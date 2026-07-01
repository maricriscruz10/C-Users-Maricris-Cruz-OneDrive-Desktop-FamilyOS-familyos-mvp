// FamilyOS backend — pure Node.js HTTP server (no external dependencies).
// Implements: auth/RBAC, multi-tenant family isolation, event CRUD (incl.
// appointments as a category of event) with versioning + conflict resolution,
// budgeting, meal planning, chores, audit logging, notifications, and a
// real-time SSE stream per family. See docs/ for full architecture notes.

const http = require('http');
const crypto = require('crypto');
const url = require('url');
const db = require('./db');
const { logger } = require('./logger');
const { createSession, getUserFromToken, hasPermission } = require('./auth');

const PORT = process.env.PORT || 4000;
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function advanceDueDate(fromDate, recurrence) {
  const d = new Date(fromDate + 'T00:00:00');
  if (recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------- SSE subscriber registry (per family) ----------
const sseClients = new Map(); // familyId -> Set(res)
function broadcast(familyId, eventName, payload) {
  const set = sseClients.get(familyId);
  if (!set) return;
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { /* client gone */ }
  }
}

// ---------- helpers ----------
// res._corsOrigin is stamped by the main request handler before any route runs,
// so sendJson/err never need req threaded through them.
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (res._corsOrigin) headers['Access-Control-Allow-Origin'] = res._corsOrigin;
  res.writeHead(status, headers);
  res.end(body);
}
function err(res, status, code, message) {
  logger.warn('http', `${status} ${code}: ${message}`);
  sendJson(res, status, { error: { code, message } });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function getToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  // EventSource (browser SSE) cannot set custom headers, so the realtime
  // stream endpoint also accepts the token as a query string parameter.
  const q = url.parse(req.url, true).query;
  return q.token || null;
}
function audit(familyId, entityType, entityId, action, actorId, before, after) {
  db.prepare(`INSERT INTO audit_logs (id,family_id,entity_type,entity_id,action,actor_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), familyId, entityType, entityId, action, actorId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now());
}
// Expo Push API delivery — fires when EXPO_ACCESS_TOKEN is set.
// Docs: https://docs.expo.dev/push-notifications/sending-notifications/
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN || '';
function sendExpoPush(pushToken, title, body) {
  if (!EXPO_ACCESS_TOKEN || !pushToken || !pushToken.startsWith('ExponentPushToken[')) return;
  const https = require('https');
  const payload = JSON.stringify({ to: pushToken, title, body, sound: 'default' });
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Authorization': `Bearer ${EXPO_ACCESS_TOKEN}`,
    'Content-Length': Buffer.byteLength(payload),
  };
  const req = https.request({ hostname: 'exp.host', path: '/api/v2/push/send', method: 'POST', headers }, (res) => {
    let data = ''; res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.data?.status === 'error') logger.warn('push', `Expo push error for ${pushToken}: ${result.data.message}`);
      } catch {}
    });
  });
  req.on('error', (e) => logger.warn('push', `Expo push request failed: ${e.message}`));
  req.write(payload);
  req.end();
}

function notify(familyId, userId, type, title, body, eventId = null) {
  const id = uuid();
  db.prepare(`INSERT INTO notifications (id,family_id,user_id,type,title,body,related_event_id,read,created_at) VALUES (?,?,?,?,?,?,?,0,?)`)
    .run(id, familyId, userId, type, title, body, eventId, now());
  broadcast(familyId, 'notification', { id, userId, type, title, body });
  // Real push delivery if user has registered an Expo push token
  const recipient = db.prepare(`SELECT push_token FROM users WHERE id = ?`).get(userId);
  if (recipient?.push_token) sendExpoPush(recipient.push_token, title, body);
  return id;
}
function eventOut(row) {
  return {
    id: row.id, familyId: row.family_id, title: row.title, description: row.description,
    location: row.location, startAt: row.start_at, endAt: row.end_at, allDay: !!row.all_day,
    recurrence: row.recurrence, category: row.category || 'general', provider: row.provider || '',
    createdBy: row.created_by, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
    assignees: db.prepare(`SELECT ea.user_id as userId, ea.response_status as status, u.name, u.avatar_color as avatarColor
                            FROM event_assignments ea JOIN users u ON u.id = ea.user_id WHERE ea.event_id = ?`).all(row.id),
  };
}
function userOut(u) {
  return { id: u.id, familyId: u.family_id, name: u.name, email: u.email, role: u.role,
    avatarColor: u.avatar_color, status: u.status, createdAt: u.created_at };
}
function budgetCategoryOut(c) {
  return { id: c.id, familyId: c.family_id, name: c.name, monthlyLimit: c.monthly_limit, color: c.color, createdAt: c.created_at };
}
function budgetTransactionOut(t) {
  return { id: t.id, familyId: t.family_id, categoryId: t.category_id, amount: t.amount,
    description: t.description, occurredOn: t.occurred_on, paymentMethod: t.payment_method || 'cash',
    receiptImage: t.receipt_image || null, createdBy: t.created_by, createdAt: t.created_at };
}
function mealOut(m) {
  return { id: m.id, familyId: m.family_id, mealDate: m.meal_date, mealType: m.meal_type,
    title: m.title, notes: m.notes, calories: m.calories || 0, assignedCook: m.assigned_cook,
    createdBy: m.created_by, createdAt: m.created_at, updatedAt: m.updated_at };
}
function choreOut(c) {
  return { id: c.id, familyId: c.family_id, title: c.title, description: c.description,
    assigneeId: c.assignee_id, recurrence: c.recurrence, dueDate: c.due_date, points: c.points,
    status: c.status, createdBy: c.created_by, createdAt: c.created_at, updatedAt: c.updated_at };
}

// expand recurring events into virtual occurrences within [start,end]
function expandOccurrences(row, rangeStart, rangeEnd) {
  const out = [];
  const dur = new Date(row.end_at) - new Date(row.start_at);
  let cursor = new Date(row.start_at);
  const rangeEndDate = new Date(rangeEnd);
  const stepFns = {
    daily: (d) => new Date(d.setDate(d.getDate() + 1)),
    weekly: (d) => new Date(d.setDate(d.getDate() + 7)),
    monthly: (d) => new Date(d.setMonth(d.getMonth() + 1)),
  };
  const step = stepFns[row.recurrence];
  if (!step) {
    if (new Date(row.start_at) <= rangeEndDate && new Date(row.end_at) >= new Date(rangeStart)) {
      out.push(eventOut(row));
    }
    return out;
  }
  let guard = 0;
  while (cursor <= rangeEndDate && guard < 200) {
    guard++;
    if (cursor >= new Date(rangeStart)) {
      const occStart = new Date(cursor);
      const occEnd = new Date(occStart.getTime() + dur);
      const base = eventOut(row);
      out.push({ ...base, id: `${row.id}::${occStart.toISOString()}`, masterId: row.id,
        startAt: occStart.toISOString(), endAt: occEnd.toISOString(), isOccurrence: row.recurrence !== 'none' });
    }
    cursor = step(new Date(cursor));
  }
  return out;
}

// ---------- middleware-ish helpers ----------
function requireAuth(req, res) {
  const token = getToken(req);
  const user = getUserFromToken(token);
  if (!user) { err(res, 401, 'UNAUTHENTICATED', 'Missing or invalid session token'); return null; }
  if (user.status === 'disabled') { err(res, 403, 'ACCOUNT_DISABLED', 'This account has been disabled'); return null; }
  return user;
}
function requireFamily(req, res, user, familyId) {
  if (user.family_id !== familyId) { err(res, 403, 'TENANT_ISOLATION', 'You do not have access to this family'); return false; }
  return true;
}
function requirePermission(req, res, user, perm) {
  if (!hasPermission(user.role, perm)) { err(res, 403, 'FORBIDDEN', `Role '${user.role}' lacks permission '${perm}'`); return false; }
  return true;
}

// ---------- route table ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
}

route('GET', '/api/health', async (req, res) => {
  sendJson(res, 200, { status: 'ok', time: now() });
});

// ---- Auth ----
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------- Rate limiting (in-memory, per IP) ----------
// RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS window per IP. No external deps.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120', 10);   // default 120 req
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // per 60s
const rateBuckets = new Map(); // ip -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
}, 30000); // clean up expired buckets every 30s

function checkRateLimit(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - bucket.count));
  if (bucket.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    err(res, 429, 'RATE_LIMITED', 'Too many requests — please slow down');
    return false;
  }
  return true;
}

// CORS_ORIGINS: comma-separated list of allowed origins.
// Defaults to * in dev; MUST be set explicitly in production.
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? new Set(process.env.CORS_ORIGINS.split(',').map(o => o.trim()))
  : null; // null = allow all (dev only)

function corsOrigin(req) {
  if (!IS_PROD || !CORS_ORIGINS) return '*';
  const origin = req.headers['origin'] || '';
  return CORS_ORIGINS.has(origin) ? origin : '';
}

route('GET', '/api/dev/users', async (req, res) => {
  if (IS_PROD) return err(res, 404, 'NOT_FOUND', 'Not found');
  const rows = db.prepare(`SELECT u.*, f.name as family_name FROM users u JOIN families f ON f.id = u.family_id ORDER BY f.name, u.role DESC`).all();
  sendJson(res, 200, { users: rows.map(r => ({ ...userOut(r), familyName: r.family_name })) });
});

route('POST', '/api/auth/dev-login', async (req, res) => {
  if (IS_PROD) return err(res, 404, 'NOT_FOUND', 'Not found');
  const body = await readBody(req);
  if (!body.userId && !body.email) return err(res, 400, 'VALIDATION_ERROR', 'userId or email is required');
  const user = body.userId
    ? db.prepare(`SELECT * FROM users WHERE id = ?`).get(body.userId)
    : db.prepare(`SELECT * FROM users WHERE email = ?`).get(body.email);
  if (!user) return err(res, 404, 'USER_NOT_FOUND', 'No such user');
  if (user.status === 'disabled') return err(res, 403, 'ACCOUNT_DISABLED', 'Account disabled');
  if (user.status === 'invited') db.prepare(`UPDATE users SET status='active' WHERE id=?`).run(user.id);
  const token = createSession(user.id);
  logger.info('auth', `dev-login: ${user.email} (${user.role})`);
  sendJson(res, 200, { token, user: userOut({ ...user, status: 'active' }) });
});

// ---- Google OAuth (B7-prep) ----
// Activate by setting GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.
// Flow: browser → GET /api/auth/google → Google consent → GET /api/auth/google/callback → token + user
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);

route('GET', '/api/auth/google', async (req, res) => {
  if (!GOOGLE_ENABLED) return err(res, 501, 'NOT_CONFIGURED', 'Google OAuth is not configured on this server');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
});

route('GET', '/api/auth/google/callback', async (req, res) => {
  if (!GOOGLE_ENABLED) return err(res, 501, 'NOT_CONFIGURED', 'Google OAuth is not configured on this server');
  const { code, error: oauthError } = url.parse(req.url, true).query;
  if (oauthError || !code) return err(res, 400, 'OAUTH_ERROR', oauthError || 'Missing code');

  // Exchange code for tokens using built-in https (no external deps)
  const https = require('https');
  async function httpsPost(hostname, path, body) {
    return new Promise((resolve, reject) => {
      const data = new URLSearchParams(body).toString();
      const reqOpts = { hostname, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } };
      const r = https.request(reqOpts, (resp) => { let buf = ''; resp.on('data', c => buf += c); resp.on('end', () => resolve(JSON.parse(buf))); });
      r.on('error', reject); r.write(data); r.end();
    });
  }
  async function httpsGet(hostname, path, token) {
    return new Promise((resolve, reject) => {
      const r = https.request({ hostname, path, headers: { Authorization: `Bearer ${token}` } }, (resp) => { let buf = ''; resp.on('data', c => buf += c); resp.on('end', () => resolve(JSON.parse(buf))); });
      r.on('error', reject); r.end();
    });
  }

  try {
    const tokens = await httpsPost('oauth2.googleapis.com', '/token', {
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
    });
    if (tokens.error) return err(res, 400, 'OAUTH_TOKEN_ERROR', tokens.error_description || tokens.error);

    const profile = await httpsGet('www.googleapis.com', '/oauth2/v3/userinfo', tokens.access_token);
    if (!profile.email) return err(res, 400, 'OAUTH_PROFILE_ERROR', 'Could not retrieve email from Google');

    // Find or create user by email
    let user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(profile.email);
    if (!user) {
      // New Google user — create as invited (admin must assign to a family separately)
      const id = uuid();
      db.prepare(`INSERT INTO users (id,family_id,name,email,role,avatar_color,oauth_provider,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, '', profile.name || profile.email, profile.email, 'member', '#6366f1', 'google', 'invited', now());
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
      logger.info('auth', `google-oauth: new user created ${profile.email}`);
    } else if (user.status === 'invited') {
      db.prepare(`UPDATE users SET status='active', oauth_provider='google' WHERE id=?`).run(user.id);
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
    }
    if (user.status === 'disabled') return err(res, 403, 'ACCOUNT_DISABLED', 'Account disabled');

    const sessionToken = createSession(user.id);
    logger.info('auth', `google-oauth: login ${profile.email} (${user.role})`);

    // Redirect to web app with token in query string — web app stores it and navigates to dashboard
    const webOrigin = CORS_ORIGINS ? [...CORS_ORIGINS][0] : 'http://localhost:3000';
    res.writeHead(302, { Location: `${webOrigin}/#/dashboard?token=${sessionToken}` });
    res.end();
  } catch (e) {
    logger.error('auth', `google-oauth callback error: ${e.message}`);
    err(res, 500, 'OAUTH_CALLBACK_ERROR', 'OAuth callback failed — check server logs');
  }
});

route('GET', '/api/auth/me', async (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  sendJson(res, 200, { user: userOut(user) });
});

route('POST', '/api/auth/push-token', async (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  const body = await readBody(req);
  if (!body.token) return err(res, 400, 'VALIDATION', 'token is required');
  db.prepare(`UPDATE users SET push_token = ? WHERE id = ?`).run(body.token, user.id);
  logger.info('push', `Registered push token for ${user.email}`);
  sendJson(res, 200, { ok: true }, req);
});

// ---- Families / members ----
route('GET', '/api/families/:familyId', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  const fam = db.prepare(`SELECT * FROM families WHERE id = ?`).get(p.familyId);
  if (!fam) return err(res, 404, 'NOT_FOUND', 'Family not found');
  sendJson(res, 200, { family: { id: fam.id, name: fam.name, timezone: fam.timezone, settings: JSON.parse(fam.settings_json), createdAt: fam.created_at } });
});

route('PUT', '/api/families/:familyId/settings', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'settings:manage')) return;
  const body = await readBody(req);
  const fam = db.prepare(`SELECT * FROM families WHERE id = ?`).get(p.familyId);
  const before = JSON.parse(fam.settings_json);
  const after = { ...before, ...body.settings };
  db.prepare(`UPDATE families SET settings_json = ?, name = COALESCE(?, name), timezone = COALESCE(?, timezone) WHERE id = ?`)
    .run(JSON.stringify(after), body.name || null, body.timezone || null, p.familyId);
  audit(p.familyId, 'family', p.familyId, 'settings_update', user.id, before, after);
  broadcast(p.familyId, 'family_updated', { familyId: p.familyId });
  sendJson(res, 200, { settings: after }, req);
});

route('GET', '/api/families/:familyId/members', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  const rows = db.prepare(`SELECT * FROM users WHERE family_id = ? ORDER BY role DESC, name`).all(p.familyId);
  sendJson(res, 200, { members: rows.map(userOut) });
});

route('POST', '/api/families/:familyId/members/invite', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'members:invite')) return;
  const body = await readBody(req);
  if (!body.name || !body.email || !body.role) return err(res, 400, 'VALIDATION', 'name, email, role are required');
  if (!['admin', 'member', 'child'].includes(body.role)) return err(res, 400, 'VALIDATION', 'role must be admin|member|child');
  const existing = db.prepare(`SELECT * FROM users WHERE email = ?`).get(body.email);
  if (existing) return err(res, 409, 'CONFLICT', 'A user with this email already exists');
  const id = uuid();
  db.prepare(`INSERT INTO users (id,family_id,name,email,role,avatar_color,oauth_provider,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, p.familyId, body.name, body.email, body.role, body.avatarColor || '#64748b', 'dev', 'invited', now());
  audit(p.familyId, 'user', id, 'invite', user.id, null, { name: body.name, email: body.email, role: body.role });
  sendJson(res, 201, { member: userOut(db.prepare(`SELECT * FROM users WHERE id=?`).get(id)) });
});

route('PATCH', '/api/families/:familyId/members/:userId', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  const target = db.prepare(`SELECT * FROM users WHERE id = ? AND family_id = ?`).get(p.userId, p.familyId);
  if (!target) return err(res, 404, 'NOT_FOUND', 'Member not found');
  const body = await readBody(req);
  const isSelf = user.id === p.userId;
  const isAdmin = user.role === 'admin';
  // Role changes require admin permission
  if (body.role && !requirePermission(req, res, user, 'members:role:change')) return;
  // Name changes allowed for self OR admin
  if (body.name && !isSelf && !isAdmin) return err(res, 403, 'FORBIDDEN', 'You can only edit your own name');
  if (!body.role && !body.name) return err(res, 400, 'VALIDATION', 'Provide role or name to update');
  if (body.role && target.role === 'admin' && body.role !== 'admin') {
    const adminCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE family_id = ? AND role = 'admin' AND status != 'disabled'`).get(p.familyId).c;
    if (adminCount <= 1) return err(res, 409, 'LAST_ADMIN', 'Cannot demote the only admin — assign another admin first');
  }
  const before = userOut(target);
  db.prepare(`UPDATE users SET role = COALESCE(?, role), name = COALESCE(?, name) WHERE id = ?`)
    .run(body.role || null, body.name || null, p.userId);
  const after = userOut(db.prepare(`SELECT * FROM users WHERE id=?`).get(p.userId));
  audit(p.familyId, 'user', p.userId, 'update', user.id, before, after);
  if (body.role) notify(p.familyId, p.userId, 'role_changed', 'Your role changed', `Your role is now ${body.role}`);
  broadcast(p.familyId, 'member_updated', { userId: p.userId });
  sendJson(res, 200, { member: after }, req);
});

route('DELETE', '/api/families/:familyId/members/:userId', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'members:remove')) return;
  if (p.userId === user.id) return err(res, 400, 'VALIDATION', 'Cannot remove yourself');
  const target = db.prepare(`SELECT * FROM users WHERE id = ? AND family_id = ?`).get(p.userId, p.familyId);
  if (!target) return err(res, 404, 'NOT_FOUND', 'Member not found');
  if (target.role === 'admin') {
    const adminCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE family_id = ? AND role='admin' AND status != 'disabled'`).get(p.familyId).c;
    if (adminCount <= 1) return err(res, 409, 'LAST_ADMIN', 'Cannot remove the only admin');
  }
  db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(p.userId);
  audit(p.familyId, 'user', p.userId, 'remove', user.id, userOut(target), null);
  broadcast(p.familyId, 'member_updated', { userId: p.userId });
  sendJson(res, 200, { ok: true }, req);
});

// ---- Events (category='general'|'appointment' — appointments reuse this whole subsystem) ----
route('GET', '/api/families/:familyId/events', async (req, res, p, query) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  const start = query.start || new Date(Date.now() - 7 * 86400000).toISOString();
  const end = query.end || new Date(Date.now() + 30 * 86400000).toISOString();
  let rows = db.prepare(`SELECT * FROM events WHERE family_id = ? AND deleted = 0`).all(p.familyId);
  if (query.category) rows = rows.filter(r => (r.category || 'general') === query.category);
  let occurrences = [];
  for (const row of rows) occurrences = occurrences.concat(expandOccurrences(row, start, end));
  occurrences.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  sendJson(res, 200, { events: occurrences }, req);
});

route('GET', '/api/families/:familyId/sync', async (req, res, p, query) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  const since = query.since || new Date(0).toISOString();
  const updated = db.prepare(`SELECT * FROM events WHERE family_id = ? AND updated_at > ? AND deleted = 0`).all(p.familyId, since).map(eventOut);
  const deletedIds = db.prepare(`SELECT id FROM events WHERE family_id = ? AND updated_at > ? AND deleted = 1`).all(p.familyId, since).map(r => r.id);
  sendJson(res, 200, { updated, deletedIds, serverTime: now() });
});

route('POST', '/api/families/:familyId/events', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'event:create')) return;
  const body = await readBody(req);
  if (!body.title || !body.startAt || !body.endAt) return err(res, 400, 'VALIDATION', 'title, startAt, endAt are required');
  if (new Date(body.endAt) < new Date(body.startAt)) return err(res, 400, 'VALIDATION', 'endAt must be after startAt');
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO events (id,family_id,title,description,location,start_at,end_at,all_day,recurrence,category,provider,created_by,version,deleted,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
    .run(id, p.familyId, body.title, body.description || '', body.location || '', body.startAt, body.endAt,
      body.allDay ? 1 : 0, body.recurrence || 'none', body.category || 'general', body.provider || '', user.id, ts, ts);
  db.prepare(`INSERT INTO event_versions (id,event_id,version,data_json,changed_by,change_type,created_at) VALUES (?,?,1,?,?,?,?)`)
    .run(uuid(), id, JSON.stringify(body), user.id, 'create', ts);
  for (const uid of (body.assigneeIds || [])) {
    const member = db.prepare(`SELECT * FROM users WHERE id = ? AND family_id = ?`).get(uid, p.familyId);
    if (!member) continue;
    db.prepare(`INSERT INTO event_assignments (id,event_id,user_id,response_status,created_at) VALUES (?,?,?,?,?)`)
      .run(uuid(), id, uid, 'pending', ts);
    if (uid !== user.id) notify(p.familyId, uid, 'event_assigned', 'New event assigned', `You were assigned to "${body.title}"`, id);
  }
  audit(p.familyId, 'event', id, 'create', user.id, null, body);
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
  broadcast(p.familyId, 'event_created', eventOut(row));
  sendJson(res, 201, { event: eventOut(row) });
});

route('GET', '/api/events/:eventId', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(p.eventId);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Event not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  sendJson(res, 200, { event: eventOut(row) });
});

route('PUT', '/api/events/:eventId', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(p.eventId);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Event not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  const isOwner = row.created_by === user.id;
  const allowed = hasPermission(user.role, 'event:update:any') || (isOwner && hasPermission(user.role, 'event:update:own'));
  if (!allowed) { err(res, 403, 'FORBIDDEN', `Role '${user.role}' cannot update this event`); return; }

  const body = await readBody(req);
  const before = eventOut(row);

  // ---- conflict resolution: last-write + field-level merge ----
  const clientVersion = body.version ?? row.version;
  const conflict = clientVersion < row.version;
  const fields = ['title', 'description', 'location', 'startAt', 'endAt', 'allDay', 'recurrence', 'category', 'provider'];
  const fieldMap = { title: 'title', description: 'description', location: 'location', startAt: 'start_at', endAt: 'end_at', allDay: 'all_day', recurrence: 'recurrence', category: 'category', provider: 'provider' };
  const conflictFields = [];
  const next = {};
  for (const f of fields) {
    if (body[f] === undefined) continue;
    const dbCol = fieldMap[f];
    const serverVal = row[dbCol];
    const clientVal = f === 'allDay' ? (body[f] ? 1 : 0) : body[f];
    if (conflict && serverVal !== clientVal && serverVal !== row[dbCol]) {
      conflictFields.push(f);
    }
    next[dbCol] = clientVal;
  }
  const newVersion = row.version + 1;
  const ts = now();
  db.prepare(`UPDATE events SET
      title = COALESCE(?, title), description = COALESCE(?, description), location = COALESCE(?, location),
      start_at = COALESCE(?, start_at), end_at = COALESCE(?, end_at), all_day = COALESCE(?, all_day),
      recurrence = COALESCE(?, recurrence), category = COALESCE(?, category), provider = COALESCE(?, provider),
      version = ?, updated_at = ?
    WHERE id = ?`)
    .run(next.title ?? null, next.description ?? null, next.location ?? null, next.start_at ?? null,
      next.end_at ?? null, next.all_day ?? null, next.recurrence ?? null, next.category ?? null, next.provider ?? null,
      newVersion, ts, p.eventId);

  const updated = db.prepare(`SELECT * FROM events WHERE id = ?`).get(p.eventId);
  db.prepare(`INSERT INTO event_versions (id,event_id,version,data_json,changed_by,change_type,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), p.eventId, newVersion, JSON.stringify(eventOut(updated)), user.id, conflict ? 'merge' : 'update', ts);
  audit(row.family_id, 'event', p.eventId, conflict ? 'merge' : 'update', user.id, before, eventOut(updated));

  for (const a of eventOut(updated).assignees) {
    if (a.userId !== user.id) notify(row.family_id, a.userId, 'event_updated', 'Event updated', `"${updated.title}" was updated`, p.eventId);
  }
  broadcast(row.family_id, 'event_updated', eventOut(updated));
  sendJson(res, 200, { event: eventOut(updated), conflict, conflictFields });
});

route('DELETE', '/api/events/:eventId', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(p.eventId);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Event not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  const isOwner = row.created_by === user.id;
  const allowedDelete = hasPermission(user.role, 'event:delete:any') || (isOwner && hasPermission(user.role, 'event:delete:own'));
  if (!allowedDelete) { err(res, 403, 'FORBIDDEN', `Role '${user.role}' cannot delete this event`); return; }
  db.prepare(`UPDATE events SET deleted = 1, version = version + 1, updated_at = ? WHERE id = ?`).run(now(), p.eventId);
  audit(row.family_id, 'event', p.eventId, 'delete', user.id, eventOut(row), null);
  broadcast(row.family_id, 'event_deleted', { id: p.eventId });
  sendJson(res, 200, { ok: true }, req);
});

route('POST', '/api/events/:eventId/assign', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(p.eventId);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Event not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'event:assign')) return;
  const body = await readBody(req);
  const member = db.prepare(`SELECT * FROM users WHERE id = ? AND family_id = ?`).get(body.userId, row.family_id);
  if (!member) return err(res, 404, 'NOT_FOUND', 'Member not found in this family');
  const existing = db.prepare(`SELECT * FROM event_assignments WHERE event_id = ? AND user_id = ?`).get(p.eventId, body.userId);
  if (existing) return err(res, 409, 'CONFLICT', 'Already assigned');
  db.prepare(`INSERT INTO event_assignments (id,event_id,user_id,response_status,created_at) VALUES (?,?,?,?,?)`)
    .run(uuid(), p.eventId, body.userId, 'pending', now());
  notify(row.family_id, body.userId, 'event_assigned', 'New event assigned', `You were assigned to "${row.title}"`, p.eventId);
  audit(row.family_id, 'event_assignment', p.eventId, 'assign', user.id, null, { userId: body.userId });
  broadcast(row.family_id, 'event_updated', eventOut(db.prepare(`SELECT * FROM events WHERE id=?`).get(p.eventId)));
  sendJson(res, 201, { ok: true }, req);
});

route('POST', '/api/events/:eventId/respond', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(p.eventId);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Event not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  const body = await readBody(req);
  if (!['accepted', 'declined', 'completed'].includes(body.status)) return err(res, 400, 'VALIDATION', 'status must be accepted|declined|completed');
  const assignment = db.prepare(`SELECT * FROM event_assignments WHERE event_id = ? AND user_id = ?`).get(p.eventId, user.id);
  if (!assignment) return err(res, 404, 'NOT_FOUND', 'You are not assigned to this event');
  db.prepare(`UPDATE event_assignments SET response_status = ? WHERE id = ?`).run(body.status, assignment.id);
  audit(row.family_id, 'event_assignment', assignment.id, 'respond', user.id, { status: assignment.response_status }, { status: body.status });
  notify(row.family_id, row.created_by, 'event_updated', 'Response received', `${user.name} marked "${row.title}" as ${body.status}`, p.eventId);
  broadcast(row.family_id, 'event_updated', eventOut(db.prepare(`SELECT * FROM events WHERE id=?`).get(p.eventId)));
  sendJson(res, 200, { ok: true }, req);
});

// ---- Budgeting ----
route('GET', '/api/families/:familyId/budget/categories', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'budget:view')) return;
  const rows = db.prepare(`SELECT * FROM budget_categories WHERE family_id = ? ORDER BY name`).all(p.familyId);
  sendJson(res, 200, { categories: rows.map(budgetCategoryOut) });
});

route('POST', '/api/families/:familyId/budget/categories', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'budget:categories:manage')) return;
  const body = await readBody(req);
  if (!body.name) return err(res, 400, 'VALIDATION', 'name is required');
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO budget_categories (id,family_id,name,monthly_limit,color,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, p.familyId, body.name, body.monthlyLimit || 0, body.color || '#6366f1', ts);
  audit(p.familyId, 'budget_category', id, 'create', user.id, null, body);
  const row = db.prepare(`SELECT * FROM budget_categories WHERE id=?`).get(id);
  broadcast(p.familyId, 'budget_updated', { categoryId: id });
  sendJson(res, 201, { category: budgetCategoryOut(row) });
});

route('PUT', '/api/budget/categories/:id', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM budget_categories WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Category not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'budget:categories:manage')) return;
  const body = await readBody(req);
  const before = budgetCategoryOut(row);
  db.prepare(`UPDATE budget_categories SET name = COALESCE(?, name), monthly_limit = COALESCE(?, monthly_limit), color = COALESCE(?, color) WHERE id = ?`)
    .run(body.name || null, body.monthlyLimit ?? null, body.color || null, p.id);
  const after = budgetCategoryOut(db.prepare(`SELECT * FROM budget_categories WHERE id=?`).get(p.id));
  audit(row.family_id, 'budget_category', p.id, 'update', user.id, before, after);
  broadcast(row.family_id, 'budget_updated', { categoryId: p.id });
  sendJson(res, 200, { category: after }, req);
});

route('DELETE', '/api/budget/categories/:id', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM budget_categories WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Category not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'budget:categories:manage')) return;
  const inUse = db.prepare(`SELECT COUNT(*) c FROM budget_transactions WHERE category_id = ?`).get(p.id).c;
  if (inUse > 0) return err(res, 409, 'CONFLICT', 'Cannot delete a category that has transactions — reassign or delete them first');
  db.prepare(`DELETE FROM budget_categories WHERE id = ?`).run(p.id);
  audit(row.family_id, 'budget_category', p.id, 'delete', user.id, budgetCategoryOut(row), null);
  broadcast(row.family_id, 'budget_updated', { categoryId: p.id });
  sendJson(res, 200, { ok: true }, req);
});

route('GET', '/api/families/:familyId/budget/transactions', async (req, res, p, query) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'budget:view')) return;
  let rows = db.prepare(`SELECT * FROM budget_transactions WHERE family_id = ? ORDER BY occurred_on DESC`).all(p.familyId);
  if (query.month) rows = rows.filter(r => r.occurred_on.startsWith(query.month)); // YYYY-MM
  sendJson(res, 200, { transactions: rows.map(budgetTransactionOut) });
});

route('POST', '/api/families/:familyId/budget/transactions', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'budget:manage')) return;
  const body = await readBody(req);
  if (!body.categoryId || body.amount === undefined || !body.occurredOn) return err(res, 400, 'VALIDATION', 'categoryId, amount, occurredOn are required');
  const cat = db.prepare(`SELECT * FROM budget_categories WHERE id = ? AND family_id = ?`).get(body.categoryId, p.familyId);
  if (!cat) return err(res, 404, 'NOT_FOUND', 'Budget category not found in this family');
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO budget_transactions (id,family_id,category_id,amount,description,occurred_on,payment_method,receipt_image,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, p.familyId, body.categoryId, body.amount, body.description || '', body.occurredOn, body.paymentMethod || 'cash', body.receiptImage || null, user.id, ts);
  audit(p.familyId, 'budget_transaction', id, 'create', user.id, null, body);
  const row = db.prepare(`SELECT * FROM budget_transactions WHERE id=?`).get(id);
  broadcast(p.familyId, 'budget_updated', { transactionId: id });
  sendJson(res, 201, { transaction: budgetTransactionOut(row) });
});

route('DELETE', '/api/budget/transactions/:id', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM budget_transactions WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Transaction not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'budget:manage')) return;
  db.prepare(`DELETE FROM budget_transactions WHERE id = ?`).run(p.id);
  audit(row.family_id, 'budget_transaction', p.id, 'delete', user.id, budgetTransactionOut(row), null);
  broadcast(row.family_id, 'budget_updated', { transactionId: p.id });
  sendJson(res, 200, { ok: true }, req);
});

route('GET', '/api/families/:familyId/budget/summary', async (req, res, p, query) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'budget:view')) return;
  const month = query.month || now().slice(0, 7); // YYYY-MM
  const categories = db.prepare(`SELECT * FROM budget_categories WHERE family_id = ?`).all(p.familyId);
  const txs = db.prepare(`SELECT * FROM budget_transactions WHERE family_id = ? AND occurred_on LIKE ?`).all(p.familyId, `${month}%`);
  const byCategory = categories.map(c => {
    const spent = txs.filter(t => t.category_id === c.id).reduce((sum, t) => sum + t.amount, 0);
    return { ...budgetCategoryOut(c), spent, remaining: c.monthly_limit - spent, overBudget: spent > c.monthly_limit && c.monthly_limit > 0 };
  });
  const totalSpent = txs.reduce((sum, t) => sum + t.amount, 0);
  const totalLimit = categories.reduce((sum, c) => sum + c.monthly_limit, 0);
  sendJson(res, 200, { month, categories: byCategory, totalSpent, totalLimit });
});

// ---- Meal planning ----
route('GET', '/api/families/:familyId/meals', async (req, res, p, query) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'meals:view')) return;
  const start = query.start || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const end = query.end || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT * FROM meal_plan_entries WHERE family_id = ? AND meal_date >= ? AND meal_date <= ? ORDER BY meal_date, meal_type`).all(p.familyId, start, end);
  sendJson(res, 200, { meals: rows.map(mealOut) });
});

route('POST', '/api/families/:familyId/meals', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'meals:manage')) return;
  const body = await readBody(req);
  if (!body.mealDate || !body.mealType || !body.title) return err(res, 400, 'VALIDATION', 'mealDate, mealType, title are required');
  if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(body.mealType)) return err(res, 400, 'VALIDATION', 'mealType must be breakfast|lunch|dinner|snack');
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO meal_plan_entries (id,family_id,meal_date,meal_type,title,notes,calories,assigned_cook,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, p.familyId, body.mealDate, body.mealType, body.title, body.notes || '', body.calories || 0, body.assignedCook || null, user.id, ts, ts);
  audit(p.familyId, 'meal', id, 'create', user.id, null, body);
  if (body.assignedCook && body.assignedCook !== user.id) notify(p.familyId, body.assignedCook, 'meal_assigned', 'You\'re cooking', `You're assigned to make "${body.title}" on ${body.mealDate}`);
  const row = db.prepare(`SELECT * FROM meal_plan_entries WHERE id=?`).get(id);
  broadcast(p.familyId, 'meal_updated', { mealId: id });
  sendJson(res, 201, { meal: mealOut(row) });
});

route('PUT', '/api/meals/:id', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM meal_plan_entries WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Meal not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'meals:manage')) return;
  const body = await readBody(req);
  const before = mealOut(row);
  db.prepare(`UPDATE meal_plan_entries SET title = COALESCE(?, title), notes = COALESCE(?, notes),
      meal_type = COALESCE(?, meal_type), meal_date = COALESCE(?, meal_date), assigned_cook = COALESCE(?, assigned_cook),
      calories = COALESCE(?, calories), updated_at = ? WHERE id = ?`)
    .run(body.title || null, body.notes ?? null, body.mealType || null, body.mealDate || null, body.assignedCook || null, body.calories ?? null, now(), p.id);
  const after = mealOut(db.prepare(`SELECT * FROM meal_plan_entries WHERE id=?`).get(p.id));
  audit(row.family_id, 'meal', p.id, 'update', user.id, before, after);
  broadcast(row.family_id, 'meal_updated', { mealId: p.id });
  sendJson(res, 200, { meal: after }, req);
});

route('DELETE', '/api/meals/:id', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM meal_plan_entries WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Meal not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'meals:manage')) return;
  db.prepare(`DELETE FROM meal_plan_entries WHERE id = ?`).run(p.id);
  audit(row.family_id, 'meal', p.id, 'delete', user.id, mealOut(row), null);
  broadcast(row.family_id, 'meal_updated', { mealId: p.id });
  sendJson(res, 200, { ok: true }, req);
});

// ---- Chores ----
route('GET', '/api/families/:familyId/chores', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'chores:view')) return;
  const rows = db.prepare(`SELECT * FROM chores WHERE family_id = ? AND deleted = 0 ORDER BY status, due_date`).all(p.familyId);
  sendJson(res, 200, { chores: rows.map(choreOut) });
});

route('POST', '/api/families/:familyId/chores', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'chores:manage')) return;
  const body = await readBody(req);
  if (!body.title) return err(res, 400, 'VALIDATION', 'title is required');
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO chores (id,family_id,title,description,assignee_id,recurrence,due_date,points,status,created_by,deleted,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`)
    .run(id, p.familyId, body.title, body.description || '', body.assigneeId || null, body.recurrence || 'none',
      body.dueDate || null, body.points || 0, 'pending', user.id, ts, ts);
  audit(p.familyId, 'chore', id, 'create', user.id, null, body);
  if (body.assigneeId && body.assigneeId !== user.id) notify(p.familyId, body.assigneeId, 'chore_assigned', 'New chore assigned', `You were assigned: "${body.title}"`);
  const row = db.prepare(`SELECT * FROM chores WHERE id=?`).get(id);
  broadcast(p.familyId, 'chore_updated', { choreId: id });
  sendJson(res, 201, { chore: choreOut(row) });
});

route('PUT', '/api/chores/:id', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM chores WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Chore not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'chores:manage')) return;
  const body = await readBody(req);
  const before = choreOut(row);
  db.prepare(`UPDATE chores SET title = COALESCE(?, title), description = COALESCE(?, description),
      assignee_id = COALESCE(?, assignee_id), recurrence = COALESCE(?, recurrence), due_date = COALESCE(?, due_date),
      points = COALESCE(?, points), updated_at = ? WHERE id = ?`)
    .run(body.title || null, body.description ?? null, body.assigneeId || null, body.recurrence || null,
      body.dueDate || null, body.points ?? null, now(), p.id);
  const after = choreOut(db.prepare(`SELECT * FROM chores WHERE id=?`).get(p.id));
  audit(row.family_id, 'chore', p.id, 'update', user.id, before, after);
  if (body.assigneeId && body.assigneeId !== row.assignee_id && body.assigneeId !== user.id) {
    notify(row.family_id, body.assigneeId, 'chore_assigned', 'Chore reassigned to you', `You were assigned: "${after.title}"`);
  }
  broadcast(row.family_id, 'chore_updated', { choreId: p.id });
  sendJson(res, 200, { chore: after }, req);
});

route('DELETE', '/api/chores/:id', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM chores WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Chore not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  if (!requirePermission(req, res, user, 'chores:manage')) return;
  db.prepare(`UPDATE chores SET deleted = 1, updated_at = ? WHERE id = ?`).run(now(), p.id);
  audit(row.family_id, 'chore', p.id, 'delete', user.id, choreOut(row), null);
  broadcast(row.family_id, 'chore_updated', { choreId: p.id });
  sendJson(res, 200, { ok: true }, req);
});

route('POST', '/api/chores/:id/complete', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  const row = db.prepare(`SELECT * FROM chores WHERE id = ?`).get(p.id);
  if (!row) return err(res, 404, 'NOT_FOUND', 'Chore not found');
  if (!requireFamily(req, res, user, row.family_id)) return;
  const isAssignee = row.assignee_id === user.id;
  const allowed = hasPermission(user.role, 'chores:complete:any') || (isAssignee && hasPermission(user.role, 'chores:complete:own'));
  if (!allowed) return err(res, 403, 'FORBIDDEN', `Role '${user.role}' cannot complete this chore`);
  const body = await readBody(req);
  const completedOn = body.completedOn || now().slice(0, 10);
  const id = uuid();
  db.prepare(`INSERT INTO chore_completions (id,chore_id,completed_by,completed_on,points_awarded,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, p.id, user.id, completedOn, row.points, now());
  // non-recurring chores flip to 'completed'; recurring ones stay 'pending' and advance their due_date
  const ts = now();
  if (row.recurrence === 'none') {
    db.prepare(`UPDATE chores SET status = 'completed', updated_at = ? WHERE id = ?`).run(ts, p.id);
  } else {
    const nextDue = advanceDueDate(completedOn, row.recurrence);
    db.prepare(`UPDATE chores SET due_date = ?, updated_at = ? WHERE id = ?`).run(nextDue, ts, p.id);
  }
  audit(row.family_id, 'chore', p.id, 'complete', user.id, { status: row.status }, { status: 'completed', completedOn });
  if (row.created_by !== user.id) notify(row.family_id, row.created_by, 'chore_completed', 'Chore completed', `${user.name} completed "${row.title}"`);
  broadcast(row.family_id, 'chore_updated', { choreId: p.id });
  sendJson(res, 200, { ok: true, pointsAwarded: row.points });
});

route('GET', '/api/families/:familyId/chores/leaderboard', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'chores:view')) return;
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
  weekStart.setHours(0, 0, 0, 0);
  const since = weekStart.toISOString().slice(0, 10);
  const completions = db.prepare(`
    SELECT cc.completed_by, cc.points_awarded, u.name, u.avatar_color
    FROM chore_completions cc
    JOIN users u ON u.id = cc.completed_by
    JOIN chores c ON c.id = cc.chore_id
    WHERE c.family_id = ? AND cc.completed_on >= ?
  `).all(p.familyId, since);
  const byUser = {};
  for (const row of completions) {
    if (!byUser[row.completed_by]) byUser[row.completed_by] = { userId: row.completed_by, name: row.name, avatarColor: row.avatar_color, points: 0, count: 0 };
    byUser[row.completed_by].points += row.points_awarded;
    byUser[row.completed_by].count += 1;
  }
  const leaderboard = Object.values(byUser).sort((a, b) => b.points - a.points);
  sendJson(res, 200, { leaderboard, weekStart: since });
});

route('GET', '/api/families/:familyId/chores/streaks', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'chores:view')) return;
  // streak: consecutive days ending today or yesterday
  const allRows = db.prepare(`
    SELECT DISTINCT cc.completed_by, cc.completed_on, u.name, u.avatar_color
    FROM chore_completions cc
    JOIN chores c ON c.id = cc.chore_id
    JOIN users u ON u.id = cc.completed_by
    WHERE c.family_id = ?
    ORDER BY cc.completed_by, cc.completed_on DESC
  `).all(p.familyId);
  const byUser = {};
  for (const row of allRows) {
    (byUser[row.completed_by] ||= { name: row.name, avatarColor: row.avatar_color, dates: [] }).dates.push(row.completed_on);
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  const prevStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const streaks = Object.entries(byUser).map(([userId, info]) => {
    const dates = info.dates; // already sorted desc
    if (!dates.length || (dates[0] !== todayStr && dates[0] !== prevStr)) return { userId, name: info.name, avatarColor: info.avatarColor, streak: 0 };
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      const expected = new Date(new Date(dates[i - 1] + 'T00:00:00') - 86400000).toISOString().slice(0, 10);
      if (dates[i] === expected) streak++;
      else break;
    }
    return { userId, name: info.name, avatarColor: info.avatarColor, streak };
  }).filter((s) => s.streak > 0).sort((a, b) => b.streak - a.streak);

  // recent history: last 15 completions
  const histRows = db.prepare(`
    SELECT cc.completed_on, cc.points_awarded, c.title as chore_title,
           u.name as completer_name, u.avatar_color
    FROM chore_completions cc
    JOIN chores c ON c.id = cc.chore_id
    JOIN users u ON u.id = cc.completed_by
    WHERE c.family_id = ?
    ORDER BY cc.completed_on DESC, cc.id DESC LIMIT 15
  `).all(p.familyId);
  sendJson(res, 200, { streaks, history: histRows.map((r) => ({
    choreTitle: r.chore_title, completerName: r.completer_name,
    avatarColor: r.avatar_color, completedOn: r.completed_on, pointsAwarded: r.points_awarded,
  })) });
});

// ---- Activity feed (all roles) ----
route('GET', '/api/families/:familyId/activity', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  const rows = db.prepare(`
    SELECT a.id, a.entity_type, a.action, a.created_at,
           u.name as actor_name, u.avatar_color as actor_avatar_color
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.family_id = ?
    ORDER BY a.created_at DESC LIMIT 20
  `).all(p.familyId);
  sendJson(res, 200, { activity: rows.map((r) => ({
    id: r.id,
    actorName: r.actor_name || 'Someone',
    actorAvatarColor: r.actor_avatar_color || '#6366f1',
    entityType: r.entity_type,
    action: r.action,
    createdAt: r.created_at,
  })) });
});

// ---- Audit log ----
route('GET', '/api/families/:familyId/audit-logs', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  if (!requirePermission(req, res, user, 'audit:view')) return;
  const rows = db.prepare(`SELECT * FROM audit_logs WHERE family_id = ? ORDER BY created_at DESC LIMIT 200`).all(p.familyId);
  sendJson(res, 200, { logs: rows.map(r => ({
    id: r.id, entityType: r.entity_type, entityId: r.entity_id, action: r.action,
    actorId: r.actor_id, before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null, createdAt: r.created_at,
  })) });
});

// ---- Notifications ----
route('GET', '/api/notifications', async (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(user.id);
  sendJson(res, 200, { notifications: rows.map(r => ({
    id: r.id, type: r.type, title: r.title, body: r.body, relatedEventId: r.related_event_id,
    read: !!r.read, createdAt: r.created_at,
  })) });
});

route('POST', '/api/notifications/:id/read', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`).run(p.id, user.id);
  sendJson(res, 200, { ok: true }, req);
});

route('POST', '/api/notifications/read-all', async (req, res) => {
  const user = requireAuth(req, res); if (!user) return;
  db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ?`).run(user.id);
  sendJson(res, 200, { ok: true }, req);
});

// ---- Real-time stream (SSE) ----
route('GET', '/api/families/:familyId/stream', async (req, res, p) => {
  const user = requireAuth(req, res); if (!user) return;
  if (!requireFamily(req, res, user, p.familyId)) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  if (!sseClients.has(p.familyId)) sseClients.set(p.familyId, new Set());
  sseClients.get(p.familyId).add(res);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.get(p.familyId)?.delete(res);
  });
});

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  // Stamp CORS origin once so sendJson/err can use it without needing req.
  res._corsOrigin = corsOrigin(req);

  // Security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers ignore it; disabling is safer than enabling
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

  if (req.method === 'OPTIONS') {
    const headers = { 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
    if (res._corsOrigin) headers['Access-Control-Allow-Origin'] = res._corsOrigin;
    res.writeHead(204, headers);
    return res.end();
  }

  if (!checkRateLimit(req, res)) return;

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = m[i + 1]));
    try {
      await r.handler(req, res, params, parsed.query);
    } catch (e) {
      logger.error('http', `Unhandled error on ${req.method} ${pathname}: ${e.message}`, { stack: e.stack });
      if (!res.writableEnded) err(res, 500, 'INTERNAL', 'Something went wrong. Check server logs.');
    }
    return;
  }
  err(res, 404, 'NOT_FOUND', `No route for ${req.method} ${pathname}`);
});

// ---------- event reminder scheduler ----------
// Runs every 60s; fires a notification when an event is about to start.
// reminderMinutesBefore is stored per-family in settings_json (default 60).
// Dedup key: `${eventId}:${userId}:${startAt}` — per occurrence + per user.
const sentReminders = new Set();
function runReminderCheck() {
  try {
    const families = db.prepare(`SELECT id, settings_json FROM families`).all();
    for (const fam of families) {
      let settings = {};
      try { settings = JSON.parse(fam.settings_json || '{}'); } catch {}
      const minutes = Number(settings.reminderMinutesBefore) || 0;
      if (!minutes) continue;
      // window: [now + minutes - 1min, now + minutes + 1min]
      const windowStart = new Date(Date.now() + (minutes - 1) * 60000);
      const windowEnd   = new Date(Date.now() + (minutes + 1) * 60000);
      const rows = db.prepare(`SELECT * FROM events WHERE family_id = ? AND deleted = 0`).all(fam.id);
      for (const row of rows) {
        const occurrences = expandOccurrences(row, windowStart.toISOString(), windowEnd.toISOString());
        for (const occ of occurrences) {
          const assignees = db.prepare(`SELECT user_id FROM event_assignments WHERE event_id = ?`).all(row.id);
          for (const a of assignees) {
            const key = `${row.id}:${a.user_id}:${occ.startAt}`;
            if (sentReminders.has(key)) continue;
            sentReminders.add(key);
            const minsLabel = minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
            notify(fam.id, a.user_id, 'event_reminder',
              `Reminder: ${occ.title}`,
              `Starting in ${minsLabel} at ${new Date(occ.startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
              row.id);
          }
        }
      }
    }
  } catch (e) {
    logger.warn('reminders', `Reminder check failed: ${e.message}`);
  }
}
setInterval(runReminderCheck, 60000);

server.listen(PORT, () => {
  logger.info('server', `FamilyOS backend listening on http://localhost:${PORT}`);
  if (!IS_PROD) logger.warn('server', 'Running in DEV mode — /api/dev/users and /api/auth/dev-login are enabled. Set NODE_ENV=production to disable.');
});

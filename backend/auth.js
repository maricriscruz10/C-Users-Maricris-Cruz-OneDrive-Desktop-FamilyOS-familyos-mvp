// Lightweight auth — no external JWT/bcrypt libs needed.
// MVP NOTE (assumption, see docs/01_summary_and_requirements.md):
// The BRD specifies OAuth-only (Google/Apple) auth in production. Standing up
// real OAuth requires registered client IDs/secrets we don't have in this
// sandbox. For local testing we implement "Dev Login": pick any seeded user
// (simulating an already-verified OAuth identity) and receive a signed
// session token. The token/middleware layer is provider-agnostic, so swapping
// in real Google/Apple OAuth later only changes how the user record is first
// resolved — not how sessions/RBAC work.

const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.SESSION_SECRET || 'familyos-dev-secret-change-in-prod';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

function createSession(userId) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const token = sign({ uid: userId, exp });
  db.prepare(`INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)`)
    .run(token, userId, new Date().toISOString(), new Date(exp).toISOString());
  return token;
}

function getUserFromToken(token) {
  const decoded = verify(token);
  if (!decoded) return null;
  const session = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(decoded.uid) || null;
}

// RBAC matrix — kept explicit and centralized per the security-hooks doc.
// Budgeting is treated as financially sensitive: Child has no access at all
// (view or otherwise) — a deliberate assumption, see docs/01 assumptions table.
// Meals and chores are visible to everyone (kids need to see their own chores
// and the family menu), but only Admin/Member can create/edit/assign them.
// Appointments are just events with category='appointment', so they're
// covered entirely by the existing event:* permissions — no new perms needed.
const ROLE_PERMISSIONS = {
  admin: ['family:manage', 'members:invite', 'members:role:change', 'members:remove',
          'event:create', 'event:update:any', 'event:delete:any', 'event:assign',
          'audit:view', 'settings:manage',
          'budget:view', 'budget:manage', 'budget:categories:manage',
          'meals:view', 'meals:manage',
          'chores:view', 'chores:manage', 'chores:complete:any', 'chores:complete:own'],
  member: ['event:create', 'event:update:own', 'event:delete:own', 'event:assign',
           'event:respond',
           'budget:view', 'budget:manage',
           'meals:view', 'meals:manage',
           'chores:view', 'chores:manage', 'chores:complete:own'],
  child: ['event:view', 'event:respond:own', 'event:complete:own',
          'meals:view',
          'chores:view', 'chores:complete:own'],
};

function hasPermission(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

module.exports = { createSession, getUserFromToken, hasPermission, ROLE_PERMISSIONS };

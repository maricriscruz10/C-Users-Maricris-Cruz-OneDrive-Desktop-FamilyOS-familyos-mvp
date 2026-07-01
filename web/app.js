// FamilyOS desktop web app — vanilla JS, no build step, no framework.
// (Substituted for Next.js in this MVP because the build sandbox has no
// package-registry access; see docs/01_summary_and_requirements.md §Assumptions.
// On a machine with normal internet access this can run unchanged, or be
// ported into a Next.js project later without changing the API contract.)

const API = window.FAMILYOS_API;
const state = {
  token: localStorage.getItem('familyos_token') || null,
  user: null,
  family: null,
  members: [],
  events: [],
  notifications: [],
  auditLogs: [],
  budgetCategories: [],
  budgetTransactions: [],
  budgetSummary: null,
  meals: [],
  chores: [],
  sse: null,
  connected: false,
};

// ---------- API helper ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const msg = body?.error?.message || `Request failed (${res.status})`;
    toast(msg, true);
    throw new Error(msg);
  }
  return body;
}

function toast(msg, isError = false) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  if (isError) el.style.background = '#ef4444';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------- router ----------
const ROUTES = ['login', 'dashboard', 'calendar', 'search', 'budget', 'meals', 'chores', 'members', 'settings', 'notifications', 'audit'];
function navigate(route) { location.hash = `#/${route}`; }
window.addEventListener('hashchange', render);

// ---------- dark mode ----------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', localStorage.getItem('familyos_dark') === '1' ? 'dark' : 'light');
}
function toggleDark() {
  const nowDark = document.documentElement.getAttribute('data-theme') === 'dark';
  localStorage.setItem('familyos_dark', nowDark ? '0' : '1');
  applyTheme();
  // update all toggle button labels in-place
  document.querySelectorAll('.dark-toggle-btn').forEach((b) => { b.textContent = nowDark ? '🌙 Dark mode' : '☀️ Light mode'; });
}
applyTheme();

// Pick up ?token= from Google OAuth redirect and store it
(function absorbOAuthToken() {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('token');
  if (t) {
    state.token = t;
    localStorage.setItem('familyos_token', t);
    // Clean the token out of the URL without a page reload
    history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
})();

async function render() {
  const app = document.getElementById('app');
  let route = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];

  if (!state.token) {
    app.innerHTML = '';
    app.appendChild(await LoginScreen());
    return;
  }
  if (!state.user) {
    try {
      const r = await api('/api/auth/me');
      state.user = r.user;
      const famRes = await api(`/api/families/${state.user.familyId}`);
      state.family = famRes.family;
      connectStream();
    } catch {
      logout();
      return;
    }
  }
  if (!ROUTES.includes(route)) route = 'dashboard';
  if (route === 'login') route = 'dashboard';
  if (route === 'budget' && state.user.role === 'child') route = 'dashboard'; // children have zero budget access

  app.innerHTML = '';
  app.appendChild(Shell(route));
}

function logout() {
  state.token = null; state.user = null; state.family = null;
  localStorage.removeItem('familyos_token');
  if (state.sse) { state.sse.close(); state.sse = null; }
  navigate('login');
  render();
}

// ---------- SSE realtime ----------
function connectStream() {
  if (state.sse) state.sse.close();
  const es = new EventSource(`${API}/api/families/${state.user.familyId}/stream?token=${state.token}`);
  // EventSource can't send Authorization headers, so the stream route also
  // accepts auth via query string fallback (handled by checking header OR query in real prod;
  // for this MVP the stream endpoint reads the Bearer header which EventSource omits,
  // so we instead poll lightly as a robust fallback — see pollFallback below).
  es.onerror = () => { state.connected = false; updateConnDot(); };
  es.onopen = () => { state.connected = true; updateConnDot(); };
  ['event_created', 'event_updated', 'event_deleted', 'member_updated', 'family_updated',
   'budget_updated', 'meal_updated', 'chore_updated'].forEach((evt) => {
    es.addEventListener(evt, () => { refreshData().then(render); });
  });
  es.addEventListener('notification', async () => {
    const prev = unreadCount();
    const { notifications } = await api('/api/notifications').catch(() => ({ notifications: state.notifications }));
    state.notifications = notifications;
    updateNotifBadge(prev);
    // also refresh the notifications screen in-place if it's currently open
    const screen = document.getElementById('screen-root');
    if (screen && location.hash === '#/notifications') render();
  });
  state.sse = es;
  // Robust fallback since EventSource cannot carry Authorization headers in browsers:
  // lightweight polling keeps data fresh even if the SSE auth handshake fails.
  if (state._pollTimer) clearInterval(state._pollTimer);
  state._pollTimer = setInterval(() => { refreshData().then(render); }, 8000);
}
function updateConnDot() {
  const dot = document.getElementById('conn-dot');
  if (dot) dot.className = 'conn-dot' + (state.connected ? '' : ' off');
}

async function refreshData() {
  if (!state.user) return;
  const fam = state.user.familyId;
  const [membersRes, notifRes] = await Promise.all([
    api(`/api/families/${fam}/members`).catch(() => ({ members: state.members })),
    api('/api/notifications').catch(() => ({ notifications: state.notifications })),
  ]);
  state.members = membersRes.members;
  state.notifications = notifRes.notifications;
}

// ---------- Shell (sidebar + content) ----------
function Shell(route) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex'; wrap.style.width = '100%';
  const isChild = state.user.role === 'child';

  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';

  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="brand"><span class="dot"></span> FamilyOS</div>
    ${navLink('dashboard', '🏠', 'Dashboard', route)}
    ${navLink('calendar', '📅', 'Calendar', route)}
    ${navLink('search', '🔍', 'Search', route)}
    ${!isChild ? navLink('budget', '💰', 'Budget', route) : ''}
    ${navLink('meals', '🍽️', 'Meal Plan', route)}
    ${navLink('chores', '✅', 'Chores', route)}
    ${navLink('members', '👨‍👩‍👧', 'Family', route)}
    ${navLink('notifications', '🔔', 'Notifications', route, unreadCount())}
    ${state.user.role === 'admin' ? navLink('audit', '🛡️', 'Audit Log', route) : ''}
    ${navLink('settings', '⚙️', 'Settings', route)}
    <div class="nav-spacer"></div>
    <div class="user-chip">
      <span id="conn-dot" class="conn-dot${state.connected ? '' : ' off'}" title="Realtime sync status"></span>
      <div class="avatar sm" style="background:${state.user.avatarColor}">${initials(state.user.name)}</div>
      <div style="flex:1; overflow:hidden;">
        <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${state.user.name}</div>
        <div class="muted" style="font-size:11px;">${state.user.role}</div>
      </div>
    </div>
    <div class="nav-link" id="logout-btn">↪ Switch user</div>
    <div class="nav-link dark-toggle-btn" id="dark-toggle-btn">${localStorage.getItem('familyos_dark') === '1' ? '☀️ Light mode' : '🌙 Dark mode'}</div>
  `;

  function closeSidebar() { sidebar.classList.remove('open'); backdrop.classList.remove('open'); }
  sidebar.querySelectorAll('.nav-link[data-route]').forEach((el) => {
    el.addEventListener('click', () => { navigate(el.dataset.route); closeSidebar(); });
  });
  sidebar.querySelector('#logout-btn').addEventListener('click', logout);
  sidebar.querySelector('#dark-toggle-btn').addEventListener('click', toggleDark);
  backdrop.addEventListener('click', closeSidebar);

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <button class="hamburger" aria-label="Open menu">
      <span></span><span></span><span></span>
    </button>
    <div class="brand" style="padding:0; font-size:16px;"><span class="dot"></span> FamilyOS</div>
  `;
  topbar.querySelector('.hamburger').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('open');
  });

  const main = document.createElement('div');
  main.className = 'main';
  main.appendChild(screenFor(route));

  wrap.appendChild(backdrop);
  wrap.appendChild(sidebar);
  wrap.appendChild(document.createElement('div')); // flex column wrapper for topbar+main
  wrap.lastChild.style.cssText = 'flex:1; display:flex; flex-direction:column; min-width:0;';
  wrap.lastChild.appendChild(topbar);
  wrap.lastChild.appendChild(main);
  return wrap;
}
function navLink(route, icon, label, current, badge) {
  const badgeId = route === 'notifications' ? ' id="notif-badge"' : '';
  return `<div class="nav-link${route === current ? ' active' : ''}" data-route="${route}">
    <span>${icon}</span><span>${label}</span>${badge ? `<span${badgeId} class="badge pending" style="margin-left:auto;">${badge}</span>` : `<span${badgeId} class="badge pending" style="margin-left:auto; display:none;"></span>`}
  </div>`;
}
function unreadCount() { return state.notifications.filter((x) => !x.read).length; }
function updateNotifBadge(prevCount) {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const count = unreadCount();
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
    if (count > prevCount) badge.classList.add('badge-pulse');
    setTimeout(() => badge.classList.remove('badge-pulse'), 600);
  } else {
    badge.style.display = 'none';
  }
}
function initials(name) { return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }

function screenFor(route) {
  const el = document.createElement('div');
  el.id = 'screen-root';
  el.innerHTML = `<div class="screen-loading"><div class="spinner"></div></div>`;
  (async () => {
    try {
      if (route === 'dashboard') el.innerHTML = await DashboardScreen();
      else if (route === 'calendar') el.innerHTML = await CalendarScreen();
      else if (route === 'search') el.innerHTML = await SearchScreen();
      else if (route === 'budget') el.innerHTML = await BudgetScreen();
      else if (route === 'meals') el.innerHTML = await MealsScreen();
      else if (route === 'chores') el.innerHTML = await ChoresScreen();
      else if (route === 'members') el.innerHTML = await MembersScreen();
      else if (route === 'settings') el.innerHTML = await SettingsScreen();
      else if (route === 'notifications') el.innerHTML = await NotificationsScreen();
      else if (route === 'audit') el.innerHTML = await AuditScreen();
      wireScreenEvents(route);
    } catch (e) {
      el.innerHTML = `<div class="empty-state">Failed to load: ${e.message}</div>`;
    }
  })();
  return el;
}

// ---------- LOGIN ----------
async function LoginScreen() {
  const wrap = document.createElement('div');
  wrap.className = 'login-screen';
  const { users } = await api('/api/dev/users');
  const byFamily = {};
  users.forEach((u) => { (byFamily[u.familyName] ||= []).push(u); });

  wrap.innerHTML = `
    <div class="login-card">
      <div class="brand" style="font-size:24px; padding-bottom:6px;"><span class="dot"></span> FamilyOS</div>
      <p class="subtitle">Dev Login — pick a household member to test as.<br/>
      <span class="muted">(Production builds use Google/Apple OAuth only — see docs for why this is a dev-mode stand-in.)</span></p>
      ${Object.entries(byFamily).map(([fam, list]) => `
        <div class="family-group">
          <h4>${fam}</h4>
          ${list.map((u) => `
            <div class="user-pick" data-uid="${u.id}">
              <div class="avatar" style="background:${u.avatarColor}">${initials(u.name)}</div>
              <div style="flex:1;">
                <div style="font-weight:600;">${u.name}</div>
                <div class="muted" style="font-size:12px;">${u.email}${u.status === 'invited' ? ' · invited (not yet logged in)' : ''}</div>
              </div>
              <span class="badge ${u.role}">${u.role}</span>
            </div>`).join('')}
        </div>`).join('')}
    </div>
  `;
  wrap.querySelectorAll('.user-pick').forEach((el) => {
    el.addEventListener('click', async () => {
      const r = await api('/api/auth/dev-login', { method: 'POST', body: JSON.stringify({ userId: el.dataset.uid }) });
      state.token = r.token; state.user = null;
      localStorage.setItem('familyos_token', state.token);
      navigate('dashboard');
      render();
    });
  });
  return wrap;
}

// ---------- DASHBOARD ----------
async function DashboardScreen() {
  await refreshData();
  const fam = state.user.familyId;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const in7days = new Date(Date.now() + 7 * 86400000);
  const { events } = await api(`/api/families/${fam}/events?start=${startOfToday.toISOString()}&end=${in7days.toISOString()}`);
  state.events = events;
  const today = events.filter((e) => sameDay(new Date(e.startAt), new Date()));
  const upcoming = events.filter((e) => new Date(e.startAt) > new Date() && !sameDay(new Date(e.startAt), new Date())).slice(0, 6);
  const upcomingAppointments = events.filter((e) => e.category === 'appointment').slice(0, 4);
  const activeMembers = state.members.filter((m) => m.status === 'active').length;

  let choresWidget = '';
  let leaderboardWidget = '';
  try {
    const [choresRes, lbRes] = await Promise.all([
      api(`/api/families/${fam}/chores`),
      api(`/api/families/${fam}/chores/leaderboard`),
    ]);
    state.chores = choresRes.chores;
    const myChores = choresRes.chores.filter((c) => c.assigneeId === state.user.id && c.status === 'pending');
    choresWidget = `
      <div class="card">
        <h3>Your chores</h3>
        ${myChores.length ? myChores.map((c) => `
          <div class="event-row">
            <div style="flex:1;">
              <div class="event-title">${escapeHtml(c.title)}</div>
              <div class="event-meta">${c.points} pts ${c.dueDate ? '· due ' + c.dueDate : ''}</div>
            </div>
            <span class="badge pending">pending</span>
          </div>`).join('') : '<div class="empty-state">No chores assigned to you right now.</div>'}
      </div>`;
    if (lbRes.leaderboard.length) {
      const medals = ['🥇', '🥈', '🥉'];
      leaderboardWidget = `
        <div class="card">
          <h3>This week's points</h3>
          <p class="subtitle" style="margin-bottom:12px;">Week starting ${lbRes.weekStart}</p>
          ${lbRes.leaderboard.map((entry, i) => `
            <div class="event-row">
              <div style="font-size:20px; width:28px; text-align:center;">${medals[i] || '🏅'}</div>
              <div class="avatar sm" style="background:${entry.avatarColor}">${initials(entry.name)}</div>
              <div style="flex:1;">
                <div class="event-title">${escapeHtml(entry.name)}${entry.userId === state.user.id ? ' <span class="badge accepted">you</span>' : ''}</div>
                <div class="event-meta">${entry.count} chore${entry.count === 1 ? '' : 's'} completed</div>
              </div>
              <div style="font-weight:800; font-size:18px; color:var(--primary);">${entry.points} pts</div>
            </div>`).join('')}
        </div>`;
    }
  } catch { /* role may lack chores:view, though all roles currently have it */ }

  return `
    <h1>Good ${dayPart()}, ${state.user.name.split(' ')[0]} 👋</h1>
    <p class="subtitle">${state.family.name} · ${today.length} event${today.length === 1 ? '' : 's'} today</p>

    <div class="grid-3">
      <div class="card stat-card"><div class="num">${today.length}</div><div class="label">Events today</div></div>
      <div class="card stat-card"><div class="num">${activeMembers}/${state.members.length}</div><div class="label">Active household members</div></div>
      <div class="card stat-card"><div class="num">${state.notifications.filter(n=>!n.read).length}</div><div class="label">Unread notifications</div></div>
    </div>

    <div class="card">
      <div class="row between"><h3>Today</h3><button class="btn sm" id="add-event-btn">+ New event</button></div>
      ${today.length ? today.map(eventRowHtml).join('') : '<div class="empty-state">Nothing scheduled today. Enjoy the calm.</div>'}
    </div>

    <div class="card">
      <h3>Coming up</h3>
      ${upcoming.length ? upcoming.map(eventRowHtml).join('') : '<div class="empty-state">No upcoming events in the next 7 days.</div>'}
    </div>

    ${upcomingAppointments.length ? `
    <div class="card">
      <h3>Appointments &amp; occasions</h3>
      ${upcomingAppointments.map(eventRowHtml).join('')}
    </div>` : ''}

    ${choresWidget}
    ${leaderboardWidget}
    ${await activityFeedWidget(fam)}
  `;
}
async function activityFeedWidget(familyId) {
  try {
    const { activity } = await api(`/api/families/${familyId}/activity`);
    if (!activity.length) return '';
    const label = (entityType, action) => {
      const map = {
        'event:created': 'added an event', 'event:updated': 'updated an event', 'event:deleted': 'removed an event',
        'event:settings_update': 'updated family settings',
        'chore:created': 'added a chore', 'chore:updated': 'updated a chore', 'chore:deleted': 'removed a chore',
        'chore:completed': 'completed a chore',
        'budget_category:created': 'added a budget category', 'budget_category:updated': 'updated a budget category', 'budget_category:deleted': 'removed a budget category',
        'budget_transaction:created': 'logged a transaction', 'budget_transaction:deleted': 'deleted a transaction',
        'meal:created': 'added a meal', 'meal:updated': 'updated a meal', 'meal:deleted': 'removed a meal',
        'member:invited': 'invited a family member', 'member:updated': 'updated a member',
        'family:settings_update': 'updated family settings',
      };
      return map[`${entityType}:${action}`] || `${action.replace(/_/g, ' ')} a ${entityType.replace(/_/g, ' ')}`;
    };
    const timeAgo = (iso) => {
      const s = Math.floor((Date.now() - new Date(iso)) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    return `
      <div class="card">
        <h3>Recent activity</h3>
        ${activity.map((a) => `
          <div class="event-row">
            <div class="avatar sm" style="background:${a.actorAvatarColor}">${initials(a.actorName)}</div>
            <div style="flex:1;">
              <div class="event-title">${escapeHtml(a.actorName)} <span style="font-weight:400;">${label(a.entityType, a.action)}</span></div>
            </div>
            <div class="muted" style="font-size:12px; flex-shrink:0;">${timeAgo(a.createdAt)}</div>
          </div>`).join('')}
      </div>`;
  } catch { return ''; }
}
function dayPart() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; }
function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
function eventRowHtml(e) {
  const t = new Date(e.startAt);
  const assignees = e.assignees.map((a) => `<span class="badge ${a.status}" title="${a.name}">${a.name.split(' ')[0]} · ${a.status}</span>`).join(' ');
  const tag = e.category === 'appointment' ? `<span class="badge admin" style="margin-right:6px;">📌 appointment${e.provider ? ' · ' + escapeHtml(e.provider) : ''}</span>` : '';
  return `<div class="event-row" data-eid="${e.masterId || e.id}">
    <div class="event-time">${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
    <div style="flex:1;">
      <div class="event-title">${tag}${escapeHtml(e.title)}</div>
      <div class="event-meta">${e.location ? '📍 ' + escapeHtml(e.location) + ' · ' : ''}${assignees}</div>
    </div>
  </div>`;
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function exportIcal(events) {
  const icalDate = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const fold = (line) => {
    const chars = [...line]; const out = [];
    for (let i = 0; i < chars.length; i += 75) out.push(chars.slice(i, i + 75).join(''));
    return out.join('\r\n ');
  };
  const esc = (s) => (s || '').replace(/[\\,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FamilyOS//FamilyOS MVP//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(fold(`UID:${e.id}@familyos`));
    lines.push(fold(`DTSTART:${icalDate(e.startAt)}`));
    lines.push(fold(`DTEND:${icalDate(e.endAt)}`));
    lines.push(fold(`SUMMARY:${esc(e.title)}`));
    if (e.location) lines.push(fold(`LOCATION:${esc(e.location)}`));
    if (e.description) lines.push(fold(`DESCRIPTION:${esc(e.description)}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `familyos-${new Date().toISOString().slice(0, 7)}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function markInvalid(inputEl) {
  const field = inputEl.closest('.field') || inputEl.parentElement;
  field.classList.add('field-error');
  inputEl.focus();
  const clear = () => { field.classList.remove('field-error'); inputEl.removeEventListener('input', clear); inputEl.removeEventListener('change', clear); };
  inputEl.addEventListener('input', clear);
  inputEl.addEventListener('change', clear);
}

// ---------- SEARCH ----------
async function SearchScreen() {
  const past = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  return `
    <div class="row between"><h1>Search Events</h1></div>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end;">
        <div class="field" style="flex:2; min-width:160px; margin:0;">
          <label>Keyword</label>
          <input id="search-q" placeholder="Title, location, or provider…" />
        </div>
        <div class="field" style="flex:1; min-width:130px; margin:0;">
          <label>Type</label>
          <select id="search-cat">
            <option value="">All types</option>
            <option value="general">General</option>
            <option value="appointment">Appointment</option>
          </select>
        </div>
        <div class="field" style="flex:1; min-width:120px; margin:0;">
          <label>From</label>
          <input type="date" id="search-from" value="${past}" />
        </div>
        <div class="field" style="flex:1; min-width:120px; margin:0;">
          <label>To</label>
          <input type="date" id="search-to" value="${future}" />
        </div>
        <button class="btn" id="search-btn" style="flex:none;">Search</button>
      </div>
    </div>
    <div id="search-results" class="muted" style="text-align:center; padding:32px 0;">Enter a keyword or date range and press Search.</div>
  `;
}

// ---------- CALENDAR ----------
let calCursor = new Date();
let budgetCursor = new Date();
async function CalendarScreen() {
  const fam = state.user.familyId;
  if (!state.members.length) await refreshData();
  const monthStart = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1);
  const monthEnd = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 0, 23, 59, 59);
  const gridStart = new Date(monthStart); gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(monthEnd); gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  const { events } = await api(`/api/families/${fam}/events?start=${gridStart.toISOString()}&end=${gridEnd.toISOString()}`);
  state.events = events;

  const memberColor = (userId) => {
    const m = state.members.find((x) => x.id === userId);
    return m ? m.avatarColor : 'var(--primary)';
  };

  const days = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));

  const legend = state.members.map((m) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin-right:10px;">
      <span style="width:10px;height:10px;border-radius:50%;background:${m.avatarColor};display:inline-block;"></span>
      ${escapeHtml(m.name.split(' ')[0])}
    </span>`
  ).join('');

  return `
    <div class="row between">
      <h1>Calendar</h1>
      <div class="flex-gap">
        <button class="btn secondary sm" id="cal-prev">←</button>
        <div style="font-weight:700; padding:6px 4px;">${calCursor.toLocaleString([], { month: 'long', year: 'numeric' })}</div>
        <button class="btn secondary sm" id="cal-next">→</button>
        <button class="btn sm" id="add-event-btn">+ New event</button>
      </div>
    </div>
    <div style="margin-bottom:10px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
      <span class="muted" style="font-size:12px; margin-right:6px;">Color by member:</span>${legend}
    </div>
    <button class="btn secondary sm" id="ical-export-btn" style="margin-bottom:12px;">⬇ Export .ics</button>
    <div class="card">
      <div class="calendar-grid" style="margin-bottom:6px;">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="muted" style="text-align:center; font-weight:700; font-size:11px;">${d}</div>`).join('')}
      </div>
      <div class="calendar-grid">
        ${days.map((d) => {
          const dayEvents = events.filter((e) => sameDay(new Date(e.startAt), d));
          const isToday = sameDay(d, new Date());
          const inMonth = d.getMonth() === calCursor.getMonth();
          return `<div class="cal-day${isToday ? ' today' : ''}" data-date="${d.toISOString()}" style="${inMonth ? '' : 'opacity:0.4;'}">
            <div class="daynum">${d.getDate()}</div>
            ${dayEvents.slice(0, 3).map((e) => `<div class="cal-pill" style="background:${memberColor(e.createdBy)};" title="${escapeHtml(e.title)}">${e.category === 'appointment' ? '📌 ' : ''}${escapeHtml(e.title)}</div>`).join('')}
            ${dayEvents.length > 3 ? `<div class="muted" style="font-size:10px;">+${dayEvents.length - 3} more</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

// ---------- BUDGET (Admin/Member only — Child has zero access) ----------
async function BudgetScreen() {
  const fam = state.user.familyId;
  const month = `${budgetCursor.getFullYear()}-${String(budgetCursor.getMonth() + 1).padStart(2, '0')}`;
  const [catRes, txRes, sumRes] = await Promise.all([
    api(`/api/families/${fam}/budget/categories`),
    api(`/api/families/${fam}/budget/transactions?month=${month}`),
    api(`/api/families/${fam}/budget/summary?month=${month}`),
  ]);
  state.budgetCategories = catRes.categories;
  state.budgetTransactions = txRes.transactions;
  state.budgetSummary = sumRes;
  const canManageCats = state.user.role === 'admin';
  const canManageTx = state.user.role !== 'child'; // admin + member both have budget:manage
  const monthLabel = budgetCursor.toLocaleString([], { month: 'long', year: 'numeric' });

  const catName = (id) => (state.budgetCategories.find((c) => c.id === id) || {}).name || '—';
  const pmIcon = { cash: '💵', credit_card: '💳', debit_card: '🏦', gcash: '📱' };
  const pmLabel = { cash: 'Cash', credit_card: 'Credit', debit_card: 'Debit', gcash: 'GCash' };

  // payment method breakdown
  const pmTotals = {};
  state.budgetTransactions.forEach((t) => {
    const pm = t.paymentMethod || 'cash';
    pmTotals[pm] = (pmTotals[pm] || 0) + t.amount;
  });

  return `
    <div class="row between"><h1>Budget</h1>
      <div class="flex-gap">
        <button class="btn secondary sm" id="budget-prev">←</button>
        <span style="font-weight:700; padding:6px 4px;">${monthLabel}</span>
        <button class="btn secondary sm" id="budget-next">→</button>
        ${canManageCats ? '<button class="btn secondary sm" id="add-budget-cat-btn">+ Category</button>' : ''}
        ${canManageTx ? '<button class="btn sm" id="add-budget-tx-btn">+ Transaction</button>' : ''}
      </div>
    </div>
    <p class="subtitle">${sumRes.month} · $${sumRes.totalSpent.toFixed(2)} spent of $${sumRes.totalLimit.toFixed(2)} limit</p>

    <div class="grid-3">
      ${sumRes.categories.map((c) => `
        <div class="card stat-card" style="border-left:4px solid ${c.color};">
          <div class="num" style="color:${c.overBudget ? '#ef4444' : 'inherit'};">$${c.spent.toFixed(2)}</div>
          <div class="label">${escapeHtml(c.name)} · limit $${c.monthlyLimit.toFixed(2)}</div>
          ${c.overBudget ? '<span class="badge declined" style="margin-top:4px;">over budget</span>' : ''}
        </div>`).join('')}
    </div>

    ${sumRes.categories.length ? `
    <div class="card">
      <h3>Spending by category</h3>
      ${sumRes.categories.map((c) => {
        const pct = c.monthlyLimit > 0 ? Math.min(100, (c.spent / c.monthlyLimit) * 100) : 0;
        const barColor = c.overBudget ? 'var(--red)' : c.color;
        return `
          <div style="margin-bottom:12px;">
            <div class="row between" style="margin-bottom:4px; font-size:13px;">
              <span style="font-weight:600;">${escapeHtml(c.name)}</span>
              <span class="muted">$${c.spent.toFixed(2)} / $${c.monthlyLimit.toFixed(2)}</span>
            </div>
            <div class="budget-bar-track">
              <div class="budget-bar-fill" style="width:${pct}%; background:${barColor};"></div>
            </div>
          </div>`;
      }).join('')}
    </div>` : ''}

    ${Object.keys(pmTotals).length ? `
    <div class="card">
      <h3>By payment method</h3>
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        ${Object.entries(pmTotals).map(([pm, total]) => `
          <div style="display:flex; align-items:center; gap:8px; background:var(--bg); border-radius:10px; padding:10px 16px;">
            <span style="font-size:22px;">${pmIcon[pm] || '💳'}</span>
            <div>
              <div style="font-weight:700; font-size:16px;">$${total.toFixed(2)}</div>
              <div class="muted" style="font-size:12px;">${pmLabel[pm] || pm}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div class="card">
      <h3>Transactions this household has logged</h3>
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Method</th><th>Amount</th><th>Receipt</th>${canManageTx ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${state.budgetTransactions.map((t) => `
            <tr>
              <td class="muted">${t.occurredOn}</td>
              <td>${escapeHtml(catName(t.categoryId))}</td>
              <td>${escapeHtml(t.description)}</td>
              <td style="white-space:nowrap;">${pmIcon[t.paymentMethod] || '💵'} <span class="muted" style="font-size:12px;">${pmLabel[t.paymentMethod] || 'Cash'}</span></td>
              <td style="font-weight:600; color:${t.amount < 0 ? 'var(--green)' : 'inherit'};">$${t.amount.toFixed(2)}</td>
              <td>${t.receiptImage ? `<img src="${t.receiptImage}" class="receipt-thumb" data-tid="${t.id}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer;" title="Click to view receipt" />` : '<span class="muted">—</span>'}</td>
              ${canManageTx ? `<td><button class="btn danger sm remove-budget-tx" data-tid="${t.id}">Delete</button></td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>
      ${state.budgetTransactions.length === 0 ? '<div class="empty-state">No transactions logged yet.</div>' : ''}
    </div>
  `;
}

// ---------- MEAL PLANNING (visible to all roles; Admin/Member can edit) ----------
async function MealsScreen() {
  const fam = state.user.familyId;
  const start = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10);
  const { meals } = await api(`/api/families/${fam}/meals?start=${start}&end=${end}`);
  state.meals = meals;
  const canManage = state.user.role !== 'child';
  const byDate = {};
  meals.forEach((m) => { (byDate[m.mealDate] ||= []).push(m); });
  const dates = Object.keys(byDate).sort();
  const cookName = (id) => { const m = state.members.find((x) => x.id === id); return m ? m.name.split(' ')[0] : 'Unassigned'; };
  const totalCals = meals.reduce((s, m) => s + (m.calories || 0), 0);

  return `
    <div class="row between"><h1>Meal Plan</h1>
      <div class="flex-gap">
        <button class="btn secondary sm" id="shopping-list-btn">🛒 Shopping list</button>
        ${canManage ? '<button class="btn sm" id="add-meal-btn">+ Add meal</button>' : ''}
      </div>
    </div>
    <p class="subtitle">Next two weeks · ${meals.length} planned meal${meals.length === 1 ? '' : 's'}${totalCals > 0 ? ` · ~${totalCals.toLocaleString()} cal total` : ''}</p>
    ${dates.length ? dates.map((date) => {
      const dateMeals = byDate[date];
      const dayCals = dateMeals.reduce((s, m) => s + (m.calories || 0), 0);
      return `
      <div class="card">
        <div class="row between" style="margin-bottom:10px;">
          <h3 style="margin:0;">${new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
          ${dayCals > 0 ? `<span class="muted" style="font-size:12px;">🔥 ${dayCals.toLocaleString()} cal</span>` : ''}
        </div>
        ${dateMeals.map((m) => `
          <div class="event-row" data-mid="${canManage ? m.id : ''}">
            <span class="badge member" style="text-transform:capitalize;">${m.mealType}</span>
            <div style="flex:1;">
              <div class="event-title">${escapeHtml(m.title)}</div>
              <div class="event-meta">${m.notes ? escapeHtml(m.notes) + ' · ' : ''}👨‍🍳 ${cookName(m.assignedCook)}${m.calories ? ' · 🔥 ' + m.calories + ' cal' : ''}</div>
            </div>
            ${canManage ? `<button class="btn danger sm remove-meal" data-mid="${m.id}">Delete</button>` : ''}
          </div>`).join('')}
      </div>`;
    }).join('') : '<div class="empty-state">No meals planned yet.</div>'}
  `;
}

// ---------- CHORES (visible to all roles; Admin/Member manage, anyone completes their own) ----------
async function ChoresScreen() {
  const fam = state.user.familyId;
  const { chores } = await api(`/api/families/${fam}/chores`);
  state.chores = chores;
  const canManage = state.user.role !== 'child';
  const assigneeName = (id) => { const m = state.members.find((x) => x.id === id); return m ? m.name.split(' ')[0] : 'Unassigned'; };
  const pending = chores.filter((c) => c.status === 'pending');
  const completed = chores.filter((c) => c.status === 'completed');

  function choreRow(c) {
    const isMine = c.assigneeId === state.user.id;
    const canComplete = c.status === 'pending' && (isMine || state.user.role === 'admin');
    return `<div class="event-row">
      <div style="flex:1;">
        <div class="event-title">${escapeHtml(c.title)}</div>
        <div class="event-meta">${c.description ? escapeHtml(c.description) + ' · ' : ''}👤 ${assigneeName(c.assigneeId)} · ${c.points} pts${c.dueDate ? ' · due ' + c.dueDate : ''}${c.recurrence !== 'none' ? ' · ' + c.recurrence : ''}</div>
      </div>
      ${c.status === 'completed' ? '<span class="badge accepted">done</span>' : ''}
      ${canComplete ? `<button class="btn sm complete-chore" data-cid="${c.id}">Mark done</button>` : ''}
      ${canManage ? `<button class="btn danger sm remove-chore" data-cid="${c.id}">Delete</button>` : ''}
    </div>`;
  }

  let streaksWidget = '';
  let historyWidget = '';
  try {
    const { streaks, history } = await api(`/api/families/${fam}/chores/streaks`);
    if (streaks.length) {
      streaksWidget = `
        <div class="card">
          <h3>Streaks 🔥</h3>
          ${streaks.map((s) => `
            <div class="event-row">
              <div class="avatar sm" style="background:${s.avatarColor}">${initials(s.name)}</div>
              <div style="flex:1;"><div class="event-title">${escapeHtml(s.name)}</div></div>
              <div style="font-weight:800; font-size:16px; color:var(--amber);">${s.streak} day${s.streak === 1 ? '' : 's'} 🔥</div>
            </div>`).join('')}
        </div>`;
    }
    if (history.length) {
      historyWidget = `
        <div class="card">
          <h3>Completion history</h3>
          ${history.map((h) => `
            <div class="event-row">
              <div class="avatar sm" style="background:${h.avatarColor}">${initials(h.completerName)}</div>
              <div style="flex:1;">
                <div class="event-title">${escapeHtml(h.choreTitle)}</div>
                <div class="event-meta">by ${escapeHtml(h.completerName)} · ${h.completedOn} · +${h.pointsAwarded} pts</div>
              </div>
            </div>`).join('')}
        </div>`;
    }
  } catch { /* streaks endpoint may not exist on older data */ }

  return `
    <div class="row between"><h1>Chores</h1>${canManage ? '<button class="btn sm" id="add-chore-btn">+ Add chore</button>' : ''}</div>
    <p class="subtitle">${pending.length} pending · ${completed.length} completed</p>
    ${streaksWidget}
    <div class="card">
      <h3>To do</h3>
      ${pending.length ? pending.map(choreRow).join('') : '<div class="empty-state">Nothing pending — nice work!</div>'}
    </div>
    ${historyWidget}
  `;
}

// ---------- MEMBERS ----------
async function MembersScreen() {
  await refreshData();
  const isAdmin = state.user.role === 'admin';
  return `
    <h1>Family Members</h1>
    <p class="subtitle">${state.family.name} · ${state.members.length} member${state.members.length === 1 ? '' : 's'}</p>
    <div class="card">
      <div class="row between"><h3>Household</h3>${isAdmin ? '<button class="btn sm" id="invite-btn">+ Invite member</button>' : ''}</div>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${state.members.map((m) => {
            const canEdit = isAdmin || m.id === state.user.id;
            return `
            <tr>
              <td>
                <div class="row">
                  <div class="avatar sm" style="background:${m.avatarColor}">${initials(m.name)}</div>
                  <span>${escapeHtml(m.name)}</span>
                  ${canEdit ? `<button class="btn secondary sm edit-member-name" data-uid="${m.id}" data-name="${escapeHtml(m.name)}" style="padding:3px 8px; font-size:11px;">✏️</button>` : ''}
                </div>
              </td>
              <td class="muted">${m.email}</td>
              <td>
                ${isAdmin && m.id !== state.user.id
                  ? `<select class="role-select" data-uid="${m.id}" style="width:auto; padding:4px 8px;">
                      ${['admin','member','child'].map(r => `<option value="${r}" ${r===m.role?'selected':''}>${r}</option>`).join('')}
                    </select>`
                  : `<span class="badge ${m.role}">${m.role}</span>`}
              </td>
              <td><span class="badge ${m.status === 'active' ? 'accepted' : m.status === 'invited' ? 'pending' : 'declined'}">${m.status}</span></td>
              <td>${isAdmin && m.id !== state.user.id ? `<button class="btn danger sm remove-member" data-uid="${m.id}">Remove</button>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ---------- SETTINGS ----------
async function SettingsScreen() {
  const settings = state.family.settings || {};
  return `
    <h1>Settings</h1>
    <p class="subtitle">Manage your household preferences</p>
    <div class="card">
      <h3>Family</h3>
      <div class="field"><label>Family name</label><input id="set-name" value="${escapeHtml(state.family.name)}" ${state.user.role !== 'admin' ? 'disabled' : ''}/></div>
      <div class="field"><label>Time zone</label><input id="set-tz" value="${escapeHtml(state.family.timezone)}" ${state.user.role !== 'admin' ? 'disabled' : ''}/></div>
      <div class="field"><label>Reminder minutes before event</label><input id="set-reminder" type="number" value="${settings.reminderMinutesBefore ?? 60}" ${state.user.role !== 'admin' ? 'disabled' : ''}/></div>
      ${state.user.role === 'admin' ? '<button class="btn" id="save-settings-btn">Save changes</button>' : '<div class="muted">Only admins can change household settings.</div>'}
    </div>
    <div class="card">
      <h3>About this build</h3>
      <p class="muted" style="font-size:13px;">FamilyOS MVP — local testing build. Backend: ${API}. See the docs folder for architecture, database design, and test scenarios.</p>
    </div>
  `;
}

// ---------- NOTIFICATIONS ----------
async function NotificationsScreen() {
  await refreshData();
  return `
    <div class="row between"><h1>Notifications</h1><button class="btn secondary sm" id="mark-all-read-btn">Mark all read</button></div>
    <div class="card">
      ${state.notifications.length ? state.notifications.map((n) => `
        <div class="event-row" style="${n.read ? '' : 'background:#f5f5ff;'}" data-nid="${n.id}">
          <div style="width:8px; height:8px; border-radius:50%; background:${n.read ? 'transparent' : 'var(--primary)'}; flex-shrink:0;"></div>
          <div style="flex:1;">
            <div class="event-title">${escapeHtml(n.title)}</div>
            <div class="event-meta">${escapeHtml(n.body)}</div>
          </div>
          <div class="muted" style="font-size:11px;">${new Date(n.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
        </div>`).join('') : '<div class="empty-state">No notifications yet.</div>'}
    </div>
  `;
}

// ---------- AUDIT LOG ----------
async function AuditScreen() {
  const { logs } = await api(`/api/families/${state.user.familyId}/audit-logs`);
  state.auditLogs = logs;
  return `
    <h1>Audit Log</h1>
    <p class="subtitle">Every change to events, members, settings, budget, meals, and chores — admin only</p>
    <div class="card">
      <table>
        <thead><tr><th>When</th><th>Entity</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td class="muted" style="white-space:nowrap;">${new Date(l.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</td>
              <td>${l.entityType}</td>
              <td><span class="badge ${l.action === 'delete' ? 'declined' : l.action === 'create' ? 'accepted' : 'pending'}">${l.action}</span></td>
              <td class="muted" style="font-size:11px; max-width:340px; overflow:hidden; text-overflow:ellipsis;">${l.after ? escapeHtml(JSON.stringify(l.after).slice(0, 120)) : (l.before ? escapeHtml(JSON.stringify(l.before).slice(0,120)) : '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${logs.length === 0 ? '<div class="empty-state">No activity yet.</div>' : ''}
    </div>
  `;
}

// ---------- EVENT MODAL (also used for appointments/occasions via the Category field) ----------
function openEventModal(existing) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const isEdit = !!existing;
  const category = existing ? (existing.category || 'general') : 'general';
  backdrop.innerHTML = `
    <div class="modal">
      <h3 style="margin-top:0;">${isEdit ? 'Edit event' : 'New event'}</h3>
      <div class="field"><label>Title</label><input id="ev-title" value="${existing ? escapeHtml(existing.title) : ''}" /></div>
      <div class="field"><label>Type</label>
        <select id="ev-category">
          <option value="general" ${category==='general'?'selected':''}>General event</option>
          <option value="appointment" ${category==='appointment'?'selected':''}>Appointment / occasion (doctor visit, birthday, graduation, etc.)</option>
        </select>
      </div>
      <div class="field" id="ev-provider-field" style="${category==='appointment' ? '' : 'display:none;'}">
        <label>Provider / occasion detail (optional)</label>
        <input id="ev-provider" placeholder="e.g. Dr. Patel — Pediatrics, or leave blank for birthdays/graduations" value="${existing ? escapeHtml(existing.provider || '') : ''}" />
      </div>
      <div class="field"><label>Location</label><input id="ev-location" value="${existing ? escapeHtml(existing.location) : ''}" /></div>
      <div class="field"><label>Description</label><textarea id="ev-desc" rows="2">${existing ? escapeHtml(existing.description) : ''}</textarea></div>
      <div class="row" style="gap:10px;">
        <div class="field" style="flex:1;"><label>Start</label><input id="ev-start" type="datetime-local" value="${existing ? toLocalInput(existing.startAt) : toLocalInput(new Date().toISOString())}"/></div>
        <div class="field" style="flex:1;"><label>End</label><input id="ev-end" type="datetime-local" value="${existing ? toLocalInput(existing.endAt) : toLocalInput(new Date(Date.now()+3600000).toISOString())}"/></div>
      </div>
      <div class="field"><label>Recurrence</label>
        <select id="ev-recurrence">
          ${['none','daily','weekly','monthly'].map(r => `<option value="${r}" ${existing && existing.recurrence===r ? 'selected':''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Assign to</label>
        ${state.members.map((m) => `
          <div class="checkbox-row">
            <input type="checkbox" class="assignee-cb" value="${m.id}" ${existing && existing.assignees?.some(a=>a.userId===m.id) ? 'checked' : ''}/>
            <div class="avatar sm" style="background:${m.avatarColor}">${initials(m.name)}</div> ${escapeHtml(m.name)}
          </div>`).join('')}
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:14px;">
        ${isEdit ? '<button class="btn danger" id="ev-delete">Delete</button>' : ''}
        <button class="btn secondary" id="ev-cancel">Cancel</button>
        <button class="btn" id="ev-save">${isEdit ? 'Save changes' : 'Create event'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#ev-cancel').onclick = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector('#ev-category').onchange = (e) => {
    backdrop.querySelector('#ev-provider-field').style.display = e.target.value === 'appointment' ? '' : 'none';
  };

  if (isEdit) {
    backdrop.querySelector('#ev-delete').onclick = async () => {
      await api(`/api/events/${existing.masterId || existing.id}`, { method: 'DELETE' });
      toast('Event deleted'); backdrop.remove(); render();
    };
  }
  backdrop.querySelector('#ev-save').onclick = async () => {
    const payload = {
      title: backdrop.querySelector('#ev-title').value,
      location: backdrop.querySelector('#ev-location').value,
      description: backdrop.querySelector('#ev-desc').value,
      startAt: new Date(backdrop.querySelector('#ev-start').value).toISOString(),
      endAt: new Date(backdrop.querySelector('#ev-end').value).toISOString(),
      recurrence: backdrop.querySelector('#ev-recurrence').value,
      category: backdrop.querySelector('#ev-category').value,
      provider: backdrop.querySelector('#ev-provider').value,
      assigneeIds: [...backdrop.querySelectorAll('.assignee-cb:checked')].map((cb) => cb.value),
    };
    if (!payload.title) { markInvalid(backdrop.querySelector('#ev-title')); return toast('Title is required', true); }
    if (!backdrop.querySelector('#ev-start').value) { markInvalid(backdrop.querySelector('#ev-start')); return toast('Start time is required', true); }
    if (!backdrop.querySelector('#ev-end').value) { markInvalid(backdrop.querySelector('#ev-end')); return toast('End time is required', true); }
    if (new Date(payload.endAt) <= new Date(payload.startAt)) { markInvalid(backdrop.querySelector('#ev-end')); return toast('End must be after start', true); }
    try {
      if (isEdit) {
        payload.version = existing.version;
        const r = await api(`/api/events/${existing.masterId || existing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        if (r.conflict) toast(`Saved with conflict resolution on: ${r.conflictFields.join(', ')}`);
        else toast('Event updated');
      } else {
        await api(`/api/families/${state.user.familyId}/events`, { method: 'POST', body: JSON.stringify(payload) });
        toast('Event created');
      }
      backdrop.remove();
      render();
    } catch {}
  };
}
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- DAY SUMMARY MODAL ----------
function openDayModal(date, dayEvents) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const label = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  backdrop.innerHTML = `
    <div class="modal" style="width:400px;">
      <div class="row between" style="margin-bottom:14px;">
        <h3 style="margin:0;">${label}</h3>
        <button class="btn secondary sm" id="day-close">✕</button>
      </div>
      <div id="day-event-list">
        ${dayEvents.map((e) => {
          const t = new Date(e.startAt);
          const tag = e.category === 'appointment' ? '<span class="badge admin" style="margin-right:6px;">📌</span>' : '';
          return `<div class="event-row day-event-item" data-eid="${e.masterId || e.id}" style="cursor:pointer; border:1px solid var(--border); border-radius:10px; margin-bottom:8px;">
            <div class="event-time">${e.allDay ? 'All day' : t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
            <div style="flex:1;">
              <div class="event-title">${tag}${escapeHtml(e.title)}</div>
              ${e.location ? `<div class="event-meta">📍 ${escapeHtml(e.location)}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
      <button class="btn sm" id="day-new-event" style="width:100%; margin-top:6px;">+ New event this day</button>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#day-close').onclick = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelectorAll('.day-event-item').forEach((item) => {
    item.onmouseenter = () => { item.style.borderColor = 'var(--primary)'; };
    item.onmouseleave = () => { item.style.borderColor = 'var(--border)'; };
    item.onclick = () => {
      backdrop.remove();
      const ev = state.events.find((e) => (e.masterId || e.id) === item.dataset.eid);
      if (ev) openEventModal(ev);
    };
  });
  backdrop.querySelector('#day-new-event').onclick = () => { backdrop.remove(); openEventModal(null); };
}

// ---------- BUDGET MODALS ----------
function openBudgetCategoryModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3 style="margin-top:0;">New budget category</h3>
      <div class="field"><label>Name</label><input id="bc-name" placeholder="e.g. Groceries" /></div>
      <div class="field"><label>Monthly limit ($)</label><input id="bc-limit" type="number" step="0.01" value="0" /></div>
      <div class="field"><label>Color</label><input id="bc-color" type="color" value="#6366f1" /></div>
      <div class="row" style="justify-content:flex-end; gap:8px;">
        <button class="btn secondary" id="bc-cancel">Cancel</button>
        <button class="btn" id="bc-save">Create</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#bc-cancel').onclick = () => backdrop.remove();
  backdrop.querySelector('#bc-save').onclick = async () => {
    const name = document.querySelector('#bc-name').value;
    if (!name) { markInvalid(document.querySelector('#bc-name')); return toast('Name is required', true); }
    const monthlyLimit = Number(document.querySelector('#bc-limit').value) || 0;
    const color = document.querySelector('#bc-color').value;
    try {
      await api(`/api/families/${state.user.familyId}/budget/categories`, { method: 'POST', body: JSON.stringify({ name, monthlyLimit, color }) });
      toast('Category created'); backdrop.remove(); render();
    } catch {}
  };
}
function openBudgetTransactionModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3 style="margin-top:0;">Log a transaction</h3>
      <div class="field"><label>Category</label>
        <select id="bt-cat">${state.budgetCategories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Amount ($) — positive = expense, negative = refund/income</label><input id="bt-amount" type="number" step="0.01" /></div>
      <div class="field"><label>Description</label><input id="bt-desc" /></div>
      <div class="field"><label>Date</label><input id="bt-date" type="date" value="${new Date().toISOString().slice(0,10)}" /></div>
      <div class="field">
        <label>Payment method</label>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn sm pm-btn" data-pm="cash" style="background:var(--primary);color:white;">💵 Cash</button>
          <button class="btn sm pm-btn secondary" data-pm="credit_card">💳 Credit</button>
          <button class="btn sm pm-btn secondary" data-pm="debit_card">🏦 Debit</button>
          <button class="btn sm pm-btn secondary" data-pm="gcash">📱 GCash</button>
        </div>
      </div>
      <div class="field">
        <label>Receipt (optional)</label>
        <input type="file" id="bt-receipt-input" accept="image/*" capture="environment" style="display:none;" />
        <button class="btn secondary sm" id="bt-receipt-btn" style="width:100%;">📷 Scan / attach receipt</button>
        <div id="bt-receipt-preview" style="display:none; margin-top:8px; position:relative;">
          <img id="bt-receipt-img" style="width:100%; max-height:160px; object-fit:contain; border-radius:8px; border:1px solid var(--border);" />
          <button class="btn danger sm" id="bt-receipt-remove" style="position:absolute; top:4px; right:4px;">✕</button>
        </div>
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px;">
        <button class="btn secondary" id="bt-cancel">Cancel</button>
        <button class="btn" id="bt-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (state.budgetCategories.length === 0) { toast('Create a budget category first', true); backdrop.remove(); return; }

  let selectedPm = 'cash';
  backdrop.querySelectorAll('.pm-btn').forEach((b) => {
    b.onclick = () => {
      selectedPm = b.dataset.pm;
      backdrop.querySelectorAll('.pm-btn').forEach((x) => { x.style.background = ''; x.style.color = ''; x.className = 'btn sm pm-btn secondary'; });
      b.className = 'btn sm pm-btn'; b.style.background = 'var(--primary)'; b.style.color = 'white';
    };
  });

  let receiptImage = null;
  backdrop.querySelector('#bt-receipt-btn').onclick = () => backdrop.querySelector('#bt-receipt-input').click();
  backdrop.querySelector('#bt-receipt-input').onchange = (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 600;
        let w = img.width, h = img.height;
        if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        receiptImage = canvas.toDataURL('image/jpeg', 0.72);
        backdrop.querySelector('#bt-receipt-img').src = receiptImage;
        backdrop.querySelector('#bt-receipt-preview').style.display = 'block';
        backdrop.querySelector('#bt-receipt-btn').style.display = 'none';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };
  backdrop.querySelector('#bt-receipt-remove').onclick = () => {
    receiptImage = null;
    backdrop.querySelector('#bt-receipt-preview').style.display = 'none';
    backdrop.querySelector('#bt-receipt-btn').style.display = '';
    backdrop.querySelector('#bt-receipt-input').value = '';
  };

  backdrop.querySelector('#bt-cancel').onclick = () => backdrop.remove();
  backdrop.querySelector('#bt-save').onclick = async () => {
    const categoryId = backdrop.querySelector('#bt-cat').value;
    const amount = Number(backdrop.querySelector('#bt-amount').value);
    const description = backdrop.querySelector('#bt-desc').value;
    const occurredOn = backdrop.querySelector('#bt-date').value;
    if (!amount) { markInvalid(backdrop.querySelector('#bt-amount')); return toast('Amount is required', true); }
    if (!occurredOn) { markInvalid(backdrop.querySelector('#bt-date')); return toast('Date is required', true); }
    try {
      await api(`/api/families/${state.user.familyId}/budget/transactions`, { method: 'POST', body: JSON.stringify({ categoryId, amount, description, occurredOn, paymentMethod: selectedPm, receiptImage }) });
      toast('Transaction logged'); backdrop.remove(); render();
    } catch {}
  };
}

// ---------- MEAL MODAL ----------
function openMealModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3 style="margin-top:0;">Add a meal</h3>
      <div class="field"><label>Date</label><input id="ml-date" type="date" value="${new Date().toISOString().slice(0,10)}" /></div>
      <div class="field"><label>Meal</label>
        <select id="ml-type">${['breakfast','lunch','dinner','snack'].map(t => `<option value="${t}">${t}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Title</label><input id="ml-title" placeholder="e.g. Taco night" /></div>
      <div class="field"><label>Notes</label><input id="ml-notes" /></div>
      <div class="field"><label>Calories (optional)</label><input id="ml-calories" type="number" min="0" placeholder="e.g. 450" /></div>
      <div class="field"><label>Assigned cook</label>
        <select id="ml-cook"><option value="">Unassigned</option>${state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}</select>
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px;">
        <button class="btn secondary" id="ml-cancel">Cancel</button>
        <button class="btn" id="ml-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#ml-cancel').onclick = () => backdrop.remove();
  backdrop.querySelector('#ml-save').onclick = async () => {
    const mealDate = backdrop.querySelector('#ml-date').value;
    const mealType = backdrop.querySelector('#ml-type').value;
    const title = backdrop.querySelector('#ml-title').value;
    const notes = backdrop.querySelector('#ml-notes').value;
    const calories = Number(backdrop.querySelector('#ml-calories').value) || 0;
    const assignedCook = backdrop.querySelector('#ml-cook').value || null;
    if (!title) { markInvalid(backdrop.querySelector('#ml-title')); return toast('Title is required', true); }
    try {
      await api(`/api/families/${state.user.familyId}/meals`, { method: 'POST', body: JSON.stringify({ mealDate, mealType, title, notes, calories, assignedCook }) });
      toast('Meal added'); backdrop.remove(); render();
    } catch {}
  };
}

// ---------- CHORE MODAL ----------
function openChoreModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3 style="margin-top:0;">Add a chore</h3>
      <div class="field"><label>Title</label><input id="ch-title" placeholder="e.g. Take out the trash" /></div>
      <div class="field"><label>Description</label><input id="ch-desc" /></div>
      <div class="field"><label>Assign to</label>
        <select id="ch-assignee"><option value="">Unassigned</option>${state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Recurrence</label>
        <select id="ch-recurrence">${['none','daily','weekly','monthly'].map(r => `<option value="${r}">${r}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Due date (optional)</label><input id="ch-due" type="date" /></div>
      <div class="field"><label>Points</label><input id="ch-points" type="number" value="5" /></div>
      <div class="row" style="justify-content:flex-end; gap:8px;">
        <button class="btn secondary" id="ch-cancel">Cancel</button>
        <button class="btn" id="ch-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#ch-cancel').onclick = () => backdrop.remove();
  backdrop.querySelector('#ch-save').onclick = async () => {
    const title = document.querySelector('#ch-title').value;
    if (!title) { markInvalid(document.querySelector('#ch-title')); return toast('Title is required', true); }
    const description = document.querySelector('#ch-desc').value;
    const assigneeId = document.querySelector('#ch-assignee').value || null;
    const recurrence = document.querySelector('#ch-recurrence').value;
    const dueDate = document.querySelector('#ch-due').value || null;
    const points = Number(document.querySelector('#ch-points').value) || 0;
    try {
      await api(`/api/families/${state.user.familyId}/chores`, { method: 'POST', body: JSON.stringify({ title, description, assigneeId, recurrence, dueDate, points }) });
      toast('Chore added'); backdrop.remove(); render();
    } catch {}
  };
}

// ---------- wire up per-screen interactive events ----------
function wireScreenEvents(route) {
  setTimeout(() => {
    document.querySelectorAll('#add-event-btn').forEach((b) => b.onclick = () => openEventModal(null));
    document.querySelectorAll('.event-row[data-eid]').forEach((row) => {
      row.onclick = () => {
        const ev = state.events.find((e) => (e.masterId || e.id) === row.dataset.eid);
        if (ev) openEventModal(ev);
      };
    });
    document.querySelectorAll('.cal-day[data-date]').forEach((cell) => {
      cell.onclick = () => {
        const dayEvents = state.events.filter((e) => sameDay(new Date(e.startAt), new Date(cell.dataset.date)));
        if (dayEvents.length === 0) { openEventModal(null); return; }
        if (dayEvents.length === 1) { openEventModal(dayEvents[0]); return; }
        openDayModal(new Date(cell.dataset.date), dayEvents);
      };
    });
    document.querySelectorAll('#cal-prev').forEach((b) => b.onclick = () => { calCursor.setMonth(calCursor.getMonth() - 1); render(); });
    document.querySelectorAll('#cal-next').forEach((b) => b.onclick = () => { calCursor.setMonth(calCursor.getMonth() + 1); render(); });
    document.querySelectorAll('#ical-export-btn').forEach((b) => b.onclick = () => { exportIcal(state.events); toast('Downloading .ics file'); });
    document.querySelectorAll('.role-select').forEach((sel) => {
      let prevRole = sel.value;
      sel.onchange = async () => {
        const newRole = sel.value;
        const memberName = sel.closest('tr')?.querySelector('td')?.textContent?.trim() || 'this member';
        if (!confirm(`Change ${memberName}'s role to "${newRole}"?`)) {
          sel.value = prevRole;
          return;
        }
        try {
          await api(`/api/families/${state.user.familyId}/members/${sel.dataset.uid}`, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
          prevRole = newRole;
          toast('Role updated');
          render();
        } catch {
          sel.value = prevRole;
        }
      };
    });
    document.querySelectorAll('.remove-member').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Remove this member?')) return;
        await api(`/api/families/${state.user.familyId}/members/${b.dataset.uid}`, { method: 'DELETE' });
        toast('Member removed'); render();
      };
    });
    document.querySelectorAll('.edit-member-name').forEach((b) => {
      b.onclick = () => openEditNameModal(b.dataset.uid, b.dataset.name);
    });
    const inviteBtn = document.querySelector('#invite-btn');
    if (inviteBtn) inviteBtn.onclick = () => openInviteModal();
    const saveSettingsBtn = document.querySelector('#save-settings-btn');
    if (saveSettingsBtn) saveSettingsBtn.onclick = async () => {
      const name = document.querySelector('#set-name').value;
      const timezone = document.querySelector('#set-tz').value;
      const reminderMinutesBefore = Number(document.querySelector('#set-reminder').value);
      await api(`/api/families/${state.user.familyId}/settings`, { method: 'PUT', body: JSON.stringify({ name, timezone, settings: { reminderMinutesBefore } }) });
      toast('Settings saved'); render();
    };
    const markAllBtn = document.querySelector('#mark-all-read-btn');
    if (markAllBtn) markAllBtn.onclick = async () => { await api('/api/notifications/read-all', { method: 'POST' }); render(); };

    document.querySelectorAll('.event-row[data-nid]').forEach((row) => {
      row.style.cursor = 'pointer';
      row.onclick = async () => {
        const nid = row.dataset.nid;
        const notif = state.notifications.find((n) => n.id === nid);
        if (!notif || notif.read) return;
        // optimistic update — mark read immediately in UI
        const prev = unreadCount();
        notif.read = true;
        row.style.background = '';
        const dot = row.querySelector('div[style*="border-radius:50%"]');
        if (dot) dot.style.background = 'transparent';
        updateNotifBadge(prev);
        api(`/api/notifications/${nid}/read`, { method: 'POST' }).catch(() => { notif.read = false; updateNotifBadge(0); });
      };
    });

    // budget
    const budgetPrev = document.querySelector('#budget-prev');
    if (budgetPrev) budgetPrev.onclick = () => { budgetCursor.setMonth(budgetCursor.getMonth() - 1); render(); };
    const budgetNext = document.querySelector('#budget-next');
    if (budgetNext) budgetNext.onclick = () => { budgetCursor.setMonth(budgetCursor.getMonth() + 1); render(); };
    const addCatBtn = document.querySelector('#add-budget-cat-btn');
    if (addCatBtn) addCatBtn.onclick = () => openBudgetCategoryModal();
    const addTxBtn = document.querySelector('#add-budget-tx-btn');
    if (addTxBtn) addTxBtn.onclick = () => openBudgetTransactionModal();
    document.querySelectorAll('.remove-budget-tx').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Delete this transaction?')) return;
        await api(`/api/budget/transactions/${b.dataset.tid}`, { method: 'DELETE' });
        toast('Transaction deleted'); render();
      };
    });
    document.querySelectorAll('.receipt-thumb').forEach((img) => {
      img.onclick = () => {
        const lb = document.createElement('div');
        lb.className = 'modal-backdrop';
        lb.style.zIndex = '200';
        lb.innerHTML = `<div style="background:var(--card);border-radius:var(--radius);padding:16px;max-width:90vw;max-height:90vh;overflow:auto;">
          <img src="${img.src}" style="max-width:100%;max-height:80vh;object-fit:contain;border-radius:8px;" />
          <div style="text-align:right;margin-top:10px;"><button class="btn secondary sm" id="lb-close">Close</button></div>
        </div>`;
        document.body.appendChild(lb);
        lb.querySelector('#lb-close').onclick = () => lb.remove();
        lb.onclick = (e) => { if (e.target === lb) lb.remove(); };
      };
    });

    // meals
    const shoppingListBtn = document.querySelector('#shopping-list-btn');
    if (shoppingListBtn) shoppingListBtn.onclick = () => openShoppingListModal();
    const addMealBtn = document.querySelector('#add-meal-btn');
    if (addMealBtn) addMealBtn.onclick = () => openMealModal();
    document.querySelectorAll('.remove-meal').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Delete this meal?')) return;
        await api(`/api/meals/${b.dataset.mid}`, { method: 'DELETE' });
        toast('Meal deleted'); render();
      };
    });

    // chores
    const addChoreBtn = document.querySelector('#add-chore-btn');
    if (addChoreBtn) addChoreBtn.onclick = () => openChoreModal();
    document.querySelectorAll('.complete-chore').forEach((b) => {
      b.onclick = async () => {
        const r = await api(`/api/chores/${b.dataset.cid}/complete`, { method: 'POST', body: JSON.stringify({}) });
        toast(`Chore completed${r.pointsAwarded ? ' · +' + r.pointsAwarded + ' pts' : ''}`); render();
      };
    });
    document.querySelectorAll('.remove-chore').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Delete this chore?')) return;
        await api(`/api/chores/${b.dataset.cid}`, { method: 'DELETE' });
        toast('Chore deleted'); render();
      };
    });

    // search
    const searchBtn = document.querySelector('#search-btn');
    if (searchBtn) {
      const doSearch = async () => {
        const q = (document.querySelector('#search-q').value || '').trim().toLowerCase();
        const cat = document.querySelector('#search-cat').value;
        const fromVal = document.querySelector('#search-from').value;
        const toVal = document.querySelector('#search-to').value;
        const resultsEl = document.getElementById('search-results');
        resultsEl.innerHTML = `<div class="screen-loading"><div class="spinner"></div></div>`;
        try {
          const start = fromVal ? new Date(fromVal + 'T00:00:00').toISOString() : new Date(Date.now() - 90 * 86400000).toISOString();
          const end = toVal ? new Date(toVal + 'T23:59:59').toISOString() : new Date(Date.now() + 180 * 86400000).toISOString();
          let url = `/api/families/${state.user.familyId}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
          if (cat) url += `&category=${encodeURIComponent(cat)}`;
          const { events } = await api(url);
          state.events = events;
          const filtered = q ? events.filter((e) =>
            e.title.toLowerCase().includes(q) ||
            (e.provider || '').toLowerCase().includes(q) ||
            (e.location || '').toLowerCase().includes(q)
          ) : events;
          if (filtered.length === 0) {
            resultsEl.innerHTML = `<div class="empty-state">No events match your search.</div>`;
            return;
          }
          const byDate = {};
          filtered.forEach((e) => { const k = new Date(e.startAt).toDateString(); (byDate[k] ||= []).push(e); });
          let html = '';
          Object.entries(byDate).forEach(([ds, dayEvs]) => {
            const d = new Date(ds);
            html += `<div class="event-date-header">${sameDay(d, new Date()) ? 'Today · ' : ''}${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>`;
            html += dayEvs.map(eventRowHtml).join('');
          });
          resultsEl.innerHTML = `<div class="card">${html}<p class="muted" style="padding:8px 0 4px; text-align:right; font-size:12px;">${filtered.length} event${filtered.length !== 1 ? 's' : ''} found</p></div>`;
          resultsEl.querySelectorAll('.event-row[data-eid]').forEach((row) => {
            row.onclick = () => {
              const ev = state.events.find((e) => (e.masterId || e.id) === row.dataset.eid);
              if (ev) openEventModal(ev);
            };
          });
        } catch (e) {
          resultsEl.innerHTML = `<div class="empty-state">Search failed: ${e.message}</div>`;
        }
      };
      searchBtn.onclick = doSearch;
      document.querySelector('#search-q').onkeydown = (ev) => { if (ev.key === 'Enter') doSearch(); };
    }
  }, 0);
}

function openShoppingListModal() {
  const meals = state.meals || [];
  const byDate = {};
  meals.forEach((m) => { (byDate[m.mealDate] ||= []).push(m); });
  const dates = Object.keys(byDate).sort();
  const weekLabel = dates.length
    ? `Week of ${new Date(dates[0] + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    : 'Upcoming meals';
  const generatedDate = new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  const lines = [
    `FamilyOS Shopping List — ${weekLabel}`,
    `Generated ${generatedDate}`,
    '',
  ];
  dates.forEach((date) => {
    lines.push(new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) + ':');
    (byDate[date] || []).forEach((m) => {
      const type = m.mealType.charAt(0).toUpperCase() + m.mealType.slice(1);
      lines.push(`  ${type}: ${m.title}${m.notes ? ' (' + m.notes + ')' : ''}`);
    });
    lines.push('');
  });
  if (!dates.length) lines.push('  No meals planned yet.');

  const plainText = lines.join('\n');
  const htmlRows = dates.map((date) => `
    <div style="margin-bottom:12px;">
      <div style="font-weight:700; margin-bottom:4px;">${new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>
      ${(byDate[date] || []).map((m) => `
        <div class="event-row" style="padding:4px 8px;">
          <span class="badge member" style="text-transform:capitalize; flex-shrink:0;">${m.mealType}</span>
          <div style="flex:1;">${escapeHtml(m.title)}${m.notes ? '<span class="muted"> — ' + escapeHtml(m.notes) + '</span>' : ''}</div>
        </div>`).join('')}
    </div>`).join('');

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="max-width:480px;">
      <h3 style="margin-top:0;">🛒 Shopping List</h3>
      <p class="muted" style="margin-top:-8px; margin-bottom:16px; font-size:13px;">${weekLabel} · ${generatedDate}</p>
      <div style="max-height:360px; overflow-y:auto;">
        ${dates.length ? htmlRows : '<div class="empty-state">No meals planned yet.</div>'}
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:16px;">
        <button class="btn secondary" id="sl-cancel">Close</button>
        <button class="btn" id="sl-copy">Copy as text</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#sl-cancel').onclick = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector('#sl-copy').onclick = () => {
    navigator.clipboard.writeText(plainText).then(() => toast('Copied to clipboard')).catch(() => {
      // fallback: select a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = plainText; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      ta.remove(); toast('Copied to clipboard');
    });
  };
}

function openEditNameModal(userId, currentName) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="width:360px;">
      <h3 style="margin-top:0;">Edit name</h3>
      <div class="field"><label>Name</label><input id="en-name" value="${escapeHtml(currentName)}" /></div>
      <div class="row" style="justify-content:flex-end; gap:8px;">
        <button class="btn secondary" id="en-cancel">Cancel</button>
        <button class="btn" id="en-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const nameInput = backdrop.querySelector('#en-name');
  nameInput.focus(); nameInput.select();
  backdrop.querySelector('#en-cancel').onclick = () => backdrop.remove();
  backdrop.querySelector('#en-save').onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) { markInvalid(nameInput); return toast('Name cannot be empty', true); }
    if (name === currentName) { backdrop.remove(); return; }
    try {
      await api(`/api/families/${state.user.familyId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      // update local state immediately so sidebar/avatar reflect change
      if (state.user.id === userId) state.user.name = name;
      toast('Name updated'); backdrop.remove(); render();
    } catch {}
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') backdrop.querySelector('#en-save').click(); });
}

function openInviteModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3 style="margin-top:0;">Invite a family member</h3>
      <div class="field"><label>Name</label><input id="inv-name" /></div>
      <div class="field"><label>Email</label><input id="inv-email" type="email" /></div>
      <div class="field"><label>Role</label>
        <select id="inv-role"><option value="member">member</option><option value="child">child</option><option value="admin">admin</option></select>
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px;">
        <button class="btn secondary" id="inv-cancel">Cancel</button>
        <button class="btn" id="inv-send">Send invite</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#inv-cancel').onclick = () => backdrop.remove();
  backdrop.querySelector('#inv-send').onclick = async () => {
    const name = document.querySelector('#inv-name').value;
    const email = document.querySelector('#inv-email').value;
    const role = document.querySelector('#inv-role').value;
    if (!name) { markInvalid(document.querySelector('#inv-name')); return toast('Name is required', true); }
    if (!email) { markInvalid(document.querySelector('#inv-email')); return toast('Email is required', true); }
    try {
      await api(`/api/families/${state.user.familyId}/members/invite`, { method: 'POST', body: JSON.stringify({ name, email, role }) });
      toast('Invite created — they can dev-login from the login screen now');
      backdrop.remove(); render();
    } catch {}
  };
}

render();

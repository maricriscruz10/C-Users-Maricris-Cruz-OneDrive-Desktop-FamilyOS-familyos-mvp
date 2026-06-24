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
const ROUTES = ['login', 'dashboard', 'calendar', 'budget', 'meals', 'chores', 'members', 'settings', 'notifications', 'audit'];
function navigate(route) { location.hash = `#/${route}`; }
window.addEventListener('hashchange', render);

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
  ['event_created', 'event_updated', 'event_deleted', 'notification', 'member_updated', 'family_updated',
   'budget_updated', 'meal_updated', 'chore_updated'].forEach((evt) => {
    es.addEventListener(evt, () => { refreshData().then(render); });
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

  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="brand"><span class="dot"></span> FamilyOS</div>
    ${navLink('dashboard', '🏠', 'Dashboard', route)}
    ${navLink('calendar', '📅', 'Calendar', route)}
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
  `;
  sidebar.querySelectorAll('.nav-link[data-route]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.route));
  });
  sidebar.querySelector('#logout-btn').addEventListener('click', logout);

  const main = document.createElement('div');
  main.className = 'main';
  main.appendChild(screenFor(route));

  wrap.appendChild(sidebar);
  wrap.appendChild(main);
  return wrap;
}
function navLink(route, icon, label, current, badge) {
  return `<div class="nav-link${route === current ? ' active' : ''}" data-route="${route}">
    <span>${icon}</span><span>${label}</span>${badge ? `<span class="badge pending" style="margin-left:auto;">${badge}</span>` : ''}
  </div>`;
}
function unreadCount() { const n = state.notifications.filter((x) => !x.read).length; return n || ''; }
function initials(name) { return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }

function screenFor(route) {
  const el = document.createElement('div');
  el.id = 'screen-root';
  (async () => {
    try {
      if (route === 'dashboard') el.innerHTML = await DashboardScreen();
      else if (route === 'calendar') el.innerHTML = await CalendarScreen();
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
  try {
    const { chores } = await api(`/api/families/${fam}/chores`);
    state.chores = chores;
    const myChores = chores.filter((c) => c.assigneeId === state.user.id && c.status === 'pending');
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
  `;
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

// ---------- CALENDAR ----------
let calCursor = new Date();
async function CalendarScreen() {
  const fam = state.user.familyId;
  const monthStart = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1);
  const monthEnd = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 0, 23, 59, 59);
  const gridStart = new Date(monthStart); gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(monthEnd); gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  const { events } = await api(`/api/families/${fam}/events?start=${gridStart.toISOString()}&end=${gridEnd.toISOString()}`);
  state.events = events;

  const days = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));

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
            ${dayEvents.slice(0, 3).map((e) => `<div class="cal-pill" title="${escapeHtml(e.title)}">${e.category === 'appointment' ? '📌 ' : ''}${escapeHtml(e.title)}</div>`).join('')}
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
  const [catRes, txRes, sumRes] = await Promise.all([
    api(`/api/families/${fam}/budget/categories`),
    api(`/api/families/${fam}/budget/transactions`),
    api(`/api/families/${fam}/budget/summary`),
  ]);
  state.budgetCategories = catRes.categories;
  state.budgetTransactions = txRes.transactions;
  state.budgetSummary = sumRes;
  const canManageCats = state.user.role === 'admin';

  const catName = (id) => (state.budgetCategories.find((c) => c.id === id) || {}).name || '—';

  return `
    <div class="row between"><h1>Budget</h1>
      <div class="flex-gap">
        ${canManageCats ? '<button class="btn secondary sm" id="add-budget-cat-btn">+ Category</button>' : ''}
        <button class="btn sm" id="add-budget-tx-btn">+ Transaction</button>
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

    <div class="card">
      <h3>Transactions this household has logged</h3>
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th>${canManageCats ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${state.budgetTransactions.map((t) => `
            <tr>
              <td class="muted">${t.occurredOn}</td>
              <td>${escapeHtml(catName(t.categoryId))}</td>
              <td>${escapeHtml(t.description)}</td>
              <td style="font-weight:600;">$${t.amount.toFixed(2)}</td>
              <td><button class="btn danger sm remove-budget-tx" data-tid="${t.id}">Delete</button></td>
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

  return `
    <div class="row between"><h1>Meal Plan</h1>${canManage ? '<button class="btn sm" id="add-meal-btn">+ Add meal</button>' : ''}</div>
    <p class="subtitle">Next two weeks · ${meals.length} planned meal${meals.length === 1 ? '' : 's'}</p>
    ${dates.length ? dates.map((date) => `
      <div class="card">
        <h3>${new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
        ${byDate[date].map((m) => `
          <div class="event-row" data-mid="${canManage ? m.id : ''}">
            <span class="badge member" style="text-transform:capitalize;">${m.mealType}</span>
            <div style="flex:1;">
              <div class="event-title">${escapeHtml(m.title)}</div>
              <div class="event-meta">${m.notes ? escapeHtml(m.notes) + ' · ' : ''}👨‍🍳 ${cookName(m.assignedCook)}</div>
            </div>
            ${canManage ? `<button class="btn danger sm remove-meal" data-mid="${m.id}">Delete</button>` : ''}
          </div>`).join('')}
      </div>`).join('') : '<div class="empty-state">No meals planned yet.</div>'}
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

  return `
    <div class="row between"><h1>Chores</h1>${canManage ? '<button class="btn sm" id="add-chore-btn">+ Add chore</button>' : ''}</div>
    <p class="subtitle">${pending.length} pending · ${completed.length} completed</p>
    <div class="card">
      <h3>To do</h3>
      ${pending.length ? pending.map(choreRow).join('') : '<div class="empty-state">Nothing pending — nice work!</div>'}
    </div>
    <div class="card">
      <h3>Recently completed</h3>
      ${completed.length ? completed.slice(0, 10).map(choreRow).join('') : '<div class="empty-state">No completed chores yet.</div>'}
    </div>
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
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${state.members.map((m) => `
            <tr>
              <td><div class="row"><div class="avatar sm" style="background:${m.avatarColor}">${initials(m.name)}</div>${escapeHtml(m.name)}</div></td>
              <td class="muted">${m.email}</td>
              <td>
                ${isAdmin && m.id !== state.user.id
                  ? `<select class="role-select" data-uid="${m.id}" style="width:auto; padding:4px 8px;">
                      ${['admin','member','child'].map(r => `<option value="${r}" ${r===m.role?'selected':''}>${r}</option>`).join('')}
                    </select>`
                  : `<span class="badge ${m.role}">${m.role}</span>`}
              </td>
              <td><span class="badge ${m.status === 'active' ? 'accepted' : m.status === 'invited' ? 'pending' : 'declined'}">${m.status}</span></td>
              ${isAdmin ? `<td>${m.id !== state.user.id ? `<button class="btn danger sm remove-member" data-uid="${m.id}">Remove</button>` : ''}</td>` : ''}
            </tr>`).join('')}
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
    if (!payload.title) return toast('Title is required', true);
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
    if (!name) return toast('Name is required', true);
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
      <div class="row" style="justify-content:flex-end; gap:8px;">
        <button class="btn secondary" id="bt-cancel">Cancel</button>
        <button class="btn" id="bt-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  if (state.budgetCategories.length === 0) { toast('Create a budget category first', true); backdrop.remove(); return; }
  backdrop.querySelector('#bt-cancel').onclick = () => backdrop.remove();
  backdrop.querySelector('#bt-save').onclick = async () => {
    const categoryId = document.querySelector('#bt-cat').value;
    const amount = Number(document.querySelector('#bt-amount').value);
    const description = document.querySelector('#bt-desc').value;
    const occurredOn = document.querySelector('#bt-date').value;
    if (!amount || !occurredOn) return toast('Amount and date are required', true);
    try {
      await api(`/api/families/${state.user.familyId}/budget/transactions`, { method: 'POST', body: JSON.stringify({ categoryId, amount, description, occurredOn }) });
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
    const mealDate = document.querySelector('#ml-date').value;
    const mealType = document.querySelector('#ml-type').value;
    const title = document.querySelector('#ml-title').value;
    const notes = document.querySelector('#ml-notes').value;
    const assignedCook = document.querySelector('#ml-cook').value || null;
    if (!title) return toast('Title is required', true);
    try {
      await api(`/api/families/${state.user.familyId}/meals`, { method: 'POST', body: JSON.stringify({ mealDate, mealType, title, notes, assignedCook }) });
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
    if (!title) return toast('Title is required', true);
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
        if (dayEvents.length === 1) openEventModal(dayEvents[0]);
        else openEventModal(null);
      };
    });
    document.querySelectorAll('#cal-prev').forEach((b) => b.onclick = () => { calCursor.setMonth(calCursor.getMonth() - 1); render(); });
    document.querySelectorAll('#cal-next').forEach((b) => b.onclick = () => { calCursor.setMonth(calCursor.getMonth() + 1); render(); });
    document.querySelectorAll('.role-select').forEach((sel) => {
      sel.onchange = async () => {
        await api(`/api/families/${state.user.familyId}/members/${sel.dataset.uid}`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) });
        toast('Role updated'); render();
      };
    });
    document.querySelectorAll('.remove-member').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Remove this member?')) return;
        await api(`/api/families/${state.user.familyId}/members/${b.dataset.uid}`, { method: 'DELETE' });
        toast('Member removed'); render();
      };
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

    // budget
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

    // meals
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
  }, 0);
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
    if (!name || !email) return toast('Name and email are required', true);
    try {
      await api(`/api/families/${state.user.familyId}/members/invite`, { method: 'POST', body: JSON.stringify({ name, email, role }) });
      toast('Invite created — they can dev-login from the login screen now');
      backdrop.remove(); render();
    } catch {}
  };
}

render();

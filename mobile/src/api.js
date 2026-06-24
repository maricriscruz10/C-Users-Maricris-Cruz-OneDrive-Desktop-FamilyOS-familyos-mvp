// Network layer with offline queueing. If a write fails because the device
// is offline, the mutation is queued and replayed once connectivity returns
// (checked by polling /api/health). Reads fall back to the local cache.
import { API_BASE } from './config';
import { Cache, Queue } from './storage';

let isOnline = true;
const listeners = new Set();
export function onConnectivityChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setOnline(v) { if (v !== isOnline) { isOnline = v; listeners.forEach((fn) => fn(v)); } }
export function getOnline() { return isOnline; }

async function request(path, opts = {}, { timeout = 6000 } = {}) {
  const token = await Cache.getToken();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers, signal: controller.signal });
    clearTimeout(t);
    setOnline(true);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error?.message || 'Request failed'), { status: res.status, body });
    return body;
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError' || e.message?.includes('Network request failed')) setOnline(false);
    throw e;
  }
}

export const Api = {
  health: () => request('/api/health'),
  devUsers: () => request('/api/dev/users'),
  login: (userId) => request('/api/auth/dev-login', { method: 'POST', body: JSON.stringify({ userId }) }),
  me: () => request('/api/auth/me'),
  family: (id) => request(`/api/families/${id}`),
  members: (id) => request(`/api/families/${id}/members`),
  events: (id, start, end) => request(`/api/families/${id}/events?start=${start}&end=${end}`),
  notifications: () => request('/api/notifications'),
  markNotificationRead: (id) => request(`/api/notifications/${id}/read`, { method: 'POST' }),
  registerPushToken: (token) => request('/api/auth/push-token', { method: 'POST', body: JSON.stringify({ token }) }),
  respond: (eventId, status) => request(`/api/events/${eventId}/respond`, { method: 'POST', body: JSON.stringify({ status }) }),

  // ---- Budgeting (Child role gets 403 from the backend — screen is hidden client-side too) ----
  budgetCategories: (familyId) => request(`/api/families/${familyId}/budget/categories`),
  budgetTransactions: (familyId) => request(`/api/families/${familyId}/budget/transactions`),
  budgetSummary: (familyId) => request(`/api/families/${familyId}/budget/summary`),
  createBudgetCategory: (familyId, payload) => request(`/api/families/${familyId}/budget/categories`, { method: 'POST', body: JSON.stringify(payload) }),
  createBudgetTransaction: (familyId, payload) => request(`/api/families/${familyId}/budget/transactions`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteBudgetTransaction: (id) => request(`/api/budget/transactions/${id}`, { method: 'DELETE' }),

  // ---- Meal planning ----
  meals: (familyId, start, end) => request(`/api/families/${familyId}/meals?start=${start}&end=${end}`),
  createMeal: (familyId, payload) => request(`/api/families/${familyId}/meals`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteMeal: (id) => request(`/api/meals/${id}`, { method: 'DELETE' }),

  // ---- Chores ----
  chores: (familyId) => request(`/api/families/${familyId}/chores`),
  createChore: (familyId, payload) => request(`/api/families/${familyId}/chores`, { method: 'POST', body: JSON.stringify(payload) }),
  completeChore: (id) => request(`/api/chores/${id}/complete`, { method: 'POST', body: JSON.stringify({}) }),
  deleteChore: (id) => request(`/api/chores/${id}`, { method: 'DELETE' }),

  // Mutating calls go through queueIfOffline so they survive no-connectivity testing.
  async createEvent(familyId, payload) {
    return queueIfOffline({ type: 'createEvent', familyId, payload }, () =>
      request(`/api/families/${familyId}/events`, { method: 'POST', body: JSON.stringify(payload) }));
  },
  async updateEvent(eventId, payload) {
    return queueIfOffline({ type: 'updateEvent', eventId, payload }, () =>
      request(`/api/events/${eventId}`, { method: 'PUT', body: JSON.stringify(payload) }));
  },
  async deleteEvent(eventId) {
    return queueIfOffline({ type: 'deleteEvent', eventId }, () =>
      request(`/api/events/${eventId}`, { method: 'DELETE' }));
  },
};

async function queueIfOffline(mutation, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isOnline || e.name === 'AbortError') {
      await Queue.push(mutation);
      return { queued: true, offline: true };
    }
    throw e;
  }
}

// Replays queued mutations in order once back online. Call this after
// `onConnectivityChange` reports true, or on app foreground.
export async function flushQueue() {
  const queue = await Queue.list();
  if (!queue.length) return { flushed: 0 };
  let flushed = 0;
  for (const m of queue) {
    try {
      if (m.type === 'createEvent') await request(`/api/families/${m.familyId}/events`, { method: 'POST', body: JSON.stringify(m.payload) });
      if (m.type === 'updateEvent') await request(`/api/events/${m.eventId}`, { method: 'PUT', body: JSON.stringify(m.payload) });
      if (m.type === 'deleteEvent') await request(`/api/events/${m.eventId}`, { method: 'DELETE' });
      await Queue.removeOne(m.id);
      flushed++;
    } catch {
      break; // stop on first failure to preserve order; will retry next flush
    }
  }
  return { flushed };
}

// Lightweight connectivity poll — also used by the UI to show an offline banner.
export function startConnectivityPolling(intervalMs = 10000) {
  const tick = async () => {
    try { await Api.health(); const wasOffline = !isOnline; setOnline(true); if (wasOffline) await flushQueue(); }
    catch { setOnline(false); }
  };
  tick();
  return setInterval(tick, intervalMs);
}

// Offline-first local cache + mutation queue, backed by AsyncStorage.
// Mirrors the BRD requirement: "Offline-first cache for last 30 days of events".
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  TOKEN: 'familyos.token',
  EVENTS: 'familyos.cache.events',
  MEMBERS: 'familyos.cache.members',
  NOTIFICATIONS: 'familyos.cache.notifications',
  FAMILY: 'familyos.cache.family',
  USER: 'familyos.cache.user',
  QUEUE: 'familyos.mutationQueue', // pending writes made while offline
};

async function get(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
async function set(key, value) {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export const Cache = {
  getToken: () => AsyncStorage.getItem(KEYS.TOKEN),
  setToken: (t) => (t ? AsyncStorage.setItem(KEYS.TOKEN, t) : AsyncStorage.removeItem(KEYS.TOKEN)),
  getEvents: () => get(KEYS.EVENTS, []),
  setEvents: (v) => set(KEYS.EVENTS, v),
  getMembers: () => get(KEYS.MEMBERS, []),
  setMembers: (v) => set(KEYS.MEMBERS, v),
  getNotifications: () => get(KEYS.NOTIFICATIONS, []),
  setNotifications: (v) => set(KEYS.NOTIFICATIONS, v),
  getFamily: () => get(KEYS.FAMILY, null),
  setFamily: (v) => set(KEYS.FAMILY, v),
  getUser: () => get(KEYS.USER, null),
  setUser: (v) => set(KEYS.USER, v),
  clearAll: () => AsyncStorage.multiRemove(Object.values(KEYS)),
};

export const Queue = {
  async list() { return get(KEYS.QUEUE, []); },
  async push(mutation) {
    const q = await get(KEYS.QUEUE, []);
    q.push({ ...mutation, queuedAt: new Date().toISOString(), id: Math.random().toString(36).slice(2) });
    await set(KEYS.QUEUE, q);
    return q;
  },
  async clear() { await set(KEYS.QUEUE, []); },
  async removeOne(id) {
    const q = await get(KEYS.QUEUE, []);
    await set(KEYS.QUEUE, q.filter((m) => m.id !== id));
  },
};

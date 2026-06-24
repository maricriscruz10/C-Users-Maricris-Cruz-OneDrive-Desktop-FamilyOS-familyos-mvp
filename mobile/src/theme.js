export const colors = {
  bg: '#f6f7fb',
  card: '#ffffff',
  text: '#1e2230',
  muted: '#6b7280',
  border: '#e7e9f0',
  primary: '#6366f1',
  primaryDark: '#4f46e5',
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
};

export const roleBadgeColor = (role) => ({
  admin: { bg: '#ecebff', text: '#4f46e5' },
  member: { bg: '#e7f8f0', text: '#047857' },
  child: { bg: '#fde9f2', text: '#be185d' },
}[role] || { bg: '#eee', text: '#555' });

export const statusBadgeColor = (s) => ({
  pending: { bg: '#fff7e6', text: '#92660a' },
  accepted: { bg: '#e7f8f0', text: '#047857' },
  declined: { bg: '#fde8e8', text: '#b91c1c' },
  completed: { bg: '#e0f2fe', text: '#0369a1' },
}[s] || { bg: '#eee', text: '#555' });

export function initials(name = '') {
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

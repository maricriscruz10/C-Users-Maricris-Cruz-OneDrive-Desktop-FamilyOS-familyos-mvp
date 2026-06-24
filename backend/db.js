// FamilyOS backend — database layer
// Uses Node's built-in `node:sqlite` module (no npm install required).
// Schema mirrors what a production Postgres/Supabase schema would look like
// (see /docs/03_database_design.md for the Postgres DDL equivalent).

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');

// IMPORTANT: the SQLite file is stored OUTSIDE this project folder by default
// (in the OS temp dir) because cloud-synced folders (OneDrive/Dropbox/iCloud)
// often block the file locks SQLite needs, causing "disk I/O error".
// Override with FAMILYOS_DATA_DIR if you want the db file somewhere specific.
const DATA_DIR = process.env.FAMILYOS_DATA_DIR || path.join(os.tmpdir(), 'familyos-data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'familyos.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT DEFAULT 'America/New_York',
  created_at TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin','member','child')),
  avatar_color TEXT DEFAULT '#6366f1',
  oauth_provider TEXT DEFAULT 'dev',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','invited','disabled')),
  push_token TEXT,
  created_at TEXT NOT NULL
);

-- 'category' distinguishes plain events from appointments (doctor/dentist/etc).
-- Appointments reuse the full event machinery (versioning, assignments,
-- notifications, conflict resolution) rather than a parallel subsystem.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT DEFAULT 'none', -- none|daily|weekly|monthly
  category TEXT NOT NULL DEFAULT 'general', -- general|appointment
  provider TEXT DEFAULT '', -- appointment-only: doctor/dentist/clinic name
  created_by TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_assignments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  response_status TEXT NOT NULL DEFAULT 'pending' CHECK(response_status IN ('pending','accepted','declined','completed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  change_type TEXT NOT NULL, -- create|update|merge|delete
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL, -- event_assigned|event_updated|event_reminder|invite|role_changed|chore_assigned|chore_completed|budget_alert
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  related_event_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- ---- Budgeting ----
CREATE TABLE IF NOT EXISTS budget_categories (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  name TEXT NOT NULL,
  monthly_limit REAL NOT NULL DEFAULT 0,
  color TEXT DEFAULT '#6366f1',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_transactions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  category_id TEXT NOT NULL REFERENCES budget_categories(id),
  amount REAL NOT NULL, -- positive = expense, negative = income/refund
  description TEXT DEFAULT '',
  occurred_on TEXT NOT NULL, -- date string YYYY-MM-DD
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- ---- Meal planning ----
CREATE TABLE IF NOT EXISTS meal_plan_entries (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  meal_date TEXT NOT NULL, -- YYYY-MM-DD
  meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast','lunch','dinner','snack')),
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  assigned_cook TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---- Chores ----
CREATE TABLE IF NOT EXISTS chores (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  assignee_id TEXT REFERENCES users(id),
  recurrence TEXT DEFAULT 'none', -- none|daily|weekly|monthly
  due_date TEXT, -- YYYY-MM-DD, nullable for recurring chores
  points INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chore_completions (
  id TEXT PRIMARY KEY,
  chore_id TEXT NOT NULL REFERENCES chores(id),
  completed_by TEXT NOT NULL REFERENCES users(id),
  completed_on TEXT NOT NULL, -- YYYY-MM-DD (the occurrence date for recurring chores)
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_family_start ON events(family_id, start_at);
CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_audit_family ON audit_logs(family_id, created_at);
CREATE INDEX IF NOT EXISTS idx_budget_tx_family ON budget_transactions(family_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_meal_family_date ON meal_plan_entries(family_id, meal_date);
CREATE INDEX IF NOT EXISTS idx_chores_family ON chores(family_id, status);
CREATE INDEX IF NOT EXISTS idx_chore_completions_chore ON chore_completions(chore_id);
`);


// ---- Lightweight migrations for databases created before this feature set ----
// (category/provider columns on events, plus the new feature tables above are
// already covered by CREATE TABLE IF NOT EXISTS; only ADD COLUMN needs guarding,
// since SQLite has no "ADD COLUMN IF NOT EXISTS".)
function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
if (!columnExists('events', 'category')) {
  db.exec(`ALTER TABLE events ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
}
if (!columnExists('events', 'provider')) {
  db.exec(`ALTER TABLE events ADD COLUMN provider TEXT DEFAULT ''`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_family_category ON events(family_id, category)`);

module.exports = db;

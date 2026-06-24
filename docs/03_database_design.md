# Database Design

## 1. What's actually running

The MVP backend uses **SQLite via Node's built-in `node:sqlite` module** — chosen so the
whole stack runs with zero `npm install`. The schema is in `backend/db.js` and is
created automatically on first run.

The data file lives **outside** the synced project folder by default
(`os.tmpdir()/familyos-data/familyos.db`, overridable via `FAMILYOS_DATA_DIR`). This is
deliberate: cloud-synced folders (OneDrive/Dropbox/iCloud) commonly block the file locks
SQLite needs, which surfaces as a `disk I/O error`. Keeping the live database outside
the synced folder avoids that entirely — your code stays synced/backed-up, your runtime
data stays fast and lock-safe. Re-seed any time with `node seed.js`.

## 2. Entity-relationship overview

```
families ──┬──< users ──┬──< events ──┬──< event_assignments >── users
           │             │   (category │
           │             │    +provider│
           │             │    cover    │              ├──< event_versions
           │             │    appts)   │
           │             │              └──< (notifications reference event_id)
           ├──< audit_logs
           │
           ├──< notifications >── users
           │
           ├──< budget_categories ──< budget_transactions >── users (created_by)
           │
           ├──< meal_plan_entries >── users (assigned_cook)
           │
           └──< chores >── users (assignee_id) ──< chore_completions >── users (completed_by)
```

Appointments are not a separate branch — they live on `events` (see the `category`/
`provider` columns above), so the diagram doesn't show a separate appointments table.

- A **family** is the tenant boundary. Every other table (except `sessions`) traces back
  to exactly one `family_id`.
- A **user** belongs to exactly one family and has exactly one role.
- An **event** belongs to one family, has one creator, and zero-or-more assignees via
  `event_assignments` (the join table that also tracks each assignee's
  accept/decline/complete response).
- **event_versions** is an append-only history table — one row per change, enabling full
  audit/rollback capability and satisfying the BRD's "event versioning to prevent data
  loss" requirement.
- **audit_logs** is a general-purpose change log across events, users, and family
  settings — broader than `event_versions`, which only covers events.

## 3. Local schema (SQLite, as implemented)

See `backend/db.js` for the authoritative DDL. Summary of tables:

| Table | Purpose | Key columns |
|---|---|---|
| `families` | Tenant root | `id`, `name`, `timezone`, `settings_json` |
| `users` | Household members | `id`, `family_id`, `role` (admin\|member\|child), `status` (active\|invited\|disabled), `push_token` |
| `events` | Calendar events **+ appointments/occasions** | `id`, `family_id`, `start_at`, `end_at`, `recurrence`, `version`, `deleted` (soft delete), `category` (general\|appointment), `provider` (free text, e.g. doctor name) |
| `event_assignments` | Who's responsible | `event_id`, `user_id`, `response_status` (pending\|accepted\|declined\|completed) |
| `event_versions` | Append-only change history | `event_id`, `version`, `data_json`, `change_type` (create\|update\|merge\|delete) |
| `audit_logs` | Cross-entity change log | `entity_type`, `entity_id`, `action`, `actor_id`, `before_json`, `after_json` |
| `notifications` | In-app + push notification records | `user_id`, `type`, `read`, `related_event_id` |
| `sessions` | Server-tracked auth sessions | `token`, `user_id`, `expires_at` |
| `budget_categories` *(added by request)* | Budget category + monthly limit | `id`, `family_id`, `name`, `monthly_limit`, `color` |
| `budget_transactions` *(added by request)* | Logged spend against a category | `id`, `family_id`, `category_id`, `amount`, `description`, `occurred_on`, `created_by` |
| `meal_plan_entries` *(added by request)* | Planned meal for a date + meal-type slot | `id`, `family_id`, `meal_date`, `meal_type` (breakfast\|lunch\|dinner\|snack), `title`, `notes`, `assigned_cook` |
| `chores` *(added by request)* | Assignable household task | `id`, `family_id`, `title`, `description`, `assignee_id`, `recurrence` (none\|daily\|weekly\|monthly), `due_date`, `points`, `status` (pending\|completed) |
| `chore_completions` *(added by request)* | One row per time a chore was marked done | `chore_id`, `completed_by`, `completed_at` |

Indexes: `events(family_id, start_at)`, `users(family_id)`,
`notifications(user_id, read)`, `audit_logs(family_id, created_at)`,
`budget_transactions(family_id, occurred_on)`, `meal_plan_entries(family_id, meal_date)`,
`chores(family_id, assignee_id)` — covering the queries the BRD calls
latency-sensitive (calendar load, unread-notification badge, admin audit view), plus the
equivalent lookups for the four added-by-request features.

## 4. Production-equivalent schema (Postgres / Supabase)

When you're ready to move off SQLite, this is the equivalent Postgres DDL — same shape,
adding native UUID/timestamp types, foreign keys, and row-level security hooks that
Supabase expects:

```sql
create extension if not exists "uuid-ossp";

create table families (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  timezone text default 'America/New_York',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  email text not null unique,
  role text not null check (role in ('admin','member','child')),
  avatar_color text default '#6366f1',
  oauth_provider text default 'google',
  status text not null default 'active' check (status in ('active','invited','disabled')),
  push_token text,
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  title text not null,
  description text default '',
  location text default '',
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  recurrence text default 'none',
  category text not null default 'general' check (category in ('general','appointment')),
  provider text default '',
  created_by uuid not null references users(id),
  version integer not null default 1,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table event_assignments (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  response_status text not null default 'pending'
    check (response_status in ('pending','accepted','declined','completed')),
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create table event_versions (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  version integer not null,
  data jsonb not null,
  changed_by uuid not null references users(id),
  change_type text not null,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_id uuid references users(id),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  related_event_id uuid references events(id),
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table budget_categories (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  monthly_limit numeric(10,2) not null default 0,
  color text default '#6366f1',
  created_at timestamptz not null default now()
);

create table budget_transactions (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  category_id uuid not null references budget_categories(id) on delete cascade,
  amount numeric(10,2) not null,
  description text default '',
  occurred_on date not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table meal_plan_entries (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  meal_date date not null,
  meal_type text not null check (meal_type in ('breakfast','lunch','dinner','snack')),
  title text not null,
  notes text default '',
  assigned_cook uuid references users(id),
  created_at timestamptz not null default now()
);

create table chores (
  id uuid primary key default uuid_generate_v4(),
  family_id uuid not null references families(id) on delete cascade,
  title text not null,
  description text default '',
  assignee_id uuid references users(id),
  recurrence text not null default 'none' check (recurrence in ('none','daily','weekly','monthly')),
  due_date date,
  points integer not null default 0,
  status text not null default 'pending' check (status in ('pending','completed')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table chore_completions (
  id uuid primary key default uuid_generate_v4(),
  chore_id uuid not null references chores(id) on delete cascade,
  completed_by uuid not null references users(id),
  completed_at timestamptz not null default now()
);

create index idx_events_family_start on events(family_id, start_at);
create index idx_notifications_user on notifications(user_id, read);
create index idx_audit_family on audit_logs(family_id, created_at);
create index idx_budget_tx_family_date on budget_transactions(family_id, occurred_on);
create index idx_meals_family_date on meal_plan_entries(family_id, meal_date);
create index idx_chores_family_assignee on chores(family_id, assignee_id);

-- Supabase row-level security (RLS) example for tenant isolation at the DB layer,
-- in addition to the app-layer checks already implemented:
alter table events enable row level security;
create policy "family isolation" on events
  using (family_id in (select family_id from users where id = auth.uid()));
```

## 5. Why SQLite now, Postgres later is safe

Nothing in the application layer (route handlers, business rules, RBAC) depends on
SQLite-specific behavior — all access goes through parameterized `db.prepare(...).run/get/all()`
calls with plain SQL. Migrating means swapping `backend/db.js`'s implementation
(point it at `pg` instead of `node:sqlite`) and adjusting the few `?`-placeholder vs
`$1`-placeholder differences. The schema, indexes, and business logic above carry over
directly.

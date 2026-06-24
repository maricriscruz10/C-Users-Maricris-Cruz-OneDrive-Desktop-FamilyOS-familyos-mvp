# Technology Stack & Architecture

## 1. What was specified vs. what was built

| Layer | BRD spec | This MVP build | Why |
|---|---|---|---|
| Mobile | React Native (Expo) | **React Native (Expo)** — unchanged | Matches spec; written to run via `npx expo start` on your machine |
| Web/Desktop | Next.js | **Dependency-free static HTML/CSS/JS**, served by a tiny Node static server | No npm registry access in the build sandbox (see doc 01) |
| Backend/DB | Supabase (Postgres + Auth + Realtime) | **Dependency-free Node.js** (`http` + `node:sqlite` + `crypto`) | Same reason; API shape and schema mirror what Supabase/Postgres would look like |
| Push | Expo Notifications | **Expo Notifications**, with local-notification fallback for reminders | Real push delivery needs FCM/APNs credentials not available here |
| Hosting | Vercel | See `06_run_locally_and_deployment.md` for a real deployment path | N/A in local-testing phase |

The API contracts, data model, and RBAC logic are written so that swapping the storage
engine (SQLite → Postgres/Supabase) or the web framework (static JS → Next.js) later is
a **substitution, not a rewrite** — nothing in `web/app.js` or the mobile app talks to
SQLite directly; everything goes through the HTTP API.

## 2. System architecture

```
                         ┌─────────────────────┐
                         │   Desktop (web) app   │
                         │  static HTML/CSS/JS   │
                         │  served on :3000      │
                         └──────────┬───────────┘
                                    │ fetch() + SSE
┌──────────────────┐               │
│  Mobile app        │             │
│  (Expo/React       │─────────────┤  HTTP REST API
│   Native, iOS/     │   fetch()   │  (JSON over HTTP)
│   Android)         │             │
└──────────────────┘               │
                                    ▼
                         ┌─────────────────────┐
                         │   Backend API server  │
                         │   Node.js http :4000  │
                         │  ─────────────────── │
                         │  Auth (sessions/JWT-  │
                         │  like signed tokens)  │
                         │  RBAC middleware       │
                         │  Event/CRUD + business │
                         │  rules                │
                         │  Audit logging         │
                         │  Notification engine   │
                         │  SSE realtime broadcast │
                         │  Structured logger      │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   SQLite database     │
                         │  (node:sqlite, file-   │
                         │  backed, WAL-free for  │
                         │  cloud-folder safety)  │
                         └─────────────────────┘
```

## 3. Backend design

- **Multi-tenancy:** every row that matters (`users`, `events`, `notifications`,
  `audit_logs`) carries a `family_id`. Every request handler calls `requireFamily()`
  before touching data, returning `403 TENANT_ISOLATION` on any cross-family access
  attempt — this is unit-tested in `05_testing_environment.md` §Security tests.
- **AuthN:** "Dev Login" issues a signed session token (HMAC-SHA256 over a JSON
  payload, similar in spirit to a JWT but with zero dependencies) tied to a server-side
  `sessions` row with an expiry. Swapping to real Google/Apple OAuth later only changes
  how the `users` row is first resolved — the token/session/RBAC layers don't change.
- **AuthZ (RBAC):** a single `ROLE_PERMISSIONS` map (`backend/auth.js`) is the source of
  truth for what each role can do. Route handlers call `hasPermission(role, 'x')` —
  there's no permission logic duplicated across routes.
- **Versioning & conflict resolution:** every event has a monotonically increasing
  `version`. Updates carry the version the client last saw; if the server has moved on,
  the server merges field-by-field rather than rejecting the write, flags which fields
  collided in `conflictFields`, and snapshots the result into `event_versions` —
  "last-write + merge rules" per the BRD, with full history retained (no silent data
  loss).
- **Audit log:** every create/update/delete/role-change/invite writes an `audit_logs`
  row with before/after JSON, visible to admins via `GET /api/families/:id/audit-logs`.
- **Real-time sync:** Server-Sent Events (`GET /api/families/:id/stream`) broadcast
  `event_created`/`event_updated`/`event_deleted`/`notification`/`member_updated` to all
  connected clients in that family. The web app also polls every 8s as a robustness
  fallback (SSE reconnection across networks can be flaky — polling guarantees
  eventual consistency even if the stream drops).
- **Offline-first:** `GET /api/families/:id/sync?since=<timestamp>` supports
  incremental sync (only rows changed since the given time), which the mobile app uses
  to refresh its cache; mutations made offline are queued client-side and replayed in
  order once connectivity returns.
- **Logging & error handling:** every request that errors is logged via
  `backend/logger.js` to `backend/logs/app.log` (JSON lines) with full stack traces on
  500s; all error responses follow `{ error: { code, message } }` so clients can branch
  on `code` rather than parsing strings.

## 4. Frontend design

- **Desktop app:** a single-page app using hash-based routing (`#/dashboard`,
  `#/calendar`, etc.), vanilla `fetch()` against the backend, and a small render-on-
  navigate pattern — no virtual DOM framework, no build step. Kept deliberately simple
  per "keep the design simple, modern, easy to use."
- **Mobile app:** Expo-managed React Native app with a tab layout — Agenda, Family,
  Budget (hidden for Child), Meals, Chores, Alerts, Settings — a modal event form (with
  an appointment-type toggle + provider field), AsyncStorage-backed cache + mutation
  queue for offline support, and Expo Notifications for push registration + local
  reminders. Budget/Meals/Chores writes call the API directly rather than going through
  the offline mutation queue (only event CRUD is currently offline-queued — see
  `05_testing_environment.md` for what that means for testing offline behavior in those
  screens).

## 5. Security implementation

- RBAC enforced server-side on every mutating and most read endpoints (never trust the
  client to hide a button).
- Tenant isolation enforced server-side, not just in UI filtering.
- Tokens expire after 7 days; sessions are server-tracked so they can be revoked
  (delete the `sessions` row) — not pure stateless JWT.
- "Last admin" guard: the only admin in a family cannot be demoted or removed, so no
  family can be left without an admin (no single-point-of-failure user role, per spec).
- CORS is open (`*`) for local testing convenience — **tighten this before any public
  deployment** (see `06_run_locally_and_deployment.md`).

## 5b. Budgeting, meal planning, chores & appointments (added by request)

These four areas were added after the original BRD-scoped MVP and follow the same
patterns already established above rather than introducing new architecture:

- **Appointments** add zero new tables/routes — they're `events` with
  `category = 'appointment'` and an optional `provider` field, so they get versioning,
  RBAC, audit logging, and SSE updates for free.
- **Budgeting, meal planning, and chores** each get their own table(s) (see
  `03_database_design.md`) and their own route groups under
  `/api/families/:id/budget|meals|chores`, but reuse the same `requireAuth` /
  `requireFamily` / `requirePermission` / `audit()` / `broadcast()` helpers as the event
  routes — no parallel auth or logging system was built.
- **RBAC additions** to `backend/auth.js`'s `ROLE_PERMISSIONS` map: `budget:view`,
  `budget:manage`, `budget:categories:manage` (Admin + Member, except categories which
  is Admin-only; Child gets none of these); `meals:view`/`meals:manage` and
  `chores:view`/`chores:manage`/`chores:complete:own`/`chores:complete:any` (Child gets
  `:view` and `:complete:own` for chores, `:view` only for meals).
- **Realtime:** three new SSE event types — `budget_updated`, `meal_updated`,
  `chore_updated` — broadcast the same way `event_updated` already did.

## 6. Known production gaps (intentionally deferred)

- Real OAuth (Google/Apple) instead of Dev Login.
- Real push delivery (Expo Push API / FCM / APNs) instead of local reminders.
- Postgres/Supabase instead of SQLite, with encryption at rest.
- TLS termination (local dev runs over plain HTTP).
- Rate limiting / abuse protection.
- Full iCal RRULE parsing instead of none/daily/weekly/monthly.
- AI ingestion layer (natural-language event parsing, email/PDF extraction) — explicitly
  listed as a *later* build-order step in the Skills & Hooks doc, not MVP scope.

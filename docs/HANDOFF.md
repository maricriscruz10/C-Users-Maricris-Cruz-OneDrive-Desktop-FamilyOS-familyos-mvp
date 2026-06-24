# FamilyOS MVP — Handoff Document

## Project at a glance

**FamilyOS** is a cross-platform family coordination app. Three apps share one backend:
- Backend: zero-dependency Node.js + SQLite (`backend/`)
- Web app: static HTML/CSS/JS (`web/`)
- Mobile: Expo/React Native (`mobile/`)

**GitHub repo:** https://github.com/maricriscruz10/C-Users-Maricris-Cruz-OneDrive-Desktop-FamilyOS-familyos-mvp

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js v22.5+ (uses built-in `node:sqlite`) |
| Backend framework | None — raw `node:http` module |
| Database (dev/MVP) | SQLite via `node:sqlite` |
| Database (production path) | Postgres / Supabase (see `docs/03_database_design.md`) |
| Auth (dev/MVP) | Custom HMAC-SHA256 signed session tokens — no external JWT lib |
| Auth (production path) | Google / Apple OAuth via Supabase Auth or Auth.js |
| Web app | Vanilla HTML + CSS + JS — no framework, no build step |
| Mobile app | Expo ~51.0.0 / React Native 0.74.5 |
| Real-time | Server-Sent Events (SSE) per family on `/api/families/:id/stream` |
| Push notifications | Expo Notifications (local reminders in MVP; real push needs FCM/APNs keys) |
| Logging | Structured JSON logger → `backend/logs/app.log` |

---

## Configuration

### Backend
| Config | Default | How to override |
|---|---|---|
| Port | `4000` | `PORT=xxxx` |
| Session secret | `familyos-dev-secret-change-in-prod` | `SESSION_SECRET=your-strong-secret` (**required in prod**) |
| Database directory | OS temp dir (`%TEMP%\familyos-data`) | `FAMILYOS_DATA_DIR=/path` |
| Session TTL | 7 days | Hardcoded in `backend/auth.js` |
| Environment | dev | `NODE_ENV=production` |
| CORS allowed origins | `*` (dev) / blocks all (prod) | `CORS_ORIGINS=https://yourapp.com,https://www.yourapp.com` (**required in prod**) |
| Rate limit max requests | `120` per window | `RATE_LIMIT_MAX=200` |
| Rate limit window | `60000` ms (60s) | `RATE_LIMIT_WINDOW_MS=30000` |

### Web app
| Config | File | Default |
|---|---|---|
| Backend API URL | `web/config.js` | `http://localhost:4000` |

### Mobile app
| Config | File | What to change |
|---|---|---|
| Backend API URL | `mobile/src/config.js` | Set `API_BASE` to your LAN IP before running on phone |

---

## Seeded users (dev login — no password required)

Run `node seed.js` in the `backend/` folder to populate these users.

### Family 1: The Garcia Family (America/Chicago)
| Name | Email | Role | Avatar color |
|---|---|---|---|
| Dana Garcia | dana@example.com | **admin** | indigo `#6366f1` |
| Marc Garcia | marc@example.com | member | green `#10b981` |
| Grandma Rosa | rosa@example.com | member | amber `#f59e0b` |
| Lily Garcia (age 9) | lily@example.com | child | pink `#ec4899` |
| Sam Garcia (age 13) | sam@example.com | child | blue `#3b82f6` |

### Family 2: The Okafor Family (America/New_York)
| Name | Email | Role | Avatar color |
|---|---|---|---|
| Tomi Okafor | tomi@example.com | **admin** | violet `#8b5cf6` |
| Chidi Okafor | chidi@example.com | member | cyan `#06b6d4` |
| Ada Okafor (age 7) | ada@example.com | child | rose `#f43f5e` |

### How to log in (Dev Login)
```bash
# Get a session token for any user by email:
curl -X POST http://localhost:4000/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"dana@example.com"}'
```
Returns `{ token, user }`. Use the token as `Authorization: Bearer <token>` on all subsequent requests.

---

## Seeded data summary (after `node seed.js`)

| Data type | Garcia family | Okafor family |
|---|---|---|
| Users | 5 | 3 |
| Events (incl. appointments) | 8 | 2 |
| Budget categories | 4 (Groceries, Kids Activities, Medical, Household) | 1 (Groceries) |
| Budget transactions | 8 | 1 |
| Meal plan entries | 8 | 1 |
| Chores | 5 | 1 |

**Garcia family budget limits:** Groceries $600/mo, Kids Activities $200/mo (seeded over budget to test UI), Medical $150/mo, Household $300/mo.

---

## RBAC permission matrix

| Permission | Admin | Member | Child |
|---|---|---|---|
| Manage family settings | yes | no | no |
| Invite / remove members | yes | no | no |
| Change member roles | yes | no | no |
| Create / edit / delete any event | yes | own only | no |
| Assign events to members | yes | yes | no |
| Respond to event assignments | yes | yes | yes (own) |
| View audit log | yes | no | no |
| View budget | yes | yes | **no** |
| Log budget transactions | yes | yes | **no** |
| Manage budget categories | yes | no | **no** |
| View / manage meals | yes | yes | view only |
| View / manage chores | yes | yes | view + complete own |

---

## API endpoints summary

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/dev/users` | List all seeded users (dev only) |
| POST | `/api/auth/dev-login` | Get session token by userId or email |
| GET | `/api/auth/me` | Get current user |
| GET | `/api/families/:id` | Get family details |
| PUT | `/api/families/:id/settings` | Update family settings |
| GET | `/api/families/:id/members` | List family members |
| POST | `/api/families/:id/members/invite` | Invite a new member |
| PATCH | `/api/families/:id/members/:userId` | Update member role/name |
| DELETE | `/api/families/:id/members/:userId` | Disable a member |
| GET | `/api/families/:id/events` | List events (supports `?start=&end=&category=`) |
| POST | `/api/families/:id/events` | Create an event |
| GET | `/api/events/:id` | Get single event |
| PUT | `/api/events/:id` | Update event (with conflict resolution) |
| DELETE | `/api/events/:id` | Soft-delete event |
| POST | `/api/events/:id/assign` | Assign a member to an event |
| POST | `/api/events/:id/respond` | Respond to event assignment |
| GET | `/api/families/:id/sync` | Incremental sync (`?since=<ISO>`) |
| GET | `/api/families/:id/stream` | SSE real-time stream |
| GET | `/api/families/:id/budget/categories` | List budget categories |
| POST | `/api/families/:id/budget/categories` | Create budget category |
| PUT | `/api/budget/categories/:id` | Update budget category |
| DELETE | `/api/budget/categories/:id` | Delete budget category |
| GET | `/api/families/:id/budget/transactions` | List transactions (`?month=YYYY-MM`) |
| POST | `/api/families/:id/budget/transactions` | Log a transaction |
| DELETE | `/api/budget/transactions/:id` | Delete a transaction |
| GET | `/api/families/:id/budget/summary` | Monthly summary (`?month=YYYY-MM`) |
| GET | `/api/families/:id/meals` | List meal plan entries |
| POST | `/api/families/:id/meals` | Create meal plan entry |
| PUT | `/api/meals/:id` | Update meal entry |
| DELETE | `/api/meals/:id` | Delete meal entry |
| GET | `/api/families/:id/chores` | List chores |
| POST | `/api/families/:id/chores` | Create a chore |
| PUT | `/api/chores/:id` | Update a chore |
| DELETE | `/api/chores/:id` | Soft-delete a chore |
| POST | `/api/chores/:id/complete` | Mark a chore complete |
| GET | `/api/notifications` | Get current user's notifications |
| POST | `/api/notifications/:id/read` | Mark notification read |
| POST | `/api/notifications/read-all` | Mark all notifications read |
| GET | `/api/families/:id/audit-logs` | Audit log (admin only) |

---

## Polish changelog

| Task | Status | Description |
|---|---|---|
| Task 1 — Budget delete column fix | ✅ Done (2026-06-24) | `canManageCats` (admin-only) was guarding the `<th>` but the delete `<td>` always rendered for all roles. Introduced `canManageTx` (admin + member) to correctly control both the column header and the delete button in each row. Both the `+ Transaction` button and delete column now use `canManageTx`. |
| Task 2 — Loading states | ✅ Done (2026-06-24) | `screenFor()` now renders a centered CSS spinner immediately while async screen data loads. Replaced by content on success, or an error message on failure. Spinner styles added to `web/styles.css`. |
| Task 3 — Mark notification read on click | ✅ Done (2026-06-24) | Clicking a notification row now marks it as read immediately (optimistic update — removes blue background and dot, updates sidebar badge) then fires `POST /api/notifications/:id/read`. Rolls back local state if the API call fails. |
| Task 4 — Calendar multi-event day click | ✅ Done (2026-06-24) | Clicking a calendar day with 2+ events now opens a day-summary modal listing all events for that day. Each event is clickable to open the edit modal. A "+ New event this day" button is shown at the bottom. Single-event days still open the event modal directly; empty days open the new-event form. |
| Task 5 — Budget month navigation | ✅ Done (2026-06-24) | Added `budgetCursor` (mirrors `calCursor` pattern). Budget screen now shows ← / → nav buttons to move between months. Both the transactions list and the summary are filtered by the selected month via `?month=YYYY-MM` query params. |
| Task 6 — Form validation field highlighting | ✅ Done (2026-06-24) | Added `markInvalid()` helper that adds a red border + red label to the invalid field and auto-clears on first input. Applied to all 6 modals: event (title, start, end, end-after-start check), budget category (name), budget transaction (amount, date), meal (title), chore (title), invite (name, email). CSS uses `.field-error` class on the `.field` wrapper. |
| Task 7 — Role change confirmation | ✅ Done (2026-06-24) | Role dropdown in Members screen now captures the previous value on render, shows a confirm dialog naming the member and new role before applying, and reverts the dropdown to the previous value if the user cancels or the API call fails. |
| Task 8 — Mobile/responsive layout | ✅ Done (2026-06-24) | Added `@media (max-width: 768px)` breakpoint. Sidebar becomes a fixed off-screen drawer (slides in with CSS transition). A sticky topbar with a hamburger button appears on mobile. A semi-transparent backdrop closes the drawer on tap. Grid collapses to 1 column, modals go full-width, padding reduces. Desktop layout unchanged. |
| Task 9 — Dashboard points leaderboard | ✅ Done (2026-06-24) | Added `GET /api/families/:familyId/chores/leaderboard` backend route (queries `chore_completions` for the current week, aggregates points per user). Dashboard now shows a "This week's points" card with 🥇🥈🥉 medals, chore count, and points per member. Hidden when nobody has completed anything yet. |
| Task 10 — Real-time sidebar badge | ✅ Done (2026-06-24) | Notification badge given a stable `id="notif-badge"`. SSE `notification` events now do a lightweight fetch-and-update of the badge only (no full re-render), with a pop animation when count increases. All other SSE events still trigger a full render. Task 3 optimistic-read update also switched to use `updateNotifBadge()`. Badge hides itself when count reaches 0. |
| B1 — Disable dev endpoints in production | ✅ Done (2026-06-24) | `GET /api/dev/users` and `POST /api/auth/dev-login` return `404 NOT_FOUND` when `NODE_ENV=production`. A warning is logged at startup in dev mode. |
| B2 — CORS restriction | ✅ Done (2026-06-24) | Added `CORS_ORIGINS` env var (comma-separated). In production, only listed origins receive `Access-Control-Allow-Origin`. In dev, `*` is still used. CORS origin is stamped onto `res._corsOrigin` at request entry so all helpers read it without signature changes. |
| B3 — Security headers | ✅ Done (2026-06-24) | Every response now includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-XSS-Protection: 0`. `Strict-Transport-Security` is added in production only. |
| B4 — Rate limiting | ✅ Done (2026-06-24) | In-memory per-IP rate limiter (no external deps). Defaults to 120 req/60s; override with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` env vars. Returns `429 RATE_LIMITED` with `Retry-After` header. Expired buckets cleaned every 30s. `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers on every response. |
| B5 — Environment validation | ✅ Done (2026-06-24) | Server exits immediately (`process.exit(1)`) if `NODE_ENV=production` and: (1) `SESSION_SECRET` is still the default dev value, or (2) `CORS_ORIGINS` is not set. Prevents accidentally running insecure defaults in production. |
| B6-prep — `.env.example` | ✅ Done (2026-06-24) | Created `.env.example` documenting every env var with descriptions and where to get each value (Supabase, Google Cloud Console, Expo). Copy to `.env` to configure for production. |
| B7-prep — Google OAuth scaffolding | ✅ Done (2026-06-24) | Added `GET /api/auth/google` (redirect to Google consent) and `GET /api/auth/google/callback` (exchange code, find/create user, issue session token, redirect to web app). Uses Node built-in `https` — no external deps. Activate by setting `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`. Web app absorbs `?token=` from OAuth redirect and stores it. Returns `501 NOT_CONFIGURED` if env vars not set. |
| B8/B9-prep — Deployment configs | ✅ Done (2026-06-24) | `backend/railway.toml` (Railway — start command, healthcheck, restart policy), `backend/Procfile` (Heroku/Render), `web/vercel.json` (Vercel — SPA rewrite + security headers). Ready to use once accounts are created. |
| B10-prep — Expo push delivery | ✅ Done (2026-06-24) | Added `sendExpoPush()` in `backend/server.js` using Node built-in `https`. Called from `notify()` whenever a user has a registered `push_token`. Activate by setting `EXPO_ACCESS_TOKEN`. Logs errors but never throws — push failure is non-fatal. |

---

## What's intentionally deferred (not MVP scope)

- Real Google/Apple OAuth (Dev Login is the placeholder)
- Real push delivery via Expo Push API / FCM / APNs
- Postgres/Supabase (SQLite is the placeholder; schema is Postgres-compatible)
- TLS (local dev is plain HTTP — terminate at proxy/host in production)
- Rate limiting
- Full iCal RRULE recurrence (only none/daily/weekly/monthly today)
- AI natural-language event parsing (planned next phase)
- CORS restriction (currently `*` — tighten before public deployment)

---

## How to reset everything
```bash
cd backend
node seed.js    # wipes all tables and re-seeds demo data
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node:sqlite` import error | Upgrade to Node 22.5+ |
| Backend `disk I/O error` | DB is inside OneDrive — set `FAMILYOS_DATA_DIR` to a local path |
| Mobile can't reach backend | Use LAN IP (not `localhost`) in `mobile/src/config.js` |
| Web shows no data | Confirm backend is running: `curl http://localhost:4000/api/health` |
| Port already in use | Kill the old process first (Task Manager or `lsof -i :4000`) |

# FamilyOS MVP — Claude Project Guide

## Project overview
FamilyOS is a cross-platform family coordination app: shared calendar, chores, meal planning, and budgeting. Three apps share one backend:
- **Backend** — zero-dependency Node.js API + SQLite (`backend/`)
- **Web app** — dependency-free static HTML/CSS/JS (`web/`)
- **Mobile app** — Expo/React Native (`mobile/`)

## Running the project

### Requirements
- Node.js **v22.5+** (uses `node:sqlite` built-in — will not run on older Node)
- For mobile: Expo Go app on your phone, same WiFi as your computer

### Start the backend
```bash
cd backend
node seed.js    # reset/populate demo data (run once or to reset)
node server.js  # API on http://localhost:4000
```

### Start the web app
```bash
cd web
node serve.js   # serves on http://localhost:3000
```

### Start the mobile app
```bash
cd mobile
npm install                 # only needed once
# Edit src/config.js: set API_BASE to your LAN IP (e.g. http://192.168.1.x:4000)
npx expo start              # scan QR with Expo Go
```

### Health check
```bash
curl http://localhost:4000/api/health
```

## Key files
| File | Purpose |
|---|---|
| `backend/server.js` | All API route handlers (single file, ~800 lines) |
| `backend/auth.js` | Session token logic + RBAC permissions matrix |
| `backend/db.js` | SQLite schema + database singleton |
| `backend/seed.js` | Demo data (2 families, 8 users, events, budget, meals, chores) |
| `backend/logger.js` | Structured logger → `backend/logs/app.log` |
| `web/app.js` | Entire web SPA (hash-based routing, vanilla JS) |
| `web/config.js` | `FAMILYOS_API` endpoint config for web app |
| `mobile/src/config.js` | `API_BASE` endpoint config for mobile app |
| `mobile/App.js` | React Native app entry + tab navigator |
| `docs/` | Architecture, DB design, test plan, deployment guide |

## Coding conventions
- **No external dependencies** in `backend/` or `web/` — everything uses Node built-ins only
- **Error responses** always follow `{ error: { code, message } }` shape
- **Route pattern:** `route(METHOD, '/path/:param', async (req, res, params, query) => { ... })`
- **Auth flow:** `requireAuth()` → `requireFamily()` → `requirePermission()` in that order
- **Every mutation** must call `audit()` and `broadcast()` before sending the response
- **RBAC** is maintained exclusively in `backend/auth.js` — `ROLE_PERMISSIONS` map, never elsewhere

## Database
- SQLite file stored in OS temp dir by default (avoids OneDrive sync lock issues)
- Override: `FAMILYOS_DATA_DIR=/path/to/dir node server.js`
- Session secret: `SESSION_SECRET` env var (default `familyos-dev-secret-change-in-prod`)
- Schema is in `backend/db.js`; Postgres-equivalent DDL is in `docs/03_database_design.md`

## RBAC roles
| Role | Key permissions |
|---|---|
| `admin` | Everything — manage family, members, all events, budget categories, audit log |
| `member` | Create/edit own events, log budget transactions, manage meals & chores |
| `child` | View events/meals/chores, respond to own assignments, complete own chores — no budget access |

## Known dev shortcuts (intentional, not bugs)
- **Dev Login** at `POST /api/auth/dev-login` — no real OAuth; pass `{ email }` to get a token
- **CORS is open (`*`)** — tighten before any public deployment
- **No real push delivery** — mobile uses local Expo notifications for reminders
- The SQLite DB is NOT committed to git (gitignored) — run `node seed.js` to recreate it

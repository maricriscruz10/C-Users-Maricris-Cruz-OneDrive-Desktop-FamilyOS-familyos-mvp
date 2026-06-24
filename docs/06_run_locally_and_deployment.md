# Running Locally & Deployment

## 1. Prerequisites

- **Node.js v22+** (the backend uses the built-in `node:sqlite` module, which requires
  Node 22.5+; confirm with `node -v`). If you're on an older Node, install the latest
  LTS from nodejs.org first.
- For the **mobile app**: a phone with the **Expo Go** app installed (iOS App Store /
  Google Play), and your phone on the **same WiFi network** as your computer.
- No database server, no Docker, no cloud account needed for local testing.

## 2. Run the backend

```bash
cd familyos-mvp/backend
node seed.js      # creates/resets sample data (2 families, 8 users, 10 events
                  # incl. 4 appointments, 9 budget txs, 9 meals, 6 chores)
node server.js    # starts the API on http://localhost:4000
```

Leave this running in its own terminal. Confirm it's healthy:

```bash
curl http://localhost:4000/api/health
```

Logs are written to `familyos-mvp/backend/logs/app.log`.

Optional: override where the SQLite file lives with `FAMILYOS_DATA_DIR=/some/path node
server.js` (defaults to your OS temp directory — deliberately *outside* this project
folder if the project folder is cloud-synced, since OneDrive/Dropbox/iCloud sync can
block the file locks SQLite needs).

## 3. Run the desktop (web) app

```bash
cd familyos-mvp/web
node serve.js     # serves the app on http://localhost:3000
```

Open `http://localhost:3000` in your browser. It talks to the backend at
`http://localhost:4000` (configured in `web/config.js` — change `FAMILYOS_API` there if
you run the backend on a different host/port).

Log in as any seeded user (e.g. Dana Garcia) from the Login screen — no password.

## 4. Run the mobile app

```bash
cd familyos-mvp/mobile
npm install        # this sandbox couldn't run this step (no registry access) —
                    # run it on your own machine, where it will work normally
```

Before starting, edit `mobile/src/config.js` and set `API_BASE` to your computer's
**LAN IP** (not `localhost` — your phone needs a real network address to reach your
computer), e.g.:

```js
export const API_BASE = 'http://192.168.1.42:4000';
```

Find your LAN IP with `ipconfig` (Windows) or `ifconfig`/`ipconfig getifaddr en0`
(Mac). Then:

```bash
npx expo start
```

Scan the QR code with Expo Go on your phone. Make sure your phone and computer are on
the same WiFi network, and that your computer's firewall allows inbound connections on
port 4000.

## 5. Quick smoke test (all three together)

1. Backend running on `:4000`, web app on `:3000`, mobile app open in Expo Go.
2. Log in as Dana on web, log in as Marc on mobile.
3. On web, create a new event and assign Marc.
4. On mobile, pull to refresh the Agenda tab (or wait for the next poll) — the new
   event and its notification should appear.
5. On mobile, mark the assignment Accepted.
6. Back on web, refresh — Dana's notification feed should show Marc's response.

If all of that works, the full loop (auth, RBAC, cross-platform sync, notifications) is
functioning end to end.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `node:sqlite` import error | Node version too old | Upgrade to Node 22.5+ |
| Backend `disk I/O error` on startup | Data dir is inside a cloud-synced folder | Set `FAMILYOS_DATA_DIR` to a local (non-synced) path |
| Mobile app can't reach backend | Used `localhost` instead of LAN IP, or different WiFi networks, or firewall blocking | Use LAN IP in `mobile/src/config.js`; same WiFi; allow port 4000 through firewall |
| Web app shows no data after login | Backend not running, or wrong `FAMILYOS_API` in `web/config.js` | Confirm `curl http://localhost:4000/api/health` works |
| Port already in use | A previous server instance is still running | Find and stop it (e.g. `lsof -i :4000` / Task Manager), then restart |

## 7. Deployment path (when you're ready to go beyond local testing)

This MVP intentionally runs zero-dependency and local-only so it works without any
cloud account. Moving to production is additive, not a rewrite:

1. **Database:** stand up Postgres (e.g. Supabase, Neon, RDS). Apply the DDL in
   `03_database_design.md` §4. Swap `backend/db.js`'s implementation to use `pg`
   instead of `node:sqlite` — route handlers don't change, since they already go
   through parameterized query helpers.
2. **Auth:** replace the Dev Login screen with real Google/Apple OAuth (e.g. via
   Supabase Auth or Auth.js). The session/RBAC layers underneath are already
   provider-agnostic — only the "resolve who just logged in" step changes.
3. **Push notifications:** call Expo's Push API (or FCM/APNs directly) using the
   `push_token` values already being collected and stored.
4. **Web hosting:** the current static app can be deployed as-is to any static host
   (Vercel, Netlify, S3+CloudFront). If you want the originally-specified Next.js
   stack, the screens/flows in `04_screens_and_user_flows.md` and the API contract in
   `server.js` are the spec to rebuild against.
5. **Mobile distribution:** `eas build` (Expo Application Services) to produce
   installable iOS/Android builds, then submit to TestFlight / Play Console internal
   testing before a public release.
6. **Security hardening:** restrict CORS to your real domains, add TLS (handled
   automatically by most hosts above), add rate limiting, and turn on encryption at
   rest on your managed Postgres instance.
7. **Observability:** point `backend/logger.js` at a hosted log sink (e.g. Logtail,
   Datadog) instead of a local file, once there's a server to ship logs from.

None of this blocks today's testing — it's the path forward once you're happy with the
MVP and ready to put it in front of real users.

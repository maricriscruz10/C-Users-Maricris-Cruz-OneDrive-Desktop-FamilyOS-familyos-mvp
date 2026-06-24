# Testing Environment, Scenarios & Expected Results

## 1. Sample data — what `node seed.js` creates

Run from `familyos-mvp/backend`: `node seed.js`. This wipes and recreates everything below.
Re-run it any time to reset to a clean state.

### Family 1 — The Garcia Family (fully active household)

| Name | Email | Role | Notes |
|---|---|---|---|
| Dana Garcia | dana@example.com | admin | Primary organizer |
| Marc Garcia | marc@example.com | member | Co-parent |
| Grandma Rosa | rosa@example.com | member | Secondary caregiver |
| Lily Garcia (age 9) | lily@example.com | child | |
| Sam Garcia (age 13) | sam@example.com | child | |

Sample events: Piano Lesson (weekly recurrence, today, Lily+Dana accepted), Soccer
Practice (tomorrow, Sam pending / Marc accepted), Family Dinner (in 2 days, Sam still
pending — tests partial-response state), Pick up Lily from school (in 3 days, Grandma
accepted), Dr. Patel checkup (2 days ago, completed by both — tests past/completed
state). Also pre-loaded: a notification for Lily, a notification for Sam, an audit-log
entry simulating a past conflicting edit to the Soccer Practice location (useful for
testing the Audit Log screen without having to generate a live conflict first).

**Appointments & occasions** *(added by request)*: Lily's Dentist Cleaning
(`category: appointment`, provider "Dr. Yuen — Bright Smiles Dental"), Sam's 8th Grade
Graduation, Lily's 10th Birthday Party — all tagged `category: appointment` so they show
up with a 📌 marker and on the Dashboard's "Appointments & occasions" card.

**Budget** *(added by request)*: 4 categories — Groceries ($600/mo), Kids Activities
($200/mo), Medical ($150/mo), Household ($300/mo) — with several transactions. Kids
Activities is deliberately pushed to $225 spent against its $200 limit, so
`GET /budget/summary` returns `overBudget: true` / `remaining: -25` for it out of the
box — use this to test the over-budget UI without logging a transaction yourself.

**Meal plan** *(added by request)*: a week-plus of breakfast/lunch/dinner entries.

**Chores** *(added by request)*: 5 chores — "Fold laundry" is pre-completed (with a
`chore_completions` row, so you can see completed-state UI immediately); "Set the
table" and "Feed the dog" are assigned to Lily; "Take out the trash" and "Clean room"
are assigned to Sam — useful for testing the child "complete my own chore" flow and the
"can't complete someone else's chore" rejection.

### Family 2 — The Okafor Family (low-engagement household)

| Name | Email | Role | Notes |
|---|---|---|---|
| Tomi Okafor | tomi@example.com | admin | |
| Chidi Okafor | chidi@example.com | member | Deliberately never "logs in" / has no responses — simulates the BRD's stated risk that secondary users disengage |
| Ada Okafor (age 7) | ada@example.com | child | |

Sample event: Dentist Appointment (in 4 days, `category: appointment`), with a
notification flagging that Chidi hasn't responded — use this family to test the "low
engagement" / reminder-escalation angle and to confirm tenant isolation (Okafors should
never see Garcia data, or vice versa). Also has a birthday appointment plus minimal
budget/meal/chore data — deliberately sparse, to test empty/near-empty UI states (e.g.
"no transactions yet," a mostly-empty week of meals) rather than only the fully-loaded
Garcia family.

## 2. How to log in as different users

Open the web app or mobile app → Login screen → tap/click any name above. No password.
Switching users: web → click your name in the sidebar → "Switch user"; mobile →
Settings tab → "Switch user." Both clear the local session and return to Login.

## 3. Feature test guide

For each feature: what it does, how it works, how to test it, expected result.

### Event creation
- **What it does:** lets Admins/Members create a calendar event with assignees.
- **How it works:** `POST /api/families/:id/events`, writes `events` +
  `event_versions` + `event_assignments` + a `notification` per assignee, broadcasts
  via SSE.
- **How to test:** log in as Dana → Dashboard → "+ New event" → fill form, assign Marc
  and Sam → Save.
- **Expected result:** event appears instantly for Dana; logging in as Marc or Sam (or
  watching the SSE-driven live update) shows the new event and a notification.

### Event editing / RBAC on edit
- **What it does:** owners and Admins can edit; other Members/Children cannot.
- **How to test:** log in as Marc (non-owner, non-admin) → try editing an event Dana
  created. Then log in as Dana (admin) and edit the same event.
- **Expected result:** Marc's edit attempt is rejected with `403 FORBIDDEN`; Dana's
  succeeds. Logging in as Sam (child) should not even show an edit control.

### Assignment response (accept/decline/complete)
- **How to test:** log in as Sam → open "Soccer Practice" (currently pending) → tap
  Accept, then later Complete.
- **Expected result:** status updates immediately; Marc (event creator) gets a
  notification each time Sam's status changes; Audit Log shows the change.

### Conflict resolution
- **How to test:** open the same event in two browser tabs logged in as two different
  users. In Tab A, change the location and save. In Tab B (which still has the old
  version loaded), change the description and save.
- **Expected result:** Tab B's save succeeds (not rejected) and the response includes
  `conflict: true` with `conflictFields`. Both changes are preserved — Tab A's location
  edit and Tab B's description edit both land, because they touched different fields.
  Check `event_versions` (or the Audit Log) to see both versions recorded.

### Real-time sync
- **How to test:** log in as the same family on two browser windows. Create/edit an
  event in one.
- **Expected result:** the other window updates within ~1 second via SSE, or within 8
  seconds via the polling fallback if you simulate an SSE drop (e.g. by blocking the
  `/stream` request in dev tools).

### Tenant isolation
- **How to test:** log in as Tomi (Okafor admin). Note the Okafor family's
  `familyId`. Try calling `GET /api/families/<garcias-family-id>/events` with Tomi's
  token (e.g. via curl).
- **Expected result:** `403 TENANT_ISOLATION` — a user can never read or write another
  family's data, regardless of role.

### Role management & last-admin guard
- **How to test:** log in as Dana → Family screen → try demoting yourself (the only
  admin) to member, or removing yourself.
- **Expected result:** rejected with `409 LAST_ADMIN`. Promote Marc to admin first,
  then demoting Dana should succeed (now two admins exist... demoting one still leaves
  one).

### Invite flow
- **How to test:** log in as Dana → Family → "+ Invite member" → add a test name/email
  as a Member.
- **Expected result:** new row appears with `status: invited`. Log out, return to
  Login screen — the invited name now appears there; "logging in" as them flips their
  status to `active`.

### Notifications
- **How to test:** trigger any of the above (assignment, response, role change) and
  check the Notifications screen / Alerts tab.
- **Expected result:** new notification appears, unread-count badge increments, tapping
  it marks it read (`PATCH /api/notifications/:id/read`).

### Audit log (admin-only)
- **How to test:** log in as Dana → Audit Log. Then log in as Marc (member) and try to
  navigate there directly via URL/route.
- **Expected result:** Dana sees the full change feed with before/after snippets; Marc
  is blocked (`403 FORBIDDEN` from the API; the UI also hides the nav link for
  non-admins).

### Appointments & occasions *(added by request)*
- **What it does:** lets any event be tagged as an appointment/occasion with an
  optional provider/detail field (doctor, venue, etc.), instead of a generic event.
- **How it works:** same `events` table/endpoints as regular events, with
  `category: 'appointment'` and `provider`. No new permissions — covered entirely by
  existing `event:*` RBAC.
- **How to test:** log in as Dana → "+ New event" → set Type to "Appointment /
  occasion" → fill provider → Save.
- **Expected result:** event shows a 📌 marker on the calendar/agenda and appears on the
  Dashboard's "Appointments & occasions" card. Filtering `GET /events?category=appointment`
  returns only tagged events.

### Budgeting *(added by request)*
- **What it does:** lets Admin/Member track spending per category against a monthly
  limit; Child has no access at all.
- **How it works:** `GET/POST /api/families/:id/budget/categories` (Admin manages
  categories), `GET/POST /api/families/:id/budget/transactions` (Admin+Member log
  spend), `GET /api/families/:id/budget/summary` computes spent/remaining/overBudget
  per category for a given month.
- **How to test:** log in as Marc (member) → Budget → "+ Transaction" → log $50 against
  Kids Activities (already at $225/$200). Then log in as Lily (child) and try to open
  Budget, or call `GET /budget/categories` directly with her token.
- **Expected result:** Marc's transaction succeeds and the summary updates; Kids
  Activities shows `overBudget: true`. Lily sees no Budget tab/link in the UI, and the
  API returns `403 FORBIDDEN` if called directly. Marc cannot create a *category*
  (`403`) — only Admin can.

### Meal planning *(added by request)*
- **What it does:** a shared meal calendar by date and meal type, visible to everyone.
- **How it works:** `GET/POST /api/families/:id/meals`, `PUT/DELETE /api/meals/:id`,
  gated by `meals:view` (everyone) / `meals:manage` (Admin+Member).
- **How to test:** log in as Dana → Meal Plan → "+ Add" → Tuesday dinner, assign Marc as
  cook. Log in as Sam (child) and view the Meals tab.
- **Expected result:** Sam can see the new dinner entry (read-only — no "+ Add" button
  or delete control for his role).

### Chores *(added by request)*
- **What it does:** assignable household tasks with recurrence and points; anyone can
  complete their own, Admin can complete anyone's.
- **How it works:** `GET/POST /api/families/:id/chores`, `PUT/DELETE /api/chores/:id`,
  `POST /api/chores/:id/complete` (logs a `chore_completions` row, notifies the
  creator), gated by `chores:view` / `chores:manage` / `chores:complete:own` /
  `chores:complete:any`.
- **How to test:** log in as Sam (child) → Chores → tap "Done" on his own "Take out the
  trash." Then log in as Lily (child) and try to mark Sam's chore done.
- **Expected result:** Sam's completion succeeds (`{"ok":true,"pointsAwarded":10}` or
  similar) and the chore moves to "Recently completed." Lily's attempt on Sam's chore
  returns `403 FORBIDDEN`.

### Offline support (mobile)
- **How to test:** on the Expo app, turn on Airplane Mode. Create a new event or edit
  an existing one. Turn Airplane Mode back off.
- **Expected result:** offline banner appears while disconnected; the action is queued
  (visible by inspecting `AsyncStorage` mutation queue if needed) and silently replays
  once back online, with no duplicate or lost writes.

### Logging & error handling
- **How to test:** trigger a deliberate error (e.g. POST an event with a missing
  `title`, or use an expired/garbage token).
- **Expected result:** a structured `{ error: { code, message } }` JSON response with
  an appropriate HTTP status (400/401/403/404), and a corresponding line in
  `backend/logs/app.log`.

## 4. Error & edge-case scenarios checklist

- Invalid/expired session token → `401 UNAUTHORIZED`.
- Missing required event fields (title, start/end) → `400 VALIDATION_ERROR`.
- `end_at` before `start_at` → `400 VALIDATION_ERROR`.
- Assigning a user who isn't in the family → `404`/`400`.
- Deleting an already-deleted (soft-deleted) event → `404 NOT_FOUND`.
- Removing the last admin → `409 LAST_ADMIN` (see above).
- Cross-family access of any kind → `403 TENANT_ISOLATION`.
- Child role attempting create/update/delete/member-management → `403 FORBIDDEN`.
- Concurrent edits to the *same field* → last write wins for that field, both versions
  retained in history, `conflictFields` reported.
- Backend restarted mid-session → sessions persist (stored in SQLite, not memory), so
  existing tokens keep working until they expire.
- Mobile app force-closed while offline with queued mutations → mutation queue is
  persisted in AsyncStorage, so it survives the restart and flushes on next launch once
  online.
- Child calls any budget endpoint directly (bypassing the UI) → `403 FORBIDDEN`, no
  exceptions — budget has zero child access, not just a hidden UI element.
- Non-assignee, non-admin tries to complete someone else's chore → `403 FORBIDDEN`.
- Member (not Admin) tries to create/edit/delete a budget *category* → `403 FORBIDDEN`
  (Member can log transactions but not manage categories).
- Mobile Budget/Meals/Chores writes attempted while offline → these are **not**
  offline-queued (unlike event CRUD); expect the request to simply fail until
  connectivity returns — a known, documented gap, not a bug.

## 5. Security/permission test matrix (quick reference)

| Action | Admin | Member | Child |
|---|---|---|---|
| Create event | ✅ | ✅ | ❌ |
| Edit own event | ✅ | ✅ | ❌ |
| Edit others' event | ✅ | ❌ | ❌ |
| Delete event | ✅ (any) | ✅ (own only) | ❌ |
| Respond to own assignment | ✅ | ✅ | ✅ |
| Invite/remove member | ✅ | ❌ | ❌ |
| Change roles | ✅ | ❌ | ❌ |
| View audit log | ✅ | ❌ | ❌ |
| Manage family settings | ✅ | ❌ | ❌ |
| Create/edit appointment (event w/ category) | ✅ | ✅ (own) | ❌ |
| View budget | ✅ | ✅ | ❌ |
| Log budget transaction | ✅ | ✅ | ❌ |
| Manage budget categories | ✅ | ❌ | ❌ |
| View meal plan | ✅ | ✅ | ✅ |
| Add/edit/delete meal plan entry | ✅ | ✅ | ❌ |
| View chores | ✅ | ✅ | ✅ |
| Add/edit/delete chore | ✅ | ✅ | ❌ |
| Complete own assigned chore | ✅ | ✅ | ✅ |
| Complete another user's chore | ✅ | ❌ | ❌ |

Verified by direct curl testing during this build (dev-login as each role, attempt each
action, confirm 200 vs 403) — see `02_tech_stack_and_architecture.md` §5 for the
underlying RBAC implementation. The budgeting/meals/chores/appointments rows were
verified the same way after being added by request, across all three roles in the
Garcia family plus a tenant-isolation check against the Okafor family.

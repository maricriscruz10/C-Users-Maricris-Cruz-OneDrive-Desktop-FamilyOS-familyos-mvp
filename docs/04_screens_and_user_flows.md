# Complete Screen List & User Flows

## 1. Screen list — Desktop (web) app

| Screen | Route | Who sees it | Purpose |
|---|---|---|---|
| Login | `#/login` | Everyone (logged out) | Dev Login picker — choose a household member |
| Dashboard | `#/dashboard` | All roles | Today's events, 7-day lookahead, household stats |
| Calendar | `#/calendar` | All roles | Month grid, click a day to view/add events |
| Family (Members) | `#/members` | All roles view; Admin can invite/edit/remove | Roster, role management, invites |
| Notifications | `#/notifications` | All roles | Notification inbox, mark read |
| Audit Log | `#/audit` | Admin only | Full change history for the family |
| Settings | `#/settings` | All roles view; Admin can edit | Family name, timezone, reminder lead time |
| Budget *(added by request)* | `#/budget` | Admin + Member only — **hidden entirely for Child** | Per-category spend summary (over-budget flagged), transaction log |
| Meal Plan *(added by request)* | `#/meals` | All roles | Day-grouped meal calendar by breakfast/lunch/dinner/snack |
| Chores *(added by request)* | `#/chores` | All roles | Pending/completed chore lists, assign + mark done |
| Event modal | (overlay) | Create: Admin/Member. Edit: owner or Admin. View: all | Create/edit/delete an event, assign members, **choose General vs. Appointment/occasion type + provider detail** |
| Invite modal | (overlay) | Admin only | Add a new household member |
| Budget category / transaction modals *(added by request)* | (overlay) | Category: Admin only. Transaction: Admin + Member | Add a budget category or log a transaction |
| Meal modal *(added by request)* | (overlay) | Admin + Member | Add a planned meal |
| Chore modal *(added by request)* | (overlay) | Admin + Member | Add a chore, assign it, set recurrence/points |

## 2. Screen list — Mobile app (iOS/Android)

| Screen | Tab | Who sees it | Purpose |
|---|---|---|---|
| Login | (pre-tab) | Everyone (logged out) | Dev Login picker |
| Agenda | Agenda 📅 | All roles | Day-grouped upcoming events, pull-to-refresh, offline banner |
| Family | Family 👨‍👩‍👧 | All roles (read-only on mobile in this MVP) | Roster with roles |
| Budget *(added by request)* | Budget 💰 | Admin + Member only — **tab is not shown at all for Child** | Per-category spend summary + transaction list, pull-to-refresh |
| Meals *(added by request)* | Meals 🍽️ | All roles | Day-grouped meal plan, add/remove (Admin/Member only) |
| Chores *(added by request)* | Chores ✅ | All roles | Pending/completed lists; mark done (assignee or Admin); add/remove (Admin/Member only) |
| Notifications | Alerts 🔔 | All roles | Notification inbox, tap to mark read |
| Settings | Settings ⚙️ | All roles | Profile, household info, backend connection, switch user |
| Event modal | (overlay) | Create: Admin/Member. Edit: owner or Admin | Create/edit/delete an event, assign members, offline-aware, **General vs. Appointment/occasion type + provider field** |

> Member invite/role-management is desktop-only in this MVP (the workflow needs more
> screen space for a table-like view) — see doc 01 assumptions table. Everything else has
> full parity across platforms, including the four added-by-request features.
> Note: Budget/Meals/Chores writes on mobile call the API directly and are **not** part
> of the offline mutation queue (only event CRUD is offline-queued) — see
> `05_testing_environment.md` for what to expect if you test these screens while offline.

## 3. Core user flows

### Flow A — First login / "Dev Login" (stand-in for OAuth)
1. Open the app (web or mobile). Not logged in → Login screen.
2. See every seeded household member grouped by family, with role badges.
3. Tap/click a person → backend issues a session token → land on Dashboard/Agenda.
4. *(Assumption, see doc 01: real builds replace this screen with a single
   "Continue with Google" / "Continue with Apple" button — the session/RBAC layer
   underneath doesn't change.)*

### Flow B — Create an event and assign responsibility
1. From Dashboard/Calendar/Agenda, tap **+ New event**.
2. Fill in title, location, description, start/end time, recurrence.
3. Check the box next to each household member who should be responsible.
4. Save → event appears immediately for the creator; assignees receive an in-app
   notification (and, on mobile, a scheduled local reminder).
5. Admin/Member can edit; Child can only view and respond.

### Flow C — Respond to an assignment (accept/decline/complete)
1. Assignee opens the event (from Dashboard, Calendar, or Agenda).
2. Marks it accepted, declined, or completed.
3. Event creator gets a notification of the response.
4. Audit log records the response change.

### Flow D — Concurrent edit / conflict resolution
1. Two household members open the same event on different devices.
2. Both edit different fields and save around the same time.
3. The second save sends the version it last saw; the server detects the version has
   moved, merges field-by-field, and returns `conflict: true` with the list of fields
   that collided.
4. The UI shows a toast: "Saved with conflict resolution on: <fields>" — no save is
   silently lost, and the full history is in the audit log / event_versions table.

### Flow E — Invite a new family member (Admin)
1. Admin opens Family → "+ Invite member".
2. Enters name, email, role.
3. New member appears in the roster with status `invited`.
4. The invited person opens the Login screen, finds their name, taps it →
   status flips to `active` and they're in.

### Flow F — Role change / removal with safety guard
1. Admin changes another member's role via the dropdown in the Family screen.
2. If demoting/removing would leave the family with zero admins, the server rejects it
   (`409 LAST_ADMIN`) — there's always at least one admin, by design.

### Flow G — Going offline and back online (mobile)
1. Turn off WiFi/cellular on the test device (or simulate via Airplane Mode).
2. The app shows the amber "Offline" banner; Agenda falls back to cached data.
3. Create/edit/delete an event anyway — it's queued locally instead of failing.
4. Reconnect — within ~10 seconds the queued mutation(s) replay against the server in
   order, and the banner disappears.

### Flow H — Audit & accountability (Admin)
1. Admin opens Audit Log.
2. Sees a reverse-chronological feed of every event/member/settings change, who made
   it, and a before/after snippet.
3. Useful for answering "who moved this?" without trusting anyone's memory.

### Flow I — Log an appointment or occasion *(added by request)*
1. From Dashboard/Calendar/Agenda, tap **+ New event**.
2. Set Type to "Appointment / occasion" — a Provider/detail field appears (e.g. "Dr.
   Yuen — Bright Smiles Dental", or just "Graduation ceremony" with no provider).
3. Save like any other event — it shows up on the calendar with a 📌 marker, and on the
   Dashboard's dedicated "Appointments & occasions" card.

### Flow J — Track spending against a budget *(added by request, Admin/Member only)*
1. Admin opens Budget → "+ Category" → names it, sets a monthly limit, picks a color.
2. Admin or Member → "+ Transaction" → picks a category, enters amount/description.
3. The category's summary card updates immediately (spent/remaining); if spending
   exceeds the monthly limit, the card flags `overBudget` and shows the overage in red.
4. Child role never sees the Budget screen/tab at all — not hidden by the UI alone, the
   backend also returns `403` if a child's token is used to call the budget endpoints
   directly.

### Flow K — Plan a meal *(added by request)*
1. Any Admin/Member opens Meal Plan / Meals → "+ Add" → picks a date, meal type
   (breakfast/lunch/dinner/snack), title, optional notes, optional assigned cook.
2. Everyone in the family, including children, can see the resulting day-grouped plan.

### Flow L — Assign and complete a chore *(added by request)*
1. Admin/Member opens Chores → "+ Add" → title, optional description, assignee,
   recurrence, optional due date, points value.
2. The assignee (or Admin, on anyone's behalf) sees it in "To do" and taps "Done" to
   complete it — this logs a `chore_completions` row and (for non-recurring chores)
   flips status to completed. The chore creator gets a notification.
3. A child who is *not* the assignee cannot complete someone else's chore (`403`).

## 4. Navigation map (desktop)

```
Login ──(pick user)──▶ Dashboard ─┬─▶ Calendar
                                   ├─▶ Family ──▶ Invite modal
                                   ├─▶ Budget (hidden for Child) ──▶ Category / Transaction modals
                                   ├─▶ Meal Plan ──▶ Meal modal
                                   ├─▶ Chores ──▶ Chore modal
                                   ├─▶ Notifications
                                   ├─▶ Audit Log (admin only)
                                   └─▶ Settings
        (any screen) ──▶ Event modal (create/edit/delete, General or Appointment type)
```

## 5. Navigation map (mobile)

```
Login ──(pick user)──▶ [Tab bar] Agenda | Family | Budget* | Meals | Chores | Alerts | Settings
        (* Budget tab omitted entirely for Child role)
        Agenda ──▶ Event modal (create/edit/delete, offline-aware, General or Appointment type)
        Budget ──▶ Transaction modal
        Meals ──▶ Meal modal
        Chores ──▶ Chore modal (add) / "Done" button (complete)
        Settings ──▶ Switch user (clears local cache, returns to Login)
```

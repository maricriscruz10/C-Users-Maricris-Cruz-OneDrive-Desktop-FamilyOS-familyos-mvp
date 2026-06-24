# FamilyOS — Project Summary & Requirements

## 1. What this project is

FamilyOS is a cross-platform "Family Operating System" focused on **shared scheduling,
event coordination, and responsibility assignment** for households. The three source
documents (BRD, Data & Research, Skills & Hooks spec) describe a calendar-first MVP —
the original BRD explicitly listed meal planning, chores, and budgeting as **out of
scope**.

> **Scope update (post-MVP-v1, by direct request):** you asked to bring budgeting, meal
> planning, chores, and a broadened "appointments & occasions" capability (doctor visits,
> graduations, birthdays, etc.) into the product. These four areas have since been fully
> designed and built — backend, web, and mobile — and are documented throughout this
> doc set. They're called out explicitly wherever they appear so it's clear they're an
> intentional expansion beyond the original BRD, not part of the three source documents.

The core problem it solves: families currently coordinate across fragmented tools
(Google Calendar, WhatsApp, Apple Calendar), there's no single source of truth, one
parent carries the administrative burden, and secondary household members rarely
engage. FamilyOS's job is to make responsibility for each event explicit and to reduce
the effort required to keep everyone in sync.

## 2. Confirmed understanding

- **Unit of isolation:** a "family" is a tenant. Each family's data (events, members,
  notifications, audit log) is fully isolated from every other family.
- **Roles:** Admin (primary organizer), Member (co-parent/secondary caregiver), Child
  (limited view + response capability). RBAC is enforced server-side on every request.
- **Core object:** the Event — has a title, time range, location, recurrence, and one or
  more assignees who can accept/decline/complete.
- **Reliability bar:** "no broken sync states, no silent data loss, no single point of
  failure user roles" — which is why every event change is versioned and audit-logged,
  and why conflict resolution merges rather than silently overwrites.
- **Adoption is the real risk**, not feature count — per the Data & Research doc, the
  product should minimize manual entry and reduce the primary organizer's cognitive
  load, not add more screens.

## 3. Features, user types, workflows, requirements (as extracted from the 3 docs)

**User types:** Admin, Member, Child (view-limited) — multi-tenant per family.

**Core features (in scope):**
- Family creation & multi-user membership
- Event CRUD (create/read/update/delete) with title, description, location, time range,
  all-day flag, recurrence (none/daily/weekly/monthly)
- Per-event member assignment with accept/decline/complete responses
- Family calendar (month view) + agenda view
- Push notifications for assignment, updates, and reminders
- Role-based access control (Admin/Member/Child)
- Audit log of all event/member/settings changes
- Event versioning + conflict resolution (last-write + field merge)
- Real-time sync across devices
- Offline-first caching (BRD specifies "last 30 days of events")
- Settings: family name, timezone, reminder lead time

**Added by request, beyond the original BRD scope:**
- **Appointments & occasions** — implemented as a `category` field (`general` |
  `appointment`) plus an optional `provider`/detail field on the existing Event object,
  so it reuses all existing event CRUD, assignment, versioning, RBAC, and notification
  machinery rather than being a separate object. Covers doctor/dentist visits,
  graduations, birthdays, and similar one-off occasions.
- **Budgeting** — categories with monthly limits + transactions, a per-category
  spent/remaining/over-budget summary. Treated as financially sensitive: **Child has
  zero access** (no view, no entry); Member and Admin can log transactions; only Admin
  can create/edit budget categories.
- **Meal planning** — a calendar-style plan of meals by date and meal type (breakfast/
  lunch/dinner/snack), with an optional assigned cook. Visible to every role (including
  Child); Admin/Member can create, edit, and delete entries.
- **Chores** — assignable tasks with optional recurrence (none/daily/weekly/monthly),
  due date, and a points value. Visible to every role; Admin/Member can create/edit/
  delete; any user can mark *their own* assigned chore complete, and Admin can mark any
  chore complete on anyone's behalf.

**Originally out of scope, still out of scope:** social feeds.

**Non-functional requirements called out in the docs:** sub-200ms calendar load,
<1s real-time sync, support for 10,000+ families, OAuth-only auth (no passwords),
encryption at rest + TLS in production, indexed queries, lazy-loaded calendar views.

## 4. Gaps in the source docs & assumptions made to keep building

The docs are intentionally strategic/architectural and leave several implementation
details unspecified. Rather than stall on these, I made the following call and kept
building — flagging each clearly so you can revisit:

| Gap | Assumption made | Why |
|---|---|---|
| OAuth requires real Google/Apple client credentials we don't have | Built a **"Dev Login"**: pick any seeded user from a list and get a signed session token. The auth/session/RBAC layer is provider-agnostic — swapping in real OAuth later only changes how the user record is first resolved. | Lets you test every role and workflow today without registering OAuth apps. |
| BRD specifies Supabase/Postgres + Next.js + Expo + Socket.io | This build sandbox has **no access to the npm package registry** (confirmed via direct test — all installs return 403/blocked-by-allowlist). Built the backend as **dependency-free Node.js** (`http`, the new built-in `node:sqlite`, `crypto`) so it runs today with zero install. Built the desktop app as a **dependency-free static HTML/CSS/JS app** instead of Next.js, for the same reason. The Expo mobile app *is* written against the real `expo`/`react-native` packages (since you'll run `npm install` on your own machine, which has normal internet access) — I just couldn't execute/test it inside this sandbox. | Keeps the MVP runnable and testable *today*. The API contracts and data model match what a Postgres/Supabase backend would look like — see `03_database_design.md` for the production-equivalent Postgres DDL — so migrating later is a backend swap, not a rewrite. |
| No specific list of event fields | Used: title, description, location, start/end, all-day flag, recurrence, assignees, version. | Standard calendar event shape; covers every workflow named in the BRD. |
| No specific recurrence/RRULE detail | Implemented simplified recurrence (none/daily/weekly/monthly) with server-side occurrence expansion, instead of full iCal RRULE. | Full RRULE parsing is a "hook" listed for later; simplified version covers the MVP workflows without the parsing complexity. |
| No explicit conflict-resolution algorithm | Implemented version-numbered events; on update, fields the client didn't touch are preserved, fields both sides changed are flagged as `conflictFields` and the latest write wins per-field, all changes recorded in `event_versions` and `audit_logs`. | Matches BRD's literal phrase "last-write + merge rules" as closely as a deterministic algorithm can. |
| No explicit push provider | Wired Expo push token registration end-to-end, but **actual** push delivery needs Expo/FCM/APNs credentials this sandbox can't provision. Added **local, client-scheduled reminder notifications** on the mobile app so reminder behavior is fully testable without a push server. | Lets you test the full notification *workflow* now; swapping in real push delivery later is a backend job (call Expo's Push API with the stored tokens), not a redesign. |
| No explicit "child" permissions | Child role can view events and respond to/complete their own assignments, but cannot create/edit/delete events or manage members. | Matches "Kids ignore scheduling apps unless extremely simple" — child UI is read+respond only. |
| No explicit invite flow (since OAuth-only, no email/password) | Admin "invites" a member by entering name/email/role; the invited user shows as `status: invited` until they log in (dev-login) for the first time, then flips to `active`. | Mirrors a real OAuth invite flow's shape without needing an email-sending service in the sandbox. |
| No spec at all for appointments/occasions (added by request) | Modeled as `events.category = 'appointment'` plus an optional `events.provider` free-text field, instead of a brand-new entity. | Appointments and occasions are structurally just events with a label — building a parallel CRUD/RBAC/notification stack would duplicate logic for no real benefit. |
| No spec for budgeting (added by request) | Two tables: `budget_categories` (name, monthly limit, color, family-scoped) and `budget_transactions` (category, amount, description, date, who logged it). Summary is computed server-side per month. Child role gets no permission at all — not even read. | Money is the one new domain where "kids can see everything" is the wrong default; treated it like the BRD treats admin-only audit logs. |
| No spec for meal planning (added by request) | One table, `meal_plan_entries`, keyed by date + meal type, with optional title/notes/assigned cook. | Simplest shape that supports "what's for dinner this week" without inventing a recipe/ingredient system nobody asked for. |
| No spec for chores (added by request) | One table, `chores` (assignee, recurrence, due date, points, status), plus `chore_completions` to log each completion event (supports recurring chores being completed repeatedly). | Points give a lightweight, optional gamification hook without requiring a rewards/redemption system that wasn't requested. |

## 5. What was actually built

A working MVP across three apps sharing one backend:

1. **Backend** — `familyos-mvp/backend` — zero-dependency Node.js API + SQLite database,
   full RBAC, multi-tenancy, event CRUD with versioning/conflict-resolution, audit
   logging, notifications, real-time SSE stream, structured logging, plus the
   **budgeting, meal planning, chores, and appointments** routes/business rules.
2. **Desktop (web) app** — `familyos-mvp/web` — login, dashboard, calendar, family
   members management, settings, notifications, audit log, **Budget, Meal Plan, and
   Chores screens**, appointment-aware event form and dashboard widget. No build step
   required.
3. **Mobile app (iOS/Android via Expo)** — `familyos-mvp/mobile` — login, agenda,
   event creation/editing (with appointment type + provider field), family members,
   notifications, settings, offline-first caching + mutation queue, push notification
   registration + local reminders, plus **Budget, Meals, and Chores tabs**.

See `02_tech_stack_and_architecture.md`, `03_database_design.md`,
`04_screens_and_user_flows.md`, `05_testing_environment.md`, and
`06_run_locally_and_deployment.md` for the rest of the deliverable.

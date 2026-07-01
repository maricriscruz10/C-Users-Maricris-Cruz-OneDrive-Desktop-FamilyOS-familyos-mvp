// Seeds two sample families with users, events (incl. appointments/occasions),
// budget data, meal plans, chores, assignments, and notifications.
// Run with: node seed.js  (wipes and recreates demo data)

const db = require('./db');
const crypto = require('crypto');
const { logger } = require('./logger');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function wipe() {
  for (const t of ['chore_completions','chores','meal_plan_entries','budget_transactions','budget_categories',
                    'event_assignments','event_versions','events','notifications','audit_logs','sessions','users','families']) {
    db.exec(`DELETE FROM ${t}`);
  }
}

function insertFamily(name, timezone) {
  const id = uuid();
  db.prepare(`INSERT INTO families (id,name,timezone,created_at,settings_json) VALUES (?,?,?,?,?)`)
    .run(id, name, timezone, now(), JSON.stringify({ reminderMinutesBefore: 60, weekStartsOn: 'Sunday' }));
  return id;
}

function insertUser(familyId, name, email, role, color) {
  const id = uuid();
  db.prepare(`INSERT INTO users (id,family_id,name,email,role,avatar_color,oauth_provider,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, familyId, name, email, role, color, 'dev', 'active', now());
  return id;
}

function insertEvent(familyId, createdBy, title, startAt, endAt, opts = {}) {
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO events (id,family_id,title,description,location,start_at,end_at,all_day,recurrence,category,provider,created_by,version,deleted,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
    .run(id, familyId, title, opts.description || '', opts.location || '', startAt, endAt, opts.allDay ? 1 : 0,
      opts.recurrence || 'none', opts.category || 'general', opts.provider || '', createdBy, ts, ts);
  db.prepare(`INSERT INTO event_versions (id,event_id,version,data_json,changed_by,change_type,created_at) VALUES (?,?,1,?,?,?,?)`)
    .run(uuid(), id, JSON.stringify({ title, startAt, endAt }), createdBy, 'create', ts);
  return id;
}

function assign(eventId, userId, status = 'pending') {
  db.prepare(`INSERT INTO event_assignments (id,event_id,user_id,response_status,created_at) VALUES (?,?,?,?,?)`)
    .run(uuid(), eventId, userId, status, now());
}

function notify(familyId, userId, type, title, body, eventId = null) {
  db.prepare(`INSERT INTO notifications (id,family_id,user_id,type,title,body,related_event_id,read,created_at) VALUES (?,?,?,?,?,?,?,0,?)`)
    .run(uuid(), familyId, userId, type, title, body, eventId, now());
}

function audit(familyId, entityType, entityId, action, actorId, before, after) {
  db.prepare(`INSERT INTO audit_logs (id,family_id,entity_type,entity_id,action,actor_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), familyId, entityType, entityId, action, actorId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now());
}

function insertBudgetCategory(familyId, name, monthlyLimit, color) {
  const id = uuid();
  db.prepare(`INSERT INTO budget_categories (id,family_id,name,monthly_limit,color,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, familyId, name, monthlyLimit, color, now());
  return id;
}

function insertBudgetTx(familyId, categoryId, amount, description, occurredOn, createdBy) {
  const id = uuid();
  db.prepare(`INSERT INTO budget_transactions (id,family_id,category_id,amount,description,occurred_on,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, familyId, categoryId, amount, description, occurredOn, createdBy, now());
  return id;
}

function insertMeal(familyId, mealDate, mealType, title, notes, assignedCook, createdBy, calories = 0) {
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO meal_plan_entries (id,family_id,meal_date,meal_type,title,notes,assigned_cook,created_by,calories,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, familyId, mealDate, mealType, title, notes || '', assignedCook || null, createdBy, calories, ts, ts);
  return id;
}

function insertChore(familyId, title, description, assigneeId, recurrence, dueDate, points, createdBy, status = 'pending') {
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO chores (id,family_id,title,description,assignee_id,recurrence,due_date,points,status,created_by,deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`)
    .run(id, familyId, title, description || '', assigneeId || null, recurrence || 'none', dueDate || null, points || 0, status, createdBy, ts, ts);
  return id;
}

function run() {
  wipe();

  // ---- Family 1: The Garcias (fully active household) ----
  const garcias = insertFamily('The Garcia Family', 'America/Chicago');
  const dana = insertUser(garcias, 'Dana Garcia', 'dana@example.com', 'admin', '#6366f1');     // primary organizer
  const marc = insertUser(garcias, 'Marc Garcia', 'marc@example.com', 'member', '#10b981');    // co-parent
  const grandma = insertUser(garcias, 'Grandma Rosa', 'rosa@example.com', 'member', '#f59e0b'); // secondary caregiver
  const lily = insertUser(garcias, 'Lily Garcia (age 9)', 'lily@example.com', 'child', '#ec4899');
  const sam = insertUser(garcias, 'Sam Garcia (age 13)', 'sam@example.com', 'child', '#3b82f6');

  const today = new Date();
  const d = (offsetDays, h, m = 0) => {
    const x = new Date(today);
    x.setDate(x.getDate() + offsetDays);
    x.setHours(h, m, 0, 0);
    return x.toISOString();
  };
  const ds = (offsetDays) => { // YYYY-MM-DD
    const x = new Date(today);
    x.setDate(x.getDate() + offsetDays);
    return x.toISOString().slice(0, 10);
  };

  const e1 = insertEvent(garcias, dana, 'Lily — Piano Lesson', d(0, 16, 0), d(0, 16, 45), { location: 'Music Studio', recurrence: 'weekly' });
  assign(e1, lily, 'accepted'); assign(e1, dana, 'accepted');
  notify(garcias, lily, 'event_reminder', 'Piano in 1 hour', 'Piano Lesson at 4:00 PM today', e1);

  const e2 = insertEvent(garcias, marc, 'Sam — Soccer Practice', d(1, 17, 30), d(1, 19, 0), { location: 'Riverside Field' });
  assign(e2, sam, 'pending'); assign(e2, marc, 'accepted');
  notify(garcias, sam, 'event_assigned', 'New event assigned', 'You were assigned to Soccer Practice', e2);

  const e3 = insertEvent(garcias, dana, 'Family Dinner', d(2, 18, 30), d(2, 19, 30), { location: 'Home' });
  assign(e3, dana, 'accepted'); assign(e3, marc, 'accepted'); assign(e3, lily, 'accepted'); assign(e3, sam, 'pending');

  const e4 = insertEvent(garcias, grandma, 'Pick up Lily from school', d(3, 15, 0), d(3, 15, 30), {});
  assign(e4, grandma, 'accepted');
  notify(garcias, dana, 'event_updated', 'Pickup confirmed', 'Grandma Rosa accepted: Pick up Lily from school', e4);

  const e5 = insertEvent(garcias, dana, "Dr. Patel — Sam's Checkup", d(-2, 10, 0), d(-2, 10, 30), {
    description: 'Annual physical', category: 'appointment', provider: 'Dr. Patel — Pediatrics',
  });
  assign(e5, sam, 'completed'); assign(e5, dana, 'completed');
  audit(garcias, 'event', e5, 'create', dana, null, { title: "Dr. Patel — Sam's Checkup" });

  // ---- Appointments / occasions (category='appointment') — broadened per request to cover
  // doctor visits, graduations, birthdays, etc., not just medical appointments.
  const e6 = insertEvent(garcias, dana, "Lily — Dentist Cleaning", d(5, 9, 0), d(5, 9, 45), {
    description: 'Routine cleaning + checkup', category: 'appointment', provider: 'Dr. Yuen — Bright Smiles Dental',
  });
  assign(e6, lily, 'pending'); assign(e6, dana, 'accepted');
  notify(garcias, dana, 'event_reminder', 'Upcoming appointment', "Lily's dentist cleaning in 5 days", e6);

  const e7 = insertEvent(garcias, marc, 'Sam — 8th Grade Graduation', d(10, 18, 0), d(10, 20, 0), {
    description: 'Middle school graduation ceremony', location: 'Lincoln Middle School Auditorium',
    category: 'appointment', provider: '', allDay: false,
  });
  assign(e7, dana, 'accepted'); assign(e7, marc, 'accepted'); assign(e7, grandma, 'pending'); assign(e7, sam, 'accepted');

  const e8 = insertEvent(garcias, dana, "Lily's 10th Birthday Party", d(14, 13, 0), d(14, 16, 0), {
    description: 'Backyard party, 10 kids invited', location: 'Home',
    category: 'appointment', provider: '',
  });
  assign(e8, dana, 'accepted'); assign(e8, marc, 'accepted'); assign(e8, lily, 'accepted');

  // a conflicting-edit example pre-baked into version history (for testing conflict resolution UI)
  audit(garcias, 'event', e2, 'update', marc, { location: 'Riverside Field' }, { location: 'Riverside Field (Field B)' });

  // ---- Budgeting (Child has zero access — see auth.js) ----
  const catGroceries     = insertBudgetCategory(garcias, 'Groceries',       600, '#10b981');
  const catActivities    = insertBudgetCategory(garcias, 'Kids Activities',  200, '#6366f1');
  const catMedical       = insertBudgetCategory(garcias, 'Medical',          150, '#ef4444');
  const catHousehold     = insertBudgetCategory(garcias, 'Household',        300, '#f59e0b');
  const catTransport     = insertBudgetCategory(garcias, 'Transportation',   400, '#f97316');
  const catDining        = insertBudgetCategory(garcias, 'Dining Out',       250, '#ec4899');
  const catUtilities     = insertBudgetCategory(garcias, 'Utilities',        200, '#3b82f6');
  const thisMonth = today.toISOString().slice(0, 7);
  insertBudgetTx(garcias, catGroceries,  84.32, 'Weekly grocery run — HEB',      `${thisMonth}-03`, dana);
  insertBudgetTx(garcias, catGroceries,  91.10, 'Weekly grocery run — HEB',      `${thisMonth}-10`, dana);
  insertBudgetTx(garcias, catGroceries,  76.55, 'Weekly grocery run — Costco',   `${thisMonth}-17`, marc);
  insertBudgetTx(garcias, catActivities, 45.00, 'Piano lesson — monthly fee',    `${thisMonth}-01`, dana);
  insertBudgetTx(garcias, catActivities,120.00, 'Soccer registration',           `${thisMonth}-05`, marc);
  insertBudgetTx(garcias, catActivities, 60.00, 'Soccer registration',           `${thisMonth}-05`, marc); // pushes Activities over its $200 limit — tests overBudget flag
  insertBudgetTx(garcias, catMedical,    35.00, "Sam's checkup copay",           `${thisMonth}-${(today.getDate() - 2 < 10 ? '0' : '') + Math.max(today.getDate() - 2, 1)}`, dana);
  insertBudgetTx(garcias, catHousehold,  22.99, 'Cleaning supplies',             `${thisMonth}-08`, grandma);
  insertBudgetTx(garcias, catTransport,  55.00, 'Gas fill-up',                   `${thisMonth}-05`, marc);
  insertBudgetTx(garcias, catTransport,  38.50, 'Grab — school run',             `${thisMonth}-12`, dana);
  insertBudgetTx(garcias, catTransport,  28.00, 'Grab — grocery trip',           `${thisMonth}-18`, dana);
  insertBudgetTx(garcias, catDining,     42.80, 'Pizza Hut — family night',      `${thisMonth}-09`, marc);
  insertBudgetTx(garcias, catDining,     18.50, 'GrabFood — lunch delivery',     `${thisMonth}-14`, dana);
  insertBudgetTx(garcias, catDining,     65.00, 'Restaurant — grandma birthday', `${thisMonth}-20`, dana);
  insertBudgetTx(garcias, catUtilities, 120.00, 'Electric bill',                 `${thisMonth}-02`, dana);
  insertBudgetTx(garcias, catUtilities,  45.00, 'Internet bill',                 `${thisMonth}-02`, dana);

  // ---- Meal planning (visible to everyone, only Admin/Member can create/edit) ----
  insertMeal(garcias, ds(0),  'breakfast', 'Oatmeal & berries',              '',                                           marc,    dana,  320);
  insertMeal(garcias, ds(0),  'dinner',    'Spaghetti & meatballs',          'Lily helps set the table',                   dana,    dana,  680);
  insertMeal(garcias, ds(1),  'breakfast', 'Scrambled eggs & toast',         '',                                           marc,    dana,  380);
  insertMeal(garcias, ds(1),  'lunch',     'Leftover spaghetti',             '',                                           null,    dana,  520);
  insertMeal(garcias, ds(1),  'dinner',    'Taco night',                     'Get extra tortillas',                        marc,    dana,  750);
  insertMeal(garcias, ds(2),  'dinner',    'Family Dinner — roast chicken',  'Coordinates with the Family Dinner event',   grandma, dana,  610);
  insertMeal(garcias, ds(3),  'breakfast', 'Avocado toast',                  '',                                           marc,    dana,  290);
  insertMeal(garcias, ds(3),  'dinner',    'Stir-fry veggies & rice',        '',                                           dana,    marc,  480);
  insertMeal(garcias, ds(-1), 'dinner',    'Pizza night',                    '',                                           marc,    dana,  820);

  // ---- Chores (assignable, recurring, points-based; visible to all roles incl. children) ----
  const c1 = insertChore(garcias, 'Set the table', 'Before every dinner', lily, 'daily', null, 5, dana, 'pending');
  const c2 = insertChore(garcias, 'Take out the trash', 'Bins go out Tuesday night', sam, 'weekly', ds(1), 10, dana, 'pending');
  const c3 = insertChore(garcias, 'Feed the dog', 'Morning and evening', lily, 'daily', null, 5, marc, 'pending');
  const c4 = insertChore(garcias, 'Clean room', '', sam, 'weekly', ds(4), 15, dana, 'pending');
  const c5 = insertChore(garcias, 'Fold laundry', 'Helped with this one last week', sam, 'none', ds(-3), 10, dana, 'completed');
  db.prepare(`INSERT INTO chore_completions (id,chore_id,completed_by,completed_on,points_awarded,created_at) VALUES (?,?,?,?,?,?)`)
    .run(uuid(), c5, sam, ds(-3), 10, now());
  notify(garcias, dana, 'chore_completed', 'Chore completed', 'Sam completed "Fold laundry"');
  notify(garcias, sam, 'chore_assigned', 'New chore assigned', 'You were assigned: "Clean room"');

  // ---- Family 2: The Okafors (low-engagement household — tests "secondary users rarely input data") ----
  const okafors = insertFamily('The Okafor Family', 'America/New_York');
  const tomi = insertUser(okafors, 'Tomi Okafor', 'tomi@example.com', 'admin', '#8b5cf6');
  const chidi = insertUser(okafors, 'Chidi Okafor', 'chidi@example.com', 'member', '#06b6d4'); // never logs in / inactive
  const ada = insertUser(okafors, 'Ada Okafor (age 7)', 'ada@example.com', 'child', '#f43f5e');

  const o1 = insertEvent(okafors, tomi, 'Ada — Dentist Appointment', d(4, 9, 0), d(4, 9, 45), {
    location: 'Bright Smiles Dental', category: 'appointment', provider: 'Dr. Yuen — Bright Smiles Dental',
  });
  assign(o1, ada, 'pending'); assign(o1, tomi, 'accepted');
  notify(okafors, chidi, 'event_assigned', 'FYI', 'Ada has a dentist appointment Friday — Chidi has not responded', o1);

  const o2 = insertEvent(okafors, tomi, "Ada's 7th Birthday", d(8, 12, 0), d(8, 15, 0), {
    description: 'Party at the park', location: 'Riverfront Park', category: 'appointment', provider: '',
  });
  assign(o2, tomi, 'accepted'); assign(o2, ada, 'accepted');

  // minimal budget/meal/chore data for the low-engagement family — tests sparse-data UI states
  const okGroceries  = insertBudgetCategory(okafors, 'Groceries',      500, '#10b981');
  const okTransport  = insertBudgetCategory(okafors, 'Transportation', 300, '#f97316');
  const okDining     = insertBudgetCategory(okafors, 'Dining Out',     150, '#ec4899');
  const okUtilities  = insertBudgetCategory(okafors, 'Utilities',      180, '#3b82f6');
  insertBudgetTx(okafors, okGroceries, 62.18, 'Grocery run',   `${thisMonth}-06`, tomi);
  insertBudgetTx(okafors, okUtilities, 98.00, 'Electric bill', `${thisMonth}-03`, tomi);
  insertMeal(okafors, ds(0), 'dinner', 'Jollof rice & chicken', '', tomi, tomi, 720);
  insertChore(okafors, 'Water the plants', '', ada, 'weekly', ds(2), 5, tomi, 'pending');

  insertUser; // no-op reference to silence unused lint in some editors

  logger.info('seed', `Seeded 2 families, 8 users, ${db.prepare('SELECT COUNT(*) c FROM events').get().c} events, ` +
    `${db.prepare('SELECT COUNT(*) c FROM budget_transactions').get().c} budget txs, ` +
    `${db.prepare('SELECT COUNT(*) c FROM meal_plan_entries').get().c} meals, ` +
    `${db.prepare('SELECT COUNT(*) c FROM chores').get().c} chores`);
  console.log('✅ Seed complete.');
  console.log('Families:', garcias, okafors);
}

run();

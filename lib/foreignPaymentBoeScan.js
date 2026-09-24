// RBI/FEMA requires a Bill of Entry to be filed within 3 months of an
// advance remittance going out - foreign_payment_requests.boe_due_date is
// that deadline (auto-computed on mark-payment-made, see
// routes/foreignPayments.js). This scans PaymentMade requests approaching
// or past that deadline and raises an in-app notification plus a
// high-priority To-Do for the Finance HOD to chase the missing BOE, the
// same "notify + assign a to-do" pattern lib/bgReminderScan.js uses for a
// BG's claim-filing deadline. Runs on the same 6-hourly timer as the BG/SOA
// scan (server.js) - idempotent throughout, so re-running it never creates
// duplicate notifications or to-dos.
const { db } = require('../db');

const WARNING_DAYS = 15; // days before boe_due_date to first raise this

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}
function today() { return daysFromNow(0); }

function notifyExists(sourceType, sourceId) {
  return !!db.prepare(`SELECT id FROM notifications WHERE source_type = ? AND source_id = ? AND is_read = 0`).get(sourceType, sourceId);
}

// Same "role + is_supervisor" convention used everywhere else in this app
// for "who is this department's head" (see lib/bgReminderScan.js).
function financeHOD() {
  return db.prepare(`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Accounts' AND u.is_supervisor = 1 AND u.is_active = 1
    ORDER BY u.id LIMIT 1
  `).get();
}

function createBoeDueTodo(fp) {
  const hod = financeHOD();
  if (!hod) return;
  const existing = db.prepare(`SELECT id FROM todos WHERE source_type = 'FP_BOE_DUE' AND source_id = ?`).get(fp.id);
  if (existing) return;
  const overdue = fp.boe_due_date < today();
  const brief = `${overdue ? 'Overdue: file' : 'File'} Bill of Entry - ${fp.request_no} (${fp.beneficiary_name})`;
  const info = db.prepare(`
    INSERT INTO todos (hod_id, assigned_to, start_date, target_date, brief_description, details, priority, source_type, source_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(hod.id, hod.id, today(), fp.boe_due_date, brief,
    `Bill of Entry due date: ${fp.boe_due_date}. Amount: ${fp.currency} ${fp.amount}.`, 'High', 'FP_BOE_DUE', fp.id);
  db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`)
    .run(hod.id, 'TODO_ASSIGNED', info.lastInsertRowid, `New To-Do assigned to you: ${brief}`);
}

function runFpBoeScan() {
  let created = 0;
  const warnBy = daysFromNow(WARNING_DAYS);
  const due = db.prepare(`
    SELECT * FROM foreign_payment_requests WHERE status = 'PaymentMade' AND boe_due_date IS NOT NULL AND boe_due_date <= ?
  `).all(warnBy);
  due.forEach(fp => {
    if (!notifyExists('FP_BOE_DUE', fp.id)) {
      const overdue = fp.boe_due_date < today();
      const label = overdue
        ? `Foreign Payment ${fp.request_no}: Bill of Entry was due ${fp.boe_due_date} and is overdue.`
        : `Foreign Payment ${fp.request_no}: Bill of Entry due ${fp.boe_due_date}.`;
      db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`).run(null, 'FP_BOE_DUE', fp.id, label);
      created++;
    }
    createBoeDueTodo(fp);
  });
  return created;
}

module.exports = { runFpBoeScan };

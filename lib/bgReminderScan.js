// Scans for two things and raises in-app notifications / reminder-log rows:
//  1. Open SO/PO deliveries approaching or past their promised delivery date.
//  2. Live Bank Guarantees approaching expiry, or whose linked project has
//     already completed (release should have been requested by then).
// Runs on a timer from server.js (no cron dependency needed for a 6-hourly
// sweep) and can also be triggered manually via POST /api/bg/scan.
// Idempotent throughout: every insert is guarded by a "does an open
// row already exist for this source" check, so re-running the scan never
// creates duplicate notifications or reminder-log entries.
const { db } = require('../db');
const { localDateStr, localDateTimeStr } = require('./dateUtil');
const { getSetting, setSetting, getEmailChannel, getWorkflowChannel } = require('./settings');
const { LIVE_BG_SQL } = require('./bgStatus');
const { soDispatchProgress } = require('./soItems');

const WARNING_DAYS = 7;   // PO/SO delivery-date warning window
const BG_WARNING_DAYS = 30; // BG expiry warning window
const CLAIM_WARNING_DAYS = 7; // BG claim_expiry warning window - the deadline to FILE a claim, distinct from the BG's own validity_expiry
const CLAIM_TODO_WINDOW_DAYS = 5; // Finance HOD's to-do target date = trigger date + this many days

function daysFromNow(n) {
  return localDateStr(new Date(Date.now() + n * 86400000));
}

function notifyExists(sourceType, sourceId) {
  return !!db.prepare(`SELECT id FROM notifications WHERE source_type = ? AND source_id = ? AND is_read = 0`).get(sourceType, sourceId);
}
function insertNotification(sourceType, sourceId, message, userId) {
  db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`).run(userId || null, sourceType, sourceId, message);
}
// Scoped by reason, not just bg_id - a BG can legitimately have two
// independent open reminders in flight at once (its own validity_expiry
// approaching AND, separately, its claim-filing deadline approaching), so
// one must not suppress the other.
function hasOpenReminder(bgId, reason) {
  return !!db.prepare(`SELECT id FROM bg_reminder_log WHERE bg_id = ? AND trigger_reason = ? AND status IN ('PendingReview', 'Verified')`).get(bgId, reason);
}

// The Finance/Accounts department's HOD - see routes/todos.js for the same
// "role + is_supervisor" convention used everywhere else in this app for
// "who is this department's head".
function financeHOD() {
  return db.prepare(`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Accounts' AND u.is_supervisor = 1 AND u.is_active = 1
    ORDER BY u.id LIMIT 1
  `).get();
}
// A high-priority To-Do for the Finance HOD to file the BG's claim before its
// deadline - skipped (not errored) if no Finance HOD is configured yet, and
// guarded by source_type/source_id so re-running the scan never duplicates it.
function createClaimExpiryTodo(bg) {
  const hod = financeHOD();
  if (!hod) return;
  const existing = db.prepare(`SELECT id FROM todos WHERE source_type = 'BG_CLAIM_EXPIRY' AND source_id = ?`).get(bg.id);
  if (existing) return;
  const brief = `File claim before deadline - BG ${bg.bg_no || '#' + bg.id} (${bg.beneficiary || 'beneficiary on file'})`;
  const info = db.prepare(`
    INSERT INTO todos (hod_id, assigned_to, start_date, target_date, brief_description, details, priority, source_type, source_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(hod.id, hod.id, daysFromNow(0), daysFromNow(CLAIM_TODO_WINDOW_DAYS), brief,
    `Claim filing deadline: ${bg.claim_expiry}. Value: Rs. ${bg.value}.`, 'High', 'BG_CLAIM_EXPIRY', bg.id);
  db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`)
    .run(hod.id, 'TODO_ASSIGNED', info.lastInsertRowid, `New To-Do assigned to you: ${brief}`);
}

function scanOrderDeliveries() {
  let created = 0;
  const warnBy = daysFromNow(WARNING_DAYS);

  const sos = db.prepare(`
    SELECT id, order_no, promised_delivery_date FROM sales_orders
    WHERE status NOT IN ('Completed', 'Cancelled', 'Dispatched') AND promised_delivery_date IS NOT NULL AND promised_delivery_date <= ?
  `).all(warnBy);
  sos.forEach(so => {
    // Same "is anything still left to ship" measure the Overdue Items page uses
    // (approved FG dispatches only) - a fully dispatched order has nothing due.
    const p = soDispatchProgress(so.id);
    if (p.anyDispatched && !p.pending.length) return;
    if (notifyExists('SO_DELIVERY_OVERDUE', so.id)) return;
    insertNotification('SO_DELIVERY_OVERDUE', so.id, `Sales Order ${so.order_no}: promised delivery ${so.promised_delivery_date} is due or overdue.`);
    created++;
  });

  const pos = db.prepare(`
    SELECT id, po_no, delivery_date FROM purchase_orders
    WHERE status NOT IN ('Received', 'Closed', 'Cancelled') AND delivery_date IS NOT NULL AND delivery_date <= ?
  `).all(warnBy);
  pos.forEach(po => {
    if (notifyExists('PO_DELIVERY_OVERDUE', po.id)) return;
    insertNotification('PO_DELIVERY_OVERDUE', po.id, `Purchase Order ${po.po_no}: promised delivery ${po.delivery_date} is due or overdue.`);
    created++;
  });
  return created;
}

function scanBankGuarantees() {
  let created = 0;
  const warnBy = daysFromNow(BG_WARNING_DAYS);
  const claimWarnDate = daysFromNow(CLAIM_WARNING_DAYS);

  const live = db.prepare(`SELECT * FROM bank_guarantees WHERE status = 'Active'`).all();
  live.forEach(bg => {
    let reason = null;
    if (bg.validity_expiry && bg.validity_expiry <= warnBy) {
      reason = 'ExpiryApproaching';
    } else if (bg.project_id) {
      const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(bg.project_id);
      if (project && project.status === 'Completed') reason = 'ProjectCompleted';
    }
    if (reason && !hasOpenReminder(bg.id, reason)) {
      db.prepare(`INSERT INTO bg_reminder_log (bg_id, trigger_reason) VALUES (?,?)`).run(bg.id, reason);
      if (!notifyExists('BG_EXPIRY', bg.id)) {
        const label = reason === 'ExpiryApproaching'
          ? `Bank Guarantee ${bg.bg_no || '#' + bg.id} expires ${bg.validity_expiry} - review for release/extension.`
          : `Bank Guarantee ${bg.bg_no || '#' + bg.id}: linked project completed - review for release.`;
        insertNotification('BG_EXPIRY', bg.id, label);
      }
      created++;
    }

    // Independent trigger: the claim-filing deadline (claim_expiry) hitting
    // exactly the warning window - distinct from the BG's own validity_expiry
    // above. Goes through the same internal verify-then-email reminder queue
    // (a human still checks before any customer-facing email goes out) and
    // additionally raises a high-priority To-Do for the Finance HOD.
    // The reminder-log guard and the to-do are deliberately independent: if
    // no Finance HOD was configured yet on the day this first fired, the
    // reminder-log guard alone would otherwise permanently block ever
    // retrying the to-do once one is - createClaimExpiryTodo() has its own
    // source_type/source_id idempotency check, so it's safe to attempt every
    // scan while the date match holds (in practice, one calendar day).
    if (bg.claim_expiry === claimWarnDate) {
      if (!hasOpenReminder(bg.id, 'ClaimExpiryApproaching')) {
        db.prepare(`INSERT INTO bg_reminder_log (bg_id, trigger_reason) VALUES (?, 'ClaimExpiryApproaching')`).run(bg.id);
        if (!notifyExists('BG_CLAIM_EXPIRY', bg.id)) {
          insertNotification('BG_CLAIM_EXPIRY', bg.id, `Bank Guarantee ${bg.bg_no || '#' + bg.id}: claim filing deadline ${bg.claim_expiry} is in ${CLAIM_WARNING_DAYS} days.`);
        }
        created++;
      }
      createClaimExpiryTodo(bg);
    }
  });
  return created;
}

// ---- Internal email to Finance for newly raised reminders ----
// Sent once per reminder (bg_reminder_log.notified_at is stamped only after a successful send), so a restart or the
// 6-hourly timer can never repeat it; a failed send or a missing recipient list simply retries on the next scan.
// Only reminders raised after this feature first ran are emailed (settings 'bg_scan_email_since'), so old backlog
// rows are not blasted out on upgrade. Recipients: the Accounts HOD plus every user holding bg.manage (role or extra grant).
let emailing = false;
function financeRecipients() {
  return db.prepare(`
    SELECT DISTINCT u.email FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.is_active = 1 AND u.email IS NOT NULL AND TRIM(u.email) != '' AND (
      (r.name = 'Accounts' AND u.is_supervisor = 1)
      OR EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = u.role_id AND p.code = 'bg.manage')
      OR EXISTS (SELECT 1 FROM extra_permission_access e WHERE e.permission_code = 'bg.manage'
                 AND ((e.scope = 'User' AND e.user_id = u.id) OR (e.scope = 'Department' AND e.department_id = u.department_id))))
  `).all().map(r => r.email.trim());
}
const REASON_TEXT = { ExpiryApproaching: 'validity expiring soon', ClaimExpiryApproaching: 'claim-filing deadline approaching', ProjectCompleted: 'linked project completed - review for release' };
async function emailNewReminders() {
  if (emailing) return { sent: false, skipped: 'already running' };
  emailing = true;
  try {
    const since = getSetting('bg_scan_email_since', null);
    const rows = db.prepare(`
      SELECT rl.id, rl.trigger_reason, bg.bg_no, bg.id AS bg_id, bg.bg_type, bg.value, bg.beneficiary, bg.validity_expiry, bg.claim_expiry
      FROM bg_reminder_log rl JOIN bank_guarantees bg ON bg.id = rl.bg_id
      WHERE rl.notified_at IS NULL AND rl.status = 'PendingReview' AND rl.triggered_at >= ? AND bg.status IN ${LIVE_BG_SQL}
      ORDER BY bg.validity_expiry
    `).all(since || '9999');
    if (!rows.length) return { sent: false, skipped: 'nothing new' };
    const to = financeRecipients();
    const chan = getEmailChannel(getWorkflowChannel('bg_reminders')) || {};
    if (!to.length && !(chan.extra_recipients || []).length) return { sent: false, skipped: 'no recipients with an email' };
    const lines = rows.map(r => `- ${r.bg_no || '#' + r.bg_id} (${r.bg_type}, ${r.beneficiary || 'beneficiary on file'}, Rs. ${r.value}): ${REASON_TEXT[r.trigger_reason] || r.trigger_reason}. Validity expiry ${r.validity_expiry}${r.claim_expiry ? ', claim expiry ' + r.claim_expiry : ''}.`);
    const { sendMail } = require('./mailer');
    const mail = await sendMail({
      to: to.join(', '), skipDefaultCc: true, workflow: 'bg_reminders',
      subject: `Bank Guarantee reminders - ${rows.length} item(s) need review`,
      text: `The following Bank Guarantee reminder(s) were raised and are waiting for review on the Bank Guarantee Dashboard (Pending Reminders):\n\n${lines.join('\n')}\n\nVenkateshwara Engineers ERP`,
    });
    if (!mail.sent) return { sent: false, reason: mail.reason };
    const stamp = localDateTimeStr();
    const mark = db.prepare('UPDATE bg_reminder_log SET notified_at = ? WHERE id = ?');
    rows.forEach(r => mark.run(stamp, r.id));
    return { sent: true, count: rows.length, to };
  } catch (e) {
    console.error('[bg-scan] reminder email failed:', e.message);
    return { sent: false, reason: e.message };
  } finally { emailing = false; }
}

function runScan() {
  if (!getSetting('bg_scan_email_since', null)) setSetting('bg_scan_email_since', localDateTimeStr());
  const deliveryAlerts = scanOrderDeliveries();
  const bgReminders = scanBankGuarantees();
  return { deliveryAlerts, bgReminders, ranAt: localDateTimeStr(), emailPromise: emailNewReminders() };
}

module.exports = { runScan, emailNewReminders };

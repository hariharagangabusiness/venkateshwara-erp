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

const WARNING_DAYS = 7;   // PO/SO delivery-date warning window
const BG_WARNING_DAYS = 30; // BG expiry warning window

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

function notifyExists(sourceType, sourceId) {
  return !!db.prepare(`SELECT id FROM notifications WHERE source_type = ? AND source_id = ? AND is_read = 0`).get(sourceType, sourceId);
}
function insertNotification(sourceType, sourceId, message) {
  db.prepare(`INSERT INTO notifications (source_type, source_id, message) VALUES (?,?,?)`).run(sourceType, sourceId, message);
}

function scanOrderDeliveries() {
  let created = 0;
  const warnBy = daysFromNow(WARNING_DAYS);

  const sos = db.prepare(`
    SELECT id, order_no, promised_delivery_date FROM sales_orders
    WHERE status NOT IN ('Completed', 'Cancelled') AND promised_delivery_date IS NOT NULL AND promised_delivery_date <= ?
  `).all(warnBy);
  sos.forEach(so => {
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

  const live = db.prepare(`SELECT * FROM bank_guarantees WHERE status = 'Active'`).all();
  live.forEach(bg => {
    let reason = null;
    if (bg.validity_expiry && bg.validity_expiry <= warnBy) {
      reason = 'ExpiryApproaching';
    } else if (bg.project_id) {
      const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(bg.project_id);
      if (project && project.status === 'Completed') reason = 'ProjectCompleted';
    }
    if (!reason) return;
    const existingOpen = db.prepare(`
      SELECT id FROM bg_reminder_log WHERE bg_id = ? AND status IN ('PendingReview', 'Verified')
    `).get(bg.id);
    if (existingOpen) return; // already has an open reminder in flight, don't duplicate
    db.prepare(`INSERT INTO bg_reminder_log (bg_id, trigger_reason) VALUES (?,?)`).run(bg.id, reason);
    if (!notifyExists('BG_EXPIRY', bg.id)) {
      const label = reason === 'ExpiryApproaching'
        ? `Bank Guarantee ${bg.bg_no || '#' + bg.id} expires ${bg.validity_expiry} - review for release/extension.`
        : `Bank Guarantee ${bg.bg_no || '#' + bg.id}: linked project completed - review for release.`;
      insertNotification('BG_EXPIRY', bg.id, label);
    }
    created++;
  });
  return created;
}

function runScan() {
  const deliveryAlerts = scanOrderDeliveries();
  const bgReminders = scanBankGuarantees();
  return { deliveryAlerts, bgReminders, ranAt: new Date().toISOString() };
}

module.exports = { runScan };

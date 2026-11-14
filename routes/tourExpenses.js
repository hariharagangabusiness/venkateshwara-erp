const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const { makeUpload } = require('../lib/upload');
const router = express.Router();
router.use(authRequired);

const uploadLeg = makeUpload('tour-expenses', 10);
const uploadLodging = makeUpload('tour-expenses', 10);
const uploadFood = makeUpload('tour-expenses', 10);
const uploadAllowance = makeUpload('tour-expenses', 10);

// Technician Tour Advance/Expense Ledger (2026-11-15) - see CLAUDE.md. A
// reviewer is Admin or anyone holding tour_expense.manage (Accounts by
// default, via bootstrapTourExpenseGrant() - freely revocable/extendable
// from the Role Permissions screen). A technician only ever acts on their
// own employee_id; Admin/a reviewer can look up anyone's.
function isReviewer(user) {
  return user.role_name === 'Admin' || hasPerm(user);
}
function hasPerm(user) {
  if (user.role_name === 'Admin') return true;
  const row = db.prepare(`
    SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ? AND p.code = 'tour_expense.manage'
  `).get(user.role_id);
  return !!row;
}
function requireReviewer(req, res, next) {
  if (isReviewer(req.user)) return next();
  return res.status(403).json({ error: 'Access denied: missing permission tour_expense.manage' });
}
// Resolves which employee_id a non-reviewer caller may act on (their own
// linked employee record only); a reviewer may pass any employee_id.
function resolveEmployeeId(req, requestedId) {
  if (isReviewer(req.user)) return requestedId ? Number(requestedId) : (req.user.employee_id || null);
  return req.user.employee_id || null;
}
const todayMonth = () => new Date().toISOString().slice(0, 7);

function legsTotal(legs) { return (legs || []).reduce((s, l) => s + (Number(l.amount) || 0), 0); }
function dayClaimed(day, legs) {
  return legsTotal(legs) + (day.lodging_claimed ? (Number(day.lodging_amount) || 0) : 0) + (day.food_claimed ? (Number(day.food_amount) || 0) : 0);
}

// ===================== Tour Advances =====================
router.get('/advances', (req, res) => {
  const employeeId = resolveEmployeeId(req, req.query.employee_id);
  if (!employeeId) return res.json([]);
  res.json(db.prepare(`
    SELECT a.*, u.full_name as issued_by_name FROM tour_advances a LEFT JOIN users u ON u.id = a.issued_by
    WHERE a.employee_id = ? ORDER BY a.issued_date DESC, a.id DESC
  `).all(employeeId));
});
router.post('/advances', requireReviewer, (req, res) => {
  const { employee_id, amount, issued_date, payment_mode, notes } = req.body;
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id);
  if (!emp) return res.status(400).json({ error: 'Select a real employee.' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be above 0.' });
  const info = db.prepare(`
    INSERT INTO tour_advances (employee_id, amount, issued_date, payment_mode, notes, issued_by)
    VALUES (?,?,?,?,?,?)
  `).run(employee_id, Number(amount), issued_date || new Date().toISOString().slice(0, 10), payment_mode || 'Cash', notes || null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

// ===================== Day entry (technician, self-service) =====================
router.get('/days', (req, res) => {
  const employeeId = resolveEmployeeId(req, req.query.employee_id);
  if (!employeeId) return res.json([]);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayMonth();
  const days = db.prepare(`
    SELECT * FROM tour_expense_days WHERE employee_id = ? AND entry_date LIKE ? ORDER BY entry_date
  `).all(employeeId, month + '%');
  const legStmt = db.prepare('SELECT * FROM tour_expense_legs WHERE day_id = ? ORDER BY sort_order, id');
  res.json(days.map(d => ({ ...d, legs: legStmt.all(d.id) })));
});

// Upsert one day's core data (legs replaced wholesale, mirroring how every
// other multi-line replace in this app works) - no file upload here;
// receipts attach via their own dedicated routes below once the day/legs
// exist with real ids. Blocked once the owning month is no longer Draft.
router.post('/days', (req, res) => {
  const employeeId = resolveEmployeeId(req, req.body.employee_id);
  if (!employeeId) return res.status(400).json({ error: 'No employee record linked to your login.' });
  const { entry_date, legs, food, lodging } = req.body;
  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(entry_date)) return res.status(400).json({ error: 'entry_date (YYYY-MM-DD) is required.' });
  const month = entry_date.slice(0, 7);
  const monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(employeeId, month);
  if (monthRow && monthRow.status !== 'Draft') return res.status(400).json({ error: `${month} has already been submitted for review and can no longer be edited.` });
  const legLines = Array.isArray(legs) ? legs.filter(l => l && l.mode_of_transport) : [];
  if (!legLines.length) return res.status(400).json({ error: 'At least one travel leg is required for a logged day.' });
  for (const l of legLines) {
    if (!Number(l.amount) || Number(l.amount) <= 0) return res.status(400).json({ error: 'Every leg needs an amount above 0.' });
  }
  const foodClaimed = !!(food && food.claimed);
  const lodgingClaimed = !!(lodging && lodging.claimed);
  const existing = db.prepare('SELECT * FROM tour_expense_days WHERE employee_id = ? AND entry_date = ?').get(employeeId, entry_date);
  if (existing && existing.status !== 'Open') return res.status(400).json({ error: 'This day has already moved into review and can no longer be edited.' });

  const tx = db.transaction(() => {
    const claimed = dayClaimed({ lodging_claimed: lodgingClaimed, lodging_amount: lodging && lodging.amount, food_claimed: foodClaimed, food_amount: food && food.amount }, legLines);
    let dayId;
    if (existing) {
      dayId = existing.id;
      db.prepare(`
        UPDATE tour_expense_days SET food_claimed=?, food_amount=?, lodging_claimed=?, lodging_name=?, lodging_amount=?, claimed_amount=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(foodClaimed ? 1 : 0, foodClaimed ? (Number(food.amount) || 0) : 0, lodgingClaimed ? 1 : 0, lodgingClaimed ? (lodging.name || null) : null, lodgingClaimed ? (Number(lodging.amount) || 0) : 0, claimed, dayId);
      db.prepare('DELETE FROM tour_expense_legs WHERE day_id = ?').run(dayId);
    } else {
      dayId = db.prepare(`
        INSERT INTO tour_expense_days (employee_id, entry_date, food_claimed, food_amount, lodging_claimed, lodging_name, lodging_amount, claimed_amount)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(employeeId, entry_date, foodClaimed ? 1 : 0, foodClaimed ? (Number(food.amount) || 0) : 0, lodgingClaimed ? 1 : 0, lodgingClaimed ? (lodging.name || null) : null, lodgingClaimed ? (Number(lodging.amount) || 0) : 0, claimed).lastInsertRowid;
    }
    legLines.forEach((l, i) => {
      db.prepare(`
        INSERT INTO tour_expense_legs (day_id, mode_of_transport, from_location, to_location, amount, sort_order)
        VALUES (?,?,?,?,?,?)
      `).run(dayId, l.mode_of_transport, l.from_location || null, l.to_location || null, Number(l.amount) || 0, i);
    });
    if (!monthRow) {
      db.prepare(`INSERT INTO tour_expense_months (employee_id, month) VALUES (?,?)`).run(employeeId, month);
    }
    return dayId;
  });
  const dayId = tx();
  const day = db.prepare('SELECT * FROM tour_expense_days WHERE id = ?').get(dayId);
  const dayLegs = db.prepare('SELECT * FROM tour_expense_legs WHERE day_id = ? ORDER BY sort_order, id').all(dayId);
  res.json({ ...day, legs: dayLegs });
});

router.delete('/days/:id', (req, res) => {
  const day = db.prepare('SELECT * FROM tour_expense_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'Not found' });
  const employeeId = resolveEmployeeId(req, day.employee_id);
  if (employeeId !== day.employee_id) return res.status(403).json({ error: 'Not your record.' });
  if (day.status !== 'Open') return res.status(400).json({ error: 'This day has already moved into review and can no longer be deleted.' });
  db.prepare('DELETE FROM tour_expense_legs WHERE day_id = ?').run(day.id);
  db.prepare('DELETE FROM tour_expense_days WHERE id = ?').run(day.id);
  res.json({ ok: true });
});

function dayOwnedBySelf(req, day) { return req.user.employee_id && req.user.employee_id === day.employee_id; }
router.post('/legs/:legId/receipt', uploadLeg.single('file'), (req, res) => {
  const leg = db.prepare('SELECT l.*, d.employee_id, d.status FROM tour_expense_legs l JOIN tour_expense_days d ON d.id = l.day_id WHERE l.id = ?').get(req.params.legId);
  if (!leg) return res.status(404).json({ error: 'Not found' });
  if (!dayOwnedBySelf(req, leg) && req.user.role_name !== 'Admin') return res.status(403).json({ error: 'Not your record.' });
  if (leg.status !== 'Open') return res.status(400).json({ error: 'This day has already moved into review.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  db.prepare('UPDATE tour_expense_legs SET attachment_path = ? WHERE id = ?').run('/uploads/tour-expenses/' + req.file.filename, leg.id);
  res.json({ attachment_path: '/uploads/tour-expenses/' + req.file.filename });
});
router.post('/days/:id/lodging-receipt', uploadLodging.single('file'), (req, res) => {
  const day = db.prepare('SELECT * FROM tour_expense_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'Not found' });
  if (!dayOwnedBySelf(req, day) && req.user.role_name !== 'Admin') return res.status(403).json({ error: 'Not your record.' });
  if (day.status !== 'Open') return res.status(400).json({ error: 'This day has already moved into review.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  db.prepare('UPDATE tour_expense_days SET lodging_attachment_path = ? WHERE id = ?').run('/uploads/tour-expenses/' + req.file.filename, day.id);
  res.json({ attachment_path: '/uploads/tour-expenses/' + req.file.filename });
});
router.post('/days/:id/food-receipt', uploadFood.single('file'), (req, res) => {
  const day = db.prepare('SELECT * FROM tour_expense_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'Not found' });
  if (!dayOwnedBySelf(req, day) && req.user.role_name !== 'Admin') return res.status(403).json({ error: 'Not your record.' });
  if (day.status !== 'Open') return res.status(400).json({ error: 'This day has already moved into review.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  db.prepare('UPDATE tour_expense_days SET food_attachment_path = ? WHERE id = ?').run('/uploads/tour-expenses/' + req.file.filename, day.id);
  res.json({ attachment_path: '/uploads/tour-expenses/' + req.file.filename });
});

// ===================== Month lifecycle =====================
router.get('/months', (req, res) => {
  const employeeId = resolveEmployeeId(req, req.query.employee_id);
  if (!employeeId) return res.json([]);
  res.json(db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? ORDER BY month DESC').all(employeeId));
});
router.post('/months/submit', (req, res) => {
  const employeeId = resolveEmployeeId(req, req.body.employee_id);
  if (!employeeId) return res.status(400).json({ error: 'No employee record linked to your login.' });
  const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : todayMonth();
  const monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(employeeId, month);
  if (!monthRow) return res.status(400).json({ error: 'No days logged for that month yet.' });
  if (monthRow.status !== 'Draft') return res.status(400).json({ error: `${month} has already been submitted.` });
  const dayCount = db.prepare(`SELECT COUNT(*) as n FROM tour_expense_days WHERE employee_id = ? AND entry_date LIKE ?`).get(employeeId, month + '%').n;
  if (!dayCount) return res.status(400).json({ error: 'No days logged for that month yet.' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE tour_expense_days SET status = 'PendingReview' WHERE employee_id = ? AND entry_date LIKE ? AND status = 'Open'`).run(employeeId, month + '%');
    db.prepare(`UPDATE tour_expense_months SET status = 'Submitted', submitted_at = CURRENT_TIMESTAMP, submitted_by = ? WHERE id = ?`).run(req.user.id, monthRow.id);
  });
  tx();
  res.json({ ok: true });
});

// ===================== Reviewer: per-day decision =====================
router.post('/days/:id/decide', requireReviewer, (req, res) => {
  const day = db.prepare('SELECT * FROM tour_expense_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'Not found' });
  if (day.status !== 'PendingReview') return res.status(400).json({ error: 'This day is not awaiting review.' });
  const { action, approved_amount, reason } = req.body;
  let status, amount;
  if (action === 'Approve') { status = 'Approved'; amount = day.claimed_amount; }
  else if (action === 'Reject') { status = 'Rejected'; amount = 0; if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to reject a day.' }); }
  else if (action === 'Adjust') {
    status = 'Adjusted'; amount = Number(approved_amount);
    if (!(amount >= 0)) return res.status(400).json({ error: 'Enter a valid approved amount.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to adjust a day.' });
  } else return res.status(400).json({ error: 'action must be Approve, Reject, or Adjust.' });
  db.prepare(`
    UPDATE tour_expense_days SET status=?, approved_amount=?, review_reason=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(status, amount, reason || null, req.user.id, day.id);
  res.json({ ok: true });
});

// ===================== Monthly lump-sum allowance =====================
router.post('/months/allowance', (req, res) => {
  const employeeId = resolveEmployeeId(req, req.body.employee_id);
  if (!employeeId) return res.status(400).json({ error: 'No employee record linked to your login.' });
  const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : todayMonth();
  const { label, amount } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be above 0.' });
  let monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(employeeId, month);
  if (monthRow && monthRow.allowance_status !== 'Pending' && monthRow.allowance_amount != null) {
    return res.status(400).json({ error: 'This month\'s allowance claim has already been reviewed.' });
  }
  if (!monthRow) {
    db.prepare(`INSERT INTO tour_expense_months (employee_id, month, allowance_label, allowance_amount) VALUES (?,?,?,?)`)
      .run(employeeId, month, label || null, Number(amount));
    monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(employeeId, month);
  } else {
    db.prepare(`UPDATE tour_expense_months SET allowance_label=?, allowance_amount=?, allowance_status='Pending' WHERE id=?`)
      .run(label || null, Number(amount), monthRow.id);
  }
  res.json({ id: monthRow.id });
});
router.post('/months/allowance/receipt', uploadAllowance.single('file'), (req, res) => {
  const employeeId = resolveEmployeeId(req, req.body.employee_id);
  const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : todayMonth();
  const monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(employeeId, month);
  if (!monthRow) return res.status(404).json({ error: 'Claim the monthly allowance amount first.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  db.prepare('UPDATE tour_expense_months SET allowance_attachment_path = ? WHERE id = ?').run('/uploads/tour-expenses/' + req.file.filename, monthRow.id);
  res.json({ attachment_path: '/uploads/tour-expenses/' + req.file.filename });
});
router.post('/months/:employeeId/:month/allowance/decide', requireReviewer, (req, res) => {
  const monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(req.params.employeeId, req.params.month);
  if (!monthRow || monthRow.allowance_amount == null) return res.status(404).json({ error: 'No allowance claim on file.' });
  if (monthRow.allowance_status !== 'Pending') return res.status(400).json({ error: 'Already reviewed.' });
  const { action, approved_amount, reason } = req.body;
  let status, amount;
  if (action === 'Approve') { status = 'Approved'; amount = monthRow.allowance_amount; }
  else if (action === 'Reject') { status = 'Rejected'; amount = 0; if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to reject.' }); }
  else if (action === 'Adjust') {
    status = 'Adjusted'; amount = Number(approved_amount);
    if (!(amount >= 0)) return res.status(400).json({ error: 'Enter a valid approved amount.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to adjust.' });
  } else return res.status(400).json({ error: 'action must be Approve, Reject, or Adjust.' });
  db.prepare(`UPDATE tour_expense_months SET allowance_status=?, allowance_approved_amount=?, allowance_reason=? WHERE id=?`)
    .run(status, amount, reason || null, monthRow.id);
  res.json({ ok: true });
});

// ===================== Service Report Up/Down & Food =====================
router.post('/service-reports/:id/updown-decide', requireReviewer, (req, res) => {
  const report = db.prepare('SELECT * FROM service_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  if (report.updown_food_status !== 'Pending') return res.status(400).json({ error: 'Already reviewed.' });
  const { action, approved_amount, reason } = req.body;
  let status, amount;
  if (action === 'Approve') { status = 'Approved'; amount = report.amount_updown_food || 0; }
  else if (action === 'Reject') { status = 'Rejected'; amount = 0; if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to reject.' }); }
  else if (action === 'Adjust') {
    status = 'Adjusted'; amount = Number(approved_amount);
    if (!(amount >= 0)) return res.status(400).json({ error: 'Enter a valid approved amount.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to adjust.' });
  } else return res.status(400).json({ error: 'action must be Approve, Reject, or Adjust.' });
  db.prepare(`
    UPDATE service_reports SET updown_food_status=?, updown_food_approved_amount=?, updown_food_reason=?, updown_food_reviewed_by=?, updown_food_reviewed_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(status, amount, reason || null, req.user.id, report.id);
  res.json({ ok: true });
});

// ===================== Review bundle (the whole month, one call) =====================
router.get('/review-bundle', requireReviewer, (req, res) => {
  const employeeId = Number(req.query.employee_id);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayMonth();
  if (!employeeId) return res.status(400).json({ error: 'employee_id is required.' });
  const days = db.prepare(`SELECT * FROM tour_expense_days WHERE employee_id = ? AND entry_date LIKE ? ORDER BY entry_date`).all(employeeId, month + '%');
  const legStmt = db.prepare('SELECT * FROM tour_expense_legs WHERE day_id = ? ORDER BY sort_order, id');
  const daysWithLegs = days.map(d => ({ ...d, legs: legStmt.all(d.id) }));
  const monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(employeeId, month);
  const serviceReports = db.prepare(`
    SELECT sr.id, sr.sl_no, sr.activity_date, sr.amount_updown_food, sr.updown_food_status, sr.updown_food_approved_amount, sr.updown_food_reason,
      req.sr_no, req.client_id, c.name as client_name, sr.customer_name
    FROM service_reports sr
    LEFT JOIN service_requests req ON req.id = sr.service_request_id
    LEFT JOIN clients c ON c.id = req.client_id
    WHERE sr.employee_id = ? AND sr.activity_date LIKE ? AND sr.amount_updown_food > 0
    ORDER BY sr.activity_date
  `).all(employeeId, month + '%');
  const collectedRow = db.prepare(`
    SELECT COALESCE(SUM(amount_travel + amount_service + amount_spares), 0) as n
    FROM service_reports WHERE employee_id = ? AND activity_date LIKE ? AND status IN ('Approved','SubmittedToAccounts')
  `).get(employeeId, month + '%');
  const advanceRow = db.prepare(`SELECT COALESCE(SUM(amount), 0) as n FROM tour_advances WHERE employee_id = ?`).get(employeeId);
  const approvedDaySum = daysWithLegs.reduce((s, d) => s + (d.approved_amount != null ? d.approved_amount : 0), 0);
  const allowanceApproved = (monthRow && monthRow.allowance_approved_amount != null) ? monthRow.allowance_approved_amount : 0;
  const svcApproved = serviceReports.reduce((s, r) => s + (r.updown_food_approved_amount != null ? r.updown_food_approved_amount : 0), 0);
  const claimedTotal = daysWithLegs.reduce((s, d) => s + d.claimed_amount, 0) + (monthRow && monthRow.allowance_amount ? monthRow.allowance_amount : 0) + serviceReports.reduce((s, r) => s + (r.amount_updown_food || 0), 0);
  const approvedTotal = approvedDaySum + allowanceApproved + svcApproved;
  res.json({
    month, days: daysWithLegs, monthRow, serviceReports,
    employee: db.prepare('SELECT id, full_name FROM employees WHERE id = ?').get(employeeId),
    totals: {
      advance: advanceRow.n, claimed: claimedTotal, approved: approvedTotal, balance: advanceRow.n - approvedTotal,
      collected: collectedRow.n, approvedExpenses: approvedTotal, net: collectedRow.n - approvedTotal,
    },
  });
});

router.post('/months/:employeeId/:month/finalize', requireReviewer, (req, res) => {
  const employeeId = Number(req.params.employeeId), month = req.params.month;
  const monthRow = db.prepare('SELECT * FROM tour_expense_months WHERE employee_id = ? AND month = ?').get(employeeId, month);
  if (!monthRow) return res.status(404).json({ error: 'Not found' });
  if (monthRow.status === 'Closed') return res.status(400).json({ error: 'Already finalized.' });
  const pending = db.prepare(`SELECT COUNT(*) as n FROM tour_expense_days WHERE employee_id = ? AND entry_date LIKE ? AND status = 'PendingReview'`).get(employeeId, month + '%').n;
  if (pending > 0) return res.status(400).json({ error: `${pending} day(s) still need a decision before this month can be finalized.` });
  if (monthRow.allowance_amount != null && monthRow.allowance_status === 'Pending') return res.status(400).json({ error: 'The monthly allowance claim still needs a decision.' });
  db.prepare(`UPDATE tour_expense_months SET status='Closed', closed_at=CURRENT_TIMESTAMP, closed_by=? WHERE id=?`).run(req.user.id, monthRow.id);
  res.json({ ok: true });
});

module.exports = router;

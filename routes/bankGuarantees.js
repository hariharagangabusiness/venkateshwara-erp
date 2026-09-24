const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission, requireRole } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');
const router = express.Router();
router.use(authRequired);

// Read access: bg.manage (Accounts) or report.view_all (Management/PM etc,
// same OR-list pattern used across the app for view-only roles).
const canView = requirePermission('bg.manage', 'report.view_all');
const canManage = requirePermission('bg.manage');

// ---- Orders picker (for the BG/milestone creation forms) ----
// Combined SO + PO list so one dropdown can point a BG or milestone at
// either kind of order, matching the order_type/order_id polymorphism used
// by bank_guarantees and payment_milestones.
router.get('/orders', canView, (req, res) => {
  const sos = db.prepare(`
    SELECT so.id, so.order_no, c.name as party_name, so.status
    FROM sales_orders so JOIN clients c ON c.id = so.client_id
    ORDER BY so.id DESC
  `).all().map(r => ({ order_type: 'SO', order_id: r.id, label: `${r.order_no} — ${r.party_name}`, status: r.status }));
  const pos = db.prepare(`
    SELECT po.id, po.po_no, v.name as party_name, po.status
    FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
    ORDER BY po.id DESC
  `).all().map(r => ({ order_type: 'PO', order_id: r.id, label: `${r.po_no} — ${r.party_name}`, status: r.status }));
  res.json([...sos, ...pos]);
});

// Resolve an order_type/order_id to its linked project_id (best-effort) and
// contact email, so BG creation can auto-fill beneficiary/contact instead of
// asking for them twice.
function resolveOrderContext(orderType, orderId) {
  // LEGACY BGs (migrated historical/manual records - see routes/dataImport.js)
  // have no real Sales/Purchase Order to resolve; their beneficiary/project_id
  // were captured directly on the row at import time instead.
  if (orderType === 'LEGACY') return null;
  if (orderType === 'SO') {
    const so = db.prepare(`
      SELECT so.*, c.name as party_name, c.email as party_email
      FROM sales_orders so JOIN clients c ON c.id = so.client_id WHERE so.id = ?
    `).get(orderId);
    if (!so) return null;
    const project = db.prepare('SELECT id FROM projects WHERE sales_order_id = ?').get(orderId);
    return { partyName: so.party_name, partyEmail: so.party_email, projectId: project ? project.id : null, orderValue: so.order_value };
  }
  const po = db.prepare(`
    SELECT po.*, v.name as party_name, v.email as party_email, v.po_email
    FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE po.id = ?
  `).get(orderId);
  if (!po) return null;
  let projectId = null;
  if (po.purchase_request_id) {
    const pr = db.prepare('SELECT project_id FROM purchase_requests WHERE id = ?').get(po.purchase_request_id);
    projectId = pr ? pr.project_id : null;
  }
  return { partyName: po.party_name, partyEmail: po.po_email || po.party_email, projectId, orderValue: po.total_value };
}
router.get('/orders/:type/:id/context', canView, (req, res) => {
  const ctx = resolveOrderContext(req.params.type, req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Not found' });
  res.json(ctx);
});

// ---- Bank Guarantee Master ----
// A BG's relevant lifetime runs from issuance to release, often spanning
// years, so there's no "current month" to scope this list by the way
// Operating Expenses/Expense Vouchers can. Instead, once a BG is Released
// it's closed history rather than something Accounts needs to see day to
// day, so a plain call (no explicit status filter, and not ?all=1) returns
// only the live ones (Active/PendingRelease) - matching the dashboard's own
// "Live Bank Guarantees" framing. ?all=1 is the explicit opt-out to include
// Released BGs too.
router.get('/', canView, (req, res) => {
  const { bg_type, status, all } = req.query;
  let q = `SELECT bg.*, p.project_code, p.title as project_title FROM bank_guarantees bg LEFT JOIN projects p ON p.id = bg.project_id WHERE 1=1`;
  const params = [];
  if (bg_type) { q += ' AND bg.bg_type = ?'; params.push(bg_type); }
  if (status) { q += ' AND bg.status = ?'; params.push(status); }
  else if (all !== '1') { q += ` AND bg.status IN ('Active','PendingRelease')`; }
  q += ' ORDER BY bg.validity_expiry ASC';
  const rows = db.prepare(q).all(...params);
  // Attach a human label for the linked order (SO/PO no + party) without a
  // UNION join - order_type/order_id is polymorphic so this is simplest as
  // a per-row lookup against the small orders list.
  rows.forEach(r => {
    const ctx = resolveOrderContext(r.order_type, r.order_id);
    r.order_label = ctx ? ctx.partyName : (r.order_type === 'LEGACY' ? (r.legacy_ref || r.beneficiary || 'Legacy / manual record') : null);
  });
  res.json(rows);
});

router.get('/summary', canView, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const totals = db.prepare(`SELECT COUNT(*) as live_count, COALESCE(SUM(value),0) as live_value FROM bank_guarantees WHERE status IN ('Active','PendingRelease')`).get();
  const expiring = db.prepare(`SELECT COUNT(*) as c FROM bank_guarantees WHERE status IN ('Active','PendingRelease') AND validity_expiry <= ? AND validity_expiry >= ?`).get(in30, today);
  const pendingReminders = db.prepare(`SELECT COUNT(*) as c FROM bg_reminder_log WHERE status = 'PendingReview'`).get();
  // MGMT dashboard additions - claim-expiry compliance (see lib/bgReminderScan.js).
  const claimAlerts = db.prepare(`SELECT COUNT(*) as c FROM bg_reminder_log WHERE trigger_reason = 'ClaimExpiryApproaching' AND status IN ('PendingReview','Verified')`).get();
  const financeTodos = db.prepare(`
    SELECT t.id, t.brief_description, t.target_date, t.status, u.full_name as assigned_to_name
    FROM todos t LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.source_type = 'BG_CLAIM_EXPIRY' AND t.status != 'Completed'
    ORDER BY t.target_date ASC
  `).all();
  const compliance = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN status = 'Completed' AND completed_at IS NOT NULL AND date(completed_at) <= target_date THEN 1 ELSE 0 END) as on_time
    FROM todos WHERE source_type = 'BG_CLAIM_EXPIRY'
  `).get();
  const complianceRate = compliance.total ? Math.round((compliance.on_time / compliance.total) * 100) : null;
  res.json({
    live_count: totals.live_count, live_value: totals.live_value, expiring_30d: expiring.c, pending_reminders: pendingReminders.c,
    claim_expiry_alerts: claimAlerts.c, finance_todos: financeTodos, claim_compliance_rate: complianceRate,
  });
});

router.post('/', canManage, (req, res) => {
  const { bg_no, bg_type, order_type, order_id, issuing_bank, value, issue_date, validity_expiry, claim_expiry, milestone_link } = req.body;
  if (!bg_type || !['Advance', 'Performance'].includes(bg_type)) return res.status(400).json({ error: 'bg_type must be Advance or Performance' });
  if (!order_type || !['SO', 'PO'].includes(order_type)) return res.status(400).json({ error: 'order_type must be SO or PO' });
  if (!order_id) return res.status(400).json({ error: 'order_id is required' });
  if (!validity_expiry) return res.status(400).json({ error: 'validity_expiry is required' });
  const ctx = resolveOrderContext(order_type, order_id);
  if (!ctx) return res.status(400).json({ error: 'That order no longer exists.' });
  const info = db.prepare(`
    INSERT INTO bank_guarantees (bg_no, bg_type, order_type, order_id, project_id, issuing_bank, beneficiary, value, issue_date, validity_expiry, claim_expiry, milestone_link, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(bg_no || null, bg_type, order_type, order_id, ctx.projectId, issuing_bank || null, ctx.partyName, Number(value) || 0, issue_date || null, validity_expiry, claim_expiry || null, milestone_link || null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

// Status-lifecycle transitions only (currently just "Mark Released" from
// the BG Dashboard) - NOT a general field editor. Editing the BG's own
// details (bg_no/issuing_bank/value/dates/milestone_link) goes exclusively
// through PUT /:id below, which is approval-gated; this route used to also
// accept those same fields with no such gate, which would have let anyone
// with bg.manage bypass that gate entirely by calling PATCH instead of PUT.
router.patch('/:id', canManage, (req, res) => {
  const bg = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(req.params.id);
  if (!bg) return res.status(404).json({ error: 'Not found' });
  const { status } = req.body;
  if (status === undefined) return res.json({ ok: true });
  if (status === 'Released') {
    db.prepare(`UPDATE bank_guarantees SET status = ?, released_at = ?, released_by = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), req.user.id, req.params.id);
  } else {
    db.prepare(`UPDATE bank_guarantees SET status = ? WHERE id = ?`).run(status, req.params.id);
  }
  res.json({ ok: true });
});

// ---- Edit / Delete, with an approval-gated access-control restriction ----
// A bg.manage holder (Accounts) can always REQUEST an edit or delete, but
// only an Admin's own request applies immediately - anyone else's is
// queued in bg_pending_changes and only takes effect once an Admin reviews
// it, so the live record (and its role in the claim/reminder compliance
// workflow) can't change out from under an in-flight reminder or email.
// Same convention as Item Master's edit/delete gate (routes/masters.js).
const BG_EDIT_FIELDS = ['bg_no', 'issuing_bank', 'value', 'issue_date', 'validity_expiry', 'claim_expiry', 'milestone_link'];

// A BG that already has real activity against it - a reminder ever raised,
// a notification, a Finance claim-filing to-do, or a scanned document -
// can't be deleted outright. Unlike vendor/item delete, there's no
// "Discontinued"-style soft fallback state for a BG, so this blocks the
// delete entirely rather than downgrading it, on the same "protect the
// audit trail" reasoning.
function bgHasActivity(bgId) {
  const counts = [
    db.prepare(`SELECT COUNT(*) as n FROM bg_reminder_log WHERE bg_id = ?`).get(bgId).n,
    db.prepare(`SELECT COUNT(*) as n FROM notifications WHERE source_type IN ('BG_EXPIRY','BG_CLAIM_EXPIRY') AND source_id = ?`).get(bgId).n,
    db.prepare(`SELECT COUNT(*) as n FROM todos WHERE source_type = 'BG_CLAIM_EXPIRY' AND source_id = ?`).get(bgId).n,
    db.prepare(`SELECT COUNT(*) as n FROM attachments WHERE entity_type = 'bank_guarantee' AND entity_id = ?`).get(bgId).n,
  ];
  return counts.some(n => n > 0);
}
function applyBGEdit(bgId, fields) {
  const existing = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(bgId);
  const sets = BG_EDIT_FIELDS.map(c => `${c}=?`).join(',');
  const values = BG_EDIT_FIELDS.map(c => (fields[c] !== undefined ? fields[c] : existing[c]));
  db.prepare(`UPDATE bank_guarantees SET ${sets} WHERE id=?`).run(...values, bgId);
}
function canDeleteBG(bg) {
  return bg.status === 'Active' && !bgHasActivity(bg.id);
}
// bg_pending_changes.bg_id is a hard FK (no ON DELETE CASCADE), so any row
// referencing this BG - including past Approved/Rejected requests kept
// only as history - would otherwise block the delete outright. Once the
// BG itself is actually gone there's nothing left for those rows to be
// history of, so they're cleared in the same transaction.
function deleteBGCompletely(bgId) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bg_pending_changes WHERE bg_id = ?').run(bgId);
    db.prepare('DELETE FROM bank_guarantees WHERE id = ?').run(bgId);
  });
  tx();
}

router.put('/:id', canManage, (req, res) => {
  const existing = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status === 'Released') return res.status(400).json({ error: 'This Bank Guarantee has been released and is closed - it can no longer be edited.' });
  const fields = {};
  BG_EDIT_FIELDS.forEach(c => { if (req.body[c] !== undefined) fields[c] = req.body[c] || null; });
  if ('validity_expiry' in fields && !fields.validity_expiry) return res.status(400).json({ error: 'validity_expiry is required' });
  if ('value' in fields) fields.value = Number(fields.value) || 0;
  if (req.user.role_name === 'Admin') {
    applyBGEdit(existing.id, fields);
    return res.json({ ok: true, applied: true });
  }
  db.prepare(`INSERT INTO bg_pending_changes (bg_id, change_type, proposed_fields, requested_by) VALUES (?,'Edit',?,?)`)
    .run(existing.id, JSON.stringify(fields), req.user.id);
  res.json({ ok: true, applied: false, message: 'Change submitted for approval - the Bank Guarantee stays as-is until an Admin reviews it.' });
});

router.delete('/:id', canManage, (req, res) => {
  const existing = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canDeleteBG(existing)) {
    return res.status(400).json({ error: 'This Bank Guarantee has activity on file (a reminder, notification, to-do, or scanned document) or is past its initial Active status, so it can no longer be deleted - it can still be edited or marked Released.' });
  }
  if (req.user.role_name === 'Admin') {
    deleteBGCompletely(existing.id);
    return res.json({ ok: true, applied: true, deleted: true });
  }
  db.prepare(`INSERT INTO bg_pending_changes (bg_id, change_type, requested_by) VALUES (?,'Delete',?)`).run(existing.id, req.user.id);
  res.json({ ok: true, applied: false, message: 'Delete request submitted for approval.' });
});

router.get('/pending-changes', canManage, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, bg.bg_no, bg.bg_type, bg.value, u.full_name as requested_by_name
    FROM bg_pending_changes c JOIN bank_guarantees bg ON bg.id = c.bg_id LEFT JOIN users u ON u.id = c.requested_by
    WHERE c.status = 'Pending' ORDER BY c.id DESC
  `).all());
});
router.post('/pending-changes/:id/approve', requireRole('Admin'), (req, res) => {
  const change = db.prepare('SELECT * FROM bg_pending_changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  if (change.status !== 'Pending') return res.status(400).json({ error: 'Already reviewed.' });
  if (change.change_type === 'Delete') {
    const bg = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(change.bg_id);
    if (!bg) return res.status(400).json({ error: 'This Bank Guarantee no longer exists.' });
    if (!canDeleteBG(bg)) {
      return res.status(400).json({ error: 'This Bank Guarantee now has activity on file and can no longer be deleted - reject this request instead.' });
    }
    // deleteBGCompletely() also removes this very change_type='Delete' row
    // (bg_pending_changes.bg_id is a hard FK) - there's nothing left to
    // mark Approved afterward, so return here instead of falling through
    // to the shared "mark Approved" update below.
    deleteBGCompletely(change.bg_id);
    return res.json({ ok: true });
  }
  const bg = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(change.bg_id);
  if (!bg) return res.status(400).json({ error: 'This Bank Guarantee no longer exists.' });
  if (bg.status === 'Released') return res.status(400).json({ error: 'This Bank Guarantee has since been released and is closed - reject this request instead.' });
  applyBGEdit(change.bg_id, JSON.parse(change.proposed_fields || '{}'));
  db.prepare(`UPDATE bg_pending_changes SET status='Approved', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, change.id);
  res.json({ ok: true });
});
router.post('/pending-changes/:id/reject', requireRole('Admin'), (req, res) => {
  const change = db.prepare('SELECT * FROM bg_pending_changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  if (change.status !== 'Pending') return res.status(400).json({ error: 'Already reviewed.' });
  db.prepare(`UPDATE bg_pending_changes SET status='Rejected', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, review_note=? WHERE id=?`)
    .run(req.user.id, (req.body && req.body.review_note) || null, change.id);
  res.json({ ok: true });
});

// ---- Payment Milestones ----
router.get('/milestones', canView, (req, res) => {
  const { order_type, order_id } = req.query;
  if (!order_type || !order_id) return res.status(400).json({ error: 'order_type and order_id are required' });
  res.json(db.prepare('SELECT * FROM payment_milestones WHERE order_type = ? AND order_id = ? ORDER BY id').all(order_type, order_id));
});
router.post('/milestones', canManage, (req, res) => {
  const { order_type, order_id, milestone_name, due_type, due_date, linked_event, percentage, amount } = req.body;
  if (!order_type || !order_id) return res.status(400).json({ error: 'order_type and order_id are required' });
  if (!milestone_name) return res.status(400).json({ error: 'milestone_name is required' });
  const info = db.prepare(`
    INSERT INTO payment_milestones (order_type, order_id, milestone_name, due_type, due_date, linked_event, percentage, amount, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(order_type, order_id, milestone_name, due_type || 'Date', due_date || null, linked_event || null, percentage || null, amount || null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});
router.patch('/milestones/:id', canManage, (req, res) => {
  const m = db.prepare('SELECT id FROM payment_milestones WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { status } = req.body;
  if (status) db.prepare('UPDATE payment_milestones SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// ---- Reminders (two-step: internal verify, then customer email) ----
router.get('/reminders', canView, (req, res) => {
  const { status } = req.query;
  let q = `
    SELECT rl.*, bg.bg_no, bg.bg_type, bg.value, bg.validity_expiry, bg.order_type, bg.order_id, bg.beneficiary
    FROM bg_reminder_log rl JOIN bank_guarantees bg ON bg.id = rl.bg_id WHERE 1=1
  `;
  const params = [];
  if (status) { q += ' AND rl.status = ?'; params.push(status); }
  q += ' ORDER BY rl.triggered_at DESC';
  res.json(db.prepare(q).all(...params));
});

// Step 1: internal verification by a finance team member.
router.post('/reminders/:id/verify', canManage, (req, res) => {
  const log = db.prepare('SELECT * FROM bg_reminder_log WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  if (log.status !== 'PendingReview') return res.status(400).json({ error: `Already ${log.status}` });
  db.prepare(`UPDATE bg_reminder_log SET status = 'Verified', reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
    .run(req.user.id, new Date().toISOString(), req.params.id);
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE source_type = 'BG_EXPIRY' AND source_id = ?`).run(log.bg_id);
  res.json({ ok: true });
});

// Step 2: 1-click email to the customer/vendor, only reachable after Verified.
router.post('/reminders/:id/send-email', canManage, async (req, res) => {
  const log = db.prepare('SELECT * FROM bg_reminder_log WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  if (log.status !== 'Verified') return res.status(400).json({ error: 'This reminder must be internally verified before an email can be sent.' });
  const bg = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(log.bg_id);
  const ctx = resolveOrderContext(bg.order_type, bg.order_id);
  const toAddress = ctx && ctx.partyEmail;
  if (!toAddress) return res.status(400).json({ error: 'No email on file for this order\'s client/vendor.' });
  const result = await sendMail({
    to: toAddress,
    subject: `Bank Guarantee ${bg.bg_no || '#' + bg.id} — Follow-up`,
    text: `Dear ${ctx.partyName},\n\nThis is a follow-up regarding the ${bg.bg_type} Bank Guarantee ${bg.bg_no || '#' + bg.id} (value Rs. ${bg.value}), valid up to ${bg.validity_expiry}.\n\n${bg.milestone_link ? 'Release condition on file: ' + bg.milestone_link + '.\n\n' : ''}Please arrange for its release/return at your earliest convenience, or let us know if an extension is required.\n\nRegards,\nVenkateshwara Engineers - Accounts`,
  });
  if (!result.sent) return res.json({ ok: false, sent: false, message: result.reason });
  db.prepare(`UPDATE bg_reminder_log SET status = 'EmailSent', email_sent_to = ?, email_sent_at = ? WHERE id = ?`)
    .run(toAddress, new Date().toISOString(), req.params.id);
  db.prepare(`UPDATE bank_guarantees SET status = 'PendingRelease' WHERE id = ? AND status = 'Active'`).run(bg.id);
  res.json({ ok: true, sent: true, to: toAddress });
});

router.post('/reminders/:id/dismiss', canManage, (req, res) => {
  const log = db.prepare('SELECT id FROM bg_reminder_log WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE bg_reminder_log SET status = 'Dismissed', reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
    .run(req.user.id, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

// ---- In-app notifications (generic - also carries PO/SO delivery alerts) ----
router.get('/notifications', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM notifications WHERE (user_id IS NULL OR user_id = ?) ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json(rows);
});
router.post('/notifications/:id/read', authRequired, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Manual trigger for the scan job (also run on a timer from server.js) -
// lets Finance force a re-scan instead of waiting for the next 6-hour tick.
router.post('/scan', canManage, (req, res) => {
  const { runScan } = require('../lib/bgReminderScan');
  const result = runScan();
  res.json(result);
});

module.exports = router;

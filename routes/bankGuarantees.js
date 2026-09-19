const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
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
router.get('/', canView, (req, res) => {
  const { bg_type, status } = req.query;
  let q = `SELECT bg.*, p.project_code, p.title as project_title FROM bank_guarantees bg LEFT JOIN projects p ON p.id = bg.project_id WHERE 1=1`;
  const params = [];
  if (bg_type) { q += ' AND bg.bg_type = ?'; params.push(bg_type); }
  if (status) { q += ' AND bg.status = ?'; params.push(status); }
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
  res.json({ live_count: totals.live_count, live_value: totals.live_value, expiring_30d: expiring.c, pending_reminders: pendingReminders.c });
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

router.patch('/:id', canManage, (req, res) => {
  const bg = db.prepare('SELECT * FROM bank_guarantees WHERE id = ?').get(req.params.id);
  if (!bg) return res.status(404).json({ error: 'Not found' });
  const { status, issuing_bank, value, validity_expiry, claim_expiry, milestone_link } = req.body;
  const updates = [];
  const params = [];
  if (status !== undefined) {
    updates.push('status = ?'); params.push(status);
    if (status === 'Released') { updates.push('released_at = ?', 'released_by = ?'); params.push(new Date().toISOString(), req.user.id); }
  }
  if (issuing_bank !== undefined) { updates.push('issuing_bank = ?'); params.push(issuing_bank); }
  if (value !== undefined) { updates.push('value = ?'); params.push(Number(value)); }
  if (validity_expiry !== undefined) { updates.push('validity_expiry = ?'); params.push(validity_expiry); }
  if (claim_expiry !== undefined) { updates.push('claim_expiry = ?'); params.push(claim_expiry); }
  if (milestone_link !== undefined) { updates.push('milestone_link = ?'); params.push(milestone_link); }
  if (!updates.length) return res.json({ ok: true });
  params.push(req.params.id);
  db.prepare(`UPDATE bank_guarantees SET ${updates.join(', ')} WHERE id = ?`).run(...params);
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

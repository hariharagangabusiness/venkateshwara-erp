const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const { submit, approve, reject } = require('../lib/reviewWorkflow');
const { generateOrderConfirmationPdf } = require('../lib/orderConfirmationPdf');
const { getCompanySettings } = require('../lib/settings');
const { getUploadsSubdir } = require('../lib/paths');

const router = express.Router();
router.use(authRequired);

const canEdit = requirePermission('sales_order.manage');
const canView = requirePermission('sales_order.manage', 'report.view_all');

function getOrder(soId) {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(soId);
  if (!order) throw Object.assign(new Error('Sales order not found'), { status: 404 });
  return order;
}

// Blocks an edit against a row that's either locked (already Approved) or
// sitting in PendingApproval - the latter matters just as much: silently
// changing the content while an approver is deciding would mean whatever
// they approve doesn't match what they actually reviewed. Only Draft or
// Rejected rows are genuinely editable.
function assertEditable(row) {
  if (row.locked) throw Object.assign(new Error('This has already been approved and is locked.'), { status: 400 });
  if (row.status === 'PendingApproval') throw Object.assign(new Error('This is awaiting approval and cannot be edited - it must be approved or rejected first.'), { status: 400 });
}

// ===================== Order Confirmation letter =====================

// Lazily creates the Draft row on first access, so every existing sales
// order (confirmed before this workflow existed) gets one on demand instead
// of needing a backfill migration.
function ensureOrderConfirmation(soId) {
  let row = db.prepare('SELECT * FROM order_confirmations WHERE sales_order_id = ?').get(soId);
  if (row) return row;
  const info = db.prepare(`INSERT INTO order_confirmations (sales_order_id) VALUES (?)`).run(soId);
  return db.prepare('SELECT * FROM order_confirmations WHERE id = ?').get(info.lastInsertRowid);
}

router.get('/order-confirmations/:soId', canView, (req, res) => {
  try {
    getOrder(req.params.soId);
    res.json(ensureOrderConfirmation(req.params.soId));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

router.put('/order-confirmations/:soId', canEdit, (req, res) => {
  try {
    getOrder(req.params.soId);
    const row = ensureOrderConfirmation(req.params.soId);
    assertEditable(row);
    const { delivery_terms, payment_terms, special_instructions } = req.body;
    db.prepare(`
      UPDATE order_confirmations SET delivery_terms = ?, payment_terms = ?, special_instructions = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(delivery_terms || null, payment_terms || null, special_instructions || null, row.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

router.post('/order-confirmations/:soId/submit', canEdit, (req, res) => {
  try {
    const row = ensureOrderConfirmation(req.params.soId);
    submit('order_confirmations', row.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/order-confirmations/:soId/approve', requirePermission('order_confirmation.approve'), (req, res) => {
  try {
    const row = ensureOrderConfirmation(req.params.soId);
    approve('order_confirmations', row.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/order-confirmations/:soId/reject', requirePermission('order_confirmation.approve'), (req, res) => {
  try {
    const row = ensureOrderConfirmation(req.params.soId);
    reject('order_confirmations', row.id, req.user.id, req.body.reason);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/order-confirmations/:soId/pdf', canView, async (req, res) => {
  try {
    const salesOrder = getOrder(req.params.soId);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(salesOrder.client_id);
    const oc = ensureOrderConfirmation(req.params.soId);
    const gen = await generateOrderConfirmationPdf(oc, salesOrder, client || {}, getCompanySettings());
    res.download(gen.outPath, `Order-Confirmation-${salesOrder.order_no}.pdf`, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ===================== Annexure review =====================

function ensureAnnexureReview(soId) {
  let row = db.prepare('SELECT * FROM annexure_reviews WHERE sales_order_id = ?').get(soId);
  if (row) return row;
  const info = db.prepare(`INSERT INTO annexure_reviews (sales_order_id) VALUES (?)`).run(soId);
  return db.prepare('SELECT * FROM annexure_reviews WHERE id = ?').get(info.lastInsertRowid);
}

router.get('/annexure-reviews/:soId', canView, (req, res) => {
  try {
    getOrder(req.params.soId);
    res.json(ensureAnnexureReview(req.params.soId));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

router.put('/annexure-reviews/:soId', canEdit, (req, res) => {
  try {
    getOrder(req.params.soId);
    const row = ensureAnnexureReview(req.params.soId);
    assertEditable(row);
    db.prepare(`UPDATE annexure_reviews SET review_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.review_notes || null, row.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// A manual replacement file for the auto-generated annexure - e.g. a
// reviewer tweaked wording directly in Word before sign-off. Blocked once
// locked, same as the existing regenerate-annexure route in routes/sales.js.
const uploadDir = getUploadsSubdir('annexures');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});
router.post('/annexure-reviews/:soId/upload', canEdit, upload.single('file'), (req, res) => {
  try {
    const salesOrder = getOrder(req.params.soId);
    const row = ensureAnnexureReview(req.params.soId);
    assertEditable(row);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    db.prepare('UPDATE sales_orders SET annexure_path = ? WHERE id = ?').run('/uploads/annexures/' + req.file.filename, salesOrder.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

router.post('/annexure-reviews/:soId/submit', canEdit, (req, res) => {
  try {
    const row = ensureAnnexureReview(req.params.soId);
    submit('annexure_reviews', row.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/annexure-reviews/:soId/approve', requirePermission('annexure.approve'), (req, res) => {
  try {
    const row = ensureAnnexureReview(req.params.soId);
    approve('annexure_reviews', row.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/annexure-reviews/:soId/reject', requirePermission('annexure.approve'), (req, res) => {
  try {
    const row = ensureAnnexureReview(req.params.soId);
    reject('annexure_reviews', row.id, req.user.id, req.body.reason);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;

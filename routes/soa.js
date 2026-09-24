const express = require('express');
const fs = require('fs');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const { computeClientLedger } = require('../lib/soaLedger');
const { generateSoaPdf } = require('../lib/soaPdf');
const { runSoaScan } = require('../lib/soaScan');
const { getCompanySettings } = require('../lib/settings');
const { sendMail } = require('../lib/mailer');
const { getDepartmentEmailIdentity } = require('../lib/departmentEmail');

const router = express.Router();
router.use(authRequired);

const canManage = requirePermission('soa.manage');

// ---- Payment Receipts (the credit side of every client's ledger) ----
function nextReceiptNo() {
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const key = 'receipt_seq_' + fy;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const next = row ? Number(row.value) + 1 : 1;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(next));
  return `RCPT/${fy}/${String(next).padStart(4, '0')}`;
}
const RECEIPT_MODES = ['Cash', 'Cheque', 'NEFT', 'RTGS', 'UPI', 'Other'];

router.get('/receipts', requirePermission('payment_receipt.manage', 'soa.manage', 'report.view_all'), (req, res) => {
  const { client_id } = req.query;
  let q = `
    SELECT pr.*, c.name as client_name, si.invoice_no FROM payment_receipts pr
    LEFT JOIN clients c ON c.id = pr.client_id LEFT JOIN sales_invoices si ON si.id = pr.sales_invoice_id
    WHERE 1=1
  `;
  const params = [];
  if (client_id) { q += ' AND pr.client_id = ?'; params.push(client_id); }
  q += ' ORDER BY pr.receipt_date DESC, pr.id DESC';
  res.json(db.prepare(q).all(...params));
});

router.post('/receipts', requirePermission('payment_receipt.manage'), (req, res) => {
  const { client_id, sales_invoice_id, amount, receipt_date, mode, reference_no, notes } = req.body;
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(400).json({ error: 'client_id is required and must be a real client' });
  if (!(Number(amount) > 0)) return res.status(400).json({ error: 'amount must be a positive number' });
  if (!receipt_date) return res.status(400).json({ error: 'receipt_date is required' });
  if (!RECEIPT_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${RECEIPT_MODES.join(', ')}` });
  if (sales_invoice_id) {
    const inv = db.prepare('SELECT id FROM sales_invoices WHERE id = ? AND client_id = ?').get(sales_invoice_id, client_id);
    if (!inv) return res.status(400).json({ error: 'That invoice does not belong to this client.' });
  }
  const receiptNo = nextReceiptNo();
  const info = db.prepare(`
    INSERT INTO payment_receipts (receipt_no, client_id, sales_invoice_id, amount, receipt_date, mode, reference_no, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(receiptNo, client_id, sales_invoice_id || null, Number(amount), receipt_date, mode, reference_no || null, notes || null, req.user.id);
  res.json({ id: info.lastInsertRowid, receipt_no: receiptNo });
});

// ---- Ledger / Statement (live, on-demand) ----
router.get('/ledger/:clientId', requirePermission('payment_receipt.manage', 'soa.manage', 'report.view_all'), (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const ledger = computeClientLedger(req.params.clientId, { from: req.query.from, to: req.query.to });
  res.json({ client, ...ledger });
});

router.get('/ledger/:clientId/pdf', requirePermission('payment_receipt.manage', 'soa.manage', 'report.view_all'), async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const { from, to } = req.query;
  const ledger = computeClientLedger(client.id, { from, to });
  try {
    const gen = await generateSoaPdf(client, ledger, { start: from || null, end: to || null }, getCompanySettings());
    res.download(gen.outPath, `SOA-${client.client_code || client.id}.pdf`, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Settings: org-wide default + per-client override ----
router.get('/settings', canManage, (req, res) => {
  const org = db.prepare('SELECT * FROM soa_settings WHERE client_id IS NULL').get() || { frequency: 'Off', enabled: 0 };
  const overrides = db.prepare(`
    SELECT s.*, c.name as client_name FROM soa_settings s JOIN clients c ON c.id = s.client_id ORDER BY c.name
  `).all();
  res.json({ org, overrides });
});

function upsertSettings(clientId, frequency, enabled, userId) {
  const FREQUENCIES = ['Off', 'Monthly', 'Quarterly'];
  if (!FREQUENCIES.includes(frequency)) throw new Error(`frequency must be one of ${FREQUENCIES.join(', ')}`);
  const existing = clientId
    ? db.prepare('SELECT id FROM soa_settings WHERE client_id = ?').get(clientId)
    : db.prepare('SELECT id FROM soa_settings WHERE client_id IS NULL').get();
  if (existing) {
    db.prepare(`UPDATE soa_settings SET frequency=?, enabled=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(frequency, enabled ? 1 : 0, userId, existing.id);
    return existing.id;
  }
  const info = db.prepare(`INSERT INTO soa_settings (client_id, frequency, enabled, updated_by) VALUES (?,?,?,?)`)
    .run(clientId || null, frequency, enabled ? 1 : 0, userId);
  return info.lastInsertRowid;
}
router.put('/settings/org', canManage, (req, res) => {
  try {
    upsertSettings(null, req.body.frequency, req.body.enabled, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/settings/client/:clientId', canManage, (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Not found' });
  try {
    upsertSettings(client.id, req.body.frequency, req.body.enabled, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/settings/client/:clientId', canManage, (req, res) => {
  db.prepare('DELETE FROM soa_settings WHERE client_id = ?').run(req.params.clientId);
  res.json({ ok: true });
});

// ---- Dispatch review queue (internal verify, then customer email) ----
// Both PendingReview and Verified statuses stay on this queue - Verified
// items are exactly the ones still waiting on the Send Email step, so they
// can't disappear from view between Verify and Send or that step would be
// unreachable from the UI.
router.get('/pending', canManage, (req, res) => {
  res.json(db.prepare(`
    SELECT l.*, c.name as client_name, c.email as client_email FROM soa_dispatch_log l
    JOIN clients c ON c.id = l.client_id WHERE l.status IN ('PendingReview', 'Verified') ORDER BY l.generated_at DESC
  `).all());
});
router.post('/:id/verify', canManage, (req, res) => {
  const log = db.prepare('SELECT * FROM soa_dispatch_log WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  if (log.status !== 'PendingReview') return res.status(400).json({ error: `Already ${log.status}` });
  db.prepare(`UPDATE soa_dispatch_log SET status = 'Verified', reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
    .run(req.user.id, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});
router.post('/:id/dismiss', canManage, (req, res) => {
  const log = db.prepare('SELECT id FROM soa_dispatch_log WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE soa_dispatch_log SET status = 'Dismissed', reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
    .run(req.user.id, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});
router.post('/:id/send-email', canManage, async (req, res) => {
  const log = db.prepare('SELECT * FROM soa_dispatch_log WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  if (log.status !== 'Verified') return res.status(400).json({ error: 'This statement must be internally verified before an email can be sent.' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(log.client_id);
  if (!client || !client.email) return res.status(400).json({ error: 'This client has no email on file - add one under Clients.' });

  const ledger = computeClientLedger(log.client_id, { from: log.period_start, to: log.period_end });
  let gen;
  try {
    gen = await generateSoaPdf(client, ledger, { start: log.period_start, end: log.period_end }, getCompanySettings());
    const pdfBuffer = fs.readFileSync(gen.outPath);
    const result = await sendMail({
      to: client.email,
      subject: `Statement of Accounts (${log.period_start} to ${log.period_end}) - Venkateshwara Engineers`,
      text: `Dear ${client.contact_person || client.name},\n\nPlease find attached your Statement of Accounts for the period ${log.period_start} to ${log.period_end}. Closing balance: Rs. ${Number(ledger.closingBalance).toLocaleString('en-IN')}.\n\nPlease report any discrepancy within 7 days.\n\nRegards,\nVenkateshwara Engineers - Accounts`,
      attachments: [{ filename: `SOA-${client.client_code || client.id}.pdf`, content: pdfBuffer }],
      ...getDepartmentEmailIdentity('Accounts / HR'),
    });
    if (!result.sent) return res.json({ ok: false, sent: false, message: result.reason });
    db.prepare(`UPDATE soa_dispatch_log SET status = 'EmailSent', email_sent_to = ?, email_sent_at = ? WHERE id = ?`)
      .run(client.email, new Date().toISOString(), req.params.id);
    res.json({ ok: true, sent: true, to: client.email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    if (gen) fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
  }
});

// Manual trigger, mirroring POST /api/bg/scan - lets Finance generate this
// period's statements immediately instead of waiting for the timer in
// server.js, and is what the functional tests below drive directly.
router.post('/scan', canManage, (req, res) => {
  res.json(runSoaScan());
});

module.exports = router;

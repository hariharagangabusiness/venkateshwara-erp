// Foreign Payments (Advance Remittance Against Imports) - see the
// foreign_payment_requests/foreign_payment_invoice_lines comment in
// db/schema.sql for what this mirrors and why. One request per remittance
// application; goes through the generic approval engine (chain
// 'ForeignPayment') exactly like every other outbound-money workflow in
// this app, then accepts a payment record and post-payment documents
// (Payment Advice, Bill of Entry, Bill of Lading, Vendor Invoice, Proforma
// Invoice) via the shared /api/attachments/foreign_payment/:id endpoint.
const express = require('express');
const fs = require('fs');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const approvals = require('../lib/approvals');
const { generateForeignPaymentPdf } = require('../lib/foreignPaymentPdf');
const { getCompanySettings } = require('../lib/settings');
const { buildDownloadFilename, buildVersionStamp } = require('../lib/downloadFilename');
const router = express.Router();
router.use(authRequired);
const canManage = requirePermission('foreign_payment.manage');

// Every editable header field, in the same order as the ARIM form's own
// sections - see db/schema.sql for what each one means. Declaration
// boilerplate text itself is never stored here (printed verbatim by the
// PDF generator) - only the two real blanks inside it
// (import_on_behalf_of, ofac_sanctioned_country) are data fields.
const HEADER_FIELDS = [
  'vendor_id',
  'ad_code', 'bank_name', 'branch', 'bank_form_no', 'customer_id', 'transaction_type', 'tr_fwc_amount', 'tr_fwc_rate', 'tr_fwc_ref_no', 'equivalent_inr',
  'currency', 'amount',
  'beneficiary_name', 'beneficiary_address_line1', 'beneficiary_address_line2', 'beneficiary_pincode', 'beneficiary_city', 'beneficiary_state', 'beneficiary_country',
  'beneficiary_bank_name', 'beneficiary_bank_address_line1', 'beneficiary_bank_address_line2', 'beneficiary_bank_pincode', 'beneficiary_bank_city', 'beneficiary_bank_state', 'beneficiary_bank_country', 'beneficiary_bank_swift_code', 'beneficiary_bank_account_no', 'iban_sort_code_bsb_transit', 'correspondent_bank_name_bic',
  'foreign_bank_charges', 'goods_freely_importable', 'license_no', 'license_issue_date', 'license_expiry_date', 'license_face_value', 'license_amount_endorsed', 'debit_account_no', 'debit_balance_account_no', 'forward_contract_no', 'forward_contract_booked_date', 'part_payment_reason',
  'fbg_sblc_reason', 'long_standing_since', 'fbg_sblc_other_reason',
  'port_of_loading', 'port_of_discharge', 'is_merchanting_trade',
  'goods_nature',
  'fbg_waiver_requested',
  'import_on_behalf_of', 'ofac_sanctioned_country',
  'signatory_name', 'signatory_address_line1', 'signatory_address_line2', 'signatory_pincode', 'signatory_city', 'signatory_state', 'signatory_country', 'ie_code', 'declaration_date', 'declaration_place',
];
const INVOICE_LINE_FIELDS = [
  'invoice_no', 'invoice_date', 'terms', 'currency', 'amount', 'qty_of_goods', 'description_of_goods',
  'hs_classification', 'country_of_origin', 'country_consigned_from', 'mode_of_shipment', 'date_of_shipment',
];
// A request stays editable up to the point it's actually been approved -
// same "you can still fix a rejected/queried one and resend it" pattern as
// Purchase Requests, rather than forcing a fresh request from scratch.
const EDITABLE_STATUSES = ['Draft', 'Rejected', 'InfoRequested'];

function saveLines(id, lines) {
  db.prepare('DELETE FROM foreign_payment_invoice_lines WHERE foreign_payment_request_id = ?').run(id);
  const insertLine = db.prepare(`
    INSERT INTO foreign_payment_invoice_lines (foreign_payment_request_id, ${INVOICE_LINE_FIELDS.join(',')}, sort_order)
    VALUES (?, ${INVOICE_LINE_FIELDS.map(() => '?').join(',')}, ?)
  `);
  (Array.isArray(lines) ? lines : []).forEach((l, i) => {
    insertLine.run(id, ...INVOICE_LINE_FIELDS.map(f => (l[f] !== undefined && l[f] !== '' ? l[f] : null)), i);
  });
}

function fetchFull(id) {
  const header = db.prepare(`
    SELECT fp.*, v.name as vendor_name, u.full_name as created_by_name
    FROM foreign_payment_requests fp LEFT JOIN vendors v ON v.id = fp.vendor_id LEFT JOIN users u ON u.id = fp.created_by
    WHERE fp.id = ?
  `).get(id);
  if (!header) return null;
  const lines = db.prepare(`SELECT * FROM foreign_payment_invoice_lines WHERE foreign_payment_request_id = ? ORDER BY sort_order, id`).all(id);
  const documents = db.prepare(`
    SELECT a.*, u.full_name as uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.entity_type = 'foreign_payment' AND a.entity_id = ? ORDER BY a.id DESC
  `).all(id);
  return { ...header, lines, documents };
}

router.get('/', canManage, (req, res) => {
  res.json(db.prepare(`
    SELECT fp.*, v.name as vendor_name, u.full_name as created_by_name,
      (SELECT COUNT(*) FROM foreign_payment_invoice_lines l WHERE l.foreign_payment_request_id = fp.id) as line_count,
      (SELECT COUNT(*) FROM attachments a WHERE a.entity_type = 'foreign_payment' AND a.entity_id = fp.id AND a.document_type = 'BillOfEntry') as boe_count
    FROM foreign_payment_requests fp LEFT JOIN vendors v ON v.id = fp.vendor_id LEFT JOIN users u ON u.id = fp.created_by
    ORDER BY fp.id DESC
  `).all());
});

router.get('/:id', canManage, (req, res) => {
  const full = fetchFull(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  res.json(full);
});

router.get('/:id/pdf', canManage, async (req, res) => {
  const full = fetchFull(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  try {
    const gen = await generateForeignPaymentPdf(full, getCompanySettings());
    const filename = buildDownloadFilename({
      docType: 'Foreign_Payment_Request',
      reference: full.request_no,
      partyName: full.beneficiary_name,
      date: new Date(full.created_at).toISOString().slice(0, 10),
      version: buildVersionStamp(),
    });
    res.download(gen.outPath, filename, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', canManage, (req, res) => {
  const b = req.body;
  if (!String(b.currency || '').trim()) return res.status(400).json({ error: 'Currency is required.' });
  if (!Number(b.amount) || Number(b.amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  if (!String(b.beneficiary_name || '').trim()) return res.status(400).json({ error: 'Beneficiary name is required.' });
  if (b.vendor_id) {
    const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(b.vendor_id);
    if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists.' });
  }
  const tx = db.transaction(() => {
    const requestNo = 'FP-' + Date.now();
    const values = HEADER_FIELDS.map(c => (b[c] !== undefined && b[c] !== '' ? b[c] : null));
    const info = db.prepare(`
      INSERT INTO foreign_payment_requests (request_no, status, created_by, ${HEADER_FIELDS.join(',')})
      VALUES (?, 'Draft', ?, ${HEADER_FIELDS.map(() => '?').join(',')})
    `).run(requestNo, req.user.id, ...values);
    saveLines(info.lastInsertRowid, b.lines);
    return { id: info.lastInsertRowid, request_no: requestNo };
  });
  res.json(tx());
});

router.put('/:id', canManage, (req, res) => {
  const existing = db.prepare('SELECT * FROM foreign_payment_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ error: `This request is ${existing.status} and can no longer be edited.` });
  }
  const b = req.body;
  if (b.currency !== undefined && !String(b.currency || '').trim()) return res.status(400).json({ error: 'Currency is required.' });
  if (b.amount !== undefined && (!Number(b.amount) || Number(b.amount) <= 0)) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  if (b.beneficiary_name !== undefined && !String(b.beneficiary_name || '').trim()) return res.status(400).json({ error: 'Beneficiary name is required.' });
  if (b.vendor_id) {
    const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(b.vendor_id);
    if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists.' });
  }
  const tx = db.transaction(() => {
    const sets = HEADER_FIELDS.map(c => `${c}=?`).join(',');
    const values = HEADER_FIELDS.map(c => (b[c] !== undefined ? (b[c] === '' ? null : b[c]) : existing[c]));
    // A resubmission after Rejected/InfoRequested goes back to Draft - the
    // Admin/Accounts approver sees it fresh next time it's submitted,
    // same "edit clears the old outcome" convention as Purchase Requests.
    db.prepare(`UPDATE foreign_payment_requests SET status='Draft', ${sets} WHERE id=?`).run(...values, existing.id);
    if (b.lines !== undefined) saveLines(existing.id, b.lines);
  });
  tx();
  res.json({ ok: true });
});

router.delete('/:id', canManage, (req, res) => {
  const existing = db.prepare('SELECT * FROM foreign_payment_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ error: `This request is ${existing.status} and can no longer be deleted.` });
  }
  db.prepare('DELETE FROM foreign_payment_invoice_lines WHERE foreign_payment_request_id = ?').run(existing.id);
  db.prepare('DELETE FROM foreign_payment_requests WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

router.post('/:id/submit-for-approval', canManage, (req, res) => {
  const existing = db.prepare('SELECT * FROM foreign_payment_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ error: `This request is already ${existing.status}.` });
  }
  // Approval Matrix thresholds are entered in INR everywhere else in this
  // app - use the INR-equivalent when it's known, falling back to the raw
  // foreign amount only when nobody's filled that in yet.
  const thresholdAmount = existing.equivalent_inr || existing.amount;
  const approvalId = approvals.startApproval('ForeignPayment', 'foreign_payment', existing.id, thresholdAmount, req.user.id);
  db.prepare(`UPDATE foreign_payment_requests SET status='Pending', approval_id=? WHERE id=?`).run(approvalId, existing.id);
  res.json({ ok: true });
});

// Records that the remittance actually went out - unlocks document
// uploads and computes the RBI 3-month Bill of Entry deadline
// (11 days instead for gold-via-IIBX, entered by hand via boe_due_date
// override since that's a rare, declared-up-front case).
router.post('/:id/mark-payment-made', canManage, (req, res) => {
  const existing = db.prepare('SELECT * FROM foreign_payment_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'Approved') return res.status(400).json({ error: 'Only an Approved request can be marked as paid.' });
  const { payment_reference, actual_debited_amount, actual_exchange_rate, boe_due_date } = req.body;
  const paidAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const dueDate = boe_due_date || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  db.prepare(`
    UPDATE foreign_payment_requests SET status='PaymentMade', payment_made_at=?, payment_made_by=?,
      payment_reference=?, actual_debited_amount=?, actual_exchange_rate=?, boe_due_date=?
    WHERE id=?
  `).run(paidAt, req.user.id, payment_reference || null, actual_debited_amount || null, actual_exchange_rate || null, dueDate, existing.id);
  res.json({ ok: true });
});

router.post('/:id/close', canManage, (req, res) => {
  const existing = db.prepare('SELECT * FROM foreign_payment_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'PaymentMade') return res.status(400).json({ error: 'Only a request with payment already made can be closed.' });
  db.prepare(`UPDATE foreign_payment_requests SET status='Closed' WHERE id=?`).run(existing.id);
  res.json({ ok: true });
});

module.exports = router;

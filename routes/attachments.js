// Generic reusable attachments (Round 3 fix): one small table keyed by
// (entity_type, entity_id) instead of a bespoke table per feature. Any
// authenticated user can attach/view files against a parent entity - the
// real access control is whatever gate the parent entity's own page/route
// already has (this endpoint stays simple by design).
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const { makeUpload } = require('../lib/upload');
const { resolveUploadPath } = require('../lib/paths');
const { compressUploadedImageFile } = require('../lib/imageCompress');
const { PDFDocument } = require('pdf-lib');
const router = express.Router();
router.use(authRequired);

const upload = makeUpload('attachments', 15);

const VALID_TYPES = new Set([
  'purchase_request', 'purchase_order', 'purchase_invoice', 'expense_voucher', 'foc_request', 'leave_request', 'salary_advance', 'ticket', 'bank_guarantee',
  'foreign_payment', 'offer', 'sales_order', 'customer_communication', 'fg_dispatch', 'sale_rejection_mrn', 'grn_reconciliation', 'grn_batches',
]);

// Free-form category tag, currently only used by foreign_payment uploads
// (Payment Advice, Bill of Entry, Bill of Lading, Vendor Invoice, Proforma
// Invoice, Other) - every other entity type leaves this NULL and just
// doesn't show a category, same as before this column existed.
const VALID_DOCUMENT_TYPES = new Set(['PaymentAdvice', 'BillOfEntry', 'BillOfLading', 'VendorInvoice', 'ProformaInvoice', 'GADrawing', 'CADFile', 'CustomerPO', 'Other',
  ...['invoice_file', 'insurance_file', 'eway_bill_file', 'transporter_receipt_file', 'packing_list_file']]);

// FG Dispatch document slots (2026-10-23): one live file per slot per dispatch -
// a new upload under the same tag replaces the previous one - and the file is
// compressed on the way in (images via sharp, PDFs via a pdf-lib re-save,
// whichever is smaller). Only meaningful against entity_type 'fg_dispatch'.
const FG_DOC_TAGS = new Set(['invoice_file', 'insurance_file', 'eway_bill_file', 'transporter_receipt_file', 'packing_list_file']);

// Best-effort: never throws, leaves the file untouched if it can't help.
async function compressUploadedFile(file) {
  const ext = path.extname(file.path).toLowerCase();
  if (ext === '.pdf') {
    try {
      const original = fs.readFileSync(file.path);
      const saved = Buffer.from(await (await PDFDocument.load(original, { ignoreEncryption: true })).save({ useObjectStreams: true }));
      if (saved.length < original.length) fs.writeFileSync(file.path, saved);
    } catch (e) { /* keep original */ }
    return path.basename(file.path);
  }
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return compressUploadedImageFile(file.path);
  return path.basename(file.path);
}

// A GRN line that belongs to a batch shares the batch's single vendor-invoice
// file, so map the line id to its parent batch instead of duplicating per line.
function resolveEntity(entityType, entityId) {
  if (entityType === 'grn_reconciliation') {
    const g = db.prepare('SELECT grn_batch_id FROM grn_reconciliations WHERE id = ?').get(entityId);
    if (g && g.grn_batch_id) return { entityType: 'grn_batches', entityId: g.grn_batch_id };
  }
  return { entityType, entityId };
}

router.get('/:entityType/:entityId', (req, res) => {
  const { entityType, entityId } = resolveEntity(req.params.entityType, req.params.entityId);
  const rows = db.prepare(`
    SELECT a.*, u.full_name as uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.id DESC
  `).all(entityType, entityId);
  res.json(rows);
});

router.post('/:entityType/:entityId', upload.single('file'), async (req, res) => {
  const { entityType, entityId } = resolveEntity(req.params.entityType, req.params.entityId);
  if (!VALID_TYPES.has(entityType)) return res.status(400).json({ error: 'Unknown entity type' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const documentType = req.body.document_type && VALID_DOCUMENT_TYPES.has(req.body.document_type) ? req.body.document_type : null;
  const isFgDoc = FG_DOC_TAGS.has(documentType);
  if (isFgDoc && entityType !== 'fg_dispatch') {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* best effort */ }
    return res.status(400).json({ error: 'That document category only applies to a dispatch.' });
  }
  let filename = req.file.filename;
  if (isFgDoc) filename = await compressUploadedFile(req.file);
  const filePath = '/uploads/attachments/' + filename;
  // Insert the new row and retire the old one(s) for the same slot together.
  const stale = [];
  const info = db.transaction(() => {
    if (isFgDoc) {
      for (const old of db.prepare('SELECT id, file_path FROM attachments WHERE entity_type = ? AND entity_id = ? AND document_type = ?').all(entityType, entityId, documentType)) {
        stale.push(old.file_path);
        db.prepare('DELETE FROM attachments WHERE id = ?').run(old.id);
      }
    }
    return db.prepare(`
      INSERT INTO attachments (entity_type, entity_id, file_path, original_name, uploaded_by, document_type) VALUES (?,?,?,?,?,?)
    `).run(entityType, entityId, filePath, req.file.originalname, req.user.id, documentType);
  })();
  // Files only go once the DB swap committed (and never the one just saved).
  stale.filter(f => f !== filePath).forEach(f => { try { fs.unlinkSync(resolveUploadPath(f)); } catch (e) { /* already gone */ } });
  res.json({ id: info.lastInsertRowid, file_path: filePath, document_type: documentType });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;

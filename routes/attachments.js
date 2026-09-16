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
const router = express.Router();
router.use(authRequired);

const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'attachments');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const VALID_TYPES = new Set([
  'purchase_request', 'purchase_order', 'expense_voucher', 'foc_request', 'leave_request', 'salary_advance', 'ticket',
]);

router.get('/:entityType/:entityId', (req, res) => {
  const { entityType, entityId } = req.params;
  const rows = db.prepare(`
    SELECT a.*, u.full_name as uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.id DESC
  `).all(entityType, entityId);
  res.json(rows);
});

router.post('/:entityType/:entityId', upload.single('file'), (req, res) => {
  const { entityType, entityId } = req.params;
  if (!VALID_TYPES.has(entityType)) return res.status(400).json({ error: 'Unknown entity type' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = '/uploads/attachments/' + req.file.filename;
  const info = db.prepare(`
    INSERT INTO attachments (entity_type, entity_id, file_path, original_name, uploaded_by) VALUES (?,?,?,?,?)
  `).run(entityType, entityId, filePath, req.file.originalname, req.user.id);
  res.json({ id: info.lastInsertRowid, file_path: filePath });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;

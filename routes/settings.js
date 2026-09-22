const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { getCompanySettings, setCompanySettings, getEmailSettings, setEmailSettings, getPurchaseSettings, setPurchaseSettings } = require('../lib/settings');
const router = express.Router();
router.use(authRequired);

const { getUploadsSubdir } = require('../lib/paths');
const logoDir = getUploadsSubdir('company');
const uploadLogo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, logoDir),
    filename: (req, file, cb) => cb(null, 'logo-' + Date.now() + path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '')),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/company', (req, res) => res.json(getCompanySettings()));
router.put('/company', requireRole('Admin'), (req, res) => {
  setCompanySettings(req.body || {});
  res.json(getCompanySettings());
});
router.post('/company/logo', requireRole('Admin'), uploadLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const relPath = '/uploads/company/' + req.file.filename;
  setCompanySettings({ logo_path: relPath });
  res.json({ logo_path: relPath });
});

// Company Bill-To/Ship-To address profiles (Round 25) - separate from the
// single flat registered_address/factory_address on the company blob above,
// so the company can have more than one of each (e.g. per-factory), same as
// a client already can via client_addresses. Any authenticated user can
// read the list (it feeds the Purchase Order form's address picker); only
// Admin manages it, same as the rest of Company Settings.
router.get('/company-addresses', (req, res) => {
  res.json(db.prepare('SELECT * FROM company_addresses ORDER BY address_type, is_default DESC, id').all());
});
router.post('/company-addresses', requireRole('Admin'), (req, res) => {
  const { address_type, label, line1, line2, city, state, state_code, pincode, gstin, is_default } = req.body;
  if (!['Billing', 'Shipping'].includes(address_type)) return res.status(400).json({ error: 'address_type must be Billing or Shipping' });
  if (!String(line1 || '').trim()) return res.status(400).json({ error: 'Address line 1 is required' });
  const tx = db.transaction(() => {
    if (is_default) db.prepare('UPDATE company_addresses SET is_default = 0 WHERE address_type = ?').run(address_type);
    return db.prepare(`
      INSERT INTO company_addresses (address_type, label, line1, line2, city, state, state_code, pincode, gstin, is_default)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(address_type, label || null, line1.trim(), line2 || null, city || null, state || null, state_code || null, pincode || null, gstin || null, is_default ? 1 : 0);
  });
  const info = tx();
  res.json({ id: info.lastInsertRowid });
});
router.put('/company-addresses/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM company_addresses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { label, line1, line2, city, state, state_code, pincode, gstin, is_default } = req.body;
  const tx = db.transaction(() => {
    if (is_default) db.prepare('UPDATE company_addresses SET is_default = 0 WHERE address_type = ? AND id != ?').run(existing.address_type, existing.id);
    db.prepare(`
      UPDATE company_addresses SET label=?, line1=?, line2=?, city=?, state=?, state_code=?, pincode=?, gstin=?, is_default=? WHERE id=?
    `).run(
      label !== undefined ? label : existing.label, line1 !== undefined ? line1 : existing.line1,
      line2 !== undefined ? line2 : existing.line2, city !== undefined ? city : existing.city,
      state !== undefined ? state : existing.state, state_code !== undefined ? state_code : existing.state_code,
      pincode !== undefined ? pincode : existing.pincode, gstin !== undefined ? gstin : existing.gstin,
      is_default !== undefined ? (is_default ? 1 : 0) : existing.is_default, existing.id
    );
  });
  tx();
  res.json({ ok: true });
});
router.delete('/company-addresses/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM company_addresses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const refCount = db.prepare('SELECT COUNT(*) as n FROM purchase_orders WHERE company_address_id = ?').get(existing.id).n;
  if (refCount > 0) return res.status(400).json({ error: `This address is used on ${refCount} Purchase Order(s) and can't be deleted.` });
  db.prepare('DELETE FROM company_addresses WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// Email settings - SMTP + default CC list. smtp_pass is never sent back to the client.
router.get('/email', requireRole('Admin'), (req, res) => {
  const cfg = getEmailSettings();
  res.json(Object.assign({}, cfg, { smtp_pass: cfg.smtp_pass ? '••••••••' : '' }));
});
router.put('/email', requireRole('Admin'), (req, res) => {
  const body = Object.assign({}, req.body);
  // Don't overwrite a real password with the masked placeholder if the form was submitted unchanged.
  if (body.smtp_pass === '••••••••') delete body.smtp_pass;
  if (typeof body.cc_list === 'string') {
    body.cc_list = body.cc_list.split(',').map(s => s.trim()).filter(Boolean);
  }
  setEmailSettings(body);
  const cfg = getEmailSettings();
  res.json(Object.assign({}, cfg, { smtp_pass: cfg.smtp_pass ? '••••••••' : '' }));
});

// Purchase settings - currently just the vendor-quote threshold (Round 13).
router.get('/purchase', (req, res) => res.json(getPurchaseSettings()));
router.put('/purchase', requireRole('Admin'), (req, res) => {
  setPurchaseSettings(req.body || {});
  res.json(getPurchaseSettings());
});
// Convenience single-value endpoint for the frontend, per the task spec.
router.get('/purchase-quote-threshold', (req, res) => res.json({ quote_threshold: getPurchaseSettings().quote_threshold }));

module.exports = router;

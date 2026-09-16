const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { authRequired, requireRole } = require('../middleware/auth');
const { getCompanySettings, setCompanySettings, getEmailSettings, setEmailSettings, getPurchaseSettings, setPurchaseSettings } = require('../lib/settings');
const router = express.Router();
router.use(authRequired);

const logoDir = path.join(__dirname, '..', 'public', 'uploads', 'company');
fs.mkdirSync(logoDir, { recursive: true });
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

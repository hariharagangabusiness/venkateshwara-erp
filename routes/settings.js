const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { getCompanySettings, setCompanySettings, getEmailSettings, setEmailSettings, getInboundMailSettings, setInboundMailSettings, getPurchaseInboundMailSettings, setPurchaseInboundMailSettings, getPurchaseSettings, setPurchaseSettings, getSidebarGroupOrder, setSidebarGroupOrder, getWeeklyDigestSettings, setWeeklyDigestSettings, getDailyPurchaseDigestSettings, setDailyPurchaseDigestSettings, EMAIL_CHANNEL_KEYS, EMAIL_WORKFLOWS, getEmailChannels, setEmailChannels, addEmailChannel, deleteEmailChannel, getEmailWorkflowChannels, setEmailWorkflowChannels, getProjectPlanSparesMode, setProjectPlanSparesMode } = require('../lib/settings');
const { sendMail } = require('../lib/mailer');
const { testConnection: testInboundMailConnection } = require('../lib/inboundMail');
const { testConnection: testPurchaseInboundMailConnection } = require('../lib/inboundRfqMail');
const { makeUpload } = require('../lib/upload');
const router = express.Router();
router.use(authRequired);

const uploadLogo = makeUpload('company', 5, name => 'logo-' + Date.now() + path.extname(name).replace(/[^a-zA-Z0-9.]/g, ''));

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

// Fires a one-off email against whatever SMTP config is currently in
// effect (saved settings first, env vars as fallback - same resolution
// lib/mailer.js always uses) so an Admin can confirm delivery actually
// works without needing a real PO/invoice to trigger one.
router.post('/email/test', requireRole('Admin'), async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter an email address to send the test to.' });
  const result = await sendMail({
    to,
    subject: 'Venkateshwara ERP - Test Email',
    text: `This is a test email from the Venkateshwara Engineers ERP, confirming SMTP is configured correctly.\n\nSent by: ${req.user.full_name || req.user.username}\nSent at: ${new Date().toLocaleString()}`,
  });
  res.json(result);
});

// System Outbound Channels - per-purpose sender identity (daily reports, weekly summary, escalations, user accounts).
// Admin-only like the rest of Email Settings; smtp_pass is masked and a masked value on save means "keep the stored one".
const maskChannels = (all) => Object.fromEntries(Object.entries(all).map(([k, c]) => [k, { ...c, smtp_pass: c.smtp_pass ? '••••••••' : '' }]));
router.get('/email-channels', requireRole('Admin'), (req, res) => res.json(maskChannels(getEmailChannels())));
router.put('/email-channels', requireRole('Admin'), (req, res) => {
  const body = (req.body && req.body.channels) || {};
  const patch = {};
  const known = getEmailChannels();
  for (const k of Object.keys(known)) {
    const c = body[k];
    if (!c) continue;
    const from_address = String(c.from_address || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from_address)) return res.status(400).json({ error: 'Enter a valid From address for ' + k + '.' });
    patch[k] = { from_address, from_name: String(c.from_name || '').trim(), smtp_user: String(c.smtp_user || '').trim() };
    if (c.smtp_pass !== '••••••••') patch[k].smtp_pass = String(c.smtp_pass || '');
    if (!patch[k].smtp_user) patch[k].smtp_pass = ''; // a password without a username can't be used
  }
  setEmailChannels(patch);
  res.json(maskChannels(getEmailChannels()));
});
// Admin-created channel. Key is a lowercase slug and must be new; the 5 built-ins can't be re-created or deleted.
router.post('/email-channels', requireRole('Admin'), (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  const key = String(b.key || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const from_address = String(b.from_address || '').trim();
  if (!key) return res.status(400).json({ error: 'Enter a channel name.' });
  if (getEmailChannels()[key]) return res.status(400).json({ error: 'A channel with that name already exists.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from_address)) return res.status(400).json({ error: 'Enter a valid From address.' });
  const smtp_user = String(b.smtp_user || '').trim();
  addEmailChannel(key, { label: label || key, from_address, from_name: String(b.from_name || '').trim(), smtp_user, smtp_pass: smtp_user ? String(b.smtp_pass || '') : '' });
  res.json(maskChannels(getEmailChannels()));
});
router.delete('/email-channels/:key', requireRole('Admin'), (req, res) => {
  const ch = getEmailChannels()[req.params.key];
  if (!ch) return res.status(404).json({ error: 'Unknown channel.' });
  if (EMAIL_CHANNEL_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Built-in channels cannot be deleted.' });
  const inUse = Object.entries(getEmailWorkflowChannels()).filter(([, c]) => c === req.params.key).map(([w]) => EMAIL_WORKFLOWS[w].label);
  if (inUse.length) return res.status(400).json({ error: 'Reassign these workflows to another channel first: ' + inUse.join(', ') + '.' });
  deleteEmailChannel(req.params.key);
  res.json(maskChannels(getEmailChannels()));
});
// Which channel each automated-email workflow sends through (+ the editable email templates it uses, for the Edit Email Content link).
router.get('/email-workflows', requireRole('Admin'), (req, res) => {
  const assigned = getEmailWorkflowChannels();
  res.json(Object.entries(EMAIL_WORKFLOWS).map(([key, w]) => ({ key, label: w.label, channel: assigned[key], templates: w.templates })));
});
router.put('/email-workflows', requireRole('Admin'), (req, res) => {
  const map = (req.body && req.body.workflows) || {};
  const chans = getEmailChannels();
  for (const [w, c] of Object.entries(map)) {
    if (!EMAIL_WORKFLOWS[w]) return res.status(400).json({ error: 'Unknown workflow ' + w + '.' });
    if (!chans[c]) return res.status(400).json({ error: 'Unknown channel ' + c + '.' });
  }
  setEmailWorkflowChannels(map);
  res.json({ ok: true });
});
// One-off test through a single channel - never falls back to the global sender, so a rejected alias shows its real error.
router.post('/email-channels/:key/test', requireRole('Admin'), async (req, res) => {
  if (!getEmailChannels()[req.params.key]) return res.status(404).json({ error: 'Unknown channel.' });
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter an email address to send the test to.' });
  const result = await sendMail({
    to, channel: req.params.key, noFallback: true,
    subject: 'Venkateshwara ERP - Test Email (' + getEmailChannels()[req.params.key].label + ')',
    text: 'This is a test email sent through the "' + getEmailChannels()[req.params.key].label + '" outbound channel, confirming the sender address and SMTP login work. Sent by: ' + (req.user.full_name || req.user.username),
  });
  res.json(result);
});

// Inbound Service mailbox (IMAP) settings - read-side counterpart to Email
// Settings above. imap_pass is never sent back to the client, same masking
// convention as smtp_pass.
router.get('/inbound-mail', requireRole('Admin'), (req, res) => {
  const cfg = getInboundMailSettings();
  res.json(Object.assign({}, cfg, { imap_pass: cfg.imap_pass ? '••••••••' : '' }));
});
router.put('/inbound-mail', requireRole('Admin'), (req, res) => {
  const body = Object.assign({}, req.body);
  if (body.imap_pass === '••••••••') delete body.imap_pass;
  setInboundMailSettings(body);
  const cfg = getInboundMailSettings();
  res.json(Object.assign({}, cfg, { imap_pass: cfg.imap_pass ? '••••••••' : '' }));
});
// Confirms the saved IMAP credentials actually connect - mirrors /email/test's
// role for the read side, but doesn't send anything, just logs in and out.
router.post('/inbound-mail/test', requireRole('Admin'), async (req, res) => {
  const result = await testInboundMailConnection();
  res.json(result);
});

// Inbound Purchase/RFQ mailbox (IMAP) settings - a separate mailbox from
// Service's above (see lib/inboundRfqMail.js). Same masking convention.
router.get('/purchase-inbound-mail', requireRole('Admin'), (req, res) => {
  const cfg = getPurchaseInboundMailSettings();
  res.json(Object.assign({}, cfg, { imap_pass: cfg.imap_pass ? '••••••••' : '' }));
});
router.put('/purchase-inbound-mail', requireRole('Admin'), (req, res) => {
  const body = Object.assign({}, req.body);
  if (body.imap_pass === '••••••••') delete body.imap_pass;
  setPurchaseInboundMailSettings(body);
  const cfg = getPurchaseInboundMailSettings();
  res.json(Object.assign({}, cfg, { imap_pass: cfg.imap_pass ? '••••••••' : '' }));
});
router.post('/purchase-inbound-mail/test', requireRole('Admin'), async (req, res) => {
  const result = await testPurchaseInboundMailConnection();
  res.json(result);
});

// Purchase settings - currently just the vendor-quote threshold (Round 13).
router.get('/purchase', (req, res) => res.json(getPurchaseSettings()));
router.put('/purchase', requireRole('Admin'), (req, res) => {
  setPurchaseSettings(req.body || {});
  res.json(getPurchaseSettings());
});
// Convenience single-value endpoint for the frontend, per the task spec.
router.get('/purchase-quote-threshold', (req, res) => res.json({ quote_threshold: getPurchaseSettings().quote_threshold }));

// Admin-configurable global sidebar group order (2026-10-14) - any
// authenticated user can read it (every login's sidebar needs it), only
// Admin can change it. See lib/settings.js for the storage shape.
router.get('/sidebar-group-order', (req, res) => res.json({ order: getSidebarGroupOrder() }));
router.put('/sidebar-group-order', requireRole('Admin'), (req, res) => {
  setSidebarGroupOrder((req.body && req.body.order) || []);
  res.json({ order: getSidebarGroupOrder() });
});

// Weekly, department-wise pending-approvals digest (2026-11-13) - GET open
// to any authenticated user so the Company Settings page can always show
// the current schedule, PUT Admin-only. See lib/weeklyApprovalDigest.js.
router.get('/weekly-digest', (req, res) => res.json(getWeeklyDigestSettings()));
router.put('/weekly-digest', requireRole('Admin'), (req, res) => {
  const b = req.body || {};
  const dayOfWeek = Math.min(6, Math.max(0, parseInt(b.day_of_week, 10) || 0));
  const hour = Math.min(23, Math.max(0, parseInt(b.hour, 10) || 0));
  const bucket1 = Math.max(0, parseInt(b.bucket1_max_days, 10) || 0);
  const bucket2 = Math.max(bucket1 + 1, parseInt(b.bucket2_max_days, 10) || bucket1 + 1);
  setWeeklyDigestSettings({
    enabled: !!b.enabled,
    day_of_week: dayOfWeek,
    hour,
    bucket1_max_days: bucket1,
    bucket2_max_days: bucket2,
  });
  res.json(getWeeklyDigestSettings());
});

// Daily Purchase Digest (Purchase Velocity + open PO/PR aging, with an Excel attachment) - GET open to any authenticated
// user so Company Settings can always show the schedule, PUT and the manual send Admin-only. See lib/purchaseDailyDigest.js.
router.get('/daily-purchase-digest', (req, res) => res.json(getDailyPurchaseDigestSettings()));
router.put('/daily-purchase-digest', requireRole('Admin'), (req, res) => {
  const b = req.body || {};
  const send_time = String(b.send_time || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(send_time)) return res.status(400).json({ error: 'Send time must be HH:MM (24-hour).' });
  const list = String(b.recipients || '').split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
  const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad.length) return res.status(400).json({ error: 'Not a valid email address: ' + bad.join(', ') });
  setDailyPurchaseDigestSettings({
    enabled: !!b.enabled, recipients: [...new Map(list.map((e) => [e.toLowerCase(), e])).values()].join(', '), include_hod_management: !!b.include_hod_management, send_time,
  });
  res.json(getDailyPurchaseDigestSettings());
});
// Manual "Send Daily Purchase Report Now" - sends immediately, ignoring enabled/schedule/last-sent, and does not
// consume today's scheduled send. Returns the recipients on success or the SMTP/config reason on failure.
router.post('/daily-purchase-digest/send', requireRole('Admin'), async (req, res) => {
  try {
    const { sendDailyPurchaseDigest } = require('../lib/purchaseDailyDigest');
    const r = await sendDailyPurchaseDigest({ userId: req.user.id, manual: true });
    if (!r.sent) return res.status(r.status || 502).json({ error: r.reason });
    res.json({ ok: true, recipients: r.recipients, open_pos: r.openPoCount, open_prs: r.openPrCount, over_5_pos: r.poOver5, over_5_prs: r.prOver5 });
  } catch (e) {
    console.error('[daily-purchase-digest] manual send failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Scope for the project.plan_spares permission (2026-11-14) - GET open to
// any authenticated user (the Role Permissions screen and the Targets
// sheet's own access check both need to read it), PUT Admin-only.
router.get('/project-plan-spares-mode', (req, res) => res.json({ mode: getProjectPlanSparesMode() }));
router.put('/project-plan-spares-mode', requireRole('Admin'), (req, res) => {
  setProjectPlanSparesMode(req.body && req.body.mode);
  res.json({ mode: getProjectPlanSparesMode() });
});

module.exports = router;

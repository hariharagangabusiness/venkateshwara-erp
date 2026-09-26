const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { SECRET, authRequired } = require('../middleware/auth');
const { createToken, verifyToken, consumeToken } = require('../lib/passwordReset');
const { sendMail } = require('../lib/mailer');
const { computeAllowedPages } = require('../lib/pageAccess');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare(`
    SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.username = ? AND u.is_active = 1
  `).get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '12h' });
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type) VALUES (?, 'login', 'user')`).run(user.id);
  res.json({
    token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role_name, department_id: user.department_id },
    must_change_password: !!user.must_change_password,
  });
});

// ===================== Password reset (unauthenticated) =====================
// Always responds with the same generic message regardless of whether the
// email matched an account, so this can't be used to enumerate valid logins.
router.post('/forgot-password', (req, res) => {
  const generic = { ok: true, message: 'If that email is on file, a password reset link has been sent.' };
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.json(generic);
  const user = db.prepare(`SELECT * FROM users WHERE email = ? AND is_active = 1`).get(email);
  if (!user) return res.json(generic);
  const rawToken = createToken(user.id, 'PasswordReset');
  const resetLink = `${req.protocol}://${req.get('host')}/?reset_token=${rawToken}`;
  sendMail({
    to: user.email,
    subject: 'Password Reset - Venkateshwara Engineers ERP',
    text: `Hello ${user.full_name},\n\nA password reset was requested for your account (${user.username}). Click the link below to set a new password - it expires in 30 minutes and can only be used once:\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email; your password won't change unless you use the link above.\n\nRegards,\nVenkateshwara Engineers ERP`,
  }).catch(() => { /* best-effort - the generic response never reveals whether sending succeeded */ });
  res.json(generic);
});

// Lets the frontend show "link expired" immediately rather than only after
// the person has typed a new password and hit submit.
router.get('/reset-password/validate', (req, res) => {
  try {
    const tokenRow = verifyToken(req.query.token);
    const user = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(tokenRow.user_id);
    res.json({ valid: true, full_name: user.full_name, username: user.username, purpose: tokenRow.purpose });
  } catch (e) {
    res.status(400).json({ valid: false, error: e.message });
  }
});

router.post('/reset-password', (req, res) => {
  const { token, new_password } = req.body;
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  let tokenRow;
  try {
    tokenRow = verifyToken(token);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(tokenRow.user_id);
  if (!user || !user.is_active) return res.status(400).json({ error: 'This account is no longer active.' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(new_password, 10), user.id);
  consumeToken(tokenRow.id);
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type) VALUES (?, 'password_reset', 'user')`).run(user.id);
  res.json({ ok: true });
});

// Self-service change while already logged in - requires the current
// password (defense in depth beyond just holding a valid session token),
// and is also how the forced must_change_password flow after a welcome
// email/admin-set password clears itself.
router.post('/change-password', authRequired, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(new_password, 10), user.id);
  res.json({ ok: true });
});

router.get('/me', authRequired, (req, res) => {
  const dept = req.user.department_id
    ? db.prepare('SELECT name FROM departments WHERE id = ?').get(req.user.department_id)
    : null;
  res.json({
    id: req.user.id, username: req.user.username, full_name: req.user.full_name,
    role: req.user.role_name, department_id: req.user.department_id,
    department_name: dept ? dept.name : null, is_supervisor: !!req.user.is_supervisor,
  });
});

// Which sidebar pages this user can see - role matrix + Extra Page Access +
// their own individual overrides, all merged by computeAllowedPages(). null
// = unrestricted (every page).
router.get('/my-pages', authRequired, (req, res) => {
  res.json({ pages: computeAllowedPages(db, req.user) });
});

// Permissions for current user's role (for frontend nav gating)
router.get('/my-permissions', authRequired, (req, res) => {
  if (req.user.role_name === 'Admin') {
    const all = db.prepare('SELECT code FROM permissions').all().map(r => r.code);
    return res.json({ role: 'Admin', permissions: all });
  }
  const rows = db.prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?
  `).all(req.user.role_id);
  res.json({ role: req.user.role_name, permissions: rows.map(r => r.code) });
});

module.exports = router;

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { SECRET, authRequired } = require('../middleware/auth');

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
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role_name, department_id: user.department_id }
  });
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

// Which sidebar pages this user's role can see. null = unrestricted (every
// page, i.e. today's behavior) - a role only gets a fixed list once an
// Admin has explicitly saved one for it in the User Access module.
router.get('/my-pages', authRequired, (req, res) => {
  if (req.user.role_name === 'Admin') return res.json({ pages: null });
  const configured = db.prepare('SELECT 1 FROM role_access_configured WHERE role_id = ?').get(req.user.role_id);
  if (!configured) return res.json({ pages: null });
  const rows = db.prepare('SELECT page_id FROM role_page_access WHERE role_id = ?').all(req.user.role_id);
  const pages = new Set(rows.map(r => r.page_id));
  // Round 3: additive department/individual grants (User Access -> Entire
  // Department / Specific Users) on top of the role's configured list.
  const extra = db.prepare(`
    SELECT page_id FROM extra_page_access WHERE user_id = ? OR (department_id IS NOT NULL AND department_id = ?)
  `).all(req.user.id, req.user.department_id || -1);
  extra.forEach(r => pages.add(r.page_id));
  res.json({ pages: Array.from(pages) });
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

const express = require('express');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { PAGE_CATALOG, ALL_PAGE_IDS } = require('../lib/pageCatalog');
const router = express.Router();
router.use(authRequired);

router.get('/page-catalog', (req, res) => res.json(PAGE_CATALOG));

// Full matrix for the User Access screen: every role x whether each page is
// explicitly configured for it and, if so, which pages are checked.
router.get('/access', requireRole('Admin'), (req, res) => {
  const roles = db.prepare('SELECT id, name FROM roles ORDER BY name').all();
  const configured = new Set(db.prepare('SELECT role_id FROM role_access_configured').all().map(r => r.role_id));
  const rows = db.prepare('SELECT role_id, page_id FROM role_page_access').all();
  const byRole = {};
  rows.forEach(r => { (byRole[r.role_id] = byRole[r.role_id] || []).push(r.page_id); });
  res.json({
    pageCatalog: PAGE_CATALOG,
    roles: roles.map(r => ({
      id: r.id, name: r.name,
      configured: configured.has(r.id),
      allowedPages: byRole[r.id] || null, // null = unrestricted (sees everything)
    })),
  });
});

// Replace one role's allowed page list. Passing an empty array explicitly
// locks that role out of every page (still overridable per-page by editing
// again) - that's different from never having configured it at all.
router.put('/access/:roleId', requireRole('Admin'), (req, res) => {
  const roleId = Number(req.params.roleId);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.name === 'Admin') return res.status(400).json({ error: "Admin's access can't be restricted." });
  const pageIds = Array.isArray(req.body.page_ids) ? req.body.page_ids : [];
  const validIds = new Set(ALL_PAGE_IDS);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM role_page_access WHERE role_id = ?').run(roleId);
    const insert = db.prepare('INSERT INTO role_page_access (role_id, page_id) VALUES (?, ?)');
    pageIds.filter(id => validIds.has(id)).forEach(id => insert.run(roleId, id));
    db.prepare('INSERT OR IGNORE INTO role_access_configured (role_id) VALUES (?)').run(roleId);
  });
  tx();
  res.json({ ok: true });
});

// Reset a role back to "unrestricted" (removes explicit configuration).
router.delete('/access/:roleId', requireRole('Admin'), (req, res) => {
  const roleId = Number(req.params.roleId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM role_page_access WHERE role_id = ?').run(roleId);
    db.prepare('DELETE FROM role_access_configured WHERE role_id = ?').run(roleId);
  });
  tx();
  res.json({ ok: true });
});

// ---- Per-user page access ----
// The role matrix above (plus Extra Page Access below) is additive only -
// there's no way to take one page away from one specific person short of
// reconfiguring their whole role. This gives an Admin a single per-person
// screen instead: pick a user, see exactly what they can see today (their
// role's baseline plus any Extra Page Access), and grant or revoke
// individual pages on top of that - see user_page_overrides and
// lib/pageAccess.js's computeAllowedPages() for how it's merged.
router.get('/access/user/:userId', requireRole('Admin'), (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.full_name, u.department_id, u.role_id, r.name as role_name, d.name as department_name
    FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.id = ?
  `).get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role_name === 'Admin') return res.status(400).json({ error: "Admin's access can't be restricted." });
  const configured = db.prepare('SELECT 1 FROM role_access_configured WHERE role_id = ?').get(user.role_id);
  let baselinePages = null;
  if (configured) {
    const rows = db.prepare('SELECT page_id FROM role_page_access WHERE role_id = ?').all(user.role_id);
    const pages = new Set(rows.map(r => r.page_id));
    const extra = db.prepare(`
      SELECT page_id FROM extra_page_access WHERE user_id = ? OR (department_id IS NOT NULL AND department_id = ?)
    `).all(user.id, user.department_id || -1);
    extra.forEach(r => pages.add(r.page_id));
    baselinePages = Array.from(pages);
  }
  const overrides = {};
  db.prepare('SELECT page_id, access FROM user_page_overrides WHERE user_id = ?').all(user.id)
    .forEach(r => { overrides[r.page_id] = r.access; });
  res.json({
    pageCatalog: PAGE_CATALOG,
    user: { id: user.id, full_name: user.full_name, role_name: user.role_name, department_name: user.department_name },
    roleConfigured: !!configured,
    baselinePages, // null = role is unrestricted (baseline is every page)
    overrides,     // { [page_id]: 'granted' | 'revoked' }, on top of baselinePages
  });
});

// Full replace of one user's overrides (mirrors PUT /access/:roleId's
// full-replace style). An empty object clears every override, resetting the
// user back to exactly their role's default.
router.put('/access/user/:userId', requireRole('Admin'), (req, res) => {
  const user = db.prepare(`
    SELECT u.id, r.name as role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?
  `).get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role_name === 'Admin') return res.status(400).json({ error: "Admin's access can't be restricted." });
  const overrides = req.body.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};
  const validIds = new Set(ALL_PAGE_IDS);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_page_overrides WHERE user_id = ?').run(user.id);
    const insert = db.prepare('INSERT INTO user_page_overrides (user_id, page_id, access, granted_by) VALUES (?,?,?,?)');
    for (const [pageId, access] of Object.entries(overrides)) {
      if (!validIds.has(pageId) || !['granted', 'revoked'].includes(access)) continue;
      insert.run(user.id, pageId, access, req.user.id);
    }
  });
  tx();
  res.json({ ok: true });
});

// ---- Extra Page Access (Round 3): grant a page to an entire department
// (current + future users) or to specific individual users, on top of the
// role-based matrix above. Checked additively in /auth/my-pages.
router.get('/extra-access', requireRole('Admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, d.name as department_name, u.full_name as user_name
    FROM extra_page_access e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN users u ON u.id = e.user_id
    ORDER BY e.id DESC
  `).all();
  res.json(rows);
});
router.post('/extra-access', requireRole('Admin'), (req, res) => {
  const { scope, department_id, user_ids, page_id } = req.body;
  if (!page_id) return res.status(400).json({ error: 'page_id is required' });
  if (scope === 'Department') {
    if (!department_id) return res.status(400).json({ error: 'department_id is required for Department scope' });
    db.prepare(`INSERT INTO extra_page_access (scope, department_id, page_id) VALUES ('Department', ?, ?)`).run(department_id, page_id);
  } else if (scope === 'User') {
    const ids = Array.isArray(user_ids) ? user_ids : [user_ids].filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one user for User scope' });
    const insert = db.prepare(`INSERT INTO extra_page_access (scope, user_id, page_id) VALUES ('User', ?, ?)`);
    ids.forEach(id => insert.run(id, page_id));
  } else {
    return res.status(400).json({ error: "scope must be 'Department' or 'User'" });
  }
  res.json({ ok: true });
});
router.delete('/extra-access/:id', requireRole('Admin'), (req, res) => {
  db.prepare('DELETE FROM extra_page_access WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Cross-Department Oversight (Round 22): grant a specific user
// supervisor-level reach into another role's domain (Job Cards, To-Dos, and
// any permission-gated route via requirePermission), without merging the
// two departments/roles - e.g. a real-world HOD who covers both Electrical
// and Service. Purely additive; see lib/roleOversight.js for how it's
// applied. Doesn't touch page-level nav visibility - pair it with Extra
// Page Access above if the granted user's own role can't already see the
// other department's pages.
router.get('/role-oversight', requireRole('Admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT ro.*, u.full_name as user_name, r.name as oversees_role_name
    FROM role_oversight ro
    JOIN users u ON u.id = ro.user_id
    JOIN roles r ON r.id = ro.oversees_role_id
    ORDER BY ro.id DESC
  `).all();
  res.json(rows);
});
router.post('/role-oversight', requireRole('Admin'), (req, res) => {
  const { user_id, oversees_role_id } = req.body;
  if (!user_id || !oversees_role_id) return res.status(400).json({ error: 'user_id and oversees_role_id are required' });
  const user = db.prepare('SELECT id, role_id FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(400).json({ error: 'User not found' });
  if (user.role_id === Number(oversees_role_id)) return res.status(400).json({ error: 'A user already has full reach over their own role - pick a different one to grant.' });
  db.prepare(`INSERT OR IGNORE INTO role_oversight (user_id, oversees_role_id, granted_by) VALUES (?,?,?)`)
    .run(user_id, oversees_role_id, req.user.id);
  res.json({ ok: true });
});
router.delete('/role-oversight/:id', requireRole('Admin'), (req, res) => {
  db.prepare('DELETE FROM role_oversight WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Approval Matrix (Admin only) ----
// Lets an Admin edit which role approves each step of each approval chain
// (Expense Voucher, Leave, Purchase Request, Salary Advance, Payroll),
// the amount threshold each step kicks in at, and whether that step
// requires the approving role's HOD/Supervisor specifically (rather than
// any user holding that role).
router.get('/approval-matrix', requireRole('Admin'), (req, res) => {
  const chains = db.prepare('SELECT * FROM approval_chains ORDER BY id').all();
  const steps = db.prepare(`
    SELECT s.*, r.name as role_name FROM approval_chain_steps s JOIN roles r ON r.id = s.approver_role_id
    ORDER BY s.chain_id, s.step_order
  `).all();
  const roles = db.prepare("SELECT id, name FROM roles WHERE name != 'Admin' ORDER BY name").all();
  res.json({
    roles,
    chains: chains.map(c => ({ ...c, steps: steps.filter(s => s.chain_id === c.id) })),
  });
});

// Replace one chain's entire step list.
router.put('/approval-matrix/:chainId', requireRole('Admin'), (req, res) => {
  const chainId = Number(req.params.chainId);
  const chain = db.prepare('SELECT * FROM approval_chains WHERE id = ?').get(chainId);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  const steps = Array.isArray(req.body.steps) ? req.body.steps : [];
  if (steps.length === 0) return res.status(400).json({ error: 'A chain needs at least one approval step.' });
  for (const s of steps) {
    if (!s.approver_role_id) return res.status(400).json({ error: 'Every step needs an approver role.' });
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM approval_chain_steps WHERE chain_id = ?').run(chainId);
    const insert = db.prepare(`
      INSERT INTO approval_chain_steps (chain_id, step_order, approver_role_id, min_amount, requires_supervisor) VALUES (?,?,?,?,?)
    `);
    steps.forEach((s, i) => insert.run(chainId, i + 1, s.approver_role_id, s.min_amount || 0, s.requires_supervisor ? 1 : 0));
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;

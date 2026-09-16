const express = require('express');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

// Catalog of every sidebar page in the app, grouped the same way the
// sidebar itself is grouped. This is the single source of truth the User
// Access module's matrix is built from, and what role_page_access rows
// reference by page_id. Keep this in sync with NAV in public/js/app.js.
const PAGE_CATALOG = [
  { group: 'Overview', items: [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'approvals', label: 'My Approvals' },
    { id: 'dept-report', label: 'Department Report' },
  ]},
  { group: 'Sales & Marketing', items: [
    { id: 'leads', label: 'Leads / Enquiries' },
    { id: 'offers', label: 'Offers / Quotations' },
    { id: 'orders', label: 'Sales Orders' },
    { id: 'clients', label: 'Clients' },
  ]},
  { group: 'Projects Management', items: [
    { id: 'projects', label: 'Projects' },
    { id: 'targets', label: 'Targets' },
    { id: 'jobcards', label: 'My Job Cards (own department)' },
  ]},
  { group: 'Purchase', items: [
    { id: 'purchase-requests', label: 'Purchase Requests' },
    { id: 'purchase-orders', label: 'Purchase Orders' },
    { id: 'vendors', label: 'Vendors' },
  ]},
  { group: 'Store & Inventory', items: [
    { id: 'store', label: 'Item Master' },
    { id: 'stock-in-out', label: 'Stock In/Out' },
    { id: 'challans', label: 'Challans' },
  ]},
  { group: 'Service', items: [
    { id: 'service', label: 'Service & Spares' },
    { id: 'service-mine', label: 'My Service Requests' },
    { id: 'service-recon', label: 'Reconciliation' },
    { id: 'service-reports-dashboard', label: 'Service Reports Dashboard' },
  ]},
  { group: 'Payroll & HR', items: [
    { id: 'employees', label: 'Employees' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'leave', label: 'Leave Requests' },
    { id: 'advances', label: 'Salary Advances' },
    { id: 'payroll', label: 'Payroll' },
    { id: 'leave-balances', label: 'Leave Balances Master' },
  ]},
  { group: 'Finance', items: [
    { id: 'expenses', label: 'Expense Vouchers' },
    { id: 'expense-report', label: 'Cash vs Accounted Report' },
    { id: 'foc', label: 'FOC Material Issue' },
    { id: 'finance-ledger', label: 'Finance Ledger' },
    { id: 'monthly-reconciliation', label: 'Monthly Reconciliation' },
  ]},
  { group: 'Finance', items: [
    { id: 'sales-invoices', label: 'Sales Invoices' },
    { id: 'operating-expenses', label: 'Operating Expenses' },
    { id: 'gst-summary', label: 'GST Summary' },
  ]},
  { group: 'Asset Management', items: [
    { id: 'assets', label: 'Asset Register' },
    { id: 'assets-maintenance', label: 'Maintenance / EOL Report' },
  ]},
  { group: 'Tickets', items: [
    { id: 'tickets-raise', label: 'Raise a Ticket' },
    { id: 'tickets-mine', label: 'My Tickets' },
    { id: 'tickets-department', label: 'Department Tickets' },
  ]},
  { group: 'Admin', items: [
    { id: 'users', label: 'Users & Roles' },
    { id: 'access', label: 'User Access' },
    { id: 'approval-matrix', label: 'Approval Matrix' },
    { id: 'company-settings', label: 'Company Settings' },
  ]},
];

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
  const validIds = new Set(PAGE_CATALOG.flatMap(g => g.items.map(it => it.id)));
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

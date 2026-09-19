const express = require('express');
const { db } = require('../db');
const { authRequired, requireRole, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

const NODE_TYPES = ['Region', 'Unit', 'Department', 'Team'];

// Full tree, flat (parent_id-linked) - the frontend builds the nested view.
// Read access matches who can already see cross-department reports.
router.get('/tree', requirePermission('report.view_all'), (req, res) => {
  res.json(db.prepare(`
    SELECT n.*, d.name as department_name FROM org_nodes n LEFT JOIN departments d ON d.id = n.department_id
    ORDER BY n.parent_id IS NOT NULL, n.sort_order, n.name
  `).all());
});

router.post('/nodes', requireRole('Admin'), (req, res) => {
  const { name, node_type, parent_id, department_id, sort_order } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name is required' });
  if (!NODE_TYPES.includes(node_type)) return res.status(400).json({ error: `node_type must be one of ${NODE_TYPES.join(', ')}` });
  if (parent_id) {
    const parent = db.prepare('SELECT id FROM org_nodes WHERE id = ?').get(parent_id);
    if (!parent) return res.status(400).json({ error: 'parent node not found' });
  }
  if (department_id) {
    const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
    if (!dept) return res.status(400).json({ error: 'department not found' });
  }
  const info = db.prepare(`INSERT INTO org_nodes (name, node_type, parent_id, department_id, sort_order) VALUES (?,?,?,?,?)`)
    .run(name.trim(), node_type, parent_id || null, department_id || null, Number(sort_order) || 0);
  res.json({ id: info.lastInsertRowid });
});

router.put('/nodes/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM org_nodes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, department_id, sort_order } = req.body;
  db.prepare(`UPDATE org_nodes SET name=?, department_id=?, sort_order=? WHERE id=?`).run(
    name !== undefined ? String(name).trim() : existing.name,
    department_id !== undefined ? (department_id || null) : existing.department_id,
    sort_order !== undefined ? Number(sort_order) : existing.sort_order,
    existing.id
  );
  res.json({ ok: true });
});

router.delete('/nodes/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT id FROM org_nodes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const hasChildren = db.prepare('SELECT id FROM org_nodes WHERE parent_id = ?').get(existing.id);
  if (hasChildren) return res.status(400).json({ error: 'Delete or move this node\'s children first.' });
  db.prepare('DELETE FROM org_nodes WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// All descendant node ids of a node, INCLUDING itself - a plain recursive
// CTE, the standard SQLite way to walk a self-referential tree without
// pulling the whole table and walking it in JS.
function descendantNodeIds(nodeId) {
  return db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM org_nodes WHERE id = ?
      UNION ALL
      SELECT o.id FROM org_nodes o JOIN sub ON o.parent_id = sub.id
    )
    SELECT id FROM sub
  `).all(nodeId).map(r => r.id);
}

// Rollup report: headcount + monthly salary cost, aggregated per department
// under this node (drill-down rows) and summed for the node itself (the
// summary). Chosen because every department has employees, unlike job-card
// pipeline stages which don't apply to Sales/Marketing/Accounts/HR/Management.
router.get('/nodes/:id/rollup', requirePermission('report.view_all'), (req, res) => {
  const node = db.prepare('SELECT * FROM org_nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const ids = descendantNodeIds(node.id);
  const placeholders = ids.map(() => '?').join(',');
  const deptIds = db.prepare(`SELECT DISTINCT department_id FROM org_nodes WHERE id IN (${placeholders}) AND department_id IS NOT NULL`)
    .all(...ids).map(r => r.department_id);

  if (!deptIds.length) return res.json({ node, by_department: [], totals: { headcount: 0, monthly_salary_cost: 0 } });
  const deptPlaceholders = deptIds.map(() => '?').join(',');
  const byDepartment = db.prepare(`
    SELECT d.id as department_id, d.name as department_name,
      COUNT(e.id) as headcount, COALESCE(SUM(e.monthly_salary), 0) as monthly_salary_cost
    FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.status = 'active'
    WHERE d.id IN (${deptPlaceholders})
    GROUP BY d.id, d.name ORDER BY d.name
  `).all(...deptIds);
  const totals = byDepartment.reduce((acc, r) => ({
    headcount: acc.headcount + r.headcount, monthly_salary_cost: acc.monthly_salary_cost + r.monthly_salary_cost,
  }), { headcount: 0, monthly_salary_cost: 0 });
  res.json({ node, by_department: byDepartment, totals });
});

// Drill-down: the actual employee rows behind one department's rollup number.
router.get('/departments/:deptId/employees', requirePermission('report.view_all'), (req, res) => {
  res.json(db.prepare(`
    SELECT id, employee_code, full_name, designation, monthly_salary, status FROM employees
    WHERE department_id = ? AND status = 'active' ORDER BY full_name
  `).all(req.params.deptId));
});

module.exports = router;

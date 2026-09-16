const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

function computeBookValue(a) {
  const purchase = Number(a.purchase_value) || 0;
  const salvage = Number(a.salvage_value) || 0;
  const life = Number(a.useful_life_years) || 1;
  if (a.status === 'Disposed' && a.disposal_value != null) return Number(a.disposal_value);
  const purchaseDate = a.purchase_date ? new Date(a.purchase_date) : null;
  if (!purchaseDate || isNaN(purchaseDate.getTime())) return purchase;
  const years = (Date.now() - purchaseDate.getTime()) / (365.25 * 24 * 3600 * 1000);
  const annualDep = (purchase - salvage) / life;
  const dep = Math.min(purchase - salvage, Math.max(0, annualDep * years));
  return Math.max(salvage, purchase - dep);
}

function withComputed(a) {
  return Object.assign({}, a, { book_value: Math.round(computeBookValue(a) * 100) / 100 });
}

router.get('/', (req, res) => {
  const { status, department_id } = req.query;
  let q = `
    SELECT a.*, v.name as vendor_name, d.name as department_name, e.full_name as custodian_name
    FROM assets a LEFT JOIN vendors v ON v.id = a.vendor_id LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN employees e ON e.id = a.custodian_id WHERE 1=1
  `;
  const params = [];
  if (status) { q += ' AND a.status = ?'; params.push(status); }
  if (department_id) { q += ' AND a.department_id = ?'; params.push(department_id); }
  q += ' ORDER BY a.id DESC';
  res.json(db.prepare(q).all(...params).map(withComputed));
});

router.get('/due-for-maintenance', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id as asset_id, a.asset_code, a.name, MAX(l.next_due_date) as next_due_date
    FROM assets a JOIN asset_maintenance_logs l ON l.asset_id = a.id
    WHERE l.next_due_date IS NOT NULL AND l.next_due_date <= date('now', '+30 days')
    GROUP BY a.id ORDER BY next_due_date
  `).all();
  res.json(rows);
});

router.get('/nearing-eol', (req, res) => {
  const rows = db.prepare(`SELECT * FROM assets WHERE status = 'Active'`).all().map(withComputed)
    .filter(a => a.purchase_value > 0 && a.book_value <= a.purchase_value * 0.15);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const logs = db.prepare('SELECT * FROM asset_maintenance_logs WHERE asset_id = ? ORDER BY log_date DESC, id DESC').all(a.id);
  res.json({ asset: withComputed(a), logs });
});

router.post('/', requirePermission('asset.manage'), (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Asset name is required.' });
  const info = db.prepare(`
    INSERT INTO assets (asset_code, name, category, purchase_date, purchase_value, vendor_id, department_id,
      custodian_id, useful_life_years, depreciation_method, salvage_value, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(b.asset_code || ('AST-' + Date.now()), b.name, b.category || null, b.purchase_date || null,
    b.purchase_value || 0, b.vendor_id || null, b.department_id || null, b.custodian_id || null,
    b.useful_life_years || 5, b.depreciation_method || 'StraightLine', b.salvage_value || 0, b.status || 'Active', req.user.id);
  res.json({ id: info.lastInsertRowid });
});

router.put('/:id', requirePermission('asset.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  const fields = ['asset_code', 'name', 'category', 'purchase_date', 'purchase_value', 'vendor_id', 'department_id',
    'custodian_id', 'useful_life_years', 'depreciation_method', 'salvage_value', 'status', 'disposal_date', 'disposal_value'];
  const sets = fields.map(f => `${f}=?`).join(',');
  const values = fields.map(f => b[f] !== undefined ? b[f] : existing[f]);
  db.prepare(`UPDATE assets SET ${sets} WHERE id=?`).run(...values, existing.id);
  res.json({ ok: true });
});

router.post('/:id/maintenance', requirePermission('asset.manage'), (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  const { log_date, type, description, cost, performed_by, next_due_date } = req.body;
  const info = db.prepare(`
    INSERT INTO asset_maintenance_logs (asset_id, log_date, type, description, cost, performed_by, next_due_date, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(asset.id, log_date || new Date().toISOString(), type || 'Preventive', description || null, cost || 0,
    performed_by || null, next_due_date || null, req.user.id);
  if (type === 'Breakdown' || type === 'Repair') {
    db.prepare(`UPDATE assets SET status = 'UnderMaintenance' WHERE id = ? AND status = 'Active'`).run(asset.id);
  }
  res.json({ id: info.lastInsertRowid });
});

module.exports = router;

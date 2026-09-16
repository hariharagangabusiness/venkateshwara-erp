const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

// Monthly Expense Tracker - a fast "quick view" rollup (replaces the team's
// Excel), distinct from the Finance > Expense Vouchers approval workflow.
// 'Daily' categories are entered day-by-day; 'Fixed' categories are one
// lump sum per month, stored against the 1st of that month.

router.get('/categories', requirePermission('expense_tracker.manage', 'report.view_all'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM expense_tracker_categories ORDER BY kind, sort_order, name`).all());
});

router.post('/categories', requirePermission('expense_tracker.manage'), (req, res) => {
  const { name, kind, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Enter a category name.' });
  if (!['Daily', 'Fixed'].includes(kind)) return res.status(400).json({ error: 'Kind must be Daily or Fixed.' });
  try {
    const info = db.prepare(`INSERT INTO expense_tracker_categories (name, kind, sort_order) VALUES (?,?,?)`)
      .run(name, kind, Number(sort_order) || 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'A category with that name already exists.' });
  }
});

router.put('/categories/:id', requirePermission('expense_tracker.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM expense_tracker_categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, kind, sort_order, active } = req.body;
  db.prepare(`UPDATE expense_tracker_categories SET name=?, kind=?, sort_order=?, active=? WHERE id=?`).run(
    name !== undefined ? name : existing.name,
    kind !== undefined ? kind : existing.kind,
    sort_order !== undefined ? Number(sort_order) : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    existing.id
  );
  res.json({ ok: true });
});

// ---- Entries for one month (grid view) ----
router.get('/entries', requirePermission('expense_tracker.manage', 'report.view_all'), (req, res) => {
  const month = req.query.month; // 'YYYY-MM'
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Pass ?month=YYYY-MM' });
  const rows = db.prepare(`
    SELECT e.*, c.name as category_name, c.kind
    FROM expense_tracker_entries e JOIN expense_tracker_categories c ON c.id = e.category_id
    WHERE e.entry_date LIKE ?
  `).all(month + '%');
  res.json(rows);
});

// ---- Bulk upsert (grid save) ----
router.post('/entries/bulk', requirePermission('expense_tracker.manage'), (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'No entries to save.' });
  const upsert = db.prepare(`
    INSERT INTO expense_tracker_entries (category_id, entry_date, amount, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(category_id, entry_date) DO UPDATE SET
      amount = excluded.amount, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
  `);
  const del = db.prepare(`DELETE FROM expense_tracker_entries WHERE category_id = ? AND entry_date = ?`);
  const tx = db.transaction(() => {
    entries.forEach(e => {
      if (!e.category_id || !e.entry_date) return;
      const amt = Number(e.amount);
      if (!amt) { del.run(e.category_id, e.entry_date); return; } // blank/zero cell clears any existing entry
      upsert.run(e.category_id, e.entry_date, amt, e.notes || null, req.user.id, req.user.id);
    });
  });
  tx();
  res.json({ ok: true });
});

// ---- Year summary (the formula-linked "Summary sheet" equivalent - always live) ----
router.get('/summary', requirePermission('expense_tracker.manage', 'report.view_all'), (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const categories = db.prepare(`SELECT * FROM expense_tracker_categories WHERE active = 1 ORDER BY kind, sort_order, name`).all();
  const rows = db.prepare(`
    SELECT category_id, substr(entry_date, 1, 7) as month, SUM(amount) as total
    FROM expense_tracker_entries
    WHERE substr(entry_date, 1, 4) = ?
    GROUP BY category_id, substr(entry_date, 1, 7)
  `).all(year);
  const byCategory = {};
  rows.forEach(r => {
    byCategory[r.category_id] = byCategory[r.category_id] || {};
    byCategory[r.category_id][r.month] = r.total;
  });
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const grid = categories.map(c => ({
    category_id: c.id, name: c.name, kind: c.kind,
    months: months.map(m => (byCategory[c.id] && byCategory[c.id][m]) || 0),
  }));
  const monthTotals = months.map((m, i) => grid.reduce((s, r) => s + r.months[i], 0));
  res.json({ year, months, categories: grid, monthTotals, grandTotal: monthTotals.reduce((a, b) => a + b, 0) });
});

module.exports = router;

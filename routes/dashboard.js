const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

router.get('/summary', (req, res) => {
  const counts = {
    employees: db.prepare(`SELECT COUNT(*) c FROM employees WHERE status='active'`).get().c,
    projects_active: db.prepare(`SELECT COUNT(*) c FROM projects WHERE status != 'Completed'`).get().c,
    open_leads: db.prepare(`SELECT COUNT(*) c FROM leads WHERE stage NOT IN ('Won','Lost')`).get().c,
    pending_expense_vouchers: db.prepare(`SELECT COUNT(*) c FROM expense_vouchers WHERE status='Pending'`).get().c,
    pending_leave: db.prepare(`SELECT COUNT(*) c FROM leave_requests WHERE status='Pending'`).get().c,
    pending_purchase_requests: db.prepare(`SELECT COUNT(*) c FROM purchase_requests WHERE status='Pending'`).get().c,
    low_stock_items: db.prepare(`SELECT COUNT(*) c FROM items WHERE current_stock <= reorder_level`).get().c,
    open_service_requests: db.prepare(`SELECT COUNT(*) c FROM service_requests WHERE status NOT IN ('Resolved','Closed')`).get().c,
  };
  const expenseByMode = db.prepare(`
    SELECT payment_mode, accounted, SUM(amount) as total FROM expense_vouchers WHERE status != 'Rejected' GROUP BY payment_mode, accounted
  `).all();
  res.json({ counts, expenseByMode });
});

// ===================== Round 3: project drill-down =====================
router.get('/project/:id/drilldown', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  // Excluded (NotApplicable) stages are hidden entirely from this drilldown
  // - a bought-out/trading order's progress bar shouldn't be dragged down by
  // stages it was never going to use in the first place.
  const topLevel = db.prepare(`SELECT * FROM job_cards WHERE project_id = ? AND parent_job_card_id IS NULL AND status != 'NotApplicable' ORDER BY COALESCE(sequence, id)`).all(project.id);
  const overallProgress = topLevel.length ? Math.round(100 * topLevel.filter(c => c.status === 'Completed').length / topLevel.length) : 0;
  const departments = topLevel.map(c => {
    const children = db.prepare(`SELECT * FROM job_cards WHERE parent_job_card_id = ? AND status != 'NotApplicable' ORDER BY COALESCE(sequence, id)`).all(c.id);
    const subProcesses = children.map(ch => ({ id: ch.id, stage: ch.stage, title: ch.title, status: ch.status }));
    const deptProgress = children.length
      ? Math.round(100 * children.filter(ch => ch.status === 'Completed').length / children.length)
      : (c.status === 'Completed' ? 100 : (c.status === 'InProgress' ? 50 : 0));
    return { id: c.id, stage: c.stage, status: c.status, progress: deptProgress, subProcesses };
  });
  res.json({ project, overallProgress, departments });
});

// ===================== Round 3: window-based summary widgets =====================
// Extends the existing /summary payload with an optional ?window=daily|weekly|monthly
// aggregation for Inventory, Operating Expenses, and Upcoming Schedules.
router.get('/window-summary', (req, res) => {
  const win = req.query.window || 'weekly';
  const days = win === 'daily' ? 1 : win === 'monthly' ? 30 : 7;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  const stockIn = db.prepare(`SELECT COALESCE(SUM(quantity),0) as total FROM stock_movements WHERE movement_type='IN' AND moved_at >= ?`).get(since).total;
  const stockOut = db.prepare(`SELECT COALESCE(SUM(quantity),0) as total FROM stock_movements WHERE movement_type='OUT' AND moved_at >= ?`).get(since).total;

  const opex = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM finance_ledger WHERE type='Expense' AND entry_date >= ?`).get(since).total;

  const upcomingJobCards = db.prepare(`
    SELECT jc.id, jc.stage, jc.title, jc.planned_start, jc.planned_end, p.project_code
    FROM job_cards jc JOIN projects p ON p.id = jc.project_id
    WHERE jc.status != 'NotApplicable' AND ((jc.planned_start BETWEEN ? AND ?) OR (jc.planned_end BETWEEN ? AND ?))
    ORDER BY jc.planned_start LIMIT 50
  `).all(today(), until, today(), until);
  const upcomingService = db.prepare(`
    SELECT id, sr_no, scheduled_date, issue_description FROM service_requests
    WHERE scheduled_date BETWEEN ? AND ? ORDER BY scheduled_date LIMIT 50
  `).all(today(), until);

  res.json({ window: win, stockIn, stockOut, opex, upcomingJobCards, upcomingService });
});
function today() { return new Date().toISOString().slice(0, 10); }

// Per-user, per-page panel order (drag-to-reorder) - see db/schema.sql's
// user_page_layout comment. Originally Dashboard-only (page_key was
// implicit); :pageKey now lets any page (Purchase Requests/Orders, Vendors,
// the Store & Inventory pages, ...) save its own independent order under
// the same account. null means "no saved layout yet for this page", which
// the frontend interprets as that page's own built-in default order.
router.get('/layout/:pageKey', (req, res) => {
  const row = db.prepare('SELECT panel_order FROM user_page_layout WHERE user_id = ? AND page_key = ?').get(req.user.id, req.params.pageKey);
  res.json({ panel_order: row ? JSON.parse(row.panel_order) : null });
});
router.put('/layout/:pageKey', (req, res) => {
  const order = req.body && req.body.panel_order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'panel_order must be a non-empty array.' });
  db.prepare(`
    INSERT INTO user_page_layout (user_id, page_key, panel_order, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, page_key) DO UPDATE SET panel_order = excluded.panel_order, updated_at = excluded.updated_at
  `).run(req.user.id, req.params.pageKey, JSON.stringify(order));
  res.json({ ok: true });
});
router.delete('/layout/:pageKey', (req, res) => {
  db.prepare('DELETE FROM user_page_layout WHERE user_id = ? AND page_key = ?').run(req.user.id, req.params.pageKey);
  res.json({ ok: true });
});

module.exports = router;

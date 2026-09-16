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
  const topLevel = db.prepare(`SELECT * FROM job_cards WHERE project_id = ? AND parent_job_card_id IS NULL ORDER BY COALESCE(sequence, id)`).all(project.id);
  const overallProgress = topLevel.length ? Math.round(100 * topLevel.filter(c => c.status === 'Completed').length / topLevel.length) : 0;
  const departments = topLevel.map(c => {
    const children = db.prepare(`SELECT * FROM job_cards WHERE parent_job_card_id = ? ORDER BY COALESCE(sequence, id)`).all(c.id);
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
    WHERE (jc.planned_start BETWEEN ? AND ?) OR (jc.planned_end BETWEEN ? AND ?)
    ORDER BY jc.planned_start LIMIT 50
  `).all(today(), until, today(), until);
  const upcomingService = db.prepare(`
    SELECT id, sr_no, scheduled_date, issue_description FROM service_requests
    WHERE scheduled_date BETWEEN ? AND ? ORDER BY scheduled_date LIMIT 50
  `).all(today(), until);

  res.json({ window: win, stockIn, stockOut, opex, upcomingJobCards, upcomingService });
});
function today() { return new Date().toISOString().slice(0, 10); }

module.exports = router;

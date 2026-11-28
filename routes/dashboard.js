const express = require('express');
const { db } = require('../db');
const { authRequired, hasPermission } = require('../middleware/auth');
const { localDateStr } = require('../lib/dateUtil');
const { SO_CLOSED_SQL } = require('../lib/soItems');
const router = express.Router();
router.use(authRequired);

// Rows a drill-down list shows; the totals above it are always exact, and the response says how many rows exist.
const DRILL_LIMIT = 100;
// Expense figures are finance data: a role that cannot open the Expense Vouchers list gets null / [] (same keys, no value)
// instead of a number whose drill-down would 403.
const EXPENSE_VOUCHER_PERM = 'expense_voucher.view_all';
const OPEX_PERMS = ['report.view_all', 'expense_voucher.view_all'];

router.get('/summary', (req, res) => {
  const canExpenseVouchers = hasPermission(req.user, EXPENSE_VOUCHER_PERM);
  const counts = {
    employees: db.prepare(`SELECT COUNT(*) c FROM employees WHERE status='active'`).get().c,
    // A project already fully Dispatched (not just PendingApproval, and not a
    // Cancelled/Rejected dispatch attempt) has physically shipped - it no
    // longer belongs in "Active Projects" even if some other department's
    // job card hasn't yet been marked Completed. A project whose Sales Order is
    // Cancelled / Completed / Dispatched is not live work either (GET /projects flags it as order_closed).
    projects_active: db.prepare(`
      SELECT COUNT(*) c FROM projects p
      WHERE p.status != 'Completed'
        AND NOT EXISTS (
          SELECT 1 FROM fg_dispatches fd
          WHERE fd.sales_order_id = p.sales_order_id AND fd.status = 'Dispatched'
        )
        AND NOT EXISTS (
          SELECT 1 FROM sales_orders so WHERE so.id = p.sales_order_id AND so.status IN (${SO_CLOSED_SQL})
        )
    `).get().c,
    open_leads: db.prepare(`SELECT COUNT(*) c FROM leads WHERE stage NOT IN ('Won','Lost')`).get().c,
    pending_expense_vouchers: canExpenseVouchers ? db.prepare(`SELECT COUNT(*) c FROM expense_vouchers WHERE status='Pending'`).get().c : null,
    pending_leave: db.prepare(`SELECT COUNT(*) c FROM leave_requests WHERE status='Pending'`).get().c,
    pending_purchase_requests: db.prepare(`SELECT COUNT(*) c FROM purchase_requests WHERE status='Pending'`).get().c,
    low_stock_items: db.prepare(`SELECT COUNT(*) c FROM items WHERE current_stock <= reorder_level`).get().c,
    // Rejected is a terminal, closed-out state same as Resolved/Closed - it
    // was missing from this exclusion list, so a rejected SR kept counting
    // as "open" indefinitely.
    open_service_requests: db.prepare(`SELECT COUNT(*) c FROM service_requests WHERE status NOT IN ('Resolved','Closed','Rejected')`).get().c,
  };
  const expenseByMode = canExpenseVouchers ? db.prepare(`
    SELECT payment_mode, accounted, SUM(amount) as total FROM expense_vouchers WHERE status != 'Rejected' GROUP BY payment_mode, accounted
  `).all() : [];
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
// ?window=daily|weekly|monthly -> exactly Today / the last 7 days / the last 30 days, calendar days in IST and inclusive of today
// (the old since = now - N days made them 2 / 8 / 31 days). The response carries since/today so a drill-down can ask for the
// very same range.
const WINDOWS = { daily: { days: 1, label: 'Today' }, weekly: { days: 7, label: 'Last 7 days' }, monthly: { days: 30, label: 'Last 30 days' } };
router.get('/window-summary', (req, res) => {
  const win = WINDOWS[req.query.window] ? req.query.window : 'weekly';
  const { days, label } = WINDOWS[win];
  const todayStr = today();
  const since = localDateStr(new Date(Date.now() - (days - 1) * 86400000));
  const until = localDateStr(new Date(Date.now() + (days - 1) * 86400000));

  const stock = (type) => db.prepare(`
    SELECT COALESCE(SUM(quantity),0) as total, COUNT(*) as n FROM stock_movements
    WHERE movement_type = ? AND date(moved_at) BETWEEN ? AND ?
  `).get(type, since, todayStr);
  const stockIn = stock('IN'), stockOut = stock('OUT');

  // The Operating Expenses page's own table. (The ledger mirrors each row as type 'OperatingExpense'; the 'Expense' type this
  // tile used to sum has not been written since vouchers were folded into Operating Expenses, so it always read 0.)
  let opex = null, opexCount = null, opexRows = [];
  if (hasPermission(req.user, ...OPEX_PERMS)) {
    const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as n FROM operating_expenses WHERE substr(expense_date, 1, 10) BETWEEN ? AND ?`).get(since, todayStr);
    opex = r.total; opexCount = r.n;
    opexRows = db.prepare(`
      SELECT id, expense_date, category, description, amount, paid_via FROM operating_expenses
      WHERE substr(expense_date, 1, 10) BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC LIMIT ${DRILL_LIMIT}
    `).all(since, todayStr);
  }

  // Both lists are genuinely "what's coming up / needs action" widgets, not
  // a full history - a job card already Completed, or a service request
  // already Resolved/Closed/Rejected, still carries whatever planned/
  // scheduled date it was ever given, so without excluding terminal
  // statuses a finished item kept reappearing here through its own old
  // date, indistinguishable from something genuinely still pending. Job cards of a
  // Cancelled / Completed / Dispatched Sales Order are not coming up either.
  const jcWhere = `
    FROM job_cards jc JOIN projects p ON p.id = jc.project_id LEFT JOIN sales_orders so ON so.id = p.sales_order_id
    WHERE jc.status NOT IN ('NotApplicable', 'Completed') AND COALESCE(so.status, '') NOT IN (${SO_CLOSED_SQL})
      AND ((jc.planned_start BETWEEN ? AND ?) OR (jc.planned_end BETWEEN ? AND ?))`;
  const upcomingJobCards = db.prepare(`
    SELECT jc.id, jc.stage, jc.title, jc.planned_start, jc.planned_end, p.project_code ${jcWhere}
    ORDER BY jc.planned_start LIMIT 50
  `).all(todayStr, until, todayStr, until);
  const upcomingJobCardsTotal = db.prepare(`SELECT COUNT(*) as n ${jcWhere}`).get(todayStr, until, todayStr, until).n;
  const svcWhere = `FROM service_requests WHERE status NOT IN ('Resolved', 'Closed', 'Rejected') AND scheduled_date BETWEEN ? AND ?`;
  const upcomingService = db.prepare(`SELECT id, sr_no, scheduled_date, issue_description ${svcWhere} ORDER BY scheduled_date LIMIT 50`).all(todayStr, until);
  const upcomingServiceTotal = db.prepare(`SELECT COUNT(*) as n ${svcWhere}`).get(todayStr, until).n;

  res.json({
    window: win, window_label: label, since, today: todayStr, until,
    stockIn: stockIn.total, stockOut: stockOut.total, stockInCount: stockIn.n, stockOutCount: stockOut.n,
    opex, opexCount, opexRows,
    upcomingJobCards, upcomingJobCardsTotal, upcomingService, upcomingServiceTotal,
  });
});
function today() { return localDateStr(); }

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
    INSERT INTO user_page_layout (user_id, page_key, panel_order, updated_at) VALUES (?, ?, ?, (datetime('now','localtime')))
    ON CONFLICT(user_id, page_key) DO UPDATE SET panel_order = excluded.panel_order, updated_at = excluded.updated_at
  `).run(req.user.id, req.params.pageKey, JSON.stringify(order));
  res.json({ ok: true });
});
router.delete('/layout/:pageKey', (req, res) => {
  db.prepare('DELETE FROM user_page_layout WHERE user_id = ? AND page_key = ?').run(req.user.id, req.params.pageKey);
  res.json({ ok: true });
});

module.exports = router;

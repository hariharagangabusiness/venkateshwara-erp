const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const approvalsLib = require('../lib/approvals');
const router = express.Router();
router.use(authRequired);

// Human-readable summary + department, so "My Approvals" can group by
// category/department instead of a bare entity id.
function describeEntity(entityType, entityId) {
  switch (entityType) {
    case 'expense_voucher': {
      const r = db.prepare(`
        SELECT ev.voucher_no as ref, ev.description, d.name as department_name, u.full_name as raised_by_name
        FROM expense_vouchers ev LEFT JOIN departments d ON d.id = ev.department_id LEFT JOIN users u ON u.id = ev.raised_by
        WHERE ev.id = ?`).get(entityId);
      if (!r) return {};
      return { ref: r.ref, summary: r.description || 'Expense voucher', department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'leave_request': {
      const r = db.prepare(`
        SELECT lr.id as ref, e.full_name as raised_by_name, d.name as department_name, lt.name as leave_type_name
        FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.id = ?`).get(entityId);
      if (!r) return {};
      return { ref: 'LR-' + r.ref, summary: (r.leave_type_name || 'Leave') + ' request', department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'purchase_request': {
      const r = db.prepare(`
        SELECT pr.pr_no as ref, i.name as item_name, u.full_name as raised_by_name, d.name as department_name
        FROM purchase_requests pr LEFT JOIN items i ON i.id = pr.item_id LEFT JOIN users u ON u.id = pr.raised_by
        LEFT JOIN departments d ON d.id = u.department_id WHERE pr.id = ?`).get(entityId);
      if (!r) return {};
      return { ref: r.ref, summary: r.item_name || 'Purchase request', department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'salary_advance': {
      const r = db.prepare(`
        SELECT sa.id as ref, e.full_name as raised_by_name, d.name as department_name
        FROM salary_advances sa JOIN employees e ON e.id = sa.employee_id LEFT JOIN departments d ON d.id = e.department_id
        WHERE sa.id = ?`).get(entityId);
      if (!r) return {};
      return { ref: 'SA-' + r.ref, summary: 'Salary advance', department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'salary_schedule': {
      return { ref: 'PR-' + entityId, summary: 'Payroll run', department_name: null, raised_by_name: null };
    }
    default:
      return {};
  }
}

// List approvals pending for the current user's role, grouped by category
// (the approval chain, e.g. "Purchase Request Approval") and, within that,
// the requester's department - so a role that approves several kinds of
// request (Admin, Management) can see at a glance what's waiting and why.
router.get('/pending', (req, res) => {
  const pending = approvalsLib.pendingForUser(req.user);
  const enriched = pending.map(a => {
    const chain = db.prepare('SELECT name, description FROM approval_chains WHERE id = ?').get(a.chain_id);
    const detail = describeEntity(a.entity_type, a.entity_id);
    return { ...a, chain_name: chain.name, chain_description: chain.description, ...detail };
  });
  res.json(enriched);
});

router.get('/:id/history', (req, res) => {
  const actions = db.prepare(`
    SELECT aa.*, u.full_name as actor_name FROM approval_actions aa
    LEFT JOIN users u ON u.id = aa.actor_user_id
    WHERE aa.approval_id = ? ORDER BY aa.acted_at
  `).all(req.params.id);
  res.json(actions);
});

function syncEntityStatus(entityType, entityId, result) {
  const map = {
    expense_voucher: { table: 'expense_vouchers', approved: 'Approved', rejected: 'Rejected' },
    leave_request: { table: 'leave_requests', approved: 'Approved', rejected: 'Rejected' },
    purchase_request: { table: 'purchase_requests', approved: 'Approved', rejected: 'Rejected' },
    salary_advance: { table: 'salary_advances', approved: 'Approved', rejected: 'Rejected' },
    salary_schedule: { table: 'salary_schedule', approved: 'Approved', rejected: 'Draft' },
  };
  const m = map[entityType];
  if (!m) return;
  if (result === 'Approved') {
    db.prepare(`UPDATE ${m.table} SET status = ? WHERE id = ?`).run(m.approved, entityId);
  } else if (result === 'Rejected') {
    db.prepare(`UPDATE ${m.table} SET status = ? WHERE id = ?`).run(m.rejected, entityId);
  }
}

router.post('/:id/act', (req, res) => {
  const { action, comment } = req.body; // action: 'Approved' | 'Rejected'
  try {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Not found' });
    const result = approvalsLib.act(req.params.id, req.user, action, comment);
    if (result === 'Approved' || result === 'Rejected') {
      syncEntityStatus(approval.entity_type, approval.entity_id, result);
    }
    db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)`)
      .run(req.user.id, 'approval_action:' + action, approval.entity_type, approval.entity_id, comment || null);
    res.json({ status: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;

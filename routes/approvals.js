const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const approvalsLib = require('../lib/approvals');
const { departmentIdsUnderNode } = require('../lib/orgHierarchy');
const router = express.Router();
router.use(authRequired);

// Same "Admin bypasses everything, else check role_permissions" rule as
// middleware/auth.js's requirePermission, but usable inline against an
// arbitrary user object while building the aggregated queue below, rather
// than gating an entire route.
function userHasPermission(user, ...codes) {
  if (user.role_name === 'Admin') return true;
  const rows = db.prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?
  `).all(user.role_id);
  const granted = new Set(rows.map(r => r.code));
  return codes.some(c => granted.has(c));
}

// Human-readable summary + department, so "My Approvals" can group by
// category/department instead of a bare entity id. department_id (distinct
// from department_name) is kept so the org-hierarchy filter below can match
// on it without a second lookup.
function describeEntity(entityType, entityId) {
  switch (entityType) {
    case 'expense_voucher': {
      const r = db.prepare(`
        SELECT ev.voucher_no as ref, ev.description, ev.department_id as department_id, d.name as department_name, u.full_name as raised_by_name
        FROM expense_vouchers ev LEFT JOIN departments d ON d.id = ev.department_id LEFT JOIN users u ON u.id = ev.raised_by
        WHERE ev.id = ?`).get(entityId);
      if (!r) return {};
      return { ref: r.ref, summary: r.description || 'Expense voucher', department_id: r.department_id, department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'leave_request': {
      const r = db.prepare(`
        SELECT lr.id as ref, e.full_name as raised_by_name, e.department_id as department_id, d.name as department_name, lt.name as leave_type_name
        FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.id = ?`).get(entityId);
      if (!r) return {};
      return { ref: 'LR-' + r.ref, summary: (r.leave_type_name || 'Leave') + ' request', department_id: r.department_id, department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'purchase_request': {
      const r = db.prepare(`
        SELECT pr.pr_no as ref, u.full_name as raised_by_name, u.department_id as department_id, d.name as department_name
        FROM purchase_requests pr LEFT JOIN users u ON u.id = pr.raised_by
        LEFT JOIN departments d ON d.id = u.department_id WHERE pr.id = ?`).get(entityId);
      if (!r) return {};
      const lines = db.prepare(`
        SELECT COALESCE(i.name, pri.item_text) as name FROM purchase_request_items pri
        LEFT JOIN items i ON i.id = pri.item_id WHERE pri.purchase_request_id = ? ORDER BY pri.sort_order, pri.id
      `).all(entityId);
      const summary = lines.length > 1 ? `${lines[0].name || 'Item'} +${lines.length - 1} more` : ((lines[0] && lines[0].name) || 'Purchase request');
      return { ref: r.ref, summary, department_id: r.department_id, department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'salary_advance': {
      const r = db.prepare(`
        SELECT sa.id as ref, e.full_name as raised_by_name, e.department_id as department_id, d.name as department_name
        FROM salary_advances sa JOIN employees e ON e.id = sa.employee_id LEFT JOIN departments d ON d.id = e.department_id
        WHERE sa.id = ?`).get(entityId);
      if (!r) return {};
      return { ref: 'SA-' + r.ref, summary: 'Salary advance', department_id: r.department_id, department_name: r.department_name, raised_by_name: r.raised_by_name };
    }
    case 'salary_schedule': {
      return { ref: 'PR-' + entityId, summary: 'Payroll run', department_id: null, department_name: null, raised_by_name: null };
    }
    default:
      return {};
  }
}

// ---- Centralized queue aggregation ----
// Four independent gates in this ERP feed a person "things waiting on you":
// the formal approval_chains/approvals mechanism (expense vouchers, leave,
// purchase requests, salary advances, payroll runs), FOC material requests
// (their own Pending/Approved/Rejected/Issued status, gated on foc.approve),
// BG expiry/claim reminders needing internal verification (bg_reminder_log,
// gated on bg.manage), and BG claim-expiry Finance-HOD To-Dos (assigned
// directly to a person, not role-gated). None of these share a table, so
// this normalizes all four into one shape the "My Approvals" page can
// render as a single queue instead of four separate screens.
//
// Sales Orders have no credit-limit or approval gate anywhere in this
// codebase today, so - deliberately - nothing is fabricated for them here;
// that gap is real and belongs on the roadmap, not invented as a fake queue.
function unifiedQueueForUser(user) {
  const items = [];

  approvalsLib.pendingForUser(user).forEach(a => {
    const chain = db.prepare('SELECT name, description FROM approval_chains WHERE id = ?').get(a.chain_id);
    const detail = describeEntity(a.entity_type, a.entity_id);
    items.push({
      source: 'ApprovalChain', id: a.id, entity_type: a.entity_type, entity_id: a.entity_id,
      chain_name: chain.name, chain_description: chain.description, amount: a.amount,
      current_step: a.current_step, created_at: a.created_at, ...detail,
    });
  });

  if (userHasPermission(user, 'foc.approve')) {
    db.prepare(`
      SELECT f.id, f.foc_no, f.item_description, f.estimated_value, f.department_id, f.created_at,
        d.name as department_name, u.full_name as raised_by_name
      FROM foc_requests f LEFT JOIN departments d ON d.id = f.department_id LEFT JOIN users u ON u.id = f.requested_by
      WHERE f.status = 'Pending'
    `).all().forEach(r => {
      items.push({
        source: 'FOC', id: r.id, entity_type: 'foc_request', entity_id: r.id,
        chain_name: 'FOC Material Requests', chain_description: 'Free-of-cost material issue requests',
        ref: r.foc_no, summary: r.item_description || 'FOC material request', amount: r.estimated_value,
        department_id: r.department_id, department_name: r.department_name, raised_by_name: r.raised_by_name,
        current_step: null, created_at: r.created_at,
      });
    });
  }

  if (userHasPermission(user, 'bg.manage')) {
    db.prepare(`
      SELECT rl.id, rl.trigger_reason, rl.triggered_at, bg.bg_no, bg.bg_type, bg.value
      FROM bg_reminder_log rl JOIN bank_guarantees bg ON bg.id = rl.bg_id
      WHERE rl.status = 'PendingReview'
    `).all().forEach(r => {
      items.push({
        source: 'BGReminder', id: r.id, entity_type: 'bg_reminder_log', entity_id: r.id,
        chain_name: 'Bank Guarantee Reminders', chain_description: 'BG expiry/claim alerts awaiting internal verification',
        ref: r.bg_no, summary: `${r.trigger_reason} - ${r.bg_type} BG`, amount: r.value,
        department_id: null, department_name: null, raised_by_name: null,
        current_step: null, created_at: r.triggered_at,
      });
    });
  }

  db.prepare(`
    SELECT t.id, t.brief_description, t.target_date, t.created_at, h.full_name as hod_name
    FROM todos t LEFT JOIN users h ON h.id = t.hod_id
    WHERE t.source_type = 'BG_CLAIM_EXPIRY' AND t.status != 'Completed' AND t.assigned_to = ?
  `).all(user.id).forEach(r => {
    items.push({
      source: 'BGClaimTask', id: r.id, entity_type: 'todo', entity_id: r.id,
      chain_name: 'BG Claim Tasks', chain_description: 'BG claim-expiry follow-ups assigned to you',
      ref: 'TODO-' + r.id, summary: r.brief_description, amount: null,
      department_id: null, department_name: null, raised_by_name: r.hod_name,
      current_step: null, created_at: r.created_at, target_date: r.target_date,
    });
  });

  return items;
}

// List everything pending on the current user, across every module that
// gates on approval - optionally scoped to one part of the org hierarchy.
// Items with no natural department (salary_advance/salary_schedule, BG
// items) always pass an org filter rather than being hidden incorrectly.
router.get('/pending', (req, res) => {
  let items = unifiedQueueForUser(req.user);
  if (req.query.org_node_id) {
    const deptIds = new Set(departmentIdsUnderNode(req.query.org_node_id));
    items = items.filter(i => i.department_id == null || deptIds.has(i.department_id));
  }
  res.json(items);
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

// ---- Diagnostics ----
// Per-entity-type SLA, in days, before a Pending item counts as "stale" -
// rough targets a Finance/Management reviewer would recognize (leave moves
// fastest since it blocks someone's calendar, payroll/purchase are the
// slowest since they usually need supporting paperwork first).
const SLA_DAYS = {
  expense_voucher: 3, leave_request: 2, purchase_request: 5, salary_advance: 3,
  salary_schedule: 5, foc_request: 3, bg_reminder_log: 2,
};
const ENTITY_TABLE = {
  expense_voucher: 'expense_vouchers', leave_request: 'leave_requests', purchase_request: 'purchase_requests',
  salary_advance: 'salary_advances', salary_schedule: 'salary_schedule',
};
function ageDays(isoTs) {
  return (Date.now() - new Date(isoTs).getTime()) / 86400000;
}

// Queue health check: how many items are waiting in each source, which ones
// have sat past their SLA, and any approvals row left pointing at a record
// that no longer exists (deleted out from under it, or a data-import glitch)
// so those don't silently disappear from every user's queue forever.
router.get('/check', requirePermission('report.view_all'), (req, res) => {
  const allApprovals = db.prepare(`SELECT * FROM approvals WHERE status = 'Pending'`).all();
  const focPending = db.prepare(`SELECT * FROM foc_requests WHERE status = 'Pending'`).all();
  const bgPending = db.prepare(`SELECT * FROM bg_reminder_log WHERE status = 'PendingReview'`).all();
  const bgClaimTasks = db.prepare(`SELECT * FROM todos WHERE source_type = 'BG_CLAIM_EXPIRY' AND status != 'Completed'`).all();

  const queue_counts = {
    ApprovalChain: allApprovals.length, FOC: focPending.length,
    BGReminder: bgPending.length, BGClaimTask: bgClaimTasks.length,
    total: allApprovals.length + focPending.length + bgPending.length + bgClaimTasks.length,
  };

  const stale_items = [];
  allApprovals.forEach(a => {
    const sla = SLA_DAYS[a.entity_type];
    const age = ageDays(a.created_at);
    if (sla && age > sla) {
      stale_items.push({ source: 'ApprovalChain', entity_type: a.entity_type, entity_id: a.entity_id, age_days: Math.round(age * 10) / 10, sla_days: sla });
    }
  });
  focPending.forEach(f => {
    const age = ageDays(f.created_at);
    if (age > SLA_DAYS.foc_request) stale_items.push({ source: 'FOC', entity_type: 'foc_request', entity_id: f.id, age_days: Math.round(age * 10) / 10, sla_days: SLA_DAYS.foc_request });
  });
  bgPending.forEach(r => {
    const age = ageDays(r.triggered_at);
    if (age > SLA_DAYS.bg_reminder_log) stale_items.push({ source: 'BGReminder', entity_type: 'bg_reminder_log', entity_id: r.id, age_days: Math.round(age * 10) / 10, sla_days: SLA_DAYS.bg_reminder_log });
  });
  bgClaimTasks.forEach(t => {
    if (t.target_date && new Date(t.target_date) < new Date()) {
      stale_items.push({ source: 'BGClaimTask', entity_type: 'todo', entity_id: t.id, age_days: Math.round(ageDays(t.target_date) * 10) / 10, sla_days: 0 });
    }
  });

  const orphaned = [];
  allApprovals.forEach(a => {
    const table = ENTITY_TABLE[a.entity_type];
    if (!table) return; // unknown entity_type - not our concern here, not an orphan
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(a.entity_id);
    if (!row) orphaned.push({ entity_type: a.entity_type, entity_id: a.entity_id, approval_id: a.id });
  });

  res.json({ queue_counts, stale_items, orphaned });
});

module.exports = router;

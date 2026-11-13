// Weekly, department-wise summary of every approval still sitting Pending at
// its current step (2026-11-13) - a separate email from the per-item
// "awaiting your approval" notification (lib/approvals.js) and the 24h/12h
// escalation reminder (lib/approvalEscalationScan.js), which both keep
// firing on their own, unrelated cadence. This is the ONE email in the
// whole approval-notification family that still carries the Company
// Settings Email Settings CC list (sendMail() is called with no
// `skipDefaultCc`, unlike every other call site touched by this round) -
// per the owner's own locked framing, the CC list "moved" here from the
// per-item escalation email rather than being dropped outright.
//
// Design, locked by the repo owner (2026-11-13):
// - One email per approving DEPARTMENT, never a combined cross-department
//   mail - "department" = the role name an approval's current step routes
//   to (approval_chain_steps.approver_role_id -> roles.name), the same
//   role/supervisor match canAct()/notifyNewPendingStep() already use, so a
//   department's digest can never show an item nobody in that department
//   could actually act on in My Approvals.
// - Addressed to the department's own approver(s) on record for that role -
//   if any of the department's chain steps are supervisor-gated
//   (requires_supervisor=1), only that department's supervisor(s)/HOD
//   qualify; otherwise every active user holding that role does, mirroring
//   exactly who'd already receive the per-item "awaiting approval" email
//   for an item routed to that role.
// - 3 age buckets (days since the item's current step started,
//   approvals.step_started_at), Admin-editable cutoffs via
//   lib/settings.js's weekly_digest settings (default 0-3 green / 4-7 amber
//   / 8+ red).
// - Schedule: Admin-configurable day-of-week + hour, server-local time (this
//   app has no per-user timezone concept anywhere else either) - checked
//   hourly by server.js's own timer; this module itself decides whether
//   it's actually due, so the timer's own interval doesn't need to match
//   the configured hour exactly.
// - A department with zero pending items still gets a short "all clear"
//   email (explicit owner choice) - so the digest's continued operation
//   stays visible on a quiet week instead of silently looking stopped.
const { db } = require('../db');
const { qualifyingSteps, resolveEntityRef } = require('./approvals');
const { getWeeklyDigestSettings, setWeeklyDigestSettings } = require('./settings');

const ENTITY_LABELS = {
  expense_voucher: 'Expense Voucher', leave_request: 'Leave Request', purchase_request: 'Purchase Request',
  salary_advance: 'Salary Advance', salary_schedule: 'Salary Schedule', foreign_payment: 'Foreign Payment Request',
  purchase_order: 'Purchase Order', purchase_invoice: 'Purchase Invoice (Vendor Bill)',
  referral_incentive: 'Referral Incentive', salary_hike_cycle: 'Salary Hike Cycle', fg_dispatch: 'FG Dispatch',
  sale_rejection_mrn: 'Sale Rejection MRN', service_request: 'Service Request (Inbound Email)',
  grn_reconciliation: 'GRN Reconciliation (Store)', todo: 'To-Do Completion',
};

const BUCKETS = {
  green: { bg: '#e4f6ea', fg: '#1e7a42', dot: '#2fa360' },
  amber: { bg: '#fff4e0', fg: '#92600b', dot: '#e8980f' },
  red: { bg: '#fde6e6', fg: '#a32020', dot: '#d6372f' },
};

function bucketFor(ageDays, cutoffs) {
  if (ageDays <= cutoffs.bucket1_max_days) return 'green';
  if (ageDays <= cutoffs.bucket2_max_days) return 'amber';
  return 'red';
}

function ageDaysOf(approval) {
  const started = approval.step_started_at ? approval.step_started_at.replace(' ', 'T') + 'Z' : approval.created_at.replace(' ', 'T') + 'Z';
  return Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 86400000));
}

// Every (role_id, department name) a real approval_chain_steps row ever
// routes to - the full universe of "departments that could have pending
// approvals", independent of whether any currently do (needed for the
// all-clear case).
function allApprovingDepartments() {
  return db.prepare(`
    SELECT DISTINCT r.id as role_id, r.name as dept_name
    FROM approval_chain_steps s JOIN roles r ON r.id = s.approver_role_id
    ORDER BY r.name
  `).all();
}

// Whoever would qualify to act on ANY of this role's chain steps - if at
// least one step for this role is open to every role-holder
// (requires_supervisor=0), every active user of that role qualifies;
// otherwise (every step for this role is supervisor-gated) only that
// role's supervisor(s)/HOD do. Mirrors the real per-step gate
// (canAct()/notifyNewPendingStep()) rather than inventing a separate
// "the one HOD" concept a role might not actually have.
function recipientsForRole(roleId) {
  const steps = db.prepare('SELECT DISTINCT requires_supervisor FROM approval_chain_steps WHERE approver_role_id = ?').all(roleId);
  const anyOpenToWholeRole = steps.some(s => !s.requires_supervisor);
  let sql = `SELECT full_name, email FROM users WHERE role_id = ? AND is_active = 1 AND email IS NOT NULL AND email != ''`;
  if (!anyOpenToWholeRole) sql += ' AND is_supervisor = 1';
  return db.prepare(sql + ' ORDER BY id').all(roleId);
}

function pendingItemsForRole(roleId) {
  const pending = db.prepare(`SELECT * FROM approvals WHERE status = 'Pending'`).all();
  const out = [];
  for (const a of pending) {
    const steps = qualifyingSteps(a);
    const step = steps.find(s => s.step_order === a.current_step);
    if (step && step.approver_role_id === roleId) out.push(a);
  }
  return out;
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function legendHtml(cutoffs) {
  const chip = (key, label) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#5b6b7c;margin-right:16px;"><span style="width:9px;height:9px;border-radius:50%;background:${BUCKETS[key].dot};display:inline-block;"></span>${esc(label)}</span>`;
  return `<div style="margin:0 0 14px;">${chip('green', `0-${cutoffs.bucket1_max_days} days`)}${chip('amber', `${cutoffs.bucket1_max_days + 1}-${cutoffs.bucket2_max_days} days`)}${chip('red', `${cutoffs.bucket2_max_days + 1}+ days`)}</div>`;
}

function badgeHtml(bucket, ageDays) {
  const c = BUCKETS[bucket];
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;background:${c.bg};color:${c.fg};white-space:nowrap;"><span style="width:7px;height:7px;border-radius:50%;background:${c.dot};display:inline-block;"></span>${ageDays} day${ageDays === 1 ? '' : 's'}</span>`;
}

// Builds the full {{items_html}} payload for one department - the legend,
// the item table (or the all-clear message when there's nothing pending),
// sorted oldest-first so the items most in need of attention lead the list.
function buildItemsHtml(items, cutoffs) {
  if (!items.length) {
    return `<p style="margin:0;color:${BUCKETS.green.fg};">No items are currently pending in this department. Everything is caught up.</p>`;
  }
  const rows = items.map(a => {
    const ageDays = ageDaysOf(a);
    const bucket = bucketFor(ageDays, cutoffs);
    const label = ENTITY_LABELS[a.entity_type] || a.entity_type;
    const ref = resolveEntityRef(a.entity_type, a.entity_id) || ('#' + a.entity_id);
    const raisedBy = a.requested_by ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(a.requested_by) : null;
    return { ref, label, raisedBy: raisedBy ? raisedBy.full_name : '-', ageDays, bucket };
  }).sort((a, b) => b.ageDays - a.ageDays);
  const trs = rows.map(r => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #dde3ea;font-weight:600;">${esc(r.ref)}</td>
      <td style="padding:8px;border-bottom:1px solid #dde3ea;color:#5b6b7c;font-size:12px;">${esc(r.label)}</td>
      <td style="padding:8px;border-bottom:1px solid #dde3ea;">${esc(r.raisedBy)}</td>
      <td style="padding:8px;border-bottom:1px solid #dde3ea;">${badgeHtml(r.bucket, r.ageDays)}</td>
    </tr>`).join('');
  return `
    ${legendHtml(cutoffs)}
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:#5b6b7c;padding:0 8px 7px;border-bottom:1px solid #dde3ea;">Reference</th>
          <th style="text-align:left;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:#5b6b7c;padding:0 8px 7px;border-bottom:1px solid #dde3ea;">Type</th>
          <th style="text-align:left;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:#5b6b7c;padding:0 8px 7px;border-bottom:1px solid #dde3ea;">Raised by</th>
          <th style="text-align:left;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:#5b6b7c;padding:0 8px 7px;border-bottom:1px solid #dde3ea;">Age</th>
        </tr>
      </thead>
      <tbody>${trs}</tbody>
    </table>`;
}

// Runs the actual send for one department - split out from
// runWeeklyApprovalDigest() so both the real scheduled run and a future
// "send a test now" action can share it without duplicating the HTML build.
function sendDepartmentDigest(roleId, deptName, cutoffs) {
  const recipients = recipientsForRole(roleId);
  if (!recipients.length) return false; // nobody to send to - skip quietly
  const { sendMail } = require('./mailer');
  const { getEmailTemplate, renderTemplate } = require('./emailTemplates');
  const items = pendingItemsForRole(roleId);
  const itemsHtml = buildItemsHtml(items, cutoffs);
  const tpl = getEmailTemplate('weekly_approval_summary');
  const hodName = recipients.length === 1 ? recipients[0].full_name : 'Team';
  const { subject, body } = renderTemplate(tpl, {
    hod_name: hodName, department: deptName, total: String(items.length), items_html: itemsHtml,
  });
  const emails = recipients.map(r => r.email);
  // Deliberately no skipDefaultCc here - this is the one email in the
  // family that's meant to carry the Company Settings Email Settings CC
  // list (see this file's own header comment).
  sendMail({ to: emails[0], cc: emails.slice(1), subject, html: body }).catch(() => {});
  return true;
}

// Entry point called hourly by server.js. Decides for itself whether it's
// actually due (so the caller's own timer interval doesn't need to match
// the configured hour exactly) - pass { force: true } to send immediately
// regardless of schedule/last-sent guard (e.g. a future "send now" action).
function runWeeklyApprovalDigest(opts) {
  opts = opts || {};
  const cfg = getWeeklyDigestSettings();
  if (!cfg.enabled && !opts.force) return { sent: 0, skipped: 'disabled' };
  const now = new Date();
  if (!opts.force) {
    if (cfg.last_sent_at) {
      const daysSinceLast = (now.getTime() - new Date(cfg.last_sent_at).getTime()) / 86400000;
      if (daysSinceLast < 6) return { sent: 0, skipped: 'already sent this week' };
    }
    if (now.getDay() !== Number(cfg.day_of_week) || now.getHours() !== Number(cfg.hour)) {
      return { sent: 0, skipped: 'not the scheduled day/hour' };
    }
  }
  const cutoffs = { bucket1_max_days: Number(cfg.bucket1_max_days), bucket2_max_days: Number(cfg.bucket2_max_days) };
  let sent = 0;
  for (const { role_id, dept_name } of allApprovingDepartments()) {
    try {
      if (sendDepartmentDigest(role_id, dept_name, cutoffs)) sent++;
    } catch (e) { /* best-effort per department - one bad row never blocks the rest */ }
  }
  setWeeklyDigestSettings({ last_sent_at: now.toISOString() });
  return { sent };
}

module.exports = { runWeeklyApprovalDigest, allApprovingDepartments, recipientsForRole, pendingItemsForRole, buildItemsHtml, bucketFor, ageDaysOf };

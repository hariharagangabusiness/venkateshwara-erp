// Escalation reminder for an approval sitting un-acted at its current step
// too long (2026-11-02). Per the owner's locked spec: the FIRST "awaiting
// your approval" notification (lib/approvals.js's notifyNewPendingStep(),
// routes/approvals.js's notifyApproversPending()) never carries the Company
// Settings Email Settings CC list - but if nobody has acted within 24 hours,
// an escalation email fires (subject literally containing "Escalation",
// per the owner's own wording), WHICH DOES carry that CC list, and then
// repeats every 12 hours until the approval is no longer sitting Pending
// (moved to Approved/Rejected - an InfoRequested approval has already
// dropped out of the requester-visible queue and isn't "awaiting an
// approver" in the same sense, so it's excluded from escalation too).
//
// Reuses the exact approver-resolution shape every other notification
// chokepoint in this app already uses (role_id + optional is_supervisor),
// via lib/approvals.js's qualifyingSteps() so "who gets escalated to" can
// never drift from "who's actually allowed to act" (canAct()'s own logic).
//
// Follows this app's established "one lib/xScan.js module, called from
// server.js's shared 6-hourly runReminderScanSafely() timer" pattern (see
// lib/referralIncentiveScan.js, lib/foreignPaymentBoeScan.js, etc.) rather
// than its own separate timer.
const { db } = require('../db');
const { qualifyingSteps } = require('./approvals');

function hoursAgo(n) {
  return `datetime('now','-${n} hours')`;
}

function runApprovalEscalationScan() {
  const due = db.prepare(`
    SELECT * FROM approvals
    WHERE status = 'Pending'
      AND step_started_at IS NOT NULL
      AND step_started_at <= ${hoursAgo(24)}
      AND (last_escalated_at IS NULL OR last_escalated_at <= ${hoursAgo(12)})
  `).all();
  if (!due.length) return { escalated: 0 };

  const { sendMail } = require('./mailer');
  const { getEmailTemplate, renderTemplate } = require('./emailTemplates');
  // describeEntity() (routes/approvals.js) has the richer per-entity
  // ref/summary formatting but lives in a file that requires this one -
  // requiring it back here would risk a cycle, so this scan uses the same
  // lighter resolveEntityRef() fallback lib/approvals.js's own
  // notifyNewPendingStep() already relies on for exactly this reason.
  const { resolveEntityRef } = require('./approvals');

  let escalated = 0;
  for (const approval of due) {
    try {
      const steps = qualifyingSteps(approval);
      const step = steps.find(s => s.step_order === approval.current_step);
      if (!step) continue;
      let sql = `SELECT full_name, email FROM users WHERE role_id = ? AND is_active = 1 AND email IS NOT NULL AND email != ''`;
      const params = [step.approver_role_id];
      if (step.requires_supervisor) sql += ' AND is_supervisor = 1';
      const approvers = db.prepare(sql).all(...params);
      if (!approvers.length) continue;

      const label = approval.entity_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const realRef = resolveEntityRef(approval.entity_type, approval.entity_id);
      const ref = realRef ? realRef : '#' + approval.entity_id;
      const hoursPending = Math.floor((Date.now() - new Date(approval.step_started_at.replace(' ', 'T') + 'Z').getTime()) / 3600000);
      const tpl = getEmailTemplate('action_escalation');
      const approverName = approvers.length === 1 ? approvers[0].full_name : 'Team';
      const { subject, body } = renderTemplate(tpl, {
        approver_name: approverName,
        entity_label: label,
        ref,
        summary: '',
        hours_pending: String(hoursPending > 0 ? hoursPending : 24),
      });
      const emails = approvers.map(u => u.email);
      // Deliberately NOT passing skipDefaultCc - the escalation email DOES
      // get the global Email Settings CC list, the opposite of the normal
      // "awaiting your approval" notification.
      sendMail({ to: emails[0], cc: emails.slice(1), subject, text: body }).catch(() => {});
      db.prepare(`UPDATE approvals SET last_escalated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(approval.id);
      escalated++;
    } catch (e) { /* best-effort per-row - one bad row never blocks the rest of the scan */ }
  }
  return { escalated };
}

module.exports = { runApprovalEscalationScan };

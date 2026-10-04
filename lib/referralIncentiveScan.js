// Flips a referral_incentives row from 'PendingProbation' to 'Eligible' once
// the referred employee's probation_end_date has passed and they're still
// active - this is the ONLY thing this scan does; it deliberately does NOT
// also start the approval chain (that's an explicit HR action, see
// POST /referral-incentives/:id/submit-for-approval in routes/hr.js), so HR
// gets a chance to confirm the referral terms still hold before kicking off
// a payout approval. Forfeiture (referred employee exits before their own
// probation completes) is handled synchronously in routes/hr.js's employee
// PUT route the moment status changes, not here - waiting for this scan's
// next run would let a since-exited employee's incentive sit as
// "PendingProbation" or flip to "Eligible" for hours needlessly.
// Runs on the same 6-hourly timer as the BG/SOA/BOE scans (server.js).
const { db } = require('../db');

function today() { return new Date().toISOString().slice(0, 10); }

function hrHOD() {
  return db.prepare(`
    SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'HR' AND u.is_supervisor = 1 AND u.is_active = 1
    ORDER BY u.id LIMIT 1
  `).get();
}

// Best-effort heads-up to the HR HOD that a batch just became eligible -
// not a To-Do (nothing to action besides the normal "Submit for Approval"
// button on the Referral Incentives page), just a notification, same
// lightweight treatment other scans give a plain state change.
function notifyHodOfEligible(count) {
  const hod = hrHOD();
  if (!hod || !count) return;
  db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`)
    .run(hod.id, 'REFERRAL_INCENTIVE_ELIGIBLE', 0, `${count} referral incentive(s) became eligible for payout - review under Referral Incentives.`);
}

function runReferralIncentiveScan() {
  const rows = db.prepare(`
    SELECT ri.id FROM referral_incentives ri JOIN employees e ON e.id = ri.employee_id
    WHERE ri.status = 'PendingProbation' AND ri.probation_end_date IS NOT NULL AND ri.probation_end_date <= ? AND e.status = 'active'
  `).all(today());
  if (!rows.length) return 0;
  const update = db.prepare(`UPDATE referral_incentives SET status = 'Eligible' WHERE id = ?`);
  const tx = db.transaction(() => { rows.forEach(r => update.run(r.id)); });
  tx();
  notifyHodOfEligible(rows.length);
  return rows.length;
}

module.exports = { runReferralIncentiveScan };

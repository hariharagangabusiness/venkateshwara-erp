const { db } = require('../db');

// Start an approval workflow for an entity. Looks up the chain by name,
// filters steps whose min_amount <= amount, and creates an `approvals` row
// at step 1 (lowest qualifying step_order).
function startApproval(chainName, entityType, entityId, amount, requestedBy) {
  const chain = db.prepare('SELECT * FROM approval_chains WHERE name = ?').get(chainName);
  if (!chain) throw new Error('Unknown approval chain: ' + chainName);
  const steps = db.prepare(`
    SELECT * FROM approval_chain_steps WHERE chain_id = ? AND min_amount <= ?
    ORDER BY step_order ASC
  `).all(chain.id, amount || 0);
  if (steps.length === 0) {
    // No approval needed - auto approve
    const info = db.prepare(`
      INSERT INTO approvals (chain_id, entity_type, entity_id, amount, current_step, status, requested_by)
      VALUES (?, ?, ?, ?, 0, 'Approved', ?)
    `).run(chain.id, entityType, entityId, amount || 0, requestedBy);
    return info.lastInsertRowid;
  }
  const info = db.prepare(`
    INSERT INTO approvals (chain_id, entity_type, entity_id, amount, current_step, status, requested_by)
    VALUES (?, ?, ?, ?, ?, 'Pending', ?)
  `).run(chain.id, entityType, entityId, amount || 0, steps[0].step_order, requestedBy);
  return info.lastInsertRowid;
}

// Returns the qualifying steps (amount-filtered) for an approval's chain.
function qualifyingSteps(approval) {
  return db.prepare(`
    SELECT * FROM approval_chain_steps WHERE chain_id = ? AND min_amount <= ?
    ORDER BY step_order ASC
  `).all(approval.chain_id, approval.amount || 0);
}

function canAct(approval, user) {
  if (approval.status !== 'Pending') return false;
  const steps = qualifyingSteps(approval);
  const step = steps.find(s => s.step_order === approval.current_step);
  if (!step) return false;
  if (user.role_name === 'Admin') return true;
  if (user.role_id !== step.approver_role_id) return false;
  if (step.requires_supervisor && !user.is_supervisor) return false;
  return true;
}

function act(approvalId, user, action, comment) {
  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  if (!approval) throw new Error('Approval not found');
  if (!canAct(approval, user)) throw new Error('Not authorized to act on this approval at its current step');
  // A reviewer can pause the chain instead of approving/rejecting outright -
  // validated before anything is written, so a rejected (e.g. blank-note)
  // attempt never leaves a stray approval_actions row behind.
  if (action === 'InfoRequested' && (!comment || !comment.trim())) {
    throw new Error('Add a note describing what information is needed.');
  }

  db.prepare(`
    INSERT INTO approval_actions (approval_id, step_order, actor_user_id, action, comment)
    VALUES (?, ?, ?, ?, ?)
  `).run(approvalId, approval.current_step, user.id, action, comment || null);

  if (action === 'Rejected') {
    db.prepare(`UPDATE approvals SET status = 'Rejected' WHERE id = ?`).run(approvalId);
    return 'Rejected';
  }

  // The approval sits at its current step with status 'InfoRequested' (so it
  // drops out of pendingForUser() until the requester responds) rather than
  // moving forward or restarting the chain like a rejection does.
  if (action === 'InfoRequested') {
    db.prepare(`UPDATE approvals SET status = 'InfoRequested' WHERE id = ?`).run(approvalId);
    return 'InfoRequested';
  }

  const steps = qualifyingSteps(approval);
  const idx = steps.findIndex(s => s.step_order === approval.current_step);
  const next = steps[idx + 1];
  if (next) {
    db.prepare(`UPDATE approvals SET current_step = ? WHERE id = ?`).run(next.step_order, approvalId);
    return 'Pending';
  } else {
    db.prepare(`UPDATE approvals SET status = 'Approved' WHERE id = ?`).run(approvalId);
    return 'Approved';
  }
}

// The original requester answers a reviewer's InfoRequested note - resumes
// the SAME approval at the SAME step (unlike a rejection, which needs a
// brand new approval to be restarted from step 1), so it reappears in
// pendingForUser() for whoever had paused it.
function provideMoreInfo(approvalId, user, comment) {
  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  if (!approval) throw new Error('Approval not found');
  if (approval.status !== 'InfoRequested') throw new Error('This request is not awaiting more information.');
  if (approval.requested_by !== user.id && user.role_name !== 'Admin') {
    throw new Error('Only the original requester can respond to this.');
  }
  db.prepare(`
    INSERT INTO approval_actions (approval_id, step_order, actor_user_id, action, comment)
    VALUES (?, ?, ?, 'InfoProvided', ?)
  `).run(approvalId, approval.current_step, user.id, comment || null);
  db.prepare(`UPDATE approvals SET status = 'Pending' WHERE id = ?`).run(approvalId);
}

// List approvals currently awaiting action from this user's role
function pendingForUser(user) {
  const all = db.prepare(`SELECT * FROM approvals WHERE status = 'Pending'`).all();
  return all.filter(a => canAct(a, user));
}

module.exports = { startApproval, act, provideMoreInfo, canAct, pendingForUser, qualifyingSteps };

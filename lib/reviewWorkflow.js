const { db } = require('../db');

// Shared Draft -> PendingApproval -> Approved/Rejected state machine for
// both order_confirmations and annexure_reviews (see db/index.js Round 28) -
// they're structurally identical review-then-lock workflows, so the
// transition logic lives once here. `table` is always a fixed literal
// passed by the calling route, never user input - same pattern already
// used by routes/offers.js's bulkReplace().
function submit(table, id, userId) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new Error('Not found');
  if (row.locked) throw new Error('This has already been approved and is locked.');
  if (!['Draft', 'Rejected'].includes(row.status)) throw new Error(`Cannot submit for approval from status ${row.status}.`);
  db.prepare(`UPDATE ${table} SET status = 'PendingApproval', submitted_by = ?, submitted_at = ?, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(userId, new Date().toISOString(), id);
}
function approve(table, id, userId) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new Error('Not found');
  if (row.status !== 'PendingApproval') throw new Error('Only an item submitted for approval (PendingApproval) can be approved.');
  db.prepare(`UPDATE ${table} SET status = 'Approved', approved_by = ?, approved_at = ?, locked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(userId, new Date().toISOString(), id);
}
function reject(table, id, userId, reason) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new Error('Not found');
  if (row.status !== 'PendingApproval') throw new Error('Only an item submitted for approval (PendingApproval) can be rejected.');
  db.prepare(`UPDATE ${table} SET status = 'Rejected', approved_by = ?, approved_at = ?, rejection_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(userId, new Date().toISOString(), reason || null, id);
}
// Admin-only escape hatch for an already-Approved, locked item that
// genuinely needs revision - reject() only ever works from PendingApproval,
// so once approved there was previously no way back to an editable state at
// all. Drops it to Rejected/unlocked (submit() already accepts Rejected as a
// resubmittable status) and records who/when separately in unlocked_by/
// unlocked_at - approved_by/approved_at are left untouched as the honest
// historical record of the original approval. Only `annexure_reviews` has
// these two columns today (db/index.js), so `table` here is narrower than
// submit/approve/reject's.
function unlock(table, id, userId, reason) {
  if (!reason || !reason.trim()) throw new Error('A reason is required to unlock an approved item for revision.');
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new Error('Not found');
  if (row.status !== 'Approved' || !row.locked) throw new Error('Only an Approved, locked item can be unlocked for revision.');
  db.prepare(`
    UPDATE ${table} SET status = 'Rejected', locked = 0, rejection_reason = ?, unlocked_by = ?, unlocked_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason.trim(), userId, new Date().toISOString(), id);
}

module.exports = { submit, approve, reject, unlock };

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

module.exports = { submit, approve, reject };

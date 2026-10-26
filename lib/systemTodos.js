// Auto-closes a system-generated To-Do the moment the real-world event it
// exists to track actually happens. These To-Dos are created by autonomous
// scans/routing code (lib/bgReminderScan.js, lib/foreignPaymentBoeScan.js,
// routes/finance.js's notifyFocRouted, routes/offers.js's section-title
// suggestion flow) rather than by a person - there's no human judgment left
// to apply once the underlying event fires, so this goes straight to
// Completed, bypassing the TodoCompletion Management-review gate a person
// manually closing a To-Do goes through (2026-10-14).
const { db } = require('../db');

function autoCompleteSystemTodos(sourceType, sourceIds) {
  const ids = (Array.isArray(sourceIds) ? sourceIds : [sourceIds]).filter(id => id !== null && id !== undefined);
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE todos SET status = 'Completed', completed_at = CURRENT_TIMESTAMP
    WHERE source_type = ? AND source_id IN (${placeholders}) AND status != 'Completed'
  `).run(sourceType, ...ids);
}

module.exports = { autoCompleteSystemTodos };

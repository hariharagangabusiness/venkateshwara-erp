#!/usr/bin/env node
// One-off cleanup: the Monthly Expense Tracker -> Operating Expenses
// migration (db/index.js) copied every expense_tracker_entries row into
// operating_expenses verbatim, tagging each with "(Migrated from Monthly
// Expense Tracker)" in its description. Some of those source rows carried
// an entry_date in November 2026, which the owner wants removed from
// Operating Expenses now that they've been reviewed.
//
// Only ever targets rows whose description contains the migration tag AND
// whose expense_date falls in the given month - never a hand-entered
// Operating Expense, even one that happens to share that month. Dry-run by
// default (lists what would be deleted); pass --apply to actually delete.
// These migrated rows were inserted with no accompanying finance_ledger
// row (confirmed against db/index.js's migration code), so deleting them
// from operating_expenses alone leaves no orphaned ledger entry behind.
//
// Usage: node scripts/cleanup-migrated-oe-nov2026.js <path-to-erp.db> [YYYY-MM] [--apply]
'use strict';
const dbPath = process.argv[2];
const monthArg = process.argv.find(a => /^\d{4}-\d{2}$/.test(a)) || '2026-11';
const apply = process.argv.includes('--apply');
if (!dbPath) {
  console.error('Usage: node scripts/cleanup-migrated-oe-nov2026.js <path-to-erp.db> [YYYY-MM] [--apply]');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: !apply });

const rows = db.prepare(`
  SELECT id, expense_date, category, description, amount, created_by
  FROM operating_expenses
  WHERE description LIKE '%Migrated from Monthly Expense Tracker%'
    AND expense_date LIKE ?
  ORDER BY expense_date, id
`).all(monthArg + '%');

console.log(`Month: ${monthArg}`);
console.log(`Matching migrated Operating Expense rows: ${rows.length}\n`);
let total = 0;
for (const r of rows) {
  total += r.amount;
  console.log(`  [${r.id}] ${r.expense_date}  ${r.category || '(no category)'}  Rs.${r.amount}  - ${r.description}`);
}
console.log(`\nTotal amount: Rs.${total.toFixed(2)}`);

if (!rows.length) {
  console.log('\nNothing to delete.');
  process.exit(0);
}

if (!apply) {
  console.log('\nDRY RUN - nothing deleted. Re-run with --apply to delete the rows listed above.');
  process.exit(0);
}

const del = db.prepare(`DELETE FROM operating_expenses WHERE id = ?`);
const tx = db.transaction ? null : null; // node:sqlite DatabaseSync has no .transaction() helper here; do it manually
db.exec('BEGIN');
try {
  for (const r of rows) del.run(r.id);
  db.exec('COMMIT');
  console.log(`\nDeleted ${rows.length} row(s).`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Delete failed, rolled back:', e.message);
  process.exit(1);
}

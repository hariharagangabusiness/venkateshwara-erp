#!/usr/bin/env node
// Read-only diagnostic for "this project still shows in Dashboard's Active
// Projects count even though its order has already been dispatched" reports.
// Mirrors routes/dashboard.js's GET /summary projects_active query exactly.
// Never writes anything.
//
// Usage: node scripts/diagnose-dashboard-active-project.js <path-to-erp.db> <order_no_or_project_code>
'use strict';
const dbPath = process.argv[2];
const key = process.argv[3];
if (!dbPath || !key) {
  console.error('Usage: node scripts/diagnose-dashboard-active-project.js <path-to-erp.db> <order_no_or_project_code>');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

let order = db.prepare('SELECT * FROM sales_orders WHERE order_no = ?').get(key);
let project = null;
if (order) {
  console.log(`Sales Order: ${order.order_no} (id ${order.id})`);
  project = db.prepare('SELECT * FROM projects WHERE sales_order_id = ?').get(order.id);
} else {
  project = db.prepare('SELECT * FROM projects WHERE project_code = ?').get(key);
  if (project) {
    console.log(`Project: ${project.project_code} (id ${project.id}) - looked up directly by project_code`);
    if (project.sales_order_id) order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(project.sales_order_id);
  }
}
if (!order && !project) {
  console.error(`No sales order or project found matching '${key}'`);
  process.exit(1);
}
if (!project) {
  console.log('No linked project found for this order.');
  process.exit(0);
}
console.log(`Project: ${project.project_code} (id ${project.id}), status = '${project.status}', sales_order_id = ${project.sales_order_id}`);
if (order) console.log(`Linked Sales Order: ${order.order_no} (id ${order.id})`);

const dispatches = project.sales_order_id
  ? db.prepare('SELECT id, dispatch_no, status, created_at FROM fg_dispatches WHERE sales_order_id = ?').all(project.sales_order_id)
  : [];
console.log(`\nFG Dispatches against this project's order (${dispatches.length}):`);
for (const d of dispatches) console.log(`    - [${d.id}] ${d.dispatch_no}: status='${d.status}' (created ${d.created_at})`);

const hasDispatchedRow = dispatches.some(d => d.status === 'Dispatched');
console.log(`\nAny dispatch with status exactly 'Dispatched'? ${hasDispatchedRow}`);

// Exact query from routes/dashboard.js's projects_active count, scoped to this one project.
const included = db.prepare(`
  SELECT COUNT(*) c FROM projects p
  WHERE p.id = ?
    AND p.status != 'Completed'
    AND NOT EXISTS (
      SELECT 1 FROM fg_dispatches fd
      WHERE fd.sales_order_id = p.sales_order_id AND fd.status = 'Dispatched'
    )
`).get(project.id).c;

console.log(`\nproject.status != 'Completed': ${project.status !== 'Completed'}`);
console.log(`Would this project currently be counted in Dashboard's "Active Projects"? ${included > 0 ? 'YES' : 'NO'}`);
if (included > 0 && hasDispatchedRow) {
  console.log('\n*** MISMATCH: a Dispatched row exists but the project is still counted active - something else is wrong (join mismatch, stale deploy, or server restart needed). ***');
} else if (included > 0 && !hasDispatchedRow) {
  console.log('\nExpected: no dispatch row has status exactly \'Dispatched\' yet, so this project correctly still counts as active per the current rule.');
}

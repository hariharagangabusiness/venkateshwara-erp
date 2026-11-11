#!/usr/bin/env node
// Read-only diagnostic for "why can't I delete this Sales Order" reports.
// Reproduces routes/sales.js's DELETE /orders/:id blocker checks exactly
// (status, started job cards, invoices/proforma/BG/milestones/FOC,
// Order Confirmation letter status, Annexure review status) against a real
// order, and prints which one(s) would trip the 400. Never writes anything.
//
// Usage: node scripts/diagnose-so-delete.js <path-to-erp.db> <order_no>
'use strict';
const dbPath = process.argv[2];
const orderNo = process.argv[3];
if (!dbPath || !orderNo) {
  console.error('Usage: node scripts/diagnose-so-delete.js <path-to-erp.db> <order_no>');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

const order = db.prepare('SELECT * FROM sales_orders WHERE order_no = ?').get(orderNo);
if (!order) {
  console.error(`No sales order found with order_no = ${orderNo}`);
  process.exit(1);
}

console.log(`Sales Order: ${order.order_no} (id ${order.id})`);
console.log(`  status: ${order.status}`);

if (order.status !== 'Confirmed') {
  console.log(`\nBLOCKED: status is '${order.status}', not 'Confirmed' - only a Confirmed order with nothing built on it yet can be deleted.`);
  process.exit(0);
}

const project = db.prepare('SELECT * FROM projects WHERE sales_order_id = ?').get(order.id);
if (project) {
  console.log(`  linked project: ${project.project_code} (id ${project.id}), status ${project.status}`);
  const startedJobCard = db.prepare(`
    SELECT id, stage, status, started_at FROM job_cards WHERE project_id = ? AND ((status != 'Pending' AND status != 'NotApplicable') OR started_at IS NOT NULL)
  `).all(project.id);
  if (startedJobCard.length) {
    console.log(`\nBLOCKED: production has already started - ${startedJobCard.length} job card(s) in progress or further along:`);
    for (const jc of startedJobCard) console.log(`    - [${jc.id}] ${jc.stage}: status=${jc.status}, started_at=${jc.started_at}`);
  } else {
    console.log('  job cards: none started (ok)');
  }
} else {
  console.log('  linked project: none');
}

const blockers = [
  ['Tax Invoice', db.prepare('SELECT COUNT(*) as n FROM sales_invoices WHERE sales_order_id = ?').get(order.id).n],
  ['Proforma Invoice', db.prepare('SELECT COUNT(*) as n FROM proforma_invoices WHERE sales_order_id = ?').get(order.id).n],
  ['Bank Guarantee', db.prepare(`SELECT COUNT(*) as n FROM bank_guarantees WHERE order_type = 'SO' AND order_id = ?`).get(order.id).n],
  ['Payment Milestone', db.prepare(`SELECT COUNT(*) as n FROM payment_milestones WHERE order_type = 'SO' AND order_id = ?`).get(order.id).n],
  ['FOC Request', db.prepare('SELECT COUNT(*) as n FROM foc_requests WHERE sales_order_id = ?').get(order.id).n],
  ['FG Dispatch', db.prepare('SELECT COUNT(*) as n FROM fg_dispatches WHERE sales_order_id = ?').get(order.id).n],
];
const lineItemCount = db.prepare('SELECT COUNT(*) as n FROM sales_order_items WHERE sales_order_id = ?').get(order.id).n;
console.log(`  line items (sales_order_items): ${lineItemCount}${lineItemCount > 0 ? ' - the exact pre-fix FOREIGN KEY crash trigger if FG Dispatch is 0' : ''}`);
console.log('\nOther blocker checks:');
for (const [label, n] of blockers) console.log(`    - ${label}: ${n} row(s)${n > 0 ? '  <-- BLOCKS DELETE' : ''}`);

const oc = db.prepare('SELECT status FROM order_confirmations WHERE sales_order_id = ?').get(order.id);
console.log(`    - Order Confirmation letter: ${oc ? oc.status : '(none)'}${oc && oc.status !== 'Draft' ? '  <-- BLOCKS DELETE' : ''}`);

const ar = db.prepare('SELECT status FROM annexure_reviews WHERE sales_order_id = ?').get(order.id);
console.log(`    - Annexure review: ${ar ? ar.status : '(none)'}${ar && ar.status !== 'Draft' ? '  <-- BLOCKS DELETE' : ''}`);

const anyBlocked = blockers.some(([, n]) => n > 0) || (oc && oc.status !== 'Draft') || (ar && ar.status !== 'Draft')
  || (project && db.prepare(`SELECT 1 as x FROM job_cards WHERE project_id = ? AND ((status != 'Pending' AND status != 'NotApplicable') OR started_at IS NOT NULL) LIMIT 1`).get(project.id));
console.log(anyBlocked ? '\nRESULT: delete is blocked (see <-- markers above).' : '\nRESULT: nothing blocks delete - this order should be deletable as Admin.');

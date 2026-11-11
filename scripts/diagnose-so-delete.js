#!/usr/bin/env node
// Read-only diagnostic for "why can't I delete this Sales Order" reports.
// Mirrors routes/sales.js's DELETE /orders/:id exactly - including its
// generic FK-based scan (findForeignKeyBlockers there / here) that replaced
// a hand-maintained blocker list on 2026-11-11, after that hand-maintained
// list was found to have fallen behind several newer features (Site Visits,
// Customer Communications, Material Requisitions, Stock Movements, Service
// Requests, Challans, Purchase Requests, job_card_comments,
// job_card_dependencies) - none of their FKs into sales_orders/projects/
// job_cards had ever been added to either the cascade-delete set or the
// blockers list, so a real order with any of that activity against it threw
// a raw, uncaught "FOREIGN KEY constraint failed" instead of a clear 400.
// Never writes anything.
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

const ORDER_DELETE_CASCADE_TABLES = ['job_card_attachments', 'job_card_comments', 'job_card_dependencies', 'job_cards', 'order_confirmations', 'annexure_reviews', 'sales_order_items'];

function findForeignKeyBlockers(targetTable, ids, exclude) {
  if (!ids.length) return [];
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name);
  const placeholders = ids.map(() => '?').join(',');
  const blockers = [];
  for (const t of tables) {
    if (exclude.includes(t)) continue;
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    for (const fk of fks) {
      if (fk.table !== targetTable) continue;
      const n = db.prepare(`SELECT COUNT(*) as n FROM ${t} WHERE ${fk.from} IN (${placeholders})`).get(...ids).n;
      if (n > 0) blockers.push([`${t}.${fk.from}`, n]);
    }
  }
  return blockers;
}

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
let jobCardIds = [];
if (project) {
  console.log(`  linked project: ${project.project_code} (id ${project.id}), status ${project.status}`);
  const startedJobCard = db.prepare(`
    SELECT id, stage, status, started_at FROM job_cards WHERE project_id = ? AND ((status != 'Pending' AND status != 'NotApplicable') OR started_at IS NOT NULL)
  `).all(project.id);
  if (startedJobCard.length) {
    console.log(`\nBLOCKED: production has already started - ${startedJobCard.length} job card(s) in progress or further along:`);
    for (const jc of startedJobCard) console.log(`    - [${jc.id}] ${jc.stage}: status=${jc.status}, started_at=${jc.started_at}`);
    process.exit(0);
  }
  console.log('  job cards: none started (ok)');
  jobCardIds = db.prepare('SELECT id FROM job_cards WHERE project_id = ?').all(project.id).map(r => r.id);
} else {
  console.log('  linked project: none');
}

const manualBlockers = [
  ['Bank Guarantee (order_type/order_id)', db.prepare(`SELECT COUNT(*) as n FROM bank_guarantees WHERE order_type = 'SO' AND order_id = ?`).get(order.id).n],
  ['Payment Milestone (order_type/order_id)', db.prepare(`SELECT COUNT(*) as n FROM payment_milestones WHERE order_type = 'SO' AND order_id = ?`).get(order.id).n],
];
const fkBlockers = [
  ...findForeignKeyBlockers('sales_orders', [order.id], [...ORDER_DELETE_CASCADE_TABLES, 'projects', 'offers']),
  ...(project ? findForeignKeyBlockers('projects', [project.id], ORDER_DELETE_CASCADE_TABLES) : []),
  ...(jobCardIds.length ? findForeignKeyBlockers('job_cards', jobCardIds, ORDER_DELETE_CASCADE_TABLES) : []),
];

console.log('\nBlocker checks (manual, polymorphic order_type/order_id - no real FK):');
for (const [label, n] of manualBlockers) console.log(`    - ${label}: ${n} row(s)${n > 0 ? '  <-- BLOCKS DELETE' : ''}`);
console.log('\nBlocker checks (generic FK scan against sales_orders/projects/job_cards):');
if (!fkBlockers.length) console.log('    (none found)');
for (const [label, n] of fkBlockers) console.log(`    - ${label}: ${n} row(s)  <-- BLOCKS DELETE`);

const oc = db.prepare('SELECT status FROM order_confirmations WHERE sales_order_id = ?').get(order.id);
console.log(`\n    - Order Confirmation letter: ${oc ? oc.status : '(none)'}${oc && oc.status !== 'Draft' ? '  <-- BLOCKS DELETE' : ''}`);

const ar = db.prepare('SELECT status FROM annexure_reviews WHERE sales_order_id = ?').get(order.id);
console.log(`    - Annexure review: ${ar ? ar.status : '(none)'}${ar && ar.status !== 'Draft' ? '  <-- BLOCKS DELETE' : ''}`);

const anyBlocked = manualBlockers.some(([, n]) => n > 0) || fkBlockers.length > 0 || (oc && oc.status !== 'Draft') || (ar && ar.status !== 'Draft');
console.log(anyBlocked ? '\nRESULT: delete is blocked (see <-- markers above).' : '\nRESULT: nothing blocks delete - this order should be deletable as Admin.');

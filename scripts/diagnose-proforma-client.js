#!/usr/bin/env node
// Read-only diagnostic for "the corrected Sales Order client isn't showing
// on this specific Proforma" reports (PR #269's fix). Shows exactly what
// GET /finance/proforma-invoices (list/detail) would now compute - the
// proforma's own frozen client_id vs. the live client via its linked Sales
// Order's client_id - so a mismatch between "what the fix reads" and "what
// the owner expects" is visible directly, rather than guessed at.
// Never writes anything.
//
// Usage: node scripts/diagnose-proforma-client.js <path-to-erp.db> <proforma_no>
'use strict';
const dbPath = process.argv[2];
const proformaNo = process.argv[3];
if (!dbPath || !proformaNo) {
  console.error('Usage: node scripts/diagnose-proforma-client.js <path-to-erp.db> <proforma_no>');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

const pf = db.prepare('SELECT * FROM proforma_invoices WHERE proforma_no = ?').get(proformaNo);
if (!pf) {
  console.error(`No proforma found with proforma_no = ${proformaNo}`);
  process.exit(1);
}

console.log(`Proforma: ${pf.proforma_no} (id ${pf.id})`);
console.log(`  status: ${pf.status}`);
console.log(`  sales_order_id: ${pf.sales_order_id}`);
console.log(`  pf.client_id (frozen, no longer trusted for display): ${pf.client_id}`);

const frozenClient = pf.client_id ? db.prepare('SELECT id, name FROM clients WHERE id = ?').get(pf.client_id) : null;
console.log(`    -> frozen client: ${frozenClient ? `#${frozenClient.id} ${frozenClient.name}` : '(none / not found)'}`);

if (!pf.sales_order_id) {
  console.log('\nBLOCKED: this proforma has no linked sales_order_id at all - the fix\'s live join (via so.client_id) has nothing to join to, so the list/detail/PDF/email routes all fall back to a null client. This proforma predates the from-sales-order creation route, or sales_order_id was cleared somehow.');
  process.exit(0);
}

const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(pf.sales_order_id);
if (!so) {
  console.log(`\nBLOCKED: sales_order_id ${pf.sales_order_id} does not resolve to a real row in sales_orders (it was deleted, or never existed) - same null-join outcome as above.`);
  process.exit(0);
}
console.log(`\n  Linked Sales Order: ${so.order_no} (id ${so.id})`);
console.log(`    so.client_id (live, what the fix now joins through): ${so.client_id}`);
const liveClient = so.client_id ? db.prepare('SELECT id, name FROM clients WHERE id = ?').get(so.client_id) : null;
console.log(`    -> live client: ${liveClient ? `#${liveClient.id} ${liveClient.name}` : '(none / not found)'}`);

console.log('\nWhat GET /finance/proforma-invoices (list) and GET /finance/proforma-invoices/:id (detail) now return as client_name:');
console.log(`    ${liveClient ? liveClient.name : '(null - so.client_id does not resolve to a real client)'}`);

if (frozenClient && liveClient && frozenClient.id === liveClient.id) {
  console.log('\nNOTE: the frozen pf.client_id and the live so.client_id are IDENTICAL - this Sales Order\'s client has not actually been changed from what this proforma was originally created against. If the owner expected a different client here, check the Sales Order Edit popup saved against order ' + so.order_no + ' specifically, not a different order.');
}

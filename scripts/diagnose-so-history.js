#!/usr/bin/env node
// Read-only diagnostic: full picture of one Sales Order's current state plus
// any audit_log trail against it, and every proforma/client row that could
// plausibly be confused with it - for chasing "I edited this order's client
// but it still shows the old one" once the simple client-id comparison in
// diagnose-proforma-client.js comes back "already matching."
// Never writes anything.
//
// Usage: node scripts/diagnose-so-history.js <path-to-erp.db> <order_no>
'use strict';
const dbPath = process.argv[2];
const orderNo = process.argv[3];
if (!dbPath || !orderNo) {
  console.error('Usage: node scripts/diagnose-so-history.js <path-to-erp.db> <order_no>');
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
console.log(`  client_id: ${order.client_id}`);
console.log(`  description: ${order.description}`);
console.log(`  order_date: ${order.order_date}`);

const client = order.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id) : null;
console.log(`  -> client: ${client ? `#${client.id} ${client.name} (gstin: ${client.gstin || '-'})` : '(none / not found)'}`);

console.log('\naudit_log entries referencing this order (entity_type=sales_order):');
const auditRows = db.prepare(`SELECT * FROM audit_log WHERE entity_type = 'sales_order' AND entity_id = ? ORDER BY id`).all(order.id);
if (!auditRows.length) {
  console.log('    (none - note: PUT /sales/orders/:id, the Admin header-Edit route, does NOT write to audit_log at all, so a client-id edit through it would leave no trail here regardless.)');
} else {
  for (const r of auditRows) console.log(`    [${r.id}] user ${r.user_id} - ${r.action} @ ${r.created_at}: ${r.details}`);
}

console.log('\nEvery proforma invoice linked to this order:');
const pfs = db.prepare('SELECT id, proforma_no, status, client_id FROM proforma_invoices WHERE sales_order_id = ? ORDER BY id').all(order.id);
for (const p of pfs) {
  const pc = p.client_id ? db.prepare('SELECT name FROM clients WHERE id = ?').get(p.client_id) : null;
  console.log(`    [${p.id}] ${p.proforma_no} (${p.status}) - own frozen client_id ${p.client_id} -> ${pc ? pc.name : '(none)'}`);
}

console.log('\nOther clients whose name looks similar (possible duplicate-client confusion):');
if (client) {
  const firstWord = client.name.split(/[\s,.(]/)[0];
  const similar = db.prepare('SELECT id, name, gstin FROM clients WHERE name LIKE ? AND id != ?').all(`%${firstWord}%`, client.id);
  if (!similar.length) console.log('    (none found)');
  for (const s of similar) console.log(`    #${s.id} ${s.name} (gstin: ${s.gstin || '-'})`);
}

console.log('\nEvery Sales Order currently on file for this same client (in case the owner is thinking of a different order against the same customer):');
if (client) {
  const sibs = db.prepare('SELECT order_no, status FROM sales_orders WHERE client_id = ? ORDER BY id').all(client.id);
  for (const s of sibs) console.log(`    ${s.order_no} (${s.status})`);
}

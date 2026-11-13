#!/usr/bin/env node
// Read-only diagnostic for "I uploaded a new Annexure on Order Confirmation &
// Annexure review but it's not updating" reports. POST /annexure-reviews/:soId/upload
// (routes/orderConfirmation.js) writes sales_orders.annexure_path directly, but is
// blocked by assertEditable() whenever the review row is already locked (Approved)
// or sitting at PendingApproval - in either case the upload 400s silently unless the
// frontend surfaces the error clearly, which can read as "nothing happened."
// Never writes.
//
// Usage: node scripts/diagnose-annexure-upload.js <path-to-erp.db> <order_no>
'use strict';
const dbPath = process.argv[2];
const orderNo = process.argv[3];
if (!dbPath || !orderNo) {
  console.error('Usage: node scripts/diagnose-annexure-upload.js <path-to-erp.db> <order_no>');
  process.exit(1);
}
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

const order = db.prepare('SELECT * FROM sales_orders WHERE order_no = ?').get(orderNo);
if (!order) {
  console.error(`No sales order found with order_no = ${orderNo}`);
  process.exit(1);
}
console.log(`Sales Order: ${order.order_no} (id ${order.id})`);
console.log(`  annexure_path (what every download route serves): ${order.annexure_path || '(none)'}`);

const absPath = order.annexure_path ? ('.' + order.annexure_path) : null;
if (absPath) {
  console.log(`  file exists on this box's own disk at that relative path: ${fs.existsSync(absPath)} (path check is only meaningful if run on the same host as the data)`);
}

const review = db.prepare('SELECT * FROM annexure_reviews WHERE sales_order_id = ?').get(order.id);
if (!review) {
  console.log('\nNo annexure_reviews row exists yet - one is lazily created on first GET/PUT, so this order has never been opened on the Order Confirmation & Annexure screen.');
} else {
  console.log(`\nAnnexure review row (id ${review.id}):`);
  console.log(`  status: ${review.status}`);
  console.log(`  locked: ${review.locked}`);
  console.log(`  updated_at: ${review.updated_at}`);
  const blocked = review.locked || review.status === 'PendingApproval';
  console.log(`\nWould POST /annexure-reviews/${order.id}/upload be blocked right now? ${blocked ? 'YES - ' + (review.locked ? '"This has already been approved and is locked."' : '"This is awaiting approval and cannot be edited - it must be approved or rejected first."') : 'No - upload should succeed and immediately overwrite annexure_path.'}`);
}

console.log('\nEvery proforma/other consumer of annexure_path reads this same sales_orders.annexure_path column directly - there is no separate cached copy anywhere else in the schema.');

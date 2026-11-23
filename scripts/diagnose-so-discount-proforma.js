#!/usr/bin/env node
// Read-only diagnostic for "a discounted price updated on the Sales Order
// isn't showing on the Proforma Invoice" reports. Shows, for every line on
// the given Sales Order, both sales_order_items.rate and .value (and, if the
// line was copied in from a Spares Offer at confirm time, that offer line's
// own unit_price/discount_amount/total_price) side by side - so a
// rate-vs-value mismatch (the suspected root cause: offer-confirm copies
// `rate: unit_price` - the PRE-discount price - while `value: total_price`,
// which IS discount-adjusted) is visible directly rather than guessed at.
// Never writes anything.
//
// Usage: node scripts/diagnose-so-discount-proforma.js <path-to-erp.db> <order_no>
'use strict';
const dbPath = process.argv[2];
const orderNo = process.argv[3];
if (!dbPath || !orderNo) {
  console.error('Usage: node scripts/diagnose-so-discount-proforma.js <path-to-erp.db> <order_no>');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

const so = db.prepare('SELECT * FROM sales_orders WHERE order_no = ?').get(orderNo);
if (!so) {
  console.error(`No sales order found with order_no = ${orderNo}`);
  process.exit(1);
}
console.log(`Sales Order: ${so.order_no} (id ${so.id}), order_value = ${so.order_value}`);

const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ? ORDER BY sort_order, id').all(so.id);
if (!items.length) {
  console.log('\nThis order has no line items on file at all.');
  process.exit(0);
}

console.log(`\n${items.length} line item(s):`);
for (const it of items) {
  console.log(`\n  SO item #${it.id}: "${it.description}"`);
  console.log(`    quantity=${it.quantity}  rate=${it.rate}  value=${it.value}  (qty*rate = ${it.quantity * it.rate})`);
  const mismatch = Math.abs(it.quantity * it.rate - it.value) > 0.01;
  console.log(`    qty*rate vs stored value: ${mismatch ? 'MISMATCH - this is the bug: rate is the pre-discount price, value is the real (discount-adjusted) total' : 'match'}`);
  console.log(`    -> Proforma's line-ticking table would show Rate = ${it.rate} and bill taxable = qty * rate = ${it.quantity * it.rate} for this line if ticked`);

  if (it.source_offer_item_id) {
    const oi = db.prepare('SELECT * FROM offer_items WHERE id = ?').get(it.source_offer_item_id);
    if (oi) {
      console.log(`    Linked offer_items #${oi.id}: unit_price=${oi.unit_price}  discount_amount=${oi.discount_amount}  qty=${oi.qty}  total_price=${oi.total_price}`);
      console.log(`      -> offer's real discounted taxable total was ${oi.total_price}, but sales_order_items.rate was set to the offer's unit_price (${oi.unit_price}), not the discounted per-unit price`);
    } else {
      console.log(`    source_offer_item_id ${it.source_offer_item_id} does not resolve to a real offer_items row (deleted?).`);
    }
  } else {
    console.log('    No source_offer_item_id - this line was added/edited directly on the Sales Order (no offer-discount concept applies here).');
  }
}

const sumValue = items.reduce((s, it) => s + it.value, 0);
const sumQtyRate = items.reduce((s, it) => s + it.quantity * it.rate, 0);
console.log(`\nSUM(value) across all lines = ${sumValue}  (this is what order_value / Advance-%/PreDispatch-% is based on)`);
console.log(`SUM(qty*rate) across all lines = ${sumQtyRate}  (this is what the Proforma would bill if every line were ticked)`);
if (Math.abs(sumValue - sumQtyRate) > 0.01) {
  console.log(`DIFFERENCE: ${(sumQtyRate - sumValue).toFixed(2)} - the Proforma (when lines are ticked) would overbill by exactly the total discount amount that was applied on the originating Offer.`);
}

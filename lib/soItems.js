const { db } = require('../db');

// How much of a sales_order_items line has already been claimed by a
// not-yet-rejected/cancelled dispatch - a PendingApproval dispatch reserves
// its quantity the same as an already-Dispatched one, so two separate
// dispatches can't both claim the same units while one is still awaiting
// sign-off. Mirrors Purchase Invoice's poLineBillableQty() discipline
// against PO lines (routes/finance.js), just for Sales Orders dispatching
// out instead of Purchase Orders receiving in.
function soLineDispatchedQty(soItemId) {
  return db.prepare(`
    SELECT COALESCE(SUM(fdi.quantity), 0) as n FROM fg_dispatch_items fdi
    JOIN fg_dispatches fd ON fd.id = fdi.dispatch_id
    WHERE fdi.sales_order_item_id = ? AND fd.status NOT IN ('Rejected', 'Cancelled')
  `).get(soItemId).n;
}
function soLineDispatchableQty(soItem) {
  return Math.max(0, Number(soItem.quantity || 0) - soLineDispatchedQty(soItem.id));
}

// How much of a specific dispatched line has already been claimed by a
// not-yet-rejected/cancelled MRN - same reservation logic as above, one
// level down (a dispatch line instead of an order line).
function dispatchItemRejectedQty(fgDispatchItemId) {
  return db.prepare(`
    SELECT COALESCE(SUM(mi.quantity_rejected), 0) as n FROM sale_rejection_mrn_items mi
    JOIN sale_rejection_mrns m ON m.id = mi.mrn_id
    WHERE mi.fg_dispatch_item_id = ? AND m.status NOT IN ('Rejected', 'Cancelled')
  `).get(fgDispatchItemId).n;
}
function dispatchItemRejectableQty(fgDispatchItem) {
  return Math.max(0, Number(fgDispatchItem.quantity || 0) - dispatchItemRejectedQty(fgDispatchItem.id));
}

module.exports = { soLineDispatchedQty, soLineDispatchableQty, dispatchItemRejectedQty, dispatchItemRejectableQty };

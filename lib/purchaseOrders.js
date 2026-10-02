const { db } = require('../db');

// How much of a single purchase_orders line has actually been received -
// derived from stock_movements (movement_type='IN', reference='PO#'+id)
// rather than stored redundantly on the PO row, same "derive, don't
// duplicate" reasoning as everywhere else in this codebase that tracks a
// running total against a source document. Shared between routes/purchase.js
// (receiving stock, PO status rollups) and routes/finance.js (Purchase
// Invoice booking can only bill what's actually been received).
function poReceivedQty(poId) {
  return db.prepare(`SELECT COALESCE(SUM(quantity), 0) as n FROM stock_movements WHERE movement_type = 'IN' AND reference = ?`).get('PO#' + poId).n;
}

module.exports = { poReceivedQty };

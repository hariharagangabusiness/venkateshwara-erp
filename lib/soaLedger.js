const { db } = require('../db');

// A client's Statement of Accounts is the two sides accounts-receivable
// always needs: every non-cancelled tax invoice raised against them
// (debit - a Draft sales_invoice is still a real, numbered GST invoice the
// moment it's created; only Cancelled ones drop out) and every payment
// receipt recorded against them (credit). Sorted by date with a running
// balance - the standard "opening balance, then one line per transaction"
// shape of a real statement.
function invoiceRows(clientId) {
  return db.prepare(`
    SELECT id, invoice_no, invoice_date, total_value FROM sales_invoices
    WHERE client_id = ? AND status != 'Cancelled'
  `).all(clientId).map(r => ({
    date: r.invoice_date, type: 'Invoice', ref: r.invoice_no, description: 'Tax Invoice ' + r.invoice_no,
    debit: Number(r.total_value) || 0, credit: 0, sort_id: 'I' + r.id,
  }));
}
function receiptRows(clientId) {
  return db.prepare(`
    SELECT id, receipt_no, receipt_date, amount, mode FROM payment_receipts WHERE client_id = ?
  `).all(clientId).map(r => ({
    date: r.receipt_date, type: 'Receipt', ref: r.receipt_no || ('#' + r.id), description: `Payment received (${r.mode})`,
    debit: 0, credit: Number(r.amount) || 0, sort_id: 'R' + r.id,
  }));
}

// `from`/`to` are inclusive 'YYYY-MM-DD' bounds, or omitted for "everything".
// Transactions before `from` fold into the opening balance instead of being
// dropped, so the statement's closing balance always reconciles with a
// no-date-filter run over the same client.
function computeClientLedger(clientId, { from, to } = {}) {
  const all = [...invoiceRows(clientId), ...receiptRows(clientId)]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sort_id < b.sort_id ? -1 : 1)));

  let openingBalance = 0;
  const inRange = [];
  all.forEach(r => {
    const beforeRange = from && r.date < from;
    const afterRange = to && r.date > (to + 'T23:59:59');
    if (beforeRange) { openingBalance += r.debit - r.credit; return; }
    if (afterRange) return;
    inRange.push(r);
  });

  let running = openingBalance;
  let totalDebit = 0, totalCredit = 0;
  const rows = inRange.map(r => {
    running += r.debit - r.credit;
    totalDebit += r.debit; totalCredit += r.credit;
    return { date: r.date, type: r.type, ref: r.ref, description: r.description, debit: r.debit, credit: r.credit, balance: running };
  });

  return { openingBalance, rows, closingBalance: running, totalDebit, totalCredit };
}

module.exports = { computeClientLedger };

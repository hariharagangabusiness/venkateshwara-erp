const { db } = require('../db');

// A vendor's ledger is the mirror image of lib/soaLedger.js's client
// statement: every booked Purchase Invoice (debit - what we owe the vendor,
// Cancelled/Rejected excluded since those never became a real payable) and
// every payment made against one (credit, sourced from finance_ledger the
// same way routes/finance.js's purchaseInvoicePaidAmount() already reads
// it) plus every Active vendor credit note (credit - it also reduces what's
// owed). Sorted by date with a running balance - same "opening balance,
// then one line per transaction" shape as the client statement.
function invoiceRows(vendorId) {
  return db.prepare(`
    SELECT id, invoice_no, booking_date, net_payable FROM purchase_invoices
    WHERE vendor_id = ? AND status != 'Cancelled' AND status != 'Rejected'
  `).all(vendorId).map(r => ({
    date: r.booking_date, type: 'Invoice', ref: r.invoice_no, description: 'Purchase Invoice ' + r.invoice_no,
    debit: Number(r.net_payable) || 0, credit: 0, sort_id: 'I' + r.id,
  }));
}
function paymentRows(vendorId) {
  return db.prepare(`
    SELECT fl.id, fl.entry_date, fl.amount, fl.description FROM finance_ledger fl
    JOIN purchase_invoices pi ON pi.id = fl.reference_id
    WHERE fl.reference_table = 'purchase_invoices' AND pi.vendor_id = ?
  `).all(vendorId).map(r => ({
    date: r.entry_date, type: 'Payment', ref: '#' + r.id, description: r.description || 'Payment made',
    debit: 0, credit: Number(r.amount) || 0, sort_id: 'P' + r.id,
  }));
}
function creditNoteRows(vendorId) {
  return db.prepare(`
    SELECT id, credit_note_no, created_at, total_value FROM vendor_credit_notes WHERE vendor_id = ? AND status != 'Cancelled'
  `).all(vendorId).map(r => ({
    date: r.created_at, type: 'CreditNote', ref: r.credit_note_no, description: 'Vendor Credit Note ' + r.credit_note_no,
    debit: 0, credit: Number(r.total_value) || 0, sort_id: 'C' + r.id,
  }));
}

// `from`/`to` are inclusive 'YYYY-MM-DD' bounds, or omitted for "everything".
// Transactions before `from` fold into the opening balance instead of being
// dropped, so the statement's closing balance always reconciles with a
// no-date-filter run over the same vendor.
function computeVendorLedger(vendorId, { from, to } = {}) {
  const all = [...invoiceRows(vendorId), ...paymentRows(vendorId), ...creditNoteRows(vendorId)]
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

module.exports = { computeVendorLedger };

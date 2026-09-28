// Compares a Sales Order's own commercial terms (delivery date, LD%, ABG/PBG)
// against what the customer's actual PO says, once one has been logged
// (routes/sales.js PUT /orders/:id/po). Recomputed any time either side's
// terms change - not just when the PO is first entered - so editing the
// SO's own terms afterward (routes/sales.js PATCH /orders/:id/commercial-terms)
// re-checks against the same PO rather than leaving a stale result in place.
const COMPARE_FIELDS = [
  { key: 'promised_delivery_date', poKey: 'po_delivery_date', label: 'Delivery Date' },
  { key: 'ld_percentage', poKey: 'po_ld_percentage', label: 'LD %' },
  { key: 'ld_cap_percentage', poKey: 'po_ld_cap_percentage', label: 'LD Cap %' },
  { key: 'abg_required', poKey: 'po_abg_required', label: 'ABG Required' },
  { key: 'abg_percentage', poKey: 'po_abg_percentage', label: 'ABG %' },
  { key: 'abg_amount', poKey: 'po_abg_amount', label: 'ABG Amount' },
  { key: 'abg_validity_days', poKey: 'po_abg_validity_days', label: 'ABG Validity (days)' },
  { key: 'pbg_required', poKey: 'po_pbg_required', label: 'PBG Required' },
  { key: 'pbg_percentage', poKey: 'po_pbg_percentage', label: 'PBG %' },
  { key: 'pbg_amount', poKey: 'po_pbg_amount', label: 'PBG Amount' },
  { key: 'pbg_validity_days', poKey: 'po_pbg_validity_days', label: 'PBG Validity (days)' },
];

function normalize(v) {
  return (v === null || v === undefined || v === '') ? null : v;
}
function fieldsDiffer(a, b) {
  return normalize(a) !== normalize(b);
}

function diffPoTerms(so) {
  return COMPARE_FIELDS.filter(f => fieldsDiffer(so[f.key], so[f.poKey])).map(f => f.label);
}

// Recomputes and persists po_terms_status/po_mismatch_fields for one order.
// A prior MismatchAcknowledged is preserved only while the mismatch set is
// exactly what was acknowledged - any change to either side's terms (a new
// field now differs, or a previously-differing one no longer does) reopens
// it as MismatchPending, since the acknowledgment was only ever valid for
// the specific discrepancies it was given for.
function recomputePoTermsStatus(db, orderId) {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(orderId);
  if (!so) return null;
  if (so.po_status !== 'Received') {
    db.prepare(`UPDATE sales_orders SET po_terms_status = 'NotApplicable', po_mismatch_fields = NULL WHERE id = ?`).run(orderId);
    return { status: 'NotApplicable', mismatches: [] };
  }
  const mismatches = diffPoTerms(so);
  const mismatchJson = mismatches.length ? JSON.stringify(mismatches) : null;
  let status;
  if (!mismatches.length) status = 'Matched';
  else if (so.po_terms_status === 'MismatchAcknowledged' && so.po_mismatch_fields === mismatchJson) status = 'MismatchAcknowledged';
  else status = 'MismatchPending';
  db.prepare(`UPDATE sales_orders SET po_terms_status = ?, po_mismatch_fields = ? WHERE id = ?`).run(status, mismatchJson, orderId);
  return { status, mismatches };
}

module.exports = { diffPoTerms, recomputePoTermsStatus, COMPARE_FIELDS };

// ERP-wide "pending items outside of aligned dates" registry.
//
// Each entity type below that has a GENUINE, already-stored target date on
// its own row (not a derived age-since-created SLA, which the approval
// engine's own SLA_DAYS map / escalation scan already cover separately)
// gets one small function here returning its own currently-overdue rows in
// one common shape: { source, ref, label, target_date, days_overdue, detail,
// link_hint }. One shared getOverdueItems() aggregates all of them for the
// dashboard page and its Excel export - mirroring how routes/approvals.js's
// describeEntity() is one shared per-entity formatter reused by the whole
// approval engine, just for this separate concept.
//
// Deliberately excluded (no real target-date field on the row, only an
// approval-queue-age SLA which already has its own coverage elsewhere):
// Purchase Requests, Leave Requests, Salary Hike Cycles, RFQ Requests,
// GRN Reconciliation, Service Requests, FG Dispatch.
const { db } = require('../db');

function daysOverdue(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10));
  if (isNaN(d.getTime())) return null;
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.round((today - d) / 86400000);
}

function overduePurchaseOrders() {
  const rows = db.prepare(`
    SELECT po.id, po.po_no, po.delivery_date, po.status, v.name as vendor_name
    FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id
    WHERE po.status IN ('Open', 'PartiallyReceived') AND po.delivery_date IS NOT NULL AND po.delivery_date != ''
  `).all();
  return rows.map(r => {
    const d = daysOverdue(r.delivery_date);
    if (d === null || d <= 0) return null;
    return {
      source: 'Purchase Order', ref: r.po_no, label: `${r.po_no} - ${r.vendor_name || 'Vendor'}`,
      target_date: r.delivery_date, days_overdue: d,
      detail: `Status: ${r.status}`, link_hint: 'purchase-orders',
    };
  }).filter(Boolean);
}

function overdueJobCards() {
  const rows = db.prepare(`
    SELECT jc.id, jc.stage, jc.planned_end, jc.status, p.project_code, p.title as project_title,
           c.name as client_name
    FROM job_cards jc JOIN projects p ON p.id = jc.project_id
    LEFT JOIN sales_orders so ON so.id = p.sales_order_id
    LEFT JOIN clients c ON c.id = so.client_id
    WHERE jc.status IN ('Pending', 'InProgress', 'OnHold') AND jc.planned_end IS NOT NULL AND jc.planned_end != ''
  `).all();
  return rows.map(r => {
    const d = daysOverdue(r.planned_end);
    if (d === null || d <= 0) return null;
    return {
      source: 'Job Card', ref: `${r.project_code || r.id} / ${r.stage}`, label: `${r.project_code || ''} (${r.client_name || 'No client'}) - ${r.stage}`,
      target_date: r.planned_end, days_overdue: d,
      detail: `Status: ${r.status}`, link_hint: 'job-cards-mine',
    };
  }).filter(Boolean);
}

function overdueForeignPayments() {
  const rows = db.prepare(`
    SELECT id, request_no, status, license_expiry_date, boe_due_date, forward_contract_booked_date, beneficiary_name
    FROM foreign_payment_requests
    WHERE status NOT IN ('Closed', 'Rejected')
  `).all();
  const out = [];
  for (const r of rows) {
    const checks = [
      ['License Expiry', r.license_expiry_date],
      ['Bill of Entry Due', r.boe_due_date],
      ['Forward Contract Booked Date', r.forward_contract_booked_date],
    ];
    for (const [what, dateVal] of checks) {
      if (!dateVal) continue;
      const d = daysOverdue(dateVal);
      if (d === null || d <= 0) continue;
      out.push({
        source: 'Foreign Payment', ref: r.request_no, label: `${r.request_no} - ${r.beneficiary_name || ''} (${what})`,
        target_date: dateVal, days_overdue: d,
        detail: `Status: ${r.status}`, link_hint: 'foreign-payments',
      });
    }
  }
  return out;
}

function overdueBankGuarantees() {
  const rows = db.prepare(`
    SELECT id, bg_no, bg_type, validity_expiry, claim_expiry, status, beneficiary
    FROM bank_guarantees
    WHERE status IN ('Active', 'Extended')
  `).all();
  const out = [];
  for (const r of rows) {
    const vd = daysOverdue(r.validity_expiry);
    if (vd !== null && vd > 0) {
      out.push({
        source: 'Bank Guarantee', ref: r.bg_no, label: `${r.bg_no} - ${r.beneficiary || ''} (${r.bg_type}, Validity Expiry)`,
        target_date: r.validity_expiry, days_overdue: vd,
        detail: `Status: ${r.status}`, link_hint: 'bank-guarantees',
      });
    }
    if (r.claim_expiry) {
      const cd = daysOverdue(r.claim_expiry);
      if (cd !== null && cd > 0) {
        out.push({
          source: 'Bank Guarantee', ref: r.bg_no, label: `${r.bg_no} - ${r.beneficiary || ''} (${r.bg_type}, Claim Expiry)`,
          target_date: r.claim_expiry, days_overdue: cd,
          detail: `Status: ${r.status}`, link_hint: 'bank-guarantees',
        });
      }
    }
  }
  return out;
}

function overdueToDos() {
  const rows = db.prepare(`
    SELECT id, brief_description, target_date, status
    FROM todos
    WHERE status IN ('Pending', 'InProgress', 'OnHold')
  `).all();
  return rows.map(r => {
    const d = daysOverdue(r.target_date);
    if (d === null || d <= 0) return null;
    return {
      source: 'To-Do', ref: '#' + r.id, label: r.brief_description || ('To-Do #' + r.id),
      target_date: r.target_date, days_overdue: d,
      detail: `Status: ${r.status}`, link_hint: 'todos',
    };
  }).filter(Boolean);
}

function overdueReferralIncentives() {
  const rows = db.prepare(`
    SELECT ri.id, ri.probation_end_date, ri.status, e.full_name as employee_name
    FROM referral_incentives ri LEFT JOIN employees e ON e.id = ri.employee_id
    WHERE ri.status = 'PendingProbation' AND ri.probation_end_date IS NOT NULL AND ri.probation_end_date != ''
  `).all();
  return rows.map(r => {
    const d = daysOverdue(r.probation_end_date);
    if (d === null || d <= 0) return null;
    return {
      source: 'Referral Incentive', ref: '#' + r.id, label: `${r.employee_name || 'Employee'} - probation end`,
      target_date: r.probation_end_date, days_overdue: d,
      detail: `Status: ${r.status} (should have flipped to Eligible already)`, link_hint: 'referral-incentives',
    };
  }).filter(Boolean);
}

function overdueSalesOrders() {
  const rows = db.prepare(`
    SELECT so.id, so.order_no, so.promised_delivery_date, so.status, c.name as client_name
    FROM sales_orders so LEFT JOIN clients c ON c.id = so.client_id
    WHERE so.status IN ('Confirmed', 'InProduction')
      AND so.promised_delivery_date IS NOT NULL AND so.promised_delivery_date != ''
  `).all();
  return rows.map(r => {
    const d = daysOverdue(r.promised_delivery_date);
    if (d === null || d <= 0) return null;
    return {
      source: 'Sales Order', ref: r.order_no, label: `${r.order_no} - ${r.client_name || 'Client'}`,
      target_date: r.promised_delivery_date, days_overdue: d,
      detail: `Status: ${r.status}`, link_hint: 'sales-orders',
    };
  }).filter(Boolean);
}

function purchaseInvoicePaidAmount(invoiceId) {
  return db.prepare(`SELECT COALESCE(SUM(amount), 0) as n FROM finance_ledger WHERE reference_table = 'purchase_invoices' AND reference_id = ?`).get(invoiceId).n;
}
function purchaseInvoiceCreditedAmount(invoiceId) {
  return db.prepare(`SELECT COALESCE(SUM(total_value), 0) as n FROM vendor_credit_notes WHERE purchase_invoice_id = ? AND status != 'Cancelled'`).get(invoiceId).n;
}

function overduePurchaseInvoices() {
  const rows = db.prepare(`
    SELECT pi.id, pi.invoice_no, pi.booking_date, pi.net_payable, pi.status, v.name as vendor_name, v.payment_terms_days
    FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
    WHERE pi.status IN ('PendingApproval', 'Approved', 'PartiallyPaid', 'Rejected', 'InfoRequested')
  `).all();
  const out = [];
  for (const r of rows) {
    const paid = purchaseInvoicePaidAmount(r.id);
    const credited = purchaseInvoiceCreditedAmount(r.id);
    const due = Math.max(0, r.net_payable - paid - credited);
    if (due <= 0.01) continue;
    const termsDays = r.payment_terms_days || 30;
    const dueDate = new Date(new Date(r.booking_date).getTime() + termsDays * 86400000).toISOString().slice(0, 10);
    const d = daysOverdue(dueDate);
    if (d === null || d <= 0) continue;
    out.push({
      source: 'Purchase Invoice', ref: r.invoice_no, label: `${r.invoice_no} - ${r.vendor_name || 'Vendor'}`,
      target_date: dueDate, days_overdue: d,
      detail: `Due ₹${due.toFixed(2)}, Status: ${r.status}`, link_hint: 'purchase-invoices',
    });
  }
  return out;
}

const SOURCES = [
  { name: 'Purchase Order', fn: overduePurchaseOrders },
  { name: 'Job Card', fn: overdueJobCards },
  { name: 'Foreign Payment', fn: overdueForeignPayments },
  { name: 'Bank Guarantee', fn: overdueBankGuarantees },
  { name: 'To-Do', fn: overdueToDos },
  { name: 'Referral Incentive', fn: overdueReferralIncentives },
  { name: 'Sales Order', fn: overdueSalesOrders },
  { name: 'Purchase Invoice', fn: overduePurchaseInvoices },
];

function getOverdueItems() {
  const bySource = {};
  let total = 0;
  for (const s of SOURCES) {
    let rows = [];
    try { rows = s.fn() || []; } catch (e) { rows = []; }
    rows.sort((a, b) => b.days_overdue - a.days_overdue);
    bySource[s.name] = rows;
    total += rows.length;
  }
  return { total, bySource };
}

module.exports = { getOverdueItems, SOURCES };

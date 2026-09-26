// Printable rendering of a Foreign Payment (Advance Remittance Against
// Imports) request, laid out to mirror the AD bank's own ARIM form sections
// (see db/schema.sql's foreign_payment_requests comment for what each field
// means) so the printed copy can be handed to the bank essentially as-is.
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return (n === null || n === undefined || n === '') ? '-' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function v(x) { return (x === null || x === undefined || x === '') ? '-' : esc(x); }

// [field, label] pairs per ARIM section, in the same order as the form.
const SECTIONS = [
  { title: 'For Office Use (Bank)', fields: [
    ['ad_code', 'AD Code'], ['bank_name', 'Bank Name'], ['branch', 'Branch'], ['bank_form_no', 'Bank Form No'],
    ['customer_id', 'Customer ID'], ['transaction_type', 'Transaction Type'], ['tr_fwc_amount', 'TR/FWC Amount'],
    ['tr_fwc_rate', 'TR/FWC Rate'], ['tr_fwc_ref_no', 'TR/FWC Ref No'], ['equivalent_inr', 'Equivalent INR'],
  ]},
  { title: 'Beneficiary', fields: [
    ['beneficiary_name', 'Name'], ['beneficiary_address_line1', 'Address Line 1'], ['beneficiary_address_line2', 'Address Line 2'],
    ['beneficiary_pincode', 'Pincode'], ['beneficiary_city', 'City'], ['beneficiary_state', 'State'], ['beneficiary_country', 'Country'],
  ]},
  { title: 'Beneficiary Bank', fields: [
    ['beneficiary_bank_name', 'Bank Name'], ['beneficiary_bank_address_line1', 'Address Line 1'], ['beneficiary_bank_address_line2', 'Address Line 2'],
    ['beneficiary_bank_pincode', 'Pincode'], ['beneficiary_bank_city', 'City'], ['beneficiary_bank_state', 'State'], ['beneficiary_bank_country', 'Country'],
    ['beneficiary_bank_swift_code', 'SWIFT Code'], ['beneficiary_bank_account_no', 'Account No'],
    ['iban_sort_code_bsb_transit', 'IBAN / Sort Code / BSB / Transit'], ['correspondent_bank_name_bic', 'Correspondent Bank Name & BIC'],
  ]},
  { title: 'II. Debit Authority', fields: [
    ['foreign_bank_charges', 'Foreign Bank Charges'], ['goods_freely_importable', 'Goods Freely Importable'],
    ['license_no', 'License No'], ['license_issue_date', 'License Issue Date'], ['license_expiry_date', 'License Expiry Date'],
    ['license_face_value', 'License Face Value'], ['license_amount_endorsed', 'License Amount Endorsed'],
    ['debit_account_no', 'Debit Account No'], ['debit_balance_account_no', 'Debit Balance Account No'],
    ['forward_contract_no', 'Forward Contract No'], ['forward_contract_booked_date', 'Forward Contract Booked Date'],
    ['part_payment_reason', 'Part Payment Reason'],
  ]},
  { title: 'III. FBG/SBLC Waiver Justification', fields: [
    ['fbg_sblc_reason', 'Reason'], ['long_standing_since', 'Long-standing Since'], ['fbg_sblc_other_reason', 'Other Reason'],
  ]},
  { title: 'IV. Transaction Details', fields: [
    ['port_of_loading', 'Port of Loading'], ['port_of_discharge', 'Port of Discharge'], ['is_merchanting_trade', 'Merchanting Trade'],
  ]},
  { title: 'V. Nature of Goods', fields: [['goods_nature', 'Goods Nature']] },
  { title: 'VI. FBG Waiver', fields: [['fbg_waiver_requested', 'FBG Waiver Requested']] },
  { title: 'Signatory', fields: [
    ['signatory_name', 'Name'], ['signatory_address_line1', 'Address Line 1'], ['signatory_address_line2', 'Address Line 2'],
    ['signatory_pincode', 'Pincode'], ['signatory_city', 'City'], ['signatory_state', 'State'], ['signatory_country', 'Country'],
    ['ie_code', 'IE Code'], ['declaration_date', 'Declaration Date'], ['declaration_place', 'Declaration Place'],
  ]},
];

function sectionHtml(fp, section) {
  return `<div class="box"><h3>${esc(section.title)}</h3><div class="kv-grid">
    ${section.fields.map(([f, label]) => `<div><span class="k">${esc(label)}:</span> <span class="val">${v(fp[f])}</span></div>`).join('')}
  </div></div>`;
}

function linesTableHtml(lines) {
  if (!lines || !lines.length) return '<p class="muted">No invoice lines on file.</p>';
  return `<table><thead><tr><th>Invoice No</th><th>Date</th><th>Terms</th><th>Currency</th><th>Amount</th><th>Qty</th><th>Description</th><th>HS Code</th><th>Origin</th><th>Consigned From</th><th>Mode</th><th>Shipment Date</th></tr></thead>
    <tbody>${lines.map(l => `<tr>
      <td>${v(l.invoice_no)}</td><td>${v(l.invoice_date)}</td><td>${v(l.terms)}</td><td>${v(l.currency)}</td><td>${fmt(l.amount)}</td>
      <td>${v(l.qty_of_goods)}</td><td>${v(l.description_of_goods)}</td><td>${v(l.hs_classification)}</td><td>${v(l.country_of_origin)}</td>
      <td>${v(l.country_consigned_from)}</td><td>${v(l.mode_of_shipment)}</td><td>${v(l.date_of_shipment)}</td>
    </tr>`).join('')}</tbody></table>`;
}

function foreignPaymentHtml(fp, company) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 2px;text-align:center;text-decoration:underline;}
    h3{font-size:12px;margin:0 0 6px;color:#1a3a6b;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .meta div span{color:#555;}
    .box{border:1px solid #ccc;padding:8px 10px;border-radius:4px;font-size:12px;margin-top:10px;page-break-inside:avoid;}
    .kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px 20px;}
    .kv-grid .k{color:#555;} .kv-grid .val{font-weight:600;}
    /* border-collapse:collapse stops Chromium repeating <thead> across a
       page break when printing, so cell borders are drawn with box-shadow
       instead of border - same look, doesn't trigger the bug. */
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:8px;} thead{display:table-header-group;} tr{page-break-inside:avoid;} th,td{box-shadow:inset 0 0 0 1px #999;padding:5px 6px;font-size:11px;text-align:left;}
    .amount-box{border:1px solid #1a3a6b;background:#f3f6fb;padding:10px;border-radius:4px;font-size:13px;margin-top:12px;}
    .declaration{font-size:11px;color:#333;margin-top:14px;line-height:1.6;}
    .foot{margin-top:50px;display:flex;justify-content:space-between;font-size:12px;}
    .muted{color:#888;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead">
    <div><div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div>
    <div class="co-sub">GSTIN: ${esc(company.gstin) || 'N/A'} &nbsp; IE Code: ${v(fp.ie_code)}</div></div>
  </div>
  <h1>APPLICATION FOR ADVANCE REMITTANCE AGAINST IMPORTS</h1>
  <div class="meta">
    <div><span>Request No:</span> <b>${esc(fp.request_no)}</b></div>
    <div><span>Status:</span> <b>${esc(fp.status)}</b></div>
    <div><span>Vendor:</span> <b>${v(fp.vendor_name)}</b></div>
    <div><span>Raised By:</span> <b>${v(fp.created_by_name)}</b></div>
  </div>
  <div class="amount-box">
    <b>I. Currency &amp; Amount:</b> ${v(fp.currency)} ${fmt(fp.amount)}
    ${fp.equivalent_inr ? ` &nbsp; (Equivalent INR: ₹${fmt(fp.equivalent_inr)})` : ''}
  </div>
  ${SECTIONS.map(s => sectionHtml(fp, s)).join('')}
  <div class="box"><h3>VII. Declaration</h3><div class="declaration">
    We hereby declare that the foreign exchange being remitted vide this application is for the import of goods
    on behalf of <b>${v(fp.import_on_behalf_of)}</b> and that the beneficiary/beneficiary's bank is not
    located in / operating from an OFAC sanctioned country (${v(fp.ofac_sanctioned_country)}). We confirm that the
    above particulars are true and that the transaction is in conformity with the extant FEMA regulations.
  </div></div>
  <h3 style="margin-top:16px;">Invoice / Shipment Details</h3>
  ${linesTableHtml(fp.lines)}
  ${fp.status === 'PaymentMade' || fp.status === 'Closed' ? `
  <div class="box"><h3>Post-Payment</h3><div class="kv-grid">
    <div><span class="k">Payment Reference:</span> <span class="val">${v(fp.payment_reference)}</span></div>
    <div><span class="k">Actual Debited Amount:</span> <span class="val">${fmt(fp.actual_debited_amount)}</span></div>
    <div><span class="k">Actual Exchange Rate:</span> <span class="val">${fmt(fp.actual_exchange_rate)}</span></div>
    <div><span class="k">Bill of Entry Due:</span> <span class="val">${v(fp.boe_due_date)}</span></div>
  </div></div>` : ''}
  <div class="foot"><div>Place: ${v(fp.declaration_place)}<br>Date: ${v(fp.declaration_date)}</div>
    <div>For ${esc(company.legal_name)}<br><br><br>${v(fp.signatory_name) !== '-' ? v(fp.signatory_name) : (company.authorized_signatory_name || 'Authorized Signatory')}</div></div>
  </body></html>`;
}

async function generateForeignPaymentPdf(fp, company) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  const outPath = path.join(tmpDir, 'foreign-payment.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(foreignPaymentHtml(fp, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateForeignPaymentPdf, foreignPaymentHtml };

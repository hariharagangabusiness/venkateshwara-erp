const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBrowser } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

function formatCompanyAddress(addr) {
  if (!addr) return '';
  const lines = [addr.line1, addr.line2, [addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')].filter(Boolean);
  return lines.map(esc).join('<br>');
}

// `lines` is every purchase_orders row sharing `po`'s po_no (one row per
// item - see routes/purchase.js's POST /orders and loadPoBundle()), so a
// single-item PO is just a one-row `lines` array and needs no special
// casing here. `po` itself (any one of those rows) supplies the header
// fields (vendor/dates/payment terms/LD/terms) that are duplicated
// identically onto every row of the group.
function poHtml(po, lines, vendor, company, companyAddress) {
  const rows = lines && lines.length ? lines : [po];
  const taxable = rows.reduce((s, l) => s + Number(l.total_value || 0), 0);
  const gstAmt = rows.reduce((s, l) => s + Number(l.gst_amount || 0), 0);
  const grand = taxable + gstAmt;
  const itemRows = rows.map((l, i) => `
    <tr><td>${i + 1}</td><td>${esc(l.item_name)}</td><td>${esc(l.hsn_code)||'-'}</td><td>${l.quantity}</td><td>${esc(l.gst_rate)||0}%</td><td>${fmt(l.rate)}</td><td>${fmt(l.total_value)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 2px;text-align:center;text-decoration:underline;}
    /* border-collapse:collapse stops Chromium repeating <thead> across a
       page break when printing, so cell borders are drawn with box-shadow
       instead of border - same look, doesn't trigger the bug. */
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:10px;} thead{display:table-header-group;} tr{page-break-inside:avoid;} th,td{box-shadow:inset 0 0 0 1px #999;padding:6px 8px;font-size:12px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .meta div span{color:#555;}
    .box{border:1px solid #ccc;padding:8px;border-radius:4px;font-size:12px;margin-top:8px;}
    .foot{margin-top:50px;display:flex;justify-content:space-between;font-size:12px;}
    .terms{font-size:11px;color:#333;margin-top:14px;white-space:pre-wrap;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead">
    <div><div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div>
    <div class="co-sub">GSTIN: ${esc(company.gstin) || 'N/A'} &nbsp; PAN: ${esc(company.pan) || 'N/A'}</div></div>
  </div>
  <h1>PURCHASE ORDER</h1>
  <div class="meta">
    <div><span>PO No:</span> <b>${esc(po.po_no)}</b></div>
    <div><span>Date:</span> <b>${new Date(po.created_at).toLocaleDateString()}</b></div>
    <div><span>Delivery Date:</span> <b>${esc(po.delivery_date) || '-'}</b></div>
    <div><span>Status:</span> <b>${esc(po.status)}</b></div>
    <div><span>Payment Terms:</span> <b>${esc(po.payment_terms) || '-'}</b></div>
  </div>
  <div class="box">
    <b>Vendor:</b> ${esc(vendor.legal_name || vendor.name)}<br>
    ${esc(vendor.address_line1)||''} ${esc(vendor.address_line2)||''} ${esc(vendor.city)||''} ${esc(vendor.state)||''} ${esc(vendor.pincode)||''}<br>
    GSTIN: ${esc(vendor.gstin) || 'N/A'} &nbsp; Contact: ${esc(vendor.contact_person)||'-'} ${esc(vendor.phone)||''}
  </div>
  ${companyAddress ? `<div class="box">
    <b>${esc(companyAddress.address_type)} Address${companyAddress.label ? ' - ' + esc(companyAddress.label) : ''}:</b><br>
    ${formatCompanyAddress(companyAddress)}${companyAddress.gstin ? '<br>GSTIN: ' + esc(companyAddress.gstin) : ''}
  </div>` : ''}
  <table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Qty</th><th>GST%</th><th>Rate (₹)</th><th>Amount (₹)</th></tr></thead>
  <tbody>${itemRows}</tbody>
  <tfoot>
    <tr><td colspan="6" style="text-align:right;">Taxable Value</td><td>₹${fmt(taxable)}</td></tr>
    <tr><td colspan="6" style="text-align:right;">GST</td><td>₹${fmt(gstAmt)}</td></tr>
    <tr><td colspan="6" style="text-align:right;"><b>Grand Total</b></td><td><b>₹${fmt(grand)}</b></td></tr>
  </tfoot></table>
  <div class="terms"><b>Terms &amp; Conditions:</b>\n${esc(po.terms) || 'Standard terms apply. Please confirm receipt of this order and expected delivery date.'}</div>
  <div class="foot"><div>Vendor Acknowledgement</div><div>For ${esc(company.legal_name)}<br><br><br>${esc(company.authorized_signatory_name) || 'Authorized Signatory'}<br>${esc(company.authorized_signatory_designation)||''}</div></div>
  </body></html>`;
}

async function generatePoPdf(po, lines, vendor, company, companyAddress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-'));
  const outPath = path.join(tmpDir, 'po.pdf');
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(poHtml(po, lines, vendor, company, companyAddress), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    if (page) await page.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generatePoPdf, poHtml };

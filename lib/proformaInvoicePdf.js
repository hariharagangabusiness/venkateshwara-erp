const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { amountInWords } = require('./invoicePdf');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

const TYPE_LABEL = { Advance: 'Advance Payment Request', PreDispatch: 'Payment Before Dispatch' };

function proformaInvoiceHtml(pf, items, client, company) {
  const rows = items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.description)}</td>
    <td>₹${fmt(it.taxable_value)}</td><td>${it.gst_rate}%</td></tr>`).join('');
  const sameState = pf.cgst > 0 || pf.sgst > 0;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    .letterhead{border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 0;text-align:center;text-decoration:underline;}
    h2{font-size:12px;margin:2px 0 0;text-align:center;color:#555;font-weight:normal;}
    /* border-collapse:collapse stops Chromium repeating <thead> across a
       page break when printing, so cell borders are drawn with box-shadow
       instead of border - same look, doesn't trigger the bug. */
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:10px;} thead{display:table-header-group;} tr{page-break-inside:avoid;} th,td{box-shadow:inset 0 0 0 1px #999;padding:6px 8px;font-size:12px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .box{border:1px solid #ccc;padding:8px;border-radius:4px;font-size:12px;margin-top:8px;}
    .foot{margin-top:50px;display:flex;justify-content:space-between;font-size:12px;}
    .words{font-size:12px;margin-top:8px;font-style:italic;}
    .note{font-size:10px;color:#888;margin-top:20px;}
    .banner{background:#fff6e5;border:1px solid #e6b800;color:#7a5c00;padding:6px 10px;border-radius:4px;font-size:11px;margin-top:10px;text-align:center;font-weight:bold;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead"><div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div>
    <div class="co-sub">GSTIN: ${esc(company.gstin) || 'N/A'} &nbsp; PAN: ${esc(company.pan) || 'N/A'} &nbsp; State: ${esc(company.state)} (${esc(company.state_code)})</div></div>
  <h1>PROFORMA INVOICE</h1>
  <h2>${esc(TYPE_LABEL[pf.invoice_type] || pf.invoice_type)}</h2>
  <div class="banner">This is a Proforma Invoice - Not a Tax Invoice. No GST liability arises from this document.</div>
  <div class="meta">
    <div><span>Proforma No:</span> <b>${esc(pf.proforma_no)}</b></div>
    <div><span>Date:</span> <b>${new Date(pf.proforma_date).toLocaleDateString()}</b></div>
    <div><span>Place of Supply:</span> <b>${esc(pf.place_of_supply) || '-'}</b></div>
    <div><span>Status:</span> <b>${esc(pf.status)}</b></div>
  </div>
  <div class="box"><b>Bill To:</b> ${esc(client.name)}<br>${esc(client.address) || ''}<br>
    GSTIN: ${esc(pf.buyer_gstin) || 'N/A'} &nbsp; State: ${esc(pf.buyer_state) || '-'}</div>
  ${pf.milestone_name ? `<div class="box"><b>Payment Term:</b> ${esc(pf.milestone_name)}</div>` : ''}
  <table><thead><tr><th>#</th><th>Description</th><th>Value (₹)</th><th>GST Rate</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr><td colspan="2" style="text-align:right;">Taxable Value</td><td colspan="2">₹${fmt(pf.taxable_value)}</td></tr>
    ${sameState ? `<tr><td colspan="2" style="text-align:right;">CGST (est.)</td><td colspan="2">₹${fmt(pf.cgst)}</td></tr>
    <tr><td colspan="2" style="text-align:right;">SGST (est.)</td><td colspan="2">₹${fmt(pf.sgst)}</td></tr>` :
    `<tr><td colspan="2" style="text-align:right;">IGST (est.)</td><td colspan="2">₹${fmt(pf.igst)}</td></tr>`}
    <tr><td colspan="2" style="text-align:right;"><b>Total Payable</b></td><td colspan="2"><b>₹${fmt(pf.total_value)}</b></td></tr>
  </tfoot></table>
  <div class="words">Amount in words: ${esc(amountInWords(pf.total_value))}</div>
  <div class="foot"><div>Receiver's Signature</div><div>For ${esc(company.legal_name)}<br><br><br>${esc(company.authorized_signatory_name) || 'Authorized Signatory'}<br>${esc(company.authorized_signatory_designation)||''}</div></div>
  <div class="note">This proforma invoice is for advance/pre-dispatch payment request purposes only and does not constitute a tax invoice under GST law. A GST-compliant tax invoice will be issued separately.</div>
  </body></html>`;
}

async function generateProformaInvoicePdf(pf, items, client, company) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  const outPath = path.join(tmpDir, 'proforma.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(proformaInvoiceHtml(pf, items, client, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateProformaInvoicePdf };

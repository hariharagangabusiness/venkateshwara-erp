// Printable Annexure for an approved FOC (Free of Cost) material request -
// the document that replaces a paper hand-off slip or an email between
// Finance/Management and the department issuing the material. Same
// puppeteer HTML-to-PDF pattern as every other document in this app
// (lib/poPdf.js etc.), with the fulfilling department's HOD to-do (see
// routes/finance.js's notifyFocRouted) pointing whoever picks it up back to
// this same printable record.
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function v(x) { return (x === null || x === undefined || x === '') ? '-' : esc(x); }

function focAnnexureHtml(foc, company) {
  const customer = foc.client_master_name || foc.customer_name || '-';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 2px;text-align:center;text-decoration:underline;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .meta div span{color:#555;}
    .box{border:1px solid #ccc;padding:10px;border-radius:4px;font-size:12px;margin-top:10px;}
    /* border-collapse:collapse stops Chromium repeating <thead> across a
       page break when printing, so cell borders are drawn with box-shadow
       instead of border - same look, doesn't trigger the bug. */
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:10px;} thead{display:table-header-group;} tr{page-break-inside:avoid;} th,td{box-shadow:inset 0 0 0 1px #999;padding:6px 8px;font-size:12px;text-align:left;}
    .foot{margin-top:60px;display:flex;justify-content:space-between;font-size:12px;}
    .foot div{width:45%;}
    .sig-line{margin-top:40px;border-top:1px solid #333;padding-top:4px;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead">
    <div><div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div>
    <div class="co-sub">GSTIN: ${esc(company.gstin) || 'N/A'}</div></div>
  </div>
  <h1>FREE OF COST (FOC) MATERIAL ISSUE - ANNEXURE</h1>
  <div class="meta">
    <div><span>FOC No:</span> <b>${esc(foc.foc_no)}</b></div>
    <div><span>Status:</span> <b>${esc(foc.status)}</b></div>
    <div><span>Sales Order:</span> <b>${v(foc.order_no)}</b></div>
    <div><span>Requesting Department:</span> <b>${v(foc.department_name)}</b></div>
    <div><span>Customer:</span> <b>${esc(customer)}</b></div>
    <div><span>Requested By:</span> <b>${v(foc.requested_by_name)}</b></div>
  </div>
  <table><thead><tr><th>Item / Material Description</th><th>Qty</th><th>Unit</th><th>Estimated Value (₹)</th></tr></thead>
  <tbody><tr><td>${esc(foc.item_description)}</td><td>${foc.quantity}</td><td>${esc(foc.unit)}</td><td>${fmt(foc.estimated_value)}</td></tr></tbody></table>
  <div class="box"><b>Reason:</b> ${v(foc.reason)}</div>
  <div class="box">
    <b>Approved By:</b> ${v(foc.approved_by_name)} &nbsp; <b>Approved On:</b> ${foc.approved_at ? new Date(foc.approved_at).toLocaleDateString() : '-'}<br>
    <b>Routed To (fulfilling department):</b> ${v(foc.fulfilling_department_name)}
  </div>
  <div class="foot">
    <div>Issued By (fulfilling department)<div class="sig-line">Name / Signature / Date</div></div>
    <div>Received By (customer / site)<div class="sig-line">Name / Signature / Date</div></div>
  </div>
  </body></html>`;
}

async function generateFocAnnexurePdf(foc, company) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foc-'));
  const outPath = path.join(tmpDir, 'foc-annexure.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(focAnnexureHtml(foc, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateFocAnnexurePdf, focAnnexureHtml };

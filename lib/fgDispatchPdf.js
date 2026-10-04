// Delivery Challan / Packing List for a customer FG dispatch - same field
// shape as the internal-stock-transfer Challan (lib/challanPdf.js: vehicle
// no, transporter, e-way bill no) but for an actual sale, with the
// "Not For Sale" wording dropped since this genuinely is one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBrowser } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

function fgDispatchHtml(dispatch, items, client, company) {
  const rows = items.map((it, i) => `
    <tr><td>${i + 1}</td><td>${esc(it.description)}</td><td>${esc(it.hsn_code)||'-'}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    h1{font-size:18px;margin:0 0 2px;} .sub{color:#555;font-size:12px;margin-bottom:16px;}
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:14px;} thead{display:table-header-group;} tr{page-break-inside:avoid;} th,td{box-shadow:inset 0 0 0 1px #999;padding:6px 8px;font-size:12px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:13px;margin-top:10px;}
    .meta div span{color:#555;}
    .foot{margin-top:40px;display:flex;justify-content:space-between;font-size:12px;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company, 'Venkateshwara Engineers')}
  <h1>${esc(company.legal_name) || 'Venkateshwara Engineers'}</h1>
  <div class="sub">${esc(company.registered_address)||''} &mdash; DELIVERY CHALLAN / PACKING LIST</div>
  <div class="meta">
    <div><span>Dispatch No:</span> <b>${esc(dispatch.dispatch_no)}</b></div>
    <div><span>Date:</span> <b>${new Date(dispatch.dispatch_date).toLocaleDateString()}</b></div>
    <div><span>Consignee:</span> <b>${esc(client && (client.legal_name || client.name)) || '-'}</b></div>
    <div><span>GSTIN:</span> <b>${esc(client && client.gstin) || 'N/A'}</b></div>
    <div><span>Vehicle No:</span> <b>${esc(dispatch.vehicle_no)||'-'}</b></div>
    <div><span>Transporter:</span> <b>${esc(dispatch.transporter_name)||'-'}</b></div>
    <div><span>E-Way Bill No:</span> <b>${esc(dispatch.eway_bill_no)||'-'}</b></div>
    <div><span>Against Order:</span> <b>${esc(dispatch.order_no)||'-'}</b></div>
  </div>
  <table><thead><tr><th>#</th><th>Description</th><th>HSN Code</th><th>Qty</th><th>Unit</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="foot"><div>Receiver's Signature</div><div>For ${esc(company.legal_name) || 'Venkateshwara Engineers'}<br><br><br>Authorized Signatory</div></div>
  </body></html>`;
}

async function generateFgDispatchPdf(dispatch, items, client, company) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgdispatch-'));
  const outPath = path.join(tmpDir, 'dispatch.pdf');
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(fgDispatchHtml(dispatch, items, client, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    if (page) await page.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateFgDispatchPdf };

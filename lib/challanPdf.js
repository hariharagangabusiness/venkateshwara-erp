const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY, documentStampHtml, DOC_STAMP_STYLE } = require('./pdfBranding');
const { getCompanySettings } = require('./settings');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
 
function challanHtml(c, items, company) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    h1{font-size:18px;margin:0 0 2px;} .sub{color:#555;font-size:12px;margin-bottom:16px;}
    table{width:100%;border-collapse:collapse;margin-top:14px;} th,td{border:1px solid #999;padding:6px 8px;font-size:12px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:13px;margin-top:10px;}
    .meta div span{color:#555;}
    .foot{margin-top:40px;display:flex;justify-content:space-between;font-size:12px;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
    ${DOC_STAMP_STYLE}
  </style></head><body>
  ${watermarkHtml(company, 'Venkateshwara Engineers')}
  <h1>Venkateshwara Engineers</h1>
  <div class="sub">Faridabad, Haryana &mdash; DELIVERY CHALLAN (Not a Tax Invoice / Not For Sale)</div>
  ${documentStampHtml({
    docType: 'Delivery Challan',
    reference: c.challan_no,
    partyLabel: 'Customer',
    partyName: c.consignee_name,
    date: new Date(c.challan_date).toLocaleDateString(),
    version: 'Generated: ' + new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  })}
  <div class="meta">
    <div><span>Challan No:</span> <b>${esc(c.challan_no)}</b></div>
    <div><span>Date:</span> <b>${new Date(c.challan_date).toLocaleDateString()}</b></div>
    <div><span>From Location:</span> <b>${esc(c.from_location)}</b></div>
    <div><span>To Location:</span> <b>${esc(c.to_location)}</b></div>
    <div><span>Vehicle No:</span> <b>${esc(c.vehicle_no)||'-'}</b></div>
    <div><span>Transport Mode:</span> <b>${esc(c.transport_mode)}</b></div>
    <div><span>Transporter:</span> <b>${esc(c.transporter_name)||'-'}</b></div>
    <div><span>Distance (km):</span> <b>${esc(c.distance_km)||'-'}</b></div>
    <div><span>Consignor:</span> <b>${esc(c.consignor_name)}</b> (${esc(c.consignor_gstin)||'GSTIN N/A'})</div>
    <div><span>Consignee:</span> <b>${esc(c.consignee_name)||'-'}</b> (${esc(c.consignee_gstin)||'GSTIN N/A'})</div>
    <div><span>E-Way Bill No:</span> <b>${esc(c.eway_bill_no)||'-'}</b></div>
    <div><span>PO/Reference:</span> <b>${esc(c.po_no)||'-'}</b></div>
    <div style="grid-column:1/-1;"><span>Reason for Transport:</span> <b>${esc(c.reason)}</b></div>
  </div>
  <table><thead><tr><th>#</th><th>Description</th><th>HSN Code</th><th>Qty</th><th>Unit</th><th>Rate (₹)</th><th>Value (₹)</th></tr></thead>
  <tbody>${items.map((it,i) => `<tr><td>${i+1}</td><td>${esc(it.description)}</td><td>${esc(it.hsn_code)||'-'}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${fmt(it.rate)}</td><td>${fmt(it.value)}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="6" style="text-align:right;"><b>Total Value</b></td><td><b>₹${fmt(c.total_value)}</b></td></tr></tfoot></table>
  <div class="foot"><div>Receiver's Signature</div><div>For Venkateshwara Engineers<br><br><br>Authorized Signatory</div></div>
  </body></html>`;
}
 
// Generates the challan PDF and returns its filesystem path (caller should
// delete the returned tmpDir after streaming it).
async function generateChallanPdf(challan, items) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challan-'));
  const outPath = path.join(tmpDir, 'challan.pdf');
 
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(challanHtml(challan, items, getCompanySettings()), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
 
  return { outPath, tmpDir };
}
 
module.exports = { generateChallanPdf };

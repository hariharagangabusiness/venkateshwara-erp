const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

function poHtml(po, vendor, company) {
  const total = Number(po.total_value || 0);
  const gstAmt = Number(po.gst_amount || 0);
  const grand = total + gstAmt;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;padding:0;margin:0;color:#111;}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 2px;text-align:center;text-decoration:underline;}
    table{width:100%;border-collapse:collapse;margin-top:10px;} th,td{border:1px solid #999;padding:6px 8px;font-size:12px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .meta div span{color:#555;}
    .box{border:1px solid #ccc;padding:8px;border-radius:4px;font-size:12px;margin-top:8px;}
    .foot{margin-top:50px;display:flex;justify-content:space-between;font-size:12px;}
    .terms{font-size:11px;color:#333;margin-top:14px;white-space:pre-wrap;}
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
  </div>
  <div class="box">
    <b>Vendor:</b> ${esc(vendor.legal_name || vendor.name)}<br>
    ${esc(vendor.address_line1)||''} ${esc(vendor.address_line2)||''} ${esc(vendor.city)||''} ${esc(vendor.state)||''} ${esc(vendor.pincode)||''}<br>
    GSTIN: ${esc(vendor.gstin) || 'N/A'} &nbsp; Contact: ${esc(vendor.contact_person)||'-'} ${esc(vendor.phone)||''}
  </div>
  <table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Qty</th><th>Rate (₹)</th><th>Amount (₹)</th></tr></thead>
  <tbody><tr><td>1</td><td>${esc(po.item_name)}</td><td>${esc(po.hsn_code)||'-'}</td><td>${po.quantity}</td><td>${fmt(po.rate)}</td><td>${fmt(total)}</td></tr></tbody>
  <tfoot>
    <tr><td colspan="5" style="text-align:right;">Taxable Value</td><td>₹${fmt(total)}</td></tr>
    <tr><td colspan="5" style="text-align:right;">GST @ ${esc(po.gst_rate)||0}%</td><td>₹${fmt(gstAmt)}</td></tr>
    <tr><td colspan="5" style="text-align:right;"><b>Grand Total</b></td><td><b>₹${fmt(grand)}</b></td></tr>
  </tfoot></table>
  <div class="terms"><b>Terms &amp; Conditions:</b>\n${esc(po.terms) || 'Standard terms apply. Please confirm receipt of this order and expected delivery date.'}</div>
  <div class="foot"><div>Vendor Acknowledgement</div><div>For ${esc(company.legal_name)}<br><br><br>${esc(company.authorized_signatory_name) || 'Authorized Signatory'}<br>${esc(company.authorized_signatory_designation)||''}</div></div>
  </body></html>`;
}

async function generatePoPdf(po, vendor, company) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-'));
  const outPath = path.join(tmpDir, 'po.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(poHtml(po, vendor, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generatePoPdf, poHtml };

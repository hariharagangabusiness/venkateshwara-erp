const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

function orderConfirmationHtml(oc, salesOrder, client, company) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    .letterhead{border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 0;text-align:center;text-decoration:underline;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .box{border:1px solid #ccc;padding:8px;border-radius:4px;font-size:12px;margin-top:10px;}
    .foot{margin-top:50px;display:flex;justify-content:space-between;font-size:12px;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead"><div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div></div>
  <h1>ORDER CONFIRMATION</h1>
  <div class="meta">
    <div><span>Sales Order No:</span> <b>${esc(salesOrder.order_no)}</b></div>
    <div><span>Date:</span> <b>${new Date(salesOrder.order_date).toLocaleDateString()}</b></div>
    <div><span>Order Value:</span> <b>₹${fmt(salesOrder.order_value)}</b></div>
    <div><span>Status:</span> <b>${esc(oc.status)}</b></div>
  </div>
  <div class="box"><b>Customer:</b> ${esc(client.name)}<br>${esc(client.address) || ''}</div>
  <div class="box"><b>Description:</b><br>${nl2br(salesOrder.description)}</div>
  <div class="box"><b>Delivery Terms:</b><br>${nl2br(oc.delivery_terms) || '-'}</div>
  <div class="box"><b>Payment Terms:</b><br>${nl2br(oc.payment_terms) || '-'}</div>
  ${oc.special_instructions ? `<div class="box"><b>Special Instructions:</b><br>${nl2br(oc.special_instructions)}</div>` : ''}
  <div class="foot"><div>Customer Acknowledgement</div><div>For ${esc(company.legal_name)}<br><br><br>${esc(company.authorized_signatory_name) || 'Authorized Signatory'}</div></div>
  </body></html>`;
}

async function generateOrderConfirmationPdf(oc, salesOrder, client, company) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  const outPath = path.join(tmpDir, 'order-confirmation.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(orderConfirmationHtml(oc, salesOrder, client, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateOrderConfirmationPdf };

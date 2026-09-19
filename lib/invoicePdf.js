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

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n) { if (n < 20) return ONES[n]; return (TENS[Math.floor(n / 10)] + ' ' + ONES[n % 10]).trim(); }
function threeDigits(n) { if (n < 100) return twoDigits(n); return (ONES[Math.floor(n / 100)] + ' Hundred ' + twoDigits(n % 100)).trim(); }
function amountInWords(num) {
  num = Math.round(Number(num) || 0);
  if (num === 0) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  if (crore) parts.push(threeDigits(crore) + ' Crore');
  if (lakh) parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (num) parts.push(threeDigits(num));
  return parts.join(' ').replace(/\s+/g, ' ').trim() + ' Rupees Only';
}

function invoiceHtml(inv, items, client, company) {
  const rows = items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.description)}</td><td>${esc(it.hsn_code) || '-'}</td>
    <td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${fmt(it.rate)}</td><td>${fmt(it.taxable_value)}</td></tr>`).join('');
  const sameState = inv.cgst > 0 || inv.sgst > 0;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;padding:0;margin:0;color:#111;}
    .letterhead{border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 2px;text-align:center;text-decoration:underline;}
    table{width:100%;border-collapse:collapse;margin-top:10px;} th,td{border:1px solid #999;padding:6px 8px;font-size:12px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .box{border:1px solid #ccc;padding:8px;border-radius:4px;font-size:12px;margin-top:8px;}
    .foot{margin-top:50px;display:flex;justify-content:space-between;font-size:12px;}
    .words{font-size:12px;margin-top:8px;font-style:italic;}
    .note{font-size:10px;color:#888;margin-top:20px;}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead"><div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div>
    <div class="co-sub">GSTIN: ${esc(company.gstin) || 'N/A'} &nbsp; PAN: ${esc(company.pan) || 'N/A'} &nbsp; State: ${esc(company.state)} (${esc(company.state_code)})</div></div>
  <h1>TAX INVOICE</h1>
  <div class="meta">
    <div><span>Invoice No:</span> <b>${esc(inv.invoice_no)}</b></div>
    <div><span>Invoice Date:</span> <b>${new Date(inv.invoice_date).toLocaleDateString()}</b></div>
    <div><span>Place of Supply:</span> <b>${esc(inv.place_of_supply)}</b></div>
    <div><span>Status:</span> <b>${esc(inv.status)}</b></div>
  </div>
  <div class="box"><b>Bill To:</b> ${esc(client.name)}<br>${esc(client.address) || ''}<br>
    GSTIN: ${esc(inv.buyer_gstin) || 'N/A'} &nbsp; State: ${esc(inv.buyer_state) || '-'}</div>
  <table><thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th>Qty</th><th>Unit</th><th>Rate (₹)</th><th>Taxable Value (₹)</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr><td colspan="6" style="text-align:right;">Taxable Value</td><td>₹${fmt(inv.taxable_value)}</td></tr>
    ${sameState ? `<tr><td colspan="6" style="text-align:right;">CGST</td><td>₹${fmt(inv.cgst)}</td></tr>
    <tr><td colspan="6" style="text-align:right;">SGST</td><td>₹${fmt(inv.sgst)}</td></tr>` :
    `<tr><td colspan="6" style="text-align:right;">IGST</td><td>₹${fmt(inv.igst)}</td></tr>`}
    <tr><td colspan="6" style="text-align:right;"><b>Total</b></td><td><b>₹${fmt(inv.total_value)}</b></td></tr>
  </tfoot></table>
  <div class="words">Amount in words: ${esc(amountInWords(inv.total_value))}</div>
  <div class="foot"><div>Receiver's Signature</div><div>For ${esc(company.legal_name)}<br><br><br>${esc(company.authorized_signatory_name) || 'Authorized Signatory'}<br>${esc(company.authorized_signatory_designation)||''}</div></div>
  <div class="note">This is a system-generated tax invoice. Figures are computed per standard GST invoicing structure (GSTIN, HSN/SAC, place of supply, CGST/SGST/IGST split) — verify with your GST practitioner before relying on it for statutory filing.</div>
  </body></html>`;
}

async function generateInvoicePdf(inv, items, client, company) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  const outPath = path.join(tmpDir, 'invoice.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(invoiceHtml(inv, items, client, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateInvoicePdf, amountInWords };

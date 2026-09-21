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
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'; }

function soaHtml(client, ledger, period, company) {
  const rows = ledger.rows.map(r => `
    <tr><td>${fmtDate(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.ref)}</td><td>${esc(r.description)}</td>
    <td class="right">${r.debit ? fmt(r.debit) : '-'}</td><td class="right">${r.credit ? fmt(r.credit) : '-'}</td>
    <td class="right">${fmt(r.balance)}</td></tr>`).join('');
  const balanceLabel = ledger.closingBalance >= 0 ? 'Amount Receivable' : 'Amount in Credit (Advance)';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;padding:0;margin:0;color:#111;}
    .letterhead{border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 0;text-align:center;text-decoration:underline;}
    h2{font-size:12px;margin:2px 0 0;text-align:center;color:#555;font-weight:normal;}
    table{width:100%;border-collapse:collapse;margin-top:10px;} th,td{border:1px solid #999;padding:5px 7px;font-size:11px;text-align:left;}
    .right{text-align:right;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .box{border:1px solid #ccc;padding:8px;border-radius:4px;font-size:12px;margin-top:8px;}
    .summary{margin-top:14px;display:flex;justify-content:flex-end;}
    .summary table{width:auto;min-width:280px;}
    .foot{margin-top:40px;font-size:11px;color:#555;}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead"><div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div>
    <div class="co-sub">GSTIN: ${esc(company.gstin) || 'N/A'} &nbsp; State: ${esc(company.state)}</div></div>
  <h1>STATEMENT OF ACCOUNTS</h1>
  <h2>${period.start ? fmtDate(period.start) : 'Account Opening'} to ${period.end ? fmtDate(period.end) : 'Date of Statement'}</h2>
  <div class="meta">
    <div><span>Statement Period:</span> <b>${period.start ? fmtDate(period.start) : 'Account Opening'} - ${period.end ? fmtDate(period.end) : 'Date of Statement'}</b></div>
    <div><span>Generated:</span> <b>${fmtDate(new Date().toISOString())}</b></div>
  </div>
  <div class="box"><b>Account of:</b> ${esc(client.name)}<br>${esc(client.address) || ''}<br>
    GSTIN: ${esc(client.gstin) || 'N/A'}</div>
  <table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Description</th><th class="right">Debit (₹)</th><th class="right">Credit (₹)</th><th class="right">Balance (₹)</th></tr></thead>
  <tbody>
    <tr><td colspan="6" class="right"><b>Opening Balance</b></td><td class="right"><b>${fmt(ledger.openingBalance)}</b></td></tr>
    ${rows || '<tr><td colspan="7" style="text-align:center;">No transactions in this period.</td></tr>'}
  </tbody></table>
  <div class="summary"><table>
    <tr><td>Total Debit (Invoiced)</td><td class="right">₹${fmt(ledger.totalDebit)}</td></tr>
    <tr><td>Total Credit (Received)</td><td class="right">₹${fmt(ledger.totalCredit)}</td></tr>
    <tr><td><b>Closing Balance</b></td><td class="right"><b>₹${fmt(Math.abs(ledger.closingBalance))} ${ledger.closingBalance !== 0 ? '(' + balanceLabel + ')' : ''}</b></td></tr>
  </table></div>
  <div class="foot">This statement is generated from our records as of ${fmtDate(new Date().toISOString())}. Please report any discrepancy within 7 days of receipt.</div>
  </body></html>`;
}

async function generateSoaPdf(client, ledger, period, company) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-'));
  const outPath = path.join(tmpDir, 'soa.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(soaHtml(client, ledger, period, company), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateSoaPdf };

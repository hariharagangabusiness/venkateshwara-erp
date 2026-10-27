const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { getBrowser } = require('./browserPath');
const { amountInWords } = require('./invoicePdf');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');
const { formatDate } = require('./dateFormat');
const { esc, fmt } = require('./pdfHtml');


const TYPE_LABEL = { Advance: 'Advance Payment Request', PreDispatch: 'Payment Before Dispatch' };

// Plain-text bank details (not a UPI pay-link - this is a scan-to-read QR,
// not a scan-to-pay one) - built once and reused both for the printed
// block and for what the QR code itself encodes, so the two can never
// drift apart. Returns null when nothing's actually on file in Company
// Settings, so a server that's never filled this in prints nothing rather
// than a mostly-blank box.
function bankDetailsText(company) {
  const lines = [
    company.bank_name && `Bank Name: ${company.bank_name}`,
    company.bank_account_number && `Account No: ${company.bank_account_number}`,
    company.bank_ifsc && `IFSC Code: ${company.bank_ifsc}`,
    company.bank_branch && `Branch: ${company.bank_branch}`,
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

function proformaInvoiceHtml(pf, items, client, company, bankQrDataUri) {
  // Split into SL No / Description / Units / Unit Price / GST % / Total
  // excl. GST columns (2026-10-27) - the quantity used to be folded into
  // the Description text (or simply always 1), with no way to see unit
  // price separately from the line's total.
  const rows = items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.description)}</td>
    <td>${it.quantity ?? 1} ${esc(it.unit) || 'Nos'}</td><td>₹${fmt(it.rate != null ? it.rate : it.taxable_value)}</td>
    <td>${it.gst_rate}%</td><td>₹${fmt(it.taxable_value)}</td></tr>`).join('');
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
    <div><span>Date:</span> <b>${formatDate(pf.proforma_date)}</b></div>
    <div><span>Place of Supply:</span> <b>${esc(pf.place_of_supply) || '-'}</b></div>
    ${pf.so_po_number ? `<div><span>Purchase Order No:</span> <b>${esc(pf.so_po_number)}</b></div>
    <div><span>PO Date:</span> <b>${formatDate(pf.so_po_date)}</b></div>` : ''}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
    <div class="box"><b>Bill To:</b> ${esc(client.name)}<br>${esc(client.address) || ''}<br>
      ${client.contact_person || client.phone ? `Contact: ${esc(client.contact_person) || '-'}${client.phone ? ' &nbsp; Phone: ' + esc(client.phone) : ''}<br>` : ''}
      GSTIN: ${esc(pf.buyer_gstin) || 'N/A'} &nbsp; State: ${esc(pf.buyer_state) || '-'}</div>
    <div class="box"><b>Ship To:</b><br>${esc(pf.ship_to_address) ? esc(pf.ship_to_address).replace(/\n/g, '<br>') : '-'}</div>
  </div>
  ${pf.milestone_name ? `<div class="box"><b>Payment Term:</b> ${esc(pf.milestone_name)}</div>` : ''}
  <table><thead><tr><th>SL No</th><th>Description</th><th>Units</th><th>Unit Price (₹)</th><th>GST %</th><th>Total excl. GST (₹)</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr><td colspan="4" style="text-align:right;">Taxable Value</td><td colspan="2">₹${fmt(pf.taxable_value)}</td></tr>
    ${pf.packing_forwarding_amount ? `<tr><td colspan="4" style="text-align:right;">Packing &amp; Forwarding${pf.packing_forwarding_percent ? ` (${pf.packing_forwarding_percent}%)` : ''}</td><td colspan="2">₹${fmt(pf.packing_forwarding_amount)}</td></tr>` : ''}
    ${sameState ? `<tr><td colspan="4" style="text-align:right;">CGST (est.)</td><td colspan="2">₹${fmt(pf.cgst)}</td></tr>
    <tr><td colspan="4" style="text-align:right;">SGST (est.)</td><td colspan="2">₹${fmt(pf.sgst)}</td></tr>` :
    `<tr><td colspan="4" style="text-align:right;">IGST (est.)</td><td colspan="2">₹${fmt(pf.igst)}</td></tr>`}
    ${pf.advance_received ? `<tr><td colspan="4" style="text-align:right;">Less: Advance Received</td><td colspan="2">(₹${fmt(pf.advance_received)})</td></tr>` : ''}
    <tr><td colspan="4" style="text-align:right;"><b>Total Payable</b></td><td colspan="2"><b>₹${fmt(pf.total_value)}</b></td></tr>
  </tfoot></table>
  <div class="words">Amount in words: ${esc(amountInWords(pf.total_value))}</div>
  <div class="foot"><div>Receiver's Signature</div><div>For ${esc(company.legal_name)}<br><br><br>Authorized Signatory${company.proforma_signatory_designation ? `<br>${esc(company.proforma_signatory_designation)}` : ''}</div></div>
  ${bankDetailsText(company) ? `<div class="box" style="margin-top:20px;display:flex;justify-content:space-between;align-items:center;gap:16px;">
    <div><b>Bank Details for Payment</b><br>${esc(bankDetailsText(company)).replace(/\n/g, '<br>')}</div>
    ${bankQrDataUri ? `<img src="${bankQrDataUri}" width="90" height="90" alt="Bank details QR">` : ''}
  </div>` : ''}
  <div class="note">This proforma invoice is for advance/pre-dispatch payment request purposes only and does not constitute a tax invoice under GST law. A GST-compliant tax invoice will be issued separately.</div>
  </body></html>`;
}

async function generateProformaInvoicePdf(pf, items, client, company) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  const outPath = path.join(tmpDir, 'proforma.pdf');
  // QR encodes the same plain-text bank details printed right next to it
  // (a scan-to-read QR, not a UPI scan-to-pay one - no payment VPA is
  // captured anywhere in this app) - generated once here, before the HTML
  // is built, since QRCode.toDataURL() is async and proformaInvoiceHtml()
  // itself stays a plain sync string-builder like every other PDF in this app.
  const bankText = bankDetailsText(company);
  const bankQrDataUri = bankText ? await QRCode.toDataURL(bankText, { margin: 1, width: 180 }).catch(() => null) : null;
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(proformaInvoiceHtml(pf, items, client, company, bankQrDataUri), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    if (page) await page.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateProformaInvoicePdf, bankDetailsText };

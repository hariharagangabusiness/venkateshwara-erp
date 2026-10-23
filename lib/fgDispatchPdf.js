// Delivery Challan / Packing List for a customer FG dispatch - same field
// shape as the internal-stock-transfer Challan (lib/challanPdf.js: vehicle
// no, transporter, e-way bill no) but for an actual sale, with the
// "Not For Sale" wording dropped since this genuinely is one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBrowser } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');
const { formatDate } = require('./dateFormat');
const { esc, fmt } = require('./pdfHtml');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');


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
    <div><span>Date:</span> <b>${formatDate(dispatch.dispatch_date)}</b></div>
    <div><span>Consignee:</span> <b>${esc(client && (client.legal_name || client.name)) || '-'}</b></div>
    <div><span>GSTIN:</span> <b>${esc(client && client.gstin) || 'N/A'}</b></div>
    <div><span>Vehicle No:</span> <b>${esc(dispatch.vehicle_no)||'-'}</b></div>
    <div><span>Transporter:</span> <b>${esc(dispatch.transporter_name)||'-'}</b></div>
    <div><span>E-Way Bill No:</span> <b>${esc(dispatch.eway_bill_no)||'-'}</b></div>
    <div><span>Against Order:</span> <b>${esc(dispatch.order_no)||'-'}</b></div>
    <div><span>Invoice No:</span> <b>${esc(dispatch.invoice_number)||'-'}</b></div>
    <div><span>Insurance No:</span> <b>${esc(dispatch.insurance_number)||'-'}</b></div>
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

// "Vehicle Request to Transporter" (2026-10-23) - a variation of the challan
// above for asking a transporter to send a vehicle: no vehicle/transporter/
// e-way bill/receiver-signature slots (none exist yet at request time), but
// the customer's delivery address + phone and the requested pick-up date.
// `shipTo` is a pre-formatted address string (Ship-To, else main address).
function transporterRequestHtml(dispatch, items, client, shipTo, company, pickupDate) {
  const rows = items.map((it, i) => `
    <tr><td>${i + 1}</td><td>${esc(it.description)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td></tr>`).join('');
  const phone = client && client.phone
    ? esc(client.phone) + (client.contact_person ? ` (${esc(client.contact_person)})` : '')
    : '-';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    h1{font-size:18px;margin:0 0 2px;} .sub{color:#555;font-size:12px;margin-bottom:16px;}
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:14px;} thead{display:table-header-group;} tr{page-break-inside:avoid;} th,td{box-shadow:inset 0 0 0 1px #999;padding:6px 8px;font-size:12px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:13px;margin-top:10px;}
    .meta div span{color:#555;}
    .box{border:1px solid #ccc;padding:8px 10px;border-radius:4px;font-size:13px;margin-top:12px;}
    .foot{margin-top:40px;display:flex;justify-content:flex-end;font-size:12px;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company, 'Venkateshwara Engineers')}
  <h1>${esc(company.legal_name) || 'Venkateshwara Engineers'}</h1>
  <div class="sub">${esc(company.registered_address)||''} &mdash; VEHICLE REQUEST TO TRANSPORTER</div>
  <div class="meta">
    <div><span>Dispatch No:</span> <b>${esc(dispatch.dispatch_no)}</b></div>
    <div><span>Date:</span> <b>${formatDate(dispatch.dispatch_date)}</b></div>
    <div><span>Consignee:</span> <b>${esc(client && (client.legal_name || client.name)) || '-'}</b></div>
    <div><span>Against Order:</span> <b>${esc(dispatch.order_no)||'-'}</b></div>
  </div>
  <div class="box"><b>Delivery Address:</b><br>${esc(shipTo || '-').replace(/\n/g, '<br>')}<br><br><b>Customer Phone:</b> ${phone}</div>
  <div class="box"><b>Date of Pick-up to be Arranged:</b> ${pickupDate ? formatDate(pickupDate) : '-'}</div>
  <table><thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="foot"><div>For ${esc(company.legal_name) || 'Venkateshwara Engineers'}<br><br><br>Authorized Signatory</div></div>
  </body></html>`;
}

async function generateTransporterRequestPdf(dispatch, items, client, shipTo, company, pickupDate) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transporter-req-'));
  const outPath = path.join(tmpDir, 'vehicle-request.pdf');
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(transporterRequestHtml(dispatch, items, client, shipTo, company, pickupDate), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    if (page) await page.close();
  }
  return { outPath, tmpDir };
}

// Formal covering letter to the customer once the material has left
// (2026-10-23). Dated with the dispatch's own date, not today's.
// dispatchData = { dispatch, items, client, shipTo, company }.
function coveringLetterHtml({ dispatch, items, client, shipTo, company }) {
  const rows = items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.description)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td></tr>`).join('');
  const name = client && (client.legal_name || client.name);
  const greeting = client && client.contact_person ? `Dear ${esc(client.contact_person)},` : 'Dear Sir / Madam,';
  const grid = [
    ['Invoice No', dispatch.invoice_number], ['Date', formatDate(dispatch.dispatch_date)],
    ['Transporter Name', dispatch.transporter_name], ['Vehicle No', dispatch.vehicle_no],
    ['E-Way Bill No', dispatch.eway_bill_no], ['Insurance Reference', dispatch.insurance_number],
  ].map(([k, v]) => `<div><span>${k}:</span> <b>${esc(v) || '-'}</b></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;font-size:13px;line-height:1.5;}
    h1{font-size:18px;margin:0 0 2px;} .sub{color:#555;font-size:12px;margin-bottom:16px;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;border:1px solid #ccc;border-radius:4px;padding:8px 10px;margin:12px 0;}
    .grid span{color:#555;}
    table{width:100%;border-collapse:separate;border-spacing:0;margin-top:10px;} thead{display:table-header-group;} tr{page-break-inside:avoid;} th,td{box-shadow:inset 0 0 0 1px #999;padding:6px 8px;font-size:12px;text-align:left;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company, 'Venkateshwara Engineers')}
  <h1>${esc(company.legal_name) || 'Venkateshwara Engineers'}</h1>
  <div class="sub">${esc(company.registered_address)||''}</div>
  <div style="text-align:right;">Date: ${formatDate(dispatch.dispatch_date)}</div>
  <p>To,<br><b>${esc(name) || '-'}</b><br>${esc(shipTo || '-').replace(/\n/g, '<br>')}${client && client.phone ? `<br>Phone: ${esc(client.phone)}` : ''}</p>
  <p><b>Subject: Dispatch of materials against Order No ${esc(dispatch.order_no) || '-'} (Dispatch ${esc(dispatch.dispatch_no)})</b></p>
  <p>${greeting}</p>
  <p>We are pleased to inform you that the materials ordered by you against the above order have been securely loaded and dispatched through the designated transporter. The dispatch details are as follows:</p>
  <div class="grid">${grid}</div>
  <p>The items contained in this consignment are listed below for your verification on receipt:</p>
  <table><thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table>
  <p style="margin-top:14px;">Kindly acknowledge receipt, and inform us immediately of any shortage or damage noticed on delivery. Thank you for your business.</p>
  <p style="margin-top:30px;">Yours faithfully,<br><b>For ${esc(company.legal_name) || 'Venkateshwara Engineers'}</b><br><br><br>Authorized Signatory</p>
  </body></html>`;
}

// DL envelope / stick-on label: just the Ship-To address and phone, big and
// bold - no header, logo or watermark.
function envelopeHtml({ shipTo, client }) {
  const name = client && (client.legal_name || client.name);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:220mm 110mm;margin:0;}
    body{margin:0;padding:14mm 18mm;color:#000;font-family:Arial,Helvetica,sans-serif;}
    .to{font-size:13pt;font-weight:bold;letter-spacing:1px;margin-bottom:4px;}
    .name{font-size:22pt;font-weight:bold;margin-bottom:4px;}
    .addr{font-size:20pt;font-weight:bold;line-height:1.3;}
    .ph{font-size:20pt;font-weight:bold;margin-top:10px;}
  </style></head><body>
  <div class="to">TO:</div>
  <div class="name">${esc(name) || ''}</div>
  <div class="addr">${esc(shipTo || '').replace(/\n/g, '<br>')}</div>
  ${client && client.phone ? `<div class="ph">Phone: ${esc(client.phone)}</div>` : ''}
  </body></html>`;
}

async function renderPdf(prefix, name, html, pdfOpts) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outPath = path.join(tmpDir, name);
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf(Object.assign({ path: outPath, printBackground: true }, pdfOpts));
  } finally {
    if (page) await page.close();
  }
  return { outPath, tmpDir };
}

function generateCustomerCoveringLetterPdf(dispatchData) {
  return renderPdf('covering-letter-', 'covering-letter.pdf', coveringLetterHtml(dispatchData),
    { format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
}
function generateEnvelopePdf(dispatchData) {
  return renderPdf('envelope-', 'envelope.pdf', envelopeHtml(dispatchData),
    { width: '220mm', height: '110mm', margin: { top: '0', bottom: '0', left: '0', right: '0' } });
}

// Customer bundle (2026-10-23): the covering letter followed by whichever of
// the uploaded dispatch documents exist, merged into one PDF. `slots` is in
// final page order: [{ label, file }] where `file` is an absolute path or
// null (nothing uploaded). PDFs are appended page-for-page at their own page
// size; images are placed (fit, centred) on an A4 page. Anything missing or
// unreadable is skipped, never fatal - the caller reports `skipped`.
const A4 = [595.28, 841.89];
async function assembleCustomerBundle(coverBuffer, slots) {
  const out = await PDFDocument.create();
  const append = async (doc) => (await out.copyPages(doc, doc.getPageIndices())).forEach(p => out.addPage(p));
  await append(await PDFDocument.load(coverBuffer));
  const included = ['Covering Letter'];
  const skipped = [];
  for (const { label, file } of slots) {
    if (!file || !fs.existsSync(file)) { skipped.push({ label, reason: 'not uploaded' }); continue; }
    try {
      const bytes = fs.readFileSync(file);
      if (path.extname(file).toLowerCase() === '.pdf') {
        await append(await PDFDocument.load(bytes, { ignoreEncryption: true }));
      } else {
        const jpg = await sharp(bytes, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
        const img = await out.embedJpg(jpg);
        const margin = 36;
        const scale = Math.min((A4[0] - 2 * margin) / img.width, (A4[1] - 2 * margin) / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        out.addPage(A4).drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
      }
      included.push(label);
    } catch (e) {
      skipped.push({ label, reason: 'unreadable or unsupported file type' });
    }
  }
  return { buffer: Buffer.from(await out.save()), included, skipped };
}

module.exports = { generateFgDispatchPdf, generateTransporterRequestPdf, generateCustomerCoveringLetterPdf, generateEnvelopePdf, assembleCustomerBundle };

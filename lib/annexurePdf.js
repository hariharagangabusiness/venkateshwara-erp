const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBrowser } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY, LETTERHEAD_STYLE, companyLetterheadHtml } = require('./pdfBranding');
const { formatDate } = require('./dateFormat');
const { esc } = require('./pdfHtml');
const { resolveUploadPath } = require('./paths');

function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

// Mirrors lib/annexureDocx.js's own offerItemImageRun() - a missing file on
// disk or an unreadable image just means no picture for that row, never a
// thrown error, same defensive behavior the Word export already has.
function imageDataUri(imagePath) {
  if (!imagePath) return null;
  try {
    const abs = resolveUploadPath(imagePath);
    if (!fs.existsSync(abs)) return null;
    const buffer = fs.readFileSync(abs);
    let ext = path.extname(abs).slice(1).toLowerCase();
    if (ext === 'jpg') ext = 'jpeg';
    if (!['jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return null;
    return `data:image/${ext};base64,${buffer.toString('base64')}`;
  } catch (e) { return null; }
}

// Same content/section rules as lib/annexureDocx.js's generateAnnexureDocx()
// - see that file's own comment for the full rationale (Project Data Sheet /
// Make Of Bought Out Items are offer-only; Scope Of Supply renders from
// whichever source is available; Spares orders drop the tech specs/bought-
// out sections and gain a Picture column instead). This is a parallel HTML/
// PDF rendering of the identical data, not a port of the .docx file itself -
// kept in its own function so either format can be requested independently.
function annexureHtml({ salesOrder, client, offer, items, techSpecs, boughtOut, company }) {
  const isSpares = !!(offer && offer.offer_format === 'Spares');

  const headerRows = [
    ['Sales Order No', esc(salesOrder.order_no)],
    ['Customer', esc(client.name)],
    ['Subject / Machine', esc(offer ? offer.subject : salesOrder.description)],
    ['Date', formatDate(salesOrder.order_date)],
  ];
  if (salesOrder.po_number) {
    headerRows.push(['Purchase Order No', esc(salesOrder.po_number)]);
    if (salesOrder.po_date) headerRows.push(['PO Date', formatDate(salesOrder.po_date)]);
  }

  let body = '';
  if (offer && !isSpares) {
    body += `<h2>Project Data Sheet</h2>
      <p><b>Application:</b> ${esc(offer.application)}</p>
      <p><b>Type Of System:</b> ${esc(offer.type_of_system)}</p>
      <p><b>Material Of Construction:</b> ${esc(offer.material_of_construction)}</p>`;
    if (techSpecs && techSpecs.length && offer.show_tech_specs !== 0) {
      body += `<table class="kv"><tbody>${techSpecs.map(s => `<tr><td class="label">${esc(s.spec_key)}</td><td>${esc(s.spec_value)}</td></tr>`).join('')}</tbody></table>`;
    }
  }

  if (items && items.length) {
    const hasPicture = isSpares;
    body += `<h2>Scope Of Supply — Machinery Description</h2>
      <table class="items"><thead><tr>
        <th>S.No</th><th>Item</th>${hasPicture ? '<th>Picture</th>' : ''}<th>Description</th><th>Qty</th>
      </tr></thead><tbody>
      ${items.map((it, idx) => {
        const pic = hasPicture ? imageDataUri(it.image_path) : null;
        return `<tr>
          <td class="center">${idx + 1}</td>
          <td>${esc(it.item_code)}</td>
          ${hasPicture ? `<td class="center">${pic ? `<img src="${pic}" style="max-width:120px;max-height:120px;">` : ''}</td>` : ''}
          <td>${it.section_title ? `<b>${esc(it.section_title)}</b><br>` : ''}${nl2br(it.description)}</td>
          <td class="center">${it.unit ? esc(`${it.qty || ''} ${it.unit}`.trim()) : esc(it.qty || '')}</td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  }

  if (offer && !isSpares && boughtOut && boughtOut.length) {
    body += `<h2>Make Of Bought Out Items</h2>
      <table class="kv"><tbody>${boughtOut.map(b => `<tr><td class="label">${esc(b.component)}</td><td>${esc(b.make)}</td></tr>`).join('')}</tbody></table>`;
  }

  if (!offer && !(items && items.length)) {
    body += `<p>No linked offer and no line items found on this sales order - nothing available for this annexure yet.</p>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    h1{font-size:15px;margin:16px 0 0;text-align:center;}
    h2{font-size:13px;margin:18px 0 8px;}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;}
    table.kv td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;}
    table.kv td.label{font-weight:bold;background:#f2f2f2;width:35%;}
    table.items th,table.items td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;}
    table.items th{background:#dbe5f1;text-align:left;}
    .center{text-align:center;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:12px;margin-top:12px;}
    .meta .label{font-weight:bold;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
    ${LETTERHEAD_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  ${companyLetterheadHtml(company)}
  <h1>Annexure to Sales Order (Engineering / Execution Reference)</h1>
  <div class="meta">${headerRows.map(([l, v]) => `<div><span class="label">${esc(l)}:</span> ${v}</div>`).join('')}</div>
  ${body}
  </body></html>`;
}

async function generateAnnexurePdf(data) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annexure-'));
  const outPath = path.join(tmpDir, 'annexure.pdf');
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.setContent(annexureHtml(data), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    if (page) await page.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateAnnexurePdf };

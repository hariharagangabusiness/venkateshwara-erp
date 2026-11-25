const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { getBrowser } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY, LETTERHEAD_STYLE, companyLetterheadHtml } = require('./pdfBranding');
const { formatDate } = require('./dateFormat');
const { esc } = require('./pdfHtml');
const { resolveUploadPath } = require('./paths');

const A4_PT = [595.28, 841.89];

// Formats the Annexure can actually print: PDF pages are copied in, images are fitted to an A4 page.
// .dwg/.dxf have no converter on the server (none installed) - they are never renderable here.
const GA_RENDERABLE_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
// rows = every GADrawing attachment on the offer, newest first. The newest RENDERABLE one wins, so a .dwg
// uploaded together with a companion PDF/PNG prints the companion; a .dwg alone is flagged unrenderable.
function pickGaDrawing(rows) {
  if (!rows || !rows.length) return null;
  const ok = rows.find(r => GA_RENDERABLE_EXT.includes(path.extname(r.original_name || r.file_path || '').toLowerCase())
    || GA_RENDERABLE_EXT.includes(path.extname(r.file_path || '').toLowerCase()));
  return ok ? { ...ok } : { ...rows[0], unrenderable: true };
}

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
function annexureHtml({ salesOrder, client, offer, items, techSpecs, boughtOut, annexures, gaDrawing, notes, company }) {
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
    // Technical Specification table removed outright (2026-11-21, requested
    // directly by the owner) - GA Drawing No takes its place as a 4th line.
    // Same <table> cell metrics (11px, 4px 6px padding, bordered) as Scope Of Supply below
    const pds = [['Application', offer.application], ['Type Of System', offer.type_of_system],
      ['Material Of Construction', offer.material_of_construction], ['GA Drawing No', offer.drawing_no]];
    body += `<h2>Project Data Sheet</h2>
      <table class="kv"><tbody>${pds.map(([l, v]) => `<tr><td class="label">${l}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
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

  if (offer && !isSpares && offer.show_bought_out !== 0 && boughtOut && boughtOut.length) {
    body += `<h2>Make Of Bought Out Items</h2>
      <table class="kv"><tbody>${boughtOut.map(b => `<tr><td class="label">${esc(b.component)}</td><td>${esc(b.make)}</td></tr>`).join('')}</tbody></table>`;
  }

  // The offer's own Annexure grid (offer_annexures), carried onto the order via its linked offer. Execution
  // reference only, so Rate/Amount are deliberately left out (same rule as Scope Of Supply above; this
  // document is also emailed to HODs).
  if (offer && annexures && annexures.length) {
    body += `<h2>Offer Annexure</h2>
      <table class="items"><colgroup><col style="width:5%"><col style="width:11%"><col style="width:10%"><col style="width:38%"><col style="width:8%"><col style="width:8%"><col style="width:20%"></colgroup>
      <thead><tr><th>S.No</th><th>Item Code</th><th>HSN Code</th><th>Description</th><th>Qty</th><th>Uom</th><th>Remarks</th></tr></thead>
      <tbody>${annexures.map((a, i) => `<tr><td class="center">${i + 1}</td><td class="center">${esc(a.item_code)}</td><td class="center">${esc(a.hsn_code)}</td><td>${nl2br(a.description)}</td><td class="center">${esc(a.qty)}</td><td class="center">${esc(a.unit)}</td><td>${nl2br(a.remarks)}</td></tr>`).join('')}</tbody></table>`;
  }

  if (!offer && !(items && items.length)) {
    body += `<p>No linked offer and no line items found on this sales order - nothing available for this annexure yet.</p>`;
  }

  // Notes (2026-11-21) - free text entered against this Annexure. Printed
  // ahead of the GA Drawing marker below, so the drawing's own merged pages
  // (appended at the very end of the whole document by generateAnnexurePdf())
  // are the last thing in the file, immediately after their own intro line.
  if (notes) {
    body += `<h2>Notes</h2><p>${nl2br(notes)}</p>`;
  }

  // GA Drawing (2026-11-21) - shown after Make Of Bought Out Items; the
  // drawing's own pages are merged in for real right after this point by
  // generateAnnexurePdf() below (pdf-lib) - this line is just the
  // in-document marker so a reader knows one follows.
  if (gaDrawing) {
    body += `<h2>GA Drawing</h2><p>${gaDrawing.unrenderable
      ? `${esc(gaDrawing.original_name || 'GA Drawing')} is a CAD file and cannot be printed here. Upload a PDF or image copy of the GA Drawing (document type GA Drawing) on the offer's Attachments tab to have it appear in this Annexure.`
      : `${esc(gaDrawing.original_name || 'GA Drawing')} - attached on the following page(s).`}</p>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    /* Uniform font (2026-11-21) - one explicit family for the whole
       document rather than relying on inheritance, so this can never
       drift from Word's own single-font fix in lib/annexureDocx.js. */
    *{font-family:Arial,sans-serif;}
    /* one body size (11px) for every section: tables, data sheet, notes, meta */
    body{padding:0;margin:0;color:#111;font-size:11px;line-height:1.45;}
    p{margin:6px 0;}
    h1{font-size:15px;margin:16px 0 0;text-align:center;}
    h2{font-size:13px;margin:18px 0 8px;}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;}
    table.kv td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;}
    table.kv td.label{font-weight:bold;background:#f2f2f2;width:35%;}
    table.items th,table.items td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;}
    table.items th{background:#dbe5f1;text-align:left;}
    /* The Scope Of Supply table shouldn't spread a single row across a
       page break, and its header row should repeat on whichever later
       page the table continues onto (2026-11-21, requested directly by
       the owner) - thead repeating as a header/footer group across pages
       is standard CSS table-pagination behavior that Chromium's own
       print/PDF engine already honors. */
    table.items thead{display:table-header-group;}
    table.items tbody{display:table-row-group;}
    table.items tr{page-break-inside:avoid;}
    .center{text-align:center;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-top:12px;}
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

// Appends the GA Drawing's own pages after the already-rendered base
// Annexure PDF (2026-11-21, requested directly by the owner - shown right
// after Make Of Bought Out Items, which is the last real content before
// this merge runs). A .pdf file's pages are copied in directly; any other
// format (jpg/png/etc.) is placed, fit and centred, on its own A4 page -
// same technique lib/fgDispatchPdf.js's assembleCustomerBundle() already
// uses for the FG Dispatch Customer Bundle. Never throws - a missing or
// unreadable drawing file just means the base Annexure is returned as-is.
async function mergeGaDrawing(basePdfPath, gaDrawing) {
  if (!gaDrawing) return null;
  try {
    const absPath = resolveUploadPath(gaDrawing.file_path);
    if (!fs.existsSync(absPath)) return null;
    const out = await PDFDocument.create();
    const append = async (doc) => (await out.copyPages(doc, doc.getPageIndices())).forEach(p => out.addPage(p));
    await append(await PDFDocument.load(fs.readFileSync(basePdfPath)));
    const bytes = fs.readFileSync(absPath);
    if (path.extname(absPath).toLowerCase() === '.pdf') {
      await append(await PDFDocument.load(bytes, { ignoreEncryption: true }));
    } else {
      const jpg = await sharp(bytes, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
      const img = await out.embedJpg(jpg);
      const margin = 36;
      const scale = Math.min((A4_PT[0] - 2 * margin) / img.width, (A4_PT[1] - 2 * margin - 20) / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      const pg = out.addPage(A4_PT);
      pg.drawText(String(gaDrawing.original_name || 'GA Drawing').slice(0, 90), { x: margin, y: A4_PT[1] - margin + 10, size: 10, font: await out.embedFont(StandardFonts.Helvetica), color: rgb(0.1, 0.1, 0.1) });
      pg.drawImage(img, { x: (A4_PT[0] - w) / 2, y: (A4_PT[1] - h) / 2 - 8, width: w, height: h });
    }
    return Buffer.from(await out.save());
  } catch (e) { return null; }
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
  const merged = await mergeGaDrawing(outPath, data.gaDrawing);
  if (merged) fs.writeFileSync(outPath, merged);
  return { outPath, tmpDir };
}

module.exports = { generateAnnexurePdf, pickGaDrawing, mergeGaDrawing };

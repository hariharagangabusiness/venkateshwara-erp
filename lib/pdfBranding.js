// Shared watermark for every generated PDF in the app (invoices, proforma
// invoices, purchase orders, challans, offers, service reports) - a faint,
// professional logo/company-name mark repeated across every printed page.
const fs = require('fs');
const path = require('path');
const { getUploadsDir } = require('./paths');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Puppeteer's page.setContent() has no base URL to resolve a relative
// /uploads/... path against, so the logo is inlined as a base64 data: URI -
// the PDF stays self-contained regardless of where it's later opened.
function logoDataUri(company) {
  if (!company || !company.logo_path) return null;
  try {
    const rel = String(company.logo_path).replace(/^\/?uploads\//, '');
    const abs = path.join(getUploadsDir(), rel);
    if (!fs.existsSync(abs)) return null;
    const ext = path.extname(abs).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  } catch (e) { return null; }
}

// Shared body typography for every generated PDF except the offer PDF
// (lib/offerPdf.js), which deliberately reproduces a specific physical
// letterhead (serif header/footer) and is left alone. Puppeteer renders PDFs
// entirely offline inside the server's own headless Chromium, so a webfont
// like Inter can't be fetched at render time - this uses the same
// widely-available system-UI sans-serif stack as the web app itself
// (see public/index.html) for one consistent look across every document a
// customer or internal reviewer might see, with a comfortable line-height
// for print legibility.
const PDF_BASE_TYPOGRAPHY = `
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.45; }
`;

// Pure CSS: a huge, rotated, very-low-opacity element positioned fixed so it
// repeats on every printed page with no per-page JS. No z-index trick needed -
// placed first in the body, so it draws behind content that follows it in
// normal DOM order, on every one of these templates (none sets an opaque
// full-page background that would otherwise hide it).
const WATERMARK_STYLE = `
  .pdf-watermark {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg);
    opacity: 0.07; pointer-events: none; text-align: center;
    width: 140%; font-size: 60px; font-weight: bold; color: #1a3a6b; white-space: nowrap;
    font-family: Arial, sans-serif;
  }
  .pdf-watermark img { max-width: 320px; max-height: 320px; opacity: 1; }
`;

function watermarkHtml(company, fallbackName) {
  const logo = logoDataUri(company);
  const name = (company && (company.legal_name || company.trade_name)) || fallbackName || '';
  return `<div class="pdf-watermark">${logo ? `<img src="${logo}">` : esc(name)}</div>`;
}

// Universal identifying stamp, added just under the letterhead of every
// generated PDF: what the document is + its reference number, who it's for
// (when there is a natural counterparty - a Purchase Order's is a vendor, an
// Invoice's a customer, some internal documents have none), when it's dated,
// and a version marker. Most document types have no real revision counter
// (a GST invoice or challan is never "v2" once issued) - for those, callers
// pass the PDF's own generation timestamp instead, which is always accurate
// and needs no schema change. Offers are the one type with a real version
// (offers.version), so lib/offerPdf.js passes that through instead.
function documentStampHtml({ docType, reference, partyLabel, partyName, date, version }) {
  const parts = [
    `${esc(docType)}${reference ? ' ' + esc(reference) : ''}`,
    partyName ? `${esc(partyLabel || 'For')}: ${esc(partyName)}` : null,
    date ? `Date: ${esc(date)}` : null,
    version ? esc(version) : null,
  ].filter(Boolean);
  return `<div class="pdf-doc-stamp">${parts.join(' &nbsp;|&nbsp; ')}</div>`;
}

const DOC_STAMP_STYLE = `
  .pdf-doc-stamp { font-size: 10px; color: #667; text-align: right; margin: 2px 0 10px; }
`;

module.exports = { WATERMARK_STYLE, watermarkHtml, logoDataUri, PDF_BASE_TYPOGRAPHY, documentStampHtml, DOC_STAMP_STYLE };

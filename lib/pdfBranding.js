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

module.exports = { WATERMARK_STYLE, watermarkHtml, logoDataUri };

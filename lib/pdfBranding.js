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

// Shared company letterhead block (2026-10-27) - every PDF that shows the
// company's own name/identity, except the Offer PDF (lib/offerPdf.js, which
// deliberately reproduces its own distinct branded Cover Page/Company
// Profile design), uses this exact block: legal name, full registered
// address, then GSTIN/PAN/State+Code on one line - the same shape the
// Proforma Invoice (the reference template named by the repo owner) and
// Sales Invoice already used. Centralized here so every document stays in
// sync automatically rather than each file hand-rolling (and inevitably
// drifting from) its own copy - the exact "fixed in one file, stale in
// another" problem that led to the Covering Letter/Vehicle Request PDFs
// missing GSTIN/PAN/State entirely before this round.
const LETTERHEAD_STYLE = `
  .letterhead{border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
  .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
`;
function companyLetterheadHtml(company, extraLine) {
  const c = company || {};
  return `<div class="letterhead"><div class="co-name">${esc(c.legal_name) || 'Venkateshwara Engineers'}</div><div class="co-sub">${esc(c.registered_address) || ''}</div>
    <div class="co-sub">GSTIN: ${esc(c.gstin) || 'N/A'} &nbsp; PAN: ${esc(c.pan) || 'N/A'} &nbsp; State: ${esc(c.state) || 'N/A'} (${esc(c.state_code) || 'N/A'})${extraLine ? ' &nbsp; ' + extraLine : ''}</div></div>`;
}

module.exports = { WATERMARK_STYLE, watermarkHtml, logoDataUri, PDF_BASE_TYPOGRAPHY, LETTERHEAD_STYLE, companyLetterheadHtml };

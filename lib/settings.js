// Generic key-value settings store (db/schema `settings` table via migration).
// Company Settings / Email Settings are stored as JSON blobs under fixed keys.
const { db } = require('../db');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

function setSetting(key, value) {
  const json = JSON.stringify(value);
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, json);
}

const DEFAULT_COMPANY = {
  legal_name: 'Venkateshwara Engineers',
  trade_name: 'Venkateshwara Engineers',
  gstin: '',
  pan: '',
  cin: '',
  registered_address: 'Faridabad, Haryana, India',
  factory_address: '',
  state: 'Haryana',
  state_code: '06',
  default_place_of_supply: 'Haryana',
  bank_name: '',
  bank_account_number: '',
  bank_ifsc: '',
  bank_branch: '',
  authorized_signatory_name: '',
  authorized_signatory_designation: '',
  logo_path: '',
  default_gst_rate: 18,
};

const DEFAULT_EMAIL = {
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_pass: '',
  smtp_secure: false,
  from_name: 'Venkateshwara Engineers',
  from_address: '',
  cc_list: [], // array of email strings, always CC'd on automated emails
};

function getCompanySettings() {
  return Object.assign({}, DEFAULT_COMPANY, getSetting('company', {}));
}
function setCompanySettings(v) {
  setSetting('company', Object.assign({}, DEFAULT_COMPANY, getCompanySettings(), v));
}
const DEFAULT_PURCHASE = {
  quote_threshold: 200000, // estimated_value at/above this requires >=2 vendor quotes before approval starts
};

function getPurchaseSettings() {
  return Object.assign({}, DEFAULT_PURCHASE, getSetting('purchase', {}));
}
function setPurchaseSettings(v) {
  setSetting('purchase', Object.assign({}, DEFAULT_PURCHASE, getPurchaseSettings(), v));
}

const DEFAULT_SERVICE = {
  reopen_window_days: 15, // free-of-charge SR reopen window from the technician's closure date
};

function getServiceSettings() {
  return Object.assign({}, DEFAULT_SERVICE, getSetting('service', {}));
}
function setServiceSettings(v) {
  setSetting('service', Object.assign({}, DEFAULT_SERVICE, getServiceSettings(), v));
}

function getEmailSettings() {
  return Object.assign({}, DEFAULT_EMAIL, getSetting('email', {}));
}
function setEmailSettings(v) {
  setSetting('email', Object.assign({}, DEFAULT_EMAIL, getEmailSettings(), v));
}

// Optional admin-uploaded override for the Offer PDF's cover page / header /
// footer images. Each of the three is independently toggleable and OFF by
// default - lib/offerPdf.js falls back to its hand-tuned, pixel-matched
// default letterhead (header1.xml/footer1.xml-derived text header/footer,
// static brand photo-collage cover) unless an admin has both uploaded an
// image AND explicitly switched that piece on, so nothing regresses for an
// installation that never touches this page.
// cover_docx_* (a Word document merged/parsed as the cover page, distinct
// from cover_image_* above), cover_pdf_* (an uploaded PDF whose own pages
// are prepended onto the generated offer PDF as-is - see lib/offerPdf.js's
// mergeCoverPdf()) and header_richtext_*/footer_richtext_* (admin-authored
// formatted HTML from the rich-text toolbar in public/js/app.js) all follow
// the exact same "uploaded/authored AND switched on" opt-in rule - see
// lib/offerPdf.js's coverPage()/headerTemplate()/footerTemplate() for the
// precedence order each piece resolves through.
const DEFAULT_OFFER_PDF_TEMPLATE = {
  header_image_path: '', header_active: false,
  footer_image_path: '', footer_active: false,
  cover_image_path: '', cover_active: false,
  cover_docx_path: '', cover_docx_active: false,
  cover_pdf_path: '', cover_pdf_active: false,
  header_richtext: '', header_richtext_active: false,
  footer_richtext: '', footer_richtext_active: false,
};
function getOfferPdfTemplate() {
  return Object.assign({}, DEFAULT_OFFER_PDF_TEMPLATE, getSetting('offer_pdf_template', {}));
}
function setOfferPdfTemplate(v) {
  setSetting('offer_pdf_template', Object.assign({}, DEFAULT_OFFER_PDF_TEMPLATE, getOfferPdfTemplate(), v));
}

// Offer PDF Layout Designer (visual drag-and-drop builder, routes/offers.js's
// /pdf-layout, public/js/app.js's 'offer-pdf-designer' page) - a newer,
// higher-precedence alternative to the override pieces above. Each of the
// three pieces (header/footer/cover) is independent and inactive by default,
// same opt-in-per-piece rule as DEFAULT_OFFER_PDF_TEMPLATE: designing one
// piece here never touches the other two, and an installation that has
// never opened this designer keeps the exact same default/override letterhead
// it already had. `html`/`css` are GrapesJS's own exported strings (what
// lib/offerPdf.js actually renders, after {{token}} substitution) - `project`
// is GrapesJS's full project data (components/styles/pages), kept only so
// the designer can re-open a piece for further editing; lib/offerPdf.js
// never reads it.
const DEFAULT_OFFER_PDF_LAYOUT_PIECE = { active: false, html: '', css: '', project: null };
const DEFAULT_OFFER_PDF_LAYOUT = {
  header: Object.assign({}, DEFAULT_OFFER_PDF_LAYOUT_PIECE),
  footer: Object.assign({}, DEFAULT_OFFER_PDF_LAYOUT_PIECE),
  cover: Object.assign({}, DEFAULT_OFFER_PDF_LAYOUT_PIECE),
};
function getOfferPdfLayout() {
  const stored = getSetting('offer_pdf_layout', {});
  return {
    header: Object.assign({}, DEFAULT_OFFER_PDF_LAYOUT_PIECE, stored.header),
    footer: Object.assign({}, DEFAULT_OFFER_PDF_LAYOUT_PIECE, stored.footer),
    cover: Object.assign({}, DEFAULT_OFFER_PDF_LAYOUT_PIECE, stored.cover),
  };
}
// Merges into just the one named piece - routes/offers.js always calls this
// with a single piece's full replacement fields, never the other two, so a
// plain top-level Object.assign (like setOfferPdfTemplate's) would silently
// wipe them; this keeps them untouched.
function setOfferPdfLayoutPiece(piece, v) {
  const current = getOfferPdfLayout();
  current[piece] = Object.assign({}, DEFAULT_OFFER_PDF_LAYOUT_PIECE, current[piece], v);
  setSetting('offer_pdf_layout', current);
  return current;
}

// Offer governance (Round 40) - admin-editable kill switches for the
// immutability/compliance behavior in routes/offers.js. Every flag here
// exists so a change in that behavior is a checkbox, not a code deploy:
// flipping lock_on_so_conversion off, for instance, reverts SO conversion
// to its pre-Round-40 behavior (never sets offers.locked) instantly, with
// no migration rollback needed - an offer already locked stays locked
// (see routes/offers.js's Admin-only /unlock for reversing that one by one).
const DEFAULT_OFFER_GOVERNANCE = {
  lock_on_so_conversion: true,
  require_library_clauses: false,
};
function getOfferGovernanceSettings() {
  return Object.assign({}, DEFAULT_OFFER_GOVERNANCE, getSetting('offer_governance', {}));
}
function setOfferGovernanceSettings(v) {
  setSetting('offer_governance', Object.assign({}, DEFAULT_OFFER_GOVERNANCE, getOfferGovernanceSettings(), v));
}

// Centralized typography design tokens (Round 40) for the offer PDF - every
// default value below is copied EXACTLY from lib/offerPdf.js's previously-
// hardcoded BASE_CSS/headerTemplate()/footerTemplate() literals, so an
// installation that never touches this panel renders byte-for-byte the same
// pixel-matched letterhead as before these tokens existed. show_page_numbers
// defaults on (Puppeteer's built-in pageNumber/totalPages header/footer
// classes) since running page numbers are the one genuinely new, always-on
// capability this round adds - not an optional override - but it's a single
// checkbox to switch back off if it ever causes a layout problem.
const DEFAULT_OFFER_DESIGN_TOKENS = {
  body_font_family: "'Calibri', Arial, sans-serif",
  body_font_size_px: 13.3,
  body_line_height: 1.5,
  body_color: '#111111',
  heading_color: '#111111',
  header_title_color: '#0000FF',
  header_title_size_px: 34.5,
  header_subtitle_color: '#808080',
  header_subtitle_size_px: 13.3,
  footer_font_size_px: 13.3,
  footer_color: '#000000',
  show_page_numbers: true,
  legal_notice_text: '',
};
function getOfferDesignTokens() {
  return Object.assign({}, DEFAULT_OFFER_DESIGN_TOKENS, getSetting('offer_design_tokens', {}));
}
function setOfferDesignTokens(v) {
  setSetting('offer_design_tokens', Object.assign({}, DEFAULT_OFFER_DESIGN_TOKENS, getOfferDesignTokens(), v));
}

module.exports = { getSetting, setSetting, getCompanySettings, setCompanySettings, getEmailSettings, setEmailSettings, getPurchaseSettings, setPurchaseSettings, getServiceSettings, setServiceSettings, getOfferPdfTemplate, setOfferPdfTemplate, getOfferGovernanceSettings, setOfferGovernanceSettings, getOfferDesignTokens, setOfferDesignTokens, getOfferPdfLayout, setOfferPdfLayoutPiece, DEFAULT_COMPANY, DEFAULT_EMAIL, DEFAULT_PURCHASE, DEFAULT_SERVICE, DEFAULT_OFFER_PDF_TEMPLATE, DEFAULT_OFFER_GOVERNANCE, DEFAULT_OFFER_DESIGN_TOKENS, DEFAULT_OFFER_PDF_LAYOUT };

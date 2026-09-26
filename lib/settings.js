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
// installation that never touches this page. See lib/offerPdf.js's
// coverPage()/headerTemplate()/footerTemplate() for the precedence order
// each piece resolves through against the Offer PDF Layout Designer below.
const DEFAULT_OFFER_PDF_TEMPLATE = {
  header_image_path: '', header_active: false,
  footer_image_path: '', footer_active: false,
  cover_image_path: '', cover_active: false,
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

// Fixed typography for the offer PDF's hand-tuned default letterhead - every
// value below is copied exactly from what used to be (and, before that, was
// once again) hardcoded literal in lib/offerPdf.js, so its default output
// never changes. Not admin-editable (that settings panel was removed) -
// lib/offerPdf.js imports this constant directly. show_page_numbers stays on
// (Puppeteer's built-in pageNumber/totalPages header/footer classes).
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

module.exports = { getSetting, setSetting, getCompanySettings, setCompanySettings, getEmailSettings, setEmailSettings, getPurchaseSettings, setPurchaseSettings, getServiceSettings, setServiceSettings, getOfferPdfTemplate, setOfferPdfTemplate, getOfferGovernanceSettings, setOfferGovernanceSettings, getOfferPdfLayout, setOfferPdfLayoutPiece, DEFAULT_COMPANY, DEFAULT_EMAIL, DEFAULT_PURCHASE, DEFAULT_SERVICE, DEFAULT_OFFER_PDF_TEMPLATE, DEFAULT_OFFER_GOVERNANCE, DEFAULT_OFFER_DESIGN_TOKENS, DEFAULT_OFFER_PDF_LAYOUT };

const fs = require('fs');
const os = require('os');
const path = require('path');
const mammoth = require('mammoth');
const { PDFDocument } = require('pdf-lib');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, documentStampHtml, DOC_STAMP_STYLE } = require('./pdfBranding');
const { resolveUploadPath } = require('./paths');
const { getCompanySettings, getOfferPdfTemplate, getOfferDesignTokens } = require('./settings');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

const COMPANY_ADDRESS_LINES = [
  `222,TYPE 'D;' 221,TYPE 'D;'215,TYPE 'B';HSIIDC; SECTOR-59`,
  `FARIDABAD &ndash; 121004, HARYANA. GST NO.06AYKPS4742F1Z7`,
  `PH :09810304413;Email &ndash; anand1917@venkateshwaraengineers.com`,
  `<a href="https://venkateshwaraengineers.com">https://venkateshwaraengineers.com</a>`,
];

// The reference letterhead's page 1 is a static brand/product photo cover -
// identical on every offer, no per-quote data - so its images are loaded
// once at module load rather than per-render. Read as base64 data URIs for
// the same reason as pdfBranding.js's logo: Puppeteer's page.setContent()
// has no base URL to resolve a relative path against.
const COVER_IMAGE_DIR = path.join(__dirname, '..', 'assets', 'offer-cover');
function coverImageDataUri(filename) {
  const abs = path.join(COVER_IMAGE_DIR, filename);
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}
const COVER_IMAGES = {
  industries: coverImageDataUri('industries-strip.jpg'),
  fertilizerLine: coverImageDataUri('fertilizer-packing-line.jpg'),
  factorySite: coverImageDataUri('factory-site.jpg'),
  logo: coverImageDataUri('logo.png'),
  bagStation: coverImageDataUri('bag-station.jpg'),
  conveyorSingle: coverImageDataUri('conveyor-single.jpg'),
  conveyorMulti: coverImageDataUri('conveyor-multi.jpg'),
  // Row of 6 product swatches (granules/crystals/grain/pellets/powders) -
  // extracted directly from the company's reference cover-page document
  // (Standar_Cover_Page.doc) as a single pre-composited strip, same as how
  // that source document itself supplies it - see coverPage() below.
  productSwatches: coverImageDataUri('product-swatches.jpg'),
};

// Converts an admin-uploaded override image (a relative /uploads/... path)
// to a base64 data URI, same reasoning as coverImageDataUri above - read at
// render time (not module load) since these can change, and swallow a
// missing/unreadable file rather than crashing the PDF generation.
function overrideImageDataUri(relPath) {
  if (!relPath) return null;
  try {
    const abs = resolveUploadPath(relPath);
    const ext = path.extname(relPath).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// A stored cover_pdf_path is only trusted as a genuine cover source once
// confirmed to still exist on disk and start with a real PDF signature -
// same "never let a bad upload silently break the whole render" principle
// as docxCoverHtml()/overrideImageDataUri() below, just checked directly
// here since there's no HTML parse step to fail during for a raw PDF.
// Returns the absolute path (not the bytes - mergeCoverPdf() reads it
// again at merge time) so coverPage() and generateOfferPdf() can each run
// this same check independently and always agree on the answer.
function pdfCoverAbsPath(relPath) {
  if (!relPath) return null;
  let fd;
  try {
    const abs = resolveUploadPath(relPath);
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    return buf.toString('ascii') === '%PDF-' ? abs : null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Prepends an uploaded cover PDF's own pages onto the generated offer body
// PDF, in place (overwrites bodyPdfPath) - a real page-level PDF merge via
// pdf-lib (pure JS, no system binary/LibreOffice dependency, so it behaves
// identically here and in production) rather than an HTML approximation of
// the cover's content. Note: the body's "Page X of Y" footer (see
// lib/settings.js's show_page_numbers token) is computed by Puppeteer
// before this merge runs, so it counts only the body pages - the physical
// page numbers in the final merged document run that many pages ahead of
// what the footer says, by however many pages the uploaded cover has.
async function mergeCoverPdf(coverPdfAbsPath, bodyPdfPath) {
  const [coverBytes, bodyBytes] = await Promise.all([
    fs.promises.readFile(coverPdfAbsPath),
    fs.promises.readFile(bodyPdfPath),
  ]);
  const merged = await PDFDocument.create();
  const coverDoc = await PDFDocument.load(coverBytes);
  const bodyDoc = await PDFDocument.load(bodyBytes);
  const coverPages = await merged.copyPages(coverDoc, coverDoc.getPageIndices());
  coverPages.forEach(p => merged.addPage(p));
  const bodyPages = await merged.copyPages(bodyDoc, bodyDoc.getPageIndices());
  bodyPages.forEach(p => merged.addPage(p));
  await fs.promises.writeFile(bodyPdfPath, await merged.save());
}

// Parses an admin-uploaded Word (.docx) cover page (a relative /uploads/...
// path) into HTML via mammoth, for use as the offer PDF's cover page instead
// of a picture. Read at render time, not cached, same reasoning as
// overrideImageDataUri above; any parse failure (missing/corrupt file) is
// swallowed so it falls back rather than failing the whole PDF. mammoth's
// default image handling inlines any images the .docx itself contains as
// base64 data URIs, so the result needs no further path resolution.
async function docxCoverHtml(relPath) {
  if (!relPath) return null;
  try {
    const abs = resolveUploadPath(relPath);
    const result = await mammoth.convertToHtml({ path: abs });
    return result.value || null;
  } catch (e) {
    return null;
  }
}

// Page 1 of the reference letterhead: a static brand/product photo cover,
// identical on every offer (no per-quote data) - see assets/offer-cover/,
// sourced directly from the company's own reference cover-page document
// (Standar_Cover_Page.doc, whose row order/grouping this now matches
// exactly: industries strip; fertilizer-line banner; factory/logo/bag-
// station as one 3-across row; the two conveyor photos as a 2-across row;
// the 6 product swatches as a closing strip).
//
// Every row is full-bleed across the same content width, matching the
// reference document, so rows share a common left/right edge instead of
// some being narrow-and-centered while others span edge to edge (the
// second half of the "pictures are all over the place" bug - the first
// half, dead-air gaps inside a row, was images centered inside an
// oversized 50%-wide table cell instead of sizing to their own content).
// Single-image rows (industries strip, fertilizer-line banner, product
// swatches) are `width:100%; height:auto`, filling the row exactly like
// the reference. Multi-image rows (factory/logo/bag-station;
// conveyorSingle/conveyorMulti) use flexbox (justify-content:space-between)
// with each <img> capped by its own max-height/max-width, since those
// need to stay individually legible rather than stretch edge to edge.
// Every row's height is either fixed by width-fill or capped
// independently, and the sum stays well inside one A4 page's usable
// height, so a page-break is still only ever needed at the end of this
// section, not partway through it.
//
// `template` is the optional admin-uploaded override (lib/settings.js's
// getOfferPdfTemplate()). Precedence when more than one piece is both
// supplied and switched on: uploaded PDF cover > uploaded Word cover page >
// uploaded image cover > the hand-tuned default collage below - each falls
// through to the next if its own content can't be read/parsed, so a bad
// upload never blanks the cover page outright.
//
// The PDF cover is handled entirely differently from the other three: it
// isn't HTML at all, so it can't be inlined into this Puppeteer render the
// way an image or parsed-docx page can. Instead this returns nothing here
// (no page, no page-break - the body content that would otherwise follow
// the cover starts immediately) and generateOfferPdf() below prepends the
// uploaded PDF's own pages onto the finished output afterward via pdf-lib,
// a real PDF-to-PDF page merge rather than an approximation of one.
async function coverPage(template) {
  if (template && template.cover_pdf_active && pdfCoverAbsPath(template.cover_pdf_path)) {
    return '';
  }
  if (template && template.cover_docx_active && template.cover_docx_path) {
    const html = await docxCoverHtml(template.cover_docx_path);
    if (html) {
      return `
      <div class="cover-page docx-cover">${html}</div>
      <div class="page-break"></div>`;
    }
  }
  if (template && template.cover_active && template.cover_image_path) {
    const uri = overrideImageDataUri(template.cover_image_path);
    if (uri) {
      return `
      <div class="cover-page" style="text-align:center;"><img src="${uri}" style="max-width:100%;max-height:100%;"></div>
      <div class="page-break"></div>`;
    }
  }
  return `
  <div class="cover-page">
    <div style="margin-bottom:12px;"><img src="${COVER_IMAGES.industries}" style="width:100%;height:auto;display:block;"></div>
    <div style="margin-bottom:12px;"><img src="${COVER_IMAGES.fertilizerLine}" style="width:100%;height:auto;display:block;"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <img src="${COVER_IMAGES.factorySite}" style="max-height:120px;max-width:32%;">
      <img src="${COVER_IMAGES.logo}" style="max-height:120px;max-width:32%;">
      <img src="${COVER_IMAGES.bagStation}" style="max-height:120px;max-width:32%;">
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <img src="${COVER_IMAGES.conveyorSingle}" style="max-height:110px;max-width:48%;">
      <img src="${COVER_IMAGES.conveyorMulti}" style="max-height:110px;max-width:48%;">
    </div>
    <div><img src="${COVER_IMAGES.productSwatches}" style="width:100%;height:auto;display:block;"></div>
  </div>
  <div class="page-break"></div>`;
}

// Header/footer match the Venkateshwara Engineers letterhead exactly - sizes
// and colors below are taken directly from the reference letterhead's own
// header1.xml/footer1.xml (title: 26pt/#0000FF; subtitle: default 10pt body
// size/#808080; rule: ~2.24pt), not eyeballed, converting pt to CSS px at
// 96dpi (1pt = 1.333px) since Puppeteer's header/footer templates render at
// that same scale as page content.
//
// Precedence when more than one piece is supplied and switched on: the
// admin-authored rich-text HTML (from the formatting toolbar in
// public/js/app.js) > an uploaded image > the hand-tuned default below,
// itself now driven by lib/settings.js's design tokens (getOfferDesignTokens()
// - every default value matches what used to be hardcoded here exactly, so
// an installation that never edits the tokens sees no visual change).
// Rich text is trusted, Admin-only input (same trust level as the uploaded
// image paths) so it's injected as-is - routes/offers.js strips any
// <script> tag before it's ever stored.
// Identifying stamp (doc type + reference, customer, offer date, and the
// offer's own real revision counter - see lib/pdfBranding.js's
// documentStampHtml()) repeated in the running header on every page, same as
// how footerAddendum() below repeats "Page X of Y" - tokens.offerNo/
// offerDate/offerVersion/clientName are set once by generateOfferPdf(), not
// re-fetched here.
function headerStampAddendum(t) {
  if (!t.offerNo && !t.clientName) return '';
  return `<style>${DOC_STAMP_STYLE}</style>${documentStampHtml({
    docType: 'Offer',
    reference: t.offerNo,
    partyLabel: 'Customer',
    partyName: t.clientName,
    date: t.offerDate,
    version: t.offerVersion ? 'v' + t.offerVersion : null,
  })}`;
}

function headerTemplate(template, tokens) {
  const t = tokens || {};
  let core;
  if (template && template.header_richtext_active && template.header_richtext) {
    core = `<div style="width:100%;margin:0 15mm;font-family:'Calibri',Arial,sans-serif;font-size:10px;-webkit-print-color-adjust:exact;">${template.header_richtext}</div>`;
  } else {
    const overrideUri = template && template.header_active && template.header_image_path && overrideImageDataUri(template.header_image_path);
    if (overrideUri) {
      core = `<div style="width:100%;margin:0 15mm;"><img src="${overrideUri}" style="width:100%;display:block;"></div>`;
    } else {
      core = `<div style="width:100%;font-size:9px;margin:0 15mm;font-family:'Times New Roman',Georgia,serif;-webkit-print-color-adjust:exact;">
    <div style="color:${t.header_title_color};font-size:${t.header_title_size_px}px;letter-spacing:0.5px;text-align:center;margin:0;line-height:1.2;">VENKATESHWARA ENGINEERS</div>
    <div style="color:${t.header_subtitle_color};text-align:center;font-size:${t.header_subtitle_size_px}px;font-weight:bold;letter-spacing:0.5px;margin:2px 0 6px;font-family:'Times New Roman',serif;">MANUFACTURERS OF MATERIAL HANDLING EQUIPMENTS</div>
    <div style="border-top:3px solid #000;"></div>
  </div>`;
    }
  }
  return core + headerStampAddendum(t);
}

// Puppeteer's page.pdf() header/footer templates recognize a small set of
// special classes it fills in itself at render time - pageNumber/totalPages
// among them - so "Page X of Y" needs no manual per-page bookkeeping. This
// (and the optional legal-notice line) is appended once, after whichever
// footer branch below was chosen, rather than duplicated into all three -
// so a page-numbered image or rich-text footer works the same way as the
// default one. tokens.show_page_numbers is the single, instant on/off
// switch for the whole running-footer addendum.
function footerAddendum(t) {
  if (!t.show_page_numbers && !t.legal_notice_text) return '';
  return `<div style="width:100%;margin:2px 15mm 0;font-size:8px;color:#666;font-family:Arial,sans-serif;display:flex;justify-content:space-between;">
    <span>${t.legal_notice_text ? esc(t.legal_notice_text) : ''}</span>
    ${t.show_page_numbers ? `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` : '<span></span>'}
  </div>`;
}

function footerTemplate(template, tokens) {
  const t = tokens || {};
  let core;
  if (template && template.footer_richtext_active && template.footer_richtext) {
    core = `<div style="width:100%;margin:0 15mm;font-family:'Calibri',Arial,sans-serif;font-size:10px;-webkit-print-color-adjust:exact;">${template.footer_richtext}</div>`;
  } else {
    const overrideUri = template && template.footer_active && template.footer_image_path && overrideImageDataUri(template.footer_image_path);
    if (overrideUri) {
      core = `<div style="width:100%;margin:0 15mm;"><img src="${overrideUri}" style="width:100%;display:block;"></div>`;
    } else {
      core = `<div style="width:100%;font-size:${t.footer_font_size_px}px;margin:0 15mm;text-align:center;font-family:'Times New Roman',serif;color:${t.footer_color};-webkit-print-color-adjust:exact;">
        <div style="border-top:3px solid #000;margin-bottom:4px;"></div>
        <div style="font-weight:bold;line-height:1.4;">${COMPANY_ADDRESS_LINES.join('<br>')}</div>
      </div>`;
    }
  }
  return core + footerAddendum(t);
}

// Was a static string; now built from lib/settings.js's design tokens
// (getOfferDesignTokens()) so typography is governed centrally rather than
// hardcoded here - every default value is copied exactly from what used to
// be literal in this template, so an untouched installation renders
// byte-for-byte the same as before tokens existed.
function baseCss(tokens) {
  const t = tokens || {};
  return `
  * { box-sizing: border-box; }
  /* Body copy is 10pt Calibri in the reference document (word/styles.xml's
     Normal style, sz=20 half-points) with no distinct size for section
     headings - "Company Profile" etc. are bold+underlined at the SAME size
     as body text, not enlarged, and never colored (always plain black).
     Sizes/colors below are lib/settings.js design tokens, not literals. */
  body { font-family: ${t.body_font_family}; font-size: ${t.body_font_size_px}px; line-height: ${t.body_line_height}; color: ${t.body_color}; margin: 0; }
  p { margin: 0 0 12px; }
  h2.section-title, h3.sub-title { font-size: ${t.body_font_size_px}px; font-weight: bold; text-decoration: underline; color: ${t.heading_color}; margin: 0 0 10px; }
  h3.sub-title { margin: 16px 0 8px; }
  /* "Project Data Sheet" is the one heading styled differently in the
     reference - centered, light-gray highlight, not bold/underlined. */
  .highlight-title { text-align: center; margin: 0 0 10px; }
  .highlight-title span { background: #d3d3d3; padding: 1px 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; table-layout: fixed; }
  th, td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
  th { background: #c5d9f1; font-weight: bold; }
  .section-header { background: #d9ead3; font-weight: bold; }
  .page-break { page-break-before: always; }
  .box { border: 1px solid #333; padding: 7px 9px; margin-bottom: 10px; font-size: 12.5px; }
  .right { text-align: right; }
  .center { text-align: center; }
  /* Dash bullets ("-"), matching the reference's actual list style (Word
     numbering.xml lvlText="-") instead of a browser default disc. Two
     indent depths appear in the reference: most lists hang the marker ~6.35mm
     before ~12.7mm of text indent (the default here); the very first list on
     the Company Profile page (industries served) uses a deeper ~6.6mm/~25.7mm
     pair - see .deep-indent. Values converted from the source .doc's twips
     (1440/inch) to CSS px at 96dpi.
     .indent-block matches a bulleted heading's own text indent for a
     continuation paragraph that's part of the same list item but isn't
     itself bulleted (e.g. the description under "Electronic Weighing and
     Bagging Machines..."), exactly as the reference does it. */
  ul, ol { list-style: none; margin: 4px 0 10px; padding: 0; }
  li { position: relative; padding-left: 48px; margin-bottom: 3px; }
  li::before { content: '-'; position: absolute; left: 24px; }
  ul.deep-indent li { padding-left: 97px; }
  ul.deep-indent li::before { left: 72px; }
  .indent-block { padding-left: 48px; margin: 0 0 8px; }
  /* Loose reset for a parsed Word cover page (docxCoverHtml()) - mammoth's
     output uses bare tags (h1/h2/p/table/img) with no classes of its own,
     so this just keeps images/tables from overflowing the page width. */
  .docx-cover img { max-width: 100%; }
  .docx-cover table { width: 100%; border-collapse: collapse; }
  ${WATERMARK_STYLE}
`;
}

// ---- Fixed company profile pages (identical on every offer - taken from
// the standard Venkateshwara Engineers offer template, pages 3-5) ----
function companyProfilePages() {
  return `
  <div class="page-break"></div>
  <h2 class="section-title">Company Profile</h2>
  <p>We are one of the leading manufacturers, supplier of Electronic Weighing &amp; Bagging Machines, Batching Systems, Bag Closing Machines and Bag Handling Conveyors (Bag Transfer/Loading/Stacking) etc for Following Industries:</p>
  <ul class="deep-indent">
    <li>Fertilizer</li>
    <li>Argo Industry (Rice/Wheat/Paddy/Pulses/Guar Gum)</li>
    <li>Poultry/Animal Feed/Solvents</li>
    <li>Sugar</li>
    <li>Grouts/Building Material</li>
    <li>Petro Chemicals</li>
  </ul>
  <p>Our wide Product portfolio includes solutions such as bagging scales and feeders, bagging machines, case packing machines, robotic and conventional palletizers, stretch wrappers, stretch hooders, conveyors, etc. Moreover, we also offer bulk processing solutions, mixing lines, harrows, vacuum harvesters, etc.</p>
  <p>Innovation is also a major focus for the company. In the last 19 years, the company has developed and acquired several state-of-the-art technologies that are still in the lead today. With much more to come, our prime objective is to continue to meet your needs in the most creative way.</p>
  <h3 class="sub-title">Our Commitment</h3>
  <p>We are committed to creating sustainable solutions that help improve the efficiency of manufacturing facilities. We provide the most valuable lifecycle services in the industry and focusing on critical areas such as 24/7 technical support, spare parts, field service, training, system assessments, and optimization.</p>
  <h3 class="sub-title">Safety as a value</h3>
  <p>We believes that our team members are the most valuable resource on which we can rely. Accordingly, we have taken a series of measures that support daily work towards eliminating the risk of accidents on its production sites. These measures include lockout procedures, workplace inspections, first aid training, mandatory protective equipment, restricted plant access, and emergency plans.</p>
  <h3 class="sub-title">A constant concern</h3>
  <p>The equipment manufactured by us is extremely safe. At all stages of product development, the safety of team members, customers, and all people who have access to the equipment remains our primary concern: at the design stage (reducing the risk of hazards), during equipment commissioning, and throughout the entire service life of the equipment (rigorous maintenance and service). We are compliant with the strictest international regulations and the desire to eliminate industrial accidents has earned the trust of both customers and their communities.</p>

  <div class="page-break"></div>
  <h3 class="sub-title" style="margin-top:0;">Innovation</h3>
  <p>Since the beginning, the experienced and dynamic team of engineers has diligently used the "art of listening" as one of the most powerful tools in developing its technologies to the fullest. Listening to the customers and asking questions has provided us with the end results of what needed to be accomplished to conquer various targeted markets within its three business segments (flexible packaging; rigid packaging; bulk processing and field equipment).</p>
  <p>Our Innovation, Research, and Development (IR&amp;D) programs contribute to developing brand new technologies and new product options or features and to performing continuous improvement on the existing product lines. These programs provide us with the opportunity to "think outside the box" and launch many more innovative products in the marketplace. Most IR&amp;D projects are carried out through a partnership with a customer, thus allowing for the installation of modern technologies inside a real production environment. This facilitates all the steps towards the maturity of the new equipment and its worldwide marketing.</p>
  <p>Every year, we reinvest a reasonable amount of effort and money in Innovation, Research and Development (IR&amp;D). This has allowed us to design new products and achieve many technological advances. In the last few years, the company's efforts have been focused on developing innovative, eco-friendly technologies.</p>
  <h3 class="sub-title">Our customers</h3>
  <p>We also feel proud to share below few of our customers with whom we are continuously providing our products and services:</p>
  <ul>
    <li>Fertilizers (Adani Ports (Mundra, Dhamra, Krishnapatnam, Dahej, Tuna, Gangavaram), IFFCO, KRIBHCO, Zuari Agro, MCF, SPIC , PPL, JM Balshi, Bothra Shipping etc)</li>
    <li>Food Grains (Adani Agri Logistics Limited, KRBL, LT Foods BLV Exports and Various Rice Mills Across India, over 600 Mills)</li>
    <li>Other Industries (ABIS Exports, Hindalco, continental Carbon, Polyplex, DUPONT,Saint Gobain, KRBL, Philips Carbon, RQS, Kumar Metals, Growel Feeds etc)</li>
  </ul>
  <h3 class="sub-title">Few Of Our Product range:</h3>
  <ul><li><b>Electronic Weighing and Bagging Machines including conveying equipment.</b></li></ul>
  <p class="indent-block">Manufacturer of Bagging machines with (Three Speed) Electronic Net Weighing &amp; Bagging (Two Weighers with Common Bag Holder) for high speed and extremely high weighing accuracy. Bagging machines are designed to provide extremely high performance and consistency.</p>
  <p class="indent-block">Feeding Can Be Gravity, Screw, Belt or Vibratory Depending Upon Product Flow Characteristics</p>
  <ul><li><b>Continuous Flow Weighers (Range up to 700 T Per hour)</b></li></ul>
  <p class="indent-block">It is applied to continuously measure flow capacity and total weight of flowable bulk. The system provides practicable, accurate, dependable, robust, and easy-to-handle services.</p>
  <p class="indent-block">All common cereals, animal feed, granules, pellets, but also bruised grains and various grinded products can be applied for weighing. The system is also suited for the application of seeds and can optionally be supplied with stainless steel qualities.</p>
  <ul><li><b>Bag Handling equipment.</b></li></ul>
  <p class="indent-block">Manufacturing optimum quality range of Bag Stacker, Hydraulic Bag Stacker, Hydraulic Belt Conveyor, Belt Conveyor, Portable Bag Stacker, Truck Loading Unloading System, Bag Handling System, and many more.</p>
  <p class="indent-block">Machines offered by us have a long functional life and are known for features such as rust resistance, efficiency, easy installation, and reliability. We fabricate our products making use of high-grade raw material sourced from dependable vendors. Owing to the technical expertise of our professionals, we can manufacture machines in varied technical specifications.</p>

  <div class="page-break"></div>
  <p><b>Our continuous efforts to provide quality and cost-effective products as per the customers' requirements has given us the opportunity to serve many of our customer in these industries in India.</b></p>
  <p><b>We strongly believe in maintaining quality. To achieve this, we take measures to check quality at each stage of manufacturing.</b></p>
  <p><b>Further Please Note-</b></p>
  <ul>
    <li>We Have a Huge Customer Base Across India</li>
    <li>We Have Strong Design, Engineering Team</li>
    <li>All Manufacturing Facilities Including Shot Blasting, Painting Etc.</li>
    <li>We Adopt Latest Technologies (Laser Cutting, Investment Casting) In Manufacturing</li>
    <li>We Have a Strong Service Team</li>
    <li>We Keep 100% Spares in Stock to Meet Timely Delivery</li>
  </ul>
  `;
}

async function bodyHtml(offer, client, items, techSpecs, boughtOut, terms, company, template, tokens) {
  // Per-offer section toggles - NULL (a pre-existing offer, since ALTER
  // TABLE doesn't backfill old rows here) is treated as "show", same as an
  // explicit 1, so only an explicit 0 hides a section.
  const showTechSpecs = offer.show_tech_specs !== 0;
  const showBoughtOut = offer.show_bought_out !== 0;
  const showInclExcl = offer.show_inclusions_exclusions !== 0;

  const itemRows = items.map(it => `
    ${it.section_title ? `<tr><td colspan="5" class="section-header">${esc(it.section_title)}</td></tr>` : ''}
    <tr>
      <td>${esc(it.item_code)}</td>
      <td>${nl2br(it.description)}</td>
      <td class="center">${it.qty}</td>
      <td class="right">${fmt(it.unit_price)}</td>
      <td class="right">${fmt(it.total_price)}</td>
    </tr>`).join('');
  const grandTotal = items.reduce((a, b) => a + Number(b.total_price || 0), 0);

  const specRows = techSpecs.map(s => `<tr><td style="width:42%"><b>${esc(s.spec_key)}</b></td><td>${esc(s.spec_value)}</td></tr>`).join('');
  const boughtOutRows = boughtOut.map(b => `<tr><td style="width:32%"><b>${esc(b.component)}</b></td><td>${esc(b.make)}</td></tr>`).join('');
  const termRows = terms.map(t => `<tr><td style="width:32%"><b>${esc(t.term_key)}</b></td><td>${esc(t.term_value)}</td></tr>`).join('');

  const imageBlocks = items.filter(it => it.image_data_uri).map(it => `
    <div class="box">
      <p><b>${esc(it.section_title || it.description || '')}</b></p>
      <img src="${it.image_data_uri}" style="max-width:100%;max-height:280px;">
    </div>`).join('');

  const dateStr = new Date(offer.offer_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${baseCss(tokens)}</style></head><body>
  ${await coverPage(template)}
  ${watermarkHtml(company, 'Venkateshwara Engineers')}
  <div style="text-align:right;">${dateStr}</div>
  <p>To,<br>
  <b>${esc(client.name)}</b><br>
  ${offer.contact_person ? `<b>${esc(offer.contact_person)}</b><br>` : ''}
  ${offer.contact_phone ? `<b>Cell:</b> ${esc(offer.contact_phone)}<br>` : ''}
  ${offer.contact_email ? `<b>Email:</b> ${esc(offer.contact_email)}<br>` : ''}
  <b>Address:</b> ${esc(client.address)}<br>
  ${client.gstin ? `<b>GSTIN:</b> ${esc(client.gstin)}<br>` : ''}
  </p>
  <p>Dear Sir,<br>
  Thank You Very Much for The Kind Courtesy Extended to The Under Signed during telephonic conversation. As Discussed, we are Pleased to Submit Our Offer for ${esc(offer.subject || 'the requested equipment')} as under for Your Perusal.</p>
  <p>Should you require any further information / clarifications please contact us.</p>
  <p><b>Thanking You</b><br><b>Yours Faithfully,</b><br><b>For M/S Venkateshwara Engineers</b></p>
  <p><b>Authorized Signatory</b></p>

  ${companyProfilePages()}

  <div class="page-break"></div>
  <p class="highlight-title"><span>Project Data Sheet</span></p>
  <p>The Equipment Offered Is Based on Application Information Currently at Hand. We Reserve the Right to Review Our Offer When All Relevant Data Is Available Should This Conflict With The Current Assumption.</p>
  <p><u>Application</u><br>${nl2br(offer.application)}<br>
  <b>Type Of System</b> : ${esc(offer.type_of_system)}<br>
  <b>Material Of Construction</b> : ${esc(offer.material_of_construction)}</p>
  ${showTechSpecs ? `<table><colgroup><col style="width:42%"><col style="width:58%"></colgroup><tr><th colspan="2">Specifications</th></tr>${specRows}</table>` : ''}

  <div class="page-break"></div>
  <h2 class="section-title">Scope Of Supply</h2>
  <p><b>${esc(offer.subject)}</b>${offer.drawing_no ? ` &mdash; Drawing No: ${esc(offer.drawing_no)}` : ''}</p>
  <table>
    <colgroup><col style="width:6%"><col style="width:46%"><col style="width:10%"><col style="width:19%"><col style="width:19%"></colgroup>
    <tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit Price (Ex Works)</th><th>Total Price</th></tr>
    ${itemRows}
    <tr><td colspan="4" class="right"><b>Grand Total</b></td><td class="right"><b>${fmt(grandTotal)}</b></td></tr>
  </table>

  ${imageBlocks ? `<div class="page-break"></div><h2 class="section-title">Equipment Description</h2>${imageBlocks}` : ''}

  <div class="page-break"></div>
  ${showBoughtOut ? `<h2 class="section-title">Make Of Bought Out Items</h2>
  <table><colgroup><col style="width:32%"><col style="width:68%"></colgroup>${boughtOutRows}</table>` : ''}
  <h2 class="section-title">Terms And Conditions</h2>
  <table><colgroup><col style="width:32%"><col style="width:68%"></colgroup>${termRows}</table>

  ${showInclExcl ? `<div class="page-break"></div>
  <div class="box"><b>Inclusions:-</b><br>${nl2br(offer.inclusions)}</div>
  <div class="box"><b>Exclusions:-</b><br>${nl2br(offer.exclusions)}</div>
  <div class="box"><b>Utilities Requirement:</b><br>${nl2br(offer.utilities_requirement)}</div>
  <div class="box"><b>Instrument Air Supply:</b><br>${nl2br(offer.instrument_air_supply)}</div>` : ''}

  </body></html>`;
}

// Generates the offer PDF and returns its filesystem path (caller should
// delete the returned tmpDir after streaming it). `items` should already
// have `image_data_uri` set (base64 data: URI) instead of a file path -
// see routes/offers.js.
async function generateOfferPdf(offer, client, items, techSpecs, boughtOut, terms) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-'));
  const outPath = path.join(tmpDir, 'offer.pdf');
  // Optional admin override (lib/settings.js) - every piece defaults to off,
  // so an installation that has never touched Offer PDF Template settings
  // gets exactly the hand-tuned default letterhead, unchanged.
  const template = getOfferPdfTemplate();
  // Extends the design tokens (rather than fetching separately) with the
  // offer's own identity - reference, date, real version counter (see
  // db/schema.sql's offers.version) and customer - for headerTemplate()'s
  // per-page stamp below; offer/client are already in scope here.
  const tokens = {
    ...getOfferDesignTokens(),
    offerNo: offer.offer_no,
    offerDate: new Date(offer.offer_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    offerVersion: offer.version,
    clientName: client.name,
  };

  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(await bodyHtml(offer, client, items, techSpecs, boughtOut, terms, getCompanySettings(), template, tokens), { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(template, tokens),
      footerTemplate: footerTemplate(template, tokens),
      // bottom is generous rather than a tight fit to the footer's own
      // 4-line/13.3px content height, since Chrome doesn't reliably clip a
      // footer that slightly exceeds its reserved margin - it can instead
      // overlap the last line of body content, which is worse.
      margin: { top: '30mm', bottom: '26mm', left: '15mm', right: '15mm' },
    });
  } finally {
    await browser.close();
  }

  // Uploaded PDF cover (highest-precedence cover source - see coverPage())
  // isn't part of the HTML Puppeteer just rendered, so it's prepended here
  // as a real page-level merge instead. Uses the exact same existence/
  // signature check coverPage() already used to decide to render nothing,
  // so the two can never disagree about whether a cover was supplied. A
  // failure at this point (e.g. a corrupt file that still passed the
  // signature check) is logged and swallowed rather than failing the whole
  // download - the offer PDF still comes out, just without its cover.
  const coverPdfAbs = template.cover_pdf_active ? pdfCoverAbsPath(template.cover_pdf_path) : null;
  if (coverPdfAbs) {
    try {
      await mergeCoverPdf(coverPdfAbs, outPath);
    } catch (e) {
      console.error('Cover PDF merge failed, continuing without it:', e);
    }
  }

  return { outPath, tmpDir };
}

module.exports = { generateOfferPdf, bodyHtml, coverPage, headerTemplate, footerTemplate, baseCss, mergeCoverPdf, pdfCoverAbsPath };

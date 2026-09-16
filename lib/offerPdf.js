const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { findBrowser } = require('./browserPath');

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

// Header/footer match the Venkateshwara Engineers letterhead exactly: serif
// blue company name, bold gray small-caps subtitle, thick black rule -
// repeated on every page by Chrome's own header/footer templates.
function headerTemplate() {
  return `<div style="width:100%;font-size:9px;margin:0 15mm;font-family:'Times New Roman',Georgia,serif;-webkit-print-color-adjust:exact;">
    <div style="color:#1414c8;font-size:22px;letter-spacing:0.5px;text-align:center;margin:0;line-height:1.2;">VENKATESHWARA ENGINEERS</div>
    <div style="color:#595959;text-align:center;font-size:8.5px;font-weight:bold;letter-spacing:0.5px;margin:1px 0 5px;font-family:'Times New Roman',serif;">MANUFACTURERS OF MATERIAL HANDLING EQUIPMENTS</div>
    <div style="border-top:2.2px solid #000;"></div>
  </div>`;
}

function footerTemplate() {
  return `<div style="width:100%;font-size:7.3px;margin:0 15mm;text-align:center;font-family:'Times New Roman',serif;color:#000;-webkit-print-color-adjust:exact;">
    <div style="border-top:2.2px solid #000;margin-bottom:3px;"></div>
    <div style="font-weight:bold;line-height:1.5;">${COMPANY_ADDRESS_LINES.join('<br>')}</div>
  </div>`;
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'Calibri', Arial, sans-serif; font-size: 10.5px; color: #111; margin: 0; }
  p { margin: 0 0 8px; }
  h2.section-title { color: #1e3a8a; font-size: 13px; margin: 0 0 8px; text-decoration: underline; }
  h3.sub-title { font-size: 11.5px; margin: 14px 0 6px; text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; table-layout: fixed; }
  th, td { border: 1px solid #333; padding: 4px 6px; font-size: 9.5px; text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
  th { background: #dbe5f1; font-weight: bold; }
  .section-header { background: #d9ead3; font-weight: bold; }
  .page-break { page-break-before: always; }
  .box { border: 1px solid #333; padding: 7px 9px; margin-bottom: 10px; font-size: 10px; }
  .right { text-align: right; }
  .center { text-align: center; }
  ul, ol { margin: 4px 0 10px; padding-left: 20px; }
  li { margin-bottom: 3px; }
`;

// ---- Fixed company profile pages (identical on every offer - taken from
// the standard Venkateshwara Engineers offer template, pages 3-5) ----
function companyProfilePages() {
  return `
  <div class="page-break"></div>
  <h2 class="section-title" style="text-decoration:underline;">Company Profile</h2>
  <p>We are one of the leading manufacturers, supplier of Electronic Weighing &amp; Bagging Machines, Batching Systems, Bag Closing Machines and Bag Handling Conveyors (Bag Transfer/Loading/Stacking) etc for Following Industries:</p>
  <ul>
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
  <p><b>Electronic Weighing and Bagging Machines including conveying equipment.</b></p>
  <ul>
    <li>Manufacturer of Bagging machines with (Three Speed) Electronic Net Weighing &amp; Bagging (Two Weighers with Common Bag Holder) for high speed and extremely high weighing accuracy. Bagging machines are designed to provide extremely high performance and consistency.</li>
    <li>Feeding Can Be Gravity, Screw, Belt or Vibratory Depending Upon Product Flow Characteristics</li>
  </ul>
  <p><b>Continuous Flow Weighers (Range up to 700 T Per hour)</b></p>
  <ul>
    <li>It is applied to continuously measure flow capacity and total weight of flowable bulk. The system provides practicable, accurate, dependable, robust, and easy-to-handle services.</li>
    <li>All common cereals, animal feed, granules, pellets, but also bruised grains and various grinded products can be applied for weighing. The system is also suited for the application of seeds and can optionally be supplied with stainless steel qualities.</li>
  </ul>
  <p><b>Bag Handling equipment.</b></p>
  <ul>
    <li>Manufacturing optimum quality range of Bag Stacker, Hydraulic Bag Stacker, Hydraulic Belt Conveyor, Belt Conveyor, Portable Bag Stacker, Truck Loading Unloading System, Bag Handling System, and many more.</li>
    <li>Machines offered by us have a long functional life and are known for features such as rust resistance, efficiency, easy installation, and reliability. We fabricate our products making use of high-grade raw material sourced from dependable vendors. Owing to the technical expertise of our professionals, we can manufacture machines in varied technical specifications.</li>
  </ul>

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

function bodyHtml(offer, client, items, techSpecs, boughtOut, terms) {
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

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>

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
  <h2 class="section-title">PROJECT DATA SHEET</h2>
  <p>The Equipment Offered Is Based on Application Information Currently at Hand. We Reserve the Right to Review Our Offer When All Relevant Data Is Available Should This Conflict With The Current Assumption.</p>
  <p><u>Application</u><br>${nl2br(offer.application)}<br>
  <b>Type Of System</b> : ${esc(offer.type_of_system)}<br>
  <b>Material Of Construction</b> : ${esc(offer.material_of_construction)}</p>
  <table><colgroup><col style="width:42%"><col style="width:58%"></colgroup><tr><th colspan="2">Specifications</th></tr>${specRows}</table>

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
  <h2 class="section-title">Make Of Bought Out Items</h2>
  <table><colgroup><col style="width:32%"><col style="width:68%"></colgroup>${boughtOutRows}</table>
  <h2 class="section-title">Terms And Conditions</h2>
  <table><colgroup><col style="width:32%"><col style="width:68%"></colgroup>${termRows}</table>

  <div class="page-break"></div>
  <div class="box"><b>Inclusions:-</b><br>${nl2br(offer.inclusions)}</div>
  <div class="box"><b>Exclusions:-</b><br>${nl2br(offer.exclusions)}</div>
  <div class="box"><b>Utilities Requirement:</b><br>${nl2br(offer.utilities_requirement)}</div>
  <div class="box"><b>Instrument Air Supply:</b><br>${nl2br(offer.instrument_air_supply)}</div>

  </body></html>`;
}

// Generates the offer PDF and returns its filesystem path (caller should
// delete the returned tmpDir after streaming it). `items` should already
// have `image_data_uri` set (base64 data: URI) instead of a file path -
// see routes/offers.js.
async function generateOfferPdf(offer, client, items, techSpecs, boughtOut, terms) {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error(
      'No Chrome/Edge/Chromium browser found on this machine. Offer PDFs are generated using your ' +
      'installed browser. Install Google Chrome or Microsoft Edge, or set the PDF_CHROME_PATH ' +
      'environment variable to your browser executable, then try again.'
    );
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-'));
  const outPath = path.join(tmpDir, 'offer.pdf');

  const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(bodyHtml(offer, client, items, techSpecs, boughtOut, terms), { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(),
      footerTemplate: footerTemplate(),
      margin: { top: '30mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });
  } finally {
    await browser.close();
  }

  return { outPath, tmpDir };
}

module.exports = { generateOfferPdf };

const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageSize } = require('image-size');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType,
} = require('docx');

const TABLE_WIDTH_DXA = 9026;
const MAX_IMAGE_WIDTH_PX = 380;
const MAX_IMAGE_HEIGHT_PX = 280;
// docx's ImageRun only accepts these four - image-size's own `type` string
// is close enough to match directly except jpeg needing the 'jpg' alias.
const DOCX_IMAGE_TYPES = { jpg: 'jpg', jpeg: 'jpg', png: 'png', gif: 'gif', bmp: 'bmp' };

function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function nl2br(s) { return String(s || ''); }

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 2000, type: WidthType.DXA },
    columnSpan: opts.colSpan,
    shading: opts.header ? { type: ShadingType.CLEAR, fill: 'C5D9F1' } : (opts.sectionHeader ? { type: ShadingType.CLEAR, fill: 'D9EAD3' } : undefined),
    children: String(text ?? '').split('\n').map(line => new Paragraph({
      alignment: opts.align, children: [new TextRun({ text: line, bold: !!opts.header || !!opts.bold })],
    })),
  });
}

// Decodes a data: URI (as produced by routes/offers.js's withImageDataUri())
// into a Buffer plus a docx-recognized image type, scaled down to fit the
// page - or null if the image is missing/corrupt/an unsupported format
// (webp, svg), so a bad picture just gets skipped instead of failing the
// whole document (same defensive posture as offerPdf.js's own image-size
// probe in equipmentDescriptionBlock()).
function decodeImage(dataUri) {
  if (!dataUri) return null;
  try {
    const base64 = String(dataUri).split(',')[1] || '';
    const buffer = Buffer.from(base64, 'base64');
    const dims = imageSize(buffer);
    const docxType = DOCX_IMAGE_TYPES[String(dims.type || '').toLowerCase()];
    if (!docxType || !dims.width || !dims.height) return null;
    const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / dims.width, MAX_IMAGE_HEIGHT_PX / dims.height);
    return { buffer, type: docxType, width: Math.round(dims.width * scale), height: Math.round(dims.height * scale) };
  } catch (e) { return null; }
}

function imageParagraph(dataUri) {
  const img = decodeImage(dataUri);
  if (!img) return null;
  return new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 100, after: 100 },
    children: [new ImageRun({ type: img.type, data: img.buffer, transformation: { width: img.width, height: img.height } })],
  });
}

// One Equipment Description entry (a priced Scope-of-Supply item with a
// picture, or a reference-only entry) as title + picture + summary, mirroring
// lib/offerPdf.js's equipmentDescriptionBlock() but as docx Paragraphs
// instead of an HTML box - a picture that fails to decode still gets its
// title/summary text, just without the image.
function equipmentDescriptionParagraphs(it) {
  const title = it.section_title || it.description || '';
  const out = [new Paragraph({ text: title, spacing: { before: 200 }, children: [new TextRun({ text: title, bold: true })] })];
  const imgPara = imageParagraph(it.image_data_uri);
  if (imgPara) out.push(imgPara);
  if (it.summary) out.push(new Paragraph({ text: it.summary, spacing: { after: 100 } }));
  return out;
}

async function generateOfferDocx(offer, client, items, techSpecs, boughtOut, terms, company, equipmentReferences) {
  const showTechSpecs = offer.show_tech_specs !== 0;
  const showBoughtOut = offer.show_bought_out !== 0;
  const showInclExcl = offer.show_inclusions_exclusions !== 0;
  const grandTotal = items.reduce((a, b) => a + Number(b.total_price || 0), 0);
  const dateStr = new Date(offer.offer_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const letter = [
    new Paragraph({ text: company.legal_name || 'Venkateshwara Engineers', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: company.registered_address || '', alignment: AlignmentType.CENTER, spacing: { after: 300 } }),
    new Paragraph({ text: dateStr, alignment: AlignmentType.RIGHT }),
    new Paragraph({ text: 'To,', spacing: { before: 200 } }),
    new Paragraph({ children: [new TextRun({ text: client.name || '', bold: true })] }),
    ...(offer.contact_person ? [new Paragraph({ children: [new TextRun({ text: offer.contact_person, bold: true })] })] : []),
    ...(offer.contact_phone ? [new Paragraph({ text: `Cell: ${offer.contact_phone}` })] : []),
    ...(offer.contact_email ? [new Paragraph({ text: `Email: ${offer.contact_email}` })] : []),
    new Paragraph({ text: `Address: ${client.address || ''}` }),
    ...(client.gstin ? [new Paragraph({ text: `GSTIN: ${client.gstin}` })] : []),
    new Paragraph({ text: 'Dear Sir,', spacing: { before: 200 } }),
    new Paragraph({ text: `Thank You Very Much for The Kind Courtesy Extended to The Under Signed during telephonic conversation. As Discussed, we are Pleased to Submit Our Offer for ${offer.subject || 'the requested equipment'} as under for Your Perusal.`, spacing: { before: 100 } }),
    new Paragraph({ text: 'Should you require any further information / clarifications please contact us.', spacing: { before: 100 } }),
    new Paragraph({ text: 'Thanking You', spacing: { before: 200 } }),
    new Paragraph({ children: [new TextRun({ text: 'Yours Faithfully,', bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: 'For M/S Venkateshwara Engineers', bold: true })], spacing: { after: 400 } }),
    new Paragraph({ children: [new TextRun({ text: 'Authorized Signatory', bold: true })] }),
  ];

  const projectDataSheet = [
    new Paragraph({ text: 'Project Data Sheet', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
    new Paragraph({ text: 'The Equipment Offered Is Based on Application Information Currently at Hand. We Reserve the Right to Review Our Offer When All Relevant Data Is Available Should This Conflict With The Current Assumption.' }),
    new Paragraph({ children: [new TextRun({ text: 'Application', underline: {} })], spacing: { before: 200 } }),
    new Paragraph({ text: nl2br(offer.application) }),
    new Paragraph({ children: [new TextRun({ text: 'Type Of System: ', bold: true }), new TextRun({ text: offer.type_of_system || '' })] }),
    new Paragraph({ children: [new TextRun({ text: 'Material Of Construction: ', bold: true }), new TextRun({ text: offer.material_of_construction || '' })] }),
  ];
  const specTable = (showTechSpecs && techSpecs.length) ? [
    new Paragraph({ text: 'Specifications', heading: HeadingLevel.HEADING_2, spacing: { before: 200 } }),
    new Table({
      width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: [3800, 5226],
      rows: techSpecs.map(s => new TableRow({ children: [cell(s.spec_key, { bold: true, width: 3800 }), cell(s.spec_value, { width: 5226 })] })),
    }),
  ] : [];

  const scopeColWidths = [700, 4326, 700, 1650, 1650];
  const scopeTable = [
    new Paragraph({ text: 'Scope Of Supply', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: offer.subject || '', bold: true }), ...(offer.drawing_no ? [new TextRun({ text: `  —  Drawing No: ${offer.drawing_no}` })] : [])] }),
    new Table({
      width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: scopeColWidths,
      rows: [
        new TableRow({ children: ['Item', 'Description', 'Qty', 'Unit Price (Ex Works)', 'Total Price'].map((h, i) => cell(h, { header: true, width: scopeColWidths[i] })) }),
        ...items.flatMap(it => [
          ...(it.section_title ? [new TableRow({ children: [cell(it.section_title, { sectionHeader: true, bold: true, colSpan: 5, width: TABLE_WIDTH_DXA })] })] : []),
          new TableRow({ children: [
            cell(it.item_code, { width: scopeColWidths[0] }), cell(it.description, { width: scopeColWidths[1] }),
            cell(String(it.qty), { align: AlignmentType.CENTER, width: scopeColWidths[2] }),
            cell(fmt(it.unit_price), { align: AlignmentType.RIGHT, width: scopeColWidths[3] }),
            cell(fmt(it.total_price), { align: AlignmentType.RIGHT, width: scopeColWidths[4] }),
          ] }),
        ]),
        new TableRow({ children: [cell('Grand Total', { header: true, align: AlignmentType.RIGHT, colSpan: 4, width: TABLE_WIDTH_DXA - scopeColWidths[4] }), cell(fmt(grandTotal), { header: true, align: AlignmentType.RIGHT, width: scopeColWidths[4] })] }),
      ],
    }),
  ];

  const referenceEntries = (equipmentReferences || []).filter(r => r.image_data_uri)
    .map(r => ({ section_title: r.title, summary: r.summary, image_data_uri: r.image_data_uri }));
  const imageEntries = items.filter(it => it.image_data_uri).concat(referenceEntries);
  const equipmentDescription = imageEntries.length ? [
    new Paragraph({ text: 'Equipment Description', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
    ...imageEntries.flatMap(equipmentDescriptionParagraphs),
  ] : [];

  const boughtOutSection = (showBoughtOut && boughtOut.length) ? [
    new Paragraph({ text: 'Make Of Bought Out Items', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
    new Table({
      width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: [2900, 6126],
      rows: boughtOut.map(b => new TableRow({ children: [cell(b.component, { bold: true, width: 2900 }), cell(b.make, { width: 6126 })] })),
    }),
  ] : [];

  const termsSection = [
    new Paragraph({ text: 'Terms And Conditions', heading: HeadingLevel.HEADING_1, pageBreakBefore: !boughtOutSection.length, spacing: { before: 200, after: 200 } }),
    new Table({
      width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: [2900, 6126],
      rows: terms.map(t => new TableRow({ children: [cell(t.term_key, { bold: true, width: 2900 }), cell(t.term_value, { width: 6126 })] })),
    }),
  ];

  const inclExclSection = showInclExcl ? [
    new Paragraph({ pageBreakBefore: true, spacing: { before: 200 }, children: [new TextRun({ text: 'Inclusions:-', bold: true })] }),
    new Paragraph({ text: nl2br(offer.inclusions) }),
    new Paragraph({ children: [new TextRun({ text: 'Exclusions:-', bold: true })], spacing: { before: 200 } }),
    new Paragraph({ text: nl2br(offer.exclusions) }),
    new Paragraph({ children: [new TextRun({ text: 'Utilities Requirement:', bold: true })], spacing: { before: 200 } }),
    new Paragraph({ text: nl2br(offer.utilities_requirement) }),
    new Paragraph({ children: [new TextRun({ text: 'Instrument Air Supply:', bold: true })], spacing: { before: 200 } }),
    new Paragraph({ text: nl2br(offer.instrument_air_supply) }),
  ] : [];

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 900, bottom: 900, left: 1100, right: 1100 } } },
      children: [
        ...letter, ...projectDataSheet, ...specTable, ...scopeTable,
        ...equipmentDescription, ...boughtOutSection, ...termsSection, ...inclExclSection,
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-docx-'));
  const outPath = path.join(tmpDir, `${offer.offer_no}.docx`);
  fs.writeFileSync(outPath, buffer);
  return { outPath, tmpDir };
}

module.exports = { generateOfferDocx };

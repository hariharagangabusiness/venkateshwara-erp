// Native Word (.docx) template for the "Download Word" export - a genuinely
// different mechanism from the PDF's custom_body_html override in
// lib/offerPdf.js. The PDF is rendered HTML/CSS through a real browser, so
// any HTML template drives it; a .docx is its own file format (OOXML), so an
// admin-branded Word output needs the admin's actual .docx (designed in
// Microsoft Word with {tag} placeholders and a repeatable item-row table)
// merged with docxtemplater rather than converted from anything.
//
// Deliberately narrower in scope than the fixed layout in lib/offerDocx.js:
// header/project-data fields, the priced Scope-of-Supply table, and simple
// paragraph-loop blocks for tech specs / bought-out items / terms. No
// per-item pictures here (that stays PDF-only for now) - keeps the merge
// data plain strings/numbers and the template a plain paragraph/table
// document, no image-handling module needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, AlignmentType } = require('docx');

function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

// Same field set on every render (Draft, sample, or real) - fmt()'d numbers
// and always-present string keys, so docxtemplater's nullGetter only ever
// fires for a genuinely unrecognized tag the admin typed, never for a
// legitimately blank optional field like contact_phone.
function buildOfferTemplateData(offer, client, items, techSpecs, boughtOut, terms, company) {
  const grandTotal = (items || []).reduce((a, b) => a + Number(b.total_price || 0), 0);
  const dateStr = offer.offer_date ? new Date(offer.offer_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return {
    offer_no: offer.offer_no || '', offer_date: dateStr, subject: offer.subject || '',
    application: offer.application || '', type_of_system: offer.type_of_system || '',
    material_of_construction: offer.material_of_construction || '', drawing_no: offer.drawing_no || '',
    client_name: (client && client.name) || '', client_address: (client && client.address) || '', client_gstin: (client && client.gstin) || '',
    contact_person: offer.contact_person || '', contact_phone: offer.contact_phone || '', contact_email: offer.contact_email || '',
    company_name: (company && company.legal_name) || '', company_address: (company && company.registered_address) || '',
    grand_total: fmt(grandTotal),
    inclusions: offer.inclusions || '', exclusions: offer.exclusions || '',
    utilities_requirement: offer.utilities_requirement || '', instrument_air_supply: offer.instrument_air_supply || '',
    items: (items || []).map(it => ({
      item_code: it.item_code || '', section_title: it.section_title || '', description: it.description || '',
      qty: String(it.qty ?? ''), unit_price: fmt(it.unit_price), total_price: fmt(it.total_price),
    })),
    tech_specs: (techSpecs || []).map(s => ({ spec_key: s.spec_key || '', spec_value: s.spec_value || '' })),
    bought_out: (boughtOut || []).map(b => ({ component: b.component || '', make: b.make || '' })),
    terms: (terms || []).map(t => ({ term_key: t.term_key || '', term_value: t.term_value || '' })),
  };
}

// docxtemplater throws a single Error whose .properties.errors lists every
// bad tag found (unclosed loop, stray brace, etc.) when compiling - collapse
// that into one readable message instead of a raw stack trace.
function formatTemplateError(e) {
  if (e && e.properties && Array.isArray(e.properties.errors) && e.properties.errors.length) {
    return e.properties.errors.map(err => (err.properties && err.properties.explanation) || err.message).join('; ');
  }
  return (e && e.message) || String(e);
}

// Renders the given .docx template against `data`, returning the merged
// buffer plus any "unrecognized {tag}" warnings (collected via nullGetter,
// which only fires for a tag not present in `data` at all - a real but
// blank field never triggers it, see buildOfferTemplateData above).
function renderOfferDocxTemplate(templateAbsPath, data) {
  const content = fs.readFileSync(templateAbsPath, 'binary');
  const zip = new PizZip(content);
  const warnings = new Set();
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: (part) => { warnings.add(`Unrecognized placeholder: {${part.value}}`); return ''; },
  });
  doc.render(data);
  const buffer = doc.getZip().generate({ type: 'nodebuffer' });
  return { buffer, warnings: Array.from(warnings) };
}

// Dry-run against representative sample data - called right after upload,
// before the file is ever saved as the active template, so a typo'd or
// malformed tag is caught immediately instead of surfacing the first time
// someone actually downloads a Word offer.
function validateOfferDocxTemplate(templateAbsPath) {
  const sample = buildOfferTemplateData(
    { offer_no: 'OFR-SAMPLE', offer_date: new Date().toISOString(), subject: 'Sample Equipment', application: 'Sample application', type_of_system: 'Sample system', material_of_construction: 'MS', drawing_no: 'DRG-001', contact_person: 'Sample Contact', contact_phone: '9999999999', contact_email: 'sample@example.com', inclusions: 'Sample inclusions', exclusions: 'Sample exclusions', utilities_requirement: 'Sample utilities', instrument_air_supply: 'Sample air supply' },
    { name: 'Sample Client Pvt Ltd', address: 'Sample Address', gstin: '06AAAAA0000A1Z5' },
    [{ item_code: 'A', section_title: 'Sample Section', description: 'Sample line item', qty: 1, unit_price: 1000, total_price: 1000 }],
    [{ spec_key: 'Capacity', spec_value: '100 kg/hr' }],
    [{ component: 'Motor', make: 'Sample Make' }],
    [{ term_key: 'Payment', term_value: '100% Advance' }],
    { legal_name: 'Venkateshwara Engineers', registered_address: 'Faridabad, Haryana' },
  );
  try {
    const { warnings } = renderOfferDocxTemplate(templateAbsPath, sample);
    return { ok: true, warnings };
  } catch (e) {
    const err = new Error(formatTemplateError(e));
    err.status = 400;
    throw err;
  }
}

// Same {outPath, tmpDir} shape as lib/offerDocx.js's generateOfferDocx, so
// routes/offers.js's GET /:id/docx can call whichever one applies and
// hand the result to the exact same res.download()/cleanup code either way.
function generateOfferDocxFromTemplate(templateAbsPath, offer, client, items, techSpecs, boughtOut, terms, company) {
  const data = buildOfferTemplateData(offer, client, items, techSpecs, boughtOut, terms, company);
  const { buffer } = renderOfferDocxTemplate(templateAbsPath, data);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-docx-tpl-'));
  const outPath = path.join(tmpDir, `${offer.offer_no}.docx`);
  fs.writeFileSync(outPath, buffer);
  return { outPath, tmpDir };
}

function loopParagraphs(openTag, lines, closeTag) {
  return [new Paragraph({ text: openTag }), ...lines.map(t => new Paragraph({ text: t })), new Paragraph({ text: closeTag })];
}

// A ready-to-edit .docx an admin downloads, opens in Microsoft Word, brands
// (fonts, logo, colors, layout) and re-uploads - every recognized {tag} is
// already placed and explained, including the one non-obvious part: the
// {#items}...{/items} scope-of-supply loop has to have its opening tag in
// the first cell of a table row and its closing tag in the last cell of
// THAT SAME row - docxtemplater then repeats the whole row per item. That's
// a docxtemplater convention, not something this file can make more
// obvious than showing it pre-built and explained inline.
async function buildStarterTemplateBuffer() {
  const note = (t) => new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: t, italics: true, color: '808080' })] });
  const tableWidth = 9026;
  const colWidths = [1200, 2426, 1200, 1400, 1400, 1400];
  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 900, bottom: 900, left: 1100, right: 1100 } } },
      children: [
        new Paragraph({ text: 'Offer Word Template - Starter', heading: HeadingLevel.TITLE }),
        note('This is a starting point, not a requirement - edit fonts, colors, logo and layout freely in Word. The only rule: keep every placeholder below exactly as typed (don\'t retype its curly braces - Word\'s autocorrect can turn straight braces into curly quotes) and keep each hash/slash loop pair intact.'),
        new Paragraph({ text: '{company_name}', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: '{company_address}' }),
        new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: 'Offer No: ' }), new TextRun({ text: '{offer_no}', bold: true }), new TextRun({ text: '     Date: ' }), new TextRun({ text: '{offer_date}', bold: true })] }),
        new Paragraph({ text: 'To,', spacing: { before: 200 } }),
        new Paragraph({ children: [new TextRun({ text: '{client_name}', bold: true })] }),
        new Paragraph({ text: '{client_address}' }),
        new Paragraph({ text: 'GSTIN: {client_gstin}' }),
        new Paragraph({ text: 'Attn: {contact_person}   Phone: {contact_phone}   Email: {contact_email}' }),
        new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: 'Subject: ', bold: true }), new TextRun({ text: '{subject}' })] }),

        new Paragraph({ text: 'Project Data', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
        new Paragraph({ children: [new TextRun({ text: 'Application: ', bold: true }), new TextRun({ text: '{application}' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Type Of System: ', bold: true }), new TextRun({ text: '{type_of_system}' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Material Of Construction: ', bold: true }), new TextRun({ text: '{material_of_construction}' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Drawing No: ', bold: true }), new TextRun({ text: '{drawing_no}' })] }),

        new Paragraph({ text: 'Scope Of Supply', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
        note('The second row below is the repeatable item row - its opening loop tag starts in the first cell and the matching closing tag ends in the last cell, both in THIS row. docxtemplater repeats that whole row once per scope item. Add/remove/format columns freely as long as that opening/closing pair stays in the first/last cell of one row.'),
        new Table({
          width: { size: tableWidth, type: WidthType.DXA }, columnWidths: colWidths,
          rows: [
            new TableRow({ children: ['Item', 'Section / Description', 'Qty', 'Unit Price', 'Total Price', ''].map((h, i) => new TableCell({ width: { size: colWidths[i], type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })) }),
            new TableRow({
              children: [
                new TableCell({ width: { size: colWidths[0], type: WidthType.DXA }, children: [new Paragraph({ text: '{#items}{item_code}' })] }),
                new TableCell({ width: { size: colWidths[1], type: WidthType.DXA }, children: [new Paragraph({ text: '{section_title} - {description}' })] }),
                new TableCell({ width: { size: colWidths[2], type: WidthType.DXA }, children: [new Paragraph({ text: '{qty}' })] }),
                new TableCell({ width: { size: colWidths[3], type: WidthType.DXA }, children: [new Paragraph({ text: '{unit_price}' })] }),
                new TableCell({ width: { size: colWidths[4], type: WidthType.DXA }, children: [new Paragraph({ text: '{total_price}' })] }),
                new TableCell({ width: { size: colWidths[5], type: WidthType.DXA }, children: [new Paragraph({ text: '{/items}' })] }),
              ],
            }),
          ],
        }),
        new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Grand Total: ', bold: true }), new TextRun({ text: '{grand_total}', bold: true })] }),

        new Paragraph({ text: 'Specifications', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
        note('A simple paragraph loop (no table) - the opening loop tag sits on its own paragraph, then one repeated line, then the matching closing tag on its own paragraph. Same pattern is used below for Bought-Out Items and Terms.'),
        ...loopParagraphs('{#tech_specs}', ['{spec_key}: {spec_value}'], '{/tech_specs}'),

        new Paragraph({ text: 'Make Of Bought-Out Items', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }),
        ...loopParagraphs('{#bought_out}', ['{component}: {make}'], '{/bought_out}'),

        new Paragraph({ text: 'Terms And Conditions', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
        ...loopParagraphs('{#terms}', ['{term_key}: {term_value}'], '{/terms}'),

        new Paragraph({ text: 'Inclusions / Exclusions', heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 200, after: 200 } }),
        new Paragraph({ children: [new TextRun({ text: 'Inclusions: ', bold: true })] }),
        new Paragraph({ text: '{inclusions}' }),
        new Paragraph({ children: [new TextRun({ text: 'Exclusions: ', bold: true })], spacing: { before: 200 } }),
        new Paragraph({ text: '{exclusions}' }),
        new Paragraph({ children: [new TextRun({ text: 'Utilities Requirement: ', bold: true })], spacing: { before: 200 } }),
        new Paragraph({ text: '{utilities_requirement}' }),
        new Paragraph({ children: [new TextRun({ text: 'Instrument Air Supply: ', bold: true })], spacing: { before: 200 } }),
        new Paragraph({ text: '{instrument_air_supply}' }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildOfferTemplateData, renderOfferDocxTemplate, validateOfferDocxTemplate, generateOfferDocxFromTemplate, buildStarterTemplateBuffer, formatTemplateError };

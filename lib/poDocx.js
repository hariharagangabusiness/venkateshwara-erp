const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, UnderlineType, LevelFormat, BorderStyle,
} = require('docx');
const { richTextToDocxParagraphs, ORDERED_LIST_NUMBERING_REFERENCE } = require('./richText');
const { companyLetterheadDocxParagraphs } = require('./pdfBranding');
const { formatDate } = require('./dateFormat');
const { fmt } = require('./pdfHtml');

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER };

const TABLE_WIDTH_DXA = 9026;
const richTextParagraphs = (raw) => richTextToDocxParagraphs(raw, { Paragraph, TextRun, UnderlineType });

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 2000, type: WidthType.DXA },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: 'DBE5F1' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold: !!opts.header })] })],
  });
}
// The item name cell optionally carries a second, smaller line for the
// line's free-text Additional Details (2026-10-07) - its own TableCell
// variant rather than a cell() option, since every other cell() caller is a
// single plain value with no second line.
function itemCell(name, details, width) {
  const children = [new Paragraph({ children: [new TextRun({ text: String(name ?? '') })] })];
  if (details) children.push(new Paragraph({ children: [new TextRun({ text: String(details), size: 16, color: '555555' })] }));
  return new TableCell({ width: { size: width, type: WidthType.DXA }, children });
}

// Same 3-line shape lib/poPdf.js's formatCompanyAddress() prints (line1 /
// line2 / "city, state, pincode", each its own line) - as separate
// Paragraphs rather than one comma-joined run-on line.
function companyAddressParagraphs(addr) {
  const lines = [addr.line1, addr.line2, [addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')].filter(Boolean);
  return lines.map(l => new Paragraph({ text: l }));
}
// One Bill-To/Ship-To box's full content - bold heading line (matching
// lib/poPdf.js's addressBox()'s "Bill-To Address - <label>:"), address
// lines, then the address's own GSTIN if it carries one.
function addressBoxParagraphs(addr, label) {
  return [
    new Paragraph({ children: [new TextRun({ text: `${label}${addr.label ? ' - ' + addr.label : ''}:`, bold: true })] }),
    ...companyAddressParagraphs(addr),
    ...(addr.gstin ? [new Paragraph({ text: `GSTIN: ${addr.gstin}` })] : []),
  ];
}
// A single bordered one-cell "box" table - docx's default Table border is
// already a visible single line (same look lib/poPdf.js's `.box` CSS class
// gives every box on the PDF), so no explicit border config is needed here.
function boxTable(childrenParas, width) {
  return new Table({
    width: { size: width, type: WidthType.DXA },
    rows: [new TableRow({ children: [new TableCell({ width: { size: width, type: WidthType.DXA }, children: childrenParas })] })],
  });
}

// `lines` is every purchase_orders row sharing `po`'s po_no (one row per
// item - see routes/purchase.js's POST /orders and loadPoBundle()), so a
// single-item PO is just a one-row `lines` array and needs no special
// casing here.
async function generatePoDocx(po, lines, vendor, company, companyAddress, companyShipAddress, purchaseSettings) {
  const vis = (purchaseSettings && purchaseSettings.po_visible_fields) || {};
  const show = (key) => vis[key] !== false; // default on - matches DEFAULT_PURCHASE's own defaults
  // Same exclusion as lib/poPdf.js's poHtml() - a Cancelled sibling line
  // still sits in `lines` (every row sharing this po_no, terminal or not),
  // so it's dropped here too rather than printed alongside the still-live
  // lines as if still being ordered.
  const rows = (lines && lines.length ? lines : [po]).filter(l => l.status !== 'Cancelled');
  const taxable = rows.reduce((s, l) => s + Number(l.total_value || 0), 0);
  const gstAmt = rows.reduce((s, l) => s + Number(l.gst_amount || 0), 0);
  // Freight is one charge for the whole order, duplicated identically onto
  // every line sharing this po_no (see routes/purchase.js) - read off `po`
  // itself rather than summed across `rows`, so it's added once into the
  // grand total, not once per line.
  const freight = Number(po.freight || 0);
  const freightGstRate = Number(po.freight_gst_rate || 0);
  const freightGst = freight * freightGstRate / 100;
  const grand = taxable + gstAmt + freight + freightGst;

  const draftBanner = po.status === 'Draft' ? [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({
        text: '✎ DRAFT — This Purchase Order has not yet been submitted for approval. For internal review only.',
        bold: true, color: '1E40AF',
      })],
    }),
  ] : [];
  const pendingBanner = po.status === 'PendingApproval' ? [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({
        text: '⚠ PENDING APPROVAL — This Purchase Order has not yet been authorized. Values and terms are subject to change until approved.',
        bold: true, color: '991B1B',
      })],
    }),
  ] : [];
  // Matches lib/poPdf.js's `.meta` CSS grid: 2 label/value pairs per row,
  // in the same PO No/Date/Delivery Date/Status/Payment Terms order - a
  // trailing odd item (Payment Terms, the common case) gets its value cell
  // spanned across the rest of the row instead of a dangling empty pair.
  const metaItems = [
    { l: 'PO No', v: po.po_no },
    { l: 'Date', v: formatDate(po.created_at) },
    ...(show('delivery_date') ? [{ l: 'Delivery Date', v: po.delivery_date ? formatDate(po.delivery_date) : '-' }] : []),
    ...(show('status') ? [{ l: 'Status', v: po.status || '-' }] : []),
    ...(show('payment_terms') ? [{ l: 'Payment Terms', v: po.payment_terms || '-' }] : []),
  ];
  const metaColWidths = [1550, 2963, 1550, 2963];
  const metaRows = [];
  for (let i = 0; i < metaItems.length; i += 2) {
    const a = metaItems[i], b = metaItems[i + 1];
    if (b) {
      metaRows.push(new TableRow({ children: [
        cell(a.l, { header: true, width: metaColWidths[0] }), cell(a.v, { width: metaColWidths[1] }),
        cell(b.l, { header: true, width: metaColWidths[2] }), cell(b.v, { width: metaColWidths[3] }),
      ] }));
    } else {
      metaRows.push(new TableRow({ children: [
        cell(a.l, { header: true, width: metaColWidths[0] }),
        new TableCell({
          columnSpan: 3,
          width: { size: metaColWidths[1] + metaColWidths[2] + metaColWidths[3], type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: String(a.v ?? '') })] })],
        }),
      ] }));
    }
  }
  const metaTable = new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: metaColWidths, rows: metaRows });

  // Its own box, same as lib/poPdf.js's Vendor `.box` - name, then (when
  // shown) address + GSTIN/Contact on one line, matching the PDF exactly
  // (previously this app's address_line1/city/state/pincode were never
  // shown in the Word export's Vendor section at all).
  const vendorAddrLine = [vendor.address_line1, vendor.address_line2, vendor.city, vendor.state, vendor.pincode].filter(Boolean).join(' ');
  const vendorParas = [
    new Paragraph({ children: [new TextRun({ text: 'Vendor: ', bold: true }), new TextRun({ text: vendor.legal_name || vendor.name || '' })] }),
    ...(show('vendor_contact')
      ? [
        ...(vendorAddrLine ? [new Paragraph({ text: vendorAddrLine })] : []),
        new Paragraph({ text: `GSTIN: ${vendor.gstin || 'N/A'}   Contact: ${(vendor.contact_person || '-')} ${vendor.phone || ''}`.trim() }),
      ]
      : [new Paragraph({ text: `GSTIN: ${vendor.gstin || 'N/A'}` })]),
  ];
  const vendorBox = boxTable(vendorParas, TABLE_WIDTH_DXA);

  // Bill-To/Ship-To side by side in one 2-cell row when both are set
  // (matching the PDF's flex row of 2 boxes); a lone one gets the full
  // width, same graceful single-box fallback the PDF already has.
  const addrHalf = Math.round(TABLE_WIDTH_DXA / 2);
  let addressBlock = [];
  if (companyAddress && companyShipAddress) {
    addressBlock = [new Table({
      width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: [addrHalf, TABLE_WIDTH_DXA - addrHalf],
      rows: [new TableRow({ children: [
        new TableCell({ width: { size: addrHalf, type: WidthType.DXA }, children: addressBoxParagraphs(companyAddress, 'Bill-To Address') }),
        new TableCell({ width: { size: TABLE_WIDTH_DXA - addrHalf, type: WidthType.DXA }, children: addressBoxParagraphs(companyShipAddress, 'Ship-To Address') }),
      ] })],
    })];
  } else if (companyAddress) {
    addressBlock = [boxTable(addressBoxParagraphs(companyAddress, 'Bill-To Address'), TABLE_WIDTH_DXA)];
  } else if (companyShipAddress) {
    addressBlock = [boxTable(addressBoxParagraphs(companyShipAddress, 'Ship-To Address'), TABLE_WIDTH_DXA)];
  }

  const header = [
    ...draftBanner,
    ...pendingBanner,
    ...companyLetterheadDocxParagraphs(company, { Paragraph, TextRun, HeadingLevel, AlignmentType }),
    // Plain bold+underlined text, not a built-in Heading style - Word's own
    // Heading 1 style carries a blue theme color (confirmed by direct
    // comparison against the PDF, whose own <h1>PURCHASE ORDER</h1> is
    // plain black) - this keeps the title visually identical to the PDF.
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 },
      children: [new TextRun({ text: 'PURCHASE ORDER', bold: true, underline: {}, size: 32 })],
    }),
    metaTable,
    new Paragraph({ text: '' }),
    vendorBox,
    ...addressBlock,
  ];

  // Same 9-column layout as lib/poPdf.js's item table, with every total
  // line (Taxable Value/GST/Freight/Freight GST/Freight Comments/Grand
  // Total) appended as further rows of the SAME table instead of plain,
  // unbordered paragraphs below it - matching the PDF's single bordered
  // table that runs straight from the item rows into its own <tfoot>.
  const itemColWidths = [400, 2726, 900, 650, 650, 600, 1100, 600, 1400];
  const totalsLabelWidth = itemColWidths.slice(0, -1).reduce((a, b) => a + b, 0);
  function totalRow(label, value, opts = {}) {
    return new TableRow({ children: [
      new TableCell({
        columnSpan: itemColWidths.length - 1,
        width: { size: totalsLabelWidth, type: WidthType.DXA },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: label, bold: !!opts.bold })] })],
      }),
      new TableCell({
        width: { size: itemColWidths[itemColWidths.length - 1], type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: opts.rawValue != null ? String(opts.rawValue) : `₹${value}`, bold: !!opts.bold })] })],
      }),
    ] });
  }
  const itemTable = new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: itemColWidths,
    rows: [
      new TableRow({ children: ['#', 'Item', 'HSN', 'Qty', 'Unit', 'GST%', 'Rate (₹)', 'Disc%', 'Amount (₹)'].map((h, i) => cell(h, { header: true, width: itemColWidths[i] })) }),
      ...rows.map((l, i) => new TableRow({ children: [
        cell(String(i + 1), { width: itemColWidths[0] }), itemCell(l.item_name || '', l.details, itemColWidths[1]),
        cell(l.hsn_code || '-', { width: itemColWidths[2] }), cell(l.quantity, { width: itemColWidths[3] }),
        cell(l.unit || 'Nos', { width: itemColWidths[4] }),
        cell(`${l.gst_rate || 0}%`, { width: itemColWidths[5] }),
        cell(fmt(l.rate), { width: itemColWidths[6] }), cell(`${Number(l.discount_percent) || 0}%`, { width: itemColWidths[7] }),
        cell(fmt(l.total_value), { width: itemColWidths[8] }),
      ] })),
      totalRow('Taxable Value', fmt(taxable)),
      totalRow('GST', fmt(gstAmt)),
      ...(freight && show('freight') ? [totalRow('Freight', fmt(freight)), totalRow(`Freight GST (${freightGstRate}%)`, fmt(freightGst))] : []),
      ...(show('freight') && po.freight_notes ? [totalRow('Freight Comments', null, { rawValue: po.freight_notes })] : []),
      totalRow('Grand Total', fmt(grand), { bold: true }),
    ],
  });

  // General Notes and LD Terms each get their own bordered box, matching
  // the PDF's `.box` divs for both, instead of plain unboxed paragraphs.
  const generalNotesBox = po.general_notes ? [boxTable([
    new Paragraph({ children: [new TextRun({ text: 'General Notes: ', bold: true }), new TextRun({ text: po.general_notes })] }),
  ], TABLE_WIDTH_DXA)] : [];
  const ldBox = (show('ld_terms') && (po.ld_percentage || po.ld_cap_percentage || po.ld_trigger_notes)) ? [boxTable([
    new Paragraph({ children: [
      new TextRun({ text: 'LD Terms: ', bold: true }),
      new TextRun({ text: `${po.ld_percentage ? po.ld_percentage + '% per week of delay' : ''}${po.ld_cap_percentage ? ', capped at ' + po.ld_cap_percentage + '% of order value' : ''}` }),
    ] }),
    ...(po.ld_trigger_notes ? [new Paragraph({ text: po.ld_trigger_notes })] : []),
  ], TABLE_WIDTH_DXA)] : [];

  const termsParas = [
    ...(show('terms') ? [
      new Paragraph({ text: 'Terms & Conditions', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }),
      ...(po.terms ? [new Paragraph({ text: po.terms })]
        : (purchaseSettings && purchaseSettings.default_po_terms ? richTextParagraphs(purchaseSettings.default_po_terms)
          : [new Paragraph({ text: 'Standard terms apply. Please confirm receipt of this order and expected delivery date.' })])),
    ] : []),
    ...(show('delivery_guidelines') && purchaseSettings && purchaseSettings.delivery_guidelines ? [
      new Paragraph({ text: 'Delivery Guidelines', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }),
      ...richTextParagraphs(purchaseSettings.delivery_guidelines),
    ] : []),
  ];

  // Vendor Acknowledgement (left) / For Company-Authorized Signatory
  // (right), side by side - matching the PDF's `.foot` flex row, which the
  // Word export never had a "Vendor Acknowledgement" line for at all.
  const footHalf = Math.round(TABLE_WIDTH_DXA / 2);
  const footerTable = new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: [footHalf, TABLE_WIDTH_DXA - footHalf], borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: footHalf, type: WidthType.DXA }, children: [new Paragraph({ text: 'Vendor Acknowledgement', spacing: { before: 400 } })] }),
      new TableCell({ width: { size: TABLE_WIDTH_DXA - footHalf, type: WidthType.DXA }, children: [
        new Paragraph({ text: `For ${company.legal_name || 'Venkateshwara Engineers'}`, spacing: { before: 400 } }),
        new Paragraph({ text: 'Authorized Signatory', spacing: { before: 600 } }),
        ...(company.po_signatory_designation ? [new Paragraph({ text: company.po_signatory_designation })] : []),
      ] }),
    ] })],
  });

  const doc = new Document({
    // Only needed for a numbered-list line (`1. `) inside Terms &
    // Conditions/Delivery Guidelines - richTextToDocxParagraphs() (lib/
    // richText.js) references this same reference name. Bullet lists use
    // docx's built-in `bullet: {level}` instead, which needs no config.
    numbering: { config: [{ reference: ORDERED_LIST_NUMBERING_REFERENCE, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }] }] },
    sections: [{
      properties: { page: { margin: { top: 900, bottom: 900, left: 1100, right: 1100 } } },
      children: [...header, itemTable, ...generalNotesBox, ...ldBox, ...termsParas, new Paragraph({ text: '' }), footerTable],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-docx-'));
  const outPath = path.join(tmpDir, `${po.po_no}.docx`);
  fs.writeFileSync(outPath, buffer);
  return { outPath, tmpDir };
}

module.exports = { generatePoDocx };

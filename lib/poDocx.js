const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, UnderlineType, LevelFormat,
} = require('docx');
const { richTextToDocxParagraphs, ORDERED_LIST_NUMBERING_REFERENCE } = require('./richText');
const { formatDate } = require('./dateFormat');

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

function companyAddressLines(addr) {
  if (!addr) return '';
  return [addr.line1, addr.line2, [addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')].filter(Boolean).join(', ');
}

// `lines` is every purchase_orders row sharing `po`'s po_no (one row per
// item - see routes/purchase.js's POST /orders and loadPoBundle()), so a
// single-item PO is just a one-row `lines` array and needs no special
// casing here.
async function generatePoDocx(po, lines, vendor, company, companyAddress, companyShipAddress, purchaseSettings) {
  const vis = (purchaseSettings && purchaseSettings.po_visible_fields) || {};
  const show = (key) => vis[key] !== false; // default on - matches DEFAULT_PURCHASE's own defaults
  const rows = lines && lines.length ? lines : [po];
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

  const headWidths = [2200, 6826];
  const addressRows = [
    ...(companyAddress ? [new TableRow({ children: [
      cell('Bill-To Address', { header: true, width: headWidths[0] }),
      cell(`${companyAddress.label ? companyAddress.label + ' - ' : ''}${companyAddressLines(companyAddress)}`, { width: headWidths[1] }),
    ] })] : []),
    ...(companyShipAddress ? [new TableRow({ children: [
      cell('Ship-To Address', { header: true, width: headWidths[0] }),
      cell(`${companyShipAddress.label ? companyShipAddress.label + ' - ' : ''}${companyAddressLines(companyShipAddress)}`, { width: headWidths[1] }),
    ] })] : []),
  ];
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
  const header = [
    ...draftBanner,
    ...pendingBanner,
    new Paragraph({ text: company.legal_name || 'Venkateshwara Engineers', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: company.registered_address || '', alignment: AlignmentType.CENTER }),
    new Paragraph({ text: 'PURCHASE ORDER', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } }),
    new Table({
      width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: headWidths,
      rows: [
        new TableRow({ children: [cell('PO No', { header: true, width: headWidths[0] }), cell(po.po_no, { width: headWidths[1] })] }),
        new TableRow({ children: [cell('Date', { header: true, width: headWidths[0] }), cell(formatDate(po.created_at), { width: headWidths[1] })] }),
        ...(show('delivery_date') ? [new TableRow({ children: [cell('Delivery Date', { header: true, width: headWidths[0] }), cell(po.delivery_date ? formatDate(po.delivery_date) : '-', { width: headWidths[1] })] })] : []),
        ...(show('status') ? [new TableRow({ children: [cell('Status', { header: true, width: headWidths[0] }), cell(po.status || '-', { width: headWidths[1] })] })] : []),
        new TableRow({ children: [cell('Vendor', { header: true, width: headWidths[0] }), cell(vendor.legal_name || vendor.name, { width: headWidths[1] })] }),
        new TableRow({ children: [cell('Vendor GSTIN', { header: true, width: headWidths[0] }), cell(vendor.gstin || 'N/A', { width: headWidths[1] })] }),
        ...(show('vendor_contact') ? [new TableRow({ children: [cell('Vendor Contact', { header: true, width: headWidths[0] }), cell(`${vendor.contact_person || '-'} ${vendor.phone || ''}`.trim(), { width: headWidths[1] })] })] : []),
        ...(show('payment_terms') ? [new TableRow({ children: [cell('Payment Terms', { header: true, width: headWidths[0] }), cell(po.payment_terms || '-', { width: headWidths[1] })] })] : []),
        ...addressRows,
      ],
    }),
  ];

  const itemColWidths = [400, 2726, 900, 650, 650, 600, 1100, 600, 1400];
  const itemTable = new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: itemColWidths,
    rows: [
      new TableRow({ children: ['#', 'Item', 'HSN', 'Qty', 'Unit', 'GST%', 'Rate', 'Disc%', 'Amount'].map((h, i) => cell(h, { header: true, width: itemColWidths[i] })) }),
      ...rows.map((l, i) => new TableRow({ children: [
        cell(String(i + 1), { width: itemColWidths[0] }), itemCell(l.item_name || '', l.details, itemColWidths[1]),
        cell(l.hsn_code || '-', { width: itemColWidths[2] }), cell(l.quantity, { width: itemColWidths[3] }),
        cell(l.unit || 'Nos', { width: itemColWidths[4] }),
        cell(l.gst_rate || 0, { width: itemColWidths[5] }),
        cell(Number(l.rate || 0).toFixed(2), { width: itemColWidths[6] }), cell(Number(l.discount_percent) || 0, { width: itemColWidths[7] }),
        cell(Number(l.total_value || 0).toFixed(2), { width: itemColWidths[8] }),
      ] })),
    ],
  });

  const totalsPara = [
    new Paragraph({ text: `Taxable Value: Rs. ${taxable.toFixed(2)}`, alignment: AlignmentType.RIGHT, spacing: { before: 100 } }),
    new Paragraph({ text: `GST: Rs. ${gstAmt.toFixed(2)}`, alignment: AlignmentType.RIGHT }),
    ...(freight && show('freight') ? [
      new Paragraph({ text: `Freight: Rs. ${freight.toFixed(2)}`, alignment: AlignmentType.RIGHT }),
      new Paragraph({ text: `Freight GST (${freightGstRate}%): Rs. ${freightGst.toFixed(2)}`, alignment: AlignmentType.RIGHT }),
    ] : []),
    new Paragraph({ children: [new TextRun({ text: `Grand Total: Rs. ${grand.toFixed(2)}`, bold: true })], alignment: AlignmentType.RIGHT }),
    ...(show('ld_terms') && (po.ld_percentage || po.ld_cap_percentage || po.ld_trigger_notes) ? [
      new Paragraph({
        spacing: { before: 200 },
        children: [
          new TextRun({ text: 'LD Terms: ', bold: true }),
          new TextRun({ text: `${po.ld_percentage ? po.ld_percentage + '% per week of delay' : ''}${po.ld_cap_percentage ? ', capped at ' + po.ld_cap_percentage + '% of order value' : ''}${po.ld_trigger_notes ? ' - ' + po.ld_trigger_notes : ''}` }),
        ],
      }),
    ] : []),
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
    new Paragraph({ text: '' }),
    new Paragraph({ text: `For ${company.legal_name || 'Venkateshwara Engineers'}`, spacing: { before: 400 } }),
    new Paragraph({ text: 'Authorized Signatory', spacing: { before: 600 } }),
    ...(company.po_signatory_designation ? [new Paragraph({ text: company.po_signatory_designation })] : []),
  ];

  const doc = new Document({
    // Only needed for a numbered-list line (`1. `) inside Terms &
    // Conditions/Delivery Guidelines - richTextToDocxParagraphs() (lib/
    // richText.js) references this same reference name. Bullet lists use
    // docx's built-in `bullet: {level}` instead, which needs no config.
    numbering: { config: [{ reference: ORDERED_LIST_NUMBERING_REFERENCE, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }] }] },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1100, right: 1100 } } }, children: [...header, itemTable, ...totalsPara] }],
  });

  const buffer = await Packer.toBuffer(doc);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-docx-'));
  const outPath = path.join(tmpDir, `${po.po_no}.docx`);
  fs.writeFileSync(outPath, buffer);
  return { outPath, tmpDir };
}

module.exports = { generatePoDocx };

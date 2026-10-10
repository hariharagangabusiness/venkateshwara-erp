const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType,
} = require('docx');

const { getUploadsSubdir } = require('./paths');
const { formatDate } = require('./dateFormat');
const annexureDir = getUploadsSubdir('annexures');

const TABLE_WIDTH_DXA = 9026; // ~6.27in usable width at default margins

function labelValueRow(label, value, widths) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: widths[0], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
      }),
      new TableCell({
        width: { size: widths[1], type: WidthType.DXA },
        children: [new Paragraph({ text: value || '' })],
      }),
    ],
  });
}

function sectionHeading(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } });
}

function sanitizeFileName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// Builds the internal execution annexure for a sales order: header
// identifiers, and - for an order confirmed from an offer - Project Data
// Sheet / Technical Specification and Make Of Bought Out Items, neither of
// which exist for an order created directly. Scope Of Supply (no price -
// this is an engineering handoff document, not a commercial one) always
// renders when there's a source for it, from offer_items or, for an
// offer-less order, sales_order_items. Terms & Conditions and
// Inclusions/Exclusions are deliberately left out either way.
async function generateAnnexureDocx({ salesOrder, client, offer, items, techSpecs, boughtOut }) {
  const halfWidth = Math.round(TABLE_WIDTH_DXA * 0.35);
  const restWidth = TABLE_WIDTH_DXA - halfWidth;

  const headerRows = [
    labelValueRow('Sales Order No', salesOrder.order_no, [halfWidth, restWidth]),
    labelValueRow('Customer', client.name, [halfWidth, restWidth]),
    labelValueRow('Subject / Machine', offer ? offer.subject : salesOrder.description, [halfWidth, restWidth]),
    labelValueRow('Date', formatDate(salesOrder.order_date), [halfWidth, restWidth]),
  ];
  // Customer's own PO, already captured via the Sales Orders page's
  // "Customer PO" panel (routes/sales.js's PUT /orders/:id/po) - display
  // only here, not a second entry point for the same two fields. po_number
  // is only ever set when po_status is 'Received', so that alone is enough
  // to know a PO is on file.
  if (salesOrder.po_number) {
    headerRows.push(labelValueRow('Purchase Order No', salesOrder.po_number, [halfWidth, restWidth]));
    if (salesOrder.po_date) {
      headerRows.push(labelValueRow('PO Date', formatDate(salesOrder.po_date), [halfWidth, restWidth]));
    }
  }

  const children = [
    new Paragraph({ text: 'VENKATESHWARA ENGINEERS', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: 'Annexure to Sales Order (Engineering / Execution Reference)', alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
    new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: [halfWidth, restWidth], rows: headerRows }),
  ];

  // Project Data Sheet and tech specs only ever come from an offer - an
  // offer-less order has no equivalent data anywhere to show here.
  if (offer) {
    children.push(sectionHeading('Project Data Sheet'));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Application: ', bold: true }), new TextRun(offer.application || '')] }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Type Of System: ', bold: true }), new TextRun(offer.type_of_system || '')] }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Material Of Construction: ', bold: true }), new TextRun(offer.material_of_construction || '')], spacing: { after: 150 } }));

    if (techSpecs && techSpecs.length) {
      const specWidths = [Math.round(TABLE_WIDTH_DXA * 0.42), 0];
      specWidths[1] = TABLE_WIDTH_DXA - specWidths[0];
      const rows = techSpecs.map(s => labelValueRow(s.spec_key, s.spec_value, specWidths));
      children.push(new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: specWidths, rows }));
    }
  }

  // Scope Of Supply renders off whichever source is available - offer_items
  // for an offer-based order, sales_order_items (entered without a price) for
  // one created directly - so an offer-less order still gets its real item
  // list instead of nothing. A sales_order_items row carries its own unit
  // (offer_items has none), so the Qty cell shows it when present.
  if (items && items.length) {
    children.push(sectionHeading('Scope Of Supply — Machinery Description'));
    const colWidths = [
      Math.round(TABLE_WIDTH_DXA * 0.06),
      Math.round(TABLE_WIDTH_DXA * 0.08),
      Math.round(TABLE_WIDTH_DXA * 0.56),
      Math.round(TABLE_WIDTH_DXA * 0.10),
    ];
    colWidths.push(TABLE_WIDTH_DXA - colWidths.reduce((a, b) => a + b, 0));
    const headerRow = new TableRow({
      children: ['S.No', 'Item', 'Description', 'Qty'].map((h, i) => new TableCell({
        width: { size: colWidths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: 'DBE5F1' },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
      })),
    });
    const dataRows = items.map((it, idx) => new TableRow({
      children: [
        new TableCell({ width: { size: colWidths[0], type: WidthType.DXA }, children: [new Paragraph(String(idx + 1))] }),
        new TableCell({ width: { size: colWidths[1], type: WidthType.DXA }, children: [new Paragraph(it.item_code || '')] }),
        new TableCell({
          width: { size: colWidths[2], type: WidthType.DXA },
          children: [
            ...(it.section_title ? [new Paragraph({ children: [new TextRun({ text: it.section_title, bold: true })] })] : []),
            ...String(it.description || '').split('\n').map(line => new Paragraph(line)),
          ],
        }),
        new TableCell({ width: { size: colWidths[3], type: WidthType.DXA }, children: [new Paragraph(it.unit ? `${it.qty || ''} ${it.unit}`.trim() : String(it.qty || ''))] }),
      ],
    }));
    children.push(new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...dataRows] }));
  }

  // Make Of Bought Out Items is an offer-only concept, same as Project Data
  // Sheet above.
  if (offer && boughtOut && boughtOut.length) {
    children.push(sectionHeading('Make Of Bought Out Items'));
    const boWidths = [Math.round(TABLE_WIDTH_DXA * 0.32), 0];
    boWidths[1] = TABLE_WIDTH_DXA - boWidths[0];
    const rows = boughtOut.map(b => labelValueRow(b.component, b.make, boWidths));
    children.push(new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: boWidths, rows }));
  }

  if (!offer && !(items && items.length)) {
    children.push(new Paragraph({ text: 'No linked offer and no line items found on this sales order - nothing available for this annexure yet.', spacing: { before: 200 } }));
  }

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 900, bottom: 900, left: 1100, right: 1100 } } },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const fileName = `${sanitizeFileName(client.name)}_${sanitizeFileName(salesOrder.order_no)}.docx`;
  const filePath = path.join(annexureDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return { filePath, relativePath: '/uploads/annexures/' + fileName, fileName };
}

module.exports = { generateAnnexureDocx };

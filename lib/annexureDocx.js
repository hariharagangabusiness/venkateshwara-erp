const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType,
} = require('docx');

const annexureDir = path.join(__dirname, '..', 'public', 'uploads', 'annexures');
fs.mkdirSync(annexureDir, { recursive: true });

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

// Builds the internal execution annexure for a confirmed sales order:
// header identifiers, Project Data Sheet / Technical Specification, Scope of
// Supply descriptions (no qty/price - those are commercial), and Make of
// Bought Out Items. Terms & Conditions and Inclusions/Exclusions are
// deliberately left out - this is an engineering handoff document, not a
// commercial one.
async function generateAnnexureDocx({ salesOrder, client, offer, items, techSpecs, boughtOut }) {
  const halfWidth = Math.round(TABLE_WIDTH_DXA * 0.35);
  const restWidth = TABLE_WIDTH_DXA - halfWidth;

  const headerRows = [
    labelValueRow('Sales Order No', salesOrder.order_no, [halfWidth, restWidth]),
    labelValueRow('Customer', client.name, [halfWidth, restWidth]),
    labelValueRow('Subject / Machine', offer ? offer.subject : salesOrder.description, [halfWidth, restWidth]),
    labelValueRow('Date', new Date(salesOrder.order_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), [halfWidth, restWidth]),
  ];

  const children = [
    new Paragraph({ text: 'VENKATESHWARA ENGINEERS', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: 'Annexure to Sales Order (Engineering / Execution Reference)', alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
    new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: [halfWidth, restWidth], rows: headerRows }),
  ];

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

    if (items && items.length) {
      children.push(sectionHeading('Scope Of Supply — Machinery Description'));
      const colWidths = [
        Math.round(TABLE_WIDTH_DXA * 0.08),
        Math.round(TABLE_WIDTH_DXA * 0.62),
        Math.round(TABLE_WIDTH_DXA * 0.10),
      ];
      colWidths.push(TABLE_WIDTH_DXA - colWidths.reduce((a, b) => a + b, 0));
      const headerRow = new TableRow({
        children: ['Item', 'Description', 'Qty'].map((h, i) => new TableCell({
          width: { size: colWidths[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: 'DBE5F1' },
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
        })),
      });
      const dataRows = items.map(it => new TableRow({
        children: [
          new TableCell({ width: { size: colWidths[0], type: WidthType.DXA }, children: [new Paragraph(it.item_code || '')] }),
          new TableCell({
            width: { size: colWidths[1], type: WidthType.DXA },
            children: [
              ...(it.section_title ? [new Paragraph({ children: [new TextRun({ text: it.section_title, bold: true })] })] : []),
              ...String(it.description || '').split('\n').map(line => new Paragraph(line)),
            ],
          }),
          new TableCell({ width: { size: colWidths[2], type: WidthType.DXA }, children: [new Paragraph(String(it.qty || ''))] }),
        ],
      }));
      children.push(new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...dataRows] }));
    }

    if (boughtOut && boughtOut.length) {
      children.push(sectionHeading('Make Of Bought Out Items'));
      const boWidths = [Math.round(TABLE_WIDTH_DXA * 0.32), 0];
      boWidths[1] = TABLE_WIDTH_DXA - boWidths[0];
      const rows = boughtOut.map(b => labelValueRow(b.component, b.make, boWidths));
      children.push(new Table({ width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: boWidths, rows }));
    }
  } else {
    children.push(new Paragraph({ text: 'No linked offer found — this sales order was created without a techno-commercial offer, so no technical annexure content is available.', spacing: { before: 200 } }));
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

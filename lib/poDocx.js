const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType,
} = require('docx');

const TABLE_WIDTH_DXA = 9026;

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 2000, type: WidthType.DXA },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: 'DBE5F1' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold: !!opts.header })] })],
  });
}

function companyAddressLines(addr) {
  if (!addr) return '';
  return [addr.line1, addr.line2, [addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')].filter(Boolean).join(', ');
}

async function generatePoDocx(po, vendor, company, companyAddress) {
  const total = Number(po.total_value || 0);
  const gstAmt = Number(po.gst_amount || 0);
  const grand = total + gstAmt;

  const headWidths = [2200, 6826];
  const addressRows = companyAddress ? [
    new TableRow({ children: [
      cell(`${companyAddress.address_type} Address`, { header: true, width: headWidths[0] }),
      cell(`${companyAddress.label ? companyAddress.label + ' - ' : ''}${companyAddressLines(companyAddress)}`, { width: headWidths[1] }),
    ] }),
  ] : [];
  const header = [
    new Paragraph({ text: company.legal_name || 'Venkateshwara Engineers', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: company.registered_address || '', alignment: AlignmentType.CENTER }),
    new Paragraph({ text: 'PURCHASE ORDER', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 } }),
    new Table({
      width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: headWidths,
      rows: [
        new TableRow({ children: [cell('PO No', { header: true, width: headWidths[0] }), cell(po.po_no, { width: headWidths[1] })] }),
        new TableRow({ children: [cell('Date', { header: true, width: headWidths[0] }), cell(new Date(po.created_at).toLocaleDateString(), { width: headWidths[1] })] }),
        new TableRow({ children: [cell('Vendor', { header: true, width: headWidths[0] }), cell(vendor.legal_name || vendor.name, { width: headWidths[1] })] }),
        new TableRow({ children: [cell('Vendor GSTIN', { header: true, width: headWidths[0] }), cell(vendor.gstin || 'N/A', { width: headWidths[1] })] }),
        ...addressRows,
      ],
    }),
  ];

  const itemColWidths = [500, 3826, 1200, 1000, 1250, 1250];
  const itemTable = new Table({
    width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA }, columnWidths: itemColWidths,
    rows: [
      new TableRow({ children: ['#', 'Item', 'HSN', 'Qty', 'Rate', 'Amount'].map((h, i) => cell(h, { header: true, width: itemColWidths[i] })) }),
      new TableRow({ children: [
        cell('1', { width: itemColWidths[0] }), cell(po.item_name || '', { width: itemColWidths[1] }),
        cell(po.hsn_code || '-', { width: itemColWidths[2] }), cell(po.quantity, { width: itemColWidths[3] }),
        cell(Number(po.rate || 0).toFixed(2), { width: itemColWidths[4] }), cell(total.toFixed(2), { width: itemColWidths[5] }),
      ] }),
    ],
  });

  const totalsPara = [
    new Paragraph({ text: `Taxable Value: Rs. ${total.toFixed(2)}`, alignment: AlignmentType.RIGHT, spacing: { before: 100 } }),
    new Paragraph({ text: `GST @ ${po.gst_rate || 0}%: Rs. ${gstAmt.toFixed(2)}`, alignment: AlignmentType.RIGHT }),
    new Paragraph({ children: [new TextRun({ text: `Grand Total: Rs. ${grand.toFixed(2)}`, bold: true })], alignment: AlignmentType.RIGHT }),
    new Paragraph({ text: 'Terms & Conditions', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }),
    new Paragraph({ text: po.terms || 'Standard terms apply. Please confirm receipt of this order and expected delivery date.' }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: `For ${company.legal_name || 'Venkateshwara Engineers'}`, spacing: { before: 400 } }),
    new Paragraph({ text: company.authorized_signatory_name || 'Authorized Signatory', spacing: { before: 600 } }),
  ];

  const doc = new Document({
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1100, right: 1100 } } }, children: [...header, itemTable, ...totalsPara] }],
  });

  const buffer = await Packer.toBuffer(doc);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-docx-'));
  const outPath = path.join(tmpDir, `${po.po_no}.docx`);
  fs.writeFileSync(outPath, buffer);
  return { outPath, tmpDir };
}

module.exports = { generatePoDocx };

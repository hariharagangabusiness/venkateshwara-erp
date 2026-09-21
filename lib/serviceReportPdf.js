const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getLaunchOptions } = require('./browserPath');
const { WATERMARK_STYLE, watermarkHtml, PDF_BASE_TYPOGRAPHY } = require('./pdfBranding');

function esc(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

function row(label, value) {
  return `<div><span>${esc(label)}:</span> <b>${esc(value) || '-'}</b></div>`;
}

function serviceReportHtml(report, sr, company, spares) {
  const total = (Number(report.amount_travel) || 0) + (Number(report.amount_service) || 0) + (Number(report.amount_spares) || 0) + (Number(report.amount_updown_food) || 0);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{padding:0;margin:0;color:#111;}
    .letterhead{border-bottom:3px solid #1a3a6b;padding-bottom:10px;}
    .co-name{font-size:20px;font-weight:bold;color:#1a3a6b;} .co-sub{font-size:11px;color:#555;}
    h1{font-size:16px;margin:16px 0 2px;text-align:center;text-decoration:underline;}
    h4{font-size:13px;margin:14px 0 4px;color:#1a3a6b;}
    table{width:100%;border-collapse:collapse;margin-top:6px;} th,td{border:1px solid #999;padding:5px 7px;font-size:11px;text-align:left;}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:3px 24px;font-size:12px;}
    .meta div span{color:#555;}
    .box{border:1px solid #ccc;padding:8px;border-radius:4px;font-size:12px;margin-top:4px;white-space:pre-wrap;}
    .foot{margin-top:40px;display:flex;justify-content:space-between;font-size:12px;}
    img.sig{max-width:220px;max-height:80px;border:1px solid #ccc;background:#fff;}
    ${PDF_BASE_TYPOGRAPHY}
    ${WATERMARK_STYLE}
  </style></head><body>
  ${watermarkHtml(company)}
  <div class="letterhead">
    <div class="co-name">${esc(company.legal_name)}</div><div class="co-sub">${esc(company.registered_address)}</div>
  </div>
  <h1>SERVICE REPORT</h1>
  <div class="meta">
    ${row('SR No', sr.sr_no)} ${row('SL. No', report.sl_no)}
    ${row('Customer', report.customer_name)} ${row('Contact Person', report.contact_person)}
    ${row('Contact No', report.contact_no)} ${row('Engineer', report.engineer_name)}
    ${row('Visit From', report.visit_from)} ${row('Visit To', report.visit_to)}
    ${row('Activity Date', report.activity_date)} ${row('Activity Time', (report.activity_start_time||'-') + ' - ' + (report.activity_end_time||'-'))}
    ${row('Machine Type', report.machine_type)} ${row('Capacity', report.machine_capacity)}
    ${row('Type of Visit', report.type_of_visit)} ${row('Status', report.status)}
  </div>
  <div style="grid-column:1/-1;">${row('Customer Address', report.customer_address)}</div>
  <h4>Reason for Visit</h4><div class="box">${esc(report.reason_for_visit)||'-'}</div>
  <h4>Faults Found</h4><div class="box">${esc(report.faults_found)||'-'}</div>
  <h4>Action Taken</h4><div class="box">${esc(report.action_taken)||'-'}</div>
  <h4>Completion Remarks / Pending Reasons</h4><div class="box">${esc(report.completion_remarks)||'-'}</div>
  <h4>Spares Used</h4>
  <table><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit Rate (₹)</th><th>Value (₹)</th></tr></thead>
  <tbody>${(spares||[]).length ? spares.map((s,i) => `<tr><td>${i+1}</td><td>${esc(s.item_name)}</td><td>${s.quantity}</td><td>${fmt(s.unit_rate)}</td><td>${fmt((s.quantity||0)*(s.unit_rate||0))}</td></tr>`).join('') : '<tr><td colspan="5">No spares used</td></tr>'}</tbody></table>
  <h4>Charges</h4>
  <table><tbody>
    <tr><td>Service Charge</td><td>₹${fmt(report.amount_service)}</td></tr>
    <tr><td>Travel</td><td>₹${fmt(report.amount_travel)}</td></tr>
    <tr><td>Up/Down &amp; Food</td><td>₹${fmt(report.amount_updown_food)}</td></tr>
    <tr><td>Spares (claimed)</td><td>₹${fmt(report.amount_spares)}</td></tr>
    <tr><td><b>Total</b></td><td><b>₹${fmt(total)}</b></td></tr>
  </tbody></table>
  <h4>Customer Feedback</h4>
  <div class="meta">
    ${row('Machine Working Satisfactorily', report.machine_working_satisfactorily)}
    ${row('Visit Rating', report.visit_rating)}
    ${row('Overall Feedback', report.overall_feedback)}
  </div>
  <div class="box">${esc(report.customer_remarks)||'-'}</div>
  <div class="foot">
    <div>Customer Signature<br>${report.customer_signature_path ? `<img class="sig" src="${report.customer_signature_path}">` : '<p>Not captured</p>'}</div>
    <div>Engineer: ${esc(report.engineer_name)||'-'}</div>
  </div>
  </body></html>`;
}

async function generateServiceReportPdf(report, sr, company, spares) {
  const launchOptions = await getLaunchOptions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svcrpt-'));
  const outPath = path.join(tmpDir, 'service-report.pdf');
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(serviceReportHtml(report, sr, company, spares), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser.close();
  }
  return { outPath, tmpDir };
}

module.exports = { generateServiceReportPdf, serviceReportHtml };

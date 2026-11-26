// Daily Purchase Velocity & Aging Digest (2026-11-24, requested by the repo owner): one HTML email that mirrors the
// Purchase Velocity dashboard (PR->PO, PO->Approval, PO->GRN cards + Open PO / Open PR), calls out every open PO and
// PR older than 5 days, and attaches a two-sheet Excel workbook with 100% of the open rows. The numbers come from
// lib/purchaseVelocity.js - the same queries the dashboard uses - so the email and the screen cannot disagree.
//
// Schedule: server.js ticks every 5 minutes; this module decides for itself whether it is due (enabled, past the
// configured IST send_time, and last_sent_date is not today). last_sent_date is written BEFORE the send starts, so a
// restart or an overlapping tick can never send twice in a day. A failed send clears it again (retry on a later tick,
// at most once per 30 minutes) so an SMTP outage doesn't lose the day's report.
const XLSX = require('xlsx');
const { db } = require('../db');
const { localDateStr, localDateTimeStr } = require('./dateUtil');
const { formatDate } = require('./dateFormat');
const { esc } = require('./pdfHtml');
const { getDailyPurchaseDigestSettings, setDailyPurchaseDigestSettings } = require('./settings');
const { velocityMetrics, openPoRows, openPrRows } = require('./purchaseVelocity');

const OVER_DAYS = 5; // "older than 5 days" threshold (strictly greater)
const WINDOW_DAYS = 90; // velocity averages cover the dashboard's default window
const PREVIEW_ROWS = 15; // rows shown inline per aging table; the workbook holds all of them
const RETRY_AFTER_FAIL_MIN = 30;

const ageOf = (dateVal) => {
  const d = String(dateVal || '').slice(0, 10);
  if (!d) return null;
  return Math.max(0, Math.round((new Date(localDateStr()) - new Date(d)) / 86400000));
};
const GAP = '<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>';
const fmtDays = (d) => (d == null ? '-' : Number(d).toFixed(1) + ' d');
const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => Number(Number(n || 0).toFixed(3)).toString();

// ---- Data ----
function collectDigestData() {
  const today = localDateStr();
  const from = localDateStr(new Date(Date.now() - WINDOW_DAYS * 86400000));
  const metrics = velocityMetrics(from, today);
  const poLines = openPoRows().map((r) => ({ ...r, age: ageOf(r.po_date) })).sort((a, b) => (b.age || 0) - (a.age || 0) || String(a.po_no).localeCompare(String(b.po_no)));
  const prLines = openPrRows().map((r) => ({ ...r, age: r.days_pending })).sort((a, b) => (b.age || 0) - (a.age || 0) || String(a.pr_no).localeCompare(String(b.pr_no)));

  // Per-document groups (a PO / PR is several rows sharing one number) for the email's tables and counts.
  const group = (lines, key, init, add) => {
    const m = new Map();
    for (const l of lines) { if (!m.has(l[key])) m.set(l[key], init(l)); add(m.get(l[key]), l); }
    return [...m.values()].sort((a, b) => (b.age || 0) - (a.age || 0));
  };
  const poDocs = group(poLines, 'po_no', (l) => ({ po_no: l.po_no, date: l.po_date, vendor: l.vendor_name, age: l.age, lines: 0, pending_qty: 0, pending_value: 0 }),
    (g, l) => { g.lines += 1; g.pending_qty += l.pending_qty; g.pending_value += l.pending_value; });
  const prDocs = group(prLines, 'pr_no', (l) => ({ pr_no: l.pr_no, date: l.created_at, department: l.department, requested_by: l.created_by, status: l.status, age: l.age, items: 0 }),
    (g) => { g.items += 1; });
  return {
    today, from, metrics, poLines, prLines, poDocs, prDocs,
    poOver: poDocs.filter((d) => d.age > OVER_DAYS), prOver: prDocs.filter((d) => d.age > OVER_DAYS),
  };
}

// ---- Excel ----
const yn = (age) => (age > OVER_DAYS ? 'Yes' : 'No');
function buildWorkbookBuffer(data) {
  const poHeader = ['PO No.', 'PO Date', 'Approval Date', 'Vendor', 'Item Code', 'Description', 'Unit', 'Ordered Qty', 'Received Qty', 'Pending Qty', 'Rate', 'Pending Value', 'Status', 'Age (Days)', '> 5 Days'];
  const poRows = data.poLines.map((r) => ({
    'PO No.': r.po_no, 'PO Date': formatDate(r.po_date), 'Approval Date': formatDate(r.approval_date), Vendor: r.vendor_name || '',
    'Item Code': r.item_code || '', Description: r.item_description || '', Unit: r.unit || '',
    'Ordered Qty': r.item_qty, 'Received Qty': r.received_qty, 'Pending Qty': r.pending_qty, Rate: r.rate,
    'Pending Value': Math.round(r.pending_value * 100) / 100, Status: r.status, 'Age (Days)': r.age, '> 5 Days': yn(r.age),
  }));
  const prHeader = ['PR No.', 'PR Date', 'Department', 'Requested By', 'Item Code', 'Description', 'Qty', 'Unit', 'Status', 'Age (Days)', '> 5 Days'];
  const prRows = data.prLines.map((r) => ({
    'PR No.': r.pr_no, 'PR Date': formatDate(r.created_at), Department: r.department || '', 'Requested By': r.created_by || '',
    'Item Code': r.item_code || '', Description: r.item_description || '', Qty: r.quantity, Unit: r.unit || '',
    Status: r.status, 'Age (Days)': r.age, '> 5 Days': yn(r.age),
  }));
  const wb = XLSX.utils.book_new();
  const sheet = (rows, header, widths) => {
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    ws['!cols'] = widths.map((wch) => ({ wch }));
    return ws;
  };
  XLSX.utils.book_append_sheet(wb, sheet(poRows, poHeader, [14, 12, 13, 28, 14, 36, 8, 12, 12, 12, 10, 14, 18, 11, 9]), 'Open Purchase Orders');
  XLSX.utils.book_append_sheet(wb, sheet(prRows, prHeader, [14, 12, 20, 22, 14, 36, 9, 8, 14, 11, 9]), 'Open Purchase Requests');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---- HTML (table layout + inline CSS only: Gmail/Outlook strip <style>/flex/grid) ----
const NAVY = '#1e3a5f', PAPER = '#f4f6f8', RULE = '#dde3e8', INK = '#1a202c', PENCIL = '#6b7686', AMBER_BG = '#fef3cd', AMBER_FG = '#b7791f', RED = '#c53030';
const FONT = "font-family:'Segoe UI',Arial,Helvetica,sans-serif;";

function velocityCard(title, sub, m, waiting, extraLine) {
  return `<td width="33%" valign="top" style="background:#ffffff;border:1px solid ${RULE};border-radius:8px;padding:14px;${FONT}">
      <div style="font-size:12px;color:${PENCIL};">${esc(title)}</div>
      <div style="font-size:28px;font-weight:700;color:${NAVY};line-height:1.25;">${fmtDays(m.avg)}</div>
      <div style="font-size:12px;color:${PENCIL};margin:2px 0 8px;">${esc(sub)}</div>
      <div style="font-size:12px;color:${INK};">${m.count} completed &middot; slowest ${fmtDays(m.max)}</div>
      ${extraLine ? `<div style="font-size:12px;color:${PENCIL};">${extraLine}</div>` : ''}
      <div style="font-size:12px;color:${INK};margin-top:4px;"><b>${m.in_flight} in flight</b> <span style="color:${PENCIL};">(${esc(waiting)})</span></div>
    </td>`;
}
function openCard(title, sub, big, detail) {
  return `<td width="50%" valign="top" style="background:#ffffff;border:1px solid ${RULE};border-radius:8px;padding:14px;${FONT}">
      <div style="font-size:12px;color:${PENCIL};">${esc(title)}</div>
      <div style="font-size:28px;font-weight:700;color:${NAVY};line-height:1.25;">${big}</div>
      <div style="font-size:12px;color:${INK};">${detail}</div>
      <div style="font-size:12px;color:${PENCIL};margin-top:4px;">${esc(sub)}</div>
    </td>`;
}
function agingTable(title, cols, rows, total, shown) {
  const th = (c) => `<th align="${c.right ? 'right' : 'left'}" style="padding:6px 8px;background:#f7f9fb;border-bottom:1px solid ${RULE};font-size:11px;color:${PENCIL};white-space:nowrap;${FONT}">${esc(c.label)}</th>`;
  const body = rows.length ? rows.map((r) => `<tr>${cols.map((c) => `<td align="${c.right ? 'right' : 'left'}" style="padding:6px 8px;border-bottom:1px solid #edf1f4;font-size:12px;color:${c.age ? RED : INK};${c.age ? 'font-weight:700;' : ''}${FONT}">${c.html(r)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" style="padding:10px 8px;font-size:12px;color:${PENCIL};${FONT}">None - nothing is older than ${OVER_DAYS} days.</td></tr>`;
  return `<div style="font-size:14px;font-weight:700;color:${NAVY};margin:16px 0 6px;${FONT}">${esc(title)} <span style="background:${AMBER_BG};color:${AMBER_FG};border-radius:10px;padding:2px 8px;font-size:11px;">${total}</span></div>
    <div style="overflow-x:auto;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${RULE};border-collapse:separate;border-radius:6px;background:#ffffff;"><thead><tr>${cols.map(th).join('')}</tr></thead><tbody>${body}</tbody></table></div>
    ${total > shown ? `<div style="font-size:11px;color:${PENCIL};margin-top:4px;${FONT}">Showing the ${shown} oldest of ${total}. Full list attached in Excel.</div>` : ''}`;
}

function buildDigestHtml(data) {
  const { metrics: m } = data;
  const lineWord = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const poCols = [
    { label: 'PO No.', html: (r) => `<b>${esc(r.po_no)}</b>` }, { label: 'Date', html: (r) => esc(formatDate(r.date)) },
    { label: 'Vendor', html: (r) => esc(r.vendor || '-') }, { label: 'Lines Pending', right: true, html: (r) => r.lines },
    { label: 'Pending Qty', right: true, html: (r) => qty(r.pending_qty) }, { label: 'Pending Value (Rs)', right: true, html: (r) => money(r.pending_value) },
    { label: 'Age (days)', right: true, age: true, html: (r) => r.age },
  ];
  const prCols = [
    { label: 'PR No.', html: (r) => `<b>${esc(r.pr_no)}</b>` }, { label: 'Date', html: (r) => esc(formatDate(r.date)) },
    { label: 'Department / Requester', html: (r) => esc([r.department, r.requested_by].filter(Boolean).join(' / ') || '-') },
    { label: 'Status', html: (r) => esc(r.status) }, { label: 'Items', right: true, html: (r) => r.items },
    { label: 'Age (days)', right: true, age: true, html: (r) => r.age },
  ];
  const badge = (n, label) => `<td style="padding:0 4px;"><span style="display:inline-block;background:${n ? AMBER_BG : '#dcf3e6'};color:${n ? AMBER_FG : '#2f855a'};border-radius:12px;padding:5px 12px;font-size:12px;font-weight:700;${FONT}">${n} ${esc(label)}</span></td>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:${PAPER};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};"><tr><td align="center" style="padding:16px 8px;">
  <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:100%;">
    <tr><td style="background:${NAVY};border-radius:8px 8px 0 0;padding:16px 18px;${FONT}">
      <div style="font-size:18px;font-weight:700;color:#ffffff;">Venkateshwara Engineers &mdash; Daily Purchase Summary</div>
      <div style="font-size:12px;color:#c9d6e6;margin-top:2px;">${esc(formatDate(data.today))} &middot; velocity window ${esc(formatDate(data.from))} to ${esc(formatDate(data.today))} (last ${WINDOW_DAYS} days)</div>
    </td></tr>
    <tr><td style="padding:12px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${velocityCard('PR → PO', 'Purchase Request raised to first PO created', m.pr_po, 'approved PRs with no PO yet')}
      ${GAP}
      ${velocityCard('PO → Approval', 'PO submitted to final approval', m.po_approval, 'POs awaiting approval')}
      ${GAP}
      ${velocityCard('PO → GRN', 'PO approved to first receipt', m.po_grn, 'approved POs with nothing received', `Full receipt: ${fmtDays(m.po_grn.full.avg)} avg (${lineWord(m.po_grn.full.count, 'PO')})`)}
    </tr></table></td></tr>
    <tr><td style="padding:12px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${openCard('Open Purchase Orders', 'Every not-yet-fully-received PO line, across all time.', data.poDocs.length, `${lineWord(data.poDocs.length, 'PO')} &middot; ${lineWord(data.poLines.length, 'open line')}`)}
      ${GAP}
      ${openCard('Open Purchase Requests', 'Draft / Pending Quotes / Pending (and Approved awaiting a PO), across all time.', data.prDocs.length, `${lineWord(data.prDocs.length, 'PR')} &middot; ${lineWord(data.prLines.length, 'item')}`)}
    </tr></table></td></tr>
    <tr><td style="padding:16px 4px 0;"><div style="font-size:15px;font-weight:700;color:${NAVY};${FONT}">Aging &mdash; older than ${OVER_DAYS} days</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>${badge(data.poOver.length, 'open PO(s) > ' + OVER_DAYS + ' days')}${badge(data.prOver.length, 'open PR(s) > ' + OVER_DAYS + ' days')}</tr></table></td></tr>
    <tr><td style="padding:0 4px;">
      ${agingTable(`Open Purchase Orders > ${OVER_DAYS} Days Old`, poCols, data.poOver.slice(0, PREVIEW_ROWS), data.poOver.length, PREVIEW_ROWS)}
      ${agingTable(`Open Purchase Requests > ${OVER_DAYS} Days Old`, prCols, data.prOver.slice(0, PREVIEW_ROWS), data.prOver.length, PREVIEW_ROWS)}
    </td></tr>
    <tr><td style="padding:16px 4px;font-size:11px;color:${PENCIL};${FONT}">Age is counted from the PO / PR creation date. The attached workbook (<b>${esc(fileNameFor(data.today))}</b>) lists every open PO line and PR item, oldest first. Sent automatically by the Venkateshwara Engineers ERP.</td></tr>
  </table></td></tr></table></body></html>`;
}

const fileNameFor = (today) => `Purchase_Open_Summary_${today}.xlsx`;

// ---- Recipients ----
function recipientList(cfg) {
  const out = new Map();
  for (const e of String(cfg.recipients || '').split(/[,;\s]+/).filter(Boolean)) out.set(e.toLowerCase(), e);
  if (cfg.include_hod_management) {
    const rows = db.prepare(`
      SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND TRIM(COALESCE(u.email, '')) <> '' AND (r.name = 'Management' OR (r.name = 'Purchase' AND u.is_supervisor = 1))
    `).all();
    for (const r of rows) out.set(String(r.email).trim().toLowerCase(), String(r.email).trim());
  }
  return [...out.values()];
}

// Builds and sends the digest right now (no schedule/guard checks). Returns { sent, recipients, reason, status, counts }.
async function sendDailyPurchaseDigest({ userId = null, manual = false } = {}) {
  const { sendMail } = require('./mailer');
  const cfg = getDailyPurchaseDigestSettings();
  const recipients = recipientList(cfg);
  if (!recipients.length) return { sent: false, status: 400, reason: 'No recipients: add at least one email address, or tick "Include Purchase HOD(s) and Management" (and make sure those users have an email on file).' };
  const data = collectDigestData();
  const subject = `Daily Purchase Summary - ${formatDate(data.today)} - ${data.poDocs.length} open PO(s), ${data.prDocs.length} open PR(s) (${data.poOver.length + data.prOver.length} older than ${OVER_DAYS} days)`;
  const mail = await sendMail({
    to: recipients.join(', '), subject, html: buildDigestHtml(data),
    attachments: [{ filename: fileNameFor(data.today), content: buildWorkbookBuffer(data), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    skipDefaultCc: true, workflow: 'daily_purchase_digest',
  });
  if (!mail.sent) return { sent: false, status: 502, reason: mail.reason || 'Email could not be sent.' };
  // No dedicated outbound-email log exists in this app; audit_log is where the other emailed documents record a send.
  db.prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)')
    .run(userId, manual ? 'daily_purchase_digest_manual' : 'daily_purchase_digest_sent', 'purchase_digest', null, `${subject} -> ${recipients.join(', ')}`);
  return { sent: true, recipients, openPoCount: data.poDocs.length, openPrCount: data.prDocs.length, poOver5: data.poOver.length, prOver5: data.prOver.length };
}

// Called every few minutes by server.js. Idempotent per IST day; see the header comment.
let running = false;
async function runDailyPurchaseDigest(now = new Date()) {
  const cfg = getDailyPurchaseDigestSettings();
  if (!cfg.enabled) return { sent: false, skipped: 'disabled' };
  const today = localDateStr(now);
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (hhmm < cfg.send_time) return { sent: false, skipped: 'before send time' };
  if (cfg.last_sent_date === today) return { sent: false, skipped: 'already sent today' };
  if (cfg.last_failed_at && (now.getTime() - new Date(cfg.last_failed_at).getTime()) < RETRY_AFTER_FAIL_MIN * 60000) return { sent: false, skipped: 'recent failure, waiting to retry' };
  if (running) return { sent: false, skipped: 'already running' };
  running = true;
  setDailyPurchaseDigestSettings({ last_sent_date: today, last_sent_at: localDateTimeStr(now) }); // guard first
  try {
    const r = await sendDailyPurchaseDigest({ manual: false });
    if (!r.sent) { setDailyPurchaseDigestSettings({ last_sent_date: null, last_failed_at: localDateTimeStr(now) }); console.error('[daily-purchase-digest] not sent:', r.reason); }
    if (r.sent) setDailyPurchaseDigestSettings({ last_failed_at: null });
    return r;
  } catch (e) {
    setDailyPurchaseDigestSettings({ last_sent_date: null, last_failed_at: localDateTimeStr(now) });
    throw e;
  } finally { running = false; }
}

module.exports = { runDailyPurchaseDigest, sendDailyPurchaseDigest, collectDigestData, buildDigestHtml, buildWorkbookBuffer, recipientList, OVER_DAYS };

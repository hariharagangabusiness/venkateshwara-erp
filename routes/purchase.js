const express = require('express');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, issueRfqToken } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const approvals = require('../lib/approvals');
const { generateChallanPdf } = require('../lib/challanPdf');
const { generatePoPdf } = require('../lib/poPdf');
const { generatePoDocx } = require('../lib/poDocx');
const { sendMail } = require('../lib/mailer');
const { getDepartmentEmailIdentity } = require('../lib/departmentEmail');
const { getCompanySettings, getPurchaseSettings } = require('../lib/settings');
const { buildDownloadFilename, buildVersionStamp } = require('../lib/downloadFilename');
const { runInboundRfqScan } = require('../lib/inboundRfqMail');
const { poReceivedQty } = require('../lib/purchaseOrders');
const path = require('path');
const { makeUpload, uploadMemory } = require('../lib/upload');
const router = express.Router();
router.use(authRequired);

// Disk storage for quote documents (PDF/image/etc), following the pattern
// in routes/service.js.
const uploadQuote = makeUpload('purchase-quotes', 15);

// ---- Purchase Requests ----
// Dashboard widget: vendors onboarded vs. vendors with a live, unanswered RFQ
// portal link. An already-Active vendor is never counted as "developing", so
// totalTracked is a true unique-vendor count.
router.get('/dashboard/vendor-analytics', requirePermission('purchase_order.manage'), (req, res) => {
  const onboardedCount = db.prepare("SELECT COUNT(*) AS n FROM vendors WHERE status = 'Active'").get().n;
  const developingCount = db.prepare(`
    SELECT COUNT(DISTINCT t.vendor_id) AS n
    FROM rfq_tokens t
    JOIN vendors v ON v.id = t.vendor_id
    JOIN rfq_requests r ON r.id = t.rfq_request_id
    LEFT JOIN vendor_responses vr ON vr.rfq_token_id = t.id
    WHERE t.revoked = 0 AND t.expires_at > datetime('now') AND r.status = 'Sent'
      AND vr.id IS NULL AND COALESCE(v.status, 'Active') != 'Active'
  `).get().n;
  res.json({ success: true, onboardedCount, developingCount, totalTracked: onboardedCount + developingCount });
});

router.get('/requests', (req, res) => {
  res.json(db.prepare(`
    SELECT pr.*, i.name as item_name, i.status as item_master_status, p.project_code, u.full_name as raised_by_name, d.name as department_name,
      (SELECT COUNT(*) FROM purchase_request_items pri WHERE pri.purchase_request_id = pr.id) as line_count,
      (SELECT COALESCE(SUM(pri.estimated_value), 0) FROM purchase_request_items pri WHERE pri.purchase_request_id = pr.id) as items_total_value,
      (SELECT GROUP_CONCAT(COALESCE(i2.name, pri.item_text), ', ') FROM purchase_request_items pri LEFT JOIN items i2 ON i2.id = pri.item_id WHERE pri.purchase_request_id = pr.id) as item_summary,
      (SELECT COUNT(*) FROM purchase_request_items pri JOIN items i3 ON i3.id = pri.item_id WHERE pri.purchase_request_id = pr.id AND i3.status = 'Pending') as pending_item_count,
      -- Scoped to pr.approval_id (the PR's CURRENT approval cycle), not just
      -- entity_type/entity_id - a resubmit starts a brand-new approvals row
      -- (see POST /requests/:id/resubmit), so matching on entity alone would
      -- keep surfacing a stale rejection from a cycle that's already been
      -- superseded, even once the PR is freshly Pending again.
      (SELECT aa.comment FROM approval_actions aa
        WHERE aa.approval_id = pr.approval_id AND aa.action = 'Rejected'
        ORDER BY aa.acted_at DESC LIMIT 1) as rejection_reason,
      (SELECT ru.full_name FROM approval_actions aa LEFT JOIN users ru ON ru.id = aa.actor_user_id
        WHERE aa.approval_id = pr.approval_id AND aa.action = 'Rejected'
        ORDER BY aa.acted_at DESC LIMIT 1) as rejected_by_name,
      (SELECT aa.comment FROM approval_actions aa
        WHERE aa.approval_id = pr.approval_id AND aa.action = 'InfoRequested'
        ORDER BY aa.acted_at DESC LIMIT 1) as info_requested_note,
      (SELECT ru.full_name FROM approval_actions aa LEFT JOIN users ru ON ru.id = aa.actor_user_id
        WHERE aa.approval_id = pr.approval_id AND aa.action = 'InfoRequested'
        ORDER BY aa.acted_at DESC LIMIT 1) as info_requested_by_name
    FROM purchase_requests pr
    LEFT JOIN items i ON i.id = pr.item_id LEFT JOIN projects p ON p.id = pr.project_id
    LEFT JOIN users u ON u.id = pr.raised_by LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY pr.id DESC
  `).all());
});

// Sidebar "pending count" badge (2026-10-14) - the signed-in user's own
// Purchase Requests still needing action: Draft (not yet submitted),
// Pending/PendingQuotes (awaiting the approval chain), or Rejected (needs
// resubmission) - mirrors canEditPR()'s own "still active" status set.
// Registered ahead of /requests/:id/items, same :id-before-literal-sibling
// discipline this file already follows everywhere else.
router.get('/requests/my-pending-count', (req, res) => {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM purchase_requests
    WHERE raised_by = ? AND status NOT IN ('Approved', 'OrderPlaced', 'Received', 'Cancelled')
  `).get(req.user.id);
  res.json({ count: row.count });
});

// Line items for a single PR - drives the Edit panel and the "From PR" line
// picker on Purchase Order creation.
router.get('/requests/:id/items', (req, res) => {
  res.json(db.prepare(`
    SELECT pri.*, i.name as item_name, i.status as item_master_status, i.unit as item_unit
    FROM purchase_request_items pri LEFT JOIN items i ON i.id = pri.item_id
    WHERE pri.purchase_request_id = ? ORDER BY pri.sort_order, pri.id
  `).all(req.params.id));
});

// Resolves a proposed line's item (from the master, or an ad-hoc typed name
// which becomes a Pending item, same rule as the old single-item flow) and
// returns { itemId, wasAdhoc }.
function resolvePRLineItem(line, userId) {
  if (line.item_id) return { itemId: line.item_id, wasAdhoc: false };
  const text = String(line.item_text || '').trim();
  if (!text) throw new Error('Every line needs an item - pick one from the master, or type its name.');
  const qty = Number(line.quantity);
  if (!qty || qty <= 0) throw new Error(`"${text}" needs a quantity greater than 0.`);
  const info = db.prepare(`INSERT INTO items (name, unit, status, submitted_by) VALUES (?, 'Nos', 'Pending', ?)`).run(text, userId);
  return { itemId: info.lastInsertRowid, wasAdhoc: true };
}

// Draft-first submission (2026-10-07) - a PR is created here purely as a
// Draft, fully editable, with no approval chain started and no quote
// threshold evaluated yet - the requester reviews/edits it in the list
// (same Edit panel every other editable-status PR already uses) and only
// POST /requests/:id/submit-for-approval below actually commits it, which
// is also where the quote-threshold check now happens (moved out of here,
// since a Draft's total can still change before it's submitted).
router.post('/requests', requirePermission('purchase_request.create', 'job_card.manage'), (req, res) => {
  const { project_id, items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item line.' });
  let resolved;
  try {
    resolved = items.map(line => {
      const qty = Number(line.quantity);
      if (!qty || qty <= 0) throw new Error('Every line needs a quantity greater than 0.');
      const { itemId, wasAdhoc } = resolvePRLineItem(line, req.user.id);
      return { itemId, wasAdhoc, quantity: qty, estimatedValue: Number(line.estimated_value) || 0, itemText: line.item_text || null, details: line.details || null };
    });
  } catch (e) { return res.status(400).json({ error: e.message }); }

  const prNo = 'PR-' + Date.now();
  const totalValue = resolved.reduce((sum, l) => sum + l.estimatedValue, 0);
  const first = resolved[0];

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO purchase_requests (pr_no, project_id, raised_by, item_id, item_text, quantity, estimated_value, status, quotes_required)
      VALUES (?,?,?,?,?,?,?,'Draft',0)
    `).run(prNo, project_id || null, req.user.id, first.itemId, first.itemText, first.quantity, totalValue);
    const prId = info.lastInsertRowid;
    const insertLine = db.prepare(`
      INSERT INTO purchase_request_items (purchase_request_id, item_id, item_text, quantity, estimated_value, details, sort_order)
      VALUES (?,?,?,?,?,?,?)
    `);
    resolved.forEach((l, i) => {
      insertLine.run(prId, l.itemId, l.itemText, l.quantity, l.estimatedValue, l.details, i);
      if (l.wasAdhoc) db.prepare('UPDATE items SET created_from_pr_id = ? WHERE id = ?').run(prId, l.itemId);
    });
    return prId;
  });
  const prId = tx();
  res.json({ id: prId, pr_no: prNo, status: 'Draft' });
});

// ---- Vendor discovery for a selected item (Round 13) ----
// Matches vendors to the item's category. Category naming isn't always
// consistent between the two masters (case, whitespace, singular/plural,
// near-synonyms), so matching is done in three tiers:
//   1. normalized-exact (trim/lowercase/collapse-whitespace/singularize)
//   2. normalized substring match, either direction
//   3. fallback to every vendor that has SOME category on file, when
//      nothing above matched - a vendor with no category at all never
//      appears here regardless of tier, so "no category filled in" can't
//      masquerade as a category match (a genuinely uncategorized item, or
//      one whose category matches no vendor's, still needs *some* fallback
//      so the picker isn't left empty, but it should never be padded out
//      with vendors that plainly haven't been categorized).
function normalizeCategory(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/s$/, ''); // simple singular/plural fold
}
router.get('/vendors-for-item/:itemId', (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  let vendors = [];
  let matchType = 'fallback';
  if (item.category) {
    const itemNorm = normalizeCategory(item.category);
    const allVendors = db.prepare(`SELECT * FROM vendors WHERE status = 'Active' OR status IS NULL ORDER BY name`).all();
    if (itemNorm) {
      const exact = allVendors.filter(v => normalizeCategory(v.category) === itemNorm);
      if (exact.length) {
        vendors = exact;
        matchType = 'exact';
      } else {
        const partial = allVendors.filter(v => {
          const vNorm = normalizeCategory(v.category);
          return vNorm && (vNorm.includes(itemNorm) || itemNorm.includes(vNorm));
        });
        if (partial.length) {
          vendors = partial;
          matchType = 'partial';
        }
      }
    }
  }
  const fallback = vendors.length === 0;
  if (fallback) {
    vendors = db.prepare(`
      SELECT * FROM vendors
      WHERE (status = 'Active' OR status IS NULL) AND category IS NOT NULL AND TRIM(category) != ''
      ORDER BY name
    `).all();
    matchType = 'fallback';
  }
  vendors = vendors.map(v => Object.assign({}, v, { match_type: matchType }));
  res.json({ vendors, fallback });
});

// Item price history - every purchase_orders row already carries item_id,
// vendor_id, rate and created_at (one row per PO line - see POST /orders),
// so this is a pure read against data that already exists, no new table.
// Defaults to the last 1 year; `from`/`to` (YYYY-MM-DD) let the caller widen
// or narrow that window. Cancelled/Rejected lines are included (flagged via
// their own `status`, same as everywhere else in this app) rather than
// silently dropped - a cancelled PO's rate is still useful context when
// comparing what was actually quoted/ordered over time.
router.get('/items/:itemId/price-history', requirePermission('purchase_order.manage', 'purchase_request.create'), (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT po.id, po.po_no, po.vendor_id, v.name as vendor_name, po.quantity, po.rate, po.total_value,
      po.status, po.created_at
    FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id
    WHERE po.item_id = ? AND date(po.created_at) BETWEEN date(?) AND date(?)
    ORDER BY po.created_at DESC
  `).all(item.id, from, to);
  res.json({ item: { id: item.id, name: item.name, item_code: item.item_code, unit: item.unit }, from, to, rows });
});

// ---- Purchase Velocity Dashboard ----
// One row per po_no (a multi-line PO is several rows sharing it). Clocks:
// PR->PO = PR created to first PO row; PO->Approval = latest approval's
// submit to its final Approved action (Draft time excluded); PO->GRN = that
// approval to first IN receipt, plus to full receipt (all live lines Received).
const VELOCITY_SQL = `
  WITH g AS (
    SELECT po.po_no, MIN(po.created_at) po_created, MIN(po.purchase_request_id) pr_id, MIN(po.vendor_id) vendor_id,
      COUNT(*) total_lines, SUM(po.status = 'Received') received_lines,
      SUM(po.status IN ('Open','PartiallyReceived','PendingApproval')) open_lines
    FROM purchase_orders po
    WHERE po.po_no IS NOT NULL AND po.status NOT IN ('Draft','Cancelled','Rejected')
    GROUP BY po.po_no),
  la AS (
    SELECT po.po_no, MAX(a.id) approval_id FROM approvals a
    JOIN purchase_orders po ON a.entity_type = 'purchase_order' AND a.entity_id = po.id
    GROUP BY po.po_no),
  ap AS (
    SELECT la.po_no, a.created_at submitted_at, a.status ap_status,
      (SELECT MAX(x.acted_at) FROM approval_actions x WHERE x.approval_id = a.id AND x.action = 'Approved' AND a.status = 'Approved') approved_at
    FROM la JOIN approvals a ON a.id = la.approval_id),
  gr AS (
    SELECT po.po_no, MIN(sm.moved_at) first_grn, MAX(sm.moved_at) last_grn FROM purchase_orders po
    JOIN stock_movements sm ON sm.reference = 'PO#' || po.id AND sm.movement_type = 'IN'
    GROUP BY po.po_no),
  r AS (
    SELECT g.po_no, v.name vendor_name, pr.pr_no, pr.created_at pr_created, g.po_created, g.open_lines,
      ap.submitted_at, ap.ap_status, ap.approved_at, gr.first_grn,
      CASE WHEN g.received_lines = g.total_lines THEN gr.last_grn END full_grn
    FROM g LEFT JOIN vendors v ON v.id = g.vendor_id
      LEFT JOIN purchase_requests pr ON pr.id = g.pr_id
      LEFT JOIN ap ON ap.po_no = g.po_no LEFT JOIN gr ON gr.po_no = g.po_no
    WHERE date(g.po_created) BETWEEN date(?) AND date(?))
  SELECT r.*,
    julianday(po_created) - julianday(pr_created) d_pr_po,
    julianday(approved_at) - julianday(submitted_at) d_approval,
    julianday(first_grn) - julianday(approved_at) d_grn,
    julianday(full_grn) - julianday(approved_at) d_full,
    julianday('now') - julianday(submitted_at) w_approval,
    julianday('now') - julianday(approved_at) w_grn
  FROM r`;

function velocityRange(q) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const to = ok(q.to) ? q.to : new Date().toISOString().slice(0, 10);
  const from = ok(q.from) ? q.from : new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}
// "In flight" = started but the end event hasn't happened yet.
const VELOCITY_INFLIGHT = {
  po_approval: (r) => r.submitted_at && !r.approved_at && ['Pending', 'InfoRequested'].includes(r.ap_status),
  po_grn: (r) => r.approved_at && !r.first_grn && r.open_lines > 0,
};
const VELOCITY_KEYS = { pr_po: 'd_pr_po', po_approval: 'd_approval', po_grn: 'd_grn' };
const VELOCITY_WAIT = { po_approval: 'w_approval', po_grn: 'w_grn' };
// Approved PRs with no PO of any status yet (the PR->PO in-flight set).
const PR_WAITING_SQL = `
  SELECT pr.pr_no, pr.created_at, julianday('now') - julianday(pr.created_at) wait_days FROM purchase_requests pr
  WHERE pr.status = 'Approved' AND date(pr.created_at) BETWEEN date(?) AND date(?)
    AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.purchase_request_id = pr.id)
  ORDER BY wait_days DESC`;

function velocityStats(vals) {
  const v = vals.filter((x) => x != null);
  return { count: v.length, avg: v.length ? v.reduce((s, x) => s + x, 0) / v.length : null, max: v.length ? Math.max(...v) : null };
}

router.get('/velocity', requirePermission('purchase_order.manage'), (req, res) => {
  const { from, to } = velocityRange(req.query);
  const rows = db.prepare(VELOCITY_SQL).all(from, to);
  const metrics = {};
  for (const m of Object.keys(VELOCITY_KEYS)) {
    metrics[m] = velocityStats(rows.map((r) => r[VELOCITY_KEYS[m]]));
    metrics[m].in_flight = m === 'pr_po'
      ? db.prepare(PR_WAITING_SQL).all(from, to).length
      : rows.filter(VELOCITY_INFLIGHT[m]).length;
  }
  metrics.po_grn.full = velocityStats(rows.map((r) => r.d_full));
  res.json({ from, to, metrics });
});

router.get('/velocity/drill', requirePermission('purchase_order.manage'), (req, res) => {
  const m = req.query.metric;
  if (!VELOCITY_KEYS[m]) return res.status(400).json({ error: 'metric must be pr_po, po_approval or po_grn' });
  const { from, to } = velocityRange(req.query);
  const rows = db.prepare(VELOCITY_SQL).all(from, to);
  const startEnd = {
    pr_po: (r) => [r.pr_created, r.po_created],
    po_approval: (r) => [r.submitted_at, r.approved_at],
    po_grn: (r) => [r.approved_at, r.first_grn],
  }[m];
  const done = rows.filter((r) => r[VELOCITY_KEYS[m]] != null).map((r) => {
    const [start, end] = startEnd(r);
    return { ref: r.po_no, vendor_name: r.vendor_name, pr_no: r.pr_no, start, end, days: r[VELOCITY_KEYS[m]], full_days: m === 'po_grn' ? r.d_full : undefined };
  }).sort((a, b) => b.days - a.days);
  const inFlight = m === 'pr_po'
    ? db.prepare(PR_WAITING_SQL).all(from, to).map((p) => ({ ref: p.pr_no, start: p.created_at, days: p.wait_days }))
    : rows.filter(VELOCITY_INFLIGHT[m]).map((r) => ({ ref: r.po_no, vendor_name: r.vendor_name, pr_no: r.pr_no, start: startEnd(r)[0], days: r[VELOCITY_WAIT[m]] }))
      .sort((a, b) => b.days - a.days);
  res.json({ from, to, metric: m, done, in_flight: inFlight });
});

// ---- Multi-vendor quotes for a Purchase Request (Round 13) ----
router.get('/requests/:id/quotes', (req, res) => {
  res.json(db.prepare(`
    SELECT q.*, v.name as vendor_name, u.full_name as created_by_name, pri.item_text as pr_item_text, i.name as pr_item_name
    FROM purchase_request_quotes q LEFT JOIN vendors v ON v.id = q.vendor_id LEFT JOIN users u ON u.id = q.created_by
      LEFT JOIN purchase_request_items pri ON pri.id = q.purchase_request_item_id LEFT JOIN items i ON i.id = pri.item_id
    WHERE q.purchase_request_id = ? ORDER BY q.id DESC
  `).all(req.params.id));
});

router.post('/requests/:id/quotes', requirePermission('purchase_request.create', 'purchase_order.manage'), uploadQuote.single('quote_file'), (req, res) => {
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  const { vendor_id, quoted_amount, notes, purchase_request_item_id, payment_terms, delivery_commit_date, quoted_qty, rfq_request_id } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'Pick a vendor.' });
  const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendor_id);
  if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists.' });
  // Optional: this quote is for one specific line item rather than a whole-PR
  // lump sum - must belong to this same PR, same guard as everywhere else
  // that accepts a purchase_request_item_id from the client.
  let itemId = null;
  if (purchase_request_item_id) {
    const line = db.prepare('SELECT id FROM purchase_request_items WHERE id = ? AND purchase_request_id = ?').get(purchase_request_item_id, pr.id);
    if (!line) return res.status(400).json({ error: 'That line item does not belong to this Purchase Request.' });
    itemId = line.id;
  }
  const filePath = req.file ? '/uploads/purchase-quotes/' + req.file.filename : null;
  const info = db.prepare(`
    INSERT INTO purchase_request_quotes (purchase_request_id, vendor_id, quoted_amount, quote_file_path, notes,
      purchase_request_item_id, payment_terms, delivery_commit_date, quoted_qty, rfq_request_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(pr.id, vendor_id, quoted_amount ? Number(quoted_amount) : null, filePath, notes || null,
    itemId, payment_terms || null, delivery_commit_date || null, quoted_qty ? Number(quoted_qty) : null,
    rfq_request_id || null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/requests/:id/quotes/:quoteId', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const quote = db.prepare('SELECT * FROM purchase_request_quotes WHERE id = ? AND purchase_request_id = ?').get(req.params.quoteId, req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM purchase_request_quotes WHERE id = ?').run(quote.id);
  res.json({ ok: true });
});

router.put('/requests/:id/quotes/:quoteId/select', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const quote = db.prepare('SELECT * FROM purchase_request_quotes WHERE id = ? AND purchase_request_id = ?').get(req.params.quoteId, req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE purchase_request_quotes SET is_selected = 0 WHERE purchase_request_id = ?').run(req.params.id);
    db.prepare('UPDATE purchase_request_quotes SET is_selected = 1 WHERE id = ?').run(quote.id);
  });
  tx();
  res.json({ ok: true });
});

// ---- RFQ: select PR line items + vendors, send an editable email template ----
// Outbound only - see the rfq_requests/rfq_request_vendors comment in
// db/schema.sql. A vendor's reply still comes back by phone/email outside
// the system and gets typed into POST /requests/:id/quotes as before,
// optionally against the specific line item and carrying payment_terms/
// delivery_commit_date/quoted_qty this RFQ asked for.
const RFQ_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
router.get('/requests/:id/rfq', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const requests = db.prepare(`
    SELECT r.*, u.full_name as created_by_name FROM rfq_requests r LEFT JOIN users u ON u.id = r.created_by
    WHERE r.purchase_request_id = ? ORDER BY r.id DESC
  `).all(req.params.id);
  const vendorsByRfq = db.prepare(`
    SELECT rv.*, v.name as vendor_name FROM rfq_request_vendors rv JOIN vendors v ON v.id = rv.vendor_id
    WHERE rv.rfq_request_id = ? ORDER BY rv.id
  `);
  const emailsByRfq = db.prepare(`SELECT * FROM rfq_request_emails WHERE rfq_request_id = ? ORDER BY id`);
  res.json(requests.map(r => ({
    ...r, status: r.status, item_ids: JSON.parse(r.item_ids || '[]'),
    vendor_ids: JSON.parse(r.vendor_ids || '[]'), extra_emails: JSON.parse(r.extra_emails || '[]'),
    vendors: vendorsByRfq.all(r.id), emails: emailsByRfq.all(r.id),
  })));
});

// Actually emails every vendor/extra-address targeted by an RFQ - shared by
// the immediate "Send Now" path below and POST /purchase/rfqs/:id/send
// (sending an already-saved Draft), so the two can never drift apart.
async function dispatchRfqEmails(rfqId, vendors, extraEmails, subject, body, baseUrl) {
  const insertVendorRow = db.prepare(`INSERT INTO rfq_request_vendors (rfq_request_id, vendor_id, email_status) VALUES (?,?,'Pending')`);
  const updateVendorRow = db.prepare(`UPDATE rfq_request_vendors SET email_status=?, email_error=?, sent_at=?, sent_message_id=? WHERE id=?`);
  const insertEmailRow = db.prepare(`INSERT INTO rfq_request_emails (rfq_request_id, email, email_status) VALUES (?,?,'Pending')`);
  const updateEmailRow = db.prepare(`UPDATE rfq_request_emails SET email_status=?, email_error=?, sent_at=?, sent_message_id=? WHERE id=?`);
  const now = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const fromIdentity = getDepartmentEmailIdentity('Purchase');

  // Plain-text requirement list for {{items_table}}. Spec = the PR line's "Additional Details"
  // (Item Master has no description column).
  const rfqRow = db.prepare('SELECT item_ids FROM rfq_requests WHERE id = ?').get(rfqId);
  const itemIds = JSON.parse((rfqRow && rfqRow.item_ids) || '[]').map(Number);
  const itemRows = itemIds.length ? db.prepare(`
    SELECT COALESCE(i.name, pri.item_text) as name, pri.details, pri.quantity, COALESCE(i.unit, 'Nos') as unit
    FROM purchase_request_items pri LEFT JOIN items i ON i.id = pri.item_id
    WHERE pri.id IN (${itemIds.map(() => '?').join(',')}) ORDER BY pri.sort_order, pri.id
  `).all(...itemIds) : [];
  const itemsTableText = itemRows.map((r, n) =>
    `${n + 1}. ${r.name || '-'}${r.details ? ` (${r.details})` : ''} - ${r.quantity} ${r.unit}`).join('\n');
  // Fills {{items_table}}; if the token is absent, inserts the list above the portal-link footer
  // (or at the end when there is no link). Recipients without a link still get the list.
  const withItems = (text, footerMarker) => {
    if (!itemsTableText) return text.split('{{items_table}}').join('');
    if (text.includes('{{items_table}}')) return text.split('{{items_table}}').join(itemsTableText);
    const at = footerMarker ? text.lastIndexOf(footerMarker) : -1;
    return at >= 0 ? `${text.slice(0, at)}Items requested:\n${itemsTableText}\n\n${text.slice(at)}` : `${text}\n\nItems requested:\n${itemsTableText}`;
  };

  const results = [];
  for (const vendor of vendors) {
    const rowId = insertVendorRow.run(rfqId, vendor.id).lastInsertRowid;
    const to = vendor.po_email || vendor.email;
    if (!to) {
      updateVendorRow.run('NoEmail', 'This vendor has no PO/general email on file.', null, null, rowId);
      results.push({ vendor_id: vendor.id, vendor_name: vendor.name, email_status: 'NoEmail' });
      continue;
    }
    // {{vendor_name}} is the only personalization token - simple mail-merge,
    // not a template engine, since the editable body is meant to stay
    // readable/predictable for whoever wrote it.
    let personalizedBody = body.split('{{vendor_name}}').join(vendor.name || '');
    // Per-vendor portal link: a re-send replaces this vendor's earlier unused
    // token (the raw token can't be recovered), but a vendor who already
    // submitted keeps theirs and gets no new link.
    let portalLink = '';
    const prior = db.prepare('SELECT t.id, (SELECT COUNT(*) FROM vendor_responses r WHERE r.rfq_token_id = t.id) as done FROM rfq_tokens t WHERE t.rfq_request_id = ? AND t.vendor_id = ?').get(rfqId, vendor.id);
    if (!(prior && prior.done)) {
      if (prior) db.prepare('DELETE FROM rfq_tokens WHERE id = ?').run(prior.id);
      portalLink = `${baseUrl}/vendor.html?token=${issueRfqToken(rfqId, vendor.id)}`;
    }
    const footer = portalLink ? `Submit your quotation online: ${portalLink}` : '';
    // Items first (before the auto-appended footer exists), so the fallback list lands above it.
    if (personalizedBody.includes('{{portal_link}}')) personalizedBody = withItems(personalizedBody, '{{portal_link}}').split('{{portal_link}}').join(portalLink);
    else personalizedBody = withItems(personalizedBody, '') + (footer ? `\n\n${footer}` : '');
    const result = await sendMail({ to, subject: subject.trim(), text: personalizedBody, ...fromIdentity });
    if (result.sent) {
      updateVendorRow.run('Sent', null, now(), result.messageId || null, rowId);
      results.push({ vendor_id: vendor.id, vendor_name: vendor.name, email_status: 'Sent' });
    } else {
      updateVendorRow.run('Failed', result.reason || 'Unknown error', null, null, rowId);
      results.push({ vendor_id: vendor.id, vendor_name: vendor.name, email_status: 'Failed', email_error: result.reason });
    }
  }
  for (const email of extraEmails) {
    const rowId = insertEmailRow.run(rfqId, email).lastInsertRowid;
    // No vendor name to personalize with for a manually-typed address.
    const personalizedBody = withItems(body.split('{{vendor_name}}').join(''), '{{portal_link}}').split('{{portal_link}}').join(''); // no vendor id -> no portal link
    const result = await sendMail({ to: email, subject: subject.trim(), text: personalizedBody, ...fromIdentity });
    if (result.sent) {
      updateEmailRow.run('Sent', null, now(), result.messageId || null, rowId);
      results.push({ email, email_status: 'Sent' });
    } else {
      updateEmailRow.run('Failed', result.reason || 'Unknown error', null, null, rowId);
      results.push({ email, email_status: 'Failed', email_error: result.reason });
    }
  }
  return results;
}

router.post('/requests/:id/rfq', requirePermission('purchase_request.create', 'purchase_order.manage'), async (req, res) => {
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  const { item_ids, vendor_ids, subject, body } = req.body;
  const isDraft = !!req.body.draft;
  // Manually-typed recipients not on file in Vendor Master at all (a new
  // vendor's buyer, a broker, an alternate contact) - optional, alongside
  // (not instead of) picking from Vendor Master.
  const extraEmails = [...new Set((Array.isArray(req.body.extra_emails) ? req.body.extra_emails : [])
    .map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const badEmails = extraEmails.filter(e => !RFQ_EMAIL_RE.test(e));
  if (badEmails.length) return res.status(400).json({ error: `"${badEmails.join('", "')}" doesn't look like a valid email address.` });
  if (!Array.isArray(item_ids) || !item_ids.length) return res.status(400).json({ error: 'Select at least one line item to request quotes for.' });
  // A Draft can be saved with no recipients yet (they're often added later,
  // while reviewing) - only an actual send requires at least one.
  if (!isDraft && (!Array.isArray(vendor_ids) || !vendor_ids.length) && !extraEmails.length) {
    return res.status(400).json({ error: 'Add at least one vendor or email address to send the RFQ to.' });
  }
  if (!String(subject || '').trim()) return res.status(400).json({ error: 'Subject is required.' });
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Email body is required.' });
  const lines = db.prepare(`SELECT id FROM purchase_request_items WHERE purchase_request_id = ?`).all(pr.id).map(r => r.id);
  const badItems = item_ids.filter(id => !lines.includes(Number(id)));
  if (badItems.length) return res.status(400).json({ error: `Line item(s) ${badItems.join(', ')} do not belong to this Purchase Request.` });
  const vendorIds = Array.isArray(vendor_ids) ? vendor_ids.map(Number) : [];
  const vendors = vendorIds.length ? db.prepare(`SELECT * FROM vendors WHERE id IN (${vendorIds.map(() => '?').join(',')})`).all(...vendorIds) : [];
  if (vendors.length !== vendorIds.length) return res.status(400).json({ error: 'One or more selected vendors no longer exist.' });

  const info = db.prepare(`
    INSERT INTO rfq_requests (purchase_request_id, item_ids, subject, body, created_by, status, vendor_ids, extra_emails)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(pr.id, JSON.stringify(item_ids.map(Number)), subject.trim(), body, req.user.id,
    isDraft ? 'Draft' : 'Sent', JSON.stringify(vendorIds), JSON.stringify(extraEmails));
  const rfqId = info.lastInsertRowid;

  if (isDraft) return res.json({ id: rfqId, status: 'Draft' });
  const results = await dispatchRfqEmails(rfqId, vendors, extraEmails, subject, body, `${req.protocol}://${req.get('host')}`);
  res.json({ id: rfqId, status: 'Sent', results });
});

// Sends a Draft RFQ - reads back the vendor_ids/extra_emails it was saved
// with (same dual Vendor-Master/manually-typed shape POST /requests/:id/rfq
// already accepts) and dispatches through the identical shared sender, then
// flips status to Sent. Only a genuine Draft can be sent this way - a
// Sent/Closed RFQ already has its own real send-attempt rows and isn't
// re-sendable through this route.
router.post('/rfqs/:id/send', requirePermission('purchase_request.create', 'purchase_order.manage'), async (req, res) => {
  const rfq = db.prepare('SELECT * FROM rfq_requests WHERE id = ?').get(req.params.id);
  if (!rfq) return res.status(404).json({ error: 'Not found' });
  if (rfq.status !== 'Draft') return res.status(400).json({ error: 'Only a Draft RFQ can be sent from here.' });
  const vendorIds = JSON.parse(rfq.vendor_ids || '[]');
  const extraEmails = JSON.parse(rfq.extra_emails || '[]');
  if (!vendorIds.length && !extraEmails.length) {
    return res.status(400).json({ error: 'Add at least one vendor or email address before sending - edit the Draft first.' });
  }
  const vendors = vendorIds.length ? db.prepare(`SELECT * FROM vendors WHERE id IN (${vendorIds.map(() => '?').join(',')})`).all(...vendorIds) : [];
  const results = await dispatchRfqEmails(rfq.id, vendors, extraEmails, rfq.subject, rfq.body, `${req.protocol}://${req.get('host')}`);
  db.prepare(`UPDATE rfq_requests SET status = 'Sent' WHERE id = ?`).run(rfq.id);
  res.json({ id: rfq.id, status: 'Sent', results });
});

// Edits a Draft's own content (item_ids/subject/body/targeted vendors) -
// locked once Sent/Closed, same "Draft is freely editable, a live
// record isn't" shape Purchase Requests/Orders already use elsewhere.
router.put('/rfqs/:id', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const rfq = db.prepare('SELECT * FROM rfq_requests WHERE id = ?').get(req.params.id);
  if (!rfq) return res.status(404).json({ error: 'Not found' });
  if (rfq.status !== 'Draft') return res.status(400).json({ error: 'Only a Draft RFQ can be edited - a Sent RFQ already went out with its original content.' });
  const { item_ids, vendor_ids, subject, body } = req.body;
  const extraEmails = [...new Set((Array.isArray(req.body.extra_emails) ? req.body.extra_emails : [])
    .map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const badEmails = extraEmails.filter(e => !RFQ_EMAIL_RE.test(e));
  if (badEmails.length) return res.status(400).json({ error: `"${badEmails.join('", "')}" doesn't look like a valid email address.` });
  if (!Array.isArray(item_ids) || !item_ids.length) return res.status(400).json({ error: 'Select at least one line item to request quotes for.' });
  if (!String(subject || '').trim()) return res.status(400).json({ error: 'Subject is required.' });
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Email body is required.' });
  const lines = db.prepare(`SELECT id FROM purchase_request_items WHERE purchase_request_id = ?`).all(rfq.purchase_request_id).map(r => r.id);
  const badItems = item_ids.filter(id => !lines.includes(Number(id)));
  if (badItems.length) return res.status(400).json({ error: `Line item(s) ${badItems.join(', ')} do not belong to this Purchase Request.` });
  const vendorIds = Array.isArray(vendor_ids) ? vendor_ids.map(Number) : [];
  if (vendorIds.length) {
    const count = db.prepare(`SELECT COUNT(*) as n FROM vendors WHERE id IN (${vendorIds.map(() => '?').join(',')})`).get(...vendorIds).n;
    if (count !== vendorIds.length) return res.status(400).json({ error: 'One or more selected vendors no longer exist.' });
  }
  db.prepare(`
    UPDATE rfq_requests SET item_ids=?, subject=?, body=?, vendor_ids=?, extra_emails=? WHERE id = ?
  `).run(JSON.stringify(item_ids.map(Number)), subject.trim(), body, JSON.stringify(vendorIds), JSON.stringify(extraEmails), rfq.id);
  res.json({ ok: true });
});

// Deletes a Draft outright - nothing was ever sent, so there's no "honest
// audit trail" reason to keep it around the way a Cancel/Close leaves a
// real record for.
router.delete('/rfqs/:id', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const rfq = db.prepare('SELECT * FROM rfq_requests WHERE id = ?').get(req.params.id);
  if (!rfq) return res.status(404).json({ error: 'Not found' });
  if (rfq.status !== 'Draft') return res.status(400).json({ error: 'Only a Draft RFQ can be deleted.' });
  db.prepare('DELETE FROM rfq_requests WHERE id = ?').run(rfq.id);
  res.json({ ok: true });
});

// Marks a Sent RFQ as Closed - no more quotes are expected against it.
// Purely a status label (same role Purchase Orders' own "Closed"/Short
// Ship status plays) - doesn't touch purchase_request_quotes or anything
// already received against it.
router.post('/rfqs/:id/close', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const rfq = db.prepare('SELECT * FROM rfq_requests WHERE id = ?').get(req.params.id);
  if (!rfq) return res.status(404).json({ error: 'Not found' });
  if (rfq.status !== 'Sent') return res.status(400).json({ error: 'Only a Sent RFQ can be closed.' });
  db.prepare(`UPDATE rfq_requests SET status = 'Closed', closed_by = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.user.id, rfq.id);
  res.json({ ok: true });
});

// Cross-PR RFQ Dashboard list - every RFQ ever created (Draft/Sent/Closed),
// with its linked PR and a target-vendor count. GET /requests/:id/rfq above
// stays scoped to one PR (used by that PR's own detail screen); this is the
// system-wide view the RFQ Dashboard page needs, which didn't exist before
// this round - the previous RFQ UI only ever showed one PR's own RFQs.
router.get('/rfqs', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.full_name as created_by_name, pr.pr_no as purchase_request_no, pr.id as pr_id
    FROM rfq_requests r
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN purchase_requests pr ON pr.id = r.purchase_request_id
    ORDER BY r.id DESC
  `).all();
  const vendorCounts = db.prepare(`SELECT rfq_request_id, COUNT(*) as n FROM rfq_request_vendors GROUP BY rfq_request_id`).all();
  const emailCounts = db.prepare(`SELECT rfq_request_id, COUNT(*) as n FROM rfq_request_emails GROUP BY rfq_request_id`).all();
  const vendorCountById = Object.fromEntries(vendorCounts.map(r => [r.rfq_request_id, r.n]));
  const emailCountById = Object.fromEntries(emailCounts.map(r => [r.rfq_request_id, r.n]));
  res.json(rows.map(r => ({
    ...r,
    item_ids: JSON.parse(r.item_ids || '[]'),
    vendor_ids: JSON.parse(r.vendor_ids || '[]'),
    extra_emails: JSON.parse(r.extra_emails || '[]'),
    // For a Draft (no real send-attempt rows yet) the target count comes
    // from the saved intent; for Sent/Closed it comes from the actual rows
    // dispatchRfqEmails() created - these can never disagree once sent.
    target_vendor_count: r.status === 'Draft'
      ? JSON.parse(r.vendor_ids || '[]').length + JSON.parse(r.extra_emails || '[]').length
      : (vendorCountById[r.id] || 0) + (emailCountById[r.id] || 0),
  })));
});

// Side-by-side comparison of vendor-portal quotations for one RFQ.
router.get('/rfqs/:id/comparison', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const rfq = db.prepare('SELECT r.*, pr.pr_no FROM rfq_requests r LEFT JOIN purchase_requests pr ON pr.id = r.purchase_request_id WHERE r.id = ?').get(req.params.id);
  if (!rfq) return res.status(404).json({ error: 'Not found' });
  const itemIds = JSON.parse(rfq.item_ids || '[]').map(Number);
  const items = itemIds.length ? db.prepare(`
    SELECT pri.id, COALESCE(i.name, pri.item_text) as name, pri.details, pri.quantity, COALESCE(i.unit, 'Nos') as unit
    FROM purchase_request_items pri LEFT JOIN items i ON i.id = pri.item_id
    WHERE pri.id IN (${itemIds.map(() => '?').join(',')}) ORDER BY pri.sort_order, pri.id
  `).all(...itemIds) : [];
  const vendors = db.prepare(`
    SELECT rv.vendor_id, v.name, vr.id as response_id, vr.remarks, vr.submitted_at
    FROM rfq_request_vendors rv
    JOIN vendors v ON v.id = rv.vendor_id
    LEFT JOIN rfq_tokens t ON t.rfq_request_id = rv.rfq_request_id AND t.vendor_id = rv.vendor_id
    LEFT JOIN vendor_responses vr ON vr.rfq_token_id = t.id
    WHERE rv.rfq_request_id = ? ORDER BY v.name
  `).all(rfq.id);
  const qtyById = Object.fromEntries(items.map(i => [i.id, i.quantity]));
  const out = vendors.map(v => {
    const lines = {};
    let total = 0, maxLead = 0;
    if (v.response_id) {
      db.prepare('SELECT purchase_request_item_id as item_id, unit_rate, lead_days FROM vendor_response_lines WHERE vendor_response_id = ?').all(v.response_id)
        .forEach(l => {
          const subtotal = l.unit_rate * (qtyById[l.item_id] || 0);
          lines[l.item_id] = { unit_rate: l.unit_rate, lead_days: l.lead_days, subtotal };
          total += subtotal; maxLead = Math.max(maxLead, l.lead_days);
        });
    }
    return { vendor_id: v.vendor_id, name: v.name, responded: !!v.response_id, submitted_at: v.submitted_at, remarks: v.remarks,
      lines, total: v.response_id ? total : null, max_lead_days: v.response_id ? maxLead : null, is_lowest_total: false };
  });
  const responded = out.filter(v => v.responded);
  if (responded.length) {
    const minTotal = Math.min(...responded.map(v => v.total));
    responded.forEach(v => { v.is_lowest_total = v.total === minTotal; });
  }
  items.forEach(it => {
    const rates = responded.filter(v => v.lines[it.id]).map(v => ({ id: v.vendor_id, r: v.lines[it.id].unit_rate }));
    const min = rates.length ? Math.min(...rates.map(x => x.r)) : null;
    it.lowest_rate_vendor_ids = rates.filter(x => x.r === min).map(x => x.id);
  });
  res.json({ rfq: { id: rfq.id, reference: rfq.pr_no || ('RFQ-' + rfq.id), status: rfq.status }, items, vendors: out });
});

// ===================== RFQ vendor-response mailbox scan =====================
// Mail read from a dedicated Purchase inbox (lib/inboundRfqMail.js, polled
// from server.js) lands here first, never straight into
// purchase_request_quotes - see that file's header comment for the
// ThreadMatch/SenderMatch matching it already attempted. A Purchase
// Executive confirms each item into a real quote (pre-filled from the
// match, editable/completable before saving) or dismisses it.
router.get('/rfq-inbox', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const rows = db.prepare(`
    SELECT irr.*, v.name as matched_vendor_name, r.subject as rfq_subject, r.purchase_request_id, pr.pr_no as purchase_request_no
    FROM incoming_rfq_responses irr
    LEFT JOIN vendors v ON v.id = irr.matched_vendor_id
    LEFT JOIN rfq_requests r ON r.id = irr.matched_rfq_request_id
    LEFT JOIN purchase_requests pr ON pr.id = r.purchase_request_id
    WHERE irr.status = 'Pending'
    ORDER BY irr.received_at DESC
  `).all();
  res.json(rows);
});

// Flat list of every RFQ ever sent, most recent first - populates the
// manual RFQ picker on an inbox item that didn't auto-match (no thread or
// sender match found).
router.get('/rfq-inbox/open-rfqs', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.subject, r.purchase_request_id, pr.pr_no as purchase_request_no
    FROM rfq_requests r LEFT JOIN purchase_requests pr ON pr.id = r.purchase_request_id
    ORDER BY r.id DESC LIMIT 200
  `).all();
  res.json(rows);
});

router.post('/rfq-inbox/:id/confirm', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const item = db.prepare('SELECT * FROM incoming_rfq_responses WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.status !== 'Pending') return res.status(400).json({ error: `Already ${item.status}.` });

  const rfqRequestId = req.body.rfq_request_id !== undefined && req.body.rfq_request_id !== '' ? req.body.rfq_request_id : item.matched_rfq_request_id;
  const vendorId = req.body.vendor_id !== undefined && req.body.vendor_id !== '' ? req.body.vendor_id : item.matched_vendor_id;
  if (!rfqRequestId) return res.status(400).json({ error: 'Pick which RFQ this reply belongs to.' });
  if (!vendorId) return res.status(400).json({ error: 'Pick which vendor this reply is from.' });

  const rfq = db.prepare('SELECT * FROM rfq_requests WHERE id = ?').get(rfqRequestId);
  if (!rfq) return res.status(400).json({ error: 'That RFQ no longer exists.' });
  const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendorId);
  if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists.' });

  const { notes, purchase_request_item_id, payment_terms, delivery_commit_date, quoted_qty } = req.body;
  let itemId = null;
  if (purchase_request_item_id) {
    const line = db.prepare('SELECT id FROM purchase_request_items WHERE id = ? AND purchase_request_id = ?').get(purchase_request_item_id, rfq.purchase_request_id);
    if (!line) return res.status(400).json({ error: "That line item does not belong to this RFQ's Purchase Request." });
    itemId = line.id;
  }
  const quotedAmount = req.body.quoted_amount !== undefined && req.body.quoted_amount !== '' ? req.body.quoted_amount : item.guessed_quoted_amount;

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO purchase_request_quotes (purchase_request_id, vendor_id, quoted_amount, notes,
        purchase_request_item_id, payment_terms, delivery_commit_date, quoted_qty, rfq_request_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(rfq.purchase_request_id, vendorId, quotedAmount ? Number(quotedAmount) : null, notes || item.body_text || null,
      itemId, payment_terms || null, delivery_commit_date || null, quoted_qty ? Number(quoted_qty) : null,
      rfqRequestId, req.user.id);
    db.prepare(`
      UPDATE incoming_rfq_responses SET status = 'Confirmed', confirmed_quote_id = ?, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(info.lastInsertRowid, req.user.id, item.id);
    return info;
  });
  const info = tx();
  res.json({ id: info.lastInsertRowid });
});

router.post('/rfq-inbox/:id/dismiss', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const item = db.prepare('SELECT * FROM incoming_rfq_responses WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.status !== 'Pending') return res.status(400).json({ error: `Already ${item.status}.` });
  db.prepare(`
    UPDATE incoming_rfq_responses SET status = 'Dismissed', dismissed_by = ?, dismissed_at = CURRENT_TIMESTAMP, dismiss_reason = ? WHERE id = ?
  `).run(req.user.id, req.body && req.body.reason || null, item.id);
  res.json({ ok: true });
});

// Manual on-demand poll (Admin only), same escape hatch as Service's
// equivalent - lets an Admin confirm the mailbox is wired up correctly
// without waiting for the next scheduled scan.
router.post('/rfq-inbox/scan', requirePermission('purchase_request.create', 'purchase_order.manage'), async (req, res) => {
  if (req.user.role_name !== 'Admin') return res.status(403).json({ error: 'Admin only.' });
  const result = await runInboundRfqScan();
  res.json(result);
});

// ---- Submit a Draft (or a high-value PR already past quote-collection) into the normal approval chain ----
// Draft -> here is where the quote-threshold check now happens (moved out
// of POST /requests, since a Draft's total can still change before it's
// submitted) - below threshold goes straight into the approval chain;
// at/above it stops at PendingQuotes so the requester can collect quotes,
// then calls this same route again once they have (the PendingQuotes
// branch below, unchanged from before Draft existed).
router.post('/requests/:id/submit-for-approval', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  const isOwner = pr.raised_by === req.user.id;
  const isPrivileged = req.user.role_name === 'Admin' || req.user.role_name === 'Management';
  if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Only the requester or Admin/Management can submit this.' });

  if (pr.status === 'Draft') {
    const totalValue = db.prepare('SELECT COALESCE(SUM(estimated_value), 0) as t FROM purchase_request_items WHERE purchase_request_id = ?').get(pr.id).t;
    const threshold = getPurchaseSettings().quote_threshold;
    if (totalValue >= threshold) {
      db.prepare(`UPDATE purchase_requests SET status = 'PendingQuotes', quotes_required = 1, estimated_value = ? WHERE id = ?`).run(totalValue, pr.id);
      return res.json({ ok: true, quotes_required: true });
    }
    const approvalId = approvals.startApproval('PurchaseRequest', 'purchase_request', pr.id, totalValue, req.user.id);
    db.prepare(`UPDATE purchase_requests SET status = 'Pending', quotes_required = 0, estimated_value = ?, approval_id = ? WHERE id = ?`).run(totalValue, approvalId, pr.id);
    return res.json({ ok: true, quotes_required: false });
  }

  if (pr.status === 'PendingQuotes') {
    const quoteCount = db.prepare('SELECT COUNT(*) as c FROM purchase_request_quotes WHERE purchase_request_id = ?').get(pr.id).c;
    if (quoteCount < 2) return res.status(400).json({ error: `At least 2 vendor quotes are required before submitting for approval - only ${quoteCount} on file.` });
    const totalValue = db.prepare('SELECT COALESCE(SUM(estimated_value), 0) as t FROM purchase_request_items WHERE purchase_request_id = ?').get(pr.id).t;
    const approvalId = approvals.startApproval('PurchaseRequest', 'purchase_request', pr.id, totalValue, req.user.id);
    db.prepare(`UPDATE purchase_requests SET approval_id = ?, status = 'Pending' WHERE id = ?`).run(approvalId, pr.id);
    return res.json({ ok: true, quotes_required: false });
  }

  return res.status(400).json({ error: 'This request has already been submitted for approval.' });
});

router.put('/requests/:id', requirePermission('purchase_request.create', 'job_card.manage', 'purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.raised_by === req.user.id;
  // "Approver" (2026-10-07) = Admin, Management, or the Purchase department's
  // own HOD - the same roles the PurchaseRequest chain itself routes to (see
  // isPurchaseApprover() below). Broader than the old Admin/Management-only
  // "isPrivileged" check this replaces, so a Purchase HOD can now also edit a
  // subordinate's PR before approval, not just after - and, same as Purchase
  // Orders, once the request has actually cleared approval (Approved/
  // OrderPlaced) the original requester's own edit access is withdrawn and
  // only an approver/Admin can still touch it.
  const isApprover = isPurchaseApprover(req.user);
  if (!isOwner && !isApprover) return res.status(403).json({ error: 'Only the requester or an approver (Purchase HOD/Management/Admin) can edit this.' });
  // A rejected request, or one a reviewer paused to ask for more info, stays
  // editable for its own requester (not just an approver) so they can
  // fix/complete it and send it back, instead of having to raise a brand new
  // PR from scratch. A Draft is always editable by its owner too - that's
  // the whole point of the Draft stage (see POST /requests above).
  if (!['Draft', 'Pending', 'Rejected', 'InfoRequested'].includes(existing.status) && !isApprover) {
    return res.status(400).json({ error: 'This request has already been approved - only an approver (Purchase HOD/Management/Admin) can still edit it.' });
  }
  const { project_id, items } = req.body;
  // Line items (this route's `items` array doubles as "add a line" - there's
  // no separate add-line endpoint for PRs the way POST /orders/:id/add-line
  // exists for POs, since a PR's items are a real child table this route
  // already replaces wholesale) stay frozen once the request has actually
  // cleared approval, for the creator AND an approver alike - matches Purchase
  // Orders' own add-line route, which likewise blocks adding a line past
  // Open/PartiallyReceived regardless of who's asking. Other fields
  // (project_id) stay approver-editable post-approval per the status gate above.
  if (items !== undefined && ['Approved', 'OrderPlaced'].includes(existing.status)) {
    return res.status(400).json({ error: 'Items can only be changed while this request is still Draft, pending approval, or rejected - once approved, raise a new Purchase Request for anything further.' });
  }
  let resolved;
  if (items !== undefined) {
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item line.' });
    try {
      resolved = items.map(line => {
        const qty = Number(line.quantity);
        if (!qty || qty <= 0) throw new Error('Every line needs a quantity greater than 0.');
        const { itemId, wasAdhoc } = resolvePRLineItem(line, req.user.id);
        return { itemId, wasAdhoc, quantity: qty, estimatedValue: Number(line.estimated_value) || 0, itemText: line.item_text || null, details: line.details || null };
      });
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  const tx = db.transaction(() => {
    if (resolved) {
      db.prepare('DELETE FROM purchase_request_items WHERE purchase_request_id = ?').run(existing.id);
      const insertLine = db.prepare(`
        INSERT INTO purchase_request_items (purchase_request_id, item_id, item_text, quantity, estimated_value, details, sort_order)
        VALUES (?,?,?,?,?,?,?)
      `);
      resolved.forEach((l, i) => {
        insertLine.run(existing.id, l.itemId, l.itemText, l.quantity, l.estimatedValue, l.details, i);
        if (l.wasAdhoc) db.prepare('UPDATE items SET created_from_pr_id = ? WHERE id = ?').run(existing.id, l.itemId);
      });
      const first = resolved[0];
      const totalValue = resolved.reduce((sum, l) => sum + l.estimatedValue, 0);
      db.prepare(`
        UPDATE purchase_requests SET item_id=?, item_text=?, project_id=?, quantity=?, estimated_value=? WHERE id=?
      `).run(first.itemId, first.itemText,
        project_id !== undefined ? (project_id || null) : existing.project_id,
        first.quantity, totalValue, existing.id);
    } else if (project_id !== undefined) {
      db.prepare(`UPDATE purchase_requests SET project_id=? WHERE id=?`).run(project_id || null, existing.id);
    }
  });
  tx();
  res.json({ ok: true });
});

// ---- Resubmit a rejected PR: starts a fresh approval cycle from step 1
// (the old, rejected approval stays on file as history - see GET
// /requests/:id/approval-history). Goes through the same value-threshold
// check as a brand new PR, so a resubmission that's since grown past the
// quote threshold correctly lands back in PendingQuotes instead of skipping
// straight to approval.
router.post('/requests/:id/resubmit', requirePermission('purchase_request.create', 'job_card.manage', 'purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.raised_by === req.user.id;
  const isPrivileged = req.user.role_name === 'Admin' || req.user.role_name === 'Management';
  if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Only the requester or Admin/Management can resubmit this.' });
  if (existing.status !== 'Rejected') return res.status(400).json({ error: 'Only a rejected request can be resubmitted.' });
  const totalValue = db.prepare('SELECT COALESCE(SUM(estimated_value), 0) as t FROM purchase_request_items WHERE purchase_request_id = ?').get(existing.id).t;
  const threshold = getPurchaseSettings().quote_threshold;
  const quotesRequired = totalValue >= threshold;
  if (quotesRequired) {
    db.prepare(`UPDATE purchase_requests SET status = 'PendingQuotes', quotes_required = 1, approval_id = NULL WHERE id = ?`).run(existing.id);
    return res.json({ ok: true, quotes_required: true });
  }
  const approvalId = approvals.startApproval('PurchaseRequest', 'purchase_request', existing.id, totalValue, req.user.id);
  db.prepare(`UPDATE purchase_requests SET status = 'Pending', quotes_required = 0, approval_id = ? WHERE id = ?`).run(approvalId, existing.id);
  res.json({ ok: true, quotes_required: false });
});

// Lets the requester (or Admin/Management) withdraw a PR that's no longer
// needed - the main scenario is after one or more rejections, where trying
// again isn't worth it and the request just needs closing out. Only
// available before a PO exists against it (Pending/PendingQuotes/
// InfoRequested/Rejected); once Approved/OrderPlaced, unwinding goes through
// Cancel PO instead, which already reverses a PR at OrderPlaced back to
// Approved if its only PO is cancelled. `Cancelled` is a genuinely new PR
// status (not a reuse of `Rejected`) so it can't be mistaken for a reviewer's
// own verdict in reporting. Also closes out the PR's live approval row (if
// any) so it stops showing in reviewers' pending-approval queues -
// lib/approvals.js's pendingForUser() only ever surfaces status='Pending'.
router.post('/requests/:id/cancel', requirePermission('purchase_request.create', 'job_card.manage', 'purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.raised_by === req.user.id;
  const isPrivileged = req.user.role_name === 'Admin' || req.user.role_name === 'Management';
  if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Only the requester or Admin/Management can withdraw this.' });
  if (!['Draft', 'Pending', 'PendingQuotes', 'InfoRequested', 'Rejected'].includes(existing.status)) {
    return res.status(400).json({ error: 'This request has already moved past review and can no longer be withdrawn - if a purchase order was raised against it, cancel the PO instead.' });
  }
  const reason = (req.body && req.body.reason) || null;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE purchase_requests SET status = 'Cancelled' WHERE id = ?`).run(existing.id);
    if (existing.approval_id) {
      db.prepare(`UPDATE approvals SET status = 'Cancelled' WHERE id = ? AND status IN ('Pending', 'InfoRequested')`).run(existing.approval_id);
    }
  });
  tx();
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)`)
    .run(req.user.id, 'pr_cancel', 'purchase_request', existing.id, reason);
  res.json({ ok: true });
});

// Full approval trail for a PR across every submission/resubmission -
// each resubmit starts a brand-new `approvals` row, so a single PR's history
// spans more than one approval id once it's been rejected and tried again.
router.get('/requests/:id/approval-history', (req, res) => {
  res.json(db.prepare(`
    SELECT aa.*, ap.id as approval_id, u.full_name as actor_name
    FROM approval_actions aa
    JOIN approvals ap ON ap.id = aa.approval_id
    LEFT JOIN users u ON u.id = aa.actor_user_id
    WHERE ap.entity_type = 'purchase_request' AND ap.entity_id = ?
    ORDER BY aa.acted_at
  `).all(req.params.id));
});

// Shared creator-vs-approver authorization (2026-10-07) - used by both the
// PR and PO edit/add-line routes below. "Approver" means anyone who could
// act on this entity's approval chain - Admin, Management, or the Purchase
// department's own HOD (role Purchase + requires_supervisor) - the same
// three roles both the PurchaseRequest and PurchaseOrder chains route to
// (see db/seed.js / db/index.js's bootstrapPurchaseOrderApproval()). Kept
// separate from "the creator" (raised_by/created_by) so that once a PR/PO
// is approved and live, only an approver can still touch it - the original
// requester's edit access is withdrawn at that point even though they still
// hold the general purchase_request.create/purchase_order.manage permission.
function isPurchaseApprover(user) {
  return user.role_name === 'Admin' || user.role_name === 'Management' ||
    (user.role_name === 'Purchase' && !!user.is_supervisor);
}
// Same shape, Store department's own HOD/Supervisor instead of Purchase's -
// the role the GrnReconciliation chain itself routes to (see
// bootstrapGrnReconciliationApproval() in db/index.js) - used to gate who
// besides the original receiver can edit+resubmit a Rejected GRN below.
function isStoreApprover(user) {
  return user.role_name === 'Admin' || user.role_name === 'Management' ||
    (user.role_name === 'Store' && !!user.is_supervisor);
}
// Shared per-line taxable/GST computation - same formula used by POST
// /orders' insert loop, PUT /orders/:id's single-line edit, and POST
// /orders/:id/add-line below; pulled out once so all three can't drift.
function poLineCalc(quantity, rate, discountPercent, gstRate) {
  const total = quantity * rate * (1 - discountPercent / 100);
  const gstAmount = total * (gstRate || 0) / 100;
  return { total, gstAmount };
}

// ---- Purchase Orders ----
router.get('/orders', (req, res) => {
  res.json(db.prepare(`
    SELECT po.*, v.name as vendor_name, i.name as item_name,
      ca.label as company_address_label, ca.address_type as company_address_type,
      sa.label as company_ship_address_label, sa.address_type as company_ship_address_type,
      COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm WHERE sm.movement_type = 'IN' AND sm.reference = 'PO#' || po.id), 0) as received_qty
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id LEFT JOIN items i ON i.id = po.item_id
    LEFT JOIN company_addresses ca ON ca.id = po.company_address_id
    LEFT JOIN company_addresses sa ON sa.id = po.company_ship_address_id
    ORDER BY po.id DESC
  `).all());
});
// Sidebar "pending count" badge (2026-10-14) - the signed-in user's own
// Purchase Orders still needing action: Draft, PendingApproval, or
// Rejected - mirrors canEditPO()'s own "still active" status set.
router.get('/orders/my-pending-count', (req, res) => {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM purchase_orders
    WHERE created_by = ? AND status NOT IN ('Open', 'PartiallyReceived', 'Received', 'Closed', 'Cancelled')
  `).get(req.user.id);
  res.json({ count: row.count });
});
// A "Purchase Order" is still stored as one purchase_orders row per line
// item (no separate po_items table - see the payment_terms migration note
// in db/index.js), several rows sharing one po_no for a multi-item PO. The
// route below accepts either the current multi-line shape (`lines: [...]`,
// what the New Purchase Order form's Add Line Item button sends) or the
// older single-item shape (item_id/quantity/rate/... at the top level, no
// `lines`) for any other caller - both funnel into the same insert loop.
router.post('/orders', requirePermission('purchase_order.manage'), (req, res) => {
  const {
    purchase_request_id, vendor_id, terms, delivery_date, company_address_id, company_ship_address_id, payment_terms,
    ld_percentage, ld_cap_percentage, ld_trigger_notes, freight_notes, general_notes,
  } = req.body;
  // Freight is one charge for the whole shipment, not per line - same
  // header-level treatment as payment_terms/LD terms below (duplicated onto
  // every line sharing this po_no, added once into the grand total, never
  // multiplied per line). Its GST rate defaults to the company's own default
  // rather than a hardcoded 18, matching how Proforma/Sales Invoice creation
  // already picks a default GST rate elsewhere in this codebase.
  const freight = Number(req.body.freight) || 0;
  const freightGstRate = req.body.freight_gst_rate !== undefined && req.body.freight_gst_rate !== ''
    ? Number(req.body.freight_gst_rate) : (getCompanySettings().default_gst_rate || 18);
  const lines = Array.isArray(req.body.lines) && req.body.lines.length
    ? req.body.lines
    : [{
        item_id: req.body.item_id, quantity: req.body.quantity, rate: req.body.rate,
        hsn_code: req.body.hsn_code, gst_rate: req.body.gst_rate, unit: req.body.unit, discount_percent: req.body.discount_percent,
        purchase_request_item_id: req.body.purchase_request_item_id, details: req.body.details,
      }];
  // Validate references before hitting the DB - an empty/missing vendor or
  // item (e.g. no vendors created yet, or a stale item id) otherwise surfaces
  // as a raw "FOREIGN KEY constraint failed" 500, which reads as "Request
  // failed" in the UI with no clue what actually went wrong.
  if (!vendor_id) return res.status(400).json({ error: 'Pick a vendor. If none exist yet, add one under Vendor Master first.' });
  const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendor_id);
  if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists - refresh the page and pick a vendor again.' });
  if (company_address_id) {
    const addr = db.prepare('SELECT id FROM company_addresses WHERE id = ?').get(company_address_id);
    if (!addr) return res.status(400).json({ error: 'That Bill-To address no longer exists - refresh the page and pick one again.' });
  }
  if (company_ship_address_id) {
    const addr = db.prepare('SELECT id FROM company_addresses WHERE id = ?').get(company_ship_address_id);
    if (!addr) return res.status(400).json({ error: 'That Ship-To address no longer exists - refresh the page and pick one again.' });
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prefix = lines.length > 1 ? `Line ${i + 1}: ` : '';
    if (l.item_id) {
      const item = db.prepare('SELECT id FROM items WHERE id = ?').get(l.item_id);
      if (!item) return res.status(400).json({ error: `${prefix}that item no longer exists - refresh the page and pick an item again.` });
    }
    if (!l.quantity || Number(l.quantity) <= 0) return res.status(400).json({ error: `${prefix}enter a quantity greater than 0.` });
    if (!l.rate || Number(l.rate) <= 0) return res.status(400).json({ error: `${prefix}enter a rate greater than 0.` });
  }
  const poNo = 'PO-' + Date.now();
  // Deliberately NOT pre-filled from the Purchase Settings default here
  // (reverted 2026-10-09, same day it was added) - lib/poPdf.js/lib/poDocx.js
  // already fall back to the live default_po_terms whenever a PO's own
  // `terms` is blank, which (a) always reflects the Admin's *current*
  // default rather than freezing whatever it was at creation time, and (b)
  // is the only way default_po_terms's rich-text formatting (bold/italic/
  // underline/lists, see lib/richText.js) actually renders - copying the
  // raw markup into `terms` at creation time silently defeated it, since
  // `terms` itself is a plain per-PO field with no formatting support.
  const effectiveTerms = terms || null;
  // Draft-first submission (2026-10-07) - a PO is created here purely as a
  // Draft, fully editable (PUT /orders/:id below leaves it as Draft rather
  // than resubmitting for approval), with no approval chain started and the
  // source PR (if any) not yet flipped to OrderPlaced - both of those now
  // happen in POST /orders/:id/submit-for-approval instead, once the buyer
  // has actually reviewed/confirmed the order.
  const insert = db.prepare(`
    INSERT INTO purchase_orders (po_no, purchase_request_id, purchase_request_item_id, vendor_id, item_id, quantity, rate, total_value, created_by,
      hsn_code, gst_rate, gst_amount, unit, discount_percent, details, terms, delivery_date, company_address_id, company_ship_address_id, payment_terms,
      ld_percentage, ld_cap_percentage, ld_trigger_notes, freight, freight_gst_rate, freight_notes, general_notes, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Draft')
  `);
  const ids = [];
  let totalOrderValue = 0;
  db.transaction(() => {
    for (const l of lines) {
      const quantity = Number(l.quantity), rate = Number(l.rate);
      // Discount reduces the taxable value before GST is computed on it -
      // clamped to [0,100] since this is free-typed (unlike GST rate, which
      // is vendor-supplied/trusted) and a stray negative or >100 value would
      // otherwise inflate the total or go negative.
      const discountPercent = Math.min(100, Math.max(0, Number(l.discount_percent) || 0));
      const gstRate = l.gst_rate !== undefined && l.gst_rate !== '' ? Number(l.gst_rate) : 18;
      const { total, gstAmount } = poLineCalc(quantity, rate, discountPercent, gstRate);
      totalOrderValue += total;
      const unit = String(l.unit || '').trim() || 'Nos';
      const info = insert.run(poNo, purchase_request_id || null, l.purchase_request_item_id || null, vendor_id, l.item_id || null,
        quantity, rate, total, req.user.id, l.hsn_code || null, gstRate, gstAmount, unit, discountPercent, l.details || null, effectiveTerms, delivery_date || null,
        company_address_id || null, company_ship_address_id || null, payment_terms || null, ld_percentage || null, ld_cap_percentage || null,
        ld_trigger_notes || null, freight, freightGstRate, freight_notes || null, general_notes || null);
      ids.push(info.lastInsertRowid);
    }
  })();
  res.json({ id: ids[0], ids, po_no: poNo, status: 'Draft' });
});

// Starts the approval chain for a Draft PO - acts on the whole po_no group
// (a multi-line PO is several rows sharing one po_no), same grand-total
// computation PUT /orders/:id's own resubmit-on-edit path already uses.
// Only a Draft can be submitted this way; once PendingApproval, an edit
// resubmits it automatically instead (see PUT /orders/:id below).
router.post('/orders/:id/submit-for-approval', requirePermission('purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'Draft') return res.status(400).json({ error: 'This order has already been submitted for approval.' });
  const totals = db.prepare('SELECT COALESCE(SUM(total_value), 0) as t, MAX(freight) as freight, MAX(freight_gst_rate) as freight_gst_rate FROM purchase_orders WHERE po_no = ?').get(existing.po_no);
  const groupTotal = totals.t + (totals.freight || 0) * (1 + (totals.freight_gst_rate || 0) / 100);
  const approvalId = approvals.startApproval('PurchaseOrder', 'purchase_order', existing.id, groupTotal, req.user.id);
  db.prepare(`UPDATE purchase_orders SET status = 'PendingApproval', approval_id = ? WHERE po_no = ?`).run(approvalId, existing.po_no);
  if (existing.purchase_request_id) db.prepare(`UPDATE purchase_requests SET status = 'OrderPlaced' WHERE id = ?`).run(existing.purchase_request_id);
  poAuditLog(req.user.id, 'po_submit_for_approval', existing.id, null);
  res.json({ ok: true });
});

// Commercial terms (Round 16): LD clause (delivery_date already exists on
// purchase_orders from Round 5 and doubles as the promised delivery date).
// These are all header-level fields shared by every line of a multi-item PO
// (see POST /orders' `lines` support) - applied to every row sharing this
// PO's po_no, not just the one line the Terms panel happened to be opened
// from, so they can't drift out of sync across a multi-line PO's rows.
router.patch('/orders/:id/commercial-terms', requirePermission('purchase_order.manage'), (req, res) => {
  const order = db.prepare('SELECT id, po_no FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { delivery_date, ld_percentage, ld_cap_percentage, ld_trigger_notes, payment_terms, freight, freight_gst_rate, freight_notes, general_notes } = req.body;
  db.prepare(`
    UPDATE purchase_orders SET delivery_date = COALESCE(?, delivery_date), ld_percentage = ?, ld_cap_percentage = ?, ld_trigger_notes = ?,
      payment_terms = COALESCE(?, payment_terms), freight = ?, freight_gst_rate = ?, freight_notes = ?, general_notes = ?
    WHERE po_no = ?
  `).run(delivery_date || null, ld_percentage || null, ld_cap_percentage || null, ld_trigger_notes || null, payment_terms || null,
    Number(freight) || 0, freight_gst_rate !== undefined && freight_gst_rate !== '' ? Number(freight_gst_rate) : (getCompanySettings().default_gst_rate || 18),
    freight_notes || null, general_notes || null,
    order.po_no);
  res.json({ ok: true });
});

const PO_EDIT_FIELDS = ['vendor_id', 'item_id', 'quantity', 'rate', 'hsn_code', 'gst_rate', 'unit', 'discount_percent', 'details', 'terms', 'delivery_date', 'company_address_id', 'company_ship_address_id'];
const PO_EDIT_LABELS = { vendor_id: 'Vendor', item_id: 'Item', quantity: 'Qty', rate: 'Rate', hsn_code: 'HSN', gst_rate: 'GST %', unit: 'Unit', discount_percent: 'Discount %', details: 'Additional Details', terms: 'Terms', delivery_date: 'Delivery date', company_address_id: 'Bill-To address', company_ship_address_id: 'Ship-To address' };
function poAuditLog(userId, action, poId, details) {
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)`)
    .run(userId, action, 'purchase_order', poId, details || null);
}
// Supersedes a po_no group's still-live approval (if any) and starts a fresh
// one against its current grand total - shared by PUT /orders/:id's
// edit-always-resubmits logic and POST /orders/:id/add-line below, so both
// "editing a field" and "adding a line" count as the same kind of change
// that voids a prior sign-off and sends the whole group back through
// approval from scratch.
function resubmitPoGroup(poNo, entityId, liveApprovalId, actingUserId) {
  if (liveApprovalId) {
    db.prepare(`UPDATE approvals SET status = 'Superseded' WHERE id = ? AND status IN ('Pending', 'InfoRequested')`).run(liveApprovalId);
  }
  const totals = db.prepare('SELECT COALESCE(SUM(total_value), 0) as t, MAX(freight) as freight, MAX(freight_gst_rate) as freight_gst_rate FROM purchase_orders WHERE po_no = ?').get(poNo);
  const groupTotal = totals.t + (totals.freight || 0) * (1 + (totals.freight_gst_rate || 0) / 100);
  const newApprovalId = approvals.startApproval('PurchaseOrder', 'purchase_order', entityId, groupTotal, actingUserId);
  // Only re-queue the line actually being edited, plus any sibling still
  // awaiting its OWN original approval (Draft/PendingApproval/Rejected) - a
  // sibling that's already live with real stock against it
  // (Open/PartiallyReceived/Received) must never be knocked out of the
  // Receive picker just because an unrelated line on the same PO was
  // edited, and a sibling that's already Closed/Cancelled must stay that
  // way, not get swept back into a fresh approval cycle (2026-10-16).
  db.prepare(`
    UPDATE purchase_orders SET status = 'PendingApproval', approval_id = ?
    WHERE po_no = ? AND (id = ? OR status IN ('Draft', 'PendingApproval', 'Rejected'))
  `).run(newApprovalId, poNo, entityId);
}
router.put('/orders/:id', requirePermission('purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // Creator-vs-approver gating (2026-10-07): before approval, the creator
  // (or an approver, or Admin) can edit freely, same as always. Once the
  // group has cleared approval and gone live (Open/PartiallyReceived), the
  // creator's own edit access is withdrawn - only an approver/Admin can
  // still touch it, even though the creator still holds the general
  // purchase_order.manage permission. Received/Cancelled stay locked for
  // everyone, unchanged.
  const isOwner = existing.created_by === req.user.id;
  const isApprover = isPurchaseApprover(req.user);
  if (!isOwner && !isApprover) {
    return res.status(403).json({ error: 'Only the creator or an approver (Purchase HOD/Management/Admin) can edit this order.' });
  }
  if (['Received', 'Cancelled'].includes(existing.status)) {
    return res.status(400).json({ error: `This order is already ${existing.status} and can no longer be edited.` });
  }
  if (['Open', 'PartiallyReceived'].includes(existing.status) && !isApprover) {
    return res.status(403).json({ error: 'This order has already been approved and is live - only an approver (Purchase HOD/Management/Admin) can still edit it.' });
  }
  if (req.body.vendor_id) {
    const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(req.body.vendor_id);
    if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists - refresh the page and pick a vendor again.' });
  }
  if (req.body.item_id) {
    const item = db.prepare('SELECT id FROM items WHERE id = ?').get(req.body.item_id);
    if (!item) return res.status(400).json({ error: 'That item no longer exists - refresh the page and pick an item again.' });
  }
  if (req.body.company_address_id) {
    const addr = db.prepare('SELECT id FROM company_addresses WHERE id = ?').get(req.body.company_address_id);
    if (!addr) return res.status(400).json({ error: 'That Bill-To address no longer exists - refresh the page and pick one again.' });
  }
  if (req.body.company_ship_address_id) {
    const addr = db.prepare('SELECT id FROM company_addresses WHERE id = ?').get(req.body.company_ship_address_id);
    if (!addr) return res.status(400).json({ error: 'That Ship-To address no longer exists - refresh the page and pick one again.' });
  }
  const quantity = req.body.quantity !== undefined ? Number(req.body.quantity) : existing.quantity;
  const rate = req.body.rate !== undefined ? Number(req.body.rate) : existing.rate;
  if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (!rate || rate <= 0) return res.status(400).json({ error: 'Enter a rate greater than 0.' });
  const gstRate = req.body.gst_rate !== undefined && req.body.gst_rate !== '' ? Number(req.body.gst_rate) : existing.gst_rate;
  const discountPercent = req.body.discount_percent !== undefined && req.body.discount_percent !== ''
    ? Math.min(100, Math.max(0, Number(req.body.discount_percent))) : (existing.discount_percent || 0);
  const unit = req.body.unit !== undefined ? (String(req.body.unit).trim() || 'Nos') : existing.unit;
  const total = quantity * rate * (1 - discountPercent / 100);
  const gstAmount = total * (gstRate || 0) / 100;

  const changes = [];
  PO_EDIT_FIELDS.forEach(f => {
    if (req.body[f] === undefined) return;
    const newVal = req.body[f] || null;
    const oldVal = existing[f];
    if (String(oldVal || '') !== String(newVal || '')) changes.push(`${PO_EDIT_LABELS[f]}: ${oldVal || '-'} -> ${newVal || '-'}`);
  });

  db.prepare(`
    UPDATE purchase_orders SET vendor_id=?, item_id=?, quantity=?, rate=?, total_value=?, hsn_code=?, gst_rate=?, gst_amount=?, unit=?, discount_percent=?, details=?, terms=?, delivery_date=?, company_address_id=?, company_ship_address_id=?
    WHERE id=?
  `).run(
    req.body.vendor_id !== undefined ? req.body.vendor_id : existing.vendor_id,
    req.body.item_id !== undefined ? (req.body.item_id || null) : existing.item_id,
    quantity, rate, total,
    req.body.hsn_code !== undefined ? (req.body.hsn_code || null) : existing.hsn_code,
    gstRate, gstAmount, unit, discountPercent,
    req.body.details !== undefined ? (req.body.details || null) : existing.details,
    req.body.terms !== undefined ? (req.body.terms || null) : existing.terms,
    req.body.delivery_date !== undefined ? (req.body.delivery_date || null) : existing.delivery_date,
    req.body.company_address_id !== undefined ? (req.body.company_address_id || null) : existing.company_address_id,
    req.body.company_ship_address_id !== undefined ? (req.body.company_ship_address_id || null) : existing.company_ship_address_id,
    existing.id
  );
  // Vendor and Bill-To/Ship-To address are header-level fields shared by
  // every line of a multi-item PO (see POST /orders' `lines` support) -
  // propagate a change to them onto every sibling row sharing this PO's
  // po_no so they can't drift out of sync (item/qty/rate/hsn/gst/terms/
  // delivery_date stay genuinely per-line, so they're deliberately NOT
  // propagated here).
  if (req.body.vendor_id !== undefined || req.body.company_address_id !== undefined || req.body.company_ship_address_id !== undefined) {
    db.prepare(`UPDATE purchase_orders SET vendor_id=?, company_address_id=?, company_ship_address_id=? WHERE po_no = ? AND id != ?`).run(
      req.body.vendor_id !== undefined ? req.body.vendor_id : existing.vendor_id,
      req.body.company_address_id !== undefined ? (req.body.company_address_id || null) : existing.company_address_id,
      req.body.company_ship_address_id !== undefined ? (req.body.company_ship_address_id || null) : existing.company_ship_address_id,
      existing.po_no, existing.id
    );
  }
  // Any edit sends the whole PO back through approval from scratch - a
  // prior sign-off no longer reflects what's actually in the order. Applies
  // uniformly regardless of what state the approval was in (still pending,
  // already cleared, or previously rejected) - same reject-edit-resubmit
  // spirit Purchase Requests already use (POST /requests/:id/resubmit),
  // just unconditional here rather than only from Rejected. The superseded
  // approval row is marked out of lib/approvals.js's pendingForUser() (which
  // only ever surfaces status='Pending') so it can't double up with the new
  // cycle in anyone's approval queue.
  // A still-Draft PO is the one exception - it was never submitted in the
  // first place, so an edit here just saves the change and leaves it Draft;
  // POST /orders/:id/submit-for-approval is what actually starts the chain.
  if (changes.length) {
    if (existing.status === 'Draft') {
      poAuditLog(req.user.id, 'po_edit_draft', existing.id, 'Edited while still Draft: ' + changes.join('; '));
    } else {
      resubmitPoGroup(existing.po_no, existing.id, existing.approval_id, req.user.id);
      poAuditLog(req.user.id, 'po_edit_resubmit', existing.id, 'Edited - resubmitted for approval. Changes: ' + changes.join('; '));
    }
  }
  res.json({ ok: true });
});

// Inserts a new line into an existing po_no group, cloning the shared
// header fields (vendor, addresses, freight, payment/LD terms) from the
// sibling row named by :id - the only way to add an item to a PO after
// creation, since POST /orders only ever builds a new po_no from scratch.
// Deliberately narrower than PUT /orders/:id's own edit gate: a line can
// only be added while the group hasn't yet gone live (Draft/PendingApproval/
// Rejected) - once Open/PartiallyReceived, not even an approver can add a
// line here, since by then it isn't "finishing the order before it ships",
// it's changing a live commitment, which this app treats as needing a new,
// separate PO rather than reopening this one indefinitely.
router.post('/orders/:id/add-line', requirePermission('purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.created_by === req.user.id;
  const isApprover = isPurchaseApprover(req.user);
  if (!isOwner && !isApprover) {
    return res.status(403).json({ error: 'Only the creator or an approver (Purchase HOD/Management/Admin) can add items to this order.' });
  }
  if (!['Draft', 'PendingApproval', 'Rejected'].includes(existing.status)) {
    return res.status(400).json({ error: 'Items can only be added while this order is still Draft, pending approval, or rejected - once approved, raise a new Purchase Order for anything further.' });
  }
  const { item_id, quantity, rate, hsn_code, gst_rate, unit, discount_percent, details } = req.body;
  if (item_id) {
    const item = db.prepare('SELECT id FROM items WHERE id = ?').get(item_id);
    if (!item) return res.status(400).json({ error: 'That item no longer exists - refresh the page and pick an item again.' });
  }
  const qty = Number(quantity);
  const rt = Number(rate);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (!rt || rt <= 0) return res.status(400).json({ error: 'Enter a rate greater than 0.' });
  const discountPercent = Math.min(100, Math.max(0, Number(discount_percent) || 0));
  const gstRate = gst_rate !== undefined && gst_rate !== '' ? Number(gst_rate) : 18;
  const { total, gstAmount } = poLineCalc(qty, rt, discountPercent, gstRate);
  const newUnit = String(unit || '').trim() || 'Nos';

  const info = db.prepare(`
    INSERT INTO purchase_orders (po_no, purchase_request_id, vendor_id, item_id, quantity, rate, total_value, created_by,
      hsn_code, gst_rate, gst_amount, unit, discount_percent, details, terms, delivery_date, company_address_id, company_ship_address_id, payment_terms,
      ld_percentage, ld_cap_percentage, ld_trigger_notes, freight, freight_gst_rate, freight_notes, general_notes, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(existing.po_no, existing.purchase_request_id, existing.vendor_id, item_id || null, qty, rt, total, req.user.id,
    hsn_code || null, gstRate, gstAmount, newUnit, discountPercent, details || null, existing.terms, existing.delivery_date,
    existing.company_address_id, existing.company_ship_address_id, existing.payment_terms,
    existing.ld_percentage, existing.ld_cap_percentage, existing.ld_trigger_notes, existing.freight, existing.freight_gst_rate,
    existing.freight_notes, existing.general_notes,
    existing.status);

  if (existing.status === 'Draft') {
    poAuditLog(req.user.id, 'po_add_line_draft', existing.id, `Added a line while still Draft: item_id=${item_id || '-'} qty=${qty} rate=${rt}`);
  } else {
    resubmitPoGroup(existing.po_no, existing.id, existing.approval_id, req.user.id);
    poAuditLog(req.user.id, 'po_add_line_resubmit', existing.id, `Added a line - resubmitted for approval. item_id=${item_id || '-'} qty=${qty} rate=${rt}`);
  }
  res.json({ id: info.lastInsertRowid, ok: true });
});

router.post('/orders/:id/cancel', requirePermission('purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status === 'Cancelled') return res.status(400).json({ error: 'This order is already cancelled.' });
  if (existing.status === 'Received') return res.status(400).json({ error: 'This order has already been received and can no longer be cancelled.' });
  // Closed (short-shipped, 2026-10-16) is its own terminal state, distinct
  // from a plain Cancel - without this check, Cancel would silently
  // overwrite a short-ship closure's status (and its reason for being
  // closed) with a generic Cancel, losing that distinction.
  if (existing.status === 'Closed') return res.status(400).json({ error: 'This line is already closed and can no longer be cancelled.' });
  const reason = (req.body && req.body.reason) || null;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE purchase_orders SET status = 'Cancelled' WHERE id = ?`).run(existing.id);
    // A PR that was sitting at OrderPlaced only because of this PO goes back
    // to Approved, so it's raisable against a new PO instead of stuck
    // pointing at a cancelled one - but only when no other live PO still
    // covers it.
    if (existing.purchase_request_id) {
      const otherLivePOs = db.prepare(`
        SELECT COUNT(*) as n FROM purchase_orders WHERE purchase_request_id = ? AND id != ? AND status != 'Cancelled'
      `).get(existing.purchase_request_id, existing.id).n;
      if (otherLivePOs === 0) {
        db.prepare(`UPDATE purchase_requests SET status = 'Approved' WHERE id = ? AND status = 'OrderPlaced'`).run(existing.purchase_request_id);
      }
    }
    if (existing.approval_id) {
      db.prepare(`UPDATE approvals SET status = 'Cancelled' WHERE id = ? AND status IN ('Pending', 'InfoRequested')`).run(existing.approval_id);
    }
  });
  tx();
  poAuditLog(req.user.id, 'po_cancel', existing.id, reason);
  res.json({ ok: true });
});

// Close a line out as short-shipped (2026-10-16) - distinct from Cancel:
// a vendor that's stopped shipping against a line (whether nothing at all
// came in, or only part of it did across one or several of their own
// invoices) can be closed out explicitly rather than left open forever or
// marked Cancelled (which reads as "this never happened" even once real
// stock has already come in against it). Reuses the 'Closed' status -
// already a recognized terminal PO status throughout this codebase (the
// Archive bucket, the receive/email/bill blocks, the bulk-import template's
// valid list) via the legacy bulk importer, just never reachable from an
// interactive action on a live order before this. Every already-received
// stock_movements/grn_reconciliations row is left completely untouched -
// only the line's own status changes.
router.post('/orders/:id/close-short-ship', requirePermission('purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!['Open', 'PartiallyReceived'].includes(existing.status)) {
    return res.status(400).json({ error: `This line is ${existing.status} and cannot be closed as short-shipped.` });
  }
  const reason = req.body && req.body.reason && String(req.body.reason).trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to close a line as short-shipped.' });
  db.prepare(`UPDATE purchase_orders SET status = 'Closed' WHERE id = ?`).run(existing.id);
  const receivedSoFar = poReceivedQty(existing.id);
  poAuditLog(req.user.id, 'po_close_short_shipped', existing.id, `${reason} (received ${receivedSoFar} of ${existing.quantity})`);
  res.json({ ok: true });
});

router.get('/orders/:id/audit-log', (req, res) => {
  res.json(db.prepare(`
    SELECT al.*, u.full_name as actor_name FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.entity_type = 'purchase_order' AND al.entity_id = ?
    ORDER BY al.created_at
  `).all(req.params.id));
});

// ---- Bulk import existing/legacy Open POs (Excel) ----
// No real legacy-ERP export format was specified, so this mirrors the
// established stock-movements bulk-upload pattern: a downloadable template,
// per-row validation that skips-and-reports rather than fails the whole
// file, and vendor/item resolution by name/code so the import doesn't
// require knowing this system's internal ids. Every imported row lands as
// a real purchase_orders row (status defaults to Open, i.e. "not yet
// received") so it behaves identically to a PO raised natively - GRN
// receive, edit, cancel, PDF/Word/email all just work on it afterwards.
const PO_IMPORT_STATUSES = ['Open', 'PartiallyReceived', 'Received', 'Closed', 'Cancelled'];
const PO_IMPORT_COLUMNS = ['po_no', 'vendor_name', 'item_code_or_barcode', 'quantity', 'unit', 'rate', 'discount_percent', 'hsn_code', 'gst_rate', 'freight', 'freight_gst_rate', 'delivery_date', 'terms', 'status', 'po_date', 'bill_address', 'ship_address'];
router.get('/orders/import-template', requirePermission('purchase_order.manage'), (req, res) => {
  const exampleRow = {
    po_no: 'PO-LEGACY-1024', vendor_name: 'Acme Steel Traders', item_code_or_barcode: 'ITM-1001', quantity: 50, unit: 'KGS', rate: 250,
    discount_percent: 0, hsn_code: '7208', gst_rate: 18, freight: 0, freight_gst_rate: 18, delivery_date: '2025-06-30',
    terms: 'Standard terms apply', status: 'Open', po_date: '2025-04-01',
    bill_address: 'Head Office', ship_address: 'Factory - Faridabad',
  };
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: PO_IMPORT_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'OpenPOs');
  const note = XLSX.utils.aoa_to_sheet([['Notes'],
    ['po_no is optional - leave blank to auto-generate one; if supplied it must not already exist in this system.'],
    ['vendor_name is matched against Vendor Master by name (case-insensitive) - an unmatched name creates a new vendor automatically.'],
    ['item_code_or_barcode can be either the item\'s Item Code or its printed barcode number.'],
    ['status is optional (defaults to Open) - one of: ' + PO_IMPORT_STATUSES.join(', ') + '.'],
    ['po_date is optional (defaults to today) - the order\'s original date, so imported history sorts correctly.'],
    ['bill_address and ship_address are both optional and independent - each matched by its Label in Company Settings > Bill-To/Ship-To Addresses (case-insensitive); leave either blank to import without it.'],
    ['unit is optional (defaults to Nos) - any text is accepted (e.g. KGS, Nos, Meters, or a custom unit).'],
    ['discount_percent is optional (defaults to 0) - a per-line percentage, applied to this row\'s taxable value before GST.'],
    ['freight and freight_gst_rate are optional (both default to 0/18) - note each row here becomes its own independent Purchase Order (po_no must be unique across this file and the system), so freight applies to that one row\'s order only.'],
  ]);
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="open_po_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
router.post('/orders/bulk-upload', requirePermission('purchase_order.manage'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' }); }
  const findItem = db.prepare('SELECT * FROM items WHERE item_code = ? OR barcode = ?');
  const findVendorByName = db.prepare('SELECT * FROM vendors WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))');
  const findPoByNo = db.prepare('SELECT id FROM purchase_orders WHERE po_no = ?');
  const findAddressByLabel = db.prepare('SELECT id FROM company_addresses WHERE LOWER(TRIM(label)) = LOWER(TRIM(?))');
  const insertVendor = db.prepare(`INSERT INTO vendors (name, legal_name, status) VALUES (?, ?, 'Active')`);
  const insertPO = db.prepare(`
    INSERT INTO purchase_orders (po_no, vendor_id, item_id, quantity, rate, total_value, status, created_by,
      hsn_code, gst_rate, gst_amount, unit, discount_percent, freight, freight_gst_rate, terms, delivery_date, created_at, company_address_id, company_ship_address_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let inserted = 0; const errors = []; const warnings = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const vendorName = String(row.vendor_name || '').trim();
    if (!vendorName) { errors.push(`Row ${rowNum}: vendor_name is required - skipped.`); return; }
    const itemKey = String(row.item_code_or_barcode || '').trim();
    if (!itemKey) { errors.push(`Row ${rowNum}: item_code_or_barcode is required - skipped.`); return; }
    const item = findItem.get(itemKey, itemKey);
    if (!item) { errors.push(`Row ${rowNum}: no item matches "${itemKey}" - skipped.`); return; }
    const qty = Number(row.quantity) || 0;
    if (qty <= 0) { errors.push(`Row ${rowNum}: quantity must be greater than 0 - skipped.`); return; }
    const rate = Number(row.rate) || 0;
    if (rate <= 0) { errors.push(`Row ${rowNum}: rate must be greater than 0 - skipped.`); return; }
    let poNo = String(row.po_no || '').trim() || ('PO-' + Date.now() + '-' + rowNum);
    if (findPoByNo.get(poNo)) { errors.push(`Row ${rowNum}: PO number "${poNo}" already exists - skipped.`); return; }
    let status = String(row.status || '').trim();
    status = PO_IMPORT_STATUSES.includes(status) ? status : 'Open';
    let vendor = findVendorByName.get(vendorName);
    if (!vendor) {
      const info = insertVendor.run(vendorName, vendorName);
      vendor = { id: info.lastInsertRowid };
    }
    const billAddressLabel = String(row.bill_address || '').trim();
    let billAddressId = null;
    if (billAddressLabel) {
      const addr = findAddressByLabel.get(billAddressLabel);
      if (!addr) { warnings.push(`Row ${rowNum}: no Bill-To/Ship-To address matches "${billAddressLabel}" (bill_address) - imported without one.`); }
      else billAddressId = addr.id;
    }
    const shipAddressLabel = String(row.ship_address || '').trim();
    let shipAddressId = null;
    if (shipAddressLabel) {
      const addr = findAddressByLabel.get(shipAddressLabel);
      if (!addr) { warnings.push(`Row ${rowNum}: no Bill-To/Ship-To address matches "${shipAddressLabel}" (ship_address) - imported without one.`); }
      else shipAddressId = addr.id;
    }
    const gstRate = row.gst_rate !== '' && row.gst_rate !== undefined ? Number(row.gst_rate) : 18;
    const discountPercent = row.discount_percent !== '' && row.discount_percent !== undefined
      ? Math.min(100, Math.max(0, Number(row.discount_percent))) : 0;
    const total = qty * rate * (1 - discountPercent / 100);
    const gstAmount = total * (gstRate || 0) / 100;
    const unit = String(row.unit || '').trim() || 'Nos';
    const freight = Number(row.freight) || 0;
    const freightGstRate = row.freight_gst_rate !== '' && row.freight_gst_rate !== undefined ? Number(row.freight_gst_rate) : 18;
    // Match SQLite's own CURRENT_TIMESTAMP format ('YYYY-MM-DD HH:MM:SS') so
    // an imported row sorts/compares consistently against natively-created
    // ones rather than mixing in ISO8601 with a 'T'/'Z'.
    const poDate = String(row.po_date || '').trim();
    const createdAt = poDate ? poDate + ' 00:00:00' : new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    insertPO.run(poNo, vendor.id, item.id, qty, rate, total, status, req.user.id,
      String(row.hsn_code || '') || null, gstRate, gstAmount, unit, discountPercent, freight, freightGstRate, String(row.terms || '') || null,
      String(row.delivery_date || '') || null, createdAt, billAddressId, shipAddressId);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors, warnings });
});

// ---- Store: GRN receive & issue to production ----
// A PO's own `quantity` is the ordered amount; how much has actually come
// in is derived from stock_movements (movement_type='IN', reference =
// 'PO#'+id) - see lib/purchaseOrders.js's poReceivedQty(), also used by
// routes/finance.js's Purchase Invoice booking.
// Receiving against a PO line now also starts a GRN reconciliation - the PO
// line (at the rate it actually carried at receipt time) plus whatever the
// vendor's own invoice says (captured here if it's already in hand;
// optional, since the bill can arrive after the goods) goes to the Store
// department's own HOD/Supervisor to review and reconcile before any of
// this quantity can be billed - see poLineReconciledQty() in
// routes/finance.js, which Purchase Invoice booking is gated on. A receipt
// with no po_id (ad hoc stock-in, nothing to reconcile against) is
// untouched by any of this, same as before.
router.post('/store/receive', requirePermission('store.manage'), (req, res) => {
  const { item_id, quantity, po_id, project_id, vendor_invoice_no, vendor_invoice_date, vendor_invoiced_qty, vendor_invoiced_rate } = req.body;
  // Validate before hitting the DB - an empty/missing item_id (e.g. the Item
  // Master has no approved items yet, or the picker was left blank) otherwise
  // surfaces as a raw "FOREIGN KEY constraint failed" 500 with no clue what
  // went wrong. Same class of bug as the earlier Purchase Order fix.
  if (!item_id) return res.status(400).json({ error: 'Pick an item. If the Item Master is empty, add one there first.' });
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(item_id);
  if (!item) return res.status(400).json({ error: 'That item no longer exists - refresh the page and pick an item again.' });
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  let po = null;
  if (po_id) {
    po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(po_id);
    if (!po) return res.status(400).json({ error: 'That Purchase Order no longer exists - refresh the page and try again.' });
    if (['Draft', 'PendingApproval', 'Rejected'].includes(po.status)) {
      return res.status(400).json({ error: `This Purchase Order is still ${po.status === 'Draft' ? 'a Draft, not yet submitted for approval,' : po.status === 'PendingApproval' ? 'pending approval' : 'Rejected'} and cannot receive stock until it is approved.` });
    }
    if (['Received', 'Cancelled', 'Closed'].includes(po.status)) {
      return res.status(400).json({ error: `This Purchase Order is already ${po.status} and can no longer receive stock against it.` });
    }
  }
  if (project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(400).json({ error: 'That project no longer exists - refresh the page and try again.' });
  }
  const tx = db.transaction(() => {
    const moveInfo = db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, moved_by) VALUES (?, 'IN', ?, ?, ?, ?)`)
      .run(item_id, qty, po_id ? 'PO#' + po_id : null, project_id || null, req.user.id);
    db.prepare(`UPDATE items SET current_stock = current_stock + ? WHERE id = ?`).run(qty, item_id);
    let grnId = null;
    if (po_id) {
      // Receiving less than the full ordered quantity used to still mark
      // the PO fully 'Received' outright - which then also dropped it out
      // of the "Receive against PO" picker (Open-only), silently blocking
      // ever receiving the remainder through the normal flow again. Now
      // reflects the real cumulative total instead.
      const receivedSoFar = poReceivedQty(po_id);
      const newStatus = receivedSoFar >= po.quantity ? 'Received' : 'PartiallyReceived';
      db.prepare(`UPDATE purchase_orders SET status = ? WHERE id = ?`).run(newStatus, po_id);
      const invNo = (vendor_invoice_no && String(vendor_invoice_no).trim()) || null;
      // Single-row placeholder batch so the invoice no/date always live on a grn_batches header.
      const batchId = db.prepare(`INSERT INTO grn_batches (po_id, invoice_attachment_path, uploaded_by, is_placeholder, vendor_invoice_no, vendor_invoice_date) VALUES (?,?,?,1,?,?)`)
        .run(po_id, 'PLACEHOLDER - vendor invoice not yet received', req.user.id, invNo, vendor_invoice_date || null).lastInsertRowid;
      db.prepare('UPDATE stock_movements SET grn_batch_id = ? WHERE id = ?').run(batchId, moveInfo.lastInsertRowid);
      const grnInfo = db.prepare(`
        INSERT INTO grn_reconciliations (po_id, stock_movement_id, received_qty, po_rate, vendor_invoice_no, vendor_invoice_date, vendor_invoiced_qty, vendor_invoiced_rate, created_by, grn_batch_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(po_id, moveInfo.lastInsertRowid, qty, po.rate,
        invNo, vendor_invoice_date || null,
        vendor_invoiced_qty !== undefined && vendor_invoiced_qty !== '' ? Number(vendor_invoiced_qty) : null,
        vendor_invoiced_rate !== undefined && vendor_invoiced_rate !== '' ? Number(vendor_invoiced_rate) : null,
        req.user.id, batchId);
      grnId = grnInfo.lastInsertRowid;
    }
    return grnId;
  });
  const grnId = tx();
  if (grnId) {
    const approvalId = approvals.startApproval('GrnReconciliation', 'grn_reconciliation', grnId, 0, req.user.id);
    db.prepare('UPDATE grn_reconciliations SET approval_id = ? WHERE id = ?').run(approvalId, grnId);
  }
  res.json({ ok: true, grn_id: grnId });
});

// Consolidated multi-line receipt (2026-10-21): one mandatory master vendor-
// invoice file + shared invoice no/date, N PO lines. All-or-nothing in one
// transaction; each line still gets its own movement, GRN row and approval
// (so billing/ledger logic downstream is unchanged), all tagged with the same
// grn_batch_id. The file is attached once to the batch; routes/attachments.js maps a
// GRN line id to its parent batch so the drilldown widget still finds it.
const uploadGrnInvoice = makeUpload('attachments', 15);
router.post('/store/receive-batch', requirePermission('store.manage'), uploadGrnInvoice.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach the vendor invoice copy - it is mandatory for a batch receipt.' });
  const fail = (msg) => { try { fs.unlinkSync(req.file.path); } catch (e) { /* best effort */ } return res.status(400).json({ error: msg }); };
  let lines;
  try { lines = JSON.parse(req.body.lines || '[]'); } catch (e) { return fail('Invalid lines payload.'); }
  lines = (Array.isArray(lines) ? lines : []).filter(l => Number(l.quantity) > 0);
  if (!lines.length) return fail('Enter a Qty to Receive greater than 0 on at least one line.');
  const invNo = (req.body.vendor_invoice_no || '').trim() || null;
  const invDate = req.body.vendor_invoice_date || null;
  const num = (v) => (v !== undefined && v !== null && v !== '' ? Number(v) : null);
  const seen = new Set();
  const prepared = [];
  for (const l of lines) {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(l.po_id);
    if (!po) return fail('A Purchase Order line no longer exists - refresh the page and try again.');
    if (seen.has(po.id)) return fail('The same PO line appears twice in this batch.');
    seen.add(po.id);
    if (['Draft', 'PendingApproval', 'Rejected', 'Received', 'Cancelled', 'Closed'].includes(po.status)) {
      return fail(`${po.item_name || 'A line'} is ${po.status} and cannot receive stock.`);
    }
    prepared.push({ po, qty: Number(l.quantity), vqty: num(l.vendor_invoiced_qty), vrate: num(l.vendor_invoiced_rate) });
  }
  const filePath = '/uploads/attachments/' + req.file.filename;
  const grnIds = db.transaction(() => {
    const batchId = db.prepare('INSERT INTO grn_batches (po_id, invoice_attachment_path, uploaded_by, vendor_invoice_no, vendor_invoice_date) VALUES (?,?,?,?,?)')
      .run(prepared[0].po.id, filePath, req.user.id, invNo, invDate).lastInsertRowid;
    // The scanned master invoice is attached ONCE, to the batch header.
    db.prepare(`INSERT INTO attachments (entity_type, entity_id, file_path, original_name, uploaded_by, document_type) VALUES ('grn_batches', ?, ?, ?, ?, 'VendorInvoice')`)
      .run(batchId, filePath, req.file.originalname, req.user.id);
    return prepared.map(({ po, qty, vqty, vrate }) => {
      const mv = db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, moved_by, grn_batch_id) VALUES (?, 'IN', ?, ?, ?, ?)`)
        .run(po.item_id, qty, 'PO#' + po.id, req.user.id, batchId);
      db.prepare('UPDATE items SET current_stock = current_stock + ? WHERE id = ?').run(qty, po.item_id);
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?')
        .run(poReceivedQty(po.id) >= po.quantity ? 'Received' : 'PartiallyReceived', po.id);
      const grnId = db.prepare(`
        INSERT INTO grn_reconciliations (po_id, stock_movement_id, received_qty, po_rate, vendor_invoice_no, vendor_invoice_date, vendor_invoiced_qty, vendor_invoiced_rate, created_by, grn_batch_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(po.id, mv.lastInsertRowid, qty, po.rate, invNo, invDate, vqty, vrate, req.user.id, batchId).lastInsertRowid;
      return grnId;
    });
  })();
  for (const grnId of grnIds) {
    const approvalId = approvals.startApproval('GrnReconciliation', 'grn_reconciliation', grnId, 0, req.user.id);
    db.prepare('UPDATE grn_reconciliations SET approval_id = ? WHERE id = ?').run(approvalId, grnId);
  }
  res.json({ ok: true, grn_ids: grnIds });
});

// GRN reconciliation - the Store HOD's review queue needs the full PO-vs-
// vendor-invoice comparison (see My Approvals' grn_reconciliation drilldown,
// routes/approvals.js), and the Stock In/Out page itself shows every line's
// reconciliation status so receiving clerks can see what's still pending.
// Rejection reason/actor are resolved live from the generic approval engine's
// own approval_actions, never stored on grn_reconciliations itself - same
// "resolve it live" approach already used for To-Do's InfoRequested note
// (routes/todos.js's TODO_APPROVAL_FIELDS) - so a Rejected row always shows
// whatever the most recent Reject action actually said, with no new column
// and nothing that can drift out of sync (2026-10-16, "resurface the reason
// to whoever received it").
const GRN_REJECTION_REASON_FIELDS = `
  (SELECT aa.comment FROM approval_actions aa JOIN approvals ap ON ap.id = aa.approval_id
    WHERE ap.entity_type = 'grn_reconciliation' AND ap.entity_id = g.id AND aa.action = 'Rejected'
    ORDER BY aa.acted_at DESC LIMIT 1) as rejection_reason,
  (SELECT u.full_name FROM approval_actions aa JOIN approvals ap ON ap.id = aa.approval_id
    LEFT JOIN users u ON u.id = aa.actor_user_id
    WHERE ap.entity_type = 'grn_reconciliation' AND ap.entity_id = g.id AND aa.action = 'Rejected'
    ORDER BY aa.acted_at DESC LIMIT 1) as rejected_by_name
`;
router.get('/store/grn-reconciliations', (req, res) => {
  let q = `
    SELECT g.*, po.po_no, po.item_id, i.name as item_name, v.name as vendor_name, ${GRN_REJECTION_REASON_FIELDS}
    FROM grn_reconciliations g
    JOIN purchase_orders po ON po.id = g.po_id
    LEFT JOIN items i ON i.id = po.item_id
    LEFT JOIN vendors v ON v.id = po.vendor_id
    WHERE 1=1
  `;
  const params = [];
  if (req.query.po_id) { q += ' AND g.po_id = ?'; params.push(req.query.po_id); }
  q += ' ORDER BY g.id DESC';
  res.json(db.prepare(q).all(...params));
});
// Sidebar "pending count" badge (2026-10-14) - Store's own global review
// queue (not personal, same as the queue itself), so every user who can
// see the Stock In/Out nav item sees the same figure. Registered ahead of
// /store/grn-reconciliations/:id, same :id-before-literal-sibling
// discipline this file already follows everywhere else.
router.get('/store/grn-reconciliations/pending-count', (req, res) => {
  const row = db.prepare(`SELECT COUNT(*) as count FROM grn_reconciliations WHERE status = 'PendingApproval'`).get();
  res.json({ count: row.count });
});
router.get('/store/grn-reconciliations/:id', (req, res) => {
  const g = db.prepare(`
    SELECT g.*, po.po_no, po.item_id, po.quantity as po_quantity, po.unit, po.hsn_code, po.gst_rate,
      i.name as item_name, v.name as vendor_name, v.gstin as vendor_gstin, ${GRN_REJECTION_REASON_FIELDS},
      COALESCE((SELECT a.file_path FROM attachments a WHERE a.entity_type = 'grn_batches' AND a.entity_id = g.grn_batch_id ORDER BY a.id DESC LIMIT 1),
        (SELECT a.file_path FROM attachments a WHERE a.entity_type = 'grn_reconciliation' AND a.entity_id = g.id ORDER BY a.id DESC LIMIT 1)) as invoice_attachment_path,
      (SELECT COUNT(*) FROM grn_reconciliations g2 WHERE g2.grn_batch_id = g.grn_batch_id) as batch_line_count
    FROM grn_reconciliations g
    JOIN purchase_orders po ON po.id = g.po_id
    LEFT JOIN items i ON i.id = po.item_id
    LEFT JOIN vendors v ON v.id = po.vendor_id
    WHERE g.id = ?
  `).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  res.json(g);
});
// Edit + resubmit a Rejected GRN reconciliation (2026-10-16) - the only way
// out of a Reject before this was a dead end (no edit route existed at
// all). Deliberately scoped to the vendor-invoice fields the clerk typed
// off the vendor's own bill (what a reconciliation mismatch is actually
// about) - NOT received_qty/po_rate, which are a snapshot of what's
// already been physically received and fed into stock_movements/the
// item's stock count at receive time; correcting those would mean also
// adjusting the linked stock movement, a materially different change.
// Gated the same "owner or approver" way every other edit action in this
// app already is - the original receiver, or an Admin/Management/Store
// HOD - and applies to ANY row currently sitting at Rejected, including
// ones rejected before this route existed (the gate is a live status
// check, not an event-time flag).
router.patch('/store/grn-reconciliations/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM grn_reconciliations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.created_by === req.user.id;
  if (!isOwner && !isStoreApprover(req.user)) {
    return res.status(403).json({ error: 'Only the person who received this, or an approver (Store HOD/Management/Admin), can edit it.' });
  }
  if (existing.status !== 'Rejected') {
    return res.status(400).json({ error: 'Only a rejected reconciliation can be edited and resubmitted.' });
  }
  const { vendor_invoice_no, vendor_invoice_date, vendor_invoiced_qty, vendor_invoiced_rate } = req.body;
  db.prepare(`
    UPDATE grn_reconciliations SET vendor_invoice_no = ?, vendor_invoice_date = ?, vendor_invoiced_qty = ?, vendor_invoiced_rate = ?
    WHERE id = ?
  `).run(
    (vendor_invoice_no && String(vendor_invoice_no).trim()) || null,
    vendor_invoice_date || null,
    vendor_invoiced_qty !== undefined && vendor_invoiced_qty !== '' ? Number(vendor_invoiced_qty) : null,
    vendor_invoiced_rate !== undefined && vendor_invoiced_rate !== '' ? Number(vendor_invoiced_rate) : null,
    existing.id
  );
  if (existing.grn_batch_id) {
    db.prepare('UPDATE grn_batches SET vendor_invoice_no = ?, vendor_invoice_date = ? WHERE id = ? AND is_placeholder = 1')
      .run((vendor_invoice_no && String(vendor_invoice_no).trim()) || null, vendor_invoice_date || null, existing.grn_batch_id);
  }
  // A fresh approval, not a resume of the rejected one - same shape as a
  // rejected Purchase Request's own POST /requests/:id/resubmit, so the
  // Rejected approval and its reason stay on file as permanent history
  // rather than being reused/overwritten.
  const approvalId = approvals.startApproval('GrnReconciliation', 'grn_reconciliation', existing.id, 0, req.user.id);
  db.prepare(`UPDATE grn_reconciliations SET status = 'PendingApproval', approval_id = ? WHERE id = ?`).run(approvalId, existing.id);
  res.json({ ok: true });
});

// Accepts either the original single-item shape (item_id/quantity at the
// top level) or a multi-line lines:[{item_id,quantity}] array sharing one
// department/project/client (2026-10-16) - same dual-shape pattern POST
// /orders and POST /foc already use, so the single-item shape (and anything
// still calling it, if anything ever does) keeps working unchanged.
// All-or-nothing: every line is validated - including summing repeated
// item_ids across lines, so two lines for the same item can't each pass an
// individual stock check against the same pre-issue quantity and together
// over-issue it - before anything is written; one bad line 400s the whole
// request and nothing is applied, rather than issuing some lines and
// silently skipping others.
router.post('/store/issue', requirePermission('store.manage'), (req, res) => {
  const { project_id, department_id, client_id } = req.body;
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [{ item_id: req.body.item_id, quantity: req.body.quantity }];
  if (!lines.length) return res.status(400).json({ error: 'Add at least one line item.' });
  // Store fulfills issue requests from every other department, so recording
  // WHOSE request this is matters even though it has no effect on stock math -
  // required on every interactive issue (the Excel bulk-upload path below is
  // unaffected and still leaves it null, since that template has no
  // department column and this wasn't asked to change).
  if (!department_id) return res.status(400).json({ error: 'Pick which department this is being issued to.' });
  const department = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
  if (!department) return res.status(400).json({ error: 'That department no longer exists - refresh the page and try again.' });
  if (project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(400).json({ error: 'That project no longer exists - refresh the page and try again.' });
  }
  if (client_id) {
    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(client_id);
    if (!client) return res.status(400).json({ error: 'That client no longer exists - refresh the page and try again.' });
  }
  const items = {};
  const requestedByItem = {};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prefix = lines.length > 1 ? `Line ${i + 1}: ` : '';
    if (!l.item_id) return res.status(400).json({ error: `${prefix}pick an item. If the Item Master is empty, add one there first.` });
    if (!l.quantity || Number(l.quantity) <= 0) return res.status(400).json({ error: `${prefix}enter a quantity greater than 0.` });
    if (!items[l.item_id]) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(l.item_id);
      if (!item) return res.status(400).json({ error: `${prefix}that item no longer exists - refresh the page and pick an item again.` });
      items[l.item_id] = item;
    }
    requestedByItem[l.item_id] = (requestedByItem[l.item_id] || 0) + Number(l.quantity);
  }
  for (const itemId of Object.keys(requestedByItem)) {
    const item = items[itemId];
    if (item.current_stock < requestedByItem[itemId]) {
      return res.status(400).json({ error: `Insufficient stock for ${item.name} - only ${item.current_stock} ${item.unit || ''} available, ${requestedByItem[itemId]} requested.` });
    }
  }
  const tx = db.transaction(() => {
    const insertMove = db.prepare(`
      INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, department_id, client_id, moved_by)
      VALUES (?, 'OUT', ?, ?, ?, ?, ?, ?)
    `);
    const adjustStock = db.prepare(`UPDATE items SET current_stock = current_stock - ? WHERE id = ?`);
    lines.forEach(l => {
      insertMove.run(l.item_id, l.quantity, project_id ? 'Project#' + project_id : null, project_id || null, department_id, client_id || null, req.user.id);
      adjustStock.run(l.quantity, l.item_id);
    });
  });
  tx();
  res.json({ ok: true });
});

// ---- Store Q: job-card material requisitions raised via POST
// /projects/job-cards/:id/request-material, reviewed/issued here. No
// approval chain - same "Store acts directly" shape as /store/issue above;
// Issue actually moves stock (same atomic decrement+stock_movements
// pattern as /store/issue, one line at a time since a requisition is
// already one item), tagged with the request's own job_card_id/project_id/
// department_id so project costing can read consumption straight off the
// movement.
router.get('/store/material-requests', requirePermission('store.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT smr.*, jc.stage as job_card_stage, p.project_code, p.title as project_title,
      d.name as department_name, i.unit as item_master_unit,
      ur.full_name as requested_by_name, ui.full_name as issued_by_name
    FROM store_material_requests smr
    JOIN job_cards jc ON jc.id = smr.job_card_id
    LEFT JOIN projects p ON p.id = smr.project_id
    LEFT JOIN departments d ON d.id = smr.department_id
    LEFT JOIN items i ON i.id = smr.item_id
    LEFT JOIN users ur ON ur.id = smr.requested_by
    LEFT JOIN users ui ON ui.id = smr.issued_by
    ORDER BY (smr.status = 'Pending') DESC, smr.id DESC
  `).all());
});
router.post('/store/material-requests/:id/action', requirePermission('store.manage'), (req, res) => {
  const reqRow = db.prepare('SELECT * FROM store_material_requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'Not found' });
  if (reqRow.status !== 'Pending') return res.status(400).json({ error: 'This request has already been actioned.' });
  const action = req.body.action;
  if (action !== 'Issue' && action !== 'Reject') return res.status(400).json({ error: "action must be 'Issue' or 'Reject'." });
  const notes = req.body.notes || null;
  if (action === 'Reject') {
    db.prepare(`UPDATE store_material_requests SET status = 'Rejected', issued_by = ?, decision_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.user.id, notes, reqRow.id);
    return res.json({ ok: true });
  }
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(reqRow.item_id);
  if (!item) return res.status(400).json({ error: 'That item no longer exists in Item Master.' });
  if (item.current_stock < reqRow.quantity_requested) {
    return res.status(400).json({ error: `Insufficient stock for ${item.name} - only ${item.current_stock} ${item.unit || ''} available, ${reqRow.quantity_requested} requested.` });
  }
  const tx = db.transaction(() => {
    const moveInfo = db.prepare(`
      INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, department_id, moved_by)
      VALUES (?, 'OUT', ?, ?, ?, ?, ?)
    `).run(reqRow.item_id, reqRow.quantity_requested, 'JobCard#' + reqRow.job_card_id, reqRow.project_id || null, reqRow.department_id || null, req.user.id);
    db.prepare('UPDATE items SET current_stock = current_stock - ? WHERE id = ?').run(reqRow.quantity_requested, reqRow.item_id);
    db.prepare(`
      UPDATE store_material_requests SET status = 'Issued', issued_by = ?, decision_notes = ?, stock_movement_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.user.id, notes, moveInfo.lastInsertRowid, reqRow.id);
  });
  tx();
  res.json({ ok: true });
});

// reference stores 'PO#'+id (an internal row id, see POST /store/receive) -
// on its own it's meaningless to a user searching by the PO number they
// actually know (po_no). Resolve it back to the real PO No (IN movements)
// or the linked project's code (OUT movements, which already carry a real
// project_id - no string-parsing needed there) so "Recent Movements" shows
// something a user can actually search/recognize (2026-10-16).
router.get('/store/movements', (req, res) => {
  res.json(db.prepare(`
    SELECT sm.*, i.name as item_name, d.name as department_name, c.name as client_name,
      po.po_no, p.project_code
    FROM stock_movements sm
    JOIN items i ON i.id = sm.item_id
    LEFT JOIN departments d ON d.id = sm.department_id
    LEFT JOIN clients c ON c.id = sm.client_id
    LEFT JOIN purchase_orders po ON ('PO#' || po.id) = sm.reference
    LEFT JOIN projects p ON p.id = sm.project_id
    ORDER BY sm.id DESC LIMIT 200
  `).all());
});

const STOCK_TEMPLATE_COLUMNS = ['item_code_or_barcode', 'movement_type', 'quantity', 'po_no', 'department', 'project', 'client', 'reference'];
router.get('/store/movements/template', requirePermission('store.manage'), (req, res) => {
  const exampleRows = [
    { item_code_or_barcode: 'ITM-1001', movement_type: 'IN', quantity: 50, po_no: 'PO-1024', department: '', project: '', client: '', reference: 'GRN against PO-1024' },
    { item_code_or_barcode: 'ITM-1002', movement_type: 'OUT', quantity: 10, po_no: '', department: 'Production', project: 'PRJ-0007', client: 'Acme Industries', reference: 'Issued for assembly' },
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exampleRows, { header: STOCK_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'StockMovements');
  const note = XLSX.utils.aoa_to_sheet([['Notes'],
    ['movement_type must be IN (stock received) or OUT (issued to production).'],
    ['item_code_or_barcode can be either the item\'s Item Code or its printed barcode number.'],
    ['po_no is optional and only applies to IN movements - when it matches an open Purchase Order, this receipt counts toward that PO\'s received quantity and updates its status (Open/PartiallyReceived/Received), same as receiving against it from the Purchase Orders page.'],
    ['department is required for OUT movements (same rule as the Issue screen - Store needs to know which department the stock is going to) and does not apply to IN movements. Match it exactly to a department name already in the system.'],
    ['project is optional and only applies to OUT movements - match it to a Project Code (e.g. PRJ-0007) or project title.'],
    ['client is optional and only applies to OUT movements - match it to a Customer name already in the system.'],
  ]);
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="stock_in_out_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
router.post('/store/movements/bulk-upload', requirePermission('store.manage'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' }); }
  const findItem = db.prepare('SELECT * FROM items WHERE item_code = ? OR barcode = ?');
  const findDepartment = db.prepare('SELECT * FROM departments WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))');
  const findProject = db.prepare('SELECT * FROM projects WHERE LOWER(TRIM(project_code)) = LOWER(TRIM(?)) OR LOWER(TRIM(title)) = LOWER(TRIM(?))');
  const findClient = db.prepare('SELECT * FROM clients WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))');
  // A multi-item PO is several purchase_orders rows sharing one po_no (see
  // POST /orders) - matching by po_no alone would resolve to whichever
  // sibling row SQLite happens to return first, posting this receipt
  // against the wrong line item. item_id (already resolved above from this
  // same row's item_code_or_barcode) disambiguates which line the receipt
  // is actually for.
  const findPoByNoAndItem = db.prepare('SELECT * FROM purchase_orders WHERE po_no = ? AND item_id = ?');
  const insertMove = db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, department_id, client_id, moved_by) VALUES (?,?,?,?,?,?,?,?)`);
  const adjustStock = db.prepare('UPDATE items SET current_stock = current_stock + ? WHERE id = ?');
  const updatePoStatus = db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?');
  let inserted = 0; const errors = []; const warnings = [];
  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const key = String(row.item_code_or_barcode || '').trim();
      if (!key) { errors.push(`Row ${rowNum}: item_code_or_barcode is required - skipped.`); return; }
      const item = findItem.get(key, key);
      if (!item) { errors.push(`Row ${rowNum}: no item matches "${key}" - skipped.`); return; }
      const type = String(row.movement_type || '').trim().toUpperCase();
      if (type !== 'IN' && type !== 'OUT') { errors.push(`Row ${rowNum}: movement_type must be IN or OUT - skipped.`); return; }
      const qty = Number(row.quantity) || 0;
      if (qty <= 0) { errors.push(`Row ${rowNum}: quantity must be greater than 0 - skipped.`); return; }
      if (type === 'OUT' && item.current_stock < qty) { errors.push(`Row ${rowNum}: insufficient stock for "${item.name}" - skipped.`); return; }
      // department/project/client mirror the interactive Issue (OUT) form,
      // which alone has these fields - Receive (IN) only has po_no. Same
      // required-for-OUT rule as /store/issue's own check.
      const deptName = String(row.department || '').trim();
      let department_id = null;
      if (type === 'OUT') {
        if (!deptName) { errors.push(`Row ${rowNum}: department is required for OUT movements - skipped.`); return; }
        const dept = findDepartment.get(deptName);
        if (!dept) { errors.push(`Row ${rowNum}: department "${deptName}" not found - skipped.`); return; }
        department_id = dept.id;
      } else if (deptName) {
        warnings.push(`Row ${rowNum}: department only applies to OUT movements - ignored for this IN row.`);
      }
      const projectName = String(row.project || '').trim();
      let project_id = null;
      if (projectName) {
        if (type !== 'OUT') {
          warnings.push(`Row ${rowNum}: project only applies to OUT movements - ignored for this IN row.`);
        } else {
          const project = findProject.get(projectName, projectName);
          if (!project) { errors.push(`Row ${rowNum}: project "${projectName}" not found - skipped.`); return; }
          project_id = project.id;
        }
      }
      const clientName = String(row.client || '').trim();
      let client_id = null;
      if (clientName) {
        if (type !== 'OUT') {
          warnings.push(`Row ${rowNum}: client only applies to OUT movements - ignored for this IN row.`);
        } else {
          const client = findClient.get(clientName);
          if (!client) { errors.push(`Row ${rowNum}: client "${clientName}" not found - skipped.`); return; }
          client_id = client.id;
        }
      }
      const poNo = String(row.po_no || '').trim();
      let po = null;
      let reference = String(row.reference || '') || null;
      if (poNo) {
        if (type !== 'IN') {
          warnings.push(`Row ${rowNum}: po_no is only applied to IN movements - ignored for this OUT row.`);
        } else {
          po = findPoByNoAndItem.get(poNo, item.id);
          if (!po) { warnings.push(`Row ${rowNum}: no Purchase Order matches "${poNo}" for item "${item.name}" - imported without linking to a PO.`); }
          else if (['Draft', 'PendingApproval', 'Rejected', 'Received', 'Cancelled', 'Closed'].includes(po.status)) {
            warnings.push(`Row ${rowNum}: PO "${poNo}" is ${po.status} - imported without linking to it.`);
            po = null;
          } else {
            reference = 'PO#' + po.id;
          }
        }
      }
      insertMove.run(item.id, type, qty, reference, project_id, department_id, client_id, req.user.id);
      adjustStock.run(type === 'IN' ? qty : -qty, item.id);
      if (po) {
        const receivedSoFar = poReceivedQty(po.id);
        const newStatus = receivedSoFar >= po.quantity ? 'Received' : 'PartiallyReceived';
        updatePoStatus.run(newStatus, po.id);
      }
      inserted++;
    });
  });
  tx();
  res.json({ inserted, skipped: errors.length, errors, warnings });
});

router.get('/store/low-stock', (req, res) => {
  res.json(db.prepare(`SELECT * FROM items WHERE current_stock <= reorder_level`).all());
});

// ---- Challans (inter-location material movement, GST delivery challan) ----
router.get('/store/challans', (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, u.full_name as created_by_name, p.project_code,
      (SELECT COUNT(*) FROM challan_items ci WHERE ci.challan_id = c.id) as item_count
    FROM challans c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN projects p ON p.id = c.project_id
    ORDER BY c.id DESC
  `).all());
});

router.get('/store/challans/:id', (req, res) => {
  const challan = db.prepare(`
    SELECT c.*, u.full_name as created_by_name, p.project_code FROM challans c
    LEFT JOIN users u ON u.id = c.created_by LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?
  `).get(req.params.id);
  if (!challan) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM challan_items WHERE challan_id = ? ORDER BY sort_order, id').all(challan.id);
  res.json({ challan, items });
});

function computeChallanTotal(items) {
  return items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.rate) || 0), 0);
}

router.post('/store/challans', requirePermission('store.manage'), (req, res) => {
  const {
    from_location, to_location, vehicle_no, transport_mode, transporter_name, distance_km,
    consignor_name, consignor_gstin, consignee_name, consignee_gstin, reason, eway_bill_no,
    po_no, project_id, items,
  } = req.body;
  if (!from_location || !to_location) return res.status(400).json({ error: 'From and To location are required' });
  const lineItems = Array.isArray(items) ? items : [];
  const challanNo = 'CH-' + Date.now();
  const total = computeChallanTotal(lineItems);
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO challans (challan_no, from_location, to_location, vehicle_no, transport_mode, transporter_name,
        distance_km, consignor_name, consignor_gstin, consignee_name, consignee_gstin, reason, eway_bill_no, po_no,
        project_id, total_value, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(challanNo, from_location, to_location, vehicle_no || null, transport_mode || 'Road', transporter_name || null,
      distance_km || null, consignor_name || 'Venkateshwara Engineers', consignor_gstin || null, consignee_name || null,
      consignee_gstin || null, reason || 'Stock Transfer (Own Use - Not For Sale)', eway_bill_no || null, po_no || null,
      project_id || null, total, req.user.id);
    const insertItem = db.prepare(`
      INSERT INTO challan_items (challan_id, description, hsn_code, quantity, unit, rate, value, sort_order)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    lineItems.forEach((it, i) => {
      const value = (Number(it.quantity) || 0) * (Number(it.rate) || 0);
      insertItem.run(info.lastInsertRowid, it.description, it.hsn_code || null, it.quantity || 0, it.unit || 'Nos', it.rate || 0, value, i);
    });
    return info.lastInsertRowid;
  });
  const id = tx();
  res.json({ id, challan_no: challanNo });
});

router.put('/store/challans/:id', requirePermission('store.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM challans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const {
    from_location, to_location, vehicle_no, transport_mode, transporter_name, distance_km,
    consignor_name, consignor_gstin, consignee_name, consignee_gstin, reason, eway_bill_no,
    po_no, project_id, items,
  } = req.body;
  const lineItems = Array.isArray(items) ? items : [];
  const total = computeChallanTotal(lineItems);
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE challans SET from_location=?, to_location=?, vehicle_no=?, transport_mode=?, transporter_name=?,
        distance_km=?, consignor_name=?, consignor_gstin=?, consignee_name=?, consignee_gstin=?, reason=?,
        eway_bill_no=?, po_no=?, project_id=?, total_value=? WHERE id = ?
    `).run(from_location, to_location, vehicle_no || null, transport_mode || 'Road', transporter_name || null,
      distance_km || null, consignor_name || 'Venkateshwara Engineers', consignor_gstin || null, consignee_name || null,
      consignee_gstin || null, reason || 'Stock Transfer (Own Use - Not For Sale)', eway_bill_no || null, po_no || null,
      project_id || null, total, existing.id);
    db.prepare('DELETE FROM challan_items WHERE challan_id = ?').run(existing.id);
    const insertItem = db.prepare(`
      INSERT INTO challan_items (challan_id, description, hsn_code, quantity, unit, rate, value, sort_order)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    lineItems.forEach((it, i) => {
      const value = (Number(it.quantity) || 0) * (Number(it.rate) || 0);
      insertItem.run(existing.id, it.description, it.hsn_code || null, it.quantity || 0, it.unit || 'Nos', it.rate || 0, value, i);
    });
  });
  tx();
  res.json({ ok: true });
});

router.get('/store/challans/:id/pdf', async (req, res) => {
  const challan = db.prepare('SELECT * FROM challans WHERE id = ?').get(req.params.id);
  if (!challan) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM challan_items WHERE challan_id = ? ORDER BY sort_order, id').all(challan.id);
  try {
    const gen = await generateChallanPdf(challan, items);
    const filename = buildDownloadFilename({
      docType: 'Delivery_Challan',
      reference: challan.challan_no,
      partyName: challan.consignee_name,
      date: new Date(challan.challan_date).toISOString().slice(0, 10),
      version: buildVersionStamp(),
    });
    res.download(gen.outPath, filename, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Purchase Order: PDF / Word / Email to vendor ----
// A multi-item PO is several purchase_orders rows sharing one po_no (see
// POST /orders) - `po` here is the one row the caller asked for (so the
// route path/permission checks stay per-id), but `lines` is every row
// under that same po_no, which is what the PDF/DOCX/email actually render
// as one document's item table. A single-item PO just gets a one-row
// `lines` array, so the generators below never need to special-case it.
function loadPoBundle(id) {
  const po = db.prepare(`
    SELECT po.*, i.name as item_name FROM purchase_orders po LEFT JOIN items i ON i.id = po.item_id WHERE po.id = ?
  `).get(id);
  if (!po) return null;
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(po.vendor_id);
  const companyAddress = po.company_address_id
    ? db.prepare('SELECT * FROM company_addresses WHERE id = ?').get(po.company_address_id)
    : null;
  const companyShipAddress = po.company_ship_address_id
    ? db.prepare('SELECT * FROM company_addresses WHERE id = ?').get(po.company_ship_address_id)
    : null;
  const lines = db.prepare(`
    SELECT po.*, i.name as item_name FROM purchase_orders po LEFT JOIN items i ON i.id = po.item_id WHERE po.po_no = ? ORDER BY po.id
  `).all(po.po_no);
  return { po, vendor, companyAddress, companyShipAddress, lines };
}

// Shared gate for PDF/Word download and emailing the vendor: a PO still
// PendingApproval (or already Rejected) hasn't been authorized, so sending
// it anywhere a vendor could see it defeats the point of the approval gate.
// An Admin can lift this via Purchase Settings' "Allow emailing a Purchase
// Order that's pending approval" toggle for a genuinely urgent case -
// lib/poPdf.js/lib/poDocx.js both check `po.status` themselves and add a
// visible "Pending Approval" banner whenever this override is the reason
// the document was generated at all, so it never reads as authorized.
// A Draft is a separate case: `allowDraft` lets PDF/Word download through
// (lib/poPdf.js/poDocx.js render a "DRAFT" banner instead, same mechanism) -
// this is the submitter's actual "preview before submission" ask, so it's
// deliberately NOT gated behind the pending-email override. Email never
// gets this carve-out - a Draft is never sent to a vendor, no override.
function poSendBlocked(po, { allowDraft } = {}) {
  if (po.status === 'Draft' && allowDraft) return null;
  if (!['Draft', 'PendingApproval', 'Rejected'].includes(po.status)) return null;
  if (po.status === 'PendingApproval' && getPurchaseSettings().allow_pending_po_email) return null;
  const reason = po.status === 'Draft' ? 'still a Draft and has not yet been submitted for approval'
    : po.status === 'PendingApproval' ? 'still pending approval' : 'Rejected';
  return `This Purchase Order is ${reason} and cannot be sent to the vendor yet.`;
}

router.get('/orders/:id/pdf', async (req, res) => {
  const bundle = loadPoBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  const blocked = poSendBlocked(bundle.po, { allowDraft: true });
  if (blocked) return res.status(400).json({ error: blocked });
  try {
    const gen = await generatePoPdf(bundle.po, bundle.lines, bundle.vendor || {}, getCompanySettings(), bundle.companyAddress, bundle.companyShipAddress, getPurchaseSettings());
    const filename = buildDownloadFilename({
      docType: 'Purchase_Order',
      reference: bundle.po.po_no,
      partyName: bundle.vendor && (bundle.vendor.legal_name || bundle.vendor.name),
      date: new Date(bundle.po.created_at).toISOString().slice(0, 10),
      version: buildVersionStamp(),
    });
    res.download(gen.outPath, filename, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id/docx', async (req, res) => {
  const bundle = loadPoBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  const blocked = poSendBlocked(bundle.po, { allowDraft: true });
  if (blocked) return res.status(400).json({ error: blocked });
  try {
    const gen = await generatePoDocx(bundle.po, bundle.lines, bundle.vendor || {}, getCompanySettings(), bundle.companyAddress, bundle.companyShipAddress, getPurchaseSettings());
    const filename = buildDownloadFilename({
      docType: 'Purchase_Order',
      reference: bundle.po.po_no,
      partyName: bundle.vendor && (bundle.vendor.legal_name || bundle.vendor.name),
      date: new Date(bundle.po.created_at).toISOString().slice(0, 10),
      version: buildVersionStamp(),
      ext: 'docx',
    });
    res.download(gen.outPath, filename, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/orders/:id/email', requirePermission('purchase_order.manage'), async (req, res) => {
  const bundle = loadPoBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  const { po, vendor, companyAddress, companyShipAddress, lines } = bundle;
  const blocked = poSendBlocked(po);
  if (blocked) return res.status(400).json({ error: blocked });
  const toAddress = (vendor && (vendor.po_email || vendor.email)) || null;
  if (!toAddress) return res.status(400).json({ error: 'This vendor has no PO/document delivery email on file - add one under Vendor Master.' });
  let gen;
  try {
    gen = await generatePoPdf(po, lines, vendor, getCompanySettings(), companyAddress, companyShipAddress, getPurchaseSettings());
    const pdfBuffer = fs.readFileSync(gen.outPath);
    const attachmentName = buildDownloadFilename({
      docType: 'Purchase_Order',
      reference: po.po_no,
      partyName: vendor && (vendor.legal_name || vendor.name),
      date: new Date(po.created_at).toISOString().slice(0, 10),
      version: buildVersionStamp(),
    });
    const result = await sendMail({
      to: toAddress,
      subject: `Purchase Order ${po.po_no} - Venkateshwara Engineers`,
      text: `Dear ${vendor.contact_person || vendor.name},\n\nPlease find attached Purchase Order ${po.po_no}.\n\nRegards,\nVenkateshwara Engineers`,
      attachments: [{ filename: attachmentName, content: pdfBuffer }],
      ...getDepartmentEmailIdentity('Purchase'),
    });
    if (result.sent) return res.json({ ok: true, sent: true, to: toAddress });
    return res.json({ ok: false, sent: false, message: result.reason });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    if (gen) fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
  }
});

module.exports = router;

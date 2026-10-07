const express = require('express');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
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
const router = express.Router();
router.use(authRequired);
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Disk storage for quote documents (PDF/image/etc), following the pattern
// in routes/service.js.
const { getUploadsSubdir } = require('../lib/paths');
const quoteUploadDir = getUploadsSubdir('purchase-quotes');
const uploadQuote = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, quoteUploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---- Purchase Requests ----
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
    ...r, item_ids: JSON.parse(r.item_ids || '[]'),
    vendors: vendorsByRfq.all(r.id), emails: emailsByRfq.all(r.id),
  })));
});

router.post('/requests/:id/rfq', requirePermission('purchase_request.create', 'purchase_order.manage'), async (req, res) => {
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  const { item_ids, vendor_ids, subject, body } = req.body;
  // Manually-typed recipients not on file in Vendor Master at all (a new
  // vendor's buyer, a broker, an alternate contact) - optional, alongside
  // (not instead of) picking from Vendor Master.
  const extraEmails = [...new Set((Array.isArray(req.body.extra_emails) ? req.body.extra_emails : [])
    .map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const badEmails = extraEmails.filter(e => !RFQ_EMAIL_RE.test(e));
  if (badEmails.length) return res.status(400).json({ error: `"${badEmails.join('", "')}" doesn't look like a valid email address.` });
  if (!Array.isArray(item_ids) || !item_ids.length) return res.status(400).json({ error: 'Select at least one line item to request quotes for.' });
  if ((!Array.isArray(vendor_ids) || !vendor_ids.length) && !extraEmails.length) {
    return res.status(400).json({ error: 'Add at least one vendor or email address to send the RFQ to.' });
  }
  if (!String(subject || '').trim()) return res.status(400).json({ error: 'Subject is required.' });
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Email body is required.' });
  const lines = db.prepare(`SELECT id FROM purchase_request_items WHERE purchase_request_id = ?`).all(pr.id).map(r => r.id);
  const badItems = item_ids.filter(id => !lines.includes(Number(id)));
  if (badItems.length) return res.status(400).json({ error: `Line item(s) ${badItems.join(', ')} do not belong to this Purchase Request.` });
  const vendorIds = Array.isArray(vendor_ids) ? vendor_ids : [];
  const vendors = vendorIds.length ? db.prepare(`SELECT * FROM vendors WHERE id IN (${vendorIds.map(() => '?').join(',')})`).all(...vendorIds) : [];
  if (vendors.length !== vendorIds.length) return res.status(400).json({ error: 'One or more selected vendors no longer exist.' });

  const info = db.prepare(`INSERT INTO rfq_requests (purchase_request_id, item_ids, subject, body, created_by) VALUES (?,?,?,?,?)`)
    .run(pr.id, JSON.stringify(item_ids.map(Number)), subject.trim(), body, req.user.id);
  const rfqId = info.lastInsertRowid;
  const insertVendorRow = db.prepare(`INSERT INTO rfq_request_vendors (rfq_request_id, vendor_id, email_status) VALUES (?,?,'Pending')`);
  const updateVendorRow = db.prepare(`UPDATE rfq_request_vendors SET email_status=?, email_error=?, sent_at=?, sent_message_id=? WHERE id=?`);
  const insertEmailRow = db.prepare(`INSERT INTO rfq_request_emails (rfq_request_id, email, email_status) VALUES (?,?,'Pending')`);
  const updateEmailRow = db.prepare(`UPDATE rfq_request_emails SET email_status=?, email_error=?, sent_at=?, sent_message_id=? WHERE id=?`);
  const now = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const fromIdentity = getDepartmentEmailIdentity('Purchase');

  const results = [];
  for (const vendor of vendors) {
    const rowId = insertVendorRow.run(rfqId, vendor.id).lastInsertRowid;
    const to = vendor.po_email || vendor.email;
    if (!to) {
      updateVendorRow.run('NoEmail', 'This vendor has no PO/general email on file.', null, rowId);
      results.push({ vendor_id: vendor.id, vendor_name: vendor.name, email_status: 'NoEmail' });
      continue;
    }
    // {{vendor_name}} is the only personalization token - simple mail-merge,
    // not a template engine, since the editable body is meant to stay
    // readable/predictable for whoever wrote it.
    const personalizedBody = body.split('{{vendor_name}}').join(vendor.name || '');
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
    const personalizedBody = body.split('{{vendor_name}}').join('');
    const result = await sendMail({ to: email, subject: subject.trim(), text: personalizedBody, ...fromIdentity });
    if (result.sent) {
      updateEmailRow.run('Sent', null, now(), result.messageId || null, rowId);
      results.push({ email, email_status: 'Sent' });
    } else {
      updateEmailRow.run('Failed', result.reason || 'Unknown error', null, null, rowId);
      results.push({ email, email_status: 'Failed', email_error: result.reason });
    }
  }
  res.json({ id: rfqId, results });
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
    ld_percentage, ld_cap_percentage, ld_trigger_notes,
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
  // Draft-first submission (2026-10-07) - a PO is created here purely as a
  // Draft, fully editable (PUT /orders/:id below leaves it as Draft rather
  // than resubmitting for approval), with no approval chain started and the
  // source PR (if any) not yet flipped to OrderPlaced - both of those now
  // happen in POST /orders/:id/submit-for-approval instead, once the buyer
  // has actually reviewed/confirmed the order.
  const insert = db.prepare(`
    INSERT INTO purchase_orders (po_no, purchase_request_id, purchase_request_item_id, vendor_id, item_id, quantity, rate, total_value, created_by,
      hsn_code, gst_rate, gst_amount, unit, discount_percent, details, terms, delivery_date, company_address_id, company_ship_address_id, payment_terms,
      ld_percentage, ld_cap_percentage, ld_trigger_notes, freight, freight_gst_rate, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Draft')
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
        quantity, rate, total, req.user.id, l.hsn_code || null, gstRate, gstAmount, unit, discountPercent, l.details || null, terms || null, delivery_date || null,
        company_address_id || null, company_ship_address_id || null, payment_terms || null, ld_percentage || null, ld_cap_percentage || null,
        ld_trigger_notes || null, freight, freightGstRate);
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
  const { delivery_date, ld_percentage, ld_cap_percentage, ld_trigger_notes, payment_terms, freight, freight_gst_rate } = req.body;
  db.prepare(`
    UPDATE purchase_orders SET delivery_date = COALESCE(?, delivery_date), ld_percentage = ?, ld_cap_percentage = ?, ld_trigger_notes = ?,
      payment_terms = COALESCE(?, payment_terms), freight = ?, freight_gst_rate = ?
    WHERE po_no = ?
  `).run(delivery_date || null, ld_percentage || null, ld_cap_percentage || null, ld_trigger_notes || null, payment_terms || null,
    Number(freight) || 0, freight_gst_rate !== undefined && freight_gst_rate !== '' ? Number(freight_gst_rate) : (getCompanySettings().default_gst_rate || 18),
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
  db.prepare(`UPDATE purchase_orders SET status = 'PendingApproval', approval_id = ? WHERE po_no = ?`).run(newApprovalId, poNo);
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
      ld_percentage, ld_cap_percentage, ld_trigger_notes, freight, freight_gst_rate, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(existing.po_no, existing.purchase_request_id, existing.vendor_id, item_id || null, qty, rt, total, req.user.id,
    hsn_code || null, gstRate, gstAmount, newUnit, discountPercent, details || null, existing.terms, existing.delivery_date,
    existing.company_address_id, existing.company_ship_address_id, existing.payment_terms,
    existing.ld_percentage, existing.ld_cap_percentage, existing.ld_trigger_notes, existing.freight, existing.freight_gst_rate,
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
router.post('/store/receive', requirePermission('store.manage'), (req, res) => {
  const { item_id, quantity, po_id, project_id } = req.body;
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
    db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, moved_by) VALUES (?, 'IN', ?, ?, ?, ?)`)
      .run(item_id, qty, po_id ? 'PO#' + po_id : null, project_id || null, req.user.id);
    db.prepare(`UPDATE items SET current_stock = current_stock + ? WHERE id = ?`).run(qty, item_id);
    if (po_id) {
      // Receiving less than the full ordered quantity used to still mark
      // the PO fully 'Received' outright - which then also dropped it out
      // of the "Receive against PO" picker (Open-only), silently blocking
      // ever receiving the remainder through the normal flow again. Now
      // reflects the real cumulative total instead.
      const receivedSoFar = poReceivedQty(po_id);
      const newStatus = receivedSoFar >= po.quantity ? 'Received' : 'PartiallyReceived';
      db.prepare(`UPDATE purchase_orders SET status = ? WHERE id = ?`).run(newStatus, po_id);
    }
  });
  tx();
  res.json({ ok: true });
});

router.post('/store/issue', requirePermission('store.manage'), (req, res) => {
  const { item_id, quantity, project_id, department_id, client_id } = req.body;
  if (!item_id) return res.status(400).json({ error: 'Pick an item. If the Item Master is empty, add one there first.' });
  if (!quantity || Number(quantity) <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  // Store fulfills issue requests from every other department, so recording
  // WHOSE request this is matters even though it has no effect on stock math -
  // required on every interactive issue (the Excel bulk-upload path below is
  // unaffected and still leaves it null, since that template has no
  // department column and this wasn't asked to change).
  if (!department_id) return res.status(400).json({ error: 'Pick which department this is being issued to.' });
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(item_id);
  if (!item) return res.status(400).json({ error: 'That item no longer exists - refresh the page and pick an item again.' });
  if (item.current_stock < quantity) return res.status(400).json({ error: `Insufficient stock - only ${item.current_stock} ${item.unit || ''} available.` });
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
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, department_id, client_id, moved_by)
      VALUES (?, 'OUT', ?, ?, ?, ?, ?, ?)
    `).run(item_id, quantity, project_id ? 'Project#' + project_id : null, project_id || null, department_id, client_id || null, req.user.id);
    db.prepare(`UPDATE items SET current_stock = current_stock - ? WHERE id = ?`).run(quantity, item_id);
  });
  tx();
  res.json({ ok: true });
});

router.get('/store/movements', (req, res) => {
  res.json(db.prepare(`
    SELECT sm.*, i.name as item_name, d.name as department_name, c.name as client_name
    FROM stock_movements sm
    JOIN items i ON i.id = sm.item_id
    LEFT JOIN departments d ON d.id = sm.department_id
    LEFT JOIN clients c ON c.id = sm.client_id
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
    const gen = await generatePoPdf(bundle.po, bundle.lines, bundle.vendor || {}, getCompanySettings(), bundle.companyAddress, bundle.companyShipAddress);
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
    const gen = await generatePoDocx(bundle.po, bundle.lines, bundle.vendor || {}, getCompanySettings(), bundle.companyAddress, bundle.companyShipAddress);
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
    gen = await generatePoPdf(po, lines, vendor, getCompanySettings(), companyAddress, companyShipAddress);
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

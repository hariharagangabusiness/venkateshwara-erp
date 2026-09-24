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

router.post('/requests', requirePermission('purchase_request.create', 'job_card.manage'), (req, res) => {
  const { project_id, items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item line.' });
  let resolved;
  try {
    resolved = items.map(line => {
      const qty = Number(line.quantity);
      if (!qty || qty <= 0) throw new Error('Every line needs a quantity greater than 0.');
      const { itemId, wasAdhoc } = resolvePRLineItem(line, req.user.id);
      return { itemId, wasAdhoc, quantity: qty, estimatedValue: Number(line.estimated_value) || 0, itemText: line.item_text || null };
    });
  } catch (e) { return res.status(400).json({ error: e.message }); }

  const prNo = 'PR-' + Date.now();
  const totalValue = resolved.reduce((sum, l) => sum + l.estimatedValue, 0);
  // Round 13: a high-value request (>= the configurable quote threshold)
  // must collect at least 2 vendor quotes before it can enter the normal
  // approval chain - it's created here but held at status 'PendingQuotes'
  // instead of calling approvals.startApproval() immediately. Below the
  // threshold, behavior is unchanged - approval starts right away. The
  // threshold now applies to the whole request's total value across lines.
  const threshold = getPurchaseSettings().quote_threshold;
  const quotesRequired = totalValue >= threshold;
  const first = resolved[0];

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO purchase_requests (pr_no, project_id, raised_by, item_id, item_text, quantity, estimated_value, status, quotes_required)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(prNo, project_id || null, req.user.id, first.itemId, first.itemText, first.quantity, totalValue,
      quotesRequired ? 'PendingQuotes' : 'Pending', quotesRequired ? 1 : 0);
    const prId = info.lastInsertRowid;
    const insertLine = db.prepare(`
      INSERT INTO purchase_request_items (purchase_request_id, item_id, item_text, quantity, estimated_value, sort_order)
      VALUES (?,?,?,?,?,?)
    `);
    resolved.forEach((l, i) => {
      insertLine.run(prId, l.itemId, l.itemText, l.quantity, l.estimatedValue, i);
      if (l.wasAdhoc) db.prepare('UPDATE items SET created_from_pr_id = ? WHERE id = ?').run(prId, l.itemId);
    });
    if (!quotesRequired) {
      // Every purchase request goes to the Purchase HOD/Supervisor first,
      // regardless of value - the approval chain's step 1 always qualifies
      // (min_amount 0), and step 2 (Management) kicks in only above whatever
      // threshold is set on the Approval Matrix page.
      const approvalId = approvals.startApproval('PurchaseRequest', 'purchase_request', prId, totalValue, req.user.id);
      db.prepare('UPDATE purchase_requests SET approval_id = ? WHERE id = ?').run(approvalId, prId);
    }
    return prId;
  });
  const prId = tx();
  res.json({ id: prId, pr_no: prNo, quotes_required: quotesRequired });
});

// ---- Vendor discovery for a selected item (Round 13) ----
// Matches vendors to the item's category. Category naming isn't always
// consistent between the two masters (case, whitespace, singular/plural,
// near-synonyms), so matching is done in three tiers:
//   1. normalized-exact (trim/lowercase/collapse-whitespace/singularize)
//   2. normalized substring match, either direction
//   3. fallback to ALL vendors when nothing matches
// so the UI is never left empty.
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
    vendors = db.prepare(`SELECT * FROM vendors WHERE status = 'Active' OR status IS NULL ORDER BY name`).all();
    matchType = 'fallback';
  }
  vendors = vendors.map(v => Object.assign({}, v, { match_type: matchType }));
  res.json({ vendors, fallback });
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
  const updateVendorRow = db.prepare(`UPDATE rfq_request_vendors SET email_status=?, email_error=?, sent_at=? WHERE id=?`);
  const insertEmailRow = db.prepare(`INSERT INTO rfq_request_emails (rfq_request_id, email, email_status) VALUES (?,?,'Pending')`);
  const updateEmailRow = db.prepare(`UPDATE rfq_request_emails SET email_status=?, email_error=?, sent_at=? WHERE id=?`);
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
      updateVendorRow.run('Sent', null, now(), rowId);
      results.push({ vendor_id: vendor.id, vendor_name: vendor.name, email_status: 'Sent' });
    } else {
      updateVendorRow.run('Failed', result.reason || 'Unknown error', null, rowId);
      results.push({ vendor_id: vendor.id, vendor_name: vendor.name, email_status: 'Failed', email_error: result.reason });
    }
  }
  for (const email of extraEmails) {
    const rowId = insertEmailRow.run(rfqId, email).lastInsertRowid;
    // No vendor name to personalize with for a manually-typed address.
    const personalizedBody = body.split('{{vendor_name}}').join('');
    const result = await sendMail({ to: email, subject: subject.trim(), text: personalizedBody, ...fromIdentity });
    if (result.sent) {
      updateEmailRow.run('Sent', null, now(), rowId);
      results.push({ email, email_status: 'Sent' });
    } else {
      updateEmailRow.run('Failed', result.reason || 'Unknown error', null, rowId);
      results.push({ email, email_status: 'Failed', email_error: result.reason });
    }
  }
  res.json({ id: rfqId, results });
});

// ---- Submit a high-value (quotes-required) PR into the normal approval chain ----
router.post('/requests/:id/submit-for-approval', requirePermission('purchase_request.create', 'purchase_order.manage'), (req, res) => {
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  if (!pr.quotes_required) return res.status(400).json({ error: 'This request does not require vendor quotes.' });
  if (pr.status !== 'PendingQuotes') return res.status(400).json({ error: 'This request has already been submitted for approval.' });
  const quoteCount = db.prepare('SELECT COUNT(*) as c FROM purchase_request_quotes WHERE purchase_request_id = ?').get(pr.id).c;
  if (quoteCount < 2) return res.status(400).json({ error: `At least 2 vendor quotes are required before submitting for approval - only ${quoteCount} on file.` });
  const totalValue = db.prepare('SELECT COALESCE(SUM(estimated_value), 0) as t FROM purchase_request_items WHERE purchase_request_id = ?').get(pr.id).t;
  const approvalId = approvals.startApproval('PurchaseRequest', 'purchase_request', pr.id, totalValue, req.user.id);
  db.prepare(`UPDATE purchase_requests SET approval_id = ?, status = 'Pending' WHERE id = ?`).run(approvalId, pr.id);
  res.json({ ok: true });
});

router.put('/requests/:id', requirePermission('purchase_request.create', 'job_card.manage', 'purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.raised_by === req.user.id;
  const isPrivileged = req.user.role_name === 'Admin' || req.user.role_name === 'Management';
  if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Only the requester or Admin/Management can edit this.' });
  // A rejected request, or one a reviewer paused to ask for more info, stays
  // editable for its own requester (not just Admin/Management) so they can
  // fix/complete it and send it back, instead of having to raise a brand new
  // PR from scratch.
  if (!['Pending', 'Rejected', 'InfoRequested'].includes(existing.status) && !isPrivileged) {
    return res.status(400).json({ error: 'This request has already been actioned - only Admin/Management can still edit it.' });
  }
  const { project_id, items } = req.body;
  let resolved;
  if (items !== undefined) {
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item line.' });
    try {
      resolved = items.map(line => {
        const qty = Number(line.quantity);
        if (!qty || qty <= 0) throw new Error('Every line needs a quantity greater than 0.');
        const { itemId, wasAdhoc } = resolvePRLineItem(line, req.user.id);
        return { itemId, wasAdhoc, quantity: qty, estimatedValue: Number(line.estimated_value) || 0, itemText: line.item_text || null };
      });
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  const tx = db.transaction(() => {
    if (resolved) {
      db.prepare('DELETE FROM purchase_request_items WHERE purchase_request_id = ?').run(existing.id);
      const insertLine = db.prepare(`
        INSERT INTO purchase_request_items (purchase_request_id, item_id, item_text, quantity, estimated_value, sort_order)
        VALUES (?,?,?,?,?,?)
      `);
      resolved.forEach((l, i) => {
        insertLine.run(existing.id, l.itemId, l.itemText, l.quantity, l.estimatedValue, i);
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

// ---- Purchase Orders ----
router.get('/orders', (req, res) => {
  res.json(db.prepare(`
    SELECT po.*, v.name as vendor_name, i.name as item_name, ca.label as company_address_label, ca.address_type as company_address_type,
      COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm WHERE sm.movement_type = 'IN' AND sm.reference = 'PO#' || po.id), 0) as received_qty
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id LEFT JOIN items i ON i.id = po.item_id
    LEFT JOIN company_addresses ca ON ca.id = po.company_address_id
    ORDER BY po.id DESC
  `).all());
});
router.post('/orders', requirePermission('purchase_order.manage'), (req, res) => {
  const { purchase_request_id, purchase_request_item_id, vendor_id, item_id, quantity, rate, hsn_code, gst_rate, terms, delivery_date, company_address_id } = req.body;
  // Validate references before hitting the DB - an empty/missing vendor or
  // item (e.g. no vendors created yet, or a stale item id) otherwise surfaces
  // as a raw "FOREIGN KEY constraint failed" 500, which reads as "Request
  // failed" in the UI with no clue what actually went wrong.
  if (!vendor_id) return res.status(400).json({ error: 'Pick a vendor. If none exist yet, add one under Vendor Master first.' });
  const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendor_id);
  if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists - refresh the page and pick a vendor again.' });
  if (item_id) {
    const item = db.prepare('SELECT id FROM items WHERE id = ?').get(item_id);
    if (!item) return res.status(400).json({ error: 'That item no longer exists - refresh the page and pick an item again.' });
  }
  if (company_address_id) {
    const addr = db.prepare('SELECT id FROM company_addresses WHERE id = ?').get(company_address_id);
    if (!addr) return res.status(400).json({ error: 'That company address no longer exists - refresh the page and pick one again.' });
  }
  if (!quantity || Number(quantity) <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (!rate || Number(rate) <= 0) return res.status(400).json({ error: 'Enter a rate greater than 0.' });
  const poNo = 'PO-' + Date.now();
  const total = quantity * rate;
  const gstRate = gst_rate !== undefined && gst_rate !== '' ? Number(gst_rate) : 18;
  const gstAmount = total * gstRate / 100;
  const info = db.prepare(`
    INSERT INTO purchase_orders (po_no, purchase_request_id, purchase_request_item_id, vendor_id, item_id, quantity, rate, total_value, created_by,
      hsn_code, gst_rate, gst_amount, terms, delivery_date, company_address_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(poNo, purchase_request_id || null, purchase_request_item_id || null, vendor_id, item_id || null, quantity, rate, total, req.user.id,
    hsn_code || null, gstRate, gstAmount, terms || null, delivery_date || null, company_address_id || null);
  if (purchase_request_id) db.prepare(`UPDATE purchase_requests SET status = 'OrderPlaced' WHERE id = ?`).run(purchase_request_id);
  res.json({ id: info.lastInsertRowid, po_no: poNo });
});

// Commercial terms (Round 16): LD clause (delivery_date already exists on
// purchase_orders from Round 5 and doubles as the promised delivery date).
router.patch('/orders/:id/commercial-terms', requirePermission('purchase_order.manage'), (req, res) => {
  const order = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { delivery_date, ld_percentage, ld_cap_percentage, ld_trigger_notes } = req.body;
  db.prepare(`
    UPDATE purchase_orders SET delivery_date = COALESCE(?, delivery_date), ld_percentage = ?, ld_cap_percentage = ?, ld_trigger_notes = ?
    WHERE id = ?
  `).run(delivery_date || null, ld_percentage || null, ld_cap_percentage || null, ld_trigger_notes || null, req.params.id);
  res.json({ ok: true });
});

const PO_EDIT_FIELDS = ['vendor_id', 'item_id', 'quantity', 'rate', 'hsn_code', 'gst_rate', 'terms', 'delivery_date', 'company_address_id'];
const PO_EDIT_LABELS = { vendor_id: 'Vendor', item_id: 'Item', quantity: 'Qty', rate: 'Rate', hsn_code: 'HSN', gst_rate: 'GST %', terms: 'Terms', delivery_date: 'Delivery date', company_address_id: 'Our address' };
function poAuditLog(userId, action, poId, details) {
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)`)
    .run(userId, action, 'purchase_order', poId, details || null);
}
router.put('/orders/:id', requirePermission('purchase_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (['Received', 'Cancelled'].includes(existing.status)) {
    return res.status(400).json({ error: `This order is already ${existing.status} and can no longer be edited.` });
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
    if (!addr) return res.status(400).json({ error: 'That company address no longer exists - refresh the page and pick one again.' });
  }
  const quantity = req.body.quantity !== undefined ? Number(req.body.quantity) : existing.quantity;
  const rate = req.body.rate !== undefined ? Number(req.body.rate) : existing.rate;
  if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (!rate || rate <= 0) return res.status(400).json({ error: 'Enter a rate greater than 0.' });
  const gstRate = req.body.gst_rate !== undefined && req.body.gst_rate !== '' ? Number(req.body.gst_rate) : existing.gst_rate;
  const total = quantity * rate;
  const gstAmount = total * (gstRate || 0) / 100;

  const changes = [];
  PO_EDIT_FIELDS.forEach(f => {
    if (req.body[f] === undefined) return;
    const newVal = req.body[f] || null;
    const oldVal = existing[f];
    if (String(oldVal || '') !== String(newVal || '')) changes.push(`${PO_EDIT_LABELS[f]}: ${oldVal || '-'} -> ${newVal || '-'}`);
  });

  db.prepare(`
    UPDATE purchase_orders SET vendor_id=?, item_id=?, quantity=?, rate=?, total_value=?, hsn_code=?, gst_rate=?, gst_amount=?, terms=?, delivery_date=?, company_address_id=?
    WHERE id=?
  `).run(
    req.body.vendor_id !== undefined ? req.body.vendor_id : existing.vendor_id,
    req.body.item_id !== undefined ? (req.body.item_id || null) : existing.item_id,
    quantity, rate, total,
    req.body.hsn_code !== undefined ? (req.body.hsn_code || null) : existing.hsn_code,
    gstRate, gstAmount,
    req.body.terms !== undefined ? (req.body.terms || null) : existing.terms,
    req.body.delivery_date !== undefined ? (req.body.delivery_date || null) : existing.delivery_date,
    req.body.company_address_id !== undefined ? (req.body.company_address_id || null) : existing.company_address_id,
    existing.id
  );
  if (changes.length) poAuditLog(req.user.id, 'po_edit', existing.id, changes.join('; '));
  res.json({ ok: true });
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
const PO_IMPORT_COLUMNS = ['po_no', 'vendor_name', 'item_code_or_barcode', 'quantity', 'rate', 'hsn_code', 'gst_rate', 'delivery_date', 'terms', 'status', 'po_date', 'bill_ship_address'];
router.get('/orders/import-template', requirePermission('purchase_order.manage'), (req, res) => {
  const exampleRow = {
    po_no: 'PO-LEGACY-1024', vendor_name: 'Acme Steel Traders', item_code_or_barcode: 'ITM-1001', quantity: 50, rate: 250,
    hsn_code: '7208', gst_rate: 18, delivery_date: '2025-06-30', terms: 'Standard terms apply', status: 'Open', po_date: '2025-04-01',
    bill_ship_address: 'Head Office',
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
    ['bill_ship_address is optional - matched by its Label in Company Settings > Bill-To/Ship-To Addresses (case-insensitive); leave blank to import without one.'],
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
      hsn_code, gst_rate, gst_amount, terms, delivery_date, created_at, company_address_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    const addressLabel = String(row.bill_ship_address || '').trim();
    let addressId = null;
    if (addressLabel) {
      const addr = findAddressByLabel.get(addressLabel);
      if (!addr) { warnings.push(`Row ${rowNum}: no Bill-To/Ship-To address matches "${addressLabel}" - imported without one.`); }
      else addressId = addr.id;
    }
    const gstRate = row.gst_rate !== '' && row.gst_rate !== undefined ? Number(row.gst_rate) : 18;
    const total = qty * rate;
    const gstAmount = total * (gstRate || 0) / 100;
    // Match SQLite's own CURRENT_TIMESTAMP format ('YYYY-MM-DD HH:MM:SS') so
    // an imported row sorts/compares consistently against natively-created
    // ones rather than mixing in ISO8601 with a 'T'/'Z'.
    const poDate = String(row.po_date || '').trim();
    const createdAt = poDate ? poDate + ' 00:00:00' : new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    insertPO.run(poNo, vendor.id, item.id, qty, rate, total, status, req.user.id,
      String(row.hsn_code || '') || null, gstRate, gstAmount, String(row.terms || '') || null,
      String(row.delivery_date || '') || null, createdAt, addressId);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors, warnings });
});

// ---- Store: GRN receive & issue to production ----
// A PO's own `quantity` is the ordered amount; how much has actually come
// in is derived from stock_movements (movement_type='IN', reference =
// 'PO#'+id) rather than stored redundantly on the PO row - same "derive,
// don't duplicate" reasoning as everywhere else in this codebase that
// tracks a running total against a source document.
function poReceivedQty(poId) {
  return db.prepare(`SELECT COALESCE(SUM(quantity), 0) as n FROM stock_movements WHERE movement_type = 'IN' AND reference = ?`).get('PO#' + poId).n;
}
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
  const { item_id, quantity, project_id } = req.body;
  if (!item_id) return res.status(400).json({ error: 'Pick an item. If the Item Master is empty, add one there first.' });
  if (!quantity || Number(quantity) <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(item_id);
  if (!item) return res.status(400).json({ error: 'That item no longer exists - refresh the page and pick an item again.' });
  if (item.current_stock < quantity) return res.status(400).json({ error: `Insufficient stock - only ${item.current_stock} ${item.unit || ''} available.` });
  if (project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(400).json({ error: 'That project no longer exists - refresh the page and try again.' });
  }
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, moved_by) VALUES (?, 'OUT', ?, ?, ?, ?)`)
      .run(item_id, quantity, project_id ? 'Project#' + project_id : null, project_id || null, req.user.id);
    db.prepare(`UPDATE items SET current_stock = current_stock - ? WHERE id = ?`).run(quantity, item_id);
  });
  tx();
  res.json({ ok: true });
});

router.get('/store/movements', (req, res) => {
  res.json(db.prepare(`
    SELECT sm.*, i.name as item_name FROM stock_movements sm JOIN items i ON i.id = sm.item_id ORDER BY sm.id DESC LIMIT 200
  `).all());
});

const STOCK_TEMPLATE_COLUMNS = ['item_code_or_barcode', 'movement_type', 'quantity', 'po_no', 'reference'];
router.get('/store/movements/template', requirePermission('store.manage'), (req, res) => {
  const exampleRow = { item_code_or_barcode: 'ITM-1001', movement_type: 'IN', quantity: 50, po_no: 'PO-1024', reference: 'GRN against PO-1024' };
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: STOCK_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'StockMovements');
  const note = XLSX.utils.aoa_to_sheet([['Notes'],
    ['movement_type must be IN (stock received) or OUT (issued to production).'],
    ['item_code_or_barcode can be either the item\'s Item Code or its printed barcode number.'],
    ['po_no is optional and only applies to IN movements - when it matches an open Purchase Order, this receipt counts toward that PO\'s received quantity and updates its status (Open/PartiallyReceived/Received), same as receiving against it from the Purchase Orders page.'],
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
  const findPoByNo = db.prepare('SELECT * FROM purchase_orders WHERE po_no = ?');
  const insertMove = db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, moved_by) VALUES (?,?,?,?,?)`);
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
      const poNo = String(row.po_no || '').trim();
      let po = null;
      let reference = String(row.reference || '') || null;
      if (poNo) {
        if (type !== 'IN') {
          warnings.push(`Row ${rowNum}: po_no is only applied to IN movements - ignored for this OUT row.`);
        } else {
          po = findPoByNo.get(poNo);
          if (!po) { warnings.push(`Row ${rowNum}: no Purchase Order matches "${poNo}" - imported without linking to a PO.`); }
          else if (['Received', 'Cancelled', 'Closed'].includes(po.status)) {
            warnings.push(`Row ${rowNum}: PO "${poNo}" is already ${po.status} - imported without linking to it.`);
            po = null;
          } else {
            reference = 'PO#' + po.id;
          }
        }
      }
      insertMove.run(item.id, type, qty, reference, req.user.id);
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
    res.download(gen.outPath, `${challan.challan_no}.pdf`, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Purchase Order: PDF / Word / Email to vendor ----
function loadPoBundle(id) {
  const po = db.prepare(`
    SELECT po.*, i.name as item_name FROM purchase_orders po LEFT JOIN items i ON i.id = po.item_id WHERE po.id = ?
  `).get(id);
  if (!po) return null;
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(po.vendor_id);
  const companyAddress = po.company_address_id
    ? db.prepare('SELECT * FROM company_addresses WHERE id = ?').get(po.company_address_id)
    : null;
  return { po, vendor, companyAddress };
}

router.get('/orders/:id/pdf', async (req, res) => {
  const bundle = loadPoBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  try {
    const gen = await generatePoPdf(bundle.po, bundle.vendor || {}, getCompanySettings(), bundle.companyAddress);
    res.download(gen.outPath, `${bundle.po.po_no}.pdf`, () => {
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
  try {
    const gen = await generatePoDocx(bundle.po, bundle.vendor || {}, getCompanySettings(), bundle.companyAddress);
    res.download(gen.outPath, `${bundle.po.po_no}.docx`, () => {
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
  const { po, vendor, companyAddress } = bundle;
  const toAddress = (vendor && (vendor.po_email || vendor.email)) || null;
  if (!toAddress) return res.status(400).json({ error: 'This vendor has no PO/document delivery email on file - add one under Vendor Master.' });
  let gen;
  try {
    gen = await generatePoPdf(po, vendor, getCompanySettings(), companyAddress);
    const pdfBuffer = fs.readFileSync(gen.outPath);
    const result = await sendMail({
      to: toAddress,
      subject: `Purchase Order ${po.po_no} - Venkateshwara Engineers`,
      text: `Dear ${vendor.contact_person || vendor.name},\n\nPlease find attached Purchase Order ${po.po_no}.\n\nRegards,\nVenkateshwara Engineers`,
      attachments: [{ filename: `${po.po_no}.pdf`, content: pdfBuffer }],
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

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
      (SELECT aa.comment FROM approval_actions aa JOIN approvals ap ON ap.id = aa.approval_id
        WHERE ap.entity_type = 'purchase_request' AND ap.entity_id = pr.id AND aa.action = 'Rejected'
        ORDER BY aa.acted_at DESC LIMIT 1) as rejection_reason,
      (SELECT ru.full_name FROM approval_actions aa JOIN approvals ap ON ap.id = aa.approval_id LEFT JOIN users ru ON ru.id = aa.actor_user_id
        WHERE ap.entity_type = 'purchase_request' AND ap.entity_id = pr.id AND aa.action = 'Rejected'
        ORDER BY aa.acted_at DESC LIMIT 1) as rejected_by_name,
      (SELECT aa.comment FROM approval_actions aa JOIN approvals ap ON ap.id = aa.approval_id
        WHERE ap.entity_type = 'purchase_request' AND ap.entity_id = pr.id AND aa.action = 'InfoRequested'
        ORDER BY aa.acted_at DESC LIMIT 1) as info_requested_note,
      (SELECT ru.full_name FROM approval_actions aa JOIN approvals ap ON ap.id = aa.approval_id LEFT JOIN users ru ON ru.id = aa.actor_user_id
        WHERE ap.entity_type = 'purchase_request' AND ap.entity_id = pr.id AND aa.action = 'InfoRequested'
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
    SELECT q.*, v.name as vendor_name, u.full_name as created_by_name
    FROM purchase_request_quotes q LEFT JOIN vendors v ON v.id = q.vendor_id LEFT JOIN users u ON u.id = q.created_by
    WHERE q.purchase_request_id = ? ORDER BY q.id DESC
  `).all(req.params.id));
});

router.post('/requests/:id/quotes', requirePermission('purchase_request.create', 'purchase_order.manage'), uploadQuote.single('quote_file'), (req, res) => {
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  const { vendor_id, quoted_amount, notes } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'Pick a vendor.' });
  const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendor_id);
  if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists.' });
  const filePath = req.file ? '/uploads/purchase-quotes/' + req.file.filename : null;
  const info = db.prepare(`
    INSERT INTO purchase_request_quotes (purchase_request_id, vendor_id, quoted_amount, quote_file_path, notes, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(pr.id, vendor_id, quoted_amount ? Number(quoted_amount) : null, filePath, notes || null, req.user.id);
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
    SELECT po.*, v.name as vendor_name, i.name as item_name FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id LEFT JOIN items i ON i.id = po.item_id
    ORDER BY po.id DESC
  `).all());
});
router.post('/orders', requirePermission('purchase_order.manage'), (req, res) => {
  const { purchase_request_id, purchase_request_item_id, vendor_id, item_id, quantity, rate, hsn_code, gst_rate, terms, delivery_date } = req.body;
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
  if (!quantity || Number(quantity) <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (!rate || Number(rate) <= 0) return res.status(400).json({ error: 'Enter a rate greater than 0.' });
  const poNo = 'PO-' + Date.now();
  const total = quantity * rate;
  const gstRate = gst_rate !== undefined && gst_rate !== '' ? Number(gst_rate) : 18;
  const gstAmount = total * gstRate / 100;
  const info = db.prepare(`
    INSERT INTO purchase_orders (po_no, purchase_request_id, purchase_request_item_id, vendor_id, item_id, quantity, rate, total_value, created_by,
      hsn_code, gst_rate, gst_amount, terms, delivery_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(poNo, purchase_request_id || null, purchase_request_item_id || null, vendor_id, item_id || null, quantity, rate, total, req.user.id,
    hsn_code || null, gstRate, gstAmount, terms || null, delivery_date || null);
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

// ---- Store: GRN receive & issue to production ----
router.post('/store/receive', requirePermission('store.manage'), (req, res) => {
  const { item_id, quantity, po_id, project_id } = req.body;
  // Validate before hitting the DB - an empty/missing item_id (e.g. the Item
  // Master has no approved items yet, or the picker was left blank) otherwise
  // surfaces as a raw "FOREIGN KEY constraint failed" 500 with no clue what
  // went wrong. Same class of bug as the earlier Purchase Order fix.
  if (!item_id) return res.status(400).json({ error: 'Pick an item. If the Item Master is empty, add one there first.' });
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(item_id);
  if (!item) return res.status(400).json({ error: 'That item no longer exists - refresh the page and pick an item again.' });
  if (!quantity || Number(quantity) <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (po_id) {
    const po = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(po_id);
    if (!po) return res.status(400).json({ error: 'That Purchase Order no longer exists - refresh the page and try again.' });
  }
  if (project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(400).json({ error: 'That project no longer exists - refresh the page and try again.' });
  }
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, project_id, moved_by) VALUES (?, 'IN', ?, ?, ?, ?)`)
      .run(item_id, quantity, po_id ? 'PO#' + po_id : null, project_id || null, req.user.id);
    db.prepare(`UPDATE items SET current_stock = current_stock + ? WHERE id = ?`).run(quantity, item_id);
    if (po_id) {
      db.prepare(`UPDATE purchase_orders SET status = 'Received' WHERE id = ?`).run(po_id);
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

const STOCK_TEMPLATE_COLUMNS = ['item_code_or_barcode', 'movement_type', 'quantity', 'reference'];
router.get('/store/movements/template', requirePermission('store.manage'), (req, res) => {
  const exampleRow = { item_code_or_barcode: 'ITM-1001', movement_type: 'IN', quantity: 50, reference: 'GRN against PO-1024' };
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: STOCK_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'StockMovements');
  const note = XLSX.utils.aoa_to_sheet([['Notes'],
    ['movement_type must be IN (stock received) or OUT (issued to production).'],
    ['item_code_or_barcode can be either the item\'s Item Code or its printed barcode number.']]);
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
  const insertMove = db.prepare(`INSERT INTO stock_movements (item_id, movement_type, quantity, reference, moved_by) VALUES (?,?,?,?,?)`);
  const adjustStock = db.prepare('UPDATE items SET current_stock = current_stock + ? WHERE id = ?');
  let inserted = 0; const errors = [];
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
    insertMove.run(item.id, type, qty, String(row.reference || '') || null, req.user.id);
    adjustStock.run(type === 'IN' ? qty : -qty, item.id);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors });
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
  return { po, vendor };
}

router.get('/orders/:id/pdf', async (req, res) => {
  const bundle = loadPoBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  try {
    const gen = await generatePoPdf(bundle.po, bundle.vendor || {}, getCompanySettings());
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
    const gen = await generatePoDocx(bundle.po, bundle.vendor || {}, getCompanySettings());
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
  const { po, vendor } = bundle;
  const toAddress = (vendor && (vendor.po_email || vendor.email)) || null;
  if (!toAddress) return res.status(400).json({ error: 'This vendor has no PO/document delivery email on file - add one under Vendor Master.' });
  let gen;
  try {
    gen = await generatePoPdf(po, vendor, getCompanySettings());
    const pdfBuffer = fs.readFileSync(gen.outPath);
    const result = await sendMail({
      to: toAddress,
      subject: `Purchase Order ${po.po_no} - Venkateshwara Engineers`,
      text: `Dear ${vendor.contact_person || vendor.name},\n\nPlease find attached Purchase Order ${po.po_no}.\n\nRegards,\nVenkateshwara Engineers`,
      attachments: [{ filename: `${po.po_no}.pdf`, content: pdfBuffer }],
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

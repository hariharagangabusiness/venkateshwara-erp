const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requirePermission, requireRole } = require('../middleware/auth');
const approvals = require('../lib/approvals');
const { generateInvoicePdf } = require('../lib/invoicePdf');
const { generateProformaInvoicePdf } = require('../lib/proformaInvoicePdf');
const { generateFocAnnexurePdf } = require('../lib/focAnnexurePdf');
const { autoCompleteSystemTodos } = require('../lib/systemTodos');
const { getCompanySettings } = require('../lib/settings');
const { sendMail } = require('../lib/mailer');
const { getDepartmentEmailIdentity } = require('../lib/departmentEmail');
const { buildDownloadFilename, buildVersionStamp } = require('../lib/downloadFilename');
const { poReceivedQty } = require('../lib/purchaseOrders');
const { oversightDepartmentIds } = require('../lib/roleOversight');
const { computeVendorLedger } = require('../lib/vendorLedger');
const { generateVendorLedgerPdf } = require('../lib/vendorLedgerPdf');
const { makeUpload } = require('../lib/upload');
const router = express.Router();
router.use(authRequired);

const uploadExpense = makeUpload('expenses', 15);

// ---- Expense Vouchers (Operation Expenses, cash vs accounted) ----
// Unscoped, this grows without bound as vouchers pile up, so a call with no
// from/to/status filter (i.e. the plain browse list, not a targeted query
// like "all Pending vouchers" or an explicit date range) defaults to the
// current month server-side - same convention as Operating Expenses.
// ?month=YYYY-MM asks for a specific month; ?month=all is the explicit
// opt-out to fetch full history.
router.get('/expense-vouchers', (req, res) => {
  const { department_id, accounted, status, from, to, month } = req.query;
  let q = `
    SELECT ev.*, d.name as department_name, c.name as category_name, u.full_name as raised_by_name
    FROM expense_vouchers ev
    LEFT JOIN departments d ON d.id = ev.department_id
    LEFT JOIN expense_categories c ON c.id = ev.category_id
    LEFT JOIN users u ON u.id = ev.raised_by
    WHERE 1=1
  `;
  const params = [];
  if (department_id) { q += ' AND ev.department_id = ?'; params.push(department_id); }
  if (accounted) { q += ' AND ev.accounted = ?'; params.push(accounted); }
  if (status) { q += ' AND ev.status = ?'; params.push(status); }
  if (from) { q += ' AND ev.voucher_date >= ?'; params.push(from); }
  if (to) { q += ' AND ev.voucher_date <= ?'; params.push(to); }
  if (!from && !to && !status && month !== 'all') {
    const m = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date().toISOString().slice(0, 7);
    q += ' AND ev.voucher_date LIKE ?';
    params.push(m + '%');
  }
  q += ' ORDER BY ev.id DESC';
  res.json(db.prepare(q).all(...params));
});

// Submitter-facing view (2026-10-12, requested directly by the owner) -
// every employee can see their own vouchers and full status regardless of
// whether they hold expense_voucher.view_all, which the plain list above
// has never required either (deliberately - Finance needed everyone to be
// able to raise one, and the unscoped GET above was already reachable by
// anyone logged in; this just adds the filtered "mine" shape on top rather
// than opening up anything new). A supervisor (any department, not just
// Accounts) additionally gets `department`: every voucher raised against
// their own department or one they've been granted oversight of (same
// lib/roleOversight.js model Todos/Salary Report already use) - scoped by
// the voucher's own department_id, not the raiser's personal department,
// since that's the field actually captured on the form. Registered ahead
// of the :id route below (this app's own recurring route-shadowing bug
// class) so "mine" is never swallowed by it.
router.get('/expense-vouchers/mine', (req, res) => {
  const own = db.prepare(`
    SELECT ev.*, d.name as department_name, c.name as category_name, u.full_name as raised_by_name
    FROM expense_vouchers ev
    LEFT JOIN departments d ON d.id = ev.department_id
    LEFT JOIN expense_categories c ON c.id = ev.category_id
    LEFT JOIN users u ON u.id = ev.raised_by
    WHERE ev.raised_by = ?
    ORDER BY ev.id DESC
  `).all(req.user.id);
  let department = [];
  if (req.user.is_supervisor) {
    const deptIds = Array.from(new Set([req.user.department_id, ...oversightDepartmentIds(db, req.user.id)].filter(Boolean)));
    if (deptIds.length) {
      const placeholders = deptIds.map(() => '?').join(',');
      department = db.prepare(`
        SELECT ev.*, d.name as department_name, c.name as category_name, u.full_name as raised_by_name
        FROM expense_vouchers ev
        LEFT JOIN departments d ON d.id = ev.department_id
        LEFT JOIN expense_categories c ON c.id = ev.category_id
        LEFT JOIN users u ON u.id = ev.raised_by
        WHERE ev.department_id IN (${placeholders})
        ORDER BY ev.id DESC
      `).all(...deptIds);
    }
  }
  res.json({ own, department });
});

// Admin-maintained Expense Voucher category -> Operating Expense category
// mapping, used by Mark Paid below to know which Operating Expense category
// an auto-created entry should land in. Registered ahead of the :id route
// below for the same route-shadowing reason as /mine above.
router.get('/expense-vouchers/category-oe-map', requireRole('Admin'), (req, res) => {
  res.json(db.prepare(`
    SELECT ec.id as expense_category_id, ec.name as expense_category_name,
      m.operating_expense_category_id, oc.name as operating_expense_category_name
    FROM expense_categories ec
    LEFT JOIN expense_category_oe_map m ON m.expense_category_id = ec.id
    LEFT JOIN operating_expense_categories oc ON oc.id = m.operating_expense_category_id
    ORDER BY ec.sort_order, ec.name
  `).all());
});
router.put('/expense-vouchers/category-oe-map/:expenseCategoryId', requireRole('Admin'), (req, res) => {
  const { operating_expense_category_id } = req.body;
  if (!operating_expense_category_id) return res.status(400).json({ error: 'Pick an Operating Expense category.' });
  const oeCat = db.prepare('SELECT id FROM operating_expense_categories WHERE id = ?').get(operating_expense_category_id);
  if (!oeCat) return res.status(400).json({ error: 'Operating Expense category not found.' });
  db.prepare(`
    INSERT INTO expense_category_oe_map (expense_category_id, operating_expense_category_id) VALUES (?, ?)
    ON CONFLICT(expense_category_id) DO UPDATE SET operating_expense_category_id = excluded.operating_expense_category_id
  `).run(req.params.expenseCategoryId, operating_expense_category_id);
  res.json({ ok: true });
});

// Single-record lookup for drill-downs (e.g. an approval-history detail
// view) that need one specific voucher regardless of which month it falls
// in - the plain list above is month-scoped by default, so it can't be
// used to look up an older voucher by id.
router.get('/expense-vouchers/:id', (req, res) => {
  const row = db.prepare(`
    SELECT ev.*, d.name as department_name, c.name as category_name, u.full_name as raised_by_name
    FROM expense_vouchers ev
    LEFT JOIN departments d ON d.id = ev.department_id
    LEFT JOIN expense_categories c ON c.id = ev.category_id
    LEFT JOIN users u ON u.id = ev.raised_by
    WHERE ev.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/expense-vouchers', requirePermission('expense_voucher.create'), uploadExpense.single('attachment'), (req, res) => {
  const { department_id, category_id, amount, payment_mode, accounted, description } = req.body;
  const voucherNo = 'EV-' + Date.now();
  const attachmentPath = req.file ? '/uploads/expenses/' + req.file.filename : null;
  const info = db.prepare(`
    INSERT INTO expense_vouchers (voucher_no, department_id, category_id, raised_by, amount, payment_mode, accounted, description, attachment_path)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(voucherNo, department_id, category_id, req.user.id, amount, payment_mode, accounted || 'Accounted', description, attachmentPath);
  const approvalId = approvals.startApproval('ExpenseVoucher', 'expense_voucher', info.lastInsertRowid, amount, req.user.id);
  db.prepare('UPDATE expense_vouchers SET approval_id = ? WHERE id = ?').run(approvalId, info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, voucher_no: voucherNo, approval_id: approvalId });
});

// Marking Paid now (2026-10-12, requested directly by the owner) requires a
// payment reference (UTR/cheque no./transaction id - whatever the actual
// settlement is identified by) and auto-creates the matching Operating
// Expense entry, via the Admin-maintained category mapping above - these
// are two previously-separate, parallel features (see this file's own
// GET /operating-expenses route) that had no linkage at all; this is the
// one place they now connect. The voucher's own direct 'Expense'
// finance_ledger entry is deliberately dropped in favor of the Operating
// Expense's 'OperatingExpense' entry (inserted just below) - keeping both
// would double-count this payment in every Finance Ledger / cash-outflow
// report, since the auto-created Operating Expense row is now the single
// authoritative record of the actual spend.
router.post('/expense-vouchers/:id/mark-paid', requirePermission('expense_voucher.approve'), (req, res) => {
  const row = db.prepare('SELECT * FROM expense_vouchers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'Approved') return res.status(400).json({ error: 'Must be Approved first' });
  const paymentReference = String((req.body && req.body.payment_reference) || '').trim();
  if (!paymentReference) return res.status(400).json({ error: 'Enter a payment reference (UTR / cheque no. / transaction id).' });
  const mapRow = row.category_id ? db.prepare(`
    SELECT oc.id, oc.name FROM expense_category_oe_map m
    JOIN operating_expense_categories oc ON oc.id = m.operating_expense_category_id
    WHERE m.expense_category_id = ?
  `).get(row.category_id) : null;
  if (!mapRow) {
    const catName = row.category_id ? (db.prepare('SELECT name FROM expense_categories WHERE id = ?').get(row.category_id) || {}).name : null;
    return res.status(400).json({ error: `No Operating Expense category mapped for "${catName || 'this voucher\'s category'}" yet - an Admin needs to map it under Expense Vouchers > Operating Expense Category Mapping first.` });
  }
  const deptName = row.department_id ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(row.department_id) || {}).name : null;
  const oeDescription = `${row.voucher_no}${deptName ? ' (' + deptName + ')' : ''}${row.description ? ' - ' + row.description : ''}`;
  const tx = db.transaction(() => {
    const oeInfo = db.prepare(`
      INSERT INTO operating_expenses (expense_date, category, description, amount, paid_via, created_by)
      VALUES (CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
    `).run(mapRow.name, oeDescription, row.amount, row.payment_mode, req.user.id);
    db.prepare(`
      UPDATE expense_vouchers SET status = 'Paid', payment_reference = ?, paid_at = CURRENT_TIMESTAMP, operating_expense_id = ? WHERE id = ?
    `).run(paymentReference, oeInfo.lastInsertRowid, row.id);
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, department_id, amount, direction, description, created_by)
      VALUES ('OperatingExpense', 'operating_expenses', ?, ?, ?, 'Outflow', ?, ?)
    `).run(oeInfo.lastInsertRowid, row.department_id, row.amount, oeDescription, req.user.id);
  });
  try { tx(); } catch (e) { return res.status(500).json({ error: 'Failed to mark paid: ' + e.message }); }
  res.json({ ok: true });
});

// Cash vs Accounted summary report
router.get('/expense-summary', requirePermission('report.view_all', 'expense_voucher.view_all'), (req, res) => {
  const { from, to } = req.query;
  let q = `SELECT accounted, payment_mode, COALESCE(c.name,'Uncategorized') as category, SUM(amount) as total, COUNT(*) as count
    FROM expense_vouchers ev LEFT JOIN expense_categories c ON c.id = ev.category_id
    WHERE status != 'Rejected'`;
  const params = [];
  if (from) { q += ' AND voucher_date >= ?'; params.push(from); }
  if (to) { q += ' AND voucher_date <= ?'; params.push(to); }
  q += ' GROUP BY accounted, payment_mode, category ORDER BY total DESC';
  res.json(db.prepare(q).all(...params));
});

// ---- Free of Cost (FOC) material issue ----
// Requested by a department HOD/Supervisor (linked to a sales order/project
// wherever possible), approved or rejected by a Management login (or Admin).
// A "request" is still stored as one foc_requests row per line item (no
// separate foc_request_items table - same "several rows, one shared
// document number" shape multi-line Purchase Orders already use for po_no,
// see db/index.js's migrateFocRequestsDropFocNoUnique()), several rows
// sharing one foc_no for a multi-item request (2026-10-13). Approve/Reject/
// Issue below all act on the whole foc_no group at once - one decision, one
// fulfilling department, for every line - never per line.
router.get('/foc', (req, res) => {
  res.json(db.prepare(`
    SELECT f.*, so.order_no, p.project_code, d.name as department_name,
      u.full_name as requested_by_name, a.full_name as approved_by_name,
      c.name as client_master_name, fd.name as fulfilling_department_name,
      iu.full_name as issued_by_name
    FROM foc_requests f
    LEFT JOIN sales_orders so ON so.id = f.sales_order_id
    LEFT JOIN projects p ON p.id = f.project_id
    LEFT JOIN departments d ON d.id = f.department_id
    LEFT JOIN users u ON u.id = f.requested_by
    LEFT JOIN users a ON a.id = f.approved_by
    LEFT JOIN clients c ON c.id = f.client_id
    LEFT JOIN departments fd ON fd.id = f.fulfilling_department_id
    LEFT JOIN users iu ON iu.id = f.issued_by
    ORDER BY f.id DESC
  `).all());
});

// Accepts either the current multi-line shape (`lines: [...]`, what the New
// FOC Material Request form's Add Line Item button sends) or the older
// single-item shape (item_description/quantity/unit/estimated_value at the
// top level, no `lines`) for any other caller - e.g. routes/sales.js's MRN
// "FOC Replacement" resolution, which inserts its own single-row request
// directly and never goes through this route at all. Both funnel into the
// same insert loop, mirroring routes/purchase.js's POST /orders exactly.
router.post('/foc', requirePermission('foc.request'), (req, res) => {
  if (req.user.role_name !== 'Admin' && !req.user.is_supervisor) {
    return res.status(403).json({ error: 'Only a department HOD/Supervisor (or Admin) can raise an FOC request.' });
  }
  const { sales_order_id, client_id, customer_name, contact_person, contact_phone, reason } = req.body;
  const lines = Array.isArray(req.body.lines) && req.body.lines.length
    ? req.body.lines
    : [{ item_description: req.body.item_description, quantity: req.body.quantity, unit: req.body.unit, estimated_value: req.body.estimated_value }];
  for (let i = 0; i < lines.length; i++) {
    if (!String(lines[i].item_description || '').trim()) {
      return res.status(400).json({ error: `${lines.length > 1 ? `Line ${i + 1}: ` : ''}describe the material being requested.` });
    }
  }
  let projectId = null;
  let clientId = client_id || null;
  if (sales_order_id) {
    const project = db.prepare('SELECT id FROM projects WHERE sales_order_id = ?').get(sales_order_id);
    if (project) projectId = project.id;
    // Customer is implied by the SO - same auto-derivation as project_id.
    const so = db.prepare('SELECT client_id FROM sales_orders WHERE id = ?').get(sales_order_id);
    if (so) clientId = so.client_id;
  } else if (!clientId && !String(customer_name || '').trim()) {
    return res.status(400).json({ error: 'Not linked to an order - pick a customer from Clients or type a customer name.' });
  }
  const focNo = 'FOC-' + Date.now();
  const insert = db.prepare(`
    INSERT INTO foc_requests (foc_no, sales_order_id, project_id, department_id, requested_by, client_id,
      customer_name, contact_person, contact_phone, item_description, quantity, unit, estimated_value, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const ids = [];
  db.transaction(() => {
    for (const l of lines) {
      const info = insert.run(focNo, sales_order_id || null, projectId, req.user.department_id, req.user.id, clientId,
        sales_order_id ? null : (customer_name || null), contact_person || null, contact_phone || null,
        l.item_description, l.quantity || 1, l.unit || 'Nos', l.estimated_value || 0, reason || null);
      ids.push(info.lastInsertRowid);
    }
  })();
  res.json({ ids, id: ids[0], foc_no: focNo });
});

// Adding a line to an already-raised request - only while it's still
// Pending (per the owner's locked design: once Management has decided,
// the set of items they decided on shouldn't change - raise a new FOC
// request for anything further, same spirit as Purchase Orders' own
// Add Line Item lock). requested_by on the new row is deliberately kept as
// the ORIGINAL requester's (not whoever happens to be adding the line),
// since every line in one foc_no group represents one person's one request.
router.post('/foc/:id/add-line', requirePermission('foc.request', 'foc.approve'), (req, res) => {
  const existing = db.prepare('SELECT * FROM foc_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.requested_by === req.user.id;
  const isPrivileged = req.user.role_name === 'Admin' || req.user.role_name === 'Management';
  if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Only the requester or Management can add items to this request.' });
  if (existing.status !== 'Pending') {
    return res.status(400).json({ error: 'Items can only be added while this request is still Pending - once a decision has been made, raise a new FOC request for anything further.' });
  }
  const { item_description, quantity, unit, estimated_value } = req.body;
  if (!String(item_description || '').trim()) return res.status(400).json({ error: 'Describe the material being requested.' });
  const info = db.prepare(`
    INSERT INTO foc_requests (foc_no, sales_order_id, project_id, department_id, requested_by, client_id,
      customer_name, contact_person, contact_phone, item_description, quantity, unit, estimated_value, reason, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Pending')
  `).run(existing.foc_no, existing.sales_order_id, existing.project_id, existing.department_id, existing.requested_by, existing.client_id,
    existing.customer_name, existing.contact_person, existing.contact_phone,
    item_description, quantity || 1, unit || 'Nos', estimated_value || 0, existing.reason);
  res.json({ id: info.lastInsertRowid, foc_no: existing.foc_no });
});

// All fields stay editable - by whoever raised it, or Admin/Management -
// for as long as the request hasn't been finally approved/rejected/issued.
router.put('/foc/:id', requirePermission('foc.request', 'foc.approve'), (req, res) => {
  const existing = db.prepare('SELECT * FROM foc_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = existing.requested_by === req.user.id;
  const isPrivileged = req.user.role_name === 'Admin' || req.user.role_name === 'Management';
  if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Only the requester or Management can edit this.' });
  if (existing.status !== 'Pending' && !isPrivileged) {
    return res.status(400).json({ error: 'This request has already been actioned - only Management/Admin can still edit it.' });
  }
  const { sales_order_id, client_id, customer_name, contact_person, contact_phone, item_description, quantity, unit, estimated_value, reason } = req.body;
  let projectId = existing.project_id;
  let clientId = client_id !== undefined ? (client_id || null) : existing.client_id;
  if (sales_order_id !== undefined) {
    const project = sales_order_id ? db.prepare('SELECT id FROM projects WHERE sales_order_id = ?').get(sales_order_id) : null;
    projectId = project ? project.id : null;
    if (sales_order_id) {
      const so = db.prepare('SELECT client_id FROM sales_orders WHERE id = ?').get(sales_order_id);
      clientId = so ? so.client_id : null;
    }
  }
  db.prepare(`
    UPDATE foc_requests SET sales_order_id=?, project_id=?, client_id=?, customer_name=?, contact_person=?, contact_phone=?,
      item_description=?, quantity=?, unit=?, estimated_value=?, reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(
    sales_order_id !== undefined ? (sales_order_id || null) : existing.sales_order_id, projectId, clientId,
    sales_order_id !== undefined && sales_order_id ? null : (customer_name !== undefined ? customer_name : existing.customer_name),
    contact_person !== undefined ? contact_person : existing.contact_person,
    contact_phone !== undefined ? contact_phone : existing.contact_phone,
    item_description !== undefined ? item_description : existing.item_description,
    quantity !== undefined ? quantity : existing.quantity,
    unit !== undefined ? unit : existing.unit,
    estimated_value !== undefined ? estimated_value : existing.estimated_value,
    reason !== undefined ? reason : existing.reason,
    existing.id
  );
  res.json({ ok: true });
});

// "HOD of department X" - same is_supervisor/is_active convention used
// throughout the app (lib/bgReminderScan.js, routes/todos.js), scoped by
// department_id rather than role name since the fulfilling department can
// be any department, not one hardcoded finance-ops role.
function departmentHOD(departmentId) {
  return db.prepare(`
    SELECT id FROM users WHERE department_id = ? AND is_supervisor = 1 AND is_active = 1 ORDER BY id LIMIT 1
  `).get(departmentId);
}
// Same lightweight inline-permission-check idiom as routes/approvals.js's
// userHasPermission - usable inside a handler whose authorization depends
// on the row being acted on, not just the route itself.
function userHasPermission(user, ...codes) {
  if (user.role_name === 'Admin') return true;
  const rows = db.prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?
  `).all(user.role_id);
  const granted = new Set(rows.map(r => r.code));
  return codes.some(c => granted.has(c));
}
// Approving an FOC request fires an in-app to-do + notification for the
// fulfilling department's HOD, so nobody needs to be told by paper slip or
// email that free material is waiting on them to issue - the whole
// "eliminate the paper/email trail" point of this workflow. Covers every
// item in the group in one combined To-Do (2026-10-13) - a multi-item
// request is one hand-off to the fulfilling department, not one per line.
function notifyFocRouted(focNo, items, departmentId) {
  const hod = departmentHOD(departmentId);
  if (!hod) return; // no active supervisor on file for that department yet - skip silently, same as bgReminderScan.js's equivalent guard
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const brief = `Issue FOC material - ${focNo}${items.length > 1 ? ` (${items.length} items)` : ''}`;
  const itemsList = items.map(it => `${it.item_description} (Qty: ${it.quantity} ${it.unit})`).join('; ');
  const info = db.prepare(`
    INSERT INTO todos (hod_id, assigned_to, start_date, target_date, brief_description, details, priority, source_type, source_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(hod.id, hod.id, today, dueDate, brief,
    `${itemsList}. Approved for free issue - print the Annexure from the FOC Material Issue page and hand it over with the material.`,
    'High', 'FOC_ROUTED', items[0].id);
  db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`)
    .run(hod.id, 'TODO_ASSIGNED', info.lastInsertRowid, `New To-Do assigned to you: ${brief}`);
}

// Approve/Reject/Issue all act on the WHOLE foc_no group at once (every row
// sharing the clicked line's foc_no), not just the one row clicked -
// Management makes one decision and picks one fulfilling department for the
// entire request, same as a multi-line Purchase Order's own group-wide
// approval. `existing` (found by the clicked id) only supplies which group
// to act on; the actual UPDATE and notification cover every sibling line.
router.post('/foc/:id/approve', requirePermission('foc.approve'), (req, res) => {
  const existing = db.prepare('SELECT * FROM foc_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'Pending') return res.status(400).json({ error: 'This request has already been actioned.' });
  const departmentId = Number(req.body.fulfilling_department_id) || null;
  if (!departmentId) return res.status(400).json({ error: 'Pick which department will issue this material before approving.' });
  const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
  if (!dept) return res.status(400).json({ error: 'That department no longer exists.' });
  const tx = db.transaction(() => {
    const items = db.prepare(`SELECT * FROM foc_requests WHERE foc_no = ? AND status = 'Pending' ORDER BY id`).all(existing.foc_no);
    db.prepare(`
      UPDATE foc_requests SET status = 'Approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, fulfilling_department_id = ? WHERE foc_no = ? AND status = 'Pending'
    `).run(req.user.id, departmentId, existing.foc_no);
    notifyFocRouted(existing.foc_no, items, departmentId);
  });
  tx();
  res.json({ ok: true });
});
router.post('/foc/:id/reject', requirePermission('foc.approve'), (req, res) => {
  const existing = db.prepare('SELECT * FROM foc_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'Pending') return res.status(400).json({ error: 'This request has already been actioned.' });
  db.prepare(`UPDATE foc_requests SET status = 'Rejected', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE foc_no = ? AND status = 'Pending'`)
    .run(req.user.id, existing.foc_no);
  res.json({ ok: true });
});
// Gate depends on the row, not just the route: Admin always; the current
// user's own department once one's been picked (the department chosen at
// Approve time, not the fixed 'Store' permission this used to be gated on
// - Manufacturing/Service/etc. can all issue their own routed FOCs now);
// store.manage remains a fallback only for a request Approved before this
// column existed (fulfilling_department_id is NULL on those).
router.post('/foc/:id/issue', (req, res) => {
  const existing = db.prepare('SELECT * FROM foc_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'Approved') return res.status(400).json({ error: 'Must be Approved before it can be issued.' });
  const allowed = req.user.role_name === 'Admin'
    || (existing.fulfilling_department_id && req.user.department_id === existing.fulfilling_department_id)
    || (!existing.fulfilling_department_id && userHasPermission(req.user, 'store.manage'));
  if (!allowed) return res.status(403).json({ error: 'Only the department this was routed to (or Admin) can mark it issued.' });
  db.prepare(`UPDATE foc_requests SET status = 'Issued', issued_by = ?, issued_at = CURRENT_TIMESTAMP WHERE foc_no = ? AND status = 'Approved'`)
    .run(req.user.id, existing.foc_no);
  const groupIds = db.prepare('SELECT id FROM foc_requests WHERE foc_no = ?').all(existing.foc_no).map(r => r.id);
  autoCompleteSystemTodos('FOC_ROUTED', groupIds);
  res.json({ ok: true });
});

router.get('/foc/:id/pdf', async (req, res) => {
  const foc = db.prepare(`
    SELECT f.*, so.order_no, d.name as department_name, u.full_name as requested_by_name,
      a.full_name as approved_by_name, c.name as client_master_name, fd.name as fulfilling_department_name
    FROM foc_requests f
    LEFT JOIN sales_orders so ON so.id = f.sales_order_id
    LEFT JOIN departments d ON d.id = f.department_id
    LEFT JOIN users u ON u.id = f.requested_by
    LEFT JOIN users a ON a.id = f.approved_by
    LEFT JOIN clients c ON c.id = f.client_id
    LEFT JOIN departments fd ON fd.id = f.fulfilling_department_id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!foc) return res.status(404).json({ error: 'Not found' });
  if (foc.status === 'Pending' || foc.status === 'Rejected') {
    return res.status(400).json({ error: 'The Annexure is only available once this request has been approved.' });
  }
  // The Annexure covers every item in the group, not just the clicked row -
  // one combined document per foc_no, same reasoning as Approve/Reject/Issue
  // above (one request, one hand-off, regardless of line count).
  const items = db.prepare(`SELECT item_description, quantity, unit, estimated_value FROM foc_requests WHERE foc_no = ? ORDER BY id`).all(foc.foc_no);
  try {
    const gen = await generateFocAnnexurePdf(foc, getCompanySettings(), items);
    const filename = buildDownloadFilename({
      docType: 'FOC_Annexure',
      reference: foc.foc_no,
      partyName: foc.client_master_name || foc.customer_name,
      date: new Date(foc.created_at).toISOString().slice(0, 10),
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

// ===================== Finance Ledger (Round 3) =====================
// Consolidated view across all money-moving events this app hooks into:
// Expense voucher payment (above), Payroll mark-paid, Salary advance
// issuance/recovery (routes/hr.js), Service report amount approval
// (routes/service.js). Purchase orders don't yet have a "paid" event to
// hook (they track quantity/status, not a payment date) - not covered.
router.get('/ledger', requirePermission('report.view_all', 'expense_voucher.view_all'), (req, res) => {
  const { from, to, type, department_id } = req.query;
  let q = `
    SELECT l.*, d.name as department_name, u.full_name as created_by_name
    FROM finance_ledger l LEFT JOIN departments d ON d.id = l.department_id LEFT JOIN users u ON u.id = l.created_by
    WHERE 1=1
  `;
  const params = [];
  if (from) { q += ' AND l.entry_date >= ?'; params.push(from); }
  if (to) { q += ' AND l.entry_date <= ?'; params.push(to + ' 23:59:59'); }
  if (type) { q += ' AND l.type = ?'; params.push(type); }
  if (department_id) { q += ' AND l.department_id = ?'; params.push(department_id); }
  q += ' ORDER BY l.id DESC LIMIT 500';
  res.json(db.prepare(q).all(...params));
});

router.get('/summary', requirePermission('report.view_all', 'expense_voucher.view_all'), (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`SELECT * FROM finance_ledger WHERE entry_date LIKE ?`).all(month + '%');
  const inflow = rows.filter(r => r.direction === 'Inflow').reduce((s, r) => s + r.amount, 0);
  const outflow = rows.filter(r => r.direction === 'Outflow').reduce((s, r) => s + r.amount, 0);
  const byType = {};
  rows.forEach(r => { byType[r.type] = (byType[r.type] || 0) + (r.direction === 'Outflow' ? -r.amount : r.amount); });
  const byDeptRows = db.prepare(`
    SELECT COALESCE(d.name, 'Unassigned') as department, SUM(CASE WHEN l.direction='Outflow' THEN l.amount ELSE 0 END) as outflow,
      SUM(CASE WHEN l.direction='Inflow' THEN l.amount ELSE 0 END) as inflow
    FROM finance_ledger l LEFT JOIN departments d ON d.id = l.department_id
    WHERE l.entry_date LIKE ? GROUP BY department
  `).all(month + '%');
  res.json({ month, inflow, outflow, net: inflow - outflow, byType, byDepartment: byDeptRows, count: rows.length });
});

// ===================== Sales Invoices (Round 5) =====================
function nextInvoiceNo() {
  const now = new Date();
  // Indian financial year: Apr-Mar
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const key = 'invoice_seq_' + fy;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const next = row ? Number(row.value) + 1 : 1;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(next));
  return `INV/${fy}/${String(next).padStart(4, '0')}`;
}

router.get('/invoices', requirePermission('report.view_all', 'sales_order.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT si.*, c.name as client_name, so.order_no FROM sales_invoices si
    LEFT JOIN clients c ON c.id = si.client_id LEFT JOIN sales_orders so ON so.id = si.sales_order_id
    ORDER BY si.id DESC
  `).all());
});
router.get('/invoices/:id', requirePermission('report.view_all', 'sales_order.manage'), (req, res) => {
  const inv = db.prepare(`
    SELECT si.*, c.name as client_name FROM sales_invoices si LEFT JOIN clients c ON c.id = si.client_id WHERE si.id = ?
  `).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(inv.id);
  res.json({ invoice: inv, items });
});

// Generate a GST-compliant tax invoice from a sales order. CGST+SGST applies
// when the buyer's state matches the company's state; otherwise IGST.
router.post('/invoices/from-sales-order/:soId', requirePermission('sales_order.manage'), (req, res) => {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.soId);
  if (!so) return res.status(404).json({ error: 'Sales order not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(so.client_id);
  if (!client) return res.status(400).json({ error: 'This sales order has no linked client.' });
  // Don't allow a second invoice against the same sales order while an
  // earlier one is still live (Draft or Paid) - cancel that invoice first
  // (POST /invoices/:id/cancel) if it was a mistake and a fresh one is needed.
  const existing = db.prepare(`SELECT * FROM sales_invoices WHERE sales_order_id = ? AND status != 'Cancelled' ORDER BY id DESC LIMIT 1`).get(so.id);
  if (existing) {
    return res.status(400).json({ error: `This sales order already has invoice ${existing.invoice_no} (${existing.status}). Cancel it first if you need to reissue.` });
  }
  const company = getCompanySettings();
  const items = Array.isArray(req.body.items) && req.body.items.length ? req.body.items : [{
    description: so.description || so.order_no, hsn_code: '', quantity: 1, unit: 'Nos',
    rate: Number(so.order_value) || 0, gst_rate: company.default_gst_rate || 18,
  }];
  const buyerState = req.body.buyer_state || '';
  const buyerGstin = req.body.buyer_gstin || client.gstin || '';
  // Editable buyer identity (2026-10-17) - defaults from the order's own
  // client master but is freely overridable per-invoice, same reasoning
  // buyer_gstin/buyer_state already use (e.g. billing to a different site
  // contact than the one on file). Stored on the invoice itself rather than
  // always joined live, so a later edit to the Client Master can't quietly
  // change what already-generated invoice printed.
  const buyerName = req.body.buyer_name || client.name || '';
  const buyerContactPerson = req.body.buyer_contact_person || client.contact_person || '';
  const buyerAddress = req.body.buyer_address || client.address || '';
  const buyerPhone = req.body.buyer_phone || client.phone || '';
  const sameState = buyerState && company.state && buyerState.trim().toLowerCase() === company.state.trim().toLowerCase();

  let taxableTotal = 0, cgst = 0, sgst = 0, igst = 0;
  const lineRows = items.map((it, i) => {
    const qty = Number(it.quantity) || 1;
    const rate = Number(it.rate) || 0;
    const taxable = qty * rate;
    const gstRate = Number(it.gst_rate) || company.default_gst_rate || 18;
    taxableTotal += taxable;
    const taxAmt = taxable * gstRate / 100;
    if (sameState) { cgst += taxAmt / 2; sgst += taxAmt / 2; } else { igst += taxAmt; }
    return { description: it.description, hsn_code: it.hsn_code || null, quantity: qty, unit: it.unit || 'Nos', rate, taxable_value: taxable, gst_rate: gstRate, sort_order: i };
  });
  const total = taxableTotal + cgst + sgst + igst;
  const invoiceNo = nextInvoiceNo();
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO sales_invoices (invoice_no, sales_order_id, client_id, place_of_supply, buyer_gstin, buyer_state,
        buyer_name, buyer_contact_person, buyer_address, buyer_phone,
        taxable_value, cgst, sgst, igst, total_value, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(invoiceNo, so.id, client.id, buyerState || company.default_place_of_supply, buyerGstin, buyerState,
      buyerName, buyerContactPerson, buyerAddress, buyerPhone,
      taxableTotal, cgst, sgst, igst, total, 'Draft', req.user.id);
    const insertItem = db.prepare(`
      INSERT INTO sales_invoice_items (invoice_id, description, hsn_code, quantity, unit, rate, taxable_value, gst_rate, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    lineRows.forEach(r => insertItem.run(info.lastInsertRowid, r.description, r.hsn_code, r.quantity, r.unit, r.rate, r.taxable_value, r.gst_rate, r.sort_order));
    // Reflect the invoice back onto the sales order so its own record shows
    // billing has happened, without clobbering a status further along the
    // production pipeline (Completed) or one that's been Cancelled.
    if (!['Completed', 'Cancelled'].includes(so.status)) {
      db.prepare(`UPDATE sales_orders SET status = 'Invoiced' WHERE id = ?`).run(so.id);
    }
    return info.lastInsertRowid;
  });
  const id = tx();
  res.json({ id, invoice_no: invoiceNo });
});

router.post('/invoices/:id/cancel', requirePermission('sales_order.manage'), (req, res) => {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status === 'Paid') return res.status(400).json({ error: 'This invoice has already been marked Paid and cannot be cancelled - reverse the payment first if it was in error.' });
  db.prepare(`UPDATE sales_invoices SET status = 'Cancelled' WHERE id = ?`).run(inv.id);
  res.json({ ok: true });
});

router.post('/invoices/:id/mark-paid', requirePermission('sales_order.manage', 'report.view_all'), (req, res) => {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE sales_invoices SET status = 'Paid' WHERE id = ?`).run(inv.id);
  try {
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, amount, direction, description, created_by)
      VALUES ('SalesInvoice', 'sales_invoices', ?, ?, 'Inflow', ?, ?)
    `).run(inv.id, inv.total_value, 'Invoice ' + inv.invoice_no, req.user.id);
  } catch (e) { /* best-effort ledger hook */ }
  res.json({ ok: true });
});

router.post('/invoices/:id/email', requirePermission('sales_order.manage'), async (req, res) => {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(inv.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(inv.client_id);
  const toAddress = client && client.email;
  if (!toAddress) return res.status(400).json({ error: 'This client has no email on file - add one under Clients.' });
  let gen;
  try {
    gen = await generateInvoicePdf(inv, items, client || {}, getCompanySettings());
    const pdfBuffer = fs.readFileSync(gen.outPath);
    const attachmentName = buildDownloadFilename({
      docType: 'Tax_Invoice',
      reference: inv.invoice_no,
      partyName: client && client.name,
      date: new Date(inv.invoice_date).toISOString().slice(0, 10),
      version: buildVersionStamp(),
    });
    const result = await sendMail({
      to: toAddress,
      subject: `Tax Invoice ${inv.invoice_no} - Venkateshwara Engineers`,
      text: `Dear ${client.contact_person || client.name},\n\nPlease find attached Tax Invoice ${inv.invoice_no} for ₹${Number(inv.total_value).toLocaleString('en-IN')}.\n\nRegards,\nVenkateshwara Engineers`,
      attachments: [{ filename: attachmentName, content: pdfBuffer }],
      ...getDepartmentEmailIdentity('Sales'),
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

router.get('/invoices/:id/pdf', async (req, res) => {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(inv.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(inv.client_id);
  try {
    const gen = await generateInvoicePdf(inv, items, client || {}, getCompanySettings());
    const filename = buildDownloadFilename({
      docType: 'Tax_Invoice',
      reference: inv.invoice_no,
      partyName: client && client.name,
      date: new Date(inv.invoice_date).toISOString().slice(0, 10),
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

// ===================== Accounts Payable: Purchase Invoices =====================
// Booking a vendor's bill against what's actually been received on a PO
// (never the full ordered quantity - routes/purchase.js's poReceivedQty()
// is the same helper /store/receive already uses). Mirrors the Sales
// Invoice shape (own numbered sequence, CGST/SGST-vs-IGST split by state)
// but flowing the other direction, plus a few things only the payable side
// needs: the vendor's own bill number/date (required for GSTR-2B matching),
// optional TDS withholding, and payment recorded as its own finance_ledger
// row per instalment rather than a single mark-paid flag, so partial
// payments (e.g. "50% Advance + 50% Against Delivery") are a first-class
// case, not a workaround.
function nextPurchaseInvoiceNo() {
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const key = 'purchase_invoice_seq_' + fy;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const next = row ? Number(row.value) + 1 : 1;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(next));
  return `PINV/${fy}/${String(next).padStart(4, '0')}`;
}
function nextCreditNoteNo() {
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const key = 'vendor_credit_note_seq_' + fy;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const next = row ? Number(row.value) + 1 : 1;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(next));
  return `VCN/${fy}/${String(next).padStart(4, '0')}`;
}
// Stock In/Out + Store HOD reconciliation (2026-10-13) - a PO line's
// received quantity used to be directly billable the moment it physically
// arrived; now every receipt starts a grn_reconciliation (Store HOD review,
// PO vs vendor invoice) and only an Approved one counts toward what Finance
// may bill. Summing received_qty off Approved rows (rather than reusing
// poReceivedQty()) can never exceed what was actually received, since each
// grn_reconciliations row is created 1:1 with the stock_movements IN row
// that produced it (see routes/purchase.js's POST /store/receive).
function poLineReconciledQty(poLineId) {
  return db.prepare(`SELECT COALESCE(SUM(received_qty), 0) as n FROM grn_reconciliations WHERE po_id = ? AND status = 'Approved'`).get(poLineId).n;
}
// "Billable" is reconciled quantity minus whatever's already been invoiced
// (across any non-cancelled purchase invoice) against that exact line, so a
// PO billed in two instalments can't be double-invoiced.
function poLineBillableQty(poLineId) {
  const reconciled = poLineReconciledQty(poLineId);
  const invoiced = db.prepare(`
    SELECT COALESCE(SUM(pii.quantity), 0) as n
    FROM purchase_invoice_items pii JOIN purchase_invoices pi ON pi.id = pii.invoice_id
    WHERE pii.purchase_order_line_id = ? AND pi.status != 'Cancelled' AND pi.status != 'Rejected'
  `).get(poLineId).n;
  return reconciled - invoiced;
}
// "Still billable" for a GRN's own Transportation/Packing & Forwarding
// charge (2026-10-27) - the flat amount the Store HOD/Supervisor entered at
// GRN-approval time, minus whatever's already been invoiced against this
// exact GRN+charge pair (across any non-cancelled/non-rejected invoice), so
// the same charge can never be billed twice even if the PO line itself ends
// up split across two invoices. Mirrors poLineBillableQty()'s own
// not-already-invoiced-twice reasoning, just keyed by source_grn_id/
// charge_type instead of purchase_order_line_id.
function grnChargeBillable(grnId, chargeType) {
  const grn = db.prepare('SELECT * FROM grn_reconciliations WHERE id = ?').get(grnId);
  if (!grn) return 0;
  let total = 0;
  if (chargeType === 'Transportation') total = Number(grn.transportation_amount || 0);
  else if (chargeType === 'PackingForwarding') total = Number(grn.packing_forwarding_amount || 0);
  else return 0;
  if (total <= 0) return 0;
  const invoiced = db.prepare(`
    SELECT COALESCE(SUM(pii.taxable_value), 0) as n
    FROM purchase_invoice_items pii JOIN purchase_invoices pi ON pi.id = pii.invoice_id
    WHERE pii.source_grn_id = ? AND pii.charge_type = ? AND pi.status != 'Cancelled' AND pi.status != 'Rejected'
  `).get(grnId, chargeType).n;
  return Math.max(0, total - invoiced);
}
function purchaseInvoicePaidAmount(invoiceId) {
  return db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as n FROM finance_ledger WHERE reference_table = 'purchase_invoices' AND reference_id = ?
  `).get(invoiceId).n;
}
function purchaseInvoiceCreditedAmount(invoiceId) {
  return db.prepare(`
    SELECT COALESCE(SUM(total_value), 0) as n FROM vendor_credit_notes WHERE purchase_invoice_id = ? AND status != 'Cancelled'
  `).get(invoiceId).n;
}

router.get('/purchase-invoices', requirePermission('purchase_invoice.manage', 'report.view_all'), (req, res) => {
  const rows = db.prepare(`
    SELECT pi.*, v.name as vendor_name
    FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
    ORDER BY pi.id DESC
  `).all();
  res.json(rows.map(r => {
    const paid = purchaseInvoicePaidAmount(r.id);
    const credited = purchaseInvoiceCreditedAmount(r.id);
    return { ...r, paid_amount: paid, credited_amount: credited, due_amount: Math.max(0, r.net_payable - paid - credited) };
  }));
});
// Lines on this PO (across every status except Cancelled) with how much of
// each is still billable - drives the New Purchase Invoice form's line
// picker so it only ever offers quantity that's actually been received and
// not already invoiced.
// Registered before '/purchase-invoices/:id' - Express matches routes in
// registration order, and ':id' matches any path segment including the
// literal string "billable-po-lines", which would otherwise swallow this
// route (same :id-before-literal-sibling bug already hit and fixed twice
// elsewhere in this codebase: the Employee and Vendor template routes).
router.get('/purchase-invoices/billable-po-lines', requirePermission('purchase_invoice.manage'), (req, res) => {
  const poNo = req.query.po_no;
  if (!poNo) return res.status(400).json({ error: 'po_no is required.' });
  const lines = db.prepare(`
    SELECT po.*, i.name as item_name FROM purchase_orders po LEFT JOIN items i ON i.id = po.item_id
    WHERE po.po_no = ? AND po.status != 'Cancelled'
  `).all(poNo);
  res.json(lines.map(l => ({ ...l, received_qty: poReceivedQty(l.id), reconciled_qty: poLineReconciledQty(l.id), billable_qty: poLineBillableQty(l.id) })).filter(l => l.billable_qty > 0));
});
// Transportation / Packing & Forwarding charges (2026-10-27) still billable
// against this PO's Approved GRNs - a separate, additive endpoint rather
// than folding these into billable-po-lines above, so that existing,
// already-tested response shape is left completely untouched. The New
// Purchase Invoice form offers these as extra, item-less lines the same way
// it already offers real item lines.
router.get('/purchase-invoices/billable-charges', requirePermission('purchase_invoice.manage'), (req, res) => {
  const poNo = req.query.po_no;
  if (!poNo) return res.status(400).json({ error: 'po_no is required.' });
  const grns = db.prepare(`
    SELECT g.* FROM grn_reconciliations g JOIN purchase_orders po ON po.id = g.po_id
    WHERE po.po_no = ? AND g.status = 'Approved'
  `).all(poNo);
  const charges = [];
  for (const g of grns) {
    const t = grnChargeBillable(g.id, 'Transportation');
    if (t > 0) charges.push({ source_grn_id: g.id, charge_type: 'Transportation', description: `Transportation (GRN #${g.id})`, amount: t });
    const p = grnChargeBillable(g.id, 'PackingForwarding');
    if (p > 0) charges.push({ source_grn_id: g.id, charge_type: 'PackingForwarding', description: `Packing & Forwarding (GRN #${g.id})`, amount: p });
  }
  res.json(charges);
});
// "Ready to Bill" queue (2026-10-13) - every Approved GRN reconciliation
// still carrying billable quantity, with the vendor's own invoice
// no/date/qty/rate already captured at receiving time, so the New Purchase
// Invoice form can be pre-filled rather than Accounts retyping what Store
// already typed off the same bill. Accounts still clicks Create - this
// never books an invoice on its own.
// Registered before '/purchase-invoices/:id' for the same :id-before-
// literal-sibling reason as billable-po-lines above.
router.get('/purchase-invoices/ready-to-bill', requirePermission('purchase_invoice.manage'), (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, po.po_no, po.vendor_id, po.item_id, po.hsn_code, po.gst_rate, po.unit,
      i.name as item_name, v.name as vendor_name
    FROM grn_reconciliations g
    JOIN purchase_orders po ON po.id = g.po_id
    LEFT JOIN items i ON i.id = po.item_id
    LEFT JOIN vendors v ON v.id = po.vendor_id
    WHERE g.status = 'Approved'
    ORDER BY g.id DESC
  `).all();
  res.json(rows.map(r => ({ ...r, billable_qty: poLineBillableQty(r.po_id) })).filter(r => r.billable_qty > 0));
});
router.get('/purchase-invoices/:id', requirePermission('purchase_invoice.manage', 'report.view_all'), (req, res) => {
  const inv = db.prepare(`
    SELECT pi.*, v.name as vendor_name, v.gstin as vendor_gstin_onfile FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id WHERE pi.id = ?
  `).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT pii.*, i.name as item_name FROM purchase_invoice_items pii LEFT JOIN items i ON i.id = pii.item_id
    WHERE pii.invoice_id = ? ORDER BY pii.sort_order, pii.id
  `).all(inv.id);
  const payments = db.prepare(`
    SELECT * FROM finance_ledger WHERE reference_table = 'purchase_invoices' AND reference_id = ? ORDER BY entry_date
  `).all(inv.id);
  const creditNotes = db.prepare(`SELECT * FROM vendor_credit_notes WHERE purchase_invoice_id = ? ORDER BY id`).all(inv.id);
  const paid = purchaseInvoicePaidAmount(inv.id);
  const credited = purchaseInvoiceCreditedAmount(inv.id);
  res.json({ invoice: { ...inv, paid_amount: paid, credited_amount: credited, due_amount: Math.max(0, inv.net_payable - paid - credited) }, items, payments, creditNotes });
});

router.post('/purchase-invoices', requirePermission('purchase_invoice.manage'), (req, res) => {
  const { po_no, vendor_id, vendor_invoice_no, vendor_invoice_date, tds_rate } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'Pick a vendor.' });
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendor_id);
  if (!vendor) return res.status(400).json({ error: 'That vendor no longer exists - refresh the page and pick a vendor again.' });
  if (!vendor_invoice_no || !String(vendor_invoice_no).trim()) return res.status(400).json({ error: "Enter the vendor's own invoice/bill number." });
  if (!vendor_invoice_date) return res.status(400).json({ error: "Enter the date on the vendor's bill." });
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: 'Add at least one line item.' });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prefix = lines.length > 1 ? `Line ${i + 1}: ` : '';
    // A Transportation/Packing & Forwarding charge line (2026-10-27) is
    // always qty 1 at a flat ₹ rate - validated against grnChargeBillable()
    // instead of poLineBillableQty(), since it bills a GRN's own charge
    // amount, not an item quantity.
    if (l.charge_type) {
      if (!['Transportation', 'PackingForwarding'].includes(l.charge_type)) return res.status(400).json({ error: `${prefix}invalid charge type.` });
      if (!l.source_grn_id) return res.status(400).json({ error: `${prefix}a charge line must reference the GRN it came from.` });
      if (!l.rate || Number(l.rate) <= 0) return res.status(400).json({ error: `${prefix}enter an amount greater than 0.` });
      const billableCharge = grnChargeBillable(l.source_grn_id, l.charge_type);
      if (Number(l.rate) > billableCharge) {
        return res.status(400).json({ error: `${prefix}only ₹${billableCharge} of this charge is still billable against that GRN.` });
      }
      continue;
    }
    if (!l.quantity || Number(l.quantity) <= 0) return res.status(400).json({ error: `${prefix}enter a quantity greater than 0.` });
    if (!l.rate || Number(l.rate) <= 0) return res.status(400).json({ error: `${prefix}enter a rate greater than 0.` });
    if (l.purchase_order_line_id) {
      const billable = poLineBillableQty(l.purchase_order_line_id);
      if (Number(l.quantity) > billable) {
        return res.status(400).json({ error: `${prefix}only ${billable} is still billable against that PO line (requires Store HOD's GRN reconciliation to be Approved, minus whatever's already invoiced).` });
      }
    }
  }
  const company = getCompanySettings();
  const sameState = vendor.state && company.state && vendor.state.trim().toLowerCase() === company.state.trim().toLowerCase();
  let taxableTotal = 0, cgst = 0, sgst = 0, igst = 0;
  const lineRows = lines.map((l, i) => {
    const qty = l.charge_type ? 1 : Number(l.quantity);
    const rate = Number(l.rate);
    const taxable = qty * rate;
    const gstRate = l.gst_rate !== undefined && l.gst_rate !== '' ? Number(l.gst_rate) : (company.default_gst_rate || 18);
    taxableTotal += taxable;
    const taxAmt = taxable * gstRate / 100;
    if (sameState) { cgst += taxAmt / 2; sgst += taxAmt / 2; } else { igst += taxAmt; }
    return {
      purchase_order_line_id: l.purchase_order_line_id || null, item_id: l.item_id || null,
      description: l.description || l.item_name || (l.charge_type === 'Transportation' ? 'Transportation' : l.charge_type === 'PackingForwarding' ? 'Packing & Forwarding' : 'Item'),
      hsn_code: l.hsn_code || null,
      quantity: qty, unit: l.unit || 'Nos', rate, taxable_value: taxable, gst_rate: gstRate, sort_order: i,
      source_grn_id: l.charge_type ? (l.source_grn_id || null) : null, charge_type: l.charge_type || null,
    };
  });
  const totalValue = taxableTotal + cgst + sgst + igst;
  const tdsRate = Number(tds_rate) || 0;
  const tdsAmount = taxableTotal * tdsRate / 100;
  const netPayable = totalValue - tdsAmount;
  const invoiceNo = nextPurchaseInvoiceNo();
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO purchase_invoices (invoice_no, po_no, vendor_id, vendor_invoice_no, vendor_invoice_date, vendor_gstin, vendor_state,
        taxable_value, cgst, sgst, igst, total_value, tds_rate, tds_amount, net_payable, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PendingApproval', ?)
    `).run(invoiceNo, po_no || null, vendor_id, String(vendor_invoice_no).trim(), vendor_invoice_date, vendor.gstin || null, vendor.state || null,
      taxableTotal, cgst, sgst, igst, totalValue, tdsRate, tdsAmount, netPayable, req.user.id);
    const insertItem = db.prepare(`
      INSERT INTO purchase_invoice_items (invoice_id, purchase_order_line_id, item_id, description, hsn_code, quantity, unit, rate, taxable_value, gst_rate, sort_order, source_grn_id, charge_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    lineRows.forEach(r => insertItem.run(info.lastInsertRowid, r.purchase_order_line_id, r.item_id, r.description, r.hsn_code, r.quantity, r.unit, r.rate, r.taxable_value, r.gst_rate, r.sort_order, r.source_grn_id, r.charge_type));
    return info.lastInsertRowid;
  });
  const id = tx();
  const approvalId = approvals.startApproval('PurchaseInvoice', 'purchase_invoice', id, netPayable, req.user.id);
  db.prepare('UPDATE purchase_invoices SET approval_id = ? WHERE id = ?').run(approvalId, id);
  res.json({ id, invoice_no: invoiceNo, status: 'PendingApproval' });
});

router.post('/purchase-invoices/:id/cancel', requirePermission('purchase_invoice.manage'), (req, res) => {
  const inv = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (['PartiallyPaid', 'Paid'].includes(inv.status)) {
    return res.status(400).json({ error: 'A payment has already been recorded against this invoice - it can no longer be cancelled.' });
  }
  if (inv.status === 'Cancelled') return res.status(400).json({ error: 'This invoice is already cancelled.' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE purchase_invoices SET status = 'Cancelled' WHERE id = ?`).run(inv.id);
    if (inv.approval_id) {
      db.prepare(`UPDATE approvals SET status = 'Cancelled' WHERE id = ? AND status IN ('Pending', 'InfoRequested')`).run(inv.approval_id);
    }
  });
  tx();
  res.json({ ok: true });
});

// Payment only once Approved (or already PartiallyPaid - a second/third
// instalment) - the formal approval chain above is what actually gates
// money leaving, this is just the bookkeeping record of each instalment.
router.post('/purchase-invoices/:id/record-payment', requirePermission('purchase_invoice.manage'), (req, res) => {
  const inv = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (!['Approved', 'PartiallyPaid'].includes(inv.status)) {
    return res.status(400).json({ error: `This invoice must be Approved before a payment can be recorded against it (currently ${inv.status}).` });
  }
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a payment amount greater than 0.' });
  const paidSoFar = purchaseInvoicePaidAmount(inv.id);
  const credited = purchaseInvoiceCreditedAmount(inv.id);
  const due = inv.net_payable - paidSoFar - credited;
  if (amount > due + 0.01) return res.status(400).json({ error: `That's more than the ₹${fmt2(due)} currently due on this invoice.` });
  const reference = (req.body.reference || '').trim() || null;
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, amount, direction, description, created_by)
      VALUES ('PurchaseInvoice', 'purchase_invoices', ?, ?, 'Outflow', ?, ?)
    `).run(inv.id, amount, `Payment against ${inv.invoice_no}${reference ? ' (' + reference + ')' : ''}`, req.user.id);
    const newPaid = paidSoFar + amount;
    const newStatus = newPaid + credited >= inv.net_payable - 0.01 ? 'Paid' : 'PartiallyPaid';
    db.prepare(`UPDATE purchase_invoices SET status = ? WHERE id = ?`).run(newStatus, inv.id);
  });
  tx();
  res.json({ ok: true });
});
function fmt2(n) { return Number(n || 0).toFixed(2); }

// ===================== Vendor Credit Notes =====================
router.get('/vendor-credit-notes', requirePermission('purchase_invoice.manage', 'report.view_all'), (req, res) => {
  res.json(db.prepare(`
    SELECT vcn.*, v.name as vendor_name, pi.invoice_no as purchase_invoice_no
    FROM vendor_credit_notes vcn JOIN vendors v ON v.id = vcn.vendor_id
    JOIN purchase_invoices pi ON pi.id = vcn.purchase_invoice_id
    ORDER BY vcn.id DESC
  `).all());
});
router.post('/vendor-credit-notes', requirePermission('purchase_invoice.manage'), (req, res) => {
  const { purchase_invoice_id, vendor_credit_note_no, reason, taxable_value, gst_rate } = req.body;
  const inv = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(purchase_invoice_id);
  if (!inv) return res.status(400).json({ error: 'That purchase invoice no longer exists.' });
  if (inv.status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled - a credit note against it would not make sense.' });
  const taxable = Number(taxable_value);
  if (!taxable || taxable <= 0) return res.status(400).json({ error: 'Enter a taxable value greater than 0.' });
  const company = getCompanySettings();
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(inv.vendor_id);
  const sameState = vendor && vendor.state && company.state && vendor.state.trim().toLowerCase() === company.state.trim().toLowerCase();
  const gstRate = Number(gst_rate) || 0;
  const taxAmt = taxable * gstRate / 100;
  let cgst = 0, sgst = 0, igst = 0;
  if (sameState) { cgst = taxAmt / 2; sgst = taxAmt / 2; } else { igst = taxAmt; }
  const total = taxable + cgst + sgst + igst;
  const alreadyCredited = purchaseInvoiceCreditedAmount(inv.id);
  const alreadyPaid = purchaseInvoicePaidAmount(inv.id);
  if (alreadyCredited + alreadyPaid + total > inv.net_payable + 0.01) {
    return res.status(400).json({ error: `That would credit more than the ₹${fmt2(inv.net_payable - alreadyCredited - alreadyPaid)} remaining on this invoice.` });
  }
  const cnNo = nextCreditNoteNo();
  const info = db.prepare(`
    INSERT INTO vendor_credit_notes (credit_note_no, vendor_credit_note_no, purchase_invoice_id, vendor_id, reason, taxable_value, cgst, sgst, igst, total_value, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(cnNo, (vendor_credit_note_no || '').trim() || null, inv.id, inv.vendor_id, reason || null, taxable, cgst, sgst, igst, total, req.user.id);
  // A fully/over-credited invoice needs no further payment - same
  // "net_payable minus paid minus credited <= 0" rule record-payment uses.
  if (alreadyCredited + alreadyPaid + total >= inv.net_payable - 0.01 && inv.status !== 'Cancelled') {
    db.prepare(`UPDATE purchase_invoices SET status = 'Paid' WHERE id = ? AND status IN ('Approved', 'PartiallyPaid')`).run(inv.id);
  }
  res.json({ id: info.lastInsertRowid, credit_note_no: cnNo });
});
router.post('/vendor-credit-notes/:id/cancel', requirePermission('purchase_invoice.manage'), (req, res) => {
  const cn = db.prepare('SELECT * FROM vendor_credit_notes WHERE id = ?').get(req.params.id);
  if (!cn) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE vendor_credit_notes SET status = 'Cancelled' WHERE id = ?`).run(cn.id);
  // The invoice may have been auto-marked Paid when this credit note fully
  // covered it - if it's no longer covered now, drop it back so the due
  // amount (now positive again) shows up in Pending Purchase Bills.
  const inv = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(cn.purchase_invoice_id);
  if (inv && inv.status === 'Paid') {
    const paid = purchaseInvoicePaidAmount(inv.id);
    const credited = purchaseInvoiceCreditedAmount(inv.id);
    if (paid + credited < inv.net_payable - 0.01) {
      db.prepare(`UPDATE purchase_invoices SET status = ? WHERE id = ?`).run(paid > 0 ? 'PartiallyPaid' : 'Approved', inv.id);
    }
  }
  res.json({ ok: true });
});

// ===================== Pending Purchase Bills (AP aging) =====================
router.get('/pending-purchase-bills', requirePermission('purchase_invoice.manage', 'report.view_all'), (req, res) => {
  const rows = db.prepare(`
    SELECT pi.*, v.name as vendor_name, v.payment_terms_days as vendor_payment_terms_days
    FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
    WHERE pi.status IN ('PendingApproval', 'Approved', 'PartiallyPaid', 'Rejected', 'InfoRequested')
    ORDER BY pi.booking_date
  `).all();
  const today = new Date();
  const result = rows.map(r => {
    const paid = purchaseInvoicePaidAmount(r.id);
    const credited = purchaseInvoiceCreditedAmount(r.id);
    const due = Math.max(0, r.net_payable - paid - credited);
    const termsDays = r.vendor_payment_terms_days || 30;
    const dueDate = new Date(new Date(r.booking_date).getTime() + termsDays * 86400000);
    const daysOverdue = Math.max(0, Math.round((today - dueDate) / 86400000));
    return { ...r, paid_amount: paid, credited_amount: credited, due_amount: due, due_date: dueDate.toISOString().slice(0, 10), days_overdue: daysOverdue };
  }).filter(r => r.due_amount > 0.01);
  res.json(result);
});

// ===================== Proforma Invoices (Round 22) =====================
// Advance / pre-dispatch payment requests against a sales order - not a tax
// document (see db/index.js Round 22 comment). Reuses the same GST-split
// logic as tax invoices for the printed estimate, but never touches the
// invoice-number sequence and never pushes the SO to 'Invoiced'.
function nextProformaNo() {
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const key = 'proforma_seq_' + fy;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const next = row ? Number(row.value) + 1 : 1;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(next));
  return `PF/${fy}/${String(next).padStart(4, '0')}`;
}

router.get('/proforma-invoices', requirePermission('report.view_all', 'sales_order.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT pf.*, c.name as client_name, so.order_no, m.milestone_name
    FROM proforma_invoices pf
    LEFT JOIN clients c ON c.id = pf.client_id
    LEFT JOIN sales_orders so ON so.id = pf.sales_order_id
    LEFT JOIN payment_milestones m ON m.id = pf.milestone_id
    ORDER BY pf.id DESC
  `).all());
});
router.get('/proforma-invoices/:id', requirePermission('report.view_all', 'sales_order.manage'), (req, res) => {
  const pf = db.prepare(`
    SELECT pf.*, c.name as client_name, m.milestone_name FROM proforma_invoices pf
    LEFT JOIN clients c ON c.id = pf.client_id LEFT JOIN payment_milestones m ON m.id = pf.milestone_id
    WHERE pf.id = ?
  `).get(req.params.id);
  if (!pf) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM proforma_invoice_items WHERE proforma_id = ? ORDER BY sort_order, id').all(pf.id);
  res.json({ proforma: pf, items });
});

router.post('/proforma-invoices/from-sales-order/:soId', requirePermission('sales_order.manage'), (req, res) => {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.soId);
  if (!so) return res.status(404).json({ error: 'Sales order not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(so.client_id);
  if (!client) return res.status(400).json({ error: 'This sales order has no linked client.' });
  const { invoice_type, milestone_id, buyer_state, buyer_gstin } = req.body;
  if (!['Advance', 'PreDispatch'].includes(invoice_type)) return res.status(400).json({ error: 'invoice_type must be Advance or PreDispatch' });

  let milestone = null;
  if (milestone_id) {
    milestone = db.prepare(`SELECT * FROM payment_milestones WHERE id = ? AND order_type = 'SO' AND order_id = ?`).get(milestone_id, so.id);
    if (!milestone) return res.status(400).json({ error: 'That payment milestone does not belong to this sales order.' });
  }

  const company = getCompanySettings();
  let items = Array.isArray(req.body.items) && req.body.items.length ? req.body.items : null;
  if (!items) {
    // Default to the milestone's own amount/percentage, or the request body's
    // flat amount, so a milestone-linked proforma needs no manual line items.
    // Advance %/Payment-Before-Dispatch % (2026-10-27, captured on the Sales
    // Order itself) default this line's amount when neither a milestone nor
    // an explicit amount was given - still a default, not a lock: the caller
    // can always override by sending its own `amount`.
    const soPercent = invoice_type === 'Advance' ? Number(so.advance_percent) || 0 : Number(so.predispatch_percent) || 0;
    const amount = milestone
      ? (milestone.amount || (Number(milestone.percentage) || 0) / 100 * (Number(so.order_value) || 0))
      : (Number(req.body.amount) || (soPercent / 100 * (Number(so.order_value) || 0)));
    if (!amount) return res.status(400).json({ error: 'Give an amount, pick a milestone that has one, or set this order\'s Advance %/Payment Before Dispatch % first.' });
    // Item Description (2026-10-27) - same "blank field, server defaults to
    // the order's own description" pattern as Generate Invoice's own
    // inv-desc field: a milestone still drives its own name (it's the more
    // specific label), but a manual-amount line now honors a typed
    // description, falling back to the order's description (not its
    // number, which alone doesn't tell the reader what's being paid for)
    // only when nothing was typed.
    const typedDesc = req.body.description && String(req.body.description).trim();
    items = [{
      description: milestone ? milestone.milestone_name : (typedDesc || `${invoice_type === 'Advance' ? 'Advance payment' : 'Payment before dispatch'} - ${so.description || so.order_no}`),
      quantity: 1, unit: 'Nos', rate: amount, gst_rate: company.default_gst_rate || 18,
    }];
  }
  const buyerState = buyer_state || '';
  const buyerGstin = buyer_gstin || client.gstin || '';
  const sameState = buyerState && company.state && buyerState.trim().toLowerCase() === company.state.trim().toLowerCase();

  // Ship To (2026-10-27) - resolved and snapshotted as text the same way
  // routes/sales.js's dispatchParty() resolves FG Dispatch's own Ship-To:
  // the client's default Shipping address, falling back to their plain
  // `address` field when none is on file. Snapshotted at creation time, not
  // joined live, so a later edit to the client's address book can't
  // silently change what this document already printed.
  const shipAddr = db.prepare(`SELECT * FROM client_addresses WHERE client_id = ? AND address_type = 'Shipping' ORDER BY is_default DESC, id LIMIT 1`).get(client.id);
  const shipToAddress = shipAddr
    ? [shipAddr.line1, shipAddr.line2, [shipAddr.city, shipAddr.state, shipAddr.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n')
    : (client.address || '');

  let taxableTotal = 0, cgst = 0, sgst = 0, igst = 0;
  const lineRows = items.map((it, i) => {
    const qty = Number(it.quantity) || 1;
    const rate = Number(it.rate != null ? it.rate : it.taxable_value) || 0;
    const taxable = qty * rate;
    const gstRate = Number(it.gst_rate) || company.default_gst_rate || 18;
    taxableTotal += taxable;
    const taxAmt = taxable * gstRate / 100;
    if (sameState) { cgst += taxAmt / 2; sgst += taxAmt / 2; } else { igst += taxAmt; }
    return { description: it.description, quantity: qty, unit: it.unit || 'Nos', rate, taxable_value: taxable, gst_rate: gstRate, sort_order: i, sales_order_item_id: it.sales_order_item_id || null };
  });

  // Packing & Forwarding (2026-10-27) - part of the GST taxable value (same
  // treatment GST law gives any packing/forwarding charge billed alongside
  // the goods - Section 15 CGST Act), taxed at the first line's own GST
  // rate (Proforma is effectively always a single line in practice, same as
  // Generate Invoice). A caller-given flat ₹ amount wins over the
  // percentage when both are sent; the percentage alone is also accepted
  // and computed off the items' own taxable total.
  const pfPercent = Math.max(0, Number(req.body.packing_forwarding_percent) || 0);
  const pfRate = lineRows[0] ? lineRows[0].gst_rate : (company.default_gst_rate || 18);
  const pfAmountGiven = req.body.packing_forwarding_amount !== undefined && req.body.packing_forwarding_amount !== '' && req.body.packing_forwarding_amount !== null;
  const packingAmount = Math.max(0, pfAmountGiven ? (Number(req.body.packing_forwarding_amount) || 0) : taxableTotal * pfPercent / 100);
  const packingTax = packingAmount * pfRate / 100;
  if (sameState) { cgst += packingTax / 2; sgst += packingTax / 2; } else { igst += packingTax; }

  // Courier Charges (2026-10-29) - built exactly like Packing & Forwarding
  // above (same flat-₹-overrides-% shape, same GST-taxable treatment per
  // the owner's locked answer), as its own separate charge rather than
  // folded into Packing & Forwarding.
  const ccPercent = Math.max(0, Number(req.body.courier_charges_percent) || 0);
  const ccAmountGiven = req.body.courier_charges_amount !== undefined && req.body.courier_charges_amount !== '' && req.body.courier_charges_amount !== null;
  const courierAmount = Math.max(0, ccAmountGiven ? (Number(req.body.courier_charges_amount) || 0) : taxableTotal * ccPercent / 100);
  const courierTax = courierAmount * pfRate / 100;
  if (sameState) { cgst += courierTax / 2; sgst += courierTax / 2; } else { igst += courierTax; }

  // Advance Received (2026-10-27) - a deduction Finance types in against
  // what's already come in for this order, reducing what's actually payable
  // on THIS document (most useful on a Pre-Dispatch proforma raised after an
  // earlier Advance proforma's payment has already landed). A plain
  // deduction, not derived from any other Advance proforma's own status.
  const advanceReceived = Math.max(0, Number(req.body.advance_received) || 0);
  const total = taxableTotal + packingAmount + courierAmount + cgst + sgst + igst - advanceReceived;
  const proformaNo = nextProformaNo();
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO proforma_invoices (proforma_no, sales_order_id, client_id, milestone_id, invoice_type,
        place_of_supply, buyer_gstin, buyer_state, ship_to_address, taxable_value, cgst, sgst, igst,
        packing_forwarding_percent, packing_forwarding_amount, courier_charges_percent, courier_charges_amount, advance_received, total_value, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(proformaNo, so.id, client.id, milestone_id || null, invoice_type,
      buyerState || company.default_place_of_supply, buyerGstin, buyerState, shipToAddress, taxableTotal, cgst, sgst, igst,
      pfPercent, packingAmount, ccPercent, courierAmount, advanceReceived, total, 'Draft', req.user.id);
    const insertItem = db.prepare(`INSERT INTO proforma_invoice_items (proforma_id, description, quantity, unit, rate, taxable_value, gst_rate, sort_order, sales_order_item_id) VALUES (?,?,?,?,?,?,?,?,?)`);
    lineRows.forEach(r => insertItem.run(info.lastInsertRowid, r.description, r.quantity, r.unit, r.rate, r.taxable_value, r.gst_rate, r.sort_order, r.sales_order_item_id));
    // The tax-invoice pipeline uses 'Invoiced' for this same transition -
    // one consistent status regardless of which document triggered it.
    if (milestone) db.prepare(`UPDATE payment_milestones SET status = 'Invoiced' WHERE id = ?`).run(milestone.id);
    return info.lastInsertRowid;
  });
  const id = tx();

  // An Advance proforma is a request for the advance payment an ABG is
  // meant to secure - if the SO's commercial terms say one is required and
  // no live BG covers it yet, don't block the proforma (Finance may
  // legitimately need to invoice before the bank paperwork clears) but
  // raise a clear warning, both inline in this response and as a standing
  // notification so it isn't lost the moment this screen closes. Guarded
  // the same way lib/bgReminderScan.js guards its own notifications, so
  // raising a second Advance proforma against the same SO doesn't spam a
  // duplicate unread one.
  let bgWarning = null;
  if (invoice_type === 'Advance' && so.abg_required) {
    const hasLiveAbg = db.prepare(`
      SELECT id FROM bank_guarantees WHERE order_type = 'SO' AND order_id = ? AND bg_type = 'Advance' AND status IN ('Active', 'PendingRelease', 'Extended')
    `).get(so.id);
    if (!hasLiveAbg) {
      bgWarning = `This order's commercial terms require an Advance Bank Guarantee, and none is on file yet - raise it on the Bank Guarantee Dashboard before releasing goods against this advance.`;
      const alreadyNotified = db.prepare(`SELECT id FROM notifications WHERE source_type = 'BG_PENDING' AND source_id = ? AND is_read = 0`).get(so.id);
      if (!alreadyNotified) {
        db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`)
          .run(req.user.id, 'BG_PENDING', so.id, `Sales Order ${so.order_no}: Advance proforma ${proformaNo} raised, but the required Advance Bank Guarantee is not yet on file.`);
      }
    }
  }

  res.json({ id, proforma_no: proformaNo, bgWarning });
});

router.post('/proforma-invoices/:id/mark-received', requirePermission('sales_order.manage', 'report.view_all'), (req, res) => {
  const pf = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(req.params.id);
  if (!pf) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE proforma_invoices SET status = 'Received' WHERE id = ?`).run(pf.id);
  if (pf.milestone_id) db.prepare(`UPDATE payment_milestones SET status = 'Received' WHERE id = ?`).run(pf.milestone_id);
  try {
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, amount, direction, description, created_by)
      VALUES ('ProformaInvoice', 'proforma_invoices', ?, ?, 'Inflow', ?, ?)
    `).run(pf.id, pf.total_value, 'Proforma ' + pf.proforma_no, req.user.id);
  } catch (e) { /* best-effort ledger hook */ }
  res.json({ ok: true });
});
router.post('/proforma-invoices/:id/cancel', requirePermission('sales_order.manage'), (req, res) => {
  const pf = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(req.params.id);
  if (!pf) return res.status(404).json({ error: 'Not found' });
  if (pf.status === 'Received') return res.status(400).json({ error: 'This proforma has already been marked Received and cannot be cancelled.' });
  db.prepare(`UPDATE proforma_invoices SET status = 'Cancelled' WHERE id = ?`).run(pf.id);
  if (pf.milestone_id) db.prepare(`UPDATE payment_milestones SET status = 'Pending' WHERE id = ? AND status = 'Invoiced'`).run(pf.milestone_id);
  res.json({ ok: true });
});
router.post('/proforma-invoices/:id/email', requirePermission('sales_order.manage'), async (req, res) => {
  const pf = db.prepare(`
    SELECT pf.*, so.po_number AS so_po_number, so.po_date AS so_po_date, so.payment_terms AS so_payment_terms
    FROM proforma_invoices pf LEFT JOIN sales_orders so ON so.id = pf.sales_order_id WHERE pf.id = ?
  `).get(req.params.id);
  if (!pf) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM proforma_invoice_items WHERE proforma_id = ? ORDER BY sort_order, id').all(pf.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(pf.client_id);
  const toAddress = client && client.email;
  if (!toAddress) return res.status(400).json({ error: 'This client has no email on file - add one under Clients.' });
  let gen;
  try {
    gen = await generateProformaInvoicePdf(pf, items, client || {}, getCompanySettings());
    const pdfBuffer = fs.readFileSync(gen.outPath);
    const attachmentName = buildDownloadFilename({
      docType: 'Proforma_Invoice',
      reference: pf.proforma_no,
      partyName: client && client.name,
      date: new Date(pf.proforma_date).toISOString().slice(0, 10),
      version: buildVersionStamp(),
    });
    const result = await sendMail({
      to: toAddress,
      subject: `Proforma Invoice ${pf.proforma_no} - Venkateshwara Engineers`,
      text: `Dear ${client.contact_person || client.name},\n\nPlease find attached Proforma Invoice ${pf.proforma_no} for ₹${Number(pf.total_value).toLocaleString('en-IN')}.\n\nRegards,\nVenkateshwara Engineers`,
      attachments: [{ filename: attachmentName, content: pdfBuffer }],
      ...getDepartmentEmailIdentity('Sales'),
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
router.get('/proforma-invoices/:id/pdf', async (req, res) => {
  const pf = db.prepare(`
    SELECT pf.*, so.po_number AS so_po_number, so.po_date AS so_po_date, so.payment_terms AS so_payment_terms
    FROM proforma_invoices pf LEFT JOIN sales_orders so ON so.id = pf.sales_order_id WHERE pf.id = ?
  `).get(req.params.id);
  if (!pf) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM proforma_invoice_items WHERE proforma_id = ? ORDER BY sort_order, id').all(pf.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(pf.client_id);
  try {
    const gen = await generateProformaInvoicePdf(pf, items, client || {}, getCompanySettings());
    const filename = buildDownloadFilename({
      docType: 'Proforma_Invoice',
      reference: pf.proforma_no,
      partyName: client && client.name,
      date: new Date(pf.proforma_date).toISOString().slice(0, 10),
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

// ===================== Operating Expenses (Round 5) =====================
// Category list (Round: Operating Expense Categories) - an admin-editable
// master list, same "add/rename/deactivate, never hard-delete" convention
// as expense_tracker_categories. Read is open to anyone who can record an
// expense (or just view them); only Admin can change the list itself.
router.get('/operating-expense-categories', requirePermission('expense_voucher.create', 'report.view_all', 'expense_voucher.view_all'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM operating_expense_categories ORDER BY sort_order, name`).all());
});
router.post('/operating-expense-categories', requireRole('Admin'), (req, res) => {
  const { name, sort_order } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Enter a category name.' });
  try {
    const info = db.prepare(`INSERT INTO operating_expense_categories (name, sort_order) VALUES (?,?)`)
      .run(name.trim(), Number(sort_order) || 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'A category with that name already exists.' });
  }
});
router.put('/operating-expense-categories/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM operating_expense_categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, sort_order, active } = req.body;
  if (name !== undefined && !String(name || '').trim()) return res.status(400).json({ error: 'Enter a category name.' });
  try {
    db.prepare(`UPDATE operating_expense_categories SET name=?, sort_order=?, active=? WHERE id=?`).run(
      name !== undefined ? name.trim() : existing.name,
      sort_order !== undefined ? Number(sort_order) : existing.sort_order,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      existing.id
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'A category with that name already exists.' });
  }
});

// Scoped to one month by default (?month=YYYY-MM, defaulting to the
// current month) rather than returning every row ever recorded - as this
// table grows into the thousands, an unscoped SELECT * would mean
// fetching and rendering the entire history on every page load just to
// show this month's transactions. ?month=all is the explicit opt-out for
// the rare case of actually needing to browse everything at once; the new
// Monthly Category Summary below already covers "totals across months"
// without needing the raw list to load unscoped.
router.get('/operating-expenses', requirePermission('report.view_all', 'expense_voucher.view_all'), (req, res) => {
  if (req.query.month === 'all') {
    return res.json(db.prepare('SELECT * FROM operating_expenses ORDER BY id DESC').all());
  }
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  res.json(db.prepare(`SELECT * FROM operating_expenses WHERE expense_date LIKE ? ORDER BY id DESC`).all(month + '%'));
});
router.post('/operating-expenses', requirePermission('expense_voucher.create'), (req, res) => {
  const { expense_date, category, description, amount, paid_via } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });
  if (category) {
    const validCategory = db.prepare(`SELECT id FROM operating_expense_categories WHERE name = ? AND active = 1`).get(category);
    if (!validCategory) return res.status(400).json({ error: 'That category is not on the active list. Pick one from the dropdown.' });
  }
  const info = db.prepare(`
    INSERT INTO operating_expenses (expense_date, category, description, amount, paid_via, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(expense_date || new Date().toISOString(), category || null, description || null, amount, paid_via || 'Bank', req.user.id);
  try {
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, amount, direction, description, created_by)
      VALUES ('OperatingExpense', 'operating_expenses', ?, ?, 'Outflow', ?, ?)
    `).run(info.lastInsertRowid, amount, description || category || 'Operating expense', req.user.id);
  } catch (e) { /* best-effort ledger hook */ }
  res.json({ id: info.lastInsertRowid });
});

// Month x Category review report (replaces the bulk pivot-entry grid,
// which turned out not to be useful in practice - a read-only summary for
// scanning spend patterns is what was actually wanted). Mirrors the old
// Monthly Expense Tracker's /summary route, adapted for one unified
// category list and operating_expenses' plain transaction shape:
//  - An active category always appears, even at zero for months with no
//    spend, so the list scans consistently across a full year.
//  - A category that's since been deactivated only appears if it actually
//    has spend that year - so reviewing an old year keeps its real
//    history without cluttering a current year with a zeroed-out leftover.
//  - A transaction with no category (allowed - see POST above) is bucketed
//    under "(Uncategorized)" rather than silently dropped, so the grand
//    total always reconciles with real total spend.
router.get('/operating-expenses/summary', requirePermission('report.view_all', 'expense_voucher.view_all', 'expense_voucher.create'), (req, res) => {
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
  const allCategories = db.prepare(`SELECT * FROM operating_expense_categories ORDER BY sort_order, name`).all();
  const rows = db.prepare(`
    SELECT COALESCE(category, '(Uncategorized)') as category, substr(expense_date, 1, 7) as month, SUM(amount) as total
    FROM operating_expenses
    WHERE substr(expense_date, 1, 4) = ?
    GROUP BY COALESCE(category, '(Uncategorized)'), substr(expense_date, 1, 7)
  `).all(year);
  const byCategory = {};
  const namesWithData = new Set();
  rows.forEach(r => {
    byCategory[r.category] = byCategory[r.category] || {};
    byCategory[r.category][r.month] = r.total;
    namesWithData.add(r.category);
  });
  const namesToShow = [];
  allCategories.forEach(c => {
    if (c.active || namesWithData.has(c.name)) namesToShow.push(c.name);
    namesWithData.delete(c.name);
  });
  Array.from(namesWithData).sort().forEach(name => namesToShow.push(name));

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const grid = namesToShow.map(name => ({
    category: name,
    months: months.map(m => (byCategory[name] && byCategory[name][m]) || 0),
  }));
  const monthTotals = months.map((m, i) => grid.reduce((s, r) => s + r.months[i], 0));
  res.json({ year, months, categories: grid, monthTotals, grandTotal: monthTotals.reduce((a, b) => a + b, 0) });
});

// ===================== GST Summary (reporting aid only) =====================
router.get('/gst-summary', requirePermission('report.view_all', 'expense_voucher.view_all'), (req, res) => {
  const { from, to } = req.query;
  let invQ = `SELECT COALESCE(SUM(cgst),0) as cgst, COALESCE(SUM(sgst),0) as sgst, COALESCE(SUM(igst),0) as igst,
    COALESCE(SUM(taxable_value),0) as taxable_value FROM sales_invoices WHERE status != 'Draft'`;
  const params = [];
  if (from) { invQ += ' AND invoice_date >= ?'; params.push(from); }
  if (to) { invQ += ' AND invoice_date <= ?'; params.push(to + ' 23:59:59'); }
  const output = db.prepare(invQ).get(...params);
  const outputGst = (output.cgst || 0) + (output.sgst || 0) + (output.igst || 0);

  // ITC now sources from actually-booked Purchase Invoices rather than
  // Purchase Orders - a PO is just a commitment, not a tax document, so it
  // was only ever an approximation. Cancelled/Rejected bills claim nothing.
  let poQ = `SELECT COALESCE(SUM(cgst + sgst + igst),0) as itc FROM purchase_invoices WHERE status NOT IN ('Cancelled', 'Rejected')`;
  const poParams = [];
  if (from) { poQ += ' AND booking_date >= ?'; poParams.push(from); }
  if (to) { poQ += ' AND booking_date <= ?'; poParams.push(to + ' 23:59:59'); }
  const input = db.prepare(poQ).get(...poParams);
  const itc = input.itc || 0;

  res.json({
    from: from || null, to: to || null,
    output: { cgst: output.cgst, sgst: output.sgst, igst: output.igst, total: outputGst, taxable_value: output.taxable_value },
    input_tax_credit: itc,
    net_payable: outputGst - itc,
    note: 'For reference only - a reporting aid to help estimate GST liability. Verify with your GST practitioner before filing.',
  });
});

// ---- Vendor Ledger (2026-10-13) - mirrors routes/soa.js's client ledger,
// backed by Purchase Invoices (debit) + payments/vendor credit notes
// (credit) via lib/vendorLedger.js's computeVendorLedger(). Lives here
// rather than its own router since every other piece of this PO payment
// lifecycle (Purchase Invoices, vendor payments, credit notes) is already
// in this file.
router.get('/vendor-ledger/:vendorId', requirePermission('purchase_invoice.manage', 'report.view_all'), (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.vendorId);
  if (!vendor) return res.status(404).json({ error: 'Not found' });
  const ledger = computeVendorLedger(req.params.vendorId, { from: req.query.from, to: req.query.to });
  res.json({ vendor, ...ledger });
});
router.get('/vendor-ledger/:vendorId/pdf', requirePermission('purchase_invoice.manage', 'report.view_all'), async (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.vendorId);
  if (!vendor) return res.status(404).json({ error: 'Not found' });
  const { from, to } = req.query;
  const ledger = computeVendorLedger(vendor.id, { from, to });
  try {
    const gen = await generateVendorLedgerPdf(vendor, ledger, { start: from || null, end: to || null }, getCompanySettings());
    const filename = buildDownloadFilename({
      docType: 'Vendor_Ledger', reference: vendor.id, partyName: vendor.legal_name || vendor.name,
      date: to || new Date().toISOString().slice(0, 10), version: buildVersionStamp(),
    });
    res.download(gen.outPath, filename, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

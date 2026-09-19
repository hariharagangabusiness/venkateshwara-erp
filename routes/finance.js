const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const approvals = require('../lib/approvals');
const { generateInvoicePdf } = require('../lib/invoicePdf');
const { generateProformaInvoicePdf } = require('../lib/proformaInvoicePdf');
const { getCompanySettings } = require('../lib/settings');
const { sendMail } = require('../lib/mailer');
const router = express.Router();
router.use(authRequired);

const { getUploadsSubdir } = require('../lib/paths');
const expenseUploadDir = getUploadsSubdir('expenses');
const uploadExpense = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, expenseUploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// ---- Expense Vouchers (Operation Expenses, cash vs accounted) ----
router.get('/expense-vouchers', (req, res) => {
  const { department_id, accounted, status, from, to } = req.query;
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
  q += ' ORDER BY ev.id DESC';
  res.json(db.prepare(q).all(...params));
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

router.post('/expense-vouchers/:id/mark-paid', requirePermission('expense_voucher.approve'), (req, res) => {
  const row = db.prepare('SELECT * FROM expense_vouchers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'Approved') return res.status(400).json({ error: 'Must be Approved first' });
  db.prepare(`UPDATE expense_vouchers SET status = 'Paid' WHERE id = ?`).run(row.id);
  try {
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, department_id, amount, direction, description, created_by)
      VALUES ('Expense', 'expense_vouchers', ?, ?, ?, 'Outflow', ?, ?)
    `).run(row.id, row.department_id, row.amount, row.description || row.voucher_no, req.user.id);
  } catch (e) { /* best-effort ledger hook */ }
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
router.get('/foc', (req, res) => {
  res.json(db.prepare(`
    SELECT f.*, so.order_no, p.project_code, d.name as department_name,
      u.full_name as requested_by_name, a.full_name as approved_by_name,
      c.name as client_master_name
    FROM foc_requests f
    LEFT JOIN sales_orders so ON so.id = f.sales_order_id
    LEFT JOIN projects p ON p.id = f.project_id
    LEFT JOIN departments d ON d.id = f.department_id
    LEFT JOIN users u ON u.id = f.requested_by
    LEFT JOIN users a ON a.id = f.approved_by
    LEFT JOIN clients c ON c.id = f.client_id
    ORDER BY f.id DESC
  `).all());
});

router.post('/foc', requirePermission('foc.request'), (req, res) => {
  if (req.user.role_name !== 'Admin' && !req.user.is_supervisor) {
    return res.status(403).json({ error: 'Only a department HOD/Supervisor (or Admin) can raise an FOC request.' });
  }
  const { sales_order_id, client_id, customer_name, contact_person, contact_phone, item_description, quantity, unit, estimated_value, reason } = req.body;
  if (!item_description) return res.status(400).json({ error: 'Describe the material being requested.' });
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
  const info = db.prepare(`
    INSERT INTO foc_requests (foc_no, sales_order_id, project_id, department_id, requested_by, client_id,
      customer_name, contact_person, contact_phone, item_description, quantity, unit, estimated_value, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(focNo, sales_order_id || null, projectId, req.user.department_id, req.user.id, clientId,
    sales_order_id ? null : (customer_name || null), contact_person || null, contact_phone || null,
    item_description, quantity || 1, unit || 'Nos', estimated_value || 0, reason || null);
  res.json({ id: info.lastInsertRowid, foc_no: focNo });
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

router.post('/foc/:id/approve', requirePermission('foc.approve'), (req, res) => {
  db.prepare(`UPDATE foc_requests SET status = 'Approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.user.id, req.params.id);
  res.json({ ok: true });
});
router.post('/foc/:id/reject', requirePermission('foc.approve'), (req, res) => {
  db.prepare(`UPDATE foc_requests SET status = 'Rejected', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.user.id, req.params.id);
  res.json({ ok: true });
});
router.post('/foc/:id/issue', requirePermission('store.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM foc_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'Approved') return res.status(400).json({ error: 'Must be Approved before it can be issued.' });
  db.prepare(`UPDATE foc_requests SET status = 'Issued' WHERE id = ?`).run(existing.id);
  res.json({ ok: true });
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
        taxable_value, cgst, sgst, igst, total_value, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(invoiceNo, so.id, client.id, buyerState || company.default_place_of_supply, buyerGstin, buyerState,
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
    const result = await sendMail({
      to: toAddress,
      subject: `Tax Invoice ${inv.invoice_no} - Venkateshwara Engineers`,
      text: `Dear ${client.contact_person || client.name},\n\nPlease find attached Tax Invoice ${inv.invoice_no} for ₹${Number(inv.total_value).toLocaleString('en-IN')}.\n\nRegards,\nVenkateshwara Engineers`,
      attachments: [{ filename: `${inv.invoice_no.replace(/\//g, '-')}.pdf`, content: pdfBuffer }],
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
    res.download(gen.outPath, `${inv.invoice_no.replace(/\//g, '-')}.pdf`, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
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
    const amount = milestone
      ? (milestone.amount || (Number(milestone.percentage) || 0) / 100 * (Number(so.order_value) || 0))
      : Number(req.body.amount) || 0;
    if (!amount) return res.status(400).json({ error: 'Give an amount, or pick a milestone that has one.' });
    items = [{ description: milestone ? milestone.milestone_name : `${invoice_type === 'Advance' ? 'Advance payment' : 'Payment before dispatch'} - ${so.order_no}`, taxable_value: amount, gst_rate: company.default_gst_rate || 18 }];
  }
  const buyerState = buyer_state || '';
  const buyerGstin = buyer_gstin || client.gstin || '';
  const sameState = buyerState && company.state && buyerState.trim().toLowerCase() === company.state.trim().toLowerCase();

  let taxableTotal = 0, cgst = 0, sgst = 0, igst = 0;
  const lineRows = items.map((it, i) => {
    const taxable = Number(it.taxable_value) || 0;
    const gstRate = Number(it.gst_rate) || company.default_gst_rate || 18;
    taxableTotal += taxable;
    const taxAmt = taxable * gstRate / 100;
    if (sameState) { cgst += taxAmt / 2; sgst += taxAmt / 2; } else { igst += taxAmt; }
    return { description: it.description, taxable_value: taxable, gst_rate: gstRate, sort_order: i };
  });
  const total = taxableTotal + cgst + sgst + igst;
  const proformaNo = nextProformaNo();
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO proforma_invoices (proforma_no, sales_order_id, client_id, milestone_id, invoice_type,
        place_of_supply, buyer_gstin, buyer_state, taxable_value, cgst, sgst, igst, total_value, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(proformaNo, so.id, client.id, milestone_id || null, invoice_type,
      buyerState || company.default_place_of_supply, buyerGstin, buyerState, taxableTotal, cgst, sgst, igst, total, 'Draft', req.user.id);
    const insertItem = db.prepare(`INSERT INTO proforma_invoice_items (proforma_id, description, taxable_value, gst_rate, sort_order) VALUES (?,?,?,?,?)`);
    lineRows.forEach(r => insertItem.run(info.lastInsertRowid, r.description, r.taxable_value, r.gst_rate, r.sort_order));
    // The tax-invoice pipeline uses 'Invoiced' for this same transition -
    // one consistent status regardless of which document triggered it.
    if (milestone) db.prepare(`UPDATE payment_milestones SET status = 'Invoiced' WHERE id = ?`).run(milestone.id);
    return info.lastInsertRowid;
  });
  const id = tx();
  res.json({ id, proforma_no: proformaNo });
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
  const pf = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(req.params.id);
  if (!pf) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM proforma_invoice_items WHERE proforma_id = ? ORDER BY sort_order, id').all(pf.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(pf.client_id);
  const toAddress = client && client.email;
  if (!toAddress) return res.status(400).json({ error: 'This client has no email on file - add one under Clients.' });
  let gen;
  try {
    gen = await generateProformaInvoicePdf(pf, items, client || {}, getCompanySettings());
    const pdfBuffer = fs.readFileSync(gen.outPath);
    const result = await sendMail({
      to: toAddress,
      subject: `Proforma Invoice ${pf.proforma_no} - Venkateshwara Engineers`,
      text: `Dear ${client.contact_person || client.name},\n\nPlease find attached Proforma Invoice ${pf.proforma_no} for ₹${Number(pf.total_value).toLocaleString('en-IN')}.\n\nRegards,\nVenkateshwara Engineers`,
      attachments: [{ filename: `${pf.proforma_no.replace(/\//g, '-')}.pdf`, content: pdfBuffer }],
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
  const pf = db.prepare('SELECT * FROM proforma_invoices WHERE id = ?').get(req.params.id);
  if (!pf) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM proforma_invoice_items WHERE proforma_id = ? ORDER BY sort_order, id').all(pf.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(pf.client_id);
  try {
    const gen = await generateProformaInvoicePdf(pf, items, client || {}, getCompanySettings());
    res.download(gen.outPath, `${pf.proforma_no.replace(/\//g, '-')}.pdf`, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ===================== Operating Expenses (Round 5) =====================
router.get('/operating-expenses', requirePermission('report.view_all', 'expense_voucher.view_all'), (req, res) => {
  res.json(db.prepare('SELECT * FROM operating_expenses ORDER BY id DESC').all());
});
router.post('/operating-expenses', requirePermission('expense_voucher.create'), (req, res) => {
  const { expense_date, category, description, amount, paid_via } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });
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

  let poQ = `SELECT COALESCE(SUM(gst_amount),0) as itc FROM purchase_orders WHERE 1=1`;
  const poParams = [];
  if (from) { poQ += ' AND created_at >= ?'; poParams.push(from); }
  if (to) { poQ += ' AND created_at <= ?'; poParams.push(to + ' 23:59:59'); }
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

module.exports = router;

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const { generateItemBarcode } = require('../lib/barcode');
const router = express.Router();
router.use(authRequired);
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Simple read-only + admin-managed master lists
router.get('/departments', (req, res) => res.json(db.prepare('SELECT * FROM departments ORDER BY name').all()));
router.get('/roles', (req, res) => res.json(db.prepare('SELECT * FROM roles ORDER BY name').all()));
router.get('/leave-types', (req, res) => res.json(db.prepare('SELECT * FROM leave_types').all()));
router.get('/expense-categories', (req, res) => res.json(db.prepare('SELECT * FROM expense_categories').all()));

router.get('/clients', (req, res) => res.json(db.prepare('SELECT * FROM clients ORDER BY id DESC').all()));
router.get('/clients/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});
// Customer 360: everything about this client pulled from existing tables -
// leads, offers/quotations, sales orders - plus a total business value.
router.get('/clients/:id/360', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const leads = db.prepare(`
    SELECT l.*, u.full_name as owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.client_id = ? ORDER BY l.id DESC
  `).all(client.id);
  const offers = db.prepare('SELECT * FROM offers WHERE client_id = ? ORDER BY id DESC').all(client.id);
  const orders = db.prepare('SELECT * FROM sales_orders WHERE client_id = ? ORDER BY id DESC').all(client.id);
  const totalBusinessValue = orders.reduce((a, o) => a + Number(o.order_value || 0), 0);
  res.json({ client, leads, offers, orders, totalBusinessValue });
});
router.post('/clients', requirePermission('lead.manage', 'sales_order.manage'), (req, res) => {
  const { name, contact_person, phone, email, address, gstin, source } = req.body;
  const info = db.prepare(`INSERT INTO clients (name, contact_person, phone, email, address, gstin, source) VALUES (?,?,?,?,?,?,?)`)
    .run(name, contact_person, phone, email, address, gstin, source);
  res.json({ id: info.lastInsertRowid });
});
router.put('/clients/:id', requirePermission('lead.manage', 'sales_order.manage'), (req, res) => {
  const { name, contact_person, phone, email, address, gstin, source } = req.body;
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE clients SET name=?, contact_person=?, phone=?, email=?, address=?, gstin=?, source=? WHERE id=?`)
    .run(name, contact_person, phone, email, address, gstin, source, req.params.id);
  res.json({ ok: true });
});

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
function validGstin(g) { return !g || GSTIN_RE.test(String(g).trim().toUpperCase()); }

const VENDOR_FIELDS = [
  'name', 'legal_name', 'trade_name', 'gstin', 'pan', 'vendor_type', 'is_msme', 'msme_number',
  'state', 'state_code', 'address_line1', 'address_line2', 'city', 'pincode', 'country',
  'contact_person', 'phone', 'email', 'bank_name', 'bank_account_number', 'bank_ifsc',
  'bank_account_holder', 'payment_terms', 'payment_terms_days', 'category', 'status', 'po_email',
  'address', // legacy free-text address, kept for backward compat / display
];

router.get('/vendors', (req, res) => res.json(db.prepare('SELECT * FROM vendors ORDER BY id DESC').all()));
router.get('/vendors/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});
router.post('/vendors', requirePermission('purchase_order.manage', 'purchase_request.create'), (req, res) => {
  const b = req.body;
  if (!b.name && !b.legal_name) return res.status(400).json({ error: 'Vendor name is required.' });
  if (!validGstin(b.gstin)) return res.status(400).json({ error: 'GSTIN looks invalid - expected a 15-character GSTIN like 06AAACA1234B1Z5.' });
  const cols = VENDOR_FIELDS;
  const values = cols.map(c => {
    if (c === 'name') return b.name || b.legal_name;
    if (c === 'is_msme') return b.is_msme ? 1 : 0;
    if (c === 'country') return b.country || 'India';
    if (c === 'status') return b.status || 'Active';
    return b[c] !== undefined ? b[c] : null;
  });
  const info = db.prepare(`INSERT INTO vendors (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values);
  res.json({ id: info.lastInsertRowid });
});
router.put('/vendors/:id', requirePermission('purchase_order.manage', 'purchase_request.create'), (req, res) => {
  const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  if (!validGstin(b.gstin)) return res.status(400).json({ error: 'GSTIN looks invalid - expected a 15-character GSTIN like 06AAACA1234B1Z5.' });
  const cols = VENDOR_FIELDS;
  const sets = cols.map(c => `${c}=?`).join(',');
  const values = cols.map(c => {
    if (c === 'name') return (b.name || b.legal_name) !== undefined ? (b.name || b.legal_name) : existing.name;
    if (c === 'is_msme') return b.is_msme !== undefined ? (b.is_msme ? 1 : 0) : existing.is_msme;
    return b[c] !== undefined ? b[c] : existing[c];
  });
  db.prepare(`UPDATE vendors SET ${sets} WHERE id=?`).run(...values, existing.id);
  res.json({ ok: true });
});

const VENDOR_TEMPLATE_COLUMNS = [
  'name', 'legal_name', 'gstin', 'pan', 'vendor_type', 'is_msme', 'msme_number', 'state', 'state_code',
  'address_line1', 'address_line2', 'city', 'pincode', 'country', 'contact_person', 'phone', 'email',
  'bank_name', 'bank_account_number', 'bank_ifsc', 'bank_account_holder', 'payment_terms',
  'payment_terms_days', 'category', 'po_email',
];
router.get('/vendors/template', requirePermission('purchase_order.manage', 'purchase_request.create'), (req, res) => {
  const exampleRow = { name: 'ABC Steels Pvt Ltd', legal_name: 'ABC Steels Private Limited', gstin: '06AAACA1234B1Z5',
    pan: 'AAACA1234B', vendor_type: 'Manufacturer', is_msme: 'Yes', msme_number: 'UDYAM-HR-01-1234567',
    state: 'Haryana', state_code: '06', address_line1: 'Plot 12, Sector 24', address_line2: '', city: 'Faridabad',
    pincode: '121005', country: 'India', contact_person: 'Rakesh Sharma', phone: '9811122233',
    email: 'sales@abcsteels.example', bank_name: 'HDFC Bank', bank_account_number: '00123456789',
    bank_ifsc: 'HDFC0000123', bank_account_holder: 'ABC Steels Pvt Ltd', payment_terms: 'Net 30', payment_terms_days: 30,
    category: 'Raw Material', po_email: 'po@abcsteels.example' };
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: VENDOR_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'Vendors');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="vendor_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
router.post('/vendors/bulk-upload', requirePermission('purchase_order.manage', 'purchase_request.create'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' }); }
  const cols = VENDOR_FIELDS.filter(c => c !== 'address');
  const insert = db.prepare(`INSERT INTO vendors (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  let inserted = 0; const errors = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const name = String(row.name || row.legal_name || '').trim();
    if (!name) { errors.push(`Row ${rowNum}: name is required - skipped.`); return; }
    const gstin = String(row.gstin || '').trim();
    if (!validGstin(gstin)) { errors.push(`Row ${rowNum}: GSTIN "${gstin}" looks invalid - skipped.`); return; }
    const values = cols.map(c => {
      if (c === 'name') return name;
      if (c === 'is_msme') return /^(y|yes|true|1)$/i.test(String(row.is_msme || '')) ? 1 : 0;
      if (c === 'country') return String(row.country || '') || 'India';
      if (c === 'status') return 'Active';
      return String(row[c] || '') || null;
    });
    insert.run(...values);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors });
});

router.get('/items', (req, res) => {
  const { status } = req.query;
  if (status) return res.json(db.prepare('SELECT * FROM items WHERE status = ? ORDER BY id DESC').all(status));
  res.json(db.prepare('SELECT * FROM items ORDER BY name').all());
});
router.get('/items/by-barcode/:code', (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE barcode = ?').get(req.params.code);
  if (!item) return res.status(404).json({ error: 'No item matches that barcode.' });
  res.json(item);
});
router.post('/items', requirePermission('item.manage'), (req, res) => {
  const { item_code, name, unit, category, reorder_level, hsn_code, location } = req.body;
  const info = db.prepare(`INSERT INTO items (item_code, name, unit, category, reorder_level, hsn_code, location) VALUES (?,?,?,?,?,?,?)`)
    .run(item_code, name, unit || 'Nos', category, reorder_level || 0, hsn_code || null, location || null);
  const barcode = generateItemBarcode(info.lastInsertRowid);
  db.prepare('UPDATE items SET barcode = ? WHERE id = ?').run(barcode, info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, barcode });
});

// An item typed freehand on a Purchase Request (no Item Master pick) lands
// here as status='Pending'. Store reviews/completes it - usually while
// receiving the goods - and approves it into the permanent Item Master.
router.put('/items/:id/review', requirePermission('item.manage', 'store.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { item_code, name, unit, category, hsn_code, location, reorder_level, approve } = req.body;
  db.prepare(`
    UPDATE items SET item_code=?, name=?, unit=?, category=?, hsn_code=?, location=?, reorder_level=?, status=?
    WHERE id=?
  `).run(
    item_code !== undefined ? (item_code || null) : existing.item_code,
    name !== undefined ? name : existing.name,
    unit !== undefined ? (unit || 'Nos') : existing.unit,
    category !== undefined ? category : existing.category,
    hsn_code !== undefined ? hsn_code : existing.hsn_code,
    location !== undefined ? location : existing.location,
    reorder_level !== undefined ? reorder_level : existing.reorder_level,
    approve ? 'Approved' : existing.status,
    existing.id
  );
  if (approve && !existing.barcode) {
    db.prepare('UPDATE items SET barcode = ? WHERE id = ?').run(generateItemBarcode(existing.id), existing.id);
  }
  res.json({ ok: true });
});

const ITEM_TEMPLATE_COLUMNS = ['item_code', 'name', 'unit', 'category', 'hsn_code', 'reorder_level', 'location'];
router.get('/items/template', requirePermission('item.manage'), (req, res) => {
  const exampleRow = { item_code: 'ITM-1001', name: 'MS Angle 40x40x5mm', unit: 'Kg', category: 'Raw Material',
    hsn_code: '7216', reorder_level: 100, location: 'Rack A-1' };
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: ITEM_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'Items');
  const note = XLSX.utils.aoa_to_sheet([['Note'], ['A barcode is generated automatically for every item - do not include a barcode column.']]);
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="item_master_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
router.post('/items/bulk-upload', requirePermission('item.manage'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' }); }
  const insert = db.prepare(`INSERT INTO items (item_code, name, unit, category, reorder_level, hsn_code, location) VALUES (?,?,?,?,?,?,?)`);
  const existingCodes = new Set(db.prepare('SELECT item_code FROM items WHERE item_code IS NOT NULL').all().map(r => r.item_code));
  let inserted = 0; const errors = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const name = String(row.name || '').trim();
    if (!name) { errors.push(`Row ${rowNum}: name is required - skipped.`); return; }
    const code = String(row.item_code || '').trim() || null;
    if (code && existingCodes.has(code)) { errors.push(`Row ${rowNum}: item_code "${code}" already exists - skipped.`); return; }
    const info = insert.run(code, name, String(row.unit || '') || 'Nos', String(row.category || '') || null,
      Number(row.reorder_level) || 0, String(row.hsn_code || '') || null, String(row.location || '') || null);
    db.prepare('UPDATE items SET barcode = ? WHERE id = ?').run(generateItemBarcode(info.lastInsertRowid), info.lastInsertRowid);
    if (code) existingCodes.add(code);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors });
});

// Users management (Admin/HR)
router.get('/users', requirePermission('user.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.full_name, u.is_active, u.employee_id, u.role_id, u.department_id, u.is_supervisor,
      r.name as role, d.name as department, e.employee_code, e.full_name as employee_name
    FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN employees e ON e.id = u.employee_id
    ORDER BY u.id
  `).all());
});
// Employees who don't already have a login - so the Add User form only offers
// employees that actually need one (an employee can have at most one user account).
router.get('/employees-without-login', requirePermission('user.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT e.id, e.employee_code, e.full_name, e.department_id
    FROM employees e
    WHERE e.status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id)
    ORDER BY e.full_name
  `).all());
});
router.post('/users', requirePermission('user.manage'), (req, res) => {
  const bcrypt = require('bcryptjs');
  const { username, password, full_name, role_id, department_id, employee_id, is_supervisor } = req.body;
  const hash = bcrypt.hashSync(password || 'Demo@123', 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role_id, department_id, employee_id, is_active, is_supervisor)
    VALUES (?,?,?,?,?,?,1,?)
  `).run(username, hash, full_name, role_id, department_id || null, employee_id || null, is_supervisor ? 1 : 0);
  res.json({ id: info.lastInsertRowid });
});
router.patch('/users/:id/toggle', requirePermission('user.manage'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(u.is_active ? 0 : 1, u.id);
  res.json({ ok: true });
});
// Full edit of a user's role/department/supervisor flag/name - previously
// the ONLY way to fix a miskeyed account (wrong role, missing department,
// no HOD flag - all of which silently break that person's Job Cards
// visibility) was to deactivate it and create a new one from scratch, since
// nothing beyond toggle-active and employee-linking was ever editable.
router.put('/users/:id', requirePermission('user.manage'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const f = req.body;
  const pick = (key, fallback) => (f[key] !== undefined ? f[key] : fallback);
  db.prepare(`
    UPDATE users SET full_name=?, role_id=?, department_id=?, is_supervisor=? WHERE id=?
  `).run(
    pick('full_name', u.full_name), pick('role_id', u.role_id),
    f.department_id !== undefined ? (f.department_id || null) : u.department_id,
    pick('is_supervisor', u.is_supervisor) ? 1 : 0,
    u.id
  );
  if (f.password) {
    const bcrypt = require('bcryptjs');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(f.password, 10), u.id);
  }
  res.json({ ok: true });
});
// Link (or unlink, with employee_id: null) an existing login to an employee
// record - covers the case where a user was created before their employee
// record existed, or the wrong employee was picked at creation time.
router.patch('/users/:id/link-employee', requirePermission('user.manage'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { employee_id } = req.body;
  if (employee_id) {
    const already = db.prepare('SELECT id FROM users WHERE employee_id = ? AND id != ?').get(employee_id, u.id);
    if (already) return res.status(400).json({ error: 'That employee already has a login account.' });
  }
  db.prepare('UPDATE users SET employee_id = ? WHERE id = ?').run(employee_id || null, u.id);
  res.json({ ok: true });
});

module.exports = router;

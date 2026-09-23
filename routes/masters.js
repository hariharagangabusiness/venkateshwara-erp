const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
const { authRequired, requirePermission, requireRole } = require('../middleware/auth');
const { generateItemBarcode } = require('../lib/barcode');
const { generateTempPassword } = require('../lib/passwordReset');
const { sendMail } = require('../lib/mailer');
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
  // Client ID is customer-facing and derived from the row's own id, so it
  // needs the id to exist first - same two-step pattern as items.barcode.
  const clientCode = 'CLI-' + String(info.lastInsertRowid).padStart(6, '0');
  db.prepare('UPDATE clients SET client_code = ? WHERE id = ?').run(clientCode, info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, client_code: clientCode });
});
router.put('/clients/:id', requirePermission('lead.manage', 'sales_order.manage'), (req, res) => {
  const { name, contact_person, phone, email, address, gstin, source } = req.body;
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE clients SET name=?, contact_person=?, phone=?, email=?, address=?, gstin=?, source=? WHERE id=?`)
    .run(name, contact_person, phone, email, address, gstin, source, req.params.id);
  res.json({ ok: true });
});

// ---- Bill-to / Ship-to addresses (a client can have more than one of each -
// e.g. a head office that's billed, but material ships to different plants) ----
router.get('/clients/:id/addresses', (req, res) => {
  res.json(db.prepare('SELECT * FROM client_addresses WHERE client_id = ? ORDER BY address_type, is_default DESC, id').all(req.params.id));
});
router.post('/clients/:id/addresses', requirePermission('lead.manage', 'sales_order.manage'), (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { address_type, label, line1, line2, city, state, state_code, pincode, gstin, is_default } = req.body;
  if (!['Billing', 'Shipping'].includes(address_type)) return res.status(400).json({ error: 'address_type must be Billing or Shipping' });
  if (!String(line1 || '').trim()) return res.status(400).json({ error: 'Address line 1 is required' });
  const tx = db.transaction(() => {
    if (is_default) db.prepare('UPDATE client_addresses SET is_default = 0 WHERE client_id = ? AND address_type = ?').run(req.params.id, address_type);
    return db.prepare(`
      INSERT INTO client_addresses (client_id, address_type, label, line1, line2, city, state, state_code, pincode, gstin, is_default)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(req.params.id, address_type, label || null, line1.trim(), line2 || null, city || null, state || null, state_code || null, pincode || null, gstin || null, is_default ? 1 : 0);
  });
  const info = tx();
  res.json({ id: info.lastInsertRowid });
});
router.put('/client-addresses/:id', requirePermission('lead.manage', 'sales_order.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM client_addresses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { label, line1, line2, city, state, state_code, pincode, gstin, is_default } = req.body;
  const tx = db.transaction(() => {
    if (is_default) db.prepare('UPDATE client_addresses SET is_default = 0 WHERE client_id = ? AND address_type = ? AND id != ?').run(existing.client_id, existing.address_type, existing.id);
    db.prepare(`
      UPDATE client_addresses SET label=?, line1=?, line2=?, city=?, state=?, state_code=?, pincode=?, gstin=?, is_default=? WHERE id=?
    `).run(
      label !== undefined ? label : existing.label, line1 !== undefined ? line1 : existing.line1,
      line2 !== undefined ? line2 : existing.line2, city !== undefined ? city : existing.city,
      state !== undefined ? state : existing.state, state_code !== undefined ? state_code : existing.state_code,
      pincode !== undefined ? pincode : existing.pincode, gstin !== undefined ? gstin : existing.gstin,
      is_default !== undefined ? (is_default ? 1 : 0) : existing.is_default, existing.id
    );
  });
  tx();
  res.json({ ok: true });
});
router.delete('/client-addresses/:id', requirePermission('lead.manage', 'sales_order.manage'), (req, res) => {
  db.prepare('DELETE FROM client_addresses WHERE id = ?').run(req.params.id);
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
// A vendor referenced by any PO or quote can't be hard-deleted without
// orphaning that history, so it's deactivated instead (status='Inactive',
// same convention as the status field the Add Vendor form already offers) -
// it drops out of every vendor picker (PO creation, vendor-for-item
// suggestions) but stays visible/reactivatable in the Vendor Master list and
// on the historical documents that reference it. Only a vendor with no
// references at all is actually removed.
router.delete('/vendors/:id', requirePermission('purchase_order.manage', 'purchase_request.create'), (req, res) => {
  const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const poCount = db.prepare('SELECT COUNT(*) as n FROM purchase_orders WHERE vendor_id = ?').get(req.params.id).n;
  const quoteCount = db.prepare('SELECT COUNT(*) as n FROM purchase_request_quotes WHERE vendor_id = ?').get(req.params.id).n;
  if (poCount > 0 || quoteCount > 0) {
    db.prepare(`UPDATE vendors SET status = 'Inactive' WHERE id = ?`).run(req.params.id);
    return res.json({ ok: true, deactivated: true, message: `This vendor has ${poCount} PO(s) and ${quoteCount} quote(s) on file, so it was deactivated instead of deleted - it will no longer appear when picking a vendor.` });
  }
  db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
  res.json({ ok: true, deactivated: false });
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
  const findByGstin = db.prepare('SELECT * FROM vendors WHERE gstin = ?');
  const findByName = db.prepare('SELECT * FROM vendors WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))');
  let inserted = 0, updated = 0; const errors = [];
  // Wrapped in a transaction: without one, a mid-file failure (e.g. the DB's
  // own GSTIN unique index rejecting an old-style duplicate row) used to
  // throw straight out of this handler, leaving whatever rows had already
  // been inserted committed with no summary response at all.
  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const name = String(row.name || row.legal_name || '').trim();
      if (!name) { errors.push(`Row ${rowNum}: name is required - skipped.`); return; }
      const gstin = String(row.gstin || '').trim();
      if (!validGstin(gstin)) { errors.push(`Row ${rowNum}: GSTIN "${gstin}" looks invalid - skipped.`); return; }
      // Re-uploading the same file (e.g. after exporting, filling in a
      // missing field, and re-importing) updates the existing vendor
      // instead of failing on the GSTIN unique index or creating a
      // duplicate-by-name row. Matched by GSTIN first (the real durable
      // identifier), falling back to an exact name match when no GSTIN is
      // given. A blank cell never overwrites an existing value, so a
      // partial re-export/re-import can't accidentally wipe a field the
      // file just didn't happen to carry.
      const existing = (gstin && findByGstin.get(gstin)) || findByName.get(name);
      if (existing) {
        const sets = cols.map(c => `${c} = ?`).join(',');
        const values = cols.map(c => {
          if (c === 'name') return name;
          if (c === 'is_msme') return row.is_msme !== '' ? (/^(y|yes|true|1)$/i.test(String(row.is_msme || '')) ? 1 : 0) : existing.is_msme;
          const raw = row[c];
          return (raw !== undefined && String(raw).trim() !== '') ? String(raw).trim() : existing[c];
        });
        db.prepare(`UPDATE vendors SET ${sets} WHERE id = ?`).run(...values, existing.id);
        updated++;
        return;
      }
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
  });
  tx();
  res.json({ inserted, updated, skipped: errors.length, errors });
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

const ITEM_EDIT_FIELDS = ['item_code', 'name', 'unit', 'category', 'hsn_code', 'location', 'reorder_level'];
// How many live transactions reference an item - used to decide whether a
// delete can actually remove the row or must fall back to discontinuing it
// (status='Discontinued'), same reasoning as vendor delete just above.
function itemReferenceCount(itemId) {
  const tables = ['purchase_request_items', 'purchase_orders', 'stock_movements', 'service_center_stock', 'service_center_transfer_items', 'service_report_spares'];
  return tables.reduce((sum, t) => sum + db.prepare(`SELECT COUNT(*) as n FROM ${t} WHERE item_id = ?`).get(itemId).n, 0);
}
function applyItemEdit(itemId, fields) {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  const sets = ITEM_EDIT_FIELDS.map(c => `${c}=?`).join(',');
  const values = ITEM_EDIT_FIELDS.map(c => (fields[c] !== undefined ? fields[c] : existing[c]));
  db.prepare(`UPDATE items SET ${sets} WHERE id=?`).run(...values, itemId);
}
function applyItemDelete(itemId) {
  if (itemReferenceCount(itemId) > 0) {
    db.prepare(`UPDATE items SET status = 'Discontinued' WHERE id = ?`).run(itemId);
    return { deleted: false };
  }
  db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
  return { deleted: true };
}

// General edit for an item already in the master (distinct from
// PUT /items/:id/review, which is specifically for completing a Pending
// item created ad hoc from a Purchase Request). Admin applies immediately;
// anyone else with item.manage/store.manage queues the change instead -
// the live item is untouched until an Admin/reviewer approves it, so a
// transaction already using this item's current values can't be changed
// out from under it mid-flight.
router.put('/items/:id', requirePermission('item.manage', 'store.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status === 'Pending') return res.status(400).json({ error: 'This item is still awaiting its first-time review - use the Pending Item Master Review panel instead.' });
  const fields = {};
  ITEM_EDIT_FIELDS.forEach(c => { if (req.body[c] !== undefined) fields[c] = req.body[c] || null; });
  if (req.user.role_name === 'Admin') {
    applyItemEdit(existing.id, fields);
    return res.json({ ok: true, applied: true });
  }
  db.prepare(`INSERT INTO item_pending_changes (item_id, change_type, proposed_fields, requested_by) VALUES (?,'Edit',?,?)`)
    .run(existing.id, JSON.stringify(fields), req.user.id);
  res.json({ ok: true, applied: false, message: 'Change submitted for approval - the item stays as-is until an Admin reviews it.' });
});
router.delete('/items/:id', requirePermission('item.manage', 'store.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (req.user.role_name === 'Admin') {
    const result = applyItemDelete(existing.id);
    return res.json({ ok: true, applied: true, deleted: result.deleted });
  }
  db.prepare(`INSERT INTO item_pending_changes (item_id, change_type, requested_by) VALUES (?,'Delete',?)`).run(existing.id, req.user.id);
  res.json({ ok: true, applied: false, message: 'Delete request submitted for approval.' });
});

router.get('/items/pending-changes', requirePermission('item.manage', 'store.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, i.name as item_name, i.item_code, u.full_name as requested_by_name
    FROM item_pending_changes c JOIN items i ON i.id = c.item_id LEFT JOIN users u ON u.id = c.requested_by
    WHERE c.status = 'Pending' ORDER BY c.id DESC
  `).all());
});
router.post('/items/pending-changes/:id/approve', requireRole('Admin'), (req, res) => {
  const change = db.prepare('SELECT * FROM item_pending_changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  if (change.status !== 'Pending') return res.status(400).json({ error: 'Already reviewed.' });
  let result = {};
  if (change.change_type === 'Edit') applyItemEdit(change.item_id, JSON.parse(change.proposed_fields || '{}'));
  else result = applyItemDelete(change.item_id);
  db.prepare(`UPDATE item_pending_changes SET status='Approved', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, change.id);
  res.json({ ok: true, deleted: result.deleted });
});
router.post('/items/pending-changes/:id/reject', requireRole('Admin'), (req, res) => {
  const change = db.prepare('SELECT * FROM item_pending_changes WHERE id = ?').get(req.params.id);
  if (!change) return res.status(404).json({ error: 'Not found' });
  if (change.status !== 'Pending') return res.status(400).json({ error: 'Already reviewed.' });
  db.prepare(`UPDATE item_pending_changes SET status='Rejected', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, review_note=? WHERE id=?`)
    .run(req.user.id, req.body.review_note || null, change.id);
  res.json({ ok: true });
});

router.post('/items/:id/reactivate', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE items SET status = 'Approved' WHERE id = ?`).run(req.params.id);
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
  const findByCode = db.prepare('SELECT * FROM items WHERE item_code = ?');
  let inserted = 0, updated = 0; const errors = [];
  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const name = String(row.name || '').trim();
      if (!name) { errors.push(`Row ${rowNum}: name is required - skipped.`); return; }
      const code = String(row.item_code || '').trim() || null;
      // Re-uploading the same file (e.g. after exporting, filling in a
      // missing hsn_code/location, and re-importing) updates the existing
      // item instead of skipping it as a duplicate - matched by item_code,
      // the master's own natural key. A row with no item_code has nothing
      // to match against, so it always inserts as new, same as before.
      // Barcode and status are never touched by an update - a barcode is
      // permanent once assigned, and a bulk data correction shouldn't
      // silently flip an item back to Approved from Discontinued.
      const existing = code ? findByCode.get(code) : null;
      if (existing) {
        db.prepare(`UPDATE items SET name=?, unit=?, category=?, reorder_level=?, hsn_code=?, location=? WHERE id=?`).run(
          name,
          row.unit && String(row.unit).trim() ? String(row.unit).trim() : existing.unit,
          row.category && String(row.category).trim() ? String(row.category).trim() : existing.category,
          row.reorder_level !== undefined && String(row.reorder_level).trim() !== '' ? Number(row.reorder_level) : existing.reorder_level,
          row.hsn_code && String(row.hsn_code).trim() ? String(row.hsn_code).trim() : existing.hsn_code,
          row.location && String(row.location).trim() ? String(row.location).trim() : existing.location,
          existing.id
        );
        updated++;
        return;
      }
      const info = insert.run(code, name, String(row.unit || '') || 'Nos', String(row.category || '') || null,
        Number(row.reorder_level) || 0, String(row.hsn_code || '') || null, String(row.location || '') || null);
      db.prepare('UPDATE items SET barcode = ? WHERE id = ?').run(generateItemBarcode(info.lastInsertRowid), info.lastInsertRowid);
      inserted++;
    });
  });
  tx();
  res.json({ inserted, updated, skipped: errors.length, errors });
});

// Users management (Admin/HR)
router.get('/users', requirePermission('user.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.employee_id, u.role_id, u.department_id, u.is_supervisor,
      u.must_change_password, r.name as role, d.name as department, e.employee_code, e.full_name as employee_name
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
router.post('/users', requirePermission('user.manage'), async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { username, password, full_name, email, role_id, department_id, employee_id, is_supervisor } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase() || null;
  if (cleanEmail) {
    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail);
    if (existing) return res.status(400).json({ error: 'Another user already has this email address.' });
  }
  // No password typed by the Admin -> generate one and email it, rather than
  // silently falling back to a fixed, guessable default (the previous
  // behavior) - only meaningful if there's an email to send it to, so a
  // no-email account still needs the Admin to set/share a password by hand.
  const autoGenerated = !password && !!cleanEmail;
  const effectivePassword = password || (autoGenerated ? generateTempPassword() : 'Demo@123');
  const hash = bcrypt.hashSync(effectivePassword, 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, full_name, email, role_id, department_id, employee_id, is_active, is_supervisor, must_change_password)
    VALUES (?,?,?,?,?,?,?,1,?,?)
  `).run(username, hash, full_name, cleanEmail, role_id, department_id || null, employee_id || null, is_supervisor ? 1 : 0, autoGenerated ? 1 : 0);

  let welcomeEmail = { attempted: false };
  if (cleanEmail) {
    welcomeEmail.attempted = true;
    const loginUrl = `${req.protocol}://${req.get('host')}/`;
    try {
      const r = await sendMail({
        to: cleanEmail,
        subject: 'Welcome to Venkateshwara Engineers ERP - Your Login Details',
        text: `Hello ${full_name},\n\nAn account has been created for you on the Venkateshwara Engineers ERP.\n\nLogin: ${loginUrl}\nUsername: ${username}\nPassword: ${effectivePassword}\n\n${autoGenerated ? "You'll be asked to set your own password the first time you log in.\n\n" : ''}Regards,\nVenkateshwara Engineers ERP`,
      });
      welcomeEmail.sent = r.sent;
      welcomeEmail.reason = r.reason;
    } catch (e) {
      welcomeEmail.sent = false;
      welcomeEmail.reason = e.message;
    }
  }
  res.json({ id: info.lastInsertRowid, password_used: autoGenerated ? effectivePassword : undefined, welcome_email: welcomeEmail });
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
  let email = u.email;
  if (f.email !== undefined) {
    email = String(f.email || '').trim().toLowerCase() || null;
    if (email) {
      const existing = db.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`).get(email, u.id);
      if (existing) return res.status(400).json({ error: 'Another user already has this email address.' });
    }
  }
  db.prepare(`
    UPDATE users SET full_name=?, email=?, role_id=?, department_id=?, is_supervisor=? WHERE id=?
  `).run(
    pick('full_name', u.full_name), email, pick('role_id', u.role_id),
    f.department_id !== undefined ? (f.department_id || null) : u.department_id,
    pick('is_supervisor', u.is_supervisor) ? 1 : 0,
    u.id
  );
  // An Admin manually resetting someone's password is the same trust
  // situation as a welcome email - the new password passed through a
  // channel other than the account owner typing it themselves - so it
  // forces the same change-on-next-login flow.
  if (f.password) {
    const bcrypt = require('bcryptjs');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(f.password, 10), u.id);
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

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);
// Generalized bulk-upload / migration framework, modeled on the stock
// movements bulk-upload in routes/purchase.js. Admin-only, since this is a
// sensitive bulk-write path that can create masters and transactional rows
// across the whole system.
router.use(requireRole('Admin'));
 
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
 
// SheetJS's CSV/XLSX reader auto-detects date-looking cells (including a
// plain YYYY-MM-DD string typed into a CSV) and hands sheet_to_json back
// either a JS Date object or an Excel serial-date number instead of the
// original text, depending on the source format. Every importRow() that
// expects a YYYY-MM-DD date string needs to tolerate all three shapes -
// this normalizes any of them to 'YYYY-MM-DD', or returns null if the
// value can't be read as a date at all.
function normalizeDate(value) {
  if (value instanceof Date && !isNaN(value)) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const mm = String(parsed.m).padStart(2, '0');
    const dd = String(parsed.d).padStart(2, '0');
    return `${parsed.y}-${mm}-${dd}`;
  }
  const str = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}
// For an optional date field: a blank cell is legitimately "not given" (null,
// no error); anything else must parse via normalizeDate() or the row is
// rejected - a value Excel couldn't read as a date is almost always a
// formatting mistake, not something to silently store as garbage or drop.
function optionalDate(value) {
  if (value === '' || value === null || value === undefined) return { ok: true, value: null };
  const normalized = normalizeDate(value);
  return normalized ? { ok: true, value: normalized } : { ok: false, value: null };
}
 
// ===================== Entity registry =====================
// Each entity defines: key, label, table, columns (with an example row for
// the template), notes (shown on the template's Notes sheet), and an
// importRow(row, ctx) function that validates one sheet_to_json row and
// either returns { insert: {col: val, ...} } to insert, or { error: 'msg' }
// to skip it. ctx carries prepared lookup statements + req.user.
 
const ENTITIES = {
  clients: {
    label: 'Clients',
    table: 'clients',
    columns: ['name', 'contact_person', 'phone', 'email', 'address', 'gstin', 'source'],
    example: { name: 'ABC Industries', contact_person: 'Ramesh Gupta', phone: '9876543210', email: 'ramesh@abc.example', address: 'Sector 24, Faridabad', gstin: '06ABCDE1234F1Z5', source: 'Referral' },
    notes: ['name is required.', 'All other fields are optional.'],
    importRow(row, ctx) {
      const name = String(row.name || '').trim();
      if (!name) return { error: 'name is required' };
      // Idempotent re-runs: skip a client that already exists with this
      // exact name + phone combination (clients has no UNIQUE constraint).
      if (row.phone) {
        const existing = db.prepare('SELECT id FROM clients WHERE name = ? AND phone = ?').get(name, String(row.phone));
        if (existing) return { error: `duplicate of client #${existing.id} - skipped` };
      }
      return { insert: { name, contact_person: row.contact_person || null, phone: row.phone ? String(row.phone) : null, email: row.email || null, address: row.address || null, gstin: row.gstin || null, source: row.source || null } };
    },
  },
  vendors: {
    label: 'Vendors',
    table: 'vendors',
    columns: ['name', 'contact_person', 'phone', 'email', 'address', 'gstin', 'category'],
    example: { name: 'Steel Traders Pvt Ltd', contact_person: 'Suresh Kumar', phone: '9812345678', email: 'sales@steeltraders.example', address: 'Industrial Area, Faridabad', gstin: '06XYZAB5678G1Z9', category: 'Raw Material' },
    notes: ['name is required.', 'category is a free-text tag (e.g. Raw Material, Spares, Services) - it is matched against an item\'s category on the vendor-comparison page.'],
    importRow(row) {
      const name = String(row.name || '').trim();
      if (!name) return { error: 'name is required' };
      if (row.gstin) {
        const existing = db.prepare('SELECT id FROM vendors WHERE gstin = ?').get(String(row.gstin));
        if (existing) return { error: `duplicate GSTIN of vendor #${existing.id} - skipped` };
      }
      return { insert: { name, contact_person: row.contact_person || null, phone: row.phone ? String(row.phone) : null, email: row.email || null, address: row.address || null, gstin: row.gstin || null, category: row.category || null } };
    },
  },
  items: {
    label: 'Items (Item Master)',
    table: 'items',
    columns: ['item_code', 'name', 'unit', 'category', 'reorder_level', 'current_stock'],
    example: { item_code: 'ITM-2001', name: 'MS Angle 50x50x6', unit: 'Kg', category: 'Raw Material', reorder_level: 100, current_stock: 250 },
    notes: ['name is required. item_code, if given, must be unique - a row reusing an existing item_code is skipped.'],
    importRow(row) {
      const name = String(row.name || '').trim();
      if (!name) return { error: 'name is required' };
      const code = row.item_code ? String(row.item_code).trim() : null;
      if (code) {
        const existing = db.prepare('SELECT id FROM items WHERE item_code = ?').get(code);
        if (existing) return { error: `duplicate item_code "${code}" (item #${existing.id}) - skipped` };
      }
      return { insert: { item_code: code, name, unit: row.unit || 'Nos', category: row.category || null, reorder_level: Number(row.reorder_level) || 0, current_stock: Number(row.current_stock) || 0, status: 'Approved' } };
    },
  },
  employees: {
    label: 'Employees',
    table: 'employees',
    columns: ['employee_code', 'full_name', 'department', 'designation', 'date_of_joining', 'phone', 'email', 'monthly_salary'],
    example: { employee_code: 'EMP-101', full_name: 'Ravi Shankar', department: 'Manufacturing', designation: 'Fitter', date_of_joining: '2024-01-15', phone: '9900011122', email: 'ravi@venkateshwara.example', monthly_salary: 22000 },
    notes: ['full_name is required. employee_code, if given, must be unique.', 'department must match an existing department name exactly (see Admin > Users & Roles, or the departments seeded with the app).'],
    importRow(row) {
      const fullName = String(row.full_name || '').trim();
      if (!fullName) return { error: 'full_name is required' };
      const code = row.employee_code ? String(row.employee_code).trim() : null;
      if (code) {
        const existing = db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(code);
        if (existing) return { error: `duplicate employee_code "${code}" (employee #${existing.id}) - skipped` };
      }
      let deptId = null;
      if (row.department) {
        const dept = db.prepare('SELECT id FROM departments WHERE name = ?').get(String(row.department).trim());
        if (!dept) return { error: `no department named "${row.department}"` };
        deptId = dept.id;
      }
      const doj = optionalDate(row.date_of_joining);
      if (!doj.ok) return { error: 'date_of_joining is not a valid date (YYYY-MM-DD)' };
      return { insert: { employee_code: code, full_name: fullName, department_id: deptId, designation: row.designation || null, date_of_joining: doj.value, phone: row.phone ? String(row.phone) : null, email: row.email || null, monthly_salary: Number(row.monthly_salary) || 0 } };
    },
  },
  expense_tracker_entries: {
    label: 'Expense Tracker Entries',
    table: 'expense_tracker_entries',
    columns: ['category_name', 'entry_date', 'amount', 'notes'],
    example: { category_name: 'Diesel', entry_date: '2026-04-05', amount: 1500, notes: 'Generator diesel refill' },
    notes: [
      'category_name must match an existing Monthly Expense Tracker category exactly (see Finance > Expense Tracker - Categories).',
      'entry_date: Daily categories use the actual date (YYYY-MM-DD); Fixed categories use the 1st of the month (YYYY-MM-01).',
      'Re-running with the same category_name + entry_date updates that entry (matches the existing UNIQUE constraint), so re-imports are safe.',
    ],
    importRow(row) {
      const catName = String(row.category_name || '').trim();
      if (!catName) return { error: 'category_name is required' };
      const cat = db.prepare('SELECT id FROM expense_tracker_categories WHERE name = ?').get(catName);
      if (!cat) return { error: `no expense tracker category named "${catName}"` };
      const date = normalizeDate(row.entry_date);
      if (!date) return { error: 'entry_date must be YYYY-MM-DD' };
      const amount = Number(row.amount);
      if (!amount) return { error: 'amount must be a non-zero number' };
      return { upsert: { category_id: cat.id, entry_date: date, amount, notes: row.notes || null } };
    },
  },
  site_visits: {
    label: 'Site Visits',
    table: 'site_visits',
    columns: ['site_name', 'client_name', 'purpose', 'status', 'arrival_date', 'close_date', 'engineer_names', 'expenses_note'],
    example: { site_name: 'ABC Industries - Boiler Install', client_name: 'ABC Industries', purpose: 'Boiler commissioning', status: 'Working', arrival_date: '2026-04-01', close_date: '', engineer_names: 'Ravi Shankar, Suresh Patil', expenses_note: 'All expenses in customer scope' },
    notes: [
      'site_name is required. status must be one of Pending, Working, Hold, Closed (default Pending).',
      'client_name, if given, is looked up by exact name against Clients - leave blank if unknown.',
      'engineer_names is a comma-separated list of employee full names, resolved against the Employees master (site_visit_engineers).',
    ],
    importRow(row) {
      const siteName = String(row.site_name || '').trim();
      if (!siteName) return { error: 'site_name is required' };
      const status = row.status ? String(row.status).trim() : 'Pending';
      if (!['Pending', 'Working', 'Hold', 'Closed'].includes(status)) return { error: 'status must be Pending/Working/Hold/Closed' };
      let clientId = null;
      if (row.client_name) {
        const c = db.prepare('SELECT id FROM clients WHERE name = ?').get(String(row.client_name).trim());
        if (!c) return { error: `no client named "${row.client_name}"` };
        clientId = c.id;
      }
      const engineerIds = [];
      if (row.engineer_names) {
        const names = String(row.engineer_names).split(',').map(s => s.trim()).filter(Boolean);
        for (const n of names) {
          const e = db.prepare('SELECT id FROM employees WHERE full_name = ?').get(n);
          if (!e) return { error: `no employee named "${n}"` };
          engineerIds.push(e.id);
        }
      }
      const arrival = optionalDate(row.arrival_date);
      if (!arrival.ok) return { error: 'arrival_date is not a valid date (YYYY-MM-DD)' };
      const close = optionalDate(row.close_date);
      if (!close.ok) return { error: 'close_date is not a valid date (YYYY-MM-DD)' };
      return {
        insert: { site_name: siteName, client_id: clientId, purpose: row.purpose || null, status, arrival_date: arrival.value, close_date: close.value, expenses_note: row.expenses_note || null },
        engineerIds,
      };
    },
  },
  bank_guarantees: {
    label: 'Bank Guarantees',
    table: 'bank_guarantees',
    columns: ['bg_no', 'bg_type', 'order_type', 'order_no', 'beneficiary', 'project_code', 'issuing_bank', 'value', 'issue_date', 'validity_expiry', 'claim_expiry', 'milestone_link'],
    examples: [
      { bg_no: 'BG/2026/0042', bg_type: 'Performance', order_type: 'SO', order_no: 'SO-1044', beneficiary: '', project_code: '', issuing_bank: 'HDFC Bank, Faridabad', value: 250000, issue_date: '2026-02-01', validity_expiry: '2027-01-31', claim_expiry: '2027-03-31', milestone_link: 'Release on final acceptance' },
      { bg_no: 'MIG-BG-0001', bg_type: 'Performance', order_type: 'LEGACY', order_no: 'Old ERP ref BG-114 / paper file 2019', beneficiary: 'ABC Industries', project_code: 'PRJ-2019-014', issuing_bank: 'SBI, Faridabad', value: 180000, issue_date: '2019-06-10', validity_expiry: '2026-12-31', claim_expiry: '', milestone_link: '' },
    ],
    notes: [
      'bg_type must be Advance or Performance. order_type must be SO, PO, or LEGACY.',
      'SO/PO: order_no must match an existing Sales Order order_no (order_type=SO) or Purchase Order po_no (order_type=PO) exactly. project_id and beneficiary are auto-derived from the linked order, same as creating a BG from the BG Dashboard - leave beneficiary/project_code blank.',
      'LEGACY: for historical/manual BGs that have no matching Sales/Purchase Order in this system (data migration from an old system or paper records). order_no is stored as a free-text reference only (e.g. the old system\'s own BG/order number) and is not validated. beneficiary is required (it cannot be auto-derived without a linked order). project_code is optional - if given, it must match an existing Project Code exactly.',
      'value and validity_expiry are required. Dates are YYYY-MM-DD.',
      'bg_no, if given, must be unique - re-running with the same bg_no updates that BG\'s bank/value/dates/milestone_link (safe to re-import). A row with no bg_no is always inserted as a new BG. For LEGACY rows, giving each one a stable bg_no (e.g. a sequential migration number like MIG-BG-0001, or the old system\'s own BG number) is strongly recommended so re-imports stay idempotent and the record is traceable back to its source.',
    ],
    importRow(row) {
      const bgType = String(row.bg_type || '').trim();
      if (!['Advance', 'Performance'].includes(bgType)) return { error: 'bg_type must be Advance or Performance' };
      const orderType = String(row.order_type || '').trim();
      if (!['SO', 'PO', 'LEGACY'].includes(orderType)) return { error: 'order_type must be SO, PO or LEGACY' };
      const value = Number(row.value);
      if (!value) return { error: 'value must be a non-zero number' };
      const validityExpiry = normalizeDate(row.validity_expiry);
      if (!validityExpiry) return { error: 'validity_expiry must be a valid date (YYYY-MM-DD)' };
      const issueDate = optionalDate(row.issue_date);
      if (!issueDate.ok) return { error: 'issue_date is not a valid date (YYYY-MM-DD)' };
      const claimExpiry = optionalDate(row.claim_expiry);
      if (!claimExpiry.ok) return { error: 'claim_expiry is not a valid date (YYYY-MM-DD)' };
      const bgNo = row.bg_no ? String(row.bg_no).trim() : null;

      let orderId = 0, projectId = null, beneficiary, legacyRef = null;
      if (orderType === 'LEGACY') {
        beneficiary = String(row.beneficiary || '').trim();
        if (!beneficiary) return { error: 'beneficiary is required when order_type is LEGACY' };
        if (row.project_code) {
          const project = db.prepare('SELECT id FROM projects WHERE project_code = ?').get(String(row.project_code).trim());
          if (!project) return { error: `no project with project_code "${row.project_code}"` };
          projectId = project.id;
        }
        legacyRef = row.order_no ? String(row.order_no).trim() : null;
      } else {
        const orderNo = String(row.order_no || '').trim();
        if (!orderNo) return { error: 'order_no is required' };
        let order;
        if (orderType === 'SO') {
          order = db.prepare('SELECT so.id, c.name as party_name FROM sales_orders so JOIN clients c ON c.id = so.client_id WHERE so.order_no = ?').get(orderNo);
          if (!order) return { error: `no Sales Order with order_no "${orderNo}"` };
          const project = db.prepare('SELECT id FROM projects WHERE sales_order_id = ?').get(order.id);
          projectId = project ? project.id : null;
        } else {
          order = db.prepare('SELECT po.id, v.name as party_name FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE po.po_no = ?').get(orderNo);
          if (!order) return { error: `no Purchase Order with po_no "${orderNo}"` };
          const pr = db.prepare('SELECT purchase_request_id FROM purchase_orders WHERE id = ?').get(order.id);
          const prRow = pr && pr.purchase_request_id ? db.prepare('SELECT project_id FROM purchase_requests WHERE id = ?').get(pr.purchase_request_id) : null;
          projectId = prRow ? prRow.project_id : null;
        }
        orderId = order.id;
        beneficiary = order.party_name;
      }

      return {
        upsert: {
          bg_no: bgNo, bg_type: bgType, order_type: orderType, order_id: orderId, project_id: projectId,
          issuing_bank: row.issuing_bank || null, beneficiary, value,
          issue_date: issueDate.value, validity_expiry: validityExpiry,
          claim_expiry: claimExpiry.value, milestone_link: row.milestone_link || null,
          legacy_ref: legacyRef,
        },
      };
    },
  },
  daily_work_logs: {
    label: 'Daily Work Log',
    table: 'daily_work_logs',
    columns: ['employee_name', 'log_date', 'note'],
    example: { employee_name: 'Ravi Shankar', log_date: '2026-04-05', note: 'Boiler commissioning at ABC Industries' },
    notes: [
      'employee_name must match an existing Employees full_name exactly.',
      'log_date is YYYY-MM-DD. Re-running with the same employee_name + log_date updates that day\'s note (matches the existing UNIQUE constraint), so re-imports are safe.',
    ],
    importRow(row) {
      const empName = String(row.employee_name || '').trim();
      if (!empName) return { error: 'employee_name is required' };
      const emp = db.prepare('SELECT id FROM employees WHERE full_name = ?').get(empName);
      if (!emp) return { error: `no employee named "${empName}"` };
      const date = normalizeDate(row.log_date);
      if (!date) return { error: 'log_date must be a valid date (YYYY-MM-DD)' };
      const note = String(row.note || '').trim();
      if (!note) return { error: 'note is required' };
      return { upsert: { employee_id: emp.id, log_date: date, note } };
    },
  },
};
 
router.get('/entities', (req, res) => {
  res.json(Object.entries(ENTITIES).map(([id, e]) => ({ id, label: e.label })));
});
 
router.get('/:entity/template', (req, res) => {
  const entity = ENTITIES[req.params.entity];
  if (!entity) return res.status(404).json({ error: 'Unknown entity' });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(entity.examples || [entity.example], { header: entity.columns });
  XLSX.utils.book_append_sheet(wb, ws, entity.label.slice(0, 31));
  const note = XLSX.utils.aoa_to_sheet([['Notes'], ...entity.notes.map(n => [n])]);
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}_import_template.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
 
router.post('/:entity/upload', uploadMemory.single('file'), (req, res) => {
  const entity = ENTITIES[req.params.entity];
  if (!entity) return res.status(404).json({ error: 'Unknown entity' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' }); }
 
  let inserted = 0; const errors = [];
  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      const rowNum = i + 2;
      let result;
      try { result = entity.importRow(row, { user: req.user }); }
      catch (e) { errors.push(`Row ${rowNum}: ${e.message}`); return; }
      if (!result || result.error) { errors.push(`Row ${rowNum}: ${(result && result.error) || 'invalid row'} - skipped.`); return; }
      if (result.insert) {
        const cols = Object.keys(result.insert);
        try {
          const info = db.prepare(`INSERT INTO ${entity.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
            .run(...cols.map(c => result.insert[c]));
          if (entity.table === 'site_visits' && result.engineerIds && result.engineerIds.length) {
            const insEng = db.prepare('INSERT OR IGNORE INTO site_visit_engineers (site_visit_id, employee_id) VALUES (?,?)');
            result.engineerIds.forEach(eid => insEng.run(info.lastInsertRowid, eid));
          }
          inserted++;
        } catch (e) { errors.push(`Row ${rowNum}: ${e.message} - skipped.`); }
      } else if (result.upsert) {
        // Entities with a UNIQUE constraint use upsert semantics so re-running
        // the same file is idempotent (matches stock-movements bulk-upload's
        // "safe to re-run" spirit, adapted for entities that have real
        // natural keys instead of always-additive movement rows).
        if (entity.table === 'expense_tracker_entries') {
          db.prepare(`
            INSERT INTO expense_tracker_entries (category_id, entry_date, amount, notes, created_by, updated_by)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(category_id, entry_date) DO UPDATE SET amount = excluded.amount, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
          `).run(result.upsert.category_id, result.upsert.entry_date, result.upsert.amount, result.upsert.notes, req.user.id, req.user.id);
          inserted++;
        } else if (entity.table === 'daily_work_logs') {
          db.prepare(`
            INSERT INTO daily_work_logs (employee_id, log_date, note, created_by, updated_by)
            VALUES (?,?,?,?,?)
            ON CONFLICT(employee_id, log_date) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
          `).run(result.upsert.employee_id, result.upsert.log_date, result.upsert.note, req.user.id, req.user.id);
          inserted++;
        } else if (entity.table === 'bank_guarantees') {
          // bg_no has a UNIQUE index but is nullable - a row with a bg_no
          // upserts on it (safe re-import); a row with no bg_no has nothing
          // to match against, so it's always inserted as a new BG.
          const u = result.upsert;
          if (u.bg_no) {
            db.prepare(`
              INSERT INTO bank_guarantees (bg_no, bg_type, order_type, order_id, project_id, issuing_bank, beneficiary, value, issue_date, validity_expiry, claim_expiry, milestone_link, legacy_ref, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(bg_no) DO UPDATE SET
                bg_type = excluded.bg_type, order_type = excluded.order_type, order_id = excluded.order_id,
                project_id = excluded.project_id, issuing_bank = excluded.issuing_bank, beneficiary = excluded.beneficiary,
                value = excluded.value, issue_date = excluded.issue_date, validity_expiry = excluded.validity_expiry,
                claim_expiry = excluded.claim_expiry, milestone_link = excluded.milestone_link, legacy_ref = excluded.legacy_ref
            `).run(u.bg_no, u.bg_type, u.order_type, u.order_id, u.project_id, u.issuing_bank, u.beneficiary, u.value, u.issue_date, u.validity_expiry, u.claim_expiry, u.milestone_link, u.legacy_ref, req.user.id);
          } else {
            db.prepare(`
              INSERT INTO bank_guarantees (bg_no, bg_type, order_type, order_id, project_id, issuing_bank, beneficiary, value, issue_date, validity_expiry, claim_expiry, milestone_link, legacy_ref, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(null, u.bg_type, u.order_type, u.order_id, u.project_id, u.issuing_bank, u.beneficiary, u.value, u.issue_date, u.validity_expiry, u.claim_expiry, u.milestone_link, u.legacy_ref, req.user.id);
          }
          inserted++;
        }
      }
    });
  });
  tx();
  res.json({ inserted, skipped: errors.length, errors });
});
 
module.exports = router;
 

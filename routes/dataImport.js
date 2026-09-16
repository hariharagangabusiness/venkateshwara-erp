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
      return { insert: { employee_code: code, full_name: fullName, department_id: deptId, designation: row.designation || null, date_of_joining: row.date_of_joining || null, phone: row.phone ? String(row.phone) : null, email: row.email || null, monthly_salary: Number(row.monthly_salary) || 0 } };
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
      const date = String(row.entry_date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'entry_date must be YYYY-MM-DD' };
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
      return {
        insert: { site_name: siteName, client_id: clientId, purpose: row.purpose || null, status, arrival_date: row.arrival_date || null, close_date: row.close_date || null, expenses_note: row.expenses_note || null },
        engineerIds,
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
      const date = String(row.log_date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'log_date must be YYYY-MM-DD' };
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
  const ws = XLSX.utils.json_to_sheet([entity.example], { header: entity.columns });
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
        }
      }
    });
  });
  tx();
  res.json({ inserted, skipped: errors.length, errors });
});

module.exports = router;

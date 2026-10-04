const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const approvals = require('../lib/approvals');
const { inOversightDept, oversightDepartmentIds } = require('../lib/roleOversight');
const router = express.Router();
router.use(authRequired);

const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
// Matches every field on the Add Employee form (public/js/app.js's
// addEmployee()) in the same order, so a one-time migration of existing
// employee data can be done entirely via this one template instead of
// hand-entering each employee afterward to fill in the rest. Deliberately
// excludes `bank_account` - a legacy column the Add Employee form itself
// doesn't use either (it writes bank_name/account_number/ifsc_code), kept
// only for old data and the Edit Employee screen.
const EMPLOYEE_TEMPLATE_COLUMNS = [
  'employee_code', 'full_name', 'department', 'designation', 'employment_type', 'date_of_joining',
  'phone', 'email', 'monthly_salary', 'pan_number', 'blood_group',
  'emergency_contact_name', 'emergency_contact_phone', 'address',
  'bank_name', 'account_number', 'ifsc_code',
  'aadhaar_number', 'passport_number', 'visa_availability', 'driving_license_number',
];
const EMPLOYMENT_TYPES = ['Full-time', 'Contract', 'Probation', 'Intern'];

// ---- Employees ----
router.get('/employees', (req, res) => {
  res.json(db.prepare(`
    SELECT e.*, d.name as department_name FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    ORDER BY e.full_name
  `).all());
});
// Must be registered before GET /employees/:id below - Express matches
// routes in registration order, and :id matches ANY path segment
// (including the literal string "template"), so this was previously
// unreachable: a request for this route was always caught by the :id
// handler first, which treated "template" as an employee id, found no
// such row, and returned a plain 404 - "Download Template" never actually
// worked. Same reasoning applies to bulk-upload below, though that one
// never collided in practice since it's a POST, not a GET.
//
// Downloadable Excel template for bulk employee upload - headers plus one
// example row, and a Departments sheet listing the exact department names
// to use (department is matched by name, case-insensitively, on upload).
router.get('/employees/template', requirePermission('payroll.manage'), (req, res) => {
  const depts = db.prepare('SELECT name FROM departments ORDER BY name').all().map(d => d.name);
  const wb = XLSX.utils.book_new();
  const exampleRow = {
    employee_code: 'EMP-1001', full_name: 'Jane Doe', department: depts[0] || 'Design', designation: 'Engineer',
    employment_type: 'Full-time', date_of_joining: '2024-01-15', phone: '9876543210', email: 'jane@example.com',
    monthly_salary: 25000, pan_number: 'ABCDE1234F', blood_group: 'O+',
    emergency_contact_name: 'John Doe', emergency_contact_phone: '9123456780', address: 'Faridabad',
    bank_name: 'State Bank of India', account_number: '000123456789', ifsc_code: 'SBIN0001234',
    aadhaar_number: '123456789012', passport_number: '', visa_availability: '', driving_license_number: '',
  };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: EMPLOYEE_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  const deptWs = XLSX.utils.aoa_to_sheet([['Department Names (use exactly as spelled here)'], ...depts.map(d => [d])]);
  XLSX.utils.book_append_sheet(wb, deptWs, 'Departments');
  const empTypeWs = XLSX.utils.aoa_to_sheet([['Employment Type (use exactly as spelled here)'], ...EMPLOYMENT_TYPES.map(t => [t])]);
  XLSX.utils.book_append_sheet(wb, empTypeWs, 'Employment Types');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="employee_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
router.get('/employees/:id', (req, res) => {
  const e = db.prepare(`
    SELECT emp.*, d.name as department_name FROM employees emp LEFT JOIN departments d ON d.id = emp.department_id WHERE emp.id = ?
  `).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  res.json(e);
});
router.post('/employees', requirePermission('payroll.manage'), (req, res) => {
  const { employee_code, full_name, department_id, designation, date_of_joining, phone, email, address, bank_account,
    monthly_salary, reporting_manager_id, employment_type, pan_number, blood_group, emergency_contact_name, emergency_contact_phone,
    bank_name, account_number, ifsc_code, aadhaar_number, passport_number, visa_availability, driving_license_number,
    referred_by_employee_id, referral_incentive_amount, probation_end_date } = req.body;
  // Nothing enforced this before, so an employee could be added with the
  // Full Name field left blank - it saved silently and then sat in the
  // Employees table forever with a blank Name column, with no obvious way
  // to tell which row that even was. Bulk-upload already required this;
  // the single Add Employee form and API just never did.
  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: 'Full Name is required.' });
  }
  if (referred_by_employee_id) {
    const referrer = db.prepare('SELECT id FROM employees WHERE id = ?').get(referred_by_employee_id);
    if (!referrer) return res.status(400).json({ error: 'That referring employee no longer exists - refresh the page and pick again.' });
  }
  const info = db.prepare(`
    INSERT INTO employees (employee_code, full_name, department_id, designation, date_of_joining, phone, email, address, bank_account,
      monthly_salary, reporting_manager_id, employment_type, pan_number, blood_group, emergency_contact_name, emergency_contact_phone,
      bank_name, account_number, ifsc_code, aadhaar_number, passport_number, visa_availability, driving_license_number,
      referred_by_employee_id, referral_incentive_amount, probation_end_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(employee_code, full_name, department_id, designation, date_of_joining, phone, email, address, bank_account, monthly_salary || 0,
    reporting_manager_id || null, employment_type || 'Full-time', pan_number || null, blood_group || null,
    emergency_contact_name || null, emergency_contact_phone || null,
    bank_name || null, account_number || null, ifsc_code || null, aadhaar_number || null, passport_number || null,
    visa_availability || null, driving_license_number || null,
    referred_by_employee_id || null, referral_incentive_amount || 0, probation_end_date || null);
  // A referral only ever produces one referral_incentives row, created here
  // at hire time - not something HR adds separately later. No incentive
  // amount or no referrer means nothing to track, so this silently no-ops
  // rather than creating a zero-value row that would just clutter the list.
  if (referred_by_employee_id && Number(referral_incentive_amount) > 0) {
    db.prepare(`
      INSERT INTO referral_incentives (employee_id, referred_by_employee_id, incentive_amount, probation_end_date, created_by)
      VALUES (?,?,?,?,?)
    `).run(info.lastInsertRowid, referred_by_employee_id, Number(referral_incentive_amount), probation_end_date || null, req.user.id);
  }
  res.json({ id: info.lastInsertRowid });
});
// Full edit - every field on the employee master is editable, including
// employee code, date of joining and reporting manager (not just the
// handful the old version allowed), plus a Resigned/Terminated status can
// carry an exit date.
router.put('/employees/:id', requirePermission('payroll.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const f = req.body;
  if (f.full_name !== undefined && !String(f.full_name).trim()) {
    return res.status(400).json({ error: 'Full Name cannot be blank.' });
  }
  const pick = (key, fallback) => (f[key] !== undefined ? f[key] : fallback);
  const newStatus = pick('status', existing.status) || 'active';
  db.prepare(`
    UPDATE employees SET employee_code=?, full_name=?, department_id=?, designation=?, date_of_joining=?, phone=?, email=?, address=?,
      bank_account=?, monthly_salary=?, status=?, reporting_manager_id=?, employment_type=?, pan_number=?, blood_group=?,
      emergency_contact_name=?, emergency_contact_phone=?, exit_date=?,
      bank_name=?, account_number=?, ifsc_code=?, aadhaar_number=?, passport_number=?, visa_availability=?, driving_license_number=?,
      referred_by_employee_id=?, referral_incentive_amount=?, probation_end_date=?, exit_reason=?, exit_recommendation=?
    WHERE id=?
  `).run(
    pick('employee_code', existing.employee_code), pick('full_name', existing.full_name), pick('department_id', existing.department_id),
    pick('designation', existing.designation), pick('date_of_joining', existing.date_of_joining), pick('phone', existing.phone),
    pick('email', existing.email), pick('address', existing.address), pick('bank_account', existing.bank_account),
    pick('monthly_salary', existing.monthly_salary), newStatus,
    f.reporting_manager_id !== undefined ? (f.reporting_manager_id || null) : existing.reporting_manager_id,
    pick('employment_type', existing.employment_type) || 'Full-time', pick('pan_number', existing.pan_number),
    pick('blood_group', existing.blood_group), pick('emergency_contact_name', existing.emergency_contact_name),
    pick('emergency_contact_phone', existing.emergency_contact_phone), pick('exit_date', existing.exit_date) || null,
    pick('bank_name', existing.bank_name), pick('account_number', existing.account_number), pick('ifsc_code', existing.ifsc_code),
    pick('aadhaar_number', existing.aadhaar_number), pick('passport_number', existing.passport_number),
    pick('visa_availability', existing.visa_availability), pick('driving_license_number', existing.driving_license_number),
    f.referred_by_employee_id !== undefined ? (f.referred_by_employee_id || null) : existing.referred_by_employee_id,
    pick('referral_incentive_amount', existing.referral_incentive_amount),
    pick('probation_end_date', existing.probation_end_date) || null,
    pick('exit_reason', existing.exit_reason) || null, pick('exit_recommendation', existing.exit_recommendation) || null,
    existing.id
  );
  // An employee who is THEMSELVES a referred hire still has a live
  // referral_incentives row (status PendingProbation/Eligible/PendingApproval)
  // right up until their own probation completes - if they exit before that,
  // the incentive their referrer would have earned is forfeited immediately,
  // not left to sit until the next scan run picks up a status that no longer
  // makes sense (an exited employee can never become 'Eligible').
  if (['resigned', 'terminated'].includes(newStatus) && !['resigned', 'terminated'].includes(existing.status)) {
    const live = db.prepare(`
      SELECT * FROM referral_incentives WHERE employee_id = ? AND status IN ('PendingProbation', 'Eligible', 'PendingApproval')
    `).get(existing.id);
    if (live) {
      db.prepare(`UPDATE referral_incentives SET status = 'Forfeited' WHERE id = ?`).run(live.id);
      if (live.approval_id) {
        db.prepare(`UPDATE approvals SET status = 'Cancelled' WHERE id = ? AND status IN ('Pending', 'InfoRequested')`).run(live.approval_id);
      }
    }
  }
  res.json({ ok: true });
});

// Bulk-create or bulk-update employees from a filled-in copy of the template
// above - matched by employee_code (the durable identifier). Re-uploading
// the same file after changing a field (e.g. date_of_joining) for an
// existing employee_code now applies that change instead of being rejected
// as a duplicate. A blank cell never overwrites an existing value, so a
// partial re-export/re-import can't accidentally wipe a field the file just
// didn't happen to carry - same "upsert, blank never wins" rule as the
// Vendor/Item Master bulk-uploads (routes/masters.js). A row with no
// employee_code has nothing to match against, so it's always inserted as a
// new employee, same as before.
router.post('/employees/bulk-upload', requirePermission('payroll.manage'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' });
  }
  const depts = db.prepare('SELECT id, name FROM departments').all();
  const deptByName = new Map(depts.map(d => [d.name.trim().toLowerCase(), d.id]));
  const empTypeByLower = new Map(EMPLOYMENT_TYPES.map(t => [t.toLowerCase(), t]));
  // Full employees-table column list, in the same order as
  // EMPLOYEE_TEMPLATE_COLUMNS (department/employment_type are looked up/
  // normalized separately below - their raw spreadsheet values aren't valid
  // column values directly).
  const cols = [
    'employee_code', 'full_name', 'department_id', 'designation', 'employment_type', 'date_of_joining',
    'phone', 'email', 'monthly_salary', 'pan_number', 'blood_group',
    'emergency_contact_name', 'emergency_contact_phone', 'address',
    'bank_name', 'account_number', 'ifsc_code',
    'aadhaar_number', 'passport_number', 'visa_availability', 'driving_license_number',
  ];
  const insert = db.prepare(`INSERT INTO employees (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const findByCode = db.prepare('SELECT * FROM employees WHERE employee_code = ?');
  let inserted = 0, updated = 0;
  const errors = [];
  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      const rowNum = i + 2; // header is row 1 in the spreadsheet
      const fullName = String(row.full_name || '').trim();
      if (!fullName) { errors.push(`Row ${rowNum}: full_name is required - skipped.`); return; }
      const deptName = String(row.department || '').trim();
      const deptId = deptName ? deptByName.get(deptName.toLowerCase()) : null;
      if (deptName && !deptId) { errors.push(`Row ${rowNum}: department "${deptName}" not recognized - skipped.`); return; }
      const empTypeRaw = String(row.employment_type || '').trim();
      const empType = empTypeRaw ? empTypeByLower.get(empTypeRaw.toLowerCase()) : null;
      if (empTypeRaw && !empType) { errors.push(`Row ${rowNum}: employment_type "${empTypeRaw}" not recognized - skipped. Use one of: ${EMPLOYMENT_TYPES.join(', ')}.`); return; }
      const code = String(row.employee_code || '').trim() || null;
      const existing = code ? findByCode.get(code) : null;
      if (existing) {
        const values = cols.map(c => {
          if (c === 'employee_code') return code;
          if (c === 'full_name') return fullName;
          if (c === 'department_id') return deptName ? deptId : existing.department_id;
          if (c === 'employment_type') return empType || existing.employment_type;
          if (c === 'monthly_salary') return (String(row.monthly_salary || '').trim() !== '') ? Number(row.monthly_salary) : existing.monthly_salary;
          const raw = String(row[c] || '').trim();
          return raw !== '' ? raw : existing[c];
        });
        db.prepare(`UPDATE employees SET ${cols.map(c => `${c} = ?`).join(',')} WHERE id = ?`).run(...values, existing.id);
        updated++;
        return;
      }
      const values = cols.map(c => {
        if (c === 'employee_code') return code;
        if (c === 'full_name') return fullName;
        if (c === 'department_id') return deptId || null;
        if (c === 'employment_type') return empType || 'Full-time';
        if (c === 'monthly_salary') return Number(row.monthly_salary) || 0;
        return String(row[c] || '').trim() || null;
      });
      insert.run(...values);
      inserted++;
    });
  });
  tx();
  res.json({ inserted, updated, skipped: errors.length, errors });
});

// ---- Attendance ----
router.get('/attendance', (req, res) => {
  const { month, employee_id } = req.query;
  let q = 'SELECT a.*, e.full_name FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE 1=1';
  const params = [];
  if (month) { q += " AND a.work_date LIKE ?"; params.push(month + '%'); }
  if (employee_id) { q += ' AND a.employee_id = ?'; params.push(employee_id); }
  q += ' ORDER BY a.work_date DESC';
  res.json(db.prepare(q).all(...params));
});
router.post('/attendance/mark', requirePermission('attendance.manage'), (req, res) => {
  const { employee_id, work_date, status, check_in, check_out, remarks } = req.body;
  db.prepare(`
    INSERT INTO attendance (employee_id, work_date, status, check_in, check_out, remarks)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(employee_id, work_date) DO UPDATE SET status=excluded.status, check_in=excluded.check_in, check_out=excluded.check_out, remarks=excluded.remarks
  `).run(employee_id, work_date, status, check_in, check_out, remarks);
  res.json({ ok: true });
});
router.post('/attendance/bulk-mark', requirePermission('attendance.manage'), (req, res) => {
  const { work_date, entries } = req.body; // entries: [{employee_id, status}]
  const stmt = db.prepare(`
    INSERT INTO attendance (employee_id, work_date, status) VALUES (?,?,?)
    ON CONFLICT(employee_id, work_date) DO UPDATE SET status=excluded.status
  `);
  const tx = db.transaction((rows) => rows.forEach(r => stmt.run(r.employee_id, work_date, r.status)));
  tx(entries);
  res.json({ ok: true, count: entries.length });
});

const ATTENDANCE_TEMPLATE_COLUMNS = ['employee_code', 'work_date', 'status', 'check_in', 'check_out', 'remarks'];
router.get('/attendance/template', requirePermission('attendance.manage'), (req, res) => {
  const exampleRow = { employee_code: 'EMP-1001', work_date: '2026-09-01', status: 'Present', check_in: '09:00', check_out: '18:00', remarks: '' };
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: ATTENDANCE_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
  const note = XLSX.utils.aoa_to_sheet([['Notes'],
    ['status must be one of: Present, Absent, HalfDay, Leave, Holiday, WeekOff'],
    ['work_date format: YYYY-MM-DD. One row per employee per day - re-uploading the same employee/date overwrites that day.']]);
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="attendance_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
router.post('/attendance/bulk-upload', requirePermission('attendance.manage'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' }); }
  const VALID_STATUSES = new Set(['Present', 'Absent', 'HalfDay', 'Leave', 'Holiday', 'WeekOff']);
  const findEmp = db.prepare('SELECT id FROM employees WHERE employee_code = ?');
  const upsert = db.prepare(`
    INSERT INTO attendance (employee_id, work_date, status, check_in, check_out, remarks) VALUES (?,?,?,?,?,?)
    ON CONFLICT(employee_id, work_date) DO UPDATE SET status=excluded.status, check_in=excluded.check_in, check_out=excluded.check_out, remarks=excluded.remarks
  `);
  let inserted = 0; const errors = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const code = String(row.employee_code || '').trim();
    if (!code) { errors.push(`Row ${rowNum}: employee_code is required - skipped.`); return; }
    const emp = findEmp.get(code);
    if (!emp) { errors.push(`Row ${rowNum}: no employee with code "${code}" - skipped.`); return; }
    const workDate = String(row.work_date || '').trim();
    if (!workDate) { errors.push(`Row ${rowNum}: work_date is required - skipped.`); return; }
    const status = String(row.status || '').trim();
    if (!VALID_STATUSES.has(status)) { errors.push(`Row ${rowNum}: status "${status}" is not valid - skipped.`); return; }
    upsert.run(emp.id, workDate, status, String(row.check_in || '') || null, String(row.check_out || '') || null, String(row.remarks || '') || null);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors });
});

// ---- Leave ----
router.get('/leave-requests', (req, res) => {
  res.json(db.prepare(`
    SELECT lr.*, e.full_name, lt.name as leave_type_name FROM leave_requests lr
    JOIN employees e ON e.id = lr.employee_id JOIN leave_types lt ON lt.id = lr.leave_type_id
    ORDER BY lr.id DESC
  `).all());
});
router.post('/leave-requests', (req, res) => {
  const { employee_id, leave_type_id, from_date, to_date, days, reason } = req.body;
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
  const leaveType = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(leave_type_id);
  if (!employee || !leaveType) return res.status(400).json({ error: 'Pick a valid employee and leave type.' });
  // Probation gate: this leave type isn't available until the employee has
  // completed leaveType.probation_months of service from their joining date.
  if (leaveType.probation_months > 0 && employee.date_of_joining) {
    const monthsServed = monthsBetween(employee.date_of_joining, from_date || today());
    if (monthsServed < leaveType.probation_months) {
      return res.status(400).json({
        error: `${leaveType.name} leave isn't available during probation - eligible after ${leaveType.probation_months} month(s) of service (currently ${monthsServed}).`
      });
    }
  }
  const info = db.prepare(`
    INSERT INTO leave_requests (employee_id, leave_type_id, from_date, to_date, days, reason)
    VALUES (?,?,?,?,?,?)
  `).run(employee_id, leave_type_id, from_date, to_date, days, reason);
  const approvalId = approvals.startApproval('Leave', 'leave_request', info.lastInsertRowid, 0, req.user.id);
  db.prepare('UPDATE leave_requests SET approval_id = ? WHERE id = ?').run(approvalId, info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, approval_id: approvalId });
});

function today() { return new Date().toISOString().slice(0, 10); }
function monthsBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr), to = new Date(toDateStr);
  return Math.max(0, (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + (to.getDate() >= from.getDate() ? 0 : -1));
}

// ---- Leave Types & Leave Balances Master ----
// Leave type config drives both eligibility (probation_months) and payroll
// impact (is_paid - an unpaid leave type reduces that month's pay; a paid
// one doesn't). carry_forward/max_carry_forward are informational fields an
// HR admin can use when manually adjusting a following year's allocation
// (this app doesn't auto-roll balances year to year).
router.get('/leave-types', (req, res) => res.json(db.prepare('SELECT * FROM leave_types ORDER BY name').all()));
router.post('/leave-types', requirePermission('payroll.manage'), (req, res) => {
  const { name, annual_quota, is_paid, probation_months, accrual, carry_forward, max_carry_forward } = req.body;
  if (!name) return res.status(400).json({ error: 'Leave type name is required.' });
  const info = db.prepare(`
    INSERT INTO leave_types (name, annual_quota, is_paid, probation_months, accrual, carry_forward, max_carry_forward)
    VALUES (?,?,?,?,?,?,?)
  `).run(name, annual_quota || 0, is_paid === false ? 0 : 1, probation_months || 0, accrual || 'Annual', carry_forward ? 1 : 0, max_carry_forward || 0);
  res.json({ id: info.lastInsertRowid });
});
router.put('/leave-types/:id', requirePermission('payroll.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, annual_quota, is_paid, probation_months, accrual, carry_forward, max_carry_forward } = req.body;
  db.prepare(`
    UPDATE leave_types SET name=?, annual_quota=?, is_paid=?, probation_months=?, accrual=?, carry_forward=?, max_carry_forward=? WHERE id=?
  `).run(
    name !== undefined ? name : existing.name, annual_quota !== undefined ? annual_quota : existing.annual_quota,
    is_paid !== undefined ? (is_paid ? 1 : 0) : existing.is_paid,
    probation_months !== undefined ? probation_months : existing.probation_months,
    accrual !== undefined ? accrual : existing.accrual, carry_forward !== undefined ? (carry_forward ? 1 : 0) : existing.carry_forward,
    max_carry_forward !== undefined ? max_carry_forward : existing.max_carry_forward, existing.id
  );
  res.json({ ok: true });
});

// Balance = an explicit per-employee/year override if one's been set,
// otherwise: the Department-scope leave_balance_policy for that
// employee's department/leave-type/year, otherwise the Company-scope
// policy for that leave-type/year, otherwise the leave type's own default
// annual_quota (0 if still on probation for that type) - minus days
// already taken this year across Approved and Pending leave requests.
router.get('/leave-balances', requirePermission('payroll.manage', 'attendance.manage'), (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
  const employees = employeeId
    ? [db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId)].filter(Boolean)
    : db.prepare(`SELECT * FROM employees WHERE status = 'active' ORDER BY full_name`).all();
  const leaveTypes = db.prepare('SELECT * FROM leave_types ORDER BY name').all();
  const overrides = db.prepare('SELECT * FROM employee_leave_balances WHERE year = ?').all(year);
  const overrideMap = new Map(overrides.map(o => [o.employee_id + ':' + o.leave_type_id, o.allocated]));
  const policies = db.prepare('SELECT * FROM leave_balance_policies WHERE year = ?').all(year);
  const companyPolicyMap = new Map(policies.filter(p => p.scope === 'Company').map(p => [p.leave_type_id, p.allocated]));
  const deptPolicyMap = new Map(policies.filter(p => p.scope === 'Department').map(p => [p.department_id + ':' + p.leave_type_id, p.allocated]));
  const usedRows = db.prepare(`
    SELECT employee_id, leave_type_id, SUM(days) as used FROM leave_requests
    WHERE status IN ('Approved','Pending') AND from_date LIKE ? GROUP BY employee_id, leave_type_id
  `).all(year + '%');
  const usedMap = new Map(usedRows.map(r => [r.employee_id + ':' + r.leave_type_id, r.used]));
  const out = [];
  employees.forEach(e => {
    leaveTypes.forEach(lt => {
      const key = e.id + ':' + lt.id;
      const onProbation = lt.probation_months > 0 && e.date_of_joining && monthsBetween(e.date_of_joining, year + '-12-31') < lt.probation_months;
      const deptKey = e.department_id + ':' + lt.id;
      let source = 'LeaveTypeDefault';
      let resolvedAllocated = lt.annual_quota;
      if (companyPolicyMap.has(lt.id)) { resolvedAllocated = companyPolicyMap.get(lt.id); source = 'Company'; }
      if (e.department_id != null && deptPolicyMap.has(deptKey)) { resolvedAllocated = deptPolicyMap.get(deptKey); source = 'Department'; }
      const defaultAllocated = onProbation ? 0 : resolvedAllocated;
      const allocated = overrideMap.has(key) ? overrideMap.get(key) : defaultAllocated;
      const used = usedMap.get(key) || 0;
      out.push({
        employee_id: e.id, employee_name: e.full_name, leave_type_id: lt.id, leave_type_name: lt.name,
        is_paid: lt.is_paid, allocated, used, balance: allocated - used, overridden: overrideMap.has(key), on_probation: onProbation, source,
      });
    });
  });
  res.json(out);
});
router.put('/leave-balances', requirePermission('payroll.manage'), (req, res) => {
  const { employee_id, leave_type_id, year, allocated } = req.body;
  if (!employee_id || !leave_type_id || !year) return res.status(400).json({ error: 'employee_id, leave_type_id and year are required.' });
  db.prepare(`
    INSERT INTO employee_leave_balances (employee_id, leave_type_id, year, allocated) VALUES (?,?,?,?)
    ON CONFLICT(employee_id, leave_type_id, year) DO UPDATE SET allocated = excluded.allocated
  `).run(employee_id, leave_type_id, year, allocated || 0);
  res.json({ ok: true });
});

// ---- Leave Balance Policies (Round 3): Company-wide and Department-level ----
router.get('/leave-balance-policies', requirePermission('payroll.manage', 'attendance.manage'), (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const rows = db.prepare(`
    SELECT p.*, lt.name as leave_type_name, d.name as department_name
    FROM leave_balance_policies p
    JOIN leave_types lt ON lt.id = p.leave_type_id
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE p.year = ? ORDER BY p.scope, d.name, lt.name
  `).all(year);
  res.json(rows);
});
router.put('/leave-balance-policies', requirePermission('payroll.manage'), (req, res) => {
  const { scope, department_id, leave_type_id, year, allocated } = req.body;
  if (!scope || !leave_type_id || !year) return res.status(400).json({ error: 'scope, leave_type_id and year are required.' });
  if (scope === 'Department' && !department_id) return res.status(400).json({ error: 'department_id is required for Department scope.' });
  const deptId = scope === 'Company' ? null : department_id;
  // SQLite treats each NULL as distinct for UNIQUE, so ON CONFLICT can't
  // dedupe Company-scope rows (department_id IS NULL) - upsert manually.
  const existing = deptId == null
    ? db.prepare('SELECT id FROM leave_balance_policies WHERE scope = ? AND department_id IS NULL AND leave_type_id = ? AND year = ?').get(scope, leave_type_id, year)
    : db.prepare('SELECT id FROM leave_balance_policies WHERE scope = ? AND department_id = ? AND leave_type_id = ? AND year = ?').get(scope, deptId, leave_type_id, year);
  if (existing) {
    db.prepare('UPDATE leave_balance_policies SET allocated = ? WHERE id = ?').run(allocated || 0, existing.id);
  } else {
    db.prepare(`INSERT INTO leave_balance_policies (scope, department_id, leave_type_id, year, allocated) VALUES (?,?,?,?,?)`)
      .run(scope, deptId, leave_type_id, year, allocated || 0);
  }
  res.json({ ok: true });
});

// ---- Salary Advances ----
router.get('/advances', (req, res) => {
  res.json(db.prepare(`
    SELECT sa.*, e.full_name FROM salary_advances sa JOIN employees e ON e.id = sa.employee_id ORDER BY sa.id DESC
  `).all());
});
// installments (default 1) lets the requester spread recovery over several
// payroll cycles instead of the whole amount coming out of the very next
// salary - installment_amount is derived (amount / installments) unless
// explicitly overridden.
router.post('/advances', requirePermission('advance.request'), (req, res) => {
  const { employee_id, amount, reason, installments, installment_amount } = req.body;
  const n = Math.max(1, Number(installments) || 1);
  const perInstallment = Number(installment_amount) || Math.ceil((Number(amount) || 0) / n);
  const info = db.prepare(`
    INSERT INTO salary_advances (employee_id, amount, reason, installments, installment_amount) VALUES (?,?,?,?,?)
  `).run(employee_id, amount, reason, n, perInstallment);
  const approvalId = approvals.startApproval('SalaryAdvance', 'salary_advance', info.lastInsertRowid, amount, req.user.id);
  db.prepare('UPDATE salary_advances SET approval_id = ? WHERE id = ?').run(approvalId, info.lastInsertRowid);
  try {
    const emp = db.prepare('SELECT department_id FROM employees WHERE id = ?').get(employee_id);
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, department_id, amount, direction, description, created_by)
      VALUES ('Other', 'salary_advances', ?, ?, ?, 'Outflow', 'Salary advance requested', ?)
    `).run(info.lastInsertRowid, emp ? emp.department_id : null, amount, req.user.id);
  } catch (e) { /* best-effort ledger hook */ }
  res.json({ id: info.lastInsertRowid, approval_id: approvalId });
});

// ---- Salary Schedule / Payroll run ----
router.get('/salary-schedule', (req, res) => {
  const { month } = req.query;
  let q = `SELECT ss.*, e.full_name FROM salary_schedule ss JOIN employees e ON e.id = ss.employee_id WHERE 1=1`;
  const params = [];
  if (month) { q += ' AND ss.month = ?'; params.push(month); }
  q += ' ORDER BY e.full_name';
  res.json(db.prepare(q).all(...params));
});

function daysInMonth(month) { // 'YYYY-MM'
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// Generate a draft payroll run for a month based on attendance, monthly
// salary, unpaid-leave deduction (per leave_types.is_paid - a user-defined
// setting) and each outstanding salary advance's own installment schedule.
router.post('/salary-schedule/generate', requirePermission('payroll.manage'), (req, res) => {
  const { month } = req.body; // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be in YYYY-MM format.' });
  const employees = db.prepare(`SELECT * FROM employees WHERE status = 'active'`).all();
  const dim = daysInMonth(month);
  const tx = db.transaction(() => {
    employees.forEach(e => {
      const presentDays = db.prepare(`
        SELECT COUNT(*) as c FROM attendance WHERE employee_id = ? AND work_date LIKE ? AND status IN ('Present','HalfDay','Leave','Holiday')
      `).get(e.id, month + '%').c;

      // Unpaid-leave deduction: days on Approved leave requests this month
      // whose leave type is configured is_paid = 0, priced at 1/(days in
      // month) of the monthly salary per day.
      const unpaidLeaveDays = db.prepare(`
        SELECT COALESCE(SUM(lr.days),0) as d FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.employee_id = ? AND lr.status = 'Approved' AND lt.is_paid = 0 AND lr.from_date LIKE ?
      `).get(e.id, month + '%').d;
      const leaveDeduction = Math.round((e.monthly_salary / dim) * unpaidLeaveDays);

      // Advance recovery: each outstanding Approved advance contributes its
      // own installment_amount (capped at what's actually still owed) - not
      // one flat rule for everything the employee owes.
      const outstandingAdvances = db.prepare(`
        SELECT * FROM salary_advances WHERE employee_id = ? AND status = 'Approved' AND recovered_amount < amount
      `).all(e.id);
      const advanceDetail = outstandingAdvances.map(a => ({
        advance_id: a.id, amount: Math.min(a.installment_amount || (a.amount - a.recovered_amount), a.amount - a.recovered_amount),
      })).filter(d => d.amount > 0);
      const advanceDeduction = advanceDetail.reduce((s, d) => s + d.amount, 0);

      const gross = e.monthly_salary;
      const totalDeductions = leaveDeduction;
      const net = gross - totalDeductions - advanceDeduction;
      db.prepare(`
        INSERT INTO salary_schedule (month, employee_id, basic, allowances, deductions, advance_deduction, leave_deduction, advance_deduction_detail, days_present, gross, net_pay, status)
        VALUES (?,?,?,0,?,?,?,?,?,?,?, 'Draft')
        ON CONFLICT(month, employee_id) DO UPDATE SET basic=excluded.basic, deductions=excluded.deductions, advance_deduction=excluded.advance_deduction,
          leave_deduction=excluded.leave_deduction, advance_deduction_detail=excluded.advance_deduction_detail,
          days_present=excluded.days_present, gross=excluded.gross, net_pay=excluded.net_pay, status='Draft'
      `).run(month, e.id, e.monthly_salary, totalDeductions, advanceDeduction, leaveDeduction, JSON.stringify(advanceDetail), presentDays, gross, net);
    });
  });
  tx();
  res.json({ ok: true, employees: employees.length });
});

router.post('/salary-schedule/:id/submit-approval', requirePermission('payroll.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM salary_schedule WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const approvalId = approvals.startApproval('Payroll', 'salary_schedule', row.id, row.net_pay, req.user.id);
  db.prepare(`UPDATE salary_schedule SET approval_id = ?, status='Pending' WHERE id = ?`).run(approvalId, row.id);
  res.json({ approval_id: approvalId });
});

router.post('/salary-schedule/:id/mark-paid', requirePermission('payroll.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM salary_schedule WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'Approved') return res.status(400).json({ error: 'Must be Approved before paying' });
  const { cash_or_bank } = req.body;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE salary_schedule SET status='Paid', paid_on = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    db.prepare(`INSERT INTO payroll_vouchers (month, employee_id, amount, voucher_type, cash_or_bank) VALUES (?,?,?,'Salary',?)`)
      .run(row.month, row.employee_id, row.net_pay, cash_or_bank || 'Bank');
    try {
      const emp = db.prepare('SELECT department_id FROM employees WHERE id = ?').get(row.employee_id);
      db.prepare(`
        INSERT INTO finance_ledger (type, reference_table, reference_id, department_id, amount, direction, description, created_by)
        VALUES ('Payroll', 'salary_schedule', ?, ?, ?, 'Outflow', ?, ?)
      `).run(row.id, emp ? emp.department_id : null, row.net_pay, 'Salary paid for ' + row.month, req.user.id);
    } catch (e) { /* best-effort ledger hook */ }
    // Only now - actually paid, not just Draft/Approved - do the advance
    // installments this run accounted for get recorded as recovered.
    // Recomputed from the advance's own current row rather than trusting
    // the JSON as authoritative, in case something changed since generation.
    let detail = [];
    try { detail = JSON.parse(row.advance_deduction_detail || '[]'); } catch (e) { detail = []; }
    detail.forEach(d => {
      const adv = db.prepare('SELECT * FROM salary_advances WHERE id = ?').get(d.advance_id);
      if (!adv) return;
      const applied = Math.min(d.amount, adv.amount - adv.recovered_amount);
      if (applied <= 0) return;
      const newRecovered = adv.recovered_amount + applied;
      const fullyRecovered = newRecovered >= adv.amount;
      db.prepare(`
        UPDATE salary_advances SET recovered_amount = ?, installments_paid = installments_paid + 1, status = ? WHERE id = ?
      `).run(newRecovered, fullyRecovered ? 'Recovered' : adv.status, adv.id);
      try {
        const emp = db.prepare('SELECT department_id FROM employees WHERE id = ?').get(adv.employee_id);
        db.prepare(`
          INSERT INTO finance_ledger (type, reference_table, reference_id, department_id, amount, direction, description, created_by)
          VALUES ('AdvanceRecovery', 'salary_advances', ?, ?, ?, 'Inflow', 'Advance installment recovered via payroll', ?)
        `).run(adv.id, emp ? emp.department_id : null, applied, req.user.id);
      } catch (e) { /* best-effort ledger hook */ }
    });
  });
  tx();
  res.json({ ok: true });
});

router.get('/payroll-vouchers', (req, res) => {
  res.json(db.prepare(`
    SELECT pv.*, e.full_name FROM payroll_vouchers pv JOIN employees e ON e.id = pv.employee_id ORDER BY pv.id DESC
  `).all());
});

// ---- Referral Incentives ----
// Status flow: PendingProbation -> Eligible (lib/referralIncentiveScan.js,
// 6-hourly) -> PendingApproval (explicit HR submit below) -> Approved/
// Rejected (generic approval engine, 'ReferralIncentive' chain, HR HOD only)
// -> Paid (explicit HR mark-paid below, same pattern as Purchase Invoice's
// record-payment). Forfeited is set inline by the employee PUT route above
// the moment the REFERRED employee's own status becomes resigned/terminated.
router.get('/referral-incentives', requirePermission('payroll.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT ri.*, e.full_name as employee_name, e.status as employee_status, r.full_name as referred_by_name
    FROM referral_incentives ri
    JOIN employees e ON e.id = ri.employee_id
    JOIN employees r ON r.id = ri.referred_by_employee_id
    ORDER BY ri.id DESC
  `).all());
});
router.post('/referral-incentives/:id/submit-for-approval', requirePermission('payroll.manage'), (req, res) => {
  const ri = db.prepare('SELECT * FROM referral_incentives WHERE id = ?').get(req.params.id);
  if (!ri) return res.status(404).json({ error: 'Not found' });
  if (ri.status !== 'Eligible') return res.status(400).json({ error: `This incentive is ${ri.status}, not Eligible - it can't be submitted for approval.` });
  const approvalId = approvals.startApproval('ReferralIncentive', 'referral_incentive', ri.id, ri.incentive_amount, req.user.id);
  db.prepare(`UPDATE referral_incentives SET status = 'PendingApproval', approval_id = ? WHERE id = ?`).run(approvalId, ri.id);
  res.json({ ok: true });
});
router.post('/referral-incentives/:id/mark-paid', requirePermission('payroll.manage'), (req, res) => {
  const ri = db.prepare('SELECT * FROM referral_incentives WHERE id = ?').get(req.params.id);
  if (!ri) return res.status(404).json({ error: 'Not found' });
  if (ri.status !== 'Approved') return res.status(400).json({ error: `This incentive is ${ri.status}, not Approved - it can't be marked paid yet.` });
  const { payment_reference } = req.body;
  db.prepare(`UPDATE referral_incentives SET status = 'Paid', payment_reference = ?, paid_date = ? WHERE id = ?`)
    .run(payment_reference || null, today(), ri.id);
  res.json({ ok: true });
});

// ---- Salary Hikes (permanent per-employee history) ----
router.get('/salary-hikes', requirePermission('payroll.manage'), (req, res) => {
  const where = req.query.employee_id ? 'WHERE sh.employee_id = ?' : '';
  const params = req.query.employee_id ? [req.query.employee_id] : [];
  res.json(db.prepare(`
    SELECT sh.*, e.full_name as employee_name FROM salary_hikes sh JOIN employees e ON e.id = sh.employee_id
    ${where} ORDER BY sh.effective_year DESC, sh.id DESC
  `).all(...params));
});
const SALARY_HIKE_TEMPLATE_COLUMNS = ['employee_code', 'previous_salary', 'hike_type', 'hike_value', 'new_salary', 'effective_year', 'effective_date'];
router.get('/salary-hikes/template', requirePermission('payroll.manage'), (req, res) => {
  const wb = XLSX.utils.book_new();
  const exampleRow = { employee_code: 'EMP-1001', previous_salary: 25000, hike_type: 'Percent', hike_value: 10, new_salary: 27500, effective_year: 2025, effective_date: '2025-04-01' };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: SALARY_HIKE_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'SalaryHikes');
  const note = XLSX.utils.aoa_to_sheet([['Notes'],
    ['For backfilling past years\' hikes only - this does NOT change an employee\'s current salary (use Edit Employee for that). Each row is a historical record.'],
    ['employee_code is matched against the Employee master - an unrecognized code errors that row.'],
    ['hike_type is Percent or Fixed. new_salary is optional - if left blank it\'s computed from previous_salary and hike_type/hike_value.'],
  ]);
  XLSX.utils.book_append_sheet(wb, note, 'Notes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="salary_hikes_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
router.post('/salary-hikes/bulk-upload', requirePermission('payroll.manage'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read that file as an Excel workbook.' }); }
  const findByCode = db.prepare('SELECT id FROM employees WHERE employee_code = ?');
  const insert = db.prepare(`
    INSERT INTO salary_hikes (employee_id, previous_salary, hike_type, hike_value, new_salary, effective_year, effective_date, source, created_by)
    VALUES (?,?,?,?,?,?,?,'Manual',?)
  `);
  let inserted = 0; const errors = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const code = String(row.employee_code || '').trim();
    if (!code) { errors.push(`Row ${rowNum}: employee_code is required - skipped.`); return; }
    const emp = findByCode.get(code);
    if (!emp) { errors.push(`Row ${rowNum}: no employee matches "${code}" - skipped.`); return; }
    const prevSalary = Number(row.previous_salary) || 0;
    const hikeType = String(row.hike_type || '').trim() === 'Fixed' ? 'Fixed' : 'Percent';
    const hikeValue = Number(row.hike_value) || 0;
    const newSalary = String(row.new_salary || '').trim() !== ''
      ? Number(row.new_salary)
      : (hikeType === 'Percent' ? prevSalary * (1 + hikeValue / 100) : prevSalary + hikeValue);
    const effectiveYear = Number(row.effective_year) || null;
    if (!effectiveYear) { errors.push(`Row ${rowNum}: effective_year is required - skipped.`); return; }
    insert.run(emp.id, prevSalary, hikeType, hikeValue, newSalary, effectiveYear, String(row.effective_date || '').trim() || null, req.user.id);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors });
});

// ---- Salary Hike Cycles (annual planning run) ----
router.get('/salary-hike-cycles', requirePermission('payroll.manage'), (req, res) => {
  res.json(db.prepare(`
    SELECT shc.*,
      (SELECT COUNT(*) FROM salary_hike_cycle_items WHERE cycle_id = shc.id) as item_count,
      (SELECT COALESCE(SUM(proposed_salary - current_salary), 0) FROM salary_hike_cycle_items WHERE cycle_id = shc.id) as total_increase
    FROM salary_hike_cycles shc ORDER BY shc.id DESC
  `).all());
});
router.post('/salary-hike-cycles', requirePermission('payroll.manage'), (req, res) => {
  const { cycle_name, effective_year } = req.body;
  if (!cycle_name || !String(cycle_name).trim()) return res.status(400).json({ error: 'Cycle name is required.' });
  const info = db.prepare(`INSERT INTO salary_hike_cycles (cycle_name, effective_year, created_by) VALUES (?,?,?)`)
    .run(String(cycle_name).trim(), effective_year || null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});
function hikeCycleBundle(id) {
  const cycle = db.prepare('SELECT * FROM salary_hike_cycles WHERE id = ?').get(id);
  if (!cycle) return null;
  const items = db.prepare(`
    SELECT shci.*, e.full_name as employee_name, e.department_id as department_id, d.name as department_name
    FROM salary_hike_cycle_items shci JOIN employees e ON e.id = shci.employee_id LEFT JOIN departments d ON d.id = e.department_id
    WHERE shci.cycle_id = ? ORDER BY d.name, e.full_name
  `).all(id);
  return { cycle, items };
}
router.get('/salary-hike-cycles/:id', requirePermission('payroll.manage'), (req, res) => {
  const bundle = hikeCycleBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  res.json(bundle);
});
function computeProposedSalary(currentSalary, hikeType, hikeValue) {
  return hikeType === 'Fixed' ? currentSalary + Number(hikeValue || 0) : currentSalary * (1 + Number(hikeValue || 0) / 100);
}
// Add/update a single employee's proposed hike within this cycle - upserts
// by (cycle_id, employee_id), snapshotting the employee's CURRENT
// monthly_salary at the moment this is set (not read live again at
// approval time - see salary_hike_cycle_items' table comment in
// db/index.js for why).
router.post('/salary-hike-cycles/:id/items', requirePermission('payroll.manage'), (req, res) => {
  const cycle = db.prepare('SELECT * FROM salary_hike_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) return res.status(404).json({ error: 'Not found' });
  if (cycle.status !== 'Draft') return res.status(400).json({ error: `This cycle is ${cycle.status}, not Draft - it can no longer be edited.` });
  const { employee_id, hike_type, hike_value, notes } = req.body;
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
  if (!emp) return res.status(400).json({ error: 'That employee no longer exists - refresh the page and pick again.' });
  const hikeType = hike_type === 'Fixed' ? 'Fixed' : 'Percent';
  const currentSalary = Number(emp.monthly_salary || 0);
  const proposedSalary = computeProposedSalary(currentSalary, hikeType, hike_value);
  const existing = db.prepare('SELECT id FROM salary_hike_cycle_items WHERE cycle_id = ? AND employee_id = ?').get(cycle.id, employee_id);
  if (existing) {
    db.prepare(`UPDATE salary_hike_cycle_items SET current_salary=?, hike_type=?, hike_value=?, proposed_salary=?, notes=? WHERE id=?`)
      .run(currentSalary, hikeType, Number(hike_value || 0), proposedSalary, notes || null, existing.id);
    res.json({ id: existing.id });
  } else {
    const info = db.prepare(`
      INSERT INTO salary_hike_cycle_items (cycle_id, employee_id, current_salary, hike_type, hike_value, proposed_salary, notes)
      VALUES (?,?,?,?,?,?,?)
    `).run(cycle.id, employee_id, currentSalary, hikeType, Number(hike_value || 0), proposedSalary, notes || null);
    res.json({ id: info.lastInsertRowid });
  }
});
// Apply the same %/fixed hike to every active employee in scope at once -
// department_id filters to one department, omitted means every active
// employee org-wide. Overwrites any item already in this cycle for an
// affected employee (re-running with different numbers is how "redo the
// whole department" works, not a separate undo step).
router.post('/salary-hike-cycles/:id/bulk-apply', requirePermission('payroll.manage'), (req, res) => {
  const cycle = db.prepare('SELECT * FROM salary_hike_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) return res.status(404).json({ error: 'Not found' });
  if (cycle.status !== 'Draft') return res.status(400).json({ error: `This cycle is ${cycle.status}, not Draft - it can no longer be edited.` });
  const { department_id, hike_type, hike_value } = req.body;
  const hikeType = hike_type === 'Fixed' ? 'Fixed' : 'Percent';
  const employees = department_id
    ? db.prepare(`SELECT * FROM employees WHERE status = 'active' AND department_id = ?`).all(department_id)
    : db.prepare(`SELECT * FROM employees WHERE status = 'active'`).all();
  const upsert = db.prepare('SELECT id FROM salary_hike_cycle_items WHERE cycle_id = ? AND employee_id = ?');
  const update = db.prepare(`UPDATE salary_hike_cycle_items SET current_salary=?, hike_type=?, hike_value=?, proposed_salary=? WHERE id=?`);
  const insert = db.prepare(`INSERT INTO salary_hike_cycle_items (cycle_id, employee_id, current_salary, hike_type, hike_value, proposed_salary) VALUES (?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    employees.forEach(emp => {
      const currentSalary = Number(emp.monthly_salary || 0);
      const proposedSalary = computeProposedSalary(currentSalary, hikeType, hike_value);
      const existing = upsert.get(cycle.id, emp.id);
      if (existing) update.run(currentSalary, hikeType, Number(hike_value || 0), proposedSalary, existing.id);
      else insert.run(cycle.id, emp.id, currentSalary, hikeType, Number(hike_value || 0), proposedSalary);
    });
  });
  tx();
  res.json({ applied: employees.length });
});
router.delete('/salary-hike-cycles/:id/items/:itemId', requirePermission('payroll.manage'), (req, res) => {
  const cycle = db.prepare('SELECT * FROM salary_hike_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) return res.status(404).json({ error: 'Not found' });
  if (cycle.status !== 'Draft') return res.status(400).json({ error: `This cycle is ${cycle.status}, not Draft - it can no longer be edited.` });
  db.prepare('DELETE FROM salary_hike_cycle_items WHERE id = ? AND cycle_id = ?').run(req.params.itemId, cycle.id);
  res.json({ ok: true });
});
router.post('/salary-hike-cycles/:id/submit-for-approval', requirePermission('payroll.manage'), (req, res) => {
  const cycle = db.prepare('SELECT * FROM salary_hike_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) return res.status(404).json({ error: 'Not found' });
  if (cycle.status !== 'Draft') return res.status(400).json({ error: `This cycle is ${cycle.status}, not Draft - it can't be submitted.` });
  const items = db.prepare('SELECT * FROM salary_hike_cycle_items WHERE cycle_id = ?').all(cycle.id);
  if (!items.length) return res.status(400).json({ error: 'Add at least one employee to this cycle before submitting.' });
  const totalIncrease = items.reduce((s, i) => s + (i.proposed_salary - i.current_salary), 0);
  const approvalId = approvals.startApproval('SalaryHikeCycle', 'salary_hike_cycle', cycle.id, totalIncrease, req.user.id);
  db.prepare(`UPDATE salary_hike_cycles SET status = 'PendingApproval', approval_id = ? WHERE id = ?`).run(approvalId, cycle.id);
  res.json({ ok: true });
});
// A Rejected cycle stays as an honest record (the rejected approval row and
// its comment aren't touched) but can be reopened for editing and
// resubmitted - same "fix and try again" spirit as a Purchase Request's
// reject-edit-resubmit cycle, just without needing a brand new cycle row.
router.post('/salary-hike-cycles/:id/reopen', requirePermission('payroll.manage'), (req, res) => {
  const cycle = db.prepare('SELECT * FROM salary_hike_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) return res.status(404).json({ error: 'Not found' });
  if (cycle.status !== 'Rejected') return res.status(400).json({ error: `This cycle is ${cycle.status}, not Rejected - only a rejected cycle can be reopened.` });
  db.prepare(`UPDATE salary_hike_cycles SET status = 'Draft' WHERE id = ?`).run(cycle.id);
  res.json({ ok: true });
});

// ---- Department-wise / org-wide salary view (oversight-scoped) ----
// Admin/Management see every department; a department HOD sees only their
// own department(s) (home department plus anything granted via role
// oversight - same inOversightDept() model every other cross-department
// report in this app already uses). cycle_id is optional - when given,
// each employee's post-hike figure comes from that cycle's own items (0 if
// the employee isn't in it); omitted, only current-salary figures are shown.
function isGlobalHrViewer(user) {
  return user.role_name === 'Admin' || user.role_name === 'Management';
}
router.get('/salary-report', (req, res) => {
  const user = req.user;
  if (!isGlobalHrViewer(user) && !user.is_supervisor) {
    return res.status(403).json({ error: 'Only a department HOD, Management, or Admin can view this report.' });
  }
  const accessibleDeptIds = isGlobalHrViewer(user)
    ? null // null = no restriction
    : new Set([user.department_id, ...oversightDepartmentIds(db, user.id)].filter(id => id != null));
  if (req.query.department_id) {
    const deptId = Number(req.query.department_id);
    if (accessibleDeptIds && !accessibleDeptIds.has(deptId)) {
      return res.status(403).json({ error: "You don't have oversight of that department." });
    }
  }
  const employees = db.prepare(`
    SELECT e.id, e.full_name, e.department_id, d.name as department_name, e.monthly_salary
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.status = 'active'
  `).all().filter(e => {
    if (req.query.department_id) return e.department_id === Number(req.query.department_id);
    return accessibleDeptIds ? accessibleDeptIds.has(e.department_id) : true;
  });
  const cycleItemsByEmployee = new Map();
  if (req.query.cycle_id) {
    db.prepare('SELECT employee_id, proposed_salary FROM salary_hike_cycle_items WHERE cycle_id = ?').all(req.query.cycle_id)
      .forEach(i => cycleItemsByEmployee.set(i.employee_id, i.proposed_salary));
  }
  const rows = employees.map(e => ({
    employee_id: e.id, full_name: e.full_name, department_id: e.department_id, department_name: e.department_name,
    current_salary: e.monthly_salary, proposed_salary: cycleItemsByEmployee.has(e.id) ? cycleItemsByEmployee.get(e.id) : null,
  }));
  const byDept = new Map();
  rows.forEach(r => {
    const key = r.department_id || 0;
    if (!byDept.has(key)) byDept.set(key, { department_id: r.department_id, department_name: r.department_name || 'Unassigned', rows: [] });
    byDept.get(key).rows.push(r);
  });
  const summarize = (list) => {
    const currents = list.map(r => r.current_salary);
    const proposeds = list.filter(r => r.proposed_salary != null).map(r => r.proposed_salary);
    return {
      headcount: list.length,
      total_current: currents.reduce((s, v) => s + v, 0),
      min_current: currents.length ? Math.min(...currents) : 0,
      max_current: currents.length ? Math.max(...currents) : 0,
      total_proposed: proposeds.length ? proposeds.reduce((s, v) => s + v, 0) : null,
      min_proposed: proposeds.length ? Math.min(...proposeds) : null,
      max_proposed: proposeds.length ? Math.max(...proposeds) : null,
    };
  };
  const departments = [...byDept.values()].map(d => ({ department_id: d.department_id, department_name: d.department_name, ...summarize(d.rows) }));
  res.json({ rows, departments, org_wide: summarize(rows) });
});

module.exports = router;

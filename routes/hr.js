const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const approvals = require('../lib/approvals');
const router = express.Router();
router.use(authRequired);

const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const EMPLOYEE_TEMPLATE_COLUMNS = [
  'employee_code', 'full_name', 'department', 'designation', 'date_of_joining',
  'phone', 'email', 'address', 'bank_account', 'monthly_salary',
];

// ---- Employees ----
router.get('/employees', (req, res) => {
  res.json(db.prepare(`
    SELECT e.*, d.name as department_name FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    ORDER BY e.full_name
  `).all());
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
    bank_name, account_number, ifsc_code, aadhaar_number, passport_number, visa_availability, driving_license_number } = req.body;
  // Nothing enforced this before, so an employee could be added with the
  // Full Name field left blank - it saved silently and then sat in the
  // Employees table forever with a blank Name column, with no obvious way
  // to tell which row that even was. Bulk-upload already required this;
  // the single Add Employee form and API just never did.
  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: 'Full Name is required.' });
  }
  const info = db.prepare(`
    INSERT INTO employees (employee_code, full_name, department_id, designation, date_of_joining, phone, email, address, bank_account,
      monthly_salary, reporting_manager_id, employment_type, pan_number, blood_group, emergency_contact_name, emergency_contact_phone,
      bank_name, account_number, ifsc_code, aadhaar_number, passport_number, visa_availability, driving_license_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(employee_code, full_name, department_id, designation, date_of_joining, phone, email, address, bank_account, monthly_salary || 0,
    reporting_manager_id || null, employment_type || 'Full-time', pan_number || null, blood_group || null,
    emergency_contact_name || null, emergency_contact_phone || null,
    bank_name || null, account_number || null, ifsc_code || null, aadhaar_number || null, passport_number || null,
    visa_availability || null, driving_license_number || null);
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
  db.prepare(`
    UPDATE employees SET employee_code=?, full_name=?, department_id=?, designation=?, date_of_joining=?, phone=?, email=?, address=?,
      bank_account=?, monthly_salary=?, status=?, reporting_manager_id=?, employment_type=?, pan_number=?, blood_group=?,
      emergency_contact_name=?, emergency_contact_phone=?, exit_date=?,
      bank_name=?, account_number=?, ifsc_code=?, aadhaar_number=?, passport_number=?, visa_availability=?, driving_license_number=?
    WHERE id=?
  `).run(
    pick('employee_code', existing.employee_code), pick('full_name', existing.full_name), pick('department_id', existing.department_id),
    pick('designation', existing.designation), pick('date_of_joining', existing.date_of_joining), pick('phone', existing.phone),
    pick('email', existing.email), pick('address', existing.address), pick('bank_account', existing.bank_account),
    pick('monthly_salary', existing.monthly_salary), pick('status', existing.status) || 'active',
    f.reporting_manager_id !== undefined ? (f.reporting_manager_id || null) : existing.reporting_manager_id,
    pick('employment_type', existing.employment_type) || 'Full-time', pick('pan_number', existing.pan_number),
    pick('blood_group', existing.blood_group), pick('emergency_contact_name', existing.emergency_contact_name),
    pick('emergency_contact_phone', existing.emergency_contact_phone), pick('exit_date', existing.exit_date) || null,
    pick('bank_name', existing.bank_name), pick('account_number', existing.account_number), pick('ifsc_code', existing.ifsc_code),
    pick('aadhaar_number', existing.aadhaar_number), pick('passport_number', existing.passport_number),
    pick('visa_availability', existing.visa_availability), pick('driving_license_number', existing.driving_license_number),
    existing.id
  );
  res.json({ ok: true });
});

// Downloadable Excel template for bulk employee upload - headers plus one
// example row, and a Departments sheet listing the exact department names
// to use (department is matched by name, case-insensitively, on upload).
router.get('/employees/template', requirePermission('payroll.manage'), (req, res) => {
  const depts = db.prepare('SELECT name FROM departments ORDER BY name').all().map(d => d.name);
  const wb = XLSX.utils.book_new();
  const exampleRow = {
    employee_code: 'EMP-1001', full_name: 'Jane Doe', department: depts[0] || 'Design', designation: 'Engineer',
    date_of_joining: '2024-01-15', phone: '9876543210', email: 'jane@example.com', address: 'Faridabad',
    bank_account: '1234567890', monthly_salary: 25000,
  };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: EMPLOYEE_TEMPLATE_COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  const deptWs = XLSX.utils.aoa_to_sheet([['Department Names (use exactly as spelled here)'], ...depts.map(d => [d])]);
  XLSX.utils.book_append_sheet(wb, deptWs, 'Departments');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="employee_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Bulk-create employees from a filled-in copy of the template above.
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
  const insert = db.prepare(`
    INSERT INTO employees (employee_code, full_name, department_id, designation, date_of_joining, phone, email, address, bank_account, monthly_salary)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const existingCodes = new Set(db.prepare('SELECT employee_code FROM employees WHERE employee_code IS NOT NULL').all().map(r => r.employee_code));
  let inserted = 0;
  const errors = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2; // header is row 1 in the spreadsheet
    const fullName = String(row.full_name || '').trim();
    if (!fullName) { errors.push(`Row ${rowNum}: full_name is required - skipped.`); return; }
    const deptName = String(row.department || '').trim();
    const deptId = deptName ? deptByName.get(deptName.toLowerCase()) : null;
    if (deptName && !deptId) { errors.push(`Row ${rowNum}: department "${deptName}" not recognized - skipped.`); return; }
    const code = String(row.employee_code || '').trim() || null;
    if (code && existingCodes.has(code)) { errors.push(`Row ${rowNum}: employee_code "${code}" already exists - skipped.`); return; }
    insert.run(
      code, fullName, deptId || null, String(row.designation || '') || null,
      String(row.date_of_joining || '') || null, String(row.phone || '') || null, String(row.email || '') || null,
      String(row.address || '') || null, String(row.bank_account || '') || null, Number(row.monthly_salary) || 0
    );
    if (code) existingCodes.add(code);
    inserted++;
  });
  res.json({ inserted, skipped: errors.length, errors });
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

module.exports = router;

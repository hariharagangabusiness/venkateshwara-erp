const bcrypt = require('bcryptjs');
const { db } = require('./index');

const departments = [
  'Admin', 'Marketing', 'Sales', 'Project Management', 'Design', 'Purchase', 'Electrical', 'Store',
  'Laser & Bending Processing', 'Manufacturing', 'Assembling', 'Packing', 'Shipping',
  'Installation', 'Service & Spare Parts', 'Accounts / HR', 'Management'
];

const roles = [
  ['Admin', 'Full system access'],
  ['Marketing', 'Lead generation and enquiries'],
  ['Sales', 'Sales orders and client management'],
  ['ProjectManager', 'Project tracking across departments'],
  ['Design', 'Engineering / drawing design'],
  ['Purchase', 'Purchase requests and orders'],
  ['Electrical', 'Control panel and electrical systems design'],
  ['Store', 'Inventory / GRN / issue to production'],
  ['LaserBending', 'Laser cutting and bending processing'],
  ['Manufacturing', 'Manufacturing HOD - plans and oversees Fitting/Tacking/Welding/Buffing/Painting'],
  ['Fitting', 'Manufacturing - fitting'],
  ['Tacking', 'Manufacturing - tacking'],
  ['Welding', 'Manufacturing - welding'],
  ['BuffingSandblast', 'Manufacturing - buffing / sandblast'],
  ['Painting', 'Manufacturing - painting'],
  ['Assembling', 'Assembly line'],
  ['Packing', 'Packing for dispatch'],
  ['Shipping', 'Logistics and shipping'],
  ['Installation', 'Onsite installation'],
  ['Service', 'Service and spare part support'],
  ['HR', 'Payroll, attendance, leave'],
  ['Accounts', 'Expenses, vouchers, finance approvals'],
  ['Management', 'Senior management - FOC and cross-department approvals'],
];

const insertRole = db.prepare('INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)');
roles.forEach(([n, d]) => insertRole.run(n, d));

const insertDept = db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)');
departments.forEach(d => insertDept.run(d));

const permissionCodes = [
  'user.manage', 'role.manage',
  'lead.manage', 'sales_order.manage',
  'project.manage', 'job_card.manage',
  'purchase_request.create', 'purchase_request.approve', 'purchase_order.manage',
  'store.manage', 'item.manage',
  'expense_voucher.create', 'expense_voucher.approve', 'expense_voucher.view_all',
  'payroll.manage', 'payroll.approve', 'attendance.manage', 'leave.manage', 'leave.approve',
  'advance.request', 'advance.approve',
  'service_request.manage',
  'report.view_all',
  'admin.access_control',
  'foc.request', 'foc.approve',
  'asset.manage', 'ticket.manage',
  'service_center.manage',
  'expense_tracker.manage',
  'site_visit.manage',
];
const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (code) VALUES (?)');
permissionCodes.forEach(c => insertPerm.run(c));

function grant(roleName, codes) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  const insert = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, (SELECT id FROM permissions WHERE code = ?))');
  codes.forEach(c => insert.run(role.id, c));
}
grant('Marketing', ['lead.manage']);
grant('Sales', ['lead.manage', 'sales_order.manage']);
grant('ProjectManager', ['project.manage', 'job_card.manage', 'report.view_all']);
grant('Design', ['job_card.manage', 'foc.request']);
grant('Purchase', ['purchase_request.create', 'purchase_order.manage', 'job_card.manage', 'foc.request']);
grant('Electrical', ['job_card.manage', 'foc.request']);
grant('Store', ['store.manage', 'item.manage', 'job_card.manage', 'foc.request', 'asset.manage', 'service_center.manage']);
grant('LaserBending', ['job_card.manage', 'foc.request']);
grant('Manufacturing', ['job_card.manage', 'foc.request']);
grant('Fitting', ['job_card.manage']);
grant('Tacking', ['job_card.manage']);
grant('Welding', ['job_card.manage']);
grant('BuffingSandblast', ['job_card.manage']);
grant('Painting', ['job_card.manage']);
grant('Assembling', ['job_card.manage', 'foc.request']);
grant('Packing', ['job_card.manage', 'foc.request']);
grant('Shipping', ['job_card.manage', 'foc.request']);
grant('Installation', ['job_card.manage', 'foc.request']);
grant('Service', ['service_request.manage', 'foc.request', 'service_center.manage', 'site_visit.manage']);
grant('Electrical', ['site_visit.manage']);
grant('HR', ['payroll.manage', 'attendance.manage', 'leave.manage', 'advance.request', 'user.manage']);
grant('Accounts', ['expense_voucher.create', 'expense_voucher.approve', 'expense_voucher.view_all', 'payroll.approve', 'report.view_all', 'sales_order.manage', 'expense_tracker.manage']);
grant('HR', ['expense_tracker.manage']);
grant('Management', ['foc.approve', 'report.view_all', 'expense_voucher.view_all', 'service_request.manage']);

// Approval chains
const chains = [
  ['ExpenseVoucher', 'Expense voucher approval'],
  ['Leave', 'Leave request approval'],
  ['PurchaseRequest', 'Purchase request approval'],
  ['SalaryAdvance', 'Salary advance approval'],
  ['Payroll', 'Monthly payroll approval'],
];
const insertChain = db.prepare('INSERT OR IGNORE INTO approval_chains (name, description) VALUES (?, ?)');
chains.forEach(([n, d]) => insertChain.run(n, d));

function roleId(name) { return db.prepare('SELECT id FROM roles WHERE name = ?').get(name).id; }
function chainId(name) { return db.prepare('SELECT id FROM approval_chains WHERE name = ?').get(name).id; }
// Upsert (not INSERT OR IGNORE) so re-seeding a carried-forward database
// still picks up matrix changes made here (e.g. a role or threshold moved) -
// same self-healing pattern used for demoUsers below. Note this means a
// re-seed resets any customization made afterwards via the Approval Matrix
// page - same tradeoff as demoUsers being reset by a reseed.
const upsertStep = db.prepare(`
  INSERT INTO approval_chain_steps (chain_id, step_order, approver_role_id, min_amount, requires_supervisor)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(chain_id, step_order) DO UPDATE SET
    approver_role_id = excluded.approver_role_id,
    min_amount = excluded.min_amount,
    requires_supervisor = excluded.requires_supervisor
`);

// Expense voucher: Accounts approves any amount; above 25000 also needs Admin
upsertStep.run(chainId('ExpenseVoucher'), 1, roleId('Accounts'), 0, 0);
upsertStep.run(chainId('ExpenseVoucher'), 2, roleId('Admin'), 25000, 0);

// Leave: HR approves
upsertStep.run(chainId('Leave'), 1, roleId('HR'), 0, 0);

// Purchase request: EVERY request goes to the Purchase HOD/Supervisor first,
// regardless of value; above the configured threshold it then also needs
// Management HOD/Supervisor sign-off. Both thresholds/roles are editable
// afterwards from the Approval Matrix page (Admin only).
upsertStep.run(chainId('PurchaseRequest'), 1, roleId('Purchase'), 0, 1);
upsertStep.run(chainId('PurchaseRequest'), 2, roleId('Management'), 50000, 1);

// Salary advance: HR then Accounts
upsertStep.run(chainId('SalaryAdvance'), 1, roleId('HR'), 0, 0);
upsertStep.run(chainId('SalaryAdvance'), 2, roleId('Accounts'), 0, 0);

// Payroll: Accounts then Admin
upsertStep.run(chainId('Payroll'), 1, roleId('Accounts'), 0, 0);
upsertStep.run(chainId('Payroll'), 2, roleId('Admin'), 0, 0);

// Leave types
const insertLeaveType = db.prepare('INSERT OR IGNORE INTO leave_types (name, annual_quota) VALUES (?, ?)');
[['Casual', 12], ['Sick', 8], ['Earned', 15], ['Unpaid', 0]].forEach(([n, q]) => insertLeaveType.run(n, q));

// Expense categories
const insertCat = db.prepare('INSERT OR IGNORE INTO expense_categories (name) VALUES (?)');
['Travel', 'Freight & Logistics', 'Office Supplies', 'Utilities', 'Raw Material', 'Repairs & Maintenance', 'Site Expenses', 'Miscellaneous']
  .forEach(c => insertCat.run(c));

// Admin user
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('Admin@123', 10);
  db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role_id, department_id, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run('admin', hash, 'System Administrator', roleId('Admin'), db.prepare('SELECT id FROM departments WHERE name = ?').get('Admin').id);
  console.log('Created admin user: admin / Admin@123');
}

// A demo user per key department for quick testing
// [username, full name, role, department, isSupervisor]
// The demo "1" user per department is that department's HOD/Supervisor -
// only they (and Admin) can start/complete a department-level job card or
// allocate work to teammates. design2 is a plain (non-supervisor) team
// member, seeded to demonstrate that a regular team member can only
// start/complete a job card that's been specifically assigned to them.
const demoUsers = [
  ['hr1', 'HR Executive', 'HR', 'Accounts / HR', true],
  ['accounts1', 'Accounts Executive', 'Accounts', 'Accounts / HR', true],
  ['sales1', 'Sales Executive', 'Sales', 'Sales', true],
  ['marketing1', 'Marketing Executive', 'Marketing', 'Marketing', true],
  ['design1', 'Design HOD', 'Design', 'Design', true],
  ['design2', 'Design Engineer', 'Design', 'Design', false],
  ['purchase1', 'Purchase Executive', 'Purchase', 'Purchase', true],
  ['electrical1', 'Electrical Design Engineer', 'Electrical', 'Electrical', true],
  ['store1', 'Store Executive', 'Store', 'Store', true],
  ['laserbending1', 'Laser & Bending Operator', 'LaserBending', 'Laser & Bending Processing', true],
  ['manufacturing1', 'Manufacturing HOD', 'Manufacturing', 'Manufacturing', true],
  ['fitting1', 'Fitting Technician', 'Fitting', 'Manufacturing', true],
  ['tacking1', 'Tacking Technician', 'Tacking', 'Manufacturing', true],
  ['welding1', 'Welding Technician', 'Welding', 'Manufacturing', true],
  ['buffing1', 'Buffing/Sandblast Technician', 'BuffingSandblast', 'Manufacturing', true],
  ['painting1', 'Painting Technician', 'Painting', 'Manufacturing', true],
  ['assembling1', 'Assembly Technician', 'Assembling', 'Assembling', true],
  ['packing1', 'Packing Executive', 'Packing', 'Packing', true],
  ['shipping1', 'Shipping Executive', 'Shipping', 'Shipping', true],
  ['installation1', 'Installation Engineer', 'Installation', 'Installation', true],
  ['service1', 'Service Engineer', 'Service', 'Service & Spare Parts', true],
  ['pm1', 'Project Manager', 'ProjectManager', 'Project Management', true],
  ['management1', 'Management (FOC Approver)', 'Management', 'Management', true],
];
demoUsers.forEach(([uname, fname, roleName, deptName, isSupervisor]) => {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  const deptId = db.prepare('SELECT id FROM departments WHERE name = ?').get(deptName).id;
  // Round 3: link every demo user to a matching employees row (employee_code
  // = username uppercased) so "My Service Requests" and payroll/leave flows
  // that key off employees.id have something real to point at in the demo data.
  let employee = db.prepare('SELECT * FROM employees WHERE employee_code = ?').get(uname.toUpperCase());
  if (!employee) {
    const info = db.prepare(`
      INSERT INTO employees (employee_code, full_name, department_id, designation, monthly_salary)
      VALUES (?, ?, ?, ?, 25000)
    `).run(uname.toUpperCase(), fname, deptId, roleName + (isSupervisor ? ' HOD' : ''));
    employee = { id: info.lastInsertRowid };
  }
  if (!exists) {
    const hash = bcrypt.hashSync('Demo@123', 10);
    db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role_id, department_id, is_active, is_supervisor, employee_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(uname, hash, fname, roleId(roleName), deptId, isSupervisor ? 1 : 0, employee.id);
  } else {
    // Self-healing: a demo user created by an older version of this seed
    // (before is_supervisor existed) got is_supervisor defaulted to 0 by
    // the ALTER TABLE migration in db/index.js. Re-running seed.js against
    // a carried-forward database used to leave that stuck at 0 forever,
    // silently demoting every HOD login to a regular team member (no
    // Start/Complete, no HOD tools) even after picking up a newer build.
    // Sync it (and role/department, in case those drifted too) every run.
    db.prepare(`
      UPDATE users SET full_name = ?, role_id = ?, department_id = ?, is_supervisor = ?, employee_id = COALESCE(employee_id, ?) WHERE id = ?
    `).run(fname, roleId(roleName), deptId, isSupervisor ? 1 : 0, employee.id, exists.id);
  }
});

// Demo Service Centers (Round 7) - upsert by name so a re-seed against a
// carried-forward database still picks up any changes made here.
const serviceCenters = [
  ['Delhi Service Center', 'Delhi', 'Okhla Industrial Area, New Delhi', 'Rakesh Kumar', '9810000001', 'delhi.service@venkateshwara.example'],
  ['Mumbai Service Center', 'Mumbai', 'Andheri MIDC, Mumbai', 'Suresh Patil', '9820000002', 'mumbai.service@venkateshwara.example'],
  ['Bangalore Service Center', 'Bangalore', 'Peenya Industrial Area, Bangalore', 'Manjunath Rao', '9880000003', 'bangalore.service@venkateshwara.example'],
];
const findSC = db.prepare('SELECT id FROM service_centers WHERE name = ?');
const insertSC = db.prepare(`
  INSERT INTO service_centers (name, city, address, contact_person, phone, email, status) VALUES (?,?,?,?,?,?,'Active')
`);
const updateSC = db.prepare(`
  UPDATE service_centers SET city=?, address=?, contact_person=?, phone=?, email=? WHERE id=?
`);
serviceCenters.forEach(([name, city, address, contact_person, phone, email]) => {
  const existing = findSC.get(name);
  if (existing) updateSC.run(city, address, contact_person, phone, email, existing.id);
  else insertSC.run(name, city, address, contact_person, phone, email);
});

// Monthly Expense Tracker categories (Round 11) - the same canonical list
// used to clean up the team's expense-tracking Excel, so the ERP module
// starts pre-populated instead of empty. Upsert by name so re-seeding a
// carried-forward DB still picks up any renames/reordering made here.
const dailyExpenseCats = [
  'Conv & Maint', 'Courier & Freight', 'Construction Work', 'Crane Charges', 'Daily Labour / Wages',
  'Diesel', 'Loan & Advance', 'Mask & Sanitisation', 'Misc Exp. (Non-Regular)', 'Mobile Exp',
  'Consumable Items', 'Office Exp.', 'Printing & Stationery', 'Repair & Maintenance', 'Stamping Charges',
  'Sweeper', 'Tour Exp', 'Water Tank', 'Weighing Exp', "Worker's Welfare",
];
const fixedExpenseCats = [
  'Salary (VE) - Axis', 'Salary (VE) - Cash', 'OT (VE)', 'Salary - Others', 'PF (VE)', 'ESIC (VE)',
  'Electricity - Plot 222', 'Electricity - Plot 221', 'Electricity - Plot 219', 'Electricity - Plot 217',
  'Electricity - Plot 123-124', 'Electricity - Plot 213', 'Electricity - Plot 23', 'Misc Basket Exp.',
  'Mediclaim & Other Policies', 'Holi', 'Diwali', 'Sri Vishwakarma Pooja', 'New Year', 'LTA',
  'Miryalguda Office', 'Karimnagar Office', 'Factory Anniversary', 'Rent - Plot 218', 'Rent - Plot 219',
  'Sand Blasting',
];
const findExpCat = db.prepare('SELECT id FROM expense_tracker_categories WHERE name = ?');
const insertExpCat = db.prepare('INSERT INTO expense_tracker_categories (name, kind, sort_order) VALUES (?,?,?)');
dailyExpenseCats.forEach((name, i) => { if (!findExpCat.get(name)) insertExpCat.run(name, 'Daily', i); });
fixedExpenseCats.forEach((name, i) => { if (!findExpCat.get(name)) insertExpCat.run(name, 'Fixed', i); });

console.log('Seed complete. Demo users use password: Demo@123 (admin uses Admin@123)');

// Catalog of every sidebar page in the app, grouped the same way the
// sidebar itself is grouped. This is the single source of truth the User
// Access module's matrices (role-based and per-user) are built from, and
// what role_page_access/extra_page_access/user_page_overrides rows
// reference by page_id. Keep this in sync with NAV in public/js/app.js.
const PAGE_CATALOG = [
  { group: 'Overview', items: [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'approvals', label: 'My Approvals' },
    { id: 'todos', label: 'To-Do List' },
    { id: 'dept-report', label: 'Department Report' },
  ]},
  { group: 'Sales & Marketing', items: [
    { id: 'leads', label: 'Leads / Enquiries' },
    { id: 'pipeline', label: 'Pipeline (Kanban)' },
    { id: 'followups', label: "Today's Follow-ups" },
    { id: 'offers', label: 'Offers / Quotations' },
    { id: 'offer-options', label: 'Offer Field Options' },
    { id: 'orders', label: 'Sales Orders' },
    { id: 'clients', label: 'Clients' },
    { id: 'sales-analytics', label: 'Sales Analytics' },
    { id: 'sales-targets', label: 'Sales Targets' },
  ]},
  { group: 'Projects Management', items: [
    { id: 'projects', label: 'Projects' },
    { id: 'targets', label: 'Targets' },
    { id: 'jobcards', label: 'My Job Cards (own department)' },
    { id: 'time-motion-report', label: 'Time & Motion Report' },
  ]},
  { group: 'Purchase', items: [
    { id: 'purchase-requests', label: 'Purchase Requests' },
    { id: 'purchase-orders', label: 'Purchase Orders' },
    { id: 'vendors', label: 'Vendors' },
  ]},
  { group: 'Store & Inventory', items: [
    { id: 'store', label: 'Item Master' },
    { id: 'stock-in-out', label: 'Stock In/Out' },
    { id: 'challans', label: 'Challans' },
    { id: 'service-centers', label: 'Service Centers Master' },
    { id: 'sc-transfers', label: 'Store -> Service Center Transfers' },
    { id: 'sc-stock', label: 'Service Center Stock Levels' },
  ]},
  { group: 'Electrical & Service', items: [
    { id: 'service', label: 'Service & Spares' },
    { id: 'service-mine', label: 'My Service Requests' },
    { id: 'service-recon', label: 'Reconciliation' },
    { id: 'service-reports-dashboard', label: 'Service Reports Dashboard' },
    { id: 'service-reopenings', label: 'SR Reopenings Report' },
    { id: 'sc-receive', label: 'Receive Center Transfers' },
    { id: 'sc-reconciliation', label: 'Service Center Reconciliation' },
    { id: 'site-visits', label: 'Site Visit Tracker' },
    { id: 'daily-work-log', label: 'Engineer Daily Work Log' },
  ]},
  { group: 'Payroll & HR', items: [
    { id: 'employees', label: 'Employees' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'leave', label: 'Leave Requests' },
    { id: 'advances', label: 'Salary Advances' },
    { id: 'payroll', label: 'Payroll' },
    { id: 'leave-balances', label: 'Leave Balances Master' },
  ]},
  { group: 'Finance', items: [
    { id: 'expenses', label: 'Expense Vouchers' },
    { id: 'expense-report', label: 'Cash vs Accounted Report' },
    { id: 'foc', label: 'FOC Material Issue' },
    { id: 'finance-ledger', label: 'Finance Ledger' },
    { id: 'monthly-reconciliation', label: 'Monthly Reconciliation' },
    { id: 'sales-invoices', label: 'Sales Invoices' },
    { id: 'soa', label: 'Statement of Accounts' },
    { id: 'operating-expenses', label: 'Operating Expenses' },
    { id: 'gst-summary', label: 'GST Summary' },
    { id: 'bg-dashboard', label: 'Bank Guarantee Dashboard' },
    { id: 'foreign-payments', label: 'Foreign Payments' },
  ]},
  { group: 'Asset Management', items: [
    { id: 'assets', label: 'Asset Register' },
    { id: 'assets-maintenance', label: 'Maintenance / EOL Report' },
  ]},
  { group: 'Tickets', items: [
    { id: 'tickets-raise', label: 'Raise a Ticket' },
    { id: 'tickets-mine', label: 'My Tickets' },
    { id: 'tickets-department', label: 'Department Tickets' },
  ]},
  { group: 'Admin', items: [
    { id: 'users', label: 'Users & Roles' },
    { id: 'access', label: 'User Access' },
    { id: 'approval-matrix', label: 'Approval Matrix' },
    { id: 'company-settings', label: 'Company Settings' },
    { id: 'data-import', label: 'Data Import' },
    { id: 'full-data-export', label: 'Full Data Export' },
    { id: 'org-hierarchy', label: 'Organizational Hierarchy' },
    { id: 'backups', label: 'Backups' },
  ]},
];

const ALL_PAGE_IDS = PAGE_CATALOG.flatMap(g => g.items.map(it => it.id));

module.exports = { PAGE_CATALOG, ALL_PAGE_IDS };

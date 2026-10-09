// Catalog of every real permission code in the app (db/seed.js's
// permissionCodes array plus the handful added later by bootstrap backfills -
// bg.manage, order_confirmation.approve, annexure.approve), grouped the same
// way lib/pageCatalog.js groups pages, for the Admin-only Role Permissions
// screen (routes/admin.js's GET/PUT /permissions). Keep this in sync with
// db/seed.js's permissionCodes and any bootstrap*() function in db/index.js
// that backfills a new permission code.
const PERMISSION_CATALOG = [
  { group: 'Admin', items: [
    { code: 'user.manage', label: 'Manage Users' },
    { code: 'role.manage', label: 'Manage Roles' },
    { code: 'admin.access_control', label: 'Access Control (User Access / Role Permissions)' },
  ]},
  { group: 'Sales & Marketing', items: [
    { code: 'lead.manage', label: 'Leads / Enquiries' },
    { code: 'sales_order.manage', label: 'Sales Orders / FG Dispatch / MRN' },
    { code: 'offer_options.manage', label: 'Offer Field Options (Admin-level offer config)' },
    { code: 'order_confirmation.approve', label: 'Approve Order Confirmation Letter' },
    { code: 'annexure.approve', label: 'Approve Sales Order Annexure' },
  ]},
  { group: 'Projects Management', items: [
    { code: 'project.manage', label: 'Projects' },
    { code: 'job_card.manage', label: 'Job Cards' },
  ]},
  { group: 'Purchase', items: [
    { code: 'purchase_request.create', label: 'Create Purchase Requests' },
    { code: 'purchase_request.approve', label: 'Approve Purchase Requests' },
    { code: 'purchase_order.manage', label: 'Purchase Orders' },
  ]},
  { group: 'Store & Inventory', items: [
    { code: 'store.manage', label: 'Stock In/Out, Store Challans' },
    { code: 'item.manage', label: 'Item Master (add/edit/delete items)' },
  ]},
  { group: 'Finance', items: [
    { code: 'expense_voucher.create', label: 'Create Expense Vouchers' },
    { code: 'expense_voucher.approve', label: 'Approve Expense Vouchers' },
    { code: 'expense_voucher.view_all', label: 'View All Expense Vouchers' },
    { code: 'expense_tracker.manage', label: 'Operating Expense Tracker' },
    { code: 'bg.manage', label: 'Bank Guarantees' },
    { code: 'payment_receipt.manage', label: 'Payment Receipts' },
    { code: 'soa.manage', label: 'Statement of Accounts' },
  ]},
  { group: 'Payroll & HR', items: [
    { code: 'payroll.manage', label: 'Run Payroll' },
    { code: 'payroll.approve', label: 'Approve Payroll' },
    { code: 'attendance.manage', label: 'Attendance' },
    { code: 'leave.manage', label: 'Leave Requests' },
    { code: 'leave.approve', label: 'Approve Leave Requests' },
    { code: 'advance.request', label: 'Request Salary Advance' },
    { code: 'advance.approve', label: 'Approve Salary Advance' },
  ]},
  { group: 'Electrical & Service', items: [
    { code: 'service_request.manage', label: 'Service Requests' },
    { code: 'service_center.manage', label: 'Service Centers' },
    { code: 'site_visit.manage', label: 'Site Visits' },
  ]},
  { group: 'Asset Management', items: [
    { code: 'asset.manage', label: 'Assets' },
  ]},
  { group: 'Tickets', items: [
    { code: 'ticket.manage', label: 'Tickets' },
  ]},
  { group: 'Cross-Cutting', items: [
    { code: 'foc.request', label: 'Request FOC (Free of Cost)' },
    { code: 'foc.approve', label: 'Approve FOC' },
    { code: 'report.view_all', label: 'View All Reports' },
  ]},
];
const ALL_PERMISSION_CODES = PERMISSION_CATALOG.flatMap(g => g.items.map(i => i.code));
module.exports = { PERMISSION_CATALOG, ALL_PERMISSION_CODES };

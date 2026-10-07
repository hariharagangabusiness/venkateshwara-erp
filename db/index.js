const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || __dirname;
if (process.env.DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'erp.db');
const isNew = !fs.existsSync(dbPath);
const raw = new DatabaseSync(dbPath);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
raw.exec(schema);

// Additive migrations - `CREATE TABLE IF NOT EXISTS` in schema.sql handles new
// tables safely, but new columns on existing tables need ALTER TABLE, which
// has no "IF NOT EXISTS" for columns in SQLite. Try each; ignore "duplicate
// column" errors so this stays safe to run against an already-migrated DB.
const MIGRATIONS = [
  `ALTER TABLE sales_orders ADD COLUMN annexure_path TEXT`,
  `ALTER TABLE job_cards ADD COLUMN planned_start TEXT`,
  `ALTER TABLE job_cards ADD COLUMN planned_end TEXT`,
  `ALTER TABLE job_cards ADD COLUMN duration_days INTEGER DEFAULT 7`,
  `ALTER TABLE job_cards ADD COLUMN sequence INTEGER`,
  `ALTER TABLE job_cards ADD COLUMN parent_job_card_id INTEGER`,
  `ALTER TABLE job_cards ADD COLUMN title TEXT`,
  `ALTER TABLE job_cards ADD COLUMN is_adhoc INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN is_supervisor INTEGER DEFAULT 0`,
  `ALTER TABLE service_requests ADD COLUMN employee_id INTEGER REFERENCES employees(id)`,
  `ALTER TABLE service_requests ADD COLUMN scheduled_date TEXT`,
  `ALTER TABLE service_requests ADD COLUMN customer_name TEXT`,
  `ALTER TABLE service_requests ADD COLUMN contact_person TEXT`,
  `ALTER TABLE service_requests ADD COLUMN contact_phone TEXT`,
  `ALTER TABLE items ADD COLUMN barcode TEXT`,
  `ALTER TABLE items ADD COLUMN hsn_code TEXT`,
  `ALTER TABLE items ADD COLUMN location TEXT`,
  `ALTER TABLE items ADD COLUMN status TEXT DEFAULT 'Approved'`,
  `ALTER TABLE items ADD COLUMN submitted_by INTEGER REFERENCES users(id)`,
  `ALTER TABLE items ADD COLUMN created_from_pr_id INTEGER`,
  `ALTER TABLE purchase_requests ADD COLUMN item_text TEXT`,
  `ALTER TABLE approval_chain_steps ADD COLUMN requires_supervisor INTEGER DEFAULT 0`,
  `ALTER TABLE employees ADD COLUMN employment_type TEXT DEFAULT 'Full-time'`,
  `ALTER TABLE employees ADD COLUMN pan_number TEXT`,
  `ALTER TABLE employees ADD COLUMN blood_group TEXT`,
  `ALTER TABLE employees ADD COLUMN emergency_contact_name TEXT`,
  `ALTER TABLE employees ADD COLUMN emergency_contact_phone TEXT`,
  `ALTER TABLE employees ADD COLUMN exit_date TEXT`,
  `ALTER TABLE leave_types ADD COLUMN is_paid INTEGER DEFAULT 1`,
  `ALTER TABLE leave_types ADD COLUMN probation_months INTEGER DEFAULT 0`,
  `ALTER TABLE leave_types ADD COLUMN accrual TEXT DEFAULT 'Annual'`,
  `ALTER TABLE leave_types ADD COLUMN carry_forward INTEGER DEFAULT 0`,
  `ALTER TABLE leave_types ADD COLUMN max_carry_forward REAL DEFAULT 0`,
  `ALTER TABLE salary_advances ADD COLUMN installments INTEGER DEFAULT 1`,
  `ALTER TABLE salary_advances ADD COLUMN installment_amount REAL DEFAULT 0`,
  `ALTER TABLE salary_advances ADD COLUMN installments_paid INTEGER DEFAULT 0`,
  `ALTER TABLE salary_schedule ADD COLUMN leave_deduction REAL DEFAULT 0`,
  `ALTER TABLE salary_schedule ADD COLUMN advance_deduction_detail TEXT`,
  // ---- Round 3 ----
  `ALTER TABLE service_requests ADD COLUMN reopen_reason TEXT`,
  // ---- Round 3 fixes ----
  `ALTER TABLE employees ADD COLUMN bank_name TEXT`,
  `ALTER TABLE employees ADD COLUMN account_number TEXT`,
  `ALTER TABLE employees ADD COLUMN ifsc_code TEXT`,
  `ALTER TABLE employees ADD COLUMN aadhaar_number TEXT`,
  `ALTER TABLE employees ADD COLUMN passport_number TEXT`,
  `ALTER TABLE employees ADD COLUMN visa_availability TEXT`,
  `ALTER TABLE employees ADD COLUMN driving_license_number TEXT`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT,
    uploaded_by INTEGER REFERENCES users(id),
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 5: Vendor Master expansion ----
  `ALTER TABLE vendors ADD COLUMN legal_name TEXT`,
  `ALTER TABLE vendors ADD COLUMN trade_name TEXT`,
  `ALTER TABLE vendors ADD COLUMN gstin TEXT`,
  `ALTER TABLE vendors ADD COLUMN pan TEXT`,
  `ALTER TABLE vendors ADD COLUMN vendor_type TEXT`,
  `ALTER TABLE vendors ADD COLUMN is_msme INTEGER DEFAULT 0`,
  `ALTER TABLE vendors ADD COLUMN msme_number TEXT`,
  `ALTER TABLE vendors ADD COLUMN state TEXT`,
  `ALTER TABLE vendors ADD COLUMN state_code TEXT`,
  `ALTER TABLE vendors ADD COLUMN address_line1 TEXT`,
  `ALTER TABLE vendors ADD COLUMN address_line2 TEXT`,
  `ALTER TABLE vendors ADD COLUMN city TEXT`,
  `ALTER TABLE vendors ADD COLUMN pincode TEXT`,
  `ALTER TABLE vendors ADD COLUMN country TEXT DEFAULT 'India'`,
  `ALTER TABLE vendors ADD COLUMN bank_name TEXT`,
  `ALTER TABLE vendors ADD COLUMN bank_account_number TEXT`,
  `ALTER TABLE vendors ADD COLUMN bank_ifsc TEXT`,
  `ALTER TABLE vendors ADD COLUMN bank_account_holder TEXT`,
  `ALTER TABLE vendors ADD COLUMN payment_terms TEXT`,
  `ALTER TABLE vendors ADD COLUMN payment_terms_days INTEGER DEFAULT 0`,
  `ALTER TABLE vendors ADD COLUMN status TEXT DEFAULT 'Active'`,
  `ALTER TABLE vendors ADD COLUMN po_email TEXT`,
  // ---- Round 5: Purchase orders GST fields ----
  `ALTER TABLE purchase_orders ADD COLUMN hsn_code TEXT`,
  `ALTER TABLE purchase_orders ADD COLUMN gst_rate REAL DEFAULT 18`,
  `ALTER TABLE purchase_orders ADD COLUMN gst_amount REAL DEFAULT 0`,
  `ALTER TABLE purchase_orders ADD COLUMN terms TEXT`,
  `ALTER TABLE purchase_orders ADD COLUMN delivery_date TEXT`,
  // ---- Round 5: Settings (generic key-value) ----
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  // ---- Round 5: Finance - Sales Invoices ----
  `CREATE TABLE IF NOT EXISTS sales_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no TEXT UNIQUE,
    sales_order_id INTEGER REFERENCES sales_orders(id),
    client_id INTEGER REFERENCES clients(id),
    invoice_date TEXT DEFAULT CURRENT_TIMESTAMP,
    place_of_supply TEXT,
    buyer_gstin TEXT,
    buyer_state TEXT,
    taxable_value REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    total_value REAL DEFAULT 0,
    status TEXT DEFAULT 'Draft',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sales_invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id),
    description TEXT NOT NULL,
    hsn_code TEXT,
    quantity REAL DEFAULT 1,
    unit TEXT DEFAULT 'Nos',
    rate REAL DEFAULT 0,
    taxable_value REAL DEFAULT 0,
    gst_rate REAL DEFAULT 18,
    sort_order INTEGER DEFAULT 0
  )`,
  // ---- Round 5: Operating Expenses ----
  `CREATE TABLE IF NOT EXISTS operating_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_date TEXT DEFAULT CURRENT_TIMESTAMP,
    category TEXT,
    description TEXT,
    amount REAL NOT NULL,
    paid_via TEXT DEFAULT 'Bank',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 5: Asset Management ----
  `CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_code TEXT UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    purchase_date TEXT,
    purchase_value REAL DEFAULT 0,
    vendor_id INTEGER REFERENCES vendors(id),
    department_id INTEGER REFERENCES departments(id),
    custodian_id INTEGER REFERENCES employees(id),
    useful_life_years REAL DEFAULT 5,
    depreciation_method TEXT DEFAULT 'StraightLine',
    salvage_value REAL DEFAULT 0,
    status TEXT DEFAULT 'Active',
    disposal_date TEXT,
    disposal_value REAL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS asset_maintenance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    log_date TEXT DEFAULT CURRENT_TIMESTAMP,
    type TEXT DEFAULT 'Preventive',
    description TEXT,
    cost REAL DEFAULT 0,
    performed_by TEXT,
    next_due_date TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 5: Ticketing ----
  `CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_no TEXT UNIQUE,
    subject TEXT NOT NULL,
    description TEXT,
    category TEXT,
    priority TEXT DEFAULT 'Medium',
    department_id INTEGER REFERENCES departments(id),
    raised_by INTEGER REFERENCES users(id),
    assigned_to INTEGER REFERENCES users(id),
    status TEXT DEFAULT 'Open',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    user_id INTEGER REFERENCES users(id),
    comment TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 6: Sales & Marketing upgrade ----
  `ALTER TABLE leads ADD COLUMN lead_source TEXT`,
  `ALTER TABLE leads ADD COLUMN lost_reason TEXT`,
  `ALTER TABLE leads ADD COLUMN lost_reason_detail TEXT`,
  `ALTER TABLE leads ADD COLUMN stage_changed_at TEXT`,
  `ALTER TABLE offers ADD COLUMN parent_offer_id INTEGER REFERENCES offers(id)`,
  // ---- Round 7: Time & Motion tracking ----
  `ALTER TABLE job_cards ADD COLUMN allocated_at TEXT`,
  `CREATE TABLE IF NOT EXISTS lead_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    activity_type TEXT NOT NULL,        -- Call, Email, Meeting, Site Visit, Demo, Note
    notes TEXT,
    due_date TEXT,
    completed_at TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 7: Service Centers ----
  `ALTER TABLE stock_movements ADD COLUMN service_center_id INTEGER REFERENCES service_centers(id)`,
  `CREATE TABLE IF NOT EXISTS sales_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,               -- YYYY-MM
    owner_id INTEGER REFERENCES users(id),   -- NULL = company-wide target
    target_value REAL NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 9: Service Report - replicate the printed field-service form ----
  `ALTER TABLE service_reports ADD COLUMN sl_no TEXT`,
  `ALTER TABLE service_reports ADD COLUMN customer_name TEXT`,
  `ALTER TABLE service_reports ADD COLUMN customer_address TEXT`,
  `ALTER TABLE service_reports ADD COLUMN contact_person TEXT`,
  `ALTER TABLE service_reports ADD COLUMN contact_no TEXT`,
  `ALTER TABLE service_reports ADD COLUMN engineer_name TEXT`,
  `ALTER TABLE service_reports ADD COLUMN visit_from TEXT`,
  `ALTER TABLE service_reports ADD COLUMN visit_to TEXT`,
  `ALTER TABLE service_reports ADD COLUMN days_at_site REAL`,
  `ALTER TABLE service_reports ADD COLUMN activity_date TEXT`,
  `ALTER TABLE service_reports ADD COLUMN activity_start_time TEXT`,
  `ALTER TABLE service_reports ADD COLUMN activity_end_time TEXT`,
  `ALTER TABLE service_reports ADD COLUMN machine_type TEXT`,
  `ALTER TABLE service_reports ADD COLUMN machine_capacity TEXT`,
  `ALTER TABLE service_reports ADD COLUMN type_of_visit TEXT`,
  `ALTER TABLE service_reports ADD COLUMN reason_for_visit TEXT`,
  `ALTER TABLE service_reports ADD COLUMN faults_found TEXT`,
  `ALTER TABLE service_reports ADD COLUMN action_taken TEXT`,
  `ALTER TABLE service_reports ADD COLUMN completion_remarks TEXT`,
  `ALTER TABLE service_reports ADD COLUMN amount_updown_food REAL DEFAULT 0`,
  `ALTER TABLE service_reports ADD COLUMN machine_working_satisfactorily TEXT`,
  `ALTER TABLE service_reports ADD COLUMN visit_rating TEXT`,
  `ALTER TABLE service_reports ADD COLUMN overall_feedback TEXT`,
  `ALTER TABLE service_reports ADD COLUMN customer_remarks TEXT`,
  `ALTER TABLE service_reports ADD COLUMN customer_signatory_mobile TEXT`,
  `ALTER TABLE service_reports ADD COLUMN engineer_remarks TEXT`,
  `ALTER TABLE service_reports ADD COLUMN engineer_signatory_mobile TEXT`,
  // ---- Round 10: signature capture, service center address already exists ----
  `ALTER TABLE service_reports ADD COLUMN customer_signature_path TEXT`,
  // ---- Round 13: Purchase multi-vendor quotes for high-value PRs ----
  `ALTER TABLE purchase_requests ADD COLUMN quotes_required INTEGER DEFAULT 0`,
  // ---- Round 15: Service Request Queue enhancements (job-state, geolocation, 15-day reopen) ----
  `ALTER TABLE service_requests ADD COLUMN job_status TEXT DEFAULT 'Assigned'`,
  `ALTER TABLE service_requests ADD COLUMN closed_at TEXT`,
  `ALTER TABLE service_requests ADD COLUMN start_lat REAL`,
  `ALTER TABLE service_requests ADD COLUMN start_lng REAL`,
  `ALTER TABLE service_requests ADD COLUMN start_captured_at TEXT`,
  `ALTER TABLE service_requests ADD COLUMN end_lat REAL`,
  `ALTER TABLE service_requests ADD COLUMN end_lng REAL`,
  `ALTER TABLE service_requests ADD COLUMN end_captured_at TEXT`,
  // ---- Round 16: PO/SO commercial terms (LD clause + promised delivery) and Bank Guarantee tracking ----
  `ALTER TABLE sales_orders ADD COLUMN promised_delivery_date TEXT`,
  `ALTER TABLE sales_orders ADD COLUMN ld_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN ld_cap_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN ld_trigger_notes TEXT`,
  `ALTER TABLE purchase_orders ADD COLUMN ld_percentage REAL`,
  `ALTER TABLE purchase_orders ADD COLUMN ld_cap_percentage REAL`,
  `ALTER TABLE purchase_orders ADD COLUMN ld_trigger_notes TEXT`,
  `CREATE TABLE IF NOT EXISTS payment_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_type TEXT NOT NULL,              -- 'SO' or 'PO'
    order_id INTEGER NOT NULL,
    milestone_name TEXT NOT NULL,
    due_type TEXT NOT NULL DEFAULT 'Date', -- 'Date' or 'Event'
    due_date TEXT,
    linked_event TEXT,
    percentage REAL,
    amount REAL,
    status TEXT DEFAULT 'Pending',         -- Pending, Invoiced, Received, Overdue
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS bank_guarantees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bg_no TEXT UNIQUE,
    bg_type TEXT NOT NULL,                 -- 'Advance' or 'Performance'
    order_type TEXT NOT NULL,              -- 'SO' or 'PO'
    order_id INTEGER NOT NULL,
    project_id INTEGER REFERENCES projects(id),
    issuing_bank TEXT,
    beneficiary TEXT,
    value REAL NOT NULL DEFAULT 0,
    issue_date TEXT,
    validity_expiry TEXT NOT NULL,
    claim_expiry TEXT,
    milestone_link TEXT,
    status TEXT DEFAULT 'Active',          -- Active, PendingRelease, Released, Expired, Extended, Invoked
    released_at TEXT,
    released_by INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    source_type TEXT NOT NULL,             -- BG_EXPIRY, PO_DELIVERY_OVERDUE, SO_DELIVERY_OVERDUE, PAYMENT_MILESTONE_DUE
    source_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 17: parallel department scheduling on the Targets sheet ----
  // A stage marked parallel_with_previous starts on the same day as the
  // stage immediately above it in the plan, instead of waiting for that
  // stage to finish - see the date-math in PUT /projects/:id/plan.
  `ALTER TABLE job_cards ADD COLUMN parallel_with_previous INTEGER DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS bg_reminder_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bg_id INTEGER NOT NULL REFERENCES bank_guarantees(id),
    trigger_reason TEXT NOT NULL,          -- ExpiryApproaching, ProjectCompleted, MilestoneReached, ClaimExpiryApproaching
    triggered_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'PendingReview',   -- PendingReview, Verified, EmailSent, Dismissed
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    email_sent_to TEXT,
    email_sent_at TEXT
  )`,
  // ---- Round 18: historical/manual Bank Guarantees with no matching SO/PO
  // in this system (data migration). order_type gains a third value, 'LEGACY'
  // - order_id is stored as 0 (there's no real FK on this polymorphic column
  // to violate) and legacy_ref carries the old system's/paper record's own
  // reference number as plain audit text. See routes/dataImport.js.
  `ALTER TABLE bank_guarantees ADD COLUMN legacy_ref TEXT`,
  // ---- Round 19: To-Do List (action items logged against a department HOD
  // and handed to whoever actually has the action) - see routes/todos.js.
  `CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hod_id INTEGER REFERENCES users(id),
    assigned_to INTEGER NOT NULL REFERENCES users(id),
    start_date TEXT NOT NULL,
    target_date TEXT NOT NULL,
    brief_description TEXT NOT NULL,
    details TEXT,
    status TEXT DEFAULT 'Pending',         -- Pending, InProgress, Completed, OnHold
    created_by INTEGER REFERENCES users(id),
    completed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 20: FOC customer capture independent of an SO, auto-generated
  // Client ID, and structured Bill-to/Ship-to addresses per client.
  `ALTER TABLE foc_requests ADD COLUMN client_id INTEGER REFERENCES clients(id)`,
  `ALTER TABLE foc_requests ADD COLUMN customer_name TEXT`,
  `ALTER TABLE foc_requests ADD COLUMN contact_person TEXT`,
  `ALTER TABLE foc_requests ADD COLUMN contact_phone TEXT`,
  // FOC department routing: the approver must pick which department will
  // physically issue the material as part of approving it (not a separate
  // step afterward), so the department, the printable Annexure, and the
  // in-app to-do it fires are all in place the moment a request goes
  // Approved. issued_by/issued_at give the same audit trail Mark Issued
  // already had for approved_by/approved_at, just never actually recorded.
  `ALTER TABLE foc_requests ADD COLUMN fulfilling_department_id INTEGER REFERENCES departments(id)`,
  `ALTER TABLE foc_requests ADD COLUMN issued_by INTEGER REFERENCES users(id)`,
  `ALTER TABLE foc_requests ADD COLUMN issued_at TEXT`,
  `ALTER TABLE clients ADD COLUMN client_code TEXT`,
  `CREATE TABLE IF NOT EXISTS client_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    address_type TEXT NOT NULL,        -- 'Billing' or 'Shipping'
    label TEXT,                        -- e.g. "Head Office", "Plant 2 - Manesar"
    line1 TEXT NOT NULL,
    line2 TEXT,
    city TEXT,
    state TEXT,
    state_code TEXT,                   -- drives CGST/SGST vs IGST on invoices/proforma
    pincode TEXT,
    gstin TEXT,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 21: admin-editable dropdown options for the Offers/Quotations
  // form's Application / Type of System / Material of Construction fields -
  // one generic table for all three (same shape), see routes/offers.js.
  `CREATE TABLE IF NOT EXISTS offer_field_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_name TEXT NOT NULL,     -- 'application' | 'type_of_system' | 'material_of_construction'
    value TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    UNIQUE(field_name, value)
  )`,
  // ---- Round 22: Proforma Invoices (Advance / Pre-Dispatch) - separate from
  // sales_invoices since a proforma is not a fiscal tax document, doesn't
  // consume the tax-invoice-number sequence, and doesn't push the SO to
  // Invoiced. One SO can have several (one Advance, one PreDispatch) plus
  // exactly one eventual tax invoice - see routes/finance.js.
  `CREATE TABLE IF NOT EXISTS proforma_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proforma_no TEXT UNIQUE,
    sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
    client_id INTEGER REFERENCES clients(id),
    milestone_id INTEGER REFERENCES payment_milestones(id),
    invoice_type TEXT NOT NULL,        -- 'Advance' or 'PreDispatch'
    proforma_date TEXT DEFAULT CURRENT_TIMESTAMP,
    place_of_supply TEXT,
    buyer_gstin TEXT,
    buyer_state TEXT,
    taxable_value REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    total_value REAL DEFAULT 0,
    status TEXT DEFAULT 'Draft',       -- Draft, Sent, Received, Cancelled
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS proforma_invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proforma_id INTEGER NOT NULL REFERENCES proforma_invoices(id),
    description TEXT NOT NULL,
    taxable_value REAL DEFAULT 0,
    gst_rate REAL DEFAULT 18,
    sort_order INTEGER DEFAULT 0
  )`,
  // ---- Round 23: To-Do activity log - notes the assignee (or the logging
  // HOD/Admin) attaches to a To-Do over its life, plus an auto-logged entry
  // per status change, so the two merge into one timeline. See routes/todos.js.
  `CREATE TABLE IF NOT EXISTS todo_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL REFERENCES todos(id),
    user_id INTEGER REFERENCES users(id),
    note TEXT NOT NULL,
    status_at_update TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 24: BG claim-expiry compliance workflow - a system-generated
  // To-Do needs a priority to flag urgency, and a source_type/source_id
  // pointer (same polymorphic pattern as `notifications`) so the scan job
  // can tell "is there already an open To-Do for this BG's claim deadline"
  // without fragile text matching. See lib/bgReminderScan.js.
  `ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT 'Normal'`,
  `ALTER TABLE todos ADD COLUMN source_type TEXT`,
  `ALTER TABLE todos ADD COLUMN source_id INTEGER`,
  // ---- Round 25: Organizational Hierarchy - a self-referential rollup tree
  // (Region -> Unit -> Department -> Team) that sits ABOVE the existing
  // departments/roles/is_supervisor model for reporting purposes only. A
  // leaf node optionally maps to a real `departments` row via department_id,
  // which is how the rollup report aggregates real data (headcount, salary
  // cost) up the tree. Deliberately additive: no existing permission check,
  // HOD flag, or department itself is touched by this table's existence.
  // See routes/orgHierarchy.js.
  `CREATE TABLE IF NOT EXISTS org_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    node_type TEXT NOT NULL,           -- Region, Unit, Department, Team
    parent_id INTEGER REFERENCES org_nodes(id),
    department_id INTEGER REFERENCES departments(id),
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 26: Offer version-control gaps closed - an offer's iteration
  // history had no link back to the enquiry/RFQ that started it (only to the
  // client), and no note of *why* a version was revised. See lib/offerVersioning.js.
  `ALTER TABLE offers ADD COLUMN lead_id INTEGER REFERENCES leads(id)`,
  `ALTER TABLE offers ADD COLUMN revision_reason TEXT`,
  // ---- Round 27: Automated Statement of Accounts. sales_invoices.mark-paid
  // only ever flipped a whole invoice to Paid with no record of when/how much/
  // by what mode money actually arrived - not enough to build a real
  // per-client running balance. payment_receipts is the missing credit side;
  // a Statement of Accounts is (non-cancelled sales_invoices as debits) +
  // (payment_receipts as credits), sorted by date. See lib/soaLedger.js.
  `CREATE TABLE IF NOT EXISTS payment_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no TEXT UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    sales_invoice_id INTEGER REFERENCES sales_invoices(id),
    amount REAL NOT NULL,
    receipt_date TEXT NOT NULL,
    mode TEXT NOT NULL,                -- Cash, Cheque, NEFT, RTGS, UPI, Other
    reference_no TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // SOA dispatch cadence config: one row with client_id NULL is the org-wide
  // default; a row with client_id set overrides it for that client only
  // (enforced application-side for the NULL row, and by a partial unique
  // index below for client rows - see routes/soa.js).
  `CREATE TABLE IF NOT EXISTS soa_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    frequency TEXT NOT NULL DEFAULT 'Off',   -- Off, Monthly, Quarterly
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // A generated-but-not-yet-emailed statement, mirroring bg_reminder_log's
  // internal-verify-then-email pattern so no statement reaches a customer's
  // inbox without a human checking it first. See lib/soaScan.js.
  `CREATE TABLE IF NOT EXISTS soa_dispatch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    closing_balance REAL,
    status TEXT DEFAULT 'PendingReview',     -- PendingReview, Verified, EmailSent, Dismissed
    generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    email_sent_to TEXT,
    email_sent_at TEXT
  )`,
  // ---- Round 28: Order Confirmation & Annexure Dual-Approval. Confirming an
  // offer still creates the Sales Order/Project/job cards instantly (never
  // gated - production isn't delayed), but the two customer/execution-facing
  // documents it produces now each need their own review -> approve -> lock
  // before being considered final. See lib/reviewWorkflow.js and
  // routes/orderConfirmation.js.
  `CREATE TABLE IF NOT EXISTS order_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_order_id INTEGER NOT NULL UNIQUE REFERENCES sales_orders(id),
    delivery_terms TEXT,
    payment_terms TEXT,
    special_instructions TEXT,
    status TEXT DEFAULT 'Draft',       -- Draft, PendingApproval, Approved, Rejected
    submitted_by INTEGER REFERENCES users(id),
    submitted_at TEXT,
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    rejection_reason TEXT,
    locked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // The annexure's actual technical content still comes from its sales
  // order's (frozen, version-controlled) offer - this row is the review
  // wrapper around that generated document: notes, an optional manually
  // revised file, and the approve/lock state. Regenerating or reuploading
  // the underlying file is blocked once locked (see routes/sales.js and
  // routes/orderConfirmation.js).
  `CREATE TABLE IF NOT EXISTS annexure_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_order_id INTEGER NOT NULL UNIQUE REFERENCES sales_orders(id),
    review_notes TEXT,
    status TEXT DEFAULT 'Draft',       -- Draft, PendingApproval, Approved, Rejected
    submitted_by INTEGER REFERENCES users(id),
    submitted_at TEXT,
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    rejection_reason TEXT,
    locked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 29: Password reset + welcome email + SR activity log.
  // users had no email at all - it's needed both to look someone up for a
  // password reset and to send the welcome email on account creation.
  // Nullable/unenforced-unique on purpose: many existing accounts (and
  // Admin/demo logins) will never have one set, and that's fine - reset-by-
  // email and the welcome email simply don't apply to them.
  `ALTER TABLE users ADD COLUMN email TEXT`,
  // Set on any account whose current password was auto-generated (welcome
  // email) or reset via a token, rather than chosen by the person - checked
  // at login to force a change before they can use the app with a password
  // that passed through an email inbox.
  `ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`,
  // One reset/activation flow, not two - setting a first password on a new
  // account and resetting a forgotten one are the same operation
  // (token proves "this really is that email's owner", then set a password),
  // so `purpose` is a label for the email copy, not a fork in the logic.
  // Only the token's hash is ever stored, never the raw token itself (same
  // reasoning as a password hash) - see lib/passwordReset.js.
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'PasswordReset',   -- PasswordReset, AccountActivation
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // Free-form activity log for a Service Request, independent of the
  // formal status/job-status state machines already in service_requests -
  // support/ops can log "called customer, waiting on part" without that
  // being a status transition. Same shape as todo_updates (the same need,
  // solved once before for To-Dos): a note plus an optional status_change/
  // action_taken pair, so a real transition (including a reopen) can be
  // annotated in the same timeline as pure commentary. See routes/service.js.
  `CREATE TABLE IF NOT EXISTS sr_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sr_id INTEGER NOT NULL REFERENCES service_requests(id),
    user_id INTEGER REFERENCES users(id),
    note TEXT,
    status_change TEXT,
    action_taken TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 22: Cross-department oversight (e.g. one HOD covering both
  // Electrical and Service without merging the two departments/roles - see
  // lib/roleOversight.js) and Daily Work Log entries becoming assignable
  // (status + who assigned it) instead of pure free-text.
  `CREATE TABLE IF NOT EXISTS role_oversight (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    oversees_role_id INTEGER NOT NULL REFERENCES roles(id),
    granted_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE daily_work_logs ADD COLUMN status TEXT`,
  `ALTER TABLE daily_work_logs ADD COLUMN assigned_by INTEGER REFERENCES users(id)`,
  // ---- Round 23: Item Master edit/delete approval gate. Editing or
  // deleting an item already in the (Approved) master doesn't touch the
  // live row directly for a non-Admin - it's queued here and only applied
  // once approved, so nothing changes underneath a transaction already in
  // flight against that item. Admin edits/deletes apply immediately (same
  // "Admin bypasses the gate" convention used throughout this app). See
  // routes/masters.js.
  `CREATE TABLE IF NOT EXISTS item_pending_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    change_type TEXT NOT NULL,          -- Edit, Delete
    proposed_fields TEXT,               -- JSON of {field: value} - null for Delete
    status TEXT DEFAULT 'Pending',      -- Pending, Approved, Rejected
    requested_by INTEGER REFERENCES users(id),
    requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    review_note TEXT
  )`,
  // ---- Round 24: Purchase Requests become multi-line-item. Each PR can now
  // carry more than one item/qty/value line, mirroring the challan_items
  // child-table pattern. purchase_requests keeps its own item_id/quantity/
  // estimated_value columns as a mirror of the first line (+ the summed
  // value) so any read path not yet updated for multi-line still works.
  `CREATE TABLE IF NOT EXISTS purchase_request_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id),
    item_id INTEGER REFERENCES items(id),
    item_text TEXT,
    quantity REAL NOT NULL,
    estimated_value REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`,
  // Tracks which PR line a PO was raised against, since Purchase Orders stay
  // single-item even though a PR can now have several lines.
  `ALTER TABLE purchase_orders ADD COLUMN purchase_request_item_id INTEGER REFERENCES purchase_request_items(id)`,
  // ---- Round 25: multiple company Bill-To/Ship-To address profiles (e.g.
  // separate factory/office locations), mirroring the existing
  // client_addresses pattern but with no parent - there's only ever one
  // company. A PO can pick which one applies instead of the single flat
  // registered_address on lib/settings.js's company blob.
  `CREATE TABLE IF NOT EXISTS company_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address_type TEXT NOT NULL,        -- 'Billing' or 'Shipping'
    label TEXT,                        -- e.g. "Head Office", "Factory - Faridabad"
    line1 TEXT NOT NULL,
    line2 TEXT,
    city TEXT,
    state TEXT,
    state_code TEXT,
    pincode TEXT,
    gstin TEXT,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE purchase_orders ADD COLUMN company_address_id INTEGER REFERENCES company_addresses(id)`,
  // ---- Round 26: per-offer section include/exclude toggles for the
  // generated PDF (Technical Specifications, Make of Bought-Out Items,
  // Inclusions/Exclusions/Utilities+Instrument Air as one group, since the
  // Offer Builder already edits all four of those fields together on one
  // tab). NULL on a pre-existing row (ALTER TABLE doesn't backfill it here)
  // is treated as "show" in lib/offerPdf.js, same as a fresh DEFAULT 1 row -
  // no existing offer's PDF changes until someone explicitly unchecks a box.
  `ALTER TABLE offers ADD COLUMN show_tech_specs INTEGER DEFAULT 1`,
  `ALTER TABLE offers ADD COLUMN show_bought_out INTEGER DEFAULT 1`,
  `ALTER TABLE offers ADD COLUMN show_inclusions_exclusions INTEGER DEFAULT 1`,
  // ---- Round 27: Section Title library - an admin-managed catalog of named
  // machinery/scope lines (title + description + summary + picture) that the
  // Offer Builder's "Add Machinery / Scope Line" form can pick from to
  // auto-fill the description/image instead of retyping them on every
  // offer. offer_items.section_title/description/image_path stay plain
  // copied values (same as before) rather than FKs into this table, so
  // deleting or editing a library entry never touches any offer already
  // built from it.
  `CREATE TABLE IF NOT EXISTS section_title_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE,
    description TEXT,
    summary TEXT,
    image_path TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Round 28: Sales Order Bank Guarantee terms. bank_guarantees (Round
  // 17-ish) already tracks an actual BG once someone creates one, but
  // nothing on the SO itself declares that an ABG/PBG is owed in the first
  // place - creating one has been a fully manual, disconnected step. These
  // columns are the SO-side "this order requires a BG" declaration; the
  // actual BG record it's satisfied by is still resolved at read time via
  // bank_guarantees WHERE order_type='SO' AND order_id=<so>, same
  // polymorphic link every other BG consumer already uses (no new FK).
  `ALTER TABLE sales_orders ADD COLUMN abg_required INTEGER DEFAULT 0`,
  `ALTER TABLE sales_orders ADD COLUMN abg_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN abg_amount REAL`,
  `ALTER TABLE sales_orders ADD COLUMN abg_validity_days INTEGER`,
  `ALTER TABLE sales_orders ADD COLUMN pbg_required INTEGER DEFAULT 0`,
  `ALTER TABLE sales_orders ADD COLUMN pbg_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN pbg_amount REAL`,
  `ALTER TABLE sales_orders ADD COLUMN pbg_validity_days INTEGER`,
  `ALTER TABLE sales_orders ADD COLUMN bg_terms_notes TEXT`,
  // ---- Round 40: Offer immutability. Set once an offer is converted to a
  // Sales Order (routes/offers.js POST /:id/confirm) - the schema.sql
  // triggers below (and the app-level guard in lib/offerVersioning.js) both
  // refuse any further UPDATE/DELETE/INSERT against a locked offer or its
  // items/tech-specs/bought-out/terms, short of an Admin-only, audited
  // unlock (POST /:id/unlock). Whether conversion sets this flag at all is
  // itself an admin-editable, easily reversible setting - see
  // lib/settings.js's getOfferGovernanceSettings().
  `ALTER TABLE offers ADD COLUMN locked INTEGER DEFAULT 0`,
  `ALTER TABLE offers ADD COLUMN locked_at TEXT`,
  `ALTER TABLE offers ADD COLUMN locked_reason TEXT`,
  // ---- RFQ workflow: a quote can now optionally be tied to one specific PR
  // line item (purchase_request_item_id) instead of only ever being a
  // whole-PR lump sum - NULL keeps the original behavior (whole-PR quote)
  // so the existing 2-quotes-required threshold flow is untouched. The
  // payment_terms/delivery_commit_date/quoted_qty columns capture what the
  // RFQ actually asked vendors for; rfq_request_id is a soft trace back to
  // the rfq_requests row that prompted this quote, when there was one (a
  // quote can still be entered by hand with no RFQ ever sent, same as today).
  `ALTER TABLE purchase_request_quotes ADD COLUMN purchase_request_item_id INTEGER REFERENCES purchase_request_items(id)`,
  `ALTER TABLE purchase_request_quotes ADD COLUMN payment_terms TEXT`,
  `ALTER TABLE purchase_request_quotes ADD COLUMN delivery_commit_date TEXT`,
  `ALTER TABLE purchase_request_quotes ADD COLUMN quoted_qty REAL`,
  `ALTER TABLE purchase_request_quotes ADD COLUMN rfq_request_id INTEGER REFERENCES rfq_requests(id)`,
  // ---- Optional additional offsite copy of each backup, uploaded to Zoho
  // WorkDrive by lib/zohoWorkdrive.js alongside the existing email option -
  // see the Backups & migration section of README.md for setup.
  `ALTER TABLE backup_runs ADD COLUMN zoho_uploaded INTEGER DEFAULT 0`,
  `ALTER TABLE backup_runs ADD COLUMN zoho_file_id TEXT`,
  `ALTER TABLE backup_runs ADD COLUMN zoho_error TEXT`,
  // ---- Foreign Payments: lets an uploaded attachment declare which of the
  // ARIM-style document categories it is (Payment Advice, Bill of Entry,
  // Bill of Lading, Vendor Invoice, Proforma Invoice, Other) - optional and
  // NULL for every attachment type that existed before this (BG scans,
  // expense voucher receipts, etc.), which just never show a category.
  `ALTER TABLE attachments ADD COLUMN document_type TEXT`,
  // ---- Per-department outgoing email identity ----
  // Lets a department's own name/address show as the "From" on the mail it
  // sends (PO/RFQ emails from Purchase, Invoice/Proforma emails from Sales,
  // SOA/BG reminder emails from Accounts) while still relaying through the
  // one shared SMTP account in lib/settings.js - NULL (the default) falls
  // back to that global From Name/Address, so this is opt-in per department.
  `ALTER TABLE departments ADD COLUMN email_from_name TEXT`,
  `ALTER TABLE departments ADD COLUMN email_from_address TEXT`,
  // ---- Backup resilience: a single unreadable file under uploads (a
  // corrupted volume block, a broken symlink) used to abort the whole
  // backup via fs.cpSync. The copy is now per-file and skips a bad file
  // instead of failing the run - this records which files it had to skip
  // (JSON array of {path, error}) so an Admin can see what's actually
  // missing from a given backup's artifact.
  `ALTER TABLE backup_runs ADD COLUMN skipped_files TEXT`,
  // ---- Equipment Description summary text ----
  // section_title_library already had a `summary` field, but nothing ever
  // copied it onto an offer item or rendered it - picking a library section
  // title only ever carried over title/description/image. This is that
  // missing piece, copied at use time same as description/image_path (see
  // section_title_library's own comment) so editing the library later never
  // changes an offer already built from it.
  `ALTER TABLE offer_items ADD COLUMN summary TEXT`,
  // ---- Section Title suggestions ----
  // A user typing a brand-new section title directly on an offer item (the
  // "type a new one" path, bypassing the library dropdown) never reached
  // section_title_library - the next person quoting similar equipment had
  // no way to find it and just retyped it again. This is a lightweight
  // review queue: the typed title/description/summary/picture is recorded
  // here (never touching the offer item itself, which saves normally
  // either way) and every Admin gets a To-Do to approve it into the real
  // library or reject it - see routes/offers.js's item create/update.
  `CREATE TABLE IF NOT EXISTS section_title_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    summary TEXT,
    image_path TEXT,
    offer_id INTEGER REFERENCES offers(id),
    offer_item_id INTEGER REFERENCES offer_items(id),
    suggested_by INTEGER REFERENCES users(id),
    status TEXT DEFAULT 'Pending',
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // ---- Per-user page access overrides ----
  // The role matrix (role_page_access) and Extra Page Access are additive
  // only - neither can take a page away from one specific person without
  // reconfiguring their whole role. This is the missing subtractive half:
  // one row per (user, page) that either adds a page the role/extra grants
  // don't cover, or removes one they do - see lib/pageAccess.js's
  // computeAllowedPages(), the single place all of role_page_access,
  // extra_page_access and this table are merged into the page list a user
  // actually sees (routes/auth.js's /my-pages, and the Admin-only
  // per-user preview in routes/admin.js).
  `CREATE TABLE IF NOT EXISTS user_page_overrides (
    user_id INTEGER NOT NULL REFERENCES users(id),
    page_id TEXT NOT NULL,
    access TEXT NOT NULL CHECK (access IN ('granted', 'revoked')),
    granted_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, page_id)
  )`,
  // ---- Per-project pipeline stage exclusion ----
  // Every project got the exact same fixed 10-stage (+5 Manufacturing
  // sub-stage) job-card tree, unconditionally - a purely bought-out/trading
  // order still got Design, Electrical, Manufacturing and every one of its
  // sub-processes stamped out alongside Purchase and Store, all sitting
  // there Pending forever. Worse, "just leave it unplanned" doesn't work as
  // a workaround: the handover gate and the project-completion check in
  // routes/projects.js only ever tested status != 'Completed', so an
  // unplanned stage would silently block every later stage from ever
  // starting and the project from ever completing. job_cards.status can now
  // also be 'NotApplicable' (see lib/pipeline.js's excludeJobCard/
  // includeJobCard) - these two columns are just the audit trail of who
  // excluded a stage and when, cleared again on re-include.
  `ALTER TABLE job_cards ADD COLUMN excluded_at TEXT`,
  `ALTER TABLE job_cards ADD COLUMN excluded_by INTEGER REFERENCES users(id)`,

  // Offer commercial terms (delivery/LD/BG) - the same fields sales_orders
  // already has (Round 16/28's commercial-terms form), now also on the
  // offer itself. Today these are only ever typed in manually on the SO
  // after conversion, with nothing on the Offer to originate them from; an
  // offer that never gets a customer PO back has no fallback "what did we
  // commit to" record at all. Copied into the new sales_orders row at
  // confirm time (routes/offers.js POST /:id/confirm) as its starting
  // terms - still independently editable afterward, same as before.
  `ALTER TABLE offers ADD COLUMN promised_delivery_date TEXT`,
  `ALTER TABLE offers ADD COLUMN ld_percentage REAL`,
  `ALTER TABLE offers ADD COLUMN ld_cap_percentage REAL`,
  `ALTER TABLE offers ADD COLUMN ld_trigger_notes TEXT`,
  `ALTER TABLE offers ADD COLUMN abg_required INTEGER DEFAULT 0`,
  `ALTER TABLE offers ADD COLUMN abg_percentage REAL`,
  `ALTER TABLE offers ADD COLUMN abg_amount REAL`,
  `ALTER TABLE offers ADD COLUMN abg_validity_days INTEGER`,
  `ALTER TABLE offers ADD COLUMN pbg_required INTEGER DEFAULT 0`,
  `ALTER TABLE offers ADD COLUMN pbg_percentage REAL`,
  `ALTER TABLE offers ADD COLUMN pbg_amount REAL`,
  `ALTER TABLE offers ADD COLUMN pbg_validity_days INTEGER`,
  `ALTER TABLE offers ADD COLUMN bg_terms_notes TEXT`,

  // Customer PO capture + cross-check against the SO's own commercial terms.
  // po_status: Pending (not yet decided), NotProvided (customer never sent
  // a formal PO - the SO's own terms, which trace back to the Offer, govern
  // instead), Received (a PO was logged below). po_terms_status is the
  // auto-computed comparison result once Received: Matched, MismatchPending
  // (blocks any not-yet-started job card on this project - see
  // routes/projects.js PATCH /job-cards/:id), or MismatchAcknowledged (a
  // human explicitly accepted the discrepancy - see /po/acknowledge-mismatch).
  // Recomputed by lib/poTerms.js's recomputePoTermsStatus() any time either
  // side's terms change, not just when the PO is first logged.
  `ALTER TABLE sales_orders ADD COLUMN po_status TEXT DEFAULT 'Pending'`,
  `ALTER TABLE sales_orders ADD COLUMN po_number TEXT`,
  `ALTER TABLE sales_orders ADD COLUMN po_date TEXT`,
  `ALTER TABLE sales_orders ADD COLUMN po_delivery_date TEXT`,
  `ALTER TABLE sales_orders ADD COLUMN po_ld_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN po_ld_cap_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN po_abg_required INTEGER DEFAULT 0`,
  `ALTER TABLE sales_orders ADD COLUMN po_abg_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN po_abg_amount REAL`,
  `ALTER TABLE sales_orders ADD COLUMN po_abg_validity_days INTEGER`,
  `ALTER TABLE sales_orders ADD COLUMN po_pbg_required INTEGER DEFAULT 0`,
  `ALTER TABLE sales_orders ADD COLUMN po_pbg_percentage REAL`,
  `ALTER TABLE sales_orders ADD COLUMN po_pbg_amount REAL`,
  `ALTER TABLE sales_orders ADD COLUMN po_pbg_validity_days INTEGER`,
  `ALTER TABLE sales_orders ADD COLUMN po_terms_status TEXT DEFAULT 'NotApplicable'`,
  `ALTER TABLE sales_orders ADD COLUMN po_mismatch_fields TEXT`,
  `ALTER TABLE sales_orders ADD COLUMN po_terms_resolution_notes TEXT`,
  `ALTER TABLE sales_orders ADD COLUMN po_terms_resolved_by INTEGER REFERENCES users(id)`,
  `ALTER TABLE sales_orders ADD COLUMN po_terms_resolved_at TEXT`,

  // RFQ vendor-response mailbox scan: captures the outbound RFQ email's
  // Message-ID at send time, so an inbound reply's In-Reply-To/References
  // header can be matched back to the exact RFQ+vendor it's replying to
  // (see lib/inboundRfqMail.js) - a vendor can easily have more than one
  // open RFQ from us at once, so matching by sender address alone isn't
  // reliable enough on its own.
  `ALTER TABLE rfq_request_vendors ADD COLUMN sent_message_id TEXT`,
  `ALTER TABLE rfq_request_emails ADD COLUMN sent_message_id TEXT`,

  // ---- Offer Equipment Description references (customer-reference-only,
  // decoupled from pricing): lets an offer show a library item's picture and
  // summary on the PDF's Equipment Description page purely for the
  // customer's reference, without adding it as a priced Scope-of-Supply
  // line - e.g. a related product a customer would recognize even though
  // it's not part of what's being quoted. Deliberately its own table rather
  // than a "reference only" flag on offer_items, so it can never affect
  // pricing/grand-total logic anywhere that reads offer_items. title/summary/
  // image_path are copied from the library entry at the moment it's picked
  // (section_title_library_id is kept only as a soft trace of where it came
  // from, same as offer_items' relationship to the library) - NOT resolved
  // live at PDF render time, so editing or deleting the library entry later
  // never changes what an already-generated/sent offer shows, consistent
  // with this app's offer-immutability rules.
  `CREATE TABLE IF NOT EXISTS offer_equipment_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL REFERENCES offers(id),
    section_title_library_id INTEGER REFERENCES section_title_library(id),
    title TEXT NOT NULL,
    summary TEXT,
    image_path TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  // Purchase Order line items (Round: PO multi-line items): payment_terms is
  // a header-level field, same as delivery_date/ld_*/terms - a multi-item PO
  // is still stored as one purchase_orders row per line item (see
  // routes/purchase.js's POST /orders `lines` support), all sharing one
  // po_no, so this column is duplicated onto every line's row and kept in
  // sync across them by PATCH /orders/:id/commercial-terms.
  `ALTER TABLE purchase_orders ADD COLUMN payment_terms TEXT`,

  // Stock In/Out redesign (Round: tabbed Receive/Issue panel): an OUT
  // movement can now record which department the material was issued to
  // (Store fulfills requests from every other department and needs to
  // record whose request it was) and, separately from project_id, which
  // client it was issued against - a quick customer-facing issue that
  // isn't tracked as a formal Project. Both nullable: neither applies to
  // an IN movement, and an OUT movement not tied to either still works
  // exactly as before.
  `ALTER TABLE stock_movements ADD COLUMN department_id INTEGER REFERENCES departments(id)`,
  `ALTER TABLE stock_movements ADD COLUMN client_id INTEGER REFERENCES clients(id)`,

  // Purchase Order approval gate (Purchase HOD -> Management, value-gated) -
  // same approval_id-on-the-entity pattern purchase_requests already uses,
  // so the PR resubmit/"prior rejection" UX conventions carry straight over.
  // See bootstrapPurchaseOrderApproval() below for the chain/steps themselves.
  `ALTER TABLE purchase_orders ADD COLUMN approval_id INTEGER REFERENCES approvals(id)`,

  // ---- Accounts Payable: Purchase Invoices (vendor bills) + vendor Credit
  // Notes. Separate from purchase_orders (a commitment, already approved on
  // its own) - a Purchase Invoice is booking what the vendor actually
  // billed, which can only ever be for quantity already received (see
  // purchase_order_line_id below, checked against poReceivedQty() at
  // booking time in routes/finance.js). Own invoice_no sequence (our
  // internal booking reference) alongside the vendor's own bill number/date,
  // which is what GST return matching actually needs. See
  // bootstrapPurchaseInvoiceApproval() for the approval chain.
  `CREATE TABLE IF NOT EXISTS purchase_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no TEXT UNIQUE,              -- our internal booking reference, e.g. PINV/2026-27/0001
    po_no TEXT,                          -- the PO group this bill is against
    vendor_id INTEGER NOT NULL REFERENCES vendors(id),
    vendor_invoice_no TEXT NOT NULL,     -- the vendor's own bill number - needed for GSTR-2B matching
    vendor_invoice_date TEXT NOT NULL,   -- date printed on the vendor's bill
    booking_date TEXT DEFAULT CURRENT_TIMESTAMP,
    vendor_gstin TEXT,
    vendor_state TEXT,
    taxable_value REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    total_value REAL DEFAULT 0,
    tds_rate REAL DEFAULT 0,
    tds_amount REAL DEFAULT 0,
    net_payable REAL DEFAULT 0,          -- total_value - tds_amount - what's actually transferred to the vendor
    status TEXT DEFAULT 'PendingApproval', -- PendingApproval, Approved, Rejected, InfoRequested, PartiallyPaid, Paid, Cancelled
    approval_id INTEGER REFERENCES approvals(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS purchase_invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
    purchase_order_line_id INTEGER REFERENCES purchase_orders(id), -- which PO line this bills against
    item_id INTEGER REFERENCES items(id),
    description TEXT NOT NULL,
    hsn_code TEXT,
    quantity REAL DEFAULT 1,
    unit TEXT DEFAULT 'Nos',
    rate REAL DEFAULT 0,
    taxable_value REAL DEFAULT 0,
    gst_rate REAL DEFAULT 18,
    sort_order INTEGER DEFAULT 0
  )`,
  // Payments themselves are NOT a column on purchase_invoices - each one is
  // its own finance_ledger row (type='PurchaseInvoice', direction='Outflow',
  // reference_id=invoice id), same ledger every other outflow already uses.
  // paid/due is always computed by summing those rows, so there's no running
  // total that can drift out of sync with the ledger.
  `CREATE TABLE IF NOT EXISTS vendor_credit_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    credit_note_no TEXT UNIQUE,          -- our internal reference
    vendor_credit_note_no TEXT,          -- the vendor's own CN number, if they gave one
    purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
    vendor_id INTEGER NOT NULL REFERENCES vendors(id),
    reason TEXT,
    taxable_value REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    total_value REAL DEFAULT 0,
    status TEXT DEFAULT 'Active',        -- Active, Cancelled
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // The original `company_address_id` only ever let a PO carry ONE of our
  // addresses, printed as a single "Our Address" box regardless of whether
  // the admin had tagged it Billing or Shipping in Company Settings - a
  // vendor PO commonly needs both, and they're often different (Head
  // Office for billing, a factory for delivery). `company_address_id` now
  // means Bill-To specifically; this new column is Ship-To. Both stay
  // optional and independent, same as the single field was before.
  `ALTER TABLE purchase_orders ADD COLUMN company_ship_address_id INTEGER REFERENCES company_addresses(id)`,
  // ---- HR: employee referral incentives + annual salary hike cycles ----
  // referred_by_employee_id/referral_incentive_amount/probation_end_date are
  // set at hire time on the Add Employee form; exit_reason/exit_recommendation
  // are set on the Edit Employee form only when status moves to
  // resigned/terminated (same optional-until-relevant pattern as the
  // pre-existing exit_date column).
  `ALTER TABLE employees ADD COLUMN referred_by_employee_id INTEGER REFERENCES employees(id)`,
  `ALTER TABLE employees ADD COLUMN referral_incentive_amount REAL DEFAULT 0`,
  `ALTER TABLE employees ADD COLUMN probation_end_date TEXT`,
  `ALTER TABLE employees ADD COLUMN exit_reason TEXT`,
  `ALTER TABLE employees ADD COLUMN exit_recommendation TEXT`,
  // One row per referred hire (not per referrer - a referrer can refer many
  // people over time, each tracked independently). Status flow:
  // PendingProbation (just hired, probation_end_date snapshotted from the
  // referred employee's own row at creation time) -> Eligible (the daily
  // scan in lib/referralIncentiveScan.js flips this once probation_end_date
  // has passed and the referred employee is still active) -> PendingApproval
  // (HR explicitly submits an Eligible row - this isn't automatic, since HR
  // should confirm the referral terms still hold before starting a payout
  // approval) -> Approved/Rejected via the generic approval engine ('HR'
  // HOD only - see bootstrapHrCompensationApprovals()) -> Paid (HR marks
  // manually with a payment reference, same explicit-payment pattern as
  // Purchase Invoice's record-payment action). Forfeited short-circuits
  // PendingProbation/Eligible/PendingApproval the moment the REFERRED
  // employee's own status is set to resigned/terminated before their
  // probation completed (routes/hr.js's employee PUT route checks this
  // inline - not left to the scan, so it's immediate, not next-scan-cycle).
  `CREATE TABLE IF NOT EXISTS referral_incentives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    referred_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
    incentive_amount REAL DEFAULT 0,
    probation_end_date TEXT,
    status TEXT DEFAULT 'PendingProbation',
    approval_id INTEGER REFERENCES approvals(id),
    payment_reference TEXT,
    paid_date TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // Permanent hike history, one row per actual raise - exists independently
  // of salary_hike_cycles so a manually-entered historical hike (from before
  // this system, backfilled via bulk-upload) and a hike produced by a Cycle
  // both live in the same place and show up identically in an employee's
  // history. cycle_id is NULL for a Manual-source row.
  `CREATE TABLE IF NOT EXISTS salary_hikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    previous_salary REAL DEFAULT 0,
    hike_type TEXT DEFAULT 'Percent',
    hike_value REAL DEFAULT 0,
    new_salary REAL DEFAULT 0,
    effective_year INTEGER,
    effective_date TEXT,
    source TEXT DEFAULT 'Manual',
    cycle_id INTEGER REFERENCES salary_hike_cycles(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // The annual planning run itself. Draft (HR builds/edits
  // salary_hike_cycle_items below) -> PendingApproval (HR submits - starts
  // the 'SalaryHikeCycle' chain, HR HOD then Management) -> Approved, at
  // which point routes/approvals.js's syncEntityStatus atomically writes one
  // salary_hikes row per item and updates each employee's monthly_salary,
  // then flips this to Applied in the same transaction -> or Rejected,
  // which (like a Purchase Request) can be edited and resubmitted rather
  // than needing a brand new cycle.
  `CREATE TABLE IF NOT EXISTS salary_hike_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_name TEXT NOT NULL,
    effective_year INTEGER,
    status TEXT DEFAULT 'Draft',
    approval_id INTEGER REFERENCES approvals(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT
  )`,
  // current_salary is a snapshot taken when the item is added/edited (not
  // read live from employees at Approved-time) so what the approver actually
  // reviewed is what gets applied, even if someone edits the employee's
  // salary elsewhere in the gap between submission and approval.
  `CREATE TABLE IF NOT EXISTS salary_hike_cycle_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL REFERENCES salary_hike_cycles(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    current_salary REAL DEFAULT 0,
    hike_type TEXT DEFAULT 'Percent',
    hike_value REAL DEFAULT 0,
    proposed_salary REAL DEFAULT 0,
    notes TEXT
  )`,
  // ---- Sales fulfillment: Sales Order line items, FG Packing/Dispatch,
  // Sale Rejection MRN, Sales Credit Notes ----
  // Sales Orders never had line items before this - a single row with
  // order_value/description. This table is purely additive: an SO with no
  // rows here keeps behaving exactly as before (manual order_value), so
  // nothing existing breaks. A new SO built with lines has its order_value
  // computed as the sum of its lines instead. item_id is optional - most
  // lines are custom-fabricated equipment, not a stocked Items Master row
  // (per the owner's own confirmation: Items Master has no Finished-Goods
  // concept), but a line selling an actual stocked/catalog item can still
  // link one.
  `CREATE TABLE IF NOT EXISTS sales_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
    item_id INTEGER REFERENCES items(id),
    description TEXT NOT NULL,
    hsn_code TEXT,
    quantity REAL DEFAULT 1,
    unit TEXT DEFAULT 'Nos',
    rate REAL DEFAULT 0,
    value REAL DEFAULT 0,
    gst_rate REAL DEFAULT 18,
    sort_order INTEGER DEFAULT 0
  )`,
  // A dispatch event against one or more sales_order_items lines - a big
  // project ships in several of these over time, each covering part of a
  // line's ordered quantity (see lib/soItems.js's soLineDispatchableQty(),
  // same "billable qty" discipline Purchase Invoices already use against PO
  // lines). Starts PendingApproval and only becomes Dispatched once BOTH
  // Accounts and Management have signed off - see
  // bootstrapSalesFulfillmentApprovals() below. payment_override_by/_note
  // record when Management pushed a dispatch through despite an unpaid
  // Pre-Dispatch proforma invoice (see routes/sales.js's dispatch hard-gate)
  // - left NULL on the normal, non-overridden path.
  `CREATE TABLE IF NOT EXISTS fg_dispatches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_no TEXT UNIQUE,
    sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
    project_id INTEGER REFERENCES projects(id),
    client_id INTEGER REFERENCES clients(id),
    dispatch_date TEXT DEFAULT CURRENT_TIMESTAMP,
    vehicle_no TEXT,
    transporter_name TEXT,
    eway_bill_no TEXT,
    sales_invoice_id INTEGER REFERENCES sales_invoices(id),
    status TEXT DEFAULT 'PendingApproval',
    approval_id INTEGER REFERENCES approvals(id),
    payment_override_by INTEGER REFERENCES users(id),
    payment_override_note TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fg_dispatch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id INTEGER NOT NULL REFERENCES fg_dispatches(id),
    sales_order_item_id INTEGER NOT NULL REFERENCES sales_order_items(id),
    quantity REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`,
  // A customer rejecting/returning goods from a SPECIFIC prior dispatch -
  // can't reject what was never dispatched, so this always points at an
  // fg_dispatch (and the specific dispatched line(s) within it, via
  // sale_rejection_mrn_items below), not the sales order in the abstract.
  // `resolution` is deliberately never set automatically on Approved - the
  // owner wants a human choice afterwards (Generate Credit Note, or Create
  // FOC Replacement Request riding the existing FOC feature's own approval
  // flow) rather than the system picking one. The linked credit note/FOC
  // request is found by querying sales_credit_notes/foc_requests for a row
  // pointing back at this mrn (derive, don't duplicate the link both ways).
  `CREATE TABLE IF NOT EXISTS sale_rejection_mrns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_no TEXT UNIQUE,
    fg_dispatch_id INTEGER NOT NULL REFERENCES fg_dispatches(id),
    sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
    project_id INTEGER REFERENCES projects(id),
    client_id INTEGER REFERENCES clients(id),
    rejection_date TEXT DEFAULT CURRENT_TIMESTAMP,
    reason TEXT,
    description TEXT,
    disposition TEXT DEFAULT 'Rework',
    resolution TEXT DEFAULT 'Unresolved',
    status TEXT DEFAULT 'PendingApproval',
    approval_id INTEGER REFERENCES approvals(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sale_rejection_mrn_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_id INTEGER NOT NULL REFERENCES sale_rejection_mrns(id),
    fg_dispatch_item_id INTEGER NOT NULL REFERENCES fg_dispatch_items(id),
    quantity_rejected REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`,
  // Customer-side mirror of vendor_credit_notes (Accounts Payable, 2026-10-02)
  // - reduces what's receivable against the original sales_invoice, same
  // shape just the other direction of the relationship. Created manually
  // from an Approved MRN (never automatically), one per MRN at most in
  // practice though nothing enforces that.
  `CREATE TABLE IF NOT EXISTS sales_credit_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    credit_note_no TEXT UNIQUE,
    sale_rejection_mrn_id INTEGER NOT NULL REFERENCES sale_rejection_mrns(id),
    sales_invoice_id INTEGER REFERENCES sales_invoices(id),
    client_id INTEGER NOT NULL REFERENCES clients(id),
    reason TEXT,
    taxable_value REAL DEFAULT 0,
    cgst REAL DEFAULT 0,
    sgst REAL DEFAULT 0,
    igst REAL DEFAULT 0,
    total_value REAL DEFAULT 0,
    status TEXT DEFAULT 'Active',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  // Traces a replacement FOC request back to the MRN that caused it - the
  // existing foc_requests table already carries everything else needed
  // (sales_order_id, project_id, reason free text), this is the one new
  // link.
  `ALTER TABLE foc_requests ADD COLUMN source_mrn_id INTEGER REFERENCES sale_rejection_mrns(id)`,
  // Purchase Order: Unit of Measurement, Discount %, and Freight (2026-10-06).
  // unit/discount_percent are genuinely per-line (same granularity as
  // hsn_code/gst_rate) - unit defaults 'Nos' to match items.unit's own
  // default. freight/freight_gst_rate are header-level (one charge for the
  // whole shipment, not per item) - duplicated onto every line sharing a
  // po_no the same way payment_terms/LD terms already are (see POST /orders
  // and PATCH /orders/:id/commercial-terms in routes/purchase.js), and added
  // once - not per line - into the PDF/Word/drilldown grand total.
  `ALTER TABLE purchase_orders ADD COLUMN unit TEXT DEFAULT 'Nos'`,
  `ALTER TABLE purchase_orders ADD COLUMN discount_percent REAL DEFAULT 0`,
  `ALTER TABLE purchase_orders ADD COLUMN freight REAL DEFAULT 0`,
  `ALTER TABLE purchase_orders ADD COLUMN freight_gst_rate REAL DEFAULT 18`,
  // Offer Templates (2026-10-06) - a Standard Template is an offer not tied
  // to any real customer, so it needs its own flag; client_id itself has to
  // become nullable too, handled separately below by
  // migrateOffersClientIdNullable() since SQLite can't ALTER a NOT NULL
  // constraint away in place.
  `ALTER TABLE offers ADD COLUMN is_template INTEGER DEFAULT 0`,
  // Purchase Request/Order "Draft before submit" + per-line Additional
  // Details (2026-10-07) - a free-text note next to the item picker, for
  // specification info (grade, size, drawing ref, ...) that doesn't fit any
  // existing column; purely optional, never validated. The Draft lifecycle
  // stage itself needs no schema change - both status columns are plain
  // TEXT with no CHECK constraint, see routes/purchase.js.
  `ALTER TABLE purchase_request_items ADD COLUMN details TEXT`,
  `ALTER TABLE purchase_orders ADD COLUMN details TEXT`,
];
for (const stmt of MIGRATIONS) {
  try { raw.exec(stmt); } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// purchase_orders.po_no was originally UNIQUE (one row = one PO = one item),
// but a multi-item PO (Round: PO multi-line items) is now several rows
// sharing one po_no by design (see routes/purchase.js's POST /orders) - the
// old UNIQUE constraint blocks exactly that. SQLite has no ALTER TABLE DROP
// CONSTRAINT, so this rebuilds the table (the standard SQLite technique for
// dropping a column constraint), preserving every existing row - guarded so
// it only ever runs once, by checking the live table's own CREATE SQL for
// the constraint before doing anything. schema.sql's own CREATE TABLE
// already omits UNIQUE, so this only fires against a database created
// before this change; a brand-new database never sees po_no as UNIQUE in
// the first place and this is a same-boot no-op for it.
function migratePurchaseOrdersDropPoNoUnique() {
  const row = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get();
  if (!row || !/po_no\s+TEXT\s+UNIQUE/i.test(row.sql)) return;
  raw.exec(`
    BEGIN;
    CREATE TABLE purchase_orders_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_no TEXT,
      purchase_request_id INTEGER REFERENCES purchase_requests(id),
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      item_id INTEGER REFERENCES items(id),
      quantity REAL NOT NULL,
      rate REAL NOT NULL,
      total_value REAL,
      status TEXT DEFAULT 'Open',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      hsn_code TEXT,
      gst_rate REAL DEFAULT 18,
      gst_amount REAL DEFAULT 0,
      terms TEXT,
      delivery_date TEXT,
      ld_percentage REAL,
      ld_cap_percentage REAL,
      ld_trigger_notes TEXT,
      purchase_request_item_id INTEGER REFERENCES purchase_request_items(id),
      company_address_id INTEGER REFERENCES company_addresses(id),
      payment_terms TEXT
    );
    INSERT INTO purchase_orders_new (id, po_no, purchase_request_id, vendor_id, item_id, quantity, rate, total_value,
      status, created_by, created_at, hsn_code, gst_rate, gst_amount, terms, delivery_date, ld_percentage,
      ld_cap_percentage, ld_trigger_notes, purchase_request_item_id, company_address_id)
    SELECT id, po_no, purchase_request_id, vendor_id, item_id, quantity, rate, total_value,
      status, created_by, created_at, hsn_code, gst_rate, gst_amount, terms, delivery_date, ld_percentage,
      ld_cap_percentage, ld_trigger_notes, purchase_request_item_id, company_address_id
    FROM purchase_orders;
    DROP TABLE purchase_orders;
    ALTER TABLE purchase_orders_new RENAME TO purchase_orders;
    COMMIT;
  `);
}
migratePurchaseOrdersDropPoNoUnique();

// user_dashboard_layout (Dashboard-only, one row per user) was generalized
// into user_page_layout (one row per user+page - see the table's own
// comment in schema.sql) so the same drag-to-reorder mechanism could extend
// to the Purchase and Store & Inventory pages. schema.sql's own CREATE
// TABLE IF NOT EXISTS above already brings a database up to the new table;
// this only needs to carry over an existing database's saved Dashboard
// layouts (as page_key='dashboard') before dropping the old table - a
// fresh database never had the old table and this is a no-op for it.
function migrateUserDashboardLayoutToPageLayout() {
  const oldTable = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_dashboard_layout'`).get();
  if (!oldTable) return;
  raw.exec(`
    INSERT INTO user_page_layout (user_id, page_key, panel_order, updated_at)
    SELECT user_id, 'dashboard', panel_order, updated_at FROM user_dashboard_layout
    WHERE true
    ON CONFLICT(user_id, page_key) DO UPDATE SET panel_order = excluded.panel_order, updated_at = excluded.updated_at;
    DROP TABLE user_dashboard_layout;
  `);
}
migrateUserDashboardLayoutToPageLayout();

// ---- Round 40: Offer immutability - child-table triggers ----
// offers' own two triggers live in schema.sql; these four child tables all
// follow the exact same shape (block UPDATE/DELETE on an existing row, and
// INSERT of a new one, once the parent offer is locked), so they're
// generated here instead of hand-repeating 12 near-identical blocks of SQL.
// Placed after the MIGRATIONS loop above (not immediately after schema.sql)
// because these triggers' bodies reference offers.locked, which the
// migration just added - CREATE TRIGGER resolves that column reference at
// creation time, so the column must already exist. Pulled out into a named,
// idempotent (CREATE TRIGGER IF NOT EXISTS) function - also called by
// migrateOffersClientIdNullable() above, which has to drop every trigger
// referencing `offers` before rebuilding that table and recreate them
// afterward in the same transaction.
const OFFER_CHILD_LOCK_TABLES = ['offer_items', 'offer_tech_specs', 'offer_bought_out_items', 'offer_terms', 'offer_equipment_references'];
function createOfferChildLockTriggers() {
  for (const table of OFFER_CHILD_LOCK_TABLES) {
    raw.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_locked_update
      BEFORE UPDATE ON ${table}
      WHEN (SELECT locked FROM offers WHERE id = OLD.offer_id) = 1
      BEGIN SELECT RAISE(ABORT, 'OFFER_LOCKED: this offer is locked and cannot be modified'); END;
    `);
    raw.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_locked_delete
      BEFORE DELETE ON ${table}
      WHEN (SELECT locked FROM offers WHERE id = OLD.offer_id) = 1
      BEGIN SELECT RAISE(ABORT, 'OFFER_LOCKED: this offer is locked and cannot be modified'); END;
    `);
    raw.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_locked_insert
      BEFORE INSERT ON ${table}
      WHEN (SELECT locked FROM offers WHERE id = NEW.offer_id) = 1
      BEGIN SELECT RAISE(ABORT, 'OFFER_LOCKED: this offer is locked and cannot be modified'); END;
    `);
  }
}
createOfferChildLockTriggers();

// offers.client_id was NOT NULL (every offer always belonged to a real
// customer) - a Standard Template (2026-10-06, see is_template above) needs
// a row that isn't tied to any customer, so this relaxes that constraint
// the same way migratePurchaseOrdersDropPoNoUnique() above relaxed po_no's
// UNIQUE constraint (SQLite has no ALTER TABLE DROP CONSTRAINT, so the
// table has to be rebuilt). Built from the live table's own PRAGMA
// table_info()/foreign_key_list() rather than a hand-transcribed column
// list - offers has picked up roughly 20 ALTER TABLE ADD COLUMNs since the
// base schema, and hand-copying them here would only need one typo to
// silently drop a column - so this reads whatever columns/foreign keys the
// table actually has right now and reproduces them exactly, just without
// NOT NULL on client_id. Guarded so it only ever fires once, against a
// database where client_id is still NOT NULL; schema.sql's own CREATE
// TABLE already omits the constraint for a brand-new database. Placed after
// createOfferChildLockTriggers() (not immediately after
// migratePurchaseOrdersDropPoNoUnique(), its closest sibling) because it
// needs that function and OFFER_CHILD_LOCK_TABLES to already exist - see
// the trigger-drop/recreate comment inside this function for why.
function migrateOffersClientIdNullable() {
  const cols = raw.prepare(`PRAGMA table_info(offers)`).all();
  const clientCol = cols.find(c => c.name === 'client_id');
  if (!clientCol || !clientCol.notnull) return;
  const fks = raw.prepare(`PRAGMA foreign_key_list(offers)`).all();
  const fkTableByColumn = new Map(fks.map(fk => [fk.from, fk.table]));
  const colDefs = cols.map(c => {
    if (c.pk) return `${c.name} INTEGER PRIMARY KEY AUTOINCREMENT`;
    let def = `${c.name} ${c.type}`;
    if (c.name !== 'client_id' && c.notnull) def += ' NOT NULL';
    if (fkTableByColumn.has(c.name)) def += ` REFERENCES ${fkTableByColumn.get(c.name)}(id)`;
    if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${c.dflt_value}`;
    return def;
  });
  const colNames = cols.map(c => c.name).join(', ');
  // The offer-immutability triggers (schema.sql's trg_offers_locked_* on
  // offers itself, plus createOfferChildLockTriggers()'s per-child-table
  // ones above) all reference `offers` in their trigger body - SQLite
  // refuses to drop/rebuild a table another trigger still references, so
  // every one of them has to be dropped first and recreated afterward, in
  // the same transaction (schema.sql's own CREATE TRIGGER IF NOT EXISTS
  // already ran once this boot before this function does, so re-running it
  // here is a safe, cheap no-op for every other statement in it - it's pure
  // DDL, no seed data).
  const dropLockTriggers = ['trg_offers_locked_update', 'trg_offers_locked_delete',
    ...OFFER_CHILD_LOCK_TABLES.flatMap(t => [`trg_${t}_locked_update`, `trg_${t}_locked_delete`, `trg_${t}_locked_insert`]),
  ].map(name => `DROP TRIGGER IF EXISTS ${name};`).join('\n    ');
  // offers has a self-referential FK (parent_offer_id REFERENCES offers(id))
  // plus every child-lock table's offer_id FK pointing at it, so the rename
  // step trips `PRAGMA foreign_keys=ON` (set globally at the top of this
  // file) even though the data itself never actually violates any
  // constraint - this is SQLite's own documented procedure for rebuilding a
  // table with foreign keys: turn enforcement off for the rebuild, verify
  // with foreign_key_check once it's back in its final shape, then turn it
  // back on. Must sit outside the BEGIN/COMMIT - this pragma is a no-op
  // inside a transaction.
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec(`
    BEGIN;
    ${dropLockTriggers}
    CREATE TABLE offers_new (${colDefs.join(',\n      ')});
    INSERT INTO offers_new (${colNames}) SELECT ${colNames} FROM offers;
    DROP TABLE offers;
    ALTER TABLE offers_new RENAME TO offers;
    COMMIT;
  `);
  const violations = raw.prepare(`PRAGMA foreign_key_check(offers)`).all();
  if (violations.length) {
    throw new Error('migrateOffersClientIdNullable: foreign_key_check failed after rebuild: ' + JSON.stringify(violations));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(schema);
  createOfferChildLockTriggers();
}
migrateOffersClientIdNullable();

// ---- Round 14: Duplicate-prevention UNIQUE indexes ----
// SQLite has no "ALTER TABLE ... ADD UNIQUE" for an existing column, so these
// are enforced as CREATE UNIQUE INDEX (idempotent via IF NOT EXISTS) rather
// than inline in schema.sql. A regular (non-partial) unique index treats
// every NULL as distinct, so optional columns that may be genuinely unset
// stay safe automatically; where the app stores an *empty string* instead of
// NULL for "not entered" (clients/vendors.gstin, service_reports.sl_no on
// legacy/never-generated rows), a partial index (`WHERE col IS NOT NULL AND
// col <> ''`) is used instead so multiple blanks don't collide.
const UNIQUE_INDEXES = [
  // A GSTIN is a government-issued tax ID - genuinely unique per legal
  // entity per state. Two different client/vendor records sharing one GSTIN
  // is always a data-entry error (duplicate master), never a legitimate
  // real-world case - unlike the name field, which two branches of the same
  // company can legitimately share.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_gstin ON clients(gstin) WHERE gstin IS NOT NULL AND gstin <> ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_vendors_gstin ON vendors(gstin) WHERE gstin IS NOT NULL AND gstin <> ''`,
  // service_reports.sl_no is the printed pad's office-copy serial, auto-
  // generated in sequence (MAX+1) the first time a report is created and
  // never edited afterwards (see routes/service.js). Concurrent saves could
  // in theory compute the same MAX+1 before either commits; this index turns
  // that race into a clean constraint failure instead of a silent duplicate
  // serial. Partial (excludes NULL/'') because Draft rows created before
  // Round 9 introduced sl_no may still have none.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_service_reports_sl_no ON service_reports(sl_no) WHERE sl_no IS NOT NULL AND sl_no <> ''`,
  // Client ID is a customer-facing reference number - genuinely unique once
  // assigned. Partial (excludes NULL) so clients created before Round 20 are
  // backfilled below without a transient collision window.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_client_code ON clients(client_code) WHERE client_code IS NOT NULL`,
  // At most one SOA settings override per client - the NULL-client_id org
  // default row is deliberately excluded (and kept singular by application
  // logic in routes/soa.js) since a partial index can't cover it the same way.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_soa_settings_client ON soa_settings(client_id) WHERE client_id IS NOT NULL`,
  // A login's email must resolve to exactly one account for password-reset
  // lookup to be unambiguous. Partial (excludes NULL/'') since most existing
  // accounts predate this column and many will never have one set.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email) WHERE email IS NOT NULL AND email <> ''`,
  // A user is granted oversight of a given other role at most once - granting
  // it again is a no-op, not a second row.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_role_oversight ON role_oversight(user_id, oversees_role_id)`,
];
for (const stmt of UNIQUE_INDEXES) {
  try { raw.exec(stmt); } catch (e) { throw e; }
}
// Plain (non-unique) lookup indexes for hot filter columns - the To-Do List's
// role-based scoping (routes/todos.js `/mine`) now filters every request by
// assigned_to and, via a join, by the hod's department, so both need to stay
// fast as the table grows rather than falling back to a full scan.
const PERFORMANCE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_todos_assigned_to ON todos(assigned_to)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_hod_id ON todos(hod_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_department_id ON users(department_id)`,
];
for (const stmt of PERFORMANCE_INDEXES) {
  try { raw.exec(stmt); } catch (e) { throw e; }
}
// Existing rows on a carried-forward DB predate the `status` column and got
// NULL from the ALTER TABLE above (not the 'Approved' default, which only
// applies to rows inserted after the column exists) - backfill them so old
// items don't silently vanish from the "approved" Item Master view.
try { raw.exec(`UPDATE items SET status = 'Approved' WHERE status IS NULL`); } catch (e) {}
// Existing salary_advances predate installment_amount - without a backfill
// they'd compute a 0 monthly due and never actually get recovered.
// Default them to "recover the whole thing in one shot", same as the old
// hardcoded behavior these replace.
try { raw.exec(`UPDATE salary_advances SET installment_amount = amount WHERE installment_amount IS NULL OR installment_amount = 0`); } catch (e) {}
// Round 5: backfill legal_name/status for vendors created before these columns existed.
try { raw.exec(`UPDATE vendors SET legal_name = name WHERE legal_name IS NULL`); } catch (e) {}
try { raw.exec(`UPDATE vendors SET status = 'Active' WHERE status IS NULL`); } catch (e) {}
try { raw.exec(`UPDATE vendors SET country = 'India' WHERE country IS NULL`); } catch (e) {}
try { raw.exec(`UPDATE purchase_orders SET gst_rate = 18 WHERE gst_rate IS NULL`); } catch (e) {}
// Round 6: leads created before stage_changed_at existed - seed it from
// created_at so "days in stage" degrades to "days since created" for them
// instead of showing garbage.
try { raw.exec(`UPDATE leads SET stage_changed_at = created_at WHERE stage_changed_at IS NULL`); } catch (e) {}
// Round 20: clients created before client_code existed - assign each one a
// stable code derived from its own id, so every client ends up with one
// without a separate running counter to maintain.
try { raw.exec(`UPDATE clients SET client_code = 'CLI-' || printf('%06d', id) WHERE client_code IS NULL`); } catch (e) {}
// Round 21: every value already typed into an offer's Application/Type of
// System/Material of Construction becomes a valid dropdown option from day
// one - no existing offer's value becomes "invalid" once these go live.
for (const col of ['application', 'type_of_system', 'material_of_construction']) {
  try {
    raw.exec(`
      INSERT OR IGNORE INTO offer_field_options (field_name, value)
      SELECT DISTINCT '${col}', ${col} FROM offers WHERE ${col} IS NOT NULL AND TRIM(${col}) <> ''
    `);
  } catch (e) {}
}

// Round 24: every pre-existing single-item purchase_requests row becomes its
// PR's first (and only) line in purchase_request_items, so nothing already
// raised loses its item/quantity/value once PRs read from the child table.
// Guarded by NOT EXISTS so this is safe to re-run on an already-migrated DB.
try {
  raw.exec(`
    INSERT INTO purchase_request_items (purchase_request_id, item_id, item_text, quantity, estimated_value, sort_order)
    SELECT pr.id, pr.item_id, pr.item_text, pr.quantity, pr.estimated_value, 0
    FROM purchase_requests pr
    WHERE NOT EXISTS (SELECT 1 FROM purchase_request_items pri WHERE pri.purchase_request_id = pr.id)
  `);
} catch (e) {}

// Backfill `sequence` for any job cards created before that column existed,
// using their insertion order (id) within each project as the sequence -
// this preserves each project's original pipeline order exactly.
raw.exec(`
  UPDATE job_cards SET sequence = (
    SELECT COUNT(*) FROM job_cards jc2 WHERE jc2.project_id = job_cards.project_id AND jc2.id <= job_cards.id
  ) WHERE sequence IS NULL
`);

// Nest pre-existing Manufacturing sub-process cards (created back when they
// were flat siblings in the top-level pipeline) under their project's
// Manufacturing job card, so older projects pick up the new two-level
// Targets-sheet / department-HOD-workbench planning model automatically.
{
  const SUB_STAGE_NAMES = ['Fitting', 'Tacking', 'Welding', 'BuffingSandblast', 'Painting'];
  const projects = raw.prepare(`
    SELECT DISTINCT project_id FROM job_cards
    WHERE stage IN (${SUB_STAGE_NAMES.map(() => '?').join(',')}) AND parent_job_card_id IS NULL
  `).all(...SUB_STAGE_NAMES);
  for (const { project_id } of projects) {
    const parent = raw.prepare(`SELECT id FROM job_cards WHERE project_id = ? AND stage = 'Manufacturing'`).get(project_id);
    if (!parent) continue;
    const children = raw.prepare(`
      SELECT id FROM job_cards WHERE project_id = ? AND stage IN (${SUB_STAGE_NAMES.map(() => '?').join(',')}) AND parent_job_card_id IS NULL
      ORDER BY sequence, id
    `).all(project_id, ...SUB_STAGE_NAMES);
    children.forEach((c, i) => {
      raw.prepare(`UPDATE job_cards SET parent_job_card_id = ?, sequence = ? WHERE id = ?`).run(parent.id, i + 1, c.id);
    });
    // renumber the remaining top-level cards for this project contiguously
    const topLevel = raw.prepare(`
      SELECT id FROM job_cards WHERE project_id = ? AND parent_job_card_id IS NULL ORDER BY sequence, id
    `).all(project_id);
    topLevel.forEach((c, i) => {
      raw.prepare(`UPDATE job_cards SET sequence = ? WHERE id = ?`).run(i + 1, c.id);
    });
  }
}

// Round 40: offer_options.manage (Section Title library images/descriptions,
// dropdown field options) used to be granted to Sales, letting a non-admin
// edit master template controls - db/seed.js only runs on a brand-new
// database, so a carried-forward DB needs this explicit one-time revoke to
// actually lose the grant. Deleting an already-absent row is a harmless
// no-op, so this is safe to run on every boot.
try {
  raw.exec(`
    DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = 'Sales')
      AND permission_id = (SELECT id FROM permissions WHERE code = 'offer_options.manage')
  `);
} catch (e) {}

// Operating Expenses category list default values - self-contained (no
// role/permission dependency, unlike the Foreign Payments bootstrap below),
// so this is safe to seed directly here on every boot. INSERT OR IGNORE
// against the UNIQUE(name) means an Admin's own additions/renames/removals
// afterwards are never stomped on a later boot.
try {
  const insertOeCat = raw.prepare(`INSERT OR IGNORE INTO operating_expense_categories (name, sort_order) VALUES (?, ?)`);
  [
    'Conv & Maint', 'Courier & Freight', 'Construction Work', 'Crane Charges', 'Daily Labour / Wages',
    'Diesel', 'Loan & Advance', 'Mask & Sanitisation', 'Misc Exp. (Non-Regular)', 'Mobile Exp',
    'Consumable Items', 'Office Exp.', 'Printing & Stationery', 'Repair & Maintenance', 'Stamping Charges',
    'Sweeper', 'Tour Exp', 'Water Tank', 'Weighing Exp', "Worker's Welfare",
    // Folded in from the Monthly Expense Tracker's "Fixed & Overhead
    // Expenses" section (Round: Expense Tracker consolidation) - same 25
    // names db/seed.js originally seeded as expense_tracker_categories'
    // kind='Fixed' rows, now living in this one unified list instead.
    'Salary (VE) - Axis', 'Salary (VE) - Cash', 'OT (VE)', 'Salary - Others', 'PF (VE)', 'ESIC (VE)',
    'Electricity - Plot 222', 'Electricity - Plot 221', 'Electricity - Plot 219', 'Electricity - Plot 217',
    'Electricity - Plot 123-124', 'Electricity - Plot 213', 'Electricity - Plot 23', 'Misc Basket Exp.',
    'Mediclaim & Other Policies', 'Holi', 'Diwali', 'Sri Vishwakarma Pooja', 'New Year', 'LTA',
    'Miryalguda Office', 'Karimnagar Office', 'Factory Anniversary', 'Rent - Plot 218', 'Rent - Plot 219',
    'Sand Blasting',
  ].forEach((name, i) => insertOeCat.run(name, i));
} catch (e) { console.error('[db] Operating Expense categories seed failed:', e.message); }

// One-time historical migration: every existing Monthly Expense Tracker
// entry becomes a real Operating Expense transaction, so Operating
// Expenses becomes the single continuous record (old + new) once the
// Expense Tracker pages are retired - see the settings flag guard below,
// which makes this run exactly once ever, regardless of how many times
// the server boots afterward. Never touches/deletes the source tables
// (expense_tracker_entries/_categories) - they stay exactly as they were,
// just no longer written to going forward.
try {
  const MIGRATION_FLAG = 'expense_tracker_migrated_to_operating_expenses';
  const alreadyMigrated = raw.prepare(`SELECT value FROM settings WHERE key = ?`).get(MIGRATION_FLAG);
  if (!alreadyMigrated) {
    const entries = raw.prepare(`
      SELECT e.entry_date, e.amount, e.notes, e.created_by, c.name as category_name
      FROM expense_tracker_entries e JOIN expense_tracker_categories c ON c.id = e.category_id
    `).all();
    const insertOe = raw.prepare(`
      INSERT INTO operating_expenses (expense_date, category, description, amount, paid_via, created_by)
      VALUES (?, ?, ?, ?, 'Bank', ?)
    `);
    entries.forEach(e => {
      const description = e.notes ? `${e.notes} (Migrated from Monthly Expense Tracker)` : 'Migrated from Monthly Expense Tracker';
      insertOe.run(e.entry_date, e.category_name, description, e.amount, e.created_by);
    });
    raw.prepare(`INSERT INTO settings (key, value) VALUES (?, 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'`).run(MIGRATION_FLAG);
    if (entries.length) console.log(`[db] Migrated ${entries.length} Monthly Expense Tracker entries into Operating Expenses.`);
  }
} catch (e) { console.error('[db] Expense Tracker -> Operating Expenses migration failed:', e.message); }

// Thin wrapper so the rest of the app can keep using the better-sqlite3-style
// db.prepare(sql).run/get/all(...) API, plus a db.transaction(fn) helper
// (node:sqlite's DatabaseSync has no built-in transaction wrapper).
// node:sqlite (unlike better-sqlite3) throws if a bound parameter is
// `undefined` instead of `null` - which happens whenever an optional field
// is omitted from a request body. Sanitize on every call so route code
// doesn't need to remember `|| null` everywhere.
function sanitize(args) {
  return args.map(a => (a === undefined ? null : a));
}

function wrapStatement(stmt) {
  return {
    run: (...args) => stmt.run(...sanitize(args)),
    get: (...args) => stmt.get(...sanitize(args)),
    all: (...args) => stmt.all(...sanitize(args)),
  };
}

const db = {
  raw,
  prepare(sql) {
    return wrapStatement(raw.prepare(sql));
  },
  exec(sql) {
    return raw.exec(sql);
  },
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    };
  }
};

// Foreign Payments module: db/seed.js only runs on a brand-new database, so
// a carried-forward one needs this explicit bootstrap for the new permission
// code, its grant to Accounts (the role that already owns bg.manage/
// payment_receipt.manage/soa.manage - the same finance-ops role), and the
// 'ForeignPayment' approval chain (Accounts signs off any amount; above
// 500000 [INR-equivalent] Management also has to) - all guarded by
// INSERT OR IGNORE / ON CONFLICT so re-running this on every boot is safe,
// and an Admin can still retune the chain afterwards from the Approval
// Matrix page without this stomping their changes on the next boot.
// Must run AFTER db/seed.js on a brand-new database (roles/permissions don't
// exist yet at require('./db') time), so server.js calls this itself right
// after its own isNew-gated seed step, on every boot either way.
function bootstrapForeignPayments() {
  try {
    raw.exec(`INSERT OR IGNORE INTO permissions (code) VALUES ('foreign_payment.manage')`);
    raw.exec(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT (SELECT id FROM roles WHERE name = 'Accounts'), (SELECT id FROM permissions WHERE code = 'foreign_payment.manage')
    `);
    raw.exec(`INSERT OR IGNORE INTO approval_chains (name, description) VALUES ('ForeignPayment', 'Foreign advance remittance approval')`);
    const chainId = raw.prepare(`SELECT id FROM approval_chains WHERE name = 'ForeignPayment'`).get().id;
    const accountsRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Accounts'`).get()?.id;
    const managementRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Management'`).get()?.id;
    const upsertFpStep = raw.prepare(`
      INSERT INTO approval_chain_steps (chain_id, step_order, approver_role_id, min_amount, requires_supervisor)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(chain_id, step_order) DO NOTHING
    `);
    if (accountsRoleId) upsertFpStep.run(chainId, 1, accountsRoleId, 0);
    if (managementRoleId) upsertFpStep.run(chainId, 2, managementRoleId, 500000);
  } catch (e) { console.error('[db] Foreign Payments bootstrap failed:', e.message); }
}

// Defensive re-grant: 'Accounts' owning 'bg.manage' has been in db/seed.js
// since this repo's very first commit, so a database seeded from this
// codebase already has the role_permissions row - but a database migrated
// in from an older/external system (this app's own README/prior work
// describes bulk-migrated legacy Bank Guarantee records) may have had its
// Accounts role and permission rows created some other way, without this
// specific grant ever being applied. Cheap and idempotent (INSERT OR
// IGNORE) to just re-assert it on every boot rather than rely on trusting
// how a given production database originally came to exist. Same ordering
// requirement as bootstrapForeignPayments() above: must run AFTER
// db/seed.js on a brand-new database, so server.js calls it right after
// its own isNew-gated seed step.
function bootstrapBgManageGrant() {
  try {
    raw.exec(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT (SELECT id FROM roles WHERE name = 'Accounts'), (SELECT id FROM permissions WHERE code = 'bg.manage')
      WHERE (SELECT id FROM roles WHERE name = 'Accounts') IS NOT NULL
        AND (SELECT id FROM permissions WHERE code = 'bg.manage') IS NOT NULL
    `);
  } catch (e) { console.error('[db] bg.manage grant backfill failed:', e.message); }
}

// Purchase Order approval gate: every PO now needs the Purchase department's
// own HOD to sign off (step 1, always required - there's no separate
// "Purchase HOD" role, just a Purchase-role user flagged is_supervisor=1,
// same model every other HOD check in this app already uses), then
// Management above a value threshold (step 2) that an Admin can retune any
// time from the Approval Matrix page - this bootstrap only ever sets the
// *default* (Rs 50,000, same default PurchaseRequest's own Management step
// already uses) and never overwrites it once the chain exists, same
// ON CONFLICT DO NOTHING guarantee bootstrapForeignPayments() relies on.
// Same ordering requirement as the bootstraps above: must run AFTER
// db/seed.js on a brand-new database, so server.js calls it right after its
// own isNew-gated seed step - and safe to re-run on every boot either way.
function bootstrapPurchaseOrderApproval() {
  try {
    raw.exec(`INSERT OR IGNORE INTO approval_chains (name, description) VALUES ('PurchaseOrder', 'Purchase order approval (Purchase HOD -> Management)')`);
    const chainId = raw.prepare(`SELECT id FROM approval_chains WHERE name = 'PurchaseOrder'`).get().id;
    const purchaseRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Purchase'`).get()?.id;
    const managementRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Management'`).get()?.id;
    const upsertPoStep = raw.prepare(`
      INSERT INTO approval_chain_steps (chain_id, step_order, approver_role_id, min_amount, requires_supervisor)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, step_order) DO NOTHING
    `);
    if (purchaseRoleId) upsertPoStep.run(chainId, 1, purchaseRoleId, 0, 1);
    if (managementRoleId) upsertPoStep.run(chainId, 2, managementRoleId, 50000, 0);
  } catch (e) { console.error('[db] Purchase Order approval bootstrap failed:', e.message); }
}

// Creator-vs-approver PR/PO edit gating (2026-10-07, routes/purchase.js's
// isPurchaseApprover()) lets Management keep editing a PO/PR once it's
// approved, but that check only runs INSIDE the route handlers - which sit
// behind requirePermission('purchase_order.manage')/('purchase_request.create',
// ...) at the router level. Management was never granted either permission
// (only the Purchase role was, in db/seed.js), so the route-level gate
// rejected Management before the new in-route logic could even run -
// the exact same "correct application-code check, unreachable because the
// route-level permission gate stands in front of it" bug already hit and
// fixed once for Accounts/bg.manage (bootstrapBgManageGrant()) and again for
// Management/sales_order.manage (bootstrapSalesFulfillmentApprovals()).
// Idempotent INSERT OR IGNORE, same pattern as both of those.
function bootstrapPurchaseApproverGrants() {
  try {
    const managementRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Management'`).get()?.id;
    if (!managementRoleId) return;
    raw.exec(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT ${managementRoleId}, id FROM permissions WHERE code IN ('purchase_order.manage', 'purchase_request.create')
    `);
  } catch (e) { console.error('[db] Purchase approver permission grant backfill failed:', e.message); }
}

// Accounts Payable: booking a Purchase Invoice (vendor bill) starts this
// chain immediately, same shape as ExpenseVoucher - step 1 is the Accounts
// department's own HOD (always required), step 2 is Management above a
// value threshold (default Rs 50,000, admin-editable from the Approval
// Matrix page, same as every other chain). Only once Approved can a payment
// actually be recorded against the invoice - this is how "payment needs
// sign-off" is enforced, without a second approval cycle per payment
// instalment. Same idempotent INSERT OR IGNORE / ON CONFLICT DO NOTHING
// guarantee as the other bootstraps - safe on every boot.
function bootstrapPurchaseInvoiceApproval() {
  try {
    raw.exec(`INSERT OR IGNORE INTO permissions (code) VALUES ('purchase_invoice.manage')`);
    raw.exec(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT (SELECT id FROM roles WHERE name = 'Accounts'), (SELECT id FROM permissions WHERE code = 'purchase_invoice.manage')
      WHERE (SELECT id FROM roles WHERE name = 'Accounts') IS NOT NULL
        AND (SELECT id FROM permissions WHERE code = 'purchase_invoice.manage') IS NOT NULL
    `);
    raw.exec(`INSERT OR IGNORE INTO approval_chains (name, description) VALUES ('PurchaseInvoice', 'Vendor bill payment approval (Accounts HOD -> Management)')`);
    const chainId = raw.prepare(`SELECT id FROM approval_chains WHERE name = 'PurchaseInvoice'`).get().id;
    const accountsRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Accounts'`).get()?.id;
    const managementRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Management'`).get()?.id;
    const upsertPiStep = raw.prepare(`
      INSERT INTO approval_chain_steps (chain_id, step_order, approver_role_id, min_amount, requires_supervisor)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, step_order) DO NOTHING
    `);
    if (accountsRoleId) upsertPiStep.run(chainId, 1, accountsRoleId, 0, 1);
    if (managementRoleId) upsertPiStep.run(chainId, 2, managementRoleId, 50000, 0);
  } catch (e) { console.error('[db] Purchase Invoice approval bootstrap failed:', e.message); }
}

// Referral incentive payouts and annual salary hike cycles both route
// through the HR department's own HOD first (role 'HR' + requires_supervisor
// = 1, same is_supervisor-flag HOD model every other chain in this app uses)
// - HR already owns and builds both of these (same as how Accounts owns and
// books every Purchase Invoice), so "HOD" here means HR's HOD specifically,
// not each individual employee's own department HOD (this codebase's
// existing cross-department chains - ExpenseVoucher/Leave/PurchaseInvoice -
// all route to one fixed owning department's HOD, never to "whichever
// department the entity happens to belong to"; a per-raiser-department HOD
// step isn't something the generic engine supports, and would be a much
// larger change to lib/approvals.js's role-based canAct() for comparatively
// little benefit here). ReferralIncentive is a single step (a referral
// payout is a modest, routine amount) - SalaryHikeCycle adds a Management
// step after, unconditionally (min_amount 0, not value-gated like
// PurchaseOrder/PurchaseInvoice's step 2) since an annual compensation
// decision affects the whole org regardless of its total value. Same
// idempotent INSERT OR IGNORE / ON CONFLICT DO NOTHING guarantee as every
// other bootstrap here - safe on every boot, never overwrites an
// admin-retuned step once the chain exists.
function bootstrapHrCompensationApprovals() {
  try {
    const hrRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'HR'`).get()?.id;
    const managementRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Management'`).get()?.id;
    const upsertStep = raw.prepare(`
      INSERT INTO approval_chain_steps (chain_id, step_order, approver_role_id, min_amount, requires_supervisor)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, step_order) DO NOTHING
    `);

    raw.exec(`INSERT OR IGNORE INTO approval_chains (name, description) VALUES ('ReferralIncentive', 'Employee referral incentive payout approval (HR HOD)')`);
    const riChainId = raw.prepare(`SELECT id FROM approval_chains WHERE name = 'ReferralIncentive'`).get().id;
    if (hrRoleId) upsertStep.run(riChainId, 1, hrRoleId, 0, 1);

    raw.exec(`INSERT OR IGNORE INTO approval_chains (name, description) VALUES ('SalaryHikeCycle', 'Annual salary hike cycle approval (HR HOD -> Management)')`);
    const shChainId = raw.prepare(`SELECT id FROM approval_chains WHERE name = 'SalaryHikeCycle'`).get().id;
    if (hrRoleId) upsertStep.run(shChainId, 1, hrRoleId, 0, 1);
    if (managementRoleId) upsertStep.run(shChainId, 2, managementRoleId, 0, 0);
  } catch (e) { console.error('[db] HR compensation approval bootstrap failed:', e.message); }
}

// FG Dispatch and Sale Rejection MRN (Phases E/D, 2026-10). Dispatch is a
// two-step chain, Accounts then Management, BOTH always required
// (min_amount 0 - goods physically leaving the building isn't a
// value-threshold policy the way PO/PI's step 2 is). The hard block for an
// unpaid Pre-Dispatch proforma invoice lives in routes/sales.js's dispatch
// creation route itself, not in this chain - by the time a dispatch reaches
// this approval, payment is either already confirmed or was explicitly
// overridden by Management, so these two steps are a normal "does this
// shipment look right" sign-off, not a second payment check.
// SaleRejectionMRN is a single step, the Sales department's own HOD - the
// rejection record itself isn't a financial release event (unlike its two
// optional follow-ups, Credit Note / FOC Replacement, which ride their own
// existing gates - see db/index.js's sales_credit_notes/foc_requests
// comments). Same idempotent bootstrap guarantee as every chain above.
function bootstrapSalesFulfillmentApprovals() {
  try {
    const accountsRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Accounts'`).get()?.id;
    const managementRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Management'`).get()?.id;
    const salesRoleId = raw.prepare(`SELECT id FROM roles WHERE name = 'Sales'`).get()?.id;
    // Management needs to actually be able to raise a dispatch to exercise
    // the owner-confirmed "unpaid Pre-Dispatch proforma override" on
    // POST /sales/dispatches - that route is gated by sales_order.manage
    // like every other Sales Order route, and Management doesn't carry it
    // by default (same gap bootstrapBgManageGrant() fixed for Accounts/
    // bg.manage). Idempotent, same as every grant in this app.
    if (managementRoleId) {
      raw.exec(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
        SELECT ${managementRoleId}, id FROM permissions WHERE code = 'sales_order.manage'
      `);
    }
    const upsertStep = raw.prepare(`
      INSERT INTO approval_chain_steps (chain_id, step_order, approver_role_id, min_amount, requires_supervisor)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, step_order) DO NOTHING
    `);

    raw.exec(`INSERT OR IGNORE INTO approval_chains (name, description) VALUES ('FgDispatch', 'Finished goods dispatch approval (Accounts -> Management)')`);
    const fgChainId = raw.prepare(`SELECT id FROM approval_chains WHERE name = 'FgDispatch'`).get().id;
    if (accountsRoleId) upsertStep.run(fgChainId, 1, accountsRoleId, 0, 1);
    if (managementRoleId) upsertStep.run(fgChainId, 2, managementRoleId, 0, 0);

    raw.exec(`INSERT OR IGNORE INTO approval_chains (name, description) VALUES ('SaleRejectionMRN', 'Customer goods rejection/return approval (Sales HOD)')`);
    const mrnChainId = raw.prepare(`SELECT id FROM approval_chains WHERE name = 'SaleRejectionMRN'`).get().id;
    if (salesRoleId) upsertStep.run(mrnChainId, 1, salesRoleId, 0, 1);
  } catch (e) { console.error('[db] Sales fulfillment approval bootstrap failed:', e.message); }
}

// One-time (but safe to re-run every boot) data repair: PUT /employees/:id
// used to write `monthly_salary`/`referral_incentive_amount` straight
// through from the request body without the same `|| 0` fallback
// POST /employees already applied, so saving the Edit Employee form with
// either field left blank (e.g. opening Edit on a row whose value was NULL,
// which a `type="number"` input renders as empty) sent an empty string -
// not a well-formed numeric literal, so SQLite's REAL-affinity conversion
// left it stored as literal TEXT ''. A single such row then poisoned any
// JS `reduce((s, v) => s + v, 0)` over the column (e.g. the Salary Report's
// department totals - `number + '' ` silently becomes string concatenation,
// not addition, visible in the UI as an absurd digit-string total).
// Both write sites are now fixed to never write that, but any row already
// corrupted on an existing database needs fixing too - `typeof(col) = 'text'`
// only ever matches a non-numeric value like this (a real number stored in
// a REAL-affinity column always reads back as 'integer'/'real'), so this
// can't touch a legitimate figure. Reset to 0, the same fallback the write
// paths themselves use for "no value given".
function repairCorruptedEmployeeNumericFields() {
  try {
    raw.exec(`UPDATE employees SET monthly_salary = 0 WHERE typeof(monthly_salary) IN ('text', 'blob')`);
    raw.exec(`UPDATE employees SET referral_incentive_amount = 0 WHERE typeof(referral_incentive_amount) IN ('text', 'blob')`);
  } catch (e) { console.error('[db] employee numeric-field repair failed:', e.message); }
}

module.exports = {
  db, isNew, dataDir, dbPath, bootstrapForeignPayments, bootstrapBgManageGrant,
  bootstrapPurchaseOrderApproval, bootstrapPurchaseInvoiceApproval, bootstrapHrCompensationApprovals,
  bootstrapSalesFulfillmentApprovals, bootstrapPurchaseApproverGrants, repairCorruptedEmployeeNumericFields,
};

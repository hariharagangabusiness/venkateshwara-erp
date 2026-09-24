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
];
for (const stmt of MIGRATIONS) {
  try { raw.exec(stmt); } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// ---- Round 40: Offer immutability - child-table triggers ----
// offers' own two triggers live in schema.sql; these four child tables all
// follow the exact same shape (block UPDATE/DELETE on an existing row, and
// INSERT of a new one, once the parent offer is locked), so they're
// generated here instead of hand-repeating 12 near-identical blocks of SQL.
// Placed after the MIGRATIONS loop above (not immediately after schema.sql)
// because these triggers' bodies reference offers.locked, which the
// migration just added - CREATE TRIGGER resolves that column reference at
// creation time, so the column must already exist.
for (const table of ['offer_items', 'offer_tech_specs', 'offer_bought_out_items', 'offer_terms']) {
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
  ].forEach((name, i) => insertOeCat.run(name, i));
} catch (e) { console.error('[db] Operating Expense categories seed failed:', e.message); }

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

module.exports = { db, isNew, dataDir, dbPath, bootstrapForeignPayments };

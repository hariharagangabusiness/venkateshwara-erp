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
];
for (const stmt of MIGRATIONS) {
  try { raw.exec(stmt); } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
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
];
for (const stmt of UNIQUE_INDEXES) {
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

module.exports = { db, isNew };

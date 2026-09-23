-- Venkateshwara Engineers ERP schema

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,          -- e.g. Admin, Marketing, Sales, Design, Purchase, Store, LaserBending, Manufacturing, Assembling, Packing, Shipping, Installation, Service, PM, HR, Accounts
  description TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL           -- e.g. 'purchase.create', 'payroll.approve', 'expense.view'
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id),
  permission_id INTEGER NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_code TEXT UNIQUE,
  full_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  designation TEXT,
  date_of_joining TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  bank_account TEXT,
  monthly_salary REAL DEFAULT 0,
  status TEXT DEFAULT 'active',       -- active, resigned, terminated
  reporting_manager_id INTEGER REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  employee_id INTEGER REFERENCES employees(id),
  department_id INTEGER REFERENCES departments(id),
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== ATTENDANCE / LEAVE / PAYROLL =====================

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  status TEXT NOT NULL,               -- Present, Absent, HalfDay, Leave, Holiday, WeekOff
  check_in TEXT,
  check_out TEXT,
  remarks TEXT,
  UNIQUE(employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,          -- Casual, Sick, Earned, Unpaid
  annual_quota REAL DEFAULT 0
);

-- Per-employee, per-year leave balance. A row here overrides that leave
-- type's default annual_quota for that employee/year (e.g. a part-timer, or
-- a manually corrected balance); if no row exists, the balance is computed
-- from the leave type's default quota (pro-rated for probation - see
-- leave_types.probation_months) minus approved leave_requests for that year.
CREATE TABLE IF NOT EXISTS employee_leave_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  year INTEGER NOT NULL,
  allocated REAL DEFAULT 0,
  UNIQUE(employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'Pending',      -- Pending, Approved, Rejected
  approval_id INTEGER REFERENCES approvals(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS salary_advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount REAL NOT NULL,
  request_date TEXT DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  status TEXT DEFAULT 'Pending',
  approval_id INTEGER REFERENCES approvals(id),
  recovered_amount REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS salary_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,                -- 'YYYY-MM'
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  basic REAL DEFAULT 0,
  allowances REAL DEFAULT 0,
  deductions REAL DEFAULT 0,
  advance_deduction REAL DEFAULT 0,
  days_present REAL DEFAULT 0,
  gross REAL DEFAULT 0,
  net_pay REAL DEFAULT 0,
  status TEXT DEFAULT 'Draft',        -- Draft, Approved, Paid
  approval_id INTEGER REFERENCES approvals(id),
  paid_on TEXT,
  UNIQUE(month, employee_id)
);

CREATE TABLE IF NOT EXISTS payroll_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  amount REAL NOT NULL,
  voucher_type TEXT DEFAULT 'Salary', -- Salary, Advance, Reimbursement
  cash_or_bank TEXT DEFAULT 'Bank',   -- Cash, Bank
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== EXPENSES / VOUCHERS =====================

CREATE TABLE IF NOT EXISTS expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL           -- Travel, Freight, Office, Utilities, Raw Material, Repairs, Misc...
);

CREATE TABLE IF NOT EXISTS expense_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no TEXT UNIQUE,
  voucher_date TEXT DEFAULT CURRENT_TIMESTAMP,
  department_id INTEGER REFERENCES departments(id),
  category_id INTEGER REFERENCES expense_categories(id),
  raised_by INTEGER REFERENCES users(id),
  amount REAL NOT NULL,
  payment_mode TEXT NOT NULL,         -- Cash, Bank
  accounted TEXT NOT NULL DEFAULT 'Accounted',  -- Accounted, Cash(Unaccounted)
  description TEXT,
  attachment_path TEXT,
  status TEXT DEFAULT 'Pending',      -- Pending, Approved, Rejected, Paid
  approval_id INTEGER REFERENCES approvals(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== MONTHLY EXPENSE TRACKER (Round 11) =====================
-- Replaces the team's "quick view" Excel: a fast day-wise grid for
-- operational spend (Conveyance, Freight, Diesel, Tour, etc.) plus a
-- once-a-month lump sum for fixed/overhead items (Salary, PF, ESIC,
-- Electricity by meter, Rent by plot, festival allowances). Distinct from
-- expense_vouchers above, which is a per-transaction approval workflow -
-- this is a lightweight rollup entered directly by Accounts/HR for
-- management visibility, no approval chain.
CREATE TABLE IF NOT EXISTS expense_tracker_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Daily',   -- 'Daily' (day-wise grid) or 'Fixed' (one amount per month)
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expense_tracker_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES expense_tracker_categories(id),
  entry_date TEXT NOT NULL,             -- Daily: the actual date; Fixed: the 1st of that month
  amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(category_id, entry_date)
);

-- ===================== SITE VISIT TRACKER (Round 12) =====================
-- Replaces the team's "SITE STATUS" Excel tab: site installation/service
-- visits that can run for days or weeks, with multiple engineers on one
-- visit at once, and status buckets matching the sheet's own layout
-- (Pending -> Working -> Hold/Closed). Distinct from Service Requests
-- (routes/service.js), which is a single-engineer, single-visit workflow
-- that closes with a formal report - this stays open and editable for as
-- long as the visit runs, the way the team actually uses it day to day.
CREATE TABLE IF NOT EXISTS site_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),     -- optional link to a known client
  project_id INTEGER REFERENCES projects(id),   -- optional link to a known project
  purpose TEXT,                                 -- 'Purpose of Visit' / 'Pending Works' on the sheet
  status TEXT NOT NULL DEFAULT 'Pending',       -- Pending, Working, Hold, Closed
  arrival_date TEXT,
  close_date TEXT,
  expenses_note TEXT,                           -- free-text running note, e.g. "All expenses in customer scope"
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_visit_engineers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_visit_id INTEGER NOT NULL REFERENCES site_visits(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  UNIQUE(site_visit_id, employee_id)
);

-- ===================== DAILY WORK LOG (Round 12) =====================
-- Replaces the team's "DAILY WORK" Excel tab: one free-text cell per
-- engineer per day (a job description, or shorthand like "OD"/"A"/"1\2"
-- exactly as the team already types it) - a daily roll-call of who's doing
-- what, independent of the structured job-card timestamps elsewhere.
CREATE TABLE IF NOT EXISTS daily_work_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  log_date TEXT NOT NULL,
  note TEXT,
  site_visit_id INTEGER REFERENCES site_visits(id),  -- optional link when the note is about a tracked site visit
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(employee_id, log_date)
);

-- ===================== APPROVAL ENGINE (generic, reusable) =====================

CREATE TABLE IF NOT EXISTS approval_chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,          -- e.g. 'ExpenseVoucher', 'Leave', 'Purchase', 'Payroll'
  description TEXT
);

CREATE TABLE IF NOT EXISTS approval_chain_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL REFERENCES approval_chains(id),
  step_order INTEGER NOT NULL,
  approver_role_id INTEGER NOT NULL REFERENCES roles(id),
  min_amount REAL DEFAULT 0,          -- step only applies if request amount >= this (0 = always)
  UNIQUE(chain_id, step_order)
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL REFERENCES approval_chains(id),
  entity_type TEXT NOT NULL,          -- 'expense_voucher','leave_request','purchase_order','salary_advance','salary_schedule'
  entity_id INTEGER NOT NULL,
  amount REAL DEFAULT 0,
  current_step INTEGER DEFAULT 1,
  status TEXT DEFAULT 'Pending',      -- Pending, Approved, Rejected
  requested_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approval_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL REFERENCES approvals(id),
  step_order INTEGER NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,               -- Approved, Rejected
  comment TEXT,
  acted_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== CLIENTS / VENDORS =====================

-- name is deliberately NOT unique - two branches of the same real-world
-- company are a legitimate case. gstin IS unique (a government-issued tax
-- ID can't genuinely repeat across two different clients) - enforced via a
-- partial UNIQUE index (ux_clients_gstin) in db/index.js rather than inline
-- here, since it must exclude NULL/blank to allow multiple clients with no
-- GSTIN on file.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  gstin TEXT,
  source TEXT                         -- lead source
);

-- Same reasoning as clients above: name not unique (legitimate duplicate
-- branches), gstin unique via partial index ux_vendors_gstin in db/index.js.
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  gstin TEXT,
  category TEXT                       -- raw material, spares, services...
);

-- ===================== MARKETING / SALES =====================

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id),
  enquiry_details TEXT,
  product_interest TEXT,              -- weighing / bagging / material handling
  stage TEXT DEFAULT 'New',           -- New, Quoted, Negotiation, Won, Lost
  owner_id INTEGER REFERENCES users(id),
  expected_value REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE,
  lead_id INTEGER REFERENCES leads(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  order_date TEXT DEFAULT CURRENT_TIMESTAMP,
  description TEXT,
  order_value REAL,
  status TEXT DEFAULT 'Confirmed',    -- Confirmed, InProduction, Completed, Cancelled
  created_by INTEGER REFERENCES users(id)
);

-- ===================== PROJECT MANAGEMENT (job pipeline across depts) =====================

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_code TEXT UNIQUE,
  sales_order_id INTEGER REFERENCES sales_orders(id),
  title TEXT NOT NULL,
  pm_id INTEGER REFERENCES users(id),
  start_date TEXT,
  target_date TEXT,
  status TEXT DEFAULT 'Planning',     -- Planning, Design, Purchase, Production, Assembly, Packing, Shipping, Installation, Completed, OnHold
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Generic stage-tracking table used by Design, Purchase, Store, Laser&Bending,
-- Manufacturing, Assembling, Packing, Shipping, Installation, Service&Spare
CREATE TABLE IF NOT EXISTS job_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  stage TEXT NOT NULL,                -- Design, Purchase, Store, LaserBending, Manufacturing, Assembling, Packing, Shipping, Installation, Service
  assigned_to INTEGER REFERENCES users(id),
  department_id INTEGER REFERENCES departments(id),
  status TEXT DEFAULT 'Pending',      -- Pending, InProgress, Completed, OnHold, Rejected
  notes TEXT,
  started_at TEXT,
  completed_at TEXT,
  allocated_at TEXT,                  -- when assigned_to was last (re)set
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Files attached to a job card (any level - top-level department, HOD
-- sub-assembly, or a routed hand-off card) as a project moves through
-- production - drawings, BOM sheets, cut files, photos, etc.
CREATE TABLE IF NOT EXISTS job_card_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- A running comment/handover trail on a job card - notes passed between
-- team members, supervisor, and the next department.
CREATE TABLE IF NOT EXISTS job_card_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  user_id INTEGER REFERENCES users(id),
  comment TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Explicit hand-off links for work that fans out to more than one
-- downstream department at once (e.g. Design finishing releases BOM details
-- to Purchase, cut/bend files to Laser & Bending, and sub-assembly drawings
-- to Electrical, all in parallel - not a single linear "next stage"). A
-- dependent card is released (gets an auto planned_start) once every one of
-- its dependencies is Completed.
CREATE TABLE IF NOT EXISTS job_card_dependencies (
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  depends_on_id INTEGER NOT NULL REFERENCES job_cards(id),
  PRIMARY KEY (job_card_id, depends_on_id)
);

-- ===================== PURCHASE / STORE / INVENTORY =====================

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT UNIQUE,
  name TEXT NOT NULL,
  unit TEXT DEFAULT 'Nos',
  category TEXT,
  reorder_level REAL DEFAULT 0,
  current_stock REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_no TEXT UNIQUE,
  project_id INTEGER REFERENCES projects(id),
  raised_by INTEGER REFERENCES users(id),
  item_id INTEGER REFERENCES items(id),
  quantity REAL NOT NULL,
  estimated_value REAL,
  status TEXT DEFAULT 'Pending',      -- Pending, Approved, OrderPlaced, Received, Rejected
  approval_id INTEGER REFERENCES approvals(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT UNIQUE,
  purchase_request_id INTEGER REFERENCES purchase_requests(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  item_id INTEGER REFERENCES items(id),
  quantity REAL NOT NULL,
  rate REAL NOT NULL,
  total_value REAL,
  status TEXT DEFAULT 'Open',         -- Open, PartiallyReceived, Received, Closed, Cancelled
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  movement_type TEXT NOT NULL,        -- IN (GRN), OUT (Issue to production), ADJUST
  quantity REAL NOT NULL,
  reference TEXT,                     -- PO no / project code
  project_id INTEGER REFERENCES projects(id),
  moved_by INTEGER REFERENCES users(id),
  moved_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== SERVICE & SPARE PARTS =====================

CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sr_no TEXT UNIQUE,
  client_id INTEGER REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id),
  issue_description TEXT,
  spare_parts_needed TEXT,
  assigned_to INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'Open',         -- Open, InProgress, PartsOrdered, Resolved, Closed
  job_status TEXT DEFAULT 'Assigned', -- technician-side job state: Assigned, InProgress, OnHold, Completed
  closed_at TEXT,                     -- set when status becomes 'Closed' - anchors the 15-day reopen window
  start_lat REAL, start_lng REAL, start_captured_at TEXT,   -- best-effort geolocation captured on "Start Work"
  end_lat REAL, end_lng REAL, end_captured_at TEXT,         -- best-effort geolocation captured on final report submit
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Timestamped technician job-state transitions (Assigned -> InProgress -> OnHold -> InProgress -> Completed),
-- reused to log the best-effort start/end geolocation capture alongside each transition.
CREATE TABLE IF NOT EXISTS service_request_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sr_id INTEGER NOT NULL REFERENCES service_requests(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  lat REAL, lng REAL
);

-- 15-day free-of-charge reopen policy: logs every reopen of a Closed SR for
-- reporting (which SR, which technician originally closed it, who reopened it, why).
CREATE TABLE IF NOT EXISTS service_request_reopenings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sr_id INTEGER NOT NULL REFERENCES service_requests(id),
  original_closed_at TEXT,
  reopened_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reopened_by INTEGER REFERENCES users(id),
  technician_id INTEGER REFERENCES employees(id),
  reason TEXT
);

-- ===================== OFFERS / QUOTATIONS =====================
-- Techno-commercial offer, built on the fixed Venkateshwara Engineers letterhead,
-- stored under the customer (client) profile. On confirmation it spawns a
-- sales order + project (execution queue).

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_no TEXT,                      -- shared across an offer's versions - not unique; see version/parent_offer_id
  client_id INTEGER NOT NULL REFERENCES clients(id),
  contact_person TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  subject TEXT,                       -- e.g. "Offer for Electronic Weighing and Bagging System"
  offer_date TEXT DEFAULT CURRENT_TIMESTAMP,
  drawing_no TEXT,
  application TEXT,                   -- Project Data Sheet: Application
  type_of_system TEXT,
  material_of_construction TEXT,
  inclusions TEXT,
  exclusions TEXT,
  utilities_requirement TEXT,
  instrument_air_supply TEXT,
  status TEXT DEFAULT 'Draft',        -- Draft, Sent, Won, Lost
  version INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  sales_order_id INTEGER REFERENCES sales_orders(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Scope of Supply / Machinery Description lines (with picture, qty, price, total)
CREATE TABLE IF NOT EXISTS offer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  item_code TEXT,                     -- A, B, C ...
  section_title TEXT,                 -- e.g. "Electronic Net Weighing And Bagging System(duplex)"
  description TEXT,                   -- multiline
  image_path TEXT,
  qty REAL DEFAULT 1,
  unit_price REAL DEFAULT 0,
  total_price REAL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

-- Technical Specification sheet (prefilled defaults, fully editable, rows addable)
CREATE TABLE IF NOT EXISTS offer_tech_specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  spec_key TEXT NOT NULL,
  spec_value TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Make Of Bought Out Items sheet (Load Cell, Controller, Relays, Motor, Gear box,
-- Air Cylinders, Solenoid Valves, Sewing Head - prefilled, editable, addable)
CREATE TABLE IF NOT EXISTS offer_bought_out_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  component TEXT NOT NULL,
  make TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Terms & Conditions sheet (Price Basis, Delivery, Packing & Forwarding, GST,
-- Freight & Insurance, Guarantee/Warrantee, Payment Terms - prefilled, editable)
CREATE TABLE IF NOT EXISTS offer_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  term_key TEXT NOT NULL,
  term_value TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Admin-managed reusable clauses (Round 40) for Terms & Conditions /
-- Inclusions / Exclusions / Utilities Requirement / Instrument Air Supply -
-- Sales picks from these instead of always typing free text from scratch,
-- same "copy the text at use time, don't reference the row" pattern as
-- section_title_library (Round 27) so editing/removing a library entry
-- later never changes what's already on an existing offer.
CREATE TABLE IF NOT EXISTS offer_clause_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,             -- term, inclusion, exclusion, utilities, instrument_air
  label TEXT NOT NULL,                -- short reference name (the term_key, for 'term'; just a menu label otherwise)
  body TEXT NOT NULL,                 -- the clause text (the term_value, for 'term'; the paragraph text otherwise)
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== Offer immutability (Round 40) =====================
-- Database-level backstop, on top of the app-level guard in
-- lib/offerVersioning.js's ensureEditableVersion(), against mutating an
-- offer once it's locked (offers.locked = 1 - see db/index.js MIGRATIONS
-- for the column and routes/offers.js for what sets/clears it). Child-table
-- triggers (offer_items/offer_tech_specs/offer_bought_out_items/offer_terms)
-- are generated in db/index.js instead of hand-repeated here, since all four
-- follow the exact same shape.
--
-- This UPDATE trigger only fires when the row would REMAIN locked
-- afterwards (OLD.locked = 1 AND NEW.locked = 1) - an UPDATE that itself
-- sets locked = 0 (the Admin-only unlock action) is deliberately still
-- allowed, since NEW.locked would then be 0.
CREATE TRIGGER IF NOT EXISTS trg_offers_locked_update
BEFORE UPDATE ON offers
WHEN OLD.locked = 1 AND NEW.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'OFFER_LOCKED: this offer is locked and cannot be modified');
END;

CREATE TRIGGER IF NOT EXISTS trg_offers_locked_delete
BEFORE DELETE ON offers
WHEN OLD.locked = 1
BEGIN
  SELECT RAISE(ABORT, 'OFFER_LOCKED: this offer is locked and cannot be deleted');
END;

-- ===================== USER ACCESS CONTROL =====================
-- Which sidebar pages a role is allowed to see. Empty for a role = that
-- role is unrestricted (sees everything it always did) until an Admin
-- explicitly saves a selection for it via the User Access module - so
-- turning this feature on never silently locks anyone out.
CREATE TABLE IF NOT EXISTS role_page_access (
  role_id INTEGER NOT NULL REFERENCES roles(id),
  page_id TEXT NOT NULL,
  PRIMARY KEY (role_id, page_id)
);
-- Marks a role as having been explicitly configured at least once (so we
-- can tell "never configured, allow all" apart from "configured to allow
-- nothing").
CREATE TABLE IF NOT EXISTS role_access_configured (
  role_id INTEGER PRIMARY KEY REFERENCES roles(id)
);

-- ===================== CHALLANS (inter-location material movement) =====================
-- Delivery challan for moving material between the company's own locations
-- (factory to factory / factory to site) - not a sale, so no invoice, but
-- still needs to travel with GST-compliant transport paperwork.
CREATE TABLE IF NOT EXISTS challans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challan_no TEXT UNIQUE,
  challan_date TEXT DEFAULT CURRENT_TIMESTAMP,
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  vehicle_no TEXT,
  transport_mode TEXT DEFAULT 'Road',
  transporter_name TEXT,
  distance_km REAL,
  consignor_name TEXT DEFAULT 'Venkateshwara Engineers',
  consignor_gstin TEXT,
  consignee_name TEXT,
  consignee_gstin TEXT,
  reason TEXT DEFAULT 'Stock Transfer (Own Use - Not For Sale)',
  eway_bill_no TEXT,
  po_no TEXT,
  project_id INTEGER REFERENCES projects(id),
  total_value REAL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS challan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challan_id INTEGER NOT NULL REFERENCES challans(id),
  description TEXT NOT NULL,
  hsn_code TEXT,
  quantity REAL NOT NULL,
  unit TEXT DEFAULT 'Nos',
  rate REAL DEFAULT 0,
  value REAL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

-- ===================== FREE OF COST (FOC) MATERIAL ISSUE =====================
CREATE TABLE IF NOT EXISTS foc_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  foc_no TEXT UNIQUE,
  sales_order_id INTEGER REFERENCES sales_orders(id),
  project_id INTEGER REFERENCES projects(id),
  department_id INTEGER REFERENCES departments(id),
  requested_by INTEGER REFERENCES users(id),
  item_description TEXT NOT NULL,
  quantity REAL DEFAULT 1,
  unit TEXT DEFAULT 'Nos',
  estimated_value REAL DEFAULT 0,
  reason TEXT,
  status TEXT DEFAULT 'Pending',      -- Pending, Approved, Rejected, Issued
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== SERVICE REPORTS (Round 3) =====================
-- Filled by the employee a service request is scheduled to. Draft until
-- Submitted; on submit, pending_items=1 reopens the parent service_request,
-- pending_items=0 moves this report into 'Reconciliation' for amount review.
CREATE TABLE IF NOT EXISTS service_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_request_id INTEGER NOT NULL REFERENCES service_requests(id),
  employee_id INTEGER REFERENCES employees(id),
  -- Round 9: fields below replicate the printed "Service Report" form used in
  -- the field (customer/contact/visit header, machine details, type of visit,
  -- narrative sections, charges breakdown, and customer/engineer sign-off).
  sl_no TEXT,                         -- printed form's SL. NO (office copy serial); unique via
                                       -- partial index ux_service_reports_sl_no in db/index.js
                                       -- (excludes NULL/blank for pre-Round-9 legacy rows)
  customer_name TEXT,
  customer_address TEXT,
  contact_person TEXT,
  contact_no TEXT,
  engineer_name TEXT,
  visit_from TEXT,
  visit_to TEXT,
  days_at_site REAL,
  activity_date TEXT,
  activity_start_time TEXT,
  activity_end_time TEXT,
  machine_type TEXT,                  -- Simple/Duplex Bagging Machine, Stitching Machine, Conveyor/Loader, Hyd. Loader/Stacker, Others
  machine_capacity TEXT,              -- e.g. "5 Kg"
  type_of_visit TEXT,                 -- Installation/Commissioning, Warranty, AMC, Emergency, Additional
  reason_for_visit TEXT,
  faults_found TEXT,
  action_taken TEXT,
  completion_remarks TEXT,            -- Completion Remarks / Pending Reasons
  amount_updown_food REAL DEFAULT 0,  -- "Up/Down & Food" line on the printed form
  machine_working_satisfactorily TEXT,-- Yes / No
  visit_rating TEXT,                  -- Excellent / Good / Average
  overall_feedback TEXT,              -- Satisfactory / Non Satisfactory
  customer_remarks TEXT,
  customer_signatory_mobile TEXT,
  customer_signature_path TEXT,       -- drawn on the employee's phone/device at the visit
  engineer_remarks TEXT,
  engineer_signatory_mobile TEXT,
  type_of_service TEXT,               -- 'Under Warranty' / 'Out of Warranty'
  type_of_issue TEXT,                 -- 'Repair' / 'Service' / free text (Other)
  machine TEXT,
  problem_identified TEXT,
  resolution_provided TEXT,
  pending_items INTEGER DEFAULT 0,
  pending_items_comments TEXT,
  amount_travel REAL DEFAULT 0,
  amount_service REAL DEFAULT 0,
  amount_spares REAL DEFAULT 0,
  handwritten_report_path TEXT,
  status TEXT DEFAULT 'Draft',        -- Draft, Submitted, Reconciliation, Approved, SubmittedToAccounts
  submitted_to_accounts_at TEXT,
  submitted_to_accounts_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== LEAVE BALANCE POLICIES (Round 3) =====================
-- Company-wide or department-level leave allocation schedules, resolved at
-- lookup time: Department policy (for that employee's department) overrides
-- Company policy overrides the leave_type's own default annual_quota.
CREATE TABLE IF NOT EXISTS leave_balance_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                 -- 'Company' or 'Department'
  department_id INTEGER REFERENCES departments(id), -- NULL for Company scope
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  year INTEGER NOT NULL,
  allocated REAL DEFAULT 0,
  UNIQUE(scope, department_id, leave_type_id, year)
);

-- ===================== FINANCE LEDGER (Round 3) =====================
CREATE TABLE IF NOT EXISTS finance_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT DEFAULT CURRENT_TIMESTAMP,
  type TEXT NOT NULL,                 -- Expense, Payroll, ServiceCollection, AdvanceRecovery, PurchaseInvoice, Other
  reference_table TEXT,
  reference_id INTEGER,
  department_id INTEGER REFERENCES departments(id),
  amount REAL NOT NULL,
  direction TEXT NOT NULL,            -- Inflow / Outflow
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== EXTRA PAGE ACCESS (Round 3) =====================
-- Additive grants on top of a role's configured page list: 'Department'
-- scope applies to every current AND future user in that department,
-- 'User' scope applies to one specific user.
CREATE TABLE IF NOT EXISTS extra_page_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                -- 'Department' or 'User'
  department_id INTEGER REFERENCES departments(id),
  user_id INTEGER REFERENCES users(id),
  page_id TEXT NOT NULL,
  granted_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== SERVICE CENTERS (Round 7) =====================
-- Company's service centers across cities. Spare parts ship from the
-- central store (items.current_stock) to these locations, tracked here
-- separately via service_center_stock - items.current_stock keeps meaning
-- "central store stock" unchanged.
CREATE TABLE IF NOT EXISTS service_centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  status TEXT DEFAULT 'Active',       -- Active, Inactive
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Per-location stock, parallel to (not part of) items.current_stock.
CREATE TABLE IF NOT EXISTS service_center_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_center_id INTEGER NOT NULL REFERENCES service_centers(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL DEFAULT 0,
  UNIQUE(service_center_id, item_id)
);

-- Store -> Service Center stock issue (dispatch), with a per-line receipt
-- confirmation step that captures any shortage/damage discrepancy.
CREATE TABLE IF NOT EXISTS service_center_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_no TEXT UNIQUE,
  service_center_id INTEGER NOT NULL REFERENCES service_centers(id),
  status TEXT DEFAULT 'Dispatched',   -- Dispatched, Received, PartiallyReceived, Disputed
  dispatched_by INTEGER REFERENCES users(id),
  dispatched_at TEXT DEFAULT CURRENT_TIMESTAMP,
  received_by INTEGER REFERENCES users(id),
  received_at TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS service_center_transfer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL REFERENCES service_center_transfers(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity_sent REAL NOT NULL,
  quantity_received REAL,             -- NULL until receipt is confirmed
  unit_rate REAL DEFAULT 0
);

-- Spares actually consumed by a service engineer during a visit, deducted
-- from that service center's stock. Kept alongside (not replacing) the
-- existing free-text spare_parts_needed / amount_spares fields on
-- service_reports for backward compatibility.
CREATE TABLE IF NOT EXISTS service_report_spares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_report_id INTEGER NOT NULL REFERENCES service_reports(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_rate REAL DEFAULT 0,
  service_center_id INTEGER NOT NULL REFERENCES service_centers(id)
);

-- ===================== PURCHASE: MULTI-VENDOR QUOTES =====================
-- Round 13: for a high-value Purchase Request (estimated_value at/above the
-- configurable 'purchase_quote_threshold' setting), Purchase must collect
-- quotes from at least 2 vendors before it can be submitted for approval.

CREATE TABLE IF NOT EXISTS purchase_request_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  quoted_amount REAL,
  quote_file_path TEXT,
  notes TEXT,
  is_selected INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== PURCHASE: RFQ (REQUEST FOR QUOTATION) =====================
-- Outbound-only vendor RFQ: a Purchase Executive selects some or all of a
-- PR's line items and one or more vendors, edits a default email template,
-- and sends it (via lib/mailer.js). There is no inbound email parsing or
-- vendor portal here - a vendor's reply still comes back outside the
-- system and gets typed in as a quote (purchase_request_quotes below),
-- same as before this feature existed. rfq_requests is the "what/who was
-- asked" record; rfq_request_vendors is one row per vendor the RFQ went
-- to, so a partial send failure (bad email, SMTP hiccup) is visible per
-- vendor instead of an all-or-nothing send.
CREATE TABLE IF NOT EXISTS rfq_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id),
  item_ids TEXT NOT NULL,             -- JSON array of purchase_request_items.id this RFQ covers
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rfq_request_vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_request_id INTEGER NOT NULL REFERENCES rfq_requests(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  email_status TEXT DEFAULT 'Pending',  -- Pending, Sent, Failed, NoEmail (vendor has no email on file)
  email_error TEXT,
  sent_at TEXT
);
-- A manually-typed recipient not on file in Vendor Master at all (a new
-- vendor's buyer, a broker, an alternate contact) - kept as its own table
-- rather than loosening rfq_request_vendors.vendor_id's NOT NULL, since
-- that table's rows already went out under the earlier RFQ PRs and a
-- column can't be added mid-flight without a full table rebuild in SQLite.
CREATE TABLE IF NOT EXISTS rfq_request_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_request_id INTEGER NOT NULL REFERENCES rfq_requests(id),
  email TEXT NOT NULL,
  email_status TEXT DEFAULT 'Pending',  -- Pending, Sent, Failed
  email_error TEXT,
  sent_at TEXT
);

-- ===================== AUDIT LOG =====================

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Bank Guarantee edit/delete approval gate, same shape and reasoning as
-- item_pending_changes (Round 23): a bg.manage holder who isn't Admin can
-- request an edit or delete, but the live row isn't touched until an Admin
-- reviews it here - nothing changes underneath a reminder/claim workflow
-- already in flight against that BG. See routes/bankGuarantees.js.
CREATE TABLE IF NOT EXISTS bg_pending_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bg_id INTEGER NOT NULL REFERENCES bank_guarantees(id),
  change_type TEXT NOT NULL,          -- Edit, Delete
  proposed_fields TEXT,               -- JSON of {field: value} - null for Delete
  status TEXT DEFAULT 'Pending',      -- Pending, Approved, Rejected
  requested_by INTEGER REFERENCES users(id),
  requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT
);

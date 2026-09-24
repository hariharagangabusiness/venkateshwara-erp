# Venkateshwara Engineers — ERP System (Prototype)

A working multi-department ERP built for Venkateshwara Engineers. Node.js + Express + SQLite backend, no-build vanilla-JS frontend.

## What's included

- **Auth & Access Control** — JWT login, role-based permissions (16 roles: Admin, Marketing, Sales, ProjectManager, Design, Purchase, Store, LaserBending, Manufacturing, Assembling, Packing, Shipping, Installation, Service, HR, Accounts). Admin bypasses all checks; other roles are gated by a permission table you can extend in `db/seed.js`.
- **Generic approval engine** (`lib/approvals.js`) — reusable multi-step chains with amount thresholds, each step optionally restricted to that role's HOD/Supervisor specifically. Pre-wired chains: Expense Voucher (Accounts, +Admin above ₹25,000), Leave (HR), Purchase Request (Purchase HOD always, +Management HOD above ₹50,000), Salary Advance (HR then Accounts), Payroll (Accounts then Admin) — every chain is editable from **Admin → Approval Matrix** without touching code.
- **Marketing & Sales** — leads/enquiries with stage tracking (New → Quoted → Negotiation → Won/Lost), sales orders, client master.
- **Offers / Quotations** (`Sales & Marketing → Offers`) — full techno-commercial offer builder on the standard Venkateshwara Engineers letterhead: customer & address, a Scope of Supply sheet with machinery description, picture, qty, unit price and auto-calculated totals; a Technical Specification sheet prefilled from your standard template and fully editable/extendable; a Make of Bought Out Items sheet (Load Cell, Controller, Relays, Motor, Gear Box, Air Cylinders, Solenoid Valves, Sewing Head) prefilled with your usual makes; a Terms & Conditions sheet (Price Basis, Delivery, Packing & Forwarding, GST, Freight & Insurance, Guarantee/Warrantee, Payment Terms); and Inclusions/Exclusions/Utilities Requirement/Instrument Air Supply text blocks — all prefilled with your standard boilerplate and editable per offer. Every offer is stored under its customer (client) and downloadable as a PDF that reproduces the letterhead (banner header + address footer on every page). Clicking **Confirm Order** turns a won offer straight into a Sales Order and auto-queues a Project with a job card in every downstream department (Design → Purchase → Store → Laser & Bending → Manufacturing → Assembling → Packing → Shipping → Installation) for execution.
- **Project Management** — creating a project auto-generates a job card in every downstream department (Design, Purchase, Store, Laser & Bending, Manufacturing, Assembling, Packing, Shipping, Installation) so the whole shop-floor pipeline is tracked from one place. Completing the last stage auto-closes the project.
- **Purchase & Store** — purchase requests with approval, purchase orders, vendor master, item master, stock IN/OUT (GRN receive / issue to production) with running stock levels and low-stock flags.
- **Service & Spares** — service request tracking with status workflow.
- **Payroll (HR)** — employee master, daily attendance marking, leave requests with approval, salary advances with approval and automatic deduction against the next payroll run, monthly payroll generation (draft) → approval → mark paid, payroll voucher log.
- **Operation Expenses** — expense vouchers by department and category, **cash vs accounted** tagging on every voucher, and a dedicated Cash vs Accounted report (`Finance → Cash vs Accounted Report`).
- **Dashboard** — live counts (active employees, active projects, open leads, pending approvals of each type, low stock, open service tickets) plus an expense-by-mode breakdown.

## This round's changes

- **FOC approval confirmed to Management** — FOC Material Issue's approval chain routes to the Management role, verified end-to-end (no code change needed, existing config already correct).
- **Design / Electrical / Manufacturing get their own sidebar tabs** — each department login now sees a dedicated nav group named after its department instead of only the generic "My Job Cards" tab. Manufacturing HODs/supervisors additionally get a combined view across all Manufacturing sub-processes (Fitting, Tacking, Welding, Buffing/Sandblast, Painting) so they can see the whole shop floor's queue without switching logins (`lib/pipeline.js` `combinedStagesForRole()`, `routes/projects.js` `/job-cards/mine` and `/job-cards/by-stage/:stage`).
- **Employee edit + expanded fields** — Employees can now be edited in place (not just created), and the employee record carries employment type, PAN number, blood group, emergency contact name/phone, exit date and an active/inactive status flag.
- **Leave Balances Master** (`Payroll & HR → Leave Balances Master`) — configure leave types (annual quota, paid/unpaid, probation eligibility in months, accrual, carry-forward and max carry-forward) and view/override each employee's per-year allocation, usage and remaining balance. A leave type's `probation_months` gates new leave requests until the employee has served that long; its `is_paid` flag feeds directly into payroll (see below).
- **Salary Advance installments** — advance requests can specify a number of installments (with an optional per-installment override); each payroll run automatically deducts that advance's next installment (capped at what's still owed) and, once marked Paid, updates `recovered_amount` / `installments_paid` on the advance. The Salary Advances page shows installment progress and recovered-vs-total for each advance. The payroll Salary Schedule table now shows the unpaid-leave deduction (`leave_deduction`) as its own column, separate from the advance deduction, so HR can see exactly why a month's pay was reduced.

## Round 3 fixes

Four bugs reported after Round 3 shipped were investigated and fixed:

1. **User Access page "lost" pages/functions** — investigated: `PAGE_CATALOG` in `routes/admin.js` was cross-checked against every `PAGES[...]` entry and `NAV` group in `public/js/app.js` (dept-report, leave-balances, finance-ledger, service-reports-dashboard, stock-in-out, challans, etc.) and both the role-matrix and department/individual "extra access" grant UI already render every catalog entry. No missing pages or broken save paths were found — verified by reading both the catalog and the full NAV/PAGES key list side by side; they match exactly. No code change was needed here.
2. **Employees module restructuring** — `employee_code` (HR/payroll ID) was already properly separate from login credentials (`users.username`/`password_hash`, linked via `users.employee_id`), so no data-model change was required there. Added: `bank_name`, `account_number`, `ifsc_code` columns (replacing reliance on the old single free-text `bank_account` field going forward, which is kept for backward compatibility) and `aadhaar_number`, `passport_number`, `visa_availability`, `driving_license_number` — all as `ALTER TABLE` migrations in `db/index.js`. `POST`/`PUT /hr/employees` now accept and return all of them, and the Add/Edit Employee forms in `app.js` show them grouped under "Bank Details" and "Identity Documents" subsections. Verified via curl (`POST /api/hr/employees` round-trips all new fields).
3. **Attachments missing on several pages** — added a generic, reusable `attachments` table (`entity_type`, `entity_id`, `file_path`, `original_name`, `uploaded_by`) plus `routes/attachments.js` (`GET`/`POST /api/attachments/:entityType/:entityId`, `DELETE /api/attachments/:id`, `requireAuth` only — access follows whatever gate the parent record's own page already has) reusing the same multer disk-storage pattern already used for expense vouchers, job cards and service reports. Added a `renderAttachmentsWidget(entityType, entityId, container)` frontend helper and wired it into Purchase Requests, Purchase Orders, FOC Material Requests, Leave Requests and Salary Advances. Expense Vouchers' existing attachment mechanism was left untouched and re-verified working via curl.
4. **Admin "Access Denied: Missing Permission service_request.manage"** — investigated `requirePermission()` in `middleware/auth.js` (Admin bypass is checked first and is correct), the route (`POST /api/service` in `routes/service.js`, permission code matches what's seeded for other roles), and the frontend (no client-side permission gating blocks the button). Reproduced via curl login as Admin and `POST /api/service` — succeeded (`{"id":...,"sr_no":"SR-..."}`), confirming the bypass works correctly end-to-end. No reproduction of the reported error was found in the current code; most likely cause was a stale JWT issued before the bypass logic was in place, or a stale seed — both are resolved by a clean reseed/relogin.
5. **Service Request scheduling not landing in the assigned employee's queue** — tested end-to-end via curl: created a request as Admin, scheduled it to the `service1` demo employee (`PATCH /api/service/:id/schedule`), logged in as `service1`, and called `GET /api/service/mine`. The scheduled request appeared correctly. `db/seed.js` correctly links every demo user to a matching `employees` row via `users.employee_id`, and `GET /api/service/mine` correctly joins through `req.user.employee_id`. No reproduction found — verified working after a clean reseed.

## Running it

Requires **Node.js 22.5 or newer** (uses Node's built-in `node:sqlite` module — no native/C++ build tools needed, so this installs cleanly on Windows without Visual Studio Build Tools).

Offer PDFs are generated using a Chrome or Edge browser already on your machine (via `puppeteer-core`, which is a thin driver, not a bundled 200MB+ browser download). Windows 10/11 comes with Microsoft Edge pre-installed, so this works out of the box on almost every machine; if it can't find a browser it will tell you clearly, and you can point it at one with the `PDF_CHROME_PATH` environment variable if it's installed somewhere non-standard.

```bash
npm install
node db/seed.js     # one-time: creates tables + demo roles/users (safe to re-run)
node server.js       # starts on http://localhost:4000
```

Open `http://localhost:4000` in a browser.

### Deployment (Render or similar)

By default the SQLite DB (`db/erp.db`) and uploaded files (`public/uploads/`) live inside the app directory, which is fine for local use but gets wiped on every redeploy on platforms like Render that use an ephemeral container filesystem. To persist data across redeploys, mount a persistent disk and set:

- `DATA_DIR` — directory for `erp.db` (e.g. `/data`)
- `UPLOADS_DIR` — directory for uploaded files (e.g. `/data/uploads`)

Both are optional and unset by default, which keeps local dev behavior unchanged.

### Backups & migration

The app takes a **daily automated backup** — a consistent SQLite snapshot of `erp.db` (via `VACUUM INTO`, safe to run against a live, concurrently-written database) plus a full copy of the uploads directory, bundled into one `.tar.gz` when the `tar` binary is available. It runs once at boot and every 24 hours after (see `server.js`/`lib/backup.js`), and every attempt — success or failure — is logged to the `backup_runs` table, viewable under **Admin > Backups**, which also has a "Run Backup Now" button, per-backup download, and delete.

Configuration (all optional, see `.env.example`):
- `BACKUP_DIR` — where backups are written. Defaults to a `backups/` folder next to `erp.db`. Point this at a **separate** volume/disk if you want backups to survive the loss of the main data volume — a backup that lives on the same disk it's backing up doesn't protect against that disk failing.
- `BACKUP_RETENTION_DAYS` — how many days of backup files to keep before they're deleted (default 14). The log entries in Admin > Backups are kept regardless, so the audit trail survives even after a file is purged.
- `BACKUP_EMAIL_TO` — email each day's backup as an offsite copy (only when SMTP is configured and the archive is under ~20MB).
- `ZOHO_WORKDRIVE_CLIENT_ID` / `ZOHO_WORKDRIVE_CLIENT_SECRET` / `ZOHO_WORKDRIVE_REFRESH_TOKEN` / `ZOHO_WORKDRIVE_FOLDER_ID` / `ZOHO_WORKDRIVE_DC` — also upload each day's backup to a Zoho WorkDrive folder as an offsite copy (`lib/zohoWorkdrive.js`). All four of the first values must be set together or this is skipped (logged per-run in Admin > Backups, same as an email failure).

**Getting the Zoho WorkDrive credentials** — a connected chat session's own WorkDrive access (e.g. this repo's Claude Code session) can browse and create folders there, but it can't act on the deployed server's behalf: the running app needs its *own* Zoho API credentials, independent of any person's login session, so it can upload unattended every day indefinitely. That means a one-time setup a human has to do in Zoho's API Console:
1. Go to [api-console.zoho.com](https://api-console.zoho.com/) (sign in with the same Zoho account/org whose WorkDrive you want backups in), click **Add Client** → **Self Client**.
2. Under the **Generate Code** tab, enter scope `WorkDrive.files.ALL` (or `WorkDrive.files.CREATE` if offered separately), pick a time duration (e.g. 10 minutes is enough), and generate a code.
3. Immediately exchange that code for tokens by POSTing to `https://accounts.zoho.<dc>/oauth/v2/token` with `code`, `client_id`, `client_secret`, `redirect_uri=https://workdrive.zoho.com`, and `grant_type=authorization_code` (curl or Postman both work) — the response's `refresh_token` is long-lived and is what the app actually uses day to day; the Self Client screen also shows the `client_id`/`client_secret` directly.
4. Pick (or create) the destination folder in WorkDrive and grab its folder ID from its URL (the segment after the last `/`, or via the API).
5. Set all five as environment variables on the server (Railway's dashboard, not this repo) — never commit them to git.

A destination team folder named **"ERP Backups"** already exists in this project's connected WorkDrive (private, created via the session's connector) if you want to point `ZOHO_WORKDRIVE_FOLDER_ID` at it rather than creating a new one — open WorkDrive and check its URL for the folder ID, or ask whoever set it up.

**To migrate to a new server**: download a backup from Admin > Backups (or grab one directly from `BACKUP_DIR` on the server), stop the app on the new server, replace its `erp.db` with the backup's `erp.db` and its uploads directory with the backup's `uploads/` folder, then start it there with `DATA_DIR`/`UPLOADS_DIR` pointed at those paths. Nothing proprietary — it's a plain SQLite file and a plain folder of files, the same as this app already reads and writes every day.

### Demo logins

| Username | Password | Role |
|---|---|---|
| admin | Admin@123 | Admin (full access) |
| hr1 | Demo@123 | HR |
| accounts1 | Demo@123 | Accounts |
| sales1 | Demo@123 | Sales |
| marketing1 | Demo@123 | Marketing |
| pm1 | Demo@123 | Project Manager |
| design1 | Demo@123 | Design |
| purchase1 | Demo@123 | Purchase |
| electrical1 | Demo@123 | Electrical |
| store1 | Demo@123 | Store |
| laserbending1 | Demo@123 | Laser & Bending Processing |
| manufacturing1 | Demo@123 | Manufacturing (HOD) |
| fitting1 | Demo@123 | Manufacturing — Fitting |
| tacking1 | Demo@123 | Manufacturing — Tacking |
| welding1 | Demo@123 | Manufacturing — Welding |
| buffing1 | Demo@123 | Manufacturing — Buffing/Sandblast |
| painting1 | Demo@123 | Manufacturing — Painting |
| assembling1 | Demo@123 | Assembling |
| packing1 | Demo@123 | Packing |
| shipping1 | Demo@123 | Shipping |
| installation1 | Demo@123 | Installation |
| service1 | Demo@123 | Service & Spares |
| management1 | Demo@123 | Management (approves FOC material requests) |
| design2 | Demo@123 | Design (regular team member, not the HOD) |

Every department in the pipeline now has a ready-to-use demo login above — no need to create users manually to try out the full flow end to end. Every `<dept>1` login is that department's **HOD/Supervisor**; `design2` is seeded specifically to demonstrate the difference — a regular team member can only start/complete a job card once their HOD has allocated it to them (see below).

## Architecture notes

- `db/schema.sql` — full relational schema (SQLite). One `job_cards` table drives every production-stage department generically, keyed by `stage` (department name) — the same pattern used for Design through Installation, so adding a new stage doesn't need a new table.
- `lib/approvals.js` — the approval engine is entity-agnostic: any module calls `startApproval(chainName, entityType, entityId, amount, userId)` and later `act(...)`. Adding a new approval-gated workflow means adding a chain + steps in the seed data, no code changes.
- `middleware/auth.js` — `requirePermission()` / `requireRole()` middleware for route-level access control; permissions are stored per-role in `role_permissions` so you can regrant access without touching code.
- Frontend is a single-page app (`public/js/app.js`) with no build step — open `public/index.html` mentally as the shell, everything else is rendered client-side against the JSON API.

## Extending toward production

This is a functional foundation, not a finished production system. Before real deployment, plan for:
- Password reset / forced change on first login, stronger password policy
- File uploads for voucher attachments and drawings (currently a placeholder column)
- Multi-currency / GST-compliant invoicing if needed beyond internal vouchers
- Real reporting/exports (PDF/Excel) for payroll slips, PO printouts, vouchers
- A proper production database (Postgres/MySQL) once beyond single-machine use — daily backups exist (see "Backups & migration" above), but SQLite itself remains a single-writer, single-file bottleneck at scale
- Row-level scoping (e.g., a Sales user only seeing their own leads) if headcount grows
- HTTPS + a real deployment target (this listens on plain HTTP on port 4000)

## Sales Order features

- **Auto-generated annexure (Word doc)** — the moment a quotation is confirmed into a Sales Order, an internal execution annexure (`.docx`) is generated automatically, named `<ClientName>_<OrderNo>.docx`. It contains the Project Data Sheet / Technical Specification and Scope of Supply (item, description, qty — **no prices or totals**) and the Make of Bought Out Items table. Terms & Conditions and Inclusions/Exclusions are deliberately left out — this is meant as an engineering/production handoff document, not a commercial one. Download it from the **Annexure** link in the Sales Orders table (`GET /api/sales/orders/:id/annexure`).
- **Auto-generated annexure (Word doc)** — the moment a quotation is confirmed into a Sales Order, an internal execution annexure (`.docx`) is generated automatically, named `<ClientName>_<OrderNo>.docx`. It contains the Project Data Sheet / Technical Specification and Scope of Supply (item, description, qty — **no prices or totals**) and the Make of Bought Out Items table. Terms & Conditions and Inclusions/Exclusions are deliberately left out — this is meant as an engineering/production handoff document, not a commercial one. Download it from the **Annexure** link in the Sales Orders table (`GET /api/sales/orders/:id/annexure`).

### Two-level target planning: Targets sheet (PM) → department HOD workbench

Planning happens on its own **Targets** tab (Projects & Production section), separate from the Projects list itself, so it can be revisited and edited at any time without re-navigating to the order it came from:

- **Targets sheet (PM / Admin only, gated behind `project.manage`)** — pick a project, set a start date, and enter how many days each top-level department needs. Rows can be reordered with the ▲▼ buttons to match the real handover sequence between teams, and the order you leave them in is saved as that project's actual pipeline order (`sequence` on each job card), not just a fixed default. Saving recalculates each stage's planned start/end so they cascade one after another (next stage starts the day after the previous ends), and rolls up an overall project target completion date, shown both on the Targets sheet and back on the Projects table. Come back to this same tab any time to change targets already set (`PUT /api/projects/:id/plan`).
- **Planning is what releases work to departments** — a job card only shows up in a department's **My Job Cards** workbench once it has a planned start date. A top-level department gets one from the PM's Targets sheet; before that, the stage exists (so the pipeline and sequence are already set up) but isn't "released" for execution yet.
- **Department HOD workbench, for departments with sub-processes** — right now, Manufacturing. The PM only plans Manufacturing's *overall* window on the Targets sheet as a single row; once that's released, the Manufacturing HOD (the user whose role is `Manufacturing`) sees it in their own My Job Cards workbench with a **Plan Sub-Processes** button, which opens the same kind of planner scoped to just their department's five sub-processes (Fitting → Tacking → Welding → Buffing/Sandblast → Painting). The HOD sets each one's duration, the dates cascade the same way, and saving is what releases each sub-process to *its* worker's own My Job Cards queue (`GET /api/projects/job-cards/:id/children`, `PUT /api/projects/job-cards/:id/subplan`). Only that department's own HOD (or Admin) can plan its sub-processes — anyone else gets a clear 403.
- **Handover gating, at both levels** — a department can't be marked In Progress or Completed until every department ahead of it in the (possibly reordered) top-level sequence has finished, and the same rule applies one level down among a department's own sub-processes. A department with sub-processes additionally can't be marked **Complete Work** until every one of its sub-processes is completed first — so Manufacturing can't be closed out until Fitting, Tacking, Welding, Buffing/Sandblast and Painting all are.
- **Complete Work button** — every Job Cards row gets a clear **Start Work** / **Complete Work** action pair (renamed from the earlier generic "Mark ..." wording) so a department knows exactly what to click once they're done.

### Default execution pipeline

`lib/pipeline.js` is the single source of truth for the two-level stage tree created when a project's execution queue (job cards) is first created — for a new Sales Order (whether created directly or by confirming an Offer):

1. **Design**
2. **Purchase** — BOM / raw material & component procurement, once Design hands off the BOM
3. **Electrical** — control panel & electrical systems design, once Design hands off the details
4. **Store** — GRN / issue to production
5. **Laser & Bending Processing**
6. **Manufacturing** — planned by the PM as a single top-level row; internally made up of sub-processes **Fitting → Tacking → Welding → Buffing/Sandblast → Painting**, planned separately by the Manufacturing HOD (see above)
7. **Assembling**
8. **Packing**
9. **Shipping**
10. **Installation**

This is only the *starting* order — any project's actual top-level sequence can be changed per-project from the Targets sheet to reflect how work really moves between teams for that job (e.g. Electrical before Purchase, or vice versa), and a department with sub-processes can reorder those independently from its own HOD workbench.

### Department workbench: HOD gating, sub-assemblies, attachments, comments, and multi-department routing

Every department works from the same **My Job Cards** page — it's already scoped to whichever department the logged-in user belongs to, so it functions as that department's own tab without needing a separate nav entry per department. Within it:

- **Only the HOD/Supervisor, or whoever a card is specifically assigned to, can Start/Complete it.** Every user has an `is_supervisor` flag (set per demo login above). A regular team member sees their department's cards but the Start/Complete buttons are hidden unless the card is assigned to them; their HOD/Supervisor can act on any card in the department at any time. Everyone can still **Open** a card to read its details, attachments and comments.
- **HOD/Supervisor Tools** (visible only to the HOD/Supervisor, inside a card's **Open** detail panel):
  - **Add Sub-Assembly** — create an ad-hoc child card scoped to that department and project (e.g. "Hopper Sub-Assembly" under Design), not limited to Manufacturing's fixed five sub-processes. It's released immediately and shows up in the same workbench.
  - **Allocate to Team Member** — assign any card (top-level or sub-assembly) to a specific person in the department, so that person's own Start/Complete/attachments/comments apply to just that card.
  - **Route to Department** — hand this card's work off to one or more *other* departments independently, once it's ready — the example this was built for: Design finishing up routes the BOM to Purchase, the cut/bend files to Laser & Bending Processing, and the sub-assembly drawings to Electrical, all at once and all independent of each other (`POST /api/projects/job-cards/:id/route-to`). Each routed hand-off becomes its own ad-hoc card in the receiving department, linked back to the source card via a dependency, and is released to that department's workbench once the source card is marked Completed — so three departments can pick up their part of the work in parallel rather than waiting in a single line.
- **Attachments** — upload files (drawings, BOMs, spec sheets) directly on any job card, viewable by anyone who can see that card; this is how a department hands off files to the next one.
- **Comments / Handover Notes** — a running note thread on every job card, for the kind of "here's what I did, here's what you need to know" context that a status change alone doesn't carry.
- A department card that has children (sub-assemblies or sub-processes) still can't be marked Complete until every child is completed first, same rule as the Manufacturing sub-process gating above.
- **Admin/Project Manager also get a separate Job Cards tab per department** — a new **Department Job Cards** sidebar group, one entry per pipeline stage (Design Job Cards, Purchase Job Cards, Electrical Job Cards, and so on), each showing that department's *entire* queue rather than filtering down to "assigned to me" (`GET /api/projects/job-cards/by-stage/:stage`, gated behind `project.manage`). This is how someone overseeing the whole pipeline watches every department without switching logins; a regular department login still only ever sees its own single tab.

## User Access (Admin only)

A new **User Access** page under Admin lets an Admin control which sidebar pages each *role* is allowed to see, department by department — tick the pages a role should have, save, and every user with that role is instantly limited to that list (`GET/PUT/DELETE /api/admin/access/:roleId`). A role that's never been explicitly configured stays **Unrestricted** (sees everything, exactly like before this feature existed) — so turning this on never silently locks anyone out; it only takes effect once an Admin actively saves a list for that role. Admin itself always sees everything and can't be restricted. The frontend re-checks this on every login (`GET /api/auth/my-pages`) and hides disallowed items from the sidebar entirely, collapsing empty groups.

## Service Request Management

Under **Service & Spares**, logging and scheduling are now two separate steps:

1. **Log (step 1, any Service team member):** create a request against a customer picked from the Clients master, *or* type one in manually (name, contact person, contact number) for a walk-in/phone customer who isn't in the system yet. It lands in the **Service Request Queue** with status Open — no employee or date yet.
2. **Schedule (step 2, Service HOD/Supervisor or Admin only):** open a queued request and assign a **service employee** (pulled from the Employees table) and a **scheduled date** (`PATCH /api/service/:id/schedule`). Doing this flips the status Open → Scheduled. A regular (non-supervisor) Service team member can log requests but sees no Schedule button and is rejected (403) if they call the schedule endpoint directly.

After scheduling, the status can still be walked forward with the dropdown (InProgress → PartsOrdered → Resolved → Closed), and the HOD/Supervisor can re-open the schedule panel any time to reschedule.

## Store / Inventory: Challans

The **Store / Inventory** tab (already its own sidebar entry) now also includes a **Challan** module for moving material between the company's own locations (factory to factory, or factory to a site) — not a sale, so no invoice, but it still needs to travel with proper paperwork. The form covers what's needed for a GST-compliant delivery challan: from/to location, vehicle number, transport mode, transporter name, distance, e-way bill number, PO/reference number, consignor/consignee GSTIN, reason for transport, and a line-item table (description, HSN code, qty, unit, rate, computed value, running total). Save it (`POST /api/purchase/store/challans`), and it's in the database and listed under Saved Challans, with two options per row: **Print** opens a formatted, ready-to-print challan in a new tab (browser print dialog), and **Download PDF** fetches a real, server-generated PDF (`GET /api/purchase/store/challans/:id/pdf`) rendered with the installed Chrome/Edge browser (via `puppeteer-core`) and downloads it straight to disk — no print dialog needed.

## FOC (Free of Cost) Material Issue

Under **Finance → FOC Material Issue**: any department's HOD/Supervisor login can request material to go out free of cost, optionally linked to a specific Sales Order (the project it belongs to is resolved automatically from the order) — a plain team member (non-supervisor) can't raise one. Every field (item description, quantity, value, etc.) stays editable inline right in the table while the request is still Pending. A **Management** login (or Admin) approves or rejects it (`POST /api/finance/foc/:id/approve` / `/reject`); once approved, Store can mark it **Issued**. After a request has been actioned, only Management/Admin can still edit it — the original requester can't quietly change something that's already been approved.

## Expense Vouchers: bill attachment

Raising an expense voucher (`POST /api/finance/expense-vouchers`) now accepts an optional file upload (`attachment`, up to 15 MB — bill/receipt image or PDF), stored under `public/uploads/expenses/` and linked via `attachment_path`. The voucher list shows a **Bill** column with a **View** link when one's attached.

## Employees: bulk upload via Excel template

On the **Employees** page: **Download Template** (`GET /api/hr/employees/template`) gives an `.xlsx` with the expected columns (employee code, name, department, designation, date of joining, phone, email, address, bank account, salary) plus a second sheet listing the exact department names to use. Fill in a row per employee and use **Upload Filled Template** (`POST /api/hr/employees/bulk-upload`) to create them all at once. Each row is validated independently — a missing name, an unrecognized department, or a duplicate employee code skips just that row with a reported reason, while the rest of the file still goes through; the response summarizes how many were inserted vs. skipped, with the skip reasons listed.

## Purchase Requests & Purchase Orders

Purchase Requests can now be **edited while Pending** — an Edit button on each pending row opens a panel to review/change the item, project, quantity, or estimated value (`PUT /api/purchase/requests/:id`, restricted to the original requester or Admin/Management once it's no longer Pending). On the Purchase Order form, picking a PR from **From PR (approved)** now shows a detail box with that PR's item, requested quantity, project, and estimated value, and auto-fills the item/quantity fields — so a PO is never created "blind" against a PR you can't see.

## Purchase Request: type an item instead of picking from the master, plus mandatory two-step approval

Raising a Purchase Request no longer requires the item to already exist in the Item Master. The form offers both: pick an existing (approved) item from the dropdown, **or** just type the item name in "Or type an item name" if it isn't there yet. A typed item is created immediately as a **Pending** entry in the Item Master (`status = 'Pending'`) and linked to the request — it shows up under **Store & Inventory → Item Master → Pending Item Master Review**, where Store can fill in the remaining details (item code, category, HSN, rack location, reorder level) and click **Approve into Master**, usually done while physically receiving the goods. Only once approved does it get a barcode and count as a real master item; until then it's excluded from the Item Master list, the Stock In/Out item dropdown, and bulk-upload duplicate checks.

Every Purchase Request — regardless of value — now goes to the **Purchase department's HOD/Supervisor** for approval first (a plain Purchase team member, non-supervisor, can't act on it). Only after that does it move to a second step, gated by whatever **Approval Matrix** (see below) has configured for that value — by default, Management HOD/Supervisor sign-off above ₹50,000. A request under the threshold is fully approved (and shows up in Purchase Orders' "From PR" dropdown) as soon as the Purchase HOD approves it; nothing skips the first step regardless of amount.

## Approval Matrix (Admin only)

A new **Admin → Approval Matrix** page makes every approval chain in the system (Expense Voucher, Leave, Purchase Request, Salary Advance, Payroll) fully configurable without touching code: for each chain, add/remove/reorder steps, and for each step pick the **approver role**, the **minimum amount** it kicks in at (0 = always applies), and whether it **requires that role's HOD/Supervisor specifically** rather than any user holding the role (`GET/PUT /api/admin/approval-matrix/:chainId`). This is the same underlying `approval_chain_steps` table the approval engine (`lib/approvals.js`) already ran on — the matrix page just makes it editable from the UI. Admin can always act on any step regardless of the matrix.

**My Approvals** (every login's pending-approval tab) is now grouped for clarity: first by **category** (which approval chain — Expense Voucher, Purchase Request, Leave, etc.), then by the **requester's department** within that category, with a human-readable reference and description (item name, voucher description, leave type) instead of a bare entity id — so a role that approves several kinds of request (Admin, Management) can scan the queue by what it is and where it came from at a glance (`GET /api/approvals/pending`).

## Purchase vs. Store & Inventory (separate sidebar sections)

The old combined **Purchase & Store** group is now two: **Purchase** (Purchase Requests, Purchase Orders, Vendors) and its own **Store & Inventory** section. Store & Inventory is one page with three spreadsheet-style tabs across the top, like sheet tabs in Excel:

- **Item Master** — add items (with unit, category, HSN code, rack/location, reorder level) and see the full item list with live stock and a printable barcode. Every item gets a **barcode auto-generated on creation** — a proper EAN-13 check-digit code in the `20xxxxxxxxxxx` range, which GS1 reserves for internal/in-store use so it never collides with a real product barcode. A **Download Template / Upload Filled Template** pair (`GET/POST /api/masters/items/template` & `/bulk-upload`) lets you bulk-add items from Excel; barcodes are still generated automatically for every uploaded row.
- **Stock In / Out** — the receive/issue form now sits behind a **Scan Barcode** box: click into it and scan with any USB or Bluetooth barcode scanner (they type the code and hit Enter, exactly like a keyboard), or type a code by hand, and it selects the matching item automatically. A **Download Template / Upload Filled Template** pair (`GET/POST /api/purchase/store/movements/template` & `/bulk-upload`) bulk-applies IN/OUT movements from Excel — each row can reference an item by either its Item Code or its barcode.
- **Challans** — unchanged from before (GST delivery challan builder, Print, Download PDF), just relocated onto its own tab within Store & Inventory instead of being stacked on the same page as everything else.

## More Excel bulk-upload templates

Following the same **Download Template → fill it → Upload Filled Template** pattern used for Employees:

- **Vendors** (`GET/POST /api/masters/vendors/template` & `/bulk-upload`) — bulk-add vendors (name, contact, phone, email, address, GSTIN, category).
- **Attendance** (`GET/POST /api/hr/attendance/template` & `/bulk-upload`) — bulk-mark attendance for any date range; matches employees by Employee Code, validates the status against the allowed list (Present/Absent/HalfDay/Leave/Holiday/WeekOff), and re-uploading the same employee+date overwrites that day rather than duplicating it.

Every bulk upload reports how many rows were inserted vs. skipped, with a plain-English reason next to each skipped row (missing required field, unrecognized department, duplicate code, etc.) so a partially-wrong file still processes the good rows instead of failing the whole batch.

## Round 3

Nine feature areas added on top of Round 2:

1. **Job Card ↔ Sales Order Annexure + attachments.** A job card's detail view now shows a read-only download link to its parent sales order's annexure (joined project → sales_orders) plus a multi-file attachments list (already had `job_card_attachments`; wired the annexure link into `GET /api/projects/job-cards/:id/detail` and the app.js detail panel).
2. **"Projects & Production" renamed to "Projects Management"** — display label only, internal page ids/keys unchanged.
3. **Department Reporting** — `GET /api/reports/department/:stage` returns status counts (Pending/InProgress/Completed/OnHold/Delayed), average cycle time, and active job cards with days-in-stage, gated to that department's HOD/Supervisor (or Admin). Surfaced as **Overview → Department Report**.
4. **Store & Inventory split** into three top-level pages — **Item Master**, **Stock In/Out**, **Challans** — replacing the old in-page tab switcher. All existing functionality (barcode scan, bulk upload, PDF/print) is unchanged, just relocated.
5. **Service Request overhaul** (largest item): a new `service_reports` table backs the full lifecycle — employee sees scheduled requests under **My Service Requests** (`GET /api/service/mine`, matched via `users.employee_id`), fills a Service Report (type of service/issue, machine, problem/resolution, pending items + comments, travel/service/spares amounts, hand-written report upload) with Save Draft / Submit. On Submit: `pending_items=true` reopens the parent request (`status='Pending Items'`); `pending_items=false` moves the report to `Reconciliation`. **Service → Reconciliation** reviews/approves amounts (writes a `finance_ledger` inflow row) and rolls approved reports into a **Monthly Reconciliation** view with a "Submit to Accounts" action (`submitted_to_accounts_at`/`_by`). **Service Reports Dashboard** shows status counts (pending/delayed/ongoing/held/pending-items) and week/month/year trend tables.
6. **Leave Balances Master reworked** to Company/Department scope. New `leave_balance_policies` table (`scope`, `department_id` NULL for Company, `leave_type_id`, `year`, `allocated`). Resolution order: per-employee manual override (`employee_leave_balances`, kept for back-compat) → Department policy → Company policy → leave type's own `annual_quota`. The UI is now a **Company-wide Leave Policy** panel + **Department Overrides** panel + a read-only resolved **Employee Balance Lookup**, instead of a big per-employee grid.
7. **Finance module consolidation.** New `finance_ledger` table (type, reference, department, amount, direction Inflow/Outflow). Hooked at: **Expense Voucher mark-paid** (Outflow), **Payroll mark-paid** (Outflow), **Salary Advance request** (Outflow) and **advance installment recovery during payroll** (Inflow), and **Service Report reconciliation approval** (Inflow). Purchase orders were *not* hooked — they track quantity/status, not a "paid" event, so there's no natural trigger point without a larger PO-payment feature. New **Finance → Finance Ledger** page with month totals, breakdown by type/department, and a filterable ledger table (`GET /api/finance/ledger`, `GET /api/finance/summary?month=`).
8. **Dashboard: project drill-down + windowed widgets.** Dashboard now has a **Project Drill-Down** picker showing overall progress %, per-department progress, and per-sub-process progress within Manufacturing (`GET /api/dashboard/project/:id/drilldown`, progress = completed / total job cards at each level). A **Daily/Weekly/Monthly** toggle drives three widgets: Inventory (stock in/out totals for the window), Operating Expenses (sum of `finance_ledger` Expense entries), and Upcoming Schedules (job cards and service requests due in the window) — `GET /api/dashboard/window-summary?window=`.
9. **User Access: department or individual grants.** New `extra_page_access` table, additive on top of the existing role-based matrix: grant one page to an **Entire Department** (current + future users, resolved live off `users.department_id`) or to **Specific Users** (multi-select checkboxes). Checked in `GET /api/auth/my-pages` alongside the role config. Admin-only, under **Admin → User Access**.

**Scope notes / deliberate simplifications:** the Finance ledger hooks are best-effort at the clearly identifiable payment events listed above, not a full retrofit of every money-moving code path (no double-entry accounting, no PO-payment hook). The Dashboard's per-sub-process progress uses a simple completed/total ratio rather than weighted effort. Demo seed users are now linked to matching `employees` rows (`employee_code` = username, uppercased) so "My Service Requests" has real data to key off in the demo environment — this wasn't previously the case since `users` and `employees` were unlinked for demo logins.

## Round 4: clickable stat-tile drill-downs

Every stat "card" in every reporting/summary block — **Dashboard** (Active Employees, Active Projects, Open Leads, Pending Expense Vouchers, Pending Leave Requests, Pending Purchase Requests, Low Stock Items, Open Service Requests, plus the Stock In/Stock Out/Operating Expenses window widgets), **Department Report** (Pending/In Progress/Completed/Delayed/On Hold/Avg Cycle Time), **Service Reports Dashboard** (Pending/Ongoing/Held/Pending Items/Delayed/Resolved/Total), and **Finance Ledger** and **Cash vs Accounted Report** (Total Inflow/Outflow/Net, Total Accounted/Cash) — is now clickable. Clicking a tile toggles an inline detail panel directly beneath the cards row (same expand/collapse pattern as the Dashboard's existing Project Drill-Down), showing the underlying records for that stat plus added analysis appropriate to it — a breakdown-by-category/department/status bar chart (reusing the existing div-width progress-bar style, no charting library), ageing (days pending/open/delayed), and, for Low Stock Items, how far each item is below its reorder level. All detail data is fetched from existing endpoints (`/hr/employees`, `/projects`, `/sales/leads`, `/finance/expense-vouchers`, `/hr/leave-requests`, `/purchase/requests`, `/purchase/store/low-stock`, `/service`, `/purchase/store/movements`) and filtered/grouped client-side — no new backend routes were needed. Implemented via a small reusable `statCard()`/`showStatDetail()` pair in `app.js` so future reporting pages can opt in the same way.

## Round 5

Six feature areas:

1. **Extensive Vendor Master (GST-compliant).** `vendors` table expanded with legal/trade name, GSTIN (15-char regex-validated, not live-verified), PAN, vendor type, MSME/Udyam flag + number, full address (line1/2, city, state, state code, pincode, country), bank details, payment terms (dropdown + days), category, status (Active/Inactive/Blacklisted), and a dedicated PO/document delivery email. `routes/masters.js` POST/PUT and the bulk-upload Excel template were updated to match; `public/js/app.js` Vendors page form is grouped into Company Details / GST & Compliance / Address / Bank Details / Contact & Terms.
2. **Purchase Order PDF, Word, and Email.** `lib/poPdf.js` (puppeteer-core, same pattern as `lib/challanPdf.js`) and `lib/poDocx.js` (`docx` package, same pattern as `lib/annexureDocx.js`) render a PO with company letterhead, vendor GSTIN, item/qty/rate/GST breakup, terms, and signatory line. `GET /api/purchase/orders/:id/pdf`, `GET /api/purchase/orders/:id/docx`, and `POST /api/purchase/orders/:id/email` (emails the PDF to the vendor's PO email, CC'ing the configured default list, with a friendly non-crashing message if SMTP isn't configured). Buttons wired into the Purchase Orders table row. `purchase_orders` gained `hsn_code`, `gst_rate`, `gst_amount`, `terms`, `delivery_date`.
3. **Company Settings.** New `settings` key-value table (`lib/settings.js`) holding a `company` JSON blob (legal/trade name, GSTIN, PAN, CIN, registered + factory address, state/state code, default place of supply, bank details, authorized signatory, logo, default GST rate) and an `email` JSON blob (SMTP host/port/user/pass/secure, from name/address, always-CC list). Admin-only **Admin → Company Settings** page; `GET/PUT /api/settings/company`, logo upload via `POST /api/settings/company/logo` (reuses the existing multer disk-storage pattern, saved under `public/uploads/company/`), `GET/PUT /api/settings/email`. This is the letterhead source for PO and Invoice PDFs/Word docs.
4. **Finance: Sales Invoices, Operating Expenses, GST Summary.**
   - `POST /api/finance/invoices/from-sales-order/:soId` generates a tax invoice from a sales order: sequential numbering per Indian financial year (`INV/2025-26/0001`, counter kept in `settings`), CGST+SGST when the buyer's state matches Company Settings' state, otherwise IGST, per-line HSN/SAC and configurable GST rate (defaults to Company Settings' default rate). Stored in new `sales_invoices` + `sales_invoice_items` tables; `lib/invoicePdf.js` renders the PDF (amount-in-words included); `POST /api/finance/invoices/:id/mark-paid` feeds an Inflow row into `finance_ledger`.
   - **Operating Expenses**: existing `expense_vouchers` already cover department-raised expense claims — left untouched. A new, simpler `operating_expenses` table + `GET/POST /api/finance/operating-expenses` covers non-department overheads (rent, utilities, subscriptions), also feeding `finance_ledger` as an Outflow.
   - **GST Summary**: `GET /api/finance/gst-summary?from=&to=` sums Output GST (CGST+SGST+IGST from `sales_invoices`) against Input Tax Credit (`gst_amount` on `purchase_orders`), returning Net GST Payable. Surfaced as **Finance → GST Summary** with an explicit on-page note: *reference only, not an official filing tool — verify with your GST practitioner.*
5. **Asset Management.** New `assets` + `asset_maintenance_logs` tables and `routes/assets.js`: CRUD for assets (code, name, category, purchase date/value, vendor, department/location, custodian employee, useful life, straight-line depreciation with a computed `book_value`, status Active/UnderMaintenance/Disposed/EOL, disposal date/value), maintenance/repair log CRUD (type, cost, performed by, next due date — a Breakdown/Repair entry auto-flips an Active asset to UnderMaintenance), and two report endpoints (`/assets/due-for-maintenance`, `/assets/nearing-eol`, the latter a simple book-value ≤ 15% of purchase-value heuristic). New **Asset Management** nav group: Asset Register (with maintenance log per asset) and a Maintenance/EOL report page. `asset.manage` permission granted to Store (Admin bypasses everything as usual).
6. **Ticketing.** New `tickets` + `ticket_comments` tables and `routes/tickets.js`: any authenticated user can raise a ticket (subject, description, category, priority, target department); `GET /tickets/mine` (raised by me), `GET /tickets/department` (department queue — HOD/Supervisor and Admin see the whole department queue, a regular member sees only tickets assigned to them), `PATCH /tickets/:id` for status (Open→InProgress→Resolved→Closed, plus Reopened) and assignee, `POST /tickets/:id/comments` for threaded replies. New **Tickets** nav group: Raise a Ticket, My Tickets, Department Tickets, with a detail/thread view. Attachments are now wired in (Round 6, see below).

## Round 8g: fixed "HOD can't see their Job Cards tab", added user editing

Root cause: nothing in Users & Roles let an Admin set the "Supervisor/HOD" flag on a user, or fix a user's role/department after creating them - the only options were toggle active/inactive and link/relink an employee. So an account created with the department left blank (easy to miss - it's an optional-looking dropdown) got no Job Cards tab at all, and an account without the Supervisor flag couldn't act on the department's cards even if the role was otherwise correct - and there was no way to go back and fix either one short of deactivating the account and creating a new one. Reproduced exactly: creating a user with role "LaserBending" but no department left `department_name: null`, which is what boot()'s sidebar logic checks before showing that department's Job Cards group at all.

Fixed: Add User now has a Supervisor/HOD checkbox, and a warning appears inline if a department-scoped role (Design, Purchase, Electrical, Store, LaserBending, Manufacturing and its sub-processes, Assembling, Packing, Shipping, Installation, Service) is picked with no department selected. Users & Roles also gained a real Edit button per user - role, department, Supervisor flag, and an optional password reset are now all editable after the fact (`PUT /api/masters/users/:id`), so an account like Shubham1's can be corrected directly instead of being recreated. Verified via curl: created an account matching the reported misconfiguration (LaserBending role, no department) and confirmed it came back with no department name; edited it to add the department and Supervisor flag; confirmed the account then has a working department name and can reach its Job Cards queue.

## Round 8f: fixed employees with a blank name

Root cause of "unable to edit employee record" / employee name not showing up: nothing ever required a Full Name when adding an employee. Add Employee had no client- or server-side check, so it was possible to save a new employee with that field left empty, which then sat in the Employees table forever as a blank row in the Name column with no obvious way to tell whose record it was. `POST /hr/employees` and `PUT /hr/employees/:id` now both reject a blank/whitespace-only name (400 with a clear message), and the Add/Edit forms check client-side too before submitting. Any employee that's already stuck with a blank name is now highlighted (a light red row plus a "(no name set)" label) in the Employees table with a banner pointing at it - click Edit on that row and fill in the name like normal; editing itself was never broken, there was just no way to tell which blank row needed fixing.

## Round 8e: fixed "waiting on handover" incorrectly blocking sub-assemblies

Bug: starting work on an HOD-allocated sub-assembly could fail with "Cannot start this stage yet - waiting on handover from Design" even though nothing was actually pending. Root cause: the handover-gate check that enforces genuine sequential chains (e.g. Manufacturing's Fitting must finish before Tacking can start) was also being applied to ad-hoc sub-assemblies, which inherit their parent department's stage name (so a second sub-assembly under Design showed as "waiting on handover from Design" — that was really just an earlier sibling sub-assembly, not the parent stage). Sub-assemblies are independent, parallel pieces of work an HOD can hand out to different team members - they were never meant to queue behind each other. The gate (`PATCH /projects/job-cards/:id` in routes/projects.js) now only applies to genuine sequential sub-processes (`is_adhoc = 0`, e.g. Manufacturing's Fitting/Tacking/Welding/Buffing/Painting), so sub-assemblies can now be started and completed in any order/in parallel, and can still each be routed on to another department individually once their own work is done ("Route to Department" already worked per-card, this only needed the false block removed). Verified via curl: two sibling sub-assemblies under the same Design card both start successfully with neither complete, while Manufacturing's real Fitting→Tacking sequence still correctly blocks Tacking until Fitting is handed over.

## Round 8d: Assembling/Packing/Shipping/Installation grouped under Manufacturing

Per follow-up, these four downstream stages no longer get their own separate top-level tabs — they're now items inside the same "Manufacturing" sidebar group as its sub-processes: Overall, Fitting, Tacking, Welding, Buffing/Sandblast, Painting, Assembling, Packing, Shipping, Installation, all in one place, reflecting how they follow on from Manufacturing in the pipeline. Each is still its own independent job-card queue underneath (Assembling/Packing/Shipping/Installation aren't part of Manufacturing's combined query, just grouped alongside it in the sidebar) — only the sidebar organization changed. Verified in an actual rendered browser via a Puppeteer sidebar check, not just curl.

## Round 8c: department tabs done properly, sub-assembly visibility, project pipeline view

Round 8b's fix still put every department's Job Cards tab in one place at the sidebar-structure level, and Purchase/Store's job-card tabs duplicated their existing dedicated groups instead of joining them — this round addresses both, plus a real gap in where allocated sub-assembly work shows up:

1. **Purchase and Store & Inventory's Job Cards now live inside their own existing groups** ("Purchase" gets a "Job Cards" item alongside Purchase Requests/Purchase Orders/Vendors; "Store & Inventory" gets one alongside Item Master/Stock In-Out/Challans) instead of creating a second, separately-named group that duplicated what was already there.
2. **Every other department — Design, Electrical, Laser & Bending Processing, Assembling, Packing, Shipping, Installation — keeps its own separate sidebar group**, since none of them already had one, each with a single "Job Cards" item.
3. **Manufacturing's tab now has real sidebar sub-items**, not just sectioned content inside one page: "Overall" plus one item per sub-process (Fitting, Tacking, Welding, Buffing/Sandblast, Painting), each independently clickable and showing only that section's cards.
4. **Sub-assembly allocation is now visible from the project itself.** Previously, once an HOD created a sub-assembly job card and allocated it to a team member, that assignment was only ever visible inside that department's own Job Cards workbench — opening the project's own Pipeline view showed nothing about it beyond a bare "(N sub-processes)" count. Opening a project's Pipeline now lists every sub-assembly/sub-process nested under its parent stage, each showing who it's assigned to and its allocated/started/completed timestamps, the same way the parent stage's own status already did (`GET /projects/:id/job-cards` now returns each top-level card's `children[]` with full assignee/timestamp detail, not just a count).

## Round 8b: separate department tabs, Manufacturing sub-process sections

Round 8's sidebar fix relabeled the per-department Job Cards tabs but still grouped all of them together under one combined "Department Job Cards" section. Per follow-up feedback, each department (Design, Purchase, Electrical, Store, Laser & Bending, Manufacturing, Assembling, Packing, Shipping, Installation) now gets its own separate sidebar group/tab for Admin/ProjectManager logins — not items inside a shared group — placed together right after Projects Management, in pipeline order. The Manufacturing tab additionally splits its queue into its own section per sub-process (Fitting, Tacking, Welding, Buffing/Sandblast, Painting) plus an "overall" section for the parent stage, instead of one flat mixed list — mirroring how the Manufacturing HOD's own sub-process planning is already organized.

## Round 8: Service Center stock automation, Time & Motion tracking, Dashboard metric picker, sidebar fix

Four items:

1. **Admin sidebar "missing" Design/Electrical/Manufacturing tabs — actual root cause found and fixed.** These were never actually missing: Admin/Project Manager logins get a per-department "Job Cards" tab for every pipeline stage, but it was (a) labeled "Design Job Cards" / "Electrical Job Cards" / "Manufacturing Job Cards" rather than the bare department name, and (b) appended as the very last group in the sidebar, below 11 other groups including Admin — easy to scroll past. Fixed both: the nav items now read plainly as "Design", "Electrical", "Manufacturing" (page titles still say "X Job Cards" once opened), and the "Department Job Cards" group is now placed right after Projects Management instead of at the bottom.

2. **Service Center stock automation** (Purchase/Store module). New `service_centers` master (city, contact, status). Stock is now tracked per service center (`service_center_stock`), separate from the central store's own `items.current_stock`. **Store → Service Center Transfers**: Store picks a center, adds item/quantity lines (validated against central stock, same as Stock In/Out), dispatch deducts central stock and logs the movement. The receiving side confirms actual received quantity per line — a shortfall auto-flags the transfer `PartiallyReceived`, and receipt increments that center's own stock. **Service report spares** are now real inventory lines (`service_report_spares`, item + qty + rate, tied to a service center) instead of only a free-text description and a rupee total — submitting a report with spares lines deducts that center's stock automatically, with a full audit trail (existing free-text field kept for backward compatibility). A **Service Center Reconciliation** page (with CSV export) rolls up, per center and company-wide, value dispatched vs received vs consumed vs on-hand vs expected, with the variance called out — this is the automated replacement for the manual Excel tracking, and it will surface shrinkage/loss the spreadsheet couldn't catch. Stock-level views (per-center and company-wide) round it out.

3. **Time & Motion tracking**, generic across every department (Design, Purchase, Electrical, Store, Laser & Bending, Manufacturing + its sub-processes, Assembling, Packing, Shipping, Installation — all share the same job-card mechanism, so this applies everywhere without per-department code). A job card now stamps `allocated_at` the moment an HOD assigns it to someone (reassigning to someone else restarts the clock, since the metric is "how long did *this* assignee sit on it"), on top of the existing `started_at`/`completed_at`. A new **Time & Motion Report** page (filterable by department, date range, assignee) shows allocation-to-start time (how long work sat before being picked up), start-to-completion time (actual work duration), and total cycle time, with per-department and per-assignee averages — the efficiency-improvement data asked for. Each job card's detail view also now plainly shows its allocated/started/completed timestamps.

4. **Dashboard: cross-department metric picker.** Rather than having to open each department's own report page to check one number, the Dashboard now has an "Add a Metric to Review" picker covering 14+ metrics spanning Sales, Purchase, Store, Service, HR, Finance, Projects/Time & Motion, and Tickets — each pulled from the same endpoint its home page already uses (no duplicated logic). Picked metrics appear as their own stat cards on the Dashboard, remain clickable for the same drill-down detail as on their home page, and are removable; the selection is remembered per browser.

## Round 7: Sales & Marketing overhaul

The Sales & Marketing module (Leads, Offers/Quotations, Sales Orders, Clients) was upgraded with seven CRM-grade features, on top of everything that already existed:

1. **Lead source tracking.** Leads now capture their own `lead_source` (Website, Referral, Cold Call, Exhibition, Existing Client, Advertisement, Other) at the point of enquiry, distinct from the client master's own free-text `source` field.
2. **Pipeline / Kanban view.** Leads/Enquiries now has a List/Kanban toggle. Kanban shows one column per stage (New, Quoted, Negotiation, Won, Lost) with drag-and-drop (plain HTML5, no library) to move a lead between stages; each card shows client, expected value, owner and days-in-stage. The original list view is untouched.
3. **Follow-up / activity log with reminders.** New `lead_activities` table backs a timeline on every lead (Call/Email/Meeting/Site Visit/Demo/Note, with notes and an optional due date). A new **Today's Follow-ups** page lists everything due today or overdue across the leads you own (Admin sees all), and a matching widget sits on the Dashboard.
4. **Lost-reason capture.** Moving a lead to **Lost** (from either the list or the kanban board) now opens a required reason picker (Price, Timeline, Competitor, No Budget, No Response, Requirement Changed, Other + free text) — `PATCH /api/sales/leads/:id/stage` rejects a Lost transition with no reason (400), so a lead can no longer go dark with no record of why.
5. **Customer 360 view.** A **View 360** action on the Clients page opens a single panel pulling together everything already in the system for that client — their leads (with stage), offers/quotations (with status), sales orders (with status/value) and a computed total business value — with no data duplication, just joined reads off existing tables.
6. **Quotation (offer) versioning.** The previously-unused `version` column on `offers` now does real work: editing an offer that's already past Draft (Sent or later) creates a new version instead of silently overwriting it — same `offer_no`, incremented `version`, linked via a new `parent_offer_id`. The offer builder shows a version-history panel with status and date per version, and any prior version's PDF stays downloadable.
7. **Sales analytics & targets.** New `sales_targets` table (company-wide or per-salesperson, by month) plus a **Sales Analytics** page: conversion funnel (New→Quoted→Negotiation→Won with stage-to-stage %), win rate, lost-reason breakdown, average sales cycle time, sales-rep-wise performance, and target-vs-achievement for the selected period. A **Sales Targets** page lets Admin/Sales set the targets that page reads against.

Verified via curl: lead created with a source, follow-up logged with a due date and surfaced correctly, Lost-without-reason blocked (400) and Lost-with-reason accepted, customer 360 returns the right joined data, editing a Sent offer forks a new version while the PDF for each version stays retrievable, the analytics endpoint returns funnel/win-rate/cycle-time/rep data, and a sales target round-trips through create → fetch.

## Round 6e: invoicing gaps filled

Three gaps in the Sales-Order → Invoice flow, closed per explicit request:

1. **Email invoice to client.** New `POST /api/finance/invoices/:id/email` — generates the invoice PDF (`lib/invoicePdf.js`) and emails it to the client's registered email (`clients.email`), same graceful no-crash behavior as PO emailing when SMTP isn't configured. "Email to Client" button added next to every invoice row on the **Sales Invoices** page.
2. **Duplicate-invoice guard + Cancel escape hatch.** `POST /api/finance/invoices/from-sales-order/:soId` now blocks generating a second invoice for a sales order that already has one in any non-Cancelled status, returning a clear error naming the existing invoice number. Since that would otherwise permanently block re-invoicing a mistaken Draft, a new `POST /api/finance/invoices/:id/cancel` lets a Draft/Sent invoice be cancelled (blocked once Paid) — a cancelled invoice no longer counts against the guard, so the sales order can be invoiced again. "Cancel" button shown on Draft invoices.
3. **Sales Order status sync.** Generating an invoice now flips the source sales order's `status` to `Invoiced` (unless it's already `Completed` or `Cancelled`), and the Sales Order dropdown on the invoice-generation form now shows "(already invoiced)" next to orders that have one, so it's obvious at a glance which orders still need billing.

Verified via curl end-to-end: create client+SO → generate invoice (`INV/2026-27/0001`) → SO status flips to `Invoiced` → second generate attempt correctly blocked → email endpoint responds gracefully with no SMTP configured → cancel the invoice → status becomes `Cancelled` → re-generate now succeeds with a new invoice number (`INV/2026-27/0002`).

## Round 6d

- **Issue to Production: project picker.** The Stock In/Out form's "Issue (OUT)" side previously had no way to tag which project the material was going to, even though the backend already supported an optional `project_id` (recorded as `Project#<id>` in the movement reference). Added a "Issue to Project (optional)" dropdown listing all projects; picking one tags the OUT movement so material consumption can be traced back to the project that used it.
- **Searchable item picker.** The single-item dropdown on Stock In/Out (previously one long `<select>`) is now a type-to-filter search box above a list box — type any part of the item name or item code and the list narrows live, useful once the Item Master has more than a handful of items.

## Round 6c

- **Stock In/Out: fixed "FOREIGN KEY constraint failed" crash.** `POST /purchase/store/receive` and `/store/issue` had no validation on `item_id` before inserting - an empty Item Master (or a blank picker) sent an invalid item reference straight to the database and crashed with a raw FK error instead of a usable message. Both routes now validate `item_id` (and `po_id`/`project_id` when present) up front and return a clear 400 error; `issue` now also names how much stock is actually available when there isn't enough. The Stock In/Out page itself now shows a clear banner and disables the form when the Item Master is empty, instead of letting you submit into a guaranteed failure.

## Round 6b

- **Stock In/Out: receive against an open PO.** The Stock In/Out page had no way to pick which Purchase Order a receipt was against, even though `POST /purchase/store/receive` always supported an optional `po_id`. Added a "Receive against PO (optional)" dropdown listing all currently `Open` POs (PO no, vendor, item, ordered qty); picking one auto-fills the item and quantity, and the receipt is now tagged with that PO (flips it to `Received`, and shows `PO#<id>` as the movement's reference) instead of only ever being possible to do blind/untraceable receipts.

## Round 6

- **Collapsible sidebar groups.** Each nav group header is now clickable and toggles that group's item list open/closed, with a chevron indicator. Collapsed state is remembered per browser (`localStorage`). Navigating to a page whose nav item lives inside a collapsed group auto-expands that group so the active page is always visible in the sidebar, never hidden.
- **Ticket attachments.** `'ticket'` added to the generic attachments whitelist in `routes/attachments.js`. The Raise a Ticket form now has an optional file input (uploaded right after the ticket is created), and the Ticket Detail view has an Attachments section (upload/list/remove) using the same reusable `renderAttachmentsWidget()` used elsewhere in the app.

### Email / SMTP configuration (required for PO and invoice emailing to actually send)

No SMTP service is bundled or assumed — `lib/mailer.js` reads config with **DB (Company Settings → Email Settings) overriding environment variables**, and no-ops with a clear "not configured" result (never a crash) when neither is set. To enable real sending in your own deployment, either:

- Set environment variables (see `.env.example`): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` (`true`/`false`), `SMTP_FROM_NAME`, `SMTP_FROM_ADDRESS`, `SMTP_DEFAULT_CC` (comma-separated), or
- Log in as Admin → **Company Settings → Email Settings** and fill in the same fields plus the CC list through the UI — these values take priority over the env vars once saved.

Every automated email (currently: PO to vendor) reads the CC list from settings and includes it automatically.

### Scope notes / deliberate simplifications

- GSTIN validation is a **format check only** (regex against the standard 15-character structure) — there is no live GST portal verification, and none should be assumed.
- The GST Summary report is a **reference/reporting aid**, not a filing integration; it is explicitly labeled as such in the UI.
- Asset depreciation uses a straight-line calculation only, as scoped; no other methods (WDV, double-declining, etc.) are implemented.
- Finance's "Operating Expenses" is intentionally a separate, simpler table from the existing department `expense_vouchers` (which already has its own approval chain) rather than a rebuild of that flow.

## Data model summary

Departments modeled: Admin, Marketing, Sales, Project Management, Design, Purchase, Store, Laser & Bending Processing, Manufacturing, Assembling, Packing, Shipping, Installation, Service & Spare Parts, Accounts/HR — matching the workflow you described end-to-end from enquiry to installation and after-sales service.

## Round 9: Service Report now replicates the printed field form

The "My Service Requests -> Fill Report" form (Service employees) captured only
a handful of fields. It now mirrors the printed Venkateshwara Engineers
"Service Report" pad used in the field: SL. No, customer name/address, contact
person/no, engineer name, Visit From/To dates and No. of Days at Site,
Activity Date/Start/End time, Machine Type (Simple/Duplex Bagging, Stitching,
Conveyor/Loader, Hyd. Loader/Stacker, Others) + Capacity, Type of Visit
(Installation/Commissioning, Warranty, AMC, Emergency, Additional), Reason for
Visit, Faults Found During Visit, Action Taken, Completion Remarks/Pending
Reasons, a Service Charge + Up/Down & Food charge line (in addition to the
existing Travel/Service/Spares amounts), Machine Working Satisfactorily
(Yes/No), visit rating (Excellent/Good/Average), Overall Feedback
(Satisfactory/Non Satisfactory), and Customer/Engineer remarks + mobile
number (the physical signature itself still lives on the uploaded
hand-written copy). All new columns are additive on `service_reports`
(migrated via ALTER TABLE, safe on existing DBs) and pre-fill from the linked
Service Request (customer, contact, scheduled date) where available.

## Round 10: Service Report cleanup, signature capture, service-center admin note

- Removed the legacy "Service & Support Details" fields from the Fill Report
  form (Type of Service, Type of Issue, legacy free-text Machine, Problem
  Identified, Resolution Provided) - the printed-form fields added in Round 9
  (Reason for Visit, Faults Found, Action Taken, Completion Remarks, Machine
  Type/Capacity) already cover the same ground. The Pending Items toggle
  (which drives the reopen-the-queue workflow) was kept, moved into its own
  "Follow-up" section. The underlying DB columns are untouched (harmless
  nulls going forward) so no data migration was needed.
- "Charges (as on printed report)" section renamed to just "Charges".
- SL. No is no longer a free-text field - it's generated automatically the
  first time a report is created for a request (sequential, based on the
  highest existing numeric SL. No), and is never editable afterwards.
- Added customer signature capture: a draw-with-finger/stylus canvas on the
  employee's phone/device, saved as a PNG under
  public/uploads/service-reports/signatures/ and shown read-only once the
  report is submitted. `service_reports.customer_signature_path` stores it.
- Service Centers Master (Store & Inventory > Service Centers Master) already
  supported full Add/Edit of service center locations (name, city, address,
  contact, phone, email, status) for Admin - confirmed working, no change
  needed there.

## Round 11: Monthly Expense Tracker module (replaces the team's tracking Excel)

Added a new "Finance" module for the day-to-day expense rollup the team was
maintaining in a spreadsheet for quick view (separate from the existing
Expense Vouchers approval workflow, which is per-transaction with sign-off -
this is a lightweight rollup, no approval chain):

- **Monthly Expense Tracker**: a day-wise grid for the selected month -
  Daily categories (Conveyance, Courier & Freight, Diesel, Tour Exp, etc.)
  across 31 day columns with live row/column/grand totals, plus a Fixed &
  Overhead section below for once-a-month lump sums (Salary, PF, ESIC,
  Electricity by meter, Rent by plot, festival allowances). Saving does a
  bulk upsert; clearing a cell to 0 removes that entry rather than storing
  a zero row.
- **Expense Tracker - Year Summary**: pulls every number live via SQL
  SUM/GROUP BY from what was actually entered in the monthly grids - never
  hand-retyped, so it can't drift out of sync the way the old Excel's
  summary sheet did.
- **Expense Tracker - Categories**: Admin/Accounts/HR can add, reorder, and
  deactivate categories (Daily or Fixed kind).

New tables `expense_tracker_categories` and `expense_tracker_entries`
(`db/schema.sql`), new permission `expense_tracker.manage` (granted to
Accounts and HR; Admin bypasses as usual; anyone with `report.view_all`,
e.g. Management/ProjectManager, gets read-only access), new route file
`routes/expenseTracker.js` mounted at `/api/expense-tracker`. Seeded with
the same 46 categories (20 Daily, 26 Fixed) used to clean up the original
Excel, so the module starts pre-populated rather than empty.

Also delivered a cleaned, formula-linked version of the original tracking
Excel (Expenses_Detail_2026_Cleaned.xlsx) for anyone still working from the
spreadsheet during the transition: standardized category names across all
12 months, split into Daily Operational vs Fixed & Overhead sections, a
Summary sheet with live formulas (no manual retyping), and a Notes sheet
documenting every cleanup decision (including a "Loan & Adv" double-count
that existed in the original file, now fixed).

## Round 12: Site Visit Tracker + Engineer Daily Work Log

Two new modules under the "Service" nav group, replacing the team's "DAILY
WORK" and "SITE STATUS" Excel tabs:

- **Site Visit Tracker**: site installation/service visits that stay open
  for days or weeks, with multiple engineers assignable to one visit at
  once (a real gap - Service Requests and job cards only support a single
  assignee). Four status buckets matching the original sheet's own layout -
  Pending (requested, not started), Working (on site), Hold (paused mid-
  visit, with a running "pending works" note), Closed - plus arrival/close
  dates and a free-text expenses note that can be updated while the visit
  is still open, not just at formal close-out like Service Reports.
  Optionally links to a Client/Project when the site corresponds to one,
  but doesn't require it - many entries in the source sheet were informal
  site names with no project record behind them.
- **Engineer Daily Work Log**: the "who's doing what today" roll-call the
  office was keeping by hand - one free-text cell per engineer per day for
  the whole team, month grid, same shorthand the team already uses ("OD",
  "A", "1/2") typed directly into the cell. Independent of the structured
  job-card allocated/started/completed timestamps elsewhere in the ERP,
  which don't capture a daily narrative.

New tables: `site_visits`, `site_visit_engineers` (join table for the
multi-engineer assignment), `daily_work_logs`. New permission
`site_visit.manage` (granted to Service and Electrical; Admin bypasses;
`report.view_all` roles get read-only). New route file
`routes/siteVisits.js` mounted at `/api/site-visits`.

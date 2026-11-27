# Working with this repo

Node/Express + `node:sqlite` ERP (Venkateshwara Engineers). Vanilla-JS SPA in `public/js/*.js` (13 classic scripts, see Frontend module map), routes in `routes/`, shared logic in `lib/`, schema in `db/schema.sql` + idempotent migrations/bootstraps in `db/index.js`. Feature history lives in git log and the graphify graph (`graphify-out/`), not here.

## Workflow rules (standing, from the repo owner)
- **Provide your understanding first and wait for confirmation** before building anything non-trivial. Applies to every ask of that size, standing, not only when the owner repeats the phrase (restated 2026-10-08).
- After building and end-to-end testing on `claude/got-push-qutr7d`: push, open a PR against `main`, and **merge automatically** (standing since 2026-09-29). Then resync the local branch with `origin/main` before the next task.
- **New sidebar page** = new entry in `NAV` (`public/js/core.js`) AND in `lib/pageCatalog.js` `PAGE_CATALOG`, same round. A page missing from the catalog can never be granted to an Admin-configured role and silently vanishes from its sidebar.
- **Collapse-by-default** for every new multi-item, grouped or repeating list UI (explicit expand control, never auto-expanded).
- **Overlay/dropdown/picker fields**: measure the real rendered width (`getBoundingClientRect()` against realistic siblings) before shipping. Eyeballing and checking ancestor overflow are not enough.
- Verify UI changes in a real browser (Puppeteer against a scratch server with `DATA_DIR` isolation), not just by reading code.
- **Every amendment must re-verify the existing behaviour in the area it touches**, not just the new ask (owner standard protocol, 2026-10-27). In the up-front write-up, name what existing behaviour will be re-checked, then actually re-check it before shipping.
- **A new entity with an FK into an order, or any new review-then-lock workflow, needs three things in the same round** (owner rule, 2026-11-20): (1) its cancel/reject route defines which statuses mean "never happened" vs "real, live activity", and `routes/sales.js` `DELETE /orders/:id` treats it that way (add it to `SALES_ORDER_STATUS_AWARE_CHILDREN`, mirrored in `scripts/diagnose-so-delete.js`); (2) any grandchild table reachable only through it gets its own delete guard, since the generic FK scan cannot see two hops; (3) a review-then-lock table gets `unlocked_by`/`unlocked_at` and a `POST .../unlock` route (`lib/reviewWorkflow.js` `unlock()`) from day one. Known, documented, unfixed gap: `fg_dispatches`, `sale_rejection_mrns`, `sales_returns` still hit the generic-scan block even when Cancelled/Rejected (each needs a careful cascade, not a blind delete).
- After pulling, run `npm install` (remote added `pptxgenjs`; the server will not start without it).

## Recurring bug classes (check these first)
1. **Route shadowing**: `GET /x/:id` registered before a literal sibling (`/x/template`, `/x/billable-po-lines`) swallows it. Always register literal routes first. Hit 4 times.
2. **Permission gate in front of correct app logic**: `requirePermission()` rejects a role before the in-handler role check runs (Accounts/`bg.manage`, Management/`sales_order.manage`, `purchase_*`, `item.manage`). Grant the permission, and backfill the `permissions` code row itself (seed.js only runs on a fresh DB).
3. **Role name vs department name**: `getDepartmentEmailIdentity('Service')` silently returned `{}`; the department is `'Service & Spare Parts'`. String lookups that resolve to "nothing configured" fail silently.
4. **Un-parallelized page loads**: independent reads must be one `Promise.all`. Un-indexed correlated subqueries (`stock_movements.reference`) hurt too.
5. **Table-per-group layouts**: N independent `<table>`s compute different column widths. Use one table with several `<tbody>`, or CSS grid (`gridLineTableHTML`, `.row-actions`).
6. **Blanket status writes on multi-line groups** (a PO `po_no`, FOC `foc_no`): only touch lines actually in the cycle; never reset a line with real stock/closed status.
7. **Blank form values**: `''` is not `undefined`. A REAL column given `''` stays TEXT and later concatenates instead of adding. Coerce with a `pickNum`-style helper; blank never overwrites an existing value.
8. **`position:absolute` overlays inside `overflow:auto` wrappers** clip; use `position:fixed` anchored to a stable element (the search input), not the select that grows.
9. **Hand-maintained lists that must stay in sync with the schema or with each other**: the SO-delete blocker list silently missed 9 tables. Discover from `PRAGMA foreign_key_list` at request time (`findForeignKeyBlockers`, `ORDER_DELETE_CASCADE_TABLES`) instead of listing tables by hand.
10. **Same filter copied into several places** (a dashboard stat tile, its drill-down list, the Pinned Metrics widget) drifts: three independent "Open Service Requests" filters disagreed on Rejected. Define the filter once and reuse it.
11. **New permission rule not applied to its sibling routes**: `requirePlanAccess` was added but Exclude/Include stayed on `project.manage`. When widening a gate, grep every route that acts on the same screen.
12. **Date "today" via `toISOString()`** is always UTC. Use `lib/dateUtil.js` (see IST below).

## Architecture conventions
- **Approvals**: one generic engine (`lib/approvals.js`: `startApproval`, `canAct`, `provideMoreInfo`); chains live in `approval_chains`/`approval_chain_steps`. Each step matches ONE fixed `approver_role_id` (+ `requires_supervisor` for "that department's HOD"), so cross-department chains route to a single owning department, not the raiser's. Every chain is created by an idempotent `bootstrapXxx()` in `db/index.js`, called from `server.js` on boot (`INSERT OR IGNORE`/`ON CONFLICT DO NOTHING`). A change to an *existing* chain must be a one-time flagged migration (a `settings` flag), not a boot-time `DO UPDATE`, or it overwrites Admin edits.
- **Entity status sync**: `routes/approvals.js` `syncEntityStatus()` maps approval outcome to entity status; add `describeEntity()`, `ENTITY_LABELS`, `SLA_DAYS`, `ENTITY_TABLE` and `routes/attachments.js` `VALID_TYPES` for each new entity. `resolveEntityRef()` in `lib/approvals.js` supplies real document numbers for notification emails.
- **Notifications**: `notifyNewPendingStep()` sends ONE shared email (first approver in To, rest in Cc). Templates live in `lib/emailTemplates.js` (`{{token}}`, Admin-editable via `/admin/email-templates`); department SMTP identity via `lib/departmentEmail.js` -> `lib/mailer.js` `resolveConfig()` (department > global DB settings > env).
- **Draft-first documents**: PR/PO are created `Draft`, edited freely, then `submit-for-approval`. Editing anything already in approval re-submits it. Creator may edit until approved; after that only an approver (`isPurchaseApprover`: Admin/Management/Purchase HOD).
- **Multi-line documents** are several rows sharing one number (`po_no`, `foc_no`, `grn_batches`), not header+child tables. Actions on the group resolve every sibling from the clicked row.
- **Derive, don't store, running totals**: received qty (`poReceivedQty`), billable/dispatchable/rejectable qty, paid/due, ledgers are computed live from source rows (`lib/purchaseOrders.js`, `lib/soItems.js`, `lib/vendorLedger.js`, `lib/soaLedger.js`). Quantities are reserved by any non-cancelled in-flight document.
- **Admin-editable settings** go in `lib/settings.js` JSON blobs (`DEFAULT_X`/`getX`/`setX`), `GET` open to authed users, `PUT` Admin-only. Role page visibility = `lib/pageCatalog.js`; role action permissions = `lib/permissionCatalog.js` + Admin "Role Permissions" screen (revocable; do not add boot-time grants for things Admin should control).
- **Schema changes**: plain `ALTER TABLE ADD COLUMN` via the idempotent migration array in `db/index.js`. Dropping a constraint needs a table rebuild built off `PRAGMA table_info()`/`foreign_key_list()` with `PRAGMA foreign_keys=OFF` outside the transaction and trigger drop/recreate (see `migrateOffersClientIdNullable`). Test upgrades against a pre-migration copy.
- **Documents/PDFs**: generators in `lib/*Pdf.js`/`*Docx.js` take pre-loaded data. Dates use `lib/dateFormat.js` `formatDate()` (DD/MM/YYYY). Signatures print literal "Authorized Signatory" + a per-document designation. Offers PDF is the only Offer export (Word export was removed 2026-09-30). Cancelled PO lines are excluded from the vendor-facing PO document and its totals.
- **Offers**: `offer_format` Standard|Spares (Spares drops cover/profile/data-sheet/equipment pages; Unit, Discount, Remarks, Picture columns appear only when used). Standard Templates are `is_template=1`, `client_id` NULL, Admin-only to edit; reuse = `POST /:id/copy`. Confirm Order hard-blocks without a Billing address (Line1/State/State Code) and client GSTIN. Root-creator visibility via `lib/offerVisibility.js` when `restrict_offers_to_creator` is on.
- **Auth/session**: JWT 24h; `api()` clears the token and shows login on any 401.
- **Time zone is IST everywhere.** `server.js` sets `process.env.TZ = 'Asia/Kolkata'` first; use `lib/dateUtil.js` (`localDateStr`/`localMonthStr`/`localDateTimeStr`/`localDateFromValue`) for "today/now", never `new Date().toISOString().slice(0,10)`. The frontend has its own local-getter equivalent. DB timestamps default to an IST expression (not `CURRENT_TIMESTAMP`); stored SQLite strings have no zone marker, so parse with the helpers, not `new Date(str)`. A one-time flagged migration rebuilt every table that still used `CURRENT_TIMESTAMP`.
- **Order delete**: `DELETE /orders/:id` blocks on any live FK into `sales_orders`/`projects`/`job_cards` discovered at runtime, excluding `ORDER_DELETE_CASCADE_TABLES` (safe to delete alongside) and checking status-aware children explicitly. Polymorphic `bank_guarantees`/`payment_milestones` keep their own check.
- **Permissions**: role grants live in `role_permissions` (Admin "Role Permissions" screen). Per-user grants: `extra_page_access` = page visibility only; `extra_permission_access` = an actual permission code, checked in `middleware/auth.js` `hasPermission()`, so every `requirePermission()` route honours it with no per-route change. Project planning uses `requirePlanAccess` / `requirePlanAccessForJobCard` (`project.manage`, or `project.plan_spares` scoped by `project_plan_spares_mode`).
- **Email CC policy**: the Company Settings CC list rides only on the weekly department-wise pending-approvals digest. First "awaiting approval", Approved/Rejected outcome and escalation mails pass `skipDefaultCc: true`. Escalation reminders repeat at 24h/12h.
- **PDFs in the browser**: every PDF button goes through `openOrDownloadBlob()` (popup with explicit Preview / Download). Filenames come from the server `Content-Disposition` (dispatch PDFs, offers); the frontend must honour it. All non-Offer PDFs share the standardized company letterhead (`lib/pdfBranding.js`), and PO/FG Word exports mirror their PDF layout.
- **System To-Dos** auto-close when the real-world event happens (`lib/systemTodos.js`); user To-Do completion goes through a Management review (`TodoCompletion` chain).
- **Locks**: offer-immutability triggers (`trg_offers_locked_*`) must be dropped/recreated around any `offers` table rebuild. Review-style records (`annexure_reviews`, `order_confirmations`) use `lib/reviewWorkflow.js`; Admin `unlock` is the only way out of Approved.

## Frontend module map (`public/js/`)
Thirteen plain classic scripts, no bundler, all `defer`, executed in this order (see the script tags in `public/index.html`). Top-level `let/const/function` names are shared across files, so code may call helpers from any file **at run time** but must not touch another file's top-level names at load time unless that file loads earlier.

1. `core.js` - state (`TOKEN`, `ME`, `PERMS`), `api()`, auth/login, permission helpers, `boot()`, `NAV`, sidebar, `navigate()`, and `const PAGES = {}` (must exist before any page file).
2. `ui.js` - `esc`, `tableHTML`/`gridLineTableHTML`/`sortableTableHTML`, pickers, `collapsiblePanel`, `openAppModal`, bulk-upload helpers, panel drag-reorder.
3. `dashboard.js` - Dashboard, stat drill-downs, Department/Time & Motion reports, Vendor Analytics, To-Do board.
4. `approvals.js` - My Approvals, GRN batch cards, approval drilldown.
5. `projects.js` - Projects, Targets, Department Capacity, Job Cards.
6. `service.js` - Service requests, Service Centers, Site Visits, Daily Work Log.
7. `sales.js` - Clients, Leads, Orders, FG Dispatch, MRN, Sales Returns, Credit Notes, Offers, Spares Comparison, Sales Analytics/Targets.
8. `purchase.js` - Vendors, PR, PO, RFQ Dashboard, Purchase Velocity, Overdue Items, Store/Stock In-Out/Challans.
9. `hr.js` - Employees, Referral/Salary pages, Attendance, Leave, Advances, Payroll, Technician Tour Expenses (incl. the Finance-group review page), Leave Balances.
10. `finance.js` - Expenses, BG, Foreign Payments, Ledger, FOC, Sales/Purchase Invoices, SOA, Operating Expenses, GST.
11. `admin.js` - Offer Options/PDF Designer, Users, Access, Approval Matrix, Company Settings, Assets, Tickets, data tools.
12. `modpolish.js` - Apple-HIG UI polish for Purchase / Store / Finance / Electrical & Service and Sales & Marketing (`mod-sales`; its list/entry tables are classified centrally by `higTagTables()`, so a new Sales table needs no per-page class; all Sales and Dashboard dates go through `fmtDMY()` in `ui.js`): wraps those `PAGES` entries (and popups opened from them) in `.hig-mod-scope`, owns all of that CSS, stamps `data-label`s so mobile line grids become cards. Add a new page of those four modules to `HIG_PAGES` there. Loads after every page file.
13. `app.js` - entrypoint only (boot on load); keep it LAST so every `PAGES` entry exists first.

Page placement follows the file, not always the NAV group (e.g. `sales-returns` lives in `sales.js`, `overdue-items` in `purchase.js`). NAV groups: Settings (was Admin), plus an "Unused" group for leads/pipeline/followups/sales-analytics/sales-targets.

New page: add its `PAGES[...]` in the domain file that owns its NAV group, add the `NAV` entry in `core.js`, and `PAGE_CATALOG`. A new script file must be added to `index.html` before `app.js`.

### Known gap
- The **RFQ Dashboard has no standalone "Create RFQ" modal yet**. Only PR-linked RFQ creation exists (the per-PR composer). `purchase.js` mentions a standalone flow in a comment, but the code was never built; it still needs building (Draft/Send Now, PR picker, vendor multi-select).

## Frontend conventions
- Pages are `PAGES['id']` render functions; shared helpers: `api`, `esc`, `tableHTML`, `gridLineTableHTML`, `sortableTableHTML`, `actionButtonsCell` (wrap every row-action cell), `collapsiblePanel`, `reorderablePanelsHTML`, `searchPickerHTML`/`itemPickerHTML`, `openAppModal`/`closeAppModal`/`confirmSavedThenClose` (Edit actions are popups with "Saved ✓" confirmation).
- Panel drag-reorder is gated behind "Edit Widget Layout" mode. Sidebar: groups A-Z, per-session expand state, Admin-configurable global order, live count badges via `PAGE_PENDING_COUNT_ENDPOINTS` baked into `renderSidebar()`.
- Lazy-build heavy per-row forms on first open; keep modal forms out of the initial DOM.
- Run `node --check` on every file in `public/js/` before every commit (a parse error blanks the whole app).

## Domain rules worth remembering
- GST: CGST+SGST if party state code == company state code, else IGST. TDS deducted on taxable value, not GST-inclusive total.
- PO approval: Purchase HOD always, then Management above the Admin-editable threshold (default Rs 50,000). Freight + its GST counted once, never per line. Purchase Invoice booking is blocked until the GRN is Approved by Store HOD (`poLineReconciledQty`).
- FG Dispatch: Accounts HOD then Management, always required; hard payment gate overridable by Management/Admin only; approval completes the Packing/Shipping job cards and moves the Sales Order to `Dispatched`/`PartiallyDispatched` (`lib/soItems.js` `markFgDispatchApproved`, also used by the no-chain auto-approve path; `Completed`/`Cancelled`/`Invoiced` are never overwritten). Overdue Items measures pending qty from APPROVED (`Dispatched`) dispatches only via `soDispatchProgress` - `soLineDispatchedQty` is the reservation count (includes PendingApproval) and must not be used for it. The SO delivery-reminder scan (`lib/bgReminderScan.js`) uses the same `soDispatchProgress` measure, so a fully dispatched order raises no due/overdue notification.
- Dashboard (`routes/dashboard.js`, `public/js/dashboard.js`): a tile / pinned metric / chart a role cannot open is hidden, not left to 403 (`dashCanSee()` mirrors the endpoint's permission and the sidebar page; the server returns null / [] for expense figures without `expense_voucher.view_all`). Windows are exact Today / last 7 / last 30 IST days, inclusive. "Operating Expenses" reads the `operating_expenses` table (the ledger type 'Expense' is no longer written). A Cancelled Sales Order's project is not Active (`order_cancelled` on `GET /projects`; also excluded from Overdue job cards and Upcoming Job Cards). Sales Target achievement excludes Cancelled orders. A multi-line PO is one PO in every count (sidebar badge, Overdue Items). Compare dates / ages with `localDateStr()` or `'localtime'`, never SQLite's UTC `date('now')` / `julianday('now')`.
- Job cards: manual routing is blocked to departments already in the project's planned sequence; Admin recall (`job_card.recall`) only if no downstream work started; capacity warning (not a block) at 3+ projects per department per day.
- Expense Voucher: Management -> Accounts, Mark Paid needs a payment reference and auto-creates the Operating Expense via the Admin category map.
- Store: one consolidated, invoice-mandatory batch receipt per PO (`POST /store/receive-batch`); Short Ship closes a line without touching received history; Cancel is blocked on Closed lines.
- Removed on purpose, do not rebuild without asking: Offer Word (.docx) export; sidebar logo (login screen keeps it).

## Testing
- Scratch server with isolated `DATA_DIR`, fresh seed; test both fresh install and upgrade path for migrations. Test as the real non-Admin role (Admin bypasses permission checks and hides gate bugs).
- `scripts/consolidate-historical-grn.js` is dry-run by default; `--apply` is transactional and backs up first.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- graphify-out/ is local and gitignored (listed in .gitignore), so graph.json is rebuilt on each machine and never appears in pull requests. Run `graphify update .` after code changes; do not commit graphify-out/.

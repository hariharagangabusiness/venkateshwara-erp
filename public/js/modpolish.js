// ===================== Module UI polish (Apple-HIG pass, 2026-11-26; Sales & Marketing, HR, Projects, My Approvals, Dashboard added 2026-11-27) =====================
// Purchase, Store, Finance, Electrical & Service, Sales & Marketing, HR, Projects, My Approvals and Dashboard screens. Loaded after every page file and before app.js, so
// every PAGES entry already exists when it is wrapped here. Each wrapped page renders into
//   <div class="hig-mod-scope mod-<purchase|store|finance|electrical|sales|hr|projects|approvals|dashboard> hig-page-<id>">
// and every CSS rule below starts with .hig-mod-scope (or .hig-entry / .hig-savebar, which only exist inside it; the Sales-only
// block starts with .mod-sales, the HR / Projects / Approvals / Dashboard block with :is(.mod-hr, .mod-projects, .mod-approvals,
// .mod-dashboard)), so Settings and every other screen are untouched. Popups opened while a module page is current get the same
// class on their .app-modal-box. Nothing here touches the backend, core.js, ui.js or another module's page file.
//
// Sizing follows the HIG ask (12px cards, 8px controls, 40px / 44px-on-mobile hit areas); colours stay on the DESIGN.md
// tokens. Dense in-table inputs stay 36px on desktop and row buttons (.btn.small) stay 32px; both go to 44px on mobile.
const HIG_PAGES = {
  purchase: ['purchase-requests', 'purchase-orders', 'rfq-dashboard', 'purchase-velocity', 'vendors'],
  store: ['store', 'stock-in-out', 'challans', 'service-centers', 'sc-transfers', 'sc-stock'],
  finance: ['expenses', 'expenses-mine', 'expense-report', 'foc', 'finance-ledger', 'sales-invoices', 'purchase-invoices', 'soa',
    'operating-expenses', 'gst-summary', 'bg-dashboard', 'foreign-payments'],
  // daily-work-log is left out on purpose: it already ships its own self-contained dwl-* design system.
  // monthly-reconciliation is left out because it just renders service-recon, which is wrapped below.
  electrical: ['service', 'service-mine', 'service-recon', 'service-reports-dashboard', 'service-reopenings', 'sc-receive',
    'sc-reconciliation', 'site-visits', 'dept-capacity'],
  // Sales & Marketing (2026-11-27). Left out on purpose: sales-analytics / sales-targets (parked chart pages) and the two
  // admin.js offer pages (offer-options, offer-pdf-designer). Proforma Invoices live on 'sales-invoices' (finance, above).
  sales: ['leads', 'pipeline', 'followups', 'offers', 'orders', 'fg-dispatches', 'sale-rejection-mrns', 'sales-returns',
    'sales-credit-notes', 'clients', 'spares-comparison'],
  // HR, Projects, My Approvals, Dashboard (2026-11-27). Left out on purpose: dept-capacity (already Electrical), To-Do / Department
  // Report / Time & Motion Report (same file as the Dashboard but not part of this pass). Job-card boards of every stage that is not
  // Purchase / Store / Electrical fall through to 'projects' in higModuleOf().
  hr: ['employees', 'attendance', 'leave', 'advances', 'payroll', 'leave-balances', 'referral-incentives', 'salary-hikes',
    'salary-hike-cycles', 'salary-report', 'tour-expenses-mine', 'tour-expenses-review'],
  projects: ['projects', 'targets'],
  approvals: ['approvals'],
  dashboard: ['dashboard'],
};
// Department job-card queues: only these three stages belong to the modules in scope; Manufacturing & co. stay as they were.
const HIG_STAGE_MODULE = { Purchase: 'purchase', Store: 'store', Electrical: 'electrical' };
const HIG_ROLE_MODULE = { Purchase: 'purchase', Store: 'store', Electrical: 'electrical', Service: 'electrical' };
const HIG_PAGE_MODULE = {};
Object.entries(HIG_PAGES).forEach(([mod, ids]) => ids.forEach(id => { HIG_PAGE_MODULE[id] = mod; }));

function higModuleOf(pageId) {
  if (HIG_PAGE_MODULE[pageId]) return HIG_PAGE_MODULE[pageId];
  if (pageId === 'jobcards') return HIG_ROLE_MODULE[ME && ME.role] || 'projects';
  if (pageId && pageId.startsWith('jc_')) return HIG_STAGE_MODULE[pageId.slice(3)] || 'projects';
  return null;
}

const HIG_CSS = `
.hig-mod-scope{font-variant-numeric:tabular-nums;}
/* ---- grouped inset cards ---- */
.hig-mod-scope .panel{border-radius:12px;padding:20px;margin-bottom:16px;}
.hig-mod-scope .panel > h3,.hig-mod-scope .panel > .panel-head{font-size:18px;font-weight:600;letter-spacing:-.012em;line-height:1.3;margin:0 0 16px;padding-bottom:12px;}
.hig-mod-scope .panel.collapsible > .panel-head{min-height:28px;}
.hig-mod-scope .panel.collapsible > .panel-head .chev{font-size:12px;}
.hig-mod-scope .panel.collapsible.collapsed > .panel-head{padding-bottom:0;border-bottom-color:transparent;}
.hig-mod-scope .panel .panel{padding:16px;margin-top:14px;}
.hig-mod-scope .panel .panel:first-child{margin-top:0;}
.hig-mod-scope .panel:has(> .panel.collapsible:only-child){padding:0;border:0;background:transparent;}
.hig-mod-scope .panel-sub{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px;margin-top:12px;}
.hig-mod-scope .panel-sub:first-child{border-top:1px solid var(--border);padding-top:16px;margin-top:0;}
.hig-mod-scope .panel-sub > .panel-head{min-height:28px;margin-bottom:12px;}
.hig-mod-scope .panel-sub.collapsed > .panel-head{margin-bottom:0;}
.hig-mod-scope .panel-sub > .panel-head h4{font-size:15px;font-weight:600;letter-spacing:-.006em;margin:0;}
.hig-mod-scope .panel-sub > .panel-head .chev{font-size:11px;}
.hig-mod-scope .panel-sub .panel{border-radius:10px;}
.hig-mod-scope .panel h4{font-size:15px;font-weight:600;letter-spacing:-.006em;margin:20px 0 8px;}
.hig-mod-scope .panel h4:first-child{margin-top:0;}
.hig-mod-scope .panel-sub > .panel-head h4{margin:0;}
.hig-mod-scope .panel h5{font-size:13px;font-weight:600;color:var(--primary);margin:14px 0 6px;}
.hig-mod-scope .muted{font-size:12px;line-height:1.5;}
.hig-mod-scope p.muted{font-size:13px;line-height:1.55;margin:0 0 12px;}
.hig-mod-scope .msg{border-radius:8px;padding:10px 12px;font-size:13px;}
.hig-mod-scope .cards{gap:12px;}
.hig-mod-scope .card{border-radius:12px;padding:16px;}
.hig-mod-scope .card .num{font-size:24px;letter-spacing:-.01em;}
.hig-mod-scope .card .label{font-size:12px;}
/* ---- form controls (pages + popups) ---- */
.hig-mod-scope label{font-size:12px;line-height:1.35;font-weight:500;color:var(--muted);}
.hig-mod-scope .form-grid{gap:12px 14px;}
.hig-mod-scope .form-grid label{margin-bottom:4px;}
.hig-mod-scope @I,.hig-mod-scope select:not([multiple]):not([size]){box-sizing:border-box;min-height:40px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background-color:#fff;color:var(--text);font:inherit;font-size:13px;line-height:1.4;max-width:100%;transition:border-color .15s ease,box-shadow .15s ease,background-color .15s ease;}
.hig-mod-scope textarea{display:block;width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:8px;color:var(--text);font:inherit;font-size:13px;line-height:1.5;max-width:100%;resize:vertical;transition:border-color .15s ease,box-shadow .15s ease;}
.hig-mod-scope select[multiple],.hig-mod-scope select[size]{border:1px solid var(--border);border-radius:8px;padding:6px;font:inherit;font-size:13px;max-width:100%;}
.hig-mod-scope input[type=file]{max-width:100%;font-size:13px;}
.hig-mod-scope @I:disabled,.hig-mod-scope select:disabled,.hig-mod-scope textarea:disabled{background-color:var(--bg);color:var(--muted);cursor:not-allowed;}
.hig-mod-scope @I:focus-visible,.hig-mod-scope select:focus-visible,.hig-mod-scope textarea:focus-visible{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(30,58,95,.16);}
.hig-mod-scope td @I,.hig-mod-scope td select:not([multiple]):not([size]){min-height:36px;padding:6px 10px;}
/* Stock In/Out fields carry !important sizing in index.html, so match it with !important */
.hig-mod-scope .stock-input-group input,.hig-mod-scope .stock-input-group select:not([size]){height:40px!important;padding:0 12px!important;font-size:13px!important;border-radius:8px!important;}
.hig-mod-scope .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:9px 18px;border-radius:8px;font-size:13px;line-height:1.3;transition:background-color .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease;}
.hig-mod-scope a.btn{display:inline-flex;}
.hig-mod-scope .btn.small{min-height:32px;padding:5px 12px;font-size:12px;}
.hig-mod-scope .btn:focus-visible,.hig-mod-scope .tab:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(30,58,95,.28);}
.hig-mod-scope .app-modal-close,.app-modal-box.hig-mod-scope .app-modal-close{min-width:32px;min-height:32px;border-radius:8px;}
/* ---- checkboxes / radios: always inline with their label ---- */
.hig-mod-scope input[type=checkbox],.hig-mod-scope input[type=radio]{box-sizing:border-box;width:18px;height:18px;min-height:0;margin:0 8px 0 0;padding:0;flex:none;accent-color:var(--primary);cursor:pointer;vertical-align:-3px;}
.hig-mod-scope label:has(> input[type=checkbox]),.hig-mod-scope label:has(> input[type=radio]){display:inline-flex;align-items:center;gap:8px;max-width:100%;margin:0;font-size:13px;line-height:1.45;font-weight:400;color:var(--text);cursor:pointer;}
.hig-mod-scope label:has(> input[type=checkbox]) > input,.hig-mod-scope label:has(> input[type=radio]) > input{margin:0;}
.hig-mod-scope .form-grid > div{display:flex;flex-direction:column;justify-content:flex-end;min-width:0;}
.hig-mod-scope .form-grid > div:has(> label > input[type=checkbox]){align-self:end;}
.hig-mod-scope .form-grid > div > label:has(> input[type=checkbox]){min-height:40px;}
/* ---- tabs: one scrolling row of pills, never wider than the page ---- */
.hig-mod-scope .tabs{display:flex;gap:6px;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding-bottom:8px;}
.hig-mod-scope .tabs::-webkit-scrollbar{display:none;}
.hig-mod-scope .tab{flex:none;display:inline-flex;align-items:center;min-height:38px;padding:8px 14px;white-space:nowrap;border:1px solid transparent;border-radius:8px;font-size:13px;transition:background-color .15s ease,color .15s ease,border-color .15s ease;}
.hig-mod-scope .tab:hover{background:var(--bg);color:var(--text);}
.hig-mod-scope .tab.active{background:color-mix(in srgb,var(--primary) 9%,#fff);border-color:color-mix(in srgb,var(--primary) 22%,#fff);}
/* item / project / vendor pickers (searchPickerHTML) carry inline sizing on their search box */
.hig-mod-scope [data-resize-key] > input{padding:9px 12px !important;border-radius:8px !important;font-size:13px !important;}
/* "Status [All]" / "Sort by [...]" filters: label above the select, never squeezed */
.hig-mod-scope label:has(> select){display:flex;flex-direction:column;gap:4px;min-width:0;}
.hig-mod-scope .btn.small.outline[onclick^="add"]:is([onclick*="Line"],[onclick*="Row"]){margin:4px 0 14px;}
/* ---- toolbars / filter rows wrap instead of squeezing ---- */
.hig-mod-scope .toolbar{flex-wrap:wrap;gap:8px;}
.hig-mod-scope .hig-filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 12px;margin-bottom:12px;}
.hig-mod-scope .hig-filters > *{min-width:0;}
/* ---- save bars / action rows ---- */
.hig-mod-scope .hig-actions,.hig-mod-scope .hig-savebar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
.hig-mod-scope .hig-savebar{margin-top:12px;}
/* ---- popups opened from a module page ---- */
.app-modal-box.hig-mod-scope{border-radius:12px;padding:20px;}
.app-modal-box.hig-mod-scope h3{font-size:18px;font-weight:600;letter-spacing:-.012em;margin:0 0 14px;}
.app-modal-box.hig-mod-scope code{overflow-wrap:anywhere;}
#mini-modal-overlay.hig-mod-scope > .panel{border-radius:12px;padding:20px;box-shadow:0 8px 30px rgba(0,0,0,.25);}
#mini-modal-overlay.hig-mod-scope > .panel h3{font-size:18px;font-weight:600;letter-spacing:-.012em;border:0;padding:0;}
@media (max-width:768px){
  .hig-mod-scope .panel{padding:14px;margin-bottom:14px;}
  .hig-mod-scope .panel .panel{padding:12px;}
  .hig-mod-scope .panel:has(> .panel.collapsible:only-child){padding:0;}
  .hig-mod-scope .panel.collapsible > .panel-head,.hig-mod-scope .panel-sub > .panel-head{min-height:44px;align-items:center;}
  .hig-mod-scope .panel-sub{padding:14px;}
  .hig-mod-scope .cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
  .hig-mod-scope .card{padding:12px;}
  .hig-mod-scope .card .num{font-size:20px;}
  .hig-mod-scope @I,.hig-mod-scope select:not([multiple]):not([size]){min-height:44px;font-size:16px;}
  .hig-mod-scope td @I,.hig-mod-scope td select:not([multiple]):not([size]){min-height:44px;padding:8px 10px;}
  .hig-mod-scope textarea{font-size:16px;}
  .hig-mod-scope .stock-input-group input,.hig-mod-scope .stock-input-group select:not([size]){height:44px!important;font-size:16px!important;}
  .hig-mod-scope .btn,.hig-mod-scope .btn.small{min-height:44px;}
  .hig-mod-scope label:has(> input[type=checkbox]),.hig-mod-scope label:has(> input[type=radio]),.hig-mod-scope .form-grid > div > label:has(> input[type=checkbox]){min-height:44px;}
  .hig-mod-scope .tab{min-height:44px;}
  .hig-mod-scope .app-modal-close,.app-modal-box.hig-mod-scope .app-modal-close{min-width:44px;min-height:44px;}
  /* row-action buttons: two per line so PR / PO rows stay compact, selects and long labels span the full row */
  .hig-mod-scope .row-actions,.hig-mod-scope .po-actions{grid-template-columns:repeat(2,minmax(0,1fr));}
  .hig-mod-scope [data-resize-key]{width:100% !important;max-width:100% !important;resize:none !important;}
  .hig-mod-scope [data-resize-key] > input{min-height:44px;font-size:16px !important;}
  .hig-mod-scope div:has(> [data-resize-key]){flex:1 1 100% !important;min-width:0;}
  .hig-mod-scope .glt-row > div input,.hig-mod-scope .glt-row > div select{width:100% !important;}
  .hig-mod-scope div:has(> label > select){display:flex;flex-wrap:wrap;gap:10px 12px;}
  .hig-mod-scope div:has(> label > select) > label{flex:1 1 calc(50% - 12px);}
  .hig-mod-scope .hig-filters > *{flex:1 1 calc(50% - 12px);}
  .hig-mod-scope .hig-filters > .hig-wide{flex-basis:100%;}
  /* sticky save bar. bottom:-14px = the mobile .content padding (Chrome pins a sticky bar to that padding's inner edge) */
  .hig-mod-scope .hig-savebar{position:sticky;bottom:-14px;z-index:5;background:rgba(255,255,255,.94);-webkit-backdrop-filter:saturate(1.2) blur(8px);backdrop-filter:saturate(1.2) blur(8px);border-top:1px solid var(--border);margin-top:14px;padding:10px 0 calc(10px + env(safe-area-inset-bottom));}
  .hig-mod-scope .panel-sub .hig-savebar{background:rgba(244,246,248,.94);}
  .hig-mod-scope .hig-savebar > .btn{flex:1 1 auto;}
  /* popups: nearly full-bleed; the backdrop padding (12px) is what the sticky bar's bottom offset compensates for */
  .app-modal-backdrop:has(> .app-modal-box.hig-mod-scope),#mini-modal-overlay.hig-mod-scope{padding:12px 10px !important;}
  .app-modal-box.hig-mod-scope{padding:16px;width:100%;}
  .app-modal-box.hig-mod-scope .hig-savebar{bottom:-12px;margin-inline:-16px;padding-inline:16px;}
  #mini-modal-overlay.hig-mod-scope > .panel{max-width:none !important;}
  #mini-modal-overlay.hig-mod-scope .hig-savebar{bottom:-12px;margin-inline:-14px;padding-inline:14px;}
  /* ---- line-item entry grids -> one labelled card per line (read-only list tables keep scrolling inside their card) ---- */
  .hig-mod-scope .grid-line-table{border:0;border-radius:0;overflow:visible !important;}
  .hig-mod-scope .glt-head{display:none !important;}
  .hig-mod-scope .glt-row:not(.glt-head):not(.glt-foot){grid-template-columns:repeat(2,minmax(0,1fr)) !important;gap:10px 12px;align-items:start;padding:14px;margin-bottom:10px;background:#fff;border:1px solid var(--border);border-radius:12px;}
  .hig-mod-scope .glt-row + .glt-row{border-top:1px solid var(--border);}
  .hig-mod-scope .glt-row > div{padding:0;}
  .hig-mod-scope .glt-row > div[data-w="wide"]{grid-column:1 / -1;}
  .hig-mod-scope .glt-row > div[data-w="sel"]{grid-column:1 / -1;justify-self:start;}
  .hig-mod-scope .glt-row > div[data-w="act"]{grid-column:1 / -1;justify-self:end;}
  .hig-mod-scope .glt-row > div[data-label]::before,.hig-mod-scope .hig-entry td[data-label]::before{content:attr(data-label);display:block;margin-bottom:4px;font-size:12px;font-weight:500;color:var(--muted);}
  .hig-mod-scope .glt-foot{display:flex !important;flex-wrap:wrap;justify-content:space-between;gap:6px 14px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;}
  .hig-mod-scope .glt-foot > div{grid-column:auto !important;padding:0;}
  /* read-only workbench rows (department job-card boards): one card per row so Open / Start Work are never off-screen */
  .hig-mod-scope .hig-rowcards table{display:block;white-space:normal;overflow:visible;}
  .hig-mod-scope .hig-rowcards thead{display:none;}
  .hig-mod-scope .hig-rowcards tbody{display:block;}
  .hig-mod-scope .hig-rowcards tbody tr{display:block;margin-bottom:10px;padding:12px 14px;background:#fff;border:1px solid var(--border);border-radius:12px;}
  .hig-mod-scope .hig-rowcards tbody tr:hover td{background:transparent;}
  .hig-mod-scope .hig-rowcards td{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border:0;padding:4px 0;text-align:right;}
  .hig-mod-scope .hig-rowcards td::before{content:attr(data-label);flex:none;font-size:12px;font-weight:500;color:var(--muted);text-align:left;}
  .hig-mod-scope .hig-rowcards td:first-child{display:block;padding-bottom:6px;font-weight:600;color:var(--primary);text-align:left;}
  .hig-mod-scope .hig-rowcards td:last-child{display:block;padding-top:8px;text-align:left;}
  .hig-mod-scope .hig-rowcards td:first-child::before,.hig-mod-scope .hig-rowcards td:last-child::before{display:none;}
  /* table-based entry forms (challan items, invoice lines, spares, transfer lines) */
  .hig-mod-scope .hig-entry{overflow:visible;}
  .hig-mod-scope .hig-entry table{display:block;white-space:normal;overflow:visible;}
  .hig-mod-scope .hig-entry thead{display:none;}
  .hig-mod-scope .hig-entry tbody,.hig-mod-scope .hig-entry tfoot{display:block;}
  .hig-mod-scope .hig-entry tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;align-items:start;padding:14px;margin-bottom:10px;background:#fff;border:1px solid var(--border);border-radius:12px;}
  .hig-mod-scope .hig-entry tbody tr:hover td{background:transparent;}
  .hig-mod-scope .hig-entry td{display:block;min-width:0;border:0;padding:0;white-space:normal;}
  .hig-mod-scope .hig-entry td:first-child,.hig-mod-scope .hig-entry td[data-w="wide"]{grid-column:1 / -1;}
  .hig-mod-scope .hig-entry td[data-w="act"]{grid-column:1 / -1;justify-self:end;}
  .hig-mod-scope .hig-entry td input,.hig-mod-scope .hig-entry td select{width:100% !important;max-width:none;}
  .hig-mod-scope .hig-entry tfoot tr{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 14px;padding:6px 14px;}
  .hig-mod-scope .hig-entry tfoot td{padding:0;text-align:left !important;}
}
`.replace(/@I/g, 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=hidden]):not([type=color])');

// ---- Sales & Marketing only: every rule starts with .mod-sales (page wrapper, and the popups opened from those pages) ----
const HIG_SALES_CSS = `
/* a row's cells share one top line even when one holds a picker + select pair (New Offer's Client) */
.mod-sales .form-grid > div{justify-content:flex-start;}
/* markup in sales.js still carries a few hand-rolled inline paddings / widths: the field look wins over them */
.mod-sales textarea[style]{width:100% !important;box-sizing:border-box;padding:10px 12px !important;border-radius:8px !important;font-size:13px !important;}
.mod-sales input[style*="padding"]:not([type=checkbox]):not([type=radio]):not([type=file]),.mod-sales select[style*="padding"]{padding:7px 10px !important;border-radius:8px !important;}
.mod-sales > .btn.small.outline,.mod-sales > .toolbar{margin-bottom:12px;}
.mod-sales .toolbar{align-items:center;}
.mod-sales .panel > h4 + .form-grid,.mod-sales .modal-body > h4 + .form-grid{margin-top:4px;}
/* status pills (Sales Orders / Leads use more statuses than the base palette names) */
.mod-sales .badge{padding:3px 10px;font-size:12px;border-radius:999px;white-space:nowrap;}
.mod-sales .badge.Confirmed,.mod-sales .badge.New{background:#dbeafe;color:#1d4ed8;}
.mod-sales .badge.InProduction,.mod-sales .badge.Negotiation{background:#fef3cd;color:var(--amber);}
.mod-sales .badge.Quoted{background:#ede9fe;color:#6d28d9;}
.mod-sales .badge.Invoiced{background:#dcf3e6;color:var(--green);}
/* ---- Leads kanban (had no CSS at all): one lane per stage, scrolls sideways, cards keep drag-and-drop ---- */
.mod-sales .kanban-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(168px,1fr);gap:12px;overflow-x:auto;padding:2px 2px 12px;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scroll-snap-type:x proximity;}
.mod-sales .kanban-col{display:flex;flex-direction:column;min-width:0;background:var(--bg);border:1px solid var(--border);border-top:3px solid var(--border);border-radius:12px;padding:10px;scroll-snap-align:start;}
.mod-sales .kanban-col[data-stage="New"]{border-top-color:#1d4ed8;}
.mod-sales .kanban-col[data-stage="Quoted"]{border-top-color:#6d28d9;}
.mod-sales .kanban-col[data-stage="Negotiation"]{border-top-color:var(--amber);}
.mod-sales .kanban-col[data-stage="Won"]{border-top-color:var(--green);}
.mod-sales .kanban-col[data-stage="Lost"]{border-top-color:var(--red);}
.mod-sales .kanban-col-header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:2px 2px 10px;margin-bottom:10px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;letter-spacing:-.006em;}
.mod-sales .kanban-col-header .muted{font-size:12px;font-weight:500;white-space:nowrap;}
.mod-sales .kanban-dropzone{display:flex;flex-direction:column;gap:8px;flex:1;min-height:76px;border-radius:8px;}
.mod-sales .kanban-card{background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px 12px;cursor:grab;transition:border-color .15s ease,box-shadow .15s ease;}
.mod-sales .kanban-card:hover{border-color:color-mix(in srgb,var(--primary) 35%,#fff);box-shadow:0 2px 8px rgba(30,58,95,.10);}
.mod-sales .kanban-card:active{cursor:grabbing;}
.mod-sales .kanban-card-title{font-size:14px;font-weight:600;letter-spacing:-.006em;margin-bottom:2px;overflow-wrap:anywhere;}
.mod-sales .kanban-dropzone > .muted:only-child{display:block;text-align:center;padding:16px 8px;border:1px dashed var(--border);border-radius:8px;}
/* the modal's close button floats right, which narrows a scrolling first child (History table, a form grid) to sit beside it */
.mod-sales #app-modal-body > :first-child{clear:both;}
.mod-sales .hig-actions > a:not(.btn),.mod-sales .hig-savebar > a:not(.btn){color:var(--primary);font-size:13px;font-weight:500;text-decoration:underline;text-underline-offset:2px;}
.mod-sales .activity-item{padding:10px 0;border-bottom:1px solid var(--border);}
.mod-sales .activity-item:last-child{border-bottom:0;}
/* ---- list tables on a desktop: ids never split, actions pack into two columns instead of one tall stack ---- */
.mod-sales .hig-rowcards table td,.mod-sales .hig-rowcards table th{padding-left:7px;padding-right:7px;}
.mod-sales .hig-rowcards table th{white-space:normal;}
.mod-sales .hig-rowcards td .badge{white-space:normal;text-align:center;font-size:11.5px;padding:3px 8px;border-radius:12px;}
.mod-sales td .row-actions{grid-template-columns:repeat(2,minmax(78px,1fr));min-width:176px;}
.mod-sales td[onclick*="toggleCustomerGroupRollup"]{padding:11px 10px;}
/* New Dispatch: amber banner listing the dispatches that already claim quantity on the picked order; Delete Dispatch facts */
.mod-sales .disp-prior{background:#fff8e1;border:1px solid #f1d58a;border-left:4px solid var(--amber);border-radius:10px;padding:12px 14px;margin:4px 0 14px;font-size:13px;color:#5c4400;}
.mod-sales .disp-prior-head{font-weight:600;margin-bottom:6px;}
.mod-sales .disp-prior-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:7px 0;border-top:1px solid rgba(180,130,0,.22);}
.mod-sales .disp-prior-no{font-weight:600;font-variant-numeric:tabular-nums;}
.mod-sales .disp-prior-lines{flex:1 1 260px;min-width:0;overflow-wrap:anywhere;}
.mod-sales .disp-prior-note{margin-top:8px;padding-top:8px;border-top:1px solid rgba(180,130,0,.22);font-size:12px;color:#7a5c00;}
.mod-sales .disp-del-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:12px 0;font-size:13px;}
.mod-sales .disp-del-facts > span:nth-child(odd){font-size:12px;}
/* entry tables (annexure rows, line fields) scroll inside their card on a desktop instead of widening the page */
@media (min-width:769px){.mod-sales .hig-entry{overflow-x:auto;}}
.mod-sales .hig-entry td[data-label="S.No"]:first-child{grid-column:auto;}
@media (max-width:768px){
  .mod-sales .badge,.mod-sales .hig-rowcards td .badge{padding:4px 10px;font-size:12px;white-space:nowrap;border-radius:999px;}
  .mod-sales .hig-savebar{padding-bottom:max(12px,env(safe-area-inset-bottom));}
  .mod-sales .hig-actions > a:not(.btn),.mod-sales .hig-savebar > a:not(.btn){display:inline-flex;align-items:center;min-height:44px;}
  .mod-sales > .btn.small.outline{width:100%;}
  /* kanban: one stage per screen, the next one peeks in; moving a lead on touch uses the List view's "Move to" menu */
  .mod-sales .kanban-board{grid-auto-columns:82%;scroll-snap-type:x mandatory;margin-inline:-2px;}
  .mod-sales .kanban-card{padding:12px;}
  /* list rows -> cards */
  .mod-sales .hig-rowcards td[data-empty]{display:none !important;}
  .mod-sales .hig-rowcards table td{padding-left:0;padding-right:0;}
  .mod-sales .hig-rowcards table td:first-child{white-space:normal;overflow-wrap:anywhere;}
  .mod-sales .hig-rowcards td[data-label="Description"],.mod-sales .hig-rowcards td[data-label="Remarks"],.mod-sales .hig-rowcards td[data-label="Address"],.mod-sales .hig-rowcards td[data-label="Notes"],.mod-sales .hig-rowcards td[data-label="Details"],.mod-sales .hig-rowcards td[data-label="Revision Reason"]{display:block;text-align:left;}
  .mod-sales .hig-rowcards td[data-label="Description"]::before,.mod-sales .hig-rowcards td[data-label="Remarks"]::before,.mod-sales .hig-rowcards td[data-label="Address"]::before,.mod-sales .hig-rowcards td[data-label="Notes"]::before,.mod-sales .hig-rowcards td[data-label="Details"]::before,.mod-sales .hig-rowcards td[data-label="Revision Reason"]::before{display:block;margin-bottom:2px;}
  .mod-sales .hig-rowcards td:last-child .row-actions,.mod-sales .hig-rowcards td .row-actions{min-width:0;grid-template-columns:repeat(2,minmax(0,1fr));}
  .mod-sales .hig-rowcards td:last-child > select,.mod-sales .hig-rowcards td:last-child > .btn{margin-top:6px;}
  .mod-sales .hig-rowcards td a.btn,.mod-sales .hig-rowcards td .btn.small{width:100%;}
  .mod-sales .hig-rowcards tbody tr[id]{background:var(--bg);}
  .mod-sales td[onclick*="toggleCustomerGroupRollup"]{min-height:44px;}
  /* entry tables: keep the key text wide, numbers in pairs */
  .mod-sales .hig-entry td[data-label="Description"],.mod-sales .hig-entry td[data-label="Line"],.mod-sales .hig-entry td[data-label="Item"],.mod-sales .hig-entry td[data-label="Remarks"],.mod-sales .hig-entry td[data-label="Title"],.mod-sales .hig-entry td[data-label="Summary"]{grid-column:1 / -1;}
  .mod-sales .hig-entry:has(#kv-rows) td{grid-column:1 / -1;}
  .mod-sales .hig-entry td textarea{width:100% !important;min-height:84px;}
  .mod-sales .hig-entry td[data-w="act"] .row-actions{min-width:0;}
  .mod-sales .hig-entry td .btn.small{min-width:96px;}
  /* wide pickers and file rows never push the card past the screen */
  .mod-sales input[type=file]{width:100%;}
}
`;
// ---- HR, Projects, My Approvals, Dashboard: every rule starts with :is(.mod-hr, .mod-projects, .mod-approvals, .mod-dashboard) ----
// (@N below). Long free-text columns keep their label above the text on a phone card; short columns sit label-left / value-right.
const HIG_LONG_CELLS = ['Description', 'Remarks', 'Notes', 'Details', 'Reason', 'Summary', 'Subject', 'Issue', 'Comment', 'Travel', 'Lodging'];
const HIG_WIDE_ENTRY = ['Description', 'Line', 'Item', 'Remarks', 'Title', 'Summary', 'Department', 'Employee', 'Leave Type', 'Name'];
const higCells = (kind, labels, suffix = '') => labels.map(l => `@N .${kind} td[data-label="${l}"]${suffix}`).join(',');
const HIG_NEW_CSS = `
@N .badge{padding:3px 10px;font-size:12px;border-radius:999px;white-space:nowrap;}
@N .toolbar{align-items:center;}
@N .hig-check-row{margin:0 0 6px;}
@N .hig-actions{margin:8px 0;}
@N .panel > h4 + .form-grid{margin-top:4px;}
@N td[data-label="Name"],@N td[data-label="Employee"]{font-weight:500;}
@media (min-width:769px){@N .hig-entry{overflow-x:auto;}}
/* ---- My Approvals ---- */
@N .panel > h3:only-child{border-bottom:0;margin-bottom:0;padding-bottom:0;}
@N td[onclick*="toggleApprovalBucket"]{transition:background-color .15s ease;}
@N td[onclick*="toggleApprovalBucket"]:hover{background:#e8edf3 !important;}
/* ---- Dashboard ---- */
@N .card{display:flex;flex-direction:column;justify-content:center;min-height:84px;}
@N .card .num{font-weight:600;line-height:1.15;}
@N .card .label{margin-top:4px;line-height:1.3;overflow-wrap:anywhere;}
@N .card:hover{transform:none;box-shadow:0 2px 8px rgba(30,58,95,.10);border-color:color-mix(in srgb,var(--primary) 35%,#fff);}
@N .card.active{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 5%,#fff);box-shadow:0 0 0 2px rgba(30,58,95,.14);}
@N .card > span[onclick*="removeDashboardMetric"]{top:6px !important;right:6px !important;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:18px;line-height:1;color:var(--muted) !important;transition:background-color .15s ease,color .15s ease;}
@N .card > span[onclick*="removeDashboardMetric"]:hover{background:color-mix(in srgb,var(--red) 10%,#fff);color:var(--red) !important;}
@N .card:has(> span[onclick*="removeDashboardMetric"]) .num{padding-right:30px;}
@N .toolbar > h3{font-size:18px;font-weight:600;letter-spacing:-.012em;}
@N .toolbar > select{min-width:150px;}
@N .chart-box{border-radius:12px;padding:14px;}
@N .chart-box h4{font-size:14px;font-weight:600;letter-spacing:-.006em;margin:0 0 8px;}
/* ---- Projects ---- */
@N .pj-child-row td{background:#fbfcfe;}
@N .pj-blocked{max-width:260px;}
@media (max-width:768px){
  @N .badge{padding:4px 10px;}
  @N .hig-rowcards td[data-empty]{display:none !important;}
  @N .hig-rowcards table td{padding-left:0;padding-right:0;overflow-wrap:anywhere;}
  @N .hig-rowcards table td:first-child{white-space:normal;}
  /* the shared card rule treats every last cell as the action cell: a last cell with its own column header keeps its label */
  @N .hig-rowcards td:last-child[data-label]:not([data-w="act"]):not([data-label="Action"]):not([data-label="Actions"]){display:flex;padding-top:4px;text-align:right;}
  @N .hig-rowcards td:last-child[data-label]:not([data-w="act"]):not([data-label="Action"]):not([data-label="Actions"])::before{display:block;}
  ${higCells('hig-rowcards', HIG_LONG_CELLS, '')}{display:block;text-align:left;}
  ${higCells('hig-rowcards', HIG_LONG_CELLS, '::before')}{display:block;margin-bottom:2px;}
  @N .hig-rowcards td .row-actions{min-width:0;grid-template-columns:repeat(2,minmax(0,1fr));}
  @N .hig-rowcards td:last-child > select,@N .hig-rowcards td:last-child > .btn{margin-top:6px;}
  @N .hig-rowcards td a.btn,@N .hig-rowcards td .btn.small{width:100%;}
  ${higCells('hig-entry', HIG_WIDE_ENTRY)}{grid-column:1 / -1;}
  @N .hig-entry td textarea{width:100% !important;min-height:84px;}
  @N .hig-entry td[data-w="act"] .row-actions{min-width:0;}
  @N .hig-entry td .btn.small{min-width:96px;}
  @N input[type=file]{width:100%;}
  @N .toolbar > select{flex:1 1 100%;}
  @N .card{min-height:76px;}
  @N .card > span[onclick*="removeDashboardMetric"]{width:44px;height:44px;top:2px !important;right:2px !important;}
  @N .card:has(> span[onclick*="removeDashboardMetric"]) .num{padding-right:40px;}
  /* My Approvals: chain / department headers are full-width tappable section bars, every request below is a card */
  @N .hig-rowcards tbody:not([id]) tr{padding:0;background:transparent;border:0;}
  @N .hig-rowcards tbody:not([id]) tr:has(> td:not([onclick])){margin:16px 0 8px;}
  @N .hig-rowcards tbody:not([id]) tr:has(> td[onclick]){margin:0 0 8px;}
  @N .hig-rowcards tbody:not([id]) td[colspan]{display:flex;align-items:center;justify-content:flex-start;gap:4px 8px;min-height:44px;padding:10px 14px !important;border-radius:10px;text-align:left;}
  @N .hig-rowcards tbody:not([id]) td[colspan] > .muted{margin-left:auto;}
  @N .hig-rowcards tbody:not([id]) td[colspan][onclick]{border:1px solid var(--border);}
  @N .hig-rowcards tbody:not([id]) td[colspan]::before{display:none;}
  /* the page-wide .approval-actions is a fixed 130px column: on a phone the card is the column. Approve + Reject share a row, everything else is full width */
  @N .row-actions.approval-actions{width:auto;grid-template-columns:repeat(2,minmax(0,1fr));}
  @N .row-actions.approval-actions .btn.small{width:100%;min-height:44px;}
  @N .row-actions.approval-actions > .btn{grid-column:1 / -1;}
  @N .row-actions.approval-actions > .btn.green:has(+ .btn.red),@N .row-actions.approval-actions > .btn.green + .btn.red{grid-column:auto;}
  @N .hig-rowcards tr:has(> td[data-empty]:first-child + td[colspan]){margin:-6px 0 10px;padding:8px 14px;border-top:0;border-radius:0 0 12px 12px;background:#fffaf0;}
  @N .hig-rowcards tr[id^="appr-drill-row"],@N .hig-rowcards tr[id^="grn-batch-"]{background:var(--bg);margin-top:-4px;}
  @N .hig-rowcards tr[id^="appr-drill-row"] > td,@N .hig-rowcards tr[id^="grn-batch-"] > td{display:block;}
  @N .glt-row > div:has(> .row-actions){grid-column:1 / -1;}
  /* Projects: nested sub-process / sub-assembly rows hang off their parent card; the plan editor puts the move buttons last */
  @N .hig-rowcards tr.pj-child-row,@N .hig-rowcards tr[class*="jc-child-row"]{margin-left:12px;background:#fbfcfe;border-left:3px solid var(--border);}
  @N .hig-entry td.pl-reorder[data-w]{order:90;grid-column:1;justify-self:start;}
  @N .hig-entry td[data-w="act"]:last-child:not(.pl-reorder){order:91;grid-column:2;justify-self:end;}
  @N .hig-entry .reorder-actions{grid-template-columns:repeat(2,44px);gap:8px;}
  @N .hig-entry .reorder-actions .btn.small{min-width:0;width:44px;padding:0;}
}
`.replace(/@N/g, ':is(.mod-hr,.mod-projects,.mod-approvals,.mod-dashboard)');
function higInstall() {
  if (document.getElementById('hig-mod-css')) return;
  const st = document.createElement('style'); st.id = 'hig-mod-css'; st.textContent = HIG_CSS + HIG_SALES_CSS + HIG_NEW_CSS;
  document.head.appendChild(st);
  // One observer keeps two things in step with every (re)render: popups opened from a module page get the scope class,
  // and line-item grids get their header text copied onto each cell (CSS attr(data-label) shows it on the mobile cards).
  // On a phone an error shown below a sticky Save bar would be off-screen, so a message that appears is scrolled into view.
  new MutationObserver((muts) => { higMarkModal(); higStampLabels(); higRevealMessages(muts); })
    .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
}
function higMarkModal() {
  // Two popup helpers exist: openAppModal (a box inside #app-modal-backdrop) and openMiniModal (#mini-modal-overlay, sales.js).
  const host = document.querySelector('#app-modal-backdrop > .app-modal-box:not(.hig-mod-scope), #mini-modal-overlay:not(.hig-mod-scope)');
  const mod = host && higModuleOf(CURRENT_PAGE);
  if (mod) host.classList.add('hig-mod-scope', 'mod-' + mod);
}
function higRevealMessages(muts) {
  if (!window.matchMedia('(max-width:768px)').matches) return;
  const seen = new Set();
  muts.forEach((m) => {
    const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    const msg = n && n.closest('.hig-mod-scope .msg');
    if (!msg || seen.has(msg) || !msg.textContent.trim() || msg.offsetParent === null) return;
    seen.add(msg);
    const r = msg.getBoundingClientRect();
    if (r.bottom > innerHeight - 70 || r.top < 0) msg.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}
// Sales screens build plain <table>s from several helpers (tableHTML, customerGroupedHTML, raw markup), so they are classified here
// once instead of editing ~25 call sites. A table whose body holds fields is an entry table (.hig-entry: one labelled card per
// line on a phone); any other table with 3+ columns is a list (.hig-rowcards: one card per row). A host that already carries
// .hig-entry / .hig-rowcards / data-hig-keep is left alone. Only runs under .mod-sales / .mod-hr / .mod-projects / .mod-approvals /
// .mod-dashboard; idempotent (re-run on every render).
const HIG_TAGGED_MODS = ['sales', 'hr', 'projects', 'approvals', 'dashboard'];
function higTagTables() {
  document.querySelectorAll(HIG_TAGGED_MODS.map(k => '.mod-' + k + ' table').join(',')).forEach(t => {
    const auto = t.closest('[data-hig-auto]');
    if (!auto && t.closest('.hig-entry, .hig-rowcards, .grid-line-table, [data-hig-keep]')) return;
    const head = t.tHead && t.tHead.rows[0];
    if (!head || head.cells.length < 3) return;
    // fields in a data cell = entry table; a select/button in the LAST cell is a row action, and a full-width (colspan) row is a hidden detail form
    const entry = !!t.querySelector('tbody td:not([colspan]):not(:last-child) :is(input:not([type=hidden]), select, textarea)');
    let box = auto;
    if (!box) {
      const host = t.parentElement;
      if (host.tagName === 'DIV' && host.children.length === 1) box = host;
      else { box = document.createElement('div'); host.insertBefore(box, t); box.appendChild(t); }
      box.setAttribute('data-hig-auto', '');
    }
    box.classList.toggle('hig-entry', entry);
    box.classList.toggle('hig-rowcards', !entry);
  });
  // a list cell with nothing in it would print a bare label on a phone card
  document.querySelectorAll(HIG_TAGGED_MODS.map(k => '.mod-' + k + ' .hig-rowcards tbody td').join(',')).forEach(td => {
    td.toggleAttribute('data-empty', td.colSpan === 1 && !td.textContent.trim() && !td.querySelector('input,select,textarea,button,a,img'));
  });
}
// a sortable header carries its ▲▼⇅ glyph in .sort-arrow: that is not part of the column name
function higThLabel(th) { const c = th.cloneNode(true); c.querySelectorAll('.sort-arrow').forEach(e => e.remove()); c.querySelectorAll('br').forEach(e => e.replaceWith(' ')); return c.textContent.replace(/\s+/g, ' ').trim(); }
function higStampLabels() {
  higTagTables();
  document.querySelectorAll('.hig-mod-scope .grid-line-table').forEach(g => {
    const head = g.querySelector('.glt-head');
    if (!head) return;
    const labels = Array.from(head.children, c => c.textContent.trim());
    g.querySelectorAll('.glt-row:not(.glt-head):not(.glt-foot)').forEach(row => {
      const tracks = (row.style.gridTemplateColumns || '').match(/minmax\([^)]*\)|\S+/g) || [];
      Array.from(row.children).forEach((cell, i) => {
        if (cell.hasAttribute('data-w')) return;
        const wide = /fr|auto/.test(tracks[i] || '');
        if (labels[i]) { cell.setAttribute('data-label', labels[i]); cell.setAttribute('data-w', wide ? 'wide' : 'half'); }
        else cell.setAttribute('data-w', i === 0 ? 'sel' : 'act');
      });
    });
  });
  document.querySelectorAll('.hig-mod-scope :is(.hig-entry,.hig-rowcards) table').forEach(t => {
    const labels = Array.from(t.querySelectorAll(':scope > thead th'), higThLabel);
    t.querySelectorAll(':scope > tbody > tr').forEach(tr => {
      Array.from(tr.children).forEach((td, i) => {
        if (td.hasAttribute('data-w') || td.colSpan > 1) return;
        if (labels[i]) { td.setAttribute('data-label', labels[i]); td.setAttribute('data-w', 'half'); }
        else td.setAttribute('data-w', 'act');
      });
    });
  });
}
// Centre the active tab inside its scrolling row without scrolling the page itself.
function higRevealTab(t) { const bar = t.parentElement; if (bar) bar.scrollLeft = t.offsetLeft - (bar.clientWidth - t.offsetWidth) / 2; }

async function higRenderScoped(el, mod, key, render) {
  higInstall();
  const wrap = document.createElement('div');
  wrap.className = `hig-mod-scope mod-${mod} hig-page-${key}`;
  el.innerHTML = '';
  el.appendChild(wrap);
  wrap.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) setTimeout(() => higRevealTab(t), 0); });
  await render(wrap);
  wrap.querySelectorAll('.tabs .tab.active').forEach(higRevealTab);
}

Object.entries(HIG_PAGES).forEach(([mod, ids]) => ids.forEach(id => {
  const render = PAGES[id];
  if (!render) return;
  PAGES[id] = (el) => higRenderScoped(el, mod, id, (wrap) => render(wrap));
}));
// "My Job Cards" belongs to the user's own department: Purchase / Store / Electrical (+ Service) keep their module, every other role is Projects.
if (PAGES.jobcards) {
  const renderMine = PAGES.jobcards;
  PAGES.jobcards = (el) => {
    const mod = higModuleOf('jobcards');
    return mod ? higRenderScoped(el, mod, 'jobcards', (wrap) => renderMine(wrap)) : renderMine(el);
  };
}
// jc_<Stage> pages are created by core.js at login and call renderDeptJobCards by name, so wrap that function instead.
if (typeof renderDeptJobCards === 'function') {
  const renderDept = renderDeptJobCards;
  window.renderDeptJobCards = (el, stage, label, onlyStage) => {
    const mod = HIG_STAGE_MODULE[stage] || 'projects';
    return mod ? higRenderScoped(el, mod, 'jc-' + stage, (wrap) => renderDept(wrap, stage, label, onlyStage)) : renderDept(el, stage, label, onlyStage);
  };
}

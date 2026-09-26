// ===================== State & API helper =====================
let TOKEN = localStorage.getItem('erp_token') || null;
let ME = null;
let PERMS = new Set();

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch('/api' + path, Object.assign({}, opts, { headers }));
  let data;
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function has(...codes) { return ME && (ME.role === 'Admin' || codes.some(c => PERMS.has(c))); }

// ===================== Auth =====================
async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-err');
  errEl.textContent = '';
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    TOKEN = data.token;
    localStorage.setItem('erp_token', TOKEN);
    if (data.must_change_password) {
      promptForcedPasswordChange(password);
      return;
    }
    await boot();
  } catch (e) {
    errEl.textContent = e.message;
  }
}
function doLogout() {
  TOKEN = null; localStorage.removeItem('erp_token');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  showLoginBox();
}
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// ---- Forgot / reset password (unauthenticated) ----
function hideAllLoginBoxes() {
  ['login-box-main', 'forgot-password-box', 'reset-password-box'].forEach(id => { document.getElementById(id).style.display = 'none'; });
}
window.showLoginBox = () => { hideAllLoginBoxes(); document.getElementById('login-box-main').style.display = 'block'; };
window.showForgotPassword = () => {
  hideAllLoginBoxes();
  document.getElementById('forgot-password-box').style.display = 'block';
  document.getElementById('forgot-err').textContent = '';
  document.getElementById('forgot-msg').style.display = 'none';
};
window.submitForgotPassword = async () => {
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('forgot-err');
  const msgEl = document.getElementById('forgot-msg');
  errEl.textContent = ''; msgEl.style.display = 'none';
  if (!email) { errEl.textContent = 'Enter your email address.'; return; }
  try {
    const r = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    msgEl.textContent = r.message;
    msgEl.style.display = 'block';
  } catch (e) { errEl.textContent = e.message; }
};

// A reset link (?reset_token=...) lands here before anything else - even
// over an existing logged-in session, since clicking one is an explicit
// intent to change a password, not to resume whatever was open before.
let RESET_TOKEN = null;
async function checkForResetToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('reset_token');
  if (!token) return false;
  RESET_TOKEN = token;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  hideAllLoginBoxes();
  document.getElementById('reset-password-box').style.display = 'block';
  const introEl = document.getElementById('reset-intro');
  try {
    const r = await api('/auth/reset-password/validate?token=' + encodeURIComponent(token));
    introEl.textContent = `Hi ${r.full_name}, set a new password for your account (${r.username}).`;
    document.getElementById('reset-form').style.display = 'block';
  } catch (e) {
    introEl.textContent = e.message;
  }
  return true;
}
window.submitResetPassword = async () => {
  const newPassword = document.getElementById('reset-new-password').value;
  const errEl = document.getElementById('reset-err');
  errEl.textContent = '';
  try {
    await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: RESET_TOKEN, new_password: newPassword }) });
    // Clear the token from the URL so a page refresh doesn't try to reuse
    // an already-consumed link, then drop back to a normal login prompt.
    window.history.replaceState({}, '', window.location.pathname);
    hideAllLoginBoxes();
    document.getElementById('login-box-main').style.display = 'block';
    document.getElementById('login-err').textContent = '';
    showMsg(document.getElementById('login-box-main'), 'Password set - please sign in.', true);
  } catch (e) { errEl.textContent = e.message; }
};

// ---- Forced password change (welcome email / admin reset) ----
// A dedicated overlay, not openMiniModal - this runs before boot() and
// before #app exists, and deliberately has no close button, since the app
// must not be usable with a password that passed through an email inbox
// or an Admin's hands until the account owner has replaced it themselves.
function promptForcedPasswordChange(currentPassword) {
  const overlay = document.createElement('div');
  overlay.id = 'forced-pw-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `<div class="login-box" style="width:min(360px,92vw);">
    <h1>Set a New Password</h1>
    <p>For your security, please set your own password before continuing.</p>
    <input id="forced-new-password" type="password" placeholder="New password (min 6 characters)" autocomplete="new-password">
    <button onclick="submitForcedPasswordChange()">Set Password &amp; Continue</button>
    <div class="login-err" id="forced-pw-err"></div>
  </div>`;
  document.body.appendChild(overlay);
  window.__FORCED_PW_CURRENT = currentPassword;
}
window.submitForcedPasswordChange = async () => {
  const newPassword = document.getElementById('forced-new-password').value;
  const errEl = document.getElementById('forced-pw-err');
  errEl.textContent = '';
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: window.__FORCED_PW_CURRENT, new_password: newPassword }) });
    document.getElementById('forced-pw-overlay').remove();
    window.__FORCED_PW_CURRENT = null;
    await boot();
  } catch (e) { errEl.textContent = e.message; }
};

// ---- Self-service change password (from within the app) ----
window.openChangePasswordModal = () => {
  const body = `
    <div><label>Current Password</label><input id="cp-current" type="password"></div>
    <div style="margin-top:8px;"><label>New Password (min 6 characters)</label><input id="cp-new" type="password"></div>
    <div style="margin-top:12px;"><button class="btn" onclick="submitChangePassword()">Change Password</button></div>
    <div class="msg err" id="cp-err" style="display:none;margin-top:8px;"></div>`;
  openMiniModal('Change Password', body);
};
window.submitChangePassword = async () => {
  const errEl = document.getElementById('cp-err');
  errEl.style.display = 'none';
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify({
      current_password: val('cp-current'), new_password: val('cp-new'),
    })});
    closeMiniModal();
    alert('Password changed.');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

let ALLOWED_PAGES = null; // null = unrestricted; Set of page ids once an Admin has configured this role
// Faint company branding watermark across the app shell - best-effort and
// non-blocking, same idea as the one baked into every generated PDF
// (lib/pdfBranding.js), just so the two never contradict what boot() does.
let APP_WATERMARK_RENDERED = false;
async function renderAppWatermark() {
  if (APP_WATERMARK_RENDERED) return;
  try {
    const company = await api('/settings/company');
    const el = document.getElementById('app-watermark');
    const name = company.legal_name || company.trade_name || '';
    el.innerHTML = company.logo_path
      ? `<img src="${esc(company.logo_path)}">`
      : `<span>${esc(name)}</span>`;
    APP_WATERMARK_RENDERED = true;
  } catch (e) { /* purely decorative - never block the app over this */ }
}

async function boot() {
  try {
    ME = await api('/auth/me');
    const p = await api('/auth/my-permissions');
    PERMS = new Set(p.permissions);
    const mp = await api('/auth/my-pages');
    ALLOWED_PAGES = mp.pages ? new Set(mp.pages) : null;
  } catch (e) {
    return doLogout();
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('user-name').textContent = ME.full_name;
  document.getElementById('user-role').textContent = ME.role;
  renderAppWatermark();
  // Department-scoped roles (everyone except Admin/ProjectManager, who can
  // touch any department) get their own dedicated sidebar group named after
  // their department - e.g. "Design", "Electrical", "Manufacturing" - the
  // same pattern as the Admin and Finance groups, instead of a generic
  // "My Job Cards" item buried under Projects Management. A Manufacturing
  // sub-process login (Fitting/Tacking/Welding/BuffingSandblast/Painting)
  // still lands in a group named "Manufacturing" (their department name),
  // and the combined-stage backend query means that one tab shows the whole
  // sub-process chain, not just their own sliver.
  // NAV persists across logins within one page session (no full reload on
  // logout/login), so this must be idempotent - always start by removing
  // any "jobcards" item Projects Management may still have from a
  // previous login, then decide fresh where it belongs for this one.
  const prodGroup = NAV.find(g => g.group === 'Projects Management');
  if (prodGroup) prodGroup.items = prodGroup.items.filter(it => it.id !== 'jobcards');
  const elecServiceGroup = NAV.find(g => g.group === 'Electrical & Service');
  if (elecServiceGroup) elecServiceGroup.items = elecServiceGroup.items.filter(it => it.id !== 'jobcards');
  DEPT_OWN_GROUP.items = [];
  if (ME.department_name && !['Admin', 'ProjectManager'].includes(ME.role)) {
    const label = `${ME.department_name} Job Cards`;
    PAGE_TITLES['jobcards'] = label;
    // Electrical and Service are one merged department/HOD in this org (see
    // Round 22) - their Job Cards entry lives inside the shared "Electrical &
    // Service" tab instead of getting its own separate top-level group. Every
    // other department still gets its own department-named group as before.
    if (['Electrical', 'Service'].includes(ME.role) && elecServiceGroup) {
      elecServiceGroup.items.unshift({ id: 'jobcards', label });
    } else {
      DEPT_OWN_GROUP.group = ME.department_name;
      DEPT_OWN_GROUP.items = [{ id: 'jobcards', label }];
    }
  } else if (prodGroup) {
    // Admin/ProjectManager keep a generic "My Job Cards" entry under
    // Projects Management (they also get the full per-department set
    // below), rather than a group named after a department they don't have.
    PAGE_TITLES['jobcards'] = 'My Job Cards';
    prodGroup.items.push({ id: 'jobcards', label: 'My Job Cards' });
  }
  // "User Access" and "Approval Matrix" are Admin-only, regardless of any per-role page config.
  NAV.forEach(g => { g.items = g.items.filter(it => (it.id !== 'access' && it.id !== 'approval-matrix') || ME.role === 'Admin'); });
  // Admin/ProjectManager get a separate Job Cards tab per department, so
  // they can watch every department's queue without switching logins. Each
  // department gets its OWN sidebar group/tab (not all lumped together
  // inside one combined "Department Job Cards" group) - Manufacturing's own
  // page additionally groups its sub-processes (Fitting/Tacking/Welding/
  // Buffing-Sandblast/Painting) into their own sections rather than one
  // flat list, since combinedStagesForRole() already pulls all of them in.
  // NAV persists across logins, so start idempotent: strip any jc_* items a
  // previous login may have merged into Purchase / Store & Inventory /
  // Electrical & Service.
  NAV.forEach(g => { if (['Purchase', 'Store & Inventory', 'Electrical & Service'].includes(g.group)) g.items = g.items.filter(it => !it.id.startsWith('jc_')); });
  DEPT_JOBCARDS_GROUPS.length = 0;
  if (['Admin', 'ProjectManager'].includes(ME.role)) {
    try {
      const stages = await api('/projects/pipeline-stages');
      // Purchase and Store already have their own dedicated functional nav
      // groups (Purchase Requests/POs/Vendors, Item Master/Stock In-Out/
      // Challans) - their job cards belong INSIDE those, not in a second
      // separate group of the same name. Electrical is merged into the same
      // "Electrical & Service" tab Service's own functional pages live in
      // (Round 22 - one HOD covers both). Every other stage gets its own
      // group, since nothing else already claims that department's name.
      const MERGE_INTO = { Purchase: 'Purchase', Store: 'Store & Inventory', Electrical: 'Electrical & Service' };
      // These downstream stages don't have their own dedicated functional
      // nav group the way Purchase/Store do, and by request they're grouped
      // together under "Manufacturing" alongside its sub-processes, rather
      // than each getting its own separate top-level tab - the assembly/
      // finishing/dispatch chain that follows Manufacturing in the pipeline.
      const UNDER_MANUFACTURING = ['Assembling', 'Packing', 'Shipping', 'Installation'];
      stages.forEach(s => {
        if (s === 'Manufacturing' || UNDER_MANUFACTURING.includes(s)) return; // handled below, grouped under "Manufacturing"
        const deptLabel = SHORT_STAGE_LABELS[s] || STAGE_LABELS[s] || s;
        const id = 'jc_' + s;
        const fullTitle = deptLabel + ' Job Cards';
        PAGES[id] = (el) => renderDeptJobCards(el, s, fullTitle);
        PAGE_TITLES[id] = fullTitle;
        const item = { id, label: 'Job Cards' };
        const mergeGroup = MERGE_INTO[s] && NAV.find(g => g.group === MERGE_INTO[s]);
        if (mergeGroup) mergeGroup.items.push(item);
        else DEPT_JOBCARDS_GROUPS.push({ group: deptLabel, items: [item] });
      });
      // Manufacturing group: "Overall" + one item per sub-process (Fitting/
      // Tacking/Welding/Buffing-Sandblast/Painting), each filtering the same
      // combined by-stage('Manufacturing') result down to its own section -
      // PLUS Assembling/Packing/Shipping/Installation as their own items in
      // this same group, each a normal independent by-stage call (they're
      // separate pipeline stages, not Manufacturing sub-processes, so they
      // don't get folded into that combined query - just grouped alongside it
      // in the sidebar).
      const mfgItems = [{ id: 'jc_Manufacturing', label: 'Overall', only: null }]
        .concat((DEPT_SUB_STAGES.Manufacturing || []).map(s => ({ id: 'jc_' + s, label: STAGE_LABELS[s] || s, only: s })));
      mfgItems.forEach(it => {
        PAGES[it.id] = (el) => renderDeptJobCards(el, 'Manufacturing', (STAGE_LABELS[it.only] || 'Manufacturing') + ' Job Cards', it.only);
        PAGE_TITLES[it.id] = (STAGE_LABELS[it.only] || 'Manufacturing') + ' Job Cards';
      });
      const downstreamItems = UNDER_MANUFACTURING.map(s => {
        const deptLabel = SHORT_STAGE_LABELS[s] || STAGE_LABELS[s] || s;
        const id = 'jc_' + s;
        const fullTitle = deptLabel + ' Job Cards';
        PAGES[id] = (el) => renderDeptJobCards(el, s, fullTitle);
        PAGE_TITLES[id] = fullTitle;
        return { id, label: deptLabel };
      });
      DEPT_JOBCARDS_GROUPS.push({ group: 'Manufacturing', items: mfgItems.map(it => ({ id: it.id, label: it.label })).concat(downstreamItems) });
    } catch (e) { /* pipeline-stages should always succeed; degrade quietly */ }
  }
  renderSidebar();
  const landing = (!ALLOWED_PAGES || ALLOWED_PAGES.has('dashboard')) ? 'dashboard' : (NAV.flatMap(g => g.items).find(it => ALLOWED_PAGES.has(it.id)) || { id: 'dashboard' }).id;
  navigate(landing);
}

// ===================== Navigation / Sidebar =====================
const NAV = [
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
    { id: 'offer-pdf-designer', label: 'Offer PDF Layout Designer' },
    { id: 'orders', label: 'Sales Orders' },
    { id: 'clients', label: 'Clients' },
    { id: 'sales-analytics', label: 'Sales Analytics' },
    { id: 'sales-targets', label: 'Sales Targets' },
  ]},
  { group: 'Projects Management', items: [
    { id: 'projects', label: 'Projects' },
    { id: 'targets', label: 'Targets' },
    { id: 'jobcards', label: 'My Job Cards' },
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
    { id: 'sc-transfers', label: 'Store → Service Center Transfers' },
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
    // Monthly Expense Tracker / Year Summary / Categories retired here -
    // its categories and historical entries were folded into Operating
    // Expenses above (see db/index.js's one-time migration), which is now
    // the single continuous record. routes/expenseTracker.js and its
    // tables are left completely intact, just no longer linked from the
    // sidebar, so this is reversible by re-adding these 3 lines.
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
// Per-department Job Cards groups are injected dynamically in boot() for
// Admin/ProjectManager logins only - one SEPARATE sidebar group/tab per
// department (Design, Purchase, Electrical, Store, Laser & Bending,
// Manufacturing, Assembling, Packing, Shipping, Installation), not lumped
// together under one combined group - so they can see every department's
// queue without switching logins. Everyone else keeps their single
// department-scoped "My Job Cards" tab under Projects Management.
const DEPT_JOBCARDS_GROUPS = [];
// A department-scoped login's own dedicated sidebar group, named after
// their department (e.g. "Design", "Electrical", "Manufacturing") - set up
// fresh in boot() for whoever's currently logged in.
const DEPT_OWN_GROUP = { group: '', items: [] };

// Which sidebar groups the user has explicitly EXPANDED, keyed by group
// label, persisted per-browser so it survives navigation and page reloads.
// Every group defaults to collapsed (a missing/falsy key) unless the user
// has opened it before - the inverse of an earlier "collapsed" map, kept as
// an expanded-set instead so a fresh browser starts with the whole sidebar
// collapsed rather than everything open. A group containing the page
// currently being opened is always force-expanded (see navigate()) even if
// the user had previously collapsed it - collapsing a group is a "get it
// out of my way for now" choice, not "hide this forever".
function loadExpandedNavGroups() {
  try { return JSON.parse(localStorage.getItem('erp_expanded_nav_groups') || '{}'); } catch (e) { return {}; }
}
function saveExpandedNavGroups(map) {
  try { localStorage.setItem('erp_expanded_nav_groups', JSON.stringify(map)); } catch (e) {}
}
window.toggleNavGroup = (label) => {
  const map = loadExpandedNavGroups();
  map[label] = !map[label];
  saveExpandedNavGroups(map);
  renderSidebar();
  if (CURRENT_PAGE) {
    const navEl = document.getElementById('nav-' + CURRENT_PAGE);
    if (navEl) navEl.classList.add('active');
  }
};

// Generic default-collapsed panel wrapper for the handful of high-traffic
// list panels (Vendors, Purchase Orders, Item Master, etc.) that are long
// enough to want out of the way until the user actually needs them - same
// "collapsed by default, remembered once expanded" behavior as the sidebar
// nav groups above, just keyed per-panel instead of per-nav-group. `key`
// must be a stable, unique, attribute-safe id for this panel across the
// app (e.g. 'vendors-list'). `headHtml` is rendered inside the clickable
// header next to the chevron - callers put any dynamic count span there
// with its own id so search/filter handlers can keep updating just that
// text without needing to know about the collapsible wrapper.
function loadExpandedPanels() {
  try { return JSON.parse(localStorage.getItem('erp_expanded_panels') || '{}'); } catch (e) { return {}; }
}
function saveExpandedPanels(map) {
  try { localStorage.setItem('erp_expanded_panels', JSON.stringify(map)); } catch (e) {}
}
function collapsiblePanel(key, headHtml, bodyHtml) {
  const expanded = loadExpandedPanels();
  const isCollapsed = !expanded[key];
  return `<div class="panel collapsible${isCollapsed ? ' collapsed' : ''}" id="cp-${key}">
    <h3 class="panel-head" onclick="toggleCollapsiblePanel('${key}')">${headHtml}<span class="chev">&#9660;</span></h3>
    <div class="panel-body">${bodyHtml}</div>
  </div>`;
}
window.toggleCollapsiblePanel = (key) => {
  const el = document.getElementById('cp-' + key);
  if (!el) return;
  const expanded = loadExpandedPanels();
  expanded[key] = !expanded[key];
  saveExpandedPanels(expanded);
  el.classList.toggle('collapsed');
};
// ===================== Mobile sidebar drawer =====================
// On screens <=768px the sidebar becomes an off-canvas drawer (see the
// matching @media block in index.html). These just toggle the 'open'
// class on the sidebar + a dimming overlay; navigate() below auto-closes
// it after picking a page so users don't have to close it by hand every
// time on a phone.
function toggleSidebarDrawer() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebarDrawer() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}
window.toggleSidebarDrawer = toggleSidebarDrawer;
window.closeSidebarDrawer = closeSidebarDrawer;

function renderSidebar() {
  const el = document.getElementById('sidebar');
  el.innerHTML = `<div class="brand"><strong>Venkateshwara Engineers</strong><span>ERP System</span></div>`;
  const groups = [...NAV];
  if (DEPT_OWN_GROUP.items.length) groups.splice(3, 0, DEPT_OWN_GROUP); // right after Projects Management
  // Placed right after Projects Management too (not appended at the very
  // bottom below 11 other groups) so Admin/PM logins can't miss it - each
  // department is its own separate group/tab, in pipeline order, rather than
  // combined into one "Department Job Cards" group.
  if (DEPT_JOBCARDS_GROUPS.length) groups.splice(3, 0, ...DEPT_JOBCARDS_GROUPS);
  const expanded = loadExpandedNavGroups();
  groups.forEach(g => {
    const items = ALLOWED_PAGES ? g.items.filter(it => ALLOWED_PAGES.has(it.id)) : g.items;
    if (!items.length) return; // hide an empty group entirely rather than showing a bare heading
    const isCollapsed = !expanded[g.group];
    const div = document.createElement('div');
    div.className = 'nav-group' + (isCollapsed ? ' collapsed' : '');
    const h4 = document.createElement('h4');
    h4.innerHTML = `<span>${esc(g.group)}</span><span class="chev">&#9660;</span>`;
    h4.onclick = () => toggleNavGroup(g.group);
    div.appendChild(h4);
    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'nav-items';
    items.forEach(it => {
      const a = document.createElement('a');
      a.className = 'nav-item'; a.id = 'nav-' + it.id; a.textContent = it.label;
      a.onclick = () => navigate(it.id);
      itemsWrap.appendChild(a);
    });
    div.appendChild(itemsWrap);
    el.appendChild(div);
  });
}

const PAGE_TITLES = {};
NAV.forEach(g => g.items.forEach(it => PAGE_TITLES[it.id] = it.label));

let CURRENT_PAGE = null;
async function navigate(id) {
  CURRENT_PAGE = id;
  closeSidebarDrawer();
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  let navEl = document.getElementById('nav-' + id);
  // If this page's nav item lives inside a collapsed group (e.g. a deep
  // link, or the group was collapsed on a previous visit), expand that
  // group so the active item is actually visible, not just highlighted
  // somewhere the user can't see.
  if (navEl) {
    const groupDiv = navEl.closest('.nav-group');
    if (groupDiv && groupDiv.classList.contains('collapsed')) {
      const labelSpan = groupDiv.querySelector('h4 span');
      const label = labelSpan ? labelSpan.textContent : null;
      if (label) {
        const expanded = loadExpandedNavGroups();
        expanded[label] = true;
        saveExpandedNavGroups(expanded);
        renderSidebar();
        navEl = document.getElementById('nav-' + id);
      }
    }
  }
  if (navEl) navEl.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[id] || id;
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty">Loading...</div>';
  try {
    await PAGES[id](content);
  } catch (e) {
    content.innerHTML = `<div class="msg err">${e.message}</div>`;
  }
}

// ===================== Helpers =====================
function esc(s) { return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function badge(status) { return `<span class="badge ${esc(status)}">${esc(status)}</span>`; }
function fmt(n) { return n === null || n === undefined ? '-' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function today() { return new Date().toISOString().slice(0, 10); }
// Round 16: color-coded delivery-date badge for SO/PO lists - green if
// comfortably ahead, amber inside the 7-day warning window (matches the
// scan job's WARNING_DAYS), red once past due. No date on file renders
// nothing rather than a false badge.
function deliveryBadge(dateStr) {
  if (!dateStr) return '<span class="muted">-</span>';
  const days = Math.round((new Date(dateStr) - new Date(today())) / 86400000);
  let cls = 'active', label = dateStr;
  if (days < 0) { cls = 'Rejected'; label = `${dateStr} (overdue ${-days}d)`; }
  else if (days <= 7) { cls = 'Pending'; label = `${dateStr} (due in ${days}d)`; }
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function thisMonth() { return new Date().toISOString().slice(0, 7); }

function tableHTML(columns, rows, rowRenderer) {
  if (!rows.length) return '<div class="empty">No records yet.</div>';
  return `<table><thead><tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(rowRenderer).join('')}
  </tbody></table>`;
}

// ---- Generic multi-field list search ----
// Every "All X" list page (Clients, Sales Orders, Offers, ...) already hands
// its full row set straight to the browser (these lists are small enough
// that there's never been a need for server-side paging), so a live,
// client-side, multi-field filter is all "search this list" needs - no new
// backend search index to build or keep in sync. Typing filters by
// substring match against every field named in `fields`, re-rendering just
// the table (and its count) rather than the whole page, so the box never
// loses focus while typing.
const LIST_SEARCH_STATE = {};
function renderListSearch(key, allRows, fields, onFilter, placeholder) {
  LIST_SEARCH_STATE[key] = { allRows, fields, onFilter };
  return `<input type="text" class="list-search" placeholder="${esc(placeholder || 'Search...')}"
    oninput="filterList('${key}', this.value)"
    style="margin:8px 0;width:100%;max-width:360px;padding:7px 10px;border:1px solid var(--border);border-radius:5px;font-size:13px;">`;
}
window.filterList = (key, query) => {
  const st = LIST_SEARCH_STATE[key];
  if (!st) return;
  const q = query.trim().toLowerCase();
  const filtered = !q ? st.allRows : st.allRows.filter(row =>
    st.fields.some(f => String(row[f] ?? '').toLowerCase().includes(q))
  );
  st.onFilter(filtered);
};

async function loadSelectOptions(selectEl, apiPath, valueKey, labelKey, placeholder) {
  const items = await api(apiPath);
  selectEl.innerHTML = `<option value="">${placeholder || 'Select...'}</option>` +
    items.map(i => `<option value="${i[valueKey]}">${esc(i[labelKey])}</option>`).join('');
  return items;
}

// Generic "download template / upload filled template" pair used by Item
// Master, Stock In/Out, Vendors and Attendance bulk-upload panels.
function bulkUploadPanelHTML(fileInputId) {
  return `<div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <input id="${fileInputId}" type="file" accept=".xlsx,.xls">
    </div>`;
}
// `filename` is only a fallback for when the server's response carries no
// Content-Disposition (e.g. a plain xlsx template, not a generated PDF) -
// most callers pass one that's since gone stale (a generic "InvoiceNo.pdf"
// hardcoded at the call site) now that the server names generated documents
// itself (lib/downloadFilename.js); the real, current name always wins when
// the server sends one.
async function downloadTemplateFile(apiPath, filename) {
  try {
    const res = await fetch('/api' + apiPath, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not download template'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = match ? match[1] : filename; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}
async function uploadTemplateFile(apiPath, fileInputId, resultElId, afterSuccess) {
  const resultEl = document.getElementById(resultElId);
  const fileEl = document.getElementById(fileInputId);
  if (!fileEl.files.length) { alert('Choose a filled template file first.'); return; }
  try {
    const fd = new FormData();
    fd.append('file', fileEl.files[0]);
    const result = await apiUpload(apiPath, fd, 'POST');
    // `updated` is only present on the importers that support upsert
    // (re-uploading the same file to fix/complete existing records) -
    // shown only when present so importers that are strictly insert-only
    // don't show a misleading "Updated: 0".
    resultEl.innerHTML = `<div class="msg ${result.errors.length ? 'err' : 'ok'}">
      Inserted: <b>${result.inserted}</b>${result.updated !== undefined ? `, Updated: <b>${result.updated}</b>` : ''}, Skipped: <b>${result.skipped}</b>
      ${result.errors.length ? '<br>' + result.errors.map(e => esc(e)).join('<br>') : ''}
      ${result.warnings && result.warnings.length ? '<br>' + result.warnings.map(w => esc(w)).join('<br>') : ''}
    </div>`;
    if ((result.inserted > 0 || result.updated > 0) && afterSuccess) afterSuccess();
  } catch (e) { resultEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
}

function showMsg(container, text, ok) {
  const el = document.createElement('div');
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = text;
  container.prepend(el);
  setTimeout(() => el.remove(), 4000);
}

function daysSince(dateStr) {
  if (!dateStr) return '-';
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// A small breakdown bar list used by stat drill-down panels - reuses the
// same "div width %" progress-bar pattern PAGES.dashboard's Project
// Drill-Down section already uses, so no charting library is needed.
function breakdownBars(counts, isCurrency) {
  const max = Math.max(1, ...Object.values(counts).map(n => Math.abs(n)));
  return Object.entries(counts).map(([label, n]) => `
    <div style="margin-bottom:6px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;"><span>${esc(label)}</span><span>${isCurrency ? '₹' + fmt(n) : n}</span></div>
      <div style="background:#eee;border-radius:4px;height:8px;overflow:hidden;"><div style="width:${Math.min(100, Math.round(100*Math.abs(n)/max))}%;background:var(--primary);height:100%;"></div></div>
    </div>`).join('');
}

// ===================== Stat tile drill-downs =====================
// Generic click-to-expand detail used by every reporting page's "cards"
// row (Dashboard, Department Report, Service Reports Dashboard, Finance
// Ledger, Cash vs Accounted Report). Each PAGES function registers a
// key -> async-HTML-builder map in window.__STAT_DETAIL_BUILDERS just
// before rendering, and renders its tiles with statCard(key, num, label)
// plus a `<div id="stat-detail"></div>` placeholder right under the
// cards row. Clicking a tile toggles a panel there showing the
// underlying records for that stat plus a bit of added analysis
// (breakdown/grouping/ageing) - never just a flat re-fetch.
window.__STAT_DETAIL_BUILDERS = {};
window.__STAT_DETAIL_OPEN = {};
function statCard(key, num, label, panelId) {
  panelId = panelId || 'stat-detail';
  return `<div class="card" data-stat="${esc(key)}" data-panel="${esc(panelId)}" onclick="showStatDetail('${esc(key)}','${esc(panelId)}')"><div class="num">${num}</div><div class="label">${esc(label)}</div></div>`;
}
window.showStatDetail = async (key, panelId) => {
  panelId = panelId || 'stat-detail';
  const panel = document.getElementById(panelId);
  if (!panel) return;
  if (window.__STAT_DETAIL_OPEN[panelId] === key) {
    window.__STAT_DETAIL_OPEN[panelId] = null;
    panel.innerHTML = '';
    document.querySelectorAll(`.card[data-panel="${panelId}"]`).forEach(c => c.classList.remove('active'));
    return;
  }
  window.__STAT_DETAIL_OPEN[panelId] = key;
  document.querySelectorAll(`.card[data-panel="${panelId}"]`).forEach(c => c.classList.toggle('active', c.dataset.stat === key));
  panel.innerHTML = '<div class="panel"><span class="muted">Loading detail...</span></div>';
  try {
    const builder = window.__STAT_DETAIL_BUILDERS[key];
    if (!builder) { panel.innerHTML = ''; return; }
    const html = await builder();
    panel.innerHTML = `<div class="panel" id="stat-detail-panel">${html}</div>`;
  } catch (e) {
    panel.innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
  }
};

// ===================== Dashboard cross-department metric registry =====================
// A single place listing metrics already computed by each department's own
// report endpoint (Sales Analytics, Purchase, Store, Service, HR, Finance,
// Projects/Time&Motion, Tickets) so the Dashboard can let a user pick any of
// them for review without duplicating each page's fetch/aggregation logic -
// fetchValue() and buildDetail() both call the SAME endpoint each metric's
// home page already uses.
const DASHBOARD_METRIC_REGISTRY = [
  { key: 'sales_win_rate', label: 'Sales: Win Rate', department: 'Sales',
    fetchValue: async () => { const d = await api('/sales/analytics'); return d.winRate === null ? '-' : d.winRate + '%'; },
    buildDetail: async () => { const d = await api('/sales/analytics'); return `<h3>Win Rate: ${d.winRate === null ? '-' : d.winRate + '%'}</h3><p class="muted">Conversion funnel</p>${tableHTML(['Stage','Count','Value'], d.funnel, f => `<tr><td>${esc(f.stage)}</td><td>${f.count}</td><td>₹${fmt(f.value)}</td></tr>`)}`; } },
  { key: 'sales_cycle', label: 'Sales: Avg Sales Cycle (days)', department: 'Sales',
    fetchValue: async () => { const d = await api('/sales/analytics'); return d.avgCycleDays ?? '-'; },
    buildDetail: async () => { const d = await api('/sales/analytics'); return `<h3>Avg Sales Cycle: ${d.avgCycleDays ?? '-'} days</h3>${tableHTML(['Rep','Leads Owned','Won Count'], d.repPerf, r => `<tr><td>${esc(r.owner_name)}</td><td>${r.leads_owned}</td><td>${r.won_count||0}</td></tr>`)}`; } },
  { key: 'purchase_pending_pr', label: 'Purchase: Pending Purchase Requests', department: 'Purchase',
    fetchValue: async () => (await api('/purchase/requests')).filter(r => r.status === 'Pending').length,
    buildDetail: async () => { const reqs = (await api('/purchase/requests')).filter(r => r.status === 'Pending'); const total = reqs.reduce((a,r) => a + (r.items_total_value != null ? r.items_total_value : (r.estimated_value||0)), 0); return `<h3>Pending Purchase Requests (${reqs.length})</h3><p class="muted">Total estimated value: ₹${fmt(total)}</p>${tableHTML(['PR No','Project','Item(s)','Est. Value'], reqs, r => `<tr><td>${esc(r.pr_no)}</td><td>${esc(r.project_code)||'-'}</td><td>${esc(r.item_summary)||esc(r.item_name)||esc(r.item_text)||'-'}</td><td>₹${fmt(r.items_total_value != null ? r.items_total_value : r.estimated_value)}</td></tr>`)}`; } },
  { key: 'store_low_stock', label: 'Store: Low Stock Items', department: 'Store',
    fetchValue: async () => (await api('/purchase/store/low-stock')).length,
    buildDetail: async () => { const items = await api('/purchase/store/low-stock'); return `<h3>Low Stock Items (${items.length})</h3>${tableHTML(['Code','Name','Current','Reorder Level'], items, i => `<tr><td>${esc(i.item_code)}</td><td>${esc(i.name)}</td><td>${fmt(i.current_stock)}</td><td>${fmt(i.reorder_level)}</td></tr>`)}`; } },
  { key: 'service_open', label: 'Service: Open Service Requests', department: 'Service',
    fetchValue: async () => (await api('/service')).filter(r => !['Resolved','Closed'].includes(r.status)).length,
    buildDetail: async () => { const reqs = (await api('/service')).filter(r => !['Resolved','Closed'].includes(r.status)); return `<h3>Open Service Requests (${reqs.length})</h3>${tableHTML(['SR No','Customer','Status'], reqs, r => `<tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${badge(r.status)}</td></tr>`)}`; } },
  { key: 'hr_pending_leave', label: 'HR: Pending Leave Requests', department: 'HR/Payroll',
    fetchValue: async () => (await api('/hr/leave-requests')).filter(r => r.status === 'Pending').length,
    buildDetail: async () => { const reqs = (await api('/hr/leave-requests')).filter(r => r.status === 'Pending'); return `<h3>Pending Leave Requests (${reqs.length})</h3>${tableHTML(['Employee','Leave Type','From','To'], reqs, r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.leave_type_name)}</td><td>${r.from_date}</td><td>${r.to_date}</td></tr>`)}`; } },
  { key: 'finance_outflow_month', label: 'Finance: Total Outflow (This Month)', department: 'Finance',
    fetchValue: async () => { const s = await api('/finance/summary?month=' + thisMonth()); return '₹' + fmt(s.outflow); },
    buildDetail: async () => { const month = thisMonth(); const s = await api('/finance/summary?month=' + month); const ledger = (await api('/finance/ledger')).filter(l => l.direction === 'Outflow'); return `<h3>Total Outflow (${esc(month)}): ₹${fmt(s.outflow)}</h3>${tableHTML(['Date','Type','Department','Amount'], ledger.slice(0,100), l => `<tr><td>${new Date(l.entry_date).toLocaleDateString()}</td><td>${esc(l.type)}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td></tr>`)}`; } },
  { key: 'finance_inflow_month', label: 'Finance: Total Inflow (This Month)', department: 'Finance',
    fetchValue: async () => { const s = await api('/finance/summary?month=' + thisMonth()); return '₹' + fmt(s.inflow); },
    buildDetail: async () => { const month = thisMonth(); const s = await api('/finance/summary?month=' + month); const ledger = (await api('/finance/ledger')).filter(l => l.direction === 'Inflow'); return `<h3>Total Inflow (${esc(month)}): ₹${fmt(s.inflow)}</h3>${tableHTML(['Date','Type','Department','Amount'], ledger.slice(0,100), l => `<tr><td>${new Date(l.entry_date).toLocaleDateString()}</td><td>${esc(l.type)}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td></tr>`)}`; } },
  { key: 'design_alloc_start', label: 'Design: Avg Allocation-to-Start Time', department: 'Projects',
    fetchValue: async () => { const d = await api('/projects/time-motion-report?stage=Design'); return tmHrs(d.overall?.alloc_to_start.avg); },
    buildDetail: async () => { const d = await api('/projects/time-motion-report?stage=Design'); return `<h3>Design: Avg Allocation→Start: ${tmHrs(d.overall?.alloc_to_start.avg)}</h3>${tableHTML(['Card','Project','Assignee','Alloc→Start'], d.cards.filter(c=>c.alloc_to_start_hrs!==null), c => `<tr><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${esc(c.assignee_name)||'-'}</td><td>${tmHrs(c.alloc_to_start_hrs)}</td></tr>`)}`; } },
  { key: 'electrical_alloc_start', label: 'Electrical: Avg Allocation-to-Start Time', department: 'Projects',
    fetchValue: async () => { const d = await api('/projects/time-motion-report?stage=Electrical'); return tmHrs(d.overall?.alloc_to_start.avg); },
    buildDetail: async () => { const d = await api('/projects/time-motion-report?stage=Electrical'); return `<h3>Electrical: Avg Allocation→Start: ${tmHrs(d.overall?.alloc_to_start.avg)}</h3>${tableHTML(['Card','Project','Assignee','Alloc→Start'], d.cards.filter(c=>c.alloc_to_start_hrs!==null), c => `<tr><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${esc(c.assignee_name)||'-'}</td><td>${tmHrs(c.alloc_to_start_hrs)}</td></tr>`)}`; } },
  { key: 'manufacturing_start_complete', label: 'Manufacturing: Avg Start-to-Completion Time', department: 'Projects',
    fetchValue: async () => { const d = await api('/projects/time-motion-report?stage=Manufacturing'); return tmHrs(d.overall?.start_to_complete.avg); },
    buildDetail: async () => { const d = await api('/projects/time-motion-report?stage=Manufacturing'); return `<h3>Manufacturing: Avg Start→Completion: ${tmHrs(d.overall?.start_to_complete.avg)}</h3>${tableHTML(['Card','Project','Assignee','Start→Complete'], d.cards.filter(c=>c.start_to_complete_hrs!==null), c => `<tr><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${esc(c.assignee_name)||'-'}</td><td>${tmHrs(c.start_to_complete_hrs)}</td></tr>`)}`; } },
  { key: 'projects_active', label: 'Projects: Active Projects', department: 'Projects',
    fetchValue: async () => (await api('/projects')).filter(p => p.status !== 'Completed').length,
    buildDetail: async () => { const projects = (await api('/projects')).filter(p => p.status !== 'Completed'); return `<h3>Active Projects (${projects.length})</h3>${tableHTML(['Code','Title','Status'], projects, p => `<tr><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${badge(p.status)}</td></tr>`)}`; } },
  { key: 'tickets_open_mine', label: 'Tickets: My Open Tickets', department: 'Tickets',
    fetchValue: async () => { try { return (await api('/tickets/mine')).filter(t => !['Closed','Resolved'].includes(t.status)).length; } catch (e) { return '-'; } },
    buildDetail: async () => { const tk = (await api('/tickets/mine')).filter(t => !['Closed','Resolved'].includes(t.status)); return `<h3>My Open Tickets (${tk.length})</h3>${tableHTML(['Ticket No','Subject','Priority','Status'], tk, t => `<tr><td>${esc(t.ticket_no)}</td><td>${esc(t.subject)}</td><td>${esc(t.priority)}</td><td>${badge(t.status)}</td></tr>`)}`; } },
  // TODO: Service Center stock module metrics (service_centers / service_center_stock
  // etc.) once that module lands - skipped here as it's a separate concurrent task.
];
function dashboardMetricRegistryByKey(key) { return DASHBOARD_METRIC_REGISTRY.find(m => m.key === key); }

// ===================== PAGES =====================
const PAGES = {};

// ---- Dashboard ----
PAGES.dashboard = async (el) => {
  const win = window.DASH_WINDOW || 'weekly';
  const [d, ws, projects] = await Promise.all([api('/dashboard/summary'), api('/dashboard/window-summary?window=' + win), api('/projects')]);
  const c = d.counts;
  window.__STAT_DETAIL_BUILDERS = {
    employees: async () => {
      const emps = (await api('/hr/employees')).filter(e => e.status === 'active');
      const byDept = {};
      emps.forEach(e => { const dpt = e.department_name || 'Unassigned'; byDept[dpt] = (byDept[dpt]||0) + 1; });
      return `<h3>Active Employees (${emps.length})</h3>
        <p class="muted">Breakdown by department</p>
        ${breakdownBars(byDept)}
        ${tableHTML(['Code','Name','Department','Designation','Type','Status'], emps, e => `
          <tr><td>${esc(e.employee_code)}</td><td>${esc(e.full_name)}</td><td>${esc(e.department_name)}</td><td>${esc(e.designation)}</td><td>${esc(e.employment_type)||'Full-time'}</td><td>${badge(e.status)}</td></tr>`)}`;
    },
    projects_active: async () => {
      const projects = (await api('/projects')).filter(p => p.status !== 'Completed');
      const byStatus = {};
      projects.forEach(p => { byStatus[p.status] = (byStatus[p.status]||0) + 1; });
      return `<h3>Active Projects (${projects.length})</h3>
        <p class="muted">Breakdown by stage</p>
        ${breakdownBars(byStatus)}
        ${tableHTML(['Code','Title','Client','PM','Status','Target Date'], projects, p => `
          <tr><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${esc(p.client_name)||'-'}</td><td>${esc(p.pm_name)||'-'}</td><td>${badge(p.status)}</td><td>${p.target_date||'-'}</td></tr>`)}`;
    },
    open_leads: async () => {
      const leads = (await api('/sales/leads')).filter(l => !['Won','Lost'].includes(l.stage));
      const byStage = {};
      leads.forEach(l => { byStage[l.stage] = (byStage[l.stage]||0) + 1; });
      const pipelineValue = leads.reduce((a,l) => a + (l.expected_value||0), 0);
      return `<h3>Open Leads (${leads.length})</h3>
        <p class="muted">Breakdown by stage &middot; Pipeline value: <b>₹${fmt(pipelineValue)}</b></p>
        ${breakdownBars(byStage)}
        ${tableHTML(['Client','Product Interest','Stage','Expected Value','Owner','Open (days)'], leads, l => `
          <tr><td>${esc(l.client_name)||'-'}</td><td>${esc(l.product_interest)||'-'}</td><td>${badge(l.stage)}</td><td>₹${fmt(l.expected_value)}</td><td>${esc(l.owner_name)||'-'}</td><td>${daysSince(l.created_at)}</td></tr>`)}`;
    },
    pending_expense_vouchers: async () => {
      const vouchers = (await api('/finance/expense-vouchers?status=Pending')).filter(v => v.status === 'Pending');
      const total = vouchers.reduce((a,v) => a + (v.amount||0), 0);
      const byDept = {};
      vouchers.forEach(v => { const dpt = v.department_name || 'Unassigned'; byDept[dpt] = (byDept[dpt]||0) + 1; });
      return `<h3>Pending Expense Vouchers (${vouchers.length})</h3>
        <p class="muted">Total pending value: <b>₹${fmt(total)}</b> &middot; Breakdown by department</p>
        ${breakdownBars(byDept)}
        ${tableHTML(['Voucher No','Dept','Category','Amount','Mode','Pending (days)'], vouchers, v => `
          <tr><td>${esc(v.voucher_no)}</td><td>${esc(v.department_name)}</td><td>${esc(v.category_name)}</td><td>₹${fmt(v.amount)}</td><td>${esc(v.payment_mode)}</td><td>${daysSince(v.created_at)}</td></tr>`)}`;
    },
    pending_leave: async () => {
      const reqs = (await api('/hr/leave-requests')).filter(r => r.status === 'Pending');
      const byType = {};
      reqs.forEach(r => { byType[r.leave_type_name] = (byType[r.leave_type_name]||0) + 1; });
      return `<h3>Pending Leave Requests (${reqs.length})</h3>
        <p class="muted">Breakdown by leave type</p>
        ${breakdownBars(byType)}
        ${tableHTML(['Employee','Leave Type','From','To','Days','Pending (days)'], reqs, r => `
          <tr><td>${esc(r.full_name)}</td><td>${esc(r.leave_type_name)}</td><td>${r.from_date}</td><td>${r.to_date}</td><td>${r.days}</td><td>${daysSince(r.created_at)}</td></tr>`)}`;
    },
    pending_purchase_requests: async () => {
      const reqs = (await api('/purchase/requests')).filter(r => r.status === 'Pending');
      const total = reqs.reduce((a,r) => a + (r.items_total_value != null ? r.items_total_value : (r.estimated_value||0)), 0);
      return `<h3>Pending Purchase Requests (${reqs.length})</h3>
        <p class="muted">Total estimated value: <b>₹${fmt(total)}</b></p>
        ${tableHTML(['PR No','Project','Item(s)','Lines','Est. Value','Raised By','Pending (days)'], reqs, r => `
          <tr><td>${esc(r.pr_no)}</td><td>${esc(r.project_code)||'-'}</td><td>${esc(r.item_summary)||esc(r.item_name)||esc(r.item_text)||'-'}</td><td>${r.line_count||1}</td><td>₹${fmt(r.items_total_value != null ? r.items_total_value : r.estimated_value)}</td><td>${esc(r.raised_by_name)||'-'}</td><td>${daysSince(r.created_at)}</td></tr>`)}`;
    },
    low_stock_items: async () => {
      const items = await api('/purchase/store/low-stock');
      items.sort((a,b) => (a.current_stock - a.reorder_level) - (b.current_stock - b.reorder_level));
      return `<h3>Low Stock Items (${items.length})</h3>
        <p class="muted">Sorted by how far below reorder level (worst first)</p>
        ${tableHTML(['Code','Name','Current Stock','Reorder Level','Shortfall','% Below'], items, i => {
          const shortfall = (i.reorder_level||0) - (i.current_stock||0);
          const pct = i.reorder_level ? Math.round(100 * shortfall / i.reorder_level) : 0;
          return `<tr><td>${esc(i.item_code)}</td><td>${esc(i.name)}</td><td>${fmt(i.current_stock)} ${esc(i.unit)}</td><td>${fmt(i.reorder_level)} ${esc(i.unit)}</td><td>${fmt(shortfall)}</td><td>${pct}%</td></tr>`;
        })}`;
    },
    open_service_requests: async () => {
      const reqs = (await api('/service')).filter(r => !['Resolved','Closed'].includes(r.status));
      const byStatus = {};
      reqs.forEach(r => { byStatus[r.status] = (byStatus[r.status]||0) + 1; });
      return `<h3>Open Service Requests (${reqs.length})</h3>
        <p class="muted">Breakdown by status</p>
        ${breakdownBars(byStatus)}
        ${tableHTML(['SR No','Customer','Issue','Assigned To','Status','Open (days)'], reqs, r => `
          <tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${esc(r.issue_description)||'-'}</td><td>${esc(r.assigned_to_name)||'-'}</td><td>${badge(r.status)}</td><td>${daysSince(r.created_at)}</td></tr>`)}`;
    },
    stock_in: async () => {
      const moves = (await api('/purchase/store/movements')).filter(m => m.movement_type === 'IN');
      return `<h3>Stock In (${win}) - ${moves.length} movements, ${fmt(ws.stockIn)} units</h3>
        ${tableHTML(['Date','Item','Qty','Ref'], moves.slice(0,100), m => `<tr><td>${esc(m.moved_at)}</td><td>${esc(m.item_name)||m.item_id}</td><td>${fmt(m.quantity)}</td><td>${esc(m.reference)||'-'}</td></tr>`)}`;
    },
    stock_out: async () => {
      const moves = (await api('/purchase/store/movements')).filter(m => m.movement_type === 'OUT');
      return `<h3>Stock Out (${win}) - ${moves.length} movements, ${fmt(ws.stockOut)} units</h3>
        ${tableHTML(['Date','Item','Qty','Ref'], moves.slice(0,100), m => `<tr><td>${esc(m.moved_at)}</td><td>${esc(m.item_name)||m.item_id}</td><td>${fmt(m.quantity)}</td><td>${esc(m.reference)||'-'}</td></tr>`)}`;
    },
    opex: async () => {
      return `<h3>Operating Expenses (${win})</h3>
        <p class="muted">Total: <b>₹${fmt(ws.opex)}</b></p>
        ${tableHTML(['Payment Mode', 'Accounted', 'Total'], d.expenseByMode, r => `<tr><td>${esc(r.payment_mode)}</td><td>${esc(r.accounted)}</td><td>₹${fmt(r.total)}</td></tr>`)}`;
    },
  };
  el.innerHTML = `
    <div class="cards">
      ${statCard('employees', c.employees, 'Active Employees')}
      ${statCard('projects_active', c.projects_active, 'Active Projects')}
      ${statCard('open_leads', c.open_leads, 'Open Leads')}
      ${statCard('pending_expense_vouchers', c.pending_expense_vouchers, 'Pending Expense Vouchers')}
      ${statCard('pending_leave', c.pending_leave, 'Pending Leave Requests')}
      ${statCard('pending_purchase_requests', c.pending_purchase_requests, 'Pending Purchase Requests')}
      ${statCard('low_stock_items', c.low_stock_items, 'Low Stock Items')}
      ${statCard('open_service_requests', c.open_service_requests, 'Open Service Requests')}
    </div>
    <div id="stat-detail"></div>
    <div id="dash-followups-widget"></div>
    <div class="panel">
      <h3>Add a Metric to Review</h3>
      <p class="muted">Pick any metric from another department to pin it here for review — no need to visit that department's own report page.</p>
      <div class="form-grid">
        <div style="grid-column:1/-1;"><label>Metric</label>
          <select id="dash-metric-pick">
            <option value="">Select a metric...</option>
            ${DASHBOARD_METRIC_REGISTRY.map(m => `<option value="${esc(m.key)}">${esc(m.department)}: ${esc(m.label.replace(m.department + ': ', ''))}</option>`).join('')}
          </select>
        </div>
      </div>
      <button class="btn small outline" onclick="addDashboardMetric()">Add</button>
    </div>
    <div id="dash-custom-metrics"></div>
    <div class="panel">
      <h3>Expenses by Payment Mode / Accounted Status</h3>
      ${tableHTML(['Payment Mode', 'Accounted', 'Total'], d.expenseByMode, r => `<tr><td>${esc(r.payment_mode)}</td><td>${esc(r.accounted)}</td><td>₹${fmt(r.total)}</td></tr>`)}
    </div>
    <div class="panel">
      <div class="toolbar"><h3 style="margin:0;">Inventory / Opex / Upcoming Schedules</h3>
        <select onchange="window.DASH_WINDOW=this.value;navigate('dashboard')">
          ${['daily','weekly','monthly'].map(w => `<option value="${w}" ${w===win?'selected':''}>${w[0].toUpperCase()+w.slice(1)}</option>`).join('')}
        </select>
      </div>
      <div class="cards">
        ${statCard('stock_in', fmt(ws.stockIn), 'Stock In (units)', 'stat-detail-win')}
        ${statCard('stock_out', fmt(ws.stockOut), 'Stock Out (units)', 'stat-detail-win')}
        ${statCard('opex', '₹' + fmt(ws.opex), 'Operating Expenses', 'stat-detail-win')}
      </div>
      <div id="stat-detail-win"></div>
      <h4>Upcoming Job Cards</h4>
      ${tableHTML(['Project', 'Item', 'Planned Start', 'Planned End'], ws.upcomingJobCards, j => `<tr><td>${esc(j.project_code)}</td><td>${esc(j.title||STAGE_LABELS[j.stage]||j.stage)}</td><td>${j.planned_start||'-'}</td><td>${j.planned_end||'-'}</td></tr>`)}
      <h4>Upcoming Service Requests</h4>
      ${tableHTML(['SR No', 'Scheduled', 'Issue'], ws.upcomingService, s => `<tr><td>${esc(s.sr_no)}</td><td>${s.scheduled_date}</td><td>${esc(s.issue_description)}</td></tr>`)}
    </div>
    <div class="panel">
      <h3>Project Drill-Down</h3>
      <div class="form-grid"><div><label>Project</label><select id="dash-proj-select" onchange="loadProjectDrilldown(this.value)">
        <option value="">Select a project...</option>${projects.map(p => `<option value="${p.id}">${esc(p.project_code)} - ${esc(p.title)}</option>`).join('')}
      </select></div></div>
      <div id="dash-drilldown"></div>
    </div>
  `;
  document.getElementById('dash-followups-widget').innerHTML = await dashboardFollowupsWidgetHTML();
  await renderDashboardCustomMetrics();
};

// Client-side only (per-browser, via localStorage) - the picked set doesn't
// need to persist server-side or be shared across viewers.
function loadDashboardMetricKeys() {
  try { return JSON.parse(localStorage.getItem('erp_dash_metrics') || '[]'); } catch (e) { return []; }
}
function saveDashboardMetricKeys(keys) {
  try { localStorage.setItem('erp_dash_metrics', JSON.stringify(keys)); } catch (e) {}
}
window.addDashboardMetric = () => {
  const key = val('dash-metric-pick');
  if (!key) return;
  const keys = loadDashboardMetricKeys();
  if (!keys.includes(key)) { keys.push(key); saveDashboardMetricKeys(keys); }
  renderDashboardCustomMetrics();
};
window.removeDashboardMetric = (key) => {
  saveDashboardMetricKeys(loadDashboardMetricKeys().filter(k => k !== key));
  renderDashboardCustomMetrics();
};
async function renderDashboardCustomMetrics() {
  const wrap = document.getElementById('dash-custom-metrics');
  if (!wrap) return;
  const keys = loadDashboardMetricKeys();
  if (!keys.length) { wrap.innerHTML = ''; return; }
  const metrics = keys.map(dashboardMetricRegistryByKey).filter(Boolean);
  wrap.innerHTML = `<div class="panel"><h3>Your Pinned Metrics</h3><div class="cards" id="dash-custom-cards"></div><div id="stat-detail-custom"></div></div>`;
  const cardsEl = document.getElementById('dash-custom-cards');
  cardsEl.innerHTML = metrics.map(m => `<span class="muted">Loading ${esc(m.label)}...</span>`).join(' ');
  const values = await Promise.all(metrics.map(async m => {
    try { return await m.fetchValue(); } catch (e) { return 'Error'; }
  }));
  metrics.forEach(m => { window.__STAT_DETAIL_BUILDERS['custom_' + m.key] = m.buildDetail; });
  cardsEl.innerHTML = metrics.map((m, i) => `
    <div class="card" data-stat="custom_${esc(m.key)}" data-panel="stat-detail-custom" onclick="showStatDetail('custom_${esc(m.key)}','stat-detail-custom')" style="position:relative;">
      <span title="Remove" onclick="event.stopPropagation();removeDashboardMetric('${esc(m.key)}')" style="position:absolute;top:4px;right:8px;cursor:pointer;color:#999;font-weight:bold;">&times;</span>
      <div class="num">${values[i]}</div><div class="label">${esc(m.label)}</div>
    </div>`).join('');
}
window.loadProjectDrilldown = async (projectId) => {
  const body = document.getElementById('dash-drilldown');
  if (!projectId) { body.innerHTML = ''; return; }
  body.innerHTML = '<span class="muted">Loading...</span>';
  const data = await api('/dashboard/project/' + projectId + '/drilldown');
  body.innerHTML = `
    <p><b>Overall Progress: ${data.overallProgress}%</b></p>
    <div class="progress-bar" style="background:#eee;border-radius:4px;height:10px;overflow:hidden;margin-bottom:12px;"><div style="width:${data.overallProgress}%;background:#2e7d32;height:100%;"></div></div>
    ${data.departments.map(dpt => `
      <div style="margin-bottom:10px;border-top:1px solid #eee;padding-top:8px;">
        <b>${esc(STAGE_LABELS[dpt.stage]||dpt.stage)}</b> — ${badge(dpt.status)} — ${dpt.progress}%
        <div style="background:#eee;border-radius:4px;height:8px;overflow:hidden;margin:4px 0;"><div style="width:${dpt.progress}%;background:#1565c0;height:100%;"></div></div>
        ${dpt.subProcesses.length ? `<div style="padding-left:16px;">
          ${dpt.subProcesses.map(sp => `<div style="font-size:12px;">${esc(STAGE_LABELS[sp.stage]||sp.title||sp.stage)}: ${badge(sp.status)}</div>`).join('')}
        </div>` : ''}
      </div>`).join('')}
  `;
};

// ---- Department Report (HOD/Supervisor of own department, or Admin) ----
PAGES['dept-report'] = async (el) => {
  const stage = ME.role === 'Admin' ? (window.DR_STAGE || 'Design') : ME.role;
  let stages = [];
  try { stages = await api('/projects/pipeline-stages'); } catch (e) {}
  const stagePicker = ME.role === 'Admin' ? `
    <div class="panel"><label>Department</label>
      <select onchange="window.DR_STAGE=this.value;navigate('dept-report')">
        ${stages.map(s => `<option value="${s}" ${s===stage?'selected':''}>${esc(STAGE_LABELS[s]||s)}</option>`).join('')}
      </select>
    </div>` : '';
  let data;
  try {
    data = await api('/reports/department/' + encodeURIComponent(stage));
  } catch (e) {
    el.innerHTML = stagePicker + `<div class="msg err">${esc(e.message)}</div>`;
    return;
  }
  const jcCols = ['Project', 'Item', 'Status', 'Days in Stage', 'Delayed'];
  const jcRow = c => `<tr><td>${esc(c.project_code)} - ${esc(c.project_title)}</td><td>${esc(c.title || STAGE_LABELS[c.stage] || c.stage)}</td><td>${badge(c.status)}</td><td>${c.days_in_stage}</td><td>${c.delayed?'⚠️ Yes':'-'}</td></tr>`;
  const byStatus = s => data.active.filter(c => c.status === s);
  window.__STAT_DETAIL_BUILDERS = {
    dr_Pending: async () => `<h3>Pending (${byStatus('Pending').length})</h3>${tableHTML(jcCols, byStatus('Pending'), jcRow)}`,
    dr_InProgress: async () => `<h3>In Progress (${byStatus('InProgress').length})</h3>${tableHTML(jcCols, byStatus('InProgress'), jcRow)}`,
    dr_Completed: async () => `<h3>Completed (${byStatus('Completed').length})</h3>${tableHTML(jcCols, byStatus('Completed'), jcRow)}`,
    dr_Delayed: async () => {
      const rows = data.active.filter(c => c.delayed);
      return `<h3>Delayed (${rows.length})</h3><p class="muted">Job cards past their planned time in this stage, worst first.</p>
        ${tableHTML(jcCols, rows.sort((a,b) => b.days_in_stage - a.days_in_stage), jcRow)}`;
    },
    dr_OnHold: async () => `<h3>On Hold (${byStatus('OnHold').length})</h3>${tableHTML(jcCols, byStatus('OnHold'), jcRow)}`,
    dr_cycle: async () => `<h3>Avg Cycle Time: ${data.avg_cycle_days ?? '-'} days</h3>
      <p class="muted">All active job cards in this stage, sorted by longest-running first.</p>
      ${tableHTML(jcCols, [...data.active].sort((a,b) => b.days_in_stage - a.days_in_stage), jcRow)}`,
  };
  el.innerHTML = `${stagePicker}
    <div class="cards">
      ${statCard('dr_Pending', data.counts.Pending||0, 'Pending')}
      ${statCard('dr_InProgress', data.counts.InProgress||0, 'In Progress')}
      ${statCard('dr_Completed', data.counts.Completed||0, 'Completed')}
      ${statCard('dr_Delayed', data.counts.Delayed||0, 'Delayed')}
      ${statCard('dr_OnHold', data.counts.OnHold||0, 'On Hold')}
      ${statCard('dr_cycle', data.avg_cycle_days ?? '-', 'Avg Cycle Time (days)')}
    </div>
    <div id="stat-detail"></div>
    ${collapsiblePanel('dept-report-active', `<span id="dr-active-count">Active Job Cards (${data.active.length})</span>`, `
      ${renderListSearch('dr-active', data.active, ['project_code', 'project_title', 'title', 'status'], (rows) => {
        document.getElementById('dr-active-table').innerHTML = tableHTML(jcCols, rows, jcRow);
        document.getElementById('dr-active-count').textContent = 'Active Job Cards (' + rows.length + ')';
      }, 'Search by project, item, status...')}
      <div id="dr-active-table">${tableHTML(jcCols, data.active, jcRow)}</div>
    `)}`;
};

// ---- Time & Motion Report ----
// Measures how long work sits after allocation before someone starts it
// (allocated_at -> started_at) and how long actual execution takes
// (started_at -> completed_at), across every department's job cards
// (they all flow through the same job_cards table / PATCH handler).
function tmHrs(h) { return h === null || h === undefined ? '-' : (h < 48 ? Math.round(h*10)/10 + ' hrs' : Math.round(h/24*10)/10 + ' days'); }
async function loadTimeMotionReport() {
  const stage = val('tm-stage') || '';
  const from = val('tm-from') || '';
  const to = val('tm-to') || '';
  const qs = new URLSearchParams();
  if (stage) qs.set('stage', stage);
  if (from) qs.set('date_from', from);
  if (to) qs.set('date_to', to);
  const data = await api('/projects/time-motion-report?' + qs.toString());
  window.__STAT_DETAIL_BUILDERS = {
    tm_alloc_start: async () => `<h3>Avg Allocation-to-Start: ${tmHrs(data.overall?.alloc_to_start.avg)}</h3>
      <p class="muted">Cards with both allocated_at and started_at recorded, most recent first.</p>
      ${tableHTML(['Stage','Card','Project','Assignee','Allocated','Started','Alloc→Start'],
        data.cards.filter(c => c.alloc_to_start_hrs !== null), c => `
        <tr><td>${esc(STAGE_LABELS[c.stage]||c.stage)}</td><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${esc(c.assignee_name)||'-'}</td>
        <td>${c.allocated_at?new Date(c.allocated_at).toLocaleString():'-'}</td><td>${c.started_at?new Date(c.started_at).toLocaleString():'-'}</td><td>${tmHrs(c.alloc_to_start_hrs)}</td></tr>`)}`,
    tm_start_complete: async () => `<h3>Avg Start-to-Completion: ${tmHrs(data.overall?.start_to_complete.avg)}</h3>
      ${tableHTML(['Stage','Card','Project','Assignee','Started','Completed','Start→Complete'],
        data.cards.filter(c => c.start_to_complete_hrs !== null), c => `
        <tr><td>${esc(STAGE_LABELS[c.stage]||c.stage)}</td><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${esc(c.assignee_name)||'-'}</td>
        <td>${c.started_at?new Date(c.started_at).toLocaleString():'-'}</td><td>${c.completed_at?new Date(c.completed_at).toLocaleString():'-'}</td><td>${tmHrs(c.start_to_complete_hrs)}</td></tr>`)}`,
    tm_total: async () => `<h3>Avg Allocation-to-Completion: ${tmHrs(data.overall?.alloc_to_complete.avg)}</h3>
      ${tableHTML(['Stage','Card','Project','Assignee','Alloc→Complete'],
        data.cards.filter(c => c.alloc_to_complete_hrs !== null), c => `
        <tr><td>${esc(STAGE_LABELS[c.stage]||c.stage)}</td><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${esc(c.assignee_name)||'-'}</td><td>${tmHrs(c.alloc_to_complete_hrs)}</td></tr>`)}`,
  };
  const byDeptBars = Object.fromEntries(data.byDepartment.map(g => [STAGE_LABELS[g.key]||g.key, Math.round((g.alloc_to_start.avg||0)*10)/10]));
  document.getElementById('tm-results').innerHTML = `
    <div class="cards">
      ${statCard('tm_alloc_start', tmHrs(data.overall?.alloc_to_start.avg), 'Avg Allocation → Start')}
      ${statCard('tm_start_complete', tmHrs(data.overall?.start_to_complete.avg), 'Avg Start → Completion')}
      ${statCard('tm_total', tmHrs(data.overall?.alloc_to_complete.avg), 'Avg Allocation → Completion')}
    </div>
    <div id="stat-detail"></div>
    <div class="panel">
      <h3>By Department — Avg Allocation-to-Start (hrs)</h3>
      ${Object.keys(byDeptBars).length ? breakdownBars(byDeptBars) : '<div class="empty">No data for this filter yet.</div>'}
    </div>
    <div class="panel">
      <h3>By Assignee</h3>
      ${tableHTML(['Assignee','Cards','Avg Alloc→Start','Avg Start→Complete','Avg Total'], data.byAssignee, g => `
        <tr><td>${esc(g.key)}</td><td>${g.count}</td><td>${tmHrs(g.alloc_to_start.avg)}</td><td>${tmHrs(g.start_to_complete.avg)}</td><td>${tmHrs(g.alloc_to_complete.avg)}</td></tr>`)}
    </div>
    ${collapsiblePanel('time-motion-cards', `<span id="tm-cards-count">Job Cards (${data.cards.length})</span>`, `
      ${renderListSearch('tm-cards', data.cards, ['stage', 'title', 'project_name', 'status', 'assignee_name'], (rows) => {
        document.getElementById('tm-cards-table').innerHTML = tableHTML(['Stage','Card','Project','Status','Assignee','Allocated','Started','Completed'], rows, c => `
          <tr><td>${esc(STAGE_LABELS[c.stage]||c.stage)}</td><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${badge(c.status)}</td><td>${esc(c.assignee_name)||'-'}</td>
          <td>${c.allocated_at?new Date(c.allocated_at).toLocaleString():'-'}</td><td>${c.started_at?new Date(c.started_at).toLocaleString():'-'}</td><td>${c.completed_at?new Date(c.completed_at).toLocaleString():'-'}</td></tr>`);
        document.getElementById('tm-cards-count').textContent = 'Job Cards (' + rows.length + ')';
      }, 'Search by stage, card, project, status, assignee...')}
      <div id="tm-cards-table">${tableHTML(['Stage','Card','Project','Status','Assignee','Allocated','Started','Completed'], data.cards, c => `
        <tr><td>${esc(STAGE_LABELS[c.stage]||c.stage)}</td><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${badge(c.status)}</td><td>${esc(c.assignee_name)||'-'}</td>
        <td>${c.allocated_at?new Date(c.allocated_at).toLocaleString():'-'}</td><td>${c.started_at?new Date(c.started_at).toLocaleString():'-'}</td><td>${c.completed_at?new Date(c.completed_at).toLocaleString():'-'}</td></tr>`)}</div>
    `)}`;
}
window.loadTimeMotionReport = loadTimeMotionReport;
PAGES['time-motion-report'] = async (el) => {
  let stages = [];
  try { stages = await api('/projects/pipeline-stages'); } catch (e) {}
  el.innerHTML = `
    <div class="panel">
      <h3>Time & Motion Study</h3>
      <p class="muted">Time from allocation to start (how long work sat before pickup) and start to completion (actual work duration), across every department.</p>
      <div class="form-grid">
        <div><label>Department / Stage</label><select id="tm-stage" onchange="loadTimeMotionReport()">
          <option value="">All Departments</option>${stages.map(s => `<option value="${s}">${esc(STAGE_LABELS[s]||s)}</option>`).join('')}
        </select></div>
        <div><label>From</label><input id="tm-from" type="date" onchange="loadTimeMotionReport()"></div>
        <div><label>To</label><input id="tm-to" type="date" onchange="loadTimeMotionReport()"></div>
      </div>
    </div>
    <div id="tm-results"><span class="muted">Loading...</span></div>
  `;
  await loadTimeMotionReport();
};

// ---- Approvals ----
// Grouped by category (the approval chain - e.g. "PurchaseRequest") and,
// within that, by the requester's department, so a role that approves
// several kinds of request (Admin, Management) can scan the queue by
// what it is and where it came from rather than a flat list of ids.
// The queue itself is a merge of four unrelated gates in the backend
// (formal approval chains, FOC material requests, BG reminders awaiting
// internal verification, and BG claim-expiry To-Dos assigned to this
// person) normalized into one shape by GET /approvals/pending - grouping
// and department drill-down here work the same regardless of which one a
// row came from; only the action column and its handler differ by source.
function approvalActionCell(r) {
  if (r.source === 'FOC') {
    // Approving requires picking a fulfilling department first (see
    // routes/finance.js POST /foc/:id/approve) - no room for that dropdown
    // in this compact queue row, so it opens the same decision in a modal.
    return `<button class="btn small" type="button" onclick="openFocApprovalModal(${r.id})">Review &amp; Decide</button>`;
  }
  if (r.source === 'BGReminder') {
    return `<button class="btn small green" onclick="actOnBgReminder(${r.id})">Verify</button>`;
  }
  if (r.source === 'BGClaimTask') {
    return `<button class="btn small green" onclick="actOnApprovalTodo(${r.id}, 'InProgress')">In Progress</button>
      <button class="btn small blue" onclick="actOnApprovalTodo(${r.id}, 'Completed')">Complete</button>`;
  }
  return `<button class="btn small green" onclick="actOnApproval(${r.id}, 'Approved')">Approve</button>
    <button class="btn small red" onclick="actOnApproval(${r.id}, 'Rejected')">Reject</button>
    <button class="btn small outline" onclick="actOnApproval(${r.id}, 'InfoRequested')">Ask for More Info</button>`;
}
PAGES.approvals = async (el) => {
  const pending = await api('/approvals/pending');
  window.__APPROVALS_CACHE = pending;
  const byChain = {};
  pending.forEach(r => { (byChain[r.chain_name] = byChain[r.chain_name] || []).push(r); });
  el.innerHTML = `<div class="panel"><h3>Pending My Approval (${pending.length})</h3>
    ${pending.length === 0 ? '<div class="empty">Nothing waiting on you right now.</div>' : ''}
  </div>` + Object.keys(byChain).sort().map(chainName => {
    const rows = byChain[chainName];
    const byDept = {};
    rows.forEach(r => { const dept = r.department_name || 'No department'; (byDept[dept] = byDept[dept] || []).push(r); });
    return `<div class="panel" style="margin-bottom:12px;">
      <h4 style="margin:0 0 8px;">${esc(chainName)} <span class="muted" style="font-weight:normal;">(${rows.length})</span></h4>
      ${Object.keys(byDept).sort().map(dept => `
        <div style="margin-bottom:10px;">
          <div style="font-weight:600;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">${esc(dept)}</div>
          ${tableHTML(['Reference', 'Details', 'Requested By', 'Amount', 'Step', 'Requested', 'Action'], byDept[dept], r => `
            <tr><td>${esc(r.ref)||('#'+r.entity_id)}</td><td>${esc(r.summary)||'-'}${r.is_resubmission ? ' <span class="badge Rejected" title="This was rejected before and has since been resubmitted">Resubmitted</span>' : ''}</td><td>${esc(r.raised_by_name)||'-'}</td><td>₹${fmt(r.amount)}</td><td>${r.current_step ?? '-'}</td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${approvalActionCell(r)}
            <button class="btn small outline" type="button" onclick="toggleApprovalDrilldown('${r.source}-${r.id}')">Details</button></td></tr>
            ${r.is_resubmission && r.prior_rejection_reason ? `<tr><td></td><td colspan="6" style="padding-top:0;"><span class="muted" style="font-size:12px;">Previously rejected${r.prior_rejected_by_name ? ' by ' + esc(r.prior_rejected_by_name) : ''}: ${esc(r.prior_rejection_reason)}</span></td></tr>` : ''}
            <tr id="appr-drill-row-${r.source}-${r.id}" style="display:none;"><td colspan="7"><div id="appr-drill-${r.source}-${r.id}"></div></td></tr>
          `)}
        </div>`).join('')}
    </div>`;
  }).join('');
};
window.actOnApproval = async (id, action) => {
  let comment = null;
  if (action === 'Rejected') comment = prompt('Reason for rejection (optional):');
  else if (action === 'InfoRequested') {
    comment = prompt('What information do you need from the requester?');
    if (!comment || !comment.trim()) return; // required - a blank note means "cancelled"
  }
  try {
    await api(`/approvals/${id}/act`, { method: 'POST', body: JSON.stringify({ action, comment }) });
    navigate('approvals');
  } catch (e) { alert(e.message); }
};
window.openFocApprovalModal = async (id) => {
  const departments = await api('/masters/departments');
  const body = `
    <div class="form-grid">
      <div><label>Route to Department (required before you can decide)</label>
        <select id="foc-modal-dept-${id}" onchange="document.getElementById('foc-modal-approve-${id}').disabled = !this.value; document.getElementById('foc-modal-reject-${id}').disabled = !this.value;">
          <option value="">-- Select --</option>
          ${departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <button class="btn small green" id="foc-modal-approve-${id}" disabled type="button" onclick="actOnFoc(${id}, 'approve')">Approve</button>
    <button class="btn small red" id="foc-modal-reject-${id}" disabled type="button" onclick="actOnFoc(${id}, 'reject')">Reject</button>`;
  openMiniModal('Review FOC Request', body);
};
window.actOnFoc = async (id, verb) => {
  try {
    const deptSelect = document.getElementById(`foc-modal-dept-${id}`);
    const body = verb === 'approve' ? { fulfilling_department_id: deptSelect ? deptSelect.value : undefined } : undefined;
    await api(`/finance/foc/${id}/${verb}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    closeMiniModal();
    navigate('approvals');
  } catch (e) { alert(e.message); }
};
window.actOnBgReminder = async (id) => {
  try {
    await api(`/bg/reminders/${id}/verify`, { method: 'POST' });
    navigate('approvals');
  } catch (e) { alert(e.message); }
};
window.actOnApprovalTodo = async (id, status) => {
  try {
    await api(`/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    navigate('approvals');
  } catch (e) { alert(e.message); }
};

// ---- My Approvals drill-down: full transaction context (line items, extra
// fields not in the flat summary, attachments where already supported
// elsewhere, and the approval action history) without leaving the queue.
function approvalHistoryTable(history) {
  if (!history || !history.length) return '<p class="muted" style="margin:4px 0;">No approval actions recorded yet.</p>';
  return tableHTML(['When', 'Step', 'Actor', 'Action', 'Comment'], history, h => `
    <tr><td>${new Date(h.acted_at).toLocaleString()}</td><td>${h.step_order ?? '-'}</td><td>${esc(h.actor_name)||'-'}</td><td>${esc(h.action)}</td><td>${esc(h.comment)||'-'}</td></tr>`);
}
window.toggleApprovalDrilldown = (key) => {
  const row = document.getElementById(`appr-drill-row-${key}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderApprovalDrilldown(key);
};
async function renderApprovalDrilldown(key) {
  const container = document.getElementById(`appr-drill-${key}`);
  container.innerHTML = '<p class="muted">Loading full details...</p>';
  const r = (window.__APPROVALS_CACHE || []).find(x => `${x.source}-${x.id}` === key);
  if (!r) { container.innerHTML = '<p class="muted">Not found - refresh the page.</p>'; return; }
  try {
    if (r.source === 'FOC') {
      const rows = await api('/finance/foc');
      const f = rows.find(x => x.id === r.entity_id);
      container.innerHTML = f ? `<div style="padding:10px;background:#f9f9f9;border-radius:6px;font-size:13px;">
        <b>Item:</b> ${esc(f.item_description)} &nbsp; <b>Qty:</b> ${f.quantity} ${esc(f.unit)} &nbsp; <b>Est. Value:</b> ₹${fmt(f.estimated_value)}<br>
        <b>Reason:</b> ${esc(f.reason)||'-'}
      </div>` : '<p class="muted">FOC request not found.</p>';
      return;
    }
    if (r.source === 'BGReminder' || r.source === 'BGClaimTask') {
      // Everything the backend has on these two is already merged onto the
      // queue row itself (see routes/approvals.js's unifiedQueueForUser) -
      // no separate fetch needed, just a fuller read of what's already here.
      container.innerHTML = `<div style="padding:10px;background:#f9f9f9;border-radius:6px;font-size:13px;">
        <b>Reference:</b> ${esc(r.ref)||'-'} &nbsp; <b>Category:</b> ${esc(r.chain_description)||'-'}<br>
        <b>Details:</b> ${esc(r.summary)||'-'}${r.amount != null ? ` &nbsp; <b>Value:</b> ₹${fmt(r.amount)}` : ''}${r.target_date ? ` &nbsp; <b>Target Date:</b> ${r.target_date}` : ''}
      </div>`;
      return;
    }
    // ApprovalChain-sourced: per-entity-type line items/extra fields, plus
    // the approval action history (for purchase_request this spans every
    // resubmission, via the same endpoint its own list page uses; the other
    // types have no resubmit workflow yet, so their single approval's own
    // history is the complete picture).
    let extraHtml = '', history = [], attachType = null;
    if (r.entity_type === 'purchase_request') {
      const [lines, hist] = await Promise.all([
        api(`/purchase/requests/${r.entity_id}/items`),
        api(`/purchase/requests/${r.entity_id}/approval-history`),
      ]);
      extraHtml = `<h5 style="margin:8px 0 4px;">Line Items</h5>${tableHTML(['Item', 'Qty', 'Est. Value'], lines, l => `
        <tr><td>${esc(l.item_name)||esc(l.item_text)||'-'}</td><td>${l.quantity}</td><td>₹${fmt(l.estimated_value)}</td></tr>`)}`;
      history = hist;
      attachType = 'purchase_request';
    } else if (r.entity_type === 'expense_voucher') {
      const [ev, hist] = await Promise.all([api(`/finance/expense-vouchers/${r.entity_id}`).catch(() => null), api(`/approvals/${r.id}/history`)]);
      extraHtml = ev ? `<h5 style="margin:8px 0 4px;">Details</h5><p style="font-size:13px;">
        <b>Voucher No:</b> ${esc(ev.voucher_no)} &nbsp; <b>Date:</b> ${new Date(ev.voucher_date).toLocaleDateString()}<br>
        <b>Category:</b> ${esc(ev.category_name)||'-'} &nbsp; <b>Payment Mode:</b> ${esc(ev.payment_mode)} &nbsp; <b>Accounted:</b> ${esc(ev.accounted)}<br>
        <b>Description:</b> ${esc(ev.description)||'-'}<br>
        ${ev.attachment_path ? `<a href="${esc(ev.attachment_path)}" target="_blank">View Attached Receipt</a>` : '<span class="muted">No receipt on file.</span>'}
      </p>` : '<p class="muted">Voucher not found.</p>';
      history = hist;
    } else if (r.entity_type === 'leave_request') {
      const [rows, hist] = await Promise.all([api('/hr/leave-requests'), api(`/approvals/${r.id}/history`)]);
      const lr = rows.find(x => x.id === r.entity_id);
      extraHtml = lr ? `<h5 style="margin:8px 0 4px;">Details</h5><p style="font-size:13px;">
        <b>Type:</b> ${esc(lr.leave_type_name)} &nbsp; <b>From:</b> ${lr.from_date} &nbsp; <b>To:</b> ${lr.to_date} &nbsp; <b>Days:</b> ${lr.days}<br>
        <b>Reason:</b> ${esc(lr.reason)||'-'}
      </p>` : '<p class="muted">Leave request not found.</p>';
      history = hist;
      attachType = 'leave_request';
    } else if (r.entity_type === 'salary_advance') {
      const [rows, hist] = await Promise.all([api('/hr/advances'), api(`/approvals/${r.id}/history`)]);
      const sa = rows.find(x => x.id === r.entity_id);
      extraHtml = sa ? `<h5 style="margin:8px 0 4px;">Details</h5><p style="font-size:13px;">
        <b>Amount:</b> ₹${fmt(sa.amount)} &nbsp; <b>Requested:</b> ${new Date(sa.request_date).toLocaleDateString()} &nbsp; <b>Already Recovered:</b> ₹${fmt(sa.recovered_amount)}<br>
        <b>Reason:</b> ${esc(sa.reason)||'-'}
      </p>` : '<p class="muted">Advance not found.</p>';
      history = hist;
      attachType = 'salary_advance';
    } else if (r.entity_type === 'salary_schedule') {
      const [rows, hist] = await Promise.all([api('/hr/salary-schedule'), api(`/approvals/${r.id}/history`)]);
      const ss = rows.find(x => x.id === r.entity_id);
      extraHtml = ss ? `<h5 style="margin:8px 0 4px;">Details</h5><p style="font-size:13px;">
        <b>Employee:</b> ${esc(ss.full_name)} &nbsp; <b>Month:</b> ${esc(ss.month)}<br>
        <b>Basic:</b> ₹${fmt(ss.basic)} &nbsp; <b>Allowances:</b> ₹${fmt(ss.allowances)} &nbsp; <b>Deductions:</b> ₹${fmt(ss.deductions)} &nbsp; <b>Advance Deduction:</b> ₹${fmt(ss.advance_deduction)}<br>
        <b>Gross:</b> ₹${fmt(ss.gross)} &nbsp; <b>Net Pay:</b> ₹${fmt(ss.net_pay)} &nbsp; <b>Days Present:</b> ${ss.days_present}
      </p>` : '<p class="muted">Payroll row not found.</p>';
      history = hist;
    } else if (r.entity_type === 'foreign_payment') {
      const [fp, hist] = await Promise.all([api(`/foreign-payments/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      extraHtml = `<h5 style="margin:8px 0 4px;">Details</h5><p style="font-size:13px;">
        <b>Beneficiary:</b> ${esc(fp.beneficiary_name)} &nbsp; <b>Amount:</b> ${esc(fp.currency)} ${fmt(fp.amount)}${fp.equivalent_inr ? ` &nbsp; <b>Equivalent INR:</b> ₹${fmt(fp.equivalent_inr)}` : ''}<br>
        <b>Vendor:</b> ${esc(fp.vendor_name)||'-'} &nbsp; <b>Beneficiary Bank:</b> ${esc(fp.beneficiary_bank_name)||'-'}
      </p>`;
      history = hist;
      attachType = 'foreign_payment';
    }
    container.innerHTML = `<div style="padding:10px;background:#f9f9f9;border-radius:6px;">
      ${extraHtml}
      <h5 style="margin:8px 0 4px;">Approval History${r.entity_type === 'purchase_request' ? ' (all submissions)' : ''}</h5>
      ${approvalHistoryTable(history)}
      <div id="appr-attach-${key}"></div>
    </div>`;
    if (attachType) renderAttachmentsWidget(attachType, r.entity_id, document.getElementById(`appr-attach-${key}`), attachType === 'foreign_payment' ? FP_DOCUMENT_TYPES : undefined);
  } catch (e) {
    container.innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
  }
}

// ---- Clients ----
let EDITING_CLIENT_ID = null;
function renderClientRows(rows) {
  return tableHTML(['Client ID', 'Name', 'Contact', 'Phone', 'Email', 'Address', 'Source', ''], rows, c => `
    <tr><td>${esc(c.client_code)||'-'}</td><td>${esc(c.name)}</td><td>${esc(c.contact_person)}</td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${esc(c.address)}</td><td>${esc(c.source)}</td>
    <td><button class="btn small outline" onclick='editClient(${JSON.stringify(c)})'>Edit</button>
    <button class="btn small outline" onclick="openClient360(${c.id})">View 360</button></td></tr>`);
}
PAGES.clients = async (el) => {
  const clients = await api('/masters/clients');
  el.innerHTML = `
    <div class="panel">
      <h3 id="cl-form-title">Add Client</h3>
      <div class="form-grid">
        <div><label>Name</label><input id="cl-name"></div>
        <div><label>Contact Person</label><input id="cl-contact"></div>
        <div><label>Phone</label><input id="cl-phone"></div>
        <div><label>Email</label><input id="cl-email"></div>
        <div><label>GSTIN</label><input id="cl-gstin"></div>
        <div><label>Source</label><input id="cl-source" placeholder="Referral / Website / Exhibition"></div>
      </div>
      <label>Address</label>
      <textarea id="cl-address" rows="2" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
      <div style="margin-top:10px;">
        <button class="btn" id="cl-save-btn" onclick="saveClient()">Add Client</button>
        <button class="btn outline" id="cl-cancel-btn" onclick="cancelClientEdit()" style="display:none;">Cancel</button>
      </div>
    </div>
    <div id="cl-addresses-panel"></div>
    <div style="margin-bottom:10px;"><button class="btn small outline" onclick="reportClients()">Generate Report (CSV)</button></div>
    ${collapsiblePanel('clients-list', `<span id="cl-count">All Clients (${clients.length})</span>`, `
      ${renderListSearch('clients', clients, ['client_code', 'name', 'contact_person', 'phone', 'email', 'address', 'source', 'gstin'], (rows) => {
        document.getElementById('cl-table-wrap').innerHTML = renderClientRows(rows);
        document.getElementById('cl-count').textContent = 'All Clients (' + rows.length + ')';
      }, 'Search by name, contact, phone, email, GSTIN, address...')}
      <div id="cl-table-wrap">${renderClientRows(clients)}</div>
    `)}`;
};
window.editClient = (c) => {
  EDITING_CLIENT_ID = c.id;
  document.getElementById('cl-form-title').textContent = `Edit Client — ${c.name} (${c.client_code || '#' + c.id})`;
  document.getElementById('cl-name').value = c.name || '';
  document.getElementById('cl-contact').value = c.contact_person || '';
  document.getElementById('cl-phone').value = c.phone || '';
  document.getElementById('cl-email').value = c.email || '';
  document.getElementById('cl-gstin').value = c.gstin || '';
  document.getElementById('cl-source').value = c.source || '';
  document.getElementById('cl-address').value = c.address || '';
  document.getElementById('cl-save-btn').textContent = 'Save Changes';
  document.getElementById('cl-cancel-btn').style.display = 'inline-block';
  document.getElementById('cl-form-title').scrollIntoView({ behavior: 'smooth' });
  renderClientAddressesPanel(c.id);
};
window.cancelClientEdit = () => navigate('clients');
window.saveClient = async () => {
  const payload = {
    name: val('cl-name'), contact_person: val('cl-contact'), phone: val('cl-phone'),
    email: val('cl-email'), gstin: val('cl-gstin'), source: val('cl-source'), address: val('cl-address')
  };
  try {
    if (EDITING_CLIENT_ID) {
      await api('/masters/clients/' + EDITING_CLIENT_ID, { method: 'PUT', body: JSON.stringify(payload) });
      EDITING_CLIENT_ID = null;
    } else {
      await api('/masters/clients', { method: 'POST', body: JSON.stringify(payload) });
    }
    navigate('clients');
  } catch (e) { alert(e.message); }
};
window.reportClients = async () => {
  const clients = await api('/masters/clients');
  downloadCSV('clients_report.csv', clients, ['id', 'client_code', 'name', 'contact_person', 'phone', 'email', 'address', 'gstin', 'source']);
};

// ---- Bill-to / Ship-to addresses (shown once a client exists to edit) ----
async function renderClientAddressesPanel(clientId) {
  const panel = document.getElementById('cl-addresses-panel');
  const addresses = await api(`/masters/clients/${clientId}/addresses`);
  const addrRow = (a) => `<tr>
      <td>${esc(a.address_type)}${a.is_default ? ' <span class="badge active">Default</span>' : ''}</td>
      <td>${esc(a.label)||'-'}</td>
      <td>${[a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).map(esc).join(', ')}</td>
      <td>${esc(a.gstin)||'-'}</td>
      <td><button class="btn small outline" onclick="deleteClientAddress(${clientId}, ${a.id})">Delete</button></td>
    </tr>`;
  panel.innerHTML = `
    <div class="panel"><h3>Bill-to / Ship-to Addresses</h3>
      ${tableHTML(['Type', 'Label', 'Address', 'GSTIN', ''], addresses, addrRow)}
      <div class="form-grid" style="margin-top:10px;">
        <div><label>Type</label><select id="ca-type"><option value="Billing">Billing</option><option value="Shipping">Shipping</option></select></div>
        <div><label>Label</label><input id="ca-label" placeholder="e.g. Head Office, Plant 2"></div>
        <div><label>GSTIN</label><input id="ca-gstin"></div>
        <div style="grid-column:1/-1;"><label>Address Line 1</label><input id="ca-line1"></div>
        <div style="grid-column:1/-1;"><label>Address Line 2</label><input id="ca-line2"></div>
        <div><label>City</label><input id="ca-city"></div>
        <div><label>State</label><input id="ca-state"></div>
        <div><label>State Code</label><input id="ca-state-code" placeholder="e.g. 06"></div>
        <div><label>Pincode</label><input id="ca-pincode"></div>
        <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="ca-default" type="checkbox"> Set as default for this type</label></div>
      </div>
      <button class="btn" onclick="addClientAddress(${clientId})">Add Address</button>
      <div id="ca-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>`;
}
window.addClientAddress = async (clientId) => {
  const errEl = document.getElementById('ca-err');
  try {
    await api(`/masters/clients/${clientId}/addresses`, { method: 'POST', body: JSON.stringify({
      address_type: val('ca-type'), label: val('ca-label'), line1: val('ca-line1'), line2: val('ca-line2'),
      city: val('ca-city'), state: val('ca-state'), state_code: val('ca-state-code'), pincode: val('ca-pincode'),
      gstin: val('ca-gstin'), is_default: document.getElementById('ca-default').checked,
    })});
    renderClientAddressesPanel(clientId);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteClientAddress = async (clientId, id) => {
  if (!confirm('Delete this address?')) return;
  await api(`/masters/client-addresses/${id}`, { method: 'DELETE' });
  renderClientAddressesPanel(clientId);
};
function val(id) { return document.getElementById(id).value; }

// ---- Customer 360 ----
const SOA_MODES = ['Cash', 'Cheque', 'NEFT', 'RTGS', 'UPI', 'Other'];
function soaSectionHTML(clientId, ledger) {
  if (!ledger) return '';
  const recent = ledger.rows.slice(-5).reverse();
  return `
    <h4>Statement of Account <span class="muted" style="font-weight:normal;">(closing balance: ₹${fmt(Math.abs(ledger.closingBalance))} ${ledger.closingBalance > 0 ? 'receivable' : ledger.closingBalance < 0 ? 'in credit' : ''})</span></h4>
    ${tableHTML(['Date', 'Type', 'Ref', 'Debit', 'Credit', 'Balance'], recent, r => `
      <tr><td>${new Date(r.date).toLocaleDateString()}</td><td>${esc(r.type)}</td><td>${esc(r.ref)}</td>
      <td>${r.debit ? '₹' + fmt(r.debit) : '-'}</td><td>${r.credit ? '₹' + fmt(r.credit) : '-'}</td><td>₹${fmt(r.balance)}</td></tr>`)}
    <div style="margin:8px 0;"><a href="#" onclick="downloadSoaPdf(${clientId});return false;">Download Full Statement (PDF)</a></div>
    <div class="form-grid" style="margin-top:6px;">
      <div><label>Record Payment - Amount (₹)</label><input id="soa-rcpt-amount" type="number"></div>
      <div><label>Date</label><input id="soa-rcpt-date" type="date" value="${today()}"></div>
      <div><label>Mode</label><select id="soa-rcpt-mode">${SOA_MODES.map(m => `<option>${m}</option>`).join('')}</select></div>
      <div><label>Reference No (optional)</label><input id="soa-rcpt-ref"></div>
    </div>
    <button class="btn small" onclick="recordPaymentReceipt(${clientId})">Record Payment</button>
    <div id="soa-rcpt-err" class="msg err" style="display:none;margin-top:6px;"></div>
  `;
}
window.openClient360 = async (clientId) => {
  const canSeeSoa = has('payment_receipt.manage', 'soa.manage', 'report.view_all');
  const [d, ledger] = await Promise.all([
    api('/masters/clients/' + clientId + '/360'),
    canSeeSoa ? api('/soa/ledger/' + clientId).catch(() => null) : Promise.resolve(null),
  ]);
  const c = d.client;
  const body = `
    <div class="form-grid">
      <div><label>Contact</label><div>${esc(c.contact_person) || '-'}</div></div>
      <div><label>Phone</label><div>${esc(c.phone) || '-'}</div></div>
      <div><label>Email</label><div>${esc(c.email) || '-'}</div></div>
      <div><label>GSTIN</label><div>${esc(c.gstin) || '-'}</div></div>
      <div><label>Source</label><div>${esc(c.source) || '-'}</div></div>
      <div><label>Total Business Value</label><div><b>₹${fmt(d.totalBusinessValue)}</b></div></div>
    </div>
    <h4>Leads (${d.leads.length})</h4>
    ${tableHTML(['Product', 'Value', 'Stage', 'Owner'], d.leads, l => `
      <tr><td>${esc(l.product_interest)}</td><td>₹${fmt(l.expected_value)}</td><td>${badge(l.stage)}</td><td>${esc(l.owner_name) || '-'}</td></tr>`)}
    <h4>Offers / Quotations (${d.offers.length})</h4>
    ${tableHTML(['Offer No', 'Subject', 'Status', 'Version'], d.offers, o => `
      <tr><td>${esc(o.offer_no)}</td><td>${esc(o.subject)}</td><td>${badge(o.status)}</td><td>v${o.version}</td></tr>`)}
    <h4>Sales Orders (${d.orders.length})</h4>
    ${tableHTML(['Order No', 'Value', 'Status', 'Date'], d.orders, o => `
      <tr><td>${esc(o.order_no)}</td><td>₹${fmt(o.order_value)}</td><td>${badge(o.status)}</td><td>${new Date(o.order_date).toLocaleDateString()}</td></tr>`)}
    ${soaSectionHTML(clientId, ledger)}
  `;
  openMiniModal('Customer 360 — ' + c.name, body, true);
};
window.downloadSoaPdf = (clientId) => downloadTemplateFile(`/soa/ledger/${clientId}/pdf`, `SOA-${clientId}.pdf`);
window.recordPaymentReceipt = async (clientId) => {
  const errEl = document.getElementById('soa-rcpt-err');
  errEl.style.display = 'none';
  try {
    await api('/soa/receipts', { method: 'POST', body: JSON.stringify({
      client_id: clientId, amount: val('soa-rcpt-amount'), receipt_date: val('soa-rcpt-date'),
      mode: val('soa-rcpt-mode'), reference_no: val('soa-rcpt-ref'),
    })});
    await openClient360(clientId);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- CSV report helper (used by Leads / Offers / Orders / Clients "Generate Report") ----
function downloadCSV(filename, rows, columns) {
  if (!rows.length) { alert('No records to export yet.'); return; }
  const cols = columns || Object.keys(rows[0]);
  const escCsv = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [cols.join(',')].concat(rows.map(r => cols.map(c => escCsv(r[c])).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---- Generic small modal (lost-reason capture, lead detail / activities, customer 360) ----
// `wide` is normally a boolean (760px vs 440px), but a number can be passed
// instead for a one-off wider case (e.g. an A4-proportioned preview).
function openMiniModal(title, bodyHTML, wide) {
  closeMiniModal();
  const overlay = document.createElement('div');
  overlay.id = 'mini-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px;';
  const maxWidth = typeof wide === 'number' ? wide : (wide ? 760 : 440);
  overlay.innerHTML = `<div class="panel" style="max-width:${maxWidth}px;width:100%;margin:0;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h3 style="margin:0;">${esc(title)}</h3>
      <button class="btn small outline" type="button" onclick="closeMiniModal()">Close</button>
    </div>
    <div style="margin-top:10px;">${bodyHTML}</div>
  </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMiniModal(); });
  document.body.appendChild(overlay);
  return overlay;
}
window.closeMiniModal = () => { const o = document.getElementById('mini-modal-overlay'); if (o) o.remove(); };

const LEAD_SOURCES = ['Website', 'Referral', 'Cold Call', 'Exhibition', 'Existing Client', 'Advertisement', 'Other'];
const LEAD_STAGES = ['New', 'Quoted', 'Negotiation', 'Won', 'Lost'];
const LOST_REASONS = ['Price', 'Timeline', 'Competitor', 'No Budget', 'No Response', 'Requirement Changed', 'Other'];
let LEADS_VIEW = 'list';

// ---- Leads ----
PAGES.leads = async (el) => { await renderLeadsPage(el); };
PAGES.pipeline = async (el) => { LEADS_VIEW = 'kanban'; await renderLeadsPage(el); };

async function renderLeadsPage(el) {
  const leads = await api('/sales/leads');
  el.innerHTML = `
    <div class="panel">
      <h3>New Lead / Enquiry</h3>
      <div class="form-grid">
        <div><label>Client</label><select id="ld-client"></select></div>
        <div><label>Product Interest</label>
          <select id="ld-product"><option>Weighing Systems</option><option>Bagging Systems</option><option>Material Handling</option><option>Fertilizer Plant Equipment</option></select>
        </div>
        <div><label>Lead Source</label><select id="ld-source"><option value="">-</option>${LEAD_SOURCES.map(s => `<option>${s}</option>`).join('')}</select></div>
        <div><label>Expected Value (₹)</label><input id="ld-value" type="number"></div>
        <div><label>Enquiry Details</label><textarea id="ld-details" rows="1"></textarea></div>
      </div>
      <button class="btn" onclick="addLead()">Add Lead</button>
    </div>
    <div class="toolbar" style="margin-bottom:10px;">
      <div class="tabs" style="margin:0;">
        <div class="tab ${LEADS_VIEW === 'list' ? 'active' : ''}" onclick="switchLeadsView('list')">List</div>
        <div class="tab ${LEADS_VIEW === 'kanban' ? 'active' : ''}" onclick="switchLeadsView('kanban')">Kanban</div>
      </div>
      <button class="btn small outline" onclick="reportLeads()">Generate Report (CSV)</button>
    </div>
    ${collapsiblePanel('leads-list', `<span id="ld-count">All Leads (${leads.length})</span>`, `
      ${renderListSearch('leads', leads, ['client_name', 'product_interest', 'lead_source', 'stage', 'owner_name'], (rows) => {
        document.getElementById('ld-count').textContent = 'All Leads (' + rows.length + ')';
        renderLeadsView(rows);
      }, 'Search by client, product, source, stage, owner...')}
      <div id="leads-view"></div>
    `)}`;
  await loadSelectOptions(document.getElementById('ld-client'), '/masters/clients', 'id', 'name', 'Select client');
  renderLeadsView(leads);
}
window.switchLeadsView = (v) => { LEADS_VIEW = v; navigate(CURRENT_PAGE === 'pipeline' ? 'pipeline' : 'leads'); };

function renderLeadsView(leads) {
  const container = document.getElementById('leads-view');
  if (!container) return;
  if (LEADS_VIEW === 'kanban') return renderLeadsKanban(container, leads);
  container.innerHTML = tableHTML(['Client', 'Product', 'Source', 'Value', 'Stage', 'Owner', 'Days in Stage', ''], leads, l => `
    <tr><td><a href="#" onclick="openLeadDetail(${l.id});return false;">${esc(l.client_name)}</a></td>
    <td>${esc(l.product_interest)}</td><td>${esc(l.lead_source) || '-'}</td><td>₹${fmt(l.expected_value)}</td>
    <td>${badge(l.stage)}${l.stage === 'Lost' && l.lost_reason ? ` <span class="muted" style="font-size:11px;">(${esc(l.lost_reason)})</span>` : ''}</td>
    <td>${esc(l.owner_name)}</td><td>${l.days_in_stage ?? '-'}</td>
    <td>${leadStageActions(l)} <button class="btn small outline" onclick="openLeadDetail(${l.id})">Activities</button></td></tr>`);
}

function renderLeadsKanban(container, leads) {
  const cols = LEAD_STAGES;
  container.innerHTML = `<div style="display:flex;gap:10px;overflow-x:auto;padding-top:4px;">
    ${cols.map(stage => {
      const items = leads.filter(l => l.stage === stage);
      const value = items.reduce((a, b) => a + Number(b.expected_value || 0), 0);
      return `<div class="kanban-col" data-stage="${esc(stage)}" style="flex:1;min-width:220px;background:#f6f7f9;border-radius:8px;padding:8px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;display:flex;justify-content:space-between;">
          <span>${esc(stage)} (${items.length})</span><span class="muted">₹${fmt(value)}</span>
        </div>
        <div class="kanban-dropzone" data-stage="${esc(stage)}" style="min-height:60px;">
          ${items.map(l => `
            <div class="kanban-card" draggable="true" data-lead-id="${l.id}"
              style="background:#fff;border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;cursor:grab;"
              onclick="openLeadDetail(${l.id})">
              <div style="font-weight:600;font-size:13px;">${esc(l.client_name)}</div>
              <div class="muted" style="font-size:12px;">₹${fmt(l.expected_value)}</div>
              <div class="muted" style="font-size:11px;">${esc(l.owner_name || '-')} &middot; ${l.days_in_stage ?? 0}d in stage</div>
            </div>`).join('') || '<div class="muted" style="font-size:12px;">Empty</div>'}
        </div>
      </div>`;
    }).join('')}
  </div>`;
  wireKanbanDragDrop(container);
}
function wireKanbanDragDrop(container) {
  let draggedId = null;
  container.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedId = card.getAttribute('data-lead-id');
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });
  });
  container.querySelectorAll('.kanban-dropzone').forEach(zone => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.outline = '2px dashed var(--primary)'; });
    zone.addEventListener('dragleave', () => { zone.style.outline = ''; });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.style.outline = '';
      const newStage = zone.getAttribute('data-stage');
      if (!draggedId || !newStage) return;
      await changeLeadStage(Number(draggedId), newStage);
    });
  });
}

async function changeLeadStage(id, stage) {
  const body = { stage };
  if (stage === 'Lost') {
    const captured = await promptLostReason();
    if (!captured) return; // cancelled
    Object.assign(body, captured);
  }
  try {
    await api(`/sales/leads/${id}/stage`, { method: 'PATCH', body: JSON.stringify(body) });
    navigate(CURRENT_PAGE);
  } catch (e) { alert(e.message); }
}
function promptLostReason() {
  return new Promise((resolve) => {
    const body = `
      <div><label>Reason</label>
        <select id="lr-reason">${LOST_REASONS.map(r => `<option>${r}</option>`).join('')}</select>
      </div>
      <div style="margin-top:8px;"><label>Detail (required for "Other", optional otherwise)</label>
        <textarea id="lr-detail" rows="2" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
      </div>
      <div style="margin-top:10px;">
        <button class="btn red" id="lr-confirm" type="button">Mark as Lost</button>
        <button class="btn outline" type="button" onclick="closeMiniModal()">Cancel</button>
      </div>`;
    const overlay = openMiniModal('Lost Reason Required', body);
    let resolved = false;
    overlay.addEventListener('click', (e) => { if (e.target === overlay && !resolved) { resolved = true; resolve(null); } });
    document.getElementById('lr-confirm').onclick = () => {
      const reason = document.getElementById('lr-reason').value;
      const detail = document.getElementById('lr-detail').value.trim();
      if (reason === 'Other' && !detail) { alert('Please provide a detail for "Other".'); return; }
      resolved = true;
      closeMiniModal();
      resolve({ lost_reason: reason, lost_reason_detail: detail || null });
    };
  });
}

window.reportLeads = async () => {
  const leads = await api('/sales/leads');
  downloadCSV('leads_report.csv', leads, ['id', 'client_name', 'product_interest', 'lead_source', 'expected_value', 'stage', 'owner_name', 'lost_reason', 'created_at']);
};
function leadStageActions(l) {
  if (l.stage === 'Won' || l.stage === 'Lost') return '';
  return `<select onchange="changeLeadStage(${l.id}, this.value); this.value='';">
    <option value="">Move to...</option>
    ${LEAD_STAGES.filter(s => s !== l.stage).map(s => `<option value="${s}">${s}</option>`).join('')}
  </select>`;
}
window.addLead = async () => {
  try {
    await api('/sales/leads', { method: 'POST', body: JSON.stringify({
      client_id: val('ld-client'), product_interest: val('ld-product'), expected_value: val('ld-value'),
      enquiry_details: val('ld-details'), lead_source: val('ld-source') || null
    })});
    navigate(CURRENT_PAGE);
  } catch (e) { alert(e.message); }
};

// ---- Lead detail: activity timeline + follow-up scheduling ----
const ACTIVITY_TYPES = ['Call', 'Email', 'Meeting', 'Site Visit', 'Demo', 'Note'];
window.openLeadDetail = async (leadId) => {
  const data = await api('/sales/leads/' + leadId);
  const l = data.lead;
  const body = `
    <div class="muted" style="margin-bottom:8px;">
      ${esc(l.product_interest)} &middot; ₹${fmt(l.expected_value)} &middot; ${badge(l.stage)} &middot; Source: ${esc(l.lead_source) || '-'} &middot; Owner: ${esc(l.owner_name) || '-'}
      ${l.stage === 'Lost' ? `<br>Lost reason: <b>${esc(l.lost_reason)}</b>${l.lost_reason_detail ? ' — ' + esc(l.lost_reason_detail) : ''}` : ''}
    </div>
    <h4 style="margin-bottom:4px;">Log Activity / Schedule Follow-up</h4>
    <div class="form-grid">
      <div><label>Type</label><select id="la-type">${ACTIVITY_TYPES.map(t => `<option>${t}</option>`).join('')}</select></div>
      <div><label>Due Date (optional)</label><input id="la-due" type="date"></div>
      <div style="grid-column:1/-1;"><label>Notes</label><textarea id="la-notes" rows="2" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea></div>
    </div>
    <button class="btn small" type="button" onclick="addLeadActivity(${leadId})">Log Activity</button>
    <h4 style="margin-top:14px;">Activity Timeline</h4>
    <div id="lead-activity-list">${renderActivityList(data.activities)}</div>`;
  openMiniModal('Lead #' + leadId + ' — ' + (l.client_name || ''), body, true);
};
function renderActivityList(activities) {
  if (!activities.length) return '<div class="empty">No activity logged yet.</div>';
  return activities.map(a => `
    <div style="border-bottom:1px solid var(--border);padding:6px 0;font-size:13px;">
      <div><b>${esc(a.activity_type)}</b> ${a.due_date ? `— due ${esc(a.due_date)}` : ''}
        ${a.completed_at ? '<span class="badge Completed">Done</span>' : (a.due_date && a.due_date <= today() ? '<span class="badge red">Due</span>' : '')}
      </div>
      ${a.notes ? `<div class="muted">${esc(a.notes)}</div>` : ''}
      <div class="muted" style="font-size:11px;">by ${esc(a.created_by_name) || '-'} on ${new Date(a.created_at).toLocaleString()}</div>
      ${!a.completed_at ? `<button class="btn small outline" type="button" onclick="completeLeadActivity(${a.lead_id || 0}, ${a.id})">Mark Done</button>` : ''}
    </div>`).join('');
}
window.addLeadActivity = async (leadId) => {
  try {
    await api(`/sales/leads/${leadId}/activities`, { method: 'POST', body: JSON.stringify({
      activity_type: val('la-type'), notes: val('la-notes'), due_date: val('la-due') || null
    })});
    openLeadDetail(leadId);
  } catch (e) { alert(e.message); }
};
window.completeLeadActivity = async (leadId, activityId) => {
  await api(`/sales/leads/activities/${activityId}/complete`, { method: 'PATCH' });
  if (leadId) openLeadDetail(leadId); else closeMiniModal();
};

// ---- Today's Follow-ups (own page + dashboard widget) ----
PAGES.followups = async (el) => {
  const items = await api('/sales/leads/followups');
  el.innerHTML = `<div class="panel">
    <h3>Today's Follow-ups (${items.length})</h3>
    <p class="muted">Activities due today or overdue, across your leads (all leads if you're Admin / have report access).</p>
    ${followupsTableHTML(items)}
  </div>`;
};
function followupsTableHTML(items) {
  if (!items.length) return '<div class="empty">Nothing due. Nice work.</div>';
  return tableHTML(['Due Date', 'Client', 'Type', 'Notes', 'Owner', ''], items, a => `
    <tr style="${a.due_date < today() ? 'background:#fff4f4;' : ''}">
      <td>${esc(a.due_date)}</td><td><a href="#" onclick="openLeadDetail(${a.lead_id});return false;">${esc(a.client_name)}</a></td>
      <td>${esc(a.activity_type)}</td><td>${esc(a.notes) || '-'}</td><td>${esc(a.owner_name) || '-'}</td>
      <td><button class="btn small outline" onclick="completeLeadActivity(${a.lead_id}, ${a.id})">Mark Done</button></td></tr>`);
}
async function dashboardFollowupsWidgetHTML() {
  try {
    const items = await api('/sales/leads/followups');
    return `<div class="panel">
      <div class="toolbar"><h3 style="margin:0;">Today's Follow-ups (${items.length})</h3>
        <a href="#" onclick="navigate('followups');return false;">View all</a></div>
      ${followupsTableHTML(items.slice(0, 5))}
    </div>`;
  } catch (e) { return ''; }
}

// ---- Sales Orders ----
const STAGE_LABELS = {
  Design: 'Design', Purchase: 'Purchase (BOM / Procurement)', Electrical: 'Electrical (Control Panel & Systems)',
  Store: 'Store (GRN / Issue)', LaserBending: 'Laser & Bending Processing',
  Fitting: 'Manufacturing — Fitting', Tacking: 'Manufacturing — Tacking', Welding: 'Manufacturing — Welding',
  BuffingSandblast: 'Manufacturing — Buffing / Sandblast', Painting: 'Manufacturing — Painting',
  Manufacturing: 'Manufacturing', Assembling: 'Assembling',
  Packing: 'Packing', Shipping: 'Shipping', Installation: 'Installation',
};
// Plain department name only (no parenthetical description) - used for
// sidebar group headers, which stay short; STAGE_LABELS' fuller wording is
// still used for page titles and table cells.
const SHORT_STAGE_LABELS = {
  Design: 'Design', Purchase: 'Purchase', Electrical: 'Electrical', Store: 'Store',
  LaserBending: 'Laser & Bending Processing', Manufacturing: 'Manufacturing',
  Assembling: 'Assembling', Packing: 'Packing', Shipping: 'Shipping', Installation: 'Installation',
};

function renderOrderRows(rows) {
  return tableHTML(['Order No', 'Client', 'Value', 'Status', 'Date', 'Promised Delivery', 'Annexure', ''], rows, o => `
    <tr><td>${esc(o.order_no)}</td><td>${esc(o.client_name)}</td><td>₹${fmt(o.order_value)}</td><td>${badge(o.status)}</td><td>${new Date(o.order_date).toLocaleDateString()}</td>
    <td>${deliveryBadge(o.promised_delivery_date)}</td>
    <td>${o.annexure_path ? `<a href="/api/sales/orders/${o.id}/annexure" onclick="return downloadAnnexure(event, ${o.id})">Annexure</a>` : `<a href="#" onclick="return generateAnnexure(event, ${o.id})">Generate</a>`}</td>
    <td><button class="btn small outline" type="button" onclick="toggleSOTerms(${o.id})">Commercial Terms</button>
    <button class="btn small outline" type="button" onclick="openOrderConfirmationModal(${o.id})">Confirmation &amp; Annexure</button>
    ${ME.role === 'Admin' && o.status === 'Confirmed' ? `<button class="btn small red" type="button" onclick="deleteOrderRow(${o.id})">Delete</button>` : ''}</td></tr>
    <tr id="so-terms-row-${o.id}" style="display:none;"><td colspan="8">${soTermsForm(o)}</td></tr>`);
}
window.deleteOrderRow = async (id) => {
  if (!confirm('Permanently delete this sales order? Only allowed while nothing has been built on it yet. This cannot be undone.')) return;
  try {
    await api('/sales/orders/' + id, { method: 'DELETE' });
    navigate('orders');
  } catch (e) { alert(e.message); }
};
PAGES.orders = async (el) => {
  const orders = await api('/sales/orders');
  const wonLeads = (await api('/sales/leads')).filter(l => l.stage === 'Won');
  el.innerHTML = `
    <div class="panel">
      <h3>New Sales Order</h3>
      <div class="form-grid">
        <div><label>Client</label><select id="so-client"></select></div>
        <div><label>From Lead (optional)</label><select id="so-lead"><option value="">-</option>${wonLeads.map(l => `<option value="${l.id}">#${l.id} ${esc(l.client_name)}</option>`).join('')}</select></div>
        <div><label>Order Value (₹)</label><input id="so-value" type="number"></div>
        <div><label>Description</label><textarea id="so-desc" rows="1"></textarea></div>
        <div><label>Promised Delivery Date</label><input id="so-delivery" type="date"></div>
      </div>
      <div class="hod-tools" style="margin-top:0;border-top:1px dashed var(--border);padding-top:10px;">
        <h4 style="margin-top:0;">LD Clause (optional)</h4>
        <div class="form-grid">
          <div><label>LD Rate (%)</label><input id="so-ld-pct" type="number" step="0.01"></div>
          <div><label>LD Cap (%)</label><input id="so-ld-cap" type="number" step="0.01"></div>
        </div>
        <div><label>Trigger Conditions</label><textarea id="so-ld-notes" rows="2" style="width:100%;" placeholder="e.g. 0.5% per week of delay, capped at 5% of order value"></textarea></div>
      </div>
      ${bgTermsFormFields('so')}
      <button class="btn" onclick="addOrder()">Create Order</button>
    </div>
    <div style="margin-bottom:10px;"><button class="btn small outline" onclick="reportOrders()">Generate Report (CSV)</button></div>
    ${collapsiblePanel('orders-list', `<span id="so-count">Sales Orders (${orders.length})</span>`, `
      ${renderListSearch('orders', orders, ['order_no', 'client_name', 'status', 'description'], (rows) => {
        document.getElementById('so-table-wrap').innerHTML = renderOrderRows(rows);
        document.getElementById('so-count').textContent = 'Sales Orders (' + rows.length + ')';
      }, 'Search by order no, client, status...')}
      <div id="so-table-wrap">${renderOrderRows(orders)}</div>
      <p class="muted" style="margin-top:10px;">Department-level target planning for a confirmed order now lives on the <a href="#" onclick="navigate('projects');return false;">Projects</a> tab, under that order's project.</p>
    `)}`;
  await loadSelectOptions(document.getElementById('so-client'), '/masters/clients', 'id', 'name', 'Select client');
};
window.reportOrders = async () => {
  const orders = await api('/sales/orders');
  downloadCSV('sales_orders_report.csv', orders, ['id', 'order_no', 'client_name', 'order_value', 'status', 'order_date', 'description']);
};
window.downloadAnnexure = async (ev, orderId) => {
  ev.preventDefault();
  try {
    const res = await fetch(`/api/sales/orders/${orderId}/annexure`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : 'annexure.docx';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
  return false;
};
window.generateAnnexure = async (ev, orderId) => {
  ev.preventDefault();
  try {
    await api(`/sales/orders/${orderId}/regenerate-annexure`, { method: 'POST' });
    navigate('orders');
  } catch (e) { alert(e.message); }
  return false;
};

// ---- Order Confirmation letter + Annexure dual-approval ----
// Two independent review -> approve -> lock workflows over an already-
// confirmed sales order's customer/execution-facing documents - production
// (the sales order, project, job cards) already started the moment the
// offer was confirmed and is never held up by this; see routes/orderConfirmation.js.
function reviewStatusBlock(doc, approvePerm, onApprove, onReject) {
  const canApprove = has(approvePerm);
  return `<div style="margin:6px 0;">Status: ${badge(doc.status)}${doc.locked ? ' <span class="muted">(locked)</span>' : ''}</div>
    ${doc.status === 'Rejected' && doc.rejection_reason ? `<div class="msg err" style="display:block;">Rejected: ${esc(doc.rejection_reason)}</div>` : ''}
    ${doc.status === 'PendingApproval' && canApprove ? `
      <button class="btn small green" type="button" onclick="${onApprove}">Approve</button>
      <button class="btn small red" type="button" onclick="${onReject}">Reject</button>` : ''}`;
}
async function renderOrderConfirmationModal(orderId) {
  const [oc, ar] = await Promise.all([
    api(`/order-confirmation/order-confirmations/${orderId}`),
    api(`/order-confirmation/annexure-reviews/${orderId}`),
  ]);
  const body = `
    <h4>Order Confirmation Letter</h4>
    ${reviewStatusBlock(oc, 'order_confirmation.approve', `approveOrderConfirmation(${orderId})`, `rejectOrderConfirmation(${orderId})`)}
    <div class="form-grid">
      <div><label>Delivery Terms</label><textarea id="oc-delivery-${orderId}" rows="2" style="width:100%;" ${oc.locked ? 'disabled' : ''}>${esc(oc.delivery_terms)}</textarea></div>
      <div><label>Payment Terms</label><textarea id="oc-payment-${orderId}" rows="2" style="width:100%;" ${oc.locked ? 'disabled' : ''}>${esc(oc.payment_terms)}</textarea></div>
    </div>
    <label>Special Instructions</label>
    <textarea id="oc-notes-${orderId}" rows="2" style="width:100%;" ${oc.locked ? 'disabled' : ''}>${esc(oc.special_instructions)}</textarea>
    <div style="margin-top:6px;">
      ${!oc.locked ? `<button class="btn small" onclick="saveOrderConfirmation(${orderId})">Save</button>
      ${['Draft', 'Rejected'].includes(oc.status) ? `<button class="btn small outline" onclick="submitOrderConfirmation(${orderId})">Submit for Approval</button>` : ''}` : ''}
      <a href="#" onclick="downloadOrderConfirmationPdf(${orderId});return false;">Download PDF</a>
    </div>

    <h4 style="margin-top:18px;border-top:1px solid var(--border);padding-top:12px;">Annexure</h4>
    ${reviewStatusBlock(ar, 'annexure.approve', `approveAnnexure(${orderId})`, `rejectAnnexure(${orderId})`)}
    <label>Review Notes</label>
    <textarea id="ar-notes-${orderId}" rows="2" style="width:100%;" ${ar.locked ? 'disabled' : ''}>${esc(ar.review_notes)}</textarea>
    <div style="margin-top:6px;">
      ${!ar.locked ? `<button class="btn small" onclick="saveAnnexureNotes(${orderId})">Save Notes</button>
      <button class="btn small outline" onclick="regenerateAnnexureInModal(${orderId})">Regenerate from Offer</button>
      <input type="file" id="ar-file-${orderId}" style="display:inline-block;width:auto;">
      <button class="btn small outline" onclick="uploadAnnexureFile(${orderId})">Upload Revised File</button>
      ${['Draft', 'Rejected'].includes(ar.status) ? `<button class="btn small outline" onclick="submitAnnexure(${orderId})">Submit for Approval</button>` : ''}` : ''}
      <a href="#" onclick="downloadAnnexure(event, ${orderId});return false;">Download Annexure</a>
    </div>
  `;
  openMiniModal('Order Confirmation & Annexure', body, true);
}
window.openOrderConfirmationModal = (orderId) => renderOrderConfirmationModal(orderId);
window.saveOrderConfirmation = async (orderId) => {
  try {
    await api(`/order-confirmation/order-confirmations/${orderId}`, { method: 'PUT', body: JSON.stringify({
      delivery_terms: val(`oc-delivery-${orderId}`), payment_terms: val(`oc-payment-${orderId}`), special_instructions: val(`oc-notes-${orderId}`),
    })});
    await renderOrderConfirmationModal(orderId);
  } catch (e) { alert(e.message); }
};
window.submitOrderConfirmation = async (orderId) => {
  try { await api(`/order-confirmation/order-confirmations/${orderId}/submit`, { method: 'POST' }); await renderOrderConfirmationModal(orderId); }
  catch (e) { alert(e.message); }
};
window.approveOrderConfirmation = async (orderId) => {
  try { await api(`/order-confirmation/order-confirmations/${orderId}/approve`, { method: 'POST' }); await renderOrderConfirmationModal(orderId); }
  catch (e) { alert(e.message); }
};
window.rejectOrderConfirmation = async (orderId) => {
  const reason = prompt('Reason for rejection (optional):');
  try { await api(`/order-confirmation/order-confirmations/${orderId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); await renderOrderConfirmationModal(orderId); }
  catch (e) { alert(e.message); }
};
window.downloadOrderConfirmationPdf = (orderId) => downloadTemplateFile(`/order-confirmation/order-confirmations/${orderId}/pdf`, `Order-Confirmation-${orderId}.pdf`);
window.regenerateAnnexureInModal = async (orderId) => {
  try {
    await api(`/sales/orders/${orderId}/regenerate-annexure`, { method: 'POST' });
    await renderOrderConfirmationModal(orderId);
  } catch (e) { alert(e.message); }
};
window.saveAnnexureNotes = async (orderId) => {
  try {
    await api(`/order-confirmation/annexure-reviews/${orderId}`, { method: 'PUT', body: JSON.stringify({ review_notes: val(`ar-notes-${orderId}`) }) });
    await renderOrderConfirmationModal(orderId);
  } catch (e) { alert(e.message); }
};
window.uploadAnnexureFile = async (orderId) => {
  const fileInput = document.getElementById(`ar-file-${orderId}`);
  if (!fileInput.files[0]) { alert('Choose a file first.'); return; }
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  try {
    await apiUpload(`/order-confirmation/annexure-reviews/${orderId}/upload`, fd, 'POST');
    await renderOrderConfirmationModal(orderId);
  } catch (e) { alert(e.message); }
};
window.submitAnnexure = async (orderId) => {
  try { await api(`/order-confirmation/annexure-reviews/${orderId}/submit`, { method: 'POST' }); await renderOrderConfirmationModal(orderId); }
  catch (e) { alert(e.message); }
};
window.approveAnnexure = async (orderId) => {
  try { await api(`/order-confirmation/annexure-reviews/${orderId}/approve`, { method: 'POST' }); await renderOrderConfirmationModal(orderId); }
  catch (e) { alert(e.message); }
};
window.rejectAnnexure = async (orderId) => {
  const reason = prompt('Reason for rejection (optional):');
  try { await api(`/order-confirmation/annexure-reviews/${orderId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); await renderOrderConfirmationModal(orderId); }
  catch (e) { alert(e.message); }
};

// Bank Guarantee terms (Round 28) - shared between the New Sales Order form
// (prefix 'so', no existing data) and the per-order Commercial Terms editor
// (prefix `so-terms-${id}`, prefilled from the order row). Declares whether
// an Advance/Performance BG is owed on this order; the actual BG record it
// gets satisfied by is still created separately on the BG Dashboard and
// resolved at read time via bank_guarantees' order_type/order_id link.
function bgTermsFormFields(prefix, o) {
  o = o || {};
  return `<div class="hod-tools" style="margin-top:10px;border-top:1px dashed var(--border);padding-top:10px;">
    <h4 style="margin-top:0;">Bank Guarantee Terms (optional)</h4>
    <div class="form-grid">
      <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="${prefix}-abg-required" type="checkbox" ${o.abg_required ? 'checked' : ''}> Advance BG (ABG) required</label></div>
      <div><label>ABG %</label><input id="${prefix}-abg-pct" type="number" step="0.01" value="${o.abg_percentage ?? ''}"></div>
      <div><label>ABG Amount (₹, if flat)</label><input id="${prefix}-abg-amt" type="number" value="${o.abg_amount ?? ''}"></div>
      <div><label>ABG Validity (days from issue)</label><input id="${prefix}-abg-days" type="number" value="${o.abg_validity_days ?? ''}"></div>
    </div>
    <div class="form-grid">
      <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="${prefix}-pbg-required" type="checkbox" ${o.pbg_required ? 'checked' : ''}> Performance BG (PBG) required</label></div>
      <div><label>PBG %</label><input id="${prefix}-pbg-pct" type="number" step="0.01" value="${o.pbg_percentage ?? ''}"></div>
      <div><label>PBG Amount (₹, if flat)</label><input id="${prefix}-pbg-amt" type="number" value="${o.pbg_amount ?? ''}"></div>
      <div><label>PBG Validity (days from issue)</label><input id="${prefix}-pbg-days" type="number" value="${o.pbg_validity_days ?? ''}"></div>
    </div>
    <div><label>BG Terms Notes</label><textarea id="${prefix}-bg-notes" rows="2" style="width:100%;">${esc(o.bg_terms_notes || '')}</textarea></div>
  </div>`;
}
function readBgTermsFields(prefix) {
  return {
    abg_required: document.getElementById(`${prefix}-abg-required`).checked,
    abg_percentage: val(`${prefix}-abg-pct`) || null,
    abg_amount: val(`${prefix}-abg-amt`) || null,
    abg_validity_days: val(`${prefix}-abg-days`) || null,
    pbg_required: document.getElementById(`${prefix}-pbg-required`).checked,
    pbg_percentage: val(`${prefix}-pbg-pct`) || null,
    pbg_amount: val(`${prefix}-pbg-amt`) || null,
    pbg_validity_days: val(`${prefix}-pbg-days`) || null,
    bg_terms_notes: val(`${prefix}-bg-notes`) || null,
  };
}
window.addOrder = async () => {
  try {
    const r = await api('/sales/orders', { method: 'POST', body: JSON.stringify({
      client_id: val('so-client'), lead_id: val('so-lead') || null, order_value: val('so-value'), description: val('so-desc')
    })});
    // Commercial terms aren't accepted by the create endpoint (kept
    // separate/optional, Round 16) - a second call sets them if the user
    // filled any of those fields in.
    const delivery = val('so-delivery'), ldPct = val('so-ld-pct'), ldCap = val('so-ld-cap'), ldNotes = val('so-ld-notes');
    const bgTerms = readBgTermsFields('so');
    const hasBgTerms = bgTerms.abg_required || bgTerms.pbg_required || bgTerms.abg_percentage || bgTerms.pbg_percentage || bgTerms.bg_terms_notes;
    if (delivery || ldPct || ldCap || ldNotes || hasBgTerms) {
      await api(`/sales/orders/${r.id}/commercial-terms`, { method: 'PATCH', body: JSON.stringify({
        promised_delivery_date: delivery || null, ld_percentage: ldPct || null, ld_cap_percentage: ldCap || null, ld_trigger_notes: ldNotes || null,
        ...bgTerms,
      })});
    }
    navigate('orders');
  } catch (e) { alert(e.message); }
};
function soTermsForm(o) {
  return `<div class="form-grid" style="margin-top:8px;">
    <div><label>Promised Delivery Date</label><input id="so-terms-delivery-${o.id}" type="date" value="${o.promised_delivery_date || ''}"></div>
    <div><label>LD Rate (%)</label><input id="so-terms-ldpct-${o.id}" type="number" step="0.01" value="${o.ld_percentage ?? ''}"></div>
    <div><label>LD Cap (%)</label><input id="so-terms-ldcap-${o.id}" type="number" step="0.01" value="${o.ld_cap_percentage ?? ''}"></div>
  </div>
  <div><label>Trigger Conditions</label><textarea id="so-terms-ldnotes-${o.id}" rows="2" style="width:100%;">${esc(o.ld_trigger_notes || '')}</textarea></div>
  ${bgTermsFormFields(`so-terms-${o.id}`, o)}
  <button class="btn small" type="button" onclick="saveSOTerms(${o.id})">Save Terms</button>`;
}
window.toggleSOTerms = (id) => {
  const row = document.getElementById(`so-terms-row-${id}`);
  row.style.display = row.style.display !== 'none' ? 'none' : '';
};
window.saveSOTerms = async (id) => {
  try {
    await api(`/sales/orders/${id}/commercial-terms`, { method: 'PATCH', body: JSON.stringify({
      promised_delivery_date: val(`so-terms-delivery-${id}`) || null,
      ld_percentage: val(`so-terms-ldpct-${id}`) || null,
      ld_cap_percentage: val(`so-terms-ldcap-${id}`) || null,
      ld_trigger_notes: val(`so-terms-ldnotes-${id}`) || null,
      ...readBgTermsFields(`so-terms-${id}`),
    })});
    navigate('orders');
  } catch (e) { alert(e.message); }
};

// ---- Offers / Quotations ----
async function apiUpload(path, formData, method) {
  const headers = {};
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch('/api' + path, { method: method || 'POST', headers, body: formData });
  let data; try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---- Generic attachments widget (Round 3 fix): reused by any page that
// needs "attach a file to this record" without a bespoke per-feature table.
// `documentTypes` is optional - when given (e.g. Foreign Payments'
// Payment Advice/Bill of Entry/... categories), a category dropdown shows
// next to the file picker and is sent as document_type on upload; every
// other caller omits it and behaves exactly as before.
async function renderAttachmentsWidget(entityType, entityId, container, documentTypes) {
  if (!entityId) { container.innerHTML = ''; return; }
  const list = await api(`/attachments/${entityType}/${entityId}`);
  container.innerHTML = `
    <div class="attachments-widget" style="margin-top:8px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Attachments</div>
      ${list.length ? list.map(a => `
        <div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:2px;">
          <a href="${esc(a.file_path)}" target="_blank">${esc(a.original_name || a.file_path)}</a>
          ${a.document_type ? `<span class="badge Draft">${esc(a.document_type)}</span>` : ''}
          <span class="muted">(${esc(a.uploaded_by_name)||'-'})</span>
          <button class="btn small outline" type="button" data-att-remove="${a.id}">Remove</button>
        </div>`).join('') : '<div class="muted" style="font-size:13px;">No attachments yet.</div>'}
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;">
        ${documentTypes ? `<select data-att-doctype><option value="">Category (optional)</option>${documentTypes.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>` : ''}
        <input type="file" data-att-file>
        <button class="btn small" type="button" data-att-upload>Attach File</button>
      </div>
    </div>`;
  container.querySelectorAll('[data-att-remove]').forEach(btn => {
    btn.onclick = async () => { await api('/attachments/' + btn.getAttribute('data-att-remove'), { method: 'DELETE' }); renderAttachmentsWidget(entityType, entityId, container, documentTypes); };
  });
  const uploadBtn = container.querySelector('[data-att-upload]');
  const fileInput = container.querySelector('[data-att-file]');
  const docTypeSelect = container.querySelector('[data-att-doctype]');
  uploadBtn.onclick = async () => {
    if (!fileInput.files.length) { alert('Choose a file first.'); return; }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    if (docTypeSelect && docTypeSelect.value) fd.append('document_type', docTypeSelect.value);
    try {
      await apiUpload(`/attachments/${entityType}/${entityId}`, fd);
      renderAttachmentsWidget(entityType, entityId, container, documentTypes);
    } catch (e) { alert(e.message); }
  };
}

let CURRENT_OFFER_ID = null;
let CURRENT_OFFER_TAB = 'scope';
let CURRENT_OFFER = null; // the offer header last fetched for the open builder - used to decide whether an edit will fork a new version
let OFFER_TERM_LIBRARY = []; // active offer_clause_library rows, category 'term' - refreshed each time renderOfferBuilder runs
let OFFER_TEXT_LIBRARY = { inclusion: [], exclusion: [], utilities: [], instrument_air: [] };
let OFFER_REQUIRE_LIBRARY_CLAUSES = false; // governance.require_library_clauses, as of the last renderOfferBuilder

// Any offer edit past Draft forks a new version server-side rather than
// overwriting a version that may already be with the customer (see
// lib/offerVersioning.js) - this asks up front so it isn't a silent
// surprise, and optionally captures why, which shows up in Version History.
// Returns null if the user cancels, else a (possibly empty) reason string.
function confirmOfferRevision(offer) {
  if (!offer || offer.status === 'Draft') return '';
  return prompt(
    `This offer has already been ${offer.status}. Saving this change will create a new version (v${offer.version + 1}) rather than overwrite the version already sent.\n\nOptionally, describe why you're revising it (shown in Version History):`,
    ''
  );
}
// After any content mutation that might have forked a new version, land the
// builder on whichever offer id is now current and refresh what's on screen.
async function afterOfferMutation(result, msg) {
  const panel = document.getElementById('offer-builder-panel');
  if (result && result.newVersion) {
    await openOfferBuilder(result.offerId);
    showMsg(panel, (msg || 'Saved') + ' as a new version.', true);
  } else {
    if (result && result.offerId) CURRENT_OFFER_ID = result.offerId;
    const data = await api('/offers/' + CURRENT_OFFER_ID);
    CURRENT_OFFER = data.offer;
    renderOfferTab(data);
    if (msg) showMsg(panel, msg, true);
  }
}

PAGES.offers = async (el) => {
  const [offers, clients, leads] = await Promise.all([api('/offers'), api('/masters/clients'), api('/sales/leads')]);
  el.innerHTML = `
    <div class="panel"><h3>New Offer</h3>
      <div class="form-grid">
        <div><label>Client</label><select id="nf-client">${clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Linked Enquiry / RFQ (optional)</label><select id="nf-lead">
          <option value="">-- None --</option>
          ${leads.map(l => `<option value="${l.id}">${esc(l.client_name)} - ${esc(l.product_interest || l.enquiry_details || ('Lead #' + l.id))}</option>`).join('')}
        </select></div>
        <div><label>Contact Person</label><input id="nf-contact"></div>
        <div><label>Contact Phone</label><input id="nf-phone"></div>
        <div><label>Subject / Machine</label><input id="nf-subject" placeholder="e.g. Electronic Weighing and Bagging System"></div>
      </div>
      ${clients.length === 0 ? '<div class="msg err">Add a client first (Sales &amp; Marketing &rarr; Clients).</div>' : ''}
      <button class="btn" onclick="createOffer()">Create Offer (opens builder with prefilled sheets)</button>
    </div>
    <div style="margin-bottom:10px;"><button class="btn small outline" onclick="reportOffers()">Generate Report (CSV)</button></div>
    ${collapsiblePanel('offers-list', `<span id="of-count">All Offers (${offers.length})</span>`, `
      ${renderListSearch('offers', offers, ['offer_no', 'client_name', 'subject', 'status', 'lead_enquiry_details'], (rows) => {
        document.getElementById('of-table-wrap').innerHTML = renderOfferRows(rows);
        document.getElementById('of-count').textContent = 'All Offers (' + rows.length + ')';
      }, 'Search by offer no, client, subject, status...')}
      <div id="of-table-wrap">${renderOfferRows(offers)}</div>
    `)}
    <div class="panel" id="offer-builder-panel" style="display:none;"></div>
  `;
};
function renderOfferRows(rows) {
  return tableHTML(['Offer No', 'Client', 'Enquiry/RFQ', 'Subject', 'Date', 'Status', ''], rows, o => `
    <tr><td>${esc(o.offer_no)}</td><td>${esc(o.client_name)}</td><td>${esc(o.lead_enquiry_details) || '-'}</td><td>${esc(o.subject)}</td><td>${new Date(o.offer_date).toLocaleDateString()}</td><td>${badge(o.status)}</td>
    <td><button class="btn small outline" onclick="openOfferBuilder(${o.id})">Open</button>
    ${ME.role === 'Admin' && !o.locked ? `<button class="btn small red" onclick="deleteOfferRow(${o.id})">Delete</button>` : ''}</td></tr>`);
}
window.deleteOfferRow = async (id) => {
  if (!confirm('Permanently delete this offer? This cannot be undone.')) return;
  try {
    await api('/offers/' + id, { method: 'DELETE' });
    navigate('offers');
  } catch (e) { alert(e.message); }
};
window.reportOffers = async () => {
  const offers = await api('/offers');
  downloadCSV('offers_report.csv', offers, ['id', 'offer_no', 'client_name', 'subject', 'offer_date', 'status', 'sales_order_id']);
};
window.createOffer = async () => {
  try {
    const r = await api('/offers', { method: 'POST', body: JSON.stringify({
      client_id: val('nf-client'), lead_id: val('nf-lead') || null, contact_person: val('nf-contact'), contact_phone: val('nf-phone'), subject: val('nf-subject')
    })});
    await openOfferBuilder(r.id);
  } catch (e) { alert(e.message); }
};

window.openOfferBuilder = async (id) => {
  CURRENT_OFFER_ID = id;
  const panel = document.getElementById('offer-builder-panel') || (() => {
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'offer-builder-panel';
    document.getElementById('content').appendChild(p); return p;
  })();
  panel.style.display = 'block';
  await renderOfferBuilder(panel);
  panel.scrollIntoView({ behavior: 'smooth' });
};

function offerFieldSelect(id, options, current) {
  const opts = options.map(o => o.value);
  if (current && !opts.includes(current)) opts.unshift(current); // keep a retired/pre-migration value selectable
  return `<select id="${id}"><option value="">-- Select --</option>${opts.map(v => `<option value="${esc(v)}" ${v===current?'selected':''}>${esc(v)}</option>`).join('')}</select>`;
}
async function renderOfferBuilder(panel) {
  const [data, versions, applicationOpts, typeOpts, materialOpts, termClauses, inclusionClauses, exclusionClauses, utilitiesClauses, airClauses, governance] = await Promise.all([
    api('/offers/' + CURRENT_OFFER_ID),
    api('/offers/' + CURRENT_OFFER_ID + '/versions'),
    api('/offers/field-options/application'),
    api('/offers/field-options/type_of_system'),
    api('/offers/field-options/material_of_construction'),
    api('/offers/clause-library/term'),
    api('/offers/clause-library/inclusion'),
    api('/offers/clause-library/exclusion'),
    api('/offers/clause-library/utilities'),
    api('/offers/clause-library/instrument_air'),
    api('/offers/governance').catch(() => ({ require_library_clauses: false })), // non-Admin can't read this - assume the lenient default
  ]);
  // Cached for renderOfferTab()'s terms/text sub-renderers (re-run on tab
  // switch without a refetch - the clause library rarely changes mid-edit).
  OFFER_TERM_LIBRARY = termClauses;
  OFFER_TEXT_LIBRARY = { inclusion: inclusionClauses, exclusion: exclusionClauses, utilities: utilitiesClauses, instrument_air: airClauses };
  OFFER_REQUIRE_LIBRARY_CLAUSES = !!governance.require_library_clauses;
  const o = data.offer;
  CURRENT_OFFER = o;
  const tabs = [
    ['scope', 'Scope of Supply & Pictures'],
    ['tech', 'Technical Specification' + (o.show_tech_specs === 0 ? ' (excluded)' : '')],
    ['boughtout', 'Make of Bought Out Items' + (o.show_bought_out === 0 ? ' (excluded)' : '')],
    ['terms', 'Terms & Conditions'],
    ['text', 'Inclusions / Exclusions / Utilities' + (o.show_inclusions_exclusions === 0 ? ' (excluded)' : '')],
  ];
  panel.innerHTML = `
    <h3>Offer Builder &mdash; ${esc(o.offer_no)} v${o.version} <span class="badge ${esc(o.status)}">${esc(o.status)}</span>${o.locked ? ' <span class="badge red">Locked</span>' : ''}</h3>
    ${o.locked ? `<div class="msg err" style="margin-bottom:10px;">
      This offer was converted to a Sales Order and is locked against further edits.${o.locked_reason ? ' ' + esc(o.locked_reason) + '.' : ''}
      ${ME.role === 'Admin' ? '<button class="btn small outline" style="margin-left:10px;" onclick="unlockOffer()">Unlock (Admin)</button>' : ' Ask an Admin to unlock it if this offer genuinely needs a further revision.'}
    </div>` : ''}
    ${versions.length > 1 ? `<div class="panel" style="background:#f6f7f9;">
      <b>Version History</b>
      ${tableHTML(['Version', 'Status', 'Date', 'Revision Reason', ''], versions, v => `
        <tr${v.id === o.id ? ' style="font-weight:600;"' : ''}><td>v${v.version}</td><td>${badge(v.status)}</td><td>${new Date(v.offer_date).toLocaleDateString()}</td>
        <td class="muted">${esc(v.revision_reason) || '-'}</td>
        <td>${v.id !== o.id ? `<button class="btn small outline" onclick="openOfferBuilder(${v.id})">View</button>` : '<span class="muted">Current</span>'}
        <a href="#" onclick="downloadOfferVersionPdf(${v.id});return false;">PDF</a></td></tr>`)}
    </div>` : ''}
    <div class="form-grid">
      <div><label>Subject / Machine</label><input id="ob-subject" value="${esc(o.subject)}"></div>
      <div><label>Contact Person</label><input id="ob-contact" value="${esc(o.contact_person)}"></div>
      <div><label>Contact Phone</label><input id="ob-phone" value="${esc(o.contact_phone)}"></div>
      <div><label>Contact Email</label><input id="ob-email" value="${esc(o.contact_email)}"></div>
      <div><label>Drawing No</label><input id="ob-drawing" value="${esc(o.drawing_no)}"></div>
      <div><label>Application</label>${offerFieldSelect('ob-application', applicationOpts, o.application)}</div>
      <div><label>Type Of System</label>${offerFieldSelect('ob-type', typeOpts, o.type_of_system)}</div>
      <div><label>Material Of Construction</label>${offerFieldSelect('ob-material', materialOpts, o.material_of_construction)}</div>
    </div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:8px;padding:10px;background:#f5f5f5;border-radius:6px;">
      <b style="width:100%;">Include in generated PDF:</b>
      <label style="margin:0;font-weight:normal;"><input id="ob-show-tech" type="checkbox" ${o.show_tech_specs !== 0 ? 'checked' : ''}> Technical Specifications</label>
      <label style="margin:0;font-weight:normal;"><input id="ob-show-boughtout" type="checkbox" ${o.show_bought_out !== 0 ? 'checked' : ''}> Make of Bought-Out Items</label>
      <label style="margin:0;font-weight:normal;"><input id="ob-show-inclexcl" type="checkbox" ${o.show_inclusions_exclusions !== 0 ? 'checked' : ''}> Inclusions / Exclusions / Utilities</label>
    </div>
    <div class="tabs">${tabs.map(([id, label]) => `<div class="tab ${CURRENT_OFFER_TAB === id ? 'active' : ''}" onclick="switchOfferTab('${id}')">${label}</div>`).join('')}</div>
    <div id="offer-tab-content"></div>
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
      <button class="btn" onclick="saveOfferHeader()">Save Header</button>
      <button class="btn outline" onclick="downloadOfferPdf()">Download PDF</button>
      ${o.status !== 'Won' ? `<button class="btn green" onclick="confirmOffer()">Confirm Order &rarr; Create Sales Order &amp; Queue for Execution</button>` : `<span class="muted">Confirmed as Sales Order #${o.sales_order_id}</span>`}
    </div>
  `;
  renderOfferTab(data);
}
window.saveOfferHeader = async () => {
  try {
    const data = await api('/offers/' + CURRENT_OFFER_ID);
    const reason = confirmOfferRevision(data.offer);
    if (reason === null) return;
    const r = await api('/offers/' + CURRENT_OFFER_ID, { method: 'PUT', body: JSON.stringify({
      subject: val('ob-subject'), contact_person: val('ob-contact'), contact_phone: val('ob-phone'), contact_email: val('ob-email'),
      drawing_no: val('ob-drawing'), application: val('ob-application'), type_of_system: val('ob-type'), material_of_construction: val('ob-material'),
      inclusions: data.offer.inclusions, exclusions: data.offer.exclusions, utilities_requirement: data.offer.utilities_requirement,
      instrument_air_supply: data.offer.instrument_air_supply, status: data.offer.status, revision_reason: reason || null,
      show_tech_specs: document.getElementById('ob-show-tech').checked ? 1 : 0,
      show_bought_out: document.getElementById('ob-show-boughtout').checked ? 1 : 0,
      show_inclusions_exclusions: document.getElementById('ob-show-inclexcl').checked ? 1 : 0,
    })});
    await afterOfferMutation({ newVersion: r.newVersion, offerId: r.id }, 'Header saved');
  } catch (e) { alert(e.message); }
};
window.downloadOfferVersionPdf = async (offerId) => {
  try {
    const res = await fetch('/api/offers/' + offerId + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = match ? match[1] : 'offer-v' + offerId + '.pdf'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
};
window.downloadOfferPdf = async () => {
  try {
    const res = await fetch('/api/offers/' + CURRENT_OFFER_ID + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = match ? match[1] : 'offer.pdf'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
};
window.confirmOffer = async () => {
  if (!confirm('Confirm this offer as a won order? This creates a Sales Order and queues the project for execution across all departments.')) return;
  try {
    const r = await api(`/offers/${CURRENT_OFFER_ID}/confirm`, { method: 'POST' });
    alert(`Sales Order ${r.orderNo} created. Project ${r.projCode} queued for execution across all departments.`);
    navigate('projects');
  } catch (e) { alert(e.message); }
};
window.unlockOffer = async () => {
  const reason = prompt('Reason for unlocking this offer (kept in the audit trail):');
  if (reason === null) return;
  if (!reason.trim()) { alert('Enter a reason.'); return; }
  try {
    await api(`/offers/${CURRENT_OFFER_ID}/unlock`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    await openOfferBuilder(CURRENT_OFFER_ID);
  } catch (e) { alert(e.message); }
};

window.switchOfferTab = async (tab) => {
  CURRENT_OFFER_TAB = tab;
  const data = await api('/offers/' + CURRENT_OFFER_ID);
  CURRENT_OFFER = data.offer;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const idx = ['scope', 'tech', 'boughtout', 'terms', 'text'].indexOf(tab);
  document.querySelectorAll('.tab')[idx].classList.add('active');
  renderOfferTab(data);
};

function renderOfferTab(data) {
  const el = document.getElementById('offer-tab-content');
  if (CURRENT_OFFER_TAB === 'scope') return renderScopeTab(el, data);
  if (CURRENT_OFFER_TAB === 'tech') return renderKvTab(el, data.techSpecs, 'spec_key', 'spec_value', 'tech-specs', 'Specification', 'Value', undefined, data.offer.show_tech_specs === 0);
  if (CURRENT_OFFER_TAB === 'boughtout') return renderKvTab(el, data.boughtOut, 'component', 'make', 'bought-out', 'Component', 'Make', undefined, data.offer.show_bought_out === 0);
  if (CURRENT_OFFER_TAB === 'terms') return renderKvTab(el, data.terms, 'term_key', 'term_value', 'terms', 'Term', 'Value', OFFER_TERM_LIBRARY);
  if (CURRENT_OFFER_TAB === 'text') return renderTextTab(el, data.offer, data.offer.show_inclusions_exclusions === 0);
}

async function renderScopeTab(el, data) {
  const items = data.items;
  const sectionTitles = await api('/offers/section-titles').catch(() => []);
  window.__SECTION_TITLES = sectionTitles;
  el.innerHTML = `
    <table><thead><tr><th>Item</th><th>Section</th><th>Description</th><th>Picture</th><th>Qty</th><th>Unit Price</th><th>Total</th><th></th></tr></thead>
    <tbody>${items.map(it => `
      <tr>
        <td>${esc(it.item_code)}</td>
        <td>${esc(it.section_title)}</td>
        <td style="white-space:pre-wrap;max-width:220px;">${esc(it.description)}</td>
        <td>${it.image_path ? `<img src="${it.image_path}" style="max-width:60px;max-height:60px;">` : '-'}</td>
        <td>${it.qty}</td><td>₹${fmt(it.unit_price)}</td><td>₹${fmt(it.total_price)}</td>
        <td>
          <button class="btn small" onclick="editOfferItem(${it.id})">Edit</button>
          <button class="btn small red" onclick="deleteOfferItem(${it.id})">Delete</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">No items yet.</td></tr>'}
    <tr><td colspan="6" class="right"><b>Grand Total</b></td><td colspan="2"><b>₹${fmt(items.reduce((a, b) => a + Number(b.total_price || 0), 0))}</b></td></tr>
    </tbody></table>
    <h4 id="it-form-title">Add Machinery / Scope Line</h4>
    <div class="form-grid">
      <div><label>Item Code</label><input id="it-code" placeholder="A / B / C"></div>
      <div><label>Section Title (from library)</label><select id="it-section-select" onchange="applySectionTitleTemplate()"><option value="">- type a new one below -</option>${sectionTitles.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select></div>
      <div><label>Or type a new Section Title</label><input id="it-section" placeholder="e.g. Electronic Net Weighing And Bagging System"></div>
      <div><label>Qty</label><input id="it-qty" type="number" value="1"></div>
      <div><label>Unit Price (₹)</label><input id="it-price" type="number" value="0"></div>
      <div><label>Picture (optional, overrides the library picture)</label><input id="it-image" type="file" accept="image/*"></div>
    </div>
    <div id="it-image-preview" style="margin:6px 0;"></div>
    <label>Description</label>
    <textarea id="it-desc" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
    <label>Equipment Description Summary <span class="muted">(shown next to the picture on the PDF's Equipment Description page - optional)</span></label>
    <textarea id="it-summary" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
    <div style="margin-top:8px;">
      <button class="btn" id="it-submit-btn" onclick="addOfferItem()">Add Line</button>
      <button class="btn outline" id="it-cancel-btn" onclick="cancelEditOfferItem()" style="display:none;">Cancel</button>
    </div>
  `;
}
window.applySectionTitleTemplate = () => {
  const id = val('it-section-select');
  const preview = document.getElementById('it-image-preview');
  if (!id) { preview.innerHTML = ''; return; }
  const lib = (window.__SECTION_TITLES || []).find(s => s.id === Number(id));
  if (!lib) return;
  document.getElementById('it-section').value = lib.title;
  document.getElementById('it-desc').value = lib.description || '';
  document.getElementById('it-summary').value = lib.summary || '';
  preview.innerHTML = lib.image_path ? `<img src="${esc(lib.image_path)}" style="max-height:80px;max-width:140px;"> <span class="muted">Library picture - will be used unless you upload your own above.</span>` : '';
};
let EDITING_OFFER_ITEM_ID = null;
window.editOfferItem = async (itemId) => {
  const data = await api('/offers/' + CURRENT_OFFER_ID);
  const it = data.items.find(x => x.id === itemId);
  if (!it) return;
  EDITING_OFFER_ITEM_ID = itemId;
  document.getElementById('it-code').value = it.item_code || '';
  document.getElementById('it-section').value = it.section_title || '';
  document.getElementById('it-desc').value = it.description || '';
  document.getElementById('it-summary').value = it.summary || '';
  document.getElementById('it-qty').value = it.qty;
  document.getElementById('it-price').value = it.unit_price;
  document.getElementById('it-form-title').textContent = 'Edit Machinery / Scope Line';
  document.getElementById('it-submit-btn').textContent = 'Update Line';
  document.getElementById('it-cancel-btn').style.display = '';
  document.getElementById('it-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
window.cancelEditOfferItem = () => {
  EDITING_OFFER_ITEM_ID = null;
  switchOfferTab('scope');
};
window.addOfferItem = async () => {
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const fd = new FormData();
    fd.append('item_code', val('it-code'));
    fd.append('section_title', val('it-section'));
    fd.append('description', val('it-desc'));
    fd.append('summary', val('it-summary'));
    fd.append('qty', val('it-qty'));
    fd.append('unit_price', val('it-price'));
    fd.append('revision_reason', reason || '');
    if (val('it-section-select')) fd.append('section_title_id', val('it-section-select'));
    const fileInput = document.getElementById('it-image');
    if (fileInput.files[0]) fd.append('image', fileInput.files[0]);
    let r;
    if (EDITING_OFFER_ITEM_ID) {
      r = await apiUpload(`/offers/${CURRENT_OFFER_ID}/items/${EDITING_OFFER_ITEM_ID}`, fd, 'PUT');
      EDITING_OFFER_ITEM_ID = null;
    } else {
      r = await apiUpload(`/offers/${CURRENT_OFFER_ID}/items`, fd, 'POST');
    }
    await afterOfferMutation(r);
  } catch (e) { alert(e.message); }
};
window.deleteOfferItem = async (itemId) => {
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const r = await api(`/offers/${CURRENT_OFFER_ID}/items/${itemId}`, { method: 'DELETE', body: JSON.stringify({ revision_reason: reason || null }) });
    await afterOfferMutation(r);
  } catch (e) { alert(e.message); }
};

function renderKvTab(el, rows, keyField, valField, endpoint, keyLabel, valLabel, library, disabled) {
  // `library` (offer_clause_library rows, category 'term') is only passed
  // for the Terms & Conditions tab - tech-specs/bought-out have no library
  // and keep the plain "+ Add Row" behavior. When Offer Governance's
  // "require library clauses" is on and this user isn't Admin, the free-
  // text "+ Add Row" is hidden so a NEW row can only come from the library;
  // rows already on the offer stay fully editable/removable either way.
  const hasLibrary = library !== undefined;
  const strict = hasLibrary && OFFER_REQUIRE_LIBRARY_CLAUSES && ME.role !== 'Admin';
  // `disabled` is set when the matching "Include in generated PDF" checkbox
  // above is off - the section is excluded from the offer, so its rows are
  // shown read-only instead of silently staying editable but invisible in
  // the PDF.
  el.innerHTML = `
    ${disabled ? `<div style="background:#f5f5f5;border-radius:6px;padding:10px;margin-bottom:10px;font-style:italic;color:var(--muted);">This section is excluded from the offer (see "Include in generated PDF" above) - re-enable it there to edit.</div>` : ''}
    <table><thead><tr><th>${keyLabel}</th><th>${valLabel}</th><th></th></tr></thead>
    <tbody id="kv-rows">${rows.map((r, i) => `
      <tr data-i="${i}">
        <td><input class="kv-key" value="${esc(r[keyField])}" ${disabled ? 'disabled' : ''} style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
        <td><input class="kv-val" value="${esc(r[valField])}" ${disabled ? 'disabled' : ''} style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
        <td>${disabled ? '' : `<button class="btn small red" onclick="this.closest('tr').remove()">Remove</button>`}</td>
      </tr>`).join('')}</tbody></table>
    ${disabled ? '' : hasLibrary ? `<div style="margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <select id="kv-lib-pick" style="border:1px solid var(--border);border-radius:4px;padding:5px;">
        <option value="">${library.length ? 'Pick a clause from the library...' : 'No library clauses defined yet'}</option>
        ${library.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}
      </select>
      <button class="btn small outline" onclick="addKvRowFromLibrary()">+ Add From Library</button>
    </div>` : '' }
    ${disabled ? '' : !strict ? `<button class="btn small outline" onclick="addKvRow()">+ Add Row</button>` : ''}
    ${disabled ? '' : `<button class="btn" onclick="saveKvTab('${endpoint}', '${keyField}', '${valField}')">Save</button>`}
  `;
  if (hasLibrary) el.dataset.library = JSON.stringify(library);
}
window.addKvRow = () => {
  const tbody = document.getElementById('kv-rows');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="kv-key" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
    <td><input class="kv-val" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
    <td><button class="btn small red" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
};
window.addKvRowFromLibrary = () => {
  const select = document.getElementById('kv-lib-pick');
  const id = select.value;
  if (!id) return;
  const library = JSON.parse(document.getElementById('offer-tab-content').dataset.library || '[]');
  const picked = library.find(c => String(c.id) === id);
  if (!picked) return;
  const tbody = document.getElementById('kv-rows');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="kv-key" value="${esc(picked.label)}" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
    <td><input class="kv-val" value="${esc(picked.body)}" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
    <td><button class="btn small red" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
  select.value = '';
};
window.saveKvTab = async (endpoint, keyField, valField) => {
  const rows = Array.from(document.querySelectorAll('#kv-rows tr')).map(tr => ({
    [keyField]: tr.querySelector('.kv-key').value,
    [valField]: tr.querySelector('.kv-val').value
  })).filter(r => r[keyField]);
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const r = await api(`/offers/${CURRENT_OFFER_ID}/${endpoint}`, { method: 'PUT', body: JSON.stringify({ rows, revision_reason: reason || null }) });
    await afterOfferMutation(r, 'Saved');
  } catch (e) { alert(e.message); }
};

// One (textareaId, clause-library category) pair per free-text field, in
// display order - reused by renderTextTab() to draw the "insert from
// library" picker under each field without repeating it four times.
const OFFER_TEXT_FIELDS = [
  ['txt-inclusions', 'inclusion', 'Inclusions'],
  ['txt-exclusions', 'exclusion', 'Exclusions (one per line)'],
  ['txt-utilities', 'utilities', 'Utilities Requirement'],
  ['txt-air', 'instrument_air', 'Instrument Air Supply'],
];
function textLibraryPicker(textareaId, category) {
  const clauses = OFFER_TEXT_LIBRARY[category] || [];
  if (!clauses.length) return '';
  return `<div style="margin:4px 0 10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
    <select id="${textareaId}-lib-pick" style="border:1px solid var(--border);border-radius:4px;padding:4px;font-size:12px;">
      <option value="">Insert a library clause...</option>
      ${clauses.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}
    </select>
    <button class="btn small outline" onclick="insertTextLibraryClause('${textareaId}', '${category}')">Insert</button>
  </div>`;
}
window.insertTextLibraryClause = (textareaId, category) => {
  const select = document.getElementById(`${textareaId}-lib-pick`);
  const id = select.value;
  if (!id) return;
  const picked = (OFFER_TEXT_LIBRARY[category] || []).find(c => String(c.id) === id);
  if (!picked) return;
  const ta = document.getElementById(textareaId);
  ta.value = ta.value ? (ta.value.replace(/\n+$/, '') + '\n' + picked.body) : picked.body;
  select.value = '';
};
function renderTextTab(el, offer, disabled) {
  const fieldMap = { 'txt-inclusions': 'inclusions', 'txt-exclusions': 'exclusions', 'txt-utilities': 'utilities_requirement', 'txt-air': 'instrument_air_supply' };
  const rowsAttr = { 'txt-inclusions': 3, 'txt-exclusions': 6, 'txt-utilities': 2, 'txt-air': 3 };
  // `disabled` mirrors renderKvTab's - the "Inclusions / Exclusions / Utilities"
  // checkbox above is off, so this whole tab is excluded from the offer.
  el.innerHTML = (disabled ? `<div style="background:#f5f5f5;border-radius:6px;padding:10px;margin-bottom:10px;font-style:italic;color:var(--muted);">This section is excluded from the offer (see "Include in generated PDF" above) - re-enable it there to edit.</div>` : '') +
    OFFER_TEXT_FIELDS.map(([textareaId, category, label]) => `
    <label style="margin-top:10px;display:block;">${label}</label>
    <textarea id="${textareaId}" rows="${rowsAttr[textareaId]}" ${disabled ? 'disabled' : ''} style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(offer[fieldMap[textareaId]])}</textarea>
    ${disabled ? '' : textLibraryPicker(textareaId, category)}
  `).join('') + (disabled ? '' : `<div style="margin-top:10px;"><button class="btn" onclick="saveTextTab()">Save</button></div>`);
}
window.saveTextTab = async () => {
  try {
    const data = await api('/offers/' + CURRENT_OFFER_ID);
    const reason = confirmOfferRevision(data.offer);
    if (reason === null) return;
    const r = await api('/offers/' + CURRENT_OFFER_ID, { method: 'PUT', body: JSON.stringify({
      subject: data.offer.subject, contact_person: data.offer.contact_person, contact_phone: data.offer.contact_phone, contact_email: data.offer.contact_email,
      drawing_no: data.offer.drawing_no, application: data.offer.application, type_of_system: data.offer.type_of_system, material_of_construction: data.offer.material_of_construction,
      inclusions: val('txt-inclusions'), exclusions: val('txt-exclusions'), utilities_requirement: val('txt-utilities'), instrument_air_supply: val('txt-air'),
      status: data.offer.status, revision_reason: reason || null,
      show_tech_specs: document.getElementById('ob-show-tech').checked ? 1 : 0,
      show_bought_out: document.getElementById('ob-show-boughtout').checked ? 1 : 0,
      show_inclusions_exclusions: document.getElementById('ob-show-inclexcl').checked ? 1 : 0,
    })});
    await afterOfferMutation({ newVersion: r.newVersion, offerId: r.id }, 'Saved');
  } catch (e) { alert(e.message); }
};

// ---- Sales Analytics ----
PAGES['sales-analytics'] = async (el) => {
  const d = await api('/sales/analytics');
  el.innerHTML = `
    <div class="panel">
      <h3>Conversion Funnel</h3>
      ${tableHTML(['Stage', 'Count', 'Value', 'Conversion from previous'], d.funnel, f => `
        <tr><td>${esc(f.stage)}</td><td>${f.count}</td><td>₹${fmt(f.value)}</td><td>${f.conversion_pct === null ? '-' : f.conversion_pct + '%'}</td></tr>`)}
      ${breakdownBars(Object.fromEntries(d.funnel.map(f => [f.stage, f.count])))}
    </div>
    <div class="cards">
      ${statCard('sa_winrate', d.winRate === null ? '-' : d.winRate + '%', 'Win Rate')}
      ${statCard('sa_cycle', d.avgCycleDays === null ? '-' : d.avgCycleDays, 'Avg Sales Cycle (days)')}
    </div>
    <div class="panel">
      <h3>Lost Reasons</h3>
      ${Object.keys(d.lostReasons).length ? breakdownBars(d.lostReasons) : '<div class="empty">No lost leads yet.</div>'}
    </div>
    <div class="panel">
      <h3>Sales-Rep-wise Performance</h3>
      ${tableHTML(['Rep', 'Leads Owned', 'Won Count', 'Won Value'], d.repPerf, r => `
        <tr><td>${esc(r.owner_name)}</td><td>${r.leads_owned}</td><td>${r.won_count || 0}</td><td>₹${fmt(r.won_value || 0)}</td></tr>`)}
    </div>
    <div class="panel">
      <h3>Target vs Achievement</h3>
      ${tableHTML(['Period', 'Owner', 'Target', 'Achieved', 'Achievement %'], d.targetVsAchievement, t => `
        <tr><td>${esc(t.period)}</td><td>${esc(t.owner_name) || 'Company-wide'}</td><td>₹${fmt(t.target_value)}</td><td>₹${fmt(t.achieved_value)}</td><td>${t.achievement_pct === null ? '-' : t.achievement_pct + '%'}</td></tr>`)}
      <p class="muted" style="margin-top:8px;">Set targets on the <a href="#" onclick="navigate('sales-targets');return false;">Sales Targets</a> page.</p>
    </div>`;
};

// ---- Sales Targets (admin) ----
PAGES['sales-targets'] = async (el) => {
  const targets = await api('/sales/targets');
  const users = await api('/masters/users').catch(() => []);
  el.innerHTML = `
    <div class="panel">
      <h3>Set Target</h3>
      <div class="form-grid">
        <div><label>Period (YYYY-MM)</label><input id="st-period" type="month"></div>
        <div><label>Owner (leave blank for company-wide)</label>
          <select id="st-owner"><option value="">Company-wide</option>${users.map(u => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select>
        </div>
        <div><label>Target Value (₹)</label><input id="st-value" type="number"></div>
      </div>
      <button class="btn" onclick="addSalesTarget()">Save Target</button>
    </div>
    ${collapsiblePanel('sales-targets-list', `All Targets (${targets.length})`, `
      ${tableHTML(['Period', 'Owner', 'Target Value', ''], targets, t => `
        <tr><td>${esc(t.period)}</td><td>${esc(t.owner_name) || 'Company-wide'}</td><td>₹${fmt(t.target_value)}</td>
        <td><button class="btn small red" onclick="deleteSalesTarget(${t.id})">Delete</button></td></tr>`)}
    `)}`;
};
window.addSalesTarget = async () => {
  try {
    await api('/sales/targets', { method: 'POST', body: JSON.stringify({
      period: val('st-period'), owner_id: val('st-owner') || null, target_value: val('st-value')
    })});
    navigate('sales-targets');
  } catch (e) { alert(e.message); }
};
window.deleteSalesTarget = async (id) => {
  if (!confirm('Delete this target?')) return;
  await api('/sales/targets/' + id, { method: 'DELETE' });
  navigate('sales-targets');
};

// ---- Projects ----
PAGES.projects = async (el) => {
  const projects = await api('/projects');
  const orders = await api('/sales/orders');
  el.innerHTML = `
    <div class="panel">
      <h3>New Project</h3>
      <div class="form-grid">
        <div><label>Title</label><input id="pj-title"></div>
        <div><label>Sales Order</label><select id="pj-order"><option value="">-</option>${orders.map(o => `<option value="${o.id}">${esc(o.order_no)} - ${esc(o.client_name)}</option>`).join('')}</select></div>
        <div><label>Start Date</label><input id="pj-start" type="date" value="${today()}"></div>
        <div><label>Target Date</label><input id="pj-target" type="date"></div>
      </div>
      <button class="btn" onclick="addProject()">Create Project (auto-generates full department pipeline)</button>
    </div>
    ${collapsiblePanel('projects-list', `Projects (${projects.length})`, `
      ${tableHTML(['Code', 'Title', 'Client', 'Status', 'PM', 'Target Completion', ''], projects, p => `
        <tr data-project-row="${p.id}"><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${esc(p.client_name)||'-'}</td><td>${badge(p.status)}</td><td>${esc(p.pm_name)}</td>
        <td class="pr-target">${p.target_date ? `<b>${new Date(p.target_date).toLocaleDateString()}</b>` : '<span class="muted">Not planned yet</span>'}</td>
        <td><button class="btn small outline" onclick="viewProjectCards(${p.id}, '${esc(p.project_code)}')">View Pipeline</button></td></tr>`)}
      <p class="muted" style="margin-top:10px;">Set or edit each project's department targets from the <a href="#" onclick="navigate('targets');return false;">Targets</a> tab.</p>
    `)}
    <div class="panel" id="pj-cards-panel" style="display:none;"><h3 id="pj-cards-title"></h3><div id="pj-cards"></div></div>
  `;
};
window.addProject = async () => {
  try {
    await api('/projects', { method: 'POST', body: JSON.stringify({
      title: val('pj-title'), sales_order_id: val('pj-order') || null, start_date: val('pj-start'), target_date: val('pj-target')
    })});
    navigate('projects');
  } catch (e) { alert(e.message); }
};
// Format a job card's own row, optionally indented as a child (sub-process
// or HOD-created sub-assembly) so who's working what and its allocation/
// start/completion timestamps are visible right from the project's own
// pipeline view - not only inside that department's Job Cards workbench.
function jobCardRowHTML(c, indent) {
  const title = indent ? esc(c.title || STAGE_LABELS[c.stage] || c.stage) + (c.is_adhoc ? ' <span class="muted">(sub-assembly)</span>' : '') : esc(STAGE_LABELS[c.stage] || c.stage);
  const fmtTs = t => t ? new Date(t).toLocaleString() : '-';
  return `<tr${indent ? ' class="jc-child-row"' : ''}>
    <td${indent ? ' style="padding-left:28px;"' : ''}>${indent ? '<span class="muted">↳</span> ' : ''}${title}</td>
    <td>${badge(c.status)}</td><td>${esc(c.assigned_to_name)||'-'}</td>
    <td>${fmtTs(c.allocated_at)}</td><td>${fmtTs(c.started_at)}</td><td>${fmtTs(c.completed_at)}</td>
    <td>${esc(c.notes)||''}</td></tr>`;
}
window.viewProjectCards = async (id, code) => {
  const cards = await api(`/projects/${id}/job-cards`);
  document.getElementById('pj-cards-panel').style.display = 'block';
  document.getElementById('pj-cards-title').textContent = 'Pipeline: ' + code;
  const rows = cards.map(c => jobCardRowHTML(c, false) + (c.children || []).map(ch => jobCardRowHTML(ch, true)).join('')).join('');
  document.getElementById('pj-cards').innerHTML = `<table><thead><tr>
    <th>Stage / Sub-Assembly</th><th>Status</th><th>Assigned To</th><th>Allocated</th><th>Started</th><th>Completed</th><th>Notes</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">No job cards yet.</td></tr>'}</tbody></table>`;
  document.getElementById('pj-cards-panel').scrollIntoView({ behavior: 'smooth' });
};

// ---- Targets sheet (PM department-level planning, editable anytime) ----
PAGES.targets = async (el) => {
  const projects = await api('/projects');
  const canPlan = has('project.manage');
  el.innerHTML = `
    ${collapsiblePanel('targets-by-project', `Targets by Project (${projects.length})`, `
      ${tableHTML(['Code', 'Title', 'Client', 'Status', 'Target Completion'], projects, p => `
        <tr data-project-row="${p.id}"><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${esc(p.client_name)||'-'}</td><td>${badge(p.status)}</td>
        <td class="pr-target">${p.target_date ? `<b>${new Date(p.target_date).toLocaleDateString()}</b>` : '<span class="muted">Not planned yet</span>'}</td></tr>`)}
    `)}
    <div class="panel">
      <h3>Plan / Edit Department Targets</h3>
      ${canPlan ? `
        <div class="form-grid">
          <div><label>Project</label><select id="pl-project" onchange="loadProjectPlan()"><option value="">Select a project...</option>${projects.map(p => `<option value="${p.id}">${esc(p.project_code)} — ${esc(p.client_name || p.title)}</option>`).join('')}</select></div>
          <div><label>Plan Start Date</label><input id="pl-start" type="date" value="${today()}"></div>
        </div>
        <div id="pl-body" class="muted">Pick a project above to plan how many days each department gets — dates cascade automatically from your start date, and rows can be reordered to match the real handover sequence. Saving here is what releases each stage into the assigned department's (or its HOD's) Job Cards queue. Come back here any time to change targets already set.</div>
      ` : `<p class="msg err">Only a Project Manager or Admin can plan department targets.</p>`}
    </div>
  `;
};
window.loadProjectPlan = async () => {
  const projectId = val('pl-project');
  const body = document.getElementById('pl-body');
  if (!projectId) { body.innerHTML = '<span class="muted">Pick a project above.</span>'; return; }
  body.innerHTML = '<span class="muted">Loading...</span>';
  let cards;
  try {
    cards = await api(`/projects/${projectId}/job-cards`);
  } catch (e) { body.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
  if (!cards.length) { body.innerHTML = '<div class="msg err">This project has no job cards.</div>'; return; }
  const targetProject = (await api('/projects')).find(p => String(p.id) === String(projectId));
  body.innerHTML = `
    <p class="muted">Set how many days each department needs and reorder rows (▲▼) to match the real handover sequence. By default each stage's start is the day after the previous stage ends, and a stage can't be started until every stage above it is completed. Tick "Run in parallel" on a row to have it start on the same day as the row above it instead — the next non-parallel row waits for whichever of that group finishes last. A department with sub-processes (marked below) is planned here as one row — its HOD breaks that window down further from their own Job Cards workbench.</p>
    <table><thead><tr><th style="width:36px;"></th><th>Department</th><th>Duration (days)</th><th>Run in parallel<br>with row above</th><th>Planned Start</th><th>Planned End</th><th>Status</th></tr></thead>
    <tbody id="pl-rows">
      ${cards.map((c, i) => `
        <tr data-jc="${c.id}">
          <td class="pl-reorder">
            <button type="button" class="btn small outline" onclick="moveRow(this,-1)" title="Move up">▲</button>
            <button type="button" class="btn small outline" onclick="moveRow(this,1)" title="Move down">▼</button>
          </td>
          <td>${esc(STAGE_LABELS[c.stage] || c.stage)}${c.child_count ? ` <span class="muted">(+${c.child_count} sub-processes, HOD-planned)</span>` : ''}</td>
          <td><input type="number" min="1" class="pl-duration" value="${c.duration_days || 7}" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td style="text-align:center;"><input type="checkbox" class="pl-parallel" ${c.parallel_with_previous ? 'checked' : ''} ${i === 0 ? 'disabled title="The first row has nothing above it to run alongside."' : ''}></td>
          <td class="pl-start">${c.planned_start || '-'}</td>
          <td class="pl-end">${c.planned_end || '-'}</td>
          <td>${badge(c.status)}</td>
        </tr>`).join('')}
    </tbody></table>
    <button class="btn" onclick="saveProjectPlan(${projectId})">Recalculate &amp; Save Plan</button>
    <span id="pl-target" class="muted" style="margin-left:10px;">${targetProject && targetProject.target_date ? `Overall target completion: <b>${targetProject.target_date}</b>` : ''}</span>
    <div id="pl-err" class="msg err" style="display:none;margin-top:10px;"></div>
  `;
};
window.moveRow = (btn, dir) => {
  const tr = btn.closest('tr');
  const sibling = dir < 0 ? tr.previousElementSibling : tr.nextElementSibling;
  if (!sibling) return;
  if (dir < 0) tr.parentNode.insertBefore(tr, sibling);
  else tr.parentNode.insertBefore(sibling, tr);
  refreshParallelCheckboxRowZero(tr.parentNode);
};
// Whichever row ends up first after reordering has nothing above it to run
// alongside, so its "Run in parallel" checkbox is disabled and cleared;
// every other row is re-enabled (it may have been the disabled first row
// a moment ago).
function refreshParallelCheckboxRowZero(tbody) {
  Array.from(tbody.children).forEach((tr, i) => {
    const cb = tr.querySelector('.pl-parallel');
    if (!cb) return;
    if (i === 0) { cb.checked = false; cb.disabled = true; cb.title = 'The first row has nothing above it to run alongside.'; }
    else { cb.disabled = false; cb.title = ''; }
  });
}
window.saveProjectPlan = async (projectId) => {
  const errEl = document.getElementById('pl-err');
  errEl.style.display = 'none';
  const startDate = val('pl-start');
  if (!startDate) { errEl.textContent = 'Pick a plan start date first.'; errEl.style.display = 'block'; return; }
  const rows = Array.from(document.querySelectorAll('#pl-rows tr'));
  const stages = rows.map(tr => ({
    id: Number(tr.dataset.jc),
    duration_days: Number(tr.querySelector('.pl-duration').value) || 1,
    parallel_with_previous: tr.querySelector('.pl-parallel').checked,
  }));
  try {
    const r = await api(`/projects/${projectId}/plan`, { method: 'PUT', body: JSON.stringify({ start_date: startDate, stages }) });
    r.jobCards.forEach(c => {
      const tr = document.querySelector(`#pl-rows tr[data-jc="${c.id}"]`);
      if (tr) { tr.querySelector('.pl-start').textContent = c.planned_start; tr.querySelector('.pl-end').textContent = c.planned_end; }
    });
    document.getElementById('pl-target').innerHTML = `Saved. Overall target completion: <b>${new Date(r.targetDate).toLocaleDateString()}</b>`;
    // also reflect it in the projects table above, so it's visible without re-opening this panel
    const projRow = document.querySelector(`tr[data-project-row="${projectId}"] .pr-target`);
    if (projRow) projRow.innerHTML = `<b>${new Date(r.targetDate).toLocaleDateString()}</b>`;
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
};

// ---- My Job Cards (department / HOD workbench) ----
// This is each department's own work queue - a user only ever sees cards
// for their own department/role (or specifically assigned to them), so
// logging in as a different department is effectively "that department's
// tab". A regular team member only gets Start/Complete on a card assigned
// to them; the HOD/Supervisor (c.is_supervisor) gets it on every card in
// the department, plus allocation, sub-assemblies, attachments and routing.
PAGES.jobcards = async (el) => {
  const cards = await api('/projects/job-cards/mine');
  const cardRow = c => `<tr><td>${esc(c.project_code)} - ${esc(c.project_title)}</td><td>${esc(c.title || STAGE_LABELS[c.stage] || c.stage)}${c.is_adhoc ? ' <span class="muted">(sub-assembly/routed)</span>' : ''}</td><td>${badge(c.status)}</td><td>${esc(c.assigned_to_name)||'-'}</td>
      <td>${jobCardActions(c)}</td></tr>`;
  el.innerHTML = renderJobCardSection('mine', `Job Cards for ${ME.role}`, cards, cardRow) +
  `<div class="panel" id="sp-panel" style="display:none;"><h3 id="sp-title"></h3><div id="sp-body"></div></div>
  <div class="panel" id="jc-panel" style="display:none;"><h3 id="jc-title"></h3><div id="jc-body"></div></div>`;
};
// A department's own top-level stage plus its sub-process stages (if any),
// in handover order - drives the sectioned Manufacturing tab below. Kept in
// sync with lib/pipeline.js's SUB_STAGES by hand since that map isn't sent
// to the frontend as data; only Manufacturing has sub-processes today.
const DEPT_SUB_STAGES = { Manufacturing: ['Fitting', 'Tacking', 'Welding', 'BuffingSandblast', 'Painting'] };

// Admin/ProjectManager per-department tab - same table/actions/detail-panel
// as "My Job Cards" above, but showing one department's entire queue rather
// than filtering down to "assigned to me". For a department with
// sub-processes (Manufacturing), the queue is split into its own section per
// sub-process instead of one flat list, so its tab reads the way the
// Manufacturing HOD's own sub-process planning already works.
// Collapsed-by-default (like every other growing list panel in the app),
// with client-side search since project/item are named entities - one
// dept's job-card queue only grows over the life of the company.
function renderJobCardSection(key, title, rows, cardRow) {
  const tableWrapId = 'jc-tw-' + key;
  const countId = 'jc-count-' + key;
  const renderRows = (rs) => rs.length ? tableHTML(['Project', 'Item', 'Status', 'Assigned', 'Action'], rs, cardRow) : '<p class="muted">No job cards in this section.</p>';
  return collapsiblePanel('dept-job-cards-' + key, `<span id="${countId}">${esc(title)} (${rows.length})</span>`, `
    ${renderListSearch('jc-' + key, rows, ['project_code', 'project_title', 'title', 'assigned_to_name', 'status'], (filtered) => {
      document.getElementById(tableWrapId).innerHTML = renderRows(filtered);
      document.getElementById(countId).textContent = title + ' (' + filtered.length + ')';
    }, 'Search by project, item, status, assignee...')}
    <div id="${tableWrapId}">${renderRows(rows)}</div>
  `);
}
async function renderDeptJobCards(el, stage, label, onlyStage) {
  const cards = await api('/projects/job-cards/by-stage/' + encodeURIComponent(stage));
  const subStages = DEPT_SUB_STAGES[stage];
  const cardRow = c => `<tr><td>${esc(c.project_code)} - ${esc(c.project_title)}</td><td>${esc(c.title || STAGE_LABELS[c.stage] || c.stage)}${c.is_adhoc ? ' <span class="muted">(sub-assembly/routed)</span>' : ''}</td><td>${badge(c.status)}</td><td>${esc(c.assigned_to_name)||'-'}</td>
      <td>${jobCardActions(c)}</td></tr>`;
  let body;
  if (onlyStage) {
    // A single sub-process's own sidebar tab (e.g. Manufacturing > Fitting) -
    // same combined-queue data, filtered down to just this one section.
    const rows = cards.filter(c => c.stage === onlyStage);
    body = renderJobCardSection('only-' + onlyStage, label, rows, cardRow);
  } else if (subStages) {
    const own = cards.filter(c => c.stage === stage);
    const sections = [{ key: stage, title: label + ' (overall)', rows: own }]
      .concat(subStages.map(s => ({ key: s, title: STAGE_LABELS[s] || s, rows: cards.filter(c => c.stage === s) })));
    body = sections.map(sec => renderJobCardSection(sec.key, sec.title, sec.rows, cardRow)).join('');
  } else {
    body = renderJobCardSection(stage, label, cards, cardRow);
  }
  el.innerHTML = body +
    `<div class="panel" id="sp-panel" style="display:none;"><h3 id="sp-title"></h3><div id="sp-body"></div></div>
     <div class="panel" id="jc-panel" style="display:none;"><h3 id="jc-title"></h3><div id="jc-body"></div></div>`;
}

function jobCardActions(c) {
  const subBtn = c.child_count ? `<button class="btn small outline" onclick="openSubPlan(${c.id}, '${esc(STAGE_LABELS[c.stage] || c.stage)}')">Plan Sub-Processes (${c.child_count})</button> ` : '';
  const openBtn = `<button class="btn small outline" onclick="openJobCardDetail(${c.id})">Open</button> `;
  if (c.status === 'Completed') return openBtn + (subBtn || '');
  if (!c.can_act) return openBtn + '<span class="muted">Not assigned to you</span>';
  const next = c.status === 'Pending' ? 'InProgress' : 'Completed';
  const label = next === 'InProgress' ? 'Start Work' : 'Complete Work';
  return `${openBtn}${subBtn}<button class="btn small green" onclick="advanceJobCard(${c.id}, '${next}')">${label}</button>
    <button class="btn small outline" onclick="holdJobCard(${c.id})">Hold</button>`;
}
window.advanceJobCard = async (id, status) => {
  try {
    await api(`/projects/job-cards/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    navigate(CURRENT_PAGE);
  } catch (e) { alert(e.message); }
};
window.holdJobCard = async (id) => {
  await api(`/projects/job-cards/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'OnHold' }) });
  navigate(CURRENT_PAGE);
};

// ---- Job card detail: attachments, comments, sub-assemblies, allocation, routing to other departments ----
window.openJobCardDetail = async (id) => {
  const panel = document.getElementById('jc-panel');
  const title = document.getElementById('jc-title');
  const body = document.getElementById('jc-body');
  panel.style.display = 'block';
  body.innerHTML = '<span class="muted">Loading...</span>';
  panel.scrollIntoView({ behavior: 'smooth' });
  let data;
  try {
    data = await api(`/projects/job-cards/${id}/detail`);
  } catch (e) { body.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
  const { jobCard: c, children, attachments, comments, dependsOn, routedTo, canAct, isSupervisor } = data;
  title.textContent = `${c.title || STAGE_LABELS[c.stage] || c.stage} — ${badge(c.status)}`;
  title.innerHTML = `${esc(c.title || STAGE_LABELS[c.stage] || c.stage)} ${badge(c.status)}`;

  const actionsHTML = canAct && c.status !== 'Completed' ? `
    <button class="btn small green" onclick="advanceJobCard(${c.id}, '${c.status === 'Pending' ? 'InProgress' : 'Completed'}')">${c.status === 'Pending' ? 'Start Work' : 'Complete Work'}</button>
    <button class="btn small outline" onclick="holdJobCard(${c.id})">Hold</button>` : '';

  const childrenHTML = children.length ? `
    <h4>Sub-Assemblies / Sub-Processes</h4>
    ${tableHTML(['Item', 'Status', 'Assigned', 'Planned Start', 'Planned End'], children, ch => `
      <tr><td><a href="#" onclick="openJobCardDetail(${ch.id});return false;">${esc(ch.title || STAGE_LABELS[ch.stage] || ch.stage)}</a></td><td>${badge(ch.status)}</td><td>${esc(ch.assigned_to_name)||'-'}</td><td>${ch.planned_start||'-'}</td><td>${ch.planned_end||'-'}</td></tr>`)}
  ` : '';

  // Show each source department's own trail (its notes + comments) right
  // here, not just that a hand-off happened - so whoever picks this up can
  // see what was actually noted/actioned upstream without clicking through
  // to the source card. Also seeded as this card's own first comment (see
  // POST /job-cards/:id/route-to), but shown here too since it's most
  // useful right where the hand-off itself is called out.
  const depsHTML = dependsOn.length ? dependsOn.map(d => `
    <div class="muted" style="margin-bottom:6px;">
      Waiting on hand-off from: <b>${esc(STAGE_LABELS[d.stage]||d.stage)}</b> (${esc(d.title)}) ${badge(d.status)}
      ${d.comments && d.comments.length ? `
        <div style="margin:4px 0 0 14px;border-left:2px solid var(--border);padding-left:8px;">
          ${d.comments.map(cm => `<div style="font-size:12px;"><b>${esc(cm.user_name)||'-'}</b> <span class="muted">${new Date(cm.created_at).toLocaleString()}</span>: ${esc(cm.comment)}</div>`).join('')}
        </div>` : ''}
    </div>`).join('') : '';
  const routedHTML = routedTo.length ? `<p class="muted">Routed onward to: ${routedTo.map(d => `${esc(STAGE_LABELS[d.stage]||d.stage)} (${esc(d.title)}) ${badge(d.status)}`).join(', ')}</p>` : '';

  const annexureHTML = c.so_annexure_path ? `
    <p><b>Sales Order Annexure</b> (${esc(c.so_order_no)||'-'}, read-only): <a href="#" onclick="return downloadAnnexure(event, ${c.so_id})">Download</a></p>
  ` : '';

  const attachHTML = `
    ${annexureHTML}
    <h4>Attachments</h4>
    <div class="attachments-list">
    ${attachments.length ? tableHTML(['File', 'Uploaded By', 'Date'], attachments, a => `
      <tr><td><a href="${a.file_path}" target="_blank">${esc(a.file_name)}</a></td><td>${esc(a.uploaded_by_name)||'-'}</td><td>${new Date(a.created_at).toLocaleDateString()}</td></tr>`) : '<div class="empty">No files yet.</div>'}
    </div>
    ${canAct ? `<form id="jc-upload-form" style="margin-top:8px;"><input type="file" id="jc-file"> <button type="button" class="btn small outline" onclick="uploadJobCardFile(${c.id})">Upload</button></form>` : ''}
  `;

  const commentsHTML = `
    <h4>Comments / Handover Notes</h4>
    <div class="comments-list">
      ${comments.length ? comments.map(cm => `<div class="comment"><b>${esc(cm.user_name)||'-'}</b> <span class="muted">${new Date(cm.created_at).toLocaleString()}</span><div>${esc(cm.comment)}</div></div>`).join('') : '<div class="empty">No comments yet.</div>'}
    </div>
    ${canAct ? `<div class="form-grid"><div style="grid-column:1/-1;"><textarea id="jc-comment" rows="2" placeholder="Add a note for the next person/department..."></textarea></div></div>
      <button class="btn small" onclick="postJobCardComment(${c.id})">Add Comment</button>` : ''}
  `;

  const hodToolsHTML = isSupervisor ? `
    <div class="hod-tools">
    <h4>HOD / Supervisor Tools</h4>
    <div class="sub-section">
      <div class="form-grid">
        <div><label>Add Sub-Assembly</label><input id="jc-sub-title" placeholder="e.g. Hopper Sub-Assembly"></div>
        <div><label>Duration (days)</label><input id="jc-sub-days" type="number" min="1" value="7"></div>
      </div>
      <button class="btn small outline" onclick="addSubAssembly(${c.id})">Add Sub-Assembly</button>
    </div>
    <div class="sub-section">
      <div class="form-grid">
        <div><label>Allocate to Team Member</label><select id="jc-assignee"><option value="">Loading...</option></select></div>
        <div style="align-self:end;"><button class="btn small outline" onclick="allocateJobCard(${c.id})">Allocate</button></div>
      </div>
    </div>
    <div class="sub-section">
      <p class="muted">Hand this off to another department once ready (e.g. BOM to Purchase, cut/bend files to Laser & Bending, drawings to Electrical — can route to several departments independently). The sub-assembly/sub-process name below carries forward to the receiving department by default, along with this card's comments so far — edit it only if the handoff is literally a different item.</p>
      <div class="form-grid">
        <div><label>Route to Department</label><select id="jc-route-stage">${Object.keys(STAGE_LABELS).map(s => `<option value="${s}">${esc(STAGE_LABELS[s])}</option>`).join('')}</select></div>
        <div><label>What's being handed off</label><input id="jc-route-title" value="${esc(c.title || STAGE_LABELS[c.stage] || c.stage)}" placeholder="e.g. BOM for Procurement"></div>
      </div>
      <button class="btn small outline" onclick="routeJobCard(${c.id})">Route to Department</button>
    </div>
    <div id="jc-hod-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>
  ` : '';

  body.innerHTML = `
    <p>Status: ${badge(c.status)} &nbsp; Assigned to: <b>${esc(c.assigned_to_name)||'Unassigned'}</b> &nbsp; ${c.planned_start ? `Window: <b>${c.planned_start} to ${c.planned_end||'-'}</b>` : ''}</p>
    <p class="muted" style="font-size:12px;">
      Allocated: <b>${c.allocated_at ? new Date(c.allocated_at).toLocaleString() : '-'}</b> &nbsp;&middot;&nbsp;
      Started: <b>${c.started_at ? new Date(c.started_at).toLocaleString() : '-'}</b> &nbsp;&middot;&nbsp;
      Completed: <b>${c.completed_at ? new Date(c.completed_at).toLocaleString() : '-'}</b>
    </p>
    ${depsHTML}${routedHTML}
    ${actionsHTML}
    ${childrenHTML}
    ${attachHTML}
    ${commentsHTML}
    ${hodToolsHTML}
  `;

  if (isSupervisor) {
    try {
      const team = await api(`/projects/department-users/${c.stage}`);
      document.getElementById('jc-assignee').innerHTML = `<option value="">Select...</option>` + team.map(u => `<option value="${u.id}" ${u.id===c.assigned_to?'selected':''}>${esc(u.full_name)}${u.is_supervisor?' (HOD)':''}</option>`).join('');
    } catch (e) { /* ignore - team list is a nice-to-have */ }
  }
};
window.uploadJobCardFile = async (id) => {
  const fileEl = document.getElementById('jc-file');
  if (!fileEl.files.length) { alert('Choose a file first.'); return; }
  const fd = new FormData();
  fd.append('file', fileEl.files[0]);
  try {
    await apiUpload(`/projects/job-cards/${id}/attachments`, fd, 'POST');
    openJobCardDetail(id);
  } catch (e) { alert(e.message); }
};
window.postJobCardComment = async (id) => {
  const text = val('jc-comment');
  if (!text || !text.trim()) return;
  try {
    await api(`/projects/job-cards/${id}/comments`, { method: 'POST', body: JSON.stringify({ comment: text }) });
    openJobCardDetail(id);
  } catch (e) { alert(e.message); }
};
window.addSubAssembly = async (id) => {
  const errEl = document.getElementById('jc-hod-err');
  const title = val('jc-sub-title');
  if (!title) { errEl.textContent = 'Give the sub-assembly a name.'; errEl.style.display = 'block'; return; }
  try {
    await api(`/projects/job-cards/${id}/subassemblies`, { method: 'POST', body: JSON.stringify({ title, duration_days: val('jc-sub-days') }) });
    openJobCardDetail(id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.allocateJobCard = async (id) => {
  const errEl = document.getElementById('jc-hod-err');
  const userId = val('jc-assignee');
  try {
    await api(`/projects/job-cards/${id}`, { method: 'PATCH', body: JSON.stringify({ assigned_to: userId ? Number(userId) : null }) });
    openJobCardDetail(id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.routeJobCard = async (id) => {
  const errEl = document.getElementById('jc-hod-err');
  const stage = val('jc-route-stage');
  const title = val('jc-route-title');
  try {
    await api(`/projects/job-cards/${id}/route-to`, { method: 'POST', body: JSON.stringify({ stage, title }) });
    openJobCardDetail(id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- HOD sub-process planning (e.g. Manufacturing HOD planning Fitting -> Tacking -> Welding -> Buffing/Sandblast -> Painting) ----
window.openSubPlan = async (parentId, parentLabel) => {
  const panel = document.getElementById('sp-panel');
  const title = document.getElementById('sp-title');
  const body = document.getElementById('sp-body');
  panel.style.display = 'block';
  title.textContent = `Sub-Process Targets: ${parentLabel}`;
  body.innerHTML = '<span class="muted">Loading...</span>';
  panel.scrollIntoView({ behavior: 'smooth' });
  let data;
  try {
    data = await api(`/projects/job-cards/${parentId}/children`);
  } catch (e) { body.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
  const { parent, children } = data;
  body.innerHTML = `
    <p class="muted">${esc(parentLabel)}'s overall window from the PM's plan: <b>${parent.planned_start || '-'} to ${parent.planned_end || '-'}</b>. Break it down into sub-process targets below — rows can be reordered (▲▼) to match real handover between sub-processes, and this can be re-edited any time.</p>
    <div class="form-grid"><div><label>Sub-Plan Start Date</label><input id="sp-start" type="date" value="${parent.planned_start || today()}"></div></div>
    <table><thead><tr><th style="width:36px;"></th><th>Sub-Process</th><th>Duration (days)</th><th>Planned Start</th><th>Planned End</th><th>Status</th></tr></thead>
    <tbody id="sp-rows">
      ${children.map(c => `
        <tr data-jc="${c.id}">
          <td class="pl-reorder">
            <button type="button" class="btn small outline" onclick="moveRow(this,-1)" title="Move up">▲</button>
            <button type="button" class="btn small outline" onclick="moveRow(this,1)" title="Move down">▼</button>
          </td>
          <td>${esc(STAGE_LABELS[c.stage] || c.stage)}</td>
          <td><input type="number" min="1" class="sp-duration" value="${c.duration_days || 2}" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td class="sp-start">${c.planned_start || '-'}</td>
          <td class="sp-end">${c.planned_end || '-'}</td>
          <td>${badge(c.status)}</td>
        </tr>`).join('')}
    </tbody></table>
    <button class="btn" onclick="saveSubPlan(${parentId})">Recalculate &amp; Save Sub-Plan</button>
    <div id="sp-err" class="msg err" style="display:none;margin-top:10px;"></div>
  `;
};
window.saveSubPlan = async (parentId) => {
  const errEl = document.getElementById('sp-err');
  errEl.style.display = 'none';
  const startDate = val('sp-start');
  if (!startDate) { errEl.textContent = 'Pick a sub-plan start date first.'; errEl.style.display = 'block'; return; }
  const rows = Array.from(document.querySelectorAll('#sp-rows tr'));
  const stages = rows.map(tr => ({ id: Number(tr.dataset.jc), duration_days: Number(tr.querySelector('.sp-duration').value) || 1 }));
  try {
    const r = await api(`/projects/job-cards/${parentId}/subplan`, { method: 'PUT', body: JSON.stringify({ start_date: startDate, stages }) });
    r.children.forEach(c => {
      const tr = document.querySelector(`#sp-rows tr[data-jc="${c.id}"]`);
      if (tr) { tr.querySelector('.sp-start').textContent = c.planned_start; tr.querySelector('.sp-end').textContent = c.planned_end; }
    });
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
};

// ---- Vendors (Round 5: full GST-compliant Vendor Master) ----
PAGES.vendors = async (el) => {
  const vendors = await api('/masters/vendors');
  el.innerHTML = `
    <div class="panel"><h3>Add Vendor</h3>
      <h4>Company Details</h4>
      <div class="form-grid">
        <div><label>Legal / Trade Name *</label><input id="v-name"></div>
        <div><label>Vendor Type</label><select id="v-type"><option value="">-</option><option>Manufacturer</option><option>Trader</option><option>Service Provider</option><option>Distributor</option><option>Other</option></select></div>
        <div><label>Category (Goods/Services Supplied)</label><input id="v-category" placeholder="Raw Material / Spares / Services"></div>
        <div><label>Status</label><select id="v-status"><option>Active</option><option>Inactive</option><option>Blacklisted</option></select></div>
      </div>
      <h4>GST &amp; Compliance</h4>
      <div class="form-grid">
        <div><label>GSTIN (15-char)</label><input id="v-gstin" maxlength="15" placeholder="06AAACA1234B1Z5"></div>
        <div><label>PAN</label><input id="v-pan" maxlength="10"></div>
        <div><label><input type="checkbox" id="v-msme"> Is MSME/Udyam Registered</label></div>
        <div><label>MSME/Udyam Number</label><input id="v-msme-no"></div>
      </div>
      <h4>Address</h4>
      <div class="form-grid">
        <div><label>Address Line 1</label><input id="v-addr1"></div>
        <div><label>Address Line 2</label><input id="v-addr2"></div>
        <div><label>City</label><input id="v-city"></div>
        <div><label>State</label><input id="v-state"></div>
        <div><label>State Code</label><input id="v-state-code" maxlength="2" placeholder="06"></div>
        <div><label>Pincode</label><input id="v-pincode"></div>
        <div><label>Country</label><input id="v-country" value="India"></div>
      </div>
      <h4>Bank Details</h4>
      <div class="form-grid">
        <div><label>Bank Name</label><input id="v-bank-name"></div>
        <div><label>Account Number</label><input id="v-bank-acc"></div>
        <div><label>IFSC</label><input id="v-bank-ifsc"></div>
        <div><label>Account Holder Name</label><input id="v-bank-holder"></div>
      </div>
      <h4>Contact &amp; Terms</h4>
      <div class="form-grid">
        <div><label>Contact Person</label><input id="v-contact"></div>
        <div><label>Phone</label><input id="v-phone"></div>
        <div><label>Email (general)</label><input id="v-email"></div>
        <div><label>PO / Document Delivery Email</label><input id="v-po-email" placeholder="Defaults to Email above if blank"></div>
        <div><label>Payment Terms</label><select id="v-terms"><option>Net 15</option><option>Net 30</option><option>Net 45</option><option>Net 60</option><option>Advance</option><option>Custom</option></select></div>
        <div><label>Payment Terms (Days)</label><input id="v-terms-days" type="number" value="30"></div>
      </div>
      <button class="btn" onclick="addVendor()" style="margin-top:10px;">Add Vendor</button>
      <div id="v-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per vendor, then upload it here.</p>
      <button class="btn outline" type="button" onclick="downloadVendorTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('ve-upload-file')}
      <button class="btn" onclick="uploadVendorTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="ve-upload-result" style="margin-top:10px;"></div>
    </div>
    ${collapsiblePanel('vendors-list', `<span id="ve-count">Vendors (${vendors.length})</span>`, `
      ${renderListSearch('vendors', vendors, ['legal_name', 'name', 'gstin', 'state', 'category', 'contact_person', 'phone', 'po_email', 'email'], (rows) => {
        document.getElementById('ve-table-wrap').innerHTML = renderVendorRows(rows);
        document.getElementById('ve-count').textContent = 'Vendors (' + rows.length + ')';
      }, 'Search by name, GSTIN, state, category, contact...')}
      <div id="ve-table-wrap">${renderVendorRows(vendors)}</div>
    `)}
    <div class="panel" id="ve-edit-panel" style="display:none;"><h3>Edit Vendor</h3><div id="ve-edit-body"></div></div>`;
  window.__VENDOR_CACHE = vendors;
};
function renderVendorRows(rows) {
  return tableHTML(['Name', 'GSTIN', 'State', 'Category', 'Contact', 'Phone', 'PO Email', 'Terms', 'Status', ''], rows, v => `<tr>
    <td>${esc(v.legal_name || v.name)}</td><td>${esc(v.gstin)||'-'}</td><td>${esc(v.state)||'-'}</td><td>${esc(v.category)||'-'}</td>
    <td>${esc(v.contact_person)||'-'}</td><td>${esc(v.phone)||'-'}</td><td>${esc(v.po_email||v.email)||'-'}</td>
    <td>${esc(v.payment_terms)||'-'}</td><td>${badge(v.status||'Active')}</td>
    <td><button class="btn small outline" type="button" onclick="openEditVendor(${v.id})">Edit</button>
    <button class="btn small outline" type="button" onclick="deleteVendor(${v.id})">Delete</button></td></tr>`);
}
window.openEditVendor = (id) => {
  const v = (window.__VENDOR_CACHE || []).find(x => x.id === id);
  if (!v) return;
  const panel = document.getElementById('ve-edit-panel');
  document.getElementById('ve-edit-body').innerHTML = `
    <div class="form-grid">
      <div><label>Legal / Trade Name *</label><input id="ve-name" value="${esc(v.legal_name || v.name)}"></div>
      <div><label>Vendor Type</label><select id="ve-type"><option value="">-</option>${['Manufacturer','Trader','Service Provider','Distributor','Other'].map(t => `<option ${v.vendor_type===t?'selected':''}>${t}</option>`).join('')}</select></div>
      <div><label>Category</label><input id="ve-category" value="${esc(v.category)}"></div>
      <div><label>Status</label><select id="ve-status">${['Active','Inactive','Blacklisted'].map(s => `<option ${v.status===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div><label>GSTIN</label><input id="ve-gstin" value="${esc(v.gstin)}" maxlength="15"></div>
      <div><label>PAN</label><input id="ve-pan" value="${esc(v.pan)}" maxlength="10"></div>
      <div><label>Address Line 1</label><input id="ve-addr1" value="${esc(v.address_line1)}"></div>
      <div><label>Address Line 2</label><input id="ve-addr2" value="${esc(v.address_line2)}"></div>
      <div><label>City</label><input id="ve-city" value="${esc(v.city)}"></div>
      <div><label>State</label><input id="ve-state" value="${esc(v.state)}"></div>
      <div><label>State Code</label><input id="ve-state-code" value="${esc(v.state_code)}" maxlength="2"></div>
      <div><label>Pincode</label><input id="ve-pincode" value="${esc(v.pincode)}"></div>
      <div><label>Contact Person</label><input id="ve-contact" value="${esc(v.contact_person)}"></div>
      <div><label>Phone</label><input id="ve-phone" value="${esc(v.phone)}"></div>
      <div><label>Email</label><input id="ve-email" value="${esc(v.email)}"></div>
      <div><label>PO / Document Delivery Email</label><input id="ve-po-email" value="${esc(v.po_email)}"></div>
      <div><label>Payment Terms</label><input id="ve-terms" value="${esc(v.payment_terms)}"></div>
      <div><label>Payment Terms (Days)</label><input id="ve-terms-days" type="number" value="${v.payment_terms_days||0}"></div>
    </div>
    <button class="btn" onclick="saveEditVendor(${id})">Save Changes</button>
    <button class="btn outline" type="button" onclick="document.getElementById('ve-edit-panel').style.display='none'">Cancel</button>
    <div id="ve-edit-err" class="msg err" style="display:none;margin-top:8px;"></div>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.saveEditVendor = async (id) => {
  const errEl = document.getElementById('ve-edit-err');
  try {
    await api('/masters/vendors/' + id, { method: 'PUT', body: JSON.stringify({
      name: val('ve-name'), legal_name: val('ve-name'), vendor_type: val('ve-type'), category: val('ve-category'), status: val('ve-status'),
      gstin: val('ve-gstin').toUpperCase(), pan: val('ve-pan').toUpperCase(),
      address_line1: val('ve-addr1'), address_line2: val('ve-addr2'), city: val('ve-city'), state: val('ve-state'),
      state_code: val('ve-state-code'), pincode: val('ve-pincode'),
      contact_person: val('ve-contact'), phone: val('ve-phone'), email: val('ve-email'), po_email: val('ve-po-email'),
      payment_terms: val('ve-terms'), payment_terms_days: val('ve-terms-days'),
    })});
    navigate('vendors');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteVendor = async (id) => {
  if (!confirm('Delete this vendor? If it has POs or quotes on file, it will be deactivated instead of deleted.')) return;
  try {
    const r = await api('/masters/vendors/' + id, { method: 'DELETE' });
    if (r.message) alert(r.message);
    navigate('vendors');
  } catch (e) { alert(e.message); }
};
window.addVendor = async () => {
  const errEl = document.getElementById('v-err');
  errEl.style.display = 'none';
  try {
    await api('/masters/vendors', { method: 'POST', body: JSON.stringify({
      name: val('v-name'), legal_name: val('v-name'), vendor_type: val('v-type'), category: val('v-category'), status: val('v-status'),
      gstin: val('v-gstin').toUpperCase(), pan: val('v-pan').toUpperCase(), is_msme: document.getElementById('v-msme').checked, msme_number: val('v-msme-no'),
      address_line1: val('v-addr1'), address_line2: val('v-addr2'), city: val('v-city'), state: val('v-state'),
      state_code: val('v-state-code'), pincode: val('v-pincode'), country: val('v-country') || 'India',
      bank_name: val('v-bank-name'), bank_account_number: val('v-bank-acc'), bank_ifsc: val('v-bank-ifsc'), bank_account_holder: val('v-bank-holder'),
      contact_person: val('v-contact'), phone: val('v-phone'), email: val('v-email'), po_email: val('v-po-email') || val('v-email'),
      payment_terms: val('v-terms'), payment_terms_days: val('v-terms-days'),
    })});
    navigate('vendors');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.downloadVendorTemplate = () => downloadTemplateFile('/masters/vendors/template', 'vendor_upload_template.xlsx');
window.uploadVendorTemplate = () => uploadTemplateFile('/masters/vendors/bulk-upload', 've-upload-file', 've-upload-result', () => navigate('vendors'));

// ---- Purchase Requests ----
let PR_LINES = [{ item_id: '', item_text: '', quantity: 1, estimated_value: 0 }];
PAGES['purchase-requests'] = async (el) => {
  const reqs = await api('/purchase/requests');
  const items = await api('/masters/items');
  const projects = await api('/projects');
  const threshold = (await api('/settings/purchase-quote-threshold')).quote_threshold;
  window.__PR_THRESHOLD = threshold;
  window.__PR_ITEMS = items; window.__PR_PROJECTS = projects;
  PR_LINES = [{ item_id: '', item_text: '', quantity: 1, estimated_value: 0 }];
  el.innerHTML = `
    <div class="panel"><h3>New Purchase Request</h3>
      <div class="form-grid">
        <div><label>Project (optional)</label><select id="pr-project"><option value="">- General / Not Project-Specific -</option>${projects.map(p => `<option value="${p.id}">${esc(p.project_code)}</option>`).join('')}</select></div>
      </div>
      <div id="pr-lines"></div>
      <button class="btn small outline" type="button" onclick="addPRLine()">+ Add Line Item</button>
      <div id="pr-vendor-suggestions" style="display:none;margin-top:8px;padding:10px;background:#f5f5f5;border-radius:6px;font-size:13px;"></div>
      <div style="margin-top:12px;"><button class="btn" onclick="addPR()">Submit Request</button></div>
      <div id="pr-err" class="msg err" style="display:none;margin-top:10px;"></div>
      <div class="muted" style="margin-top:8px;">Picking from the master is optional — type a new item name if it isn't there yet. It goes to Store & Inventory → Item Master as <b>Pending</b> for review, and becomes a permanent master item once Store approves it (usually while receiving the goods).<br>
      Project is optional too — leave it as "General / Not Project-Specific" for stock replenishment, consumables, or any other purchase that isn't tied to a particular project.<br>
      Every request goes to the Purchase HOD/Supervisor for approval first; above the configured threshold it then also needs Management sign-off (see Admin → Approval Matrix).<br>
      Requests with a combined value of ₹${fmt(threshold)} or above need at least 2 vendor quotes on file before they can be submitted for approval.</div>
    </div>
    ${collapsiblePanel('purchase-requests-list', `<span id="pr-count">Purchase Requests (${reqs.length})</span>`, `
      <p class="muted">Pending requests can be edited before they're approved — click Edit to review/change the items, project, quantities or values.</p>
      ${renderListSearch('purchase-requests', reqs, ['pr_no', 'item_summary', 'project_code', 'status'], (rows) => {
        document.getElementById('pr-table-wrap').innerHTML = renderPRRows(rows);
        document.getElementById('pr-count').textContent = 'Purchase Requests (' + rows.length + ')';
      }, 'Search by PR no, item, project, status...')}
      <div id="pr-table-wrap">${renderPRRows(reqs)}</div>
    `)}
    <div class="panel" id="pr-edit-panel" style="display:none;"><h3>Edit Purchase Request</h3><div id="pr-edit-body"></div></div>`;
  if (items.length === 0) el.querySelector('.panel').insertAdjacentHTML('afterbegin', `<div class="msg err">No items defined yet — add items via Store page first.</div>`);
  renderPRLines();
  window.__PR_CACHE = reqs;
};
function prItemOptions(selectedId) {
  const items = window.__PR_ITEMS || [];
  return `<option value="">- type a new item instead -</option>${items.filter(i=>!['Pending','Discontinued'].includes(i.status))
    .map(i => `<option value="${i.id}" ${i.id===selectedId?'selected':''}>${esc(i.name)}</option>`).join('')}`;
}
function renderPRLines() {
  const el = document.getElementById('pr-lines');
  if (!el) return;
  el.innerHTML = tableHTML(['Item (pick from master)', 'Or type a new item', 'Qty', 'Est. Value (₹)', ''], PR_LINES, (l, i) => `
    <tr>
      <td><select onchange="PR_LINES[${i}].item_id=this.value?Number(this.value):'';showVendorsForPRLine(${i})">${prItemOptions(l.item_id)}</select></td>
      <td><input value="${esc(l.item_text||'')}" placeholder="Not in the master? Type it here" onchange="PR_LINES[${i}].item_text=this.value" ${l.item_id ? 'disabled' : ''}></td>
      <td><input type="number" value="${l.quantity}" onchange="PR_LINES[${i}].quantity=Number(this.value)" style="width:80px;"></td>
      <td><input type="number" value="${l.estimated_value}" onchange="PR_LINES[${i}].estimated_value=Number(this.value);renderPRLines()" style="width:100px;"></td>
      <td>${PR_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="PR_LINES.splice(${i},1);renderPRLines()">✕</button>` : ''}</td>
    </tr>`).replace('</tbody></table>', `</tbody><tfoot><tr><td colspan="3" style="text-align:right;"><b>Total Est. Value</b></td><td><b>₹${fmt(PR_LINES.reduce((s,l)=>s+(Number(l.estimated_value)||0),0))}</b></td><td></td></tr></tfoot></table>`);
}
window.addPRLine = () => { PR_LINES.push({ item_id: '', item_text: '', quantity: 1, estimated_value: 0 }); renderPRLines(); };
function renderPRRows(rows) {
  return tableHTML(['PR No', 'Item(s)', 'Project', 'Lines', 'Total Est. Value', 'Status', 'Action'], rows, r => `
    <tr id="pr-row-${r.id}">
      <td>${esc(r.pr_no)}</td>
      <td>${esc(r.item_summary)||esc(r.item_name)||'-'}${r.pending_item_count > 0 ? ' <span class="badge Pending" title="Not yet in the approved Item Master">Item pending review</span>' : ''}</td>
      <td>${r.project_code ? esc(r.project_code) : '<span class="muted">General</span>'}</td><td>${r.line_count || 1}</td><td>₹${fmt(r.items_total_value != null ? r.items_total_value : r.estimated_value)}</td><td>${badge(r.status)}</td>
      <td>
        ${['Pending', 'Rejected', 'InfoRequested'].includes(r.status) ? `<button class="btn small outline" onclick="openEditPR(${r.id})">Edit</button>` : ''}
        ${r.status === 'Rejected' ? `<button class="btn small outline" type="button" onclick="resubmitPR(${r.id})">Resubmit</button>` : ''}
        ${r.status === 'InfoRequested' ? `<button class="btn small outline" type="button" onclick="provideInfoPR(${r.id})">Provide Info</button>` : ''}
        ${['Pending', 'PendingQuotes', 'InfoRequested', 'Rejected'].includes(r.status) ? `<button class="btn small outline" type="button" onclick="cancelPR(${r.id})">Withdraw</button>` : ''}
        <button class="btn small outline" type="button" onclick="togglePRQuotes(${r.id})">Quotes / RFQ</button>
        ${['Approved', 'OrderPlaced'].includes(r.status) ? `<button class="btn small outline" type="button" onclick="repeatPR(${r.id})">Repeat</button>` : ''}
      </td>
    </tr>
    ${r.status === 'Rejected' && r.rejection_reason ? `<tr><td></td><td colspan="6" style="padding-top:0;"><span class="muted" style="font-size:12px;">Rejected${r.rejected_by_name ? ' by ' + esc(r.rejected_by_name) : ''}: ${esc(r.rejection_reason)}</span></td></tr>` : ''}
    ${r.status === 'InfoRequested' && r.info_requested_note ? `<tr><td></td><td colspan="6" style="padding-top:0;"><span class="muted" style="font-size:12px;">More info requested${r.info_requested_by_name ? ' by ' + esc(r.info_requested_by_name) : ''}: ${esc(r.info_requested_note)}</span></td></tr>` : ''}
    <tr id="pr-quotes-row-${r.id}" style="display:none;"><td colspan="7"><div id="pr-quotes-${r.id}"></div></td></tr>`);
}
window.provideInfoPR = async (id) => {
  const comment = prompt('Response to the reviewer (optional):');
  try {
    await api(`/approvals/${(window.__PR_CACHE || []).find(r => r.id === id).approval_id}/provide-info`, { method: 'POST', body: JSON.stringify({ comment }) });
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};
window.resubmitPR = async (id) => {
  try {
    const r = await api(`/purchase/requests/${id}/resubmit`, { method: 'POST' });
    if (r.quotes_required) alert('This request now needs at least 2 vendor quotes before it can go back for approval - use the Vendor Quotes button to add them.');
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};
// Lets the requester close out a PR themselves - most useful after one or
// more rejections, when trying again isn't worth it. Only available before
// a purchase order exists against it; once Approved/OrderPlaced, unwinding
// goes through Cancel PO instead (routes/purchase.js already reverses the PR
// back to Approved there if its only PO is cancelled).
window.cancelPR = async (id) => {
  const reason = prompt('Reason for withdrawing this request (optional):');
  if (reason === null) return;
  if (!confirm('Withdraw this Purchase Request? This cannot be undone.')) return;
  try {
    await api(`/purchase/requests/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};
// "Repeat" an already-approved/ordered PR (only shown once it's actually
// Approved or OrderPlaced - reordering something never yet approved doesn't
// make sense) by pre-filling the New Purchase Request form above with its
// same lines and project. Nothing is submitted here - it's a starting point
// the user reviews/adjusts like any other new request, reusing the existing
// create flow rather than a separate clone endpoint.
window.repeatPR = async (id) => {
  const r = (window.__PR_CACHE || []).find(x => x.id === id);
  if (!r) return;
  try {
    const lines = await api('/purchase/requests/' + id + '/items').catch(() => []);
    PR_LINES = lines.length
      ? lines.map(l => ({ item_id: l.item_id || '', item_text: l.item_text || '', quantity: l.quantity, estimated_value: l.estimated_value || 0 }))
      : [{ item_id: r.item_id || '', item_text: '', quantity: r.quantity, estimated_value: r.estimated_value || 0 }];
    renderPRLines();
    const projectSel = document.getElementById('pr-project');
    if (projectSel) projectSel.value = r.project_id || '';
    const errEl = document.getElementById('pr-err');
    if (errEl) errEl.style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) { alert(e.message); }
};
window.showVendorsForPRLine = async (i) => {
  const itemId = PR_LINES[i] && PR_LINES[i].item_id;
  const box = document.getElementById('pr-vendor-suggestions');
  renderPRLines();
  if (!itemId) { box.style.display = 'none'; return; }
  try {
    const { vendors, fallback } = await api('/purchase/vendors-for-item/' + itemId);
    box.style.display = 'block';
    box.innerHTML = `<b>${fallback ? 'All vendors' : 'Vendors matching this item\'s category'}</b> (${vendors.length}): ${vendors.map(v => esc(v.name)).join(', ') || 'None on file yet.'}`;
  } catch (e) { box.style.display = 'none'; }
};
window.togglePRQuotes = (id) => {
  const row = document.getElementById('pr-quotes-row-' + id);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderPRQuotesPanel(id);
};
const PR_QUOTES_LINES_CACHE = {};
const RFQ_VENDOR_LOOKUP = {};
const RFQ_SELECTED_VENDORS = {};
const RFQ_SELECTED_EMAILS = {};
async function renderPRQuotesPanel(prId) {
  const container = document.getElementById('pr-quotes-' + prId);
  const pr = (window.__PR_CACHE || []).find(r => r.id === prId);
  const [quotes, lines] = await Promise.all([
    api(`/purchase/requests/${prId}/quotes`),
    api(`/purchase/requests/${prId}/items`).catch(() => []),
  ]);
  PR_QUOTES_LINES_CACHE[prId] = lines;
  // Suggest vendors across every line's item category, merged/deduped -
  // a multi-item PR can span more than one vendor category.
  const itemIds = [...new Set(lines.map(l => l.item_id).filter(Boolean))];
  const vendorResults = await Promise.all(itemIds.map(id => api('/purchase/vendors-for-item/' + id).catch(() => ({ vendors: [] }))));
  const vendorMap = new Map();
  vendorResults.forEach(r => (r.vendors || []).forEach(v => vendorMap.set(v.id, v)));
  const vendors = [...vendorMap.values()];
  const canSubmit = quotes.length >= 2 && pr && pr.status === 'PendingQuotes';
  const lineLabel = l => esc(l.item_name || l.item_text || 'Item') + ` (Qty: ${l.quantity}${l.item_unit ? ' ' + esc(l.item_unit) : ''})`;
  // Only a vendor with an email on file can actually receive an RFQ -
  // filtering them out of the picker (rather than just graying them out)
  // keeps the list short, since vendors-for-item's own fallback (no
  // category match) can otherwise suggest the entire Vendor Master.
  const vendorsWithEmail = vendors.filter(v => v.po_email || v.email);
  const vendorsNoEmail = vendors.filter(v => !v.po_email && !v.email);
  RFQ_VENDOR_LOOKUP[prId] = vendorsWithEmail;
  RFQ_SELECTED_VENDORS[prId] = [];
  RFQ_SELECTED_EMAILS[prId] = [];
  container.innerHTML = `
    <div style="padding:10px;background:#f9f9f9;border-radius:6px;">
      <h4 style="margin:0 0 8px;">Vendor Quotes ${pr ? '- ' + esc(pr.pr_no) : ''}</h4>
      ${tableHTML(['Vendor', 'Line Item', 'Quoted Amount', 'Qty Offered', 'Payment Terms', 'Delivery Commit', 'File', 'Notes', 'Selected', ''], quotes, q => `
        <tr>
          <td>${esc(q.vendor_name)}</td>
          <td>${q.purchase_request_item_id ? esc(q.pr_item_name || q.pr_item_text || 'Item') : '<span class="muted">Whole PR</span>'}</td>
          <td>₹${fmt(q.quoted_amount)}</td>
          <td>${q.quoted_qty != null ? q.quoted_qty : '-'}</td>
          <td>${esc(q.payment_terms)||'-'}</td>
          <td>${q.delivery_commit_date ? esc(q.delivery_commit_date) : '-'}</td>
          <td>${q.quote_file_path ? `<a href="${esc(q.quote_file_path)}" target="_blank">View</a>` : '-'}</td>
          <td>${esc(q.notes)||''}</td>
          <td>${q.is_selected ? '✓' : ''}</td>
          <td>
            ${!q.is_selected ? `<button class="btn small outline" type="button" onclick="selectPRQuote(${prId},${q.id})">Select</button>` : ''}
            <button class="btn small outline" type="button" onclick="deletePRQuote(${prId},${q.id})">Remove</button>
          </td>
        </tr>`)}
      <div class="form-grid" style="margin-top:10px;">
        <div><label>Vendor</label><select id="prq-vendor-${prId}">${vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('') || '<option value="">- No vendors -</option>'}</select></div>
        <div><label>Line Item (optional)</label><select id="prq-item-${prId}"><option value="">- Whole PR (lump sum) -</option>${lines.map(l => `<option value="${l.id}">${lineLabel(l)}</option>`).join('')}</select></div>
        <div><label>Quoted Amount (₹)</label><input id="prq-amount-${prId}" type="number"></div>
        <div><label>Qty Offered</label><input id="prq-qty-${prId}" type="number"></div>
        <div><label>Payment Terms</label><input id="prq-terms-${prId}" placeholder="e.g. Net 30"></div>
        <div><label>Delivery Commit</label><input id="prq-delivery-${prId}" type="date"></div>
        <div><label>Quote File</label><input id="prq-file-${prId}" type="file"></div>
        <div><label>Notes</label><input id="prq-notes-${prId}"></div>
      </div>
      <button class="btn small" type="button" onclick="addPRQuote(${prId})" ${!vendors.length ? 'disabled' : ''}>Add Quote</button>
      ${pr && pr.quotes_required ? `<button class="btn" type="button" style="margin-left:10px;" onclick="submitPRForApproval(${prId})" ${canSubmit ? '' : 'disabled'}>Submit for Approval</button>
      ${!canSubmit && pr.status === 'PendingQuotes' ? `<span class="muted" style="margin-left:8px;">Need at least 2 quotes (have ${quotes.length}).</span>` : ''}` : ''}
    </div>
    <div style="padding:10px;background:#f4f8fb;border-radius:6px;margin-top:10px;">
      <h4 style="margin:0 0 8px;">Request for Quotation (RFQ)</h4>
      <p class="muted" style="margin-top:0;">Select line items and vendors, then edit and send an RFQ email. A vendor's reply still comes back by phone/email outside the system - type it in as a quote above once you have it.</p>
      <div style="margin-bottom:8px;"><b>Line Items</b><br>
        ${lines.map(l => `<label style="display:inline-block;margin-right:14px;"><input type="checkbox" class="rfq-item-cb-${prId}" value="${l.id}" checked> ${lineLabel(l)}</label>`).join('') || '<span class="muted">No line items on this PR.</span>'}
      </div>
      <div style="margin-bottom:8px;">
        <label><b>Vendors</b></label><br>
        <select id="rfq-vendor-add-${prId}" style="max-width:320px;"></select>
        <button class="btn small outline" type="button" onclick="addRFQVendor(${prId})">+ Add Vendor</button>
        <div class="muted" style="margin-top:4px;">
          ${vendors.length ? `${vendorsWithEmail.length} of ${vendors.length} suggested vendor(s) have an email on file and can be sent an RFQ.` : 'No suggested vendors - add one in Vendor Master.'}
          ${vendorsNoEmail.length ? (vendorsNoEmail.length <= 10
            ? ` ${vendorsNoEmail.length} excluded for having none: ${vendorsNoEmail.map(v => esc(v.name)).join(', ')}.`
            : ` ${vendorsNoEmail.length} excluded for having none - add one in Vendor Master to include them here.`) : ''}
        </div>
        <div style="margin-top:8px;">
          <input type="email" id="rfq-email-add-${prId}" placeholder="or type an email address not on file" style="max-width:320px;" onkeydown="if(event.key==='Enter'){event.preventDefault();addRFQEmail(${prId});}">
          <button class="btn small outline" type="button" onclick="addRFQEmail(${prId})">+ Add Email</button>
        </div>
        <div id="rfq-vendor-list-${prId}" style="margin-top:8px;"></div>
      </div>
      <button class="btn small outline" type="button" onclick="loadRFQTemplate(${prId})">Load Default Template</button>
      <div class="form-grid" style="margin-top:8px;">
        <div style="grid-column:1/-1;"><label>Subject</label><input id="rfq-subject-${prId}"></div>
        <div style="grid-column:1/-1;"><label>Body (use {{vendor_name}} to personalize per vendor)</label><textarea id="rfq-body-${prId}" rows="10" style="width:100%;"></textarea></div>
      </div>
      <button class="btn" type="button" onclick="sendRFQ(${prId})" ${!lines.length ? 'disabled' : ''}>Send RFQ</button>
      <div id="rfq-send-result-${prId}" style="margin-top:8px;"></div>
      <div id="rfq-history-${prId}" style="margin-top:14px;"></div>
    </div>`;
  renderRFQVendorList(prId);
  if (lines.length) loadRFQTemplate(prId);
  renderRFQHistory(prId);
}
// Re-renders both the "already added" vendor list (with a remove button
// each) and the add-dropdown's own options, excluding whichever vendors
// are already in the list - picking one at a time from a dropdown reads
// far more clearly than a multi-select or a wall of checkboxes once there
// are more than a handful of candidates.
function renderRFQVendorList(prId) {
  const listEl = document.getElementById('rfq-vendor-list-' + prId);
  const addEl = document.getElementById('rfq-vendor-add-' + prId);
  if (!listEl || !addEl) return;
  const all = RFQ_VENDOR_LOOKUP[prId] || [];
  const selectedIds = RFQ_SELECTED_VENDORS[prId] || [];
  const selected = selectedIds.map(id => all.find(v => v.id === id)).filter(Boolean);
  const available = all.filter(v => !selectedIds.includes(v.id));
  const emails = RFQ_SELECTED_EMAILS[prId] || [];
  // A real empty placeholder as the first option, not just omitted - a
  // native <select> otherwise defaults its value to whatever option ends
  // up first (the first available vendor), which would make sendRFQ's
  // "pick up whatever's pending" auto-add silently email a vendor nobody
  // actually chose.
  addEl.innerHTML = available.length
    ? `<option value="">- Select a vendor to add -</option>${available.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}`
    : '<option value="">- No more vendors to add -</option>';
  const chip = (label, onRemove) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 8px;background:#eee;border-radius:10px;font-size:var(--fs-sm);">${label} <a href="#" onclick="${onRemove};return false;" style="margin-left:4px;">✕</a></span>`;
  const chips = [
    ...selected.map(v => chip(esc(v.name), `removeRFQVendor(${prId},${v.id})`)),
    ...emails.map(e => chip(esc(e), `removeRFQEmail(${prId},'${esc(e)}')`)),
  ];
  listEl.innerHTML = chips.length ? chips.join('')
    : '<span class="muted">No recipients added yet - pick a vendor or type an email address above.</span>';
}
window.addRFQVendor = (prId) => {
  const addEl = document.getElementById('rfq-vendor-add-' + prId);
  const vendorId = Number(addEl.value);
  if (!vendorId) return;
  RFQ_SELECTED_VENDORS[prId] = [...(RFQ_SELECTED_VENDORS[prId] || []), vendorId];
  renderRFQVendorList(prId);
};
window.removeRFQVendor = (prId, vendorId) => {
  RFQ_SELECTED_VENDORS[prId] = (RFQ_SELECTED_VENDORS[prId] || []).filter(id => id !== vendorId);
  renderRFQVendorList(prId);
};
window.addRFQEmail = (prId) => {
  const inputEl = document.getElementById('rfq-email-add-' + prId);
  const email = inputEl.value.trim().toLowerCase();
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert(`"${email}" doesn't look like a valid email address.`); return; }
  if ((RFQ_SELECTED_EMAILS[prId] || []).includes(email)) { inputEl.value = ''; return; }
  RFQ_SELECTED_EMAILS[prId] = [...(RFQ_SELECTED_EMAILS[prId] || []), email];
  inputEl.value = '';
  renderRFQVendorList(prId);
};
window.removeRFQEmail = (prId, email) => {
  RFQ_SELECTED_EMAILS[prId] = (RFQ_SELECTED_EMAILS[prId] || []).filter(e => e !== email);
  renderRFQVendorList(prId);
};
function defaultRFQBody(pr, lines, selectedItemIds) {
  const selected = lines.filter(l => selectedItemIds.includes(l.id));
  const itemLines = selected.map(l => `- ${l.item_name || l.item_text || 'Item'} : Qty ${l.quantity}${l.item_unit ? ' ' + l.item_unit : ''}`).join('\n');
  return `Dear {{vendor_name}},\n\nWe would like to request your quotation for the following item(s) against our Purchase Request ${pr ? pr.pr_no : ''}:\n\n${itemLines}\n\nPlease share in your quotation:\n- Unit price and total price\n- Payment terms\n- Delivery commitment (lead time / date)\n\nKindly send your quotation at the earliest.\n\nRegards,\nVenkateshwara Engineers - Purchase Department`;
}
window.loadRFQTemplate = (prId) => {
  const pr = (window.__PR_CACHE || []).find(r => r.id === prId);
  const lines = PR_QUOTES_LINES_CACHE[prId] || [];
  const selectedItemIds = [...document.querySelectorAll(`.rfq-item-cb-${prId}:checked`)].map(cb => Number(cb.value));
  document.getElementById('rfq-subject-' + prId).value = `Request for Quotation - PR ${pr ? pr.pr_no : ''}`;
  document.getElementById('rfq-body-' + prId).value = defaultRFQBody(pr, lines, selectedItemIds);
};
window.sendRFQ = async (prId) => {
  const resultEl = document.getElementById('rfq-send-result-' + prId);
  resultEl.innerHTML = '';
  // A vendor picked in the dropdown or an email typed into the box but
  // never explicitly "+ Add"ed is still an obvious intent to send to it -
  // pick it up here instead of silently ignoring it and telling the user
  // "add at least one vendor or email" when they just did.
  const pendingVendorSel = document.getElementById('rfq-vendor-add-' + prId);
  if (pendingVendorSel && pendingVendorSel.value) addRFQVendor(prId);
  const pendingEmailInput = document.getElementById('rfq-email-add-' + prId);
  if (pendingEmailInput && pendingEmailInput.value.trim()) addRFQEmail(prId);

  const itemIds = [...document.querySelectorAll(`.rfq-item-cb-${prId}:checked`)].map(cb => Number(cb.value));
  const vendorIds = RFQ_SELECTED_VENDORS[prId] || [];
  const extraEmails = RFQ_SELECTED_EMAILS[prId] || [];
  const subject = val('rfq-subject-' + prId);
  const body = document.getElementById('rfq-body-' + prId).value;
  if (!itemIds.length) { alert('Select at least one line item.'); return; }
  if (!vendorIds.length && !extraEmails.length) { alert('Add at least one vendor or email address.'); return; }
  try {
    const result = await api(`/purchase/requests/${prId}/rfq`, { method: 'POST', body: JSON.stringify({ item_ids: itemIds, vendor_ids: vendorIds, extra_emails: extraEmails, subject, body }) });
    const anyFailed = result.results.some(r => r.email_status === 'Failed' || r.email_status === 'NoEmail');
    resultEl.innerHTML = `<div class="msg ${anyFailed ? 'err' : 'ok'}">
      ${result.results.map(r => `${esc(r.vendor_name || r.email)}: ${esc(r.email_status)}${r.email_error ? ' - ' + esc(r.email_error) : ''}`).join('<br>')}
    </div>`;
    renderRFQHistory(prId);
  } catch (e) { resultEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};
async function renderRFQHistory(prId) {
  const el = document.getElementById('rfq-history-' + prId);
  if (!el) return;
  const rfqs = await api(`/purchase/requests/${prId}/rfq`).catch(() => []);
  if (!rfqs.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<b>RFQ History</b>` + tableHTML(['Sent', 'Subject', 'Recipients', 'By'], rfqs, r => `
    <tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${esc(r.subject)}</td>
    <td>${[...r.vendors.map(v => `${esc(v.vendor_name)} (${esc(v.email_status)})`), ...(r.emails||[]).map(e => `${esc(e.email)} (${esc(e.email_status)})`)].join(', ')}</td>
    <td>${esc(r.created_by_name)||'-'}</td></tr>`);
}
window.addPRQuote = async (prId) => {
  try {
    const fd = new FormData();
    fd.append('vendor_id', val('prq-vendor-' + prId));
    fd.append('quoted_amount', val('prq-amount-' + prId));
    fd.append('notes', val('prq-notes-' + prId));
    fd.append('purchase_request_item_id', val('prq-item-' + prId));
    fd.append('quoted_qty', val('prq-qty-' + prId));
    fd.append('payment_terms', val('prq-terms-' + prId));
    fd.append('delivery_commit_date', val('prq-delivery-' + prId));
    const fileEl = document.getElementById('prq-file-' + prId);
    if (fileEl.files.length) fd.append('quote_file', fileEl.files[0]);
    await apiUpload(`/purchase/requests/${prId}/quotes`, fd, 'POST');
    renderPRQuotesPanel(prId);
  } catch (e) { alert(e.message); }
};
window.selectPRQuote = async (prId, quoteId) => {
  try { await api(`/purchase/requests/${prId}/quotes/${quoteId}/select`, { method: 'PUT' }); renderPRQuotesPanel(prId); }
  catch (e) { alert(e.message); }
};
window.deletePRQuote = async (prId, quoteId) => {
  try { await api(`/purchase/requests/${prId}/quotes/${quoteId}`, { method: 'DELETE' }); renderPRQuotesPanel(prId); }
  catch (e) { alert(e.message); }
};
window.submitPRForApproval = async (prId) => {
  try { await api(`/purchase/requests/${prId}/submit-for-approval`, { method: 'POST' }); navigate('purchase-requests'); }
  catch (e) { alert(e.message); }
};
window.addPR = async () => {
  const errEl = document.getElementById('pr-err');
  errEl.style.display = 'none';
  try {
    const lines = PR_LINES.filter(l => (l.item_id || (l.item_text||'').trim()) && Number(l.quantity) > 0)
      .map(l => ({ item_id: l.item_id || null, item_text: l.item_text || null, quantity: Number(l.quantity), estimated_value: Number(l.estimated_value) || 0 }));
    if (!lines.length) throw new Error('Add at least one item line with a quantity.');
    await api('/purchase/requests', { method: 'POST', body: JSON.stringify({
      project_id: val('pr-project') || null, items: lines
    })});
    navigate('purchase-requests');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
let EDIT_PR_LINES = [];
window.openEditPR = async (id) => {
  const r = (window.__PR_CACHE || []).find(x => x.id === id);
  if (!r) return;
  const projects = window.__PR_PROJECTS || [];
  const panel = document.getElementById('pr-edit-panel');
  const lines = await api('/purchase/requests/' + id + '/items').catch(() => []);
  EDIT_PR_LINES = lines.length ? lines.map(l => ({ item_id: l.item_id || '', item_text: l.item_text || '', quantity: l.quantity, estimated_value: l.estimated_value || 0 }))
    : [{ item_id: r.item_id || '', item_text: '', quantity: r.quantity, estimated_value: r.estimated_value || 0 }];
  document.getElementById('pr-edit-body').innerHTML = `
    <div class="form-grid">
      <div><label>Project (optional)</label><select id="pre-project"><option value="">- General / Not Project-Specific -</option>${projects.map(p => `<option value="${p.id}" ${p.id===r.project_id?'selected':''}>${esc(p.project_code)}</option>`).join('')}</select></div>
    </div>
    <div id="pre-lines"></div>
    <button class="btn small outline" type="button" onclick="addEditPRLine()">+ Add Line Item</button>
    <div style="margin-top:12px;">
      <button class="btn" onclick="saveEditPR(${id})">Save Changes</button>
      <button class="btn outline" type="button" onclick="document.getElementById('pr-edit-panel').style.display='none'">Cancel</button>
    </div>
    <div id="pre-err" class="msg err" style="display:none;margin-top:10px;"></div>
    <div id="pr-attachments-${id}"></div>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  renderEditPRLines();
  renderAttachmentsWidget('purchase_request', id, document.getElementById(`pr-attachments-${id}`));
};
function renderEditPRLines() {
  const el = document.getElementById('pre-lines');
  if (!el) return;
  el.innerHTML = tableHTML(['Item (pick from master)', 'Or type a new item', 'Qty', 'Est. Value (₹)', ''], EDIT_PR_LINES, (l, i) => `
    <tr>
      <td><select onchange="EDIT_PR_LINES[${i}].item_id=this.value?Number(this.value):'';renderEditPRLines()">${prItemOptions(l.item_id)}</select></td>
      <td><input value="${esc(l.item_text||'')}" placeholder="Not in the master? Type it here" onchange="EDIT_PR_LINES[${i}].item_text=this.value" ${l.item_id ? 'disabled' : ''}></td>
      <td><input type="number" value="${l.quantity}" onchange="EDIT_PR_LINES[${i}].quantity=Number(this.value)" style="width:80px;"></td>
      <td><input type="number" value="${l.estimated_value}" onchange="EDIT_PR_LINES[${i}].estimated_value=Number(this.value);renderEditPRLines()" style="width:100px;"></td>
      <td>${EDIT_PR_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="EDIT_PR_LINES.splice(${i},1);renderEditPRLines()">✕</button>` : ''}</td>
    </tr>`).replace('</tbody></table>', `</tbody><tfoot><tr><td colspan="3" style="text-align:right;"><b>Total Est. Value</b></td><td><b>₹${fmt(EDIT_PR_LINES.reduce((s,l)=>s+(Number(l.estimated_value)||0),0))}</b></td><td></td></tr></tfoot></table>`);
}
window.addEditPRLine = () => { EDIT_PR_LINES.push({ item_id: '', item_text: '', quantity: 1, estimated_value: 0 }); renderEditPRLines(); };
window.saveEditPR = async (id) => {
  const errEl = document.getElementById('pre-err');
  errEl.style.display = 'none';
  try {
    const lines = EDIT_PR_LINES.filter(l => (l.item_id || (l.item_text||'').trim()) && Number(l.quantity) > 0)
      .map(l => ({ item_id: l.item_id || null, item_text: l.item_text || null, quantity: Number(l.quantity), estimated_value: Number(l.estimated_value) || 0 }));
    if (!lines.length) throw new Error('Add at least one item line with a quantity.');
    await api('/purchase/requests/' + id, { method: 'PUT', body: JSON.stringify({
      project_id: val('pre-project') || null, items: lines
    })});
    navigate('purchase-requests');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Purchase Orders ----
PAGES['purchase-orders'] = async (el) => {
  const orders = await api('/purchase/orders');
  // Only Active vendors are offered when creating a new PO - Inactive/
  // Blacklisted ones stay visible/editable in Vendor Master (and on POs that
  // already reference them) but drop out of the picker.
  const vendors = (await api('/masters/vendors')).filter(v => (v.status || 'Active') === 'Active');
  const items = await api('/masters/items');
  const prs = (await api('/purchase/requests')).filter(r => r.status === 'Approved');
  const companyAddresses = await api('/settings/company-addresses').catch(() => []);
  el.innerHTML = `
    <div class="panel"><h3>New Purchase Order</h3>
      ${!vendors.length ? `<div class="msg err">No vendors yet - add one under <a href="#" onclick="navigate('vendors');return false;">Vendor Master</a> before creating a PO.</div>` : ''}
      <div class="form-grid">
        <div><label>From PR (approved)</label><select id="po-pr" onchange="fillPOFromPR()"><option value="">-</option>${prs.map(r => `<option value="${r.id}">${esc(r.pr_no)}</option>`).join('')}</select></div>
        <div id="po-pr-line-wrap" style="display:none;"><label>PR Line Item</label><select id="po-pr-item" onchange="fillPOFromPRLine()"></select></div>
        <div><label>Vendor</label><select id="po-vendor" ${!vendors.length ? 'disabled' : ''}>${vendors.length ? vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('') : '<option value="">- No vendors -</option>'}</select></div>
        <div><label>Item</label><select id="po-item" onchange="showVendorsForPOItem()">${items.map(i => `<option value="${i.id}">${esc(i.name)}${i.status === 'Pending' ? ' (pending review)' : ''}${i.status === 'Discontinued' ? ' (discontinued)' : ''}</option>`).join('')}</select></div>
        <div><label>Quantity</label><input id="po-qty" type="number"></div>
        <div><label>Rate (₹)</label><input id="po-rate" type="number"></div>
        <div><label>HSN Code</label><input id="po-hsn"></div>
        <div><label>GST Rate (%)</label><input id="po-gst" type="number" value="18"></div>
        <div><label>Delivery Date</label><input id="po-delivery" type="date"></div>
        <div><label>Our Address (Bill-To/Ship-To)</label><select id="po-company-address"><option value="">- Default (from Company Settings) -</option>${companyAddresses.map(a => `<option value="${a.id}">${esc(a.address_type)}${a.label ? ' - ' + esc(a.label) : ''}</option>`).join('')}</select></div>
      </div>
      <div><label>Terms</label><textarea id="po-terms" rows="2" style="width:100%;" placeholder="Standard terms apply..."></textarea></div>
      <div class="hod-tools" style="margin-top:0;border-top:1px dashed var(--border);padding-top:10px;">
        <h4 style="margin-top:0;">LD Clause (optional)</h4>
        <div class="form-grid">
          <div><label>LD Rate (%)</label><input id="po-ld-pct" type="number" step="0.01"></div>
          <div><label>LD Cap (%)</label><input id="po-ld-cap" type="number" step="0.01"></div>
        </div>
        <div><label>Trigger Conditions</label><textarea id="po-ld-notes" rows="2" style="width:100%;" placeholder="e.g. 0.5% per week of delay, capped at 5% of order value"></textarea></div>
      </div>
      <div id="po-pr-detail" style="display:none;margin-top:10px;padding:10px;background:#f5f5f5;border-radius:6px;font-size:13px;"></div>
      <div id="po-vendor-suggestions" style="display:none;margin-top:8px;padding:10px;background:#f5f5f5;border-radius:6px;font-size:13px;"></div>
      <button class="btn" onclick="addPO()" ${!vendors.length ? 'disabled' : ''}>Create PO</button>
    </div>
    <div class="panel"><h3>Bulk Import Open POs</h3>
      <p class="muted">Bring in orders already open with a vendor before this system was used - each row becomes a real PO you can then receive, edit, cancel, or print, same as one created here. Vendor names not on file are added automatically; items are matched by Item Code or barcode.</p>
      <button class="btn outline" type="button" onclick="downloadPOImportTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('po-upload-file')}
      <button class="btn" onclick="uploadPOImportTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="po-upload-result" style="margin-top:10px;"></div>
    </div>
    ${collapsiblePanel('po-list', `<span id="po-count">Purchase Orders (${orders.length})</span>`, `
      ${renderListSearch('purchase-orders', orders, ['po_no', 'vendor_name', 'item_name', 'status'], (rows) => {
        document.getElementById('po-table-wrap').innerHTML = renderPORows(rows);
        document.getElementById('po-count').textContent = 'Purchase Orders (' + rows.length + ')';
      }, 'Search by PO no, vendor, item, status...')}
      <div id="po-table-wrap">${renderPORows(orders)}</div>
    `)}`;
  window.__PO_PRS = prs;
  window.__PO_VENDORS = vendors;
  window.__PO_ITEMS = items;
  window.__PO_COMPANY_ADDRESSES = companyAddresses;
};
function renderPORows(rows) {
  return tableHTML(['PO No', 'Vendor', 'Item', 'Qty', 'Received', 'Rate', 'Total', 'Status', 'Promised Delivery', 'Documents', ''], rows, o => `
    <tr><td>${esc(o.po_no)}</td><td>${esc(o.vendor_name)}</td><td>${esc(o.item_name)}</td><td>${o.quantity}</td>
    <td>${o.received_qty > 0 ? `${o.received_qty} / ${o.quantity}` : '-'}</td>
    <td>₹${fmt(o.rate)}</td><td>₹${fmt(o.total_value)}</td><td>${badge(o.status)}</td>
    <td>${deliveryBadge(o.delivery_date)}</td>
    <td>
      <button class="btn small outline" type="button" onclick="downloadPoPdf(${o.id}, '${esc(o.po_no)}')">PDF</button>
      <button class="btn small outline" type="button" onclick="downloadPoDocx(${o.id}, '${esc(o.po_no)}')">Word</button>
      <button class="btn small outline" type="button" onclick="emailPo(${o.id})">Email Vendor</button>
    </td>
    <td><button class="btn small outline" type="button" onclick="togglePOAttachments(${o.id})">Attachments</button>
    <button class="btn small outline" type="button" onclick="togglePOTerms(${o.id})">Terms</button>
    ${!['Received','Cancelled'].includes(o.status) ? `<button class="btn small outline" type="button" onclick="togglePOEdit(${o.id})">Edit</button>
    <button class="btn small red" type="button" onclick="cancelPO(${o.id})">Cancel</button>` : ''}
    <button class="btn small outline" type="button" onclick="togglePOHistory(${o.id})">History</button></td></tr>
    <tr id="po-att-row-${o.id}" style="display:none;"><td colspan="11"><div id="po-attachments-${o.id}"></div></td></tr>
    <tr id="po-terms-row-${o.id}" style="display:none;"><td colspan="11">${poTermsForm(o)}</td></tr>
    <tr id="po-edit-row-${o.id}" style="display:none;"><td colspan="11">${poEditForm(o)}</td></tr>
    <tr id="po-history-row-${o.id}" style="display:none;"><td colspan="11"><div id="po-history-${o.id}"></div></td></tr>`);
}
function poEditForm(o) {
  const vendors = window.__PO_VENDORS || [];
  const items = window.__PO_ITEMS || [];
  const companyAddresses = window.__PO_COMPANY_ADDRESSES || [];
  return `<div class="form-grid" style="margin-top:8px;">
    <div><label>Vendor</label><select id="po-edit-vendor-${o.id}">${vendors.map(v => `<option value="${v.id}" ${v.id===o.vendor_id?'selected':''}>${esc(v.name)}</option>`).join('')}</select></div>
    <div><label>Item</label><select id="po-edit-item-${o.id}">${items.map(i => `<option value="${i.id}" ${i.id===o.item_id?'selected':''}>${esc(i.name)}</option>`).join('')}</select></div>
    <div><label>Quantity</label><input id="po-edit-qty-${o.id}" type="number" value="${o.quantity}"></div>
    <div><label>Rate (₹)</label><input id="po-edit-rate-${o.id}" type="number" value="${o.rate}"></div>
    <div><label>HSN Code</label><input id="po-edit-hsn-${o.id}" value="${esc(o.hsn_code||'')}"></div>
    <div><label>GST Rate (%)</label><input id="po-edit-gst-${o.id}" type="number" value="${o.gst_rate}"></div>
    <div><label>Our Address (Bill-To/Ship-To)</label><select id="po-edit-address-${o.id}"><option value="">- Default (from Company Settings) -</option>${companyAddresses.map(a => `<option value="${a.id}" ${a.id===o.company_address_id?'selected':''}>${esc(a.address_type)}${a.label ? ' - ' + esc(a.label) : ''}</option>`).join('')}</select></div>
  </div>
  <div><label>Terms</label><textarea id="po-edit-terms-${o.id}" rows="2" style="width:100%;">${esc(o.terms||'')}</textarea></div>
  <button class="btn small" type="button" onclick="savePOEdit(${o.id})">Save Changes</button>
  <div id="po-edit-err-${o.id}" class="msg err" style="display:none;margin-top:8px;"></div>`;
}
window.togglePOEdit = (id) => {
  const row = document.getElementById(`po-edit-row-${id}`);
  row.style.display = row.style.display !== 'none' ? 'none' : '';
};
window.savePOEdit = async (id) => {
  const errEl = document.getElementById(`po-edit-err-${id}`);
  errEl.style.display = 'none';
  try {
    await api(`/purchase/orders/${id}`, { method: 'PUT', body: JSON.stringify({
      vendor_id: val(`po-edit-vendor-${id}`), item_id: val(`po-edit-item-${id}`),
      quantity: val(`po-edit-qty-${id}`), rate: val(`po-edit-rate-${id}`),
      hsn_code: val(`po-edit-hsn-${id}`), gst_rate: val(`po-edit-gst-${id}`), terms: val(`po-edit-terms-${id}`),
      company_address_id: val(`po-edit-address-${id}`) || null,
    })});
    navigate('purchase-orders');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.cancelPO = async (id) => {
  const reason = prompt('Reason for cancelling this order (optional):');
  if (reason === null) return; // user hit Cancel on the prompt itself
  try {
    await api(`/purchase/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
window.togglePOHistory = async (id) => {
  const row = document.getElementById(`po-history-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) {
    const log = await api(`/purchase/orders/${id}/audit-log`).catch(() => []);
    const box = document.getElementById(`po-history-${id}`);
    box.innerHTML = log.length
      ? tableHTML(['When', 'By', 'Action', 'Details'], log, l => `
          <tr><td>${new Date(l.created_at).toLocaleString()}</td><td>${esc(l.actor_name)||'-'}</td><td>${esc(l.action)}</td><td>${esc(l.details)||'-'}</td></tr>`)
      : '<p class="muted">No edits or cancellation recorded for this order yet.</p>';
  }
};
window.downloadPOImportTemplate = () => downloadTemplateFile('/purchase/orders/import-template', 'open_po_import_template.xlsx');
window.uploadPOImportTemplate = () => uploadTemplateFile('/purchase/orders/bulk-upload', 'po-upload-file', 'po-upload-result', () => navigate('purchase-orders'));
window.downloadPoPdf = (id, poNo) => downloadTemplateFile(`/purchase/orders/${id}/pdf`, `${poNo}.pdf`);
window.downloadPoDocx = (id, poNo) => downloadTemplateFile(`/purchase/orders/${id}/docx`, `${poNo}.docx`);
window.emailPo = async (id) => {
  try {
    const r = await api(`/purchase/orders/${id}/email`, { method: 'POST' });
    if (r.sent) alert(`Emailed to ${r.to}`);
    else alert(r.message || 'Email not sent.');
  } catch (e) { alert(e.message); }
};
window.togglePOAttachments = (id) => {
  const row = document.getElementById(`po-att-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderAttachmentsWidget('purchase_order', id, document.getElementById(`po-attachments-${id}`));
};
window.showVendorsForPOItem = async () => {
  const itemId = val('po-item');
  const box = document.getElementById('po-vendor-suggestions');
  if (!itemId) { box.style.display = 'none'; return; }
  try {
    const { vendors, fallback } = await api('/purchase/vendors-for-item/' + itemId);
    box.style.display = 'block';
    box.innerHTML = `<b>${fallback ? 'All vendors' : 'Vendors matching this item\'s category'}</b> (${vendors.length}): ${vendors.map(v => esc(v.name)).join(', ') || 'None on file yet.'}`;
  } catch (e) { box.style.display = 'none'; }
};
window.fillPOFromPR = async () => {
  const id = Number(val('po-pr'));
  const detail = document.getElementById('po-pr-detail');
  const lineWrap = document.getElementById('po-pr-line-wrap');
  if (!id) { detail.style.display = 'none'; lineWrap.style.display = 'none'; return; }
  const r = (window.__PO_PRS || []).find(x => x.id === id);
  if (!r) { detail.style.display = 'none'; lineWrap.style.display = 'none'; return; }
  const lines = await api('/purchase/requests/' + id + '/items').catch(() => []);
  window.__PO_PR_LINES = lines;
  detail.style.display = 'block';
  detail.innerHTML = `<b>${esc(r.pr_no)}</b> — ${lines.length} line item${lines.length===1?'':'s'} &nbsp;
    Project: <b>${esc(r.project_code)||'-'}</b> &nbsp; Total Est. Value: <b>₹${fmt(r.items_total_value != null ? r.items_total_value : r.estimated_value)}</b>`;
  if (lines.length > 1) {
    lineWrap.style.display = 'block';
    const sel = document.getElementById('po-pr-item');
    sel.innerHTML = lines.map(l => `<option value="${l.id}">${esc(l.item_name || l.item_text || '(item)')} — Qty ${l.quantity} — ₹${fmt(l.estimated_value)}</option>`).join('');
    window.fillPOFromPRLine();
  } else {
    lineWrap.style.display = 'none';
    if (lines.length === 1) fillPOFromLine(lines[0]);
  }
};
function fillPOFromLine(line) {
  const itemSel = document.getElementById('po-item');
  if (itemSel && line.item_id) itemSel.value = line.item_id;
  const qtyEl = document.getElementById('po-qty');
  if (qtyEl) qtyEl.value = line.quantity;
}
window.fillPOFromPRLine = () => {
  const lineId = Number(val('po-pr-item'));
  const line = (window.__PO_PR_LINES || []).find(l => l.id === lineId);
  if (line) fillPOFromLine(line);
};
window.addPO = async () => {
  try {
    const lineWrap = document.getElementById('po-pr-line-wrap');
    const prItemId = lineWrap && lineWrap.style.display !== 'none' ? val('po-pr-item') : ((window.__PO_PR_LINES || [])[0] && window.__PO_PR_LINES[0].id) || null;
    const r = await api('/purchase/orders', { method: 'POST', body: JSON.stringify({
      purchase_request_id: val('po-pr') || null, purchase_request_item_id: val('po-pr') ? prItemId : null,
      vendor_id: val('po-vendor'), item_id: val('po-item'), quantity: val('po-qty'), rate: val('po-rate'),
      hsn_code: val('po-hsn'), gst_rate: val('po-gst'), delivery_date: val('po-delivery'), terms: val('po-terms'),
      company_address_id: val('po-company-address') || null,
    })});
    const ldPct = val('po-ld-pct'), ldCap = val('po-ld-cap'), ldNotes = val('po-ld-notes');
    if (ldPct || ldCap || ldNotes) {
      await api(`/purchase/orders/${r.id}/commercial-terms`, { method: 'PATCH', body: JSON.stringify({
        ld_percentage: ldPct || null, ld_cap_percentage: ldCap || null, ld_trigger_notes: ldNotes || null
      })});
    }
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
function poTermsForm(o) {
  return `<div class="form-grid" style="margin-top:8px;">
    <div><label>Promised Delivery Date</label><input id="po-terms-delivery-${o.id}" type="date" value="${o.delivery_date || ''}"></div>
    <div><label>LD Rate (%)</label><input id="po-terms-ldpct-${o.id}" type="number" step="0.01" value="${o.ld_percentage ?? ''}"></div>
    <div><label>LD Cap (%)</label><input id="po-terms-ldcap-${o.id}" type="number" step="0.01" value="${o.ld_cap_percentage ?? ''}"></div>
  </div>
  <div><label>Trigger Conditions</label><textarea id="po-terms-ldnotes-${o.id}" rows="2" style="width:100%;">${esc(o.ld_trigger_notes || '')}</textarea></div>
  <button class="btn small" type="button" onclick="savePOTerms(${o.id})">Save Terms</button>`;
}
window.togglePOTerms = (id) => {
  const row = document.getElementById(`po-terms-row-${id}`);
  row.style.display = row.style.display !== 'none' ? 'none' : '';
};
window.savePOTerms = async (id) => {
  try {
    await api(`/purchase/orders/${id}/commercial-terms`, { method: 'PATCH', body: JSON.stringify({
      delivery_date: val(`po-terms-delivery-${id}`) || null,
      ld_percentage: val(`po-terms-ldpct-${id}`) || null,
      ld_cap_percentage: val(`po-terms-ldcap-${id}`) || null,
      ld_trigger_notes: val(`po-terms-ldnotes-${id}`) || null,
    })});
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};

// ---- Store & Inventory ----
// Split into three separate top-level pages (Round 3): Item Master,
// Stock In/Out, Challans - each its own nav entry, no more sub-tabs.
PAGES.store = async (el) => renderItemMasterSheet(el);
PAGES['stock-in-out'] = async (el) => renderStockInOutSheet(el);
PAGES.challans = async (el) => renderChallanSheet(el);

// ---- Sheet 1: Item Master ----
async function renderItemMasterSheet(el) {
  const [items, pendingItems, pendingChanges] = await Promise.all([
    api('/masters/items'), api('/masters/items?status=Pending'), api('/masters/items/pending-changes').catch(() => []),
  ]);
  const approvedItems = items.filter(i => i.status !== 'Pending');
  window.__ITEM_CACHE = items;
  el.innerHTML = `
    <div class="panel"><h3>Add Item Master</h3>
      <div class="form-grid">
        <div><label>Item Code</label><input id="it-code"></div>
        <div><label>Name</label><input id="it-name"></div>
        <div><label>Unit</label><input id="it-unit" value="Nos"></div>
        <div><label>Category</label><input id="it-cat"></div>
        <div><label>HSN Code</label><input id="it-hsn"></div>
        <div><label>Rack / Location</label><input id="it-loc"></div>
        <div><label>Reorder Level</label><input id="it-reorder" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addItem()">Add Item</button>
      <div class="muted" style="margin-top:8px;">A unique barcode (EAN-13, internal-use 20-prefix range) is generated automatically for every item.</div>
    </div>
    ${pendingItems.length ? collapsiblePanel('pending-item-review', `Pending Item Master Review (${pendingItems.length})`, `
      <p class="muted">These were typed freehand on a Purchase Request instead of picked from the master. Complete the details and Approve - typically while receiving the goods - to add them to the permanent Item Master (a barcode is generated at that point).</p>
      <div id="pending-items-body"></div>
    `) : ''}
    ${pendingChanges.length ? `<div class="panel"><h3>Pending Item Changes (${pendingChanges.length})</h3>
      <p class="muted">An edit or delete on an existing item doesn't take effect until an Admin approves it here, so nothing changes underneath a transaction already using the item's current details.</p>
      ${tableHTML(['Item', 'Change', 'Details', 'Requested By', ''], pendingChanges, c => `
        <tr><td>${esc(c.item_code)||''} ${esc(c.item_name)}</td><td>${badge(c.change_type)}</td>
        <td>${c.change_type === 'Edit' ? esc(Object.entries(JSON.parse(c.proposed_fields||'{}')).map(([k,v]) => `${k}: ${v}`).join(', ')) : '<span class="muted">Delete this item</span>'}</td>
        <td>${esc(c.requested_by_name)||'-'}</td>
        <td>${ME.role === 'Admin' ? `<button class="btn small" type="button" onclick="approveItemChange(${c.id})">Approve</button>
          <button class="btn small outline" type="button" onclick="rejectItemChange(${c.id})">Reject</button>` : '<span class="muted">Awaiting Admin</span>'}</td></tr>`)}
    </div>` : ''}
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per item, then upload it. Barcodes are generated automatically - don't include them in the file.</p>
      <button class="btn outline" type="button" onclick="downloadItemTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('it-upload-file')}
      <button class="btn" onclick="uploadItemTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="it-upload-result" style="margin-top:10px;"></div>
    </div>
    ${collapsiblePanel('item-master-list', `Item Master (${approvedItems.length})`, `
      ${tableHTML(['Code', 'Name', 'Unit', 'Category', 'Location', 'Stock', 'Reorder Level', 'Barcode', 'Status', ''], approvedItems, i => `
        <tr><td>${esc(i.item_code)}</td><td>${esc(i.name)}</td><td>${esc(i.unit)}</td><td>${esc(i.category)||'-'}</td><td>${esc(i.location)||'-'}</td>
          <td>${i.current_stock}${i.current_stock <= i.reorder_level ? ' ⚠️' : ''}</td><td>${i.reorder_level}</td>
          <td><span class="mono" style="letter-spacing:1px;">${esc(i.barcode)||'-'}</span></td>
          <td>${i.status === 'Discontinued' ? badge('Discontinued') : ''}</td>
          <td>${i.status === 'Discontinued'
            ? (ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="reactivateItem(${i.id})">Reactivate</button>` : '')
            : `<button class="btn small outline" type="button" onclick="openEditItem(${i.id})">Edit</button>
               <button class="btn small outline" type="button" onclick="deleteItem(${i.id})">Delete</button>`}</td></tr>`)}
    `)}
    <div class="panel" id="it-edit-panel" style="display:none;"><h3>Edit Item</h3><div id="it-edit-body"></div></div>`;
  if (pendingItems.length) renderPendingItemsPanel(pendingItems);
}
window.approveItemChange = async (id) => {
  try { await api('/masters/items/pending-changes/' + id + '/approve', { method: 'POST' }); navigate('store'); }
  catch (e) { alert(e.message); }
};
window.rejectItemChange = async (id) => {
  const note = prompt('Reason for rejecting (optional):') || '';
  try { await api('/masters/items/pending-changes/' + id + '/reject', { method: 'POST', body: JSON.stringify({ review_note: note }) }); navigate('store'); }
  catch (e) { alert(e.message); }
};
window.reactivateItem = async (id) => {
  try { await api('/masters/items/' + id + '/reactivate', { method: 'POST' }); navigate('store'); }
  catch (e) { alert(e.message); }
};
window.openEditItem = (id) => {
  const i = (window.__ITEM_CACHE || []).find(x => x.id === id);
  if (!i) return;
  const panel = document.getElementById('it-edit-panel');
  document.getElementById('it-edit-body').innerHTML = `
    <div class="form-grid">
      <div><label>Item Code</label><input id="ie-code" value="${esc(i.item_code)}"></div>
      <div><label>Name</label><input id="ie-name" value="${esc(i.name)}"></div>
      <div><label>Unit</label><input id="ie-unit" value="${esc(i.unit)}"></div>
      <div><label>Category</label><input id="ie-cat" value="${esc(i.category)}"></div>
      <div><label>HSN Code</label><input id="ie-hsn" value="${esc(i.hsn_code)}"></div>
      <div><label>Rack / Location</label><input id="ie-loc" value="${esc(i.location)}"></div>
      <div><label>Reorder Level</label><input id="ie-reorder" type="number" value="${i.reorder_level||0}"></div>
    </div>
    <button class="btn" onclick="saveEditItem(${id})">Save Changes</button>
    <button class="btn outline" type="button" onclick="document.getElementById('it-edit-panel').style.display='none'">Cancel</button>
    <div class="muted" style="margin-top:8px;">${ME.role === 'Admin' ? 'As Admin, this applies immediately.' : "This won't take effect until an Admin approves it - see Pending Item Changes above."}</div>
    <div id="ie-err" class="msg err" style="display:none;margin-top:8px;"></div>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.saveEditItem = async (id) => {
  const errEl = document.getElementById('ie-err');
  try {
    const r = await api('/masters/items/' + id, { method: 'PUT', body: JSON.stringify({
      item_code: val('ie-code'), name: val('ie-name'), unit: val('ie-unit'), category: val('ie-cat'),
      hsn_code: val('ie-hsn'), location: val('ie-loc'), reorder_level: val('ie-reorder'),
    })});
    if (r.message) alert(r.message);
    navigate('store');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteItem = async (id) => {
  if (!confirm('Delete this item? If it has any purchase/stock history, it will be discontinued instead of deleted.')) return;
  try {
    const r = await api('/masters/items/' + id, { method: 'DELETE' });
    if (r.message) alert(r.message);
    navigate('store');
  } catch (e) { alert(e.message); }
};
function renderPendingItemsPanel(pendingItems) {
  const body = document.getElementById('pending-items-body');
  if (!body) return;
  body.innerHTML = pendingItems.map(i => `
    <div class="form-grid" style="border-top:1px solid #eee;padding-top:10px;margin-top:10px;" id="pend-item-${i.id}">
      <div><label>Item Code</label><input id="pi-code-${i.id}" value="${esc(i.item_code)||''}"></div>
      <div><label>Name</label><input id="pi-name-${i.id}" value="${esc(i.name)}"></div>
      <div><label>Unit</label><input id="pi-unit-${i.id}" value="${esc(i.unit)||'Nos'}"></div>
      <div><label>Category</label><input id="pi-cat-${i.id}" value="${esc(i.category)||''}"></div>
      <div><label>HSN Code</label><input id="pi-hsn-${i.id}" value="${esc(i.hsn_code)||''}"></div>
      <div><label>Rack / Location</label><input id="pi-loc-${i.id}" value="${esc(i.location)||''}"></div>
      <div><label>Reorder Level</label><input id="pi-reorder-${i.id}" type="number" value="${i.reorder_level||0}"></div>
      <div style="display:flex;align-items:flex-end;"><button class="btn green" onclick="approvePendingItem(${i.id})">Approve into Master</button></div>
    </div>`).join('');
}
window.approvePendingItem = async (id) => {
  try {
    await api('/masters/items/' + id + '/review', { method: 'PUT', body: JSON.stringify({
      item_code: val('pi-code-' + id), name: val('pi-name-' + id), unit: val('pi-unit-' + id), category: val('pi-cat-' + id),
      hsn_code: val('pi-hsn-' + id), location: val('pi-loc-' + id), reorder_level: val('pi-reorder-' + id), approve: true
    })});
    navigate('store');
  } catch (e) { alert(e.message); }
};
window.addItem = async () => {
  try {
    await api('/masters/items', { method: 'POST', body: JSON.stringify({
      item_code: val('it-code'), name: val('it-name'), unit: val('it-unit'), category: val('it-cat'),
      hsn_code: val('it-hsn'), location: val('it-loc'), reorder_level: val('it-reorder')
    })});
    navigate('store');
  } catch (e) { alert(e.message); }
};
window.downloadItemTemplate = () => downloadTemplateFile('/masters/items/template', 'item_master_upload_template.xlsx');
window.uploadItemTemplate = () => uploadTemplateFile('/masters/items/bulk-upload', 'it-upload-file', 'it-upload-result', () => navigate('store'));

// ---- Sheet 2: Stock In / Out ----
async function renderStockInOutSheet(el) {
  const items = (await api('/masters/items')).filter(i => !['Pending', 'Discontinued'].includes(i.status));
  const movements = await api('/purchase/store/movements');
  const openPOs = (await api('/purchase/orders')).filter(o => ['Open', 'PartiallyReceived'].includes(o.status));
  const projects = await api('/projects');
  window.__OPEN_POS = openPOs;
  window.__STOCK_ITEMS = items;
  el.innerHTML = `
    <div class="panel"><h3>Scan Barcode</h3>
      <p class="muted">Click into the box and scan with a USB/Bluetooth barcode scanner (or type the code and press Enter) - it will select the matching item below.</p>
      <input id="st-scan" placeholder="Scan or type barcode, then press Enter" style="font-size:16px;padding:10px;width:320px;" autocomplete="off">
      <div id="st-scan-result" style="margin-top:8px;"></div>
    </div>
    <div class="panel"><h3>Stock In / Out</h3>
      ${!items.length ? `<div class="msg err">No items in the Item Master yet - add one under <a href="#" onclick="navigate('store');return false;">Item Master</a> before recording a stock movement.</div>` : ''}
      <div class="form-grid">
        <div><label>Receive against PO (optional)</label>
          <select id="st-po" onchange="fillStockFromPO()" ${!openPOs.length ? 'disabled' : ''}>
            <option value="">- Not against a PO -</option>
            ${openPOs.map(o => `<option value="${o.id}">${esc(o.po_no)} - ${esc(o.vendor_name)} - ${esc(o.item_name)||'-'} (ordered: ${o.quantity}, received: ${o.received_qty}${o.received_qty > 0 ? ', remaining: ' + (o.quantity - o.received_qty) : ''})</option>`).join('')}
          </select>
          ${!openPOs.length ? `<div class="muted" style="margin-top:4px;">No Purchase Orders are currently Open - once one is created and not yet fully received, it will show up here.</div>` : ''}
        </div>
        <div><label>Issue to Project (for OUT only, optional)</label>
          <select id="st-project">
            <option value="">- Not tied to a project -</option>
            ${projects.map(p => `<option value="${p.id}">${esc(p.project_code)} - ${esc(p.title)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Item</label>
          <input id="st-item-search" placeholder="Type to search by name or code..." autocomplete="off" oninput="filterStockItemOptions()" ${!items.length ? 'disabled' : ''} style="margin-bottom:4px;">
          <select id="st-item" ${!items.length ? 'disabled' : ''} size="6" style="width:100%;">${items.length ? items.map(i => `<option value="${i.id}" data-barcode="${esc(i.barcode)||''}" data-search="${esc(((i.name||'')+' '+(i.item_code||'')).toLowerCase())}">${esc(i.name)}${i.item_code ? ' (' + esc(i.item_code) + ')' : ''} - stock: ${i.current_stock}</option>`).join('') : '<option value="">- No items -</option>'}</select>
        </div>
        <div><label>Quantity</label><input id="st-qty" type="number"></div>
      </div>
      <button class="btn green" onclick="storeMove('receive')" ${!items.length ? 'disabled' : ''}>Receive (IN)</button>
      <button class="btn red" onclick="storeMove('issue')" ${!items.length ? 'disabled' : ''}>Issue to Production (OUT)</button>
    </div>
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per movement (item code or barcode, IN/OUT, quantity), then upload it.</p>
      <button class="btn outline" type="button" onclick="downloadStockTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('st-upload-file')}
      <button class="btn" onclick="uploadStockTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="st-upload-result" style="margin-top:10px;"></div>
    </div>
    ${collapsiblePanel('recent-movements', 'Recent Movements', `
      ${tableHTML(['Item', 'Type', 'Qty', 'Reference', 'Date'], movements.slice(0, 30), m => `
        <tr><td>${esc(m.item_name)}</td><td>${badge(m.movement_type === 'IN' ? 'Approved' : 'Pending')}${m.movement_type}</td><td>${m.quantity}</td><td>${esc(m.reference)||''}</td><td>${new Date(m.moved_at).toLocaleString()}</td></tr>`)}
    `)}`;
  const scanEl = document.getElementById('st-scan');
  scanEl.addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter') return;
    const code = scanEl.value.trim();
    scanEl.value = '';
    if (!code) return;
    const resEl = document.getElementById('st-scan-result');
    try {
      const item = await api('/masters/items/by-barcode/' + encodeURIComponent(code));
      const sel = document.getElementById('st-item');
      sel.value = item.id;
      resEl.innerHTML = `<div class="msg ok">Matched: <b>${esc(item.name)}</b> (stock: ${item.current_stock})</div>`;
    } catch (e) { resEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
  scanEl.focus();
}
window.fillStockFromPO = () => {
  const poId = Number(val('st-po'));
  if (!poId) return;
  const po = (window.__OPEN_POS || []).find(o => o.id === poId);
  if (!po) return;
  if (po.item_id) { const itemSel = document.getElementById('st-item'); if (itemSel) itemSel.value = po.item_id; }
  const qtyEl = document.getElementById('st-qty');
  // Pre-fill the REMAINING quantity, not the full ordered amount - a PO
  // already partially received (received_qty > 0) would otherwise default
  // to over-receiving it by that much every time.
  if (qtyEl) qtyEl.value = Math.max(0, po.quantity - (po.received_qty || 0));
};
window.filterStockItemOptions = () => {
  const q = (val('st-item-search') || '').toLowerCase().trim();
  const sel = document.getElementById('st-item');
  if (!sel) return;
  let firstVisible = null;
  Array.from(sel.options).forEach(opt => {
    const matches = !q || (opt.getAttribute('data-search') || '').includes(q);
    opt.hidden = !matches;
    if (matches && !firstVisible) firstVisible = opt;
  });
  // Keep the current selection if it's still visible; otherwise jump to the
  // first match so Quantity/Receive act on something the user can actually see.
  if (sel.selectedOptions.length && sel.selectedOptions[0].hidden && firstVisible) {
    sel.value = firstVisible.value;
  }
};
window.storeMove = async (type) => {
  try {
    const body = { item_id: val('st-item'), quantity: val('st-qty') };
    if (type === 'receive') {
      const poId = val('st-po');
      if (poId) body.po_id = poId;
    } else if (type === 'issue') {
      const projectId = val('st-project');
      if (projectId) body.project_id = projectId;
    }
    await api('/purchase/store/' + type, { method: 'POST', body: JSON.stringify(body) });
    navigate('stock-in-out');
  } catch (e) { alert(e.message); }
};
window.downloadStockTemplate = () => downloadTemplateFile('/purchase/store/movements/template', 'stock_in_out_upload_template.xlsx');
window.uploadStockTemplate = () => uploadTemplateFile('/purchase/store/movements/bulk-upload', 'st-upload-file', 'st-upload-result', () => navigate('stock-in-out'));

// ---- Sheet 3: Challans ----
async function renderChallanSheet(el) {
  el.innerHTML = `
    <div class="panel"><h3>Challans (Material Movement Between Locations)</h3>
      <p class="muted">Delivery challan for moving material between the company's own locations (factory to factory, or factory to site) - not a sale. Add line items, save, then Print or Download PDF for the vehicle.</p>
      <div id="challan-form"></div>
    </div>
    <div id="challan-list"></div>`;
  renderChallanForm();
  renderChallanList();
}

// ---- Challans ----
let CHALLAN_ITEMS = [{ description: '', hsn_code: '', quantity: 1, unit: 'Nos', rate: 0 }];
function renderChallanForm() {
  const formEl = document.getElementById('challan-form');
  if (!formEl) return;
  formEl.innerHTML = `
    <div class="form-grid">
      <div><label>Challan Date</label><input id="ch-date" type="date" value="${today()}"></div>
      <div><label>From Location</label><input id="ch-from" placeholder="e.g. Faridabad Factory"></div>
      <div><label>To Location</label><input id="ch-to" placeholder="e.g. Site / Other Unit"></div>
      <div><label>Vehicle Number</label><input id="ch-vehicle" placeholder="e.g. HR38 AB 1234"></div>
      <div><label>Transport Mode</label><select id="ch-mode"><option>Road</option><option>Rail</option><option>Air</option><option>Ship</option></select></div>
      <div><label>Transporter Name</label><input id="ch-transporter"></div>
      <div><label>Distance (km)</label><input id="ch-distance" type="number"></div>
      <div><label>E-Way Bill No.</label><input id="ch-eway"></div>
      <div><label>PO / Reference No.</label><input id="ch-po"></div>
      <div><label>Consignor GSTIN</label><input id="ch-cgstin" placeholder="Sender GSTIN"></div>
      <div><label>Consignee Name</label><input id="ch-consignee"></div>
      <div><label>Consignee GSTIN</label><input id="ch-econgstin"></div>
      <div><label>Reason for Transport</label><input id="ch-reason" value="Stock Transfer (Own Use - Not For Sale)"></div>
    </div>
    <h4 style="margin:14px 0 8px;">Material Being Transported</h4>
    <div id="ch-items"></div>
    <button class="btn small outline" type="button" onclick="addChallanItemRow()">+ Add Line Item</button>
    <div style="margin-top:12px;"><button class="btn" onclick="saveChallan()">Save Challan</button></div>
  `;
  renderChallanItemRows();
}
function renderChallanItemRows() {
  const el = document.getElementById('ch-items');
  if (!el) return;
  el.innerHTML = tableHTML(['Description', 'HSN Code', 'Qty', 'Unit', 'Rate (₹)', 'Value (₹)', ''], CHALLAN_ITEMS, (it, i) => `
    <tr>
      <td><input value="${esc(it.description)}" onchange="CHALLAN_ITEMS[${i}].description=this.value"></td>
      <td><input value="${esc(it.hsn_code)}" onchange="CHALLAN_ITEMS[${i}].hsn_code=this.value" style="width:80px;"></td>
      <td><input type="number" value="${it.quantity}" onchange="CHALLAN_ITEMS[${i}].quantity=Number(this.value);renderChallanItemRows()" style="width:70px;"></td>
      <td><input value="${esc(it.unit)}" onchange="CHALLAN_ITEMS[${i}].unit=this.value" style="width:60px;"></td>
      <td><input type="number" value="${it.rate}" onchange="CHALLAN_ITEMS[${i}].rate=Number(this.value);renderChallanItemRows()" style="width:80px;"></td>
      <td>₹${fmt((Number(it.quantity)||0) * (Number(it.rate)||0))}</td>
      <td><button class="btn small outline" type="button" onclick="CHALLAN_ITEMS.splice(${i},1);renderChallanItemRows()">✕</button></td>
    </tr>`).replace('</tbody></table>', `</tbody><tfoot><tr><td colspan="5" style="text-align:right;"><b>Total</b></td><td colspan="2"><b>₹${fmt(CHALLAN_ITEMS.reduce((s,it)=>s+(Number(it.quantity)||0)*(Number(it.rate)||0),0))}</b></td></tr></tfoot></table>`);
}
window.addChallanItemRow = () => { CHALLAN_ITEMS.push({ description: '', hsn_code: '', quantity: 1, unit: 'Nos', rate: 0 }); renderChallanItemRows(); };
window.saveChallan = async () => {
  try {
    await api('/purchase/store/challans', { method: 'POST', body: JSON.stringify({
      from_location: val('ch-from'), to_location: val('ch-to'), vehicle_no: val('ch-vehicle'), transport_mode: val('ch-mode'),
      transporter_name: val('ch-transporter'), distance_km: val('ch-distance') || null, consignor_gstin: val('ch-cgstin'),
      consignee_name: val('ch-consignee'), consignee_gstin: val('ch-econgstin'), reason: val('ch-reason'),
      eway_bill_no: val('ch-eway'), po_no: val('ch-po'), items: CHALLAN_ITEMS.filter(it => it.description),
    })});
    CHALLAN_ITEMS = [{ description: '', hsn_code: '', quantity: 1, unit: 'Nos', rate: 0 }];
    navigate('challans');
  } catch (e) { alert(e.message); }
};
async function renderChallanList() {
  const listEl = document.getElementById('challan-list');
  if (!listEl) return;
  const challans = await api('/purchase/store/challans');
  const renderRows = (rows) => tableHTML(['Challan No', 'Date', 'From', 'To', 'Vehicle', 'Items', 'Value', ''], rows, c => `
      <tr><td>${esc(c.challan_no)}</td><td>${new Date(c.challan_date).toLocaleDateString()}</td><td>${esc(c.from_location)}</td><td>${esc(c.to_location)}</td><td>${esc(c.vehicle_no)||'-'}</td><td>${c.item_count}</td><td>₹${fmt(c.total_value)}</td>
      <td><button class="btn small outline" onclick="printChallan(${c.id})">Print</button> <button class="btn small outline" onclick="downloadChallanPdf(${c.id}, '${esc(c.challan_no)}')">Download PDF</button></td></tr>`);
  listEl.innerHTML = collapsiblePanel('challans-list', `<span id="ch-list-count">Saved Challans (${challans.length})</span>`, `
    ${renderListSearch('challans', challans, ['challan_no', 'vehicle_no', 'from_location', 'to_location'], (rows) => {
      document.getElementById('ch-list-table').innerHTML = renderRows(rows);
      document.getElementById('ch-list-count').textContent = 'Saved Challans (' + rows.length + ')';
    }, 'Search by challan no, vehicle, from/to location...')}
    <div id="ch-list-table">${renderRows(challans)}</div>
  `);
}
window.downloadChallanPdf = async (id, challanNo) => {
  try {
    const res = await fetch('/api/purchase/store/challans/' + id + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = match ? match[1] : (challanNo || 'challan') + '.pdf'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
};
window.printChallan = async (id) => {
  const { challan: c, items } = await api('/purchase/store/challans/' + id);
  const w = window.open('', '_blank');
  w.document.write(`
    <html><head><title>Delivery Challan ${esc(c.challan_no)}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:30px;color:#111;}
      h1{font-size:18px;margin:0 0 2px;} .sub{color:#555;font-size:12px;margin-bottom:16px;}
      table{width:100%;border-collapse:collapse;margin-top:14px;} th,td{border:1px solid #999;padding:6px 8px;font-size:12px;text-align:left;}
      .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:13px;margin-top:10px;}
      .meta div span{color:#555;}
      .foot{margin-top:40px;display:flex;justify-content:space-between;font-size:12px;}
    </style></head><body>
    <h1>Venkateshwara Engineers</h1>
    <div class="sub">Faridabad, Haryana &mdash; DELIVERY CHALLAN (Not a Tax Invoice / Not For Sale)</div>
    <div class="meta">
      <div><span>Challan No:</span> <b>${esc(c.challan_no)}</b></div>
      <div><span>Date:</span> <b>${new Date(c.challan_date).toLocaleDateString()}</b></div>
      <div><span>From Location:</span> <b>${esc(c.from_location)}</b></div>
      <div><span>To Location:</span> <b>${esc(c.to_location)}</b></div>
      <div><span>Vehicle No:</span> <b>${esc(c.vehicle_no)||'-'}</b></div>
      <div><span>Transport Mode:</span> <b>${esc(c.transport_mode)}</b></div>
      <div><span>Transporter:</span> <b>${esc(c.transporter_name)||'-'}</b></div>
      <div><span>Distance (km):</span> <b>${esc(c.distance_km)||'-'}</b></div>
      <div><span>Consignor:</span> <b>${esc(c.consignor_name)}</b> (${esc(c.consignor_gstin)||'GSTIN N/A'})</div>
      <div><span>Consignee:</span> <b>${esc(c.consignee_name)||'-'}</b> (${esc(c.consignee_gstin)||'GSTIN N/A'})</div>
      <div><span>E-Way Bill No:</span> <b>${esc(c.eway_bill_no)||'-'}</b></div>
      <div><span>PO/Reference:</span> <b>${esc(c.po_no)||'-'}</b></div>
      <div style="grid-column:1/-1;"><span>Reason for Transport:</span> <b>${esc(c.reason)}</b></div>
    </div>
    <table><thead><tr><th>#</th><th>Description</th><th>HSN Code</th><th>Qty</th><th>Unit</th><th>Rate (₹)</th><th>Value (₹)</th></tr></thead>
    <tbody>${items.map((it,i) => `<tr><td>${i+1}</td><td>${esc(it.description)}</td><td>${esc(it.hsn_code)||'-'}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${fmt(it.rate)}</td><td>${fmt(it.value)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="6" style="text-align:right;"><b>Total Value</b></td><td><b>₹${fmt(c.total_value)}</b></td></tr></tfoot></table>
    <div class="foot"><div>Receiver's Signature</div><div>For Venkateshwara Engineers<br><br><br>Authorized Signatory</div></div>
    <script>window.onload = () => window.print();</script>
    </body></html>`);
  w.document.close();
};

// ---- Service Request Management ----
// Step 1: anyone in Service logs a request (customer/issue only - no
// schedule yet) and it lands in the Service Request Queue below. Step 2:
// only the Service HOD/Supervisor (or Admin) opens a queued request and
// schedules it - assigns a service employee (from Employees) and a date.
PAGES.service = async (el) => {
  const [reqs, clients] = await Promise.all([api('/service'), api('/masters/clients')]);
  el.innerHTML = `
    <div class="panel"><h3>Log Service Request</h3>
      <div class="form-grid">
        <div><label>Customer (from Clients)</label><select id="sr-client" onchange="document.getElementById('sr-manual-wrap').style.display = this.value ? 'none' : 'grid'">
          <option value="">-- Enter customer manually instead --</option>
          ${clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select></div>
        <div><label>Customer Contact Person</label><input id="sr-contact-person"></div>
        <div><label>Customer Contact Number</label><input id="sr-contact-phone"></div>
      </div>
      <div class="form-grid" id="sr-manual-wrap">
        <div><label>Customer Name (manual)</label><input id="sr-cust-name"></div>
      </div>
      <div class="form-grid">
        <div style="grid-column:1/-1;"><label>Issue Description</label><textarea id="sr-desc" rows="2"></textarea></div>
        <div><label>Spare Parts Needed</label><input id="sr-parts"></div>
      </div>
      <button class="btn" onclick="addSR()">Log Request</button>
    </div>
    ${collapsiblePanel('service-request-queue', `Service Request Queue (${reqs.length})`, `
      <p class="muted">Newly logged requests appear here first. The Service HOD/Supervisor opens one and schedules it (assigns an employee + date) - only then does it move to In Progress.</p>
      ${tableHTML(['SR No', 'Customer', 'Contact', 'Scheduled', 'Assigned', 'Issue', 'Status', 'Prev. Report', 'Action'], reqs, r => `
        <tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name || r.customer_name)}</td>
        <td>${esc(r.contact_person)||'-'}${r.contact_phone ? ' / ' + esc(r.contact_phone) : ''}</td>
        <td>${r.scheduled_date||'-'}</td><td>${esc(r.employee_name)||'-'}</td>
        <td>${esc(r.issue_description)}</td><td>${badge(r.status)}${r.status==='Pending Items' ? ' <span class="muted" style="font-size:11px;">(back from technician)</span>' : ''}</td>
        <td>${r.report_count ? `<button class="btn small outline" onclick="viewSrReportHistory(${r.id},'${esc(r.sr_no)}')">View (${r.report_count})</button>` : '-'}</td>
        <td>${srActions(r)} <button class="btn small outline" type="button" onclick="viewSrUpdates(${r.id},'${esc(r.sr_no)}')">Updates</button></td></tr>`)}
    `)}
    <div class="panel" id="sr-schedule-panel" style="display:none;"><h3>Schedule Service Request</h3><div id="sr-schedule-body"></div></div>
    <div class="panel" id="sr-history-panel" style="display:none;"><h3 id="sr-history-title">Previous Technician Report(s)</h3><div id="sr-history-body"></div></div>
    <div class="panel" id="sr-updates-panel" style="display:none;"><h3 id="sr-updates-title">Activity Log</h3><div id="sr-updates-body"></div></div>`;
};
function srActions(r) {
  const parts = [];
  if (r.can_schedule) parts.push(`<button class="btn small outline" onclick="openScheduleSR(${r.id})">${r.scheduled_date ? 'Reschedule' : 'Open & Schedule'}</button>`);
  if (r.status !== 'Closed') {
    parts.push(`<select onchange="updateSR(${r.id}, this.value)"><option value="">Update status...</option>${['Open','Scheduled','InProgress','PartsOrdered','Resolved','Closed'].filter(s=>s!==r.status).map(s=>`<option value="${s}">${s}</option>`).join('')}</select>`);
  }
  if (r.status === 'Closed' && r.can_reopen) {
    parts.push(`<button class="btn small outline" onclick="reopenSR(${r.id})">Reopen SR (15-day)</button>`);
  } else if (r.status === 'Closed') {
    parts.push(`<span class="muted" style="font-size:11px;">Reopen window expired</span>`);
  }
  return parts.join(' ') || '-';
}
window.viewSrReportHistory = async (srId, srNo) => {
  const panel = document.getElementById('sr-history-panel');
  const body = document.getElementById('sr-history-body');
  document.getElementById('sr-history-title').textContent = `Previous Technician Report(s) - ${srNo}`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
  body.innerHTML = '<p class="muted">Loading...</p>';
  const reports = await api(`/service/${srId}/reports`);
  if (!reports.length) { body.innerHTML = '<p class="muted">No reports submitted yet.</p>'; return; }
  body.innerHTML = reports.map(r => `
    <div class="box" style="border:1px solid var(--border,#ccc);border-radius:6px;padding:10px;margin-bottom:10px;">
      <p><b>${esc(r.employee_name)||'-'}</b> &middot; ${badge(r.status)} &middot; <span class="muted">${r.updated_at||r.created_at}</span></p>
      <p><b>Faults Found:</b> ${esc(r.faults_found)||'-'}</p>
      <p><b>Action Taken:</b> ${esc(r.action_taken)||'-'}</p>
      <p><b>Completion Remarks / Pending Reasons:</b> ${esc(r.completion_remarks)||'-'}</p>
      ${r.pending_items ? `<p><b>Pending Items Comments:</b> ${esc(r.pending_items_comments)||'-'}</p>` : ''}
    </div>`).join('');
};
window.reopenSR = async (id) => {
  const reason = prompt('Reason for reopening this SR (15-day free-of-charge service policy):');
  if (reason === null) return;
  try {
    await api(`/service/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) });
    navigate('service');
  } catch (e) { alert(e.message); }
};
window.viewSrUpdates = async (srId, srNo) => {
  window.__SR_UPDATES_ID = srId;
  const panel = document.getElementById('sr-updates-panel');
  document.getElementById('sr-updates-title').textContent = `Activity Log - ${srNo}`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
  await renderSrUpdates(srId);
};
async function renderSrUpdates(srId) {
  const body = document.getElementById('sr-updates-body');
  const updates = await api(`/service/${srId}/updates`);
  body.innerHTML = `
    ${updates.length ? updates.map(u => `
      <div class="box" style="border:1px solid var(--border,#ccc);border-radius:6px;padding:10px;margin-bottom:8px;">
        <p style="margin:0 0 4px;"><b>${esc(u.user_name)||'-'}</b> &middot; <span class="muted">${new Date(u.created_at).toLocaleString()}</span></p>
        ${u.status_change ? `<p style="margin:0 0 4px;"><b>Status:</b> ${esc(u.status_change)}</p>` : ''}
        ${u.action_taken ? `<p style="margin:0 0 4px;"><b>Action Taken:</b> ${esc(u.action_taken)}</p>` : ''}
        ${u.note ? `<p style="margin:0;">${esc(u.note)}</p>` : ''}
      </div>`).join('') : '<div class="empty">No updates logged yet.</div>'}
    <div class="form-grid" style="margin-top:10px;">
      <div><label>Action Taken (optional)</label><input id="sr-upd-action"></div>
      <div><label>Status Change (optional)</label><input id="sr-upd-status" placeholder="e.g. Waiting on part"></div>
    </div>
    <label>Note</label>
    <textarea id="sr-upd-note" rows="2" style="width:100%;"></textarea>
    <button class="btn small" style="margin-top:8px;" onclick="addSrUpdate(${srId})">Log Update</button>
    <div id="sr-upd-err" class="msg err" style="display:none;margin-top:6px;"></div>`;
}
window.addSrUpdate = async (srId) => {
  const errEl = document.getElementById('sr-upd-err');
  errEl.style.display = 'none';
  try {
    await api(`/service/${srId}/updates`, { method: 'POST', body: JSON.stringify({
      note: val('sr-upd-note'), status_change: val('sr-upd-status'), action_taken: val('sr-upd-action'),
    })});
    await renderSrUpdates(srId);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.addSR = async () => {
  try {
    await api('/service', { method: 'POST', body: JSON.stringify({
      client_id: val('sr-client') || null, customer_name: val('sr-cust-name'), contact_person: val('sr-contact-person'),
      contact_phone: val('sr-contact-phone'), issue_description: val('sr-desc'), spare_parts_needed: val('sr-parts'),
    })});
    navigate('service');
  } catch (e) { alert(e.message); }
};
window.updateSR = async (id, status) => {
  if (!status) return;
  await api(`/service/${id}`, { method: 'PATCH', body: JSON.stringify({ status })});
  navigate('service');
};
window.openScheduleSR = async (id) => {
  const employees = await api('/hr/employees');
  const panel = document.getElementById('sr-schedule-panel');
  const body = document.getElementById('sr-schedule-body');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
  body.innerHTML = `
    <div class="form-grid">
      <div><label>Assign Service Employee</label><select id="sr-sch-emp">${employees.map(e => `<option value="${e.id}">${esc(e.full_name)} (${esc(e.department_name)})</option>`).join('')}</select></div>
      <div><label>Scheduled Date</label><input id="sr-sch-date" type="date" value="${today()}"></div>
    </div>
    <button class="btn" onclick="saveScheduleSR(${id})">Save Schedule</button>
    <div id="sr-sch-err" class="msg err" style="display:none;margin-top:10px;"></div>`;
};
window.saveScheduleSR = async (id) => {
  const errEl = document.getElementById('sr-sch-err');
  try {
    await api(`/service/${id}/schedule`, { method: 'PATCH', body: JSON.stringify({ employee_id: val('sr-sch-emp'), scheduled_date: val('sr-sch-date') }) });
    navigate('service');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- My Service Requests (employee's own queue) + Service Report form ----
PAGES['service-mine'] = async (el) => {
  const reqs = await api('/service/mine');
  el.innerHTML = `<div class="panel"><h3>My Service Requests (${reqs.length})</h3>
    ${tableHTML(['SR No', 'Customer', 'Scheduled', 'Issue', 'Status', 'Job Status', 'Report', 'Actions'], reqs, r => `
      <tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name || r.customer_name)}</td><td>${r.scheduled_date||'-'}</td>
      <td>${esc(r.issue_description)}</td><td>${badge(r.status)}</td><td>${badge(r.job_status||'Assigned')}</td>
      <td>${r.report_status ? badge(r.report_status) : '-'}</td>
      <td>${svcMineActions(r)}</td></tr>`)}
  </div>
  <div class="panel" id="svc-report-panel" style="display:none;"><h3>Service Report</h3><div id="svc-report-body"></div></div>`;
};
function svcMineActions(r) {
  const parts = [];
  const js = r.job_status || 'Assigned';
  if (r.status === 'Closed') return '<span class="muted">Closed</span>';
  if (js === 'Assigned' || js === 'OnHold') {
    parts.push(`<button class="btn small outline" onclick="svcJobAction(${r.id},'${js==='OnHold'?'restart':'start'}')">${js==='OnHold'?'Restart':'Start Work'}</button>`);
  }
  if (js === 'InProgress') {
    parts.push(`<button class="btn small outline" onclick="svcJobAction(${r.id},'hold')">Hold</button>`);
  }
  const reportEditable = !r.report_status || r.report_status === 'Draft' || r.report_status === 'Submitted';
  parts.push(`<button class="btn small outline" onclick="openServiceReport(${r.id})">${!r.report_status ? 'Fill Report' : (reportEditable ? 'Re-edit Report' : 'Open Report')}</button>`);
  return parts.join(' ');
}
window.svcJobAction = (srId, action) => {
  const finish = (lat, lng) => {
    api(`/service/${srId}/job-status`, { method: 'PATCH', body: JSON.stringify({ action, lat, lng }) })
      .then(() => navigate('service-mine'))
      .catch(e => alert(e.message));
  };
  // Best-effort geolocation - never blocks the workflow on denial/unavailability.
  if (action === 'start' && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => finish(pos.coords.latitude, pos.coords.longitude),
      () => finish(null, null),
      { timeout: 8000 }
    );
  } else {
    finish(null, null);
  }
};
let SVC_SPARES = [];
window.openServiceReport = async (srId) => {
  const panel = document.getElementById('svc-report-panel');
  const body = document.getElementById('svc-report-body');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
  const [report, centers, items, srList] = await Promise.all([
    api(`/service/${srId}/report`), api('/service-centers'), api('/masters/items'), api('/service/mine'),
  ]);
  const sr = srList.find(r => r.id === srId) || {};
  window.__SVC_CENTERS = centers.filter(c => c.status === 'Active');
  window.__SVC_ITEMS = items.filter(i => !['Pending', 'Discontinued'].includes(i.status));
  SVC_SPARES = report && report.spares && report.spares.length
    ? report.spares.map(s => ({ item_id: s.item_id, quantity: s.quantity, unit_rate: s.unit_rate }))
    : [];
  const editable = !report || report.status === 'Draft' || report.status === 'Submitted';
  const machineTypes = ['Simple Bagging Machine', 'Duplex Bagging Machine', 'Stitching Machine', 'Conveyor / Loader', 'Hyd. Loader / Stacker', 'Others'];
  const visitTypes = ['Installation/Commissioning', 'Warranty', 'AMC', 'Emergency', 'Additional'];
  const g = (field, fallback) => (report && report[field] != null && report[field] !== '') ? report[field] : (fallback != null ? fallback : '');
  const v = (field, fallback) => esc(g(field, fallback));
  const dis = editable ? '' : 'disabled';
  const sigPath = report ? report.customer_signature_path : null;
  body.innerHTML = `
    <h4 style="margin-top:0;">Visit / Customer Details</h4>
    <div class="form-grid">
      <div><label>SL. No</label><input value="${report&&report.sl_no?esc(report.sl_no):'(auto-generated on save)'}" disabled></div>
      <div><label>Customer Name</label><input id="svc-cust-name" value="${v('customer_name', esc(sr.client_master_name || sr.customer_name || ''))}" ${dis}></div>
      <div style="grid-column:1/-1;"><label>Customer Address</label><input id="svc-cust-address" value="${v('customer_address')}" ${dis}></div>
      <div><label>Contact Person</label><input id="svc-contact-person" value="${v('contact_person', esc(sr.contact_person || ''))}" ${dis}></div>
      <div><label>Contact No</label><input id="svc-contact-no" value="${v('contact_no', esc(sr.contact_phone || ''))}" ${dis}></div>
      <div><label>Engineer Name</label><input id="svc-engineer-name" value="${v('engineer_name', esc(ME.full_name || ''))}" ${dis}></div>
      <div><label>Visit From</label><input id="svc-visit-from" type="date" value="${v('visit_from', sr.scheduled_date || '')}" ${dis}></div>
      <div><label>Visit To</label><input id="svc-visit-to" type="date" value="${v('visit_to', sr.scheduled_date || '')}" ${dis}></div>
      <div><label>No. of Days at Site</label><input id="svc-days" type="number" step="0.5" value="${v('days_at_site', 1)}" ${dis}></div>
    </div>
    <h4>Activity</h4>
    <div class="form-grid">
      <div><label>Activity Date</label><input id="svc-act-date" type="date" value="${v('activity_date', sr.scheduled_date || '')}" ${dis}></div>
      <div><label>Activity Start Time</label><input id="svc-act-start" type="time" value="${v('activity_start_time')}" ${dis}></div>
      <div><label>Activity End Time</label><input id="svc-act-end" type="time" value="${v('activity_end_time')}" ${dis}></div>
    </div>
    <h4>Machine Details</h4>
    <div class="form-grid">
      <div><label>Machine Type</label><select id="svc-machine-type" ${dis}>
        ${machineTypes.map(t => `<option value="${t}" ${g('machine_type')===t?'selected':''}>${t}</option>`).join('')}
      </select></div>
      <div><label>Capacity</label><input id="svc-machine-capacity" placeholder="e.g. 5 Kg" value="${v('machine_capacity')}" ${dis}></div>
      <div><label>Type of Visit</label><select id="svc-type-visit" ${dis}>
        ${visitTypes.map(t => `<option value="${t}" ${g('type_of_visit')===t?'selected':''}>${t}</option>`).join('')}
      </select></div>
    </div>
    <div class="form-grid">
      <div style="grid-column:1/-1;"><label>Reason for the Visit</label><textarea id="svc-reason" rows="2" ${dis}>${v('reason_for_visit')}</textarea></div>
      <div style="grid-column:1/-1;"><label>Faults Found During Visit</label><textarea id="svc-faults" rows="2" ${dis}>${v('faults_found')}</textarea></div>
      <div style="grid-column:1/-1;"><label>Action Taken</label><textarea id="svc-action-taken" rows="2" ${dis}>${v('action_taken')}</textarea></div>
      <div style="grid-column:1/-1;"><label>Completion Remarks / Pending Reasons</label><textarea id="svc-completion-remarks" rows="2" ${dis}>${v('completion_remarks')}</textarea></div>
    </div>
    <h4>Follow-up</h4>
    <div class="form-grid">
      <div><label><input type="checkbox" id="svc-pending" ${report&&report.pending_items?'checked':''} ${dis} onchange="document.getElementById('svc-pending-wrap').style.display=this.checked?'':'none'"> Pending Items?</label></div>
      <div id="svc-pending-wrap" style="grid-column:1/-1;display:${report&&report.pending_items?'':'none'};"><label>Pending Items Comments</label><textarea id="svc-pending-comments" rows="1" ${dis}>${report?esc(report.pending_items_comments)||'':''}</textarea></div>
    </div>
    <h4>Charges</h4>
    <div class="form-grid">
      <div><label>Service Charge (₹)</label><input id="svc-amt-service" type="number" value="${report?report.amount_service||0:0}" ${dis}></div>
      <div><label>Up/Down &amp; Food (₹)</label><input id="svc-amt-updown" type="number" value="${v('amount_updown_food', 0)}" ${dis}></div>
      <div><label>Amount Claimed - Travel (₹)</label><input id="svc-amt-travel" type="number" value="${report?report.amount_travel||0:0}" ${dis}></div>
      <div><label>Amount Claimed - Spares (₹)</label><input id="svc-amt-spares" type="number" value="${report?report.amount_spares||0:0}" ${dis}></div>
      <div><label>Hand Written Report (image/PDF)</label><input id="svc-file" type="file" accept="image/*,.pdf" ${dis}></div>
    </div>
    ${report && report.handwritten_report_path ? `<p><a href="${report.handwritten_report_path}" target="_blank">View uploaded hand-written report</a></p>` : ''}
    <h4>Customer Feedback &amp; Sign-off</h4>
    <div class="form-grid">
      <div><label>Machine Working Satisfactorily?</label><select id="svc-machine-ok" ${dis}>
        <option value="">- Select -</option>
        <option value="Yes" ${g('machine_working_satisfactorily')==='Yes'?'selected':''}>Yes</option>
        <option value="No" ${g('machine_working_satisfactorily')==='No'?'selected':''}>No</option>
      </select></div>
      <div><label>Rate This Visit</label><select id="svc-rating" ${dis}>
        <option value="">- Select -</option>
        ${['Excellent','Good','Average'].map(r => `<option value="${r}" ${g('visit_rating')===r?'selected':''}>${r}</option>`).join('')}
      </select></div>
      <div><label>Overall Feedback</label><select id="svc-feedback" ${dis}>
        <option value="">- Select -</option>
        ${['Satisfactory','Non Satisfactory'].map(f => `<option value="${f}" ${g('overall_feedback')===f?'selected':''}>${f}</option>`).join('')}
      </select></div>
      <div style="grid-column:1/-1;"><label>Customer Remarks</label><textarea id="svc-cust-remarks" rows="1" ${dis}>${v('customer_remarks')}</textarea></div>
      <div><label>Customer Rep Mobile Number</label><input id="svc-cust-mobile" value="${v('customer_signatory_mobile')}" ${dis}></div>
      <div style="grid-column:1/-1;"><label>Engineer Remarks</label><textarea id="svc-eng-remarks" rows="1" ${dis}>${v('engineer_remarks')}</textarea></div>
      <div><label>Engineer Mobile Number</label><input id="svc-eng-mobile" value="${v('engineer_signatory_mobile')}" ${dis}></div>
    </div>
    <label>Customer Signature</label>
    <div>
      ${editable
        ? `<canvas id="svc-sig-canvas" width="600" height="160" style="border:1px solid var(--border,#ccc);width:100%;max-width:600px;height:160px;touch-action:none;background:#fff;border-radius:6px;"></canvas>
           <div style="margin-top:6px;"><button class="btn small outline" type="button" onclick="clearSvcSignature()">Clear Signature</button>
           <span class="muted" style="margin-left:8px;">Have the customer sign with a finger or stylus above.</span></div>`
        : (sigPath ? `<img src="${sigPath}" alt="Customer signature" style="max-width:400px;border:1px solid var(--border,#ccc);border-radius:6px;background:#fff;">`
                    : `<p class="muted">No signature captured.</p>`)}
    </div>
    <h4 style="margin-top:14px;">Spares Used (deducted from that service center's stock)</h4>
    <div class="form-grid">
      <div><label>Service Center</label><select id="svc-spares-center" ${editable?'':'disabled'}>
        <option value="">- Select if spares were used -</option>
        ${window.__SVC_CENTERS.map(c => `<option value="${c.id}" ${report&&report.spares&&report.spares[0]&&report.spares[0].service_center_id===c.id?'selected':''}>${esc(c.name)} (${esc(c.city)||'-'})</option>`).join('')}
      </select></div>
    </div>
    <div id="svc-spares-lines"></div>
    ${editable ? `<button class="btn small outline" type="button" onclick="addSvcSpareLine()">+ Add Spare Line</button>` : ''}
    ${editable ? `
      <button class="btn outline" onclick="saveServiceReport(${srId}, false)">Save Draft</button>
      <button class="btn green" onclick="saveServiceReport(${srId}, true)">Submit</button>
    ` : `<p class="muted">This report is ${esc(report.status)} and can no longer be edited.</p>`}
    ${report ? `<button class="btn outline" onclick="downloadSvcReportPdf(${srId})">Download PDF</button>` : ''}
    <div id="svc-err" class="msg err" style="display:none;margin-top:10px;"></div>`;
  window.__SVC_HAS_EXISTING_SIG = !!sigPath;
  renderSvcSpareLines(editable);
  initSvcSignaturePad(sigPath, editable);
};
window.__SVC_SIG_DIRTY = false;
function initSvcSignaturePad(existingPath, editable) {
  window.__SVC_SIG_DIRTY = false;
  const canvas = document.getElementById('svc-sig-canvas');
  if (!canvas) return; // not editable - a static <img> is shown instead
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (existingPath) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = existingPath;
  }
  if (!editable) return;
  let drawing = false, last = null;
  const pos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches && e.touches[0];
    const cx = (t ? t.clientX : e.clientX) - rect.left;
    const cy = (t ? t.clientY : e.clientY) - rect.top;
    return { x: cx * canvas.width / rect.width, y: cy * canvas.height / rect.height };
  };
  const start = (e) => { drawing = true; last = pos(e); window.__SVC_SIG_DIRTY = true; e.preventDefault(); };
  const move = (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; e.preventDefault();
  };
  const end = () => { drawing = false; };
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);
  canvas.addEventListener('mouseleave', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end, { passive: false });
}
window.clearSvcSignature = () => {
  const canvas = document.getElementById('svc-sig-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  window.__SVC_SIG_DIRTY = false;
};
function renderSvcSpareLines(editable) {
  const el = document.getElementById('svc-spares-lines');
  if (!el) return;
  const items = window.__SVC_ITEMS || [];
  if (!SVC_SPARES.length) { el.innerHTML = '<p class="muted">No spares added yet.</p>'; return; }
  el.innerHTML = tableHTML(['Item', 'Qty', 'Unit Rate (₹)', 'Value (₹)', ''], SVC_SPARES, (l, i) => `
    <tr>
      <td><select ${editable?'':'disabled'} onchange="SVC_SPARES[${i}].item_id=Number(this.value)">
        <option value="">- Select item -</option>
        ${items.map(it => `<option value="${it.id}" ${l.item_id===it.id?'selected':''}>${esc(it.name)}${it.item_code?' ('+esc(it.item_code)+')':''}</option>`).join('')}
      </select></td>
      <td><input type="number" ${editable?'':'disabled'} value="${l.quantity}" onchange="SVC_SPARES[${i}].quantity=Number(this.value);renderSvcSpareLines(${editable})" style="width:80px;"></td>
      <td><input type="number" ${editable?'':'disabled'} value="${l.unit_rate}" onchange="SVC_SPARES[${i}].unit_rate=Number(this.value);renderSvcSpareLines(${editable})" style="width:90px;"></td>
      <td>₹${fmt((Number(l.quantity)||0)*(Number(l.unit_rate)||0))}</td>
      <td>${editable ? `<button class="btn small outline" type="button" onclick="SVC_SPARES.splice(${i},1);renderSvcSpareLines(${editable})">✕</button>` : ''}</td>
    </tr>`);
}
window.addSvcSpareLine = () => { SVC_SPARES.push({ item_id: '', quantity: 1, unit_rate: 0 }); renderSvcSpareLines(true); };
window.downloadSvcReportPdf = async (srId) => {
  try {
    const res = await fetch('/api/service/' + srId + '/report/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = match ? match[1] : 'service-report-' + srId + '.pdf'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
};
const SVC_REQUIRED_FIELDS = [
  ['svc-cust-name','Customer Name'],['svc-cust-address','Customer Address'],['svc-contact-person','Contact Person'],
  ['svc-contact-no','Contact No'],['svc-engineer-name','Engineer Name'],['svc-visit-from','Visit From'],
  ['svc-visit-to','Visit To'],['svc-days','No. of Days at Site'],['svc-act-date','Activity Date'],
  ['svc-act-start','Activity Start Time'],['svc-act-end','Activity End Time'],['svc-machine-type','Machine Type'],
  ['svc-machine-capacity','Capacity'],['svc-type-visit','Type of Visit'],['svc-reason','Reason for the Visit'],
  ['svc-faults','Faults Found'],['svc-action-taken','Action Taken'],['svc-completion-remarks','Completion Remarks'],
  ['svc-machine-ok','Machine Working Satisfactorily'],['svc-rating','Visit Rating'],['svc-feedback','Overall Feedback'],
  ['svc-cust-remarks','Customer Remarks'],['svc-cust-mobile','Customer Rep Mobile'],['svc-eng-remarks','Engineer Remarks'],
  ['svc-eng-mobile','Engineer Mobile'],
];
window.saveServiceReport = async (srId, submit) => {
  const errEl = document.getElementById('svc-err');
  errEl.style.display = 'none';
  if (submit) {
    const missing = SVC_REQUIRED_FIELDS.filter(([id]) => !val(id) || !val(id).trim()).map(([, label]) => label);
    const hasSig = window.__SVC_SIG_DIRTY || window.__SVC_HAS_EXISTING_SIG;
    if (!hasSig) missing.push('Customer Signature');
    if (missing.length) {
      errEl.textContent = 'Please fill all required fields before submitting: ' + missing.join(', ');
      errEl.style.display = 'block';
      errEl.scrollIntoView({ behavior: 'smooth' });
      return;
    }
  }
  const getLocation = () => new Promise((resolve) => {
    if (!submit || !navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { timeout: 8000 }
    );
  });
  const loc = await getLocation();
  try {
    const fd = new FormData();
    if (submit) { fd.append('end_lat', loc.lat != null ? loc.lat : ''); fd.append('end_lng', loc.lng != null ? loc.lng : ''); }
    fd.append('pending_items', document.getElementById('svc-pending').checked ? '1' : '0');
    fd.append('pending_items_comments', val('svc-pending-comments'));
    fd.append('amount_travel', val('svc-amt-travel'));
    fd.append('amount_service', val('svc-amt-service'));
    fd.append('amount_spares', val('svc-amt-spares'));
    fd.append('customer_name', val('svc-cust-name'));
    fd.append('customer_address', val('svc-cust-address'));
    fd.append('contact_person', val('svc-contact-person'));
    fd.append('contact_no', val('svc-contact-no'));
    fd.append('engineer_name', val('svc-engineer-name'));
    fd.append('visit_from', val('svc-visit-from'));
    fd.append('visit_to', val('svc-visit-to'));
    fd.append('days_at_site', val('svc-days'));
    fd.append('activity_date', val('svc-act-date'));
    fd.append('activity_start_time', val('svc-act-start'));
    fd.append('activity_end_time', val('svc-act-end'));
    fd.append('machine_type', val('svc-machine-type'));
    fd.append('machine_capacity', val('svc-machine-capacity'));
    fd.append('type_of_visit', val('svc-type-visit'));
    fd.append('reason_for_visit', val('svc-reason'));
    fd.append('faults_found', val('svc-faults'));
    fd.append('action_taken', val('svc-action-taken'));
    fd.append('completion_remarks', val('svc-completion-remarks'));
    fd.append('amount_updown_food', val('svc-amt-updown'));
    fd.append('machine_working_satisfactorily', val('svc-machine-ok'));
    fd.append('visit_rating', val('svc-rating'));
    fd.append('overall_feedback', val('svc-feedback'));
    fd.append('customer_remarks', val('svc-cust-remarks'));
    fd.append('customer_signatory_mobile', val('svc-cust-mobile'));
    fd.append('engineer_remarks', val('svc-eng-remarks'));
    fd.append('engineer_signatory_mobile', val('svc-eng-mobile'));
    fd.append('submit', submit ? '1' : '0');
    const spareLines = SVC_SPARES.filter(l => l.item_id && Number(l.quantity) > 0);
    if (spareLines.length) {
      fd.append('spares', JSON.stringify(spareLines));
      fd.append('service_center_id', val('svc-spares-center'));
    }
    const fileEl = document.getElementById('svc-file');
    if (fileEl.files.length) fd.append('handwritten_report', fileEl.files[0]);
    const sigCanvas = document.getElementById('svc-sig-canvas');
    if (sigCanvas && window.__SVC_SIG_DIRTY) fd.append('customer_signature_data', sigCanvas.toDataURL('image/png'));
    await apiUpload(`/service/${srId}/report`, fd, 'POST');
    navigate('service-mine');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Reconciliation (amount review) ----
PAGES['service-recon'] = async (el) => {
  const queue = await api('/service/reconciliation/queue');
  const month = window.RECON_MONTH || thisMonth();
  const monthly = await api('/service/reconciliation/monthly?month=' + month);
  el.innerHTML = `
    <div class="panel"><h3>Awaiting Amount Reconciliation (${queue.length})</h3>
      ${tableHTML(['SR No', 'Employee', 'Customer', 'Travel', 'Service', 'Spares', 'Total', 'Action'], queue, r => `
        <tr><td>${esc(r.sr_no)}</td><td>${esc(r.employee_name)}</td><td>${esc(r.client_name)||'-'}</td>
        <td>₹${fmt(r.amount_travel)}</td><td>₹${fmt(r.amount_service)}</td><td>₹${fmt(r.amount_spares)}</td>
        <td>₹${fmt((r.amount_travel||0)+(r.amount_service||0)+(r.amount_spares||0))}</td>
        <td><button class="btn small green" onclick="approveReconciliation(${r.id})">Approve</button></td></tr>`)}
    </div>
    <div class="panel"><h3>Monthly Reconciliation</h3>
      <div class="form-grid"><div><label>Month</label><input type="month" value="${month}" onchange="window.RECON_MONTH=this.value;navigate('service-recon')"></div></div>
      <p>Total approved for ${esc(month)}: <b>₹${fmt(monthly.total)}</b> (${monthly.rows.length} reports)</p>
      ${tableHTML(['SR No', 'Employee', 'Total', 'Status'], monthly.rows, r => `
        <tr><td>${esc(r.sr_no)}</td><td>${esc(r.employee_name)}</td><td>₹${fmt((r.amount_travel||0)+(r.amount_service||0)+(r.amount_spares||0))}</td><td>${badge(r.status)}</td></tr>`)}
      ${monthly.rows.length && !monthly.submitted ? `<button class="btn" onclick="submitToAccounts('${month}')">Submit to Accounts</button>` : ''}
      ${monthly.submitted ? '<p class="muted">Already submitted to Accounts.</p>' : ''}
    </div>`;
};
window.approveReconciliation = async (reportId) => {
  try { await api(`/service/reconciliation/${reportId}/approve`, { method: 'POST' }); navigate('service-recon'); }
  catch (e) { alert(e.message); }
};
window.submitToAccounts = async (month) => {
  try { await api(`/service/reconciliation/monthly/${month}/submit-to-accounts`, { method: 'POST' }); navigate('service-recon'); }
  catch (e) { alert(e.message); }
};

// ---- SR Reopenings Report (15-day free-of-charge policy analysis) ----
PAGES['service-reopenings'] = async (el) => {
  const data = await api('/service/reopenings-report');
  el.innerHTML = `
    <div class="panel"><h3>Reopenings by Technician</h3>
      ${tableHTML(['Technician', 'Reopen Count'], data.summary, s => `<tr><td>${esc(s.technician_name)}</td><td>${s.count}</td></tr>`)}
    </div>
    ${collapsiblePanel('service-reopenings-list', `All Reopenings (${data.rows.length})`, `
      ${tableHTML(['SR No', 'Technician', 'Original Closed At', 'Reopened At', 'Reason'], data.rows, r => `
        <tr><td>${esc(r.sr_no)}</td><td>${esc(r.technician_name)||'-'}</td><td>${esc(r.original_closed_at)}</td>
        <td>${esc(r.reopened_at)}</td><td>${esc(r.reason)||'-'}</td></tr>`)}
    `)}`;
};

// ---- Service Reports Dashboard ----
PAGES['service-reports-dashboard'] = async (el) => {
  const d = await api('/service/dashboard/summary');
  const srCols = ['SR No','Customer','Assigned To','Status','Scheduled','Age (days)'];
  const srRow = r => `<tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${esc(r.assigned_to_name)||'-'}</td><td>${badge(r.status)}</td><td>${r.scheduled_date||'-'}</td><td>${daysSince(r.created_at)}</td></tr>`;
  window.__STAT_DETAIL_BUILDERS = {
    sr_pending: async () => {
      const rows = (await api('/service')).filter(r => r.status === 'Open' || r.status === 'Scheduled');
      return `<h3>Pending (${rows.length})</h3><p class="muted">Logged, not yet In Progress.</p>${tableHTML(srCols, rows, srRow)}`;
    },
    sr_ongoing: async () => {
      const rows = (await api('/service')).filter(r => r.status === 'InProgress');
      return `<h3>Ongoing (${rows.length})</h3>${tableHTML(srCols, rows, srRow)}`;
    },
    sr_held: async () => {
      const rows = (await api('/service')).filter(r => r.status === 'PartsOrdered');
      return `<h3>Held - Parts Ordered (${rows.length})</h3>${tableHTML(srCols, rows, srRow)}`;
    },
    sr_pendingItems: async () => {
      const rows = (await api('/service')).filter(r => r.status === 'Pending Items');
      return `<h3>Pending Items (${rows.length})</h3>${tableHTML(srCols, rows, srRow)}`;
    },
    sr_delayed: async () => {
      const today = new Date().toISOString().slice(0,10);
      const rows = (await api('/service')).filter(r => r.scheduled_date && r.scheduled_date < today && !['Resolved','Closed'].includes(r.status));
      return `<h3>Delayed (${rows.length})</h3><p class="muted">Scheduled date has passed and the request is still open, oldest first.</p>
        ${tableHTML(srCols, rows.sort((a,b) => a.scheduled_date.localeCompare(b.scheduled_date)), srRow)}`;
    },
    sr_resolved: async () => {
      const rows = (await api('/service')).filter(r => r.status === 'Resolved');
      return `<h3>Resolved (${rows.length})</h3>${tableHTML(srCols, rows, srRow)}`;
    },
    sr_total: async () => {
      const rows = await api('/service');
      const byStatus = {};
      rows.forEach(r => { byStatus[r.status] = (byStatus[r.status]||0) + 1; });
      return `<h3>Total Requests (${rows.length})</h3><p class="muted">Breakdown by status</p>${breakdownBars(byStatus)}${tableHTML(srCols, rows, srRow)}`;
    },
  };
  el.innerHTML = `
    <div class="cards">
      ${statCard('sr_pending', d.counts.pending, 'Pending')}
      ${statCard('sr_ongoing', d.counts.ongoing, 'Ongoing')}
      ${statCard('sr_held', d.counts.held, 'Held (Parts Ordered)')}
      ${statCard('sr_pendingItems', d.counts.pendingItems, 'Pending Items')}
      ${statCard('sr_delayed', d.counts.delayed, 'Delayed')}
      ${statCard('sr_resolved', d.counts.resolved, 'Resolved')}
      ${statCard('sr_total', d.total, 'Total Requests')}
    </div>
    <div id="stat-detail"></div>
    <div class="panel"><h3>Trend by Month</h3>
      ${tableHTML(['Month', 'Count'], Object.entries(d.byMonth).sort(), ([m,c]) => `<tr><td>${esc(m)}</td><td>${c}</td></tr>`)}
    </div>
    ${collapsiblePanel('service-reports-by-week', `Trend by Week (${Object.keys(d.byWeek).length})`, `
      ${tableHTML(['Week', 'Count'], Object.entries(d.byWeek).sort(), ([w,c]) => `<tr><td>${esc(w)}</td><td>${c}</td></tr>`)}
    `)}
    <div class="panel"><h3>Trend by Year</h3>
      ${tableHTML(['Year', 'Count'], Object.entries(d.byYear).sort(), ([y,c]) => `<tr><td>${esc(y)}</td><td>${c}</td></tr>`)}
    </div>`;
};

// ---- Employees ----
PAGES.employees = async (el) => {
  const emps = await api('/hr/employees');
  const depts = await api('/masters/departments');
  el.innerHTML = `
    <div class="panel"><h3>Add Employee</h3>
      <div class="form-grid">
        <div><label>Employee Code</label><input id="em-code"></div>
        <div><label>Full Name</label><input id="em-name"></div>
        <div><label>Department</label><select id="em-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Designation</label><input id="em-desig"></div>
        <div><label>Employment Type</label><select id="em-emptype"><option>Full-time</option><option>Contract</option><option>Probation</option><option>Intern</option></select></div>
        <div><label>Date of Joining</label><input id="em-doj" type="date" value="${today()}"></div>
        <div><label>Phone</label><input id="em-phone"></div>
        <div><label>Email</label><input id="em-email"></div>
        <div><label>Monthly Salary (₹)</label><input id="em-salary" type="number"></div>
        <div><label>PAN Number</label><input id="em-pan"></div>
        <div><label>Blood Group</label><input id="em-blood"></div>
        <div><label>Emergency Contact Name</label><input id="em-ec-name"></div>
        <div><label>Emergency Contact Phone</label><input id="em-ec-phone"></div>
        <div><label>Address</label><input id="em-address"></div>
      </div>
      <h4 style="margin:14px 0 6px;">Bank Details</h4>
      <div class="form-grid">
        <div><label>Bank Name</label><input id="em-bank-name"></div>
        <div><label>Account Number</label><input id="em-bank-acct"></div>
        <div><label>IFSC Code</label><input id="em-bank-ifsc"></div>
      </div>
      <h4 style="margin:14px 0 6px;">Identity Documents</h4>
      <div class="form-grid">
        <div><label>Aadhaar Number</label><input id="em-aadhaar"></div>
        <div><label>Passport Number</label><input id="em-passport"></div>
        <div><label>Visa Availability</label><input id="em-visa" placeholder="e.g. Yes - valid till 2027, or No"></div>
        <div><label>Driving License Number</label><input id="em-dl"></div>
      </div>
      <button class="btn" onclick="addEmployee()">Add Employee</button>
    </div>
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per employee, then upload it here. Department names must match exactly (see the "Departments" sheet in the template).</p>
      <button class="btn outline" type="button" onclick="downloadEmployeeTemplate()">Download Template</button>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <input id="em-upload-file" type="file" accept=".xlsx,.xls">
        <button class="btn" onclick="uploadEmployeeTemplate()">Upload Filled Template</button>
      </div>
      <div id="em-upload-result" style="margin-top:10px;"></div>
    </div>
    ${collapsiblePanel('employees-list', `Employees (${emps.length})`, `
      ${emps.some(e => !e.full_name || !e.full_name.trim()) ? '<div class="msg err">One or more employees below have a blank name (created before this was required) - click Edit on the highlighted row(s) and fill in Full Name.</div>' : ''}
      ${tableHTML(['Code', 'Name', 'Department', 'Designation', 'Type', 'Salary', 'Status', 'Action'], emps, e => {
        const blank = !e.full_name || !e.full_name.trim();
        return `<tr id="emp-row-${e.id}"${blank ? ' style="background:#fef2f2;"' : ''}><td>${esc(e.employee_code)}</td><td>${blank ? '<span class="muted">(no name set)</span>' : esc(e.full_name)}</td><td>${esc(e.department_name)}</td><td>${esc(e.designation)}</td>
          <td>${esc(e.employment_type)||'Full-time'}</td><td>₹${fmt(e.monthly_salary)}</td><td>${badge(e.status)}</td>
          <td><button class="btn small outline" onclick="openEditEmployee(${e.id})">Edit</button></td></tr>`;
      })}
    `)}
    <div class="panel" id="emp-edit-panel" style="display:none;"><h3>Edit Employee</h3><div id="emp-edit-body"></div></div>`;
  window.__EMP_CACHE = emps; window.__EMP_DEPTS = depts;
};
window.addEmployee = async () => {
  if (!val('em-name').trim()) { alert('Full Name is required.'); return; }
  try {
    await api('/hr/employees', { method: 'POST', body: JSON.stringify({
      employee_code: val('em-code'), full_name: val('em-name'), department_id: val('em-dept'), designation: val('em-desig'),
      employment_type: val('em-emptype'), date_of_joining: val('em-doj'), phone: val('em-phone'), email: val('em-email'),
      monthly_salary: val('em-salary'), pan_number: val('em-pan'), blood_group: val('em-blood'),
      emergency_contact_name: val('em-ec-name'), emergency_contact_phone: val('em-ec-phone'), address: val('em-address'),
      bank_name: val('em-bank-name'), account_number: val('em-bank-acct'), ifsc_code: val('em-bank-ifsc'),
      aadhaar_number: val('em-aadhaar'), passport_number: val('em-passport'), visa_availability: val('em-visa'),
      driving_license_number: val('em-dl'),
    })});
    navigate('employees');
  } catch (e) { alert(e.message); }
};
window.downloadEmployeeTemplate = () => downloadTemplateFile('/hr/employees/template', 'employee_upload_template.xlsx');
window.uploadEmployeeTemplate = () => uploadTemplateFile('/hr/employees/bulk-upload', 'em-upload-file', 'em-upload-result', () => navigate('employees'));

window.openEditEmployee = (id) => {
  const e = (window.__EMP_CACHE || []).find(x => x.id === id);
  if (!e) return;
  const depts = window.__EMP_DEPTS || [];
  const panel = document.getElementById('emp-edit-panel');
  document.getElementById('emp-edit-body').innerHTML = `
    <div class="form-grid">
      <div><label>Employee Code</label><input id="eme-code" value="${esc(e.employee_code)||''}"></div>
      <div><label>Full Name</label><input id="eme-name" value="${esc(e.full_name)}"></div>
      <div><label>Department</label><select id="eme-dept">${depts.map(d => `<option value="${d.id}" ${d.id===e.department_id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div><label>Designation</label><input id="eme-desig" value="${esc(e.designation)||''}"></div>
      <div><label>Employment Type</label><select id="eme-emptype">${['Full-time','Contract','Probation','Intern'].map(t => `<option ${t===e.employment_type?'selected':''}>${t}</option>`).join('')}</select></div>
      <div><label>Date of Joining</label><input id="eme-doj" type="date" value="${e.date_of_joining||''}"></div>
      <div><label>Phone</label><input id="eme-phone" value="${esc(e.phone)||''}"></div>
      <div><label>Email</label><input id="eme-email" value="${esc(e.email)||''}"></div>
      <div><label>Monthly Salary (₹)</label><input id="eme-salary" type="number" value="${e.monthly_salary}"></div>
      <div><label>PAN Number</label><input id="eme-pan" value="${esc(e.pan_number)||''}"></div>
      <div><label>Blood Group</label><input id="eme-blood" value="${esc(e.blood_group)||''}"></div>
      <div><label>Emergency Contact Name</label><input id="eme-ec-name" value="${esc(e.emergency_contact_name)||''}"></div>
      <div><label>Emergency Contact Phone</label><input id="eme-ec-phone" value="${esc(e.emergency_contact_phone)||''}"></div>
      <div><label>Address</label><input id="eme-address" value="${esc(e.address)||''}"></div>
      <div><label>Status</label><select id="eme-status"><option value="active" ${e.status==='active'?'selected':''}>Active</option><option value="resigned" ${e.status==='resigned'?'selected':''}>Resigned</option><option value="terminated" ${e.status==='terminated'?'selected':''}>Terminated</option></select></div>
      <div><label>Exit Date (if resigned/terminated)</label><input id="eme-exit" type="date" value="${e.exit_date||''}"></div>
    </div>
    <h4 style="margin:14px 0 6px;">Bank Details</h4>
    <div class="form-grid">
      <div><label>Bank Name</label><input id="eme-bank-name" value="${esc(e.bank_name)||''}"></div>
      <div><label>Account Number</label><input id="eme-bank-acct" value="${esc(e.account_number)||''}"></div>
      <div><label>IFSC Code</label><input id="eme-bank-ifsc" value="${esc(e.ifsc_code)||''}"></div>
    </div>
    <h4 style="margin:14px 0 6px;">Identity Documents</h4>
    <div class="form-grid">
      <div><label>Aadhaar Number</label><input id="eme-aadhaar" value="${esc(e.aadhaar_number)||''}"></div>
      <div><label>Passport Number</label><input id="eme-passport" value="${esc(e.passport_number)||''}"></div>
      <div><label>Visa Availability</label><input id="eme-visa" value="${esc(e.visa_availability)||''}"></div>
      <div><label>Driving License Number</label><input id="eme-dl" value="${esc(e.driving_license_number)||''}"></div>
    </div>
    <button class="btn" onclick="saveEditEmployee(${id})">Save Changes</button>
    <button class="btn outline" type="button" onclick="document.getElementById('emp-edit-panel').style.display='none'">Cancel</button>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.saveEditEmployee = async (id) => {
  if (!val('eme-name').trim()) { alert('Full Name is required.'); return; }
  try {
    await api('/hr/employees/' + id, { method: 'PUT', body: JSON.stringify({
      employee_code: val('eme-code'), full_name: val('eme-name'), department_id: val('eme-dept'), designation: val('eme-desig'),
      employment_type: val('eme-emptype'), date_of_joining: val('eme-doj'), phone: val('eme-phone'), email: val('eme-email'),
      monthly_salary: val('eme-salary'), pan_number: val('eme-pan'), blood_group: val('eme-blood'),
      emergency_contact_name: val('eme-ec-name'), emergency_contact_phone: val('eme-ec-phone'), address: val('eme-address'),
      status: val('eme-status'), exit_date: val('eme-exit') || null,
      bank_name: val('eme-bank-name'), account_number: val('eme-bank-acct'), ifsc_code: val('eme-bank-ifsc'),
      aadhaar_number: val('eme-aadhaar'), passport_number: val('eme-passport'), visa_availability: val('eme-visa'),
      driving_license_number: val('eme-dl'),
    })});
    navigate('employees');
  } catch (e) { alert(e.message); }
};

// ---- Attendance ----
PAGES.attendance = async (el) => {
  const emps = await api('/hr/employees');
  const month = thisMonth();
  const records = await api('/hr/attendance?month=' + month);
  const recMap = {}; records.forEach(r => { recMap[r.employee_id] = recMap[r.employee_id] || {}; recMap[r.employee_id][r.work_date] = r.status; });
  el.innerHTML = `
    <div class="panel"><h3>Mark Attendance</h3>
      <div class="form-grid">
        <div><label>Employee</label><select id="at-emp">${emps.map(e => `<option value="${e.id}">${esc(e.full_name)}</option>`).join('')}</select></div>
        <div><label>Date</label><input id="at-date" type="date" value="${today()}"></div>
        <div><label>Status</label><select id="at-status"><option>Present</option><option>Absent</option><option>HalfDay</option><option>Leave</option><option>Holiday</option><option>WeekOff</option></select></div>
      </div>
      <button class="btn" onclick="markAttendance()">Mark</button>
    </div>
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per employee per day, then upload it. Matches employees by Employee Code.</p>
      <button class="btn outline" type="button" onclick="downloadAttendanceTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('at-upload-file')}
      <button class="btn" onclick="uploadAttendanceTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="at-upload-result" style="margin-top:10px;"></div>
    </div>
    ${collapsiblePanel('attendance-records', `This Month's Records (${records.length})`, `
      ${tableHTML(['Employee', 'Date', 'Status'], records, r => `<tr><td>${esc(r.full_name)}</td><td>${r.work_date}</td><td>${badge(r.status==='Present'?'Approved':r.status==='Absent'?'Rejected':'Pending')}${r.status}</td></tr>`)}
    `)}`;
};
window.markAttendance = async () => {
  try {
    await api('/hr/attendance/mark', { method: 'POST', body: JSON.stringify({ employee_id: val('at-emp'), work_date: val('at-date'), status: val('at-status') })});
    navigate('attendance');
  } catch (e) { alert(e.message); }
};
window.downloadAttendanceTemplate = () => downloadTemplateFile('/hr/attendance/template', 'attendance_upload_template.xlsx');
window.uploadAttendanceTemplate = () => uploadTemplateFile('/hr/attendance/bulk-upload', 'at-upload-file', 'at-upload-result', () => navigate('attendance'));

// ---- Leave ----
PAGES.leave = async (el) => {
  const emps = await api('/hr/employees');
  const types = await api('/masters/leave-types');
  const reqs = await api('/hr/leave-requests');
  el.innerHTML = `
    <div class="panel"><h3>New Leave Request</h3>
      <div class="form-grid">
        <div><label>Employee</label><select id="lv-emp">${emps.map(e => `<option value="${e.id}">${esc(e.full_name)}</option>`).join('')}</select></div>
        <div><label>Leave Type</label><select id="lv-type">${types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
        <div><label>From</label><input id="lv-from" type="date"></div>
        <div><label>To</label><input id="lv-to" type="date"></div>
        <div><label>Days</label><input id="lv-days" type="number" step="0.5"></div>
        <div><label>Reason</label><input id="lv-reason"></div>
        <div><label>Supporting Document (e.g. medical certificate)</label><input id="lv-file" type="file"></div>
      </div>
      <button class="btn" onclick="addLeave()">Submit Request</button>
    </div>
    ${collapsiblePanel('leave-requests-list', `Leave Requests (${reqs.length})`, `
      ${tableHTML(['Employee', 'Type', 'From', 'To', 'Days', 'Status', ''], reqs, r => `
        <tr><td>${esc(r.full_name)}</td><td>${esc(r.leave_type_name)}</td><td>${r.from_date}</td><td>${r.to_date}</td><td>${r.days}</td><td>${badge(r.status)}</td>
        <td><button class="btn small outline" type="button" onclick="toggleLeaveAttachments(${r.id})">Attachments</button></td></tr>
        <tr id="lv-att-row-${r.id}" style="display:none;"><td colspan="7"><div id="lv-attachments-${r.id}"></div></td></tr>`)}
    `)}`;
};
window.toggleLeaveAttachments = (id) => {
  const row = document.getElementById(`lv-att-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderAttachmentsWidget('leave_request', id, document.getElementById(`lv-attachments-${id}`));
};
window.addLeave = async () => {
  try {
    const { id } = await api('/hr/leave-requests', { method: 'POST', body: JSON.stringify({
      employee_id: val('lv-emp'), leave_type_id: val('lv-type'), from_date: val('lv-from'), to_date: val('lv-to'), days: val('lv-days'), reason: val('lv-reason')
    })});
    const fileInput = document.getElementById('lv-file');
    if (id && fileInput && fileInput.files.length) {
      const fd = new FormData(); fd.append('file', fileInput.files[0]);
      await apiUpload(`/attachments/leave_request/${id}`, fd);
    }
    navigate('leave');
  } catch (e) { alert(e.message); }
};

// ---- Advances ----
PAGES.advances = async (el) => {
  const emps = await api('/hr/employees');
  const advs = await api('/hr/advances');
  el.innerHTML = `
    <div class="panel"><h3>New Salary Advance Request</h3>
      <div class="form-grid">
        <div><label>Employee</label><select id="ad-emp">${emps.map(e => `<option value="${e.id}">${esc(e.full_name)}</option>`).join('')}</select></div>
        <div><label>Amount (₹)</label><input id="ad-amount" type="number"></div>
        <div><label>Installments</label><input id="ad-installments" type="number" min="1" value="1"></div>
        <div><label>Installment Amount (₹, optional override)</label><input id="ad-inst-amount" type="number" placeholder="Auto = Amount / Installments"></div>
        <div><label>Reason</label><input id="ad-reason"></div>
        <div><label>Supporting Document</label><input id="ad-file" type="file"></div>
      </div>
      <button class="btn" onclick="addAdvance()">Submit Request</button>
      <div class="muted" style="margin-top:8px;">Approval chain: HR then Accounts.</div>
    </div>
    ${collapsiblePanel('advances-list', `Advances (${advs.length})`, `
      ${tableHTML(['Employee', 'Amount', 'Recovered', 'Installments', 'Status', 'Date', ''], advs, a => `
        <tr><td>${esc(a.full_name)}</td><td>₹${fmt(a.amount)}</td><td>₹${fmt(a.recovered_amount)} / ₹${fmt(a.amount)}</td>
        <td>${a.installments_paid || 0} / ${a.installments || 1} (₹${fmt(a.installment_amount)} each)</td>
        <td>${badge(a.status)}</td><td>${new Date(a.request_date).toLocaleDateString()}</td>
        <td><button class="btn small outline" type="button" onclick="toggleAdvanceAttachments(${a.id})">Attachments</button></td></tr>
        <tr id="ad-att-row-${a.id}" style="display:none;"><td colspan="7"><div id="ad-attachments-${a.id}"></div></td></tr>`)}
    `)}`;
};
window.toggleAdvanceAttachments = (id) => {
  const row = document.getElementById(`ad-att-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderAttachmentsWidget('salary_advance', id, document.getElementById(`ad-attachments-${id}`));
};
window.addAdvance = async () => {
  try {
    const { id } = await api('/hr/advances', { method: 'POST', body: JSON.stringify({
      employee_id: val('ad-emp'), amount: val('ad-amount'), reason: val('ad-reason'),
      installments: val('ad-installments'), installment_amount: val('ad-inst-amount') || undefined
    })});
    const fileInput = document.getElementById('ad-file');
    if (id && fileInput && fileInput.files.length) {
      const fd = new FormData(); fd.append('file', fileInput.files[0]);
      await apiUpload(`/attachments/salary_advance/${id}`, fd);
    }
    navigate('advances');
  } catch (e) { alert(e.message); }
};

// ---- Payroll ----
PAGES.payroll = async (el) => {
  const month = thisMonth();
  const schedule = await api('/hr/salary-schedule?month=' + month);
  el.innerHTML = `
    <div class="panel"><h3>Generate Payroll Run</h3>
      <div class="form-grid">
        <div><label>Month</label><input id="pr-month" type="month" value="${month}"></div>
      </div>
      <button class="btn" onclick="genPayroll()">Generate Draft (from attendance & advances)</button>
    </div>
    ${collapsiblePanel('salary-schedule', `Salary Schedule &mdash; ${month} (${schedule.length})`, `
      ${tableHTML(['Employee', 'Days Present', 'Gross', 'Leave Ded.', 'Advance Ded.', 'Net Pay', 'Status', 'Action'], schedule, s => `
        <tr><td>${esc(s.full_name)}</td><td>${s.days_present}</td><td>₹${fmt(s.gross)}</td><td>₹${fmt(s.leave_deduction)}</td><td>₹${fmt(s.advance_deduction)}</td><td>₹${fmt(s.net_pay)}</td><td>${badge(s.status)}</td>
        <td>${payrollActions(s)}</td></tr>`)}
    `)}`;
};
function payrollActions(s) {
  if (s.status === 'Draft') return `<button class="btn small" onclick="submitPayrollApproval(${s.id})">Submit for Approval</button>`;
  if (s.status === 'Approved') return `<button class="btn small green" onclick="payPayroll(${s.id})">Mark Paid</button>`;
  return '-';
}
window.genPayroll = async () => {
  try {
    await api('/hr/salary-schedule/generate', { method: 'POST', body: JSON.stringify({ month: val('pr-month') })});
    navigate('payroll');
  } catch (e) { alert(e.message); }
};
window.submitPayrollApproval = async (id) => {
  await api(`/hr/salary-schedule/${id}/submit-approval`, { method: 'POST' });
  navigate('payroll');
};
window.payPayroll = async (id) => {
  await api(`/hr/salary-schedule/${id}/mark-paid`, { method: 'POST', body: JSON.stringify({ cash_or_bank: 'Bank' })});
  navigate('payroll');
};

// ---- Leave Balances Master ----
PAGES['leave-balances'] = async (el) => {
  const year = window.LB_YEAR || new Date().getFullYear();
  const empFilter = window.LB_EMP || '';
  const [types, emps, depts, policies] = await Promise.all([
    api('/hr/leave-types'),
    api('/hr/employees'),
    api('/masters/departments'),
    api('/hr/leave-balance-policies?year=' + year),
  ]);
  const balances = empFilter ? await api('/hr/leave-balances?year=' + year + '&employee_id=' + empFilter) : [];
  const companyPolicies = policies.filter(p => p.scope === 'Company');
  const deptPolicies = policies.filter(p => p.scope === 'Department');
  el.innerHTML = `
    <div class="panel"><h3>Company-wide Leave Policy</h3>
      <p class="muted">Default allocation per leave type per year, applying to every employee unless a department override exists below.</p>
      <div class="form-grid">
        <div><label>Year</label><input id="cp-year" type="number" value="${year}"></div>
        <div><label>Leave Type</label><select id="cp-type">${types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
        <div><label>Allocated</label><input id="cp-alloc" type="number" step="0.5" value="0"></div>
      </div>
      <button class="btn small" onclick="saveCompanyPolicy()">Save Company Policy</button>
      ${tableHTML(['Leave Type', 'Allocated', ''], companyPolicies, p => `
        <tr><td>${esc(p.leave_type_name)}</td><td>${p.allocated}</td>
        <td><button class="btn small outline" onclick="editCompanyPolicy(${p.leave_type_id},${p.allocated})">Edit</button></td></tr>`)}
    </div>
    <div class="panel"><h3>Department Overrides</h3>
      <p class="muted">Overrides the company default for a specific department/leave type/year.</p>
      <div class="form-grid">
        <div><label>Department</label><select id="dp-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Leave Type</label><select id="dp-type">${types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
        <div><label>Year</label><input id="dp-year" type="number" value="${year}"></div>
        <div><label>Allocated</label><input id="dp-alloc" type="number" step="0.5" value="0"></div>
      </div>
      <button class="btn small" onclick="saveDeptPolicy()">Save Department Override</button>
      ${tableHTML(['Department', 'Leave Type', 'Allocated'], deptPolicies, p => `
        <tr><td>${esc(p.department_name)}</td><td>${esc(p.leave_type_name)}</td><td>${p.allocated}</td></tr>`)}
    </div>
    <div class="panel"><h3>Employee Balance Lookup (read-only, resolved from policies above)</h3>
      <div class="form-grid">
        <div><label>Year</label><input id="lb-year" type="number" value="${year}"></div>
        <div><label>Employee</label><select id="lb-emp"><option value="">Select an employee...</option>${emps.map(e => `<option value="${e.id}" ${String(e.id) === String(empFilter) ? 'selected' : ''}>${esc(e.full_name)}</option>`).join('')}</select></div>
      </div>
      <button class="btn" onclick="loadLeaveBalances()">Look Up</button>
      ${tableHTML(['Leave Type', 'Paid', 'Source', 'Allocated', 'Used', 'Balance', 'On Probation'], balances, b => `
        <tr><td>${esc(b.leave_type_name)}</td><td>${b.is_paid ? 'Paid' : 'Unpaid'}</td><td>${esc(b.overridden ? 'Manual Override' : b.source)}</td>
        <td>${b.allocated}</td><td>${b.used}</td><td>${b.balance}</td><td>${b.on_probation ? 'Yes' : ''}</td></tr>`)}
    </div>`;
  el.innerHTML += `
    <div class="panel"><h3>Leave Types</h3>
      <div class="form-grid">
        <div><label>Name</label><input id="lt-name"></div>
        <div><label>Annual Quota</label><input id="lt-quota" type="number" step="0.5" value="0"></div>
        <div><label>Paid?</label><select id="lt-paid"><option value="1">Paid</option><option value="0">Unpaid</option></select></div>
        <div><label>Probation Months</label><input id="lt-probation" type="number" min="0" value="0"></div>
        <div><label>Accrual</label><input id="lt-accrual" value="Annual"></div>
        <div><label>Carry Forward?</label><select id="lt-carry"><option value="0">No</option><option value="1">Yes</option></select></div>
        <div><label>Max Carry Forward</label><input id="lt-maxcarry" type="number" step="0.5" value="0"></div>
      </div>
      <button class="btn" onclick="addLeaveType()">Add Leave Type</button>
      ${tableHTML(['Name', 'Quota', 'Paid', 'Probation (mo)', 'Accrual', 'Carry Fwd', 'Max Carry', 'Action'], types, t => `
        <tr>
          <td><input id="lt-name-${t.id}" value="${esc(t.name)}" style="width:100px;"></td>
          <td><input id="lt-quota-${t.id}" type="number" step="0.5" value="${t.annual_quota}" style="width:70px;"></td>
          <td><select id="lt-paid-${t.id}"><option value="1" ${t.is_paid ? 'selected' : ''}>Paid</option><option value="0" ${!t.is_paid ? 'selected' : ''}>Unpaid</option></select></td>
          <td><input id="lt-probation-${t.id}" type="number" min="0" value="${t.probation_months || 0}" style="width:60px;"></td>
          <td><input id="lt-accrual-${t.id}" value="${esc(t.accrual || 'Annual')}" style="width:80px;"></td>
          <td><select id="lt-carry-${t.id}"><option value="0" ${!t.carry_forward ? 'selected' : ''}>No</option><option value="1" ${t.carry_forward ? 'selected' : ''}>Yes</option></select></td>
          <td><input id="lt-maxcarry-${t.id}" type="number" step="0.5" value="${t.max_carry_forward || 0}" style="width:70px;"></td>
          <td><button class="btn small" onclick="saveLeaveType(${t.id})">Save</button></td>
        </tr>`)}
    </div>`;
};
window.saveCompanyPolicy = async () => {
  try {
    await api('/hr/leave-balance-policies', { method: 'PUT', body: JSON.stringify({
      scope: 'Company', leave_type_id: val('cp-type'), year: val('cp-year'), allocated: val('cp-alloc'),
    })});
    window.LB_YEAR = val('cp-year');
    navigate('leave-balances');
  } catch (e) { alert(e.message); }
};
window.editCompanyPolicy = (leaveTypeId, allocated) => {
  document.getElementById('cp-type').value = leaveTypeId;
  document.getElementById('cp-alloc').value = allocated;
};
window.saveDeptPolicy = async () => {
  try {
    await api('/hr/leave-balance-policies', { method: 'PUT', body: JSON.stringify({
      scope: 'Department', department_id: val('dp-dept'), leave_type_id: val('dp-type'), year: val('dp-year'), allocated: val('dp-alloc'),
    })});
    window.LB_YEAR = val('dp-year');
    navigate('leave-balances');
  } catch (e) { alert(e.message); }
};
window.addLeaveType = async () => {
  try {
    await api('/hr/leave-types', { method: 'POST', body: JSON.stringify({
      name: val('lt-name'), annual_quota: val('lt-quota'), is_paid: val('lt-paid') === '1',
      probation_months: val('lt-probation'), accrual: val('lt-accrual'),
      carry_forward: val('lt-carry') === '1', max_carry_forward: val('lt-maxcarry'),
    })});
    navigate('leave-balances');
  } catch (e) { alert(e.message); }
};
window.saveLeaveType = async (id) => {
  try {
    await api(`/hr/leave-types/${id}`, { method: 'PUT', body: JSON.stringify({
      name: val(`lt-name-${id}`), annual_quota: val(`lt-quota-${id}`), is_paid: val(`lt-paid-${id}`) === '1',
      probation_months: val(`lt-probation-${id}`), accrual: val(`lt-accrual-${id}`),
      carry_forward: val(`lt-carry-${id}`) === '1', max_carry_forward: val(`lt-maxcarry-${id}`),
    })});
    navigate('leave-balances');
  } catch (e) { alert(e.message); }
};
window.loadLeaveBalances = () => {
  window.LB_YEAR = val('lb-year');
  window.LB_EMP = val('lb-emp');
  navigate('leave-balances');
};
window.saveLeaveBalance = async (employeeId, leaveTypeId, year) => {
  try {
    const allocated = val(`lb-alloc-${employeeId}-${leaveTypeId}`);
    await api('/hr/leave-balances', { method: 'PUT', body: JSON.stringify({ employee_id: employeeId, leave_type_id: leaveTypeId, year, allocated })});
    navigate('leave-balances');
  } catch (e) { alert(e.message); }
};

// ---- Expense Vouchers ----
let EV_LIST_MONTH = null;
PAGES.expenses = async (el) => {
  const listMonth = EV_LIST_MONTH || new Date().toISOString().slice(0, 7);
  EV_LIST_MONTH = listMonth;
  const vouchers = await api('/finance/expense-vouchers?month=' + listMonth);
  const depts = await api('/masters/departments');
  const cats = await api('/masters/expense-categories');
  el.innerHTML = `
    <div class="panel"><h3>New Expense Voucher (Operation Expense)</h3>
      <div class="form-grid">
        <div><label>Department</label><select id="ex-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Category</label><select id="ex-cat">${cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Amount (₹)</label><input id="ex-amount" type="number"></div>
        <div><label>Payment Mode</label><select id="ex-mode"><option>Cash</option><option>Bank</option></select></div>
        <div><label>Accounted Status</label><select id="ex-acc"><option>Accounted</option><option>Cash(Unaccounted)</option></select></div>
        <div><label>Description</label><input id="ex-desc"></div>
        <div><label>Bill / Receipt Attachment</label><input id="ex-file" type="file"></div>
      </div>
      <button class="btn" onclick="addExpense()">Submit Voucher</button>
      <div class="muted" style="margin-top:8px;">Approval chain: Accounts, plus Admin for vouchers ≥ ₹25,000.</div>
    </div>
    ${collapsiblePanel('expense-vouchers-list', `Expense Vouchers - ${listMonth === 'all' ? 'All Time' : listMonth} (${vouchers.length})`, `
      <div class="form-grid" style="margin-bottom:10px;">
        <div><label>Month</label><input type="month" id="ex-list-month" value="${listMonth === 'all' ? '' : listMonth}" onchange="EV_LIST_MONTH=this.value;navigate('expenses')"></div>
        <div style="align-self:end;"><button class="btn small outline" type="button" onclick="EV_LIST_MONTH='all';navigate('expenses')">Show All</button></div>
      </div>
      ${tableHTML(['Voucher No', 'Dept', 'Category', 'Amount', 'Mode', 'Accounted', 'Bill', 'Status', 'Action'], vouchers, v => `
        <tr><td>${esc(v.voucher_no)}</td><td>${esc(v.department_name)}</td><td>${esc(v.category_name)}</td><td>₹${fmt(v.amount)}</td><td>${esc(v.payment_mode)}</td><td>${esc(v.accounted)}</td>
        <td>${v.attachment_path ? `<a href="${v.attachment_path}" target="_blank">View</a>` : '-'}</td><td>${badge(v.status)}</td>
        <td>${v.status === 'Approved' ? `<button class="btn small green" onclick="payExpense(${v.id})">Mark Paid</button>` : '-'}</td></tr>`)}
    `)}`;
};
window.addExpense = async () => {
  try {
    const fd = new FormData();
    fd.append('department_id', val('ex-dept'));
    fd.append('category_id', val('ex-cat'));
    fd.append('amount', val('ex-amount'));
    fd.append('payment_mode', val('ex-mode'));
    fd.append('accounted', val('ex-acc'));
    fd.append('description', val('ex-desc'));
    const fileEl = document.getElementById('ex-file');
    if (fileEl.files.length) fd.append('attachment', fileEl.files[0]);
    await apiUpload('/finance/expense-vouchers', fd, 'POST');
    navigate('expenses');
  } catch (e) { alert(e.message); }
};
window.payExpense = async (id) => {
  await api(`/finance/expense-vouchers/${id}/mark-paid`, { method: 'POST' });
  navigate('expenses');
};

// ---- Monthly Expense Tracker (replaces the team's tracking Excel) ----
// Daily categories: a day-wise grid for the selected month, editable inline.
// Fixed categories: one lump-sum amount for the whole month.
let EXP_TRACKER_MONTH = null;
PAGES['expense-tracker'] = async (el) => {
  const month = EXP_TRACKER_MONTH || thisMonth();
  EXP_TRACKER_MONTH = month;
  const [cats, entries] = await Promise.all([
    api('/expense-tracker/categories'), api('/expense-tracker/entries?month=' + month),
  ]);
  const daily = cats.filter(c => c.kind === 'Daily' && c.active);
  const fixed = cats.filter(c => c.kind === 'Fixed' && c.active);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const byKey = {};
  entries.forEach(e => { byKey[e.category_id + '|' + e.entry_date] = e.amount; });
  const dayCols = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const dateFor = (d) => `${month}-${String(d).padStart(2, '0')}`;
  el.innerHTML = `
    <div class="panel">
      <div class="form-grid"><div><label>Month</label><input type="month" id="et-month" value="${month}" onchange="EXP_TRACKER_MONTH=this.value;navigate('expense-tracker')"></div></div>
    </div>
    <div class="panel">
      <h3>Daily Operational Expenses</h3>
      <div style="overflow-x:auto;">
        <table class="et-grid"><thead><tr><th style="min-width:170px;">Category</th>
          ${dayCols.map(d => `<th style="min-width:52px;">${d}</th>`).join('')}
          <th style="min-width:80px;">Total</th></tr></thead>
        <tbody>
          ${daily.map(c => `<tr data-cat="${c.id}"><td>${esc(c.name)}</td>
            ${dayCols.map(d => `<td><input type="number" class="et-cell" data-cat="${c.id}" data-date="${dateFor(d)}" value="${byKey[c.id+'|'+dateFor(d)]||''}" style="width:48px;" oninput="etRecalcRow(${c.id})"></td>`).join('')}
            <td class="et-row-total" id="et-total-${c.id}">0</td></tr>`).join('')}
        </tbody>
        <tfoot><tr><td><b>Daily Total</b></td>
          ${dayCols.map(d => `<td class="et-day-total" id="et-daytotal-${d}">0</td>`).join('')}
          <td id="et-grand-daily"><b>0</b></td></tr></tfoot>
        </table>
      </div>
    </div>
    <div class="panel">
      <h3>Fixed &amp; Overhead Expenses (this month)</h3>
      <div class="form-grid">
        ${fixed.map(c => `<div><label>${esc(c.name)}</label><input type="number" class="et-fixed" data-cat="${c.id}" data-date="${month}-01" value="${byKey[c.id+'|'+month+'-01']||''}"></div>`).join('')}
      </div>
    </div>
    <button class="btn" onclick="saveExpenseTracker()">Save</button>
    <span class="muted" style="margin-left:10px;">Grand total: ₹<span id="et-grand-total">0</span></span>
    <div id="et-err" class="msg err" style="display:none;margin-top:10px;"></div>`;
  daily.forEach(c => etRecalcRow(c.id));
  etRecalcAll();
};
window.etRecalcRow = (catId) => {
  const cells = document.querySelectorAll(`.et-cell[data-cat="${catId}"]`);
  let total = 0;
  cells.forEach(c => { total += Number(c.value) || 0; });
  const totalEl = document.getElementById('et-total-' + catId);
  if (totalEl) totalEl.textContent = fmt(total);
  etRecalcAll();
};
window.etRecalcAll = () => {
  // Per-day-of-month totals, keyed by day-of-month (not full date, since all
  // cells on screen share the same month).
  const cols = {};
  let grandDaily = 0;
  document.querySelectorAll('.et-cell').forEach(c => {
    const day = Number(c.dataset.date.slice(-2));
    const v = Number(c.value) || 0;
    cols[day] = (cols[day] || 0) + v;
    grandDaily += v;
  });
  Object.keys(cols).forEach(d => {
    const el = document.getElementById('et-daytotal-' + d);
    if (el) el.textContent = fmt(cols[d]);
  });
  const grandDailyEl = document.getElementById('et-grand-daily');
  if (grandDailyEl) grandDailyEl.innerHTML = '<b>' + fmt(grandDaily) + '</b>';
  let fixedTotal = 0;
  document.querySelectorAll('.et-fixed').forEach(c => { fixedTotal += Number(c.value) || 0; });
  const grandEl = document.getElementById('et-grand-total');
  if (grandEl) grandEl.textContent = fmt(grandDaily + fixedTotal);
};
document.addEventListener('input', (e) => { if (e.target.classList && e.target.classList.contains('et-fixed')) etRecalcAll(); });
window.saveExpenseTracker = async () => {
  const errEl = document.getElementById('et-err');
  try {
    const entries = [];
    document.querySelectorAll('.et-cell, .et-fixed').forEach(c => {
      entries.push({ category_id: Number(c.dataset.cat), entry_date: c.dataset.date, amount: Number(c.value) || 0 });
    });
    await api('/expense-tracker/entries/bulk', { method: 'POST', body: JSON.stringify({ entries }) });
    navigate('expense-tracker');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Expense Tracker - Year Summary (always live, no manual retyping) ----
let EXP_TRACKER_YEAR = null;
PAGES['expense-tracker-summary'] = async (el) => {
  const year = EXP_TRACKER_YEAR || String(new Date().getFullYear());
  EXP_TRACKER_YEAR = year;
  const data = await api('/expense-tracker/summary?year=' + year);
  const monthLabels = data.months.map(m => m.slice(5));
  const section = (kind, title) => {
    const rows = data.categories.filter(c => c.kind === kind);
    const sectionTotals = data.months.map((_, i) => rows.reduce((s, r) => s + r.months[i], 0));
    return `<h4>${title}</h4>
      <div style="overflow-x:auto;"><table class="et-grid"><thead><tr><th>Category</th>
        ${monthLabels.map(m => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(r.name)}</td>${r.months.map(v => `<td>₹${fmt(v)}</td>`).join('')}<td><b>₹${fmt(r.months.reduce((a,b)=>a+b,0))}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td><b>Total</b></td>${sectionTotals.map(v => `<td><b>₹${fmt(v)}</b></td>`).join('')}<td><b>₹${fmt(sectionTotals.reduce((a,b)=>a+b,0))}</b></td></tr></tfoot>
      </table></div>`;
  };
  el.innerHTML = `
    <div class="panel"><div class="form-grid"><div><label>Year</label>
      <input type="number" value="${year}" onchange="EXP_TRACKER_YEAR=this.value;navigate('expense-tracker-summary')" style="width:100px;"></div></div>
    </div>
    <div class="panel">
      ${section('Daily', 'Daily Operational Expenses')}
      ${section('Fixed', 'Fixed & Overhead Expenses')}
      <h4>Grand Total: ₹${fmt(data.grandTotal)}</h4>
    </div>`;
};

// ---- Expense Tracker - Categories (Admin/Accounts manage the list) ----
PAGES['expense-tracker-categories'] = async (el) => {
  const cats = await api('/expense-tracker/categories');
  el.innerHTML = `
    <div class="panel"><h3>Add Category</h3>
      <div class="form-grid">
        <div><label>Name</label><input id="etc-name"></div>
        <div><label>Kind</label><select id="etc-kind"><option value="Daily">Daily (day-wise)</option><option value="Fixed">Fixed (once a month)</option></select></div>
        <div><label>Sort Order</label><input id="etc-sort" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addExpTrackerCategory()">Add Category</button>
    </div>
    <div class="panel"><h3>Categories (${cats.length})</h3>
      ${tableHTML(['Name', 'Kind', 'Sort', 'Active', 'Action'], cats, c => `
        <tr><td>${esc(c.name)}</td><td>${esc(c.kind)}</td><td>${c.sort_order}</td><td>${c.active ? 'Yes' : 'No'}</td>
        <td><button class="btn small outline" onclick="toggleExpTrackerCategory(${c.id}, ${c.active ? 0 : 1})">${c.active ? 'Deactivate' : 'Activate'}</button></td></tr>`)}
    </div>`;
};
window.addExpTrackerCategory = async () => {
  try {
    await api('/expense-tracker/categories', { method: 'POST', body: JSON.stringify({ name: val('etc-name'), kind: val('etc-kind'), sort_order: val('etc-sort') }) });
    navigate('expense-tracker-categories');
  } catch (e) { alert(e.message); }
};
window.toggleExpTrackerCategory = async (id, active) => {
  await api('/expense-tracker/categories/' + id, { method: 'PUT', body: JSON.stringify({ active }) });
  navigate('expense-tracker-categories');
};

// ---- Offer Field Options (Application / Type of System / Material of Construction) ----
const OFFER_OPTION_FIELDS = [['application', 'Application'], ['type_of_system', 'Type Of System'], ['material_of_construction', 'Material Of Construction']];
let OFFER_OPTIONS_TAB = 'application';
// ---- Offer Clause Library categories - ids must match routes/offers.js's CLAUSE_CATEGORIES ----
const CLAUSE_CATEGORIES = [['term', 'Terms & Conditions'], ['inclusion', 'Inclusions'], ['exclusion', 'Exclusions'], ['utilities', 'Utilities Requirement'], ['instrument_air', 'Instrument Air Supply']];
let CLAUSE_LIBRARY_TAB = 'term';
// Plain <input>/<textarea> fields, not contenteditable spans - contenteditable
// text selection/replacement is unreliable with real mouse clicks (e.g. a
// triple-click meant to select-all and retype instead inserts the new text
// mid-string), which is what made these look broken/uneditable in practice
// even though the save wiring underneath was fine.
function renderOfferOptionRows(rows, isAdmin) {
  return `<table><thead><tr><th>Value</th><th>Sort</th><th>Active</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(o => `<tr>
      <td>${isAdmin ? `<input type="text" value="${esc(o.value)}" onblur="editOfferOption(${o.id}, 'value', this.value)" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;">` : esc(o.value)}</td>
      <td>${isAdmin ? `<input type="number" value="${o.sort_order}" onblur="editOfferOption(${o.id}, 'sort_order', this.value)" style="width:80px;border:1px solid var(--border);border-radius:4px;padding:5px;">` : o.sort_order}</td>
      <td>${o.active ? 'Yes' : 'No'}</td>
      ${isAdmin ? `<td><button class="btn small outline" onclick="editOfferOption(${o.id}, 'active', ${o.active ? 0 : 1})">${o.active ? 'Deactivate' : 'Activate'}</button></td>` : ''}
    </tr>`).join('') || `<tr><td colspan="${isAdmin ? 4 : 3}" class="empty">No options yet.</td></tr>`}
  </tbody></table>`;
}
function renderSectionTitleRows(rows, isAdmin) {
  return `<table><thead><tr><th>Title</th><th>Description</th><th>Summary</th><th>Picture</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(s => `<tr>
      <td>${isAdmin ? `<input type="text" value="${esc(s.title)}" onblur="editSectionTitle(${s.id}, 'title', this.value)" style="width:100%;min-width:160px;border:1px solid var(--border);border-radius:4px;padding:5px;">` : esc(s.title)}</td>
      <td style="max-width:220px;">${isAdmin ? `<textarea onblur="editSectionTitle(${s.id}, 'description', this.value)" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;font-family:inherit;">${esc(s.description)}</textarea>` : (esc(s.description)||'-')}</td>
      <td style="max-width:180px;">${isAdmin ? `<input type="text" value="${esc(s.summary)}" onblur="editSectionTitle(${s.id}, 'summary', this.value)" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;">` : (esc(s.summary)||'-')}</td>
      <td>
        ${s.image_path ? `<img src="${esc(s.image_path)}" style="max-width:50px;max-height:50px;display:block;margin-bottom:4px;">` : ''}
        ${isAdmin ? `<input type="file" accept="image/*" onchange="replaceSectionTitleImage(${s.id}, this)" style="font-size:11px;width:110px;">` : (s.image_path ? '' : '-')}
      </td>
      ${isAdmin ? `<td><button class="btn small red" onclick="deleteSectionTitle(${s.id})">Delete</button></td>` : ''}
    </tr>`).join('') || `<tr><td colspan="${isAdmin ? 5 : 4}" class="empty">No section titles yet.</td></tr>`}
  </tbody></table>`;
}
PAGES['offer-options'] = async (el) => {
  // Field options / Section Title library are master template controls
  // (values every Sales user's offers draw from) - only Admin can add,
  // edit, deactivate or delete entries; everyone else gets a read-only
  // view to browse what's available while building an offer. The bulk
  // admin listing (incl. inactive, for toggling) is Admin-only now, so
  // everyone else reads just the active options for the open tab - the
  // same endpoint the offer builder itself uses to populate its dropdowns.
  const isAdmin = ME.role === 'Admin';
  const [rows, sectionTitles, pdfTemplate, governance, clauses, suggestions] = await Promise.all([
    isAdmin ? api('/offers/field-options').then(all => all.filter(o => o.field_name === OFFER_OPTIONS_TAB)) : api('/offers/field-options/' + OFFER_OPTIONS_TAB),
    api('/offers/section-titles'),
    api('/offers/pdf-template').catch(() => null), // Admin-only - null for everyone else, panel just doesn't render
    api('/offers/governance').catch(() => null), // Admin-only - same
    isAdmin ? api('/offers/clause-library') : Promise.resolve([]), // Admin-only bulk (incl. inactive) view
    isAdmin ? api('/offers/section-title-suggestions') : Promise.resolve([]), // Admin-only review queue
  ]);
  el.innerHTML = `
    <div class="panel">
      <div class="tabs">${OFFER_OPTION_FIELDS.map(([id, label]) => `<div class="tab ${OFFER_OPTIONS_TAB === id ? 'active' : ''}" onclick="switchOfferOptionsTab('${id}')">${label}</div>`).join('')}</div>
      ${isAdmin ? `<div style="margin-top:14px;" class="form-grid">
        <div><label>New Value</label><input id="oo-value"></div>
        <div><label>Sort Order</label><input id="oo-sort" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addOfferOption()">Add Option</button>` : ''}
      <div style="margin-top:14px;">
      ${collapsiblePanel('offer-field-values', `Values (${rows.length})`, `
        ${renderListSearch('offer-field-values', rows, ['value'], (filtered) => {
          document.getElementById('oo-table-wrap').innerHTML = renderOfferOptionRows(filtered, isAdmin);
        }, 'Search values...')}
        <div id="oo-table-wrap">${renderOfferOptionRows(rows, isAdmin)}</div>
      `)}
      </div>
    </div>
    ${isAdmin && suggestions.length ? `<div class="panel"><h3>Pending Section Titles for Review (${suggestions.length})</h3>
      <p class="muted">Typed directly on an offer instead of picked from the library - Approve to add it to the Section Title Library below for everyone to reuse, or Reject to discard it. The offer item itself already saved either way.</p>
      ${tableHTML(['Title', 'Description', 'Summary', 'Picture', 'Offer', 'Suggested By', ''], suggestions, s => `
        <tr>
          <td>${esc(s.title)}</td>
          <td style="white-space:pre-wrap;max-width:200px;">${esc(s.description)||'-'}</td>
          <td style="max-width:160px;">${esc(s.summary)||'-'}</td>
          <td>${s.image_path ? `<img src="${esc(s.image_path)}" style="max-width:50px;max-height:50px;">` : '-'}</td>
          <td>${esc(s.offer_no)||'-'}</td>
          <td>${esc(s.suggested_by_name)||'-'}</td>
          <td><button class="btn small green" onclick="approveSectionTitleSuggestion(${s.id})">Approve</button>
          <button class="btn small red" onclick="rejectSectionTitleSuggestion(${s.id})">Reject</button></td>
        </tr>`)}
    </div>` : ''}
    <div class="panel">
      ${collapsiblePanel('section-title-library', `Section Title Library (${sectionTitles.length})`, `
        <p class="muted">Named machinery/scope lines with a default description, summary and picture - picking one on an offer's "Add Machinery / Scope Line" form auto-fills the line instead of retyping it every time.</p>
        ${renderListSearch('section-title-library', sectionTitles, ['title', 'description', 'summary'], (filtered) => {
          document.getElementById('stl-table-wrap').innerHTML = renderSectionTitleRows(filtered, isAdmin);
        }, 'Search title, description, summary...')}
        <div id="stl-table-wrap">${renderSectionTitleRows(sectionTitles, isAdmin)}</div>
        ${isAdmin ? `<h4>Add Section Title</h4>
        <div class="form-grid">
          <div><label>Title</label><input id="stl-title" placeholder="e.g. Electronic Net Weighing And Bagging System"></div>
          <div><label>Summary</label><input id="stl-summary" placeholder="Short reference note"></div>
          <div><label>Picture (optional)</label><input id="stl-image" type="file" accept="image/*"></div>
        </div>
        <label>Description</label>
        <textarea id="stl-desc" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
        <div style="margin-top:8px;"><button class="btn" onclick="addSectionTitle()">Add to Library</button></div>
        <div id="stl-err" class="msg err" style="display:none;margin-top:10px;"></div>` : ''}
      `)}
    </div>
    ${isAdmin ? collapsiblePanel('offer-clause-library', 'Offer Clause Library', `
      <p class="muted">Pre-approved Terms &amp; Conditions / Inclusions / Exclusions / Utilities Requirement / Instrument Air Supply clauses - Sales picks from these on the offer builder's Terms and Inclusions/Exclusions tabs instead of always typing from scratch.</p>
      <div class="tabs">${CLAUSE_CATEGORIES.map(([id, label]) => `<div class="tab ${CLAUSE_LIBRARY_TAB === id ? 'active' : ''}" onclick="switchClauseLibraryTab('${id}')">${label}</div>`).join('')}</div>
      <table style="margin-top:14px;"><thead><tr><th>Label</th><th>Clause Text</th><th>Sort</th><th>Active</th><th></th></tr></thead><tbody>
        ${clauses.filter(c => c.category === CLAUSE_LIBRARY_TAB).map(c => `<tr>
          <td><input type="text" value="${esc(c.label)}" onblur="editClause(${c.id}, 'label', this.value)" style="width:100%;min-width:120px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td style="max-width:320px;"><textarea onblur="editClause(${c.id}, 'body', this.value)" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;font-family:inherit;">${esc(c.body)}</textarea></td>
          <td><input type="number" value="${c.sort_order}" onblur="editClause(${c.id}, 'sort_order', this.value)" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td>${c.active ? 'Yes' : 'No'}</td>
          <td><button class="btn small outline" onclick="editClause(${c.id}, 'active', ${c.active ? 0 : 1})">${c.active ? 'Deactivate' : 'Activate'}</button>
              <button class="btn small red" onclick="deleteClause(${c.id})">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">No clauses yet in this category.</td></tr>'}
      </tbody></table>
      <h4>Add Clause</h4>
      <div class="form-grid">
        <div><label>Label</label><input id="cl-label" placeholder="e.g. Payment Terms"></div>
        <div><label>Sort Order</label><input id="cl-sort" type="number" value="0"></div>
      </div>
      <label>Clause Text</label>
      <textarea id="cl-body" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
      <div style="margin-top:8px;"><button class="btn" onclick="addClause()">Add to Library</button></div>
      <div id="cl-err" class="msg err" style="display:none;margin-top:10px;"></div>
    `) : ''}
    ${pdfTemplate ? collapsiblePanel('offer-pdf-template', 'Offer PDF Template (Optional Override)', `
      <p class="muted">Offers use the built-in letterhead by default. Upload a header, footer and/or cover page image below and check "Active" to override just that piece - anything left unchecked keeps using the default, pixel-matched letterhead. Checking "Active" with no image uploaded (yet) has no effect. For a full custom design, use the Offer PDF Layout Designer instead.</p>
      <table><thead><tr><th>Piece</th><th>Current</th><th>Active</th><th>Upload New</th></tr></thead><tbody>
        ${['header', 'footer', 'cover'].map(piece => `<tr>
          <td style="text-transform:capitalize;">${piece}</td>
          <td>${pdfTemplate[piece + '_image_path'] ? `<img src="${esc(pdfTemplate[piece + '_image_path'])}" style="max-height:40px;max-width:120px;">` : '<span class="muted">Default (built-in)</span>'}</td>
          <td><input type="checkbox" id="pt-${piece}-active" ${pdfTemplate[piece + '_active'] ? 'checked' : ''}></td>
          <td><input type="file" id="pt-${piece}-file" accept="image/*"></td>
        </tr>`).join('')}
      </tbody></table>

      <div style="margin-top:14px;">
        <button class="btn" onclick="savePdfTemplate()">Save Template Settings</button>
        <button class="btn outline" onclick="resetPdfTemplate()">Reset All to Default</button>
      </div>
      <div id="pt-err" class="msg err" style="display:none;margin-top:10px;"></div>
    `) : ''}
    ${governance ? collapsiblePanel('offer-governance', 'Offer Governance', `
      <p class="muted">Compliance kill switches - each is instantly reversible, no code change or redeploy needed.</p>
      <label style="display:block;margin-bottom:8px;"><input type="checkbox" id="gov-lock-on-so" ${governance.lock_on_so_conversion ? 'checked' : ''}>
        Lock an offer against further edits once it's converted to a Sales Order (Admin can still unlock a specific offer from its builder page if needed)</label>
      <label style="display:block;margin-bottom:8px;"><input type="checkbox" id="gov-require-library" ${governance.require_library_clauses ? 'checked' : ''}>
        Require Sales to pick Terms/Inclusions/Exclusions from the clause library below rather than typing their own</label>
      <div style="margin-top:8px;"><button class="btn" onclick="saveOfferGovernance()">Save Governance Settings</button></div>
      <div id="gov-err" class="msg err" style="display:none;margin-top:10px;"></div>
    `) : ''}
    `;
};
window.saveOfferGovernance = async () => {
  const errEl = document.getElementById('gov-err');
  errEl.style.display = 'none';
  try {
    await api('/offers/governance', { method: 'PUT', body: JSON.stringify({
      lock_on_so_conversion: document.getElementById('gov-lock-on-so').checked,
      require_library_clauses: document.getElementById('gov-require-library').checked,
    })});
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.switchOfferOptionsTab = (id) => { OFFER_OPTIONS_TAB = id; navigate('offer-options'); };
window.addOfferOption = async () => {
  try {
    await api('/offers/field-options', { method: 'POST', body: JSON.stringify({ field_name: OFFER_OPTIONS_TAB, value: val('oo-value'), sort_order: val('oo-sort') }) });
    navigate('offer-options');
  } catch (e) { alert(e.message); }
};
window.editOfferOption = async (id, field, value) => {
  try { await api('/offers/field-options/' + id, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); navigate('offer-options'); }
  catch (e) { alert(e.message); navigate('offer-options'); }
};
window.addSectionTitle = async () => {
  const errEl = document.getElementById('stl-err');
  errEl.style.display = 'none';
  try {
    const fd = new FormData();
    fd.append('title', val('stl-title'));
    fd.append('description', val('stl-desc'));
    fd.append('summary', val('stl-summary'));
    const fileInput = document.getElementById('stl-image');
    if (fileInput.files[0]) fd.append('image', fileInput.files[0]);
    await apiUpload('/offers/section-titles', fd, 'POST');
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteSectionTitle = async (id) => {
  if (!confirm('Delete this section title from the library?')) return;
  try { await api('/offers/section-titles/' + id, { method: 'DELETE' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.editSectionTitle = async (id, field, value) => {
  try {
    const fd = new FormData();
    fd.append(field, value);
    await apiUpload('/offers/section-titles/' + id, fd, 'PUT');
    navigate('offer-options');
  } catch (e) { alert(e.message); navigate('offer-options'); }
};
window.replaceSectionTitleImage = async (id, fileInput) => {
  if (!fileInput.files[0]) return;
  try {
    const fd = new FormData();
    fd.append('image', fileInput.files[0]);
    await apiUpload('/offers/section-titles/' + id, fd, 'PUT');
    navigate('offer-options');
  } catch (e) { alert(e.message); }
};
window.approveSectionTitleSuggestion = async (id) => {
  try { await api('/offers/section-title-suggestions/' + id + '/approve', { method: 'POST' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.rejectSectionTitleSuggestion = async (id) => {
  if (!confirm('Reject this suggestion? It will be discarded - the offer item that suggested it is unaffected.')) return;
  try { await api('/offers/section-title-suggestions/' + id + '/reject', { method: 'POST' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.switchClauseLibraryTab = (id) => { CLAUSE_LIBRARY_TAB = id; navigate('offer-options'); };
window.addClause = async () => {
  const errEl = document.getElementById('cl-err');
  errEl.style.display = 'none';
  try {
    await api('/offers/clause-library', { method: 'POST', body: JSON.stringify({
      category: CLAUSE_LIBRARY_TAB, label: val('cl-label'), body: val('cl-body'), sort_order: val('cl-sort'),
    })});
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.editClause = async (id, field, value) => {
  try { await api('/offers/clause-library/' + id, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); navigate('offer-options'); }
  catch (e) { alert(e.message); navigate('offer-options'); }
};
window.deleteClause = async (id) => {
  if (!confirm('Delete this clause from the library?')) return;
  try { await api('/offers/clause-library/' + id, { method: 'DELETE' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.savePdfTemplate = async () => {
  const errEl = document.getElementById('pt-err');
  errEl.style.display = 'none';
  try {
    const fd = new FormData();
    ['header', 'footer', 'cover'].forEach(piece => {
      fd.append(piece + '_active', document.getElementById(`pt-${piece}-active`).checked);
      const fileEl = document.getElementById(`pt-${piece}-file`);
      if (fileEl.files[0]) fd.append(piece + '_image', fileEl.files[0]);
    });
    await apiUpload('/offers/pdf-template', fd, 'POST');
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.resetPdfTemplate = async () => {
  if (!confirm('Reset the Offer PDF template to the default letterhead? This removes any uploaded header/footer/cover images.')) return;
  try { await api('/offers/pdf-template', { method: 'DELETE' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};

// ===================== Offer PDF Layout Designer (GrapesJS) =====================
// Visual header/footer/cover-page builder backing routes/offers.js's
// /offers/pdf-layout endpoints (see lib/settings.js for storage). GrapesJS
// and its webpage preset are heavy and only needed on this one page, so
// they're loaded lazily (see loadOfferPdfDesignerAssets) rather than in
// index.html's <head>.
//
// Keep this token list in sync with lib/offerPdf.js's mergeTokenMap - an
// unrecognized {{token}} is left as literal text in the rendered PDF rather
// than silently disappearing, so this is the one true list admins should
// pick from instead of typing tokens by hand.
const PDF_DESIGNER_TOKENS = [
  'client.name', 'offer.no', 'offer.subject', 'offer.date', 'offer.version',
  'offer.application', 'offer.type_of_system', 'offer.material_of_construction',
  'company.legal_name', 'company.registered_address', 'company.gstin', 'company.pan',
];
// width/height approximate real print dimensions at 96dpi (A4 width, and the
// PDF's actual top/bottom margins for header/footer) so proportions look
// right while designing - see setDevice('PDF') in initOfferPdfDesignerTab.
// smallText mirrors the fact that Puppeteer's header/footer template
// rendering context (NOT the cover, which renders as part of the normal PDF
// body flow) doesn't inherit the page's CSS at all - lib/offerPdf.js wraps
// designed header/footer content in a 10px Arial default so it isn't
// invisible in the actual PDF, so the canvas should default to roughly the
// same thing while designing.
const PDF_DESIGNER_PIECES = [
  { id: 'header', label: 'Header', width: 794, height: 110, smallText: true },
  { id: 'footer', label: 'Footer', width: 794, height: 98, smallText: true },
  { id: 'cover', label: 'Cover Page', width: 794, height: 1123, smallText: false },
];
let PDF_DESIGNER_TAB = 'header';
let PDF_DESIGNER_LAYOUT = null; // { header, footer, cover }, each { active, html, css, project }
let PDF_DESIGNER_EDITORS = {}; // piece id -> live grapesjs Editor instance for this page visit
let PDF_DESIGNER_ASSETS_PROMISE = null; // guards against loading the vendor <script>/<link> tags twice

function loadOfferPdfDesignerAssets() {
  if (PDF_DESIGNER_ASSETS_PROMISE) return PDF_DESIGNER_ASSETS_PROMISE;
  PDF_DESIGNER_ASSETS_PROMISE = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/vendor/grapesjs/css/grapes.min.css';
    document.head.appendChild(link);
    const gjsScript = document.createElement('script');
    gjsScript.src = '/vendor/grapesjs/grapes.min.js';
    gjsScript.onload = () => {
      const presetScript = document.createElement('script');
      presetScript.src = '/vendor/grapesjs-preset-webpage/index.js';
      presetScript.onload = () => {
        // grapesjs-preset-webpage's own default block set is just Link/Quote/
        // Text (3 blocks total) - this adds Image and 1/2/3-column layout
        // blocks, the actual capability a header/footer/cover designer needs
        // (e.g. a logo image beside company text in two columns).
        const blocksScript = document.createElement('script');
        blocksScript.src = '/vendor/grapesjs-blocks-basic/index.js';
        blocksScript.onload = () => resolve();
        blocksScript.onerror = () => reject(new Error('Failed to load the GrapesJS basic blocks plugin.'));
        document.head.appendChild(blocksScript);
      };
      presetScript.onerror = () => reject(new Error('Failed to load the GrapesJS webpage preset.'));
      document.head.appendChild(presetScript);
    };
    gjsScript.onerror = () => reject(new Error('Failed to load GrapesJS.'));
    document.head.appendChild(gjsScript);
  });
  return PDF_DESIGNER_ASSETS_PROMISE;
}

function renderOfferPdfDesignerPanel(piece) {
  const data = (PDF_DESIGNER_LAYOUT && PDF_DESIGNER_LAYOUT[piece.id]) || { active: false };
  return `
  <div class="pdfd-panel" data-piece="${piece.id}" style="${PDF_DESIGNER_TAB === piece.id ? '' : 'display:none;'}">
    <label style="display:block;margin-bottom:10px;">
      <input type="checkbox" id="pdfd-active-${piece.id}" ${data.active ? 'checked' : ''}>
      Active (use this designed ${esc(piece.label.toLowerCase())} on offer PDFs instead of the built-in default)
    </label>
    <div class="pdfd-body">
      <div class="pdfd-canvas-col">
        <div class="pdfd-gjs-wrap"><div id="pdfd-canvas-${piece.id}"></div></div>
      </div>
      <div class="pdfd-side">
        <h4 style="margin-top:0;">Merge Fields</h4>
        <p class="muted" style="font-size:12px;">Select an element on the canvas, then click a field to insert it there. With nothing selected, it's copied to the clipboard instead.</p>
        <div class="pdfd-tokens">
          ${PDF_DESIGNER_TOKENS.map(t => `<button type="button" class="pdfd-token-btn" onclick="insertOfferPdfDesignerToken('${piece.id}','${t}')">{{${t}}}</button>`).join('')}
        </div>
        <div style="margin-top:16px;">
          <button class="btn" onclick="saveOfferPdfDesignerPiece('${piece.id}')">Save ${esc(piece.label)}</button><br>
          ${piece.id !== 'cover' ? `<button class="btn outline" onclick="previewOfferPdfDesignerFullPage('${piece.id}')" style="margin-top:8px;">Preview in Full Page</button><br>` : ''}
          <button class="btn outline" onclick="resetOfferPdfDesignerPiece('${piece.id}')" style="margin-top:8px;">Reset ${esc(piece.label)}</button>
        </div>
        <div id="pdfd-err-${piece.id}" class="msg err" style="display:none;margin-top:10px;"></div>
        <div id="pdfd-ok-${piece.id}" class="msg ok" style="display:none;margin-top:10px;"></div>
      </div>
    </div>
  </div>`;
}

PAGES['offer-pdf-designer'] = async (el) => {
  if (ME.role !== 'Admin') {
    el.innerHTML = `<div class="panel"><p class="muted">This page is only available to Admins.</p></div>`;
    return;
  }
  // Tear down any editors left over from a previous visit to this page in
  // this session - the containers below are about to be recreated, so their
  // old iframes/listeners would otherwise just leak.
  Object.values(PDF_DESIGNER_EDITORS).forEach(ed => { try { ed.destroy(); } catch (e) {} });
  PDF_DESIGNER_EDITORS = {};
  PDF_DESIGNER_LAYOUT = await api('/offers/pdf-layout');
  el.innerHTML = `
    <div class="panel">
      <h3>Offer PDF Layout Designer</h3>
      <p class="muted">Design the offer PDF's header, footer and cover page visually. Each piece can be toggled active independently - leaving a piece inactive keeps the existing built-in default for it. Changes here only apply once you click that piece's Save button.</p>
      <div class="tabs">
        ${PDF_DESIGNER_PIECES.map(p => `<div class="tab pdfd-tab ${PDF_DESIGNER_TAB === p.id ? 'active' : ''}" data-tab="${p.id}" onclick="switchOfferPdfDesignerTab('${p.id}')">${esc(p.label)}</div>`).join('')}
      </div>
      ${PDF_DESIGNER_PIECES.map(p => renderOfferPdfDesignerPanel(p)).join('')}
    </div>`;
  await loadOfferPdfDesignerAssets();
  initOfferPdfDesignerTab(PDF_DESIGNER_TAB);
};

// GrapesJS canvases need to be visible/sized to lay themselves out
// correctly, so each tab's editor is only created the first time that tab
// is actually switched to (or, for the initial tab, right after this page's
// markup lands in the DOM) - not eagerly for all three up front.
async function initOfferPdfDesignerTab(pieceId) {
  if (PDF_DESIGNER_EDITORS[pieceId]) return; // already mounted this page visit - don't recreate and lose in-progress edits
  await loadOfferPdfDesignerAssets();
  const pieceCfg = PDF_DESIGNER_PIECES.find(p => p.id === pieceId);
  const data = (PDF_DESIGNER_LAYOUT && PDF_DESIGNER_LAYOUT[pieceId]) || {};
  const editor = grapesjs.init({
    container: '#pdfd-canvas-' + pieceId,
    height: pieceId === 'cover' ? '760px' : '340px',
    width: 'auto',
    fromElement: false,
    storageManager: false,
    plugins: ['grapesjs-preset-webpage', 'gjs-blocks-basic'],
    pluginsOpts: {
      'grapesjs-preset-webpage': {},
      // video/map are excluded - neither renders meaningfully in a static
      // printed PDF, so they'd just be dead weight in the block list.
      'gjs-blocks-basic': { blocks: ['column1', 'column2', 'column3', 'text', 'image', 'link'] },
    },
    deviceManager: {
      devices: [
        { id: 'pdf-' + pieceId, name: 'PDF', width: pieceCfg.width + 'px', height: pieceCfg.height + 'px' },
      ],
    },
  });
  try { editor.setDevice('PDF'); } catch (e) { /* non-fatal - editor still usable at its default device */ }
  // Style Manager's "Dimension" sector (margin/padding/width/height) starts
  // collapsed by default and is easy to miss behind a generic accordion
  // label - spacing is the single most-needed control when laying out a
  // header/footer, so auto-open it whenever something gets selected.
  editor.on('component:selected', () => {
    try {
      const dim = editor.StyleManager.getSector('dimension');
      if (dim) dim.set('open', true);
    } catch (e) { /* non-fatal - Style Manager still usable, just collapsed */ }
  });
  if (pieceCfg.smallText) {
    // Puppeteer's header/footer template context doesn't inherit the page's
    // CSS at all (see lib/offerPdf.js) - approximate its 10px Arial default
    // here too, so what's designed isn't wildly bigger than the real PDF.
    editor.on('load', () => {
      const doc = editor.Canvas.getDocument();
      if (!doc || !doc.body) return;
      doc.body.style.fontSize = '10px';
      doc.body.style.fontFamily = 'Arial, sans-serif';
      if (!doc.getElementById('pdfd-base-style')) {
        const style = doc.createElement('style');
        style.id = 'pdfd-base-style';
        style.textContent = 'body{font-size:10px;font-family:Arial,sans-serif;}';
        doc.head.appendChild(style);
      }
    });
  }
  if (data.project) {
    try { editor.loadProjectData(data.project); }
    catch (e) { console.error('offer-pdf-designer: failed to load saved project data for ' + pieceId, e); }
  }
  PDF_DESIGNER_EDITORS[pieceId] = editor;
}

window.switchOfferPdfDesignerTab = (id) => {
  if (PDF_DESIGNER_TAB === id) return;
  PDF_DESIGNER_TAB = id;
  document.querySelectorAll('.pdfd-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('.pdfd-panel').forEach(p => { p.style.display = p.dataset.piece === id ? '' : 'none'; });
  initOfferPdfDesignerTab(id);
};

function offerPdfDesignerToast(pieceId, msg, isErr) {
  const okEl = document.getElementById('pdfd-ok-' + pieceId);
  const errEl = document.getElementById('pdfd-err-' + pieceId);
  if (isErr) {
    if (okEl) okEl.style.display = 'none';
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  } else {
    if (errEl) errEl.style.display = 'none';
    if (okEl) { okEl.textContent = msg; okEl.style.display = 'block'; }
  }
}

window.insertOfferPdfDesignerToken = (pieceId, token) => {
  const text = '{{' + token + '}}';
  const editor = PDF_DESIGNER_EDITORS[pieceId];
  const selected = editor && editor.getSelected();
  if (selected) {
    try {
      selected.append(text);
      offerPdfDesignerToast(pieceId, 'Inserted ' + text + ' into the selected element.');
      return;
    } catch (e) { /* fall through to clipboard */ }
  }
  const copied = () => offerPdfDesignerToast(pieceId, 'Copied ' + text + ' to the clipboard - select a text element on the canvas first, or paste it in now.');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(copied).catch(() => alert('Merge field: ' + text));
  } else {
    alert('Merge field: ' + text);
  }
};

window.saveOfferPdfDesignerPiece = async (pieceId) => {
  const editor = PDF_DESIGNER_EDITORS[pieceId];
  if (!editor) { offerPdfDesignerToast(pieceId, 'Editor is not ready yet - try again in a moment.', true); return; }
  try {
    const html = editor.getHtml();
    const css = editor.getCss() || '';
    const project = editor.getProjectData();
    const active = document.getElementById('pdfd-active-' + pieceId).checked;
    // The endpoint returns the FULL {header,footer,cover} layout (matching
    // GET), not just this one piece - replace the whole cached copy, don't
    // nest it under pieceId.
    PDF_DESIGNER_LAYOUT = await api('/offers/pdf-layout/' + pieceId, {
      method: 'PUT',
      body: JSON.stringify({ active, html, css, project }),
    });
    offerPdfDesignerToast(pieceId, 'Saved.');
  } catch (e) { offerPdfDesignerToast(pieceId, e.message, true); }
};

// Shows the designed header/footer inside a full A4 page mockup, at the
// exact proportions generateOfferPdf() actually renders at (page.pdf()'s
// margin: top 30mm, bottom 26mm, left/right 15mm - lib/offerPdf.js). The
// isolated per-piece canvas above only ever shows the header/footer's own
// small strip, which was the whole complaint: no way to see how it sits
// against real body content or the page's other margins. Unlike the body,
// a designed header/footer spans the FULL page width with no left/right
// inset (see headerTemplate()/footerTemplate()'s Layout-Designer branch,
// which wraps designed html with no margin, vs the built-in default's own
// `margin:0 15mm`) - so this mockup deliberately does NOT inset the piece
// being previewed, only the placeholder body text, to show that difference
// rather than hide it.
window.previewOfferPdfDesignerFullPage = (pieceId) => {
  const editor = PDF_DESIGNER_EDITORS[pieceId];
  if (!editor) { offerPdfDesignerToast(pieceId, 'Editor is not ready yet - try again in a moment.', true); return; }
  const html = editor.getHtml();
  const css = editor.getCss() || '';
  const otherId = pieceId === 'header' ? 'footer' : 'header';
  const otherLabel = pieceId === 'header' ? 'Footer' : 'Header';
  const pieceLabel = pieceId === 'header' ? 'Header' : 'Footer';
  const placeholderBody = `
    <h2 style="font-size:14px;text-decoration:underline;margin:0 0 10px;">Sample Section Title</h2>
    <p style="margin:0 0 10px;">This placeholder text stands in for the offer's actual body content (Company Profile, Project Data Sheet, Scope Of Supply, etc.) so you can see how much room is left between the ${pieceLabel.toLowerCase()} and the rest of the page.</p>
    <p style="margin:0 0 10px;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>
    <p style="margin:0;">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>`;
  const otherPlaceholder = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px;font-family:Arial,sans-serif;border:1px dashed #ccc;box-sizing:border-box;">${esc(otherLabel)} area (design it on the ${esc(otherLabel)} tab to see it here too)</div>`;
  const headerContent = pieceId === 'header' ? `<style>${css}</style><div style="font-size:10px;font-family:Arial,sans-serif;">${html}</div>` : otherPlaceholder;
  const footerContent = pieceId === 'footer' ? `<style>${css}</style><div style="font-size:10px;font-family:Arial,sans-serif;">${html}</div>` : otherPlaceholder;
  const pageMockup = `
    <div style="width:210mm;min-height:297mm;background:#fff;margin:20px auto;box-shadow:0 0 12px rgba(0,0,0,.25);position:relative;overflow:hidden;font-family:Arial,sans-serif;">
      <div style="position:absolute;top:0;left:0;right:0;height:30mm;box-sizing:border-box;overflow:hidden;border-bottom:1px dotted #c00;">${headerContent}</div>
      <div style="position:absolute;top:30mm;bottom:26mm;left:15mm;right:15mm;box-sizing:border-box;overflow:hidden;">${placeholderBody}</div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:26mm;box-sizing:border-box;overflow:hidden;border-top:1px dotted #c00;">${footerContent}</div>
    </div>`;
  const bodyHTML = `
    <p class="muted" style="font-size:12px;">Actual A4 proportions (210mm x 297mm) at the real page margins this offer PDF prints with. The dotted red lines mark where the header/footer strip ends and the body's own margin begins - notice the header/footer span the full page width, while body text is inset 15mm on each side.</p>
    <div style="max-height:75vh;overflow:auto;background:#eee;padding:12px;border-radius:6px;">${pageMockup}</div>`;
  openMiniModal(pieceLabel + ' - Full Page Preview', bodyHTML, 860);
};

window.resetOfferPdfDesignerPiece = async (pieceId) => {
  if (!confirm('Reset this ' + pieceId + ' back to blank/inactive? This discards its saved design and cannot be undone.')) return;
  try {
    await api('/offers/pdf-layout/' + pieceId, { method: 'DELETE' });
    navigate('offer-pdf-designer');
  } catch (e) { alert(e.message); }
};

// ---- Bank Guarantee Dashboard (Round 16) ----
PAGES['bg-dashboard'] = async (el) => {
  const showReleased = !!window.BG_INCLUDE_RELEASED;
  const [summary, bgs, reminders, orders, pendingChanges] = await Promise.all([
    api('/bg/summary'), api('/bg' + (showReleased ? '?all=1' : '')), api('/bg/reminders?status=PendingReview'), api('/bg/orders'),
    api('/bg/pending-changes').catch(() => []),
  ]);
  const verified = await api('/bg/reminders?status=Verified');
  window.__BG_ORDERS = orders;
  BG_CURRENT_FILTER = '';
  el.innerHTML = `
    <div class="cards">
      <div class="card"><div class="num">${summary.live_count}</div><div class="label">Live Bank Guarantees</div></div>
      <div class="card"><div class="num">₹${fmt(summary.live_value)}</div><div class="label">Total Live Value</div></div>
      <div class="card"><div class="num">${summary.expiring_30d}</div><div class="label">Expiring in 30 Days</div></div>
      <div class="card"><div class="num">${summary.pending_reminders}</div><div class="label">Pending Reminders</div></div>
      <div class="card"><div class="num">${summary.claim_expiry_alerts}</div><div class="label">Claim Expiry Alerts (7-day)</div></div>
      <div class="card"><div class="num">${summary.claim_compliance_rate === null ? '-' : summary.claim_compliance_rate + '%'}</div><div class="label">Claim Task On-Time Rate</div></div>
    </div>

    ${summary.finance_todos && summary.finance_todos.length ? `
    ${collapsiblePanel('bg-claim-tasks', 'Finance Team - Claim Filing Tasks', `
      <p class="muted">High-priority To-Dos auto-raised for the Finance HOD when a BG's claim-filing deadline is 7 days out - full detail and status updates on the To-Do List page.</p>
      ${tableHTML(['Task', 'Assigned To', 'Target Date', 'Status'], summary.finance_todos, t => `
        <tr><td>${esc(t.brief_description)}</td><td>${esc(t.assigned_to_name)}</td><td>${deliveryBadge(t.target_date)}</td><td>${badge(t.status)}</td></tr>`)}
    `)}` : ''}

    ${(reminders.length || verified.length) ? `
    ${collapsiblePanel('bg-pending-reminders', 'Pending Reminders', `
      ${tableHTML(['BG No', 'Type', 'Value', 'Expiry', 'Reason', 'Step', 'Action'], [...reminders, ...verified], r => `
        <tr><td>${esc(r.bg_no || '#'+r.bg_id)}</td><td>${esc(r.bg_type)}</td><td>₹${fmt(r.value)}</td><td>${esc(r.validity_expiry)}</td><td>${esc(r.trigger_reason)}</td>
        <td>${badge(r.status)}</td>
        <td>
          ${r.status === 'PendingReview' ? `<button class="btn small" onclick="verifyBGReminder(${r.id})">Verify</button>` : ''}
          ${r.status === 'Verified' ? `<button class="btn small green" onclick="sendBGReminderEmail(${r.id})">Send Reminder Email</button>` : ''}
          <button class="btn small outline" onclick="dismissBGReminder(${r.id})">Dismiss</button>
        </td></tr>`)}
    `)}` : ''}

    ${pendingChanges.length ? `<div class="panel"><h3>Pending BG Changes (${pendingChanges.length})</h3>
      <p class="muted">An edit or delete requested by a non-Admin doesn't take effect until an Admin approves it here, so nothing changes underneath a reminder or claim-filing workflow already in flight.</p>
      ${tableHTML(['BG No', 'Change', 'Details', 'Requested By', ''], pendingChanges, c => `
        <tr><td>${esc(c.bg_no || '#' + c.bg_id)}</td><td>${badge(c.change_type)}</td>
        <td>${c.change_type === 'Edit' ? esc(Object.entries(JSON.parse(c.proposed_fields||'{}')).map(([k,v]) => `${k}: ${v}`).join(', ')) : '<span class="muted">Delete this Bank Guarantee</span>'}</td>
        <td>${esc(c.requested_by_name)||'-'}</td>
        <td>${ME.role === 'Admin' ? `<button class="btn small" type="button" onclick="approveBGChange(${c.id})">Approve</button>
          <button class="btn small outline" type="button" onclick="rejectBGChange(${c.id})">Reject</button>` : '<span class="muted">Awaiting Admin</span>'}</td></tr>`)}
    </div>` : ''}

    <div class="panel"><h3>Add Bank Guarantee</h3>
      <div class="form-grid">
        <div><label>BG No</label><input id="bg-no"></div>
        <div><label>Type</label><select id="bg-type"><option value="Advance">Advance</option><option value="Performance">Performance</option></select></div>
        <div><label>Order</label><select id="bg-order">${orders.map(o => `<option value="${o.order_type}:${o.order_id}">[${o.order_type}] ${esc(o.label)}</option>`).join('')}</select></div>
        <div><label>Issuing Bank</label><input id="bg-bank"></div>
        <div><label>Value (₹)</label><input id="bg-value" type="number"></div>
        <div><label>Issue Date</label><input id="bg-issue" type="date"></div>
        <div><label>Validity Expiry</label><input id="bg-expiry" type="date"></div>
        <div><label>Claim Expiry (optional)</label><input id="bg-claim" type="date"></div>
        <div><label>Scanned Copy (optional)</label><input id="bg-scan-file" type="file" accept="image/*,.pdf"></div>
      </div>
      <div><label>Release Condition / Milestone Link</label><textarea id="bg-milestone" rows="2" style="width:100%;" placeholder="e.g. release on final acceptance / installation completion"></textarea></div>
      <button class="btn" onclick="addBG()">Add Bank Guarantee</button>
    </div>

    ${collapsiblePanel('bg-list', `List of Bank Guarantees (${bgs.length})`, `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div class="tabs" id="bg-tabs">
          <div class="tab active" onclick="filterBGTab(this,'')">All</div>
          <div class="tab" onclick="filterBGTab(this,'Advance')">Advance</div>
          <div class="tab" onclick="filterBGTab(this,'Performance')">Performance</div>
          <div class="tab" onclick="filterBGTab(this,'PendingRelease')">Pending Release</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <label style="margin:0;font-weight:normal;"><input type="checkbox" id="bg-show-released" ${showReleased ? 'checked' : ''} onchange="toggleBGShowReleased(this.checked)"> Show Released</label>
          <button class="btn small outline" type="button" onclick="openBGColumnPicker()">Customize Columns</button>
          ${ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="exportBGAttachments()" title="Downloads a small .tar.gz of every BG scanned-document row and file - for migrating BG attachments to another server without a full DB backup.">Export BG Attachments</button>` : ''}
        </div>
      </div>
      ${!showReleased ? `<p class="muted" style="margin-top:8px;">Showing live Bank Guarantees only (Active / Pending Release). Check "Show Released" above to include closed ones.</p>` : ''}
      <div id="bg-table-wrap">${bgTableHTML(bgs)}</div>
    `)}`;
  window.__BG_ALL = bgs;
};
// ---- BG Dashboard: user-customizable columns ----
// Each entry maps a toggleable column to the field(s) it reads off a `bg`
// row (already available from GET /bg's bg.* + the resolved order_label/
// beneficiary - no backend change needed for any of these, including
// "Customer/Vendor Name": beneficiary is already populated at BG-creation
// time from the linked SO/PO's party). Documents/Action stay fixed - they're
// controls, not data attributes, so they're not part of the toggle set.
const BG_COLUMN_REGISTRY = [
  { key: 'bg_no', label: 'BG No', default: true, render: bg => esc(bg.bg_no || '#' + bg.id) },
  { key: 'bg_type', label: 'Type', default: true, render: bg => esc(bg.bg_type) },
  { key: 'order', label: 'Order', default: true, render: bg => `[${esc(bg.order_type)}] ${esc(bg.order_label || '')}` },
  { key: 'beneficiary', label: 'Customer / Vendor Name', default: false, render: bg => esc(bg.beneficiary || bg.order_label || '-') },
  { key: 'issuing_bank', label: 'Issuing Bank', default: true, render: bg => esc(bg.issuing_bank || '-') },
  { key: 'value', label: 'Value', default: true, render: bg => '₹' + fmt(bg.value) },
  { key: 'issue_date', label: 'Issue Date', default: false, render: bg => esc(bg.issue_date || '-') },
  { key: 'validity_expiry', label: 'Validity Expiry', default: true, render: bg => deliveryBadge(bg.validity_expiry) },
  { key: 'claim_expiry', label: 'Claim Expiry', default: false, render: bg => esc(bg.claim_expiry || '-') },
  { key: 'project', label: 'Project', default: false, render: bg => esc(bg.project_code || '-') },
  { key: 'milestone_link', label: 'Release Condition', default: false, render: bg => esc(bg.milestone_link || '-') },
  { key: 'status', label: 'Status', default: true, render: bg => badge(bg.status) },
];
const BG_COLUMNS_STORAGE_KEY = 'erp_bg_dashboard_columns';
// Client-side only (per-browser, via localStorage) - same convention as the
// dashboard's pinned-metrics picker (loadDashboardMetricKeys above): a
// per-viewer display preference has no reason to live server-side or be
// shared across users.
function loadBGColumnKeys() {
  try {
    const saved = JSON.parse(localStorage.getItem(BG_COLUMNS_STORAGE_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) return saved.filter(k => BG_COLUMN_REGISTRY.some(c => c.key === k));
  } catch (e) {}
  return BG_COLUMN_REGISTRY.filter(c => c.default).map(c => c.key);
}
function saveBGColumnKeys(keys) {
  try { localStorage.setItem(BG_COLUMNS_STORAGE_KEY, JSON.stringify(keys)); } catch (e) {}
}
function bgTableHTML(bgs) {
  const activeKeys = loadBGColumnKeys();
  // Registry order, not selection order, so re-checking a box always puts
  // the column back where it was rather than at the end.
  const cols = BG_COLUMN_REGISTRY.filter(c => activeKeys.includes(c.key));
  const headers = [...cols.map(c => c.label), 'Documents', 'Action'];
  return tableHTML(headers, bgs, bg => `
    <tr>${cols.map(c => `<td>${c.render(bg)}</td>`).join('')}
    <td><button class="btn small outline" type="button" onclick="toggleBGAttachments(${bg.id})">Scanned Copy</button></td>
    <td>
      ${bg.status !== 'Released' ? `<button class="btn small outline" onclick="releaseBG(${bg.id})">Mark Released</button>` : ''}
      ${bg.status !== 'Released' ? `<button class="btn small outline" onclick="openEditBG(${bg.id})">Edit</button>` : ''}
      <button class="btn small outline" onclick="deleteBG(${bg.id})">Delete</button>
    </td></tr>
    <tr id="bg-att-row-${bg.id}" style="display:none;"><td colspan="${headers.length}"><div id="bg-attachments-${bg.id}"></div></td></tr>`);
}
window.openBGColumnPicker = () => {
  const activeKeys = loadBGColumnKeys();
  const body = `
    <p class="muted">Choose which columns show in the Bank Guarantee table below. Your choice is remembered on this browser.</p>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${BG_COLUMN_REGISTRY.map(c => `<label style="margin:0;font-weight:normal;">
        <input type="checkbox" value="${c.key}" ${activeKeys.includes(c.key) ? 'checked' : ''} onchange="toggleBGColumn('${c.key}', this.checked)"> ${esc(c.label)}
      </label>`).join('')}
    </div>
    <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;">
      <button class="btn small outline" type="button" onclick="resetBGColumns()">Reset to Default</button>
    </div>`;
  openMiniModal('Customize Columns', body);
};
window.toggleBGColumn = (key, checked) => {
  const keys = loadBGColumnKeys();
  if (checked && !keys.includes(key)) keys.push(key);
  if (!checked) { const i = keys.indexOf(key); if (i !== -1) keys.splice(i, 1); }
  // At least one data column must stay visible, or the table would render
  // with nothing but the Documents/Action controls.
  if (!keys.length) { alert('At least one column must stay visible.'); openBGColumnPicker(); return; }
  saveBGColumnKeys(keys);
  filterBGTab(document.querySelector('#bg-tabs .tab.active'), BG_CURRENT_FILTER);
};
window.resetBGColumns = () => {
  try { localStorage.removeItem(BG_COLUMNS_STORAGE_KEY); } catch (e) {}
  closeMiniModal();
  filterBGTab(document.querySelector('#bg-tabs .tab.active'), BG_CURRENT_FILTER);
};
window.toggleBGAttachments = (id) => {
  const row = document.getElementById(`bg-att-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderAttachmentsWidget('bank_guarantee', id, document.getElementById(`bg-attachments-${id}`));
};
window.toggleBGShowReleased = (checked) => {
  window.BG_INCLUDE_RELEASED = checked;
  navigate('bg-dashboard');
};
window.exportBGAttachments = () => {
  downloadTemplateFile('/bg/export-attachments', 'bg-attachments-export.tar.gz');
};
let BG_CURRENT_FILTER = '';
window.filterBGTab = (tabEl, filter) => {
  BG_CURRENT_FILTER = filter;
  document.querySelectorAll('#bg-tabs .tab').forEach(t => t.classList.remove('active'));
  if (tabEl) tabEl.classList.add('active');
  const all = window.__BG_ALL || [];
  const filtered = !filter ? all : (filter === 'PendingRelease' ? all.filter(b => b.status === 'PendingRelease') : all.filter(b => b.bg_type === filter));
  document.getElementById('bg-table-wrap').innerHTML = bgTableHTML(filtered);
};
window.addBG = async () => {
  const orderSel = val('bg-order');
  if (!orderSel) { alert('No open SO/PO to attach this BG to.'); return; }
  const [order_type, order_id] = orderSel.split(':');
  try {
    const r = await api('/bg', { method: 'POST', body: JSON.stringify({
      bg_no: val('bg-no'), bg_type: val('bg-type'), order_type, order_id,
      issuing_bank: val('bg-bank'), value: val('bg-value'), issue_date: val('bg-issue'),
      validity_expiry: val('bg-expiry'), claim_expiry: val('bg-claim'), milestone_link: val('bg-milestone'),
    })});
    // The BG record needs to exist before a file can be attached to it (the
    // generic attachments table is keyed by entity id) - so this uploads
    // right after creation instead of making it a separate manual step,
    // same as-you-go feel as filling in the rest of the form. Extra/later
    // scans (a renewal, an extension letter) still go through the
    // dashboard's own "Scanned Copy" toggle on that row.
    const scanFile = document.getElementById('bg-scan-file');
    if (scanFile.files[0]) {
      const fd = new FormData();
      fd.append('file', scanFile.files[0]);
      await apiUpload(`/attachments/bank_guarantee/${r.id}`, fd, 'POST');
    }
    navigate('bg-dashboard');
  } catch (e) { alert(e.message); }
};
window.releaseBG = async (id) => {
  if (!confirm('Mark this Bank Guarantee as Released?')) return;
  try {
    await api(`/bg/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Released' }) });
    navigate('bg-dashboard');
  } catch (e) { alert(e.message); }
};
// Editing/deleting a BG is approval-gated for anyone but Admin (see
// routes/bankGuarantees.js) - the form itself is identical either way,
// only the resulting message differs (applied immediately vs. queued).
window.openEditBG = (id) => {
  const bg = (window.__BG_ALL || []).find(b => b.id === id);
  if (!bg) return;
  const body = `
    <div class="form-grid">
      <div><label>BG No</label><input id="ebg-no" value="${esc(bg.bg_no)}"></div>
      <div><label>Issuing Bank</label><input id="ebg-bank" value="${esc(bg.issuing_bank)}"></div>
      <div><label>Value (₹)</label><input id="ebg-value" type="number" value="${bg.value}"></div>
      <div><label>Issue Date</label><input id="ebg-issue" type="date" value="${esc(bg.issue_date)}"></div>
      <div><label>Validity Expiry</label><input id="ebg-expiry" type="date" value="${esc(bg.validity_expiry)}"></div>
      <div><label>Claim Expiry</label><input id="ebg-claim" type="date" value="${esc(bg.claim_expiry)}"></div>
    </div>
    <label>Release Condition / Milestone Link</label>
    <textarea id="ebg-milestone" rows="2" style="width:100%;">${esc(bg.milestone_link)}</textarea>
    <div style="margin-top:10px;">
      <button class="btn" type="button" onclick="saveEditBG(${id})">Save Changes</button>
      <button class="btn outline" type="button" onclick="closeMiniModal()">Cancel</button>
    </div>
    <div class="muted" style="margin-top:8px;">${ME.role === 'Admin' ? 'As Admin, this applies immediately.' : "This won't take effect until an Admin approves it - see Pending BG Changes above."}</div>
    <div id="ebg-err" class="msg err" style="display:none;margin-top:8px;"></div>`;
  openMiniModal('Edit Bank Guarantee', body);
};
window.saveEditBG = async (id) => {
  const errEl = document.getElementById('ebg-err');
  try {
    const r = await api('/bg/' + id, { method: 'PUT', body: JSON.stringify({
      bg_no: val('ebg-no'), issuing_bank: val('ebg-bank'), value: val('ebg-value'),
      issue_date: val('ebg-issue'), validity_expiry: val('ebg-expiry'), claim_expiry: val('ebg-claim'),
      milestone_link: val('ebg-milestone'),
    })});
    closeMiniModal();
    if (r.message) alert(r.message);
    navigate('bg-dashboard');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteBG = async (id) => {
  if (!confirm('Delete this Bank Guarantee? This is only allowed while it has no reminder/claim activity on file.')) return;
  try {
    const r = await api('/bg/' + id, { method: 'DELETE' });
    if (r.message) alert(r.message);
    navigate('bg-dashboard');
  } catch (e) { alert(e.message); }
};
window.approveBGChange = async (id) => {
  try { await api('/bg/pending-changes/' + id + '/approve', { method: 'POST' }); navigate('bg-dashboard'); }
  catch (e) { alert(e.message); }
};
window.rejectBGChange = async (id) => {
  const review_note = prompt('Reason for rejecting (optional):') || '';
  try { await api('/bg/pending-changes/' + id + '/reject', { method: 'POST', body: JSON.stringify({ review_note }) }); navigate('bg-dashboard'); }
  catch (e) { alert(e.message); }
};
window.verifyBGReminder = async (id) => {
  try {
    await api(`/bg/reminders/${id}/verify`, { method: 'POST' });
    navigate('bg-dashboard');
  } catch (e) { alert(e.message); }
};
window.sendBGReminderEmail = async (id) => {
  try {
    const r = await api(`/bg/reminders/${id}/send-email`, { method: 'POST' });
    if (r.sent) alert(`Reminder emailed to ${r.to}`);
    else alert(r.message || 'Email not sent.');
    navigate('bg-dashboard');
  } catch (e) { alert(e.message); }
};
window.dismissBGReminder = async (id) => {
  try {
    await api(`/bg/reminders/${id}/dismiss`, { method: 'POST' });
    navigate('bg-dashboard');
  } catch (e) { alert(e.message); }
};

// ---- Foreign Payments (Advance Remittance Against Imports) ----
// Field groups mirror the ARIM form's own sections (see db/schema.sql and
// routes/foreignPayments.js's HEADER_FIELDS, which this list's flattened
// field names must match exactly - id/status/approval_id/created_by/
// created_at/vendor_id and the post-payment fields are handled separately).
const FP_DOCUMENT_TYPES = ['PaymentAdvice', 'BillOfEntry', 'BillOfLading', 'VendorInvoice', 'ProformaInvoice', 'Other'];
const FP_FIELD_GROUPS = [
  { title: 'For Office Use (Bank)', fields: [
    ['ad_code', 'AD Code'], ['bank_name', 'Bank Name'], ['branch', 'Branch'], ['bank_form_no', 'Bank Form No'],
    ['customer_id', 'Customer ID'], ['transaction_type', 'Transaction Type (TT/DD)'], ['tr_fwc_amount', 'TR/FWC Amount'],
    ['tr_fwc_rate', 'TR/FWC Rate'], ['tr_fwc_ref_no', 'TR/FWC Ref No'], ['equivalent_inr', 'Equivalent INR (for approval routing)'],
  ]},
  { title: 'Currency & Amount', fields: [['currency', 'Currency*'], ['amount', 'Amount*']] },
  { title: 'Beneficiary', fields: [
    ['beneficiary_name', 'Name*'], ['beneficiary_address_line1', 'Address Line 1'], ['beneficiary_address_line2', 'Address Line 2'],
    ['beneficiary_pincode', 'Pincode'], ['beneficiary_city', 'City'], ['beneficiary_state', 'State'], ['beneficiary_country', 'Country'],
  ]},
  { title: 'Beneficiary Bank', fields: [
    ['beneficiary_bank_name', 'Bank Name'], ['beneficiary_bank_address_line1', 'Address Line 1'], ['beneficiary_bank_address_line2', 'Address Line 2'],
    ['beneficiary_bank_pincode', 'Pincode'], ['beneficiary_bank_city', 'City'], ['beneficiary_bank_state', 'State'], ['beneficiary_bank_country', 'Country'],
    ['beneficiary_bank_swift_code', 'SWIFT Code'], ['beneficiary_bank_account_no', 'Account No'],
    ['iban_sort_code_bsb_transit', 'IBAN / Sort Code / BSB / Transit'], ['correspondent_bank_name_bic', 'Correspondent Bank Name & BIC'],
  ]},
  { title: 'Debit Authority', fields: [
    ['foreign_bank_charges', 'Foreign Bank Charges (SHA/OUR/BEN)'], ['goods_freely_importable', 'Goods Freely Importable (Y/N)'],
    ['license_no', 'License No'], ['license_issue_date', 'License Issue Date', 'date'], ['license_expiry_date', 'License Expiry Date', 'date'],
    ['license_face_value', 'License Face Value'], ['license_amount_endorsed', 'License Amount Endorsed'],
    ['debit_account_no', 'Debit Account No'], ['debit_balance_account_no', 'Debit Balance Account No'],
    ['forward_contract_no', 'Forward Contract No'], ['forward_contract_booked_date', 'Forward Contract Booked Date', 'date'],
    ['part_payment_reason', 'Part Payment Reason'],
  ]},
  { title: 'FBG / SBLC Waiver Justification', fields: [
    ['fbg_sblc_reason', 'Reason'], ['long_standing_since', 'Long-standing Since', 'date'], ['fbg_sblc_other_reason', 'Other Reason'],
  ]},
  { title: 'Transaction Details', fields: [
    ['port_of_loading', 'Port of Loading'], ['port_of_discharge', 'Port of Discharge'], ['is_merchanting_trade', 'Merchanting Trade (Y/N)'],
  ]},
  { title: 'Nature of Goods', fields: [['goods_nature', 'Goods Nature']] },
  { title: 'FBG Waiver', fields: [['fbg_waiver_requested', 'FBG Waiver Requested (Y/N)']] },
  { title: 'Declaration', fields: [['import_on_behalf_of', 'Import on Behalf Of'], ['ofac_sanctioned_country', 'OFAC Sanctioned Country (Y/N)']] },
  { title: 'Signatory', fields: [
    ['signatory_name', 'Name'], ['signatory_address_line1', 'Address Line 1'], ['signatory_address_line2', 'Address Line 2'],
    ['signatory_pincode', 'Pincode'], ['signatory_city', 'City'], ['signatory_state', 'State'], ['signatory_country', 'Country'],
    ['ie_code', 'IE Code'], ['declaration_date', 'Declaration Date', 'date'], ['declaration_place', 'Declaration Place'],
  ]},
];
const FP_LINE_FIELDS = ['invoice_no', 'invoice_date', 'terms', 'currency', 'amount', 'qty_of_goods', 'description_of_goods', 'hs_classification', 'country_of_origin', 'country_consigned_from', 'mode_of_shipment', 'date_of_shipment'];
function emptyFpLine() { return { invoice_no: '', invoice_date: '', terms: '', currency: '', amount: 0, qty_of_goods: 0, description_of_goods: '', hs_classification: '', country_of_origin: '', country_consigned_from: '', mode_of_shipment: '', date_of_shipment: '' }; }

function fpFieldsHTML(prefix, data, vendors) {
  data = data || {};
  const vendorOptions = `<option value="">-- None --</option>` + vendors.map(v => `<option value="${v.id}" ${Number(data.vendor_id) === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
  const sections = FP_FIELD_GROUPS.map(g => `
    <h4>${esc(g.title)}</h4>
    <div class="form-grid">
      ${g.fields.map(([f, label, type]) => `<div><label>${esc(label)}</label><input id="${prefix}-${f}" type="${type || 'text'}" value="${esc(data[f] === null || data[f] === undefined ? '' : data[f])}"></div>`).join('')}
    </div>`).join('');
  return `
    <h4>Vendor</h4>
    <div class="form-grid"><div><label>Vendor (optional)</label><select id="${prefix}-vendor_id">${vendorOptions}</select></div></div>
    ${sections}`;
}
function readFpFields(prefix) {
  const out = {};
  const vendorVal = val(`${prefix}-vendor_id`);
  out.vendor_id = vendorVal ? Number(vendorVal) : null;
  FP_FIELD_GROUPS.forEach(g => g.fields.forEach(([f]) => { out[f] = val(`${prefix}-${f}`); }));
  return out;
}
function fpLinesHTML(prefix, lines) {
  return tableHTML(['Invoice No', 'Date', 'Terms', 'Currency', 'Amount', 'Qty', 'Description', 'HS Code', 'Origin', 'Consigned From', 'Mode', 'Shipment Date', ''], lines, (l, i) => `
    <tr>
      <td><input value="${esc(l.invoice_no || '')}" onchange="window.${prefix}_LINES[${i}].invoice_no=this.value" style="width:90px;"></td>
      <td><input type="date" value="${esc(l.invoice_date || '')}" onchange="window.${prefix}_LINES[${i}].invoice_date=this.value" style="width:130px;"></td>
      <td><input value="${esc(l.terms || '')}" onchange="window.${prefix}_LINES[${i}].terms=this.value" style="width:70px;"></td>
      <td><input value="${esc(l.currency || '')}" onchange="window.${prefix}_LINES[${i}].currency=this.value" style="width:60px;"></td>
      <td><input type="number" value="${l.amount}" onchange="window.${prefix}_LINES[${i}].amount=Number(this.value)" style="width:90px;"></td>
      <td><input type="number" value="${l.qty_of_goods}" onchange="window.${prefix}_LINES[${i}].qty_of_goods=Number(this.value)" style="width:70px;"></td>
      <td><input value="${esc(l.description_of_goods || '')}" onchange="window.${prefix}_LINES[${i}].description_of_goods=this.value" style="width:140px;"></td>
      <td><input value="${esc(l.hs_classification || '')}" onchange="window.${prefix}_LINES[${i}].hs_classification=this.value" style="width:80px;"></td>
      <td><input value="${esc(l.country_of_origin || '')}" onchange="window.${prefix}_LINES[${i}].country_of_origin=this.value" style="width:90px;"></td>
      <td><input value="${esc(l.country_consigned_from || '')}" onchange="window.${prefix}_LINES[${i}].country_consigned_from=this.value" style="width:110px;"></td>
      <td><input value="${esc(l.mode_of_shipment || '')}" onchange="window.${prefix}_LINES[${i}].mode_of_shipment=this.value" style="width:80px;"></td>
      <td><input type="date" value="${esc(l.date_of_shipment || '')}" onchange="window.${prefix}_LINES[${i}].date_of_shipment=this.value" style="width:130px;"></td>
      <td>${lines.length > 1 ? `<button class="btn small outline" type="button" onclick="window.${prefix}_LINES.splice(${i},1);renderFpLinesTable('${prefix}')">✕</button>` : ''}</td>
    </tr>`);
}
window.renderFpLinesTable = (prefix) => {
  document.getElementById(`${prefix}-lines-wrap`).innerHTML = fpLinesHTML(prefix, window[`${prefix}_LINES`]);
};
window.addFpLine = (prefix) => { window[`${prefix}_LINES`].push(emptyFpLine()); window.renderFpLinesTable(prefix); };

window.FP_LINES = [emptyFpLine()];
PAGES['foreign-payments'] = async (el) => {
  const [requests, vendors] = await Promise.all([api('/foreign-payments'), api('/masters/vendors')]);
  window.FP_LINES = [emptyFpLine()];
  el.innerHTML = `
    <div class="panel"><h3>New Foreign Payment Request</h3>
      <div id="fp-fields-wrap">${fpFieldsHTML('fp-new', {}, vendors)}</div>
      <h4>Invoice Lines</h4>
      <div id="fp-new-lines-wrap">${fpLinesHTML('fp-new', window.FP_LINES)}</div>
      <button class="btn small outline" type="button" onclick="addFpLine('fp-new')">+ Add Invoice Line</button>
      <div style="margin-top:12px;">
        <button class="btn" type="button" onclick="createForeignPayment()">Save as Draft</button>
        <div id="fp-new-err" class="msg err" style="display:none;margin-top:8px;"></div>
      </div>
    </div>
    ${collapsiblePanel('foreign-payments-list', `<span id="fp-count">Foreign Payment Requests (${requests.length})</span>`, `
      ${renderListSearch('foreign-payments', requests, ['request_no', 'vendor_name', 'beneficiary_name', 'currency', 'status'], (rows) => {
        document.getElementById('fp-list-wrap').innerHTML = fpListHTML(rows);
        document.getElementById('fp-count').textContent = 'Foreign Payment Requests (' + rows.length + ')';
      }, 'Search by request no, vendor, beneficiary, currency, status...')}
      <div id="fp-list-wrap">${fpListHTML(requests)}</div>
    `)}`;
};

function fpListHTML(requests) {
  return tableHTML(['Request No', 'Vendor', 'Beneficiary', 'Currency', 'Amount', 'Status', 'Lines', 'BOE', ''], requests, (r) => `
    <tr>
      <td>${esc(r.request_no)}</td>
      <td>${esc(r.vendor_name || '-')}</td>
      <td>${esc(r.beneficiary_name)}</td>
      <td>${esc(r.currency)}</td>
      <td>${fmt(r.amount)}</td>
      <td>${badge(r.status)}</td>
      <td>${r.line_count}</td>
      <td>${r.boe_count > 0 ? '<span class="badge Approved">Yes</span>' : '<span class="muted">-</span>'}</td>
      <td><button class="btn small outline" type="button" onclick="openForeignPaymentDetail(${r.id})">View</button></td>
    </tr>`);
}
window.createForeignPayment = async () => {
  const errEl = document.getElementById('fp-new-err');
  errEl.style.display = 'none';
  try {
    const fields = readFpFields('fp-new');
    const lines = window.FP_LINES.filter(l => (l.invoice_no || '').trim() || (l.description_of_goods || '').trim());
    await api('/foreign-payments', { method: 'POST', body: JSON.stringify({ ...fields, lines }) });
    navigate('foreign-payments');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
};

const FP_EDITABLE_STATUSES = ['Draft', 'Rejected', 'InfoRequested'];
window.FP_EDIT_LINES = [];
window.openForeignPaymentDetail = async (id) => {
  const [r, vendors] = await Promise.all([api(`/foreign-payments/${id}`), api('/masters/vendors')]);
  const editable = FP_EDITABLE_STATUSES.includes(r.status);
  window.FP_EDIT_LINES = r.lines.length ? r.lines.map(l => ({ ...l })) : [emptyFpLine()];
  const actionButtons = [];
  actionButtons.push(`<button class="btn small outline" type="button" onclick="downloadTemplateFile('/foreign-payments/${r.id}/pdf', '${esc(r.request_no)}.pdf')">Print PDF</button>`);
  if (editable) actionButtons.push(`<button class="btn" type="button" onclick="submitForeignPaymentForApproval(${r.id})">Submit for Approval</button>`);
  if (r.status === 'Approved') actionButtons.push(`<button class="btn" type="button" onclick="openMarkForeignPaymentPaid(${r.id})">Mark Payment Made</button>`);
  if (r.status === 'PaymentMade') actionButtons.push(`<button class="btn" type="button" onclick="closeForeignPayment(${r.id})">Close</button>`);
  if (editable) actionButtons.push(`<button class="btn red outline" type="button" onclick="deleteForeignPayment(${r.id})">Delete</button>`);

  const body = `
    <div style="margin-bottom:10px;">${badge(r.status)} <span class="muted">${esc(r.request_no)}</span></div>
    ${r.status === 'PaymentMade' || r.status === 'Closed' ? `
      <h4>Payment Details</h4>
      <div class="form-grid">
        <div><label>Payment Reference</label><div>${esc(r.payment_reference || '-')}</div></div>
        <div><label>Actual Debited Amount</label><div>${fmt(r.actual_debited_amount)}</div></div>
        <div><label>Actual Exchange Rate</label><div>${fmt(r.actual_exchange_rate)}</div></div>
        <div><label>Bill of Entry Due</label><div>${esc(r.boe_due_date || '-')}</div></div>
      </div>` : ''}
    <div id="fp-detail-fields-wrap">${fpFieldsHTML(`fp-edit-${r.id}`, r, vendors)}</div>
    <h4>Invoice Lines</h4>
    <div id="fp-edit-${r.id}-lines-wrap">${fpLinesHTML(`fp-edit-${r.id}`, window.FP_EDIT_LINES)}</div>
    ${editable ? `<button class="btn small outline" type="button" onclick="addFpLine('fp-edit-${r.id}')">+ Add Invoice Line</button>` : ''}
    <div id="fp-detail-attachments-${r.id}"></div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      ${editable ? `<button class="btn green" type="button" onclick="saveForeignPaymentEdit(${r.id})">Save Changes</button>` : ''}
      ${actionButtons.join('')}
    </div>
    <div id="fp-detail-err-${r.id}" class="msg err" style="display:none;margin-top:8px;"></div>`;
  const modal = openMiniModal(`Foreign Payment - ${r.request_no}`, body, true);
  if (!editable) {
    modal.querySelectorAll('#fp-detail-fields-wrap input, #fp-detail-fields-wrap select').forEach(inp => inp.disabled = true);
  }
  renderAttachmentsWidget('foreign_payment', r.id, document.getElementById(`fp-detail-attachments-${r.id}`), FP_DOCUMENT_TYPES);
};

window.saveForeignPaymentEdit = async (id) => {
  const errEl = document.getElementById(`fp-detail-err-${id}`);
  errEl.style.display = 'none';
  try {
    const fields = readFpFields(`fp-edit-${id}`);
    const lines = window.FP_EDIT_LINES.filter(l => (l.invoice_no || '').trim() || (l.description_of_goods || '').trim());
    await api(`/foreign-payments/${id}`, { method: 'PUT', body: JSON.stringify({ ...fields, lines }) });
    closeMiniModal();
    navigate('foreign-payments');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
};
window.submitForeignPaymentForApproval = async (id) => {
  try {
    await api(`/foreign-payments/${id}/submit-for-approval`, { method: 'POST' });
    closeMiniModal();
    navigate('foreign-payments');
  } catch (e) { alert(e.message); }
};
window.deleteForeignPayment = async (id) => {
  if (!confirm('Delete this draft foreign payment request?')) return;
  try {
    await api(`/foreign-payments/${id}`, { method: 'DELETE' });
    closeMiniModal();
    navigate('foreign-payments');
  } catch (e) { alert(e.message); }
};
window.closeForeignPayment = async (id) => {
  try {
    await api(`/foreign-payments/${id}/close`, { method: 'POST' });
    closeMiniModal();
    navigate('foreign-payments');
  } catch (e) { alert(e.message); }
};
window.openMarkForeignPaymentPaid = (id) => {
  const body = `
    <div class="form-grid">
      <div><label>Payment Reference / UTR</label><input id="fp-pay-ref-${id}"></div>
      <div><label>Actual Debited Amount</label><input type="number" id="fp-pay-amt-${id}"></div>
      <div><label>Actual Exchange Rate</label><input type="number" id="fp-pay-rate-${id}"></div>
      <div><label>Bill of Entry Due Date (optional, defaults to 90 days out)</label><input type="date" id="fp-pay-boe-${id}"></div>
    </div>
    <button class="btn green" type="button" onclick="markForeignPaymentPaid(${id})">Confirm Payment Made</button>
    <div id="fp-pay-err-${id}" class="msg err" style="display:none;margin-top:8px;"></div>`;
  openMiniModal('Mark Payment Made', body);
};
window.markForeignPaymentPaid = async (id) => {
  const errEl = document.getElementById(`fp-pay-err-${id}`);
  errEl.style.display = 'none';
  try {
    await api(`/foreign-payments/${id}/mark-payment-made`, { method: 'POST', body: JSON.stringify({
      payment_reference: val(`fp-pay-ref-${id}`) || null,
      actual_debited_amount: val(`fp-pay-amt-${id}`) || null,
      actual_exchange_rate: val(`fp-pay-rate-${id}`) || null,
      boe_due_date: val(`fp-pay-boe-${id}`) || null,
    })});
    closeMiniModal();
    navigate('foreign-payments');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
};


// ---- Expense Report ----
PAGES['expense-report'] = async (el) => {
  const summary = await api('/finance/expense-summary');
  const accounted = summary.filter(s => s.accounted === 'Accounted').reduce((a, b) => a + b.total, 0);
  const cash = summary.filter(s => s.accounted !== 'Accounted').reduce((a, b) => a + b.total, 0);
  const erCols = ['Payment Mode','Category','Total','Count'];
  const erRow = s => `<tr><td>${esc(s.payment_mode)}</td><td>${esc(s.category)}</td><td>₹${fmt(s.total)}</td><td>${s.count}</td></tr>`;
  window.__STAT_DETAIL_BUILDERS = {
    er_accounted: async () => {
      const rows = summary.filter(s => s.accounted === 'Accounted');
      const byCat = {}; rows.forEach(s => { byCat[s.category] = (byCat[s.category]||0) + s.total; });
      return `<h3>Total Accounted: ₹${fmt(accounted)}</h3><p class="muted">Breakdown by category</p>${breakdownBars(byCat, true)}${tableHTML(erCols, rows, erRow)}`;
    },
    er_cash: async () => {
      const rows = summary.filter(s => s.accounted !== 'Accounted');
      const byCat = {}; rows.forEach(s => { byCat[s.category] = (byCat[s.category]||0) + s.total; });
      return `<h3>Total Cash (Unaccounted): ₹${fmt(cash)}</h3><p class="muted">Breakdown by category</p>${breakdownBars(byCat, true)}${tableHTML(erCols, rows, erRow)}`;
    },
  };
  el.innerHTML = `
    <div class="cards">
      ${statCard('er_accounted', '₹' + fmt(accounted), 'Total Accounted')}
      ${statCard('er_cash', '₹' + fmt(cash), 'Total Cash (Unaccounted)')}
    </div>
    <div id="stat-detail"></div>
    <div class="panel"><h3>Breakdown by Category / Mode / Accounted Status</h3>
      ${tableHTML(['Accounted', 'Payment Mode', 'Category', 'Total', 'Count'], summary, s => `
        <tr><td>${esc(s.accounted)}</td><td>${esc(s.payment_mode)}</td><td>${esc(s.category)}</td><td>₹${fmt(s.total)}</td><td>${s.count}</td></tr>`)}
    </div>`;
};

// Monthly Reconciliation - same view as the Service module's Reconciliation
// page's "Monthly Reconciliation" panel, exposed under Finance too so
// Accounts/Management can reach it without a Service-department login.
PAGES['monthly-reconciliation'] = async (el) => PAGES['service-recon'](el);

// ---- Finance Ledger (Round 3) ----
PAGES['finance-ledger'] = async (el) => {
  const month = window.FIN_MONTH || thisMonth();
  const [summary, ledger, depts] = await Promise.all([
    api('/finance/summary?month=' + month),
    api('/finance/ledger' + (window.FIN_FILTER ? '?' + window.FIN_FILTER : '')),
    api('/masters/departments'),
  ]);
  const flCols = ['Date','Type','Department','Amount','Direction','Description'];
  const flRow = l => `<tr><td>${new Date(l.entry_date).toLocaleString()}</td><td>${esc(l.type)}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td><td>${badge(l.direction)}</td><td>${esc(l.description)||'-'}</td></tr>`;
  window.__STAT_DETAIL_BUILDERS = {
    fl_inflow: async () => {
      const rows = ledger.filter(l => l.direction === 'Inflow');
      const byDept = {}; rows.forEach(l => { const dpt = l.department_name || 'Unassigned'; byDept[dpt] = (byDept[dpt]||0) + (l.amount||0); });
      return `<h3>Total Inflow: ₹${fmt(summary.inflow)}</h3><p class="muted">Ledger entries for ${esc(month)} &middot; breakdown by department</p>${breakdownBars(byDept, true)}${tableHTML(flCols, rows, flRow)}`;
    },
    fl_outflow: async () => {
      const rows = ledger.filter(l => l.direction === 'Outflow');
      const byDept = {}; rows.forEach(l => { const dpt = l.department_name || 'Unassigned'; byDept[dpt] = (byDept[dpt]||0) + (l.amount||0); });
      return `<h3>Total Outflow: ₹${fmt(summary.outflow)}</h3><p class="muted">Ledger entries for ${esc(month)} &middot; breakdown by department</p>${breakdownBars(byDept, true)}${tableHTML(flCols, rows, flRow)}`;
    },
    fl_net: async () => {
      return `<h3>Net: ₹${fmt(summary.net)}</h3><p class="muted">Breakdown by type (net amount)</p>${breakdownBars(summary.byType, true)}${tableHTML(flCols, ledger, flRow)}`;
    },
  };
  el.innerHTML = `
    <div class="panel"><label>Month</label><input type="month" value="${month}" onchange="window.FIN_MONTH=this.value;navigate('finance-ledger')"></div>
    <div class="cards">
      ${statCard('fl_inflow', '₹' + fmt(summary.inflow), 'Total Inflow')}
      ${statCard('fl_outflow', '₹' + fmt(summary.outflow), 'Total Outflow')}
      ${statCard('fl_net', '₹' + fmt(summary.net), 'Net')}
    </div>
    <div id="stat-detail"></div>
    <div class="panel"><h3>Breakdown by Type</h3>
      ${tableHTML(['Type', 'Net Amount'], Object.entries(summary.byType), ([t,a]) => `<tr><td>${esc(t)}</td><td>₹${fmt(a)}</td></tr>`)}
    </div>
    <div class="panel"><h3>Breakdown by Department</h3>
      ${tableHTML(['Department', 'Inflow', 'Outflow'], summary.byDepartment, r => `<tr><td>${esc(r.department)}</td><td>₹${fmt(r.inflow)}</td><td>₹${fmt(r.outflow)}</td></tr>`)}
    </div>
    <div class="panel"><h3>Ledger</h3>
      <div class="form-grid">
        <div><label>From</label><input id="fl-from" type="date"></div>
        <div><label>To</label><input id="fl-to" type="date"></div>
        <div><label>Type</label><select id="fl-type"><option value="">All</option>${['Expense','Payroll','ServiceCollection','AdvanceRecovery','PurchaseInvoice','Other'].map(t=>`<option value="${t}">${t}</option>`).join('')}</select></div>
        <div><label>Department</label><select id="fl-dept"><option value="">All</option>${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      </div>
      <button class="btn small" onclick="filterLedger()">Filter</button>
    </div>
    ${collapsiblePanel('finance-ledger-list', `Ledger Entries (${ledger.length})`, `
      ${tableHTML(['Date', 'Type', 'Department', 'Amount', 'Direction', 'Description'], ledger, l => `
        <tr><td>${new Date(l.entry_date).toLocaleString()}</td><td>${esc(l.type)}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td><td>${badge(l.direction)}</td><td>${esc(l.description)||'-'}</td></tr>`)}
    `)}`;
};
window.filterLedger = () => {
  const params = [];
  if (val('fl-from')) params.push('from=' + val('fl-from'));
  if (val('fl-to')) params.push('to=' + val('fl-to'));
  if (val('fl-type')) params.push('type=' + val('fl-type'));
  if (val('fl-dept')) params.push('department_id=' + val('fl-dept'));
  window.FIN_FILTER = params.join('&');
  navigate('finance-ledger');
};

// ---- Users & Roles ----
// Roles whose Job Cards workbench depends on the user's ROLE matching one
// of these exactly (see lib/pipeline.js PIPELINE_STAGES/SUB_STAGES, plus
// Service) - used only to warn the Admin in the UI when department is left
// blank or looks mismatched, since that silently breaks the account's job
// card visibility with no obvious symptom (a real, previously-reported bug:
// an HOD set on a role but the tab was empty/missing because the account's
// department was blank or the role picked didn't actually match).
const DEPT_SCOPED_ROLE_NAMES = ['Design', 'Purchase', 'Electrical', 'Store', 'LaserBending', 'Manufacturing',
  'Fitting', 'Tacking', 'Welding', 'BuffingSandblast', 'Painting', 'Assembling', 'Packing', 'Shipping', 'Installation', 'Service'];
PAGES.users = async (el) => {
  const users = await api('/masters/users');
  const roles = await api('/masters/roles');
  const depts = await api('/masters/departments');
  const freeEmployees = await api('/masters/employees-without-login');
  window.__FREE_EMPLOYEES = freeEmployees;
  window.__USER_ROLES = roles; window.__USER_DEPTS = depts; window.__USER_CACHE = users;
  el.innerHTML = `
    <div class="panel"><h3>Add User</h3>
      <div class="form-grid">
        <div><label>Username</label><input id="us-username"></div>
        <div><label>Full Name</label><input id="us-name"></div>
        <div><label>Email (for welcome email &amp; password reset)</label><input id="us-email" type="email"></div>
        <div><label>Password</label><input id="us-pass" type="text" placeholder="Leave blank to auto-generate + email"></div>
        <div><label>Role</label><select id="us-role" onchange="checkUserDeptWarning()">${roles.map(r => `<option value="${r.id}" data-name="${esc(r.name)}">${esc(r.name)}</option>`).join('')}</select></div>
        <div><label>Department</label><select id="us-dept" onchange="checkUserDeptWarning()"><option value="">-</option>${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="us-supervisor" type="checkbox"> Supervisor / HOD (can act on every card in this role's queue, allocate work, and see the full department report)</label></div>
        <div><label>Employee (links this login to their HR/payroll record)</label>
          <select id="us-employee">
            <option value="">- No linked employee -</option>
            ${freeEmployees.map(e => `<option value="${e.id}">${esc(e.employee_code || '')} - ${esc(e.full_name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="us-dept-warning" class="msg err" style="display:none;margin-top:8px;"></div>
      <button class="btn" onclick="addUser()">Create User</button>
    </div>
    ${collapsiblePanel('users-list', `Users (${users.length})`, `
      ${tableHTML(['Username', 'Name', 'Email', 'Role', 'Department', 'Supervisor', 'Linked Employee', 'Status', 'Action'], users, u => `
        <tr><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.email)||'<span class="muted">Not set</span>'}</td><td>${esc(u.role)}</td><td>${esc(u.department)||'<span class="muted">Not set</span>'}</td>
        <td>${u.is_supervisor ? badge('active') : '-'}</td>
        <td>${u.employee_id ? esc(u.employee_code || '') + ' - ' + esc(u.employee_name) : '<span class="muted">Not linked</span>'}</td>
        <td>${badge(u.is_active ? 'active' : 'Rejected')}${u.must_change_password ? ' <span class="badge Pending" title="Must set their own password at next login">Pending activation</span>' : ''}</td>
        <td>
          <button class="btn small outline" onclick="openEditUser(${u.id})">Edit</button>
          <button class="btn small outline" onclick="toggleUser(${u.id})">${u.is_active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn small outline" onclick="linkUserEmployee(${u.id})">${u.employee_id ? 'Change Link' : 'Link Employee'}</button>
        </td></tr>`)}
    `)}
    <div class="panel" id="user-edit-panel" style="display:none;"><h3>Edit User</h3><div id="user-edit-body"></div></div>`;
};
// A role like Design/Purchase/LaserBending/etc. only gets its own "Job
// Cards" sidebar tab and workbench if the account ALSO has a Department set
// (see boot()'s DEPT_OWN_GROUP logic) - the role decides WHICH cards show,
// the department decides WHETHER the tab appears at all. Leaving department
// blank on one of these roles silently produces an account with no Job
// Cards tab whatsoever, which is easy to miss when creating a user.
window.checkUserDeptWarning = (prefix) => {
  prefix = prefix || 'us';
  const roleSel = document.getElementById(prefix + '-role');
  const deptSel = document.getElementById(prefix + '-dept');
  const warnEl = document.getElementById(prefix + '-dept-warning');
  if (!roleSel || !deptSel || !warnEl) return;
  const roleName = roleSel.selectedOptions[0] && roleSel.selectedOptions[0].getAttribute('data-name');
  if (DEPT_SCOPED_ROLE_NAMES.includes(roleName) && !deptSel.value) {
    warnEl.style.display = 'block';
    warnEl.textContent = `The "${roleName}" role needs a Department set, or this user won't get a Job Cards tab at all.`;
  } else {
    warnEl.style.display = 'none';
  }
};
window.addUser = async () => {
  try {
    const r = await api('/masters/users', { method: 'POST', body: JSON.stringify({
      username: val('us-username'), password: val('us-pass'), full_name: val('us-name'), email: val('us-email'), role_id: val('us-role'),
      department_id: val('us-dept') || null, employee_id: val('us-employee') || null,
      is_supervisor: document.getElementById('us-supervisor').checked,
    })});
    if (r.welcome_email && r.welcome_email.attempted) {
      alert(r.welcome_email.sent
        ? 'User created. A welcome email with login details was sent.'
        : `User created, but the welcome email was not sent: ${r.welcome_email.reason || 'unknown reason'}.${r.password_used ? ' Temporary password: ' + r.password_used : ''}`);
    } else if (r.password_used) {
      alert(`User created. No email on file, so nothing was sent - temporary password: ${r.password_used}`);
    }
    navigate('users');
  } catch (e) { alert(e.message); }
};
window.openEditUser = (id) => {
  const u = (window.__USER_CACHE || []).find(x => x.id === id);
  if (!u) return;
  const roles = window.__USER_ROLES || [];
  const depts = window.__USER_DEPTS || [];
  const panel = document.getElementById('user-edit-panel');
  document.getElementById('user-edit-body').innerHTML = `
    <div class="form-grid">
      <div><label>Full Name</label><input id="ue-name" value="${esc(u.full_name)}"></div>
      <div><label>Email</label><input id="ue-email" type="email" value="${esc(u.email)}"></div>
      <div><label>Role</label><select id="ue-role" onchange="checkUserDeptWarning('ue')">${roles.map(r => `<option value="${r.id}" data-name="${esc(r.name)}" ${r.id===u.role_id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div><label>Department</label><select id="ue-dept" onchange="checkUserDeptWarning('ue')"><option value="">-</option>${depts.map(d => `<option value="${d.id}" ${d.id===u.department_id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="ue-supervisor" type="checkbox" ${u.is_supervisor?'checked':''}> Supervisor / HOD</label></div>
      <div><label>Reset Password (optional)</label><input id="ue-pass" type="text" placeholder="Leave blank to keep current password"></div>
    </div>
    <div id="ue-dept-warning" class="msg err" style="display:none;margin-top:8px;"></div>
    <button class="btn" onclick="saveEditUser(${id})">Save Changes</button>
    <button class="btn outline" type="button" onclick="document.getElementById('user-edit-panel').style.display='none'">Cancel</button>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  checkUserDeptWarning('ue');
};
window.saveEditUser = async (id) => {
  try {
    const body = {
      full_name: val('ue-name'), email: val('ue-email'), role_id: val('ue-role'), department_id: val('ue-dept') || null,
      is_supervisor: document.getElementById('ue-supervisor').checked,
    };
    if (val('ue-pass').trim()) body.password = val('ue-pass').trim();
    await api(`/masters/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    navigate('users');
  } catch (e) { alert(e.message); }
};
window.toggleUser = async (id) => {
  await api(`/masters/users/${id}/toggle`, { method: 'PATCH' });
  navigate('users');
};
window.linkUserEmployee = async (id) => {
  const freeEmployees = window.__FREE_EMPLOYEES || await api('/masters/employees-without-login');
  if (!freeEmployees.length) { alert('Every active employee already has a login. To relink this user, first unlink the employee from their current login.'); return; }
  const options = freeEmployees.map((e, i) => `${i + 1}. ${e.employee_code || ''} - ${e.full_name}`).join('\n');
  const pick = prompt(`Pick an employee to link (enter number), or 0 to unlink:\n\n0. - No linked employee -\n${options}`);
  if (pick === null) return;
  const idx = parseInt(pick, 10);
  if (isNaN(idx)) { alert('Enter a number.'); return; }
  const employee_id = idx === 0 ? null : (freeEmployees[idx - 1] ? freeEmployees[idx - 1].id : null);
  if (idx !== 0 && !employee_id) { alert('Invalid selection.'); return; }
  try {
    await api(`/masters/users/${id}/link-employee`, { method: 'PATCH', body: JSON.stringify({ employee_id }) });
    navigate('users');
  } catch (e) { alert(e.message); }
};

// ---- User Access (Admin only): which pages each role can see ----
PAGES.access = async (el) => {
  const data = await api('/admin/access');
  el.innerHTML = `
    <div class="panel">
      <h3>Access by User</h3>
      <p class="muted">Pick a person to see and change exactly what they can see, grouped the same way as the sidebar. Tick a whole group to grant every page in it at once, then expand the group to remove specific pages within it. Anything you don't touch here just follows their role's default access, configured further down.</p>
      <select id="au-user-select" onchange="loadUserAccess(this.value)"><option value="">Loading users...</option></select>
      <div id="au-body" style="margin-top:12px;"></div>
    </div>
    <div class="panel">
      <h3>Grant Extra Page Access (Round 3)</h3>
      <p class="muted">On top of the role-based matrix below, grant one page either to an entire department (applies to every current AND future user in it) or to specific individual users. Useful for one-off exceptions without changing a whole role's config. This only makes a page <b>visible</b> - if it's a page where the user needs to actually submit/approve/manage something (e.g. Service & Spares), also grant Cross-Department Oversight below for that role, or they'll see the page but get "Access denied: missing permission" when they try to act on it.</p>
      <div id="extra-access-form"></div>
      <div id="extra-access-list"></div>
    </div>
    <div class="panel">
      <h3>Cross-Department Oversight (Round 22)</h3>
      <p class="muted">Grant a specific user full supervisor-level reach into another role's domain - Job Cards allocation, To-Do oversight, and any permission-gated page that role has - without changing that user's own role or department. For a real-world HOD who covers two departments (e.g. Electrical & Service) rather than actually merging those departments/roles. This grants back-end authority only; pair it with Extra Page Access above if their own role's page list doesn't already show the other department's pages.</p>
      <div id="role-oversight-form"></div>
      <div id="role-oversight-list"></div>
    </div>
    <div class="panel">
      <h3>User Access by Role</h3>
      <p class="muted">Tick the pages a role is allowed to see in the sidebar. A role with nothing configured (marked "Unrestricted") sees every page, same as today - saving any selection for a role switches it to that fixed list. Admin can always see everything and can't be restricted.</p>
      <div id="access-body"></div>
    </div>`;
  await renderUserAccessPanel(data.pageCatalog);
  await renderExtraAccessPanel(data.pageCatalog);
  await renderRoleOversightPanel();
  const body = document.getElementById('access-body');
  // "User Access" and "Approval Matrix" are always Admin-only regardless of
  // any role's configured pages (see NAV's hardcoded filter), so offering
  // them as checkboxes here would be meaningless - ticking them would have
  // no visible effect for anyone but Admin.
  const catalogForRoles = filterAccessCatalog(data.pageCatalog);
  body.innerHTML = data.roles.filter(r => r.name !== 'Admin').map(r => `
    <div class="panel access-role-panel collapsed" style="margin-bottom:12px;" id="access-panel-${r.id}">
      <h4 class="access-role-head" onclick="toggleAccessRolePanel(${r.id})">
        <span>${esc(r.name)} ${r.configured ? '<span class="badge OnHold">Restricted</span>' : '<span class="muted">(Unrestricted - sees everything)</span>'}</span>
        <span class="chev">&#9660;</span>
      </h4>
      <div class="access-grid" id="access-role-${r.id}">
        ${catalogForRoles.map(g => `
          <div class="access-group">
            <div class="access-group-title">${esc(g.group)}</div>
            ${g.items.map(it => `
              <label class="access-item"><input type="checkbox" value="${it.id}" ${(!r.configured || (r.allowedPages||[]).includes(it.id)) ? 'checked' : ''}> ${esc(it.label)}</label>
            `).join('')}
          </div>`).join('')}
      </div>
      <div class="access-role-actions" style="margin-top:10px;">
        <button class="btn small" onclick="saveAccess(${r.id})">Save Access for ${esc(r.name)}</button>
        ${r.configured ? `<button class="btn small outline" onclick="resetAccess(${r.id})">Reset to Unrestricted</button>` : ''}
      </div>
    </div>`).join('');
};
window.toggleAccessRolePanel = (roleId) => {
  const panel = document.getElementById(`access-panel-${roleId}`);
  if (panel) panel.classList.toggle('collapsed');
};
// "User Access" and "Approval Matrix" are always Admin-only client-side
// (see NAV's hardcoded filter above) no matter what any role/user access
// config says - shared by the role matrix and the per-user screen below so
// neither offers a checkbox that can never actually do anything.
function filterAccessCatalog(pageCatalog) {
  return pageCatalog
    .map(g => ({ group: g.group, items: g.items.filter(it => it.id !== 'access' && it.id !== 'approval-matrix') }))
    .filter(g => g.items.length);
}
async function renderUserAccessPanel(pageCatalog) {
  const users = await api('/masters/users');
  const selectEl = document.getElementById('au-user-select');
  const selectable = users.filter(u => u.role !== 'Admin' && u.is_active);
  selectEl.innerHTML = `<option value="">- Select a user -</option>` +
    selectable.map(u => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.role)}${u.department ? ' - ' + esc(u.department) : ''})</option>`).join('');
}
window.loadUserAccess = async (userId) => {
  const bodyEl = document.getElementById('au-body');
  if (!userId) { bodyEl.innerHTML = ''; return; }
  const data = await api('/admin/access/user/' + userId);
  window.__AU_DATA = data;
  const catalog = filterAccessCatalog(data.pageCatalog);
  const allIds = catalog.flatMap(g => g.items.map(it => it.id));
  const effective = new Set(data.baselinePages === null ? allIds : data.baselinePages.filter(id => allIds.includes(id)));
  Object.entries(data.overrides).forEach(([pid, access]) => {
    if (access === 'granted') effective.add(pid); else effective.delete(pid);
  });
  bodyEl.innerHTML = `
    <p class="muted">${esc(data.user.full_name)} &mdash; Role: ${esc(data.user.role_name)}${data.user.department_name ? ' &middot; ' + esc(data.user.department_name) : ''}
      ${data.roleConfigured ? '' : ' <span class="muted">(role is Unrestricted by default - everything below starts checked unless you uncheck it)</span>'}</p>
    ${catalog.map(g => {
      const groupIds = g.items.map(it => it.id);
      const checkedCount = groupIds.filter(id => effective.has(id)).length;
      const groupKey = 'au-group-' + g.group.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return collapsiblePanel(groupKey, `
        <label style="margin:0;" onclick="event.stopPropagation();">
          <input type="checkbox" class="au-group-toggle" data-group="${esc(g.group)}" ${checkedCount === groupIds.length ? 'checked' : ''} onchange="toggleAuGroup(this)">
          <b>${esc(g.group)}</b>
        </label> <span class="muted">(${checkedCount}/${groupIds.length})</span>
      `, `
        ${g.items.map(it => `<label class="access-item" style="display:block;"><input type="checkbox" class="au-page" data-group="${esc(g.group)}" value="${it.id}" ${effective.has(it.id) ? 'checked' : ''}> ${esc(it.label)}</label>`).join('')}
      `);
    }).join('')}
    <div style="margin-top:10px;">
      <button class="btn" onclick="saveUserAccess()">Save Access for ${esc(data.user.full_name)}</button>
      <button class="btn outline" onclick="resetUserAccess()">Reset to Role Default</button>
    </div>
    <div id="au-err" class="msg err" style="display:none;margin-top:10px;"></div>`;
};
window.toggleAuGroup = (checkbox) => {
  const group = checkbox.dataset.group;
  document.querySelectorAll('.au-page').forEach(cb => { if (cb.dataset.group === group) cb.checked = checkbox.checked; });
};
window.saveUserAccess = async () => {
  const data = window.__AU_DATA;
  if (!data) return;
  const baselineSet = new Set(data.baselinePages === null ? ALL_PAGE_CATALOG_IDS(data.pageCatalog) : data.baselinePages);
  const overrides = {};
  document.querySelectorAll('.au-page').forEach(cb => {
    const inBaseline = baselineSet.has(cb.value);
    if (cb.checked && !inBaseline) overrides[cb.value] = 'granted';
    else if (!cb.checked && inBaseline) overrides[cb.value] = 'revoked';
    // else matches the role/extra-access baseline already - no override needed
  });
  const errEl = document.getElementById('au-err');
  try {
    await api('/admin/access/user/' + data.user.id, { method: 'PUT', body: JSON.stringify({ overrides }) });
    loadUserAccess(data.user.id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.resetUserAccess = async () => {
  const data = window.__AU_DATA;
  if (!data) return;
  if (!confirm(`Reset ${data.user.full_name}'s access back to their role's default? This removes every individual override for them.`)) return;
  await api('/admin/access/user/' + data.user.id, { method: 'PUT', body: JSON.stringify({ overrides: {} }) });
  loadUserAccess(data.user.id);
};
function ALL_PAGE_CATALOG_IDS(pageCatalog) { return pageCatalog.flatMap(g => g.items.map(it => it.id)); }
async function renderExtraAccessPanel(pageCatalog) {
  const [depts, users, extras] = await Promise.all([api('/masters/departments'), api('/masters/users'), api('/admin/extra-access')]);
  const allPages = pageCatalog.flatMap(g => g.items);
  const formEl = document.getElementById('extra-access-form');
  formEl.innerHTML = `
    <div class="form-grid">
      <div><label>Scope</label><select id="ea-scope" onchange="toggleEAscope()"><option value="Department">Entire Department</option><option value="User">Specific Users</option></select></div>
      <div id="ea-dept-wrap"><label>Department</label><select id="ea-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div id="ea-users-wrap" style="display:none;grid-column:1/-1;"><label>Users</label>
        <div style="max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:5px;padding:6px;">
          ${users.map(u => `<label style="display:block;font-weight:normal;"><input type="checkbox" class="ea-user" value="${u.id}"> ${esc(u.full_name)} (${esc(u.department)||'-'})</label>`).join('')}
        </div>
      </div>
      <div><label>Page</label><select id="ea-page">${allPages.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></div>
    </div>
    <button class="btn small" onclick="saveExtraAccess()">Grant Access</button>`;
  const listEl = document.getElementById('extra-access-list');
  listEl.innerHTML = extras.length ? tableHTML(['Scope', 'Target', 'Page', ''], extras, e => `
    <tr><td>${esc(e.scope)}</td><td>${esc(e.scope === 'Department' ? e.department_name : e.user_name)}</td><td>${esc((allPages.find(p=>p.id===e.page_id)||{}).label || e.page_id)}</td>
    <td><button class="btn small outline" onclick="removeExtraAccess(${e.id})">Remove</button></td></tr>`) : '<div class="empty">No extra grants yet.</div>';
}
window.toggleEAscope = () => {
  const isDept = val('ea-scope') === 'Department';
  document.getElementById('ea-dept-wrap').style.display = isDept ? '' : 'none';
  document.getElementById('ea-users-wrap').style.display = isDept ? 'none' : '';
};
window.saveExtraAccess = async () => {
  const scope = val('ea-scope');
  const page_id = val('ea-page');
  try {
    if (scope === 'Department') {
      await api('/admin/extra-access', { method: 'POST', body: JSON.stringify({ scope, department_id: val('ea-dept'), page_id }) });
    } else {
      const ids = Array.from(document.querySelectorAll('.ea-user:checked')).map(b => Number(b.value));
      if (!ids.length) { alert('Pick at least one user.'); return; }
      await api('/admin/extra-access', { method: 'POST', body: JSON.stringify({ scope, user_ids: ids, page_id }) });
    }
    navigate('access');
  } catch (e) { alert(e.message); }
};
window.removeExtraAccess = async (id) => {
  await api('/admin/extra-access/' + id, { method: 'DELETE' });
  navigate('access');
};
async function renderRoleOversightPanel() {
  const [users, roles, grants] = await Promise.all([api('/masters/users'), api('/masters/roles'), api('/admin/role-oversight')]);
  const nonAdminRoles = roles.filter(r => r.name !== 'Admin');
  const formEl = document.getElementById('role-oversight-form');
  formEl.innerHTML = `
    <div class="form-grid">
      <div><label>User (the HOD/supervisor being granted oversight)</label>
        <select id="ro-user">${users.map(u => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.department)||'-'})</option>`).join('')}</select></div>
      <div><label>Grant Oversight Of Role</label>
        <select id="ro-role">${nonAdminRoles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
    </div>
    <button class="btn small" onclick="saveRoleOversight()">Grant Oversight</button>`;
  const listEl = document.getElementById('role-oversight-list');
  listEl.innerHTML = grants.length ? tableHTML(['User', 'Oversees Role', ''], grants, g => `
    <tr><td>${esc(g.user_name)}</td><td>${esc(g.oversees_role_name)}</td>
    <td><button class="btn small outline" onclick="removeRoleOversight(${g.id})">Revoke</button></td></tr>`) : '<div class="empty">No cross-department oversight grants yet.</div>';
}
window.saveRoleOversight = async () => {
  try {
    await api('/admin/role-oversight', { method: 'POST', body: JSON.stringify({ user_id: val('ro-user'), oversees_role_id: val('ro-role') }) });
    navigate('access');
  } catch (e) { alert(e.message); }
};
window.removeRoleOversight = async (id) => {
  await api('/admin/role-oversight/' + id, { method: 'DELETE' });
  navigate('access');
};
window.saveAccess = async (roleId) => {
  const boxes = document.querySelectorAll(`#access-role-${roleId} input[type=checkbox]`);
  const pageIds = Array.from(boxes).filter(b => b.checked).map(b => b.value);
  try {
    await api(`/admin/access/${roleId}`, { method: 'PUT', body: JSON.stringify({ page_ids: pageIds }) });
    navigate('access');
  } catch (e) { alert(e.message); }
};
window.resetAccess = async (roleId) => {
  await api(`/admin/access/${roleId}`, { method: 'DELETE' });
  navigate('access');
};

// ---- Approval Matrix (Admin only) ----
PAGES['approval-matrix'] = async (el) => {
  const data = await api('/admin/approval-matrix');
  el.innerHTML = `
    <div class="panel">
      <h3>Approval Matrix</h3>
      <p class="muted">Configure who approves each kind of request, in order, and at what value each step kicks in. "Requires HOD/Supervisor" means only the department head for that role can act on that step - not just anyone holding the role. Admin can always act at any step regardless of this matrix.</p>
    </div>
    <div id="matrix-body"></div>`;
  const body = document.getElementById('matrix-body');
  body.innerHTML = data.chains.map(c => `
    <div class="panel" style="margin-bottom:12px;">
      <h4 style="margin:0 0 4px;">${esc(c.name)}</h4>
      <p class="muted" style="margin-top:0;">${esc(c.description)||''}</p>
      <div id="matrix-chain-${c.id}"></div>
      <button class="btn small outline" type="button" onclick="addMatrixStep(${c.id})">+ Add Step</button>
      <button class="btn small" onclick="saveMatrixChain(${c.id})" style="margin-left:8px;">Save ${esc(c.name)}</button>
    </div>`).join('');
  window.__MATRIX_ROLES = data.roles;
  data.chains.forEach(c => renderMatrixSteps(c.id, c.steps));
};
function renderMatrixSteps(chainId, steps) {
  const el = document.getElementById('matrix-chain-' + chainId);
  const roles = window.__MATRIX_ROLES || [];
  el.innerHTML = `<table><thead><tr><th>Step</th><th>Approver Role</th><th>Min. Amount (₹)</th><th>Requires HOD/Supervisor</th><th></th></tr></thead>
    <tbody id="matrix-rows-${chainId}">
      ${steps.map((s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><select class="mx-role">${roles.map(r => `<option value="${r.id}" ${r.id===s.approver_role_id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></td>
          <td><input class="mx-amount" type="number" value="${s.min_amount||0}" style="width:110px;"></td>
          <td style="text-align:center;"><input class="mx-hod" type="checkbox" ${s.requires_supervisor ? 'checked' : ''}></td>
          <td><button class="btn small outline" type="button" onclick="this.closest('tr').remove()">Remove</button></td>
        </tr>`).join('')}
    </tbody></table>`;
}
window.addMatrixStep = (chainId) => {
  const tbody = document.getElementById('matrix-rows-' + chainId);
  const roles = window.__MATRIX_ROLES || [];
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${tbody.children.length + 1}</td>
    <td><select class="mx-role">${roles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></td>
    <td><input class="mx-amount" type="number" value="0" style="width:110px;"></td>
    <td style="text-align:center;"><input class="mx-hod" type="checkbox"></td>
    <td><button class="btn small outline" type="button" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
};
window.saveMatrixChain = async (chainId) => {
  const rows = document.querySelectorAll(`#matrix-rows-${chainId} tr`);
  const steps = Array.from(rows).map(tr => ({
    approver_role_id: Number(tr.querySelector('.mx-role').value),
    min_amount: Number(tr.querySelector('.mx-amount').value) || 0,
    requires_supervisor: tr.querySelector('.mx-hod').checked,
  }));
  try {
    await api(`/admin/approval-matrix/${chainId}`, { method: 'PUT', body: JSON.stringify({ steps }) });
    navigate('approval-matrix');
  } catch (e) { alert(e.message); }
};

// ---- FOC (Free of Cost) Material Issue ----
// Department HOD/Supervisor logins raise these (linked to a sales order
// wherever possible); Management/Admin approve or reject them. All fields
// stay editable while a request is Pending.
PAGES.foc = async (el) => {
  const [reqs, orders, clients, departments] = await Promise.all([api('/finance/foc'), api('/sales/orders'), api('/masters/clients'), api('/masters/departments')]);
  const canRequest = has('foc.request') && (ME.is_supervisor || ME.role === 'Admin');
  const canApprove = has('foc.approve');
  window.FOC_DEPARTMENTS = departments;
  el.innerHTML = `
    ${canRequest ? `
    <div class="panel"><h3>New FOC Material Request</h3>
      <div class="form-grid">
        <div><label>Linked Sales Order (optional)</label><select id="foc-so" onchange="document.getElementById('foc-customer-wrap').style.display = this.value ? 'none' : 'grid'">
          <option value="">-- Not linked to an order --</option>${orders.map(o => `<option value="${o.id}">${esc(o.order_no)} - ${esc(o.client_name)}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid" id="foc-customer-wrap">
        <div><label>Customer (from Clients)</label><select id="foc-client" onchange="document.getElementById('foc-manual-wrap').style.display = this.value ? 'none' : 'grid'">
          <option value="">-- Enter customer manually instead --</option>
          ${clients.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.client_code)})</option>`).join('')}
        </select></div>
        <div><label>Contact Person</label><input id="foc-contact-person"></div>
        <div><label>Contact Number</label><input id="foc-contact-phone"></div>
      </div>
      <div class="form-grid" id="foc-manual-wrap">
        <div><label>Customer Name (manual)</label><input id="foc-cust-name"></div>
      </div>
      <div class="form-grid">
        <div><label>Material / Item Description</label><input id="foc-desc" placeholder="e.g. M8 hex bolts, 2 boxes"></div>
        <div><label>Quantity</label><input id="foc-qty" type="number" value="1"></div>
        <div><label>Unit</label><input id="foc-unit" value="Nos"></div>
        <div><label>Estimated Value (₹)</label><input id="foc-value" type="number" value="0"></div>
        <div><label>Reason</label><input id="foc-reason" placeholder="Why this needs to go out free of cost"></div>
        <div><label>Supporting Document</label><input id="foc-file" type="file"></div>
      </div>
      <button class="btn" onclick="addFOC()">Submit Request</button>
      <div class="muted" style="margin-top:8px;">Approval: Management/Admin.</div>
    </div>` : ''}
    ${collapsiblePanel('foc-requests-list', `FOC Requests (${reqs.length})`, `
      ${tableHTML(['FOC No', 'Order', 'Customer', 'Requesting Dept', 'Item', 'Qty', 'Value', 'Requested By', 'Fulfilling Dept', 'Status', 'Action', ''], reqs, r => `
        <tr><td>${esc(r.foc_no)}</td><td>${esc(r.order_no)||'-'}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${esc(r.department_name)||'-'}</td>
        <td>${focEditableCell(r, 'item_description')}</td><td>${focEditableCell(r, 'quantity')} ${esc(r.unit)}</td><td>₹${fmt(r.estimated_value)}</td>
        <td>${esc(r.requested_by_name)}</td><td>${esc(r.fulfilling_department_name)||'-'}</td><td>${badge(r.status)}</td>
        <td>${focActions(r, canApprove)}</td>
        <td>
          <button class="btn small outline" type="button" onclick="toggleFOCAttachments(${r.id})">Attachments</button>
          ${r.status === 'Approved' || r.status === 'Issued' ? `<button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/foc/${r.id}/pdf', '${esc(r.foc_no)}-Annexure.pdf')">Print Annexure</button>` : ''}
        </td></tr>
        <tr id="foc-att-row-${r.id}" style="display:none;"><td colspan="12"><div id="foc-attachments-${r.id}"></div></td></tr>`)}
    `)}`;
};
window.toggleFOCAttachments = (id) => {
  const row = document.getElementById(`foc-att-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderAttachmentsWidget('foc_request', id, document.getElementById(`foc-attachments-${id}`));
};
function focEditableCell(r, field) {
  return r.status === 'Pending' ? `<span contenteditable="true" class="inline-edit" onblur="editFOCField(${r.id}, '${field}', this.textContent)">${esc(r[field])}</span>` : esc(r[field]);
}
function focActions(r, canApprove) {
  if (r.status === 'Pending' && canApprove) {
    // The approver must pick which department will issue the material
    // before Approve or Reject is even clickable - routing is decided as
    // part of the decision, not as a separate step afterward.
    const deptOptions = (window.FOC_DEPARTMENTS || []).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    return `
      <select id="foc-dept-${r.id}" style="margin-bottom:4px;" onchange="document.getElementById('foc-approve-${r.id}').disabled = !this.value; document.getElementById('foc-reject-${r.id}').disabled = !this.value;">
        <option value="">-- Route to department --</option>${deptOptions}
      </select><br>
      <button class="btn small green" id="foc-approve-${r.id}" disabled onclick="focAction(${r.id}, 'approve')">Approve</button>
      <button class="btn small red" id="foc-reject-${r.id}" disabled onclick="focAction(${r.id}, 'reject')">Reject</button>`;
  }
  // Mark Issued is now gated to the department this was actually routed to
  // (or Admin) - the real enforcement is server-side; this just avoids
  // showing a button that would 403 for a department it wasn't routed to.
  const canIssue = r.status === 'Approved' && (ME.role === 'Admin'
    || (r.fulfilling_department_id && ME.department_id === r.fulfilling_department_id)
    || (!r.fulfilling_department_id && has('store.manage')));
  if (canIssue) {
    return `<button class="btn small" onclick="focAction(${r.id}, 'issue')">Mark Issued</button>`;
  }
  return '-';
}
window.addFOC = async () => {
  try {
    const { id } = await api('/finance/foc', { method: 'POST', body: JSON.stringify({
      sales_order_id: val('foc-so') || null,
      client_id: val('foc-client') || null, customer_name: val('foc-cust-name'),
      contact_person: val('foc-contact-person'), contact_phone: val('foc-contact-phone'),
      item_description: val('foc-desc'), quantity: val('foc-qty'),
      unit: val('foc-unit'), estimated_value: val('foc-value'), reason: val('foc-reason'),
    })});
    const fileInput = document.getElementById('foc-file');
    if (id && fileInput && fileInput.files.length) {
      const fd = new FormData(); fd.append('file', fileInput.files[0]);
      await apiUpload(`/attachments/foc_request/${id}`, fd);
    }
    navigate('foc');
  } catch (e) { alert(e.message); }
};
window.editFOCField = async (id, field, value) => {
  try { await api(`/finance/foc/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); }
  catch (e) { alert(e.message); navigate('foc'); }
};
window.focAction = async (id, action) => {
  try {
    const body = action === 'approve' ? { fulfilling_department_id: val(`foc-dept-${id}`) } : undefined;
    await api(`/finance/foc/${id}/${action}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    navigate('foc');
  } catch (e) { alert(e.message); }
};

// ===================== Round 5: Company Settings =====================
// Departments with no real external-communication role (shop-floor/internal
// production stages, or ones already covered elsewhere) - kept out of the
// Department Email Identities list below so it only shows departments that
// plausibly send PO/invoice/SOA-type mail to a vendor or client.
const DEPT_EMAIL_HIDDEN = ['Admin', 'Assembling', 'Installation', 'Laser & Bending Processing', 'Management', 'Manufacturing', 'Project Management', 'Store'];
PAGES['company-settings'] = async (el) => {
  const [company, email, departments] = await Promise.all([api('/settings/company'), api('/settings/email').catch(() => null), api('/masters/departments')]);
  el.innerHTML = `
    <div class="panel"><h3>Company Details</h3>
      <div class="form-grid">
        <div><label>Legal Name</label><input id="cs-legal" value="${esc(company.legal_name)}"></div>
        <div><label>Trade Name</label><input id="cs-trade" value="${esc(company.trade_name)}"></div>
        <div><label>GSTIN</label><input id="cs-gstin" value="${esc(company.gstin)}"></div>
        <div><label>PAN</label><input id="cs-pan" value="${esc(company.pan)}"></div>
        <div><label>CIN</label><input id="cs-cin" value="${esc(company.cin)}"></div>
        <div><label>State</label><input id="cs-state" value="${esc(company.state)}"></div>
        <div><label>State Code</label><input id="cs-state-code" value="${esc(company.state_code)}"></div>
        <div><label>Default Place of Supply</label><input id="cs-pos" value="${esc(company.default_place_of_supply)}"></div>
        <div><label>Default GST Rate (%)</label><input id="cs-gst-rate" type="number" value="${esc(company.default_gst_rate)}"></div>
      </div>
      <div><label>Registered Address</label><textarea id="cs-reg-addr" rows="2" style="width:100%;">${esc(company.registered_address)}</textarea></div>
      <div><label>Factory/Branch Address</label><textarea id="cs-factory-addr" rows="2" style="width:100%;">${esc(company.factory_address)}</textarea></div>
      <h4>Bank Details (for receiving payments)</h4>
      <div class="form-grid">
        <div><label>Bank Name</label><input id="cs-bank-name" value="${esc(company.bank_name)}"></div>
        <div><label>Account Number</label><input id="cs-bank-acc" value="${esc(company.bank_account_number)}"></div>
        <div><label>IFSC</label><input id="cs-bank-ifsc" value="${esc(company.bank_ifsc)}"></div>
        <div><label>Branch</label><input id="cs-bank-branch" value="${esc(company.bank_branch)}"></div>
      </div>
      <h4>Authorized Signatory</h4>
      <div class="form-grid">
        <div><label>Name</label><input id="cs-sig-name" value="${esc(company.authorized_signatory_name)}"></div>
        <div><label>Designation</label><input id="cs-sig-desg" value="${esc(company.authorized_signatory_designation)}"></div>
      </div>
      <h4>Logo</h4>
      ${company.logo_path ? `<img src="${esc(company.logo_path)}" style="max-height:60px;display:block;margin-bottom:8px;">` : ''}
      <input type="file" id="cs-logo-file" accept="image/*">
      <button class="btn small outline" type="button" onclick="uploadCompanyLogo()">Upload Logo</button>
      <div style="margin-top:12px;">
        <button class="btn" onclick="saveCompanySettings()">Save Company Details</button>
      </div>
      <div id="cs-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    <div id="co-addresses-panel"></div>
    ${email ? `
    <div class="panel"><h3>Email Settings (SMTP)</h3>
      <p class="muted">DB values here override the SMTP_* environment variables. Leave blank to fall back to env vars. If neither is set, automated emails are skipped gracefully with a clear message.</p>
      <div class="form-grid">
        <div><label>SMTP Host</label><input id="es-host" value="${esc(email.smtp_host)}"></div>
        <div><label>SMTP Port</label><input id="es-port" type="number" value="${esc(email.smtp_port)}"></div>
        <div><label>SMTP User</label><input id="es-user" value="${esc(email.smtp_user)}"></div>
        <div><label>SMTP Password</label><input id="es-pass" type="password" value="${esc(email.smtp_pass)}"></div>
        <div><label>Use TLS/SSL (secure)</label><select id="es-secure"><option value="false" ${!email.smtp_secure ? 'selected' : ''}>No</option><option value="true" ${email.smtp_secure ? 'selected' : ''}>Yes</option></select></div>
        <div><label>From Name</label><input id="es-from-name" value="${esc(email.from_name)}"></div>
        <div><label>From Address</label><input id="es-from-addr" value="${esc(email.from_address)}"></div>
      </div>
      <div><label>Always CC (comma-separated)</label><input id="es-cc" style="width:100%;" value="${esc((email.cc_list||[]).join(', '))}"></div>
      <button class="btn" onclick="saveEmailSettings()" style="margin-top:10px;">Save Email Settings</button>
      <div id="es-err" class="msg err" style="display:none;margin-top:8px;"></div>
      <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">
        <div class="form-grid">
          <div><label>Send Test Email To</label><input id="es-test-to" placeholder="you@example.com"></div>
          <div style="align-self:end;"><button class="btn small outline" type="button" onclick="sendTestEmail()">Send Test Email</button></div>
        </div>
        <p class="muted">Sends a one-off test message using whatever's saved above (or the SMTP_* env vars if left blank) - the quickest way to confirm delivery actually works.</p>
        <div id="es-test-result" class="msg" style="display:none;"></div>
      </div>
    </div>
    ${collapsiblePanel('department-email-identities', 'Department Email Identities', `
      <p class="muted">Optional per-department "From" name/address for outgoing mail (Purchase's PO/RFQ emails, Sales' Invoice/Proforma emails, Accounts / HR's SOA/BG reminder emails) - mail still relays through the one SMTP account above, so the address here has to actually be an alias/mailbox your mail provider recognizes for that account, or delivery can fail or get rewritten. Leave blank to keep using the global From Name/Address.</p>
      ${tableHTML(['Department', 'From Name', 'From Address', ''], departments.filter(d => !DEPT_EMAIL_HIDDEN.includes(d.name)), d => `
        <tr><td>${esc(d.name)}</td>
        <td><input id="dept-from-name-${d.id}" value="${esc(d.email_from_name)}" placeholder="${esc(email ? email.from_name : '')}"></td>
        <td><input id="dept-from-addr-${d.id}" value="${esc(d.email_from_address)}" placeholder="${esc(email ? email.from_address : '')}"></td>
        <td><button class="btn small outline" type="button" onclick="saveDepartmentEmailIdentity(${d.id})">Save</button></td></tr>`)}
      <div id="dept-email-err" class="msg err" style="display:none;margin-top:8px;"></div>
    `)}` : ''}
  `;
  renderCompanyAddressesPanel();
};
window.saveDepartmentEmailIdentity = async (id) => {
  const errEl = document.getElementById('dept-email-err');
  errEl.style.display = 'none';
  try {
    await api(`/masters/departments/${id}`, { method: 'PUT', body: JSON.stringify({
      email_from_name: val(`dept-from-name-${id}`), email_from_address: val(`dept-from-addr-${id}`),
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
async function renderCompanyAddressesPanel() {
  const panel = document.getElementById('co-addresses-panel');
  if (!panel) return;
  const addresses = await api('/settings/company-addresses');
  const addrRow = (a) => `<tr>
      <td>${esc(a.address_type)}${a.is_default ? ' <span class="badge active">Default</span>' : ''}</td>
      <td>${esc(a.label)||'-'}</td>
      <td>${[a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).map(esc).join(', ')}</td>
      <td>${esc(a.gstin)||'-'}</td>
      <td><button class="btn small outline" onclick="deleteCompanyAddress(${a.id})">Delete</button></td>
    </tr>`;
  panel.innerHTML = `
    <div class="panel"><h3>Company Bill-to / Ship-to Addresses</h3>
      <p class="muted">Separate factory/office locations, each selectable when creating a Purchase Order so the right address flows into the PO's PDF/Word document.</p>
      ${tableHTML(['Type', 'Label', 'Address', 'GSTIN', ''], addresses, addrRow)}
      <div class="form-grid" style="margin-top:10px;">
        <div><label>Type</label><select id="coaddr-type"><option value="Billing">Billing</option><option value="Shipping">Shipping</option></select></div>
        <div><label>Label</label><input id="coaddr-label" placeholder="e.g. Head Office, Factory - Faridabad"></div>
        <div><label>GSTIN</label><input id="coaddr-gstin"></div>
        <div style="grid-column:1/-1;"><label>Address Line 1</label><input id="coaddr-line1"></div>
        <div style="grid-column:1/-1;"><label>Address Line 2</label><input id="coaddr-line2"></div>
        <div><label>City</label><input id="coaddr-city"></div>
        <div><label>State</label><input id="coaddr-state"></div>
        <div><label>State Code</label><input id="coaddr-state-code" placeholder="e.g. 06"></div>
        <div><label>Pincode</label><input id="coaddr-pincode"></div>
        <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="coaddr-default" type="checkbox"> Set as default for this type</label></div>
      </div>
      <button class="btn" onclick="addCompanyAddress()">Add Address</button>
      <div id="coaddr-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>`;
}
window.addCompanyAddress = async () => {
  const errEl = document.getElementById('coaddr-err');
  errEl.style.display = 'none';
  try {
    await api('/settings/company-addresses', { method: 'POST', body: JSON.stringify({
      address_type: val('coaddr-type'), label: val('coaddr-label'), line1: val('coaddr-line1'), line2: val('coaddr-line2'),
      city: val('coaddr-city'), state: val('coaddr-state'), state_code: val('coaddr-state-code'), pincode: val('coaddr-pincode'),
      gstin: val('coaddr-gstin'), is_default: document.getElementById('coaddr-default').checked,
    })});
    renderCompanyAddressesPanel();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteCompanyAddress = async (id) => {
  if (!confirm('Delete this address?')) return;
  try { await api('/settings/company-addresses/' + id, { method: 'DELETE' }); renderCompanyAddressesPanel(); }
  catch (e) { alert(e.message); }
};
window.saveCompanySettings = async () => {
  const errEl = document.getElementById('cs-err'); errEl.style.display = 'none';
  try {
    await api('/settings/company', { method: 'PUT', body: JSON.stringify({
      legal_name: val('cs-legal'), trade_name: val('cs-trade'), gstin: val('cs-gstin'), pan: val('cs-pan'), cin: val('cs-cin'),
      state: val('cs-state'), state_code: val('cs-state-code'), default_place_of_supply: val('cs-pos'), default_gst_rate: val('cs-gst-rate'),
      registered_address: val('cs-reg-addr'), factory_address: val('cs-factory-addr'),
      bank_name: val('cs-bank-name'), bank_account_number: val('cs-bank-acc'), bank_ifsc: val('cs-bank-ifsc'), bank_branch: val('cs-bank-branch'),
      authorized_signatory_name: val('cs-sig-name'), authorized_signatory_designation: val('cs-sig-desg'),
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.uploadCompanyLogo = async () => {
  const fileEl = document.getElementById('cs-logo-file');
  if (!fileEl.files.length) { alert('Choose a logo image first.'); return; }
  const fd = new FormData(); fd.append('logo', fileEl.files[0]);
  try { await apiUpload('/settings/company/logo', fd, 'POST'); navigate('company-settings'); } catch (e) { alert(e.message); }
};
window.saveEmailSettings = async () => {
  const errEl = document.getElementById('es-err'); errEl.style.display = 'none';
  try {
    await api('/settings/email', { method: 'PUT', body: JSON.stringify({
      smtp_host: val('es-host'), smtp_port: val('es-port'), smtp_user: val('es-user'), smtp_pass: val('es-pass'),
      smtp_secure: val('es-secure') === 'true', from_name: val('es-from-name'), from_address: val('es-from-addr'), cc_list: val('es-cc'),
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.sendTestEmail = async () => {
  const resultEl = document.getElementById('es-test-result');
  const to = val('es-test-to');
  if (!to) { alert('Enter an email address to send the test to.'); return; }
  resultEl.className = 'msg';
  resultEl.style.display = 'block';
  resultEl.textContent = 'Sending...';
  try {
    const r = await api('/settings/email/test', { method: 'POST', body: JSON.stringify({ to }) });
    resultEl.className = r.sent ? 'msg ok' : 'msg err';
    resultEl.textContent = r.sent ? `Sent successfully to ${to}. Check that inbox to confirm.` : (r.reason || 'Failed to send - check the SMTP settings above.');
  } catch (e) {
    resultEl.className = 'msg err';
    resultEl.textContent = e.message;
  }
};

// ===================== Round 5: Sales Invoices =====================
PAGES['sales-invoices'] = async (el) => {
  const [invoices, orders, proformas] = await Promise.all([api('/finance/invoices'), api('/sales/orders').catch(() => api('/sales')), api('/finance/proforma-invoices')]);
  el.innerHTML = `
    <div class="panel"><h3>Generate Invoice from Sales Order</h3>
      <div class="form-grid">
        <div><label>Sales Order</label><select id="inv-so">${(orders||[]).map(o => `<option value="${o.id}">${esc(o.order_no)} - ${esc(o.description||'')}${o.status === 'Invoiced' ? ' (already invoiced)' : ''}</option>`).join('')}</select></div>
        <div><label>Buyer State</label><input id="inv-buyer-state" placeholder="e.g. Haryana"></div>
        <div><label>Buyer GSTIN</label><input id="inv-buyer-gstin"></div>
        <div><label>Item Description</label><input id="inv-desc" placeholder="Defaults to order description"></div>
        <div><label>HSN/SAC</label><input id="inv-hsn"></div>
        <div><label>Qty</label><input id="inv-qty" type="number" value="1"></div>
        <div><label>Rate (₹)</label><input id="inv-rate" type="number"></div>
        <div><label>GST Rate (%)</label><input id="inv-gst-rate" type="number" value="18"></div>
      </div>
      <button class="btn" onclick="generateInvoice()">Generate Invoice</button>
      <div id="inv-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    ${collapsiblePanel('sales-invoices-list', `Invoices (${invoices.length})`, `
      ${tableHTML(['Invoice No', 'Client', 'Date', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Status', ''], invoices, i => `
        <tr><td>${esc(i.invoice_no)}</td><td>${esc(i.client_name)}</td><td>${new Date(i.invoice_date).toLocaleDateString()}</td>
        <td>₹${fmt(i.taxable_value)}</td><td>₹${fmt(i.cgst)}</td><td>₹${fmt(i.sgst)}</td><td>₹${fmt(i.igst)}</td><td>₹${fmt(i.total_value)}</td><td>${badge(i.status)}</td>
        <td>
          <button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/invoices/${i.id}/pdf', '${esc(i.invoice_no).replace(/\//g,'-')}.pdf')">PDF</button>
          <button class="btn small outline" type="button" onclick="emailInvoice(${i.id})">Email to Client</button>
          ${i.status !== 'Paid' ? `<button class="btn small" type="button" onclick="markInvoicePaid(${i.id})">Mark Paid</button>` : ''}
          ${i.status === 'Draft' ? `<button class="btn small outline" type="button" onclick="cancelInvoice(${i.id})">Cancel</button>` : ''}
        </td></tr>`)}
    `)}
    <div class="panel"><h3>Generate Proforma Invoice (Advance / Pre-Dispatch)</h3>
      <p class="muted">Not a tax invoice - a payment request document for an advance or pre-dispatch payment term.</p>
      <div class="form-grid">
        <div><label>Sales Order</label><select id="pf-so" onchange="loadPFMilestones()">${(orders||[]).map(o => `<option value="${o.id}">${esc(o.order_no)} - ${esc(o.description||'')}</option>`).join('')}</select></div>
        <div><label>Type</label><select id="pf-type"><option value="Advance">Advance</option><option value="PreDispatch">Payment Before Dispatch</option></select></div>
        <div><label>Payment Milestone (optional)</label><select id="pf-milestone"><option value="">-- None / manual amount --</option></select></div>
        <div><label>Amount (₹, if no milestone)</label><input id="pf-amount" type="number"></div>
        <div><label>Buyer State</label><input id="pf-buyer-state" placeholder="e.g. Haryana"></div>
        <div><label>Buyer GSTIN</label><input id="pf-buyer-gstin"></div>
      </div>
      <button class="btn" onclick="generateProforma()">Generate Proforma Invoice</button>
      <div id="pf-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    ${collapsiblePanel('proforma-invoices-list', `Proforma Invoices (${proformas.length})`, `
      ${tableHTML(['Proforma No', 'Client', 'Order', 'Type', 'Milestone', 'Total', 'Status', ''], proformas, p => `
        <tr><td>${esc(p.proforma_no)}</td><td>${esc(p.client_name)}</td><td>${esc(p.order_no)}</td><td>${p.invoice_type === 'Advance' ? 'Advance' : 'Pre-Dispatch'}</td>
        <td>${esc(p.milestone_name)||'-'}</td><td>₹${fmt(p.total_value)}</td><td>${badge(p.status)}</td>
        <td>
          <button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/proforma-invoices/${p.id}/pdf', '${esc(p.proforma_no).replace(/\//g,'-')}.pdf')">PDF</button>
          <button class="btn small outline" type="button" onclick="emailProforma(${p.id})">Email to Client</button>
          ${p.status === 'Draft' ? `<button class="btn small" type="button" onclick="markProformaReceived(${p.id})">Mark Received</button>
          <button class="btn small outline" type="button" onclick="cancelProforma(${p.id})">Cancel</button>` : ''}
        </td></tr>`)}
    `)}`;
};
window.loadPFMilestones = async () => {
  const sel = document.getElementById('pf-milestone');
  sel.innerHTML = '<option value="">-- None / manual amount --</option>';
  const soId = val('pf-so');
  if (!soId) return;
  try {
    const ms = await api(`/bg/milestones?order_type=SO&order_id=${soId}`);
    sel.innerHTML += ms.map(m => `<option value="${m.id}">${esc(m.milestone_name)} (${m.percentage ? m.percentage + '%' : '₹' + fmt(m.amount)})</option>`).join('');
  } catch (e) { /* no milestone read access - manual amount still works */ }
};
window.generateProforma = async () => {
  const errEl = document.getElementById('pf-err'); errEl.style.display = 'none';
  const soId = val('pf-so');
  if (!soId) { errEl.textContent = 'Pick a sales order.'; errEl.style.display = 'block'; return; }
  try {
    const r = await api(`/finance/proforma-invoices/from-sales-order/${soId}`, { method: 'POST', body: JSON.stringify({
      invoice_type: val('pf-type'), milestone_id: val('pf-milestone') || null, amount: val('pf-amount') || undefined,
      buyer_state: val('pf-buyer-state'), buyer_gstin: val('pf-buyer-gstin'),
    })});
    // Doesn't block creation (Finance may legitimately need to invoice
    // before the bank paperwork clears) - just surfaces the gap loudly
    // right when it matters, since the page navigates away immediately
    // after. The same warning is also filed as a standing notification
    // (see routes/finance.js) so it isn't lost once this alert is dismissed.
    if (r.bgWarning) alert(r.bgWarning);
    navigate('sales-invoices');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.markProformaReceived = async (id) => {
  try { await api(`/finance/proforma-invoices/${id}/mark-received`, { method: 'POST' }); navigate('sales-invoices'); } catch (e) { alert(e.message); }
};
window.cancelProforma = async (id) => {
  if (!confirm('Cancel this proforma invoice?')) return;
  try { await api(`/finance/proforma-invoices/${id}/cancel`, { method: 'POST' }); navigate('sales-invoices'); } catch (e) { alert(e.message); }
};
window.emailProforma = async (id) => {
  try {
    const r = await api(`/finance/proforma-invoices/${id}/email`, { method: 'POST' });
    alert(r.sent ? `Emailed to ${r.to}` : `Not sent: ${r.message}`);
  } catch (e) { alert(e.message); }
};
window.generateInvoice = async () => {
  const errEl = document.getElementById('inv-err'); errEl.style.display = 'none';
  const soId = val('inv-so');
  if (!soId) { errEl.textContent = 'Pick a sales order.'; errEl.style.display = 'block'; return; }
  try {
    await api(`/finance/invoices/from-sales-order/${soId}`, { method: 'POST', body: JSON.stringify({
      buyer_state: val('inv-buyer-state'), buyer_gstin: val('inv-buyer-gstin'),
      items: val('inv-rate') ? [{ description: val('inv-desc'), hsn_code: val('inv-hsn'), quantity: val('inv-qty') || 1, rate: val('inv-rate'), gst_rate: val('inv-gst-rate') || 18 }] : undefined,
    })});
    navigate('sales-invoices');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.markInvoicePaid = async (id) => {
  try { await api(`/finance/invoices/${id}/mark-paid`, { method: 'POST' }); navigate('sales-invoices'); } catch (e) { alert(e.message); }
};
window.cancelInvoice = async (id) => {
  if (!confirm('Cancel this draft invoice? This frees up the sales order to be invoiced again.')) return;
  try { await api(`/finance/invoices/${id}/cancel`, { method: 'POST' }); navigate('sales-invoices'); } catch (e) { alert(e.message); }
};
window.emailInvoice = async (id) => {
  try {
    const result = await api(`/finance/invoices/${id}/email`, { method: 'POST' });
    alert(result.sent ? `Invoice emailed to ${result.to}.` : (result.message || 'Email was not sent.'));
  } catch (e) { alert(e.message); }
};

// ===================== Statement of Accounts =====================
// Automated per-client statements: a Monthly/Quarterly org-wide default,
// overridable per client, feeds a background scan (lib/soaScan.js) that
// queues a statement for internal review - never emails a customer directly.
// This page is where Accounts sets the cadence and works the review queue;
// day-to-day payment recording and one-off statement downloads live on each
// client's own Customer 360 modal (see soaSectionHTML above).
PAGES.soa = async (el) => {
  const [settings, pending, clients] = await Promise.all([
    api('/soa/settings'), api('/soa/pending'), api('/masters/clients'),
  ]);
  el.innerHTML = `
    <div class="panel">
      <h3>Org-Wide Default</h3>
      <div class="form-grid">
        <div><label>Frequency</label><select id="soa-org-freq">
          ${['Off', 'Monthly', 'Quarterly'].map(f => `<option value="${f}" ${settings.org.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select></div>
        <div><label><input type="checkbox" id="soa-org-enabled" ${settings.org.enabled ? 'checked' : ''}> Enabled</label></div>
      </div>
      <button class="btn small" onclick="saveSoaOrgSettings()">Save Default</button>
      <button class="btn small outline" onclick="runSoaScanNow()" style="margin-left:6px;">Run Scan Now</button>
      <p class="muted" style="margin-top:8px;">Every client follows this default unless given their own override below. A statement is only ever queued here for internal review - nothing is emailed to a customer without Verify + Send.</p>
    </div>
    <div class="panel">
      <h3>Per-Client Overrides (${settings.overrides.length})</h3>
      <div class="form-grid">
        <div><label>Client</label><select id="soa-ov-client">${clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Frequency</label><select id="soa-ov-freq"><option>Off</option><option>Monthly</option><option>Quarterly</option></select></div>
        <div><label><input type="checkbox" id="soa-ov-enabled"> Enabled</label></div>
      </div>
      <button class="btn small" onclick="saveSoaClientOverride()">Set Override</button>
      ${tableHTML(['Client', 'Frequency', 'Enabled', ''], settings.overrides, o => `
        <tr><td>${esc(o.client_name)}</td><td>${esc(o.frequency)}</td><td>${o.enabled ? 'Yes' : 'No'}</td>
        <td><button class="btn small outline" type="button" onclick="clearSoaClientOverride(${o.client_id})">Clear (use default)</button></td></tr>`)}
    </div>
    <div class="panel">
      <h3>Pending Review (${pending.length})</h3>
      <p class="muted">Internal check before anything reaches a customer - review the figures, Verify, then Send.</p>
      ${tableHTML(['Client', 'Period', 'Closing Balance', 'Generated', 'Status', 'Action'], pending, p => `
        <tr><td>${esc(p.client_name)}</td><td>${p.period_start} to ${p.period_end}</td><td>₹${fmt(p.closing_balance)}</td>
        <td>${new Date(p.generated_at).toLocaleDateString()}</td><td>${badge(p.status)}</td>
        <td>
          <a href="#" onclick="downloadSoaPeriodPdf(${p.client_id}, '${p.period_start}', '${p.period_end}');return false;">PDF</a>
          ${p.status === 'PendingReview' ? `<button class="btn small" type="button" onclick="verifySoa(${p.id})">Verify</button>` : ''}
          ${p.status === 'Verified' ? `<button class="btn small green" type="button" onclick="sendSoaEmail(${p.id})" ${p.client_email ? '' : 'disabled title="No email on file"'}>Send Email</button>` : ''}
          <button class="btn small outline" type="button" onclick="dismissSoa(${p.id})">Dismiss</button>
        </td></tr>`)}
    </div>`;
};
window.saveSoaOrgSettings = async () => {
  try {
    await api('/soa/settings/org', { method: 'PUT', body: JSON.stringify({ frequency: val('soa-org-freq'), enabled: document.getElementById('soa-org-enabled').checked }) });
    navigate('soa');
  } catch (e) { alert(e.message); }
};
window.saveSoaClientOverride = async () => {
  try {
    await api('/soa/settings/client/' + val('soa-ov-client'), { method: 'PUT', body: JSON.stringify({ frequency: val('soa-ov-freq'), enabled: document.getElementById('soa-ov-enabled').checked }) });
    navigate('soa');
  } catch (e) { alert(e.message); }
};
window.clearSoaClientOverride = async (clientId) => {
  try { await api('/soa/settings/client/' + clientId, { method: 'DELETE' }); navigate('soa'); } catch (e) { alert(e.message); }
};
window.runSoaScanNow = async () => {
  try {
    const r = await api('/soa/scan', { method: 'POST' });
    alert(`${r.created} statement(s) queued for review.`);
    navigate('soa');
  } catch (e) { alert(e.message); }
};
window.downloadSoaPeriodPdf = (clientId, from, to) => downloadTemplateFile(`/soa/ledger/${clientId}/pdf?from=${from}&to=${to}`, `SOA-${clientId}-${from}-to-${to}.pdf`);
window.verifySoa = async (id) => {
  try { await api(`/soa/${id}/verify`, { method: 'POST' }); navigate('soa'); } catch (e) { alert(e.message); }
};
window.dismissSoa = async (id) => {
  if (!confirm('Dismiss this statement without sending it?')) return;
  try { await api(`/soa/${id}/dismiss`, { method: 'POST' }); navigate('soa'); } catch (e) { alert(e.message); }
};
window.sendSoaEmail = async (id) => {
  try {
    const r = await api(`/soa/${id}/send-email`, { method: 'POST' });
    alert(r.sent ? `Emailed to ${r.to}` : `Not sent: ${r.message}`);
    navigate('soa');
  } catch (e) { alert(e.message); }
};

// ===================== Round 5: Operating Expenses =====================
// The list is scoped to one month at a time (server-side - see GET
// /operating-expenses in routes/finance.js) so a growing transaction
// history never means fetching and rendering everything on every visit;
// "Show All" is an explicit, occasional opt-out. Both this list and the
// summary panel below default to collapsed, per the app-wide convention
// (see collapsiblePanel) that a long transaction list stays out of the
// way until actually needed.
let OE_LIST_MONTH = null;
let OE_SUMMARY_YEAR = null;
PAGES['operating-expenses'] = async (el) => {
  const listMonth = OE_LIST_MONTH || new Date().toISOString().slice(0, 7);
  OE_LIST_MONTH = listMonth;
  const summaryYear = OE_SUMMARY_YEAR || String(new Date().getFullYear());
  OE_SUMMARY_YEAR = summaryYear;
  const [rows, categories, summary] = await Promise.all([
    api('/finance/operating-expenses?month=' + listMonth),
    api('/finance/operating-expense-categories'),
    api('/finance/operating-expenses/summary?year=' + summaryYear),
  ]);
  const activeCats = categories.filter(c => c.active);
  const isAdmin = ME && ME.role === 'Admin';
  const monthLabels = summary.months.map(m => m.slice(5));
  el.innerHTML = `
    <div class="panel"><h3>New Operating Expense</h3>
      <div class="form-grid">
        <div><label>Date</label><input id="oe-date" type="date"></div>
        <div><label>Category</label><select id="oe-category">
          <option value="">-- Select --</option>
          ${activeCats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
        </select></div>
        <div><label>Amount (₹)</label><input id="oe-amount" type="number"></div>
        <div><label>Paid Via</label><select id="oe-paid-via"><option>Bank</option><option>Cash</option></select></div>
      </div>
      <div><label>Description</label><input id="oe-desc" style="width:100%;"></div>
      <button class="btn" onclick="addOperatingExpense()" style="margin-top:8px;">Add Expense</button>
      ${isAdmin ? `<button class="btn small outline" type="button" onclick="openOeCategoryManager()" style="margin-top:8px;margin-left:8px;">Manage Categories</button>` : ''}
      <div id="oe-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    ${collapsiblePanel('operating-expenses-list', `Operating Expenses - ${listMonth === 'all' ? 'All Time' : listMonth} (${rows.length})`, `
      <div class="form-grid" style="margin-bottom:10px;">
        <div><label>Month</label><input type="month" id="oe-list-month" value="${listMonth === 'all' ? '' : listMonth}" onchange="OE_LIST_MONTH=this.value;navigate('operating-expenses')"></div>
        <div style="align-self:end;"><button class="btn small outline" type="button" onclick="OE_LIST_MONTH='all';navigate('operating-expenses')">Show All</button></div>
      </div>
      ${tableHTML(['Date', 'Category', 'Description', 'Amount', 'Paid Via'], rows, r => `
        <tr><td>${new Date(r.expense_date).toLocaleDateString()}</td><td>${esc(r.category)}</td><td>${esc(r.description)}</td><td>₹${fmt(r.amount)}</td><td>${esc(r.paid_via)}</td></tr>`)}
    `)}
    ${collapsiblePanel('operating-expenses-summary', `Monthly Category Summary - ${summaryYear}`, `
      <div class="form-grid" style="margin-bottom:10px;">
        <div><label>Year</label><input type="number" id="oe-summary-year" value="${summaryYear}" onchange="OE_SUMMARY_YEAR=this.value;navigate('operating-expenses')" style="width:100px;"></div>
      </div>
      <div style="overflow-x:auto;">
        <table><thead><tr><th>Category</th>${monthLabels.map(m => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${summary.categories.map(r => `<tr><td>${esc(r.category)}</td>${r.months.map(v => `<td>₹${fmt(v)}</td>`).join('')}<td><b>₹${fmt(r.months.reduce((a, b) => a + b, 0))}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td><b>Total</b></td>${summary.monthTotals.map(v => `<td><b>₹${fmt(v)}</b></td>`).join('')}<td><b>₹${fmt(summary.grandTotal)}</b></td></tr></tfoot>
        </table>
      </div>
    `)}`;
};
window.addOperatingExpense = async () => {
  const errEl = document.getElementById('oe-err'); errEl.style.display = 'none';
  try {
    await api('/finance/operating-expenses', { method: 'POST', body: JSON.stringify({
      expense_date: val('oe-date') || undefined, category: val('oe-category') || undefined, description: val('oe-desc'), amount: val('oe-amount'), paid_via: val('oe-paid-via'),
    })});
    navigate('operating-expenses');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Admin: manage the Operating Expense category dropdown list ----
window.openOeCategoryManager = async () => {
  const categories = await api('/finance/operating-expense-categories');
  const body = `
    <div class="form-grid">
      <div><label>New Category Name</label><input id="oec-name"></div>
      <div><label>Sort Order</label><input id="oec-sort" type="number" value="${categories.length}"></div>
    </div>
    <button class="btn small" type="button" onclick="addOeCategory()">Add Category</button>
    <div id="oec-err" class="msg err" style="display:none;margin-top:8px;"></div>
    <div id="oec-list-wrap" style="margin-top:12px;">${oeCategoryListHTML(categories)}</div>`;
  openMiniModal('Manage Operating Expense Categories', body, true);
};
function oeCategoryListHTML(categories) {
  return tableHTML(['Name', 'Sort', 'Active', ''], categories, c => `
    <tr><td>${esc(c.name)}</td><td>${c.sort_order}</td><td>${c.active ? 'Yes' : 'No'}</td>
    <td><button class="btn small outline" type="button" onclick="toggleOeCategory(${c.id}, ${c.active ? 0 : 1})">${c.active ? 'Deactivate' : 'Activate'}</button></td></tr>`);
}
window.addOeCategory = async () => {
  const errEl = document.getElementById('oec-err'); errEl.style.display = 'none';
  try {
    await api('/finance/operating-expense-categories', { method: 'POST', body: JSON.stringify({ name: val('oec-name'), sort_order: val('oec-sort') }) });
    const categories = await api('/finance/operating-expense-categories');
    document.getElementById('oec-list-wrap').innerHTML = oeCategoryListHTML(categories);
    document.getElementById('oec-name').value = '';
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.toggleOeCategory = async (id, active) => {
  await api('/finance/operating-expense-categories/' + id, { method: 'PUT', body: JSON.stringify({ active }) });
  const categories = await api('/finance/operating-expense-categories');
  document.getElementById('oec-list-wrap').innerHTML = oeCategoryListHTML(categories);
};

// ===================== Round 5: GST Summary =====================
PAGES['gst-summary'] = async (el) => {
  el.innerHTML = `
    <div class="panel"><h3>GST Summary</h3>
      <div class="form-grid">
        <div><label>From</label><input id="gst-from" type="date"></div>
        <div><label>To</label><input id="gst-to" type="date"></div>
      </div>
      <button class="btn" onclick="loadGstSummary()">Run Report</button>
      <div id="gst-result" style="margin-top:16px;"></div>
      <p class="muted" style="margin-top:12px;">This is a reference report only, computed from invoices and purchase order GST fields recorded in this system - not an official GST filing tool. Verify with your GST practitioner before filing.</p>
    </div>`;
};
window.loadGstSummary = async () => {
  const q = new URLSearchParams();
  if (val('gst-from')) q.set('from', val('gst-from'));
  if (val('gst-to')) q.set('to', val('gst-to'));
  try {
    const r = await api('/finance/gst-summary?' + q.toString());
    document.getElementById('gst-result').innerHTML = `
      <table><tbody>
        <tr><td>Output CGST</td><td>₹${fmt(r.output.cgst)}</td></tr>
        <tr><td>Output SGST</td><td>₹${fmt(r.output.sgst)}</td></tr>
        <tr><td>Output IGST</td><td>₹${fmt(r.output.igst)}</td></tr>
        <tr><td><b>Total Output GST</b></td><td><b>₹${fmt(r.output.total)}</b></td></tr>
        <tr><td>Input Tax Credit (from Purchase Orders)</td><td>₹${fmt(r.input_tax_credit)}</td></tr>
        <tr><td><b>Net GST Payable</b></td><td><b>₹${fmt(r.net_payable)}</b></td></tr>
      </tbody></table>`;
  } catch (e) { alert(e.message); }
};

// ===================== Round 5: Asset Management =====================
PAGES['assets'] = async (el) => {
  const [assets, vendors, depts, employees] = await Promise.all([
    api('/assets'), api('/masters/vendors'), api('/masters/departments'), api('/hr/employees').catch(() => []),
  ]);
  el.innerHTML = `
    <div class="panel"><h3>Add Asset</h3>
      <div class="form-grid">
        <div><label>Asset Code</label><input id="as-code" placeholder="Auto if blank"></div>
        <div><label>Name</label><input id="as-name"></div>
        <div><label>Category</label><input id="as-category"></div>
        <div><label>Purchase Date</label><input id="as-purchase-date" type="date"></div>
        <div><label>Purchase Value (₹)</label><input id="as-purchase-value" type="number"></div>
        <div><label>Vendor</label><select id="as-vendor"><option value="">-</option>${vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
        <div><label>Department/Location</label><select id="as-dept"><option value="">-</option>${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Custodian</label><select id="as-custodian"><option value="">-</option>${(employees||[]).map(e => `<option value="${e.id}">${esc(e.full_name)}</option>`).join('')}</select></div>
        <div><label>Useful Life (Years)</label><input id="as-life" type="number" value="5"></div>
        <div><label>Salvage Value (₹)</label><input id="as-salvage" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addAsset()">Add Asset</button>
      <div id="as-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    <div class="panel"><h3>Filter</h3>
      <div class="form-grid">
        <div><label>Status</label><select id="as-filter-status" onchange="navigateAssetsFilter()"><option value="">All</option><option>Active</option><option>UnderMaintenance</option><option>Disposed</option><option>EOL</option></select></div>
      </div>
    </div>
    ${collapsiblePanel('asset-register-list', `Asset Register (${assets.length})`, `
      ${tableHTML(['Code', 'Name', 'Category', 'Dept', 'Custodian', 'Purchase Value', 'Book Value', 'Status', ''], assets, a => `
        <tr><td>${esc(a.asset_code)}</td><td>${esc(a.name)}</td><td>${esc(a.category)||'-'}</td><td>${esc(a.department_name)||'-'}</td>
        <td>${esc(a.custodian_name)||'-'}</td><td>₹${fmt(a.purchase_value)}</td><td>₹${fmt(a.book_value)}</td><td>${badge(a.status)}</td>
        <td><button class="btn small outline" type="button" onclick="viewAsset(${a.id})">Maintenance Log</button></td></tr>`)}
    `)}
    <div class="panel" id="as-detail-panel" style="display:none;"><h3>Asset Detail</h3><div id="as-detail-body"></div></div>`;
};
window.navigateAssetsFilter = () => navigate('assets');
window.addAsset = async () => {
  const errEl = document.getElementById('as-err'); errEl.style.display = 'none';
  try {
    await api('/assets', { method: 'POST', body: JSON.stringify({
      asset_code: val('as-code'), name: val('as-name'), category: val('as-category'), purchase_date: val('as-purchase-date'),
      purchase_value: val('as-purchase-value'), vendor_id: val('as-vendor') || null, department_id: val('as-dept') || null,
      custodian_id: val('as-custodian') || null, useful_life_years: val('as-life'), salvage_value: val('as-salvage'),
    })});
    navigate('assets');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.viewAsset = async (id) => {
  const { asset, logs } = await api('/assets/' + id);
  const panel = document.getElementById('as-detail-panel');
  document.getElementById('as-detail-body').innerHTML = `
    <p><b>${esc(asset.name)}</b> (${esc(asset.asset_code)}) — Book Value: ₹${fmt(asset.book_value)} — Status: ${badge(asset.status)}</p>
    <div class="form-grid">
      <div><label>Log Date</label><input id="ml-date" type="date"></div>
      <div><label>Type</label><select id="ml-type"><option>Preventive</option><option>Breakdown</option><option>Repair</option></select></div>
      <div><label>Cost (₹)</label><input id="ml-cost" type="number"></div>
      <div><label>Performed By</label><input id="ml-performed-by"></div>
      <div><label>Next Due Date</label><input id="ml-next-due" type="date"></div>
    </div>
    <div><label>Description</label><input id="ml-desc" style="width:100%;"></div>
    <button class="btn" onclick="addMaintenanceLog(${id})" style="margin-top:8px;">Add Maintenance Entry</button>
    ${tableHTML(['Date', 'Type', 'Description', 'Cost', 'Performed By', 'Next Due'], logs, l => `
      <tr><td>${new Date(l.log_date).toLocaleDateString()}</td><td>${esc(l.type)}</td><td>${esc(l.description)}</td><td>₹${fmt(l.cost)}</td><td>${esc(l.performed_by)}</td><td>${esc(l.next_due_date)||'-'}</td></tr>`)}
    <div class="form-grid" style="margin-top:12px;">
      <div><label>Status</label><select id="ml-status">
        ${['Active','UnderMaintenance','Disposed','EOL'].map(s => `<option ${s===asset.status?'selected':''}>${s}</option>`).join('')}
      </select></div>
      <div><label>Disposal Date</label><input id="ml-disposal-date" type="date" value="${esc(asset.disposal_date)||''}"></div>
      <div><label>Disposal Value (₹)</label><input id="ml-disposal-value" type="number" value="${asset.disposal_value||''}"></div>
    </div>
    <button class="btn outline" type="button" onclick="updateAssetStatus(${id})" style="margin-top:8px;">Update Status</button>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.addMaintenanceLog = async (assetId) => {
  try {
    await api(`/assets/${assetId}/maintenance`, { method: 'POST', body: JSON.stringify({
      log_date: val('ml-date') || undefined, type: val('ml-type'), description: val('ml-desc'), cost: val('ml-cost'),
      performed_by: val('ml-performed-by'), next_due_date: val('ml-next-due') || null,
    })});
    viewAsset(assetId);
  } catch (e) { alert(e.message); }
};
window.updateAssetStatus = async (assetId) => {
  try {
    await api(`/assets/${assetId}`, { method: 'PUT', body: JSON.stringify({
      status: val('ml-status'), disposal_date: val('ml-disposal-date') || null, disposal_value: val('ml-disposal-value') || null,
    })});
    navigate('assets');
  } catch (e) { alert(e.message); }
};
PAGES['assets-maintenance'] = async (el) => {
  const [due, eol] = await Promise.all([api('/assets/due-for-maintenance'), api('/assets/nearing-eol')]);
  el.innerHTML = `
    <div class="panel"><h3>Assets Due for Maintenance (next 30 days)</h3>
      ${tableHTML(['Code', 'Name', 'Next Due'], due, d => `<tr><td>${esc(d.asset_code)}</td><td>${esc(d.name)}</td><td>${esc(d.next_due_date)}</td></tr>`)}
    </div>
    <div class="panel"><h3>Assets Nearing End of Life (book value ≤ 15% of purchase value)</h3>
      ${tableHTML(['Code', 'Name', 'Purchase Value', 'Book Value'], eol, a => `<tr><td>${esc(a.asset_code)}</td><td>${esc(a.name)}</td><td>₹${fmt(a.purchase_value)}</td><td>₹${fmt(a.book_value)}</td></tr>`)}
    </div>`;
};

// ===================== Round 5: Ticketing =====================
PAGES['tickets-raise'] = async (el) => {
  const depts = await api('/masters/departments');
  el.innerHTML = `
    <div class="panel"><h3>Raise a Ticket</h3>
      <div class="form-grid">
        <div><label>Subject</label><input id="tk-subject"></div>
        <div><label>Category</label><input id="tk-category" placeholder="IT / Facilities / HR / Other"></div>
        <div><label>Priority</label><select id="tk-priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Urgent</option></select></div>
        <div><label>Target Department</label><select id="tk-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      </div>
      <div><label>Description</label><textarea id="tk-desc" rows="3" style="width:100%;"></textarea></div>
      <div style="margin-top:8px;"><label>Attachment (optional)</label><input id="tk-file" type="file"></div>
      <button class="btn" onclick="raiseTicket()" style="margin-top:8px;">Submit Ticket</button>
      <div id="tk-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>`;
};
window.raiseTicket = async () => {
  const errEl = document.getElementById('tk-err'); errEl.style.display = 'none';
  try {
    const result = await api('/tickets', { method: 'POST', body: JSON.stringify({
      subject: val('tk-subject'), description: val('tk-desc'), category: val('tk-category'), priority: val('tk-priority'), department_id: val('tk-dept'),
    })});
    const fileEl = document.getElementById('tk-file');
    if (fileEl && fileEl.files.length) {
      const fd = new FormData();
      fd.append('file', fileEl.files[0]);
      await apiUpload(`/attachments/ticket/${result.id}`, fd, 'POST');
    }
    navigate('tickets-mine');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
PAGES['tickets-mine'] = async (el) => renderTicketQueue(el, '/tickets/mine', 'My Tickets');
PAGES['tickets-department'] = async (el) => renderTicketQueue(el, '/tickets/department', "Department Tickets");
async function renderTicketQueue(el, apiPath, title) {
  const rows = await api(apiPath);
  const key = 'tickets-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const renderRows = (rs) => tableHTML(['Ticket No', 'Subject', 'Priority', 'Status', 'Department', 'Assigned To', ''], rs, t => `
        <tr><td>${esc(t.ticket_no)}</td><td>${esc(t.subject)}</td><td>${badge(t.priority)}</td><td>${badge(t.status)}</td>
        <td>${esc(t.department_name)||'-'}</td><td>${esc(t.assigned_to_name)||'-'}</td>
        <td><button class="btn small outline" type="button" onclick="viewTicket(${t.id})">Open</button></td></tr>`);
  el.innerHTML = `
    ${collapsiblePanel(key, `<span id="${key}-count">${esc(title)} (${rows.length})</span>`, `
      ${renderListSearch(key, rows, ['ticket_no', 'subject', 'department_name', 'assigned_to_name', 'status'], (filtered) => {
        document.getElementById(key + '-table').innerHTML = renderRows(filtered);
        document.getElementById(key + '-count').textContent = title + ' (' + filtered.length + ')';
      }, 'Search by ticket no, subject, department, assignee, status...')}
      <div id="${key}-table">${renderRows(rows)}</div>
    `)}
    <div class="panel" id="tk-detail-panel" style="display:none;"><h3>Ticket Detail</h3><div id="tk-detail-body"></div></div>`;
  window.__TICKET_REFRESH = () => renderTicketQueue(el, apiPath, title);
}
window.viewTicket = async (id) => {
  const { ticket, comments } = await api('/tickets/' + id);
  const panel = document.getElementById('tk-detail-panel');
  document.getElementById('tk-detail-body').innerHTML = `
    <p><b>${esc(ticket.subject)}</b> — ${badge(ticket.priority)} ${badge(ticket.status)}<br>
    Department: ${esc(ticket.department_name)||'-'} &nbsp; Raised by: ${esc(ticket.raised_by_name)||'-'} &nbsp; Assigned to: ${esc(ticket.assigned_to_name)||'Unassigned'}</p>
    <p>${esc(ticket.description)||''}</p>
    <div class="form-grid">
      <div><label>Status</label><select id="tk-status">${['Open','InProgress','Resolved','Closed','Reopened'].map(s => `<option ${s===ticket.status?'selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <button class="btn outline" type="button" onclick="updateTicket(${id})" style="margin-top:8px;">Update Status</button>
    <h4 style="margin-top:16px;">Comments</h4>
    <div>${comments.map(c => `<div style="padding:6px 0;border-bottom:1px solid var(--border);"><b>${esc(c.user_name)}</b> <span class="muted">${new Date(c.created_at).toLocaleString()}</span><br>${esc(c.comment)}</div>`).join('') || '<span class="muted">No comments yet.</span>'}</div>
    <textarea id="tk-comment" rows="2" style="width:100%;margin-top:8px;" placeholder="Add a reply..."></textarea>
    <button class="btn" onclick="addTicketComment(${id})" style="margin-top:6px;">Post Comment</button>
    <h4 style="margin-top:16px;">Attachments</h4>
    <div id="tk-attachments-${id}"></div>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  renderAttachmentsWidget('ticket', id, document.getElementById(`tk-attachments-${id}`));
};
window.updateTicket = async (id) => {
  try { await api(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ status: val('tk-status') }) }); if (window.__TICKET_REFRESH) window.__TICKET_REFRESH(); else viewTicket(id); }
  catch (e) { alert(e.message); }
};
window.addTicketComment = async (id) => {
  const comment = val('tk-comment');
  if (!comment.trim()) return;
  try { await api(`/tickets/${id}/comments`, { method: 'POST', body: JSON.stringify({ comment }) }); viewTicket(id); }
  catch (e) { alert(e.message); }
};

// ===================== Service Centers (Round 7) =====================

// ---- Sheet: Service Centers Master ----
let EDITING_SC_ID = null;
PAGES['service-centers'] = async (el) => {
  const centers = await api('/service-centers');
  el.innerHTML = `
    <div class="panel"><h3>${EDITING_SC_ID ? 'Edit' : 'Add'} Service Center</h3>
      <div class="form-grid">
        <div><label>Name</label><input id="sc-name"></div>
        <div><label>City</label><input id="sc-city"></div>
        <div><label>Contact Person</label><input id="sc-contact"></div>
        <div><label>Phone</label><input id="sc-phone"></div>
        <div><label>Email</label><input id="sc-email"></div>
        <div><label>Status</label><select id="sc-status"><option>Active</option><option>Inactive</option></select></div>
        <div style="grid-column:1/-1;"><label>Address</label><textarea id="sc-address" rows="2"></textarea></div>
      </div>
      <button class="btn" onclick="saveServiceCenter()">${EDITING_SC_ID ? 'Save Changes' : 'Add Service Center'}</button>
      ${EDITING_SC_ID ? `<button class="btn outline" onclick="EDITING_SC_ID=null;navigate('service-centers')">Cancel</button>` : ''}
    </div>
    ${collapsiblePanel('service-centers-list', `Service Centers (${centers.length})`, `
      ${tableHTML(['Name', 'City', 'Contact', 'Phone', 'Status', ''], centers, c => `
        <tr><td>${esc(c.name)}</td><td>${esc(c.city)||'-'}</td><td>${esc(c.contact_person)||'-'}</td><td>${esc(c.phone)||'-'}</td>
        <td>${badge(c.status)}</td>
        <td><button class="btn small outline" onclick="editServiceCenter(${c.id})">Edit</button></td></tr>`)}
    `)}`;
  window.__SC_LIST = centers;
};
window.editServiceCenter = (id) => {
  const c = (window.__SC_LIST || []).find(x => x.id === id);
  if (!c) return;
  EDITING_SC_ID = id;
  navigate('service-centers').then(() => {
    document.getElementById('sc-name').value = c.name || '';
    document.getElementById('sc-city').value = c.city || '';
    document.getElementById('sc-contact').value = c.contact_person || '';
    document.getElementById('sc-phone').value = c.phone || '';
    document.getElementById('sc-email').value = c.email || '';
    document.getElementById('sc-status').value = c.status || 'Active';
    document.getElementById('sc-address').value = c.address || '';
  });
};
window.saveServiceCenter = async () => {
  const payload = {
    name: val('sc-name'), city: val('sc-city'), contact_person: val('sc-contact'), phone: val('sc-phone'),
    email: val('sc-email'), status: val('sc-status'), address: val('sc-address'),
  };
  try {
    if (EDITING_SC_ID) { await api('/service-centers/' + EDITING_SC_ID, { method: 'PUT', body: JSON.stringify(payload) }); EDITING_SC_ID = null; }
    else await api('/service-centers', { method: 'POST', body: JSON.stringify(payload) });
    navigate('service-centers');
  } catch (e) { alert(e.message); }
};

// ---- Sheet: Store -> Service Center Transfers (dispatch) ----
let SCT_ITEMS = [{ item_id: '', quantity: 1, unit_rate: 0 }];
PAGES['sc-transfers'] = async (el) => {
  const [centers, items, transfers] = await Promise.all([api('/service-centers'), api('/masters/items'), api('/service-centers/transfers/all')]);
  window.__SCT_CENTERS = centers.filter(c => c.status === 'Active');
  window.__SCT_ITEMS = items.filter(i => !['Pending', 'Discontinued'].includes(i.status));
  SCT_ITEMS = [{ item_id: '', quantity: 1, unit_rate: 0 }];
  el.innerHTML = `
    <div class="panel"><h3>Dispatch Spares to a Service Center</h3>
      <p class="muted">Issues from the central store (Item Master stock) to a service center. Deducts central stock immediately; the center confirms actual received quantity separately.</p>
      <div class="form-grid">
        <div><label>Service Center</label><select id="sct-center">${window.__SCT_CENTERS.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.city)||'-'})</option>`).join('') || '<option value="">- No active service centers -</option>'}</select></div>
        <div><label>Notes</label><input id="sct-notes"></div>
      </div>
      <div id="sct-lines"></div>
      <button class="btn small outline" type="button" onclick="addSCTLine()">+ Add Line Item</button>
      <div style="margin-top:12px;"><button class="btn green" onclick="saveSCTransfer()">Dispatch Transfer</button></div>
      <div id="sct-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>
    ${collapsiblePanel('transfers-list', `Transfers (${transfers.length})`, `
      ${tableHTML(['Transfer No', 'Service Center', 'Items', 'Status', 'Dispatched By', 'Dispatched At'], transfers, t => `
        <tr><td>${esc(t.transfer_no)}</td><td>${esc(t.service_center_name)} (${esc(t.service_center_city)||'-'})</td><td>${t.item_count}</td>
        <td>${badge(t.status)}</td><td>${esc(t.dispatched_by_name)||'-'}</td><td>${new Date(t.dispatched_at).toLocaleString()}</td></tr>`)}
    `)}`;
  renderSCTLines();
};
function renderSCTLines() {
  const el = document.getElementById('sct-lines');
  if (!el) return;
  const items = window.__SCT_ITEMS || [];
  el.innerHTML = tableHTML(['Item', 'Qty', 'Unit Rate (₹)', 'Value (₹)', ''], SCT_ITEMS, (l, i) => `
    <tr>
      <td><select onchange="SCT_ITEMS[${i}].item_id=Number(this.value)">
        <option value="">- Select item (stock) -</option>
        ${items.map(it => `<option value="${it.id}" ${l.item_id===it.id?'selected':''}>${esc(it.name)}${it.item_code?' ('+esc(it.item_code)+')':''} - stock: ${it.current_stock}</option>`).join('')}
      </select></td>
      <td><input type="number" value="${l.quantity}" onchange="SCT_ITEMS[${i}].quantity=Number(this.value);renderSCTLines()" style="width:80px;"></td>
      <td><input type="number" value="${l.unit_rate}" onchange="SCT_ITEMS[${i}].unit_rate=Number(this.value);renderSCTLines()" style="width:90px;"></td>
      <td>₹${fmt((Number(l.quantity)||0)*(Number(l.unit_rate)||0))}</td>
      <td><button class="btn small outline" type="button" onclick="SCT_ITEMS.splice(${i},1);renderSCTLines()">✕</button></td>
    </tr>`).replace('</tbody></table>', `</tbody><tfoot><tr><td colspan="3" style="text-align:right;"><b>Total</b></td><td><b>₹${fmt(SCT_ITEMS.reduce((s,l)=>s+(Number(l.quantity)||0)*(Number(l.unit_rate)||0),0))}</b></td><td></td></tr></tfoot></table>`);
}
window.addSCTLine = () => { SCT_ITEMS.push({ item_id: '', quantity: 1, unit_rate: 0 }); renderSCTLines(); };
window.saveSCTransfer = async () => {
  const errEl = document.getElementById('sct-err');
  errEl.style.display = 'none';
  try {
    const lines = SCT_ITEMS.filter(l => l.item_id && Number(l.quantity) > 0);
    if (!lines.length) throw new Error('Add at least one item line with a quantity.');
    await api('/service-centers/transfers', { method: 'POST', body: JSON.stringify({
      service_center_id: val('sct-center'), notes: val('sct-notes'), items: lines,
    })});
    navigate('sc-transfers');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Sheet: Receive Center Transfers (confirm receipt / discrepancy) ----
PAGES['sc-receive'] = async (el) => {
  const transfers = (await api('/service-centers/transfers/all')).filter(t => ['Dispatched', 'PartiallyReceived'].includes(t.status));
  el.innerHTML = `
    <div class="panel"><h3>Pending Receipt Confirmation (${transfers.length})</h3>
      <p class="muted">Enter what actually arrived per line - a difference from the dispatched quantity is recorded as a discrepancy (shortage/damage in transit) and the transfer is marked Partially Received. Flag as Disputed instead if the whole delivery is in question.</p>
      ${tableHTML(['Transfer No', 'Service Center', 'Status', 'Dispatched At', ''], transfers, t => `
        <tr><td>${esc(t.transfer_no)}</td><td>${esc(t.service_center_name)} (${esc(t.service_center_city)||'-'})</td><td>${badge(t.status)}</td>
        <td>${new Date(t.dispatched_at).toLocaleString()}</td>
        <td><button class="btn small outline" onclick="openSCReceive(${t.id})">Confirm Receipt</button></td></tr>`)}
    </div>
    <div class="panel" id="scr-panel" style="display:none;"><h3>Confirm Receipt</h3><div id="scr-body"></div></div>`;
};
window.openSCReceive = async (transferId) => {
  const { transfer, items } = await api('/service-centers/transfers/' + transferId);
  const panel = document.getElementById('scr-panel');
  const body = document.getElementById('scr-body');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
  body.innerHTML = `
    <p><b>${esc(transfer.transfer_no)}</b> → ${esc(transfer.service_center_name)} (${esc(transfer.service_center_city)||'-'})</p>
    ${tableHTML(['Item', 'Qty Sent', 'Qty Received'], items, it => `
      <tr><td>${esc(it.item_name)}</td><td>${it.quantity_sent}</td>
      <td><input type="number" id="scr-qty-${it.id}" value="${it.quantity_received !== null ? it.quantity_received : it.quantity_sent}" style="width:90px;"></td></tr>`)}
    <div class="form-grid" style="margin-top:8px;">
      <div><label><input type="checkbox" id="scr-disputed"> Flag as Disputed</label></div>
      <div style="grid-column:1/-1;"><label>Notes</label><input id="scr-notes" placeholder="e.g. reason for shortage/damage"></div>
    </div>
    <button class="btn green" onclick="confirmSCReceive(${transfer.id}, ${JSON.stringify(items.map(i=>i.id))})">Confirm Receipt</button>
    <div id="scr-err" class="msg err" style="display:none;margin-top:10px;"></div>`;
};
window.confirmSCReceive = async (transferId, lineIds) => {
  const errEl = document.getElementById('scr-err');
  try {
    const items = lineIds.map(id => ({ transfer_item_id: id, quantity_received: Number(val('scr-qty-' + id)) }));
    await api('/service-centers/transfers/' + transferId + '/receive', { method: 'POST', body: JSON.stringify({
      items, notes: val('scr-notes'), disputed: document.getElementById('scr-disputed').checked,
    })});
    navigate('sc-receive');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Sheet: Service Center Stock Levels ----
PAGES['sc-stock'] = async (el) => {
  const [centers, summary] = await Promise.all([api('/service-centers'), api('/service-centers/stock/summary')]);
  el.innerHTML = `
    <div class="panel"><h3>Per-Center Stock</h3>
      <select id="scs-center" onchange="loadSCStock()">
        <option value="">- Select a service center -</option>
        ${centers.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.city)||'-'})</option>`).join('')}
      </select>
      <div id="scs-body" style="margin-top:12px;"></div>
    </div>
    ${collapsiblePanel('sc-stock-summary', `Company-Wide: Central Store vs Distributed to Centers (${summary.length})`, `
      ${tableHTML(['Item', 'Central Store Stock', 'Total at Service Centers', 'Breakdown'], summary, i => `
        <tr><td>${esc(i.name)}${i.item_code?' ('+esc(i.item_code)+')':''}</td><td>${fmt(i.current_stock)} ${esc(i.unit)||''}</td>
        <td>${fmt(i.total_at_centers)} ${esc(i.unit)||''}</td>
        <td>${i.centers.map(c => `${esc(c.service_center_name)}: ${fmt(c.quantity)}`).join(', ') || '-'}</td></tr>`)}
    `)}`;
};
window.loadSCStock = async () => {
  const id = val('scs-center');
  const bodyEl = document.getElementById('scs-body');
  if (!id) { bodyEl.innerHTML = ''; return; }
  const { center, rows } = await api('/service-centers/' + id + '/stock');
  bodyEl.innerHTML = `<h4>${esc(center.name)} (${esc(center.city)||'-'})</h4>
    ${tableHTML(['Item', 'Unit', 'Quantity'], rows, r => `
      <tr><td>${esc(r.item_name)}${r.item_code?' ('+esc(r.item_code)+')':''}</td><td>${esc(r.unit)}</td><td>${fmt(r.quantity)}</td></tr>`)}`;
};

// ---- Sheet: Service Center Reconciliation ----
PAGES['sc-reconciliation'] = async (el) => {
  const centers = await api('/service-centers');
  el.innerHTML = `
    <div class="panel"><h3>Service Center Reconciliation</h3>
      <p class="muted">Value dispatched vs confirmed received vs consumed in service visits vs current stock on hand - the variance highlights centers where stock doesn't add up (possible shrinkage/loss).</p>
      <select id="screc-center" onchange="loadSCReconciliation()">
        <option value="">All Service Centers</option>
        ${centers.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.city)||'-'})</option>`).join('')}
      </select>
      <button class="btn small outline" type="button" onclick="exportSCReconciliation()" style="margin-left:8px;">Export CSV</button>
      <div id="screc-body" style="margin-top:12px;"></div>
    </div>`;
  window.loadSCReconciliation();
};
window.loadSCReconciliation = async () => {
  const scId = val('screc-center');
  const data = await api('/service-centers/reconciliation' + (scId ? '?service_center_id=' + scId : ''));
  window.__SCREC = data;
  const bodyEl = document.getElementById('screc-body');
  const varianceCell = v => `<span style="color:${v > 0 ? '#c0392b' : (v < 0 ? '#2e7d32' : 'inherit')};font-weight:${v !== 0 ? 'bold' : 'normal'};">₹${fmt(v)}</span>`;
  bodyEl.innerHTML = `
    ${tableHTML(['Service Center', 'Dispatched (₹)', 'Received (₹)', 'Transit Discrepancy (₹)', 'Consumed in Service (₹)', 'On Hand (₹)', 'Expected On Hand (₹)', 'Variance (₹)'], data.rows, r => `
      <tr><td>${esc(r.name)} (${esc(r.city)||'-'})</td><td>₹${fmt(r.dispatched_value)}</td><td>₹${fmt(r.received_value)}</td>
      <td>${varianceCell(r.transit_discrepancy_value)}</td><td>₹${fmt(r.consumed_value)}</td><td>₹${fmt(r.onhand_value)}</td>
      <td>₹${fmt(r.expected_onhand_value)}</td><td>${varianceCell(r.variance_value)}</td></tr>`)}
    <p style="margin-top:10px;"><b>Company-wide Totals:</b>
      Dispatched ₹${fmt(data.totals.dispatched_value)} · Received ₹${fmt(data.totals.received_value)} ·
      Consumed ₹${fmt(data.totals.consumed_value)} · On Hand ₹${fmt(data.totals.onhand_value)} ·
      Expected On Hand ₹${fmt(data.totals.expected_onhand_value)} · Variance ${varianceCell(data.totals.variance_value)}</p>`;
};
window.exportSCReconciliation = () => {
  const data = window.__SCREC;
  if (!data || !data.rows.length) { alert('No records to export yet.'); return; }
  downloadCSV('service_center_reconciliation.csv', data.rows,
    ['service_center_id', 'name', 'city', 'dispatched_value', 'received_value', 'transit_discrepancy_value', 'consumed_value', 'onhand_value', 'expected_onhand_value', 'variance_value']);
};

// ===================== Site Visit Tracker (replaces "SITE STATUS" Excel) =====================
let EDITING_VISIT_ID = null;
const SITE_VISIT_BUCKETS = [
  ['Pending', 'Pending Site', 'Requested, not yet started - Purpose of Visit shown.'],
  ['Working', 'Working Site', 'Engineer(s) currently on site.'],
  ['Hold', 'Hold', 'Paused mid-visit - Pending Works shown.'],
  ['Closed', 'Closed', 'Visit complete.'],
];
PAGES['site-visits'] = async (el) => {
  const [visits, engineers] = await Promise.all([api('/site-visits/visits'), api('/site-visits/engineers')]);
  window.__SV_ENGINEERS = engineers;
  const ed = EDITING_VISIT_ID ? visits.find(v => v.id === EDITING_VISIT_ID) : null;
  const bucketTable = (status, title, hint) => {
    const rows = visits.filter(v => v.status === status);
    const table = `<p class="muted">${esc(hint)}</p>
      ${tableHTML(['Site', 'Engineer(s)', 'Arrival', 'Close', 'Purpose / Pending Works', 'Expenses Note', ''], rows, v => `
        <tr><td>${esc(v.site_name)}</td><td>${v.engineers.map(e => esc(e.full_name)).join(', ') || '-'}</td>
        <td>${v.arrival_date||'-'}</td><td>${v.close_date||'-'}</td><td>${esc(v.purpose)||'-'}</td><td>${esc(v.expenses_note)||'-'}</td>
        <td><button class="btn small outline" onclick="editSiteVisit(${v.id})">Edit</button></td></tr>`)}`;
    // Closed visits are the one bucket that only ever grows (completed
    // history) - the other three are naturally small/active-only, so they
    // stay open by default.
    if (status === 'Closed') return collapsiblePanel('site-visits-closed', `${esc(title)} (${rows.length})`, table);
    return `<div class="panel"><h3>${esc(title)} (${rows.length})</h3>${table}</div>`;
  };
  el.innerHTML = `
    <div class="panel"><h3>${ed ? 'Edit' : 'Add'} Site Visit</h3>
      <div class="form-grid">
        <div><label>Site Name</label><input id="sv-name" value="${ed?esc(ed.site_name):''}"></div>
        <div><label>Status</label><select id="sv-status">
          ${SITE_VISIT_BUCKETS.map(([s]) => `<option value="${s}" ${ed&&ed.status===s?'selected':''}>${s}</option>`).join('')}
        </select></div>
        <div><label>Arrival Date</label><input id="sv-arrival" type="date" value="${ed?ed.arrival_date||'':''}"></div>
        <div><label>Close Date</label><input id="sv-close" type="date" value="${ed?ed.close_date||'':''}"></div>
        <div style="grid-column:1/-1;"><label>Purpose of Visit / Pending Works</label><textarea id="sv-purpose" rows="2">${ed?esc(ed.purpose)||'':''}</textarea></div>
        <div style="grid-column:1/-1;"><label>Expenses Note</label><input id="sv-expenses" value="${ed?esc(ed.expenses_note)||'':''}"></div>
        <div style="grid-column:1/-1;"><label>Engineer(s) - ctrl/cmd-click to select multiple</label>
          <select id="sv-engineers" multiple size="6">
            ${engineers.map(e => `<option value="${e.id}" ${ed&&ed.engineers.some(x=>x.id===e.id)?'selected':''}>${esc(e.full_name)}${e.department?' ('+esc(e.department)+')':''}</option>`).join('')}
          </select>
        </div>
      </div>
      <button class="btn" onclick="saveSiteVisit(${ed?ed.id:'null'})">${ed?'Save Changes':'Add Visit'}</button>
      ${ed ? `<button class="btn outline" onclick="EDITING_VISIT_ID=null;navigate('site-visits')">Cancel</button>` : ''}
      <div id="sv-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>
    ${SITE_VISIT_BUCKETS.map(([s, title, hint]) => bucketTable(s, title, hint)).join('')}`;
};
window.editSiteVisit = (id) => { EDITING_VISIT_ID = id; navigate('site-visits'); };
window.saveSiteVisit = async (id) => {
  const errEl = document.getElementById('sv-err');
  try {
    const engineerIds = Array.from(document.getElementById('sv-engineers').selectedOptions).map(o => Number(o.value));
    const payload = {
      site_name: val('sv-name'), status: val('sv-status'), arrival_date: val('sv-arrival') || null,
      close_date: val('sv-close') || null, purpose: val('sv-purpose'), expenses_note: val('sv-expenses'),
      employee_ids: engineerIds,
    };
    if (id) await api('/site-visits/visits/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/site-visits/visits', { method: 'POST', body: JSON.stringify(payload) });
    EDITING_VISIT_ID = null;
    navigate('site-visits');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ===================== Engineer Daily Work Log (replaces "DAILY WORK" Excel) =====================
let DWL_MONTH = null;
const DWL_STATUSES = ['', 'Pending', 'InProgress', 'Completed', 'OnHold'];
PAGES['daily-work-log'] = async (el) => {
  const month = DWL_MONTH || thisMonth();
  DWL_MONTH = month;
  const [engineers, logs] = await Promise.all([api('/site-visits/engineers'), api('/site-visits/daily-log?month=' + month)]);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const byKey = {};
  logs.forEach(l => { byKey[l.employee_id + '|' + l.log_date] = l; });
  const dayCols = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const dateFor = (d) => `${month}-${String(d).padStart(2, '0')}`;
  el.innerHTML = `
    <div class="panel"><div class="form-grid"><div><label>Month</label>
      <input type="month" value="${month}" onchange="DWL_MONTH=this.value;navigate('daily-work-log')"></div></div>
      <p class="muted">One cell per engineer per day - type the job/site they worked on, or a shorthand like "OD" (outdoor duty), "A" (absent), "1/2" (half day), same as the old sheet. Optionally set a Status when you're actively assigning that day's task rather than just recording what happened - leave it blank for a plain note, same as before.</p>
    </div>
    <div class="panel">
      <div style="overflow-x:auto;">
        <table class="et-grid"><thead><tr><th style="min-width:140px;">Engineer</th>
          ${dayCols.map(d => `<th style="min-width:120px;">${d}</th>`).join('')}</tr></thead>
        <tbody>
          ${engineers.map(e => `<tr><td>${esc(e.full_name)}</td>
            ${dayCols.map(d => { const cell = byKey[e.id + '|' + dateFor(d)] || {}; return `<td>
              <input class="dwl-cell" data-emp="${e.id}" data-date="${dateFor(d)}" value="${esc(cell.note || '')}" style="width:110px;">
              <select class="dwl-status" data-emp="${e.id}" data-date="${dateFor(d)}" style="width:110px;margin-top:3px;" title="${cell.assigned_by_name ? 'Assigned by ' + esc(cell.assigned_by_name) : ''}">
                ${DWL_STATUSES.map(s => `<option value="${s}" ${cell.status === s ? 'selected' : ''}>${s || '(no status)'}</option>`).join('')}
              </select>
            </td>`; }).join('')}
          </tr>`).join('')}
        </tbody></table>
      </div>
    </div>
    <button class="btn" onclick="saveDailyWorkLog()">Save</button>
    <div id="dwl-err" class="msg err" style="display:none;margin-top:10px;"></div>`;
};
window.saveDailyWorkLog = async () => {
  const errEl = document.getElementById('dwl-err');
  try {
    const byKey = {};
    document.querySelectorAll('.dwl-cell').forEach(c => {
      byKey[c.dataset.emp + '|' + c.dataset.date] = { employee_id: Number(c.dataset.emp), log_date: c.dataset.date, note: c.value, status: '' };
    });
    document.querySelectorAll('.dwl-status').forEach(s => {
      const key = s.dataset.emp + '|' + s.dataset.date;
      if (byKey[key]) byKey[key].status = s.value;
    });
    const entries = Object.values(byKey);
    await api('/site-visits/daily-log/bulk', { method: 'POST', body: JSON.stringify({ entries }) });
    navigate('daily-work-log');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ===================== To-Do List =====================
// Logging a To-Do (handing an action item to someone, against a department
// HOD) is restricted to HODs/Admin - see routes/todos.js `canLog()`. A
// regular employee only gets the "My To-Do List" panel below, where they can
// move their own items through Pending/InProgress/Completed/OnHold.
const TODO_STATUSES = ['Pending', 'InProgress', 'Completed', 'OnHold'];
PAGES['todos'] = async (el) => {
  const people = await api('/todos/people');
  const canLog = people.can_log;
  const canView = people.can_view;
  const [mine, all] = await Promise.all([api('/todos/mine'), canView ? api('/todos') : Promise.resolve([])]);
  const personLabel = p => `${esc(p.full_name)}${p.department ? ' (' + esc(p.department) + ')' : ''}`;
  const hodOptions = people.hods.map(h => `<option value="${h.id}">${personLabel(h)}</option>`).join('');
  const assigneeOptions = people.assignees.map(a => `<option value="${a.id}">${personLabel(a)}</option>`).join('');
  const detailsRow = t => `${t.priority === 'High' ? '<span class="badge Rejected" style="margin-right:6px;">HIGH</span>' : ''}${esc(t.brief_description)}${t.details ? `<div class="muted" style="margin-top:4px;">${esc(t.details)}</div>` : ''}`;
  const updatesToggle = t => `<button class="btn small outline" type="button" onclick="toggleTodoUpdates(${t.id})">Updates</button>`;
  el.innerHTML = `
    ${canLog ? `
    <div class="panel"><h3>Log a New To-Do</h3>
      <div class="form-grid">
        <div><label>HOD</label><select id="td-hod"><option value="">— none —</option>${hodOptions}</select></div>
        <div><label>Assigned To (who has the action)</label><select id="td-assignee"><option value="">Select...</option>${assigneeOptions}</select></div>
        <div><label>Start Date</label><input id="td-start" type="date" value="${today()}"></div>
        <div><label>Target Date</label><input id="td-target" type="date"></div>
        <div><label>Priority</label><select id="td-priority"><option value="Normal">Normal</option><option value="High">High</option></select></div>
        <div style="grid-column:1/-1;"><label>Brief Description</label><input id="td-brief" placeholder="e.g. Submit revised layout drawing"></div>
        <div style="grid-column:1/-1;"><label>Details</label><textarea id="td-details" rows="3"></textarea></div>
      </div>
      <button class="btn" onclick="saveTodo()">Log To-Do</button>
      <div id="td-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>` : ''}

    <div class="panel"><h3>My To-Do List</h3>
      <p class="muted">Items handed to you directly, plus other action items logged against your own department's HOD so your whole team can track them.</p>
      ${tableHTML(['Action / Details', 'HOD', 'Assigned To', 'Start Date', 'Target Date', 'Status', ''], mine, t => `
        <tr><td>${detailsRow(t)}</td><td>${esc(t.hod_name) || '-'}</td><td>${esc(t.assigned_to_name)}${t.is_mine ? '' : ' <span class="muted">(dept)</span>'}</td><td>${t.start_date || '-'}</td>
        <td>${deliveryBadge(t.target_date)}</td>
        <td>${(t.is_mine || canLog) ? `<select onchange="updateTodoStatus(${t.id}, this.value)">
          ${TODO_STATUSES.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>` : badge(t.status)}</td><td>${updatesToggle(t)}</td></tr>
        <tr id="todo-updates-row-${t.id}" style="display:none;"><td colspan="7"><div id="todo-updates-${t.id}"></div></td></tr>`)}
    </div>

    ${canView ? (() => {
      const renderAllRows = (rows) => tableHTML(['Action / Details', 'HOD', 'Assigned To', 'Start Date', 'Target Date', 'Status', ''], rows, t => `
        <tr><td>${detailsRow(t)}</td><td>${esc(t.hod_name) || '-'}</td><td>${esc(t.assigned_to_name)}</td>
        <td>${t.start_date || '-'}</td><td>${deliveryBadge(t.target_date)}</td>
        <td>${canLog ? `<select onchange="updateTodoStatus(${t.id}, this.value)">
          ${TODO_STATUSES.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>` : badge(t.status)}</td>
        <td>${updatesToggle(t)} ${canLog ? `<button class="btn small outline" onclick="deleteTodo(${t.id})">Delete</button>` : ''}</td></tr>
        <tr id="todo-updates-row-${t.id}" style="display:none;"><td colspan="7"><div id="todo-updates-${t.id}"></div></td></tr>`);
      return collapsiblePanel('all-todos', `<span id="todo-all-count">All To-Dos Logged (${all.length})</span>`, `
        <p class="muted">${['Admin', 'Management'].includes(ME.role) ? 'Every To-Do across the whole company.' : "Every To-Do logged against your own department's HOD, plus anything assigned directly to you."}</p>
        ${renderListSearch('all-todos', all, ['brief_description', 'details', 'hod_name', 'assigned_to_name', 'status'], (rows) => {
          document.getElementById('todo-all-table').innerHTML = renderAllRows(rows);
          document.getElementById('todo-all-count').textContent = 'All To-Dos Logged (' + rows.length + ')';
        }, 'Search by description, HOD, assignee, status...')}
        <div id="todo-all-table">${renderAllRows(all)}</div>
      `);
    })() : ''}`;
};
window.toggleTodoUpdates = (id) => {
  const row = document.getElementById(`todo-updates-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderTodoUpdates(id);
};
async function renderTodoUpdates(id) {
  const wrap = document.getElementById(`todo-updates-${id}`);
  const updates = await api(`/todos/${id}/updates`);
  wrap.innerHTML = `
    <div style="padding:10px;background:#f6f7f9;border-radius:6px;">
      ${updates.length ? updates.map(u => `
        <div style="padding:6px 0;border-bottom:1px solid var(--border);">
          <b>${esc(u.user_name) || 'System'}</b> <span class="muted">${new Date(u.created_at).toLocaleString()}</span>
          ${u.status_at_update ? badge(u.status_at_update) : ''}
          <div>${esc(u.note)}</div>
        </div>`).join('') : '<div class="muted">No updates logged yet.</div>'}
      <div style="display:flex;gap:8px;margin-top:10px;">
        <input id="todo-update-note-${id}" placeholder="Add an update..." style="flex:1;">
        <button class="btn small" onclick="addTodoUpdate(${id})">Add</button>
      </div>
    </div>`;
}
window.addTodoUpdate = async (id) => {
  const input = document.getElementById(`todo-update-note-${id}`);
  const note = input.value.trim();
  if (!note) return;
  try {
    await api(`/todos/${id}/updates`, { method: 'POST', body: JSON.stringify({ note }) });
    input.value = '';
    renderTodoUpdates(id);
  } catch (e) { alert(e.message); }
};
window.saveTodo = async () => {
  const errEl = document.getElementById('td-err');
  try {
    await api('/todos', { method: 'POST', body: JSON.stringify({
      hod_id: val('td-hod') || null, assigned_to: val('td-assignee'),
      start_date: val('td-start') || null, target_date: val('td-target') || null,
      brief_description: val('td-brief'), details: val('td-details'), priority: val('td-priority'),
    })});
    navigate('todos');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.updateTodoStatus = async (id, status) => {
  try { await api('/todos/' + id, { method: 'PATCH', body: JSON.stringify({ status }) }); navigate('todos'); }
  catch (e) { alert(e.message); }
};
window.deleteTodo = async (id) => {
  if (!confirm('Delete this To-Do?')) return;
  try { await api('/todos/' + id, { method: 'DELETE' }); navigate('todos'); }
  catch (e) { alert(e.message); }
};

// ===================== Full Data Export (Admin only) =====================
// Every raw column of any table in the system, straight to xlsx, for
// external deep-dive analysis in Power BI/Python - see lib/tableExport.js
// for exactly what's excluded (credentials, internal ACL plumbing) and why.
PAGES['full-data-export'] = async (el) => {
  const tables = await api('/reports/export/tables');
  el.innerHTML = `
    <div class="panel"><h3>Full Data Export</h3>
      <p class="muted">Every raw field of a table - including internal IDs, foreign keys, and timestamps not shown on any screen - as a single Excel file. For loading into Power BI, Python/pandas, or similar external analysis, not for everyday reporting (see the built-in report pages for that).</p>
      <div class="form-grid">
        <div><label>Table</label><select id="fde-table">${tables.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
      </div>
      <button class="btn" onclick="downloadFullTableExport()">Download Export</button>
    </div>`;
};
window.downloadFullTableExport = () => {
  const table = val('fde-table');
  downloadTemplateFile(`/reports/export/${table}`, `${table}_full_export.xlsx`);
};

// ===================== Backups (Admin only) =====================
// Daily automated backup (DB snapshot + uploaded files) plus a manual
// "run now" - see lib/backup.js for what each run actually does. This page
// is the audit log an Admin uses to check backup health and grab the
// right file to migrate to a new server.
function fmtBytes(n) {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
PAGES['backups'] = async (el) => {
  el.innerHTML = `
    <div class="panel"><h3>Daily Backups</h3>
      <p class="muted">Runs automatically once a day (DB snapshot via SQLite's own VACUUM INTO, safe against a live database, plus a copy of every uploaded file), bundled into one .tar.gz when possible. Kept for the retention window (default 14 days, <code>BACKUP_RETENTION_DAYS</code>), optionally emailed offsite if <code>BACKUP_EMAIL_TO</code> is set, and optionally uploaded to Zoho WorkDrive if <code>ZOHO_WORKDRIVE_*</code> is configured (see README).</p>
      <p class="muted"><b>To migrate to a new server:</b> download a backup below, stop the app there, replace its <code>erp.db</code> with the backup's <code>erp.db</code> and its uploads folder with the backup's <code>uploads</code> folder, then start it again. Nothing proprietary - it's a plain SQLite file and a plain folder of files.</p>
      <button class="btn" onclick="runBackupNow()">Run Backup Now</button>
      <div id="backup-run-result" style="margin-top:8px;"></div>
    </div>
    ${collapsiblePanel('backup-history', 'Backup History', '<div id="backup-history-body"></div>')}`;
  renderBackupHistory();
};
async function renderBackupHistory() {
  const bodyEl = document.getElementById('backup-history-body');
  if (!bodyEl) return;
  const runs = await api('/backups');
  bodyEl.innerHTML = tableHTML(['Started', 'Finished', 'Status', 'Trigger', 'By', 'DB Size', 'Uploads Size', 'Total Size', 'Emailed', 'Zoho WorkDrive', ''], runs, r => `
    <tr>
      <td>${new Date(r.started_at).toLocaleString()}</td>
      <td>${r.finished_at ? new Date(r.finished_at).toLocaleString() : '-'}</td>
      <td>${badge(r.status)}</td>
      <td>${esc(r.trigger_type)}</td>
      <td>${esc(r.triggered_by_name) || '-'}</td>
      <td>${fmtBytes(r.db_size_bytes)}</td>
      <td>${fmtBytes(r.uploads_size_bytes)}</td>
      <td>${fmtBytes(r.total_size_bytes)}</td>
      <td>${r.emailed ? '✓' : (r.email_error ? `<span class="muted" title="${esc(r.email_error)}">No</span>` : '-')}</td>
      <td>${r.zoho_uploaded ? '✓' : (r.zoho_error ? `<span class="muted" title="${esc(r.zoho_error)}">No</span>` : '-')}</td>
      <td>
        ${r.status === 'Success' && r.is_archive ? `<button class="btn small outline" type="button" onclick="downloadBackup(${r.id})">Download</button>` : ''}
        <button class="btn small outline" type="button" onclick="deleteBackup(${r.id})">Delete</button>
      </td>
    </tr>
    ${r.status === 'Failed' && r.error_message ? `<tr><td></td><td colspan="10" style="padding-top:0;"><span class="muted" style="font-size:12px;">${esc(r.error_message)}</span></td></tr>` : ''}
    ${r.skipped_files ? (() => { const skipped = JSON.parse(r.skipped_files); return `<tr><td></td><td colspan="10" style="padding-top:0;">
      <span style="color:#b45309;font-size:12px;" title="${esc(skipped.map(s => s.path + ': ' + s.error).join('\n'))}">⚠ ${skipped.length} file(s) under uploads could not be read and are missing from this backup - hover for the list.</span>
    </td></tr>`; })() : ''}
  `);
}
window.runBackupNow = async () => {
  const resultEl = document.getElementById('backup-run-result');
  resultEl.innerHTML = '<span class="muted">Running - this can take a moment for a large uploads folder...</span>';
  try {
    const result = await api('/backups/run', { method: 'POST' });
    const skippedNote = result.skippedFiles && result.skippedFiles.length
      ? ` <span style="color:#b45309;">- ${result.skippedFiles.length} file(s) under uploads could not be read and were skipped (see Backup History below).</span>` : '';
    resultEl.innerHTML = `<div class="msg ok">Backup complete: ${fmtBytes(result.totalSize)}${result.emailed ? ', emailed offsite' : ''}${result.zohoUploaded ? ', uploaded to Zoho WorkDrive' : ''}.${skippedNote}</div>`;
    renderBackupHistory();
  } catch (e) { resultEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};
window.downloadBackup = (id) => {
  downloadTemplateFile(`/backups/${id}/download`, `erp-backup-${id}.tar.gz`);
};
window.deleteBackup = async (id) => {
  if (!confirm('Delete this backup? This removes the file from disk and its log entry.')) return;
  try { await api(`/backups/${id}`, { method: 'DELETE' }); renderBackupHistory(); }
  catch (e) { alert(e.message); }
};

// ===================== Organizational Hierarchy =====================
// A reporting rollup tree (Region -> Unit -> Department -> Team) that sits
// ABOVE the app's real department/role/HOD model, purely for grouping KPIs -
// it never changes who can see or do what elsewhere in the app. Managing the
// tree (add/edit/delete nodes) is Admin-only; viewing the rollup matches
// whoever can already see cross-department reports (report.view_all).
let ORG_HIERARCHY_SELECTED = null;
PAGES['org-hierarchy'] = async (el) => {
  const [nodes, departments] = await Promise.all([api('/org-hierarchy/tree'), api('/masters/departments')]);
  const isAdmin = ME.role === 'Admin';
  const byParent = {};
  nodes.forEach(n => { const key = n.parent_id || 'root'; (byParent[key] = byParent[key] || []).push(n); });
  const renderNode = (n, depth) => {
    const children = byParent[n.id] || [];
    return `<div style="padding:6px 0 6px ${depth * 22}px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span class="badge active">${esc(n.node_type)}</span>
      <b>${esc(n.name)}</b>
      ${n.department_name ? `<span class="muted">&rarr; ${esc(n.department_name)}</span>` : ''}
      <button class="btn small outline" onclick="viewOrgRollup(${n.id})">View Rollup</button>
      ${isAdmin ? `<button class="btn small outline" onclick="deleteOrgNode(${n.id})">Delete</button>` : ''}
    </div>${children.map(c => renderNode(c, depth + 1)).join('')}`;
  };
  const roots = byParent.root || [];
  el.innerHTML = `
    ${isAdmin ? `
    <div class="panel"><h3>Add Node</h3>
      <div class="form-grid">
        <div><label>Name</label><input id="on-name" placeholder="e.g. North Region"></div>
        <div><label>Type</label><select id="on-type"><option value="Region">Region</option><option value="Unit">Unit</option><option value="Department">Department</option><option value="Team">Team</option></select></div>
        <div><label>Parent Node (optional)</label><select id="on-parent"><option value="">— top level —</option>${nodes.map(n => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select></div>
        <div><label>Maps to Department (optional)</label><select id="on-dept"><option value="">— none —</option>${departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Sort Order</label><input id="on-sort" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addOrgNode()">Add Node</button>
      <div id="on-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>` : ''}
    <div class="panel"><h3>Hierarchy</h3>
      ${roots.length ? roots.map(n => renderNode(n, 0)).join('') : '<div class="empty">No nodes yet.</div>'}
    </div>
    <div class="panel" id="org-rollup-panel" style="display:none;"></div>`;
};
window.addOrgNode = async () => {
  const errEl = document.getElementById('on-err');
  try {
    await api('/org-hierarchy/nodes', { method: 'POST', body: JSON.stringify({
      name: val('on-name'), node_type: val('on-type'), parent_id: val('on-parent') || null, department_id: val('on-dept') || null, sort_order: val('on-sort'),
    })});
    navigate('org-hierarchy');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteOrgNode = async (id) => {
  if (!confirm('Delete this node?')) return;
  try { await api('/org-hierarchy/nodes/' + id, { method: 'DELETE' }); navigate('org-hierarchy'); }
  catch (e) { alert(e.message); }
};
window.viewOrgRollup = async (id) => {
  ORG_HIERARCHY_SELECTED = id;
  const panel = document.getElementById('org-rollup-panel');
  panel.style.display = 'block';
  const data = await api(`/org-hierarchy/nodes/${id}/rollup`);
  panel.innerHTML = `
    <h3>Rollup - ${esc(data.node.name)}</h3>
    <div class="cards">
      <div class="card"><div class="num">${data.totals.headcount}</div><div class="label">Active Headcount</div></div>
      <div class="card"><div class="num">₹${fmt(data.totals.monthly_salary_cost)}</div><div class="label">Monthly Salary Cost</div></div>
    </div>
    ${tableHTML(['Department', 'Headcount', 'Monthly Salary Cost', ''], data.by_department, d => `
      <tr><td>${esc(d.department_name)}</td><td>${d.headcount}</td><td>₹${fmt(d.monthly_salary_cost)}</td>
      <td><button class="btn small outline" onclick="drillOrgDepartment(${d.department_id})">Drill Down</button></td></tr>`)}
    <div id="org-drill-wrap"></div>`;
  panel.scrollIntoView({ behavior: 'smooth' });
};
window.drillOrgDepartment = async (deptId) => {
  const wrap = document.getElementById('org-drill-wrap');
  const employees = await api(`/org-hierarchy/departments/${deptId}/employees`);
  wrap.innerHTML = `<h4 style="margin-top:14px;">Employees</h4>${tableHTML(['Code', 'Name', 'Designation', 'Monthly Salary'], employees, e => `
    <tr><td>${esc(e.employee_code)||'-'}</td><td>${esc(e.full_name)}</td><td>${esc(e.designation)||'-'}</td><td>₹${fmt(e.monthly_salary)}</td></tr>`)}`;
};

// ===================== Data Import (generic migration tool, Admin only) =====================
PAGES['data-import'] = async (el) => {
  const entities = await api('/data-import/entities');
  window.__DI_ENTITIES = entities;
  el.innerHTML = `
    <div class="panel"><h3>Data Import</h3>
      <p class="muted">Bring master/transactional data over from Excel - pick a data type, download its template, fill it in, then upload it. Re-uploading the same file is safe where the entity has a natural key (e.g. item code, employee code, expense category + date); everything else is skipped as a duplicate rather than double-inserted.</p>
      <div class="form-grid">
        <div><label>Data Type</label>
          <select id="di-entity">${entities.map(e => `<option value="${e.id}">${esc(e.label)}</option>`).join('')}</select>
        </div>
      </div>
      <button class="btn outline" type="button" onclick="downloadDataImportTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('di-upload-file')}
      <button class="btn" onclick="uploadDataImportFile()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="di-upload-result" style="margin-top:10px;"></div>
    </div>`;
};
window.downloadDataImportTemplate = () => {
  const entity = val('di-entity');
  downloadTemplateFile(`/data-import/${entity}/template`, `${entity}_import_template.xlsx`);
};
window.uploadDataImportFile = async () => {
  const entity = val('di-entity');
  const resultEl = document.getElementById('di-upload-result');
  const fileEl = document.getElementById('di-upload-file');
  if (!fileEl.files.length) { alert('Choose a filled template file first.'); return; }
  try {
    const fd = new FormData();
    fd.append('file', fileEl.files[0]);
    const result = await apiUpload(`/data-import/${entity}/upload`, fd, 'POST');
    resultEl.innerHTML = `<div class="msg ${result.errors.length ? 'err' : 'ok'}">
      Inserted: <b>${result.inserted}</b>, Skipped: <b>${result.skipped}</b>
      ${result.errors.length ? '<table style="margin-top:8px;"><thead><tr><th>Row error</th></tr></thead><tbody>' + result.errors.map(e => `<tr><td>${esc(e)}</td></tr>`).join('') + '</tbody></table>' : ''}
    </div>`;
  } catch (e) { resultEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};

// ===================== Boot on load if token exists =====================
checkForResetToken().then(hadResetToken => {
  if (!hadResetToken && TOKEN) boot();
});

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
  DEPT_OWN_GROUP.items = [];
  if (ME.department_name && !['Admin', 'ProjectManager'].includes(ME.role)) {
    const label = `${ME.department_name} Job Cards`;
    PAGE_TITLES['jobcards'] = label;
    DEPT_OWN_GROUP.group = ME.department_name;
    DEPT_OWN_GROUP.items = [{ id: 'jobcards', label }];
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
  // previous login may have merged into Purchase / Store & Inventory.
  NAV.forEach(g => { if (g.group === 'Purchase' || g.group === 'Store & Inventory') g.items = g.items.filter(it => !it.id.startsWith('jc_')); });
  DEPT_JOBCARDS_GROUPS.length = 0;
  if (['Admin', 'ProjectManager'].includes(ME.role)) {
    try {
      const stages = await api('/projects/pipeline-stages');
      // Purchase and Store already have their own dedicated functional nav
      // groups (Purchase Requests/POs/Vendors, Item Master/Stock In-Out/
      // Challans) - their job cards belong INSIDE those, not in a second
      // separate group of the same name. Every other stage gets its own
      // group, since nothing else already claims that department's name.
      const MERGE_INTO = { Purchase: 'Purchase', Store: 'Store & Inventory' };
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
  { group: 'Service', items: [
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
    { id: 'expense-tracker', label: 'Monthly Expense Tracker' },
    { id: 'expense-tracker-summary', label: 'Expense Tracker - Year Summary' },
    { id: 'expense-tracker-categories', label: 'Expense Tracker - Categories' },
    { id: 'bg-dashboard', label: 'Bank Guarantee Dashboard' },
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

// Which sidebar groups the user has collapsed, keyed by group label,
// persisted per-browser so it survives navigation and page reloads. A group
// containing the page currently being opened is always force-expanded (see
// navigate()) even if the user had previously collapsed it - collapsing a
// group is a "get it out of my way for now" choice, not "hide this forever".
function loadCollapsedNavGroups() {
  try { return JSON.parse(localStorage.getItem('erp_collapsed_nav_groups') || '{}'); } catch (e) { return {}; }
}
function saveCollapsedNavGroups(map) {
  try { localStorage.setItem('erp_collapsed_nav_groups', JSON.stringify(map)); } catch (e) {}
}
window.toggleNavGroup = (label) => {
  const map = loadCollapsedNavGroups();
  map[label] = !map[label];
  saveCollapsedNavGroups(map);
  renderSidebar();
  if (CURRENT_PAGE) {
    const navEl = document.getElementById('nav-' + CURRENT_PAGE);
    if (navEl) navEl.classList.add('active');
  }
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
  const collapsed = loadCollapsedNavGroups();
  groups.forEach(g => {
    const items = ALLOWED_PAGES ? g.items.filter(it => ALLOWED_PAGES.has(it.id)) : g.items;
    if (!items.length) return; // hide an empty group entirely rather than showing a bare heading
    const isCollapsed = !!collapsed[g.group];
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
        const collapsed = loadCollapsedNavGroups();
        delete collapsed[label];
        saveCollapsedNavGroups(collapsed);
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
async function downloadTemplateFile(apiPath, filename) {
  try {
    const res = await fetch('/api' + apiPath, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not download template'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
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
    resultEl.innerHTML = `<div class="msg ${result.errors.length ? 'err' : 'ok'}">
      Inserted: <b>${result.inserted}</b>, Skipped: <b>${result.skipped}</b>
      ${result.errors.length ? '<br>' + result.errors.map(e => esc(e)).join('<br>') : ''}
    </div>`;
    if (result.inserted > 0 && afterSuccess) afterSuccess();
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
    buildDetail: async () => { const reqs = (await api('/purchase/requests')).filter(r => r.status === 'Pending'); const total = reqs.reduce((a,r) => a + (r.estimated_value||0), 0); return `<h3>Pending Purchase Requests (${reqs.length})</h3><p class="muted">Total estimated value: ₹${fmt(total)}</p>${tableHTML(['PR No','Project','Item','Est. Value'], reqs, r => `<tr><td>${esc(r.pr_no)}</td><td>${esc(r.project_code)||'-'}</td><td>${esc(r.item_name)||esc(r.item_text)||'-'}</td><td>₹${fmt(r.estimated_value)}</td></tr>`)}`; } },
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
      const vouchers = (await api('/finance/expense-vouchers')).filter(v => v.status === 'Pending');
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
      const total = reqs.reduce((a,r) => a + (r.estimated_value||0), 0);
      return `<h3>Pending Purchase Requests (${reqs.length})</h3>
        <p class="muted">Total estimated value: <b>₹${fmt(total)}</b></p>
        ${tableHTML(['PR No','Project','Item','Qty','Est. Value','Raised By','Pending (days)'], reqs, r => `
          <tr><td>${esc(r.pr_no)}</td><td>${esc(r.project_code)||'-'}</td><td>${esc(r.item_name)||esc(r.item_text)||'-'}</td><td>${fmt(r.quantity)}</td><td>₹${fmt(r.estimated_value)}</td><td>${esc(r.raised_by_name)||'-'}</td><td>${daysSince(r.created_at)}</td></tr>`)}`;
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
    <div class="panel"><h3>Active Job Cards (${data.active.length})</h3>
      ${tableHTML(jcCols, data.active, jcRow)}
    </div>`;
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
    <div class="panel">
      <h3>Job Cards (${data.cards.length})</h3>
      ${tableHTML(['Stage','Card','Project','Status','Assignee','Allocated','Started','Completed'], data.cards, c => `
        <tr><td>${esc(STAGE_LABELS[c.stage]||c.stage)}</td><td>${esc(c.title)||'-'}</td><td>${esc(c.project_name)||'-'}</td><td>${badge(c.status)}</td><td>${esc(c.assignee_name)||'-'}</td>
        <td>${c.allocated_at?new Date(c.allocated_at).toLocaleString():'-'}</td><td>${c.started_at?new Date(c.started_at).toLocaleString():'-'}</td><td>${c.completed_at?new Date(c.completed_at).toLocaleString():'-'}</td></tr>`)}
    </div>`;
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
    return `<button class="btn small green" onclick="actOnFoc(${r.id}, 'approve')">Approve</button>
      <button class="btn small red" onclick="actOnFoc(${r.id}, 'reject')">Reject</button>`;
  }
  if (r.source === 'BGReminder') {
    return `<button class="btn small green" onclick="actOnBgReminder(${r.id})">Verify</button>`;
  }
  if (r.source === 'BGClaimTask') {
    return `<button class="btn small green" onclick="actOnApprovalTodo(${r.id}, 'InProgress')">In Progress</button>
      <button class="btn small blue" onclick="actOnApprovalTodo(${r.id}, 'Completed')">Complete</button>`;
  }
  return `<button class="btn small green" onclick="actOnApproval(${r.id}, 'Approved')">Approve</button>
    <button class="btn small red" onclick="actOnApproval(${r.id}, 'Rejected')">Reject</button>`;
}
PAGES.approvals = async (el) => {
  const pending = await api('/approvals/pending');
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
            <tr><td>${esc(r.ref)||('#'+r.entity_id)}</td><td>${esc(r.summary)||'-'}</td><td>${esc(r.raised_by_name)||'-'}</td><td>₹${fmt(r.amount)}</td><td>${r.current_step ?? '-'}</td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${approvalActionCell(r)}</td></tr>
          `)}
        </div>`).join('')}
    </div>`;
  }).join('');
};
window.actOnApproval = async (id, action) => {
  const comment = action === 'Rejected' ? prompt('Reason for rejection (optional):') : null;
  try {
    await api(`/approvals/${id}/act`, { method: 'POST', body: JSON.stringify({ action, comment }) });
    navigate('approvals');
  } catch (e) { alert(e.message); }
};
window.actOnFoc = async (id, verb) => {
  try {
    await api(`/finance/foc/${id}/${verb}`, { method: 'POST' });
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
    <div class="panel">
      <div class="toolbar"><h3 id="cl-count" style="margin:0;">All Clients (${clients.length})</h3>
        <button class="btn small outline" onclick="reportClients()">Generate Report (CSV)</button>
      </div>
      ${renderListSearch('clients', clients, ['client_code', 'name', 'contact_person', 'phone', 'email', 'address', 'source', 'gstin'], (rows) => {
        document.getElementById('cl-table-wrap').innerHTML = renderClientRows(rows);
        document.getElementById('cl-count').textContent = 'All Clients (' + rows.length + ')';
      }, 'Search by name, contact, phone, email, GSTIN, address...')}
      <div id="cl-table-wrap">${renderClientRows(clients)}</div>
    </div>`;
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
function openMiniModal(title, bodyHTML, wide) {
  closeMiniModal();
  const overlay = document.createElement('div');
  overlay.id = 'mini-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px;';
  overlay.innerHTML = `<div class="panel" style="max-width:${wide ? 760 : 440}px;width:100%;margin:0;">
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
    <div class="panel">
      <div class="toolbar"><h3 style="margin:0;">All Leads (${leads.length})</h3>
        <div style="display:flex;gap:8px;">
          <div class="tabs" style="margin:0;">
            <div class="tab ${LEADS_VIEW === 'list' ? 'active' : ''}" onclick="switchLeadsView('list')">List</div>
            <div class="tab ${LEADS_VIEW === 'kanban' ? 'active' : ''}" onclick="switchLeadsView('kanban')">Kanban</div>
          </div>
          <button class="btn small outline" onclick="reportLeads()">Generate Report (CSV)</button>
        </div>
      </div>
      <div id="leads-view"></div>
    </div>`;
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
    <button class="btn small outline" type="button" onclick="openOrderConfirmationModal(${o.id})">Confirmation &amp; Annexure</button></td></tr>
    <tr id="so-terms-row-${o.id}" style="display:none;"><td colspan="8">${soTermsForm(o)}</td></tr>`);
}
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
      <button class="btn" onclick="addOrder()">Create Order</button>
    </div>
    <div class="panel">
      <div class="toolbar"><h3 id="so-count" style="margin:0;">Sales Orders (${orders.length})</h3>
        <button class="btn small outline" onclick="reportOrders()">Generate Report (CSV)</button>
      </div>
      ${renderListSearch('orders', orders, ['order_no', 'client_name', 'status', 'description'], (rows) => {
        document.getElementById('so-table-wrap').innerHTML = renderOrderRows(rows);
        document.getElementById('so-count').textContent = 'Sales Orders (' + rows.length + ')';
      }, 'Search by order no, client, status...')}
      <div id="so-table-wrap">${renderOrderRows(orders)}</div>
      <p class="muted" style="margin-top:10px;">Department-level target planning for a confirmed order now lives on the <a href="#" onclick="navigate('projects');return false;">Projects</a> tab, under that order's project.</p>
    </div>`;
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

window.addOrder = async () => {
  try {
    const r = await api('/sales/orders', { method: 'POST', body: JSON.stringify({
      client_id: val('so-client'), lead_id: val('so-lead') || null, order_value: val('so-value'), description: val('so-desc')
    })});
    // Commercial terms aren't accepted by the create endpoint (kept
    // separate/optional, Round 16) - a second call sets them if the user
    // filled any of those fields in.
    const delivery = val('so-delivery'), ldPct = val('so-ld-pct'), ldCap = val('so-ld-cap'), ldNotes = val('so-ld-notes');
    if (delivery || ldPct || ldCap || ldNotes) {
      await api(`/sales/orders/${r.id}/commercial-terms`, { method: 'PATCH', body: JSON.stringify({
        promised_delivery_date: delivery || null, ld_percentage: ldPct || null, ld_cap_percentage: ldCap || null, ld_trigger_notes: ldNotes || null
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
async function renderAttachmentsWidget(entityType, entityId, container) {
  if (!entityId) { container.innerHTML = ''; return; }
  const list = await api(`/attachments/${entityType}/${entityId}`);
  container.innerHTML = `
    <div class="attachments-widget" style="margin-top:8px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Attachments</div>
      ${list.length ? list.map(a => `
        <div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:2px;">
          <a href="${esc(a.file_path)}" target="_blank">${esc(a.original_name || a.file_path)}</a>
          <span class="muted">(${esc(a.uploaded_by_name)||'-'})</span>
          <button class="btn small outline" type="button" data-att-remove="${a.id}">Remove</button>
        </div>`).join('') : '<div class="muted" style="font-size:13px;">No attachments yet.</div>'}
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;">
        <input type="file" data-att-file>
        <button class="btn small" type="button" data-att-upload>Attach File</button>
      </div>
    </div>`;
  container.querySelectorAll('[data-att-remove]').forEach(btn => {
    btn.onclick = async () => { await api('/attachments/' + btn.getAttribute('data-att-remove'), { method: 'DELETE' }); renderAttachmentsWidget(entityType, entityId, container); };
  });
  const uploadBtn = container.querySelector('[data-att-upload]');
  const fileInput = container.querySelector('[data-att-file]');
  uploadBtn.onclick = async () => {
    if (!fileInput.files.length) { alert('Choose a file first.'); return; }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    try {
      await apiUpload(`/attachments/${entityType}/${entityId}`, fd);
      renderAttachmentsWidget(entityType, entityId, container);
    } catch (e) { alert(e.message); }
  };
}

let CURRENT_OFFER_ID = null;
let CURRENT_OFFER_TAB = 'scope';
let CURRENT_OFFER = null; // the offer header last fetched for the open builder - used to decide whether an edit will fork a new version

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
    <div class="panel">
      <div class="toolbar"><h3 id="of-count" style="margin:0;">All Offers (${offers.length})</h3>
        <button class="btn small outline" onclick="reportOffers()">Generate Report (CSV)</button>
      </div>
      ${renderListSearch('offers', offers, ['offer_no', 'client_name', 'subject', 'status', 'lead_enquiry_details'], (rows) => {
        document.getElementById('of-table-wrap').innerHTML = renderOfferRows(rows);
        document.getElementById('of-count').textContent = 'All Offers (' + rows.length + ')';
      }, 'Search by offer no, client, subject, status...')}
      <div id="of-table-wrap">${renderOfferRows(offers)}</div>
    </div>
    <div class="panel" id="offer-builder-panel" style="display:none;"></div>
  `;
};
function renderOfferRows(rows) {
  return tableHTML(['Offer No', 'Client', 'Enquiry/RFQ', 'Subject', 'Date', 'Status', ''], rows, o => `
    <tr><td>${esc(o.offer_no)}</td><td>${esc(o.client_name)}</td><td>${esc(o.lead_enquiry_details) || '-'}</td><td>${esc(o.subject)}</td><td>${new Date(o.offer_date).toLocaleDateString()}</td><td>${badge(o.status)}</td>
    <td><button class="btn small outline" onclick="openOfferBuilder(${o.id})">Open</button></td></tr>`);
}
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
  const [data, versions, applicationOpts, typeOpts, materialOpts] = await Promise.all([
    api('/offers/' + CURRENT_OFFER_ID),
    api('/offers/' + CURRENT_OFFER_ID + '/versions'),
    api('/offers/field-options/application'),
    api('/offers/field-options/type_of_system'),
    api('/offers/field-options/material_of_construction'),
  ]);
  const o = data.offer;
  CURRENT_OFFER = o;
  const tabs = [['scope', 'Scope of Supply & Pictures'], ['tech', 'Technical Specification'], ['boughtout', 'Make of Bought Out Items'], ['terms', 'Terms & Conditions'], ['text', 'Inclusions / Exclusions / Utilities']];
  panel.innerHTML = `
    <h3>Offer Builder &mdash; ${esc(o.offer_no)} v${o.version} <span class="badge ${esc(o.status)}">${esc(o.status)}</span></h3>
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
      instrument_air_supply: data.offer.instrument_air_supply, status: data.offer.status, revision_reason: reason || null
    })});
    await afterOfferMutation({ newVersion: r.newVersion, offerId: r.id }, 'Header saved');
  } catch (e) { alert(e.message); }
};
window.downloadOfferVersionPdf = async (offerId) => {
  try {
    const res = await fetch('/api/offers/' + offerId + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'offer-v' + offerId + '.pdf'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
};
window.downloadOfferPdf = async () => {
  try {
    const res = await fetch('/api/offers/' + CURRENT_OFFER_ID + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'offer.pdf'; a.click();
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
  if (CURRENT_OFFER_TAB === 'tech') return renderKvTab(el, data.techSpecs, 'spec_key', 'spec_value', 'tech-specs', 'Specification', 'Value');
  if (CURRENT_OFFER_TAB === 'boughtout') return renderKvTab(el, data.boughtOut, 'component', 'make', 'bought-out', 'Component', 'Make');
  if (CURRENT_OFFER_TAB === 'terms') return renderKvTab(el, data.terms, 'term_key', 'term_value', 'terms', 'Term', 'Value');
  if (CURRENT_OFFER_TAB === 'text') return renderTextTab(el, data.offer);
}

function renderScopeTab(el, data) {
  const items = data.items;
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
      <div><label>Section Title</label><input id="it-section" placeholder="e.g. Electronic Net Weighing And Bagging System"></div>
      <div><label>Qty</label><input id="it-qty" type="number" value="1"></div>
      <div><label>Unit Price (₹)</label><input id="it-price" type="number" value="0"></div>
      <div><label>Picture (optional)</label><input id="it-image" type="file" accept="image/*"></div>
    </div>
    <label>Description</label>
    <textarea id="it-desc" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
    <div style="margin-top:8px;">
      <button class="btn" id="it-submit-btn" onclick="addOfferItem()">Add Line</button>
      <button class="btn outline" id="it-cancel-btn" onclick="cancelEditOfferItem()" style="display:none;">Cancel</button>
    </div>
  `;
}
let EDITING_OFFER_ITEM_ID = null;
window.editOfferItem = async (itemId) => {
  const data = await api('/offers/' + CURRENT_OFFER_ID);
  const it = data.items.find(x => x.id === itemId);
  if (!it) return;
  EDITING_OFFER_ITEM_ID = itemId;
  document.getElementById('it-code').value = it.item_code || '';
  document.getElementById('it-section').value = it.section_title || '';
  document.getElementById('it-desc').value = it.description || '';
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
    fd.append('qty', val('it-qty'));
    fd.append('unit_price', val('it-price'));
    fd.append('revision_reason', reason || '');
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

function renderKvTab(el, rows, keyField, valField, endpoint, keyLabel, valLabel) {
  el.innerHTML = `
    <table><thead><tr><th>${keyLabel}</th><th>${valLabel}</th><th></th></tr></thead>
    <tbody id="kv-rows">${rows.map((r, i) => `
      <tr data-i="${i}">
        <td><input class="kv-key" value="${esc(r[keyField])}" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
        <td><input class="kv-val" value="${esc(r[valField])}" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
        <td><button class="btn small red" onclick="this.closest('tr').remove()">Remove</button></td>
      </tr>`).join('')}</tbody></table>
    <button class="btn small outline" onclick="addKvRow()">+ Add Row</button>
    <button class="btn" onclick="saveKvTab('${endpoint}', '${keyField}', '${valField}')">Save</button>
  `;
}
window.addKvRow = () => {
  const tbody = document.getElementById('kv-rows');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="kv-key" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
    <td><input class="kv-val" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
    <td><button class="btn small red" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
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

function renderTextTab(el, offer) {
  el.innerHTML = `
    <label>Inclusions</label>
    <textarea id="txt-inclusions" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(offer.inclusions)}</textarea>
    <label style="margin-top:10px;display:block;">Exclusions (one per line)</label>
    <textarea id="txt-exclusions" rows="6" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(offer.exclusions)}</textarea>
    <label style="margin-top:10px;display:block;">Utilities Requirement</label>
    <textarea id="txt-utilities" rows="2" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(offer.utilities_requirement)}</textarea>
    <label style="margin-top:10px;display:block;">Instrument Air Supply</label>
    <textarea id="txt-air" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(offer.instrument_air_supply)}</textarea>
    <div style="margin-top:10px;"><button class="btn" onclick="saveTextTab()">Save</button></div>
  `;
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
      status: data.offer.status, revision_reason: reason || null
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
    <div class="panel">
      <h3>All Targets (${targets.length})</h3>
      ${tableHTML(['Period', 'Owner', 'Target Value', ''], targets, t => `
        <tr><td>${esc(t.period)}</td><td>${esc(t.owner_name) || 'Company-wide'}</td><td>₹${fmt(t.target_value)}</td>
        <td><button class="btn small red" onclick="deleteSalesTarget(${t.id})">Delete</button></td></tr>`)}
    </div>`;
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
    <div class="panel"><h3>Projects (${projects.length})</h3>
      ${tableHTML(['Code', 'Title', 'Client', 'Status', 'PM', 'Target Completion', ''], projects, p => `
        <tr data-project-row="${p.id}"><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${esc(p.client_name)||'-'}</td><td>${badge(p.status)}</td><td>${esc(p.pm_name)}</td>
        <td class="pr-target">${p.target_date ? `<b>${new Date(p.target_date).toLocaleDateString()}</b>` : '<span class="muted">Not planned yet</span>'}</td>
        <td><button class="btn small outline" onclick="viewProjectCards(${p.id}, '${esc(p.project_code)}')">View Pipeline</button></td></tr>`)}
      <p class="muted" style="margin-top:10px;">Set or edit each project's department targets from the <a href="#" onclick="navigate('targets');return false;">Targets</a> tab.</p>
    </div>
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
    <div class="panel"><h3>Targets by Project (${projects.length})</h3>
      ${tableHTML(['Code', 'Title', 'Client', 'Status', 'Target Completion'], projects, p => `
        <tr data-project-row="${p.id}"><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${esc(p.client_name)||'-'}</td><td>${badge(p.status)}</td>
        <td class="pr-target">${p.target_date ? `<b>${new Date(p.target_date).toLocaleDateString()}</b>` : '<span class="muted">Not planned yet</span>'}</td></tr>`)}
    </div>
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
  el.innerHTML = `<div class="panel"><h3>Job Cards for ${esc(ME.role)} (${cards.length})</h3>
    ${tableHTML(['Project', 'Item', 'Status', 'Assigned', 'Action'], cards, c => `
      <tr><td>${esc(c.project_code)} - ${esc(c.project_title)}</td><td>${esc(c.title || STAGE_LABELS[c.stage] || c.stage)}${c.is_adhoc ? ' <span class="muted">(sub-assembly/routed)</span>' : ''}</td><td>${badge(c.status)}</td><td>${esc(c.assigned_to_name)||'-'}</td>
      <td>${jobCardActions(c)}</td></tr>`)}
  </div>
  <div class="panel" id="sp-panel" style="display:none;"><h3 id="sp-title"></h3><div id="sp-body"></div></div>
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
    body = `<div class="panel"><h3>${esc(label)} (${rows.length})</h3>
      ${rows.length ? tableHTML(['Project', 'Item', 'Status', 'Assigned', 'Action'], rows, cardRow)
        : '<p class="muted">No job cards in this section.</p>'}
    </div>`;
  } else if (subStages) {
    const own = cards.filter(c => c.stage === stage);
    const sections = [{ key: stage, title: label + ' (overall)', rows: own }]
      .concat(subStages.map(s => ({ key: s, title: STAGE_LABELS[s] || s, rows: cards.filter(c => c.stage === s) })));
    body = sections.map(sec => `
      <div class="panel"><h3>${esc(sec.title)} (${sec.rows.length})</h3>
        ${sec.rows.length ? tableHTML(['Project', 'Item', 'Status', 'Assigned', 'Action'], sec.rows, cardRow)
          : '<p class="muted">No job cards in this section.</p>'}
      </div>`).join('');
  } else {
    body = `<div class="panel"><h3>${esc(label)} (${cards.length})</h3>
      ${tableHTML(['Project', 'Item', 'Status', 'Assigned', 'Action'], cards, cardRow)}
    </div>`;
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
    <div class="panel"><h3 id="ve-count">Vendors (${vendors.length})</h3>
      ${renderListSearch('vendors', vendors, ['legal_name', 'name', 'gstin', 'state', 'category', 'contact_person', 'phone', 'po_email', 'email'], (rows) => {
        document.getElementById('ve-table-wrap').innerHTML = renderVendorRows(rows);
        document.getElementById('ve-count').textContent = 'Vendors (' + rows.length + ')';
      }, 'Search by name, GSTIN, state, category, contact...')}
      <div id="ve-table-wrap">${renderVendorRows(vendors)}</div>
    </div>`;
};
function renderVendorRows(rows) {
  return tableHTML(['Name', 'GSTIN', 'State', 'Category', 'Contact', 'Phone', 'PO Email', 'Terms', 'Status'], rows, v => `<tr>
    <td>${esc(v.legal_name || v.name)}</td><td>${esc(v.gstin)||'-'}</td><td>${esc(v.state)||'-'}</td><td>${esc(v.category)||'-'}</td>
    <td>${esc(v.contact_person)||'-'}</td><td>${esc(v.phone)||'-'}</td><td>${esc(v.po_email||v.email)||'-'}</td>
    <td>${esc(v.payment_terms)||'-'}</td><td>${badge(v.status||'Active')}</td></tr>`);
}
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
PAGES['purchase-requests'] = async (el) => {
  const reqs = await api('/purchase/requests');
  const items = await api('/masters/items');
  const projects = await api('/projects');
  const threshold = (await api('/settings/purchase-quote-threshold')).quote_threshold;
  window.__PR_THRESHOLD = threshold;
  el.innerHTML = `
    <div class="panel"><h3>New Purchase Request</h3>
      <div class="form-grid">
        <div><label>Item (pick from master)</label><select id="pr-item" onchange="showVendorsForPRItem()"><option value="">- type a new item instead -</option>${items.filter(i=>i.status!=='Pending').map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></div>
        <div><label>Or type an item name</label><input id="pr-item-text" placeholder="Not in the master? Type it here"></div>
        <div><label>Project</label><select id="pr-project"><option value="">-</option>${projects.map(p => `<option value="${p.id}">${esc(p.project_code)}</option>`).join('')}</select></div>
        <div><label>Quantity</label><input id="pr-qty" type="number"></div>
        <div><label>Estimated Value (₹)</label><input id="pr-value" type="number"></div>
      </div>
      <div id="pr-vendor-suggestions" style="display:none;margin-top:8px;padding:10px;background:#f5f5f5;border-radius:6px;font-size:13px;"></div>
      <button class="btn" onclick="addPR()">Submit Request</button>
      <div class="muted" style="margin-top:8px;">Picking from the master is optional — type a new item name if it isn't there yet. It goes to Store & Inventory → Item Master as <b>Pending</b> for review, and becomes a permanent master item once Store approves it (usually while receiving the goods).<br>
      Every request goes to the Purchase HOD/Supervisor for approval first; above the configured threshold it then also needs Management sign-off (see Admin → Approval Matrix).<br>
      Requests estimated at ₹${fmt(threshold)} or above need at least 2 vendor quotes on file before they can be submitted for approval.</div>
    </div>
    <div class="panel"><h3 id="pr-count">Purchase Requests (${reqs.length})</h3>
      <p class="muted">Pending requests can be edited before they're approved — click Edit to review/change the item, project, quantity or value.</p>
      ${renderListSearch('purchase-requests', reqs, ['pr_no', 'item_name', 'project_code', 'status'], (rows) => {
        document.getElementById('pr-table-wrap').innerHTML = renderPRRows(rows);
        document.getElementById('pr-count').textContent = 'Purchase Requests (' + rows.length + ')';
      }, 'Search by PR no, item, project, status...')}
      <div id="pr-table-wrap">${renderPRRows(reqs)}</div>
    </div>
    <div class="panel" id="pr-edit-panel" style="display:none;"><h3>Edit Purchase Request</h3><div id="pr-edit-body"></div></div>`;
  if (items.length === 0) el.querySelector('.panel').insertAdjacentHTML('afterbegin', `<div class="msg err">No items defined yet — add items via Store page first.</div>`);
  window.__PR_CACHE = reqs; window.__PR_ITEMS = items; window.__PR_PROJECTS = projects;
};
function renderPRRows(rows) {
  return tableHTML(['PR No', 'Item', 'Project', 'Qty', 'Est. Value', 'Status', 'Action'], rows, r => `
    <tr id="pr-row-${r.id}">
      <td>${esc(r.pr_no)}</td>
      <td>${esc(r.item_name)}${r.item_master_status === 'Pending' ? ' <span class="badge Pending" title="Not yet in the approved Item Master">Item pending review</span>' : ''}</td>
      <td>${esc(r.project_code)||'-'}</td><td>${r.quantity}</td><td>₹${fmt(r.estimated_value)}</td><td>${badge(r.status)}</td>
      <td>
        ${r.status === 'Pending' ? `<button class="btn small outline" onclick="openEditPR(${r.id})">Edit</button>` : ''}
        ${r.quotes_required ? `<button class="btn small outline" type="button" onclick="togglePRQuotes(${r.id})">Vendor Quotes</button>` : ''}
        ${!r.status || (r.status !== 'Pending' && !r.quotes_required) ? (r.quotes_required ? '' : '-') : ''}
      </td>
    </tr>
    ${r.quotes_required ? `<tr id="pr-quotes-row-${r.id}" style="display:none;"><td colspan="7"><div id="pr-quotes-${r.id}"></div></td></tr>` : ''}`);
}
window.showVendorsForPRItem = async () => {
  const itemId = val('pr-item');
  const box = document.getElementById('pr-vendor-suggestions');
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
async function renderPRQuotesPanel(prId) {
  const container = document.getElementById('pr-quotes-' + prId);
  const pr = (window.__PR_CACHE || []).find(r => r.id === prId);
  const [quotes, vendorResult] = await Promise.all([
    api(`/purchase/requests/${prId}/quotes`),
    pr && pr.item_id ? api('/purchase/vendors-for-item/' + pr.item_id) : Promise.resolve({ vendors: [] }),
  ]);
  const vendors = vendorResult.vendors || [];
  const canSubmit = quotes.length >= 2 && pr && pr.status === 'PendingQuotes';
  container.innerHTML = `
    <div style="padding:10px;background:#f9f9f9;border-radius:6px;">
      <h4 style="margin:0 0 8px;">Vendor Quotes ${pr ? '- ' + esc(pr.pr_no) : ''}</h4>
      ${tableHTML(['Vendor', 'Quoted Amount', 'File', 'Notes', 'Selected', ''], quotes, q => `
        <tr>
          <td>${esc(q.vendor_name)}</td><td>₹${fmt(q.quoted_amount)}</td>
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
        <div><label>Quoted Amount (₹)</label><input id="prq-amount-${prId}" type="number"></div>
        <div><label>Quote File</label><input id="prq-file-${prId}" type="file"></div>
        <div><label>Notes</label><input id="prq-notes-${prId}"></div>
      </div>
      <button class="btn small" type="button" onclick="addPRQuote(${prId})" ${!vendors.length ? 'disabled' : ''}>Add Quote</button>
      <button class="btn" type="button" style="margin-left:10px;" onclick="submitPRForApproval(${prId})" ${canSubmit ? '' : 'disabled'}>Submit for Approval</button>
      ${!canSubmit && pr && pr.status === 'PendingQuotes' ? `<span class="muted" style="margin-left:8px;">Need at least 2 quotes (have ${quotes.length}).</span>` : ''}
    </div>`;
}
window.addPRQuote = async (prId) => {
  try {
    const fd = new FormData();
    fd.append('vendor_id', val('prq-vendor-' + prId));
    fd.append('quoted_amount', val('prq-amount-' + prId));
    fd.append('notes', val('prq-notes-' + prId));
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
  try {
    await api('/purchase/requests', { method: 'POST', body: JSON.stringify({
      item_id: val('pr-item') || null, item_text: val('pr-item-text'), project_id: val('pr-project') || null, quantity: val('pr-qty'), estimated_value: val('pr-value')
    })});
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};
window.openEditPR = (id) => {
  const r = (window.__PR_CACHE || []).find(x => x.id === id);
  if (!r) return;
  const items = window.__PR_ITEMS || [], projects = window.__PR_PROJECTS || [];
  const panel = document.getElementById('pr-edit-panel');
  document.getElementById('pr-edit-body').innerHTML = `
    <div class="form-grid">
      <div><label>Item</label><select id="pre-item">${items.map(i => `<option value="${i.id}" ${i.id===r.item_id?'selected':''}>${esc(i.name)}</option>`).join('')}</select></div>
      <div><label>Project</label><select id="pre-project"><option value="">-</option>${projects.map(p => `<option value="${p.id}" ${p.id===r.project_id?'selected':''}>${esc(p.project_code)}</option>`).join('')}</select></div>
      <div><label>Quantity</label><input id="pre-qty" type="number" value="${r.quantity}"></div>
      <div><label>Estimated Value (₹)</label><input id="pre-value" type="number" value="${r.estimated_value}"></div>
    </div>
    <button class="btn" onclick="saveEditPR(${id})">Save Changes</button>
    <button class="btn outline" type="button" onclick="document.getElementById('pr-edit-panel').style.display='none'">Cancel</button>
    <div id="pr-attachments-${id}"></div>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  renderAttachmentsWidget('purchase_request', id, document.getElementById(`pr-attachments-${id}`));
};
window.saveEditPR = async (id) => {
  try {
    await api('/purchase/requests/' + id, { method: 'PUT', body: JSON.stringify({
      item_id: val('pre-item'), project_id: val('pre-project') || null, quantity: val('pre-qty'), estimated_value: val('pre-value')
    })});
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};

// ---- Purchase Orders ----
PAGES['purchase-orders'] = async (el) => {
  const orders = await api('/purchase/orders');
  const vendors = await api('/masters/vendors');
  const items = await api('/masters/items');
  const prs = (await api('/purchase/requests')).filter(r => r.status === 'Approved');
  el.innerHTML = `
    <div class="panel"><h3>New Purchase Order</h3>
      ${!vendors.length ? `<div class="msg err">No vendors yet - add one under <a href="#" onclick="navigate('vendors');return false;">Vendor Master</a> before creating a PO.</div>` : ''}
      <div class="form-grid">
        <div><label>From PR (approved)</label><select id="po-pr" onchange="fillPOFromPR()"><option value="">-</option>${prs.map(r => `<option value="${r.id}">${esc(r.pr_no)}</option>`).join('')}</select></div>
        <div><label>Vendor</label><select id="po-vendor" ${!vendors.length ? 'disabled' : ''}>${vendors.length ? vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('') : '<option value="">- No vendors -</option>'}</select></div>
        <div><label>Item</label><select id="po-item" onchange="showVendorsForPOItem()">${items.map(i => `<option value="${i.id}">${esc(i.name)}${i.status === 'Pending' ? ' (pending review)' : ''}</option>`).join('')}</select></div>
        <div><label>Quantity</label><input id="po-qty" type="number"></div>
        <div><label>Rate (₹)</label><input id="po-rate" type="number"></div>
        <div><label>HSN Code</label><input id="po-hsn"></div>
        <div><label>GST Rate (%)</label><input id="po-gst" type="number" value="18"></div>
        <div><label>Delivery Date</label><input id="po-delivery" type="date"></div>
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
    <div class="panel"><h3 id="po-count">Purchase Orders (${orders.length})</h3>
      ${renderListSearch('purchase-orders', orders, ['po_no', 'vendor_name', 'item_name', 'status'], (rows) => {
        document.getElementById('po-table-wrap').innerHTML = renderPORows(rows);
        document.getElementById('po-count').textContent = 'Purchase Orders (' + rows.length + ')';
      }, 'Search by PO no, vendor, item, status...')}
      <div id="po-table-wrap">${renderPORows(orders)}</div>
    </div>`;
  window.__PO_PRS = prs;
};
function renderPORows(rows) {
  return tableHTML(['PO No', 'Vendor', 'Item', 'Qty', 'Rate', 'Total', 'Status', 'Promised Delivery', 'Documents', ''], rows, o => `
    <tr><td>${esc(o.po_no)}</td><td>${esc(o.vendor_name)}</td><td>${esc(o.item_name)}</td><td>${o.quantity}</td><td>₹${fmt(o.rate)}</td><td>₹${fmt(o.total_value)}</td><td>${badge(o.status)}</td>
    <td>${deliveryBadge(o.delivery_date)}</td>
    <td>
      <button class="btn small outline" type="button" onclick="downloadPoPdf(${o.id}, '${esc(o.po_no)}')">PDF</button>
      <button class="btn small outline" type="button" onclick="downloadPoDocx(${o.id}, '${esc(o.po_no)}')">Word</button>
      <button class="btn small outline" type="button" onclick="emailPo(${o.id})">Email Vendor</button>
    </td>
    <td><button class="btn small outline" type="button" onclick="togglePOAttachments(${o.id})">Attachments</button>
    <button class="btn small outline" type="button" onclick="togglePOTerms(${o.id})">Terms</button></td></tr>
    <tr id="po-att-row-${o.id}" style="display:none;"><td colspan="10"><div id="po-attachments-${o.id}"></div></td></tr>
    <tr id="po-terms-row-${o.id}" style="display:none;"><td colspan="10">${poTermsForm(o)}</td></tr>`);
}
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
window.fillPOFromPR = () => {
  const id = Number(val('po-pr'));
  const detail = document.getElementById('po-pr-detail');
  if (!id) { detail.style.display = 'none'; return; }
  const r = (window.__PO_PRS || []).find(x => x.id === id);
  if (!r) { detail.style.display = 'none'; return; }
  detail.style.display = 'block';
  detail.innerHTML = `<b>${esc(r.pr_no)}</b> — Item: <b>${esc(r.item_name)}</b> &nbsp; Qty requested: <b>${r.quantity}</b> &nbsp;
    Project: <b>${esc(r.project_code)||'-'}</b> &nbsp; Est. Value: <b>₹${fmt(r.estimated_value)}</b>`;
  const itemSel = document.getElementById('po-item');
  if (itemSel && r.item_id) itemSel.value = r.item_id;
  const qtyEl = document.getElementById('po-qty');
  if (qtyEl && !qtyEl.value) qtyEl.value = r.quantity;
};
window.addPO = async () => {
  try {
    const r = await api('/purchase/orders', { method: 'POST', body: JSON.stringify({
      purchase_request_id: val('po-pr') || null, vendor_id: val('po-vendor'), item_id: val('po-item'), quantity: val('po-qty'), rate: val('po-rate'),
      hsn_code: val('po-hsn'), gst_rate: val('po-gst'), delivery_date: val('po-delivery'), terms: val('po-terms'),
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
  const [items, pendingItems] = await Promise.all([api('/masters/items'), api('/masters/items?status=Pending')]);
  const approvedItems = items.filter(i => i.status !== 'Pending');
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
    ${pendingItems.length ? `<div class="panel"><h3>Pending Item Master Review (${pendingItems.length})</h3>
      <p class="muted">These were typed freehand on a Purchase Request instead of picked from the master. Complete the details and Approve - typically while receiving the goods - to add them to the permanent Item Master (a barcode is generated at that point).</p>
      <div id="pending-items-body"></div>
    </div>` : ''}
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per item, then upload it. Barcodes are generated automatically - don't include them in the file.</p>
      <button class="btn outline" type="button" onclick="downloadItemTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('it-upload-file')}
      <button class="btn" onclick="uploadItemTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="it-upload-result" style="margin-top:10px;"></div>
    </div>
    <div class="panel"><h3>Item Master (${approvedItems.length})</h3>
      ${tableHTML(['Code', 'Name', 'Unit', 'Category', 'Location', 'Stock', 'Reorder Level', 'Barcode'], approvedItems, i => `
        <tr><td>${esc(i.item_code)}</td><td>${esc(i.name)}</td><td>${esc(i.unit)}</td><td>${esc(i.category)||'-'}</td><td>${esc(i.location)||'-'}</td>
          <td>${i.current_stock}${i.current_stock <= i.reorder_level ? ' ⚠️' : ''}</td><td>${i.reorder_level}</td>
          <td><span class="mono" style="letter-spacing:1px;">${esc(i.barcode)||'-'}</span></td></tr>`)}
    </div>`;
  if (pendingItems.length) renderPendingItemsPanel(pendingItems);
}
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
  const items = (await api('/masters/items')).filter(i => i.status !== 'Pending');
  const movements = await api('/purchase/store/movements');
  const openPOs = (await api('/purchase/orders')).filter(o => o.status === 'Open');
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
            ${openPOs.map(o => `<option value="${o.id}">${esc(o.po_no)} - ${esc(o.vendor_name)} - ${esc(o.item_name)||'-'} (ordered: ${o.quantity})</option>`).join('')}
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
    <div class="panel"><h3>Recent Movements</h3>
      ${tableHTML(['Item', 'Type', 'Qty', 'Reference', 'Date'], movements.slice(0, 30), m => `
        <tr><td>${esc(m.item_name)}</td><td>${badge(m.movement_type === 'IN' ? 'Approved' : 'Pending')}${m.movement_type}</td><td>${m.quantity}</td><td>${esc(m.reference)||''}</td><td>${new Date(m.moved_at).toLocaleString()}</td></tr>`)}
    </div>`;
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
  if (qtyEl) qtyEl.value = po.quantity;
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
      <div id="challan-list"></div>
    </div>`;
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
  listEl.innerHTML = `<h4 style="margin:14px 0 8px;">Saved Challans (${challans.length})</h4>
    ${tableHTML(['Challan No', 'Date', 'From', 'To', 'Vehicle', 'Items', 'Value', ''], challans, c => `
      <tr><td>${esc(c.challan_no)}</td><td>${new Date(c.challan_date).toLocaleDateString()}</td><td>${esc(c.from_location)}</td><td>${esc(c.to_location)}</td><td>${esc(c.vehicle_no)||'-'}</td><td>${c.item_count}</td><td>₹${fmt(c.total_value)}</td>
      <td><button class="btn small outline" onclick="printChallan(${c.id})">Print</button> <button class="btn small outline" onclick="downloadChallanPdf(${c.id}, '${esc(c.challan_no)}')">Download PDF</button></td></tr>`)}`;
}
window.downloadChallanPdf = async (id, challanNo) => {
  try {
    const res = await fetch('/api/purchase/store/challans/' + id + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = (challanNo || 'challan') + '.pdf'; a.click();
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
    <div class="panel"><h3>Service Request Queue (${reqs.length})</h3>
      <p class="muted">Newly logged requests appear here first. The Service HOD/Supervisor opens one and schedules it (assigns an employee + date) - only then does it move to In Progress.</p>
      ${tableHTML(['SR No', 'Customer', 'Contact', 'Scheduled', 'Assigned', 'Issue', 'Status', 'Prev. Report', 'Action'], reqs, r => `
        <tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name || r.customer_name)}</td>
        <td>${esc(r.contact_person)||'-'}${r.contact_phone ? ' / ' + esc(r.contact_phone) : ''}</td>
        <td>${r.scheduled_date||'-'}</td><td>${esc(r.employee_name)||'-'}</td>
        <td>${esc(r.issue_description)}</td><td>${badge(r.status)}${r.status==='Pending Items' ? ' <span class="muted" style="font-size:11px;">(back from technician)</span>' : ''}</td>
        <td>${r.report_count ? `<button class="btn small outline" onclick="viewSrReportHistory(${r.id},'${esc(r.sr_no)}')">View (${r.report_count})</button>` : '-'}</td>
        <td>${srActions(r)} <button class="btn small outline" type="button" onclick="viewSrUpdates(${r.id},'${esc(r.sr_no)}')">Updates</button></td></tr>`)}
    </div>
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
  window.__SVC_ITEMS = items.filter(i => i.status !== 'Pending');
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
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'service-report-' + srId + '.pdf'; a.click();
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
    <div class="panel"><h3>All Reopenings (${data.rows.length})</h3>
      ${tableHTML(['SR No', 'Technician', 'Original Closed At', 'Reopened At', 'Reason'], data.rows, r => `
        <tr><td>${esc(r.sr_no)}</td><td>${esc(r.technician_name)||'-'}</td><td>${esc(r.original_closed_at)}</td>
        <td>${esc(r.reopened_at)}</td><td>${esc(r.reason)||'-'}</td></tr>`)}
    </div>`;
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
    <div class="panel"><h3>Trend by Week</h3>
      ${tableHTML(['Week', 'Count'], Object.entries(d.byWeek).sort(), ([w,c]) => `<tr><td>${esc(w)}</td><td>${c}</td></tr>`)}
    </div>
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
    <div class="panel"><h3>Employees (${emps.length})</h3>
      ${emps.some(e => !e.full_name || !e.full_name.trim()) ? '<div class="msg err">One or more employees below have a blank name (created before this was required) - click Edit on the highlighted row(s) and fill in Full Name.</div>' : ''}
      ${tableHTML(['Code', 'Name', 'Department', 'Designation', 'Type', 'Salary', 'Status', 'Action'], emps, e => {
        const blank = !e.full_name || !e.full_name.trim();
        return `<tr id="emp-row-${e.id}"${blank ? ' style="background:#fef2f2;"' : ''}><td>${esc(e.employee_code)}</td><td>${blank ? '<span class="muted">(no name set)</span>' : esc(e.full_name)}</td><td>${esc(e.department_name)}</td><td>${esc(e.designation)}</td>
          <td>${esc(e.employment_type)||'Full-time'}</td><td>₹${fmt(e.monthly_salary)}</td><td>${badge(e.status)}</td>
          <td><button class="btn small outline" onclick="openEditEmployee(${e.id})">Edit</button></td></tr>`;
      })}
    </div>
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
    <div class="panel"><h3>This Month's Records (${records.length})</h3>
      ${tableHTML(['Employee', 'Date', 'Status'], records, r => `<tr><td>${esc(r.full_name)}</td><td>${r.work_date}</td><td>${badge(r.status==='Present'?'Approved':r.status==='Absent'?'Rejected':'Pending')}${r.status}</td></tr>`)}
    </div>`;
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
    <div class="panel"><h3>Leave Requests (${reqs.length})</h3>
      ${tableHTML(['Employee', 'Type', 'From', 'To', 'Days', 'Status', ''], reqs, r => `
        <tr><td>${esc(r.full_name)}</td><td>${esc(r.leave_type_name)}</td><td>${r.from_date}</td><td>${r.to_date}</td><td>${r.days}</td><td>${badge(r.status)}</td>
        <td><button class="btn small outline" type="button" onclick="toggleLeaveAttachments(${r.id})">Attachments</button></td></tr>
        <tr id="lv-att-row-${r.id}" style="display:none;"><td colspan="7"><div id="lv-attachments-${r.id}"></div></td></tr>`)}
    </div>`;
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
    <div class="panel"><h3>Advances (${advs.length})</h3>
      ${tableHTML(['Employee', 'Amount', 'Recovered', 'Installments', 'Status', 'Date', ''], advs, a => `
        <tr><td>${esc(a.full_name)}</td><td>₹${fmt(a.amount)}</td><td>₹${fmt(a.recovered_amount)} / ₹${fmt(a.amount)}</td>
        <td>${a.installments_paid || 0} / ${a.installments || 1} (₹${fmt(a.installment_amount)} each)</td>
        <td>${badge(a.status)}</td><td>${new Date(a.request_date).toLocaleDateString()}</td>
        <td><button class="btn small outline" type="button" onclick="toggleAdvanceAttachments(${a.id})">Attachments</button></td></tr>
        <tr id="ad-att-row-${a.id}" style="display:none;"><td colspan="7"><div id="ad-attachments-${a.id}"></div></td></tr>`)}
    </div>`;
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
    <div class="panel"><h3>Salary Schedule &mdash; ${month} (${schedule.length})</h3>
      ${tableHTML(['Employee', 'Days Present', 'Gross', 'Leave Ded.', 'Advance Ded.', 'Net Pay', 'Status', 'Action'], schedule, s => `
        <tr><td>${esc(s.full_name)}</td><td>${s.days_present}</td><td>₹${fmt(s.gross)}</td><td>₹${fmt(s.leave_deduction)}</td><td>₹${fmt(s.advance_deduction)}</td><td>₹${fmt(s.net_pay)}</td><td>${badge(s.status)}</td>
        <td>${payrollActions(s)}</td></tr>`)}
    </div>`;
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
PAGES.expenses = async (el) => {
  const vouchers = await api('/finance/expense-vouchers');
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
    <div class="panel"><h3>Expense Vouchers (${vouchers.length})</h3>
      ${tableHTML(['Voucher No', 'Dept', 'Category', 'Amount', 'Mode', 'Accounted', 'Bill', 'Status', 'Action'], vouchers, v => `
        <tr><td>${esc(v.voucher_no)}</td><td>${esc(v.department_name)}</td><td>${esc(v.category_name)}</td><td>₹${fmt(v.amount)}</td><td>${esc(v.payment_mode)}</td><td>${esc(v.accounted)}</td>
        <td>${v.attachment_path ? `<a href="${v.attachment_path}" target="_blank">View</a>` : '-'}</td><td>${badge(v.status)}</td>
        <td>${v.status === 'Approved' ? `<button class="btn small green" onclick="payExpense(${v.id})">Mark Paid</button>` : '-'}</td></tr>`)}
    </div>`;
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
PAGES['offer-options'] = async (el) => {
  const all = await api('/offers/field-options');
  const rows = all.filter(o => o.field_name === OFFER_OPTIONS_TAB);
  el.innerHTML = `
    <div class="panel">
      <div class="tabs">${OFFER_OPTION_FIELDS.map(([id, label]) => `<div class="tab ${OFFER_OPTIONS_TAB === id ? 'active' : ''}" onclick="switchOfferOptionsTab('${id}')">${label}</div>`).join('')}</div>
      <div style="margin-top:14px;" class="form-grid">
        <div><label>New Value</label><input id="oo-value"></div>
        <div><label>Sort Order</label><input id="oo-sort" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addOfferOption()">Add Option</button>
      <table style="margin-top:14px;"><thead><tr><th>Value</th><th>Sort</th><th>Active</th><th></th></tr></thead><tbody>
        ${rows.map(o => `<tr>
          <td><span contenteditable="true" class="inline-edit" onblur="editOfferOption(${o.id}, 'value', this.textContent)">${esc(o.value)}</span></td>
          <td><span contenteditable="true" class="inline-edit" onblur="editOfferOption(${o.id}, 'sort_order', this.textContent)">${o.sort_order}</span></td>
          <td>${o.active ? 'Yes' : 'No'}</td>
          <td><button class="btn small outline" onclick="editOfferOption(${o.id}, 'active', ${o.active ? 0 : 1})">${o.active ? 'Deactivate' : 'Activate'}</button></td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">No options yet.</td></tr>'}
      </tbody></table>
    </div>`;
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

// ---- Bank Guarantee Dashboard (Round 16) ----
PAGES['bg-dashboard'] = async (el) => {
  const [summary, bgs, reminders, orders] = await Promise.all([
    api('/bg/summary'), api('/bg'), api('/bg/reminders?status=PendingReview'), api('/bg/orders'),
  ]);
  const verified = await api('/bg/reminders?status=Verified');
  window.__BG_ORDERS = orders;
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
    <div class="panel"><h3>Finance Team - Claim Filing Tasks</h3>
      <p class="muted">High-priority To-Dos auto-raised for the Finance HOD when a BG's claim-filing deadline is 7 days out - full detail and status updates on the To-Do List page.</p>
      ${tableHTML(['Task', 'Assigned To', 'Target Date', 'Status'], summary.finance_todos, t => `
        <tr><td>${esc(t.brief_description)}</td><td>${esc(t.assigned_to_name)}</td><td>${deliveryBadge(t.target_date)}</td><td>${badge(t.status)}</td></tr>`)}
    </div>` : ''}

    ${(reminders.length || verified.length) ? `
    <div class="panel"><h3>Pending Reminders</h3>
      ${tableHTML(['BG No', 'Type', 'Value', 'Expiry', 'Reason', 'Step', 'Action'], [...reminders, ...verified], r => `
        <tr><td>${esc(r.bg_no || '#'+r.bg_id)}</td><td>${esc(r.bg_type)}</td><td>₹${fmt(r.value)}</td><td>${esc(r.validity_expiry)}</td><td>${esc(r.trigger_reason)}</td>
        <td>${badge(r.status)}</td>
        <td>
          ${r.status === 'PendingReview' ? `<button class="btn small" onclick="verifyBGReminder(${r.id})">Verify</button>` : ''}
          ${r.status === 'Verified' ? `<button class="btn small green" onclick="sendBGReminderEmail(${r.id})">Send Reminder Email</button>` : ''}
          <button class="btn small outline" onclick="dismissBGReminder(${r.id})">Dismiss</button>
        </td></tr>`)}
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
      </div>
      <div><label>Release Condition / Milestone Link</label><textarea id="bg-milestone" rows="2" style="width:100%;" placeholder="e.g. release on final acceptance / installation completion"></textarea></div>
      <button class="btn" onclick="addBG()">Add Bank Guarantee</button>
    </div>

    <div class="panel">
      <div class="tabs" id="bg-tabs">
        <div class="tab active" onclick="filterBGTab(this,'')">All</div>
        <div class="tab" onclick="filterBGTab(this,'Advance')">Advance</div>
        <div class="tab" onclick="filterBGTab(this,'Performance')">Performance</div>
        <div class="tab" onclick="filterBGTab(this,'PendingRelease')">Pending Release</div>
      </div>
      <div id="bg-table-wrap">${bgTableHTML(bgs)}</div>
    </div>`;
  window.__BG_ALL = bgs;
};
function bgTableHTML(bgs) {
  return tableHTML(['BG No', 'Type', 'Order', 'Bank', 'Value', 'Validity Expiry', 'Status', 'Action'], bgs, bg => `
    <tr><td>${esc(bg.bg_no || '#'+bg.id)}</td><td>${esc(bg.bg_type)}</td><td>[${esc(bg.order_type)}] ${esc(bg.order_label || '')}</td><td>${esc(bg.issuing_bank || '-')}</td>
    <td>₹${fmt(bg.value)}</td><td>${deliveryBadge(bg.validity_expiry)}</td><td>${badge(bg.status)}</td>
    <td>${bg.status !== 'Released' ? `<button class="btn small outline" onclick="releaseBG(${bg.id})">Mark Released</button>` : ''}</td></tr>`);
}
window.filterBGTab = (tabEl, filter) => {
  document.querySelectorAll('#bg-tabs .tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  const all = window.__BG_ALL || [];
  const filtered = !filter ? all : (filter === 'PendingRelease' ? all.filter(b => b.status === 'PendingRelease') : all.filter(b => b.bg_type === filter));
  document.getElementById('bg-table-wrap').innerHTML = bgTableHTML(filtered);
};
window.addBG = async () => {
  const orderSel = val('bg-order');
  if (!orderSel) { alert('No open SO/PO to attach this BG to.'); return; }
  const [order_type, order_id] = orderSel.split(':');
  try {
    await api('/bg', { method: 'POST', body: JSON.stringify({
      bg_no: val('bg-no'), bg_type: val('bg-type'), order_type, order_id,
      issuing_bank: val('bg-bank'), value: val('bg-value'), issue_date: val('bg-issue'),
      validity_expiry: val('bg-expiry'), claim_expiry: val('bg-claim'), milestone_link: val('bg-milestone'),
    })});
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
      ${tableHTML(['Date', 'Type', 'Department', 'Amount', 'Direction', 'Description'], ledger, l => `
        <tr><td>${new Date(l.entry_date).toLocaleString()}</td><td>${esc(l.type)}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td><td>${badge(l.direction)}</td><td>${esc(l.description)||'-'}</td></tr>`)}
    </div>`;
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
    <div class="panel"><h3>Users (${users.length})</h3>
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
    </div>
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
      <h3>Grant Extra Page Access (Round 3)</h3>
      <p class="muted">On top of the role-based matrix below, grant one page either to an entire department (applies to every current AND future user in it) or to specific individual users. Useful for one-off exceptions without changing a whole role's config.</p>
      <div id="extra-access-form"></div>
      <div id="extra-access-list"></div>
    </div>
    <div class="panel">
      <h3>User Access by Role</h3>
      <p class="muted">Tick the pages a role is allowed to see in the sidebar. A role with nothing configured (marked "Unrestricted") sees every page, same as today - saving any selection for a role switches it to that fixed list. Admin can always see everything and can't be restricted.</p>
      <div id="access-body"></div>
    </div>`;
  await renderExtraAccessPanel(data.pageCatalog);
  const body = document.getElementById('access-body');
  // "User Access" itself is always Admin-only regardless of any role's
  // configured pages, so it's meaningless to offer as a checkbox here.
  const catalogForRoles = data.pageCatalog.map(g => ({ group: g.group, items: g.items.filter(it => it.id !== 'access') })).filter(g => g.items.length);
  body.innerHTML = data.roles.filter(r => r.name !== 'Admin').map(r => `
    <div class="panel access-role-panel collapsed" style="margin-bottom:12px;" id="access-panel-${r.id}">
      <h4 class="access-role-head" onclick="toggleAccessRolePanel(${r.id})">
        <span>${esc(r.name)} ${r.configured ? badge('Pending') : '<span class="muted">(Unrestricted - sees everything)</span>'}</span>
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
  const [reqs, orders, clients] = await Promise.all([api('/finance/foc'), api('/sales/orders'), api('/masters/clients')]);
  const canRequest = has('foc.request') && (ME.is_supervisor || ME.role === 'Admin');
  const canApprove = has('foc.approve');
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
    <div class="panel"><h3>FOC Requests (${reqs.length})</h3>
      ${tableHTML(['FOC No', 'Order', 'Customer', 'Department', 'Item', 'Qty', 'Value', 'Requested By', 'Status', 'Action', ''], reqs, r => `
        <tr><td>${esc(r.foc_no)}</td><td>${esc(r.order_no)||'-'}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${esc(r.department_name)||'-'}</td>
        <td>${focEditableCell(r, 'item_description')}</td><td>${focEditableCell(r, 'quantity')} ${esc(r.unit)}</td><td>₹${fmt(r.estimated_value)}</td>
        <td>${esc(r.requested_by_name)}</td><td>${badge(r.status)}</td>
        <td>${focActions(r, canApprove)}</td>
        <td><button class="btn small outline" type="button" onclick="toggleFOCAttachments(${r.id})">Attachments</button></td></tr>
        <tr id="foc-att-row-${r.id}" style="display:none;"><td colspan="11"><div id="foc-attachments-${r.id}"></div></td></tr>`)}
    </div>`;
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
    return `<button class="btn small green" onclick="focAction(${r.id}, 'approve')">Approve</button> <button class="btn small red" onclick="focAction(${r.id}, 'reject')">Reject</button>`;
  }
  if (r.status === 'Approved' && has('store.manage')) {
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
  try { await api(`/finance/foc/${id}/${action}`, { method: 'POST' }); navigate('foc'); }
  catch (e) { alert(e.message); }
};

// ===================== Round 5: Company Settings =====================
PAGES['company-settings'] = async (el) => {
  const [company, email] = await Promise.all([api('/settings/company'), api('/settings/email').catch(() => null)]);
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
    </div>` : ''}
  `;
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
    <div class="panel"><h3>Invoices (${invoices.length})</h3>
      ${tableHTML(['Invoice No', 'Client', 'Date', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Status', ''], invoices, i => `
        <tr><td>${esc(i.invoice_no)}</td><td>${esc(i.client_name)}</td><td>${new Date(i.invoice_date).toLocaleDateString()}</td>
        <td>₹${fmt(i.taxable_value)}</td><td>₹${fmt(i.cgst)}</td><td>₹${fmt(i.sgst)}</td><td>₹${fmt(i.igst)}</td><td>₹${fmt(i.total_value)}</td><td>${badge(i.status)}</td>
        <td>
          <button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/invoices/${i.id}/pdf', '${esc(i.invoice_no).replace(/\//g,'-')}.pdf')">PDF</button>
          <button class="btn small outline" type="button" onclick="emailInvoice(${i.id})">Email to Client</button>
          ${i.status !== 'Paid' ? `<button class="btn small" type="button" onclick="markInvoicePaid(${i.id})">Mark Paid</button>` : ''}
          ${i.status === 'Draft' ? `<button class="btn small outline" type="button" onclick="cancelInvoice(${i.id})">Cancel</button>` : ''}
        </td></tr>`)}
    </div>
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
    <div class="panel"><h3>Proforma Invoices (${proformas.length})</h3>
      ${tableHTML(['Proforma No', 'Client', 'Order', 'Type', 'Milestone', 'Total', 'Status', ''], proformas, p => `
        <tr><td>${esc(p.proforma_no)}</td><td>${esc(p.client_name)}</td><td>${esc(p.order_no)}</td><td>${p.invoice_type === 'Advance' ? 'Advance' : 'Pre-Dispatch'}</td>
        <td>${esc(p.milestone_name)||'-'}</td><td>₹${fmt(p.total_value)}</td><td>${badge(p.status)}</td>
        <td>
          <button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/proforma-invoices/${p.id}/pdf', '${esc(p.proforma_no).replace(/\//g,'-')}.pdf')">PDF</button>
          <button class="btn small outline" type="button" onclick="emailProforma(${p.id})">Email to Client</button>
          ${p.status === 'Draft' ? `<button class="btn small" type="button" onclick="markProformaReceived(${p.id})">Mark Received</button>
          <button class="btn small outline" type="button" onclick="cancelProforma(${p.id})">Cancel</button>` : ''}
        </td></tr>`)}
    </div>`;
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
    await api(`/finance/proforma-invoices/from-sales-order/${soId}`, { method: 'POST', body: JSON.stringify({
      invoice_type: val('pf-type'), milestone_id: val('pf-milestone') || null, amount: val('pf-amount') || undefined,
      buyer_state: val('pf-buyer-state'), buyer_gstin: val('pf-buyer-gstin'),
    })});
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
PAGES['operating-expenses'] = async (el) => {
  const rows = await api('/finance/operating-expenses');
  el.innerHTML = `
    <div class="panel"><h3>New Operating Expense</h3>
      <div class="form-grid">
        <div><label>Date</label><input id="oe-date" type="date"></div>
        <div><label>Category</label><input id="oe-category" placeholder="Rent / Utilities / Subscriptions"></div>
        <div><label>Amount (₹)</label><input id="oe-amount" type="number"></div>
        <div><label>Paid Via</label><select id="oe-paid-via"><option>Bank</option><option>Cash</option></select></div>
      </div>
      <div><label>Description</label><input id="oe-desc" style="width:100%;"></div>
      <button class="btn" onclick="addOperatingExpense()" style="margin-top:8px;">Add Expense</button>
      <div id="oe-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    <div class="panel"><h3>Operating Expenses (${rows.length})</h3>
      ${tableHTML(['Date', 'Category', 'Description', 'Amount', 'Paid Via'], rows, r => `
        <tr><td>${new Date(r.expense_date).toLocaleDateString()}</td><td>${esc(r.category)}</td><td>${esc(r.description)}</td><td>₹${fmt(r.amount)}</td><td>${esc(r.paid_via)}</td></tr>`)}
    </div>`;
};
window.addOperatingExpense = async () => {
  const errEl = document.getElementById('oe-err'); errEl.style.display = 'none';
  try {
    await api('/finance/operating-expenses', { method: 'POST', body: JSON.stringify({
      expense_date: val('oe-date') || undefined, category: val('oe-category'), description: val('oe-desc'), amount: val('oe-amount'), paid_via: val('oe-paid-via'),
    })});
    navigate('operating-expenses');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
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
    <div class="panel"><h3>Asset Register (${assets.length})</h3>
      ${tableHTML(['Code', 'Name', 'Category', 'Dept', 'Custodian', 'Purchase Value', 'Book Value', 'Status', ''], assets, a => `
        <tr><td>${esc(a.asset_code)}</td><td>${esc(a.name)}</td><td>${esc(a.category)||'-'}</td><td>${esc(a.department_name)||'-'}</td>
        <td>${esc(a.custodian_name)||'-'}</td><td>₹${fmt(a.purchase_value)}</td><td>₹${fmt(a.book_value)}</td><td>${badge(a.status)}</td>
        <td><button class="btn small outline" type="button" onclick="viewAsset(${a.id})">Maintenance Log</button></td></tr>`)}
    </div>
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
  el.innerHTML = `
    <div class="panel"><h3>${esc(title)} (${rows.length})</h3>
      ${tableHTML(['Ticket No', 'Subject', 'Priority', 'Status', 'Department', 'Assigned To', ''], rows, t => `
        <tr><td>${esc(t.ticket_no)}</td><td>${esc(t.subject)}</td><td>${badge(t.priority)}</td><td>${badge(t.status)}</td>
        <td>${esc(t.department_name)||'-'}</td><td>${esc(t.assigned_to_name)||'-'}</td>
        <td><button class="btn small outline" type="button" onclick="viewTicket(${t.id})">Open</button></td></tr>`)}
    </div>
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
    <div class="panel"><h3>Service Centers (${centers.length})</h3>
      ${tableHTML(['Name', 'City', 'Contact', 'Phone', 'Status', ''], centers, c => `
        <tr><td>${esc(c.name)}</td><td>${esc(c.city)||'-'}</td><td>${esc(c.contact_person)||'-'}</td><td>${esc(c.phone)||'-'}</td>
        <td>${badge(c.status)}</td>
        <td><button class="btn small outline" onclick="editServiceCenter(${c.id})">Edit</button></td></tr>`)}
    </div>`;
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
  window.__SCT_ITEMS = items.filter(i => i.status !== 'Pending');
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
    <div class="panel"><h3>Transfers (${transfers.length})</h3>
      ${tableHTML(['Transfer No', 'Service Center', 'Items', 'Status', 'Dispatched By', 'Dispatched At'], transfers, t => `
        <tr><td>${esc(t.transfer_no)}</td><td>${esc(t.service_center_name)} (${esc(t.service_center_city)||'-'})</td><td>${t.item_count}</td>
        <td>${badge(t.status)}</td><td>${esc(t.dispatched_by_name)||'-'}</td><td>${new Date(t.dispatched_at).toLocaleString()}</td></tr>`)}
    </div>`;
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
    <div class="panel"><h3>Company-Wide: Central Store vs Distributed to Centers</h3>
      ${tableHTML(['Item', 'Central Store Stock', 'Total at Service Centers', 'Breakdown'], summary, i => `
        <tr><td>${esc(i.name)}${i.item_code?' ('+esc(i.item_code)+')':''}</td><td>${fmt(i.current_stock)} ${esc(i.unit)||''}</td>
        <td>${fmt(i.total_at_centers)} ${esc(i.unit)||''}</td>
        <td>${i.centers.map(c => `${esc(c.service_center_name)}: ${fmt(c.quantity)}`).join(', ') || '-'}</td></tr>`)}
    </div>`;
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
    return `<div class="panel"><h3>${esc(title)} (${rows.length})</h3><p class="muted">${esc(hint)}</p>
      ${tableHTML(['Site', 'Engineer(s)', 'Arrival', 'Close', 'Purpose / Pending Works', 'Expenses Note', ''], rows, v => `
        <tr><td>${esc(v.site_name)}</td><td>${v.engineers.map(e => esc(e.full_name)).join(', ') || '-'}</td>
        <td>${v.arrival_date||'-'}</td><td>${v.close_date||'-'}</td><td>${esc(v.purpose)||'-'}</td><td>${esc(v.expenses_note)||'-'}</td>
        <td><button class="btn small outline" onclick="editSiteVisit(${v.id})">Edit</button></td></tr>`)}
    </div>`;
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
PAGES['daily-work-log'] = async (el) => {
  const month = DWL_MONTH || thisMonth();
  DWL_MONTH = month;
  const [engineers, logs] = await Promise.all([api('/site-visits/engineers'), api('/site-visits/daily-log?month=' + month)]);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const byKey = {};
  logs.forEach(l => { byKey[l.employee_id + '|' + l.log_date] = l.note; });
  const dayCols = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const dateFor = (d) => `${month}-${String(d).padStart(2, '0')}`;
  el.innerHTML = `
    <div class="panel"><div class="form-grid"><div><label>Month</label>
      <input type="month" value="${month}" onchange="DWL_MONTH=this.value;navigate('daily-work-log')"></div></div>
      <p class="muted">One cell per engineer per day - type the job/site they worked on, or a shorthand like "OD" (outdoor duty), "A" (absent), "1/2" (half day), same as the old sheet.</p>
    </div>
    <div class="panel">
      <div style="overflow-x:auto;">
        <table class="et-grid"><thead><tr><th style="min-width:140px;">Engineer</th>
          ${dayCols.map(d => `<th style="min-width:120px;">${d}</th>`).join('')}</tr></thead>
        <tbody>
          ${engineers.map(e => `<tr><td>${esc(e.full_name)}</td>
            ${dayCols.map(d => `<td><input class="dwl-cell" data-emp="${e.id}" data-date="${dateFor(d)}" value="${esc(byKey[e.id+'|'+dateFor(d)]||'')}" style="width:110px;"></td>`).join('')}
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
    const entries = [];
    document.querySelectorAll('.dwl-cell').forEach(c => {
      entries.push({ employee_id: Number(c.dataset.emp), log_date: c.dataset.date, note: c.value });
    });
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
      ${tableHTML(['Action / Details', 'HOD', 'Start Date', 'Target Date', 'Status', ''], mine, t => `
        <tr><td>${detailsRow(t)}</td><td>${esc(t.hod_name) || '-'}</td><td>${t.start_date || '-'}</td>
        <td>${deliveryBadge(t.target_date)}</td>
        <td><select onchange="updateTodoStatus(${t.id}, this.value)">
          ${TODO_STATUSES.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></td><td>${updatesToggle(t)}</td></tr>
        <tr id="todo-updates-row-${t.id}" style="display:none;"><td colspan="6"><div id="todo-updates-${t.id}"></div></td></tr>`)}
    </div>

    ${canView ? `
    <div class="panel"><h3>All To-Dos Logged</h3>
      ${tableHTML(['Action / Details', 'HOD', 'Assigned To', 'Start Date', 'Target Date', 'Status', ''], all, t => `
        <tr><td>${detailsRow(t)}</td><td>${esc(t.hod_name) || '-'}</td><td>${esc(t.assigned_to_name)}</td>
        <td>${t.start_date || '-'}</td><td>${deliveryBadge(t.target_date)}</td>
        <td>${canLog ? `<select onchange="updateTodoStatus(${t.id}, this.value)">
          ${TODO_STATUSES.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>` : badge(t.status)}</td>
        <td>${updatesToggle(t)} ${canLog ? `<button class="btn small outline" onclick="deleteTodo(${t.id})">Delete</button>` : ''}</td></tr>
        <tr id="todo-updates-row-${t.id}" style="display:none;"><td colspan="7"><div id="todo-updates-${t.id}"></div></td></tr>`)}
    </div>` : ''}`;
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

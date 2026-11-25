// core.js - app state, api(), auth/login flow, permission helpers, boot(), NAV, sidebar,
// navigate() and the PAGES registry. Loaded FIRST (see public/index.html). Classic scripts share
// top-level names, so code here may call other files' helpers at run time but never at load time.

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
  if (!res.ok) {
    // A mid-session token expiry (middleware/auth.js's "Not authenticated"/
    // "Invalid or expired token"/"Invalid session") used to surface as
    // whatever raw alert() the calling action happened to use, leaving the
    // user staring at a stale, still-rendered page with no indication they
    // need to log back in - every action anywhere in the app hit this the
    // same way once a session ran past its expiry, not just Store & Inventory
    // Receive, which is just where it was first reported. Now it logs out
    // and shows the login screen itself, with a clear message, rather than
    // propagating the backend's literal text - the login screen appears
    // underneath whatever alert() the calling code still shows.
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      doLogout();
      const err = new Error('Your session has expired - please sign in again.');
      err.data = data;
      throw err;
    }
    const err = new Error(data.error || 'Request failed');
    err.data = data; // lets a caller read structured fields beyond .message (e.g. a soft-warning's conflict list)
    throw err;
  }
  return data;
}

function has(...codes) { return ME && (ME.role === 'Admin' || codes.some(c => PERMS.has(c))); }

// Mirrors routes/purchase.js's isPurchaseApprover() - "approver" = anyone
// who could act on the PurchaseRequest/PurchaseOrder approval chains (Admin,
// Management, or the Purchase department's own HOD), used to decide Edit/
// Add Line Item button visibility the same way the backend decides whether
// to actually allow the call (2026-10-07: creator-vs-approver edit gating).
function isPurchaseApprover() { return !!ME && (ME.role === 'Admin' || ME.role === 'Management' || (ME.role === 'Purchase' && ME.is_supervisor)); }
// Mirrors routes/purchase.js's isStoreApprover() - who, besides the
// original receiver, may edit+resubmit a Rejected GRN reconciliation.
function isStoreApprover() { return !!ME && (ME.role === 'Admin' || ME.role === 'Management' || (ME.role === 'Store' && ME.is_supervisor)); }
// Mirrors routes/service.js's isServiceHOD() - who may edit the inbound-
// mail acknowledgement template (business content, not IMAP credentials).
function isServiceHOD() { return !!ME && (ME.role === 'Admin' || (ME.role === 'Service' && ME.is_supervisor)); }
// Pre-approval: creator or an approver can edit/add lines. Post-approval
// (live/Open): only an approver can still edit - the creator's own access is
// withdrawn even though they still see the page. Terminal statuses are
// never editable by anyone.
function canEditPO(o) {
  const isOwner = o.created_by === ME.id;
  const approver = isPurchaseApprover();
  if (['Draft', 'PendingApproval', 'Rejected'].includes(o.status)) return isOwner || approver;
  if (['Open', 'PartiallyReceived'].includes(o.status)) return approver;
  return false;
}
// Permanent delete (2026-11-16, mirrors routes/purchase.js's own gate) -
// narrower than Edit: an approver only, never a plain creator, and only on
// a still-untouched line (Draft/Rejected/Cancelled) - the backend's own
// poDeleteBlockers() is the real safety net for a Cancelled line that had
// already gone live before being cancelled, so this client-side check is
// just for which button to show, not the authority on whether it'll work.
function canDeletePO(o) { return isPurchaseApprover() && ['Draft', 'Rejected', 'Cancelled'].includes(o.status); }
// Add Line Item is narrower than general Edit - unavailable once a PO has
// gone live (Open/PartiallyReceived), not even for an approver; adding to a
// shipped/receivable order means raising a new PO instead (see
// POST /orders/:id/add-line's own comment in routes/purchase.js).
function canAddPOLine(o) {
  const isOwner = o.created_by === ME.id;
  return ['Draft', 'PendingApproval', 'Rejected'].includes(o.status) && (isOwner || isPurchaseApprover());
}
function canEditPR(r) {
  const isOwner = r.raised_by === ME.id;
  const approver = isPurchaseApprover();
  if (['Draft', 'Pending', 'Rejected', 'InfoRequested'].includes(r.status)) return isOwner || approver;
  if (['Approved', 'OrderPlaced'].includes(r.status)) return approver;
  return false;
}

// ===================== Branding (logo on the login screen + sidebar) =====================
// Fetched once, before login - /auth/branding is unauthenticated by design
// (the login screen has no token yet) - and cached here for renderSidebar()
// to reuse after sign-in too, so there's only ever the one request per page
// load rather than fetching it again post-login.
let BRAND = null;
async function loadBranding() {
  try {
    BRAND = await api('/auth/branding');
  } catch (e) { BRAND = null; return; } // purely decorative - login/sidebar fall back to the text wordmark
  if (!BRAND.logo_path) return;
  ['login-logo-main', 'login-logo-forgot', 'login-logo-reset'].forEach(id => {
    const img = document.getElementById(id);
    if (!img) return;
    img.src = BRAND.logo_path;
    img.alt = BRAND.display_name || 'Company logo';
    img.style.display = 'block';
  });
}

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

// ===================== Notification bell =====================
// Reads the signed-in user's rows from the notifications table (GET /bg/notifications; the route predates the bell and
// also carries BG / delivery / To-Do alerts). Piggybacks on the To-Do badge refresh, so it updates on every navigate().
let NOTIFICATIONS = [];
async function refreshNotificationBell() {
  try { NOTIFICATIONS = await api('/bg/notifications'); } catch (e) { return; }
  const n = NOTIFICATIONS.filter(x => !x.is_read).length;
  const el = document.getElementById('bell-count');
  if (el) { el.textContent = n; el.style.display = n ? '' : 'none'; }
}
const NOTIFICATION_LINKS = { PR_REJECTED: 'purchase-requests', PO_REVOKED: 'purchase-orders' };
const NOTIFICATION_LINK_LABELS = { 'purchase-requests': 'Purchase Requests', 'purchase-orders': 'Purchase Orders' };
function notificationListHTML() {
  if (!NOTIFICATIONS.length) return '<div class="empty">No notifications.</div>';
  return `<div style="display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow-y:auto;">${NOTIFICATIONS.map(n => `
    <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;${n.is_read ? 'opacity:.65;' : 'border-left:3px solid var(--red);'}">
      <div style="${n.is_read ? '' : 'font-weight:600;'}word-break:break-word;">${esc(n.message)}</div>
      <div class="muted" style="font-size:12px;margin-top:4px;">${esc((n.created_at || '').slice(0, 16))}
        ${NOTIFICATION_LINKS[n.source_type] ? ` &middot; <a href="#" onclick="openNotification(${n.id});return false;">Open ${NOTIFICATION_LINK_LABELS[NOTIFICATION_LINKS[n.source_type]]}</a>` : ''}
        ${n.is_read ? '' : ` &middot; <a href="#" onclick="markNotificationRead(${n.id});return false;">Mark read</a>`}</div>
    </div>`).join('')}</div>`;
}
window.openNotifications = async () => {
  await refreshNotificationBell();
  openMiniModal('Notifications', `<div style="margin-bottom:8px;"><button class="btn small outline" type="button" onclick="markAllNotificationsRead()">Mark all read</button></div><div id="notif-list">${notificationListHTML()}</div>`, true);
};
window.markNotificationRead = async (id) => {
  try { await api('/bg/notifications/' + id + '/read', { method: 'POST' }); } catch (e) {}
  await refreshNotificationBell();
  const l = document.getElementById('notif-list'); if (l) l.innerHTML = notificationListHTML();
};
window.markAllNotificationsRead = async () => {
  try { await api('/bg/notifications/read-all', { method: 'POST' }); } catch (e) {}
  await refreshNotificationBell();
  const l = document.getElementById('notif-list'); if (l) l.innerHTML = notificationListHTML();
};
window.openNotification = async (id) => {
  const n = NOTIFICATIONS.find(x => x.id === id);
  try { await api('/bg/notifications/' + id + '/read', { method: 'POST' }); } catch (e) {}
  closeMiniModal();
  if (n && NOTIFICATION_LINKS[n.source_type]) navigate(NOTIFICATION_LINKS[n.source_type]);
};

// ===================== To-Do sidebar badge =====================
// A small count badge on the "To-Do List" nav item - the signed-in user's
// own actionable (non-Completed) items, same scope as "My To-Do List"
// always was. Refreshed at boot, after every navigate() (so completing/
// logging/deleting a To-Do updates it immediately without a full sidebar
// re-render), and on a slow background poll so it still catches a new item
// someone else assigns while the tab sits idle - a full notification system
// was deliberately out of scope for this round, just this one count.
let TODO_PENDING_COUNT = 0;
async function refreshTodoPendingCount() {
  refreshNotificationBell();
  try { TODO_PENDING_COUNT = (await api('/todos/my-pending-count')).count; }
  catch (e) { return; }
  const navEl = document.getElementById('nav-todos');
  if (!navEl) return;
  const badgeEl = navEl.querySelector('.nav-badge');
  if (TODO_PENDING_COUNT > 0) {
    if (badgeEl) badgeEl.textContent = TODO_PENDING_COUNT;
    else navEl.insertAdjacentHTML('beforeend', ` <span class="nav-badge">${TODO_PENDING_COUNT}</span>`);
  } else if (badgeEl) {
    badgeEl.remove();
  }
}

// ===================== Per-page sidebar badges (Purchase / Store & Inventory / Job Cards) =====================
// Live "pending count" badges for the handful of other sidebar pages that
// have an obvious "needs attention" count (2026-10-14, per the owner's
// explicit ask). Deliberately scoped to Purchase, Store & Inventory, and
// Job Cards "for now" - most sidebar pages (Vendors, Challans, Service
// Centers Master, Company Settings, every report...) have no natural
// pending-count concept, so this stays a short explicit map rather than
// trying to force one onto every page. Purchase Requests/Orders count the
// signed-in user's own not-yet-cleared items (Draft/pending approval/
// Rejected - mirrors canEditPR()/canEditPO()'s own "still active" reading
// of those statuses); Item Master and the GRN Reconciliation queue are
// global counts (Store's own review queues, not personal); My Job Cards
// mirrors GET /job-cards/mine's own department-scoped WHERE clause, so the
// count always matches what that page itself would show once expanded.
//
// Unlike the DOM-patch above, these are baked straight into renderSidebar()
// via PAGE_PENDING_COUNTS (same reasoning as the Todos badge's own
// "baked into markup, not just patched" comment: a nav-group toggle
// rebuilds the sidebar's innerHTML from scratch, which would otherwise wipe
// a DOM-only patch until the next refresh).
const PAGE_PENDING_COUNT_ENDPOINTS = {
  'purchase-requests': '/purchase/requests/my-pending-count',
  'purchase-orders': '/purchase/orders/my-pending-count',
  'store': '/masters/items/pending-count',
  'stock-in-out': '/purchase/store/grn-reconciliations/pending-count',
  'jobcards': '/projects/job-cards/my-pending-count',
};
let PAGE_PENDING_COUNTS = {};
async function refreshPagePendingCounts() {
  const entries = Object.entries(PAGE_PENDING_COUNT_ENDPOINTS);
  const results = await Promise.all(entries.map(([, path]) => api(path).then(r => r.count).catch(() => null)));
  entries.forEach(([pageId], i) => { if (results[i] != null) PAGE_PENDING_COUNTS[pageId] = results[i]; });
  renderSidebar();
  if (CURRENT_PAGE) {
    const navEl = document.getElementById('nav-' + CURRENT_PAGE);
    if (navEl) navEl.classList.add('active');
  }
}

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
  SIDEBAR_GROUP_ORDER = (await api('/settings/sidebar-group-order').catch(() => ({ order: [] }))).order || [];
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
  refreshTodoPendingCount();
  refreshPagePendingCounts();
  if (!window.__TODO_BADGE_POLL) window.__TODO_BADGE_POLL = setInterval(refreshTodoPendingCount, 5 * 60 * 1000);
  if (!window.__PAGE_BADGE_POLL) window.__PAGE_BADGE_POLL = setInterval(refreshPagePendingCounts, 5 * 60 * 1000);
  const landing = (!ALLOWED_PAGES || ALLOWED_PAGES.has('dashboard')) ? 'dashboard' : (NAV.flatMap(g => g.items).find(it => ALLOWED_PAGES.has(it.id)) || { id: 'dashboard' }).id;
  navigate(landing);
}

// ===================== Navigation / Sidebar =====================
// Group order is alphabetical by group label (2026-10-14, per the owner's
// explicit ask) - this array's own declaration order IS the sidebar order,
// so keep it sorted A-Z when adding/renaming a group rather than relying on
// a runtime sort, which would obscure the ordering rule from a future edit.
const NAV = [
  { group: 'Asset Management', items: [
    { id: 'assets', label: 'Asset Register' },
    { id: 'assets-maintenance', label: 'Maintenance / EOL Report' },
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
  { group: 'Finance', items: [
    { id: 'expenses', label: 'Expense Vouchers' },
    { id: 'expenses-mine', label: 'My Expense Vouchers' },
    { id: 'expense-report', label: 'Cash vs Accounted Report' },
    { id: 'foc', label: 'FOC Material Issue' },
    { id: 'finance-ledger', label: 'Finance Ledger' },
    { id: 'monthly-reconciliation', label: 'Monthly Reconciliation' },
    { id: 'sales-invoices', label: 'Sales Invoices' },
    { id: 'purchase-invoices', label: 'Purchase Invoices (AP)' },
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
    { id: 'tour-expenses-review', label: 'Technician Expense Review' },
  ]},
  { group: 'Overview', items: [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'approvals', label: 'My Approvals' },
    { id: 'overdue-items', label: 'Overdue Items' },
    { id: 'todos', label: 'To-Do List' },
    { id: 'dept-report', label: 'Department Report' },
  ]},
  { group: 'Payroll & HR', items: [
    { id: 'employees', label: 'Employees' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'leave', label: 'Leave Requests' },
    { id: 'advances', label: 'Salary Advances' },
    { id: 'payroll', label: 'Payroll' },
    { id: 'leave-balances', label: 'Leave Balances Master' },
    { id: 'referral-incentives', label: 'Referral Incentives' },
    { id: 'salary-hikes', label: 'Salary Hike History' },
    { id: 'salary-hike-cycles', label: 'Salary Hike Cycles' },
    { id: 'salary-report', label: 'Salary Report' },
    { id: 'tour-expenses-mine', label: 'My Travel & Expense' },
  ]},
  { group: 'Projects Management', items: [
    { id: 'projects', label: 'Projects' },
    { id: 'targets', label: 'Targets' },
    { id: 'dept-capacity', label: 'Department Capacity' },
    { id: 'jobcards', label: 'My Job Cards' },
    { id: 'time-motion-report', label: 'Time & Motion Report' },
  ]},
  { group: 'Purchase', items: [
    { id: 'purchase-requests', label: 'Purchase Requests' },
    { id: 'purchase-orders', label: 'Purchase Orders' },
    { id: 'rfq-dashboard', label: 'RFQ Dashboard' },
    { id: 'purchase-velocity', label: 'Purchase Velocity' },
    { id: 'vendors', label: 'Vendors' },
  ]},
  { group: 'Sales & Marketing', items: [
    { id: 'offers', label: 'Offers / Quotations' },
    { id: 'offer-options', label: 'Offer Field Options' },
    { id: 'offer-pdf-designer', label: 'Offer PDF Layout Designer' },
    { id: 'orders', label: 'Sales Orders' },
    { id: 'fg-dispatches', label: 'FG Packing & Dispatch' },
    { id: 'sale-rejection-mrns', label: 'Sale Rejection MRN' },
    { id: 'sales-credit-notes', label: 'Sales Credit Notes' },
    { id: 'clients', label: 'Clients' },
    { id: 'spares-comparison', label: 'Spares Price Comparison' },
  ]},
  { group: 'Settings', items: [
    { id: 'users', label: 'Users & Roles' },
    { id: 'access', label: 'User Access' },
    { id: 'approval-matrix', label: 'Approval Matrix' },
    { id: 'company-settings', label: 'Company Settings' },
    { id: 'data-import', label: 'Data Import' },
    { id: 'full-data-export', label: 'Full Data Export' },
    { id: 'org-hierarchy', label: 'Organizational Hierarchy' },
    { id: 'backups', label: 'Backups' },
  ]},
  { group: 'Store & Inventory', items: [
    { id: 'store', label: 'Item Master' },
    { id: 'stock-in-out', label: 'Stock In/Out' },
    { id: 'challans', label: 'Challans' },
    { id: 'sales-returns', label: 'Sales Return' },
    { id: 'service-centers', label: 'Service Centers Master' },
    { id: 'sc-transfers', label: 'Store → Service Center Transfers' },
    { id: 'sc-stock', label: 'Service Center Stock Levels' },
  ]},
  { group: 'Tickets', items: [
    { id: 'tickets-raise', label: 'Raise a Ticket' },
    { id: 'tickets-mine', label: 'My Tickets' },
    { id: 'tickets-department', label: 'Department Tickets' },
  ]},
  // Not deleted, just parked here (2026-11-16) - these 5 Sales & Marketing
  // pages aren't currently in use. Moving an item back under its original
  // group is a one-line change if any of them come back into use.
  { group: 'Unused', items: [
    { id: 'leads', label: 'Leads / Enquiries' },
    { id: 'pipeline', label: 'Pipeline (Kanban)' },
    { id: 'followups', label: "Today's Follow-ups" },
    { id: 'sales-analytics', label: 'Sales Analytics' },
    { id: 'sales-targets', label: 'Sales Targets' },
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
// Admin-configurable global sidebar group order (2026-10-14) - an array of
// group labels in the order the Admin chose via Company Settings; empty
// (the default) means "use the built-in order" (NAV's alphabetical order,
// dynamic groups after it). Fetched once in boot(); see orderSidebarGroups().
let SIDEBAR_GROUP_ORDER = [];

// Which sidebar groups the user has explicitly EXPANDED, keyed by group
// label - kept in memory only for the current page load (2026-10-14, per
// the owner's explicit ask: every fresh session should start with the whole
// sidebar collapsed again, not carry over a prior visit's expand state via
// localStorage the way this used to). Every group defaults to collapsed (a
// missing/falsy key) unless expanded within this same session. A group
// containing the page currently being opened is still force-expanded (see
// navigate()) even if the user had just collapsed it this session -
// collapsing a group is a "get it out of my way for now" choice, not "hide
// this forever", and navigation still needs to reveal the active item.
let EXPANDED_NAV_GROUPS = {};
function loadExpandedNavGroups() {
  return EXPANDED_NAV_GROUPS;
}
function saveExpandedNavGroups(map) {
  EXPANDED_NAV_GROUPS = map;
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

// Reorders the combined static+dynamic sidebar group list per the Admin's
// saved global order (Company Settings > Sidebar Group Order, 2026-10-14) -
// an empty/unset order (nothing configured yet) leaves the list exactly as
// built (NAV's own alphabetical order, dynamic per-login groups appended
// after it). A group whose label isn't in the saved order (a new NAV group
// added later, or a department not anticipated when the order was last
// saved) keeps its original relative position rather than disappearing or
// jumping somewhere unexpected.
function orderSidebarGroups(groups) {
  const order = SIDEBAR_GROUP_ORDER || [];
  if (!order.length) return groups;
  return groups
    .map((g, i) => { const idx = order.indexOf(g.group); return { g, key: idx === -1 ? order.length + i : idx }; })
    .sort((a, b) => a.key - b.key)
    .map(x => x.g);
}
function renderSidebar() {
  const el = document.getElementById('sidebar');
  el.innerHTML = `<div class="brand"><strong>Venkateshwara Engineers</strong><span>ERP System</span></div>`;
  let groups = [...NAV];
  // These per-user/per-login groups (a department's own Job Cards tab, and
  // Admin/PM's per-department tabs) used to be unconditionally pinned to
  // the very top - since 2026-10-14 they're positioned by the Admin's saved
  // order like any other group (see orderSidebarGroups() above), per the
  // owner's explicit ask; appended here just gives them a stable default
  // position (after every static group) when no order's been configured.
  if (DEPT_OWN_GROUP.items.length) groups.push(DEPT_OWN_GROUP);
  // Each department is its own separate group/tab, in pipeline order,
  // rather than combined into one "Department Job Cards" group.
  if (DEPT_JOBCARDS_GROUPS.length) groups.push(...DEPT_JOBCARDS_GROUPS);
  groups = orderSidebarGroups(groups);
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
      a.className = 'nav-item'; a.id = 'nav-' + it.id;
      const badgeCount = it.id === 'todos' ? TODO_PENDING_COUNT : PAGE_PENDING_COUNTS[it.id];
      a.innerHTML = esc(it.label) + (badgeCount > 0 ? ` <span class="nav-badge">${badgeCount}</span>` : '');
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
  refreshTodoPendingCount();
  refreshPagePendingCounts();
}

// ===================== PAGES =====================
const PAGES = {};

// finance.js - Expenses/Expense Tracker, Bank Guarantees, Foreign Payments, Ledger, FOC, Sales/Purchase
// Invoices, SOA, Operating Expenses, GST Summary.

// ---- Expense Vouchers ----
let EV_LIST_MONTH = null;
PAGES.expenses = async (el) => {
  const listMonth = EV_LIST_MONTH || thisMonth();
  EV_LIST_MONTH = listMonth;
  const canViewAll = has('expense_voucher.view_all');
  const canMarkPaid = has('expense_voucher.approve');
  const vouchers = canViewAll ? await api('/finance/expense-vouchers?month=' + listMonth) : [];
  const depts = await api('/masters/departments');
  const cats = await api('/masters/expense-categories');
  const activeCats = cats.filter(c => c.active);
  const isAdmin = ME && ME.role === 'Admin';
  el.innerHTML = `
    <div class="panel"><h3>New Expense Voucher (Operation Expense)</h3>
      <div class="form-grid">
        <div><label>Department</label><select id="ex-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Category</label><select id="ex-cat">${activeCats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Amount (₹)</label><input id="ex-amount" type="number"></div>
        <div><label>Payment Mode</label><select id="ex-mode"><option>Cash</option><option>Bank</option></select></div>
        <div><label>Accounted Status</label><select id="ex-acc"><option>Accounted</option><option>Cash(Unaccounted)</option></select></div>
        <div><label>Description</label><input id="ex-desc"></div>
        <div><label>Bill / Receipt Attachment</label><input id="ex-file" type="file"></div>
      </div>
      <button class="btn" onclick="addExpense()">Submit Voucher</button>
      ${isAdmin ? `<button class="btn small outline" type="button" onclick="openExCategoryManager()">Manage Categories</button>` : ''}
      <div class="muted">Approval chain: Management, then Accounts (both required, any amount). <a href="#" onclick="navigate('expenses-mine');return false;">My Expense Vouchers</a> shows your own submissions' stage-by-stage status.</div>
    </div>
    ${isAdmin ? collapsiblePanel('expense-oe-map', 'Operating Expense Category Mapping', `
      <div class="muted" style="margin-bottom:8px;">Marking a voucher Paid auto-creates a matching Operating Expense entry - pick which Operating Expense category each Expense Voucher category should land in. A category left unmapped blocks Mark Paid until it's set here.</div>
      <div id="ev-oe-map-wrap">${await exOeMapHTML()}</div>
    `) : ''}
    ${canViewAll ? collapsiblePanel('expense-vouchers-list', `Expense Vouchers - ${listMonth === 'all' ? 'All Time' : listMonth} (${vouchers.length})`, `
      <div class="form-grid">
        <div><label>Month</label><input type="month" id="ex-list-month" value="${listMonth === 'all' ? '' : listMonth}" onchange="EV_LIST_MONTH=this.value;navigate('expenses')"></div>
        <div><button class="btn small outline" type="button" onclick="EV_LIST_MONTH='all';navigate('expenses')">Show All</button></div>
      </div>
      ${tableHTML(['Voucher No', 'Dept', 'Category', 'Amount', 'Mode', 'Accounted', 'Raised By', 'Bill', 'Status', 'Action'], vouchers, v => `
        <tr><td>${esc(v.voucher_no)}</td><td>${esc(v.department_name)}</td><td>${esc(v.category_name)}</td><td>₹${fmt(v.amount)}</td><td>${esc(v.payment_mode)}</td><td>${esc(v.accounted)}</td><td>${esc(v.raised_by_name)}</td>
        <td>${v.attachment_path ? `<a href="${v.attachment_path}" target="_blank">View</a>` : '-'}</td><td>${badge(v.status)}</td>
        <td>${actionButtonsCell(`
          ${v.status === 'Approved' && canMarkPaid ? `<button class="btn small green" onclick="payExpense(${v.id})">Mark Paid</button>` : ''}
          <button class="btn small outline" type="button" onclick="showExpenseVoucherHistory(${v.approval_id || 'null'}, 'Approval History - ${esc(v.voucher_no)}')">History</button>
        `)}</td></tr>`)}
    `) : `<div class="panel"><div class="muted">The company-wide Expense Vouchers list and approval history are visible only to Accounts/Management/Admin. See <a href="#" onclick="navigate('expenses-mine');return false;">My Expense Vouchers</a> for your own submissions.</div></div>`}`;
};
// Admin-only Expense Voucher category -> Operating Expense category mapping
// table (2026-10-12) - every expense category gets a row with a dropdown
// defaulting to its currently-mapped Operating Expense category (or blank if
// never mapped), saved individually per row.
async function exOeMapHTML() {
  const [map, oeCats] = await Promise.all([
    api('/finance/expense-vouchers/category-oe-map'),
    api('/finance/operating-expense-categories'),
  ]);
  return tableHTML(['Expense Voucher Category', 'Mapped Operating Expense Category', ''], map, m => `
    <tr><td>${esc(m.expense_category_name)}</td>
    <td><select id="ev-oe-map-${m.expense_category_id}">
      <option value="">- not mapped -</option>
      ${oeCats.map(oc => `<option value="${oc.id}" ${oc.id === m.operating_expense_category_id ? 'selected' : ''}>${esc(oc.name)}</option>`).join('')}
    </select></td>
    <td><button class="btn small" type="button" onclick="saveExOeMap(${m.expense_category_id})">Save</button></td></tr>`);
}
window.saveExOeMap = async (expenseCategoryId) => {
  try {
    const operating_expense_category_id = val(`ev-oe-map-${expenseCategoryId}`);
    await api(`/finance/expense-vouchers/category-oe-map/${expenseCategoryId}`, { method: 'PUT', body: JSON.stringify({ operating_expense_category_id }) });
    document.getElementById('ev-oe-map-wrap').innerHTML = await exOeMapHTML();
  } catch (e) { alert(e.message); }
};
// Stage-history popup, shared between the Admin Expense Vouchers list and
// "My Expense Vouchers" - step_order 1/2 map to the current ExpenseVoucher
// chain's two fixed stages (Management, then Accounts; see db/index.js's
// one-time chain migration). A voucher with no approval_id at all (shouldn't
// happen in practice - every voucher starts an approval at creation - but
// guarded defensively) shows a plain message instead of erroring.
window.showExpenseVoucherHistory = async (approvalId, title) => {
  if (!approvalId) { openAppModal(title || 'Approval History', '<div class="muted">No approval history on file for this voucher.</div>'); return; }
  const actions = await api(`/approvals/${approvalId}/history`);
  const stepLabel = (s) => s === 1 ? 'Management' : s === 2 ? 'Accounts' : `Step ${s}`;
  const body = actions.length
    ? tableHTML(['Stage', 'Action', 'By', 'When', 'Comment'], actions, a => `
        <tr><td>${esc(stepLabel(a.step_order))}</td><td>${badge(a.action)}</td><td>${esc(a.actor_name || '-')}</td>
        <td>${a.acted_at ? esc(a.acted_at) : '-'}</td><td>${esc(a.comment || '-')}</td></tr>`)
    : '<div class="muted">No action recorded yet - still awaiting the first approver (Management).</div>';
  openAppModal(title || 'Approval History', body);
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
  const payment_reference = prompt('Payment reference (UTR / cheque no. / transaction id):');
  if (payment_reference === null) return;
  if (!payment_reference.trim()) { alert('A payment reference is required to mark this voucher Paid.'); return; }
  try {
    await api(`/finance/expense-vouchers/${id}/mark-paid`, { method: 'POST', body: JSON.stringify({ payment_reference }) });
    navigate(CURRENT_PAGE === 'expenses-mine' ? 'expenses-mine' : 'expenses');
  } catch (e) { alert(e.message); }
};

// ---- My Expense Vouchers (2026-10-12, requested directly by the owner) ----
// Submitter-facing status view: a logged-in user's own vouchers with full
// per-stage approval history, plus - if they're a supervisor - a second,
// collapsed-by-default section showing every voucher raised against their
// own department (or any department they hold oversight of), per
// GET /finance/expense-vouchers/mine's {own, department} shape.
PAGES['expenses-mine'] = async (el) => {
  const { own, department } = await api('/finance/expense-vouchers/mine');
  const canMarkPaid = has('expense_voucher.approve');
  const rowHTML = (v) => `
    <tr><td>${esc(v.voucher_no)}</td><td>${esc(v.department_name)}</td><td>${esc(v.category_name)}</td><td>₹${fmt(v.amount)}</td>
    <td>${esc(v.raised_by_name)}</td><td>${badge(v.status)}</td>
    <td>${v.status === 'Paid' ? `${esc(v.payment_reference || '-')}${v.paid_at ? ' (' + esc(v.paid_at) + ')' : ''}` : '-'}</td>
    <td>${actionButtonsCell(`
      ${canMarkPaid && v.status === 'Approved' ? `<button class="btn small green" onclick="payExpense(${v.id})">Mark Paid</button>` : ''}
      <button class="btn small outline" type="button" onclick="showExpenseVoucherHistory(${v.approval_id || 'null'}, 'Approval History - ${esc(v.voucher_no)}')">History</button>
    `)}</td></tr>`;
  el.innerHTML = `
    <div class="panel"><h3>My Expense Vouchers (${own.length})</h3>
      <div class="muted">Status at each stage of your own submitted vouchers - Management approval, then Accounts approval, then Mark Paid with a payment reference.</div>
      ${tableHTML(['Voucher No', 'Dept', 'Category', 'Amount', 'Raised By', 'Status', 'Paid Ref / Date', 'Action'], own, rowHTML)}
    </div>
    ${ME && ME.is_supervisor ? collapsiblePanel('expenses-mine-department', `My Department's Expense Vouchers (${department.length})`, `
      <div class="muted">Every voucher raised against your own department (or any department you've been granted oversight of), submitted by anyone.</div>
      ${tableHTML(['Voucher No', 'Dept', 'Category', 'Amount', 'Raised By', 'Status', 'Paid Ref / Date', 'Action'], department, rowHTML)}
    `) : ''}`;
};

// ---- Admin: manage the New Expense Voucher category dropdown list ----
// Same add/rename/deactivate pattern as openOeCategoryManager() (Operating
// Expenses) - own element ids (ec-) since both managers can be open in
// different pages in the same session.
window.openExCategoryManager = async () => {
  const categories = await api('/masters/expense-categories');
  const body = `
    <div class="form-grid">
      <div><label>New Category Name</label><input id="ec-name"></div>
      <div><label>Sort Order</label><input id="ec-sort" type="number" value="${categories.length}"></div>
    </div>
    <button class="btn small" type="button" onclick="addExCategory()">Add Category</button>
    <div id="ec-err" class="msg err" style="display:none;"></div>
    <div id="ec-list-wrap">${exCategoryListHTML(categories)}</div>`;
  openMiniModal('Manage Expense Voucher Categories', body, true);
};
function exCategoryListHTML(categories) {
  return tableHTML(['Name', 'Sort', 'Active', ''], categories, c => `
    <tr><td>${esc(c.name)}</td><td>${c.sort_order}</td><td>${c.active ? 'Yes' : 'No'}</td>
    <td><button class="btn small outline" type="button" onclick="toggleExCategory(${c.id}, ${c.active ? 0 : 1})">${c.active ? 'Deactivate' : 'Activate'}</button></td></tr>`);
}
window.addExCategory = async () => {
  const errEl = document.getElementById('ec-err'); errEl.style.display = 'none';
  try {
    await api('/masters/expense-categories', { method: 'POST', body: JSON.stringify({ name: val('ec-name'), sort_order: val('ec-sort') }) });
    const categories = await api('/masters/expense-categories');
    document.getElementById('ec-list-wrap').innerHTML = exCategoryListHTML(categories);
    document.getElementById('ec-name').value = '';
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.toggleExCategory = async (id, active) => {
  await api('/masters/expense-categories/' + id, { method: 'PUT', body: JSON.stringify({ active }) });
  const categories = await api('/masters/expense-categories');
  document.getElementById('ec-list-wrap').innerHTML = exCategoryListHTML(categories);
};

/* ============ RETIRED: Expense Tracker module (folded into Operating Expenses) ============
   Backend routes (/api/expense-tracker) and DB tables left intact; restore by uncommenting
   these blocks and re-adding the 3 NAV sidebar entries.
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
*/

/* ============ RETIRED: Expense Tracker Year Summary ============
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
*/

/* ============ RETIRED: Expense Tracker Categories ============
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
*/

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
        <td>${actionButtonsCell(`
          ${r.status === 'PendingReview' ? `<button class="btn small" onclick="verifyBGReminder(${r.id})">Verify</button>` : ''}
          ${r.status === 'Verified' ? `<button class="btn small green" onclick="sendBGReminderEmail(${r.id})">Send Reminder Email</button>` : ''}
          <button class="btn small outline" onclick="dismissBGReminder(${r.id})">Dismiss</button>
        `)}</td></tr>`)}
    `)}` : ''}

    ${pendingChanges.length ? `<div class="panel"><h3>Pending BG Changes (${pendingChanges.length})</h3>
      <p class="muted">An edit or delete requested by a non-Admin doesn't take effect until an Admin approves it here, so nothing changes underneath a reminder or claim-filing workflow already in flight. Every field is shown current vs. proposed - changed ones are bolded - plus the BG's own order/status context, so there's no need to leave this queue to judge the request.</p>
      ${pendingChanges.map(c => renderBGPendingChangeCard(c)).join('')}
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
      <div><label>Release Condition / Milestone Link</label><textarea id="bg-milestone" rows="2" placeholder="e.g. release on final acceptance / installation completion"></textarea></div>
      <button class="btn" onclick="addBG()">Add Bank Guarantee</button>
    </div>

    ${collapsiblePanel('bg-list', `List of Bank Guarantees (${bgs.length})`, `
      <div class="form-grid">
        <div style="grid-column:1/-1;">
          <div class="tabs" id="bg-tabs">
            <div class="tab active" onclick="filterBGTab(this,'')">All</div>
            <div class="tab" onclick="filterBGTab(this,'Advance')">Advance</div>
            <div class="tab" onclick="filterBGTab(this,'Performance')">Performance</div>
            <div class="tab" onclick="filterBGTab(this,'PendingRelease')">Pending Release</div>
          </div>
        </div>
        <div><label><input type="checkbox" id="bg-show-released" ${showReleased ? 'checked' : ''} onchange="toggleBGShowReleased(this.checked)"> Show Released</label></div>
        <div><button class="btn small outline" type="button" onclick="openBGColumnPicker()">Customize Columns</button></div>
        ${ME.role === 'Admin' ? `<div><button class="btn small outline" type="button" onclick="exportBGAttachments()" title="Downloads a small .tar.gz of every BG scanned-document row and file - for migrating BG attachments to another server without a full DB backup.">Export BG Attachments</button></div>` : ''}
      </div>
      ${!showReleased ? `<p class="muted">Showing live Bank Guarantees only (Active / Pending Release). Check "Show Released" above to include closed ones.</p>` : ''}
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
    <td>${actionButtonsCell(`
      ${bg.status !== 'Released' ? `<button class="btn small outline" onclick="releaseBG(${bg.id})">Mark Released</button>` : ''}
      ${bg.status !== 'Released' ? `<button class="btn small outline" onclick="openEditBG(${bg.id})">Edit</button>` : ''}
      <button class="btn small outline" onclick="deleteBG(${bg.id})">Delete</button>
    `)}</td></tr>
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
// Current-vs-proposed table (changed fields bolded) + order/project context,
// replacing a one-line "field: value, ..." dump of every editable field
// regardless of whether it actually changed.
const BG_FIELD_LABELS = { bg_no: 'BG No', issuing_bank: 'Issuing Bank', value: 'Value (₹)', issue_date: 'Issue Date', validity_expiry: 'Validity Expiry', claim_expiry: 'Claim Expiry', milestone_link: 'Release Condition / Milestone Link' };
function renderBGPendingChangeCard(c) {
  const proposed = c.change_type === 'Edit' ? JSON.parse(c.proposed_fields || '{}') : {};
  const compareRows = Object.keys(proposed).map(k => {
    const oldVal = c[k] ?? '-';
    const newVal = proposed[k] ?? '-';
    const changed = String(c[k] ?? '') !== String(proposed[k] ?? '');
    return `<tr><td>${esc(BG_FIELD_LABELS[k] || k)}</td><td>${esc(oldVal)}</td><td>${changed ? `<b>${esc(newVal)}</b>` : esc(newVal)}</td></tr>`;
  }).join('');
  return `<div class="panel" style="margin-bottom:10px;background:#fafbfc;">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center;">
      <div><b>${esc(c.bg_no || '#' + c.bg_id)}</b> ${badge(c.change_type)} <span class="muted">(currently ${esc(c.status)})</span></div>
      <div class="muted">Requested by ${esc(c.requested_by_name) || '-'}${c.requested_at ? ' on ' + new Date(c.requested_at).toLocaleString() : ''}</div>
    </div>
    <div class="muted" style="margin-top:4px;font-size:12px;">
      ${c.order_label ? `Order: ${esc(c.order_label)}${c.order_type && c.order_type !== 'LEGACY' ? ` (${esc(c.order_type)}-${c.order_id})` : ''} &middot; ` : ''}
      ${c.project_code ? `Project: ${esc(c.project_code)} &middot; ` : ''}
      Type: ${esc(c.bg_type)} &middot; Value on file: ₹${fmt(c.value)}
    </div>
    ${c.change_type === 'Edit' ? `
      <table style="width:100%;font-size:13px;margin-top:8px;"><thead><tr><th style="text-align:left;">Field</th><th style="text-align:left;">Current</th><th style="text-align:left;">Proposed</th></tr></thead><tbody>${compareRows}</tbody></table>
    ` : `<p class="msg err" style="margin-top:8px;">Requesting to delete this Bank Guarantee entirely - this cannot be undone once approved.</p>`}
    <div style="margin-top:8px;">
      <button class="btn small outline" type="button" onclick="togglePendingBGAttachments(${c.change_id}, ${c.bg_id})">Scanned Copy</button>
      ${ME.role === 'Admin' ? `<button class="btn small" type="button" onclick="approveBGChange(${c.change_id})">Approve</button>
        <button class="btn small outline" type="button" onclick="rejectBGChange(${c.change_id})">Reject</button>` : '<span class="muted">Awaiting Admin</span>'}
    </div>
    <div id="bg-pc-att-row-${c.change_id}" style="display:none;margin-top:8px;"><div id="bg-pc-attachments-${c.change_id}"></div></div>
  </div>`;
}
window.togglePendingBGAttachments = (changeId, bgId) => {
  const row = document.getElementById(`bg-pc-att-row-${changeId}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing) renderAttachmentsWidget('bank_guarantee', bgId, document.getElementById(`bg-pc-attachments-${changeId}`));
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
      <div>
        <button class="btn" type="button" onclick="createForeignPayment()">Save as Draft</button>
        <div id="fp-new-err" class="msg err" style="display:none;"></div>
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
    <div class="form-grid">
      ${editable ? `<div><button class="btn green" type="button" onclick="saveForeignPaymentEdit(${r.id})">Save Changes</button></div>` : ''}
      <div style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;">${actionButtons.join('')}</div>
    </div>
    <div id="fp-detail-err-${r.id}" class="msg err" style="display:none;"></div>`;
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
    <div id="fp-pay-err-${id}" class="msg err" style="display:none;"></div>`;
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

// ---- FOC (Free of Cost) Material Issue ----
// Department HOD/Supervisor logins raise these (linked to a sales order
// wherever possible); Management/Admin approve or reject them. A request is
// stored as one foc_requests row per line item, several rows sharing one
// foc_no for a multi-item request (2026-10-13) - same "several rows, one
// shared document number" shape multi-line Purchase Orders already use for
// po_no. Approve/Reject/Issue act on the whole foc_no group at once; all
// fields stay editable per-line while the group is still Pending.
let FOC_LINES = [];
const FOC_LINES_GRID_COLS = 'minmax(240px,2fr) 90px 90px 130px 44px';
function renderFocLines() {
  const el = document.getElementById('foc-lines');
  if (!el) return;
  el.innerHTML = gridLineTableHTML(FOC_LINES_GRID_COLS, ['Material / Item Description', 'Quantity', 'Unit', 'Estimated Value (₹)', ''], FOC_LINES, (l, i) => `
      <div><input value="${esc(l.item_description||'')}" placeholder="e.g. M8 hex bolts, 2 boxes" onchange="FOC_LINES[${i}].item_description=this.value"></div>
      <div><input type="number" value="${l.quantity}" onchange="FOC_LINES[${i}].quantity=Number(this.value)"></div>
      <div><input value="${esc(l.unit||'Nos')}" onchange="FOC_LINES[${i}].unit=this.value"></div>
      <div><input type="number" value="${l.estimated_value}" onchange="FOC_LINES[${i}].estimated_value=Number(this.value)"></div>
      <div>${FOC_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="FOC_LINES.splice(${i},1);renderFocLines()">✕</button>` : ''}</div>`);
}
window.addFocLine = () => { FOC_LINES.push({ item_description: '', quantity: 1, unit: 'Nos', estimated_value: 0 }); renderFocLines(); };
PAGES.foc = async (el) => {
  const [reqs, orders, clients, departments] = await Promise.all([api('/finance/foc'), api('/sales/orders'), api('/masters/clients'), api('/masters/departments')]);
  const canRequest = has('foc.request') && (ME.is_supervisor || ME.role === 'Admin');
  const canApprove = has('foc.approve');
  window.FOC_DEPARTMENTS = departments;
  FOC_LINES = [{ item_description: '', quantity: 1, unit: 'Nos', estimated_value: 0 }];
  // Group the flat row list by foc_no - a single-item request (the common
  // case) renders exactly like before; a multi-item one collapses its line
  // rows by default (per this file's own standing collapse-by-default rule
  // for multi-item/repeating list UI), same look as a multi-line Purchase
  // Order's own group row.
  const groups = [];
  const byFocNo = new Map();
  reqs.forEach(r => {
    if (!byFocNo.has(r.foc_no)) { const g = []; byFocNo.set(r.foc_no, g); groups.push(g); }
    byFocNo.get(r.foc_no).push(r);
  });
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
      <h4>Material Line Items</h4>
      <div id="foc-lines"></div>
      <button class="btn small outline" type="button" onclick="addFocLine()">+ Add Line Item</button>
      <div class="form-grid">
        <div><label>Reason</label><input id="foc-reason" placeholder="Why this needs to go out free of cost"></div>
      </div>
      <button class="btn" onclick="addFOC()">Submit Request</button>
      <div class="muted">Approval: Management/Admin, for the whole request (all items) at once. Attach supporting documents per item after submitting.</div>
    </div>` : ''}
    ${collapsiblePanel('foc-requests-list', `FOC Requests (${groups.length})`, `
      ${tableHTML(['FOC No', 'Order', 'Customer', 'Requesting Dept', 'Item(s)', 'Value', 'Requested By', 'Fulfilling Dept', 'Status', 'Action'], groups, lines => focGroupRowHTML(lines, canApprove))}
    `)}`;
  renderFocLines();
};
function focGroupRowHTML(lines, canApprove) {
  const r = lines[0];
  const totalValue = lines.reduce((s, l) => s + (l.estimated_value || 0), 0);
  const itemsCell = lines.length === 1
    ? `${focEditableCell(r, 'item_description')} (${focEditableCell(r, 'quantity')} ${esc(r.unit)})`
    : `<a href="#" onclick="toggleFocGroup('${esc(r.foc_no)}');return false;">${lines.length} items</a>`;
  const groupRow = `
    <tr><td>${esc(r.foc_no)}</td><td>${esc(r.order_no)||'-'}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${esc(r.department_name)||'-'}</td>
    <td>${itemsCell}</td><td>₹${fmt(totalValue)}</td>
    <td>${esc(r.requested_by_name)}</td><td>${esc(r.fulfilling_department_name)||'-'}</td><td>${badge(r.status)}</td>
    <td>${actionButtonsCell(`${focActions(r, canApprove)}
      ${lines.length === 1 ? `<button class="btn small outline" type="button" onclick="toggleFOCAttachments(${r.id})">Attachments</button>` : ''}
      ${r.status === 'Approved' || r.status === 'Issued' ? `<button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/foc/${r.id}/pdf', '${esc(r.foc_no)}-Annexure.pdf')">Print Annexure</button>` : ''}`)}</td></tr>
    ${lines.length === 1 ? `<tr id="foc-att-row-${r.id}" style="display:none;"><td colspan="10"><div id="foc-attachments-${r.id}"></div></td></tr>` : ''}`;
  if (lines.length === 1) return groupRow;
  // Collapsed by default - each line gets its own editable cells and
  // Attachments toggle, same as a single-item request would have, plus an
  // Add Line Item mini-form while the group is still Pending.
  const detailRows = lines.map(l => `
    <tr class="foc-group-row-${esc(r.foc_no)}" style="display:none;">
      <td></td><td colspan="3">${focEditableCell(l, 'item_description')}</td>
      <td>${focEditableCell(l, 'quantity')} ${esc(l.unit)} - ₹${fmt(l.estimated_value)}</td>
      <td colspan="3"></td><td><button class="btn small outline" type="button" onclick="toggleFOCAttachments(${l.id})">Attachments</button></td></tr>
    <tr class="foc-group-row-${esc(r.foc_no)}" id="foc-att-row-${l.id}" style="display:none;"><td colspan="10"><div id="foc-attachments-${l.id}"></div></td></tr>`).join('');
  const addLineForm = r.status === 'Pending' ? `
    <tr class="foc-group-row-${esc(r.foc_no)}" style="display:none;"><td colspan="10">
      <div class="form-grid">
        <div><label>New Item</label><input id="foc-newline-desc-${r.id}" placeholder="Material / item description"></div>
        <div><label>Qty</label><input id="foc-newline-qty-${r.id}" type="number" value="1"></div>
        <div><label>Unit</label><input id="foc-newline-unit-${r.id}" value="Nos"></div>
        <div><label>Est. Value (₹)</label><input id="foc-newline-value-${r.id}" type="number" value="0"></div>
      </div>
      <button class="btn small outline" type="button" onclick="addFocGroupLine(${r.id})">+ Add Line Item</button>
    </td></tr>` : '';
  return groupRow + detailRows + addLineForm;
}
window.toggleFocGroup = (focNo) => {
  document.querySelectorAll(`.foc-group-row-${CSS.escape(focNo)}`).forEach(row => {
    row.style.display = row.style.display === 'none' ? '' : 'none';
  });
};
window.addFocGroupLine = async (id) => {
  try {
    await api(`/finance/foc/${id}/add-line`, { method: 'POST', body: JSON.stringify({
      item_description: val(`foc-newline-desc-${id}`), quantity: val(`foc-newline-qty-${id}`),
      unit: val(`foc-newline-unit-${id}`), estimated_value: val(`foc-newline-value-${id}`),
    })});
    navigate('foc');
  } catch (e) { alert(e.message); }
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
    // part of the decision, not as a separate step afterward. Acts on the
    // whole foc_no group (routes/finance.js resolves it server-side from
    // this one representative row's id).
    const deptOptions = (window.FOC_DEPARTMENTS || []).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    return `
      <select id="foc-dept-${r.id}" style="margin-bottom:4px;" onchange="document.getElementById('foc-approve-${r.id}').disabled = !this.value; document.getElementById('foc-reject-${r.id}').disabled = !this.value;">
        <option value="">-- Route to department --</option>${deptOptions}
      </select>
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
    const lines = FOC_LINES.filter(l => l.item_description && l.item_description.trim());
    if (!lines.length) { alert('Add at least one line item.'); return; }
    await api('/finance/foc', { method: 'POST', body: JSON.stringify({
      sales_order_id: val('foc-so') || null,
      client_id: val('foc-client') || null, customer_name: val('foc-cust-name'),
      contact_person: val('foc-contact-person'), contact_phone: val('foc-contact-phone'),
      reason: val('foc-reason'), lines,
    })});
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

// ===================== Round 5: Sales Invoices =====================
PAGES['sales-invoices'] = async (el) => {
  const [invoices, orders, proformas] = await Promise.all([api('/finance/invoices'), api('/sales/orders').catch(() => api('/sales')), api('/finance/proforma-invoices')]);
  window.__INV_ORDERS = orders || [];
  el.innerHTML = `
    <div class="panel"><h3>Generate Invoice from Sales Order</h3>
      <div class="form-grid">
        <div><label>Sales Order</label>${salesOrderPickerHTML('inv-so', window.__INV_ORDERS, null, 'onchange="invoiceSOChanged()"')}</div>
        <div><label>Buyer State</label><input id="inv-buyer-state" placeholder="e.g. Haryana"></div>
        <div><label>Buyer GSTIN</label><input id="inv-buyer-gstin"></div>
        <div><label>Item Description</label><input id="inv-desc" placeholder="Defaults to order description"></div>
        <div><label>HSN/SAC</label><input id="inv-hsn"></div>
        <div><label>Qty</label><input id="inv-qty" type="number" value="1"></div>
        <div><label>Rate (₹)</label><input id="inv-rate" type="number"></div>
        <div><label>GST Rate (%)</label><input id="inv-gst-rate" type="number" value="18"></div>
      </div>
      <div class="form-grid" style="margin-top:8px;">
        <div><label>Client Name</label><input id="inv-buyer-name" placeholder="Defaults from client master"></div>
        <div><label>Contact Person</label><input id="inv-buyer-contact"></div>
        <div><label>Address</label><input id="inv-buyer-address"></div>
        <div><label>Phone Number</label><input id="inv-buyer-phone"></div>
      </div>
      <button class="btn" onclick="generateInvoice()">Generate Invoice</button>
      <div id="inv-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    ${collapsiblePanel('sales-invoices-list', `Invoices (${invoices.length})`, `
      ${tableHTML(['Invoice No', 'Client', 'Date', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Status', ''], invoices, i => `
        <tr><td>${esc(i.invoice_no)}</td><td>${esc(i.client_name)}</td><td>${new Date(i.invoice_date).toLocaleDateString()}</td>
        <td>₹${fmt(i.taxable_value)}</td><td>₹${fmt(i.cgst)}</td><td>₹${fmt(i.sgst)}</td><td>₹${fmt(i.igst)}</td><td>₹${fmt(i.total_value)}</td><td>${badge(i.status)}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/invoices/${i.id}/pdf', '${esc(i.invoice_no).replace(/\//g,'-')}.pdf')">PDF</button>
          <button class="btn small outline" type="button" onclick="emailInvoice(${i.id})">Email to Client</button>
          ${i.status !== 'Paid' ? `<button class="btn small" type="button" onclick="markInvoicePaid(${i.id})">Mark Paid</button>` : ''}
          ${i.status === 'Draft' ? `<button class="btn small outline" type="button" onclick="cancelInvoice(${i.id})">Cancel</button>` : ''}
        `)}</td></tr>`)}
    `)}
    <div class="panel"><h3>Generate Proforma Invoice (Advance / Pre-Dispatch)</h3>
      <p class="muted">Not a tax invoice - a payment request document for an advance or pre-dispatch payment term.</p>
      <div class="form-grid">
        <div><label>Sales Order</label>${salesOrderPickerHTML('pf-so', window.__INV_ORDERS, null, 'onchange="pfSOChanged()"')}</div>
        <div><label>Type</label><select id="pf-type" onchange="pfPrefillAmountFromPercent()"><option value="Advance">Advance</option><option value="PreDispatch">Payment Before Dispatch</option></select></div>
        <div><label>Payment Milestone (optional)</label><select id="pf-milestone" onchange="pfPrefillAmountFromPercent()"><option value="">-- None / manual amount --</option></select></div>
        <div><label>Buyer State</label><input id="pf-buyer-state" placeholder="e.g. Haryana"></div>
        <div><label>Buyer GSTIN</label><input id="pf-buyer-gstin"></div>
      </div>
      <h4>Order Line Items <span class="muted">(tick the lines to invoice - quantity/unit/rate are pulled from the order, GST % is editable per line. Leave all unticked to use the plain Amount field below instead.)</span></h4>
      <div id="pf-lines"></div>
      <div class="form-grid" style="margin-top:8px;">
        <div><label>Amount (₹, if no milestone and no lines ticked above)</label><input id="pf-amount" type="number"></div>
        <div><label>Item Description</label><input id="pf-desc" placeholder="Defaults to order description (ignored if a milestone is picked or lines are ticked)"></div>
        ${proformaChargeFieldHTML('pf-pf', 'Packing & Forwarding', '', '')}
        ${proformaChargeFieldHTML('pf-cc', 'Courier Charges', '', '')}
        ${proformaChargeFieldHTML('pf-ins', 'Insurance', '', '')}
        <div><label>Advance Received (₹)</label><input id="pf-advance" type="number" placeholder="Deducted from the total payable"></div>
      </div>
      <p class="muted" style="margin-top:4px;">Ship To and Payment Terms are picked up automatically from the client's Shipping address and the order's own Payment Terms (Sales Orders → Commercial Terms) and printed on the document.</p>
      <button class="btn" onclick="generateProforma()">Generate Proforma Invoice</button>
      <div id="pf-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    ${collapsiblePanel('proforma-invoices-list', `Proforma Invoices (${proformas.length})`, `
      ${tableHTML(['Proforma No', 'Client', 'Order', 'Type', 'Milestone', 'Total', 'Status', ''], proformas, p => `
        <tr><td>${esc(p.proforma_no)}</td><td>${esc(p.client_name)}</td><td>${esc(p.order_no)}</td><td>${p.invoice_type === 'Advance' ? 'Advance' : 'Pre-Dispatch'}</td>
        <td>${esc(p.milestone_name)||'-'}</td><td>₹${fmt(p.total_value)}</td><td>${badge(p.status)}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/proforma-invoices/${p.id}/pdf', '${esc(p.proforma_no).replace(/\//g,'-')}.pdf')">PDF</button>
          <button class="btn small outline" type="button" onclick="emailProforma(${p.id})">Email to Client</button>
          ${p.status === 'Draft' ? `<button class="btn small outline" type="button" onclick="openEditProforma(${p.id})">Edit</button>
          <button class="btn small" type="button" onclick="markProformaReceived(${p.id})">Mark Received</button>
          <button class="btn small outline" type="button" onclick="cancelProforma(${p.id})">Cancel</button>` : ''}
        `)}</td></tr>`)}
    `)}`;
  invoiceSOChanged();
  pfSOChanged();
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
// Proforma line-item picker (2026-10-29) - lets Finance tick specific
// sales_order_items lines to invoice instead of always falling into the
// backend's single-aggregate-amount default (which hardcoded quantity to
// 1 regardless of the order's own real quantity). Each ticked line's own
// qty/unit/rate come straight from the order; GST % is editable per line
// right here, since the order's own gst_rate is just a starting default,
// not necessarily what Finance wants to bill this specific payment request
// at. Unlike Purchase Invoice vs GRN, there's no "already proforma'd"
// quantity gate - a Proforma is a payment-request document, not a
// billing-against-receipt one, so every line is always offered.
let PF_LINES = [];
window.loadPFLines = async () => {
  const wrap = document.getElementById('pf-lines');
  if (!wrap) return;
  const soId = val('pf-so');
  PF_LINES = [];
  if (!soId) { wrap.innerHTML = '<p class="muted">Pick a Sales Order first.</p>'; return; }
  try {
    const items = await api(`/sales/orders/${soId}/items`);
    PF_LINES = items.map(it => pfWithOriginals(it));
  } catch (e) { PF_LINES = []; }
  pfApplyDefaultSelection();
};
// Editable line picker shared by create and Edit. Description/Qty/Rate default to the order's own
// values (o_* keep the originals, shown as a hint once changed); edits apply to the proforma only.
function pfLinesHTML(lines, arr, rerender) {
  const hint = (l, k) => String(l[k]) !== String(l['o_' + k]) ? `<div class="muted" style="font-size:11px;">orig: ${esc(String(l['o_' + k]))}</div>` : '';
  return gridLineTableHTML('36px minmax(220px,2fr) 90px 90px 110px 100px', ['', 'Description', 'Qty', 'Unit', 'Rate (₹)', 'GST %'], lines, (l, i) => `
      <div><input type="checkbox" ${l.selected ? 'checked' : ''} onchange="${arr}[${i}].selected=this.checked"></div>
      <div><input value="${esc(l.description)}" style="width:100%;" onchange="${arr}[${i}].description=this.value;${rerender}()">${hint(l, 'description')}</div>
      <div><input type="number" min="0" step="any" value="${l.quantity}" style="width:80px;" onchange="${arr}[${i}].quantity=Number(this.value);${rerender}()">${hint(l, 'quantity')}</div>
      <div>${esc(l.unit || 'Nos')}</div>
      <div><input type="number" min="0" step="any" value="${l.rate}" style="width:100px;" onchange="${arr}[${i}].rate=Number(this.value);${rerender}()">${hint(l, 'rate')}</div>
      <div><input type="number" value="${l.gst_rate_override}" onchange="${arr}[${i}].gst_rate_override=Number(this.value)" style="width:70px;"></div>`);
}
const pfWithOriginals = (it, over = {}) => ({ ...it, o_description: it.description, o_quantity: it.quantity, o_rate: it.rate, gst_rate_override: it.gst_rate, ...over });
function renderPFLines() {
  const wrap = document.getElementById('pf-lines');
  if (!wrap) return;
  if (!PF_LINES.length) { wrap.innerHTML = '<p class="muted">This order has no line items on file - use the Amount field below instead.</p>'; return; }
  wrap.innerHTML = pfLinesHTML(PF_LINES, 'PF_LINES', 'renderPFLines');
}
// Default = bill the order's real lines. When a milestone or the order's Advance %/Payment Before
// Dispatch % (commercial terms) drives the amount, lines start unticked so that amount is used.
function pfApplyDefaultSelection() {
  const o = (window.__INV_ORDERS || []).find(x => x.id === Number(val('pf-so')));
  const pct = o ? (val('pf-type') === 'Advance' ? Number(o.advance_percent) : Number(o.predispatch_percent)) || 0 : 0;
  const driven = !!val('pf-milestone') || pct > 0;
  PF_LINES.forEach(l => { l.selected = !driven; });
  renderPFLines();
}
window.generateProforma = async () => {
  const errEl = document.getElementById('pf-err'); errEl.style.display = 'none';
  const soId = val('pf-so');
  if (!soId) { errEl.textContent = 'Pick a sales order.'; errEl.style.display = 'block'; return; }
  const selectedLines = PF_LINES.filter(l => l.selected);
  try {
    const r = await api(`/finance/proforma-invoices/from-sales-order/${soId}`, { method: 'POST', body: JSON.stringify({
      invoice_type: val('pf-type'), milestone_id: val('pf-milestone') || null,
      amount: selectedLines.length ? undefined : (val('pf-amount') || undefined),
      description: val('pf-desc'),
      items: selectedLines.length ? selectedLines.map(l => ({
        description: l.description, quantity: l.quantity, unit: l.unit, rate: l.rate,
        gst_rate: l.gst_rate_override, sales_order_item_id: l.id,
      })) : undefined,
      buyer_state: val('pf-buyer-state'), buyer_gstin: val('pf-buyer-gstin'),
      ...proformaChargePayload('pf-pf', 'packing_forwarding_percent', 'packing_forwarding_amount'),
      ...proformaChargePayload('pf-cc', 'courier_charges_percent', 'courier_charges_amount'),
      ...proformaChargePayload('pf-ins', 'insurance_percent', 'insurance_amount'),
      advance_received: val('pf-advance') || undefined,
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
// Edit a Draft proforma (2026-11-03) - same popup-modal pattern every other
// Edit action in this app already uses (openAppModal()), with the identical
// field set the create form itself captures: Type/Milestone/Buyer State &
// GSTIN/line items (tick-lines-or-flat-amount, same shape as create)/Packing
// & Forwarding/Courier Charges/Advance Received. Draft-only - PUT itself
// re-enforces this, this is just the UI-level gate (no Edit button renders
// for a non-Draft row at all).
let PFE_LINES = [];
window.openEditProforma = async (id) => {
  const data = await api(`/finance/proforma-invoices/${id}`);
  const pf = data.proforma;
  const items = data.items || [];
  const [ms, soItems] = await Promise.all([
    api(`/bg/milestones?order_type=SO&order_id=${pf.sales_order_id}`).catch(() => []),
    api(`/sales/orders/${pf.sales_order_id}/items`).catch(() => []),
  ]);
  const linkedIds = new Set(items.filter(it => it.sales_order_item_id).map(it => it.sales_order_item_id));
  PFE_LINES = soItems.map(it => {
    const pfItem = items.find(x => x.sales_order_item_id === it.id);
    return pfWithOriginals(it, pfItem
      ? { selected: true, description: pfItem.description, quantity: pfItem.quantity, rate: pfItem.rate, gst_rate_override: pfItem.gst_rate }
      : { selected: false });
  });
  const manualItem = (!linkedIds.size && items.length === 1) ? items[0] : null;
  openAppModal(`Edit Proforma — ${esc(pf.proforma_no)}`, `
    <div class="form-grid">
      <div><label>Type</label><select id="pfe-type" onchange="pfePrefillAmountFromPercent(${pf.sales_order_id})"><option value="Advance" ${pf.invoice_type === 'Advance' ? 'selected' : ''}>Advance</option><option value="PreDispatch" ${pf.invoice_type === 'PreDispatch' ? 'selected' : ''}>Payment Before Dispatch</option></select></div>
      <div><label>Payment Milestone (optional)</label><select id="pfe-milestone"><option value="">-- None / manual amount --</option>${ms.map(m => `<option value="${m.id}" ${pf.milestone_id === m.id ? 'selected' : ''}>${esc(m.milestone_name)} (${m.percentage ? m.percentage + '%' : '₹' + fmt(m.amount)})</option>`).join('')}</select></div>
      <div><label>Buyer State</label><input id="pfe-buyer-state" value="${esc(pf.buyer_state || '')}"></div>
      <div><label>Buyer GSTIN</label><input id="pfe-buyer-gstin" value="${esc(pf.buyer_gstin || '')}"></div>
    </div>
    <h4>Order Line Items <span class="muted">(tick the lines to invoice, or leave all unticked to use the Amount field below)</span></h4>
    <div id="pfe-lines"></div>
    <div class="form-grid" style="margin-top:8px;">
      <div><label>Amount (₹, if no milestone and no lines ticked)</label><input id="pfe-amount" type="number" value="${manualItem ? manualItem.rate : ''}"></div>
      <div><label>Item Description</label><input id="pfe-desc" value="${manualItem ? esc(manualItem.description) : ''}"></div>
      ${proformaChargeFieldHTML('pfe-pf', 'Packing & Forwarding', pf.packing_forwarding_percent, pf.packing_forwarding_amount)}
      ${proformaChargeFieldHTML('pfe-cc', 'Courier Charges', pf.courier_charges_percent, pf.courier_charges_amount)}
      ${proformaChargeFieldHTML('pfe-ins', 'Insurance', pf.insurance_percent, pf.insurance_amount)}
      <div><label>Advance Received (₹)</label><input id="pfe-advance" type="number" value="${pf.advance_received || ''}"></div>
    </div>
    <button class="btn" id="pfe-save-btn-${pf.id}" onclick="saveEditProforma(${pf.id})">Save Changes</button>
    <div id="pfe-err" class="msg err" style="display:none;margin-top:8px;"></div>
  `);
  renderPFELines();
};
function renderPFELines() {
  const wrap = document.getElementById('pfe-lines');
  if (!wrap) return;
  if (!PFE_LINES.length) { wrap.innerHTML = '<p class="muted">This order has no line items on file - use the Amount field below instead.</p>'; return; }
  wrap.innerHTML = pfLinesHTML(PFE_LINES, 'PFE_LINES', 'renderPFELines');
}
window.pfePrefillAmountFromPercent = (soId) => {
  const o = (window.__INV_ORDERS || []).find(x => x.id === soId);
  const amountEl = document.getElementById('pfe-amount');
  if (!o || !amountEl || val('pfe-milestone')) return;
  const pct = val('pfe-type') === 'Advance' ? Number(o.advance_percent) || 0 : Number(o.predispatch_percent) || 0;
  if (pct > 0) amountEl.value = Math.round((pct / 100 * (Number(o.order_value) || 0)) * 100) / 100;
};
window.saveEditProforma = async (id) => {
  const errEl = document.getElementById('pfe-err'); errEl.style.display = 'none';
  const selectedLines = PFE_LINES.filter(l => l.selected);
  try {
    await api(`/finance/proforma-invoices/${id}`, { method: 'PUT', body: JSON.stringify({
      invoice_type: val('pfe-type'), milestone_id: val('pfe-milestone') || null,
      amount: selectedLines.length ? undefined : (val('pfe-amount') || undefined),
      description: val('pfe-desc'),
      items: selectedLines.length ? selectedLines.map(l => ({
        description: l.description, quantity: l.quantity, unit: l.unit, rate: l.rate,
        gst_rate: l.gst_rate_override, sales_order_item_id: l.id,
      })) : undefined,
      buyer_state: val('pfe-buyer-state'), buyer_gstin: val('pfe-buyer-gstin'),
      ...proformaChargePayload('pfe-pf', 'packing_forwarding_percent', 'packing_forwarding_amount'),
      ...proformaChargePayload('pfe-cc', 'courier_charges_percent', 'courier_charges_amount'),
      ...proformaChargePayload('pfe-ins', 'insurance_percent', 'insurance_amount'),
      advance_received: val('pfe-advance') || undefined,
    })});
    confirmSavedThenClose(`pfe-save-btn-${id}`, 'sales-invoices');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
// Fills Client Name/Contact Person/Address/Phone from the picked order's
// client master the moment an order is selected - still freely editable
// afterward (e.g. billing to a different site contact for this one
// invoice), same "default from master, editable per-document" pattern the
// Offer builder's own client autofill already uses.
window.invoiceSOChanged = () => {
  const soId = Number(val('inv-so'));
  const o = (window.__INV_ORDERS || []).find(x => x.id === soId);
  if (!o) return;
  document.getElementById('inv-buyer-state').value = o.client_billing_state || '';
  document.getElementById('inv-buyer-gstin').value = o.client_gstin || '';
  document.getElementById('inv-buyer-name').value = o.client_name || '';
  document.getElementById('inv-buyer-contact').value = o.client_contact_person || '';
  document.getElementById('inv-buyer-address').value = o.client_address || '';
  document.getElementById('inv-buyer-phone').value = o.client_phone || '';
};
// Same searchable-picker + auto-fill pattern as Generate Invoice's own
// invoiceSOChanged() above (2026-10-26) - Proforma previously used a plain
// unsearchable <select> with no auto-fill at all. Both forms share one
// already-fetched `window.__INV_ORDERS` array (GET /sales/orders), which
// now also carries the client's own Billing-address state (clients itself
// has no state column - only its billing address does), so State can be
// auto-filled here for the first time, not just GSTIN.
window.pfSOChanged = () => {
  const soId = Number(val('pf-so'));
  const o = (window.__INV_ORDERS || []).find(x => x.id === soId);
  if (o) {
    document.getElementById('pf-buyer-state').value = o.client_billing_state || '';
    document.getElementById('pf-buyer-gstin').value = o.client_gstin || '';
  }
  loadPFMilestones();
  loadPFLines();
  pfPrefillAmountFromPercent();
};
// Advance %/Payment Before Dispatch % (2026-10-27, captured on the Sales
// Order itself) pre-fill the Amount field here the same way the backend
// falls back to them when no amount is sent - this is purely a visible,
// still-freely-editable default, not a lock, so Accounts can always type a
// different figure before booking. Only overwrites the Amount box when a
// milestone isn't driving the amount instead (the milestone dropdown's own
// onchange - see loadPFMilestones() - already fills/clears this field for
// that case).
window.pfPrefillAmountFromPercent = () => {
  const soId = Number(val('pf-so'));
  const o = (window.__INV_ORDERS || []).find(x => x.id === soId);
  const amountEl = document.getElementById('pf-amount');
  pfApplyDefaultSelection();
  if (!o || !amountEl || val('pf-milestone')) return;
  const pct = val('pf-type') === 'Advance' ? Number(o.advance_percent) || 0 : Number(o.predispatch_percent) || 0;
  amountEl.value = pct > 0 ? Math.round((pct / 100 * (Number(o.order_value) || 0)) * 100) / 100 : '';
};
window.generateInvoice = async () => {
  const errEl = document.getElementById('inv-err'); errEl.style.display = 'none';
  const soId = val('inv-so');
  if (!soId) { errEl.textContent = 'Pick a sales order.'; errEl.style.display = 'block'; return; }
  try {
    await api(`/finance/invoices/from-sales-order/${soId}`, { method: 'POST', body: JSON.stringify({
      buyer_state: val('inv-buyer-state'), buyer_gstin: val('inv-buyer-gstin'),
      buyer_name: val('inv-buyer-name'), buyer_contact_person: val('inv-buyer-contact'),
      buyer_address: val('inv-buyer-address'), buyer_phone: val('inv-buyer-phone'),
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

// ===================== Accounts Payable: Purchase Invoices =====================
// Booking a vendor's bill against a PO - mirrors the Sales Invoice page's
// shape (own numbered sequence, GST split) but flowing the other direction.
// A PO is picked first, then its billable lines (received-but-not-yet-
// invoiced quantity - see GET /finance/purchase-invoices/billable-po-lines)
// load in, so booking can never over-bill a PO. Goes through the same
// approval-then-pay flow Purchase Orders just got: PendingApproval ->
// Approved (Accounts HOD, then Management above a value threshold) before
// any payment can be recorded against it.
let PI_LINES = [];
window.loadBillablePOLines = async () => {
  const poNo = val('pi-po');
  const box = document.getElementById('pi-lines-box');
  PI_LINES = [];
  if (!poNo) { box.innerHTML = ''; return; }
  try {
    // Item lines and any still-billable Transportation/Packing & Forwarding
    // charges (2026-10-27, entered by the Store HOD/Supervisor while
    // approving the GRN) load together so both can be included in the same
    // invoice - a separate, additive endpoint from billable-po-lines so that
    // route's own existing response/behavior is untouched.
    const [lines, charges] = await Promise.all([
      api('/finance/purchase-invoices/billable-po-lines?po_no=' + encodeURIComponent(poNo)),
      api('/finance/purchase-invoices/billable-charges?po_no=' + encodeURIComponent(poNo)),
    ]);
    if (!lines.length && !charges.length) {
      box.innerHTML = '<p class="muted">Nothing on this PO is currently billable - either nothing has been received yet, or everything received has already been invoiced.</p>';
      return;
    }
    PI_LINES = lines.map(l => ({
      purchase_order_line_id: l.id, item_id: l.item_id, item_name: l.item_name, hsn_code: l.hsn_code || '',
      gst_rate: l.gst_rate || 18, billable_qty: l.billable_qty, quantity: l.billable_qty, rate: l.rate,
    })).concat(charges.map(c => ({
      source_grn_id: c.source_grn_id, charge_type: c.charge_type, item_name: c.description,
      hsn_code: '', gst_rate: 18, billable_qty: c.amount, quantity: 1, rate: c.amount,
    })));
    renderPILines();
  } catch (e) { box.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
};
function renderPILines() {
  const box = document.getElementById('pi-lines-box');
  if (!box) return;
  box.innerHTML = tableHTML(['Item / Charge', 'Billable', 'Bill Qty / Include', 'Rate (₹) / Amount (₹)', 'HSN', 'GST %'], PI_LINES, (l, i) => `
    <tr><td>${esc(l.item_name)||'-'}</td><td>${l.charge_type ? '₹' + fmt(l.billable_qty) : fmt(l.billable_qty)}</td>
      <td>${l.charge_type
        ? `<label><input type="checkbox" checked onchange="PI_LINES[${i}].quantity=this.checked?1:0"> Include</label>`
        : `<input type="number" value="${l.quantity}" max="${l.billable_qty}" min="0" onchange="PI_LINES[${i}].quantity=Number(this.value)" style="width:90px;">`}</td>
      <td><input type="number" value="${l.rate}" ${l.charge_type ? `max="${l.billable_qty}"` : ''} onchange="PI_LINES[${i}].rate=Number(this.value)" style="width:100px;"></td>
      <td><input value="${esc(l.hsn_code)}" onchange="PI_LINES[${i}].hsn_code=this.value" style="width:90px;"></td>
      <td><input type="number" value="${l.gst_rate}" onchange="PI_LINES[${i}].gst_rate=Number(this.value)" style="width:70px;"></td></tr>`);
}
window.prefillFromReadyToBill = async (g) => {
  document.getElementById('pi-vendor').value = g.vendor_id;
  await window.loadVendorPOsForInvoice();
  document.getElementById('pi-po').value = g.po_no;
  await window.loadBillablePOLines();
  if (g.vendor_invoice_no) document.getElementById('pi-vendor-inv-no').value = g.vendor_invoice_no;
  if (g.vendor_invoice_date) document.getElementById('pi-vendor-inv-date').value = g.vendor_invoice_date;
  // The vendor's own invoiced rate (captured at receiving time) is what
  // Accounts should actually bill at, if it differs from the PO rate the
  // line was pre-filled with - that's the whole point of reconciling first.
  if (g.vendor_invoiced_rate != null) {
    const idx = PI_LINES.findIndex(l => l.purchase_order_line_id === g.po_id);
    if (idx >= 0) { PI_LINES[idx].rate = g.vendor_invoiced_rate; renderPILines(); }
  }
  document.getElementById('pi-vendor').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.loadVendorPOsForInvoice = async () => {
  const vendorId = Number(val('pi-vendor'));
  const sel = document.getElementById('pi-po');
  const orders = window.__PI_ORDERS || [];
  const poNos = [...new Set(orders.filter(o => o.vendor_id === vendorId && o.status !== 'Cancelled').map(o => o.po_no))];
  sel.innerHTML = '<option value="">-- Select PO --</option>' + poNos.map(no => `<option value="${esc(no)}">${esc(no)}</option>`).join('');
  document.getElementById('pi-lines-box').innerHTML = '';
  PI_LINES = [];
};
PAGES['purchase-invoices'] = async (el) => {
  const [vendors, orders, invoices, creditNotes, pendingBills, readyToBill] = await Promise.all([
    api('/masters/vendors'), api('/purchase/orders'), api('/finance/purchase-invoices'),
    api('/finance/vendor-credit-notes'), api('/finance/pending-purchase-bills'),
    api('/finance/purchase-invoices/ready-to-bill'),
  ]);
  window.__PI_ORDERS = orders;
  window.__PI_READY_TO_BILL = readyToBill;
  PI_LINES = [];
  el.innerHTML = `
    <div class="panel"><h3>Book Purchase Invoice (Vendor Bill)</h3>
      <div class="form-grid">
        <div><label>Vendor</label><select id="pi-vendor" onchange="loadVendorPOsForInvoice()"><option value="">-- Select vendor --</option>${vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
        <div><label>Purchase Order</label><select id="pi-po" onchange="loadBillablePOLines()"><option value="">-- Pick a vendor first --</option></select></div>
        <div><label>Vendor's Invoice No.</label><input id="pi-vendor-inv-no" placeholder="As printed on their bill"></div>
        <div><label>Vendor's Invoice Date</label><input id="pi-vendor-inv-date" type="date"></div>
        <div><label>TDS Rate (%) <span class="muted">(if applicable)</span></label><input id="pi-tds-rate" type="number" step="0.01" value="0"></div>
      </div>
      <div id="pi-lines-box"></div>
      <button class="btn" onclick="bookPurchaseInvoice()">Book Invoice</button>
      <div id="pi-err" class="msg err" style="display:none;"></div>
    </div>
    ${collapsiblePanel('ready-to-bill', `Ready to Bill - Reconciled GRNs (${readyToBill.length})`, `
      <p class="muted">PO lines the Store HOD has already reconciled against the vendor's own invoice - click Create Invoice to pre-fill the form above with what Store already captured, then Book Invoice to confirm.</p>
      ${tableHTML(['PO No', 'Item', 'Vendor', 'Billable Qty', 'Vendor Invoice', 'Vendor Rate', ''], readyToBill, g => `
        <tr><td>${esc(g.po_no)}</td><td>${esc(g.item_name)||'-'}</td><td>${esc(g.vendor_name)||'-'}</td><td>${fmt(g.billable_qty)}</td>
        <td>${esc(g.vendor_invoice_no)||'-'}${g.vendor_invoice_date ? ' (' + esc(g.vendor_invoice_date) + ')' : ''}</td>
        <td>${g.vendor_invoiced_rate != null ? '₹' + fmt(g.vendor_invoiced_rate) : '-'}</td>
        <td><button class="btn small" type="button" onclick='prefillFromReadyToBill(${JSON.stringify(g)})'>Create Invoice</button></td></tr>`)}
    `)}
    ${collapsiblePanel('purchase-invoices-list', `Purchase Invoices (${invoices.length})`, `
      ${tableHTML(['Invoice No', 'Vendor', 'Vendor Bill No', 'PO', 'Taxable', 'GST', 'TDS', 'Net Payable', 'Paid', 'Due', 'Status', ''], invoices, i => `
        <tr><td>${esc(i.invoice_no)}</td><td>${esc(i.vendor_name)}</td><td>${esc(i.vendor_invoice_no)}</td><td>${esc(i.po_no)||'-'}</td>
        <td>₹${fmt(i.taxable_value)}</td><td>₹${fmt(i.cgst + i.sgst + i.igst)}</td><td>₹${fmt(i.tds_amount)}</td>
        <td>₹${fmt(i.net_payable)}</td><td>₹${fmt(i.paid_amount)}</td><td>₹${fmt(i.due_amount)}</td><td>${badge(i.status)}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" type="button" onclick="togglePIDetail(${i.id})">Details</button>
          ${['Approved', 'PartiallyPaid'].includes(i.status) ? `<button class="btn small" type="button" onclick="recordPIPayment(${i.id})">Record Payment</button>
          <button class="btn small outline" type="button" onclick="openCreditNoteForm(${i.id})">Credit Note</button>` : ''}
          ${!['PartiallyPaid', 'Paid', 'Cancelled'].includes(i.status) ? `<button class="btn small outline" type="button" onclick="cancelPurchaseInvoice(${i.id})">Cancel</button>` : ''}
        `)}</td></tr>
        <tr id="pi-detail-row-${i.id}" style="display:none;"><td colspan="12"><div id="pi-detail-${i.id}"></div></td></tr>`)}
    `)}
    ${collapsiblePanel('vendor-credit-notes-list', `Vendor Credit Notes (${creditNotes.length})`, `
      ${tableHTML(['Credit Note No', "Vendor's CN No", 'Vendor', 'Against Invoice', 'Taxable', 'GST', 'Total', 'Status', ''], creditNotes, c => `
        <tr><td>${esc(c.credit_note_no)}</td><td>${esc(c.vendor_credit_note_no)||'-'}</td><td>${esc(c.vendor_name)}</td><td>${esc(c.purchase_invoice_no)}</td>
        <td>₹${fmt(c.taxable_value)}</td><td>₹${fmt(c.cgst + c.sgst + c.igst)}</td><td>₹${fmt(c.total_value)}</td><td>${badge(c.status)}</td>
        <td>${c.status === 'Active' ? `<button class="btn small outline" type="button" onclick="cancelCreditNote(${c.id})">Cancel</button>` : ''}</td></tr>`)}
    `)}
    ${collapsiblePanel('pending-purchase-bills', `Pending Purchase Bills (${pendingBills.length})`, `
      <p class="muted">Booked-but-unpaid vendor bills, with how overdue each is against that vendor's own payment-terms days.</p>
      ${tableHTML(['Invoice No', 'Vendor', 'Booking Date', 'Due Date', 'Due Amount', 'Days Overdue', 'Status'], pendingBills, p => `
        <tr><td>${esc(p.invoice_no)}</td><td>${esc(p.vendor_name)}</td><td>${new Date(p.booking_date).toLocaleDateString()}</td>
        <td>${p.due_date}</td><td>₹${fmt(p.due_amount)}</td>
        <td>${p.days_overdue > 0 ? `<span class="badge Rejected">${p.days_overdue}d overdue</span>` : '<span class="muted">Not yet due</span>'}</td>
        <td>${badge(p.status)}</td></tr>`)}
    `)}`;
};
window.bookPurchaseInvoice = async () => {
  const errEl = document.getElementById('pi-err'); errEl.style.display = 'none';
  const vendorId = val('pi-vendor'), poNo = val('pi-po');
  if (!vendorId) { errEl.textContent = 'Pick a vendor.'; errEl.style.display = 'block'; return; }
  const lines = PI_LINES.filter(l => Number(l.quantity) > 0);
  if (!lines.length) { errEl.textContent = 'Pick a PO with at least one billable line, with a quantity greater than 0.'; errEl.style.display = 'block'; return; }
  try {
    await api('/finance/purchase-invoices', { method: 'POST', body: JSON.stringify({
      vendor_id: vendorId, po_no: poNo || null,
      vendor_invoice_no: val('pi-vendor-inv-no'), vendor_invoice_date: val('pi-vendor-inv-date'),
      tds_rate: val('pi-tds-rate') || 0, lines,
    })});
    alert('Purchase Invoice booked - submitted for approval (Accounts HOD, then Management if above the value threshold). A payment cannot be recorded until it is approved.');
    navigate('purchase-invoices');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.togglePIDetail = async (id) => {
  const row = document.getElementById(`pi-detail-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (showing) return;
  const box = document.getElementById(`pi-detail-${id}`);
  box.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const { invoice, items, payments } = await api(`/finance/purchase-invoices/${id}`);
    box.innerHTML = `<div class="panel">
      <h5>Line Items</h5>
      ${tableHTML(['Item', 'Qty', 'Rate (₹)', 'HSN', 'GST %', 'Taxable (₹)'], items, it => `
        <tr><td>${esc(it.item_name)||esc(it.description)}</td><td>${it.quantity}</td><td>₹${fmt(it.rate)}</td><td>${esc(it.hsn_code)||'-'}</td><td>${it.gst_rate}%</td><td>₹${fmt(it.taxable_value)}</td></tr>`)}
      <h5>Payments</h5>
      ${payments.length ? tableHTML(['Date', 'Amount', 'Description'], payments, p => `
        <tr><td>${new Date(p.entry_date).toLocaleDateString()}</td><td>₹${fmt(p.amount)}</td><td>${esc(p.description)||'-'}</td></tr>`) : '<p class="muted">No payments recorded yet.</p>'}
      <div id="pi-attachments-${id}"></div>
    </div>`;
    renderAttachmentsWidget('purchase_invoice', id, document.getElementById(`pi-attachments-${id}`));
  } catch (e) { box.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
};
window.recordPIPayment = async (id) => {
  const amount = prompt('Payment amount (₹):');
  if (!amount) return;
  const reference = prompt('Payment reference (cheque no / UTR / mode - optional):') || '';
  try {
    await api(`/finance/purchase-invoices/${id}/record-payment`, { method: 'POST', body: JSON.stringify({ amount, reference }) });
    navigate('purchase-invoices');
  } catch (e) { alert(e.message); }
};
window.cancelPurchaseInvoice = async (id) => {
  if (!confirm('Cancel this purchase invoice?')) return;
  try { await api(`/finance/purchase-invoices/${id}/cancel`, { method: 'POST' }); navigate('purchase-invoices'); }
  catch (e) { alert(e.message); }
};
window.openCreditNoteForm = (invoiceId) => {
  const body = `
    <div class="form-grid">
      <div><label>Vendor's Credit Note No. (optional)</label><input id="cn-modal-vendor-no"></div>
      <div><label>Taxable Value (₹)</label><input id="cn-modal-taxable" type="number"></div>
      <div><label>GST Rate (%)</label><input id="cn-modal-gst" type="number" value="18"></div>
      <div><label>Reason</label><input id="cn-modal-reason" placeholder="e.g. rate correction, short supply"></div>
    </div>
    <button class="btn small" type="button" onclick="submitCreditNote(${invoiceId})">Save Credit Note</button>
    <div id="cn-modal-err" class="msg err" style="display:none;"></div>`;
  openMiniModal('Vendor Credit Note', body);
};
window.submitCreditNote = async (invoiceId) => {
  const errEl = document.getElementById('cn-modal-err'); errEl.style.display = 'none';
  try {
    await api('/finance/vendor-credit-notes', { method: 'POST', body: JSON.stringify({
      purchase_invoice_id: invoiceId, vendor_credit_note_no: val('cn-modal-vendor-no'),
      taxable_value: val('cn-modal-taxable'), gst_rate: val('cn-modal-gst') || 0, reason: val('cn-modal-reason'),
    })});
    closeMiniModal();
    navigate('purchase-invoices');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.cancelCreditNote = async (id) => {
  if (!confirm('Cancel this credit note?')) return;
  try { await api(`/finance/vendor-credit-notes/${id}/cancel`, { method: 'POST' }); navigate('purchase-invoices'); }
  catch (e) { alert(e.message); }
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
      <button class="btn small outline" onclick="runSoaScanNow()">Run Scan Now</button>
      <p class="muted">Every client follows this default unless given their own override below. A statement is only ever queued here for internal review - nothing is emailed to a customer without Verify + Send.</p>
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
        <td>${actionButtonsCell(`
          <a class="btn small outline" href="#" onclick="downloadSoaPeriodPdf(${p.client_id}, '${p.period_start}', '${p.period_end}');return false;">PDF</a>
          ${p.status === 'PendingReview' ? `<button class="btn small" type="button" onclick="verifySoa(${p.id})">Verify</button>` : ''}
          ${p.status === 'Verified' ? `<button class="btn small green" type="button" onclick="sendSoaEmail(${p.id})" ${p.client_email ? '' : 'disabled title="No email on file"'}>Send Email</button>` : ''}
          <button class="btn small outline" type="button" onclick="dismissSoa(${p.id})">Dismiss</button>
        `)}</td></tr>`)}
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
  const listMonth = OE_LIST_MONTH || thisMonth();
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
      <div><label>Description</label><input id="oe-desc"></div>
      <button class="btn" onclick="addOperatingExpense()">Add Expense</button>
      ${isAdmin ? `<button class="btn small outline" type="button" onclick="openOeCategoryManager()">Manage Categories</button>` : ''}
      <div id="oe-err" class="msg err" style="display:none;"></div>
    </div>
    ${collapsiblePanel('operating-expenses-list', `Operating Expenses - ${listMonth === 'all' ? 'All Time' : listMonth} (${rows.length})`, `
      <div class="form-grid">
        <div><label>Month</label><input type="month" id="oe-list-month" value="${listMonth === 'all' ? '' : listMonth}" onchange="OE_LIST_MONTH=this.value;navigate('operating-expenses')"></div>
        <div><button class="btn small outline" type="button" onclick="OE_LIST_MONTH='all';navigate('operating-expenses')">Show All</button></div>
      </div>
      ${tableHTML(['Date', 'Category', 'Description', 'Amount', 'Paid Via'], rows, r => `
        <tr><td>${new Date(r.expense_date).toLocaleDateString()}</td><td>${esc(r.category)}</td><td>${esc(r.description)}</td><td>₹${fmt(r.amount)}</td><td>${esc(r.paid_via)}</td></tr>`)}
    `)}
    ${collapsiblePanel('operating-expenses-summary', `Monthly Category Summary - ${summaryYear}`, `
      <div class="form-grid">
        <div><label>Year</label><input type="number" id="oe-summary-year" value="${summaryYear}" onchange="OE_SUMMARY_YEAR=this.value;navigate('operating-expenses')"></div>
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
    <div id="oec-err" class="msg err" style="display:none;"></div>
    <div id="oec-list-wrap">${oeCategoryListHTML(categories)}</div>`;
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
      <div id="gst-result"></div>
      <p class="muted">This is a reference report only, computed from invoices and purchase order GST fields recorded in this system - not an official GST filing tool. Verify with your GST practitioner before filing.</p>
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

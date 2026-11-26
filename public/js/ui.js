// ui.js - shared UI helpers: esc, tableHTML, gridLineTableHTML, sortable/searchable lists,
// pickers, collapsiblePanel, openAppModal, bulk-upload helpers, panel drag-reorder. Loaded SECOND.

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
// Generic popup/modal - the first one in this app. `title` can include
// context (e.g. an SR number/customer) right in the heading, so unlike the
// older pattern of filling a panel elsewhere on the page and scrolling to
// it, there's no ambiguity about which row an open modal belongs to.
// Re-entrant: calling it again while one's already open just replaces the
// content rather than stacking a second backdrop.
window.openAppModal = (title, bodyHtml) => {
  closeAppModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'app-modal-backdrop';
  backdrop.id = 'app-modal-backdrop';
  backdrop.onclick = (e) => { if (e.target === backdrop) closeAppModal(); };
  backdrop.innerHTML = `<div class="app-modal-box">
    <button type="button" class="app-modal-close" onclick="closeAppModal()">&times;</button>
    <h3>${title}</h3>
    <div id="app-modal-body">${bodyHtml}</div>
  </div>`;
  document.body.appendChild(backdrop);
};
// Rejection popup with a Reason textarea; Submit stays disabled while it is blank when `required`. `onSubmit(reason)`
// may throw/reject - the message is shown in the popup and it stays open.
window.openRejectReasonModal = (title, required, onSubmit, opts) => {
  opts = opts || {};
  window.__rejectSubmit = onSubmit;
  openAppModal(esc(title), `
    <label>${esc(opts.label || 'Rejection Reason')}${required ? ' (required)' : ' (optional)'}</label>
    <textarea id="reject-reason" rows="4" style="width:100%;" oninput="document.getElementById('reject-submit').disabled = ${required ? 'true' : 'false'} && !this.value.trim()"></textarea>
    <div id="reject-err" class="msg err" style="display:none;margin-top:8px;"></div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn small red" id="reject-submit" type="button" ${required ? 'disabled' : ''} onclick="submitRejectReason(${required})">${esc(opts.button || 'Reject')}</button>
      <button class="btn small outline" type="button" onclick="closeAppModal()">Cancel</button>
    </div>`);
  setTimeout(() => { const t = document.getElementById('reject-reason'); if (t) t.focus(); }, 0);
};
window.submitRejectReason = async (required) => {
  const reason = document.getElementById('reject-reason').value.trim();
  const errEl = document.getElementById('reject-err');
  if (required && !reason) { errEl.textContent = 'A reason is required.'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('reject-submit'); btn.disabled = true;
  try { await window.__rejectSubmit(reason); closeAppModal(); }
  catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; btn.disabled = false; }
};
window.closeAppModal = () => {
  const el = document.getElementById('app-modal-backdrop');
  if (el) el.remove();
};
// Shared "saved" confirmation for Edit popups (2026-10-13) - every Edit
// flow converted from an inline/scroll-to panel to this modal needed some
// visible proof a save actually took effect before the popup disappears,
// rather than either a silent navigate() or a blocking alert() stacked on
// top of the now-closing modal. Disables the clicked Save button and shows
// "Saved ✓" on it briefly, then closes the modal and refreshes the
// underlying list.
function confirmSavedThenClose(buttonId, pageKey, delayMs) {
  const btn = document.getElementById(buttonId);
  if (btn) { btn.disabled = true; btn.textContent = 'Saved ✓'; }
  setTimeout(() => { closeAppModal(); navigate(pageKey); }, delayMs || 700);
}
window.toggleCollapsiblePanel = (key) => {
  const el = document.getElementById('cp-' + key);
  if (!el) return;
  const expanded = loadExpandedPanels();
  expanded[key] = !expanded[key];
  saveExpandedPanels(expanded);
  el.classList.toggle('collapsed');
};
// Lighter-weight collapsible section for grouping several already-collapsible
// panels under one outer collapsiblePanel() (e.g. Company Settings' "Email
// Settings" group) - same remembered-per-key expand state and toggle handler
// as collapsiblePanel(), just without the card background/border/padding so
// nesting one inside the other doesn't look like a card-in-a-card.
function collapsibleSubsection(key, headHtml, bodyHtml) {
  const expanded = loadExpandedPanels();
  const isCollapsed = !expanded[key];
  return `<div class="panel-sub${isCollapsed ? ' collapsed' : ''}" id="cp-${key}">
    <div class="panel-head" onclick="toggleCollapsiblePanel('${key}')"><h4>${headHtml}</h4><span class="chev">&#9660;</span></div>
    <div class="panel-body">${bodyHtml}</div>
  </div>`;
}

// ===================== Helpers =====================
function esc(s) { return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// Generic row-action button grid (2026-10-13, widened from the Purchase
// Orders list's own poActionsCell() to every list page whose Action column
// shows a different subset of buttons per row - a row's button count/label
// length varies by status (Edit/Delete vs Submit for Approval vs nothing),
// so plain flex-wrap packs them inconsistently row to row. The actual grid
// rules live on the .row-actions CSS class in public/index.html; this just
// applies it. Use for any <td> content that's more than 1-2 same-length
// buttons - a single button needs no wrapper.
function actionButtonsCell(buttonsHtml, extraClass) {
  return `<div class="row-actions${extraClass ? ' ' + extraClass : ''}">${buttonsHtml}</div>`;
}
// Customer Group rollup (2026-10-14) - shared by the Offers and Sales
// Orders lists, since a business group commonly spans several separate
// `clients` rows (companies), and both lists need the identical "group by
// client_groups, fall back to the individual client" rollup rather than two
// slightly different implementations. Each row must carry `client_id`,
// `client_name`, `group_id` and `group_name` (every GET /offers and
// GET /orders response already does, via a LEFT JOIN client_groups).
function groupByCustomerGroup(rows) {
  const groups = []; const byKey = {};
  rows.forEach(r => {
    const key = r.group_id ? 'g' + r.group_id : 'c' + r.client_id;
    const label = r.group_id ? r.group_name : r.client_name;
    if (!byKey[key]) { byKey[key] = { key, label, rows: [] }; groups.push(byKey[key]); }
    byKey[key].rows.push(r);
  });
  return groups;
}
// `columns` is the page's own header-label array (what it used to pass to
// tableHTML() directly); `rowHTML(row)` returns exactly one row's own
// <tr>...</tr> markup (what tableHTML()'s own rowRenderer callback already
// looked like) - reused verbatim so each page's row markup still lives in
// exactly one place (see offerRowHTML/orderRowHTML below). When no Customer
// Group has ever been assigned to anything in this list, every row ends up
// its own singleton group - rendered as a flat table with no rollup wrapper
// at all, so an install that's never touched Customer Groups sees zero
// visual change, same reasoning the PO Archive/FOC-group collapsing already
// uses.
//
// 2026-10-14 follow-up: this used to call a full-table-producing
// renderRowsFn(rows) once per group, so a list with more than one
// multi-record group rendered several independent <table>s - each one's
// plain `table-layout:auto` computes its OWN column widths from only that
// group's own content, so one group's header row ends up a different width
// than the next group's, visibly misaligned down the page. Fixed by
// building ONE shared <table> (one <thead>, so column widths are computed
// once across every row in every group) with each group's own rows in
// their own toggleable <tbody> - a <table> can hold several <tbody>
// elements, each independently shown/hidden, same as the single <div>
// wrapper this replaced.
// `sortOpts`, when given ({ containerId, sortKey, fields: [field-or-null per
// column] }), makes every column with a non-null field clickable to sort
// (2026-10-27, Offers list) - sorts the flat `rows` array BEFORE grouping, so
// rows within a Customer Group rollup sort correctly and groups themselves
// still render in their natural first-seen order; omitting `sortOpts`
// entirely (every other caller, e.g. Sales Orders) leaves this function's
// behavior completely unchanged. `sortKey` is a separate key from `idPrefix`
// (the grouping-id prefix, e.g. gid='of-grp-0') specifically so the two never
// collide when stored/looked-up.
const CGT_SORT_STATE = {};
function customerGroupedHTML(rows, idPrefix, columns, rowHTML, sortOpts) {
  if (!rows.length) return '<div class="empty">No records yet.</div>';
  if (sortOpts) {
    const prevSt = CGT_SORT_STATE[sortOpts.sortKey] && CGT_SORT_STATE[sortOpts.sortKey].st;
    CGT_SORT_STATE[sortOpts.sortKey] = { rows, idPrefix, columns, rowHTML, ...sortOpts, st: prevSt || { field: null, dir: 'asc' } };
  }
  const st = sortOpts ? CGT_SORT_STATE[sortOpts.sortKey].st : null;
  if (st && st.field) {
    rows = [...rows].sort((a, b) => {
      let av = a[st.field], bv = b[st.field];
      av = (av === null || av === undefined) ? '' : String(av).toLowerCase();
      bv = (bv === null || bv === undefined) ? '' : String(bv).toLowerCase();
      if (av < bv) return st.dir === 'asc' ? -1 : 1;
      if (av > bv) return st.dir === 'asc' ? 1 : -1;
      return 0;
    });
  }
  const groups = groupByCustomerGroup(rows);
  const headerRow = columns.map((c, i) => {
    const field = sortOpts && sortOpts.fields[i];
    if (!field) return `<th>${c}</th>`;
    const arrow = st && st.field === field ? (st.dir === 'asc' ? ' &#9650;' : ' &#9660;') : '';
    return `<th style="cursor:pointer;user-select:none;" onclick="toggleCGTSort('${sortOpts.sortKey}','${field}')">${c}${arrow}</th>`;
  }).join('');
  if (groups.every(g => g.rows.length === 1)) {
    return `<div style="overflow-x:auto;"><table><thead><tr>${headerRow}</tr></thead><tbody>${rows.map(rowHTML).join('')}</tbody></table></div>`;
  }
  const colCount = columns.length;
  const body = groups.map((g, i) => {
    if (g.rows.length === 1) return g.rows.map(rowHTML).join('');
    const gid = `${idPrefix}-grp-${i}`;
    return `<tbody><tr>
        <td colspan="${colCount}" style="cursor:pointer;font-weight:600;background:#f7f9fb;" onclick="toggleCustomerGroupRollup('${gid}')">
          <span id="${gid}-chev">&#9654;</span> ${esc(g.label)} <span class="muted">(${g.rows.length} records)</span>
        </td>
      </tr></tbody>
      <tbody id="${gid}-body" style="display:none;">${g.rows.map(rowHTML).join('')}</tbody>`;
  }).join('');
  return `<div style="overflow-x:auto;"><table><thead><tr>${headerRow}</tr></thead>${body}</table></div>`;
}
window.toggleCGTSort = (sortKey, field) => {
  const entry = CGT_SORT_STATE[sortKey];
  if (!entry) return;
  entry.st.dir = (entry.st.field === field && entry.st.dir === 'asc') ? 'desc' : 'asc';
  entry.st.field = field;
  const container = document.getElementById(entry.containerId);
  if (container) container.innerHTML = customerGroupedHTML(entry.rows, entry.idPrefix, entry.columns, entry.rowHTML, entry);
};
window.toggleCustomerGroupRollup = (gid) => {
  const body = document.getElementById(gid + '-body');
  const chev = document.getElementById(gid + '-chev');
  const showing = body.style.display !== 'none';
  body.style.display = showing ? 'none' : '';
  chev.innerHTML = showing ? '&#9654;' : '&#9660;';
};
window.toggleApprovalBucket = (bid) => {
  const body = document.getElementById(bid + '-body');
  const chev = document.getElementById(bid + '-chev');
  const showing = body.style.display !== 'none';
  body.style.display = showing ? 'none' : '';
  chev.innerHTML = showing ? '&#9654;' : '&#9660;';
};
function badge(status) { return `<span class="badge ${esc(status)}">${esc(status)}</span>`; }
function fmt(n) { return n === null || n === undefined ? '-' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
// The viewer's own browser-local calendar date - never toISOString(), which
// is always UTC regardless of the viewer's timezone and would silently
// shift "today" backward by up to a full day during the ~5.5-hour window
// between IST midnight and the following UTC midnight. This app's whole
// user base is in India, so a browser's own local date is the IST date.
function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function today() { return localDateStr(new Date()); }
// Mirrors routes/dashboard.js's GET /window-summary own `since` day math
// exactly (daily=1, monthly=30, else weekly=7) - used wherever a frontend
// detail view needs to independently re-filter by the same Dashboard
// window the backend already scoped its own totals by.
function windowSinceDate(win) {
  const days = win === 'daily' ? 1 : win === 'monthly' ? 30 : 7;
  return localDateStr(new Date(Date.now() - days * 86400000));
}
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

function thisMonth() { return localDateStr(new Date()).slice(0, 7); }
// {from, to} date bounds for a 'YYYY-MM' month string, for passing to
// GET /finance/ledger's own from/to query params - the route defaults to
// unbounded (all-time) when neither is given, so a caller labeling its
// own view "(This Month)" must pass these explicitly or the list silently
// shows every ledger entry ever, not just the month's.
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const to = localDateStr(new Date(y, m, 0)); // day 0 of next month = last day of this one
  return { from: month + '-01', to };
}

function tableHTML(columns, rows, rowRenderer) {
  if (!rows.length) return '<div class="empty">No records yet.</div>';
  // Wrapped in its own horizontal scroller so a cell with unusually wide
  // content (e.g. a long item name in a <select>) scrolls the table, not
  // the whole page - matches the same reasoning the mobile layout already
  // uses (see index.html's @media (max-width:768px) table rules), just
  // applied at every width instead of only on phones.
  return `<div style="overflow-x:auto;"><table><thead><tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(rowRenderer).join('')}
  </tbody></table></div>`;
}

// Grid-based line-item editing table (2026-10-14) - purpose-built for the
// New PO/PR/Edit PR/SO/FOC line-item forms, where every "column" holds a
// live input/picker rather than plain text. A plain <table> there left each
// column's rendered width to whatever its widest row's own hand-picked
// style="width:Npx" happened to force, independent of its header label -
// the same "no single declared width" root cause PR #172 fixed for row
// buttons via a real CSS grid. `colTemplate` is one grid-template-columns
// track list, applied identically to the header row and every data row
// (and the optional footer row) via the shared .glt-row class in
// index.html, so a column's width is always exactly what's declared here,
// never dependent on any one row's own input markup. `rowRenderer(row, i)`
// returns that row's own <div>...</div> cells (no wrapping element) -
// replaces the old tableHTML()+<tr>/<td> markup these forms used to use.
// `footerCellsHtml`, when given, is one more .glt-row for a totals line
// (its own <div>s may use grid-column:span N to mimic a <td colspan>).
function gridLineTableHTML(colTemplate, columns, rows, rowRenderer, footerCellsHtml) {
  if (!rows.length) return '<div class="empty">No lines yet.</div>';
  const rowStyle = `style="grid-template-columns:${colTemplate};"`;
  return `<div class="grid-line-table" style="overflow-x:auto;">
    <div class="glt-row glt-head" ${rowStyle}>${columns.map(c => `<div>${c}</div>`).join('')}</div>
    ${rows.map((r, i) => `<div class="glt-row" ${rowStyle}>${rowRenderer(r, i)}</div>`).join('')}
    ${footerCellsHtml ? `<div class="glt-row glt-foot" ${rowStyle}>${footerCellsHtml}</div>` : ''}
  </div>`;
}

// ---- Click-to-sort table headers ----
// Opt-in alternative to tableHTML() for a list page that wants sortable
// column headers - tableHTML() itself is left untouched so every other
// page using it is unaffected. Same "caller supplies a re-render callback"
// idiom as LIST_SEARCH_STATE/filterList above: clicking a header only
// redraws the table into whatever container onSort targets, not the whole
// page, so in-progress typing in an "Add X" form above the table survives
// a sort click. `columns` is [{ label, field, type }] - omit `field` for a
// column that isn't sortable (e.g. a trailing Action column); `type:
// 'number'` sorts numerically, anything else sorts as a case-insensitive
// string. Sort state persists per `key` for the session, so leaving and
// returning to a list keeps the last sort applied.
const SORT_STATE = {};
function sortableTableHTML(key, columns, rows, rowRenderer, onSort) {
  const st = SORT_STATE[key] || (SORT_STATE[key] = { field: null, dir: 'asc' });
  st.columns = columns; st.rows = rows; st.rowRenderer = rowRenderer; st.onSort = onSort;
  return renderSortedTable(key);
}
function renderSortedTable(key) {
  const st = SORT_STATE[key];
  if (!st.rows.length) return '<div class="empty">No records yet.</div>';
  let rows = st.rows;
  const activeCol = st.columns.find(c => c.field === st.field);
  if (activeCol) {
    rows = [...rows].sort((a, b) => {
      let av = a[st.field], bv = b[st.field];
      if (activeCol.type === 'number') { av = Number(av) || 0; bv = Number(bv) || 0; }
      else { av = (av === null || av === undefined) ? '' : String(av).toLowerCase(); bv = (bv === null || bv === undefined) ? '' : String(bv).toLowerCase(); }
      if (av < bv) return st.dir === 'asc' ? -1 : 1;
      if (av > bv) return st.dir === 'asc' ? 1 : -1;
      return 0;
    });
  }
  const headHtml = st.columns.map(c => {
    if (!c.field) return `<th>${esc(c.label)}</th>`;
    const active = st.field === c.field;
    const arrow = active ? (st.dir === 'asc' ? '&#9650;' : '&#9660;') : '&#8645;';
    return `<th class="sortable${active ? ' sorted' : ''}" onclick="sortTableBy('${key}','${c.field}')" title="Sort by ${esc(c.label)}">${esc(c.label)} <span class="sort-arrow">${arrow}</span></th>`;
  }).join('');
  return `<div style="overflow-x:auto;"><table><thead><tr>${headHtml}</tr></thead><tbody>
    ${rows.map(st.rowRenderer).join('')}
  </tbody></table></div>`;
}
window.sortTableBy = (key, field) => {
  const st = SORT_STATE[key];
  if (!st) return;
  if (st.field === field) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
  else { st.field = field; st.dir = 'asc'; }
  if (st.onSort) st.onSort(renderSortedTable(key));
};

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

// Reusable searchable picker - a small text input that filters a paired
// <select>'s options as you type, since scrolling a plain dropdown gets
// painful once a list has more than a couple dozen entries. Same
// filter-as-you-type idiom as LIST_SEARCH_STATE/filterList above, but drives
// a <select>'s options instead of a rendered table. `renderOptions` is
// whatever function the caller already used to build that <select>'s
// <option> markup - this only adds the search/filter layer in front of it,
// it doesn't change how records are labeled once you're browsing the
// (possibly narrowed) list. `matchFn(record, lowercaseQuery)` decides what
// counts as a match - the caller picks whichever fields make sense to
// search (item name/code, project code/title, PO number/vendor/item, ...).
const SEARCH_PICKER_STATE = {};
// `widthStorageKey`, when passed, makes this picker user-resizable (CSS
// `resize:horizontal`, dragged from its bottom-right corner) instead of the
// fixed `max-width` every picker used to be capped to - the width the user
// drags it to is remembered in localStorage under that key (a per-viewer
// convenience, same as any other browser-storage UI preference in this app)
// and reapplied as the starting width on every future render, including
// after the row it sits in gets rebuilt by an unrelated field's onchange.
// Pickers that don't pass a key (project/client) keep the old width:100%
// behavior untouched. See itemPickerHTML() below for the one caller that
// opts in, and savePickerWidth()/the 2026-10-07 CLAUDE.md note on why every
// expandable/dropdown field needs a verified-width check going forward.
function searchPickerHTML(pickerId, records, selectedValue, renderOptions, matchFn, selectAttrs, placeholder, containerStyle, widthStorageKey, noMatchMessage) {
  SEARCH_PICKER_STATE[pickerId] = { records, renderOptions, matchFn, noMatchMessage: noMatchMessage || 'No matches found.' };
  let wrapperStyle;
  if (widthStorageKey) {
    let savedWidth = '260px';
    try { savedWidth = localStorage.getItem(widthStorageKey) || '260px'; } catch (e) { /* ignore - private window / blocked storage */ }
    // `widthStorageKey` is a single key shared across every page a given
    // picker type appears on (e.g. itemPickerHTML's 'erp_item_picker_width')
    // - a width the user drags on a wide page (New Purchase Order) persists
    // and gets reapplied on a much narrower one (a popup modal), where the
    // saved px value can exceed the picker's actual grid column, pushing the
    // whole wrapper outside its cell and smashing into neighboring columns.
    // `min(...,100%)` keeps the saved/dragged width as the preference but
    // never lets it exceed whatever room the current container actually has.
    wrapperStyle = `position:relative;width:min(${savedWidth},100%);min-width:160px;max-width:min(640px,100%);resize:horizontal;overflow:hidden;padding-bottom:3px;${containerStyle || ''}`;
  } else {
    wrapperStyle = `width:100%;position:relative;${containerStyle || ''}`;
  }
  return `
    <div style="${wrapperStyle}" ${widthStorageKey ? `data-resize-key="${widthStorageKey}"` : ''}>
    <input type="text" id="${pickerId}-search" placeholder="${esc(placeholder || 'Search...')}" oninput="filterSearchPicker('${pickerId}', this.value)"
      onblur="setTimeout(()=>{const s=document.getElementById('${pickerId}'); if(s && document.activeElement!==s) collapseSearchPicker(s);}, 150)"
      style="width:100%;margin-bottom:3px;padding:5px 7px;border:1px solid var(--border);border-radius:4px;font-size:12px;box-sizing:border-box;">
    <select id="${pickerId}" style="width:100%;box-sizing:border-box;" ${selectAttrs || ''}>${renderOptions(selectedValue, records)}</select>
    <div id="${pickerId}-nomatch" class="muted" style="display:none;font-size:11px;margin-top:3px;">${esc(noMatchMessage || 'No matches found.')}</div>
    </div>`;
}
// Captures the width the user just dragged a resizable picker to, on every
// mouseup anywhere in the document rather than one bound to the wrapper
// itself - CSS `resize` applies the new size as UA-internal drag state, and
// a native resize gesture doesn't reliably bubble a 'mouseup' back to the
// element being resized (its target/bubbling path isn't the normal DOM
// click path), so an onmouseup attribute on the wrapper itself silently
// never fires. A document-level listener checking every `[data-resize-key]`
// element's current rendered size (cheap - there's only ever a couple
// visible at once) sidesteps that entirely.
document.addEventListener('mouseup', () => {
  document.querySelectorAll('[data-resize-key]').forEach(el => {
    const key = el.getAttribute('data-resize-key');
    const w = Math.round(el.getBoundingClientRect().width) + 'px';
    try { if (localStorage.getItem(key) !== w) localStorage.setItem(key, w); } catch (e) { /* ignore */ }
  });
});
// A collapsed native <select> only ever displays its currently-SELECTED
// option, never the first entry of a filtered list - so typing a search
// query alone looks like "nothing happened" until the user opens the
// dropdown. To make the filter visibly do something as you type, expand
// the select into an inline listbox (the `size` attribute) showing the
// matches. That taller listbox is floated as an absolutely-positioned
// overlay (rather than left to reflow inline) so it doesn't stretch the
// surrounding form-grid row taller and throw off every field beside it -
// exactly the misalignment a plain `size` attribute used to cause. It
// collapses back to a normal one-line dropdown (and drops the overlay
// styling) once an option is picked or focus leaves the picker.
function collapseSearchPicker(sel) {
  sel.removeAttribute('size');
  sel.style.position = ''; sel.style.zIndex = ''; sel.style.left = ''; sel.style.right = '';
  sel.style.top = ''; sel.style.width = ''; sel.style.background = ''; sel.style.boxShadow = ''; sel.style.border = '';
}
// Fixed (not absolute) positioning, computed from the input's own live
// bounding rect - a picker used inside a PR/PO line-items table sits inside
// tableHTML()'s own `overflow-x:auto` wrapper, which (per the CSS spec)
// implicitly clips the Y axis too once X is non-visible; an absolutely-
// positioned overlay relative to an ancestor inside that wrapper gets cut
// off at its bottom edge, which in practice landed right behind the
// "+ Add Line Item" button just past the table, masking the lower options.
// `position:fixed` escapes that clipping entirely (it isn't contained by
// any scrolling ancestor, only the viewport) - the one tradeoff is the
// overlay doesn't track the page if it's scrolled while still open, which
// collapseSearchPicker()'s on-blur/on-select close already limits to a
// narrow, rarely-hit window.
function expandSearchPicker(sel, optionCount) {
  // Anchor off the search <input> above this <select>, never the select
  // itself. Once expanded, the select is already position:fixed with a
  // multi-row `size` - re-measuring ITS OWN getBoundingClientRect() on the
  // next keystroke returns the bottom of the already-expanded dropdown, not
  // the original input's position, so using that as the next `top` walks
  // the dropdown further down the page with every character typed. The
  // input is never repositioned, so it's a stable anchor across keystrokes.
  const input = document.getElementById(sel.id + '-search');
  const rect = (input || sel).getBoundingClientRect();
  sel.setAttribute('size', Math.min(optionCount + 1, 6));
  sel.style.position = 'fixed'; sel.style.zIndex = '9999';
  sel.style.left = rect.left + 'px'; sel.style.width = rect.width + 'px'; sel.style.right = 'auto';
  sel.style.top = rect.bottom + 'px'; sel.style.background = '#fff'; sel.style.boxShadow = '0 4px 12px rgba(0,0,0,.18)';
  sel.style.border = '1px solid var(--border)';
}
window.filterSearchPicker = (pickerId, query) => {
  const st = SEARCH_PICKER_STATE[pickerId];
  const sel = document.getElementById(pickerId);
  if (!st || !sel) return;
  const q = query.trim().toLowerCase();
  const filtered = !q ? st.records : st.records.filter(r => st.matchFn(r, q));
  const currentValue = sel.value;
  sel.innerHTML = st.renderOptions(currentValue, filtered);
  if (currentValue && filtered.some(r => String(r.id) === String(currentValue))) sel.value = currentValue;
  if (q && filtered.length) expandSearchPicker(sel, filtered.length);
  else collapseSearchPicker(sel);
  // A zero-match search used to silently collapse to a blank one-row select,
  // indistinguishable from "search did nothing" - show an explicit note instead.
  const noMatchEl = document.getElementById(`${pickerId}-nomatch`);
  if (noMatchEl) noMatchEl.style.display = (q && !filtered.length) ? 'block' : 'none';
};
document.addEventListener('change', (e) => {
  if (e.target && e.target.tagName === 'SELECT' && SEARCH_PICKER_STATE[e.target.id]) collapseSearchPicker(e.target);
}, true);
document.addEventListener('blur', (e) => {
  if (e.target && e.target.tagName === 'SELECT' && SEARCH_PICKER_STATE[e.target.id]) collapseSearchPicker(e.target);
}, true);
// Clears a picker's search box and restores its full option list - used
// before programmatically setting a select's value (e.g. auto-filling the
// item from a picked PR line) so a leftover search filter can't hide the
// option being selected.
function resetSearchPicker(pickerId) {
  const searchEl = document.getElementById(`${pickerId}-search`);
  if (searchEl) searchEl.value = '';
  window.filterSearchPicker(pickerId, '');
}

// Thin Item Master-specific wrapper over the generic picker above - kept so
// every existing call site (Purchase Request/Order line items) doesn't need
// to know about matchFn/searchPickerHTML directly.
function itemPickerHTML(selectId, items, selectedId, renderOptions, selectAttrs) {
  return searchPickerHTML(selectId, items, selectedId, renderOptions,
    (i, q) => (i.name || '').toLowerCase().includes(q) || (i.item_code || '').toLowerCase().includes(q),
    selectAttrs, 'Search item...', '', 'erp_item_picker_width');
}
window.filterItemPicker = window.filterSearchPicker;
function resetItemPicker(selectId) { resetSearchPicker(selectId); }

// Project picker - searches by project code AND title, since a plain
// dropdown labeled only by code (see purchase-requests' pr-project) is hard
// to find by name once there are more than a handful of projects.
function projectOptions(selectedId, projects, placeholder) {
  return `<option value="">${esc(placeholder || '- General / Not Project-Specific -')}</option>` +
    projects.map(p => `<option value="${p.id}" ${selectedId && Number(selectedId) === p.id ? 'selected' : ''}>${esc(p.project_code)} - ${esc(p.client_name || 'No Customer')} - ${esc(p.title)}</option>`).join('');
}
function projectPickerHTML(pickerId, projects, selectedId, placeholder) {
  return searchPickerHTML(pickerId, projects, selectedId,
    (sel, list) => projectOptions(sel, list, placeholder),
    (p, q) => (p.project_code || '').toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q) || (p.client_name || '').toLowerCase().includes(q),
    '', 'Search project by code, customer, or title...');
}
// Indian States/UTs + their official GST state codes (as issued on GST
// registration certificates) - shared by every address form in the app
// (Client Bill-to/Ship-to, Vendor Master, Company Settings) so State is
// always picked from this one fixed list instead of free-typed, with State
// Code auto-filled from the pick rather than looked up by hand (2026-11-10).
const INDIAN_STATES = [
  ['Jammu and Kashmir', '01'], ['Himachal Pradesh', '02'], ['Punjab', '03'], ['Chandigarh', '04'],
  ['Uttarakhand', '05'], ['Haryana', '06'], ['Delhi', '07'], ['Rajasthan', '08'], ['Uttar Pradesh', '09'],
  ['Bihar', '10'], ['Sikkim', '11'], ['Arunachal Pradesh', '12'], ['Nagaland', '13'], ['Manipur', '14'],
  ['Mizoram', '15'], ['Tripura', '16'], ['Meghalaya', '17'], ['Assam', '18'], ['West Bengal', '19'],
  ['Jharkhand', '20'], ['Odisha', '21'], ['Chattisgarh', '22'], ['Madhya Pradesh', '23'], ['Gujarat', '24'],
  ['Daman and Diu', '25'], ['Dadra and Nagar Haveli', '26'], ['Maharashtra', '27'], ['Andhra Pradesh (Old)', '28'],
  ['Karnataka', '29'], ['Goa', '30'], ['Lakshadweep', '31'], ['Kerala', '32'], ['Tamil Nadu', '33'],
  ['Puducherry', '34'], ['Andaman and Nicobar Islands', '35'], ['Telangana', '36'], ['Andhra Pradesh', '37'],
  ['Ladakh', '38'], ['Other Territory', '97'], ['Centre Jurisdiction', '99'],
];
// A dropdown of INDIAN_STATES paired with a `${stateFieldId}-code` text
// input (kept editable, not locked, in case a rarer code needs overriding)
// that's auto-filled with the matching GST code on every State selection.
function statePickerHTML(stateFieldId, selectedState) {
  const match = INDIAN_STATES.find(([name]) => name.toLowerCase() === (selectedState || '').toLowerCase());
  return `<select id="${stateFieldId}" onchange="stateCodeAutofill('${stateFieldId}')">
      <option value="">-- select --</option>
      ${INDIAN_STATES.map(([name]) => `<option value="${esc(name)}" ${match && match[0]===name?'selected':''}>${esc(name)}</option>`).join('')}
    </select>`;
}
window.stateCodeAutofill = (stateFieldId) => {
  const name = val(stateFieldId);
  const match = INDIAN_STATES.find(([n]) => n === name);
  const codeEl = document.getElementById(stateFieldId + '-code');
  if (match && codeEl) codeEl.value = match[1];
};
// Client/customer picker - searches by name (clients have no separate code).
// Alphabetical (case-insensitive) regardless of the caller's own array order
// (2026-10-27) - every client picker in the app shares this one function, so
// sorting here covers all of them with no per-caller change.
function clientOptions(selectedId, clients, placeholder) {
  const sorted = [...clients].sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
  return `<option value="">${esc(placeholder || '- No customer -')}</option>` +
    sorted.map(c => `<option value="${c.id}" ${selectedId && Number(selectedId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}
function clientPickerHTML(pickerId, clients, selectedId, placeholder, selectAttrs) {
  return searchPickerHTML(pickerId, clients, selectedId,
    (sel, list) => clientOptions(sel, list, placeholder),
    (c, q) => (c.name || '').toLowerCase().includes(q),
    selectAttrs || '', 'Search customer by name...');
}
// Sales Order picker for the Generate Invoice form (2026-10-17) - the plain
// dropdown it replaces listed every order with no way to search it down.
// Matches on order #, client name, status, description, buyer GSTIN, and
// order date (all already on the GET /sales/orders row).
function salesOrderOptions(selectedId, orders) {
  return orders.map(o => `<option value="${o.id}" ${selectedId && Number(selectedId) === o.id ? 'selected' : ''}>${esc(o.order_no)} - ${esc(o.client_name)} (${esc(o.status)})${o.status === 'Invoiced' ? ' (already invoiced)' : ''}</option>`).join('');
}
function salesOrderPickerHTML(pickerId, orders, selectedId, selectAttrs) {
  return searchPickerHTML(pickerId, orders, selectedId,
    (sel, list) => salesOrderOptions(sel, list),
    (o, q) => (o.order_no || '').toLowerCase().includes(q) || (o.client_name || '').toLowerCase().includes(q) ||
      (o.status || '').toLowerCase().includes(q) || (o.description || '').toLowerCase().includes(q) ||
      (o.client_gstin || '').toLowerCase().includes(q) || (o.order_date || '').toLowerCase().includes(q),
    selectAttrs, 'Search by order #, client, status, description, GSTIN or date...');
}
// Employee picker for Users & Roles' Link/Change Link action (2026-10-08) -
// replaces a native prompt() that listed every employee without a login as
// plain numbered text, which Chrome doesn't let you scroll past a certain
// height, making anyone past the first ~20 entries unreachable.
function employeeOptions(selectedId, employees, placeholder) {
  return `<option value="">${esc(placeholder || '- No linked employee -')}</option>` +
    employees.map(e => `<option value="${e.id}" ${selectedId && Number(selectedId) === e.id ? 'selected' : ''}>${esc(e.employee_code || '')} - ${esc(e.full_name)}</option>`).join('');
}
function employeePickerHTML(pickerId, employees, selectedId, placeholder) {
  return searchPickerHTML(pickerId, employees, selectedId,
    (sel, list) => employeeOptions(sel, list, placeholder),
    (e, q) => (e.full_name || '').toLowerCase().includes(q) || (e.employee_code || '').toLowerCase().includes(q),
    '', 'Search employee by name or code...', '', '',
    'No unlinked employees match - they may already be linked to another login, or check the spelling.');
}

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
// Opens a fetched file either as an in-browser preview (PDFs, which every
// modern browser can render natively in a new tab) or as a forced download
// (anything else - .docx/.xlsx/.tar.gz have no in-browser viewer, so a
// preview attempt would just trigger the same save-as prompt anyway).
// A PDF offers the user an explicit choice - Preview (opens in a new tab,
// the browser's own viewer) or Download (the old forced-save behavior) -
// rather than deciding for them. Anything else (xlsx/tar.gz/.docx) has no
// in-browser viewer to offer a choice between, so it still just downloads.
let PENDING_DOC_PREVIEW = null;
function openOrDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  if (!(/\.pdf$/i.test(filename || '') || blob.type === 'application/pdf')) {
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    return;
  }
  PENDING_DOC_PREVIEW = { url, filename };
  openAppModal('Open Document', `
    <p class="muted">${esc(filename)}</p>
    <div style="display:flex;gap:10px;margin-top:14px;">
      <button class="btn" onclick="previewPendingDoc()">Preview (new tab)</button>
      <button class="btn outline" onclick="downloadPendingDoc()">Download</button>
    </div>
  `);
  setTimeout(() => { if (PENDING_DOC_PREVIEW && PENDING_DOC_PREVIEW.url === url) { URL.revokeObjectURL(url); PENDING_DOC_PREVIEW = null; } }, 120000);
}
window.previewPendingDoc = () => {
  if (PENDING_DOC_PREVIEW) window.open(PENDING_DOC_PREVIEW.url, '_blank');
  closeAppModal();
};
window.downloadPendingDoc = () => {
  if (PENDING_DOC_PREVIEW) {
    const a = document.createElement('a'); a.href = PENDING_DOC_PREVIEW.url; a.download = PENDING_DOC_PREVIEW.filename; a.click();
  }
  closeAppModal();
};
async function downloadTemplateFile(apiPath, filename) {
  try {
    const res = await fetch('/api' + apiPath, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not download template'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    openOrDownloadBlob(blob, match ? match[1] : filename);
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

// ---- Generic per-page panel drag-to-reorder ----
// Originally Dashboard-only (widget order); generalized so any page can let
// its user rearrange its top-level panels the same way, each page under its
// own page_key (see db/schema.sql's user_page_layout and routes/dashboard.js's
// /layout/:pageKey). `panelsObj` maps a stable panel key to that panel's
// already-rendered HTML - a falsy value (a conditional section with nothing
// to show this render, e.g. an empty review queue) is filtered out so it
// never claims a slot in the saved order or gets an empty drag handle.
async function fetchPanelOrder(pageKey, allKeys) {
  const layout = await api('/dashboard/layout/' + pageKey).catch(() => ({ panel_order: null }));
  return resolvePanelOrder(layout.panel_order, allKeys);
}
// A saved order might be missing a panel added since it was last saved
// (appended at the end, in its default position, so nothing new is ever
// hidden) or naming one that no longer exists (silently dropped).
function resolvePanelOrder(saved, allKeys) {
  if (!Array.isArray(saved) || !saved.length) return allKeys;
  const known = saved.filter(k => allKeys.includes(k));
  const missing = allKeys.filter(k => !known.includes(k));
  return [...known, ...missing];
}
// Dragging only happens inside an explicit "Edit Widget Layout" mode
// (2026-10-15) - before this, every panel on every one of these 11 pages
// was always draggable in place, so an accidental grab-and-drop during
// ordinary use (clicking near a panel header, a touch-scroll on mobile)
// could silently reorder the page. LAYOUT_EDIT_MODE is a plain in-memory,
// per-pageKey flag (same "resets on reload/new login, not persisted"
// philosophy as EXPANDED_NAV_GROUPS) - entering/leaving it goes through
// navigate(pageKey), the same full-page-rerender mechanism resetPanelOrder()
// already uses, so no call site of reorderablePanelsHTML() needs its own
// toggle plumbing.
let LAYOUT_EDIT_MODE = {};
function reorderablePanelsHTML(pageKey, panelsObj, order, labels) {
  const keys = order.filter(k => panelsObj[k]);
  const containerId = `reorder-${pageKey}`;
  const editing = !!LAYOUT_EDIT_MODE[pageKey];
  const editToggleBtn = `<button class="btn small outline" type="button" onclick="toggleLayoutEditMode('${pageKey}')">${editing ? 'Done Arranging' : 'Edit Widget Layout'}</button>`;
  if (!editing) {
    return `
      <div style="margin-bottom:8px;">${editToggleBtn}</div>
      <div id="${containerId}">${keys.map(k => `<div class="reorder-panel" data-key="${k}">${panelsObj[k]}</div>`).join('')}</div>`;
  }
  return `
    <div class="muted" style="margin-bottom:8px;">Drag a panel by its ⠿ handle to rearrange, then Save Layout.
      ${editToggleBtn}
      <button class="btn small outline" type="button" onclick="savePanelOrder('${pageKey}','${containerId}')" style="margin-left:8px;">Save Layout</button>
      <button class="btn small outline" type="button" onclick="resetPanelOrder('${pageKey}')">Reset to Default</button>
    </div>
    <div id="${containerId}">${keys.map(k => `
      <div class="reorder-panel" draggable="true" data-key="${k}"
        ondragstart="panelDragStart(event)" ondragover="panelDragOver(event,'${containerId}')" ondragend="panelDragEnd(event)">
        <div style="cursor:move;user-select:none;color:var(--muted,#888);font-size:12px;padding:2px 0 6px;">&#10021; ${esc((labels||{})[k] || k)}</div>
        ${panelsObj[k]}
      </div>`).join('')}</div>`;
}
window.toggleLayoutEditMode = (pageKey) => {
  LAYOUT_EDIT_MODE[pageKey] = !LAYOUT_EDIT_MODE[pageKey];
  navigate(pageKey);
};
let PANEL_DRAG_KEY = null;
window.panelDragStart = (e) => {
  PANEL_DRAG_KEY = e.currentTarget.dataset.key;
  e.currentTarget.style.opacity = '0.5';
  e.dataTransfer.effectAllowed = 'move';
};
window.panelDragEnd = (e) => { e.currentTarget.style.opacity = ''; PANEL_DRAG_KEY = null; };
window.panelDragOver = (e, containerId) => {
  e.preventDefault();
  const target = e.currentTarget;
  if (!PANEL_DRAG_KEY || target.dataset.key === PANEL_DRAG_KEY) return;
  const container = document.getElementById(containerId);
  const dragging = container.querySelector(`[data-key="${PANEL_DRAG_KEY}"]`);
  if (!dragging) return;
  const rect = target.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  container.insertBefore(dragging, before ? target : target.nextSibling);
};
window.savePanelOrder = async (pageKey, containerId) => {
  const order = Array.from(document.querySelectorAll(`#${containerId} .reorder-panel`)).map(w => w.dataset.key);
  try {
    await api('/dashboard/layout/' + pageKey, { method: 'PUT', body: JSON.stringify({ panel_order: order }) });
    alert('Layout saved.');
    LAYOUT_EDIT_MODE[pageKey] = false;
    navigate(pageKey);
  } catch (e) { alert(e.message); }
};
window.resetPanelOrder = async (pageKey) => {
  if (!confirm('Reset this page back to its default panel order?')) return;
  try {
    await api('/dashboard/layout/' + pageKey, { method: 'DELETE' });
    navigate(pageKey);
  } catch (e) { alert(e.message); }
};

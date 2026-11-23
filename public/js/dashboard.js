// dashboard.js - Dashboard, stat drill-downs, custom metrics, Department/Time & Motion reports,
// Vendor Analytics widget, To-Do board.

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
    fetchValue: async () => (await api('/service')).filter(r => !['Resolved','Closed','Rejected'].includes(r.status)).length,
    buildDetail: async () => { const reqs = (await api('/service')).filter(r => !['Resolved','Closed','Rejected'].includes(r.status)); return `<h3>Open Service Requests (${reqs.length})</h3>${tableHTML(['SR No','Customer','Status'], reqs, r => `<tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${badge(r.status)}</td></tr>`)}`; } },
  { key: 'hr_pending_leave', label: 'HR: Pending Leave Requests', department: 'HR/Payroll',
    fetchValue: async () => (await api('/hr/leave-requests')).filter(r => r.status === 'Pending').length,
    buildDetail: async () => { const reqs = (await api('/hr/leave-requests')).filter(r => r.status === 'Pending'); return `<h3>Pending Leave Requests (${reqs.length})</h3>${tableHTML(['Employee','Leave Type','From','To'], reqs, r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.leave_type_name)}</td><td>${r.from_date}</td><td>${r.to_date}</td></tr>`)}`; } },
  { key: 'finance_outflow_month', label: 'Finance: Total Outflow (This Month)', department: 'Finance',
    fetchValue: async () => { const s = await api('/finance/summary?month=' + thisMonth()); return '₹' + fmt(s.outflow); },
    buildDetail: async () => { const month = thisMonth(); const { from, to } = monthRange(month); const s = await api('/finance/summary?month=' + month); const ledger = (await api(`/finance/ledger?from=${from}&to=${to}`)).filter(l => l.direction === 'Outflow'); return `<h3>Total Outflow (${esc(month)}): ₹${fmt(s.outflow)}</h3>${tableHTML(['Date','Type','Department','Amount'], ledger.slice(0,100), l => `<tr><td>${new Date(l.entry_date).toLocaleDateString()}</td><td>${esc(l.type)}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td></tr>`)}`; } },
  { key: 'finance_inflow_month', label: 'Finance: Total Inflow (This Month)', department: 'Finance',
    fetchValue: async () => { const s = await api('/finance/summary?month=' + thisMonth()); return '₹' + fmt(s.inflow); },
    buildDetail: async () => { const month = thisMonth(); const { from, to } = monthRange(month); const s = await api('/finance/summary?month=' + month); const ledger = (await api(`/finance/ledger?from=${from}&to=${to}`)).filter(l => l.direction === 'Inflow'); return `<h3>Total Inflow (${esc(month)}): ₹${fmt(s.inflow)}</h3>${tableHTML(['Date','Type','Department','Amount'], ledger.slice(0,100), l => `<tr><td>${new Date(l.entry_date).toLocaleDateString()}</td><td>${esc(l.type)}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td></tr>`)}`; } },
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
    fetchValue: async () => (await api('/projects')).filter(p => p.status !== 'Completed' && !p.is_dispatched).length,
    buildDetail: async () => { const projects = (await api('/projects')).filter(p => p.status !== 'Completed' && !p.is_dispatched); return `<h3>Active Projects (${projects.length})</h3>${tableHTML(['Code','Title','Status'], projects, p => `<tr><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${badge(p.status)}</td></tr>`)}`; } },
  { key: 'tickets_open_mine', label: 'Tickets: My Open Tickets', department: 'Tickets',
    fetchValue: async () => { try { return (await api('/tickets/mine')).filter(t => !['Closed','Resolved'].includes(t.status)).length; } catch (e) { return '-'; } },
    buildDetail: async () => { const tk = (await api('/tickets/mine')).filter(t => !['Closed','Resolved'].includes(t.status)); return `<h3>My Open Tickets (${tk.length})</h3>${tableHTML(['Ticket No','Subject','Priority','Status'], tk, t => `<tr><td>${esc(t.ticket_no)}</td><td>${esc(t.subject)}</td><td>${esc(t.priority)}</td><td>${badge(t.status)}</td></tr>`)}`; } },
  // TODO: Service Center stock module metrics (service_centers / service_center_stock
  // etc.) once that module lands - skipped here as it's a separate concurrent task.
];
function dashboardMetricRegistryByKey(key) { return DASHBOARD_METRIC_REGISTRY.find(m => m.key === key); }


// ---- Dashboard charts (Chart.js, loaded on demand) ----
// shortcut: Chart.js comes from a CDN, so charts are skipped (with a notice) when
// the server has no internet; vendor it under public/js/vendor/ to run offline.
function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (!window.__CHARTJS_PROMISE) {
    window.__CHARTJS_PROMISE = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
      s.onload = () => resolve(window.Chart);
      s.onerror = () => { window.__CHARTJS_PROMISE = null; reject(new Error('Chart.js could not be loaded')); };
      document.head.appendChild(s);
    });
  }
  return window.__CHARTJS_PROMISE;
}
const CHART_COLORS = ['#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#c62828', '#00838f', '#546e7a'];
async function renderDashboardCharts(d, ws) {
  const msg = document.getElementById('chart-msg');
  let Chart;
  try { Chart = await loadChartJs(); } catch (e) {
    if (msg) msg.innerHTML = `<p class="muted">Charts unavailable: ${esc(e.message)}. The tables above still show the same data.</p>`;
    return;
  }
  // Re-navigating rebuilds the canvases; free the old chart instances first.
  (window.__DASH_CHARTS || []).forEach(ch => ch.destroy());
  window.__DASH_CHARTS = [];
  const mk = (id, type, data, extra) => {
    const cv = document.getElementById(id);
    if (!cv) return; // user navigated away while Chart.js was loading
    if (!data.datasets[0].data.some(v => Number(v) > 0)) {
      cv.parentElement.innerHTML = '<p class="muted">No data yet.</p>';
      return;
    }
    window.__DASH_CHARTS.push(new Chart(cv, {
      type, data,
      options: Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }, extra),
    }));
  };
  const byMode = {};
  d.expenseByMode.forEach(r => { byMode[r.payment_mode] = (byMode[r.payment_mode] || 0) + Number(r.total || 0); });
  mk('chart-expense-mode', 'doughnut', {
    labels: Object.keys(byMode),
    datasets: [{ data: Object.values(byMode), backgroundColor: CHART_COLORS }],
  });
  const c = d.counts;
  const open = [['Projects', c.projects_active], ['Leads', c.open_leads], ['Expense Vouchers', c.pending_expense_vouchers],
    ['Leave', c.pending_leave], ['Purchase Req.', c.pending_purchase_requests], ['Low Stock', c.low_stock_items], ['Service', c.open_service_requests]];
  mk('chart-open-items', 'bar', {
    labels: open.map(o => o[0]),
    datasets: [{ data: open.map(o => o[1]), backgroundColor: CHART_COLORS[0] }],
  }, { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } });
  mk('chart-stock', 'bar', {
    labels: ['Stock In', 'Stock Out'],
    datasets: [{ data: [ws.stockIn, ws.stockOut], backgroundColor: [CHART_COLORS[1], CHART_COLORS[4]] }],
  }, { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } });
}

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
      // A project already fully Dispatched has physically shipped - excluded
      // the same way routes/dashboard.js's own projects_active count already
      // is, so the drill-down list under the stat tile can't disagree with
      // the tile's own number.
      const projects = (await api('/projects')).filter(p => p.status !== 'Completed' && !p.is_dispatched);
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
      // Rejected is a terminal, closed-out state same as Resolved/Closed -
      // matches routes/dashboard.js's own projects_active exclusion, so the
      // tile's number and this drill-down list can't disagree.
      const reqs = (await api('/service')).filter(r => !['Resolved','Closed','Rejected'].includes(r.status));
      const byStatus = {};
      reqs.forEach(r => { byStatus[r.status] = (byStatus[r.status]||0) + 1; });
      return `<h3>Open Service Requests (${reqs.length})</h3>
        <p class="muted">Breakdown by status</p>
        ${breakdownBars(byStatus)}
        ${tableHTML(['SR No','Customer','Issue','Assigned To','Status','Open (days)'], reqs, r => `
          <tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name)||esc(r.customer_name)||'-'}</td><td>${esc(r.issue_description)||'-'}</td><td>${esc(r.assigned_to_name)||'-'}</td><td>${badge(r.status)}</td><td>${daysSince(r.created_at)}</td></tr>`)}`;
    },
    stock_in: async () => {
      // Matches routes/dashboard.js's own window-summary `since` math exactly,
      // so the header's "(window)" label, the ws.stockIn total it was already
      // showing, and this row list all agree - the list previously showed
      // every movement ever recorded regardless of the selected window.
      const since = windowSinceDate(win);
      const moves = (await api('/purchase/store/movements')).filter(m => m.movement_type === 'IN' && m.moved_at >= since);
      return `<h3>Stock In (${win}) - ${moves.length} movements, ${fmt(ws.stockIn)} units</h3>
        ${tableHTML(['Date','Item','Qty','Ref'], moves.slice(0,100), m => `<tr><td>${esc(m.moved_at)}</td><td>${esc(m.item_name)||m.item_id}</td><td>${fmt(m.quantity)}</td><td>${esc(m.po_no || m.project_code || m.reference)||'-'}</td></tr>`)}`;
    },
    stock_out: async () => {
      const since = windowSinceDate(win);
      const moves = (await api('/purchase/store/movements')).filter(m => m.movement_type === 'OUT' && m.moved_at >= since);
      return `<h3>Stock Out (${win}) - ${moves.length} movements, ${fmt(ws.stockOut)} units</h3>
        ${tableHTML(['Date','Item','Qty','Ref'], moves.slice(0,100), m => `<tr><td>${esc(m.moved_at)}</td><td>${esc(m.item_name)||m.item_id}</td><td>${fmt(m.quantity)}</td><td>${esc(m.po_no || m.project_code || m.reference)||'-'}</td></tr>`)}`;
    },
    opex: async () => {
      // d.expenseByMode is a wholly different, all-time, unscoped metric
      // (Expense Vouchers by payment mode - routes/dashboard.js's own
      // GET /summary) - it doesn't total to ws.opex (routes/dashboard.js's
      // window-scoped SUM of finance_ledger type='Expense' entries) and
      // was never actually the breakdown of the figure shown above it.
      // Query the same ledger rows ws.opex is itself computed from instead,
      // so the header total and the list beneath it genuinely agree.
      const since = windowSinceDate(win);
      const ledger = await api(`/finance/ledger?type=Expense&from=${since}&to=${today()}`);
      return `<h3>Operating Expenses (${win})</h3>
        <p class="muted">Total: <b>₹${fmt(ws.opex)}</b></p>
        ${tableHTML(['Date','Department','Amount'], ledger.slice(0,100), l => `<tr><td>${new Date(l.entry_date).toLocaleDateString()}</td><td>${esc(l.department_name)||'-'}</td><td>₹${fmt(l.amount)}</td></tr>`)}`;
    },
  };
  // Each top-level widget below is independently draggable (Dashboard
  // layout customization) - grouped by what has to stay physically
  // together (e.g. the stat cards and their own drill-down/follow-ups
  // widget), not one group per literal <div class="panel">.
  const panels = {
    keyMetrics: `
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
      <div id="dash-vendor-analytics-widget"></div>
      <div id="dash-followups-widget"></div>
    `,
    customMetrics: `
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
    `,
    expensesByMode: `
      <div class="panel">
        <h3>Expenses by Payment Mode / Accounted Status</h3>
        ${tableHTML(['Payment Mode', 'Accounted', 'Total'], d.expenseByMode, r => `<tr><td>${esc(r.payment_mode)}</td><td>${esc(r.accounted)}</td><td>₹${fmt(r.total)}</td></tr>`)}
      </div>
    `,
    charts: `
      <div class="panel">
        <h3>Charts</h3>
        <div class="chart-grid">
          <div class="chart-box"><h4>Expenses by Payment Mode</h4><div class="chart-wrap"><canvas id="chart-expense-mode"></canvas></div></div>
          <div class="chart-box"><h4>Open Work Items</h4><div class="chart-wrap"><canvas id="chart-open-items"></canvas></div></div>
          <div class="chart-box"><h4>Stock Movement (${esc(win)})</h4><div class="chart-wrap"><canvas id="chart-stock"></canvas></div></div>
        </div>
        <div id="chart-msg"></div>
      </div>
    `,
    inventoryOpex: `
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
    `,
    projectDrilldown: `
      <div class="panel">
        <h3>Project Drill-Down</h3>
        <div class="form-grid"><div><label>Project</label><select id="dash-proj-select" onchange="loadProjectDrilldown(this.value)">
          <option value="">Select a project...</option>${projects.map(p => `<option value="${p.id}">${esc(p.project_code)} - ${esc(p.title)}</option>`).join('')}
        </select></div></div>
        <div id="dash-drilldown"></div>
      </div>
    `,
  };
  const order = await fetchPanelOrder('dashboard', Object.keys(panels));
  el.innerHTML = reorderablePanelsHTML('dashboard', panels, order, DASHBOARD_WIDGET_LABELS);
  document.getElementById('dash-followups-widget').innerHTML = await dashboardFollowupsWidgetHTML();
  // Not awaited: a slow or failing analytics call must never hold up the rest of the dashboard.
  loadVendorAnalyticsWidget();
  await renderDashboardCustomMetrics();
  renderDashboardCharts(d, ws);
};

const DASHBOARD_WIDGET_LABELS = {
  keyMetrics: 'Key Metrics', customMetrics: 'Custom Metrics', expensesByMode: 'Expenses by Payment Mode', charts: 'Charts',
  inventoryOpex: 'Inventory / Opex / Upcoming Schedules', projectDrilldown: 'Project Drill-Down',
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
  const jcCols = ['Project', 'Customer', 'Item', 'Target Completion', 'Status', 'Days in Stage', 'Delayed'];
  const jcRow = c => `<tr><td>${esc(c.project_code)} - ${esc(c.project_title)}</td><td>${esc(c.client_name)||'-'}</td><td>${esc(c.title || STAGE_LABELS[c.stage] || c.stage)}</td><td>${c.planned_end || '-'}</td><td>${badge(c.status)}</td><td>${c.days_in_stage}</td><td>${c.delayed?'⚠️ Yes':'-'}</td></tr>`;
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

// ---- Vendor Development Analytics (dashboard) ----
function canSeeVendorAnalytics() {
  return has('purchase_order.manage') && (!ALLOWED_PAGES || ALLOWED_PAGES.has('purchase-orders'));
}
function renderVendorAnalyticsWidgetHTML(data) {
  const card = (label, n, color) => `<div style="flex:1 1 200px;min-width:0;border:1px solid var(--border,#ddd);border-left:4px solid ${color};border-radius:6px;padding:12px 14px;">
      <div class="muted" style="font-size:12px;">${label}</div>
      <div style="font-size:28px;font-weight:700;color:${color};">${n}</div></div>`;
  return `<div class="panel">
    <div class="toolbar"><h3 style="margin:0;">Vendor Development (${data.totalTracked} tracked)</h3></div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;">
      ${card('Onboarded Vendors', data.onboardedCount, '#1a7f37')}
      ${card('Vendors in Development', data.developingCount, '#1f6feb')}
    </div></div>`;
}
async function loadVendorAnalyticsWidget() {
  const box = document.getElementById('dash-vendor-analytics-widget');
  if (!box || !canSeeVendorAnalytics()) return;
  try {
    const data = await api('/purchase/dashboard/vendor-analytics');
    if (data && data.success) box.innerHTML = renderVendorAnalyticsWidgetHTML(data);
  } catch (e) { box.innerHTML = ''; }
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

// ===================== To-Do List =====================
// Logging a To-Do (handing an action item to someone, against a department
// HOD) is restricted to HODs/Admin - see routes/todos.js `canLog()`. Below
// that, "My To-Do List" and the old "All To-Dos Logged" oversight panel have
// been merged into a single Kanban-style board, one column per department
// (the HOD's department - see routes/todos.js's `visibleTodosWhere()`),
// since both panels were already querying the exact same row set for every
// non-Admin/Management user - there was nothing left to show separately.
// Column bodies, and the Closed section at the bottom, are never fetched on
// page load - only board-summary (counts + oldest-pending date, no item
// rows) loads eagerly; see toggleTodoColumnBody()/toggleClosedTodos() below.
const TODO_STATUSES = ['Pending', 'InProgress', 'Completed', 'OnHold'];
const TODO_BOARD_PAGE_KEY = 'todos-board';
function todoDeptKey(d) { return d.department_id == null ? 'unassigned' : 'dept_' + d.department_id; }
// Same "known entries kept in order, missing ones appended, unrecognized
// ones dropped" rule as resolvePanelOrder() - extended with a leading '!' on
// an entry to mean "hidden", since /dashboard/layout/:pageKey only stores an
// opaque array of strings and a prefix is simplest way to carry that second
// bit of per-user state through the exact same endpoint rather than adding a
// new one.
function resolveTodoColumnLayout(saved, allKeys) {
  if (!Array.isArray(saved) || !saved.length) return { order: allKeys, hidden: new Set() };
  const hidden = new Set(); const known = [];
  saved.forEach(raw => {
    const isHidden = typeof raw === 'string' && raw.startsWith('!');
    const key = isHidden ? raw.slice(1) : raw;
    if (!allKeys.includes(key) || known.includes(key)) return;
    known.push(key);
    if (isHidden) hidden.add(key);
  });
  const missing = allKeys.filter(k => !known.includes(k));
  return { order: [...known, ...missing], hidden };
}
PAGES['todos'] = async (el) => {
  const [people, board, layout] = await Promise.all([
    api('/todos/people'), api('/todos/board-summary'),
    api('/dashboard/layout/' + TODO_BOARD_PAGE_KEY).catch(() => ({ panel_order: null })),
  ]);
  const canLog = people.can_log;
  const personLabel = p => `${esc(p.full_name)}${p.department ? ' (' + esc(p.department) + ')' : ''}`;
  const hodOptions = people.hods.map(h => `<option value="${h.id}">${personLabel(h)}</option>`).join('');
  const assigneeOptions = people.assignees.map(a => `<option value="${a.id}">${personLabel(a)}</option>`).join('');
  const allKeys = board.departments.map(todoDeptKey);
  const { order, hidden } = resolveTodoColumnLayout(layout.panel_order, allKeys);
  window.__TODO_BOARD = { departments: board.departments, order, hidden, canLog };

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

    <div class="panel">
      <h3 style="display:flex;justify-content:space-between;align-items:center;">
        <span>To-Do Board</span>
        <button class="btn small outline" type="button" onclick="toggleTodoColumnManager()">Customize Columns</button>
      </h3>
      <p class="muted">Grouped by the department it's logged against. Click a column's header to load its items.</p>
      <div id="todo-col-manager" style="display:none;">${renderTodoColumnManager()}</div>
      <div id="todo-board-wrap">${renderTodoBoardColumns()}</div>
    </div>

    <div class="closed-section">${renderClosedStrip(board.total_closed)}</div>
  `;
};
function renderTodoColumnManager() {
  const { departments, order, hidden } = window.__TODO_BOARD;
  return `
    <div class="muted todo-col-manager-hint">Drag by the handle to reorder, uncheck to hide a column, then Save.
      <button class="btn small outline" type="button" onclick="saveTodoColumnLayout()">Save</button>
      <button class="btn small outline" type="button" onclick="resetTodoColumnLayout()">Reset to Default</button>
    </div>
    <div id="todo-col-manager-list">
      ${order.map(key => {
        const d = departments.find(x => todoDeptKey(x) === key);
        if (!d) return '';
        const isHidden = hidden.has(key);
        return `<div class="reorder-panel" draggable="true" data-key="${key}"
          ondragstart="panelDragStart(event)" ondragover="panelDragOver(event,'todo-col-manager-list')" ondragend="panelDragEnd(event)"
          class="todo-column-item">
          <span style="cursor:move;color:var(--muted);">&#10021;</span>
          <label style="flex:1;margin:0;display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" ${isHidden ? '' : 'checked'} onchange="toggleTodoColumnHidden('${key}', this.checked)"> ${esc(d.department_name)}
          </label>
        </div>`;
      }).join('')}
    </div>`;
}
window.toggleTodoColumnManager = () => {
  const panel = document.getElementById('todo-col-manager');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};
window.toggleTodoColumnHidden = (key, checked) => {
  if (checked) window.__TODO_BOARD.hidden.delete(key); else window.__TODO_BOARD.hidden.add(key);
};
window.saveTodoColumnLayout = async () => {
  const keys = Array.from(document.querySelectorAll('#todo-col-manager-list .reorder-panel')).map(w => w.dataset.key);
  const hidden = window.__TODO_BOARD.hidden;
  const encoded = keys.map(k => hidden.has(k) ? '!' + k : k);
  try {
    await api('/dashboard/layout/' + TODO_BOARD_PAGE_KEY, { method: 'PUT', body: JSON.stringify({ panel_order: encoded }) });
    navigate('todos');
  } catch (e) { alert(e.message); }
};
window.resetTodoColumnLayout = async () => {
  if (!confirm('Reset column order/visibility back to default?')) return;
  try { await api('/dashboard/layout/' + TODO_BOARD_PAGE_KEY, { method: 'DELETE' }); navigate('todos'); }
  catch (e) { alert(e.message); }
};
function todoSlaLine(oldest) {
  if (!oldest) return '<div class="sla-line ok">No pending items</div>';
  const days = Math.round((new Date(oldest.target_date) - new Date(today())) / 86400000);
  let cls = 'ok', label = oldest.target_date;
  if (days < 0) { cls = 'breach'; label = `${oldest.target_date} (overdue ${-days}d)`; }
  else if (days <= 7) { cls = 'warn'; label = `${oldest.target_date} (due in ${days}d)`; }
  return `<div class="sla-line ${cls}">Oldest pending: ${esc(label)}</div>`;
}
function renderTodoBoardColumns() {
  const { departments, order, hidden } = window.__TODO_BOARD;
  const visible = order.filter(k => !hidden.has(k));
  if (!visible.length) return '<div class="empty">Every column is hidden - use Customize Columns to show one.</div>';
  return `<div class="board">${visible.map(key => {
    const d = departments.find(x => todoDeptKey(x) === key);
    return d ? renderTodoColumn(key, d) : '';
  }).join('')}</div>`;
}
function renderTodoColumn(key, d) {
  return `
    <div class="board-col" data-key="${key}">
      <div class="board-col-head" onclick="toggleTodoColumnBody('${key}')">
        <div class="dept-name">${esc(d.department_name)} <span class="chev">&#9654;</span></div>
        <div class="stat-row"><span class="pending-count">${d.pending_count}</span><span class="pending-label">pending</span></div>
        ${todoSlaLine(d.oldest_pending)}
      </div>
      <div class="board-col-body collapsed" id="todo-col-body-${key}"><div class="placeholder">Collapsed - click header to load items</div></div>
    </div>`;
}
window.toggleTodoColumnBody = async (key) => {
  const body = document.getElementById('todo-col-body-' + key);
  const wasCollapsed = body.classList.contains('collapsed');
  body.classList.toggle('collapsed');
  const chev = body.previousElementSibling.querySelector('.chev');
  if (chev) chev.innerHTML = wasCollapsed ? '&#9660;' : '&#9654;';
  if (!wasCollapsed || body.dataset.built) return;
  body.dataset.built = '1';
  body.innerHTML = '<div class="muted" style="padding:10px;">Loading...</div>';
  try {
    const deptParam = key === 'unassigned' ? 'unassigned' : key.replace('dept_', '');
    const items = await api('/todos/board-items?department_id=' + encodeURIComponent(deptParam));
    body.innerHTML = renderTodoCards(items);
  } catch (e) { body.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};
function renderTodoCards(items) {
  const canLog = window.__TODO_BOARD.canLog;
  if (!items.length) return '<div class="placeholder">No items.</div>';
  return items.map(t => `
    <div class="todo-card${t.priority === 'High' ? ' high' : ''}">
      <div class="title">${t.priority === 'High' ? '<span class="badge Rejected" style="margin-right:4px;">HIGH</span>' : ''}${esc(t.brief_description)}</div>
      ${t.details ? `<div class="muted todo-card-details">${esc(t.details)}</div>` : ''}
      <div class="muted todo-card-meta">HOD: ${esc(t.hod_name) || '-'} &middot; ${esc(t.assigned_to_name)}${t.is_mine ? '' : ' (dept)'}</div>
      <div class="meta">${deliveryBadge(t.target_date)}
        ${(t.is_mine || canLog) && t.status !== 'PendingReview' && t.status !== 'InfoRequested' ? `<select onchange="updateTodoStatus(${t.id}, this.value)">
          ${TODO_STATUSES.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>` : badge(t.status)}
      </div>
      ${t.status === 'InfoRequested' && t.info_requested_note ? `<div class="muted todo-card-info">More info requested${t.info_requested_by_name ? ' by ' + esc(t.info_requested_by_name) : ''}: ${esc(t.info_requested_note)}</div>` : ''}
      <div class="todo-card-actions">
        <button class="btn small outline" type="button" onclick="toggleTodoUpdates(${t.id})">Updates</button>
        ${t.status === 'InfoRequested' && (t.is_mine || canLog) ? `<button class="btn small outline" type="button" onclick="provideInfoTodo(${t.id}, ${t.approval_id})">Provide Info</button>` : ''}
        ${canLog ? `<button class="btn small outline" onclick="deleteTodo(${t.id})">Delete</button>` : ''}
      </div>
      <div id="todo-updates-row-${t.id}" style="display:none;"><div id="todo-updates-${t.id}"></div></div>
    </div>`).join('');
}
function renderClosedStrip(totalClosed) {
  return `
    <div class="closed-head" onclick="toggleClosedTodos()">
      <div><h3>Closed (${totalClosed})</h3><div class="closed-note">Completed To-Dos - not loaded until opened</div></div>
      <span class="chev" id="todo-closed-chev">&#9654;</span>
    </div>
    <div class="board-col-body collapsed todo-closed-body" id="todo-closed-body"></div>`;
}
window.toggleClosedTodos = async () => {
  const body = document.getElementById('todo-closed-body');
  const chev = document.getElementById('todo-closed-chev');
  const wasCollapsed = body.classList.contains('collapsed');
  body.classList.toggle('collapsed');
  chev.innerHTML = wasCollapsed ? '&#9660;' : '&#9654;';
  if (!wasCollapsed || body.dataset.built) return;
  body.dataset.built = '1';
  body.innerHTML = '<div class="muted" style="padding:10px;">Loading...</div>';
  try {
    const items = await api('/todos/board-items?closed=1');
    body.innerHTML = renderClosedTable(items);
  } catch (e) { body.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};
function renderClosedTable(items) {
  return tableHTML(['Action / Details', 'HOD', 'Assigned To', 'Target Date', 'Status', ''], items, t => `
    <tr><td>${esc(t.brief_description)}${t.details ? `<div class="muted todo-card-details">${esc(t.details)}</div>` : ''}</td>
    <td>${esc(t.hod_name) || '-'}</td><td>${esc(t.assigned_to_name)}</td><td>${t.target_date || '-'}</td>
    <td>${badge(t.status)}</td>
    <td><button class="btn small outline" type="button" onclick="toggleTodoUpdates(${t.id})">Updates</button></td></tr>
    <tr id="todo-updates-row-${t.id}" style="display:none;"><td colspan="6"><div id="todo-updates-${t.id}"></div></td></tr>`);
}
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
    <div class="panel todo-updates-panel">
      ${updates.length ? updates.map(u => `
        <div class="todo-update-item">
          <b>${esc(u.user_name) || 'System'}</b> <span class="muted">${new Date(u.created_at).toLocaleString()}</span>
          ${u.status_at_update ? badge(u.status_at_update) : ''}
          <div>${esc(u.note)}</div>
        </div>`).join('') : '<div class="muted">No updates logged yet.</div>'}
      <div class="todo-update-actions">
        <input id="todo-update-note-${id}" placeholder="Add an update..." class="todo-update-input">
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
// Answers Management's "more info" question on a To-Do completion review -
// mirrors provideInfoPR() (the one other place in this app with a working
// InfoRequested resolution path). Resumes the SAME TodoCompletion approval
// at the same step, same as PR's own flow - the To-Do doesn't need to be
// marked Completed again.
window.provideInfoTodo = async (id, approvalId) => {
  const comment = prompt('Response to the reviewer (optional):');
  try {
    await api(`/approvals/${approvalId}/provide-info`, { method: 'POST', body: JSON.stringify({ comment }) });
    navigate('todos');
  } catch (e) { alert(e.message); }
};
window.deleteTodo = async (id) => {
  if (!confirm('Delete this To-Do?')) return;
  try { await api('/todos/' + id, { method: 'DELETE' }); navigate('todos'); }
  catch (e) { alert(e.message); }
};

// projects.js - Projects, Targets, Department Capacity, Job Cards.

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
// ---- Project Detail: pipeline with nested sub-processes / ad-hoc sub-assemblies ----
// Each top-level department card renders as its own row, with its children
// (the department's own defined sub-processes plus any HOD-created ad-hoc
// sub-assemblies) nested underneath as indented child rows, collapsed by
// default behind an explicit expand control - the same grouped-row shape
// groupJobCardRows() already gives the Job Cards boards, applied here
// straight from the server's parent/children payload.
//
// Which buttons a row gets is decided ENTIRELY by the server's per-card
// eligibility payload (can_act + actions.start/complete/hold, each with the
// server's own blocked reason + one-line summary, computed next to PATCH
// /job-cards/:id's own gates in routes/projects.js) - the hand-over chain,
// the PO-terms gate and the parent's open-children check only exist
// server-side, so this view never guesses: a blocked action renders
// disabled, with the server's full reason as its tooltip and the summary
// shown inline under the buttons (2026-10-20).
let PJ_VIEW = null; // { id, code, expanded:Set } - pipeline currently open on the Projects page
const pjTimestamp = t => t ? new Date(t).toLocaleString() : '-';
// Planned window (start -> end) when both ends were planned in the Targets
// sheet, otherwise whichever single end exists - older cards only ever got
// a planned_end, so don't invent a start for them.
function pjWindowCell(c) {
  const start = c.planned_start ? esc(String(c.planned_start).slice(0, 10)) : '';
  const end = c.planned_end ? esc(String(c.planned_end).slice(0, 10)) : '';
  if (start && end) return `<td>${start} &rarr; ${end}</td>`;
  return `<td>${end || start || '-'}</td>`;
}
function pjActionsCell(c) {
  const openBtn = `<button class="btn small outline" onclick="openJobCardDetail(${c.id})">Open</button>`;
  if (c.status === 'Completed') return actionButtonsCell(openBtn);
  if (!c.can_act) return actionButtonsCell(openBtn) + ' <span class="muted">Not assigned to you</span>';
  const next = c.status === 'Pending' ? 'InProgress' : 'Completed';
  const label = next === 'InProgress' ? 'Start Work' : 'Complete Work';
  const main = c.actions[next === 'InProgress' ? 'start' : 'complete'];
  const hold = c.actions.hold;
  const mainBtn = main.allowed
    ? `<button class="btn small green" onclick="pjAdvanceJobCard(${c.id}, '${next}')">${label}</button>`
    : `<button class="btn small green" disabled title="${esc(main.blocked_reason || '')}" aria-label="${esc(label)}: ${esc(main.blocked_reason || '')}">${label}</button>`;
  const holdBtn = hold.allowed
    ? `<button class="btn small outline" onclick="pjHoldJobCard(${c.id})">Hold</button>`
    : `<button class="btn small outline" disabled title="${esc(hold.blocked_reason || '')}" aria-label="Hold: ${esc(hold.blocked_reason || '')}">Hold</button>`;
  const blocker = !main.allowed ? main : (!hold.allowed ? hold : null);
  const note = blocker ? `<div class="pj-blocked" title="${esc(blocker.blocked_reason || '')}">${esc(blocker.blocked_summary || '')}</div>` : '';
  return actionButtonsCell(openBtn + mainBtn + holdBtn) + note;
}
window.toggleProjectCardGroup = (parentId) => {
  const rows = document.querySelectorAll('.pj-child-row-' + parentId);
  const showing = rows.length && rows[0].style.display !== 'none';
  rows.forEach(r => { r.style.display = showing ? 'none' : ''; });
  const link = document.getElementById('pj-group-toggle-' + parentId);
  if (link) link.textContent = (showing ? '▸ ' : '▾ ') + link.dataset.label;
  // Remember the expansion across the in-place re-render that follows a
  // Start/Complete/Hold, so acting on a card doesn't fold everything shut.
  if (PJ_VIEW) { if (showing) PJ_VIEW.expanded.delete(parentId); else PJ_VIEW.expanded.add(parentId); }
};
function pjChildRowHTML(ch, parentId) {
  const expanded = !!(PJ_VIEW && PJ_VIEW.expanded.has(parentId));
  const kind = ch.is_adhoc ? 'ad-hoc sub-assembly' : 'sub-process';
  const dur = ch.duration_days ? ` · ${ch.duration_days}d` : '';
  return `<tr class="pj-child-row pj-child-row-${parentId}" style="${expanded ? '' : 'display:none;'}">
    <td><span class="muted">&#8627;</span> ${esc(ch.title || STAGE_LABELS[ch.stage] || ch.stage)} <span class="pj-meta">(${kind}${dur})</span></td>
    ${pjWindowCell(ch)}
    <td>${badge(ch.status)}</td>
    <td>${esc(ch.assigned_to_name) || '<span class="muted">Not allocated</span>'}</td>
    <td>${pjTimestamp(ch.allocated_at)}</td>
    <td>${pjTimestamp(ch.started_at)}</td>
    <td>${pjTimestamp(ch.completed_at)}</td>
    <td>${esc(ch.notes) || ''}</td>
    <td>${pjActionsCell(ch)}</td>
  </tr>`;
}
function pjParentRowHTML(c, children) {
  const n = children.length;
  const kindWord = !n ? ''
    : children.every(ch => ch.is_adhoc) ? (n === 1 ? 'sub-assembly' : 'sub-assemblies')
      : children.every(ch => !ch.is_adhoc) ? (n === 1 ? 'sub-process' : 'sub-processes')
        : (n === 1 ? 'sub-item' : 'sub-items');
  const expanded = !!(PJ_VIEW && PJ_VIEW.expanded.has(c.id));
  const toggle = n ? ` <a href="#" id="pj-group-toggle-${c.id}" data-label="${n} ${kindWord}" onclick="toggleProjectCardGroup(${c.id});return false;" class="muted" style="font-size:12px;">${expanded ? '▾' : '▸'} ${n} ${kindWord}</a>` : '';
  return `<tr>
    <td>${esc(STAGE_LABELS[c.stage] || c.stage)}${toggle}</td>
    ${pjWindowCell(c)}
    <td>${badge(c.status)}</td>
    <td>${esc(c.assigned_to_name) || '<span class="muted">Not allocated</span>'}</td>
    <td>${pjTimestamp(c.allocated_at)}</td>
    <td>${pjTimestamp(c.started_at)}</td>
    <td>${pjTimestamp(c.completed_at)}</td>
    <td>${esc(c.notes) || ''}</td>
    <td>${pjActionsCell(c)}</td>
  </tr>`;
}
// In-place re-render of whichever project's pipeline is open (after a
// Start/Complete/Hold) rather than navigate(CURRENT_PAGE), which would
// rebuild the whole Projects page and collapse the panel the user is
// working in. Fresh server state comes back with the re-render, so badges,
// timestamps AND every button's eligibility update together.
async function pjRefreshPipeline() {
  if (PJ_VIEW) await viewProjectCards(PJ_VIEW.id, PJ_VIEW.code);
  else navigate(CURRENT_PAGE);
}
window.pjAdvanceJobCard = async (id, status) => {
  try {
    await api(`/projects/job-cards/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  } catch (e) { alert(e.message); return; }
  await pjRefreshPipeline();
};
window.pjHoldJobCard = async (id) => {
  try {
    await api(`/projects/job-cards/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'OnHold' }) });
  } catch (e) { alert(e.message); return; }
  await pjRefreshPipeline();
};
window.viewProjectCards = async (id, code) => {
  const cards = await api(`/projects/${id}/job-cards`);
  // Re-clicking the same project keeps its expanded groups; opening a
  // different one starts collapsed again (collapse-by-default, per the
  // standing rule in CLAUDE.md).
  PJ_VIEW = { id, code, expanded: PJ_VIEW && PJ_VIEW.id === id ? PJ_VIEW.expanded : new Set() };
  document.getElementById('pj-cards-panel').style.display = 'block';
  document.getElementById('pj-cards-title').textContent = 'Pipeline: ' + code;
  // Stages excluded from this project's flow (see the Targets sheet) are
  // hidden here entirely, same as everywhere else outside the Targets
  // sheet itself - this is a pipeline view, not a place to re-include one.
  // Rows: one top-level department card, then its own children nested
  // directly beneath it (hidden by default - see pjChildRowHTML). The
  // Customer column is gone on purpose: every row of this per-project
  // panel shares one client, already shown in the Projects list above.
  // tableHTML supplies the horizontal scroller and the empty state.
  const rows = [];
  cards.filter(c => c.status !== 'NotApplicable').forEach(c => {
    const children = (c.children || []).filter(ch => ch.status !== 'NotApplicable');
    rows.push({ card: c, children });
    children.forEach(ch => rows.push({ card: ch, parentId: c.id }));
  });
  document.getElementById('pj-cards').innerHTML = tableHTML(
    ['Stage / Item', 'Planned Window', 'Status', 'Assigned To', 'Allocated', 'Started', 'Completed', 'Notes', 'Action'],
    rows,
    row => (row.parentId !== undefined ? pjChildRowHTML(row.card, row.parentId) : pjParentRowHTML(row.card, row.children))
  );
  document.getElementById('pj-cards-panel').scrollIntoView({ behavior: 'smooth' });
};

// ---- Targets sheet (PM department-level planning, editable anytime) ----
// Download/Generate link for a project's Sales Order Annexure - same
// conditional pattern already used on the Sales Orders list and the Job
// Card detail panel (reuses the same downloadAnnexure() global), so the PM
// can review scope right from wherever they're assigning targets instead
// of needing a GET /annexure directly.
function annexureLinkHTML(p) {
  if (!p.sales_order_id) return '<span class="muted">No sales order</span>';
  return p.annexure_path
    ? `<a href="/api/sales/orders/${p.sales_order_id}/annexure" onclick="return downloadAnnexure(event, ${p.sales_order_id})">Annexure</a> <a href="#" onclick="return downloadAnnexure(event, ${p.sales_order_id}, 'pdf')">PDF</a>`
    : `<a href="#" onclick="return generateAnnexureForTargets(event, ${p.sales_order_id})">Generate</a>`;
}
// Same link, worded as a prominent line right above the plan editor's own
// stage table - this is where the PM actually benefits from reviewing scope
// before assigning target dates, not just a column on the project list.
function annexureLinkBannerHTML(p) {
  if (!p.sales_order_id) return '<span class="muted">No sales order linked to this project - no annexure to review.</span>';
  return `<b>Sales Order Annexure</b> (scope of supply - review before setting targets): ${annexureLinkHTML(p)}`;
}
window.generateAnnexureForTargets = async (ev, orderId) => {
  ev.preventDefault();
  try {
    await api(`/sales/orders/${orderId}/regenerate-annexure`, { method: 'POST' });
    navigate('targets');
  } catch (e) { alert(e.message); }
  return false;
};

PAGES.targets = async (el) => {
  const projects = await api('/projects');
  const canPlanAny = has('project.manage');
  // project.plan_spares (2026-11-14) lets a non-PM/Admin plan Spares-type
  // projects specifically - whether that's scoped to Spares only or widened
  // to every project is an Admin-configurable setting read server-side on
  // save/preview, but the dropdown itself is narrowed here too so a
  // Spares-only holder isn't shown a project they'll just get a 403 on.
  const canPlanSpares = !canPlanAny && has('project.plan_spares');
  const canPlan = canPlanAny || canPlanSpares;
  const sparesMode = canPlanSpares ? (await api('/settings/project-plan-spares-mode')).mode : 'spares_only';
  const planProjects = (canPlanAny || sparesMode === 'same_as_manage') ? projects : projects.filter(p => p.is_spares);
  el.innerHTML = `
    ${collapsiblePanel('targets-by-project', `Targets by Project (${projects.length})`, `
      ${tableHTML(['Code', 'Title', 'Client', 'Status', 'Target Completion', 'Annexure'], projects, p => `
        <tr data-project-row="${p.id}"><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${esc(p.client_name)||'-'}</td><td>${badge(p.status)}</td>
        <td class="pr-target">${p.target_date ? `<b>${new Date(p.target_date).toLocaleDateString()}</b>` : '<span class="muted">Not planned yet</span>'}</td>
        <td>${annexureLinkHTML(p)}</td></tr>`)}
    `)}
    <div class="panel">
      <h3>Plan / Edit Department Targets</h3>
      ${canPlan ? `
        ${canPlanSpares && sparesMode === 'spares_only' ? `<p class="muted">You can plan Spares orders only - the project list below is filtered to those.</p>` : ''}
        <div class="form-grid">
          <div><label>Project</label><select id="pl-project" onchange="loadProjectPlan()"><option value="">Select a project...</option>${planProjects.map(p => `<option value="${p.id}">${esc(p.project_code)} — ${esc(p.client_name || p.title)}</option>`).join('')}</select></div>
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
  // Not every project needs every stage (a bought-out/trading order only
  // needs Purchase + Store) - excluded stages drop out of the reorderable
  // plan entirely and move to a small "Excluded" strip below with a one-
  // click way back in, rather than cluttering the sequence/duration table
  // with rows nobody is going to schedule.
  const activeCards = cards.filter(c => c.status !== 'NotApplicable');
  const excludedCards = cards.filter(c => c.status === 'NotApplicable');
  body.innerHTML = `
    <div id="capacity-alert-banner" style="position:sticky;top:0;z-index:5;"></div>
    <p>${targetProject ? annexureLinkBannerHTML(targetProject) : ''}</p>
    <p class="muted">Set how many days each department needs and reorder rows (▲▼) to match the real handover sequence. By default each stage's start is the day after the previous stage ends, and a stage can't be started until every stage above it is completed. Tick "Run in parallel" on a row to have it start on the same day as the row above it instead — the next non-parallel row waits for whichever of that group finishes last. A department with sub-processes (marked below) is planned here as one row — its HOD breaks that window down further from their own Job Cards workbench. Doesn't need a department for this project at all? Exclude it below — it can be brought back any time.</p>
    <table><thead><tr><th style="width:36px;"></th><th>Department</th><th>Duration (days)</th><th>Run in parallel<br>with row above</th><th>Planned Start</th><th>Planned End</th><th>Status</th><th></th></tr></thead>
    <tbody id="pl-rows">
      ${activeCards.map((c, i) => `
        <tr data-jc="${c.id}">
          <td class="pl-reorder">
            <div class="reorder-actions">
              <button type="button" class="btn small outline" onclick="moveRow(this,-1)" title="Move up">▲</button>
              <button type="button" class="btn small outline" onclick="moveRow(this,1)" title="Move down">▼</button>
            </div>
          </td>
          <td>${esc(STAGE_LABELS[c.stage] || c.stage)}${c.child_count ? ` <span class="muted">(+${c.child_count} sub-processes, HOD-planned)</span>` : ''}</td>
          <td><input type="number" min="1" class="pl-duration" value="${c.duration_days || 7}" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td style="text-align:center;"><input type="checkbox" class="pl-parallel" ${c.parallel_with_previous ? 'checked' : ''} ${i === 0 ? 'disabled title="The first row has nothing above it to run alongside."' : ''}></td>
          <td class="pl-start">${c.planned_start || '-'}</td>
          <td class="pl-end">${c.planned_end || '-'}</td>
          <td>${badge(c.status)}</td>
          <td>${c.status === 'Pending' ? `<button type="button" class="btn small outline" onclick="excludeJobCardFromPlan(${c.id})">Exclude</button>` : ''}</td>
        </tr>`).join('')}
    </tbody></table>
    <button class="btn" onclick="saveProjectPlan(${projectId})">Recalculate &amp; Save Plan</button>
    <button type="button" class="btn small outline" onclick="checkPlanCapacity(${projectId})">Check Department Availability</button>
    <span id="pl-target" class="muted" style="margin-left:10px;">${targetProject && targetProject.target_date ? `Overall target completion: <b>${targetProject.target_date}</b>` : ''}</span>
    <div id="pl-capacity" style="margin-top:12px;"></div>
    ${excludedCards.length ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
        <b>Excluded from this project's flow</b>
        <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;">
          ${excludedCards.map(c => `
            <span style="display:inline-flex;align-items:center;gap:8px;padding:5px 10px;background:#f5f5f5;border-radius:5px;">
              ${esc(STAGE_LABELS[c.stage] || c.stage)}
              <button type="button" class="btn small outline" onclick="includeJobCardInPlan(${c.id})">Include</button>
            </span>`).join('')}
        </div>
      </div>` : ''}
    <div id="pl-err" class="msg err" style="display:none;margin-top:10px;"></div>
    <div id="pl-comm-${projectId}" style="margin-top:16px;"></div>
  `;
  refreshReorderButtons(document.getElementById('pl-rows'));
  renderProjectCommunications(projectId);
};

// ---- Customer communications: a note/change from the customer, pushed by
// hand to whichever departments the PM picks, each requiring an
// acknowledgment (a To-Do the recipient must mark done) rather than just a
// dismissible notification - see routes/projects.js POST /:id/communications.
async function renderProjectCommunications(projectId) {
  const container = document.getElementById(`pl-comm-${projectId}`);
  if (!container) return;
  const [departments, history] = await Promise.all([
    api('/masters/departments'),
    api(`/projects/${projectId}/communications`),
  ]);
  container.innerHTML = collapsiblePanel(`project-communications-${projectId}`, `Customer Communications (${history.length})`, `
    <p class="muted">Log a note, change, or document from the customer and push it to whichever departments need to know - each recipient gets a To-Do they must mark done to acknowledge it.</p>
    <div><label>Subject</label><input id="cc-subject-${projectId}" style="width:100%;"></div>
    <div style="margin-top:6px;"><label>Communication</label><textarea id="cc-message-${projectId}" rows="3" style="width:100%;"></textarea></div>
    <div style="margin-top:8px;"><b>Notify Departments</b></div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;">
      ${departments.map(d => `<label style="margin:0;font-weight:normal;"><input type="checkbox" class="cc-dept-${projectId}" value="${d.id}"> ${esc(d.name)}</label>`).join('')}
    </div>
    <button class="btn small" type="button" style="margin-top:10px;" onclick="sendCustomerCommunication(${projectId})">Send</button>
    <div id="cc-err-${projectId}" class="msg err" style="display:none;margin-top:8px;"></div>
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px;">
      ${history.length ? history.map(c => `
        <div class="box" style="border:1px solid var(--border,#ccc);border-radius:6px;padding:10px;margin-bottom:10px;">
          <p style="margin:0 0 4px;"><b>${esc(c.subject)}</b> <span class="muted">- ${esc(c.created_by_name)||'-'} &middot; ${new Date(c.created_at).toLocaleString()}</span></p>
          <p style="margin:0 0 6px;">${esc(c.message)}</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${c.recipients.map(r => `<span class="badge ${r.ack_status === 'Completed' ? 'active' : (r.user_name ? 'Draft' : 'red')}">${esc(r.department_name)}${r.user_name ? ' (' + esc(r.user_name) + (r.ack_status === 'Completed' ? ' - acknowledged' : ' - pending') + ')' : ' (no HOD configured)'}</span>`).join('')}
          </div>
          <div id="cc-att-${c.id}" style="margin-top:6px;"></div>
        </div>`).join('') : '<div class="empty">No customer communications logged yet.</div>'}
    </div>
  `);
  history.forEach(c => renderAttachmentsWidget('customer_communication', c.id, document.getElementById(`cc-att-${c.id}`)));
}
window.sendCustomerCommunication = async (projectId) => {
  const errEl = document.getElementById(`cc-err-${projectId}`);
  errEl.style.display = 'none';
  const departmentIds = Array.from(document.querySelectorAll(`.cc-dept-${projectId}:checked`)).map(cb => Number(cb.value));
  try {
    const r = await api(`/projects/${projectId}/communications`, { method: 'POST', body: JSON.stringify({
      subject: val(`cc-subject-${projectId}`), message: val(`cc-message-${projectId}`), department_ids: departmentIds,
    })});
    if (r.skipped && r.skipped.length) alert(`Sent, but no HOD/Supervisor is configured for: ${r.skipped.join(', ')}. Follow up with them some other way.`);
    await renderProjectCommunications(projectId);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.excludeJobCardFromPlan = async (jcId) => {
  try {
    await api(`/projects/job-cards/${jcId}/exclude`, { method: 'PUT' });
    loadProjectPlan();
  } catch (e) { alert(e.message); }
};
window.includeJobCardInPlan = async (jcId) => {
  try {
    await api(`/projects/job-cards/${jcId}/include`, { method: 'PUT' });
    loadProjectPlan();
  } catch (e) { alert(e.message); }
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
  refreshReorderButtons(tbody);
}
// ▲ is disabled on the first row, ▼ on the last.
function refreshReorderButtons(tbody) {
  const rows = Array.from(tbody.children);
  rows.forEach((tr, i) => {
    const [up, down] = tr.querySelectorAll('.reorder-actions button');
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === rows.length - 1;
  });
}
function planFormStages() {
  const startDate = val('pl-start');
  const rows = Array.from(document.querySelectorAll('#pl-rows tr'));
  const stages = rows.map(tr => ({
    id: Number(tr.dataset.jc),
    duration_days: Number(tr.querySelector('.pl-duration').value) || 1,
    parallel_with_previous: tr.querySelector('.pl-parallel').checked,
  }));
  return { startDate, stages };
}
// Color scheme fixed by the owner: 0-1 projects on a department on a given
// day = green (room for at least one more without hitting the cap of 2),
// exactly 2 = blue (at cap), 3+ = red (over cap - the thing this feature
// exists to catch before it happens).
function capacityLevelColor(level) { return level === 'red' ? '#e74c3c' : level === 'blue' ? '#3b82f6' : '#2ecc71'; }
function capacityDayTitle(d) {
  return d.count ? `${d.count} project${d.count > 1 ? 's' : ''}: ${d.projects.map(p => p.project_code).join(', ')}` : 'Available - no projects scheduled';
}
// A compact horizontal strip of colored day-squares for one department's
// own proposed (or existing) date window - used by the plan editor's
// capacity preview, where the window is usually days to a few weeks, not a
// full calendar grid.
function capacityDayStripHTML(days) {
  return `<div style="display:flex;flex-wrap:wrap;gap:3px;">
    ${days.map(d => `<div title="${esc(d.date)}: ${esc(capacityDayTitle(d))}" style="width:20px;height:20px;border-radius:3px;background:${capacityLevelColor(d.level)};display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;">${Number(d.date.slice(8, 10))}</div>`).join('')}
  </div>`;
}
window.checkPlanCapacity = async (projectId) => {
  const target = document.getElementById('pl-capacity');
  const { startDate, stages } = planFormStages();
  if (!startDate || !stages.length) { target.innerHTML = '<p class="msg err">Pick a plan start date first.</p>'; return; }
  target.innerHTML = '<span class="muted">Checking...</span>';
  try {
    const r = await api(`/projects/${projectId}/plan/preview`, { method: 'POST', body: JSON.stringify({ start_date: startDate, stages }) });
    target.innerHTML = `<p class="muted" style="margin-bottom:6px;">Each department's existing load (from every OTHER project) over the window this plan would give it - <span style="color:#2ecc71;">green</span> = available, <span style="color:#3b82f6;">blue</span> = already at the 2-project cap, <span style="color:#e74c3c;">red</span> = already over it. Hover a day for the project list.</p>
      ${r.departments.map(d => `
        <div style="margin-bottom:10px;">
          <b>${esc(d.stageLabel)}</b> <span class="muted">(${esc(d.planned_start)} to ${esc(d.planned_end)})</span>
          ${capacityDayStripHTML(d.days)}
        </div>`).join('')}`;
  } catch (e) { target.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
};
window.saveProjectPlan = async (projectId, confirmed) => {
  const errEl = document.getElementById('pl-err');
  errEl.style.display = 'none';
  const banner = document.getElementById('capacity-alert-banner');
  if (banner) banner.innerHTML = '';
  const { startDate, stages } = planFormStages();
  if (!startDate) { errEl.textContent = 'Pick a plan start date first.'; errEl.style.display = 'block'; return; }
  try {
    const body = { start_date: startDate, stages };
    if (confirmed) body.confirm = true;
    const r = await api(`/projects/${projectId}/plan`, { method: 'PUT', body: JSON.stringify(body) });
    r.jobCards.forEach(c => {
      const tr = document.querySelector(`#pl-rows tr[data-jc="${c.id}"]`);
      if (tr) { tr.querySelector('.pl-start').textContent = c.planned_start; tr.querySelector('.pl-end').textContent = c.planned_end; }
    });
    document.getElementById('pl-target').innerHTML = `Saved. Overall target completion: <b>${new Date(r.targetDate).toLocaleDateString()}</b>`;
    // also reflect it in the projects table above, so it's visible without re-opening this panel
    const projRow = document.querySelector(`tr[data-project-row="${projectId}"] .pr-target`);
    if (projRow) projRow.innerHTML = `<b>${new Date(r.targetDate).toLocaleDateString()}</b>`;
  } catch (e) {
    // A capacity conflict (soft warning, never a hard block) comes back as
    // a 409 carrying structured conflict data rather than a plain message -
    // offer to proceed anyway instead of just showing an error.
    if (e.data && e.data.conflict) {
      const lines = e.data.conflicts.map(c => `${c.stageLabel}: would reach ${Math.max(...c.dates.map(d => d.existingCount)) + 1} projects on ${c.dates.length} day(s) (e.g. ${c.dates[0].date})`);
      if (banner) {
        // Window = earliest to latest conflicting day (days in between may be clear).
        banner.innerHTML = `<div style="background:#fdecea;border:1px solid #e74c3c;border-left:5px solid #e74c3c;border-radius:6px;padding:10px 14px;margin-bottom:12px;">
          <b>⚠️ Capacity Overlap</b>
          <ul style="margin:6px 0 0 18px;">${e.data.conflicts.map(c => {
            const ds = c.dates.map(d => d.date).sort();
            const peak = Math.max(...c.dates.map(d => d.existingCount)) + 1;
            return `<li>${esc(c.stageLabel)} department exceeds the 2-project limit (up to ${esc(peak)} projects) between ${esc(ds[0])} and ${esc(ds[ds.length - 1])} (${esc(ds.length)} day${ds.length > 1 ? 's' : ''} affected)</li>`;
          }).join('')}</ul></div>`;
        banner.scrollIntoView({ block: 'nearest' });
      }
      if (confirm(`This plan would push the following department(s) over the 2-project cap:\n\n${lines.join('\n')}\n\nSave anyway?`)) {
        saveProjectPlan(projectId, true);
      }
      return;
    }
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
};

// ---- Department Capacity (standalone, every department at a glance) ----
// A compact month calendar per department, colored the same green/blue/red
// as the plan editor's own preview - lets a PM eyeball overall org load for
// a month without needing to be mid-way through planning a specific
// project. Collapsed by default per this file's own standing rule for any
// repeating/grouped list UI - 10 departments' worth of calendars at once is
// exactly that.
let DC_MONTH = null; // {year, month} - month is 0-indexed; lazily set to the current month on first visit
function monthRange(year, month) {
  const from = new Date(year, month, 1);
  const to = new Date(year, month + 1, 0);
  const fmt = d => localDateStr(d);
  return { from: fmt(from), to: fmt(to), startWeekday: from.getDay() };
}
function capacityMonthGridHTML(days, startWeekday) {
  const blanks = Array.from({ length: startWeekday }, () => '<div></div>');
  const cells = days.map(d => `<div title="${esc(d.date)}: ${esc(capacityDayTitle(d))}" style="aspect-ratio:1;border-radius:4px;background:${capacityLevelColor(d.level)};display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;">${Number(d.date.slice(8, 10))}</div>`);
  return `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;max-width:320px;">
    ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<div style="text-align:center;font-size:10px;color:var(--muted);font-weight:600;">${d}</div>`).join('')}
    ${blanks.join('')}${cells.join('')}
  </div>`;
}
PAGES['dept-capacity'] = async (el) => {
  if (!has('project.manage')) { el.innerHTML = '<p class="msg err">Only a Project Manager or Admin can view department capacity.</p>'; return; }
  if (!DC_MONTH) { const now = new Date(); DC_MONTH = { year: now.getFullYear(), month: now.getMonth() }; }
  await renderDeptCapacity(el);
};
async function renderDeptCapacity(el) {
  const { year, month } = DC_MONTH;
  const { from, to, startWeekday } = monthRange(year, month);
  const [stages, calendar] = await Promise.all([
    api('/projects/pipeline-stages'),
    api(`/projects/capacity-calendar?from=${from}&to=${to}`),
  ]);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  el.innerHTML = `
    <div class="panel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <button class="btn small outline" onclick="changeDeptCapacityMonth(-1)">&larr; Prev</button>
      <b>${esc(monthLabel)}</b>
      <button class="btn small outline" onclick="changeDeptCapacityMonth(1)">Next &rarr;</button>
      <span class="muted" style="margin-left:14px;"><span style="color:#2ecc71;">&#9632;</span> Available &nbsp; <span style="color:#3b82f6;">&#9632;</span> 2 projects loaded &nbsp; <span style="color:#e74c3c;">&#9632;</span> 3+ projects loaded (over the cap)</span>
    </div>
    ${stages.map(s => collapsiblePanel(`dept-cap-${s}`, esc(STAGE_LABELS[s] || s), capacityMonthGridHTML(calendar[s] || [], startWeekday))).join('')}
  `;
}
window.changeDeptCapacityMonth = (delta) => {
  let { year, month } = DC_MONTH;
  month += delta;
  if (month < 0) { month = 11; year--; } else if (month > 11) { month = 0; year++; }
  DC_MONTH = { year, month };
  // Re-render into the page's scope wrapper (modpolish.js) when there is one, so the styling survives a month change.
  renderDeptCapacity(document.querySelector('#content > .hig-mod-scope') || document.getElementById('content'));
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
  el.innerHTML = renderJobCardSection('mine', `Job Cards for ${ME.role}`, cards, jobCardBoardRowHTML) +
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
// Shared row renderer for every department job-card board ("My Job Cards"
// and each Admin/PM per-department tab) - one place to add/change a column
// so the two boards can never drift out of sync with each other again.
// Boards never filtered on parent_job_card_id (GET /job-cards/mine and
// /job-cards/by-stage/:stage both select on stage alone), so a department
// card and every is_adhoc sub-assembly split off it (same department, same
// project, parent_job_card_id pointing back at it) rendered as unrelated
// flat sibling rows - one project could show 3+ separate-looking lines with
// no visual connection between them (2026-10-15). A "routed" hand-off card
// (sent to a DIFFERENT department) carries no parent_job_card_id at all, so
// it's unaffected here - it's genuinely that department's own new top-level
// card, not something to nest.
//
// Groups a board's rows so a child is_adhoc card (one whose
// parent_job_card_id resolves to another row in this same rows array) nests
// under its parent instead of appearing as an independent row - same
// "N items, collapsed by default, expand on click" shape multi-line
// Purchase Order groups already use. Applied to whatever rows are actually
// being rendered (post-search-filter), not the raw fetch - a search that
// matches a child but not its own parent still shows that child, just as a
// standalone row rather than silently dropping it.
function groupJobCardRows(rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const childrenByParent = new Map();
  rows.forEach(r => {
    if (r.parent_job_card_id != null && byId.has(r.parent_job_card_id)) {
      const list = childrenByParent.get(r.parent_job_card_id) || [];
      list.push(r);
      childrenByParent.set(r.parent_job_card_id, list);
    }
  });
  const childIds = new Set();
  childrenByParent.forEach(list => list.forEach(c => childIds.add(c.id)));
  const ordered = [];
  rows.forEach(r => {
    if (childIds.has(r.id)) return;
    const children = childrenByParent.get(r.id) || [];
    ordered.push(Object.assign({}, r, { __childCount: children.length }));
    children.forEach(c => ordered.push(Object.assign({}, c, { __isChild: true, __parentId: r.id })));
  });
  return ordered;
}
window.toggleJobCardGroup = (parentId) => {
  const rows = document.querySelectorAll('.jc-child-row-' + parentId);
  const showing = rows.length && rows[0].style.display !== 'none';
  rows.forEach(r => { r.style.display = showing ? 'none' : ''; });
  const link = document.getElementById('jc-group-toggle-' + parentId);
  if (link) link.textContent = (showing ? '▸ ' : '▾ ') + link.dataset.label;
};
function jobCardBoardRowHTML(c) {
  const n = c.__childCount || 0;
  const toggleLabel = n + ' sub-assembl' + (n === 1 ? 'y' : 'ies');
  const groupToggle = n ? ` <a href="#" id="jc-group-toggle-${c.id}" data-label="${toggleLabel}" onclick="toggleJobCardGroup(${c.id});return false;" class="muted" style="font-size:12px;">▸ ${toggleLabel}</a>` : '';
  const rowAttrs = c.__isChild ? ` class="jc-child-row-${c.__parentId}" style="display:none;"` : '';
  const itemCell = (c.__isChild ? '&nbsp;&nbsp;↳ ' : '') + esc(c.title || STAGE_LABELS[c.stage] || c.stage) + (c.is_adhoc ? ' <span class="muted">(sub-assembly/routed)</span>' : '') + (c.blocked_by ? ` <span class="muted" style="font-size:12px;" title="Waiting on handover from ${esc(STAGE_LABELS[c.blocked_by] || c.blocked_by_task_name)}">🔒 blocked</span>` : '') + groupToggle;
  return `<tr${rowAttrs}><td>${esc(c.project_code)} - ${esc(c.project_title)}</td><td>${esc(c.client_name)||'-'}</td><td>${itemCell}</td><td>${c.planned_end || '-'}</td><td>${badge(c.status)}</td><td>${esc(c.assigned_to_name)||'-'}</td>
      <td>${jobCardActions(c)}</td></tr>`;
}
// Completed cards move into their own collapsed-by-default "Closed" bucket
// (2026-10-14) - the same "a bucket that only ever grows stays collapsed,
// separate from the active queue" pattern already shipped for the Service
// Request Queue's and Purchase Orders list's own Closed/Archive panels.
// Every job-card board (My Job Cards, each Admin/PM department tab, each
// Manufacturing sub-process tab) funnels through this one function, so
// splitting it here covers all of them in one place.
function renderJobCardSection(key, title, rows, cardRow) {
  const tableWrapId = 'jc-tw-' + key;
  const countId = 'jc-count-' + key;
  const closedTableWrapId = 'jc-closed-tw-' + key;
  const closedCountId = 'jc-closed-count-' + key;
  const activeRows = rows.filter(r => r.status !== 'Completed');
  const closedRows = rows.filter(r => r.status === 'Completed');
  const renderRows = (rs) => rs.length ? '<div class="hig-rowcards">' + tableHTML(['Project', 'Customer', 'Item', 'Target Completion', 'Status', 'Assigned', 'Action'], groupJobCardRows(rs), cardRow) + '</div>' : '<p class="muted">No job cards in this section.</p>';
  return collapsiblePanel('dept-job-cards-' + key, `<span id="${countId}">${esc(title)} (${activeRows.length})</span>`, `
    ${renderListSearch('jc-' + key, activeRows, ['project_code', 'project_title', 'client_name', 'title', 'assigned_to_name', 'status'], (filtered) => {
      document.getElementById(tableWrapId).innerHTML = renderRows(filtered);
      document.getElementById(countId).textContent = title + ' (' + filtered.length + ')';
    }, 'Search by project, customer, item, status, assignee...')}
    <div id="${tableWrapId}">${renderRows(activeRows)}</div>
    ${collapsiblePanel('dept-job-cards-closed-' + key, `<span id="${closedCountId}">Closed (${closedRows.length})</span>`, `
      ${renderListSearch('jc-closed-' + key, closedRows, ['project_code', 'project_title', 'client_name', 'title', 'assigned_to_name'], (filtered) => {
        document.getElementById(closedTableWrapId).innerHTML = renderRows(filtered);
        document.getElementById(closedCountId).textContent = 'Closed (' + filtered.length + ')';
      }, 'Search by project, customer, item, assignee...')}
      <div id="${closedTableWrapId}">${renderRows(closedRows)}</div>
    `)}
  `);
}
async function renderDeptJobCards(el, stage, label, onlyStage) {
  const cards = await api('/projects/job-cards/by-stage/' + encodeURIComponent(stage));
  const subStages = DEPT_SUB_STAGES[stage];
  let body;
  if (onlyStage) {
    // A single sub-process's own sidebar tab (e.g. Manufacturing > Fitting) -
    // same combined-queue data, filtered down to just this one section.
    const rows = cards.filter(c => c.stage === onlyStage);
    body = renderJobCardSection('only-' + onlyStage, label, rows, jobCardBoardRowHTML);
  } else if (subStages) {
    const own = cards.filter(c => c.stage === stage);
    const sections = [{ key: stage, title: label + ' (overall)', rows: own }]
      .concat(subStages.map(s => ({ key: s, title: STAGE_LABELS[s] || s, rows: cards.filter(c => c.stage === s) })));
    body = sections.map(sec => renderJobCardSection(sec.key, sec.title, sec.rows, jobCardBoardRowHTML)).join('');
  } else {
    body = renderJobCardSection(stage, label, cards, jobCardBoardRowHTML);
  }
  el.innerHTML = body +
    `<div class="panel" id="sp-panel" style="display:none;"><h3 id="sp-title"></h3><div id="sp-body"></div></div>
     <div class="panel" id="jc-panel" style="display:none;"><h3 id="jc-title"></h3><div id="jc-body"></div></div>`;
}

function jobCardActions(c) {
  const subBtn = c.child_count ? `<button class="btn small outline" onclick="openSubPlan(${c.id}, '${esc(STAGE_LABELS[c.stage] || c.stage)}')">Plan Sub-Processes (${c.child_count})</button>` : '';
  const openBtn = `<button class="btn small outline" onclick="openJobCardDetail(${c.id})">Open</button>`;
  if (c.status === 'Completed') return actionButtonsCell(openBtn + subBtn);
  if (!c.can_act) return actionButtonsCell(openBtn) + ' <span class="muted">Not assigned to you</span>';
  const next = c.status === 'Pending' ? 'InProgress' : 'Completed';
  const label = next === 'InProgress' ? 'Start Work' : 'Complete Work';
  // Sequential handover gate (is_adhoc cards never carry blocked_by).
  const blk = c.blocked_by ? ` disabled title="Waiting on handover from ${esc(STAGE_LABELS[c.blocked_by] || c.blocked_by_task_name)}"` : '';
  return actionButtonsCell(`${openBtn}${subBtn}<button class="btn small green"${blk} onclick="advanceJobCard(${c.id}, '${next}')">${label}</button>
    <button class="btn small outline"${blk} onclick="holdJobCard(${c.id})">Hold</button>`);
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
  let data, materialRequests;
  try {
    [data, materialRequests] = await Promise.all([
      api(`/projects/job-cards/${id}/detail`),
      api(`/projects/job-cards/${id}/material-requests`),
    ]);
  } catch (e) { body.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
  const { jobCard: c, children, attachments, comments, dependsOn, routedTo, plannedSequence, canAct, isSupervisor } = data;
  title.textContent = `${c.title || STAGE_LABELS[c.stage] || c.stage} — ${badge(c.status)}`;
  title.innerHTML = `${esc(c.title || STAGE_LABELS[c.stage] || c.stage)} ${badge(c.status)}`;

  const actionsHTML = canAct && c.status !== 'Completed' ? `
    <button class="btn small green" onclick="advanceJobCard(${c.id}, '${c.status === 'Pending' ? 'InProgress' : 'Completed'}')">${c.status === 'Pending' ? 'Start Work' : 'Complete Work'}</button>
    <button class="btn small outline" onclick="holdJobCard(${c.id})">Hold</button>`
    // Recall - shown to anyone who could plausibly have the right (Admin,
    // or this stage's own HOD/Supervisor - isSupervisor already covers
    // both); the backend's job_card.recall permission check is the real
    // gate, since a non-Admin HOD may not have been granted it yet, same
    // "frontend shows who could possibly act, backend enforces the actual
    // grant" pattern used for other Admin-grantable actions in this app.
    : (isSupervisor && c.status === 'Completed' ? `<button class="btn small outline" onclick="recallJobCard(${c.id})">Recall (Reopen)</button>` : '');

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
    <p><b>Sales Order Annexure</b> (${esc(c.so_order_no)||'-'}, read-only): <a href="#" onclick="return downloadAnnexure(event, ${c.so_id})">Download</a> / <a href="#" onclick="return downloadAnnexure(event, ${c.so_id}, 'pdf')">PDF</a></p>
  ` : '';

  const materialHTML = `
    <h4>Material Requests ${canAct ? `<button class="btn small outline" onclick="openRequestMaterialModal(${c.id})">Request Material</button>` : ''}</h4>
    ${materialRequests.length ? tableHTML(['Item', 'Qty', 'Status', 'Requested By', 'Notes'], materialRequests, r => `
      <tr><td>${esc(r.item_master_name || r.item_name)}</td><td>${r.quantity_requested} ${esc(r.unit||'')}</td><td>${badge(r.status)}</td><td>${esc(r.requested_by_name)||'-'}</td><td>${esc(r.request_notes)||'-'}${r.decision_notes ? `<br><span class="muted">${esc(r.decision_notes)}</span>` : ''}</td></tr>`)
    : '<div class="empty">No material requests yet.</div>'}
  `;

  const attachHTML = `
    ${annexureHTML}
    <h4>Attachments</h4>
    <div class="attachments-list">
    ${attachments.length ? tableHTML(['File', 'Uploaded By', 'Date', ''], attachments, a => {
      // Delete is offered to whoever uploaded the file, or this card's own
      // HOD/Supervisor (isSupervisor already covers Admin) - mirrors the
      // backend's own gate on DELETE /job-cards/:id/attachments/:id exactly
      // (2026-10-16 - there was no delete option at all before this).
      const canDelete = isSupervisor || a.uploaded_by === ME.id;
      return `<tr><td><a href="${a.file_path}" target="_blank">${esc(a.file_name)}</a></td><td>${esc(a.uploaded_by_name)||'-'}</td><td>${new Date(a.created_at).toLocaleDateString()}</td>
        <td>${canDelete ? `<button class="btn small red" onclick="deleteJobCardAttachment(${c.id}, ${a.id})">Delete</button>` : ''}</td></tr>`;
    }) : '<div class="empty">No files yet.</div>'}
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

  // Pipeline view (2026-10-16) - this project's own planned top-level
  // department sequence, so whoever's about to manually route this card
  // knows exactly who already gets their work through the normal flow vs.
  // who's genuinely outside it. Also drives which departments are even
  // offered in the Route to Department dropdown below - a department
  // already in the sequence (and not excluded) is a hard-block server-side
  // (POST /job-cards/:id/route-to), so it's left out here too rather than
  // being offered and then rejected.
  const plannedStageSet = new Set((plannedSequence || []).filter(p => p.status !== 'NotApplicable').map(p => p.stage));
  const routableStages = Object.keys(STAGE_LABELS).filter(s => !plannedStageSet.has(s));
  const pipelineHTML = (plannedSequence || []).length ? `
    <p class="muted" style="margin-bottom:6px;">This project's planned department pipeline:</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
      ${plannedSequence.map(p => `<span class="badge ${esc(p.status)}" style="${p.stage === c.stage ? 'outline:2px solid var(--primary);' : ''}" title="${p.stage === c.stage ? 'This card' : ''}">${esc(STAGE_LABELS[p.stage]||p.stage)}${p.stage === c.stage ? ' (this card)' : ''}</span>`).join('')}
    </div>
  ` : '';

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
      ${pipelineHTML}
      <p class="muted">Hand this off to another department outside this project's own planned sequence once ready (e.g. BOM to Purchase, cut/bend files to Laser & Bending, drawings to Electrical — can route to several departments independently). A department already in the pipeline above receives your work through the normal flow instead, so it isn't offered here. The sub-assembly/sub-process name below carries forward to the receiving department by default, along with this card's comments so far — edit it only if the handoff is literally a different item.</p>
      <div class="form-grid">
        <div><label>Route to Department</label><select id="jc-route-stage">${routableStages.length ? routableStages.map(s => `<option value="${s}">${esc(STAGE_LABELS[s])}</option>`).join('') : '<option value="">No departments outside the planned sequence</option>'}</select></div>
        <div><label>What's being handed off</label><input id="jc-route-title" value="${esc(c.title || STAGE_LABELS[c.stage] || c.stage)}" placeholder="e.g. BOM for Procurement"></div>
      </div>
      <button class="btn small outline" onclick="routeJobCard(${c.id})" ${routableStages.length ? '' : 'disabled'}>Route to Department</button>
    </div>
    <div id="jc-hod-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>
  ` : '';

  body.innerHTML = `
    <p>Customer: <b>${esc(c.client_name)||'-'}</b> &nbsp; Status: ${badge(c.status)} &nbsp; Assigned to: <b>${esc(c.assigned_to_name)||'Unassigned'}</b> &nbsp; ${c.planned_start ? `Window: <b>${c.planned_start} to ${c.planned_end||'-'}</b>` : ''}</p>
    <p class="muted" style="font-size:12px;">
      Allocated: <b>${c.allocated_at ? new Date(c.allocated_at).toLocaleString() : '-'}</b> &nbsp;&middot;&nbsp;
      Started: <b>${c.started_at ? new Date(c.started_at).toLocaleString() : '-'}</b> &nbsp;&middot;&nbsp;
      Completed: <b>${c.completed_at ? new Date(c.completed_at).toLocaleString() : '-'}</b>
    </p>
    ${depsHTML}${routedHTML}
    ${actionsHTML}
    ${childrenHTML}
    ${materialHTML}
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
// Multi-item Request Material modal (2026-10-26, replacing the original
// one-item-at-a-time form) - same "+ Add Line Item" shape as
// ISSUE_LINES/FOC_LINES, through gridLineTableHTML so the item/qty/notes
// columns stay aligned regardless of line count.
let RM_LINES = [];
const RM_LINES_GRID_COLS = 'minmax(220px,1.8fr) 100px minmax(160px,1.4fr) 44px';
function rmItemOptions(selectedId, items) {
  return `<option value="">- pick an item -</option>` + items.map(i =>
    `<option value="${i.id}" ${i.id===selectedId?'selected':''}>${esc(i.name)} (${esc(i.unit||'Nos')})</option>`).join('');
}
function renderRMLines() {
  const el = document.getElementById('rm-lines');
  if (!el) return;
  const items = window.__RM_ITEMS || [];
  el.innerHTML = gridLineTableHTML(RM_LINES_GRID_COLS, ['Item', 'Quantity', 'Notes (optional)', ''], RM_LINES, (l, i) => `
      <div>${itemPickerHTML(`rm-item-${i}`, items, l.item_id, rmItemOptions, `onchange="RM_LINES[${i}].item_id=this.value?Number(this.value):''"`)}</div>
      <div><input type="number" step="0.01" value="${l.quantity_requested}" onchange="RM_LINES[${i}].quantity_requested=Number(this.value)"></div>
      <div><input value="${esc(l.request_notes||'')}" placeholder="e.g. urgent" onchange="RM_LINES[${i}].request_notes=this.value"></div>
      <div>${RM_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="RM_LINES.splice(${i},1);renderRMLines()">✕</button>` : ''}</div>`);
}
window.addRMLine = () => { RM_LINES.push({ item_id: '', quantity_requested: 1, request_notes: '' }); renderRMLines(); };
window.openRequestMaterialModal = async (jobCardId) => {
  let items;
  try { items = await api('/masters/items'); } catch (e) { alert(e.message); return; }
  window.__RM_ITEMS = items.filter(i => !['Pending', 'Discontinued'].includes(i.status));
  RM_LINES = [{ item_id: '', quantity_requested: 1, request_notes: '' }];
  openAppModal('Request Material', `
    <div id="rm-lines"></div>
    <button class="btn small outline" type="button" onclick="addRMLine()">+ Add Line Item</button>
    <div id="rm-err" class="msg err" style="display:none;margin-top:8px;"></div>
    <div class="hig-savebar"><button class="btn" onclick="submitRequestMaterial(${jobCardId})">Submit Request</button></div>
  `);
  renderRMLines();
};
window.submitRequestMaterial = async (jobCardId) => {
  const errEl = document.getElementById('rm-err');
  for (let i = 0; i < RM_LINES.length; i++) {
    const l = RM_LINES[i];
    const prefix = RM_LINES.length > 1 ? `Line ${i + 1}: ` : '';
    if (!l.item_id) { errEl.textContent = prefix + 'Pick an item.'; errEl.style.display = 'block'; return; }
    if (!l.quantity_requested || Number(l.quantity_requested) <= 0) { errEl.textContent = prefix + 'Enter a quantity greater than 0.'; errEl.style.display = 'block'; return; }
  }
  try {
    await api(`/projects/job-cards/${jobCardId}/request-material`, { method: 'POST', body: JSON.stringify({ lines: RM_LINES }) });
    closeAppModal();
    openJobCardDetail(jobCardId);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
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
  if (!stage) { errEl.textContent = 'No department outside the planned sequence is available to route to.'; errEl.style.display = 'block'; return; }
  try {
    await api(`/projects/job-cards/${id}/route-to`, { method: 'POST', body: JSON.stringify({ stage, title }) });
    openJobCardDetail(id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.recallJobCard = async (id) => {
  const reason = prompt('Reason for recalling this completed stage (required):');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required to recall a completed stage.'); return; }
  try {
    await api(`/projects/job-cards/${id}/recall`, { method: 'POST', body: JSON.stringify({ reason }) });
    openJobCardDetail(id);
  } catch (e) { alert(e.message); }
};
window.deleteJobCardAttachment = async (jobCardId, attachmentId) => {
  if (!confirm('Delete this attachment? This cannot be undone.')) return;
  try {
    await api(`/projects/job-cards/${jobCardId}/attachments/${attachmentId}`, { method: 'DELETE' });
    openJobCardDetail(jobCardId);
  } catch (e) { alert(e.message); }
};

// ---- HOD sub-process planning (e.g. Manufacturing HOD planning Fitting -> Tacking -> Welding -> Buffing/Sandblast -> Painting) ----
window.openSubPlan = async (parentId, parentLabel) => {
  window.__SP_PARENT_LABEL = parentLabel; // reused by exclude/include to redraw this same screen
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
  // Not every project needs all 5 of Manufacturing's sub-processes (a
  // project might never need Painting or Buffing/Sandblast) - same
  // exclude/include pattern as the Targets sheet, one level down.
  const activeChildren = children.filter(c => c.status !== 'NotApplicable');
  const excludedChildren = children.filter(c => c.status === 'NotApplicable');
  body.innerHTML = `
    <p class="muted">${esc(parentLabel)}'s overall window from the PM's plan: <b>${parent.planned_start || '-'} to ${parent.planned_end || '-'}</b>. Break it down into sub-process targets below — rows can be reordered (▲▼) to match real handover between sub-processes, and this can be re-edited any time. Don't need one of these sub-processes for this project? Exclude it below.</p>
    <div class="form-grid"><div><label>Sub-Plan Start Date</label><input id="sp-start" type="date" value="${parent.planned_start || today()}"></div></div>
    <table><thead><tr><th style="width:36px;"></th><th>Sub-Process</th><th>Duration (days)</th><th>Planned Start</th><th>Planned End</th><th>Status</th><th></th></tr></thead>
    <tbody id="sp-rows">
      ${activeChildren.map(c => `
        <tr data-jc="${c.id}">
          <td class="pl-reorder">
            <div class="reorder-actions">
              <button type="button" class="btn small outline" onclick="moveRow(this,-1)" title="Move up">▲</button>
              <button type="button" class="btn small outline" onclick="moveRow(this,1)" title="Move down">▼</button>
            </div>
          </td>
          <td>${esc(STAGE_LABELS[c.stage] || c.stage)}</td>
          <td><input type="number" min="1" class="sp-duration" value="${c.duration_days || 2}" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td class="sp-start">${c.planned_start || '-'}</td>
          <td class="sp-end">${c.planned_end || '-'}</td>
          <td>${badge(c.status)}</td>
          <td>${c.status === 'Pending' ? `<button type="button" class="btn small outline" onclick="excludeSubStage(${c.id}, ${parentId})">Exclude</button>` : ''}</td>
        </tr>`).join('')}
    </tbody></table>
    <button class="btn" onclick="saveSubPlan(${parentId})">Recalculate &amp; Save Sub-Plan</button>
    ${excludedChildren.length ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
        <b>Excluded from this project's flow</b>
        <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;">
          ${excludedChildren.map(c => `
            <span style="display:inline-flex;align-items:center;gap:8px;padding:5px 10px;background:#f5f5f5;border-radius:5px;">
              ${esc(STAGE_LABELS[c.stage] || c.stage)}
              <button type="button" class="btn small outline" onclick="includeSubStage(${c.id}, ${parentId})">Include</button>
            </span>`).join('')}
        </div>
      </div>` : ''}
    <div id="sp-err" class="msg err" style="display:none;margin-top:10px;"></div>
  `;
  refreshReorderButtons(document.getElementById('sp-rows'));
};
window.excludeSubStage = async (jcId, parentId) => {
  if (!confirm("Exclude this sub-process from this project's flow? It can be brought back any time.")) return;
  try {
    await api(`/projects/job-cards/${jcId}/exclude`, { method: 'PUT' });
    openSubPlan(parentId, window.__SP_PARENT_LABEL);
  } catch (e) { alert(e.message); }
};
window.includeSubStage = async (jcId, parentId) => {
  try {
    await api(`/projects/job-cards/${jcId}/include`, { method: 'PUT' });
    openSubPlan(parentId, window.__SP_PARENT_LABEL);
  } catch (e) { alert(e.message); }
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

// service.js - Service requests, Service Centers, Site Visits, Daily Work Log.

// ---- Service Request Management ----
// Step 1: anyone in Service logs a request (customer/issue only - no
// schedule yet) and it lands in the Service Request Queue below. Step 2:
// only the Service HOD/Supervisor (or Admin) opens a queued request and
// schedules it - assigns a service employee (from Employees) and a date.
const INBOX_STATUS_NOTE = {
  AutoCreated: 'A new Service Request was created automatically and is waiting on HOD/Supervisor approval under My Approvals.',
  ThreadLinked: 'Recognized as a follow-up in an existing conversation - appended to that SR\'s Activity Log instead of creating a new request.',
  Quarantined: 'Could not be processed automatically - review below and either Confirm it into a real SR by hand, or Dismiss it.',
  Pending: 'Awaiting manual review.',
  Confirmed: 'Manually confirmed into a Service Request.',
  Dismissed: 'Dismissed - no Service Request was created.',
};
function inboxItemCard(i) {
  const needsAction = ['Pending', 'Quarantined'].includes(i.status);
  return `
    <div class="box" style="border:1px solid var(--border,#ccc);border-radius:6px;padding:10px;margin-bottom:10px;">
      <p style="margin:0 0 4px;"><b>${esc(i.from_name)||esc(i.from_address)}</b> &lt;${esc(i.from_address)}&gt; &middot; <span class="muted">${i.received_at ? new Date(i.received_at).toLocaleString() : '-'}</span> &middot; ${badge(i.status)}</p>
      <p style="margin:0 0 4px;"><b>Subject:</b> ${esc(i.subject)||'-'}</p>
      ${i.linked_sr_no ? `<p style="margin:0 0 4px;"><b>Service Request:</b> ${esc(i.linked_sr_no)} ${badge(i.linked_sr_status)}</p>` : ''}
      ${!i.linked_sr_no ? `<p style="margin:0 0 4px;"><b>${i.matched_client_name ? 'Matched Client' : 'Guessed Customer'}:</b> ${esc(i.matched_client_name || i.guessed_customer_name)||'-'}${i.guessed_contact_phone ? ' &middot; ' + esc(i.guessed_contact_phone) : ''}</p>` : ''}
      ${i.quarantine_reason ? `<p style="margin:0 0 4px;" class="msg err" style="display:block;">${esc(i.quarantine_reason)}</p>` : ''}
      <p class="muted" style="margin:0 0 4px;font-size:12px;">${esc(INBOX_STATUS_NOTE[i.status] || '')}</p>
      <details style="margin:6px 0;"><summary class="muted" style="cursor:pointer;">Full email text</summary><pre style="white-space:pre-wrap;font-family:inherit;margin:6px 0 0;">${esc(i.body_text)||'-'}</pre></details>
      ${needsAction ? (i.can_confirm
        ? `<div style="margin-top:8px;"><button class="btn small" onclick="openConfirmIncoming(${i.id})">Confirm as Service Request</button> <button class="btn small outline" onclick="dismissIncoming(${i.id})">Dismiss</button></div>`
        : '<p class="muted">Only the Service HOD/Supervisor (or Admin) can confirm or dismiss.</p>') : ''}
      <div id="incoming-confirm-${i.id}"></div>
    </div>`;
}
PAGES.service = async (el) => {
  const [reqs, clients, inbox] = await Promise.all([api('/service'), api('/masters/clients'), api('/service/inbox').catch(() => [])]);
  window.__SERVICE_INBOX = inbox;
  window.__SERVICE_CLIENTS = clients;
  window.__SERVICE_REQS = reqs;
  const needsReview = inbox.filter(i => ['Pending', 'Quarantined'].includes(i.status));
  el.innerHTML = `
    ${collapsiblePanel('service-incoming-requests', `Incoming Requests (Email) (${inbox.length}${needsReview.length ? `, ${needsReview.length} need review` : ''})`, `
      <p class="muted">Every inbound email to the Service mailbox from the last Scan Window (days) setting is shown here - it rolls forward with the mailbox, so an older entry drops off this list once it ages past that window rather than sitting here forever (it stays on record - a linked Service Request's "View Original Email" still works regardless of age). A genuinely new request automatically becomes a Service Request awaiting HOD/Supervisor approval (My Approvals) - a follow-up in an existing conversation is appended to that request's Activity Log instead, and a message that couldn't be processed automatically (quarantined) needs manual review below. Only mail still unread in the mailbox at the time of a poll is picked up - opening it in a mail client first means it will be missed.</p>
      ${ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="scanIncomingMailNow()">Scan Mailbox Now</button> <span id="incoming-scan-result" class="muted" style="margin-left:8px;"></span>` : ''}
      ${inbox.length ? inbox.map(inboxItemCard).join('') : '<div class="empty">No incoming emails recorded yet.</div>'}
    `)}
    ${isServiceHOD() ? collapsiblePanel('service-ack-template', 'Customer Acknowledgement Email', `
      <p class="muted">Sent automatically to the customer the moment their email creates a new Service Request (first contact only - never resent on a follow-up). Merge fields: <code>{{sr_no}}</code>, <code>{{customer_name}}</code>, <code>{{subject}}</code>.</p>
      <div id="svc-ack-body"><p class="muted">Loading...</p></div>
    `) : ''}
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
      <div class="hig-savebar"><button class="btn" onclick="addSR()">Log Request</button></div>
    </div>
    ${(() => {
      // Closed/Rejected is the one bucket that only ever grows (completed
      // history) - same "collapsed-by-default, everything else stays open"
      // split the Site Visits page already uses for its own Closed bucket.
      const CLOSED_STATUSES = ['Closed', 'Rejected'];
      const activeReqs = reqs.filter(r => !CLOSED_STATUSES.includes(r.status));
      const closedReqs = reqs.filter(r => CLOSED_STATUSES.includes(r.status));
      const cols = ['SR No', 'Customer', 'Contact', 'Scheduled', 'Assigned', 'Issue', 'Status', 'Prev. Report', 'Action'];
      window.__SR_ALL = reqs;
      window.__SR_COLS = cols;
      window.__SR_CLOSED = CLOSED_STATUSES;
      return `
      <div class="panel"><h3>Find a Service Request</h3>
        <input id="sr-search" type="text" placeholder="Search by SR no, customer, contact name, phone number, technician or issue..."
          oninput="filterSRQueues()" style="width:100%;max-width:520px;padding:7px 10px;border:1px solid var(--border);border-radius:5px;font-size:13px;">
        <span id="sr-search-count" class="muted" style="margin-left:8px;"></span>
      </div>
      <div class="panel"><h3 id="sr-active-title">Service Request Queue (${activeReqs.length})</h3>
        <p class="muted">Newly logged requests appear here first. The Service HOD/Supervisor opens one and schedules it (assigns an employee + date) - only then does it move to In Progress. Closed/Rejected requests move to the Closed section below.</p>
        <div id="sr-active-wrap">${tableHTML(cols, activeReqs, srRowHTML)}</div>
      </div>
      ${collapsiblePanel('service-request-queue-closed', `<span id="sr-closed-title">Closed (${closedReqs.length})</span>`, `<div id="sr-closed-wrap">${tableHTML(cols, closedReqs, srRowHTML)}</div>`)}`;
    })()}
    <div class="panel" id="sr-history-panel" style="display:none;"><h3 id="sr-history-title">Previous Technician Report(s)</h3><div id="sr-history-body"></div></div>
    <div class="panel" id="sr-updates-panel" style="display:none;"><h3 id="sr-updates-title">Activity Log</h3><div id="sr-updates-body"></div></div>
    <div class="panel" id="sr-email-panel" style="display:none;"><h3 id="sr-email-title">Original Email</h3><div id="sr-email-body"></div></div>`;
  if (isServiceHOD()) renderServiceAckTemplate();
};
async function renderServiceAckTemplate() {
  const body = document.getElementById('svc-ack-body');
  if (!body) return;
  const cfg = await api('/service/ack-template').catch(() => null);
  if (!cfg) { body.innerHTML = '<p class="muted">Could not load.</p>'; return; }
  body.innerHTML = `
    <label><input type="checkbox" id="svc-ack-enabled" ${cfg.enabled ? 'checked' : ''}> Send acknowledgement email on a new auto-created Service Request</label>
    <div style="margin-top:8px;"><label>Subject</label><input id="svc-ack-subject" style="width:100%;" value="${esc(cfg.subject)}"></div>
    <div style="margin-top:8px;"><label>Body</label><textarea id="svc-ack-body-text" rows="8" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(cfg.body)}</textarea></div>
    <button class="btn small" style="margin-top:8px;" onclick="saveServiceAckTemplate()">Save</button>
    <span id="svc-ack-saved" class="muted" style="margin-left:8px;display:none;">Saved.</span>`;
}
window.saveServiceAckTemplate = async () => {
  try {
    await api('/service/ack-template', { method: 'PUT', body: JSON.stringify({
      enabled: document.getElementById('svc-ack-enabled').checked,
      subject: val('svc-ack-subject'), body: val('svc-ack-body-text'),
    })});
    const savedEl = document.getElementById('svc-ack-saved');
    savedEl.style.display = 'inline';
    setTimeout(() => savedEl.style.display = 'none', 2000);
  } catch (e) { alert(e.message); }
};
// Filters both queues by one search box. Matches SR no, customer (master or manual), contact person,
// phone (also digits-only, so "98765 43210" finds "9876543210"), assigned technician and issue text.
window.filterSRQueues = () => {
  const q = (document.getElementById('sr-search').value || '').trim().toLowerCase();
  const qDigits = q.replace(/D/g, '');
  const hit = r => !q || [r.sr_no, r.client_master_name, r.customer_name, r.contact_person, r.contact_phone, r.employee_name, r.assigned_to_name, r.issue_description]
    .some(v => String(v ?? '').toLowerCase().includes(q))
    || (qDigits.length >= 3 && String(r.contact_phone || '').replace(/D/g, '').includes(qDigits));
  const rows = (window.__SR_ALL || []).filter(hit);
  const closed = window.__SR_CLOSED || [];
  const act = rows.filter(r => !closed.includes(r.status)), cl = rows.filter(r => closed.includes(r.status));
  document.getElementById('sr-active-wrap').innerHTML = tableHTML(window.__SR_COLS, act, srRowHTML);
  document.getElementById('sr-closed-wrap').innerHTML = tableHTML(window.__SR_COLS, cl, srRowHTML);
  document.getElementById('sr-active-title').textContent = 'Service Request Queue (' + act.length + ')';
  document.getElementById('sr-closed-title').textContent = 'Closed (' + cl.length + ')';
  // a search that only matches closed SRs should show them, not leave the panel collapsed
  const cp = document.getElementById('cp-service-request-queue-closed');
  if (q && cl.length && cp && cp.classList.contains('collapsed')) toggleCollapsiblePanel('service-request-queue-closed');
  document.getElementById('sr-search-count').textContent = q ? rows.length + ' match' + (rows.length === 1 ? '' : 'es') : '';
};
// Shared row renderer for both the active and Closed Service Request Queue
// tables - the Issue cell now also shows the auto-captured email excerpt
// (lib/inboundMail.js's emailExcerpt()) and, for an email-sourced SR, a
// "View Original Email" link straight to the source message, so "why was
// this SR created" never requires leaving the Queue to hunt through the
// Incoming Requests panel.
function srRowHTML(r) {
  return `
    <tr><td>${esc(r.sr_no)}</td><td>${esc(r.client_master_name || r.customer_name)}</td>
    <td>${esc(r.contact_person)||'-'}${r.contact_phone ? ' / ' + esc(r.contact_phone) : ''}</td>
    <td>${r.scheduled_date||'-'}</td><td>${esc(r.employee_name)||'-'}</td>
    <td>${esc(r.issue_description)}
      ${r.email_excerpt ? `<br><span class="muted" style="font-size:11px;">${esc(r.email_excerpt)}</span>` : ''}
      ${r.source === 'Email' ? `<br><a href="#" style="font-size:11px;" onclick="viewSrSourceEmail(${r.id},'${esc(r.sr_no)}');return false;">View Original Email</a>` : ''}
    </td>
    <td>${badge(r.status)}${r.status==='Pending Items' ? ' <span class="muted" style="font-size:11px;">(back from technician)</span>' : ''}</td>
    <td>${r.report_count ? `<button class="btn small outline" onclick="viewSrReportHistory(${r.id},'${esc(r.sr_no)}')">View (${r.report_count})</button> <button class="btn small outline" type="button" onclick="downloadSvcReportPdf(${r.id})">Report PDF</button>` : '-'}</td>
    <td>${actionButtonsCell(`${srActions(r)}
      <button class="btn small outline" type="button" onclick="openEditSR(${r.id})">Edit</button>
      <button class="btn small outline" type="button" onclick="viewSrUpdates(${r.id},'${esc(r.sr_no)}')">Updates</button>`)}</td></tr>`;
}
// Same source-email fetch as viewSrSourceEmail() below, but toggles inline
// inside the My Approvals drilldown card instead of the Service page's
// shared panel (that panel doesn't exist on this page).
window.toggleSrApprovalEmail = async (key, srId) => {
  const el = document.getElementById(`appr-drill-email-${key}`);
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  if (el.dataset.loaded) return;
  el.innerHTML = '<p class="muted">Loading...</p>';
  const { found, email } = await api(`/service/${srId}/source-email`).catch(() => ({ found: false }));
  el.innerHTML = found ? `
    <div style="padding:10px;background:#f9f9f9;border-radius:6px;font-size:13px;">
      <p style="margin:0 0 4px;"><b>${esc(email.from_name)||esc(email.from_address)}</b> &lt;${esc(email.from_address)}&gt; &middot; <span class="muted">${email.received_at ? new Date(email.received_at).toLocaleString() : '-'}</span></p>
      <p style="margin:0 0 6px;"><b>Subject:</b> ${esc(email.subject)||'-'}</p>
      <pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${esc(email.body_text)||'-'}</pre>
    </div>` : '<p class="muted">No original email on file for this SR.</p>';
  el.dataset.loaded = '1';
};
window.viewSrSourceEmail = async (srId, srNo) => {
  const panel = document.getElementById('sr-email-panel');
  const body = document.getElementById('sr-email-body');
  document.getElementById('sr-email-title').textContent = `Original Email - ${srNo}`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
  body.innerHTML = '<p class="muted">Loading...</p>';
  const { found, email } = await api(`/service/${srId}/source-email`).catch(() => ({ found: false }));
  if (!found) { body.innerHTML = '<p class="muted">No original email on file for this SR.</p>'; return; }
  body.innerHTML = `
    <p style="margin:0 0 4px;"><b>${esc(email.from_name)||esc(email.from_address)}</b> &lt;${esc(email.from_address)}&gt; &middot; <span class="muted">${email.received_at ? new Date(email.received_at).toLocaleString() : '-'}</span></p>
    <p style="margin:0 0 8px;"><b>Subject:</b> ${esc(email.subject)||'-'}</p>
    <pre style="white-space:pre-wrap;font-family:inherit;margin:0;border:1px solid var(--border,#ccc);border-radius:6px;padding:10px;">${esc(email.body_text)||'-'}</pre>`;
};
function srActions(r) {
  const parts = [];
  if (r.status === 'PendingApproval') {
    return '<span class="muted" style="font-size:11px;">Awaiting HOD/Supervisor approval (My Approvals)</span>';
  }
  if (r.can_schedule) parts.push(`<button class="btn small outline" onclick="openScheduleSR(${r.id})">${r.scheduled_date ? 'Reschedule' : 'Open & Schedule'}</button>`);
  if (r.status !== 'Closed' && r.status !== 'Rejected') {
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
window.openConfirmIncoming = (id) => {
  const item = (window.__SERVICE_INBOX || []).find(i => i.id === id);
  if (!item) return;
  const clients = window.__SERVICE_CLIENTS || [];
  const wrap = document.getElementById(`incoming-confirm-${id}`);
  wrap.innerHTML = `
    <div class="form-grid" style="margin-top:10px;border-top:1px solid var(--border,#ccc);padding-top:10px;">
      <div><label>Customer (from Clients)</label><select id="ic-client-${id}" onchange="document.getElementById('ic-manual-wrap-${id}').style.display = this.value ? 'none' : 'grid'">
        <option value="">-- Enter customer name manually instead --</option>
        ${clients.map(c => `<option value="${c.id}" ${item.matched_client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></div>
      <div><label>Contact Person</label><input id="ic-contact-person-${id}"></div>
      <div><label>Contact Number</label><input id="ic-contact-phone-${id}" value="${esc(item.guessed_contact_phone)}"></div>
    </div>
    <div class="form-grid" id="ic-manual-wrap-${id}" style="display:${item.matched_client_id ? 'none' : 'grid'};">
      <div><label>Customer Name (manual)</label><input id="ic-cust-name-${id}" value="${esc(item.guessed_customer_name)}"></div>
    </div>
    <div class="form-grid">
      <div style="grid-column:1/-1;"><label>Issue Description</label><textarea id="ic-desc-${id}" rows="2">${esc(item.subject || item.body_text)}</textarea></div>
      <div><label>Spare Parts Needed</label><input id="ic-parts-${id}"></div>
    </div>
    <div class="hig-savebar">
      <button class="btn small" onclick="saveConfirmIncoming(${id})">Save as Service Request</button>
      <button class="btn small outline" type="button" onclick="document.getElementById('incoming-confirm-${id}').innerHTML=''">Cancel</button>
    </div>
    <div id="ic-err-${id}" class="msg err" style="display:none;margin-top:6px;"></div>`;
};
window.saveConfirmIncoming = async (id) => {
  const errEl = document.getElementById(`ic-err-${id}`);
  errEl.style.display = 'none';
  try {
    await api(`/service/inbox/${id}/confirm`, { method: 'POST', body: JSON.stringify({
      client_id: val(`ic-client-${id}`) || null, customer_name: val(`ic-cust-name-${id}`),
      contact_person: val(`ic-contact-person-${id}`), contact_phone: val(`ic-contact-phone-${id}`),
      issue_description: val(`ic-desc-${id}`), spare_parts_needed: val(`ic-parts-${id}`),
    })});
    navigate('service');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.dismissIncoming = async (id) => {
  const reason = prompt('Reason for dismissing this incoming email (optional):');
  if (reason === null) return;
  try {
    await api(`/service/inbox/${id}/dismiss`, { method: 'POST', body: JSON.stringify({ reason }) });
    navigate('service');
  } catch (e) { alert(e.message); }
};
window.scanIncomingMailNow = async () => {
  const resultEl = document.getElementById('incoming-scan-result');
  resultEl.textContent = 'Scanning...';
  try {
    const r = await api('/service/inbox/scan', { method: 'POST' });
    if (!r.ran) { resultEl.textContent = r.reason || 'Scan did not run.'; return; }
    resultEl.textContent = `Done: ${r.created} new SR${r.created===1?'':'s'}, ${r.threadLinked} thread-linked, ${r.quarantined} quarantined, ${r.skipped} already seen, ${r.failed} failed.`;
    // Only mail still unread in the mailbox is ever picked up - anything
    // already processed on a prior poll is flagged \Seen and won't resurface
    // here, by design (otherwise a repeat scan would create duplicate SRs).
    if (r.created || r.threadLinked || r.quarantined) navigate('service');
  } catch (e) { resultEl.textContent = e.message; }
};
window.updateSR = async (id, status) => {
  if (!status) return;
  await api(`/service/${id}`, { method: 'PATCH', body: JSON.stringify({ status })});
  navigate('service');
};
// Schedule and Edit (below) both open as a popup rather than filling a
// panel elsewhere on the page - the previous pattern left no indication of
// which SR a scroll-to-the-bottom panel actually belonged to (reported
// directly by the owner). The modal's own title carries the SR No and
// customer, so that's never ambiguous.
function srModalTitle(r, action) {
  return `${action} &mdash; ${esc(r.sr_no)} <span class="muted" style="font-size:13px;font-weight:normal;">(${esc(r.client_master_name || r.customer_name) || 'no customer on file'})</span>`;
}
window.openScheduleSR = async (id) => {
  const r = (window.__SERVICE_REQS || []).find(x => x.id === id);
  const employees = await api('/hr/employees');
  openAppModal(r ? srModalTitle(r, 'Schedule') : 'Schedule Service Request', `
    <div class="form-grid">
      <div><label>Assign Service Employee</label><select id="sr-sch-emp">${employees.map(e => `<option value="${e.id}">${esc(e.full_name)} (${esc(e.department_name)})</option>`).join('')}</select></div>
      <div><label>Scheduled Date</label><input id="sr-sch-date" type="date" value="${today()}"></div>
    </div>
    <div class="hig-savebar"><button class="btn" onclick="saveScheduleSR(${id})">Save Schedule</button></div>
    <div id="sr-sch-err" class="msg err" style="display:none;margin-top:10px;"></div>`);
};
window.saveScheduleSR = async (id) => {
  const errEl = document.getElementById('sr-sch-err');
  try {
    await api(`/service/${id}/schedule`, { method: 'PATCH', body: JSON.stringify({ employee_id: val('sr-sch-emp'), scheduled_date: val('sr-sch-date') }) });
    closeAppModal();
    navigate('service');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
// Edit option (reported missing by the owner) - corrects an auto-created
// SR's guessed/wrong customer match, contact, issue description or spare
// parts needed. Open to anyone with service_request.manage, same as the
// rest of the Queue's actions (status dropdown, activity log) - not
// specially restricted to HOD/Admin. Same dual client-vs-manual-name
// picker the "Log Service Request" form above already uses.
window.openEditSR = (id) => {
  const r = (window.__SERVICE_REQS || []).find(x => x.id === id);
  if (!r) { alert('Service Request not found - refresh the page.'); return; }
  const clients = window.__SERVICE_CLIENTS || [];
  openAppModal(srModalTitle(r, 'Edit'), `
    <div class="form-grid">
      <div><label>Customer (from Clients)</label><select id="sr-edit-client" onchange="document.getElementById('sr-edit-manual-wrap').style.display = this.value ? 'none' : 'grid'">
        <option value="">-- Enter customer manually instead --</option>
        ${clients.map(c => `<option value="${c.id}" ${r.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></div>
      <div><label>Customer Contact Person</label><input id="sr-edit-contact-person" value="${esc(r.contact_person)}"></div>
      <div><label>Customer Contact Number</label><input id="sr-edit-contact-phone" value="${esc(r.contact_phone)}"></div>
    </div>
    <div class="form-grid" id="sr-edit-manual-wrap" style="display:${r.client_id ? 'none' : 'grid'};">
      <div><label>Customer Name (manual)</label><input id="sr-edit-cust-name" value="${esc(r.customer_name)}"></div>
    </div>
    <div class="form-grid">
      <div style="grid-column:1/-1;"><label>Issue Description</label><textarea id="sr-edit-desc" rows="2" style="width:100%;">${esc(r.issue_description)}</textarea></div>
      <div><label>Spare Parts Needed</label><input id="sr-edit-parts" value="${esc(r.spare_parts_needed)}"></div>
    </div>
    <div class="hig-savebar"><button class="btn" onclick="saveEditSR(${id})">Save Changes</button></div>
    <div id="sr-edit-err" class="msg err" style="display:none;margin-top:10px;"></div>`);
};
window.saveEditSR = async (id) => {
  const errEl = document.getElementById('sr-edit-err');
  errEl.style.display = 'none';
  const clientId = val('sr-edit-client');
  try {
    await api(`/service/${id}`, { method: 'PATCH', body: JSON.stringify({
      client_id: clientId || null,
      customer_name: clientId ? null : val('sr-edit-cust-name'),
      contact_person: val('sr-edit-contact-person'),
      contact_phone: val('sr-edit-contact-phone'),
      issue_description: val('sr-edit-desc'),
      spare_parts_needed: val('sr-edit-parts'),
    })});
    closeAppModal();
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
    <div id="svc-spares-lines" class="hig-entry"></div>
    ${editable ? `<button class="btn small outline" type="button" onclick="addSvcSpareLine()">+ Add Spare Line</button>` : ''}
    ${editable ? `
      <div class="hig-savebar">
        <button class="btn outline" onclick="saveServiceReport(${srId}, false)">Save Draft</button>
        <button class="btn green" onclick="saveServiceReport(${srId}, true)">Submit</button>
      </div>
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
    openOrDownloadBlob(blob, match ? match[1] : 'service-report-' + srId + '.pdf');
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
      const today = localDateStr(new Date());
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

// ===================== Service Centers (Round 7) =====================

// ---- Sheet: Service Centers Master ----
let EDITING_SC_ID = null;
PAGES['service-centers'] = async (el) => {
  const centers = await api('/service-centers');
  const scPanels = {
    'add-edit': `
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
      <div class="hig-savebar">
        <button class="btn" onclick="saveServiceCenter()">${EDITING_SC_ID ? 'Save Changes' : 'Add Service Center'}</button>
        ${EDITING_SC_ID ? `<button class="btn outline" onclick="EDITING_SC_ID=null;navigate('service-centers')">Cancel</button>` : ''}
      </div>
    </div>`,
    'list': collapsiblePanel('service-centers-list', `Service Centers (${centers.length})`, `
      ${tableHTML(['Name', 'City', 'Contact', 'Phone', 'Status', ''], centers, c => `
        <tr><td>${esc(c.name)}</td><td>${esc(c.city)||'-'}</td><td>${esc(c.contact_person)||'-'}</td><td>${esc(c.phone)||'-'}</td>
        <td>${badge(c.status)}</td>
        <td><button class="btn small outline" onclick="editServiceCenter(${c.id})">Edit</button></td></tr>`)}
    `),
  };
  const scLabels = { 'add-edit': 'Add / Edit Service Center', 'list': 'Service Centers List' };
  const scOrder = await fetchPanelOrder('service-centers', Object.keys(scPanels));
  el.innerHTML = reorderablePanelsHTML('service-centers', scPanels, scOrder, scLabels);
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
  const sctPanels = {
    'dispatch': `
    <div class="panel"><h3>Dispatch Spares to a Service Center</h3>
      <p class="muted">Issues from the central store (Item Master stock) to a service center. Deducts central stock immediately; the center confirms actual received quantity separately.</p>
      <div class="form-grid">
        <div><label>Service Center</label><select id="sct-center">${window.__SCT_CENTERS.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.city)||'-'})</option>`).join('') || '<option value="">- No active service centers -</option>'}</select></div>
        <div><label>Notes</label><input id="sct-notes"></div>
      </div>
      <div id="sct-lines" class="hig-entry"></div>
      <button class="btn small outline" type="button" onclick="addSCTLine()">+ Add Line Item</button>
      <div class="hig-savebar"><button class="btn green" onclick="saveSCTransfer()">Dispatch Transfer</button></div>
      <div id="sct-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>`,
    'list': collapsiblePanel('transfers-list', `Transfers (${transfers.length})`, `
      ${tableHTML(['Transfer No', 'Service Center', 'Items', 'Status', 'Dispatched By', 'Dispatched At'], transfers, t => `
        <tr><td>${esc(t.transfer_no)}</td><td>${esc(t.service_center_name)} (${esc(t.service_center_city)||'-'})</td><td>${t.item_count}</td>
        <td>${badge(t.status)}</td><td>${esc(t.dispatched_by_name)||'-'}</td><td>${new Date(t.dispatched_at).toLocaleString()}</td></tr>`)}
    `),
  };
  const sctLabels = { 'dispatch': 'Dispatch Spares to a Service Center', 'list': 'Transfers List' };
  const sctOrder = await fetchPanelOrder('sc-transfers', Object.keys(sctPanels));
  el.innerHTML = reorderablePanelsHTML('sc-transfers', sctPanels, sctOrder, sctLabels);
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
  const scsPanels = {
    'per-center': `
    <div class="panel"><h3>Per-Center Stock</h3>
      <select id="scs-center" onchange="loadSCStock()">
        <option value="">- Select a service center -</option>
        ${centers.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.city)||'-'})</option>`).join('')}
      </select>
      <div id="scs-body" style="margin-top:12px;"></div>
    </div>`,
    'summary': collapsiblePanel('sc-stock-summary', `Company-Wide: Central Store vs Distributed to Centers (${summary.length})`, `
      ${tableHTML(['Item', 'Central Store Stock', 'Total at Service Centers', 'Breakdown'], summary, i => `
        <tr><td>${esc(i.name)}${i.item_code?' ('+esc(i.item_code)+')':''}</td><td>${fmt(i.current_stock)} ${esc(i.unit)||''}</td>
        <td>${fmt(i.total_at_centers)} ${esc(i.unit)||''}</td>
        <td>${i.centers.map(c => `${esc(c.service_center_name)}: ${fmt(c.quantity)}`).join(', ') || '-'}</td></tr>`)}
    `),
  };
  const scsLabels = { 'per-center': 'Per-Center Stock', 'summary': 'Company-Wide: Central Store vs Distributed to Centers' };
  const scsOrder = await fetchPanelOrder('sc-stock', Object.keys(scsPanels));
  el.innerHTML = reorderablePanelsHTML('sc-stock', scsPanels, scsOrder, scsLabels);
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
      <div class="hig-savebar">
        <button class="btn" onclick="saveSiteVisit(${ed?ed.id:'null'})">${ed?'Save Changes':'Add Visit'}</button>
        ${ed ? `<button class="btn outline" onclick="EDITING_VISIT_ID=null;navigate('site-visits')">Cancel</button>` : ''}
      </div>
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
// Desktop: month grid (engineer x day) with a sticky engineer column. Phone (<768px): a one-day card view - pick a day,
// one stacked card per engineer. Same cells in both (every cell is always in the DOM), so the single bulk Save still
// writes the whole month. All styling is scoped under .dwl-page.
let DWL_MONTH = null;
let DWL_DAY = null;
const DWL_STATUSES = ['', 'Pending', 'InProgress', 'Completed', 'OnHold'];
const DWL_LABELS = { Pending: 'Pending', InProgress: 'In Progress', Completed: 'Completed', OnHold: 'On Hold' };
const DWL_CSS = `<style>
.dwl-page{background:#f5f5f7;border-radius:12px;padding:16px;font-variant-numeric:tabular-nums;}
.dwl-page .dwl-card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px;}
.dwl-page .dwl-title{margin:0;font-size:19px;font-weight:600;letter-spacing:-.01em;color:var(--text);}
.dwl-page .dwl-caption{margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--muted);max-width:760px;}
.dwl-page .dwl-controls{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;margin-top:16px;}
.dwl-page .dwl-field{display:flex;flex-direction:column;}
.dwl-page .dwl-field label,.dwl-page .dwl-lbl{display:block;font-size:12px;font-weight:500;color:var(--muted);margin:0 0 6px;}
.dwl-page input,.dwl-page select{box-sizing:border-box;min-height:40px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;background:#fff;color:var(--text);transition:border-color 150ms ease,box-shadow 150ms ease;}
.dwl-page input:focus,.dwl-page select:focus{outline:none;border-color:var(--primary-light);box-shadow:0 0 0 3px rgba(44,82,130,.18);}
.dwl-page .dwl-btn{min-height:40px;border-radius:8px;padding:8px 18px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;transition:background 150ms ease,transform 150ms ease,border-color 150ms ease;}
.dwl-page .dwl-btn.primary{background:var(--primary);color:#fff;border:1px solid var(--primary);}
.dwl-page .dwl-btn.primary:hover{background:var(--primary-light);}
.dwl-page .dwl-btn.secondary{background:#fff;color:var(--primary);border:1px solid var(--border);}
.dwl-page .dwl-btn.secondary:hover{border-color:var(--primary-light);background:#f5f8fb;}
.dwl-page .dwl-btn:active{transform:scale(.98);}
.dwl-page .dwl-btn:disabled{opacity:.6;cursor:default;}
.dwl-page .dwl-scroll{overflow-x:auto;border:1px solid var(--border);border-radius:10px;}
.dwl-page .dwl-table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;}
.dwl-page .dwl-table th{position:sticky;top:0;background:#f7f9fb;font-size:12px;font-weight:600;color:var(--muted);text-align:left;padding:10px 8px;border-bottom:1px solid var(--border);min-width:156px;}
.dwl-page .dwl-table th small{display:block;font-weight:500;font-size:11px;opacity:.8;}
.dwl-page .dwl-table td{padding:8px;border-bottom:1px solid #edf1f4;vertical-align:top;}
.dwl-page .dwl-table tr:last-child td{border-bottom:none;}
.dwl-page .dwl-table th:first-child,.dwl-page .dwl-table td:first-child{position:sticky;left:0;z-index:2;background:#fff;min-width:150px;border-right:1px solid var(--border);font-weight:600;font-size:14px;}
.dwl-page .dwl-table th:first-child{background:#f7f9fb;z-index:3;}
.dwl-page .dwl-table .dwl-today{background:#f1f6fc;}
.dwl-page .dwl-table th.dwl-today{color:var(--primary);}
.dwl-page .dwl-daycell input,.dwl-page .dwl-daycell select{width:100%;}
.dwl-page .dwl-lbl,.dwl-page .dwl-datecap{display:none;}
.dwl-page .dwl-statusrow{margin-top:4px;}
.dwl-page .dwl-pill-slot{display:block;margin-top:4px;min-height:20px;}
.dwl-page .dwl-pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap;}
.dwl-page .dwl-st-Pending{background:#fef3cd;color:#8a5a00;}
.dwl-page .dwl-st-InProgress{background:#dbeafe;color:#1d4ed8;}
.dwl-page .dwl-st-Completed{background:#dcf3e6;color:#276749;}
.dwl-page .dwl-st-OnHold{background:#eeeeee;color:#555;}
.dwl-page .dwl-empty{text-align:center;padding:40px 16px;color:var(--muted);}
.dwl-page .dwl-empty b{display:block;font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px;}
.dwl-page .dwl-skel{height:14px;border-radius:7px;background:#e9edf1;margin:12px 0;animation:dwlpulse 1.2s ease-in-out infinite;}
@keyframes dwlpulse{50%{opacity:.5;}}
.dwl-page .dwl-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;}
.dwl-page .dwl-err{display:none;margin:12px 0 0;}
@media (max-width:767px){
  .dwl-page{padding:12px;}
  .dwl-page .dwl-card{padding:16px;}
  .dwl-page .dwl-scroll{overflow:visible;border:none;border-radius:0;}
  .dwl-page .dwl-table,.dwl-page .dwl-table tbody,.dwl-page .dwl-table tr,.dwl-page .dwl-table td{display:block;width:auto;min-width:0;}
  .dwl-page .dwl-table thead{display:none;}
  .dwl-page .dwl-table tr{border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px;background:#fff;}
  .dwl-page .dwl-table td{border:none;padding:0;}
  .dwl-page .dwl-table td:first-child{position:static;border:none;font-size:17px;font-weight:600;letter-spacing:-.01em;margin-bottom:10px;min-width:0;}
  .dwl-page .dwl-table td.dwl-daycell{display:none;}
  .dwl-page .dwl-table td.dwl-daycell.dwl-sel{display:block;background:none;}
  .dwl-page .dwl-datecap{display:block;font-size:13px;color:var(--muted);margin-bottom:10px;}
  .dwl-page .dwl-lbl{display:block;}
  .dwl-page input,.dwl-page select,.dwl-page .dwl-btn{min-height:44px;width:100%;}
  .dwl-page .dwl-field{width:100%;}
  .dwl-page .dwl-statusrow{margin-top:0;}
  .dwl-page .dwl-actions .dwl-btn{width:100%;}
}
</style>`;
const dwlPillHTML = (st) => st ? `<span class="dwl-pill dwl-st-${esc(st)}">${esc(DWL_LABELS[st] || st)}</span>` : '';
window.dwlStatusChanged = (sel) => {
  const slot = sel.closest('.dwl-daycell').querySelector('.dwl-pill-slot');
  if (slot) slot.innerHTML = dwlPillHTML(sel.value);
};
// Day card view (phone) + column highlight/scroll (desktop).
window.dwlSetDay = (date) => {
  if (!date || date.slice(0, 7) !== DWL_MONTH) return;
  DWL_DAY = date;
  document.querySelectorAll('.dwl-page .dwl-daycell').forEach(c => c.classList.toggle('dwl-sel', c.dataset.date === date));
  const th = document.querySelector(`.dwl-page th[data-date="${date}"]`);
  if (th && th.offsetParent) { const box = th.closest('.dwl-scroll'); if (box) box.scrollLeft = Math.max(0, th.offsetLeft - 200); }
};
window.dwlGoToday = () => {
  if (thisMonth() !== DWL_MONTH) { DWL_MONTH = thisMonth(); DWL_DAY = today(); navigate('daily-work-log'); return; }
  const inp = document.getElementById('dwl-day'); if (inp) inp.value = today();
  dwlSetDay(today());
};
PAGES['daily-work-log'] = async (el) => {
  const month = DWL_MONTH || thisMonth();
  DWL_MONTH = month;
  el.innerHTML = `${DWL_CSS}<div class="dwl-page"><div class="dwl-card"><div class="dwl-skel" style="width:40%"></div><div class="dwl-skel"></div><div class="dwl-skel" style="width:70%"></div></div></div>`;
  const [engineers, logs] = await Promise.all([api('/site-visits/engineers'), api('/site-visits/daily-log?month=' + month)]);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const byKey = {};
  logs.forEach(l => { byKey[l.employee_id + '|' + l.log_date] = l; });
  const dayCols = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const dateFor = (d) => `${month}-${String(d).padStart(2, '0')}`;
  const todayStr = today();
  if (!DWL_DAY || DWL_DAY.slice(0, 7) !== month) DWL_DAY = todayStr.slice(0, 7) === month ? todayStr : dateFor(1);
  const wd = (d) => new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short' });
  const cap = (d) => new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  const cls = (d) => (dateFor(d) === todayStr ? ' dwl-today' : '') + (dateFor(d) === DWL_DAY ? ' dwl-sel' : '');
  const grid = engineers.length ? `
      <div class="dwl-scroll">
        <table class="dwl-table"><thead><tr><th>Engineer</th>
          ${dayCols.map(d => `<th data-date="${dateFor(d)}" class="${dateFor(d) === todayStr ? 'dwl-today' : ''}">${d}<small>${wd(d)}</small></th>`).join('')}</tr></thead>
        <tbody>
          ${engineers.map(e => `<tr><td>${esc(e.full_name)}</td>
            ${dayCols.map(d => { const cell = byKey[e.id + '|' + dateFor(d)] || {}; return `<td class="dwl-daycell${cls(d)}" data-date="${dateFor(d)}">
              <div class="dwl-datecap">${esc(cap(d))}</div>
              <label class="dwl-lbl">Work summary</label>
              <input class="dwl-cell" data-emp="${e.id}" data-date="${dateFor(d)}" value="${esc(cell.note || '')}" aria-label="Work summary for ${esc(e.full_name)}, day ${d}">
              <div class="dwl-statusrow"><label class="dwl-lbl">Status</label>
                <select class="dwl-status" data-emp="${e.id}" data-date="${dateFor(d)}" onchange="dwlStatusChanged(this)" aria-label="Status for ${esc(e.full_name)}, day ${d}" title="${cell.assigned_by_name ? 'Assigned by ' + esc(cell.assigned_by_name) : ''}">
                  ${DWL_STATUSES.map(s => `<option value="${s}" ${cell.status === s ? 'selected' : ''}>${s ? esc(DWL_LABELS[s] || s) : '(no status)'}</option>`).join('')}
                </select>
                <span class="dwl-pill-slot">${dwlPillHTML(cell.status)}</span></div>
            </td>`; }).join('')}
          </tr>`).join('')}
        </tbody></table>
      </div>` : `<div class="dwl-empty"><b>No engineers to log yet</b>Engineers appear here once they are set up in Employees.</div>`;
  el.innerHTML = `${DWL_CSS}<div class="dwl-page">
    <div class="dwl-card">
      <h3 class="dwl-title">Engineer Daily Work Log</h3>
      <p class="dwl-caption">One cell per engineer per day - type the job/site they worked on, or a shorthand like "OD" (outdoor duty), "A" (absent), "1/2" (half day), same as the old sheet. Optionally set a Status when you're actively assigning that day's task rather than just recording what happened - leave it blank for a plain note.</p>
      <div class="dwl-controls">
        <div class="dwl-field"><label for="dwl-month">Month</label>
          <input id="dwl-month" type="month" value="${month}" onchange="DWL_MONTH=this.value;DWL_DAY=null;navigate('daily-work-log')"></div>
        <div class="dwl-field"><label for="dwl-day">Day</label>
          <input id="dwl-day" type="date" value="${DWL_DAY}" min="${dateFor(1)}" max="${dateFor(daysInMonth)}" onchange="dwlSetDay(this.value)"></div>
        <button class="dwl-btn secondary" type="button" onclick="dwlGoToday()">Today</button>
      </div>
    </div>
    <div class="dwl-card">${grid}</div>
    ${engineers.length ? `<div class="dwl-actions"><button class="dwl-btn primary" id="dwl-save-btn" type="button" onclick="saveDailyWorkLog()">Save</button></div>` : ''}
    <div id="dwl-err" class="msg err dwl-err"></div>
  </div>`;
  setTimeout(() => dwlSetDay(DWL_DAY), 0);
};
window.saveDailyWorkLog = async () => {
  const errEl = document.getElementById('dwl-err');
  errEl.style.display = 'none';
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
    confirmSavedThenClose('dwl-save-btn', 'daily-work-log');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// sales.js - Clients, Leads, Orders, FG Dispatch, MRN, Sales Returns/Credit Notes, Offers, Spares comparison,
// Sales Analytics/Targets.

// DD/MM/YYYY for every date / timestamp this file prints. Stored values are 'YYYY-MM-DD[ HH:MM:SS]' with no zone marker, so they are parsed by
// hand (never new Date(str)), and the old toLocaleDateString() printed US MM/DD/YYYY. Inputs and CSV exports keep the raw YYYY-MM-DD value.
function fmtDMY(v, withTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v == null ? '' : v));
  if (!m) return v ? String(v) : '-';
  return `${m[3]}/${m[2]}/${m[1]}` + (withTime && m[4] ? ` ${m[4]}:${m[5]}` : '');
}
// deliveryBadge() (ui.js, shared with Purchase) decides the colour and the "(overdue Nd)" text; only the date inside its label is reformatted.
function soDeliveryBadge(d) { return d ? deliveryBadge(d).replace(esc(d), esc(fmtDMY(d))) : deliveryBadge(d); }

// ---- Clients ----
function renderClientRows(rows) {
  return tableHTML(['Client ID', 'Name', 'Group', 'Contact', 'Phone', 'Email', 'Address', 'Source', ''], rows, c => `
    <tr><td>${esc(c.client_code)||'-'}</td><td>${esc(c.name)}</td><td>${esc(c.group_name)||'-'}</td><td>${esc(c.contact_person)}</td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${esc(c.address)}</td><td>${esc(c.source)}</td>
    <td>${actionButtonsCell(`<button class="btn small outline" onclick='editClient(${JSON.stringify(c)})'>Edit</button>
    <button class="btn small outline" onclick="openClient360(${c.id})">View 360</button>`)}</td></tr>`);
}
function clientGroupOptionsHTML(selectedId) {
  return `<option value="">- None -</option>${(window.__CLIENT_GROUPS||[]).map(g => `<option value="${g.id}" ${Number(selectedId)===g.id?'selected':''}>${esc(g.name)}</option>`).join('')}`;
}
PAGES.clients = async (el) => {
  const [clients, groups] = await Promise.all([api('/masters/clients'), api('/masters/client-groups')]);
  window.__CLIENT_GROUPS = groups;
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
        <div><label>Customer Group <span class="muted">(optional)</span></label><select id="cl-group">${clientGroupOptionsHTML('')}</select></div>
      </div>
      <label>Address</label>
      <textarea id="cl-address" rows="2"></textarea>
      <div class="hig-savebar"><button class="btn" id="cl-save-btn" onclick="saveClient()">Add Client</button></div>
    </div>
    ${ME.role === 'Admin' ? collapsiblePanel('client-groups', 'Customer Groups', `
      <p class="muted">A Customer Group is a pure folder - a shared name tying several companies (each its own Client row, GSTIN, address) together, same as how a conglomerate's own filing already works. Nothing about an individual client's own details is shared or duplicated - assigning one to a group only changes how Offers/Sales Orders roll up in their lists and what shows as "sibling companies" on Customer 360.</p>
      <div id="client-groups-list">${clientGroupsListHTML(groups)}</div>
      <div class="form-grid">
        <div><label>New Group Name</label><input id="cg-new-name" placeholder="e.g. Adani Group"></div>
      </div>
      <button class="btn small" type="button" onclick="addClientGroup()">Add Group</button>
      <div id="cg-err" class="msg err" style="display:none;"></div>
    `) : ''}
    <button class="btn small outline" onclick="reportClients()">Generate Report (CSV)</button>
    ${collapsiblePanel('clients-list', `<span id="cl-count">All Clients (${clients.length})</span>`, `
      ${renderListSearch('clients', clients, ['client_code', 'name', 'group_name', 'contact_person', 'phone', 'email', 'address', 'source', 'gstin'], (rows) => {
        document.getElementById('cl-table-wrap').innerHTML = renderClientRows(rows);
        document.getElementById('cl-count').textContent = 'All Clients (' + rows.length + ')';
      }, 'Search by name, contact, phone, email, GSTIN, address...')}
      <div id="cl-table-wrap">${renderClientRows(clients)}</div>
    `)}`;
};
function clientGroupsListHTML(groups) {
  if (!groups.length) return '<p class="muted">No customer groups yet.</p>';
  return tableHTML(['Name', ''], groups, g => `
    <tr><td><input id="cg-name-${g.id}" value="${esc(g.name)}"></td>
    <td>${actionButtonsCell(`<button class="btn small outline" type="button" onclick="renameClientGroup(${g.id})">Save</button>
    <button class="btn small red" type="button" onclick="deleteClientGroup(${g.id})">Delete</button>`)}</td></tr>`);
}
window.addClientGroup = async () => {
  const errEl = document.getElementById('cg-err');
  errEl.style.display = 'none';
  try {
    await api('/masters/client-groups', { method: 'POST', body: JSON.stringify({ name: val('cg-new-name') }) });
    navigate('clients');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.renameClientGroup = async (id) => {
  const errEl = document.getElementById('cg-err');
  errEl.style.display = 'none';
  try {
    await api('/masters/client-groups/' + id, { method: 'PUT', body: JSON.stringify({ name: val('cg-name-' + id) }) });
    navigate('clients');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteClientGroup = async (id) => {
  if (!confirm('Delete this customer group? Any client still assigned to it must be moved first.')) return;
  const errEl = document.getElementById('cg-err');
  errEl.style.display = 'none';
  try {
    await api('/masters/client-groups/' + id, { method: 'DELETE' });
    navigate('clients');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
// Edit Client (2026-10-13: converted from repurposing the "Add Client" form
// at the top of the page - scroll-to-it, swap its title/button text - into
// the generic popup, see openEditVendor's own comment for why). A separate
// form from Add Client's own (cle- prefixed ids, not cl-) so Add stays
// completely untouched rather than needing an edit-mode branch inside it.
// Shared with openMissingBillingModal() below (the Confirm-Order recovery
// popup, 2026-10-15) so both use the identical fields/ids - only the
// wrapping title and what's appended after it differ. keepOpenOnSave=true
// (the recovery-modal caller) saves without closing the modal/navigating
// away - closing would destroy the "Retry Confirm Order" button and the
// Add Address panel still open underneath it, exactly the context the
// recovery popup exists to keep the user inside.
function clientEditFormHTML(c, keepOpenOnSave) {
  return `
    <div class="form-grid">
      <div><label>Name</label><input id="cle-name" value="${esc(c.name)}"></div>
      <div><label>Contact Person</label><input id="cle-contact" value="${esc(c.contact_person)}"></div>
      <div><label>Phone</label><input id="cle-phone" value="${esc(c.phone)}"></div>
      <div><label>Email</label><input id="cle-email" value="${esc(c.email)}"></div>
      <div><label>GSTIN</label><input id="cle-gstin" value="${esc(c.gstin)}"></div>
      <div><label>Source</label><input id="cle-source" value="${esc(c.source)}" placeholder="Referral / Website / Exhibition"></div>
      <div><label>Customer Group <span class="muted">(optional)</span></label><select id="cle-group">${clientGroupOptionsHTML(c.group_id)}</select></div>
    </div>
    <label>Address</label>
    <textarea id="cle-address" rows="2" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(c.address)}</textarea>
    <div class="hig-savebar"><button class="btn" id="cle-save-btn" onclick="saveClientEdit(${c.id}, ${!!keepOpenOnSave})">Save Changes</button></div>
    <div id="cle-err" class="msg err" style="display:none;margin-top:8px;"></div>
    <div id="cle-addr-panel" style="margin-top:14px;"></div>`;
}
// 2026-10-15 bug fix: this used to render the Bill-to/Ship-to Addresses
// panel into #cl-addresses-panel, a div sitting on the underlying Clients
// page - invisible once openAppModal() stacks its own full-viewport
// backdrop (z-index 200) on top, so the panel existed in the DOM but was
// completely unreachable. Now built directly into the modal body via
// clientEditFormHTML()'s own #cle-addr-panel placeholder.
window.editClient = (c) => {
  openAppModal('Edit Client — ' + esc(c.name) + (c.client_code ? ' (' + esc(c.client_code) + ')' : ''), clientEditFormHTML(c));
  renderClientAddressesPanel(c.id, 'cle-addr-panel');
};
// Confirm-Order recovery popup (2026-10-15) - POST /offers/:id/confirm's
// missing-billing-details 400 now carries the full client row structured
// (routes/offers.js), so instead of a bare alert() telling the user to go
// find Clients -> Edit themselves, the exact same Edit-Client form opens
// right here with a Retry button, so fixing the GSTIN/address and
// re-attempting confirmation never leaves the Offer Builder.
window.openMissingBillingModal = (c) => {
  openAppModal('Missing Billing Details — ' + esc(c.name), `
    <p class="msg err" style="display:block;">This order can't be confirmed yet - add a Billing address (Line 1, State, State Code) and/or GSTIN below, then retry.</p>
    ${clientEditFormHTML(c, true)}
    <div class="hig-savebar"><button class="btn" type="button" onclick="retryConfirmOfferFromModal()">Retry Confirm Order</button></div>
    <div id="cle-retry-err" class="msg err" style="display:none;"></div>`);
  renderClientAddressesPanel(c.id, 'cle-addr-panel');
};
window.retryConfirmOfferFromModal = async () => {
  const errEl = document.getElementById('cle-retry-err');
  errEl.style.display = 'none';
  try {
    const r = await api(`/offers/${CURRENT_OFFER_ID}/confirm`, { method: 'POST' });
    // Previously closed the popup and navigated away immediately on
    // success - the only way to see the result was the alert() box, with
    // no explicit control over when the window actually closed. Now shows
    // the result inside the still-open modal with its own Close/View
    // Project buttons, so the user decides when (and whether) to leave.
    document.getElementById('app-modal-body').innerHTML = `
      <p class="msg ok" style="display:block;">Sales Order ${esc(r.orderNo)} created. Project ${esc(r.projCode)} queued for execution across all departments.</p>
      <button class="btn" type="button" onclick="closeAppModal(); navigate('projects');">View Project</button>
      <button class="btn small outline" type="button" onclick="closeAppModal();">Close</button>`;
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
};
window.saveClientEdit = async (id, keepOpen) => {
  const errEl = document.getElementById('cle-err');
  const payload = {
    name: val('cle-name'), contact_person: val('cle-contact'), phone: val('cle-phone'),
    email: val('cle-email'), gstin: val('cle-gstin'), source: val('cle-source'), address: val('cle-address'),
    group_id: val('cle-group') || null,
  };
  try {
    await api('/masters/clients/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    if (keepOpen) {
      // Missing-billing recovery modal (2026-10-15) - closing here would
      // destroy the still-open Add Address form and the Retry Confirm
      // Order button beneath it, so just confirm the save happened and
      // stay put.
      const btn = document.getElementById('cle-save-btn');
      if (btn) {
        const original = btn.textContent;
        btn.textContent = 'Saved ✓';
        setTimeout(() => { if (btn.textContent === 'Saved ✓') btn.textContent = original; }, 1200);
      }
    } else {
      confirmSavedThenClose('cle-save-btn', 'clients');
    }
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.saveClient = async () => {
  const payload = {
    name: val('cl-name'), contact_person: val('cl-contact'), phone: val('cl-phone'),
    email: val('cl-email'), gstin: val('cl-gstin'), source: val('cl-source'), address: val('cl-address'),
    group_id: val('cl-group') || null,
  };
  try {
    await api('/masters/clients', { method: 'POST', body: JSON.stringify(payload) });
    navigate('clients');
  } catch (e) { alert(e.message); }
};
window.reportClients = async () => {
  const clients = await api('/masters/clients');
  downloadCSV('clients_report.csv', clients, ['id', 'client_code', 'name', 'group_name', 'contact_person', 'phone', 'email', 'address', 'gstin', 'source']);
};

// ---- Bill-to / Ship-to addresses (shown once a client exists to edit) ----
// targetId identifies which placeholder div to render into - both current
// callers (editClient, openMissingBillingModal) use the same modal-internal
// #cle-addr-panel id, but it's threaded through explicitly (not hardcoded)
// so this never silently regresses into rendering behind a modal again.
async function renderClientAddressesPanel(clientId, targetId) {
  const panel = document.getElementById(targetId);
  if (!panel) return;
  const addresses = await api(`/masters/clients/${clientId}/addresses`);
  CLIENT_ADDR_CACHE[targetId] = addresses;
  const addrRow = (a) => `<tr>
      <td>${esc(a.address_type)}${a.is_default ? ' <span class="badge active">Default</span>' : ''}</td>
      <td>${esc(a.label)||'-'}</td>
      <td>${[a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).map(esc).join(', ')}</td>
      <td>${esc(a.gstin)||'-'}</td>
      <td class="row-actions">
        <button class="btn small outline" onclick="editClientAddress(${clientId}, ${a.id}, '${targetId}')">Edit</button>
        <button class="btn small outline" onclick="deleteClientAddress(${clientId}, ${a.id}, '${targetId}')">Delete</button>
      </td>
    </tr>`;
  const hasBilling = addresses.some(a => a.address_type === 'Billing');
  CLIENT_ADDR_EDITING[targetId] = null;
  panel.innerHTML = `
    <div class="panel"><h3>Bill-to / Ship-to Addresses</h3>
      ${tableHTML(['Type', 'Label', 'Address', 'GSTIN', ''], addresses, addrRow)}
      <h4 id="ca-form-title" style="margin-bottom:6px;">Add Address</h4>
      <div class="form-grid">
        <div><label>Type</label><select id="ca-type"><option value="Billing">Billing</option><option value="Shipping">Shipping</option></select></div>
        <div><label>Label</label><input id="ca-label" placeholder="e.g. Head Office, Plant 2"></div>
        <div><label>GSTIN</label><input id="ca-gstin"></div>
        <div style="grid-column:1/-1;"><label>Address Line 1</label><input id="ca-line1"></div>
        <div style="grid-column:1/-1;"><label>Address Line 2</label><input id="ca-line2"></div>
        <div><label>City</label><input id="ca-city"></div>
        <div><label>State</label>${statePickerHTML('ca-state', '')}</div>
        <div><label>State Code</label><input id="ca-state-code" placeholder="e.g. 06"></div>
        <div><label>Pincode</label><input id="ca-pincode"></div>
        <div><label><input id="ca-default" type="checkbox"> Set as default for this type</label></div>
      </div>
      <div class="hig-savebar">
      <button class="btn small outline" type="button" ${hasBilling ? '' : 'disabled title="Add a Billing address first."'} onclick="copyBillToShipTo('${targetId}')">Same as Bill-to</button>
      <button class="btn" id="ca-save-btn" type="button" onclick="addClientAddress(${clientId}, '${targetId}')">Add Address</button>
      <button class="btn small outline" id="ca-cancel-btn" type="button" style="display:none;" onclick="cancelClientAddressEdit(${clientId}, '${targetId}')">Cancel</button>
      </div>
      <div id="ca-err" class="msg err" style="display:none;"></div>
    </div>`;
}
// Copies the client's own saved Billing address (default one, else the
// first) into the Add-Address form fields and switches Type to Shipping -
// so a Ship-to that's identical to Bill-to doesn't have to be retyped.
// Still just fills the form; nothing saves until "Add Address" is clicked.
const CLIENT_ADDR_CACHE = {};
window.copyBillToShipTo = (targetId) => {
  const addresses = CLIENT_ADDR_CACHE[targetId] || [];
  const billing = addresses.find(a => a.address_type === 'Billing' && a.is_default) || addresses.find(a => a.address_type === 'Billing');
  if (!billing) { alert('No Billing address on file yet - add one first.'); return; }
  document.getElementById('ca-type').value = 'Shipping';
  document.getElementById('ca-label').value = billing.label || '';
  document.getElementById('ca-gstin').value = billing.gstin || '';
  document.getElementById('ca-line1').value = billing.line1 || '';
  document.getElementById('ca-line2').value = billing.line2 || '';
  document.getElementById('ca-city').value = billing.city || '';
  document.getElementById('ca-state').value = billing.state || '';
  document.getElementById('ca-state-code').value = billing.state_code || '';
  document.getElementById('ca-pincode').value = billing.pincode || '';
};
// Edits an existing address in place, directly in the panel's own Add-
// Address form (not a second, nested openAppModal() popup) - this panel
// itself already lives inside another modal (Edit Client, or the
// Confirm-Order missing-billing recovery popup), and openAppModal() is
// re-entrant: a second call would replace that outer modal's whole content
// (title, Retry Confirm Order button, etc.), losing the very context this
// panel exists inside of. Loading the clicked address's values into the
// same form and switching the button to "Save Changes" avoids that.
const CLIENT_ADDR_EDITING = {};
window.editClientAddress = (clientId, addressId, targetId) => {
  const addresses = CLIENT_ADDR_CACHE[targetId] || [];
  const a = addresses.find(x => x.id === addressId);
  if (!a) return;
  CLIENT_ADDR_EDITING[targetId] = addressId;
  document.getElementById('ca-type').value = a.address_type;
  document.getElementById('ca-type').disabled = true;
  document.getElementById('ca-label').value = a.label || '';
  document.getElementById('ca-gstin').value = a.gstin || '';
  document.getElementById('ca-line1').value = a.line1 || '';
  document.getElementById('ca-line2').value = a.line2 || '';
  document.getElementById('ca-city').value = a.city || '';
  document.getElementById('ca-state').value = a.state || '';
  document.getElementById('ca-state-code').value = a.state_code || '';
  document.getElementById('ca-pincode').value = a.pincode || '';
  document.getElementById('ca-default').checked = !!a.is_default;
  const btn = document.getElementById('ca-save-btn');
  btn.textContent = 'Save Changes';
  document.getElementById('ca-cancel-btn').style.display = '';
  document.getElementById('ca-form-title').textContent = 'Edit Address';
  document.getElementById('ca-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
window.cancelClientAddressEdit = (clientId, targetId) => {
  renderClientAddressesPanel(clientId, targetId);
};
window.addClientAddress = async (clientId, targetId) => {
  const errEl = document.getElementById('ca-err');
  const editingId = CLIENT_ADDR_EDITING[targetId];
  const payload = {
    label: val('ca-label'), line1: val('ca-line1'), line2: val('ca-line2'),
    city: val('ca-city'), state: val('ca-state'), state_code: val('ca-state-code'), pincode: val('ca-pincode'),
    gstin: val('ca-gstin'), is_default: document.getElementById('ca-default').checked,
  };
  try {
    if (editingId) {
      await api(`/masters/client-addresses/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      payload.address_type = val('ca-type');
      await api(`/masters/clients/${clientId}/addresses`, { method: 'POST', body: JSON.stringify(payload) });
    }
    renderClientAddressesPanel(clientId, targetId);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteClientAddress = async (clientId, id, targetId) => {
  if (!confirm('Delete this address?')) return;
  await api(`/masters/client-addresses/${id}`, { method: 'DELETE' });
  renderClientAddressesPanel(clientId, targetId);
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
      <tr><td>${fmtDMY(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.ref)}</td>
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
      <div><label>Customer Group</label><div>${esc(d.group && d.group.name) || '-'}</div></div>
      <div><label>Total Business Value</label><div><b>₹${fmt(d.totalBusinessValue)}</b></div></div>
    </div>
    ${d.group ? `<h4>Sibling Companies in "${esc(d.group.name)}" (${d.groupSiblings.length})</h4>
    ${d.groupSiblings.length ? tableHTML(['Client ID', 'Name', ''], d.groupSiblings, s => `
      <tr><td>${esc(s.client_code)||'-'}</td><td>${esc(s.name)}</td><td><button class="btn small outline" type="button" onclick="openClient360(${s.id})">View 360</button></td></tr>`)
      : '<p class="muted">No other companies in this group yet.</p>'}` : ''}
    <h4>Leads (${d.leads.length})</h4>
    ${tableHTML(['Product', 'Value', 'Stage', 'Owner'], d.leads, l => `
      <tr><td>${esc(l.product_interest)}</td><td>₹${fmt(l.expected_value)}</td><td>${badge(l.stage)}</td><td>${esc(l.owner_name) || '-'}</td></tr>`)}
    <h4>Offers / Quotations (${d.offers.length})</h4>
    ${tableHTML(['Offer No', 'Subject', 'Status', 'Version'], d.offers, o => `
      <tr><td>${esc(o.offer_no)}</td><td>${esc(o.subject)}</td><td>${badge(o.status)}</td><td>v${o.version}</td></tr>`)}
    <h4>Sales Orders (${d.orders.length})</h4>
    ${tableHTML(['Order No', 'Value', 'Status', 'Date'], d.orders, o => `
      <tr><td>${esc(o.order_no)}</td><td>₹${fmt(o.order_value)}</td><td>${badge(o.status)}</td><td>${fmtDMY(o.order_date)}</td></tr>`)}
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
      <div class="hig-savebar"><button class="btn" onclick="addLead()">Add Lead</button></div>
    </div>
    <div class="toolbar">
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
  container.innerHTML = `<div class="kanban-board">
    ${cols.map(stage => {
      const items = leads.filter(l => l.stage === stage);
      const value = items.reduce((a, b) => a + Number(b.expected_value || 0), 0);
      return `<div class="kanban-col" data-stage="${esc(stage)}">
        <div class="kanban-col-header">
          <span>${esc(stage)} (${items.length})</span><span class="muted">₹${fmt(value)}</span>
        </div>
        <div class="kanban-dropzone" data-stage="${esc(stage)}">
          ${items.map(l => `
            <div class="kanban-card" draggable="true" data-lead-id="${l.id}" onclick="openLeadDetail(${l.id})">
              <div class="kanban-card-title">${esc(l.client_name)}</div>
              <div class="muted">₹${fmt(l.expected_value)}</div>
              <div class="muted">${esc(l.owner_name || '-')} &middot; ${l.days_in_stage ?? 0}d in stage</div>
            </div>`).join('') || '<div class="muted">Empty</div>'}
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
      <div class="hig-savebar">
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
      <div style="grid-column:1/-1;"><label>Notes</label><textarea id="la-notes" rows="2"></textarea></div>
    </div>
    <button class="btn small" type="button" onclick="addLeadActivity(${leadId})">Log Activity</button>
    <h4>Activity Timeline</h4>
    <div id="lead-activity-list">${renderActivityList(data.activities)}</div>`;
  openMiniModal('Lead #' + leadId + ' — ' + (l.client_name || ''), body, true);
};
function renderActivityList(activities) {
  if (!activities.length) return '<div class="empty">No activity logged yet.</div>';
  return activities.map(a => `
    <div class="activity-item">
      <div><b>${esc(a.activity_type)}</b> ${a.due_date ? `— due ${esc(fmtDMY(a.due_date))}` : ''}
        ${a.completed_at ? '<span class="badge Completed">Done</span>' : (a.due_date && a.due_date <= today() ? '<span class="badge red">Due</span>' : '')}
      </div>
      ${a.notes ? `<div class="muted">${esc(a.notes)}</div>` : ''}
      <div class="muted">by ${esc(a.created_by_name) || '-'} on ${fmtDMY(a.created_at, true)}</div>
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
    <tr class="${a.due_date < today() ? 'followup-overdue' : ''}">
      <td>${esc(fmtDMY(a.due_date))}</td><td><a href="#" onclick="openLeadDetail(${a.lead_id});return false;">${esc(a.client_name)}</a></td>
      <td>${esc(a.activity_type)}</td><td>${esc(a.notes) || '-'}</td><td>${esc(a.owner_name) || '-'}</td>
      <td><button class="btn small outline" onclick="completeLeadActivity(${a.lead_id}, ${a.id})">Mark Done</button></td></tr>`);
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

function poTermsBadge(o) {
  if (o.po_terms_status === 'MismatchPending') return `<span class="badge red">PO Mismatch</span>`;
  if (o.po_terms_status === 'MismatchAcknowledged') return `<span class="badge Draft">Mismatch Acknowledged</span>`;
  if (o.po_terms_status === 'Matched') return `<span class="badge active">PO Matched</span>`;
  if (o.po_status === 'NotProvided') return `<span class="muted">No PO</span>`;
  return `<span class="muted">-</span>`;
}
// Column labels + single-row renderer split out of what used to be one
// tableHTML()-calling renderOrderRows(rows) (2026-10-14) - customerGroupedHTML()
// needs a one-row-at-a-time renderer so every group's rows can share one
// <table>/<thead> instead of each group getting its own independently-sized
// table (see customerGroupedHTML's own comment above for why that matters).
const ORDER_LIST_COLUMNS = ['Order No', 'Client', 'Value', 'Status', 'Date', 'Promised Delivery', 'Customer PO', 'Annexure', ''];
function orderRowHTML(o) {
  return `<tr><td>${esc(o.order_no)}</td><td>${esc(o.client_name)}</td><td>₹${fmt(o.order_value)}</td><td>${badge(o.status)}</td><td>${fmtDMY(o.order_date)}</td>
    <td>${soDeliveryBadge(o.promised_delivery_date)}</td>
    <td>${poTermsBadge(o)}</td>
    <td>${o.annexure_path ? `<a class="btn small outline" href="/api/sales/orders/${o.id}/annexure" onclick="return downloadAnnexure(event, ${o.id})">Annex- Word</a> <a class="btn small outline" href="#" onclick="return downloadAnnexure(event, ${o.id}, 'pdf')">Annex- PDF</a>` : `<a class="btn small outline" href="#" onclick="return generateAnnexure(event, ${o.id})">Generate</a>`}</td>
    <td>${actionButtonsCell(`
    ${ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="openEditSalesOrder(${o.id})">Edit</button>` : ''}
    <button class="btn small outline" type="button" onclick="toggleSOTerms(${o.id})">Commercial Terms</button>
    <button class="btn small outline" type="button" onclick="toggleSOPo(${o.id})">Customer PO</button>
    <button class="btn small outline" type="button" onclick="toggleSOItems(${o.id})">Items</button>
    <button class="btn small outline" type="button" onclick="openOrderConfirmationModal(${o.id})">Confirmation &amp; Annexure</button>
    <button class="btn small outline" type="button" onclick="emailAnnexureToHODs(${o.id}, this)">Email Annexure to HODs</button>
    <button class="btn small outline" type="button" onclick="openSalesOrderHistory(${o.id}, '${esc(o.order_no)}')">History</button>
    ${ME.role === 'Admin' && o.status === 'Confirmed' ? `<button class="btn small red" type="button" onclick="deleteOrderRow(${o.id})">Delete</button>` : ''}
    `)}</td></tr>
    <tr id="so-terms-row-${o.id}" style="display:none;"><td colspan="9">${soTermsForm(o)}</td></tr>
    <tr id="so-po-row-${o.id}" style="display:none;"><td colspan="9"><div id="so-po-body-${o.id}"></div></td></tr>
    <tr id="so-items-row-${o.id}" style="display:none;"><td colspan="9"><div id="so-items-body-${o.id}"></div></td></tr>`;
}
window.openSalesOrderHistory = async (id, orderNo) => {
  const log = await api(`/sales/orders/${id}/history`).catch(() => []);
  // Event first, so the key column is on screen even when a phone has to scroll the rest sideways.
  openAppModal('History - ' + orderNo, log.length
    ? '<div style="overflow-x:auto;">' + tableHTML(['Event', 'When', 'By', 'Details'], log, l => `
        <tr><td>${esc(l.event)}</td><td style="white-space:nowrap;">${fmtDMY(l.when, true)}</td><td>${esc(l.by) || '-'}</td><td>${esc(l.details) || '-'}</td></tr>`) + '</div>'
    : '<p class="muted">No history recorded for this order yet.</p>');
};
window.toggleSOItems = async (id) => {
  const row = document.getElementById(`so-items-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (showing) return;
  await loadSOItems(id);
};
// id -> currently-fetched items array, and id -> the one item row (if any)
// being edited inline - so Edit/Save/Cancel on a row never needs a second
// round trip just to redraw. PUT /orders/:id/items/:itemId already accepted
// every one of these fields (description/qty/unit/rate/hsn/gst_rate) from
// the day the route shipped - the frontend simply never offered Edit at
// all, only Remove, which read (and was reported) as "I can only edit the
// order's own header Description, not the item's own details."
let SO_ITEMS_CACHE = {};
let SO_ITEM_EDITING = {};
async function loadSOItems(id) {
  const body = document.getElementById(`so-items-body-${id}`);
  body.innerHTML = '<p class="muted">Loading...</p>';
  SO_ITEMS_CACHE[id] = await api(`/sales/orders/${id}/items`);
  renderSOItemsBody(id);
}
function soItemLineFieldsHTML(id, it) {
  return `
    <div class="form-grid">
      <div><label>Description</label><input id="so-item-desc-${id}" value="${esc(it.description)}"></div>
      <div><label>Quantity</label><input id="so-item-qty-${id}" type="number" value="${it.quantity}"></div>
      <div><label>Unit</label><input id="so-item-unit-${id}" value="${esc(it.unit)}"></div>
      <div><label>Rate (₹)</label><input id="so-item-rate-${id}" type="number" value="${it.rate}"></div>
      <div><label>HSN Code</label><input id="so-item-hsn-${id}" value="${esc(it.hsn_code || '')}"></div>
      <div><label>GST Rate (%)</label><input id="so-item-gst-${id}" type="number" value="${it.gst_rate}"></div>
    </div>`;
}
function renderSOItemsBody(id) {
  const body = document.getElementById(`so-items-body-${id}`);
  if (!body) return;
  const items = SO_ITEMS_CACHE[id] || [];
  const editingItemId = SO_ITEM_EDITING[id];
  body.innerHTML = `
    ${tableHTML(['Description', 'Qty', 'Unit', 'Rate (₹)', 'Value (₹)', 'HSN', 'GST %', 'Dispatchable', ''], items, it => editingItemId === it.id ? `
      <tr><td colspan="9">
        ${soItemLineFieldsHTML('edit-' + id, it)}
        <button class="btn small" type="button" onclick="saveSOItemEdit(${id},${it.id})">Save</button>
        <button class="btn small outline" type="button" onclick="cancelSOItemEdit(${id})">Cancel</button>
      </td></tr>` : `
      <tr><td>${esc(it.description)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>₹${fmt(it.rate)}</td><td>₹${fmt(it.value)}</td>
      <td>${esc(it.hsn_code)||'-'}</td><td>${it.gst_rate}%</td><td>${it.dispatchable_qty}</td>
      <td>${actionButtonsCell(`
        <button class="btn small outline" type="button" onclick="startSOItemEdit(${id},${it.id})">Edit</button>
        ${it.dispatchable_qty === it.quantity ? `<button class="btn small outline" type="button" onclick="removeSOItem(${id},${it.id})">Remove</button>` : ''}
      `)}</td></tr>`)}
    <h5 style="margin:10px 0 6px;">Add Line Item</h5>
    <div class="form-grid">
      <div><label>Description</label><input id="so-item-desc-${id}"></div>
      <div><label>Quantity</label><input id="so-item-qty-${id}" type="number" value="1"></div>
      <div><label>Unit</label><input id="so-item-unit-${id}" value="Nos"></div>
      <div><label>Rate (₹)</label><input id="so-item-rate-${id}" type="number"></div>
      <div><label>HSN Code</label><input id="so-item-hsn-${id}"></div>
      <div><label>GST Rate (%)</label><input id="so-item-gst-${id}" type="number" value="18"></div>
    </div>
    <button class="btn small" type="button" onclick="addSOItem(${id})">Add</button>`;
}
window.startSOItemEdit = (id, itemId) => { SO_ITEM_EDITING[id] = itemId; renderSOItemsBody(id); };
window.cancelSOItemEdit = (id) => { SO_ITEM_EDITING[id] = null; renderSOItemsBody(id); };
window.saveSOItemEdit = async (id, itemId) => {
  const p = 'edit-' + id;
  try {
    await api(`/sales/orders/${id}/items/${itemId}`, { method: 'PUT', body: JSON.stringify({
      description: val(`so-item-desc-${p}`), quantity: val(`so-item-qty-${p}`), unit: val(`so-item-unit-${p}`),
      rate: val(`so-item-rate-${p}`), hsn_code: val(`so-item-hsn-${p}`), gst_rate: val(`so-item-gst-${p}`),
    })});
    SO_ITEM_EDITING[id] = null;
    await loadSOItems(id);
  } catch (e) { alert(e.message); }
};
window.addSOItem = async (id) => {
  try {
    await api(`/sales/orders/${id}/items`, { method: 'POST', body: JSON.stringify({
      description: val(`so-item-desc-${id}`), quantity: val(`so-item-qty-${id}`), unit: val(`so-item-unit-${id}`),
      rate: val(`so-item-rate-${id}`), hsn_code: val(`so-item-hsn-${id}`), gst_rate: val(`so-item-gst-${id}`),
    })});
    await loadSOItems(id);
  } catch (e) { alert(e.message); }
};
window.removeSOItem = async (orderId, itemId) => {
  if (!confirm('Remove this line item?')) return;
  try { await api(`/sales/orders/${orderId}/items/${itemId}`, { method: 'DELETE' }); await loadSOItems(orderId); }
  catch (e) { alert(e.message); }
};

// ---- FG Packing & Dispatch ----
let DISPATCH_LINES = [];
window.loadDispatchableLines = async () => {
  const soId = val('disp-so');
  const el = document.getElementById('disp-lines');
  DISPATCH_LINES = [];
  if (!soId) { renderDispatchLines(); return; }
  if (el) el.innerHTML = '<p class="muted">Loading line items...</p>';
  try {
    // Every line on the order comes back here now, even one that's already
    // fully dispatched/claimed (dispatchable_qty 0) - a line silently
    // filtered out of the response used to look identical to "this order
    // has no line items at all", which was reported as line items simply
    // not showing up after picking an order.
    const lines = await api(`/sales/orders/${soId}/dispatchable-lines`);
    DISPATCH_LINES = lines.map(l => ({ sales_order_item_id: l.id, description: l.description, unit: l.unit, quantity: l.quantity, dispatchable_qty: l.dispatchable_qty, dispatch_qty: l.dispatchable_qty }));
    renderDispatchLines();
  } catch (e) {
    // Any failure (missing permission, a server error) used to fail
    // silently here with nothing ever appearing - surface it visibly
    // instead of leaving the panel stuck on its default message.
    if (el) el.innerHTML = `<p class="msg err" style="display:block;">${esc(e.message)}</p>`;
  }
};
function renderDispatchLines() {
  const el = document.getElementById('disp-lines');
  if (!el) return;
  if (!DISPATCH_LINES.length) { el.innerHTML = '<p class="muted">This order has no line items yet - add them via the Sales Orders page\'s "Items" button before dispatching.</p>'; return; }
  const anyDispatchable = DISPATCH_LINES.some(l => l.dispatchable_qty > 0);
  el.innerHTML = (anyDispatchable ? '' : '<p class="msg err" style="display:block;">Every line on this order is already fully dispatched, or fully claimed by another dispatch still awaiting approval.</p>') +
    tableHTML(['Line', 'Ordered Qty', 'Already Claimed', 'Dispatchable Qty', 'Dispatch Qty', 'Unit'], DISPATCH_LINES, (l, i) => `
    <tr><td>${esc(l.description)}</td><td>${fmt(l.quantity)}</td><td>${fmt(l.quantity - l.dispatchable_qty)}</td><td>${fmt(l.dispatchable_qty)}</td>
    <td>${l.dispatchable_qty > 0
        ? `<input type="number" value="${l.dispatch_qty}" max="${l.dispatchable_qty}" min="0" onchange="DISPATCH_LINES[${i}].dispatch_qty=Number(this.value)" style="width:90px;">`
        : '<span class="muted">Fully claimed</span>'}</td>
    <td>${esc(l.unit)}</td></tr>`);
}
PAGES['fg-dispatches'] = async (el) => {
  const [orders, dispatches] = await Promise.all([api('/sales/orders'), api('/sales/dispatches')]);
  el.innerHTML = `
    <div class="panel"><h3>New Dispatch</h3>
      <div class="form-grid">
        <div><label>Sales Order</label>${salesOrderPickerHTML('disp-so', orders, '', 'onchange="loadDispatchableLines()"')}</div>
        <div><label>Vehicle No</label><input id="disp-vehicle"></div>
        <div><label>Transporter</label><input id="disp-transporter"></div>
        <div><label>E-Way Bill No</label><input id="disp-eway"></div>
      </div>
      <div id="disp-lines"><p class="muted">Pick a sales order with dispatchable lines.</p></div>
      <div class="hig-savebar"><button class="btn" onclick="submitDispatch()">Dispatch</button></div>
    </div>
    ${collapsiblePanel('dispatches-list', `Dispatches (${dispatches.length})`, `
      ${renderListSearch('fg-dispatches-list', dispatches, ['dispatch_no', 'order_no', 'client_name', 'status'], renderDispatchRows, 'Search by dispatch no, order, client, or status...')}
      <div id="fg-dispatches-rows"></div>
    `)}`;
  renderDispatchRows(dispatches);
};
function renderDispatchRows(dispatches) {
  document.getElementById('fg-dispatches-rows').innerHTML =
      `${tableHTML(['Dispatch No', 'Order', 'Client', 'Date', 'Status', ''], dispatches, d => `
        <tr><td>${esc(d.dispatch_no)}</td><td>${esc(d.order_no)}</td><td>${esc(d.client_name)}</td><td>${fmtDMY(d.dispatch_date)}</td><td>${badge(d.status)}</td>
        <td>${actionButtonsCell(`
          ${!['Cancelled', 'Rejected'].includes(d.status) ? `<button class="btn small grey-outline" type="button" onclick="openRequestVehicle(${d.id}, '${esc(d.dispatch_no)}')">1. Request Vehicle</button>
          <button class="btn small" type="button" onclick="openUpdateDispatchInfo(${d.id}, '${esc(d.dispatch_no)}')">2. Update Dispatch Info</button>
          <a class="btn small green" href="#" onclick="return downloadDispatchDoc(event, ${d.id}, 'customer-bundle')">3. Customer Bundle PDF</a>` : ''}
          <a class="btn small dark-outline" href="#" onclick="return downloadDispatchDoc(event, ${d.id}, 'envelope')">4. Print Envelope</a>
          <a class="btn small outline" href="/api/sales/dispatches/${d.id}/pdf" onclick="return downloadDispatchPdf(event, ${d.id})">Challan</a>
          <button class="btn small outline" type="button" onclick="toggleDispatchDetail(${d.id})">Details</button>
          ${['PendingApproval','InfoRequested'].includes(d.status) ? `<button class="btn small red" type="button" onclick="cancelDispatch(${d.id})">Cancel</button>` : ''}
        `)}</td></tr>
        <tr id="disp-detail-row-${d.id}" style="display:none;"><td colspan="6"><div id="disp-detail-${d.id}"></div></td></tr>`)}`;
}
window.submitDispatch = async () => {
  const lines = DISPATCH_LINES.filter(l => l.dispatch_qty > 0).map(l => ({ sales_order_item_id: l.sales_order_item_id, quantity: l.dispatch_qty }));
  if (!lines.length) { alert('Pick a sales order and at least one line with quantity > 0.'); return; }
  try {
    await api('/sales/dispatches', { method: 'POST', body: JSON.stringify({
      sales_order_id: val('disp-so'), vehicle_no: val('disp-vehicle'), transporter_name: val('disp-transporter'),
      eway_bill_no: val('disp-eway'), lines,
    })});
    alert('Dispatch submitted for approval - Accounts, then Management.');
    navigate('fg-dispatches');
  } catch (e) { alert(e.message); }
};
window.toggleDispatchDetail = async (id) => {
  const row = document.getElementById(`disp-detail-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (showing) return;
  const box = document.getElementById(`disp-detail-${id}`);
  box.innerHTML = '<p class="muted">Loading...</p>';
  const { dispatch, items } = await api(`/sales/dispatches/${id}`);
  box.innerHTML = `
    <div class="panel">
      ${dispatch.payment_override_note ? `<p class="msg err">${esc(dispatch.payment_override_note)}</p>` : ''}
      <p><b>Vehicle:</b> ${esc(dispatch.vehicle_no)||'-'} &nbsp; <b>Transporter:</b> ${esc(dispatch.transporter_name)||'-'} &nbsp; <b>E-Way Bill:</b> ${esc(dispatch.eway_bill_no)||'-'} &nbsp; <b>Invoice:</b> ${esc(dispatch.invoice_number)||'-'} &nbsp; <b>Insurance:</b> ${esc(dispatch.insurance_number)||'-'}</p>
      ${tableHTML(['Description', 'Qty', 'Unit', 'HSN'], items, it => `<tr><td>${esc(it.description)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${esc(it.hsn_code)||'-'}</td></tr>`)}
    </div>`;
};
window.downloadDispatchPdf = async (ev, id) => {
  ev.preventDefault();
  try {
    const res = await fetch(`/api/sales/dispatches/${id}/pdf`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    openOrDownloadBlob(await res.blob(), match ? match[1] : `dispatch-${id}.pdf`);
  } catch (e) { alert(e.message); }
  return false;
};
// GET-and-preview for the covering letter / envelope PDFs (auth header needed, so not a plain link).
window.downloadDispatchDoc = async (ev, id, kind) => {
  ev.preventDefault();
  try {
    const res = await fetch(`/api/sales/dispatches/${id}/${kind}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
    const skipped = res.headers.get('X-Bundle-Skipped');
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    openOrDownloadBlob(await res.blob(), match ? match[1] : `dispatch-${id}-${kind}.pdf`);
    if (skipped) alert('Customer bundle opened without: ' + skipped);
  } catch (e) { alert(e.message); }
  return false;
};
const DISPATCH_DOC_SLOTS = [
  { tag: 'invoice_file', btn: 'Upload Invoice PDF', fields: [['udi-invoice', 'Invoice Number', 'invoice_number']] },
  { tag: 'insurance_file', btn: 'Upload Insurance Copy', fields: [['udi-insurance', 'Insurance Number', 'insurance_number']] },
  { tag: 'eway_bill_file', btn: 'Upload E-Way Bill PDF', fields: [['udi-eway', 'E-Way Bill Number', 'eway_bill_no']] },
  { tag: 'transporter_receipt_file', btn: 'Upload Transporter Receipt', fields: [['udi-transporter', 'Transporter Name', 'transporter_name'], ['udi-vehicle', 'Vehicle Number', 'vehicle_no']] },
  { tag: 'packing_list_file', btn: 'Upload Final Packing List', fields: [] },
];
function dispatchDocStatusHTML(a) {
  return a ? `<span style="color:var(--green);font-weight:600;">&#10003; ${esc(a.original_name)}</span>` : '<span class="muted">No file yet</span>';
}
window.openUpdateDispatchInfo = async (id, dispatchNo) => {
  try {
    const [{ dispatch: d }, atts] = await Promise.all([api(`/sales/dispatches/${id}`), api(`/attachments/fg_dispatch/${id}`)]);
    const latest = (tag) => atts.find(a => a.document_type === tag);
    const row = (slot) => `
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,200px);gap:12px 14px;align-items:end;padding:10px 0;border-bottom:1px solid var(--border);">
        <div class="form-grid" style="margin:0;">
          ${slot.fields.map(([fid, label, key]) => `<div><label>${label}</label><input id="${fid}" value="${esc(d[key])}"></div>`).join('') || `<div><label>Final Packing List</label><span class="muted">Document only</span></div>`}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label class="btn small outline" style="display:block;text-align:center;margin:0 0 4px;cursor:pointer;">${slot.btn}
            <input type="file" accept="application/pdf,image/*" style="display:none;" onchange="uploadDispatchDoc(${id}, '${slot.tag}', this)"></label>
          <div id="udi-ok-${slot.tag}" style="font-size:12px;word-break:break-all;">${dispatchDocStatusHTML(latest(slot.tag))}</div>
        </div>
      </div>`;
    openAppModal('Update Dispatch Info - ' + dispatchNo, `
      <p class="muted">Documents upload as soon as you pick them (a new file replaces the previous one for that slot). Use Save for the text fields.</p>
      ${DISPATCH_DOC_SLOTS.map(row).join('')}
      <div class="hig-savebar"><button class="btn" id="udi-save" onclick="saveDispatchInfo(${id})">Save</button></div>`);
  } catch (e) { alert(e.message); }
};
window.uploadDispatchDoc = async (id, tag, input) => {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('udi-ok-' + tag);
  status.innerHTML = '<span class="muted">Uploading...</span>';
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('document_type', tag);
    await apiUpload(`/attachments/fg_dispatch/${id}`, fd, 'POST');
    status.innerHTML = dispatchDocStatusHTML({ original_name: file.name });
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red);">${esc(e.message)}</span>`;
  }
  input.value = '';
};
window.saveDispatchInfo = async (id) => {
  try {
    await api(`/sales/dispatches/${id}/finalize-logistics`, { method: 'POST', body: JSON.stringify({
      invoice_number: val('udi-invoice'), eway_bill_no: val('udi-eway'), vehicle_no: val('udi-vehicle'),
      transporter_name: val('udi-transporter'), insurance_number: val('udi-insurance'),
    })});
    confirmSavedThenClose('udi-save', 'fg-dispatches');
  } catch (e) { alert(e.message); }
};
window.openRequestVehicle = (id, dispatchNo) => {
  openAppModal('Request Vehicle - ' + dispatchNo, `
    <div class="form-grid"><div><label>Date of Pick-up to be Arranged</label><input id="rv-date" type="date"></div></div>
    <div class="hig-savebar"><button class="btn" onclick="submitRequestVehicle(${id})">Generate Request</button></div>`);
};
window.submitRequestVehicle = async (id) => {
  const pickupDate = val('rv-date');
  if (!pickupDate) { alert('Pick the date of pick-up to be arranged.'); return; }
  try {
    const res = await fetch(`/api/sales/dispatches/${id}/request-vehicle`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ pickupDate }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Request failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    openOrDownloadBlob(await res.blob(), match ? match[1] : `vehicle-request-${id}.pdf`);
  } catch (e) { alert(e.message); }
};
window.cancelDispatch = async (id) => {
  if (!confirm('Cancel this dispatch? This cannot be undone.')) return;
  try { await api(`/sales/dispatches/${id}/cancel`, { method: 'POST', body: '{}' }); navigate('fg-dispatches'); }
  catch (e) { alert(e.message); }
};

// ---- Sale Rejection MRN ----
const MRN_DISPOSITIONS = ['Rework', 'Scrap', 'ReturnToStock'];
let MRN_LINES = [];
window.loadRejectableLines = async () => {
  const dispId = val('mrn-dispatch');
  MRN_LINES = [];
  if (!dispId) { renderMrnLines(); return; }
  const lines = await api(`/sales/dispatches/${dispId}/rejectable-lines`);
  MRN_LINES = lines.map(l => ({ fg_dispatch_item_id: l.id, description: l.description, unit: l.unit, rejectable_qty: l.rejectable_qty, quantity_rejected: l.rejectable_qty }));
  renderMrnLines();
};
function renderMrnLines() {
  const el = document.getElementById('mrn-lines');
  if (!el) return;
  if (!MRN_LINES.length) { el.innerHTML = '<p class="muted">Pick a Dispatched shipment with rejectable lines.</p>'; return; }
  el.innerHTML = tableHTML(['Line', 'Rejectable Qty', 'Qty Rejected', 'Unit'], MRN_LINES, (l, i) => `
    <tr><td>${esc(l.description)}</td><td>${l.rejectable_qty}</td>
    <td><input type="number" value="${l.quantity_rejected}" max="${l.rejectable_qty}" onchange="MRN_LINES[${i}].quantity_rejected=Number(this.value)"></td>
    <td>${esc(l.unit)}</td></tr>`);
}
PAGES['sale-rejection-mrns'] = async (el) => {
  const [dispatches, mrns] = await Promise.all([api('/sales/dispatches'), api('/sales/mrns')]);
  const dispatchedOnes = dispatches.filter(d => d.status === 'Dispatched');
  el.innerHTML = `
    <div class="panel"><h3>New Sale Rejection MRN</h3>
      <div class="form-grid">
        <div><label>Dispatch</label><select id="mrn-dispatch" onchange="loadRejectableLines()"><option value="">- Select -</option>${dispatchedOnes.map(d => `<option value="${d.id}">${esc(d.dispatch_no)} - ${esc(d.order_no)} (${esc(d.client_name)})</option>`).join('')}</select></div>
        <div><label>Reason</label><select id="mrn-reason"><option>Quality Issue</option><option>Wrong Specification</option><option>Damaged in Transit</option><option>Customer Cancelled</option><option>Other</option></select></div>
        <div><label>Disposition</label><select id="mrn-disposition">${MRN_DISPOSITIONS.map(d => `<option>${d}</option>`).join('')}</select></div>
      </div>
      <div><label>Description / Notes</label><textarea id="mrn-desc" rows="2"></textarea></div>
      <div id="mrn-lines"><p class="muted">Pick a Dispatched shipment with rejectable lines.</p></div>
      <div class="hig-savebar"><button class="btn" onclick="submitMrn()">Raise MRN</button></div>
    </div>
    ${collapsiblePanel('mrns-list', `Sale Rejection MRNs (${mrns.length})`, `
      ${tableHTML(['MRN No', 'Dispatch', 'Order', 'Client', 'Disposition', 'Status', 'Resolution', ''], mrns, m => `
        <tr><td>${esc(m.mrn_no)}</td><td>${esc(m.dispatch_no)}</td><td>${esc(m.order_no)}</td><td>${esc(m.client_name)}</td><td>${esc(m.disposition)}</td>
        <td>${badge(m.status)}</td><td>${esc(m.resolution)}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" type="button" onclick="toggleMrnDetail(${m.id})">Details</button>
          ${m.status === 'Approved' && m.resolution === 'Unresolved' ? `
            <button class="btn small outline" type="button" onclick="resolveMrnCreditNote(${m.id})">Generate Credit Note</button>
            <button class="btn small outline" type="button" onclick="resolveMrnFoc(${m.id})">Create FOC Replacement</button>` : ''}
          ${['PendingApproval','InfoRequested'].includes(m.status) ? `<button class="btn small red" type="button" onclick="cancelMrn(${m.id})">Cancel</button>` : ''}
        `)}</td></tr>
        <tr id="mrn-detail-row-${m.id}" style="display:none;"><td colspan="8"><div id="mrn-detail-${m.id}"></div></td></tr>`)}
    `)}`;
};
window.submitMrn = async () => {
  const lines = MRN_LINES.filter(l => l.quantity_rejected > 0).map(l => ({ fg_dispatch_item_id: l.fg_dispatch_item_id, quantity_rejected: l.quantity_rejected }));
  if (!lines.length) { alert('Pick a dispatch and at least one line with quantity > 0.'); return; }
  try {
    await api('/sales/mrns', { method: 'POST', body: JSON.stringify({
      fg_dispatch_id: val('mrn-dispatch'), reason: val('mrn-reason'), description: val('mrn-desc'), disposition: val('mrn-disposition'), lines,
    })});
    alert('MRN raised - submitted for Sales HOD approval.');
    navigate('sale-rejection-mrns');
  } catch (e) { alert(e.message); }
};
window.toggleMrnDetail = async (id) => {
  const row = document.getElementById(`mrn-detail-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (showing) return;
  const box = document.getElementById(`mrn-detail-${id}`);
  box.innerHTML = '<p class="muted">Loading...</p>';
  const { mrn, items, creditNote, focRequest } = await api(`/sales/mrns/${id}`);
  box.innerHTML = `
    <div style="padding:10px;background:#f9f9f9;border-radius:6px;">
      <p style="font-size:13px;"><b>Reason:</b> ${esc(mrn.reason)||'-'} &nbsp; <b>Disposition:</b> ${esc(mrn.disposition)}</p>
      ${mrn.description ? `<p style="font-size:13px;">${esc(mrn.description)}</p>` : ''}
      ${tableHTML(['Description', 'Qty Rejected', 'Unit', 'Rate (₹)'], items, it => `<tr><td>${esc(it.description)}</td><td>${it.quantity_rejected}</td><td>${esc(it.unit)}</td><td>₹${fmt(it.rate)}</td></tr>`)}
      ${creditNote ? `<p style="font-size:13px;"><b>Credit Note:</b> ${esc(creditNote.credit_note_no)} - ₹${fmt(creditNote.total_value)}</p>` : ''}
      ${focRequest ? `<p style="font-size:13px;"><b>FOC Replacement:</b> ${esc(focRequest.foc_no)} (${esc(focRequest.status)})</p>` : ''}
    </div>`;
};
window.resolveMrnCreditNote = async (id) => {
  if (!confirm('Generate a Sales Credit Note for this MRN?')) return;
  try { await api(`/sales/mrns/${id}/resolve-credit-note`, { method: 'POST', body: '{}' }); navigate('sale-rejection-mrns'); }
  catch (e) { alert(e.message); }
};
window.resolveMrnFoc = async (id) => {
  if (!confirm('Create a replacement FOC request for this MRN? It will need its own FOC approval.')) return;
  try { await api(`/sales/mrns/${id}/resolve-foc`, { method: 'POST', body: '{}' }); navigate('sale-rejection-mrns'); }
  catch (e) { alert(e.message); }
};
window.cancelMrn = async (id) => {
  if (!confirm('Cancel this MRN? This cannot be undone.')) return;
  try { await api(`/sales/mrns/${id}/cancel`, { method: 'POST', body: '{}' }); navigate('sale-rejection-mrns'); }
  catch (e) { alert(e.message); }
};

// ---- Sales Return ----
// A customer sending goods back - standalone or optionally linked to a Sale
// Rejection MRN for context (not MRN-only, per the owner's locked answer).
// Draft -> PendingApproval (Store HOD confirms physical receipt) -> Approved,
// at which point a 'Good' line credits real stock and a paperwork-only Sales
// Return Challan is auto-generated server-side (no GST - that stays on the
// separate Sales Credit Note path).
let SR_RETURN_LINES = [];
const SR_RETURN_GRID_COLS = 'minmax(220px,2fr) 90px 90px 130px 44px';
function renderSalesReturnLines() {
  const el = document.getElementById('sr-return-lines');
  if (!el) return;
  el.innerHTML = gridLineTableHTML(SR_RETURN_GRID_COLS, ['Item Description', 'Quantity', 'Unit', 'Condition', ''], SR_RETURN_LINES, (l, i) => `
      <div><input value="${esc(l.item_text||'')}" placeholder="What's coming back" onchange="SR_RETURN_LINES[${i}].item_text=this.value"></div>
      <div><input type="number" value="${l.quantity}" onchange="SR_RETURN_LINES[${i}].quantity=Number(this.value)"></div>
      <div><input value="${esc(l.unit||'Nos')}" onchange="SR_RETURN_LINES[${i}].unit=this.value"></div>
      <div><select onchange="SR_RETURN_LINES[${i}].condition_status=this.value"><option ${l.condition_status==='Good'?'selected':''}>Good</option><option ${l.condition_status==='Damaged'?'selected':''}>Damaged</option><option ${l.condition_status==='Repair'?'selected':''}>Repair</option></select></div>
      <div>${SR_RETURN_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="SR_RETURN_LINES.splice(${i},1);renderSalesReturnLines()">✕</button>` : ''}</div>`);
}
window.addSalesReturnLine = () => { SR_RETURN_LINES.push({ item_text: '', quantity: 1, unit: 'Nos', condition_status: 'Good' }); renderSalesReturnLines(); };
PAGES['sales-returns'] = async (el) => {
  const [returns, clients, orders] = await Promise.all([api('/sales/returns'), api('/masters/clients'), api('/sales/orders')]);
  SR_RETURN_LINES = [{ item_text: '', quantity: 1, unit: 'Nos', condition_status: 'Good' }];
  el.innerHTML = `
    <div class="panel"><h3>New Sales Return</h3>
      <div class="form-grid">
        <div><label>Customer</label>${clientPickerHTML('sr-client', clients, '', 'Select customer')}</div>
        <div><label>Linked Sales Order (optional)</label><select id="sr-order"><option value="">-- None --</option>${orders.map(o => `<option value="${o.id}">${esc(o.order_no)} - ${esc(o.client_name)}</option>`).join('')}</select></div>
      </div>
      <div><label>Reason</label><input id="sr-reason" placeholder="Why these goods are coming back"></div>
      <h4>Returned Line Items</h4>
      <div id="sr-return-lines"></div>
      <div class="hig-actions"><button class="btn small outline" type="button" onclick="addSalesReturnLine()">+ Add Line Item</button></div>
      <div class="hig-savebar"><button class="btn" onclick="createSalesReturn()">Save Return</button></div>
      <div class="muted">Saved as Draft - freely editable until you submit for the Store HOD's approval, which is what actually credits stock for a Good-condition line.</div>
    </div>
    ${collapsiblePanel('sales-returns-list', `Sales Returns (${returns.length})`, `
      ${tableHTML(['Return No', 'Customer', 'Linked Order', 'Linked MRN', 'Lines', 'Status', ''], returns, r => `
        <tr><td>${esc(r.return_no)}</td><td>${esc(r.client_name)}</td><td>${esc(r.order_no)||'-'}</td><td>${esc(r.mrn_no)||'-'}</td><td>${r.line_count}</td>
        <td>${badge(r.status)}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" type="button" onclick="toggleSalesReturnDetail(${r.id})">Details</button>
          ${r.status === 'Draft' ? `<button class="btn small" type="button" onclick="submitSalesReturn(${r.id})">Submit for Approval</button>` : ''}
          ${['Draft','PendingApproval','InfoRequested'].includes(r.status) ? `<button class="btn small red" type="button" onclick="cancelSalesReturn(${r.id})">Cancel</button>` : ''}
        `)}</td></tr>
        <tr id="sr-detail-row-${r.id}" style="display:none;"><td colspan="7"><div id="sr-detail-${r.id}"></div></td></tr>`)}
    `)}`;
  renderSalesReturnLines();
};
window.createSalesReturn = async () => {
  const lines = SR_RETURN_LINES.filter(l => l.item_text && l.quantity > 0);
  if (!lines.length) { alert('Add at least one line with a description and quantity > 0.'); return; }
  try {
    await api('/sales/returns', { method: 'POST', body: JSON.stringify({
      client_id: val('sr-client'), sales_order_id: val('sr-order') || null, reason: val('sr-reason'), lines,
    })});
    navigate('sales-returns');
  } catch (e) { alert(e.message); }
};
window.toggleSalesReturnDetail = async (id) => {
  const row = document.getElementById(`sr-detail-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (showing) return;
  const box = document.getElementById(`sr-detail-${id}`);
  box.innerHTML = '<p class="muted">Loading...</p>';
  const { ret, items } = await api(`/sales/returns/${id}`);
  box.innerHTML = `
    <div style="padding:10px;background:#f9f9f9;border-radius:6px;">
      ${ret.reason ? `<p style="font-size:13px;"><b>Reason:</b> ${esc(ret.reason)}</p>` : ''}
      ${tableHTML(['Item', 'Qty', 'Unit', 'Condition', 'Return Status', ''], items, it => `<tr><td>${esc(it.item_text)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${badge(it.condition_status)}</td>
        <td>${it.condition_status === 'Good' ? '<span class="muted">Credited to stock</span>' :
             it.sent_back_at ? `<span class="muted">↩ Sent Back · ${esc(fmtDMY(it.sent_back_at))}${it.sent_back_ref ? ' · ' + esc(it.sent_back_ref) : ''}</span>` :
             '<span class="muted">Awaiting disposition</span>'}</td>
        <td>${actionButtonsCell(
          ret.status === 'Approved' && ['Damaged', 'Repair'].includes(it.condition_status) && !it.sent_back_at
            ? `<button class="btn small outline" type="button" onclick="sendBackSalesReturnItem(${ret.id},${it.id})">Send Back to Customer</button>` : ''
        )}</td></tr>`)}
    </div>`;
};
window.sendBackSalesReturnItem = async (returnId, itemId) => {
  const ref = prompt('Courier / challan reference (optional):') || '';
  const notes = prompt('Notes (optional):') || '';
  try {
    await api(`/sales/returns/${returnId}/items/${itemId}/send-back`, { method: 'POST', body: JSON.stringify({ ref, notes }) });
    await toggleSalesReturnDetail(returnId); // collapse
    await toggleSalesReturnDetail(returnId); // re-expand with fresh data
  } catch (e) { alert(e.message); }
};
window.submitSalesReturn = async (id) => {
  if (!confirm('Submit this return for the Store HOD\'s approval?')) return;
  try { await api(`/sales/returns/${id}/submit-for-approval`, { method: 'POST', body: '{}' }); navigate('sales-returns'); }
  catch (e) { alert(e.message); }
};
window.cancelSalesReturn = async (id) => {
  if (!confirm('Cancel this return? This cannot be undone.')) return;
  try { await api(`/sales/returns/${id}/cancel`, { method: 'POST', body: '{}' }); navigate('sales-returns'); }
  catch (e) { alert(e.message); }
};

// ---- Sales Credit Notes ----
PAGES['sales-credit-notes'] = async (el) => {
  const notes = await api('/sales/credit-notes');
  el.innerHTML = `
    <div class="panel"><h3>Sales Credit Notes</h3>
      <p class="muted">Generated from an Approved Sale Rejection MRN - see the Sale Rejection MRN page to raise one.</p>
      ${tableHTML(['Credit Note No', 'Client', 'From MRN', 'Taxable (₹)', 'GST (₹)', 'Total (₹)', 'Status', ''], notes, c => `
        <tr><td>${esc(c.credit_note_no)}</td><td>${esc(c.client_name)}</td><td>${esc(c.mrn_no)||'-'}</td><td>₹${fmt(c.taxable_value)}</td>
        <td>₹${fmt(c.cgst + c.sgst + c.igst)}</td><td>₹${fmt(c.total_value)}</td><td>${badge(c.status)}</td>
        <td>${c.status !== 'Cancelled' ? `<button class="btn small red" type="button" onclick="cancelSalesCreditNote(${c.id})">Cancel</button>` : ''}</td></tr>`)}
    </div>`;
};
window.cancelSalesCreditNote = async (id) => {
  if (!confirm('Cancel this credit note?')) return;
  try { await api(`/sales/credit-notes/${id}/cancel`, { method: 'POST', body: '{}' }); navigate('sales-credit-notes'); }
  catch (e) { alert(e.message); }
};
let SO_LINES = [];
const SO_LINES_GRID_COLS = 'minmax(220px,2fr) 90px 90px 110px 110px 100px 44px';
function renderSOLines() {
  const el = document.getElementById('so-lines');
  if (!el) return;
  el.innerHTML = gridLineTableHTML(SO_LINES_GRID_COLS, ['Description', 'Quantity', 'Unit', 'Rate (₹)', 'HSN Code', 'GST Rate (%)', ''], SO_LINES, (l, i) => `
      <div><input value="${esc(l.description||'')}" onchange="SO_LINES[${i}].description=this.value"></div>
      <div><input type="number" value="${l.quantity}" onchange="SO_LINES[${i}].quantity=Number(this.value)"></div>
      <div><input value="${esc(l.unit||'Nos')}" onchange="SO_LINES[${i}].unit=this.value"></div>
      <div><input type="number" value="${l.rate}" onchange="SO_LINES[${i}].rate=Number(this.value)"></div>
      <div><input value="${esc(l.hsn_code||'')}" onchange="SO_LINES[${i}].hsn_code=this.value"></div>
      <div><input type="number" value="${l.gst_rate}" onchange="SO_LINES[${i}].gst_rate=Number(this.value)"></div>
      <div><button class="btn small outline" type="button" onclick="SO_LINES.splice(${i},1);renderSOLines()">✕</button></div>`);
}
window.addSOLine = () => { SO_LINES.push({ description: '', quantity: 1, unit: 'Nos', rate: 0, hsn_code: '', gst_rate: 18 }); renderSOLines(); };

// Admin-only Sales Order header Edit (2026-11-12) - covers the fields that
// had no edit path at all (Client/Lead/Description/Order Date/Status, plus
// Order Value when the order has no line items of its own) folded in
// alongside the pre-existing Commercial Terms fields, per the owner's
// confirmed scope - the standalone Commercial Terms panel (soTermsForm)
// stays exactly as-is for everyone else; this is a second, Admin-only way
// to reach those same fields plus the header ones. Uses the shared
// bgTermsFormFields()/readBgTermsFields() helpers that panel already uses.
const SALES_ORDER_STATUSES = ['Confirmed', 'InProduction', 'PartiallyDispatched', 'Dispatched', 'Invoiced', 'Completed', 'Cancelled'];
window.openEditSalesOrder = async (id) => {
  const o = (window.__SO_ORDERS_CACHE || []).find(x => x.id === id);
  if (!o) return alert('Could not find this order - try refreshing the page.');
  const [clients, soItems] = await Promise.all([api('/masters/clients'), api(`/sales/orders/${id}/items`).catch(() => [])]);
  window.__ESO_ITEMS = soItems;
  const wonLeads = window.__SO_WON_LEADS_CACHE || [];
  openAppModal('Edit Sales Order — ' + o.order_no, `
    <div class="form-grid">
      <div><label>Client</label>${clientPickerHTML('eso-client', clients, o.client_id)}</div>
      <div><label>From Lead (optional)</label><select id="eso-lead"><option value="">-</option>${wonLeads.map(l => `<option value="${l.id}" ${Number(o.lead_id) === l.id ? 'selected' : ''}>#${l.id} ${esc(l.client_name)}</option>`).join('')}</select></div>
      <div><label>Order Date</label><input id="eso-date" type="date" value="${o.order_date ? String(o.order_date).slice(0, 10) : ''}"></div>
      <div><label>Status</label><select id="eso-status">${SALES_ORDER_STATUSES.map(s => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div><label>Description</label><textarea id="eso-desc" rows="2" style="width:100%;">${esc(o.description || '')}</textarea></div>
    <div class="form-grid">
      <div><label>Order Value (₹) <span class="muted">(if this order has line items, this value is recomputed from them the next time any item is added, edited, or removed)</span></label>
        <input id="eso-value" type="number" value="${o.order_value ?? ''}" ${soItems.length ? 'readonly title="Computed from the line items below"' : ''}></div>
    </div>
    ${soItems.length ? `<h4 style="margin-top:14px;">Line Items (${soItems.length})</h4>
    ${gridLineTableHTML('minmax(180px,2fr) 90px 70px 100px 90px 70px 110px 100px', ['Description', 'Qty', 'Unit', 'Rate (₹)', 'HSN', 'GST %', 'Value (₹)', 'Dispatched'], soItems, (it, i) => {
        const disp = it.quantity - it.dispatchable_qty;
        return `<div><input id="eso-it-desc-${i}" value="${esc(it.description)}"></div>
          <div><input id="eso-it-qty-${i}" type="number" min="${disp || 0}" step="any" value="${it.quantity}" oninput="esoRecalc()"></div>
          <div><input id="eso-it-unit-${i}" value="${esc(it.unit || 'Nos')}"></div>
          <div><input id="eso-it-rate-${i}" type="number" min="0" step="any" value="${it.rate}" oninput="esoRecalc()"></div>
          <div><input id="eso-it-hsn-${i}" value="${esc(it.hsn_code || '')}"></div>
          <div><input id="eso-it-gst-${i}" type="number" min="0" step="any" value="${it.gst_rate}" oninput="esoRecalc()"></div>
          <div id="eso-it-val-${i}">₹${fmt(it.value)}</div>
          <div>${disp}</div>`;
      })}
    <p id="eso-totals" style="text-align:right;margin:6px 0;"></p>` : ''}
    <h4 style="margin-top:14px;">Commercial Terms</h4>
    <div class="form-grid">
      <div><label>Promised Delivery Date</label><input id="eso-delivery" type="date" value="${o.promised_delivery_date || ''}"></div>
      <div><label>LD Rate (%)</label><input id="eso-ld-pct" type="number" step="0.01" value="${o.ld_percentage ?? ''}"></div>
      <div><label>LD Cap (%)</label><input id="eso-ld-cap" type="number" step="0.01" value="${o.ld_cap_percentage ?? ''}"></div>
    </div>
    <div><label>Trigger Conditions</label><textarea id="eso-ld-notes" rows="2" style="width:100%;">${esc(o.ld_trigger_notes || '')}</textarea></div>
    ${bgTermsFormFields('eso', o)}
    <div><label>Payment Terms</label><textarea id="eso-payment-terms" rows="2" style="width:100%;">${esc(o.payment_terms || '')}</textarea></div>
    <div class="hig-savebar"><button class="btn" id="eso-save-btn-${id}" onclick="saveEditSalesOrder(${id})">Save Changes</button></div>
  `);
  if (soItems.length) document.querySelector('.app-modal-box').style.width = 'min(1000px,100%)'; // 8-column line grid needs more than the default 560px
  esoRecalc();
};
window.esoRecalc = () => {
  const items = window.__ESO_ITEMS || [];
  let taxable = 0, gst = 0;
  items.forEach((it, i) => {
    const v = (Number(val(`eso-it-qty-${i}`)) || 0) * (Number(val(`eso-it-rate-${i}`)) || 0);
    taxable += v; gst += v * (Number(val(`eso-it-gst-${i}`)) || 0) / 100;
    document.getElementById(`eso-it-val-${i}`).textContent = '₹' + fmt(v);
  });
  const t = document.getElementById('eso-totals');
  if (t) t.innerHTML = `Taxable <b>₹${fmt(taxable)}</b> &nbsp; GST <b>₹${fmt(gst)}</b> &nbsp; Total <b>₹${fmt(taxable + gst)}</b>`;
  const ov = document.getElementById('eso-value');
  if (ov && items.length) ov.value = taxable;
};
window.saveEditSalesOrder = async (id) => {
  try {
    const items = (window.__ESO_ITEMS || []).map((it, i) => ({ id: it.id, description: val(`eso-it-desc-${i}`), quantity: val(`eso-it-qty-${i}`),
      unit: val(`eso-it-unit-${i}`), rate: val(`eso-it-rate-${i}`), hsn_code: val(`eso-it-hsn-${i}`), gst_rate: val(`eso-it-gst-${i}`) }));
    await api('/sales/orders/' + id, { method: 'PUT', body: JSON.stringify({
      client_id: val('eso-client'), lead_id: val('eso-lead') || null, description: val('eso-desc'),
      order_date: val('eso-date') || null, order_value: val('eso-value'), status: val('eso-status'),
      promised_delivery_date: val('eso-delivery') || null, ld_percentage: val('eso-ld-pct') || null,
      ld_cap_percentage: val('eso-ld-cap') || null, ld_trigger_notes: val('eso-ld-notes') || null,
      payment_terms: val('eso-payment-terms') || null, items,
      ...readBgTermsFields('eso'),
    })});
    confirmSavedThenClose('eso-save-btn-' + id, 'orders');
  } catch (e) { alert(e.message); }
};
window.emailAnnexureToHODs = async (id, btn) => {
  const o = (window.__SO_ORDERS_CACHE || []).find(x => x.id === id);
  if (!confirm(`Email the Annexure PDF for ${o ? o.order_no : 'this order'} to all active HODs?`)) return;
  btn.disabled = true;
  try {
    const r = await api(`/sales/orders/${id}/email-annexure`, { method: 'POST' });
    alert(`Annexure emailed to ${r.count} HOD${r.count === 1 ? '' : 's'}:\n` + r.recipients.join('\n'));
  } catch (e) { alert(e.message); }
  btn.disabled = false;
};
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
  window.__SO_ORDERS_CACHE = orders;
  window.__SO_WON_LEADS_CACHE = wonLeads;
  SO_LINES = [];
  el.innerHTML = `
    <div class="panel">
      <h3>New Sales Order</h3>
      <div class="form-grid">
        <div><label>Client</label><select id="so-client"></select></div>
        <div><label>From Lead (optional)</label><select id="so-lead"><option value="">-</option>${wonLeads.map(l => `<option value="${l.id}">#${l.id} ${esc(l.client_name)}</option>`).join('')}</select></div>
        <div><label>Description</label><textarea id="so-desc" rows="1"></textarea></div>
        <div><label>Promised Delivery Date</label><input id="so-delivery" type="date"></div>
      </div>
      <div class="form-grid">
        <div><label>Customer PO Number <span class="muted">(optional)</span></label><input id="so-po-number"></div>
        <div><label>Customer PO Date</label><input id="so-po-date" type="date"></div>
        <div><label>Advance (%) <span class="muted">(used to default an Advance Proforma's amount)</span></label><input id="so-advance-pct" type="number" min="0" max="100" step="0.01"></div>
        <div><label>Payment Before Dispatch (%) <span class="muted">(used to default a Pre-Dispatch Proforma's amount)</span></label><input id="so-predispatch-pct" type="number" min="0" max="100" step="0.01"></div>
      </div>
      <div class="form-grid">
        <div style="grid-column:1/-1;"><label>Payment Terms <span class="muted">(reused on every Proforma/Invoice generated against this order)</span></label><textarea id="so-payment-terms" rows="2" placeholder="e.g. 30% advance, 60% before dispatch, 10% against performance"></textarea></div>
      </div>
      <h4>Line Items <span class="muted">(optional - leave empty and set Order Value manually for a simple order with no dispatch tracking)</span></h4>
      <div id="so-lines"></div>
      <button class="btn small outline" type="button" onclick="addSOLine()">+ Add Line Item</button>
      <div class="form-grid">
        <div><label>Order Value (₹) <span class="muted">(ignored once a line item is added - computed automatically instead)</span></label><input id="so-value" type="number"></div>
      </div>
      <div class="panel hod-tools">
        <h4>LD Clause (optional)</h4>
        <div class="form-grid">
          <div><label>LD Rate (%)</label><input id="so-ld-pct" type="number" step="0.01"></div>
          <div><label>LD Cap (%)</label><input id="so-ld-cap" type="number" step="0.01"></div>
        </div>
        <div><label>Trigger Conditions</label><textarea id="so-ld-notes" rows="2" placeholder="e.g. 0.5% per week of delay, capped at 5% of order value"></textarea></div>
      </div>
      ${bgTermsFormFields('so')}
      <div class="hig-savebar"><button class="btn" onclick="addOrder()">Create Order</button></div>
    </div>
    <button class="btn small outline" onclick="reportOrders()">Generate Report (CSV)</button>
    ${collapsiblePanel('orders-list', `<span id="so-count">Sales Orders (${orders.length})</span>`, `
      ${renderListSearch('orders', orders, ['order_no', 'client_name', 'group_name', 'status', 'description'], (rows) => {
        document.getElementById('so-table-wrap').innerHTML = customerGroupedHTML(rows, 'so', ORDER_LIST_COLUMNS, orderRowHTML);
        document.getElementById('so-count').textContent = 'Sales Orders (' + rows.length + ')';
      }, 'Search by order no, client, status...')}
      <div id="so-table-wrap">${customerGroupedHTML(orders, 'so', ORDER_LIST_COLUMNS, orderRowHTML)}</div>
      <p class="muted">Department-level target planning for a confirmed order now lives on the <a href="#" onclick="navigate('projects');return false;">Projects</a> tab, under that order's project.</p>
    `)}`;
  await loadSelectOptions(document.getElementById('so-client'), '/masters/clients', 'id', 'name', 'Select client');
  renderSOLines();
};
window.reportOrders = async () => {
  const orders = await api('/sales/orders');
  downloadCSV('sales_orders_report.csv', orders, ['id', 'order_no', 'client_name', 'order_value', 'status', 'order_date', 'description']);
};
// format 'docx' (default, the stored engineering annexure) or 'pdf' (always
// rendered fresh from the order's current data - see lib/annexurePdf.js).
window.downloadAnnexure = async (ev, orderId, format) => {
  if (ev) ev.preventDefault();
  try {
    const url = format === 'pdf' ? `/api/sales/orders/${orderId}/annexure/pdf` : `/api/sales/orders/${orderId}/annexure`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : (format === 'pdf' ? 'annexure.pdf' : 'annexure.docx');
    const blob = await res.blob();
    if (format === 'pdf') { openOrDownloadBlob(blob, filename); return false; }
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = objUrl; a.download = filename; a.click();
    URL.revokeObjectURL(objUrl);
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
    <div class="hig-actions" style="margin-top:6px;">
      ${!oc.locked ? `<button class="btn small" onclick="saveOrderConfirmation(${orderId})">Save</button>
      ${['Draft', 'Rejected'].includes(oc.status) ? `<button class="btn small outline" onclick="submitOrderConfirmation(${orderId})">Submit for Approval</button>` : ''}`
        : (oc.status === 'Approved' && ME.role === 'Admin' ? `<button class="btn small outline red" onclick="unlockOrderConfirmation(${orderId})">Unlock for Revision</button>` : '')}
      <a href="#" onclick="downloadOrderConfirmationPdf(${orderId});return false;">Download PDF</a>
    </div>

    <h4 style="margin-top:18px;border-top:1px solid var(--border);padding-top:12px;">Annexure</h4>
    ${reviewStatusBlock(ar, 'annexure.approve', `approveAnnexure(${orderId})`, `rejectAnnexure(${orderId})`)}
    ${ar.annexure_is_manual ? `<div class="msg" style="display:block;background:#fff3cd;border:1px solid #ffe08a;">A manually uploaded file is currently on file for this Annexure - it will NOT be overwritten by editing the order's Customer PO/line items, only by clicking "Regenerate Annexure" below or uploading another file.</div>` : ''}
    <label>Review Notes <span class="muted">(internal, not printed on the document)</span></label>
    <textarea id="ar-notes-${orderId}" rows="2" style="width:100%;" ${ar.locked ? 'disabled' : ''}>${esc(ar.review_notes)}</textarea>
    <label style="margin-top:8px;display:block;">Annexure Notes <span class="muted">(printed on the Annexure document itself)</span></label>
    <textarea id="ar-docnotes-${orderId}" rows="2" style="width:100%;" ${ar.locked ? 'disabled' : ''}>${esc(ar.notes)}</textarea>
    <div class="hig-actions" style="margin-top:6px;">
      ${!ar.locked ? `<button class="btn small" onclick="saveAnnexureNotes(${orderId})">Save Notes</button>
      <button class="btn small outline" onclick="regenerateAnnexureInModal(${orderId}, ${!!ar.annexure_is_manual})">Regenerate Annexure</button>
      <input type="file" id="ar-file-${orderId}" style="display:inline-block;width:auto;">
      <button class="btn small outline" onclick="uploadAnnexureFile(${orderId})">Upload Revised File</button>
      ${['Draft', 'Rejected'].includes(ar.status) ? `<button class="btn small outline" onclick="submitAnnexure(${orderId})">Submit for Approval</button>` : ''}`
        : (ar.status === 'Approved' && ME.role === 'Admin' ? `<button class="btn small outline red" onclick="unlockAnnexure(${orderId})">Unlock for Revision</button>` : '')}
      <a href="#" onclick="downloadAnnexure(event, ${orderId});return false;">Download Annexure</a>
      <a href="#" onclick="downloadAnnexure(event, ${orderId}, 'pdf');return false;">Download Annexure (PDF)</a>
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
// Admin-only - the only way back to an editable state for an Order
// Confirmation letter already Approved/locked, since Reject only ever acts
// on PendingApproval. Mirrors unlockAnnexure() exactly.
window.unlockOrderConfirmation = async (orderId) => {
  const reason = prompt('Why does this approved Order Confirmation letter need to be unlocked for revision? (required)');
  if (reason === null) return;
  try { await api(`/order-confirmation/order-confirmations/${orderId}/unlock`, { method: 'POST', body: JSON.stringify({ reason }) }); await renderOrderConfirmationModal(orderId); }
  catch (e) { alert(e.message); }
};
window.regenerateAnnexureInModal = async (orderId, isManual) => {
  if (isManual && !confirm('A manually uploaded file is currently on file - regenerating will replace it with a fresh copy built from the order\'s own live data. Continue?')) return;
  try {
    await api(`/sales/orders/${orderId}/regenerate-annexure`, { method: 'POST' });
    await renderOrderConfirmationModal(orderId);
  } catch (e) { alert(e.message); }
};
window.saveAnnexureNotes = async (orderId) => {
  try {
    await api(`/order-confirmation/annexure-reviews/${orderId}`, { method: 'PUT', body: JSON.stringify({
      review_notes: val(`ar-notes-${orderId}`), notes: val(`ar-docnotes-${orderId}`),
    })});
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
// Admin-only - the only way back to an editable state for an annexure
// already Approved/locked, since Reject only ever acts on PendingApproval.
window.unlockAnnexure = async (orderId) => {
  const reason = prompt('Why does this approved annexure need to be unlocked for revision? (required)');
  if (reason === null) return;
  try { await api(`/order-confirmation/annexure-reviews/${orderId}/unlock`, { method: 'POST', body: JSON.stringify({ reason }) }); await renderOrderConfirmationModal(orderId); }
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
      <div><label><input id="${prefix}-abg-required" type="checkbox" ${o.abg_required ? 'checked' : ''}> Advance BG (ABG) required</label></div>
      <div><label>ABG %</label><input id="${prefix}-abg-pct" type="number" step="0.01" value="${o.abg_percentage ?? ''}"></div>
      <div><label>ABG Amount (₹, if flat)</label><input id="${prefix}-abg-amt" type="number" value="${o.abg_amount ?? ''}"></div>
      <div><label>ABG Validity (days from issue)</label><input id="${prefix}-abg-days" type="number" value="${o.abg_validity_days ?? ''}"></div>
    </div>
    <div class="form-grid">
      <div><label><input id="${prefix}-pbg-required" type="checkbox" ${o.pbg_required ? 'checked' : ''}> Performance BG (PBG) required</label></div>
      <div><label>PBG %</label><input id="${prefix}-pbg-pct" type="number" step="0.01" value="${o.pbg_percentage ?? ''}"></div>
      <div><label>PBG Amount (₹, if flat)</label><input id="${prefix}-pbg-amt" type="number" value="${o.pbg_amount ?? ''}"></div>
      <div><label>PBG Validity (days from issue)</label><input id="${prefix}-pbg-days" type="number" value="${o.pbg_validity_days ?? ''}"></div>
    </div>
    <div><label>BG Terms Notes</label><textarea id="${prefix}-bg-notes" rows="2">${esc(o.bg_terms_notes || '')}</textarea></div>
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
  const lines = SO_LINES.filter(l => l.description && l.description.trim());
  try {
    const r = await api('/sales/orders', { method: 'POST', body: JSON.stringify({
      client_id: val('so-client'), lead_id: val('so-lead') || null, order_value: val('so-value'), description: val('so-desc'),
      po_number: val('so-po-number'), po_date: val('so-po-date') || null,
      advance_percent: val('so-advance-pct') || 0, predispatch_percent: val('so-predispatch-pct') || 0,
      payment_terms: val('so-payment-terms') || null,
      lines,
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
  <div><label>Payment Terms <span class="muted">(reused on every Proforma/Invoice generated against this order)</span></label><textarea id="so-terms-paymentterms-${o.id}" rows="2" style="width:100%;">${esc(o.payment_terms || '')}</textarea></div>
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
      payment_terms: val(`so-terms-paymentterms-${id}`) || null,
      ...readBgTermsFields(`so-terms-${id}`),
    })});
    navigate('orders');
  } catch (e) { alert(e.message); }
};

// ---- Customer PO capture + cross-check against the order's own terms ----
// PO_FIELD_MAP lets the exact same bgTermsFormFields/readBgTermsFields BG
// widget used for the order's own terms be reused for the PO's stated BG
// terms too, by mapping po_abg_* <-> abg_* on the way in/out rather than
// building a second near-identical form.
const PO_BG_FIELD_MAP = ['abg_required', 'abg_percentage', 'abg_amount', 'abg_validity_days', 'pbg_required', 'pbg_percentage', 'pbg_amount', 'pbg_validity_days'];
function poToBgShape(o) {
  const shaped = {};
  PO_BG_FIELD_MAP.forEach(k => { shaped[k] = o['po_' + k]; });
  return shaped;
}
function bgShapeToPoFields(fields) {
  const out = {};
  PO_BG_FIELD_MAP.forEach(k => { out['po_' + k] = fields[k]; });
  return out;
}
window.toggleSOPo = async (id) => {
  const row = document.getElementById(`so-po-row-${id}`);
  const opening = row.style.display === 'none';
  row.style.display = opening ? '' : 'none';
  if (opening) await renderSOPoBody(id);
};
async function renderSOPoBody(id) {
  const orders = await api('/sales/orders');
  const o = orders.find(x => x.id === id);
  const body = document.getElementById(`so-po-body-${id}`);
  const mismatches = o.po_mismatch_fields ? JSON.parse(o.po_mismatch_fields) : [];
  body.innerHTML = `
    <div class="form-grid">
      <div><label>Customer PO Status</label>
        <select id="so-po-status-${id}" onchange="document.getElementById('so-po-details-${id}').style.display = this.value === 'Received' ? '' : 'none'">
          <option value="Pending" ${o.po_status === 'Pending' ? 'selected' : ''}>Not yet decided</option>
          <option value="NotProvided" ${o.po_status === 'NotProvided' ? 'selected' : ''}>Not Provided - run on the order's own terms</option>
          <option value="Received" ${o.po_status === 'Received' ? 'selected' : ''}>Received</option>
        </select>
      </div>
    </div>
    <div id="so-po-details-${id}" style="display:${o.po_status === 'Received' ? '' : 'none'};">
      <div class="form-grid">
        <div><label>PO Number</label><input id="so-po-number-${id}" value="${esc(o.po_number)}"></div>
        <div><label>PO Date</label><input id="so-po-date-${id}" type="date" value="${o.po_date || ''}"></div>
        <div><label>PO Delivery Date</label><input id="so-po-delivery-${id}" type="date" value="${o.po_delivery_date || ''}"></div>
        <div><label>PO LD Rate (%)</label><input id="so-po-ldpct-${id}" type="number" step="0.01" value="${o.po_ld_percentage ?? ''}"></div>
        <div><label>PO LD Cap (%)</label><input id="so-po-ldcap-${id}" type="number" step="0.01" value="${o.po_ld_cap_percentage ?? ''}"></div>
      </div>
      ${bgTermsFormFields(`so-po-${id}`, poToBgShape(o))}
    </div>
    <button class="btn small" type="button" onclick="saveSOPo(${id})">Save Customer PO</button>
    <div id="so-po-err-${id}" class="msg err" style="display:none;margin-top:8px;"></div>
    ${o.po_terms_status === 'MismatchPending' || o.po_terms_status === 'MismatchAcknowledged' ? `
      <div class="msg ${o.po_terms_status === 'MismatchPending' ? 'err' : ''}" style="margin-top:10px;">
        <b>${o.po_terms_status === 'MismatchPending' ? 'Terms mismatch - not-yet-started stages are blocked until this is resolved:' : 'Mismatch acknowledged:'}</b>
        <ul style="margin:6px 0 0 18px;">${mismatches.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
        ${o.po_terms_status === 'MismatchAcknowledged' ? `<p class="muted" style="margin:6px 0 0;">${esc(o.po_terms_resolution_notes)}</p>` : `
        <div style="margin-top:8px;">
          <button class="btn small" type="button" onclick="acceptPoTerms(${id})">Accept PO's Terms</button>
          <button class="btn small outline" type="button" onclick="acknowledgePoMismatch(${id})">Acknowledge &amp; Override</button>
        </div>`}
      </div>` : ''}
    <div id="so-po-attachments-${id}" style="margin-top:10px;"></div>`;
  renderAttachmentsWidget('sales_order', id, document.getElementById(`so-po-attachments-${id}`), ['CustomerPO', 'Other']);
}
window.saveSOPo = async (id) => {
  const errEl = document.getElementById(`so-po-err-${id}`);
  errEl.style.display = 'none';
  const status = val(`so-po-status-${id}`);
  try {
    if (status === 'Received') {
      await api(`/sales/orders/${id}/po`, { method: 'PUT', body: JSON.stringify({
        po_status: 'Received', po_number: val(`so-po-number-${id}`), po_date: val(`so-po-date-${id}`) || null,
        po_delivery_date: val(`so-po-delivery-${id}`) || null, po_ld_percentage: val(`so-po-ldpct-${id}`) || null,
        po_ld_cap_percentage: val(`so-po-ldcap-${id}`) || null,
        ...bgShapeToPoFields(readBgTermsFields(`so-po-${id}`)),
      })});
    } else if (status === 'NotProvided') {
      await api(`/sales/orders/${id}/po`, { method: 'PUT', body: JSON.stringify({ po_status: 'NotProvided' }) });
    } else {
      errEl.textContent = 'Pick "Not Provided" or "Received" to save.'; errEl.style.display = 'block'; return;
    }
    await renderSOPoBody(id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.acceptPoTerms = async (id) => {
  if (!confirm("Overwrite this order's own commercial terms with the customer PO's terms?")) return;
  try { await api(`/sales/orders/${id}/po/accept-po-terms`, { method: 'POST' }); navigate('orders'); }
  catch (e) { alert(e.message); }
};
window.acknowledgePoMismatch = async (id) => {
  const reason = prompt('Reason for accepting this mismatch as-is (kept in the audit trail):');
  if (reason === null) return;
  if (!reason.trim()) { alert('Enter a reason.'); return; }
  try {
    await api(`/sales/orders/${id}/po/acknowledge-mismatch`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    await renderSOPoBody(id);
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
    refreshOfferTabLabels(data.offer);
    renderOfferTab(data);
    if (msg) showMsg(panel, msg, true);
  }
}
// Tab labels show "(excluded)" for a section whose "Include in generated PDF"
// flag is off - keeps that in sync after an in-place save (saveKvTab/
// saveTextTab) without re-rendering the whole header and losing tab focus.
function refreshOfferTabLabels(o) {
  const labels = {
    tech: 'Technical Specification' + (o.show_tech_specs === 0 ? ' (excluded)' : ''),
    boughtout: 'Make of Bought Out Items' + (o.show_bought_out === 0 ? ' (excluded)' : ''),
    text: 'Inclusions / Exclusions / Utilities' + (o.show_inclusions_exclusions === 0 ? ' (excluded)' : ''),
  };
  const tabsBar = document.querySelector('#offer-builder-panel .tabs');
  if (!tabsBar) return;
  Object.entries(labels).forEach(([id, label]) => {
    const tabEl = tabsBar.querySelector(`.tab[data-tab-id="${id}"]`);
    if (tabEl) tabEl.textContent = label;
  });
}

PAGES.offers = async (el) => {
  const [offers, clients, leads] = await Promise.all([api('/offers'), api('/masters/clients'), api('/sales/leads')]);
  window.__OFFERS_CACHE = offers;
  window.__OFFERS_CLIENTS = clients;
  window.__OFFERS_LEADS = leads;
  el.innerHTML = `
    <div class="panel"><h3>New Offer</h3>
      <div class="form-grid">
        <div><label>Client</label>${clientPickerHTML('nf-client', clients, '', null, 'onchange="prefillOfferContactFromClient()"')}</div>
        <div><label>Linked Enquiry / RFQ (optional)</label><select id="nf-lead">
          <option value="">-- None --</option>
          ${leads.map(l => `<option value="${l.id}">${esc(l.client_name)} - ${esc(l.product_interest || l.enquiry_details || ('Lead #' + l.id))}</option>`).join('')}
        </select></div>
        <div><label>Contact Person</label><input id="nf-contact"></div>
        <div><label>Contact Phone</label><input id="nf-phone"></div>
        <div><label>Contact Email</label><input id="nf-email"></div>
        <div><label>Subject / Machine</label><input id="nf-subject" placeholder="e.g. Electronic Weighing and Bagging System"></div>
      </div>
      ${clients.length === 0 ? '<div class="msg err">Add a client first (Sales &amp; Marketing &rarr; Clients).</div>' : ''}
      <div class="hig-savebar"><button class="btn" onclick="createOffer()">Create Offer (opens builder with prefilled sheets)</button></div>
    </div>
    <button class="btn small outline" onclick="reportOffers()">Generate Report (CSV)</button>
    ${collapsiblePanel('offers-list', `<span id="of-count">All Offers (${offers.length})</span>`, `
      ${renderListSearch('offers', offers, ['offer_no', 'client_name', 'group_name', 'subject', 'status', 'lead_enquiry_details'], (rows) => {
        document.getElementById('of-table-wrap').innerHTML = customerGroupedHTML(rows, 'of', OFFER_LIST_COLUMNS, offerRowHTML, OFFER_SORT_OPTS);
        document.getElementById('of-count').textContent = 'All Offers (' + rows.length + ')';
      }, 'Search by offer no, client, subject, status...')}
      <div id="of-table-wrap">${customerGroupedHTML(offers, 'of', OFFER_LIST_COLUMNS, offerRowHTML, OFFER_SORT_OPTS)}</div>
    `)}
    <div class="panel" id="offer-copy-panel" style="display:none;">
      <h3>Copy Offer to Another Customer</h3>
      <p class="muted">Copying <b id="ocp-source-label"></b> — creates a brand-new Draft offer (its own offer number, starting at version 1, no link back to the original) with all of this offer's content: scope items, pictures, specifications, terms, everything. The original offer is never changed.</p>
      <div class="form-grid">
        <div><label>Customer</label>${clientPickerHTML('ocp-client', clients, '')}</div>
        <div><label>Linked Enquiry / RFQ (optional)</label><select id="ocp-lead">
          <option value="">-- None --</option>
          ${leads.map(l => `<option value="${l.id}">${esc(l.client_name)} - ${esc(l.product_interest || l.enquiry_details || ('Lead #' + l.id))}</option>`).join('')}
        </select></div>
        <div><label>Contact Person</label><input id="ocp-contact"></div>
        <div><label>Contact Phone</label><input id="ocp-phone"></div>
        <div><label>Contact Email</label><input id="ocp-email"></div>
      </div>
      <div class="hig-savebar">
      <button class="btn" onclick="submitCopyOffer()">Create Copy</button>
      <button class="btn outline" type="button" onclick="document.getElementById('offer-copy-panel').style.display='none'">Cancel</button>
      </div>
      <div id="ocp-err" class="msg err" style="display:none;"></div>
    </div>
    <div class="panel" id="offer-builder-panel" style="display:none;"></div>
  `;
  // Pre-fill Contact Person/Phone/Email from whichever client the browser's
  // own <select> defaults to selecting (its first option) - without this
  // the form opens showing a client already "picked" but blank contact
  // fields, the exact gap reported (switching the dropdown is the same
  // code path, see prefillOfferContactFromClient() below).
  if (clients.length) prefillOfferContactFromClient();
};
// Client picked/switched on New Offer (2026-10-14) - always overwrites
// Contact Person/Phone/Email from that client's own saved record, per the
// owner's explicit "always overwrite" answer - picking a client is expected
// to load their current default contact, not merge with whatever was typed
// for a previously-selected client.
window.prefillOfferContactFromClient = () => {
  const id = Number(val('nf-client'));
  const c = (window.__OFFERS_CLIENTS || []).find(x => x.id === id);
  if (!c) return;
  document.getElementById('nf-contact').value = c.contact_person || '';
  document.getElementById('nf-phone').value = c.phone || '';
  document.getElementById('nf-email').value = c.email || '';
};
// Column labels + single-row renderer split out of what used to be one
// tableHTML()-calling renderOfferRows(rows) (2026-10-14) - see the identical
// ORDER_LIST_COLUMNS/orderRowHTML split above and customerGroupedHTML()'s
// own comment for why (one shared <table> per list instead of one per
// Customer Group rollup, so column widths line up across every group).
const OFFER_LIST_COLUMNS = ['Offer No', 'Client', 'Enquiry/RFQ', 'Subject', 'Date', 'Status', ''];
// Click-to-sort column headers on the All Offers list (2026-10-27) - every
// column sortable except the trailing Action column (field: null there).
const OFFER_SORT_OPTS = { containerId: 'of-table-wrap', sortKey: 'of-sort', fields: ['offer_no', 'client_name', 'lead_enquiry_details', 'subject', 'offer_date', 'status', null] };
function offerRowHTML(o) {
  return `<tr><td>${esc(o.offer_no)}</td><td>${esc(o.client_name)}</td><td>${esc(o.lead_enquiry_details) || '-'}</td><td>${esc(o.subject)}</td><td>${fmtDMY(o.offer_date)}</td><td>${badge(o.status)}</td>
    <td>${actionButtonsCell(`
      <button class="btn small outline" onclick="openOfferBuilder(${o.id})">Open</button>
      <button class="btn small outline" onclick="openCopyOfferPanel(${o.id})">Copy to...</button>
      ${ME.role === 'Admin' && !o.locked ? `<button class="btn small red" onclick="deleteOfferRow(${o.id})">Delete</button>` : ''}
    `)}</td></tr>`;
}
// `labelOverride`, when given, skips the __OFFERS_CACHE lookup entirely -
// used by "Create Offer from Template" (useTemplate() below), since a
// Standard Template is deliberately excluded from GET /offers (and so
// never appears in that cache) and has no client_name to show anyway.
window.openCopyOfferPanel = (id, labelOverride) => {
  let label = labelOverride;
  if (!label) {
    const o = (window.__OFFERS_CACHE || []).find(x => x.id === id);
    if (!o) return;
    label = `${o.offer_no} (${o.client_name})`;
  }
  window.__COPY_SOURCE_OFFER_ID = id;
  document.getElementById('ocp-source-label').textContent = label;
  resetSearchPicker('ocp-client');
  document.getElementById('ocp-lead').value = '';
  document.getElementById('ocp-contact').value = '';
  document.getElementById('ocp-phone').value = '';
  document.getElementById('ocp-email').value = '';
  document.getElementById('ocp-err').style.display = 'none';
  const panel = document.getElementById('offer-copy-panel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
};
window.submitCopyOffer = async () => {
  const errEl = document.getElementById('ocp-err');
  errEl.style.display = 'none';
  const clientId = val('ocp-client');
  if (!clientId) { errEl.textContent = 'Pick a customer to copy this offer to.'; errEl.style.display = 'block'; return; }
  try {
    const r = await api(`/offers/${window.__COPY_SOURCE_OFFER_ID}/copy`, { method: 'POST', body: JSON.stringify({
      client_id: clientId, lead_id: val('ocp-lead') || null,
      contact_person: val('ocp-contact'), contact_phone: val('ocp-phone'), contact_email: val('ocp-email'),
    })});
    document.getElementById('offer-copy-panel').style.display = 'none';
    await openOfferBuilder(r.id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
// "Create Offer from Template" (Offer Field Options page) - reuses the
// existing Copy-to-another-customer flow unchanged (routes/offers.js's
// POST /:id/copy never reads the source's client_id, only writes the new
// one from the request body, so copying FROM a client-less template works
// exactly like copying from any other offer) - it just lives on the main
// Offers page's DOM, so this navigates there first.
window.useTemplate = async (id, subject) => {
  await navigate('offers');
  openCopyOfferPanel(id, 'Standard Template: ' + subject);
};
window.deleteOfferTemplate = async (id) => {
  if (!confirm('Permanently delete this Standard Template? This cannot be undone.')) return;
  try {
    await api('/offers/' + id, { method: 'DELETE' });
    navigate('offer-options');
  } catch (e) { alert(e.message); }
};
window.createOfferTemplate = async () => {
  const errEl = document.getElementById('ot-err');
  errEl.style.display = 'none';
  const subject = val('ot-subject').trim();
  if (!subject) { errEl.textContent = 'Give the template a name.'; errEl.style.display = 'block'; return; }
  try {
    const r = await api('/offers', { method: 'POST', body: JSON.stringify({ is_template: true, subject }) });
    await openOfferBuilder(r.id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
// "Save as Template" (Admin-only, Offer Builder page) - spins off a new
// Standard Template from this real offer's full content (scope/specs/terms/
// pictures) without touching this offer at all, skipping the hand-rebuild
// createOfferTemplate() above requires for a template that closely matches
// one already on file. routes/offers.js's POST /:id/save-as-template clears
// every customer-identifying field server-side; this just asks for the new
// template's name (defaulting to this offer's own subject) before calling it.
window.saveOfferAsTemplate = async () => {
  const subject = prompt('Name for the new template:', CURRENT_OFFER ? CURRENT_OFFER.subject || '' : '');
  if (subject === null) return;
  const trimmed = subject.trim();
  if (!trimmed) { alert('Give the template a name.'); return; }
  try {
    const r = await api('/offers/' + CURRENT_OFFER_ID + '/save-as-template', { method: 'POST', body: JSON.stringify({ subject: trimmed }) });
    await openOfferBuilder(r.id);
  } catch (e) { alert(e.message); }
};
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
      client_id: val('nf-client'), lead_id: val('nf-lead') || null, contact_person: val('nf-contact'), contact_phone: val('nf-phone'), contact_email: val('nf-email'), subject: val('nf-subject')
    })});
    await openOfferBuilder(r.id);
  } catch (e) { alert(e.message); }
};

window.openOfferBuilder = async (id) => {
  CURRENT_OFFER_ID = id;
  OFFER_FLAG_OVERRIDES = {};
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
    ['commercial', 'Commercial Terms'],
    // Spares offers print no equipment pages and the picker below lists the Machine library only
    ...(o.offer_format === 'Spares' ? [] : [['equipment-ref', 'Reference Equipment']]),
    ['attachments', 'Attachments (GA Drawing / CAD)'],
    ['annexure', 'Annexure' + (data.annexures && data.annexures.length ? ` (${data.annexures.length})` : '')],
  ];
  panel.innerHTML = `
    <h3>${o.is_template ? 'Standard Template' : 'Offer Builder'} &mdash; ${esc(o.offer_no)} v${o.version} <span class="badge ${esc(o.status)}">${esc(o.status)}</span>${o.locked ? ' <span class="badge red">Locked</span>' : ''}${o.is_template ? ' <span class="badge">TEMPLATE</span>' : ''}</h3>
    ${o.is_template ? `<p class="muted" style="margin-top:-6px;">A Standard Template - not tied to any customer and never sent/confirmed. Build out its scope, specs, terms and pictures here; Sales uses "Create Offer from Template" on the Offer Field Options page to start a real customer offer from it.</p>` : ''}
    ${o.locked ? `<div class="msg err" style="margin-bottom:10px;">
      This offer was converted to a Sales Order and is locked against further edits.${o.locked_reason ? ' ' + esc(o.locked_reason) + '.' : ''}
      ${ME.role === 'Admin' ? '<button class="btn small outline" style="margin-left:10px;" onclick="unlockOffer()">Unlock (Admin)</button>' : ' Ask an Admin to unlock it if this offer genuinely needs a further revision.'}
    </div>` : ''}
    ${versions.length > 1 ? `<div class="panel" style="background:#f6f7f9;">
      <b>Version History</b>
      ${tableHTML(['Version', 'Status', 'Date', 'Revision Reason', ''], versions, v => `
        <tr${v.id === o.id ? ' style="font-weight:600;"' : ''}><td>v${v.version}</td><td>${badge(v.status)}</td><td>${fmtDMY(v.offer_date)}</td>
        <td class="muted">${esc(v.revision_reason) || '-'}</td>
        <td>${actionButtonsCell(`${v.id !== o.id ? `<button class="btn small outline" onclick="openOfferBuilder(${v.id})">View</button>` : '<span class="muted">Current</span>'}
          <a class="btn small outline" href="#" onclick="downloadOfferVersionPdf(${v.id});return false;">PDF</a>`)}</td></tr>`)}
    </div>` : ''}
    <div class="form-grid">
      <div><label>${o.is_template ? 'Template Name' : 'Subject / Machine'}</label><input id="ob-subject" value="${esc(o.subject)}"></div>
      ${o.is_template ? '' : `
      <div><label>Contact Person</label><input id="ob-contact" value="${esc(o.contact_person)}"></div>
      <div><label>Contact Phone</label><input id="ob-phone" value="${esc(o.contact_phone)}"></div>
      <div><label>Contact Email</label><input id="ob-email" value="${esc(o.contact_email)}"></div>
      <div><label>Reference (Email/RFQ)</label><input id="ob-ref" value="${esc(o.customer_reference)}" placeholder="Customer's email / RFQ no"></div>`}
      <div><label>Drawing No</label><input id="ob-drawing" value="${esc(o.drawing_no)}"></div>
      <div><label>Application</label>${offerFieldSelect('ob-application', applicationOpts, o.application)}</div>
      <div><label>Type Of System</label>${offerFieldSelect('ob-type', typeOpts, o.type_of_system)}</div>
      <div><label>Material Of Construction</label>${offerFieldSelect('ob-material', materialOpts, o.material_of_construction)}</div>
      <div><label>Offer Format</label><select id="ob-format" onchange="offerFormatChanged()">
        <option value="Standard" ${o.offer_format !== 'Spares' ? 'selected' : ''}>Standard (full offer)</option>
        <option value="Spares" ${o.offer_format === 'Spares' ? 'selected' : ''}>Spares / Quick Quote (no cover page, company profile, project data sheet or equipment photos)</option>
      </select></div>
    </div>
    <div class="tabs">${tabs.map(([id, label]) => `<div class="tab ${CURRENT_OFFER_TAB === id ? 'active' : ''}" data-tab-id="${id}" onclick="switchOfferTab('${id}')">${label}</div>`).join('')}</div>
    <div id="offer-tab-content"></div>
    <div class="hig-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
      <button class="btn" onclick="saveOfferHeader()">Save Header</button>
      ${!o.is_template && o.status === 'Draft' ? `<button class="btn outline" onclick="markOfferSent()">Mark as Sent</button>` : ''}
      <button class="btn outline" onclick="downloadOfferPdf()">Download PDF</button>
      ${!o.is_template && o.status !== 'Won' ? `<button class="btn outline" onclick="downloadOfferAnnexurePreview()">Preview Annexure (PDF)</button>` : ''}
      ${o.is_template ? '' : (o.status !== 'Won' ? `<button class="btn green" onclick="confirmOffer()">Confirm Order &rarr; Create Sales Order &amp; Queue for Execution</button>` : `<span class="muted">Confirmed as Sales Order #${o.sales_order_id}</span>`)}
      ${!o.is_template && ME.role === 'Admin' ? `<button class="btn outline" onclick="saveOfferAsTemplate()">Save as Template</button>` : ''}
    </div>
  `;
  renderOfferTab(data);
}
// The three "Include in generated PDF" checkboxes each live inside their own
// offer-builder tab now, so at most one is mounted in the DOM at a time -
// falls back to the last-saved server value for whichever tab isn't active.
// Unsaved show_* flag changes made by the Spares hook (offerFormatChanged) -
// the checkboxes live inside tabs that aren't mounted, so the pending values
// are held here until Save Header persists them (cleared in openOfferBuilder).
let OFFER_FLAG_OVERRIDES = {};
const OFFER_FLAG_FIELDS = { 'ob-show-tech': 'show_tech_specs', 'ob-show-boughtout': 'show_bought_out', 'ob-show-inclexcl': 'show_inclusions_exclusions' };
function offerShowFlag(id, currentValue) {
  const el = document.getElementById(id);
  if (el) return el.checked ? 1 : 0;
  return id in OFFER_FLAG_OVERRIDES ? OFFER_FLAG_OVERRIDES[id] : currentValue;
}
window.saveOfferHeader = async () => {
  try {
    const data = await api('/offers/' + CURRENT_OFFER_ID);
    const reason = confirmOfferRevision(data.offer);
    if (reason === null) return;
    // Contact fields don't exist in the builder for a Standard Template
    // (see renderOfferBuilder) - guard rather than val()'s unconditional
    // getElementById().value, which would throw on a missing element.
    const r = await api('/offers/' + CURRENT_OFFER_ID, { method: 'PUT', body: JSON.stringify({
      subject: val('ob-subject'),
      contact_person: document.getElementById('ob-contact') ? val('ob-contact') : null,
      contact_phone: document.getElementById('ob-phone') ? val('ob-phone') : null,
      contact_email: document.getElementById('ob-email') ? val('ob-email') : null,
      drawing_no: val('ob-drawing'), application: val('ob-application'), type_of_system: val('ob-type'), material_of_construction: val('ob-material'),
      inclusions: data.offer.inclusions, exclusions: data.offer.exclusions, utilities_requirement: data.offer.utilities_requirement,
      instrument_air_supply: data.offer.instrument_air_supply, status: data.offer.status, revision_reason: reason || null,
      show_tech_specs: offerShowFlag('ob-show-tech', data.offer.show_tech_specs),
      show_bought_out: offerShowFlag('ob-show-boughtout', data.offer.show_bought_out),
      show_inclusions_exclusions: offerShowFlag('ob-show-inclexcl', data.offer.show_inclusions_exclusions),
      offer_format: val('ob-format'),
      customer_reference: document.getElementById('ob-ref') ? val('ob-ref') : undefined,
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
    openOrDownloadBlob(blob, match ? match[1] : 'offer-v' + offerId + '.pdf');
  } catch (e) { alert(e.message); }
};
window.downloadOfferPdf = async () => {
  try {
    const res = await fetch('/api/offers/' + CURRENT_OFFER_ID + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    openOrDownloadBlob(blob, match ? match[1] : 'offer.pdf');
  } catch (e) { alert(e.message); }
};
// Preview of the Sales Order Annexure document before this Offer has been
// confirmed into a real order - rendered fresh server-side from the Offer's
// own scope-of-supply/tech-specs/bought-out data, never stored (there's no
// Sales Order yet to attach a stored file to).
window.downloadOfferAnnexurePreview = async () => {
  try {
    const res = await fetch('/api/offers/' + CURRENT_OFFER_ID + '/annexure/preview-pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Annexure preview generation failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    openOrDownloadBlob(blob, match ? match[1] : 'annexure-preview.pdf');
  } catch (e) { alert(e.message); }
};
window.confirmOffer = async () => {
  if (!confirm('Confirm this offer as a won order? This creates a Sales Order and queues the project for execution across all departments.')) return;
  try {
    const r = await api(`/offers/${CURRENT_OFFER_ID}/confirm`, { method: 'POST' });
    alert(`Sales Order ${r.orderNo} created. Project ${r.projCode} queued for execution across all departments.`);
    navigate('projects');
  } catch (e) {
    // Missing billing details (routes/offers.js) - open the fix-it-here
    // popup instead of just telling the user to go find Clients -> Edit
    // themselves (2026-10-15).
    if (e.data && e.data.missing_billing && e.data.client) openMissingBillingModal(e.data.client);
    else alert(e.message);
  }
};
window.markOfferSent = async () => {
  if (!confirm('Mark this offer as Sent to the customer? This also updates the Offer Date to today.')) return;
  try {
    await api(`/offers/${CURRENT_OFFER_ID}/mark-sent`, { method: 'POST' });
    await openOfferBuilder(CURRENT_OFFER_ID);
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
  const tabsBar = document.querySelector('#offer-builder-panel .tabs');
  if (tabsBar) tabsBar.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tabId === tab));
  renderOfferTab(data);
};
// Picking a new Offer Format should change what the Scope tab shows (Unit/
// Discount fields, Spares-vs-Standard table) immediately, not only after a
// server round-trip via Save Header (2026-10-16) - re-fetches the offer's
// own data (items etc. haven't changed) and re-renders the active tab.
window.offerFormatChanged = async () => {
  if (!CURRENT_OFFER_ID) return;
  // Choosing Spares un-selects the full-offer sections (tech specs, bought-out
  // makes, inclusions/exclusions) - held as pending overrides, still freely
  // re-tickable on their own tabs before Save Header.
  if (val('ob-format') === 'Spares') {
    Object.keys(OFFER_FLAG_FIELDS).forEach(id => { OFFER_FLAG_OVERRIDES[id] = 0; });
  }
  const data = await api('/offers/' + CURRENT_OFFER_ID);
  renderOfferTab(data);
};

function renderOfferTab(data) {
  const el = document.getElementById('offer-tab-content');
  // The Scope tab's layout depends on offer_format - always read it live off
  // the Offer Format dropdown rather than data.offer's last-saved value, so
  // an unsaved format change (and a tab switch away and back before saving)
  // both render correctly without requiring Save Header first.
  const fmtEl = document.getElementById('ob-format');
  if (fmtEl) data = Object.assign({}, data, { offer: Object.assign({}, data.offer, { offer_format: fmtEl.value }) });
  // Apply pending Spares-hook flag overrides; a checkbox still mounted from the
  // previous render carries any manual re-tick, so capture that first.
  Object.keys(OFFER_FLAG_OVERRIDES).forEach(id => { const c = document.getElementById(id); if (c) OFFER_FLAG_OVERRIDES[id] = c.checked ? 1 : 0; });
  if (Object.keys(OFFER_FLAG_OVERRIDES).length) {
    const patch = {};
    Object.entries(OFFER_FLAG_OVERRIDES).forEach(([id, v]) => { patch[OFFER_FLAG_FIELDS[id]] = v; });
    data = Object.assign({}, data, { offer: Object.assign({}, data.offer, patch) });
  }
  if (CURRENT_OFFER_TAB === 'scope') return renderScopeTab(el, data);
  if (CURRENT_OFFER_TAB === 'tech') return renderKvTab(el, data.techSpecs, 'spec_key', 'spec_value', 'tech-specs', 'Specification', 'Value', undefined, data.offer.show_tech_specs === 0, { id: 'ob-show-tech', field: 'show_tech_specs', label: 'Technical Specifications', checked: data.offer.show_tech_specs !== 0 });
  if (CURRENT_OFFER_TAB === 'boughtout') return renderKvTab(el, data.boughtOut, 'component', 'make', 'bought-out', 'Component', 'Make', undefined, data.offer.show_bought_out === 0, { id: 'ob-show-boughtout', field: 'show_bought_out', label: 'Make of Bought-Out Items', checked: data.offer.show_bought_out !== 0 });
  if (CURRENT_OFFER_TAB === 'terms') return renderKvTab(el, data.terms, 'term_key', 'term_value', 'terms', 'Term', 'Value', OFFER_TERM_LIBRARY);
  if (CURRENT_OFFER_TAB === 'text') return renderTextTab(el, data.offer, data.offer.show_inclusions_exclusions === 0);
  if (CURRENT_OFFER_TAB === 'commercial') return renderOfferCommercialTab(el, data.offer);
  if (CURRENT_OFFER_TAB === 'equipment-ref') return renderEquipmentReferenceTab(el, data);
  if (CURRENT_OFFER_TAB === 'attachments') return renderAttachmentsWidget('offer', data.offer.id, el, ['GADrawing', 'CADFile', 'Other']);
  if (CURRENT_OFFER_TAB === 'annexure') return renderOfferAnnexureTab(el, data);
}

// ---- Annexure tab: paste straight from Excel (TSV on the clipboard) ----
let OFFER_ANNEXURE_ROWS = [];
function renderOfferAnnexureTab(el, data) {
  OFFER_ANNEXURE_ROWS = (data.annexures || []).map(a => ({
    item_code: a.item_code || '', hsn_code: a.hsn_code || '', description: a.description || '',
    qty: a.qty || '', unit: a.unit || '', rate: a.rate || '', remarks: a.remarks || '',
  }));
  el.innerHTML = `
    <p class="muted">Printed as the last page of the offer PDF (only when it has rows). Copy cells in Excel and paste (Ctrl+V) into the box below, or upload the file itself - columns: <b>S.No</b> (optional), <b>Item Code</b>, <b>HSN Code</b>, <b>Description</b>, <b>Qty</b>, <b>Uom</b>, <b>Rate</b>, <b>Amount</b> (recomputed as Qty &times; Rate, not stored from the file), <b>Remarks</b>. A header row is detected automatically; rows are appended and stay editable either way.</p>
    <textarea id="an-paste" rows="3" placeholder="Click here, then press Ctrl+V to paste from Excel" style="width:100%;padding:8px;border:2px dashed var(--border);border-radius:6px;font-family:inherit;" onpaste="pasteOfferAnnexure(event)"></textarea>
    <div style="margin-top:8px;">
      <label>Or upload an Annexure file (.xlsx/.csv) to read its rows in:</label>
      <input id="an-upload-file" type="file" accept=".xlsx,.xls,.csv" onchange="uploadOfferAnnexure(this)">
    </div>
    <div id="an-rows" style="margin-top:10px;"></div>
    <div class="hig-savebar">
      <button class="btn small outline" type="button" onclick="addOfferAnnexureRow()">+ Add Row</button>
      <button class="btn small outline" type="button" onclick="clearOfferAnnexure()">Clear All</button>
      <button class="btn" type="button" onclick="saveOfferAnnexure()">Save Annexure</button>
    </div>`;
  renderOfferAnnexureRows();
}
function renderOfferAnnexureRows() {
  const wrap = document.getElementById('an-rows');
  if (!wrap) return;
  const inp = (i, k, w) => `<input value="${esc(OFFER_ANNEXURE_ROWS[i][k])}" oninput="OFFER_ANNEXURE_ROWS[${i}].${k}=this.value;renderOfferAnnexureAmount(${i})" style="width:${w};padding:5px;border:1px solid var(--border);border-radius:4px;">`;
  const amount = (r) => { const a = (Number(r.qty) || 0) * (Number(r.rate) || 0); return a ? fmt(a) : ''; };
  wrap.innerHTML = `<table><thead><tr><th>S.No</th><th>Item Code</th><th>HSN Code</th><th>Description</th><th>Qty</th><th>Uom</th><th>Rate</th><th>Amount</th><th>Remarks</th><th></th></tr></thead><tbody>
    ${OFFER_ANNEXURE_ROWS.map((r, i) => `<tr><td>${i + 1}</td><td>${inp(i, 'item_code', '90px')}</td><td>${inp(i, 'hsn_code', '80px')}</td><td style="min-width:220px;">${inp(i, 'description', '100%')}</td><td>${inp(i, 'qty', '60px')}</td><td>${inp(i, 'unit', '60px')}</td><td>${inp(i, 'rate', '80px')}</td><td id="an-amt-${i}" class="muted" style="text-align:right;padding-right:6px;">${amount(r)}</td><td style="min-width:140px;">${inp(i, 'remarks', '100%')}</td>
      <td><button class="btn small red" type="button" onclick="removeOfferAnnexureRow(${i})">Delete</button></td></tr>`).join('') || '<tr><td colspan="10" class="empty">No annexure rows yet.</td></tr>'}
  </tbody></table>`;
}
// Amount is always Qty x Rate (locked 2026-10-29 answer) - recomputed live
// on every keystroke in either field rather than being its own editable
// input; the server recomputes and stores it the same way on Save, so this
// is purely a live preview.
window.renderOfferAnnexureAmount = (i) => {
  const cell = document.getElementById(`an-amt-${i}`);
  if (!cell) return;
  const r = OFFER_ANNEXURE_ROWS[i];
  const a = (Number(r.qty) || 0) * (Number(r.rate) || 0);
  cell.textContent = a ? fmt(a) : '';
};
// Parses an Excel/TSV clipboard dump into annexure rows. With a header row
// (any cell reading Description) every recognized column is mapped by name
// (any subset/order); otherwise falls back by column count to the real-
// world 9-column template (S.No/Item Code/HSN Code/Description/Qty/Uom/
// Rate/Amount/Remarks, confirmed 2026-10-29 against the owner's own sample
// file - PR #229's original format) for 8+ columns, or the older 5-column
// shape (S.No/Description/Qty/Unit/Remarks) for fewer. Mirrors
// routes/offers.js's parseAnnexureGrid() (the upload path) exactly.
function parseAnnexureTsv(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return [];
  let grid = lines.map(l => l.split('\t').map(c => c.trim()));
  let map = null;
  const hdr = grid[0].map(c => c.toLowerCase());
  if (hdr.some(c => c.startsWith('desc'))) {
    map = {
      itemCode: hdr.findIndex(c => c.includes('item code') || c.includes('item_code')),
      hsnCode: hdr.findIndex(c => c.includes('hsn')),
      description: hdr.findIndex(c => c.startsWith('desc')),
      qty: hdr.findIndex(c => c === 'qty' || c.startsWith('quant')),
      unit: hdr.findIndex(c => c === 'unit' || c === 'uom'),
      rate: hdr.findIndex(c => c.startsWith('rate')),
      remarks: hdr.findIndex(c => c.startsWith('remark')),
    };
    grid = grid.slice(1);
  } else if (grid[0].length >= 8) {
    map = { itemCode: 1, hsnCode: 2, description: 3, qty: 4, unit: 5, rate: 6, remarks: 8 };
  } else {
    const off = grid[0].length >= 5 ? 1 : 0;
    map = { description: off, qty: off + 1, unit: off + 2, remarks: off + 3 };
  }
  const at = (row, i) => (i !== undefined && i >= 0 && i < row.length ? row[i] : '');
  return grid.map(r => ({
    item_code: at(r, map.itemCode), hsn_code: at(r, map.hsnCode), description: at(r, map.description),
    qty: at(r, map.qty), unit: at(r, map.unit), rate: at(r, map.rate), remarks: at(r, map.remarks),
  })).filter(r => r.description || r.qty || r.unit || r.remarks || r.item_code || r.hsn_code || r.rate);
}
// Upload-and-parse an Excel/CSV Annexure file (2026-10-27) - server-side
// parsing (same column-detection rules as the paste box, routes/offers.js's
// parseAnnexureGrid()) since this app has no client-side XLSX library;
// returned rows are appended into the same editable grid a paste produces,
// nothing is saved until Save Annexure is clicked.
window.uploadOfferAnnexure = async (inputEl) => {
  const file = inputEl.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await apiUpload(`/offers/${CURRENT_OFFER_ID}/annexures/parse-upload`, fd, 'POST');
    OFFER_ANNEXURE_ROWS = OFFER_ANNEXURE_ROWS.concat(r.rows);
    renderOfferAnnexureRows();
  } catch (e) { alert(e.message); }
  inputEl.value = '';
};
window.pasteOfferAnnexure = (ev) => {
  const text = (ev.clipboardData || window.clipboardData).getData('text');
  ev.preventDefault();
  const rows = parseAnnexureTsv(text);
  if (!rows.length) { alert('Nothing to paste - copy a range of cells in Excel first.'); return; }
  OFFER_ANNEXURE_ROWS = OFFER_ANNEXURE_ROWS.concat(rows);
  renderOfferAnnexureRows();
};
window.addOfferAnnexureRow = () => { OFFER_ANNEXURE_ROWS.push({ item_code: '', hsn_code: '', description: '', qty: '', unit: '', rate: '', remarks: '' }); renderOfferAnnexureRows(); };
window.removeOfferAnnexureRow = (i) => { OFFER_ANNEXURE_ROWS.splice(i, 1); renderOfferAnnexureRows(); };
window.clearOfferAnnexure = () => { if (OFFER_ANNEXURE_ROWS.length && !confirm('Clear all annexure rows? (Not saved until you press Save Annexure.)')) return; OFFER_ANNEXURE_ROWS = []; renderOfferAnnexureRows(); };
window.saveOfferAnnexure = async () => {
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const r = await api(`/offers/${CURRENT_OFFER_ID}/annexures`, { method: 'PUT', body: JSON.stringify({ rows: OFFER_ANNEXURE_ROWS, revision_reason: reason || null }) });
    await afterOfferMutation(r, 'Annexure saved');
  } catch (e) { alert(e.message); }
};

// Delivery/LD/BG terms on the offer itself - what we're proposing to commit
// to, reusing the exact fields/UI already used for a Sales Order's own
// commercial terms (bgTermsFormFields/readBgTermsFields). Copied into the
// Sales Order as its starting terms once the offer is confirmed; an order
// whose customer never sends a formal PO keeps running on these.
function renderOfferCommercialTab(el, o) {
  el.innerHTML = `
    <p class="muted">What we're proposing to commit to on delivery/LD/BG - carried over to the Sales Order as its starting terms once this offer is confirmed. Optional; fill in whatever is already agreed.</p>
    <div class="form-grid">
      <div><label>Promised Delivery Date</label><input id="ob-terms-delivery" type="date" value="${o.promised_delivery_date || ''}"></div>
      <div><label>LD Rate (%)</label><input id="ob-terms-ldpct" type="number" step="0.01" value="${o.ld_percentage ?? ''}"></div>
      <div><label>LD Cap (%)</label><input id="ob-terms-ldcap" type="number" step="0.01" value="${o.ld_cap_percentage ?? ''}"></div>
    </div>
    <div><label>Trigger Conditions</label><textarea id="ob-terms-ldnotes" rows="2" style="width:100%;">${esc(o.ld_trigger_notes || '')}</textarea></div>
    ${bgTermsFormFields('ob-terms', o)}
    <button class="btn small" type="button" onclick="saveOfferCommercialTerms()">Save Commercial Terms</button>
    <div id="ob-terms-err" class="msg err" style="display:none;margin-top:8px;"></div>`;
}
window.saveOfferCommercialTerms = async () => {
  const errEl = document.getElementById('ob-terms-err');
  errEl.style.display = 'none';
  try {
    await api(`/offers/${CURRENT_OFFER_ID}/commercial-terms`, { method: 'PATCH', body: JSON.stringify({
      promised_delivery_date: val('ob-terms-delivery') || null,
      ld_percentage: val('ob-terms-ldpct') || null,
      ld_cap_percentage: val('ob-terms-ldcap') || null,
      ld_trigger_notes: val('ob-terms-ldnotes') || null,
      ...readBgTermsFields('ob-terms'),
    })});
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; return; }
  const data = await api('/offers/' + CURRENT_OFFER_ID);
  renderOfferCommercialTab(document.getElementById('offer-tab-content'), data.offer);
};

// Plain Unit dropdown over the Admin-managed 'unit' Offer Field Options; keeps a
// retired/legacy value selectable so editing an old line doesn't silently change it.
function offerUnitSelectHTML(id, options, current) {
  const vals = options.map(o => o.value);
  if (current && !vals.includes(current)) vals.unshift(current);
  return `<select id="${id}">${vals.map(v => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
}
async function renderScopeTab(el, data) {
  const items = data.items;
  const equipmentRefs = data.equipmentReferences || [];
  // Machine Library (Standard offers) vs. Spares Library (Spares offers,
  // 2026-11-01) - the two are never mixed, so only the one the offer's
  // own format actually needs is fetched.
  const isSparesFormat = data.offer.offer_format === 'Spares';
  const sectionTitles = isSparesFormat ? await api('/offers/spares-library').catch(() => []) : await api('/offers/section-titles').catch(() => []);
  window.__SECTION_TITLES = sectionTitles;
  window.__IS_SPARES_OFFER = isSparesFormat;
  // Admin-managed Unit list (Offer Field Options) - Spares lines only.
  const unitOpts = isSparesFormat ? await api('/offers/field-options/unit').catch(() => []) : [];
  const machineTypeOpts = isSparesFormat ? await api('/offers/field-options/spares_machine_type').catch(() => []) : [];
  // Unit of Measurement + flat Discount Amount per line (2026-10-15) -
  // Spares-format offers only, matching the owner's locked scope (a full
  // machinery offer's Scope Of Supply stays exactly as it was). Spares mode
  // also drops the Item Code column here, per the owner's own call that it's
  // redundant with Description once the line is this simple.
  const isSpares = data.offer.offer_format === 'Spares';
  const grandTotal = items.reduce((a, b) => a + Number(b.total_price || 0), 0);
  // Discount/Picture columns only appear at all when at least one line
  // actually has that data (2026-10-15 follow-up) - a column nobody filled
  // in for any line is dead weight on the table, not just a blank cell.
  const hasDiscount = items.some(it => Number(it.discount_amount) > 0);
  const hasPicture = items.some(it => it.image_path);
  // Remarks: same column-level gating as Discount - shown only once some line has one.
  const hasRemarks = items.some(it => it.remarks && String(it.remarks).trim());
  const colsBeforeTaxable = 6 + (hasDiscount ? 1 : 0);
  const totalCols = colsBeforeTaxable + 1 + (hasRemarks ? 1 : 0) + (hasPicture ? 1 : 0) + 1;
  const listTable = isSpares ? `
    <table><thead><tr><th>S.No</th><th>Machine Type</th><th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th>${hasDiscount ? '<th>Discount (₹)</th>' : ''}<th>Taxable</th>${hasRemarks ? '<th>Remarks</th>' : ''}${hasPicture ? '<th>Picture</th>' : ''}<th></th></tr></thead>
    <tbody>${items.map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(it.machine_type) || '-'}</td>
        <td style="white-space:pre-wrap;max-width:260px;">${esc(it.description)}</td>
        <td>${it.qty}</td><td>${esc(it.unit || 'Nos')}</td><td>₹${fmt(it.unit_price)}</td>${hasDiscount ? `<td>${it.discount_amount ? '₹' + fmt(it.discount_amount) : ''}</td>` : ''}<td>₹${fmt(it.total_price)}</td>
        ${hasRemarks ? `<td style="white-space:pre-wrap;max-width:160px;">${esc(it.remarks)}</td>` : ''}
        ${hasPicture ? `<td>${it.image_path ? `<img src="${it.image_path}" style="max-width:60px;max-height:60px;">` : ''}</td>` : ''}
        <td>${actionButtonsCell(`
          <button class="btn small outline" onclick="moveOfferItem(${it.id},'up')" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small outline" onclick="moveOfferItem(${it.id},'down')" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn small" onclick="editOfferItem(${it.id})">Edit</button>
          <button class="btn small red" onclick="deleteOfferItem(${it.id})">Delete</button>
        `)}</td>
      </tr>`).join('') || `<tr><td colspan="${totalCols}" class="empty">No items yet.</td></tr>`}
    <tr><td colspan="${colsBeforeTaxable}" class="right"><b>Grand Total</b></td><td colspan="${totalCols - colsBeforeTaxable}"><b>₹${fmt(grandTotal)}</b></td></tr>
    </tbody></table>` : `
    <table><thead><tr><th>Item</th><th>Section</th><th>Description</th><th>Picture</th><th>Qty</th><th>Unit Price</th><th>Total</th><th></th></tr></thead>
    <tbody>${items.map((it, i) => `
      <tr>
        <td>${esc(it.item_code)}</td>
        <td>${esc(it.section_title)}</td>
        <td style="white-space:pre-wrap;max-width:220px;">${esc(it.description)}</td>
        <td>${it.image_path ? `<img src="${it.image_path}" style="max-width:60px;max-height:60px;">` : '-'}</td>
        <td>${it.qty}</td><td>₹${fmt(it.unit_price)}</td><td>₹${fmt(it.total_price)}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" onclick="moveOfferItem(${it.id},'up')" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small outline" onclick="moveOfferItem(${it.id},'down')" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn small" onclick="editOfferItem(${it.id})">Edit</button>
          <button class="btn small red" onclick="deleteOfferItem(${it.id})">Delete</button>
        `)}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">No items yet.</td></tr>'}
    <tr><td colspan="6" class="right"><b>Grand Total</b></td><td colspan="2"><b>₹${fmt(grandTotal)}</b></td></tr>
    </tbody></table>`;
  el.innerHTML = `
    ${listTable}
    <h4 id="it-form-title">Add Machinery / Scope Line</h4>
    <div class="form-grid">
      <div><label>Item Code</label><input id="it-code" placeholder="A / B / C"></div>
      <div><label>${isSpares ? 'Spares Library' : 'Section Title (from library)'}</label><select id="it-section-select" onchange="applySectionTitleTemplate()"><option value="">- type a new one below -</option>${sectionTitles.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select></div>
      <div><label>Or type a new Section Title</label><input id="it-section" placeholder="e.g. Electronic Net Weighing And Bagging System"></div>
      <div><label>Qty</label><input id="it-qty" type="number" value="1"></div>
      <div><label>Unit Price (₹)</label><input id="it-price" type="number" value="0"></div>
      ${isSpares ? `<div><label>Machine Type</label>${offerFieldSelect('it-mtype', machineTypeOpts, '').replace('-- Select --', 'Select Machine Type...')}</div>
      <div><label>Unit</label>${unitOpts.length ? offerUnitSelectHTML('it-unit', unitOpts, 'Nos') : unitPickerHTML('it-unit', 'Nos', null)}</div>
      <div><label>Discount Amount (₹)</label><input id="it-discount" type="number" value="0"></div>
      <div><label>Remarks <span class="muted">(printed only if filled)</span></label><input id="it-remarks" maxlength="300"></div>` : ''}
      <div><label>Picture (optional, overrides the library picture)</label><input id="it-image" type="file" accept="image/*"></div>
    </div>
    <div id="it-image-preview" style="margin:6px 0;"></div>
    <label>Description</label>
    <textarea id="it-desc" rows="3" style="width:90%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
    <label>Equipment Description Summary <span class="muted">(shown next to the picture on the PDF's Equipment Description page - optional)</span></label>
    <textarea id="it-summary" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
    <div class="hig-savebar">
      <button class="btn" id="it-submit-btn" onclick="addOfferItem()">Add Line</button>
      <button class="btn outline" id="it-cancel-btn" onclick="cancelEditOfferItem()" style="display:none;">Cancel</button>
    </div>
  `;
}
async function renderEquipmentReferenceTab(el, data) {
  const equipmentRefs = data.equipmentReferences || [];
  const sectionTitles = await api('/offers/section-titles').catch(() => []);
  window.__SECTION_TITLES = sectionTitles;
  el.innerHTML = `
    <p class="muted">Shows a library item's picture and summary on the PDF's Equipment Description page for the customer's reference - not priced, not part of Scope of Supply. Use this for a related product the customer would recognize even though it isn't being quoted here.</p>
    <table><thead><tr><th>Picture</th><th>Title</th><th>Summary</th><th></th></tr></thead>
    <tbody>${equipmentRefs.map((r, i) => `
      <tr>
        <td>${r.image_path ? `<img src="${r.image_path}" style="max-width:60px;max-height:60px;">` : '-'}</td>
        <td>${esc(r.title)}</td>
        <td style="white-space:pre-wrap;max-width:260px;">${esc(r.summary)||'-'}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" onclick="moveEquipmentReference(${r.id},'up')" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small outline" onclick="moveEquipmentReference(${r.id},'down')" ${i === equipmentRefs.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn small red" onclick="deleteEquipmentReference(${r.id})">Remove</button>
        `)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">No reference equipment added.</td></tr>'}
    </tbody></table>
    <div class="form-grid" style="margin-top:8px;">
      <div><label>Add from library</label><select id="eqref-select"><option value="">- Select a library entry -</option>${sectionTitles.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select></div>
    </div>
    <button class="btn small outline" type="button" onclick="addEquipmentReference()">Add Reference</button>
  `;
}
window.addEquipmentReference = async () => {
  const id = val('eqref-select');
  if (!id) return;
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const r = await api(`/offers/${CURRENT_OFFER_ID}/equipment-references`, { method: 'POST', body: JSON.stringify({ section_title_library_id: id, revision_reason: reason || null }) });
    await afterOfferMutation(r);
  } catch (e) { alert(e.message); }
};
window.moveEquipmentReference = async (refId, direction) => {
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const r = await api(`/offers/${CURRENT_OFFER_ID}/equipment-references/${refId}/move`, { method: 'POST', body: JSON.stringify({ direction, revision_reason: reason || null }) });
    await afterOfferMutation(r);
  } catch (e) { alert(e.message); }
};
window.deleteEquipmentReference = async (refId) => {
  if (!confirm('Remove this reference equipment entry?')) return;
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const r = await api(`/offers/${CURRENT_OFFER_ID}/equipment-references/${refId}`, { method: 'DELETE', body: JSON.stringify({ revision_reason: reason || null }) });
    await afterOfferMutation(r);
  } catch (e) { alert(e.message); }
};
window.applySectionTitleTemplate = () => {
  const id = val('it-section-select');
  const preview = document.getElementById('it-image-preview');
  if (!id) { preview.innerHTML = ''; return; }
  const lib = (window.__SECTION_TITLES || []).find(s => s.id === Number(id));
  if (!lib) return;
  document.getElementById('it-section').value = lib.title;
  document.getElementById('it-desc').value = lib.description || '';
  document.getElementById('it-summary').value = lib.summary || '';
  setOfferMachineType(lib.machine_type);
  // Spares Library entries also carry a default rate/unit - pre-fill those
  // too (Machine Library entries have neither, so this is a no-op there).
  if (window.__IS_SPARES_OFFER) {
    if (lib.rate != null && document.getElementById('it-price')) document.getElementById('it-price').value = lib.rate;
    const unitSel = document.getElementById('it-unit');
    if (lib.unit && unitSel) {
      const opt = Array.from(unitSel.options).find(o => o.value === lib.unit);
      if (opt) { unitSel.value = lib.unit; window.toggleUnitOther && window.toggleUnitOther('it-unit'); }
      else if (document.getElementById('it-unit-other')) {
        unitSel.value = 'Other';
        document.getElementById('it-unit-other').value = lib.unit;
        window.toggleUnitOther('it-unit');
      }
    }
  }
  preview.innerHTML = lib.image_path ? `<img src="${esc(lib.image_path)}" style="max-height:80px;max-width:140px;"> <span class="muted">Library picture - will be used unless you upload your own above.</span>` : '';
};
// Keeps a retired/legacy value selectable (same rule as offerFieldSelect); blank library value leaves the pick alone.
function setOfferMachineType(v) {
  const sel = document.getElementById('it-mtype');
  if (!sel || !v) return;
  if (![...sel.options].some(o => o.value === v)) sel.add(new Option(v, v));
  sel.value = v;
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
  document.getElementById('it-summary').value = it.summary || '';
  document.getElementById('it-qty').value = it.qty;
  document.getElementById('it-price').value = it.unit_price;
  // Unit/Discount Amount only exist on the form in Spares mode (see
  // renderScopeTab) - the unit picker's <select>/Other-input pair has to be
  // populated after the fact here since it's a static, already-rendered
  // picker, not rebuilt per edit (same reasoning as every other "fill an
  // existing form" editXxx function in this file).
  const unitSel = document.getElementById('it-unit');
  if (unitSel && !document.getElementById('it-unit-other')) {
    // Managed-list <select> (no Other... box) - add a legacy value if needed.
    if (it.unit && ![...unitSel.options].some(o => o.value === it.unit)) unitSel.add(new Option(it.unit, it.unit));
    unitSel.value = it.unit || 'Nos';
  } else if (unitSel) {
    const isPreset = PO_UNIT_PRESETS.includes(it.unit);
    unitSel.value = isPreset ? (it.unit || 'Nos') : 'Other';
    toggleUnitOther('it-unit');
    if (!isPreset) document.getElementById('it-unit-other').value = it.unit || '';
  }
  if (document.getElementById('it-mtype')) { document.getElementById('it-mtype').value = ''; setOfferMachineType(it.machine_type); }
  const discountEl = document.getElementById('it-discount');
  if (discountEl) discountEl.value = it.discount_amount || 0;
  const remarksEl = document.getElementById('it-remarks');
  if (remarksEl) remarksEl.value = it.remarks || '';
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
    if (document.getElementById('it-unit')) fd.append('unit', unitPickerValue('it-unit'));
    if (document.getElementById('it-mtype')) fd.append('machine_type', val('it-mtype'));
    if (document.getElementById('it-discount')) fd.append('discount_amount', val('it-discount'));
    if (document.getElementById('it-remarks')) fd.append('remarks', val('it-remarks'));
    fd.append('revision_reason', reason || '');
    if (val('it-section-select')) fd.append(window.__IS_SPARES_OFFER ? 'spares_library_id' : 'section_title_id', val('it-section-select'));
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
window.moveOfferItem = async (itemId, direction) => {
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const r = await api(`/offers/${CURRENT_OFFER_ID}/items/${itemId}/move`, { method: 'POST', body: JSON.stringify({ direction, revision_reason: reason || null }) });
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

function renderKvTab(el, rows, keyField, valField, endpoint, keyLabel, valLabel, library, disabled, flag) {
  // `library` (offer_clause_library rows, category 'term') is only passed
  // for the Terms & Conditions tab - tech-specs/bought-out have no library
  // and keep the plain "+ Add Row" behavior. When Offer Governance's
  // "require library clauses" is on and this user isn't Admin, the free-
  // text "+ Add Row" is hidden so a NEW row can only come from the library;
  // rows already on the offer stay fully editable/removable either way.
  const hasLibrary = library !== undefined;
  const strict = hasLibrary && OFFER_REQUIRE_LIBRARY_CLAUSES && ME.role !== 'Admin';
  // `flag` ({id, field, label, checked}) is only passed for tabs that have a
  // matching "Include in generated PDF" toggle (tech-specs/bought-out) - the
  // Terms tab has none. `disabled` mirrors the flag's last-saved server value.
  el.innerHTML = `
    ${flag ? `<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px 10px;background:#f5f5f5;border-radius:6px;font-weight:600;">
      <input id="${flag.id}" type="checkbox" ${flag.checked ? 'checked' : ''}> Include ${esc(flag.label)} in generated PDF
    </label>` : ''}
    ${disabled ? `<div style="background:#f5f5f5;border-radius:6px;padding:10px;margin-bottom:10px;font-style:italic;color:var(--muted);">This section is currently excluded from the generated PDF. You can still add and edit rows here - tick the box above and click Save to include it.</div>` : ''}
    <table><thead><tr><th>${keyLabel}</th><th>${valLabel}</th><th></th></tr></thead>
    <tbody id="kv-rows">${rows.map((r, i) => `
      <tr data-i="${i}">
        <td><input class="kv-key" value="${esc(r[keyField])}" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
        <td><textarea class="kv-val" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;white-space:pre-wrap;resize:vertical;">${esc(r[valField])}</textarea></td>
        <td><button class="btn small red" onclick="this.closest('tr').remove()">Remove</button></td>
      </tr>`).join('')}</tbody></table>
    ${hasLibrary ? `<div style="margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <select id="kv-lib-pick" style="border:1px solid var(--border);border-radius:4px;padding:5px;">
        <option value="">${library.length ? 'Pick a clause from the library...' : 'No library clauses defined yet'}</option>
        ${library.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}
      </select>
      <button class="btn small outline" onclick="addKvRowFromLibrary()">+ Add From Library</button>
    </div>` : '' }
    <div class="hig-savebar">
    ${!strict ? `<button class="btn small outline" onclick="addKvRow()">+ Add Row</button>` : ''}
    <button class="btn" onclick="saveKvTab('${endpoint}', '${keyField}', '${valField}'${flag ? `, '${flag.field}', '${flag.id}'` : ''})">Save</button>
    </div>
  `;
  if (hasLibrary) el.dataset.library = JSON.stringify(library);
}
window.addKvRow = () => {
  const tbody = document.getElementById('kv-rows');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="kv-key" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
    <td><textarea class="kv-val" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;white-space:pre-wrap;resize:vertical;"></textarea></td>
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
    <td><textarea class="kv-val" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;white-space:pre-wrap;resize:vertical;">${esc(picked.body)}</textarea></td>
    <td><button class="btn small red" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
  select.value = '';
};
window.saveKvTab = async (endpoint, keyField, valField, flagField, flagCheckboxId) => {
  const rows = Array.from(document.querySelectorAll('#kv-rows tr')).map(tr => ({
    [keyField]: tr.querySelector('.kv-key').value,
    [valField]: tr.querySelector('.kv-val').value
  })).filter(r => r[keyField]);
  try {
    const reason = confirmOfferRevision(CURRENT_OFFER);
    if (reason === null) return;
    const body = { rows, revision_reason: reason || null };
    if (flagField) {
      const cb = document.getElementById(flagCheckboxId);
      if (cb) body[flagField] = cb.checked ? 1 : 0;
    }
    const r = await api(`/offers/${CURRENT_OFFER_ID}/${endpoint}`, { method: 'PUT', body: JSON.stringify(body) });
    if (flagCheckboxId) delete OFFER_FLAG_OVERRIDES[flagCheckboxId]; // saved: the server value is authoritative again, not a stale pending override
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
  // `disabled` mirrors renderKvTab's - the checkbox below is off, so this
  // whole tab is excluded from the offer.
  el.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px 10px;background:#f5f5f5;border-radius:6px;font-weight:600;">
      <input id="ob-show-inclexcl" type="checkbox" ${offer.show_inclusions_exclusions !== 0 ? 'checked' : ''}> Include Inclusions / Exclusions / Utilities in generated PDF
    </label>
    ${disabled ? `<div style="background:#f5f5f5;border-radius:6px;padding:10px;margin-bottom:10px;font-style:italic;color:var(--muted);">This section is excluded from the offer - check the box above and click Save to re-enable it.</div>` : ''}` +
    OFFER_TEXT_FIELDS.map(([textareaId, category, label]) => `
    <label style="margin-top:10px;display:block;">${label}</label>
    <textarea id="${textareaId}" rows="${rowsAttr[textareaId]}" ${disabled ? 'disabled' : ''} style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;">${esc(offer[fieldMap[textareaId]])}</textarea>
    ${disabled ? '' : textLibraryPicker(textareaId, category)}
  `).join('') + `<div class="hig-savebar"><button class="btn" onclick="saveTextTab()">Save</button></div>`;
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
      show_tech_specs: data.offer.show_tech_specs,
      show_bought_out: data.offer.show_bought_out,
      show_inclusions_exclusions: offerShowFlag('ob-show-inclexcl', data.offer.show_inclusions_exclusions),
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

// ---- Spares Price Comparison (2026-11-01) ----
// Finance's "what did we quote vs. what did they actually order" review
// before quoting a new spares RFQ - a per-customer lookup plus a QoQ/YoY
// rollup across every customer. See lib/sparesComparison.js for the match
// logic (Spares Library id where available, else a normalized-description
// fallback, flagged `approximate` either way it's rendered here).
let SPARES_TREND_PERIOD = 'quarter';
function sparesApproxNote(row) {
  return row.approximate ? ' <span class="muted" title="Matched by description text, not a Spares Library id or Item Code - may be approximate.">(approx.)</span>' : '';
}
function sparesSourceBadge(row) {
  return row.source === 'annexure'
    ? ' <span class="badge" style="background:#e8f1f8;color:#2f5f8a;" title="Priced on this offer\'s Annexure tab (pasted/uploaded price list), not Scope of Supply.">Annexure</span>'
    : ' <span class="badge" style="background:#f1e6da;color:#8a5a2f;" title="Priced on this offer\'s Scope of Supply tab.">Scope of Supply</span>';
}
function renderSparesPerCustomerTable(rows) {
  if (!rows.length) return '<p class="empty">No spares quote history for this customer yet.</p>';
  return tableHTML(['Spare', 'Source', 'Last Quoted Rate', 'Quoted On', 'Last Ordered Rate', 'Ordered On', 'Quotes', 'Orders'], rows, r => `
    <tr>
      <td>${esc(r.spare)}${sparesApproxNote(r)}</td>
      <td>${sparesSourceBadge(r)}</td>
      <td>₹${fmt(r.last_quoted_rate)}</td>
      <td>${r.last_quoted_date ? fmtDMY(r.last_quoted_date) : '-'}</td>
      <td>${r.last_ordered_rate !== null ? '₹' + fmt(r.last_ordered_rate) : '-'}</td>
      <td>${r.last_ordered_date ? fmtDMY(r.last_ordered_date) : '-'}</td>
      <td>${r.quote_count}</td>
      <td>${r.order_count}</td>
    </tr>`);
}
function renderSparesSearchTable(rows) {
  if (!rows.length) return '<p class="empty">No matching spare found in any customer\'s quote history.</p>';
  return tableHTML(['Customer', 'Spare', 'Source', 'Last Quoted Rate', 'Quoted On', 'Last Ordered Rate', 'Ordered On', 'Quotes', 'Orders'], rows, r => `
    <tr>
      <td>${esc(r.client_name)}</td>
      <td>${esc(r.spare)}${sparesApproxNote(r)}</td>
      <td>${sparesSourceBadge(r)}</td>
      <td>₹${fmt(r.last_quoted_rate)}</td>
      <td>${r.last_quoted_date ? fmtDMY(r.last_quoted_date) : '-'}</td>
      <td>${r.last_ordered_rate !== null ? '₹' + fmt(r.last_ordered_rate) : '-'}</td>
      <td>${r.last_ordered_date ? fmtDMY(r.last_ordered_date) : '-'}</td>
      <td>${r.quote_count}</td>
      <td>${r.order_count}</td>
    </tr>`);
}
window.searchSparesByName = async () => {
  const q = val('spc-search-q').trim();
  const wrap = document.getElementById('spc-search-wrap');
  if (!q) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<p class="muted">Searching...</p>';
  try {
    const rows = await api('/offers/spares-comparison/search?q=' + encodeURIComponent(q));
    wrap.innerHTML = renderSparesSearchTable(rows);
  } catch (e) { wrap.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
};
let SPARES_SEARCH_TIMER = null;
window.debouncedSearchSpares = () => {
  if (SPARES_SEARCH_TIMER) clearTimeout(SPARES_SEARCH_TIMER);
  SPARES_SEARCH_TIMER = setTimeout(window.searchSparesByName, 350);
};
window.loadSparesPerCustomer = async () => {
  const clientId = val('spc-client');
  const wrap = document.getElementById('spc-customer-wrap');
  if (!clientId) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const rows = await api('/offers/spares-comparison/customer/' + clientId);
    wrap.innerHTML = renderSparesPerCustomerTable(rows);
  } catch (e) { wrap.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
};
function groupSparesTrendByPeriod(rows) {
  const byPeriod = new Map();
  rows.forEach(r => {
    if (!byPeriod.has(r.period)) byPeriod.set(r.period, []);
    byPeriod.get(r.period).push(r);
  });
  return Array.from(byPeriod.entries());
}
async function loadSparesTrend() {
  const wrap = document.getElementById('spc-trend-wrap');
  wrap.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const rows = await api('/offers/spares-comparison/trend?period=' + SPARES_TREND_PERIOD);
    if (!rows.length) { wrap.innerHTML = '<p class="empty">No spares quote history yet.</p>'; return; }
    const groups = groupSparesTrendByPeriod(rows);
    wrap.innerHTML = groups.map(([period, periodRows], i) => collapsiblePanel(`spc-trend-period-${i}`, `${esc(period)} (${periodRows.length} spare${periodRows.length === 1 ? '' : 's'})`, `
      ${tableHTML(['Spare', 'Avg Quoted Rate', 'Avg Ordered Rate', 'Quotes', 'Orders'], periodRows, r => `
        <tr>
          <td>${esc(r.spare)}${sparesApproxNote(r)}</td>
          <td>₹${fmt(r.avg_quoted_rate)}</td>
          <td>${r.avg_ordered_rate !== null ? '₹' + fmt(r.avg_ordered_rate) : '-'}</td>
          <td>${r.quote_count}</td>
          <td>${r.order_count}</td>
        </tr>`)}
    `)).join('');
  } catch (e) { wrap.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}
window.switchSparesTrendPeriod = (period) => {
  SPARES_TREND_PERIOD = period;
  document.getElementById('spc-trend-quarter-btn').className = 'btn small' + (period === 'quarter' ? '' : ' outline');
  document.getElementById('spc-trend-year-btn').className = 'btn small' + (period === 'year' ? '' : ' outline');
  loadSparesTrend();
};
PAGES['spares-comparison'] = async (el) => {
  const clients = await api('/masters/clients').catch(() => []);
  el.innerHTML = `
    <div class="panel">
      <h3>Search by Spare Part</h3>
      <p class="muted">Type a spare's name (library title or free-typed description) to see every customer it's ever been quoted/ordered against.</p>
      <div class="form-grid">
        <div><label>Spare Name</label><input id="spc-search-q" placeholder="e.g. Bearing 6205" oninput="debouncedSearchSpares()"></div>
      </div>
      <div id="spc-search-wrap" style="margin-top:10px;"></div>
    </div>
    <div class="panel">
      <h3>Per-Customer: Quoted vs. Ordered</h3>
      <p class="muted">Pick a customer to see, for every spare they've ever been quoted, the last quoted rate against the last rate they actually ordered at.</p>
      <div class="form-grid">
        <div><label>Customer</label>${clientPickerHTML('spc-client', clients, '', 'Select a customer', 'onchange="loadSparesPerCustomer()"')}</div>
      </div>
      <div id="spc-customer-wrap" style="margin-top:10px;"></div>
    </div>
    <div class="panel">
      ${collapsiblePanel('spc-trend', 'QoQ / YoY Trend (all customers)', `
        <p class="muted">Average quoted rate vs. average ordered rate per spare, across every customer, bucketed by period.</p>
        <button class="btn small" id="spc-trend-quarter-btn" onclick="switchSparesTrendPeriod('quarter')">By Quarter</button>
        <button class="btn small outline" id="spc-trend-year-btn" onclick="switchSparesTrendPeriod('year')">By Year</button>
        <div id="spc-trend-wrap" style="margin-top:10px;"></div>
      `)}
    </div>
  `;
  loadSparesTrend();
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

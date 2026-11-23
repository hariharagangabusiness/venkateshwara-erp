// purchase.js - Vendors, Purchase Requests/Orders, RFQ Dashboard, Purchase Velocity, Overdue Items,
// Item Price History, Store & Inventory (Item Master, Stock In/Out, Challans).

// ---- Vendors (Round 5: full GST-compliant Vendor Master) ----
PAGES.vendors = async (el) => {
  const vendors = await api('/masters/vendors');
  const vendorPanels = {};
  vendorPanels['add-vendor'] = `
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
        <div><label>State</label>${statePickerHTML('v-state', '')}</div>
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
    </div>`;
  vendorPanels['bulk-upload'] = `
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per vendor, then upload it here.</p>
      <button class="btn outline" type="button" onclick="downloadVendorTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('ve-upload-file')}
      <button class="btn" onclick="uploadVendorTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="ve-upload-result" style="margin-top:10px;"></div>
    </div>`;
  vendorPanels['list'] = collapsiblePanel('vendors-list', `<span id="ve-count">Vendors (${vendors.length})</span>`, `
      ${renderListSearch('vendors', vendors, ['legal_name', 'name', 'gstin', 'state', 'category', 'contact_person', 'phone', 'po_email', 'email'], (rows) => {
        document.getElementById('ve-table-wrap').innerHTML = renderVendorRows(rows);
        document.getElementById('ve-count').textContent = 'Vendors (' + rows.length + ')';
      }, 'Search by name, GSTIN, state, category, contact...')}
      <div id="ve-table-wrap">${renderVendorRows(vendors)}</div>
    `);
  const vendorLabels = { 'add-vendor': 'Add Vendor', 'bulk-upload': 'Bulk Upload via Excel Template', 'list': 'Vendors List' };
  const vendorOrder = await fetchPanelOrder('vendors', Object.keys(vendorPanels));
  el.innerHTML = reorderablePanelsHTML('vendors', vendorPanels, vendorOrder, vendorLabels);
  window.__VENDOR_CACHE = vendors;
};
function renderVendorRows(rows) {
  return tableHTML(['Name', 'GSTIN', 'State', 'Category', 'Contact', 'Phone', 'PO Email', 'Terms', 'Status', ''], rows, v => `<tr>
    <td>${esc(v.legal_name || v.name)}</td><td>${esc(v.gstin)||'-'}</td><td>${esc(v.state)||'-'}</td><td>${esc(v.category)||'-'}</td>
    <td>${esc(v.contact_person)||'-'}</td><td>${esc(v.phone)||'-'}</td><td>${esc(v.po_email||v.email)||'-'}</td>
    <td>${esc(v.payment_terms)||'-'}</td><td>${badge(v.status||'Active')}</td>
    <td>${actionButtonsCell(`<button class="btn small outline" type="button" onclick="openEditVendor(${v.id})">Edit</button>
    <button class="btn small outline" type="button" onclick="openVendorLedger(${v.id},'${esc(v.legal_name||v.name).replace(/'/g,"\\'")}')">Ledger</button>
    <button class="btn small outline" type="button" onclick="deleteVendor(${v.id})">Delete</button>`)}</td></tr>`);
}
// Vendor Ledger (2026-10-13) - Purchase Invoices (debit) vs payments/vendor
// credit notes (credit), mirroring the client Statement of Accounts - see
// lib/vendorLedger.js. Uses the generic popup (openAppModal, introduced for
// Service Request Edit/Schedule) rather than a new standalone page, same
// "no standalone ledger page for clients either - it lives on an existing
// screen" precedent soaSectionHTML already set for Client 360.
window.openVendorLedger = async (vendorId, vendorName) => {
  openAppModal('Vendor Ledger — ' + esc(vendorName), '<p class="muted">Loading...</p>');
  await loadVendorLedgerInto(vendorId, vendorName, '', '');
};
window.loadVendorLedgerInto = async (vendorId, vendorName, from, to) => {
  const body = document.getElementById('app-modal-body');
  if (!body) return;
  try {
    const q = (from ? '?from=' + from + (to ? '&to=' + to : '') : (to ? '?to=' + to : ''));
    const ledger = await api('/finance/vendor-ledger/' + vendorId + q);
    const rows = ledger.rows || [];
    body.innerHTML = `
      <div class="form-grid">
        <div><label>From</label><input id="vl-from" type="date" value="${esc(from)}"></div>
        <div><label>To</label><input id="vl-to" type="date" value="${esc(to)}"></div>
      </div>
      <button class="btn small" type="button" onclick="loadVendorLedgerInto(${vendorId},'${esc(vendorName).replace(/'/g,"\\'")}',val('vl-from'),val('vl-to'))" style="margin:6px 0;">Apply</button>
      <button class="btn small outline" type="button" onclick="downloadTemplateFile('/finance/vendor-ledger/${vendorId}/pdf'+(val('vl-from')?'?from='+val('vl-from')+(val('vl-to')?'&to='+val('vl-to'):''):(val('vl-to')?'?to='+val('vl-to'):'')),'Vendor-Ledger-${vendorId}.pdf')">Download PDF</button>
      ${tableHTML(['Date', 'Type', 'Reference', 'Description', 'Debit (₹)', 'Credit (₹)', 'Balance (₹)'],
        [{ _opening: true }, ...rows], r => r._opening
          ? `<tr><td colspan="6" style="text-align:right;"><b>Opening Balance</b></td><td><b>₹${fmt(ledger.openingBalance)}</b></td></tr>`
          : `<tr><td>${esc(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.ref)}</td><td>${esc(r.description)}</td>
             <td>${r.debit ? '₹' + fmt(r.debit) : '-'}</td><td>${r.credit ? '₹' + fmt(r.credit) : '-'}</td><td>₹${fmt(r.balance)}</td></tr>`)}
      <p style="text-align:right;margin-top:8px;">
        <b>Total Debit:</b> ₹${fmt(ledger.totalDebit)} &nbsp; <b>Total Credit:</b> ₹${fmt(ledger.totalCredit)} &nbsp;
        <b>Closing Balance:</b> ₹${fmt(Math.abs(ledger.closingBalance))} ${ledger.closingBalance !== 0 ? (ledger.closingBalance > 0 ? '(Payable)' : '(In Credit)') : ''}
      </p>
    `;
  } catch (e) { body.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
};
// Edit Vendor (2026-10-13: converted from a bottom-of-page scroll-to panel
// to the generic popup) - openAppModal() centers the form right where the
// click happened instead of relocating attention elsewhere on the page,
// and confirmSavedThenClose() shows a visible "Saved" state on the button
// before the modal closes and the list refreshes.
window.openEditVendor = (id) => {
  const v = (window.__VENDOR_CACHE || []).find(x => x.id === id);
  if (!v) return;
  openAppModal('Edit Vendor — ' + esc(v.legal_name || v.name), `
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
      <div><label>State</label>${statePickerHTML('ve-state', v.state)}</div>
      <div><label>State Code</label><input id="ve-state-code" value="${esc(v.state_code)}" maxlength="2"></div>
      <div><label>Pincode</label><input id="ve-pincode" value="${esc(v.pincode)}"></div>
      <div><label>Contact Person</label><input id="ve-contact" value="${esc(v.contact_person)}"></div>
      <div><label>Phone</label><input id="ve-phone" value="${esc(v.phone)}"></div>
      <div><label>Email</label><input id="ve-email" value="${esc(v.email)}"></div>
      <div><label>PO / Document Delivery Email</label><input id="ve-po-email" value="${esc(v.po_email)}"></div>
      <div><label>Payment Terms</label><input id="ve-terms" value="${esc(v.payment_terms)}"></div>
      <div><label>Payment Terms (Days)</label><input id="ve-terms-days" type="number" value="${v.payment_terms_days||0}"></div>
    </div>
    <button class="btn" id="ve-edit-save-btn" onclick="saveEditVendor(${id})">Save Changes</button>
    <div id="ve-edit-err" class="msg err" style="display:none;margin-top:8px;"></div>`);
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
    confirmSavedThenClose('ve-edit-save-btn', 'vendors');
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
const PR_STATUS_ORDER = ['Draft', 'PendingQuotes', 'Pending', 'InfoRequested', 'Approved', 'OrderPlaced', 'Received', 'Rejected', 'Cancelled'];
const PR_STATUS_LABELS = { PendingQuotes: 'Pending Quotes', Pending: 'Pending Approval', InfoRequested: 'Info Requested', OrderPlaced: 'Order Placed' };
window.refreshPRList = () => {
  const box = document.getElementById('pr-table-wrap');
  const q = box && box.parentElement.querySelector('.list-search');
  filterList('purchase-requests', q ? q.value : '');
};
let PR_LINES = [{ item_id: '', item_text: '', quantity: 1, estimated_value: 0 }];
PAGES['purchase-requests'] = async (el) => {
  // All 6 of these are independent reads - fired together (rather than one
  // `await` after another) so the page's total load time is the slowest of
  // them, not their sum. Panel keys are static, so fetchPanelOrder's layout
  // read doesn't need to wait for the panels themselves to be built.
  const [reqs, items, projects, thresholdSetting, rfqInbox, unitOpts, prOrder] = await Promise.all([
    api('/purchase/requests'),
    api('/masters/items'),
    api('/projects'),
    api('/settings/purchase-quote-threshold'),
    api('/purchase/rfq-inbox').catch(() => []),
    api('/offers/field-options/unit').catch(() => []),
    fetchPanelOrder('purchase-requests', ['rfq-inbox', 'new-request', 'list']),
  ]);
  const threshold = thresholdSetting.quote_threshold;
  window.__PR_THRESHOLD = threshold;
  window.__PR_ITEMS = items; window.__PR_PROJECTS = projects;
  window.__RFQ_INBOX = rfqInbox; window.__UNIT_OPTS = unitOpts;
  PR_LINES = [{ item_id: '', item_text: '', quantity: 1, estimated_value: 0 }];
  const prPanels = {
    'rfq-inbox': collapsiblePanel('rfq-inbox-panel', `Vendor Quote Responses (Email) (${rfqInbox.length})`, `
      <p class="muted">Parsed from the Purchase inbox - nothing here is a real quote yet. Review the details below and either confirm it into a real quote (editable first) or dismiss it.</p>
      ${ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="scanRfqMailNow()">Scan Mailbox Now</button> <span id="rfq-scan-result" class="muted" style="margin-left:8px;"></span>` : ''}
      ${rfqInbox.length ? rfqInbox.map(i => `
        <div class="box" style="border:1px solid var(--border,#ccc);border-radius:6px;padding:10px;margin-bottom:10px;">
          <p style="margin:0 0 4px;"><b>${esc(i.from_name)||esc(i.from_address)}</b> &lt;${esc(i.from_address)}&gt; &middot; <span class="muted">${i.received_at ? new Date(i.received_at).toLocaleString() : '-'}</span></p>
          <p style="margin:0 0 4px;"><b>Subject:</b> ${esc(i.subject)||'-'}</p>
          <p style="margin:0 0 4px;"><b>Matched RFQ:</b> ${i.matched_rfq_request_id ? `${esc(i.purchase_request_no)||'-'} - ${esc(i.rfq_subject)||'-'}` : '<span class="muted">No match found - pick manually below</span>'}
            ${i.match_confidence ? ` <span class="badge ${i.match_confidence === 'ThreadMatch' ? 'active' : 'Draft'}">${esc(i.match_confidence)}</span>` : ''}</p>
          <p style="margin:0 0 4px;"><b>Matched Vendor:</b> ${esc(i.matched_vendor_name)||'<span class="muted">None - pick manually below</span>'}${i.guessed_quoted_amount ? ` &middot; Guessed amount: ₹${fmt(i.guessed_quoted_amount)}` : ''}</p>
          <details style="margin:6px 0;"><summary class="muted" style="cursor:pointer;">Full email text</summary><pre style="white-space:pre-wrap;font-family:inherit;margin:6px 0 0;">${esc(i.body_text)||'-'}</pre></details>
          <div style="margin-top:8px;"><button class="btn small" onclick="openConfirmRfqResponse(${i.id})">Confirm as Quote</button> <button class="btn small outline" onclick="dismissRfqResponse(${i.id})">Dismiss</button></div>
          <div id="rfq-inbox-confirm-${i.id}"></div>
        </div>`).join('') : '<div class="empty">No pending vendor responses.</div>'}
    `),
    'new-request': collapsiblePanel('new-purchase-request', 'New Purchase Request', `
      <div class="form-grid">
        <div class="stock-input-group"><label>Project (optional)</label>${projectPickerHTML('pr-project', projects, '')}</div>
      </div>
      <div id="pr-lines"></div>
      <button class="btn small outline" type="button" onclick="addPRLine()">+ Add Line Item</button>
      <div id="pr-vendor-suggestions" class="panel" style="display:none;"></div>
      <button class="btn" onclick="addPR()">Save as Draft</button>
      <div id="pr-err" class="msg err" style="display:none;"></div>
      <p class="muted">Picking from the master is optional — type a new item name if it isn't there yet. It goes to Store & Inventory → Item Master as <b>Pending</b> for review, and becomes a permanent master item once Store approves it (usually while receiving the goods).<br>
      Project is optional too — leave it as "General / Not Project-Specific" for stock replenishment, consumables, or any other purchase that isn't tied to a particular project.<br>
      This saves the request as a <b>Draft</b> below, not submitted yet — review or edit it there, then click <b>Submit for Approval</b> when it's ready. It then goes to the Purchase HOD/Supervisor first; above the configured threshold it also needs Management sign-off (see Admin → Approval Matrix).<br>
      Requests with a combined value of ₹${fmt(threshold)} or above will need at least 2 vendor quotes on file before they can be submitted for approval.</p>
    `),
    'list': collapsiblePanel('purchase-requests-list', `<span id="pr-count">Purchase Requests (${reqs.length})</span>`, `
      <p class="muted">A new request starts as a <b>Draft</b> — click Edit to review/change the items, project, quantities or values, then <b>Submit for Approval</b> when ready. A Pending request can still be edited up to the point it's approved.</p>
      ${renderListSearch('purchase-requests', reqs, ['pr_no', 'item_summary', 'project_code', 'status'], (rows) => {
        // layered on top of the text search: status filter, then sort
        const st = (document.getElementById('pr-status-filter') || {}).value || '';
        const sort = (document.getElementById('pr-sort') || {}).value || 'newest';
        rows = (st ? rows.filter(r => r.status === st) : rows).slice();
        const num = r => String(r.created_at || '') + String(r.id).padStart(9, '0');
        const cmp = {
          newest: (a, b) => num(b).localeCompare(num(a)),
          oldest: (a, b) => num(a).localeCompare(num(b)),
          status: (a, b) => (PR_STATUS_ORDER.indexOf(a.status) - PR_STATUS_ORDER.indexOf(b.status)) || num(b).localeCompare(num(a)),
          status_az: (a, b) => String(a.status).localeCompare(String(b.status)) || num(b).localeCompare(num(a)),
          pr_no: (a, b) => String(a.pr_no).localeCompare(String(b.pr_no)),
        }[sort];
        rows.sort(cmp);
        document.getElementById('pr-table-wrap').innerHTML = renderPRRows(rows);
        document.getElementById('pr-count').textContent = 'Purchase Requests (' + rows.length + ')';
      }, 'Search by PR no, item, project, status...')}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <label style="font-size:12px;">Status <select id="pr-status-filter" onchange="refreshPRList()"><option value="">All</option>${PR_STATUS_ORDER.map(x => `<option value="${x}">${esc(PR_STATUS_LABELS[x] || x)}</option>`).join('')}</select></label>
        <label style="font-size:12px;">Sort by <select id="pr-sort" onchange="refreshPRList()">
          <option value="newest">Newest First</option><option value="oldest">Oldest First</option>
          <option value="status">Status (workflow order)</option><option value="status_az">Status A→Z</option><option value="pr_no">PR No</option></select></label>
      </div>
      <div id="pr-table-wrap">${renderPRRows(reqs)}</div>
    `),
  };
  const prLabels = { 'rfq-inbox': 'Vendor Quote Responses (Email)', 'new-request': 'New Purchase Request', 'list': 'Purchase Requests List' };
  el.innerHTML = reorderablePanelsHTML('purchase-requests', prPanels, prOrder, prLabels);
  if (items.length === 0) el.querySelector('.panel').insertAdjacentHTML('afterbegin', `<div class="msg err">No items defined yet — add items via Store page first.</div>`);
  renderPRLines();
  window.__PR_CACHE = reqs;
};
window.scanRfqMailNow = async () => {
  const resultEl = document.getElementById('rfq-scan-result');
  resultEl.textContent = 'Scanning...';
  try {
    const r = await api('/purchase/rfq-inbox/scan', { method: 'POST' });
    if (!r.ran) { resultEl.textContent = r.reason || 'Scan did not run.'; return; }
    resultEl.textContent = `Done: ${r.stored} new, ${r.skipped} already seen, ${r.failed} failed.`;
    if (r.stored) navigate('purchase-requests');
  } catch (e) { resultEl.textContent = e.message; }
};
window.openConfirmRfqResponse = async (id) => {
  const item = (window.__RFQ_INBOX || []).find(i => i.id === id);
  if (!item) return;
  const [vendors, openRfqs] = await Promise.all([api('/masters/vendors'), api('/purchase/rfq-inbox/open-rfqs')]);
  const wrap = document.getElementById(`rfq-inbox-confirm-${id}`);
  wrap.innerHTML = `
    <div class="form-grid">
      <div><label>RFQ</label><select id="ri-rfq-${id}">
        <option value="">- Select the RFQ this reply belongs to -</option>
        ${openRfqs.map(r => `<option value="${r.id}" ${item.matched_rfq_request_id===r.id?'selected':''}>${esc(r.purchase_request_no)||'-'} - ${esc(r.subject)}</option>`).join('')}
      </select></div>
      <div><label>Vendor</label><select id="ri-vendor-${id}">
        <option value="">- Select vendor -</option>
        ${vendors.map(v => `<option value="${v.id}" ${item.matched_vendor_id===v.id?'selected':''}>${esc(v.name)}</option>`).join('')}
      </select></div>
      <div><label>Quoted Amount (₹)</label><input id="ri-amount-${id}" type="number" value="${item.guessed_quoted_amount ?? ''}"></div>
      <div><label>Quoted Qty</label><input id="ri-qty-${id}" type="number"></div>
      <div><label>Payment Terms</label><input id="ri-terms-${id}"></div>
      <div><label>Delivery Commit Date</label><input id="ri-delivery-${id}" type="date"></div>
    </div>
    <div><label>Notes</label><textarea id="ri-notes-${id}" rows="2">${esc(item.body_text)}</textarea></div>
    <button class="btn small" onclick="saveConfirmRfqResponse(${id})">Save as Quote</button>
    <button class="btn small outline" type="button" onclick="document.getElementById('rfq-inbox-confirm-${id}').innerHTML=''">Cancel</button>
    <div id="ri-err-${id}" class="msg err" style="display:none;"></div>`;
};
window.saveConfirmRfqResponse = async (id) => {
  const errEl = document.getElementById(`ri-err-${id}`);
  errEl.style.display = 'none';
  try {
    await api(`/purchase/rfq-inbox/${id}/confirm`, { method: 'POST', body: JSON.stringify({
      rfq_request_id: val(`ri-rfq-${id}`) || undefined, vendor_id: val(`ri-vendor-${id}`) || undefined,
      quoted_amount: val(`ri-amount-${id}`), quoted_qty: val(`ri-qty-${id}`),
      payment_terms: val(`ri-terms-${id}`), delivery_commit_date: val(`ri-delivery-${id}`), notes: val(`ri-notes-${id}`),
    })});
    navigate('purchase-requests');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.dismissRfqResponse = async (id) => {
  const reason = prompt('Reason for dismissing this vendor response (optional):');
  if (reason === null) return;
  try {
    await api(`/purchase/rfq-inbox/${id}/dismiss`, { method: 'POST', body: JSON.stringify({ reason }) });
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};
function prItemOptions(selectedId, itemsOverride) {
  const items = itemsOverride || window.__PR_ITEMS || [];
  return `<option value="">- type a new item instead -</option>${items.filter(i=>!['Pending','Discontinued'].includes(i.status))
    .map(i => `<option value="${i.id}" ${i.id===selectedId?'selected':''}>${esc(i.name)} (Stock: ${fmt(Number(i.current_stock) || 0)} ${esc(i.unit||'')})</option>`).join('')}`;
}
// A native <option> can only be colored as a whole - there's no way to
// color just the stock figure inside it while leaving the item name its
// normal color - so the dropdown list itself stays plain text, and this
// renders a small, separately-colored "Stock: N unit" readout next to the
// picker for whichever item is currently selected (green if available, red
// if zero), updated live on every change via badgeElId's onchange wiring.
function prStockBadgeHTML(badgeId, items, selectedId) {
  const it = items.find(x => x.id === Number(selectedId));
  if (!it) return `<span id="${badgeId}"></span>`;
  const stock = Number(it.current_stock) || 0;
  const color = stock > 0 ? '#1a7f37' : '#b42318';
  return `<span id="${badgeId}" style="color:${color};font-weight:600;white-space:nowrap;">Stock: ${fmt(stock)} ${esc(it.unit||'')}</span>`;
}
window.updatePRStockBadge = (badgeId, itemId) => {
  const el = document.getElementById(badgeId);
  if (!el) return;
  const it = (window.__PR_ITEMS || []).find(x => x.id === Number(itemId));
  if (!it) { el.outerHTML = `<span id="${badgeId}"></span>`; return; }
  const stock = Number(it.current_stock) || 0;
  const color = stock > 0 ? '#1a7f37' : '#b42318';
  el.outerHTML = `<span id="${badgeId}" style="color:${color};font-weight:600;white-space:nowrap;">Stock: ${fmt(stock)} ${esc(it.unit||'')}</span>`;
};
// Shared by both New PR (here) and Edit PR (renderEditPRLines below) - same
// 6 columns in both forms.
const PR_LINES_GRID_COLS = 'minmax(220px,1.6fr) minmax(140px,1.2fr) minmax(160px,1.3fr) 80px 100px 120px 44px';
// Unit of Measurement per PR line: the Admin-managed 'unit' Offer Field Options when this user can read
// them, else the PO presets. A line's own unit wins; picking a master item pre-fills that item's unit.
function prUnitSelectHTML(arr, i, current, disabled) {
  const base = (window.__UNIT_OPTS || []).length ? window.__UNIT_OPTS.map(o => o.value) : PO_UNIT_PRESETS;
  const vals = base.includes(current) || !current ? base : [current, ...base];
  const cur = current || 'Nos';
  return `<select id="${arr}-unit-${i}" onchange="${arr}[${i}].unit=this.value" ${disabled ? 'disabled' : ''}>${(vals.includes(cur) ? vals : [cur, ...vals]).map(v => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
}
window.prAutoFillUnit = (arr, i, itemId) => {
  const it = (window.__PR_ITEMS || []).find(x => x.id === Number(itemId));
  if (!it || !it.unit) return;
  (arr === 'PR_LINES' ? PR_LINES : EDIT_PR_LINES)[i].unit = it.unit;
  const sel = document.getElementById(`${arr}-unit-${i}`);
  if (sel) {
    if (!Array.from(sel.options).some(o => o.value === it.unit)) sel.add(new Option(it.unit, it.unit));
    sel.value = it.unit;
  }
};
function renderPRLines() {
  const el = document.getElementById('pr-lines');
  if (!el) return;
  const total = PR_LINES.reduce((s, l) => s + (Number(l.estimated_value) || 0), 0);
  el.innerHTML = gridLineTableHTML(PR_LINES_GRID_COLS, ['Item (pick from master)', 'Additional Details', 'Or type a new item', 'Qty', 'Unit', 'Est. Value (₹)', ''], PR_LINES, (l, i) => `
      <div><div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;">
        <div style="flex:0 0 auto;">${itemPickerHTML(`pr-item-${i}`, window.__PR_ITEMS || [], l.item_id, prItemOptions,
          `onchange="PR_LINES[${i}].item_id=this.value?Number(this.value):'';prAutoFillUnit('PR_LINES',${i},this.value);updatePRStockBadge('pr-stock-${i}',this.value);showVendorsForPRLine(${i})"`)}</div>
        <button class="btn small outline" type="button" style="white-space:nowrap;" onclick="showItemPriceHistory(PR_LINES[${i}].item_id)">Price History</button>
        ${prStockBadgeHTML(`pr-stock-${i}`, window.__PR_ITEMS || [], l.item_id)}
      </div></div>
      <div><input value="${esc(l.details||'')}" placeholder="e.g. grade, size, drawing ref" onchange="PR_LINES[${i}].details=this.value"></div>
      <div><input value="${esc(l.item_text||'')}" placeholder="Not in the master? Type it here" onchange="PR_LINES[${i}].item_text=this.value" ${l.item_id ? 'disabled' : ''}></div>
      <div><input type="number" value="${l.quantity}" onchange="PR_LINES[${i}].quantity=Number(this.value)"></div>
      <div>${prUnitSelectHTML('PR_LINES', i, l.unit, false)}</div>
      <div><input type="number" value="${l.estimated_value}" onchange="PR_LINES[${i}].estimated_value=Number(this.value);renderPRLines()"></div>
      <div>${PR_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="PR_LINES.splice(${i},1);renderPRLines()">✕</button>` : ''}</div>`,
    `<div style="grid-column:span 5;text-align:right;"><b>Total Est. Value</b></div><div><b>₹${fmt(total)}</b></div><div></div>`);
}
window.addPRLine = () => { PR_LINES.push({ item_id: '', item_text: '', quantity: 1, estimated_value: 0, details: '', unit: '' }); renderPRLines(); };
function renderPRRows(rows) {
  return tableHTML(['PR No', 'Item(s)', 'Project', 'Lines', 'Total Est. Value', 'Status', 'Action'], rows, r => `
    <tr id="pr-row-${r.id}">
      <td>${esc(r.pr_no)}</td>
      <td>${esc(r.item_summary)||esc(r.item_name)||'-'}${r.pending_item_count > 0 ? ' <span class="badge Pending" title="Not yet in the approved Item Master">Item pending review</span>' : ''}</td>
      <td>${r.project_code ? esc(r.project_code) : '<span class="muted">General</span>'}</td><td>${r.line_count || 1}</td><td>₹${fmt(r.items_total_value != null ? r.items_total_value : r.estimated_value)}</td><td>${badge(r.status)}</td>
      <td>${actionButtonsCell(`
        ${canEditPR(r) ? `<button class="btn small outline" onclick="openEditPR(${r.id})">Edit</button>` : ''}
        ${r.status === 'Draft' ? `<button class="btn small" type="button" onclick="submitPRForApproval(${r.id})">Submit for Approval</button>` : ''}
        ${r.status === 'Rejected' ? `<button class="btn small outline" type="button" onclick="resubmitPR(${r.id})">Resubmit</button>` : ''}
        ${ME.role === 'Admin' && r.status === 'Pending' && r.approval_id ? `<button class="btn small red" type="button" onclick="adminRejectPR(${r.id})">Reject</button>` : ''}
        ${r.status === 'InfoRequested' ? `<button class="btn small outline" type="button" onclick="provideInfoPR(${r.id})">Provide Info</button>` : ''}
        ${['Draft', 'Pending', 'PendingQuotes', 'InfoRequested', 'Rejected'].includes(r.status) ? `<button class="btn small outline" type="button" onclick="cancelPR(${r.id}, ${r.status === 'Draft'})">${r.status === 'Draft' ? 'Delete' : 'Withdraw'}</button>` : ''}
        <button class="btn small outline" type="button" onclick="togglePRQuotes(${r.id})">Quotes / RFQ</button>
        ${['Approved', 'OrderPlaced'].includes(r.status) ? `<button class="btn small outline" type="button" onclick="repeatPR(${r.id})">Repeat</button>` : ''}
      `)}</td>
    </tr>
    ${r.status === 'Rejected' && r.rejection_reason ? `<tr><td></td><td colspan="6" style="padding-top:0;"><span class="muted" style="font-size:12px;">Rejected${r.rejected_by_name ? ' by ' + esc(r.rejected_by_name) : ''}: ${esc(r.rejection_reason)}</span></td></tr>` : ''}
    ${r.status === 'InfoRequested' && r.info_requested_note ? `<tr><td></td><td colspan="6" style="padding-top:0;"><span class="muted" style="font-size:12px;">More info requested${r.info_requested_by_name ? ' by ' + esc(r.info_requested_by_name) : ''}: ${esc(r.info_requested_note)}</span></td></tr>` : ''}
    <tr id="pr-quotes-row-${r.id}" style="display:none;"><td colspan="7"><div id="pr-quotes-${r.id}"></div></td></tr>`);
}
window.adminRejectPR = async (id) => {
  const r = (window.__PR_CACHE || []).find(x => x.id === id);
  const reason = prompt('Reason for rejecting ' + (r ? r.pr_no : 'this request') + ' (required):');
  if (reason === null) return;
  if (!reason.trim()) return alert('A rejection reason is required.');
  try {
    await api(`/approvals/${r.approval_id}/act`, { method: 'POST', body: JSON.stringify({ action: 'Rejected', comment: reason.trim() }) });
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};
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
// back to Approved there if its only PO is cancelled). A still-Draft PR was
// never actually submitted, so the prompts read "Delete" rather than
// "Withdraw" - same backend route either way (it just flips to Cancelled).
window.cancelPR = async (id, isDraft) => {
  const reason = isDraft ? null : prompt('Reason for withdrawing this request (optional):');
  if (reason === null && !isDraft) return;
  if (!confirm(isDraft ? 'Delete this Draft Purchase Request? This cannot be undone.' : 'Withdraw this Purchase Request? This cannot be undone.')) return;
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
      ? lines.map(l => ({ item_id: l.item_id || '', item_text: l.item_text || '', quantity: l.quantity, estimated_value: l.estimated_value || 0, details: l.details || '', unit: l.unit || l.item_unit || '' }))
      : [{ item_id: r.item_id || '', item_text: '', quantity: r.quantity, estimated_value: r.estimated_value || 0, details: '' }];
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
  // The RFQ composer only appears once the PR is approved; earlier statuses keep just the manual quote grid.
  const rfqAllowed = !!pr && ['Approved', 'OrderPlaced'].includes(pr.status);
  container.innerHTML = `
    <div class="panel">
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
          <td>${actionButtonsCell(`
            ${!q.is_selected ? `<button class="btn small outline" type="button" onclick="selectPRQuote(${prId},${q.id})">Select</button>` : ''}
            <button class="btn small outline" type="button" onclick="deletePRQuote(${prId},${q.id})">Remove</button>
          `)}</td>
        </tr>`)}
      <div class="form-grid">
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
      ${pr && pr.quotes_required ? `<button class="btn" type="button" onclick="submitPRForApproval(${prId})" ${canSubmit ? '' : 'disabled'}>Submit for Approval</button>
      ${!canSubmit && pr.status === 'PendingQuotes' ? `<span class="muted">Need at least 2 quotes (have ${quotes.length}).</span>` : ''}` : ''}
    </div>
    ${!rfqAllowed ? '<div class="panel"><span class="muted">Requests for Quotation can be sent once this Purchase Request is approved.</span></div>' : `<div class="panel">
      <h4 style="margin:0 0 8px;">Request for Quotation (RFQ)</h4>
      <p class="muted">Select line items and vendors, then edit and send an RFQ email. A vendor's reply still comes back by phone/email outside the system - type it in as a quote above once you have it.</p>
      <div><b>Line Items</b></div>
        ${lines.map(l => `<label style="display:inline-block;margin-right:14px;"><input type="checkbox" class="rfq-item-cb-${prId}" value="${l.id}" checked onchange="loadRFQTemplate(${prId})"> ${lineLabel(l)}</label>`).join('') || '<span class="muted">No line items on this PR.</span>'}
      </div>
      <div>
        <label><b>Vendors</b></label>
        <select id="rfq-vendor-add-${prId}"></select>
        <button class="btn small outline" type="button" onclick="addRFQVendor(${prId})">+ Add Vendor</button>
        <p class="muted">${vendors.length ? `${vendorsWithEmail.length} of ${vendors.length} suggested vendor(s) have an email on file and can be sent an RFQ.` : 'No suggested vendors - add one in Vendor Master.'}
          ${vendorsNoEmail.length ? (vendorsNoEmail.length <= 10
            ? ` ${vendorsNoEmail.length} excluded for having none: ${vendorsNoEmail.map(v => esc(v.name)).join(', ')}.`
            : ` ${vendorsNoEmail.length} excluded for having none - add one in Vendor Master to include them here.`) : ''}
        </p>
        <div>
          <input type="email" id="rfq-email-add-${prId}" placeholder="or type an email address not on file" onkeydown="if(event.key==='Enter'){event.preventDefault();addRFQEmail(${prId});}">
          <button class="btn small outline" type="button" onclick="addRFQEmail(${prId})">+ Add Email</button>
        </div>
        <div id="rfq-vendor-list-${prId}"></div>
      </div>
      <button class="btn small outline" type="button" onclick="loadRFQTemplate(${prId})">Load Default Template</button>
      <div class="form-grid">
        <div style="grid-column:1/-1;"><label>Subject</label><input id="rfq-subject-${prId}"></div>
        <div style="grid-column:1/-1;"><label>Body (use {{vendor_name}} to personalize per vendor)</label><textarea id="rfq-body-${prId}" rows="10"></textarea></div>
      </div>
      <button class="btn small outline" type="button" onclick="sendRFQ(${prId}, true)" ${!lines.length ? 'disabled' : ''}>Save as Draft</button>
      <button class="btn" type="button" onclick="sendRFQ(${prId})" ${!lines.length ? 'disabled' : ''}>Send RFQ</button>
      <div id="rfq-send-result-${prId}"></div>
      <div id="rfq-history-${prId}"></div>
    </div>`}`;
  if (!rfqAllowed) return;
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
window.sendRFQ = async (prId, asDraft) => {
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
  if (!asDraft && !vendorIds.length && !extraEmails.length) { alert('Add at least one vendor or email address, or save as Draft.'); return; }
  try {
    const result = await api(`/purchase/requests/${prId}/rfq`, { method: 'POST', body: JSON.stringify({ item_ids: itemIds, vendor_ids: vendorIds, extra_emails: extraEmails, subject, body, draft: !!asDraft }) });
    if (asDraft) {
      resultEl.innerHTML = '<div class="msg ok">Saved as Draft - send it from the RFQ History below.</div>';
      renderRFQHistory(prId);
      return;
    }
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
  el.innerHTML = `<b>RFQ History</b>` + tableHTML(['Created', 'Subject', 'Status', 'Recipients', 'By', ''], rfqs, r => {
    const btns = [];
    if (r.status === 'Draft') btns.push(`<button class="btn small" type="button" onclick="sendDraftRFQ(${r.id}, ${prId})">Send</button>`);
    if (r.status === 'Draft') btns.push(`<button class="btn small outline" type="button" onclick="deleteDraftRFQ(${r.id}, ${prId})">Delete</button>`);
    if (r.status === 'Sent') btns.push(`<button class="btn small outline" type="button" onclick="closeRFQ(${r.id}, ${prId})">Close</button>`);
    if (r.status === 'Sent' || r.status === 'Closed') btns.push(`<button class="btn small green" type="button" onclick="openRFQComparison(${r.id})">Compare Quotes</button>`);
    // A Draft has no send rows yet - show its saved targets instead.
    const recips = r.status === 'Draft'
      ? `${(r.vendor_ids || []).length + (r.extra_emails || []).length} saved recipient(s)`
      : [...r.vendors.map(v => `${esc(v.vendor_name)} (${esc(v.email_status)})`), ...(r.emails||[]).map(e => `${esc(e.email)} (${esc(e.email_status)})`)].join(', ');
    return `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${esc(r.subject)}</td><td>${badge(r.status)}</td>
    <td>${recips}</td><td>${esc(r.created_by_name)||'-'}</td><td>${actionButtonsCell(btns.join(''))}</td></tr>`;
  });
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
  try {
    const r = await api(`/purchase/requests/${prId}/submit-for-approval`, { method: 'POST' });
    if (r.quotes_required) alert('This request needs at least 2 vendor quotes before it can go to approval - add them via the Quotes / RFQ button, then Submit for Approval again.');
    navigate('purchase-requests');
  } catch (e) { alert(e.message); }
};
window.addPR = async () => {
  const errEl = document.getElementById('pr-err');
  errEl.style.display = 'none';
  try {
    const lines = PR_LINES.filter(l => (l.item_id || (l.item_text||'').trim()) && Number(l.quantity) > 0)
      .map(l => ({ item_id: l.item_id || null, item_text: l.item_text || null, quantity: Number(l.quantity), estimated_value: Number(l.estimated_value) || 0, details: l.details || null, unit: l.unit || null }));
    if (!lines.length) throw new Error('Add at least one item line with a quantity.');
    await api('/purchase/requests', { method: 'POST', body: JSON.stringify({
      project_id: val('pr-project') || null, items: lines
    })});
    navigate('purchase-requests');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
let EDIT_PR_LINES = [];
// Once a PR has actually cleared approval (Approved/OrderPlaced), only an
// approver can even open this form (see canEditPR()) - and even then, line
// items stay frozen for everyone (PUT /requests/:id 400s on any `items`
// payload in that state - see its own comment in routes/purchase.js), same
// as a Purchase Order can't gain a new line past Open/PartiallyReceived.
// This flag drives the read-only rendering below and tells saveEditPR() to
// leave `items` out of the request entirely rather than send a doomed call.
let EDIT_PR_ITEMS_LOCKED = false;
// Edit Purchase Request (2026-10-13: converted from a bottom-of-page
// scroll-to panel to the generic popup - see openEditVendor's own comment
// for why).
window.openEditPR = async (id) => {
  const r = (window.__PR_CACHE || []).find(x => x.id === id);
  if (!r) return;
  const projects = window.__PR_PROJECTS || [];
  const lines = await api('/purchase/requests/' + id + '/items').catch(() => []);
  EDIT_PR_LINES = lines.length ? lines.map(l => ({ item_id: l.item_id || '', item_text: l.item_text || '', quantity: l.quantity, estimated_value: l.estimated_value || 0, details: l.details || '', unit: l.unit || l.item_unit || '' }))
    : [{ item_id: r.item_id || '', item_text: '', quantity: r.quantity, estimated_value: r.estimated_value || 0, details: '' }];
  EDIT_PR_ITEMS_LOCKED = ['Approved', 'OrderPlaced'].includes(r.status);
  openAppModal('Edit PR — ' + esc(r.pr_no), `
    <div class="form-grid">
      <div><label>Project (optional)</label><select id="pre-project">${projectOptions(r.project_id, projects)}</select></div>
    </div>
    ${EDIT_PR_ITEMS_LOCKED ? `<p class="muted">This request has already been approved - line items are locked. Only the project assignment above can still be changed.</p>` : ''}
    <div id="pre-lines"></div>
    ${EDIT_PR_ITEMS_LOCKED ? '' : `<button class="btn small outline" type="button" onclick="addEditPRLine()">+ Add Line Item</button>`}
    <div style="margin-top:12px;">
      <button class="btn" id="pre-save-btn-${id}" onclick="saveEditPR(${id})">Save Changes</button>
    </div>
    <div id="pre-err" class="msg err" style="display:none;margin-top:10px;"></div>
    <div id="pr-attachments-${id}"></div>`);
  renderEditPRLines();
  renderAttachmentsWidget('purchase_request', id, document.getElementById(`pr-attachments-${id}`));
};
function renderEditPRLines() {
  const el = document.getElementById('pre-lines');
  if (!el) return;
  const ro = EDIT_PR_ITEMS_LOCKED;
  const total = EDIT_PR_LINES.reduce((s, l) => s + (Number(l.estimated_value) || 0), 0);
  el.innerHTML = gridLineTableHTML(PR_LINES_GRID_COLS, ['Item (pick from master)', 'Additional Details', 'Or type a new item', 'Qty', 'Unit', 'Est. Value (₹)', ''], EDIT_PR_LINES, (l, i) => `
      <div><div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;">
        ${itemPickerHTML(`edit-pr-item-${i}`, window.__PR_ITEMS || [], l.item_id, prItemOptions,
          `onchange="EDIT_PR_LINES[${i}].item_id=this.value?Number(this.value):'';prAutoFillUnit('EDIT_PR_LINES',${i},this.value);renderEditPRLines()" ${ro ? 'disabled' : ''}`)}
        ${prStockBadgeHTML(`edit-pr-stock-${i}`, window.__PR_ITEMS || [], l.item_id)}
      </div></div>
      <div><input value="${esc(l.details||'')}" placeholder="e.g. grade, size, drawing ref" onchange="EDIT_PR_LINES[${i}].details=this.value" ${ro ? 'disabled' : ''}></div>
      <div><input value="${esc(l.item_text||'')}" placeholder="Not in the master? Type it here" onchange="EDIT_PR_LINES[${i}].item_text=this.value" ${l.item_id || ro ? 'disabled' : ''}></div>
      <div><input type="number" value="${l.quantity}" onchange="EDIT_PR_LINES[${i}].quantity=Number(this.value)" ${ro ? 'disabled' : ''}></div>
      <div>${prUnitSelectHTML('EDIT_PR_LINES', i, l.unit, ro)}</div>
      <div><input type="number" value="${l.estimated_value}" onchange="EDIT_PR_LINES[${i}].estimated_value=Number(this.value);renderEditPRLines()" ${ro ? 'disabled' : ''}></div>
      <div>${!ro && EDIT_PR_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="EDIT_PR_LINES.splice(${i},1);renderEditPRLines()">✕</button>` : ''}</div>`,
    `<div style="grid-column:span 5;text-align:right;"><b>Total Est. Value</b></div><div><b>₹${fmt(total)}</b></div><div></div>`);
}
window.addEditPRLine = () => { EDIT_PR_LINES.push({ item_id: '', item_text: '', quantity: 1, estimated_value: 0, details: '', unit: '' }); renderEditPRLines(); };
window.saveEditPR = async (id) => {
  const errEl = document.getElementById('pre-err');
  errEl.style.display = 'none';
  try {
    const payload = { project_id: val('pre-project') || null };
    if (!EDIT_PR_ITEMS_LOCKED) {
      const lines = EDIT_PR_LINES.filter(l => (l.item_id || (l.item_text||'').trim()) && Number(l.quantity) > 0)
        .map(l => ({ item_id: l.item_id || null, item_text: l.item_text || null, quantity: Number(l.quantity), estimated_value: Number(l.estimated_value) || 0, details: l.details || null, unit: l.unit || null }));
      if (!lines.length) throw new Error('Add at least one item line with a quantity.');
      payload.items = lines;
    }
    await api('/purchase/requests/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    confirmSavedThenClose(`pre-save-btn-${id}`, 'purchase-requests');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Purchase Orders ----
// Unit of Measurement picker: a dropdown of the 3 common presets plus
// "Other..." which reveals a free-text box for anything else - used on both
// the New PO line-items table (array-backed, via `assignExpr`) and the
// single-line Edit PO form (read back at Save time via unitPickerValue(),
// no live assignment needed there since that form has no backing array).
const PO_UNIT_PRESETS = ['KGS', 'Nos', 'Meters'];
function unitPickerHTML(id, currentValue, assignExpr) {
  const isPreset = PO_UNIT_PRESETS.includes(currentValue);
  const selVal = isPreset ? currentValue : (currentValue ? 'Other' : 'Nos');
  const assign = assignExpr ? `${assignExpr}=unitPickerValue('${id}');` : '';
  return `<select id="${id}" onchange="toggleUnitOther('${id}');${assign}" style="width:80px;">
      ${PO_UNIT_PRESETS.map(u => `<option value="${esc(u)}" ${selVal===u?'selected':''}>${esc(u)}</option>`).join('')}
      <option value="Other" ${selVal==='Other'?'selected':''}>Other...</option>
    </select>
    <input id="${id}-other" value="${esc(isPreset ? '' : (currentValue||''))}" placeholder="unit" style="width:70px;display:${selVal==='Other'?'inline-block':'none'};margin-top:4px;"
      ${assignExpr ? `oninput="${assign}"` : ''}>`;
}
window.toggleUnitOther = (id) => {
  const other = document.getElementById(id + '-other');
  if (other) other.style.display = val(id) === 'Other' ? 'inline-block' : 'none';
};
window.unitPickerValue = (id) => {
  const sel = val(id);
  return sel === 'Other' ? (val(id + '-other').trim() || 'Nos') : sel;
};
let PO_LINES = [];
PAGES['purchase-orders'] = async (el) => {
  // All 7 of these are independent reads - fired together (rather than one
  // `await` after another) so the page's total load time is the slowest of
  // them, not their sum. Panel keys are static, so fetchPanelOrder's layout
  // read doesn't need to wait for the panels themselves to be built.
  const [orders, vendorsRaw, items, prsRaw, companyAddresses, purchaseSettings, poOrder] = await Promise.all([
    api('/purchase/orders'),
    api('/masters/vendors'),
    api('/masters/items'),
    api('/purchase/requests'),
    api('/settings/company-addresses').catch(() => []),
    api('/settings/purchase').catch(() => null),
    fetchPanelOrder('purchase-orders', ['new-po', 'bulk-import', 'list', 'archive']),
  ]);
  // Only Active vendors are offered when creating a new PO - Inactive/
  // Blacklisted ones stay visible/editable in Vendor Master (and on POs that
  // already reference them) but drop out of the picker.
  const vendors = vendorsRaw.filter(v => (v.status || 'Active') === 'Active');
  const prs = prsRaw.filter(r => r.status === 'Approved');
  const paymentTermsOptions = (purchaseSettings || {}).payment_terms_options || [];
  // Archive split (2026-10-13) - see the 'archive' panel below for the full
  // reasoning. groupPORows() is the same consecutive-by-po_no grouping
  // renderPORows() already uses (safe here since GET /orders' ORDER BY id
  // DESC keeps every po_no's sibling rows adjacent, same assumption that
  // function already relies on).
  const TERMINAL_PO_STATUSES = ['Received', 'Cancelled', 'Closed'];
  const archivedPoNos = new Set(
    groupPORows(orders).filter(g => g.lines.every(l => TERMINAL_PO_STATUSES.includes(l.status))).map(g => g.po_no)
  );
  const activeOrders = orders.filter(o => !archivedPoNos.has(o.po_no));
  const archivedOrders = orders.filter(o => archivedPoNos.has(o.po_no));
  // Set before building the HTML below, not after - renderPOLines() (called
  // as part of that build) and the lazily-built per-row Edit/Terms panels
  // (poEditForm()/poTermsForm(), built on first toggle - see togglePOEdit/
  // togglePOTerms below) all read these globals directly rather than taking
  // them as arguments, so assigning them afterward would leave pickers empty.
  window.__PO_PRS = prs;
  window.__PO_VENDORS = vendors;
  window.__PO_ITEMS = items;
  window.__PO_COMPANY_ADDRESSES = companyAddresses;
  window.__PO_PAYMENT_TERMS = paymentTermsOptions;
  // Flat id->row lookup for the lazy Edit/Terms panels - rows only ever need
  // their own PO line's data, found by id, not the whole list.
  window.__PO_ORDERS_CACHE = orders;
  PO_LINES = [{ item_id: '', quantity: 1, rate: 0, hsn_code: '', gst_rate: 18, unit: 'Nos', discount_percent: 0, purchase_request_item_id: null, details: '' }];
  const poPanels = {
    'new-po': collapsiblePanel('new-purchase-order', 'New Purchase Order', `
      ${!vendors.length ? `<div class="msg err">No vendors yet - add one under <a href="#" onclick="navigate('vendors');return false;">Vendor Master</a> before creating a PO.</div>` : ''}
      <div class="form-grid">
        <div><label>From PR (approved)</label><select id="po-pr" onchange="fillPOFromPR()"><option value="">-</option>${prs.map(r => `<option value="${r.id}">${esc(r.pr_no)}</option>`).join('')}</select></div>
        <div><label>Vendor</label><select id="po-vendor" ${!vendors.length ? 'disabled' : ''}>${vendors.length ? vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('') : '<option value="">- No vendors -</option>'}</select></div>
      </div>
      <div id="po-pr-detail" class="panel" style="display:none;"></div>
      <div id="po-lines"></div>
      <button class="btn small outline" type="button" onclick="addPOLine()">+ Add Line Item</button>
      <div id="po-vendor-suggestions" class="panel" style="display:none;"></div>
      <div class="form-grid">
        <div><label>Delivery Date</label><input id="po-delivery" type="date"></div>
        <div><label>Payment Terms</label><select id="po-payment-terms"><option value="">-</option>${paymentTermsOptions.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid">
        <div><label>LD Rate (%)</label><input id="po-ld-pct" type="number" step="0.01"></div>
        <div><label>LD Cap (%)</label><input id="po-ld-cap" type="number" step="0.01"></div>
        <div><label>Trigger Conditions/Notes</label><textarea id="po-ld-notes" rows="2" placeholder="e.g. 0.5% per week of delay, capped at 5% of order value"></textarea></div>
      </div>
      <div class="form-grid">
        <div><label>Freight (₹)</label><input id="po-freight" type="number" value="0"></div>
        <div><label>Freight GST (%)</label><input id="po-freight-gst" type="number" value="${(purchaseSettings && purchaseSettings.default_gst_rate) || 18}"></div>
        <div><label>Freight Comments</label><textarea id="po-freight-notes" rows="2" placeholder="e.g. covers door delivery, excludes unloading"></textarea></div>
      </div>
      <div class="form-grid"><div style="grid-column:1/-1;"><label>General Notes</label><textarea id="po-general-notes" rows="2" placeholder="Any other notes for this order"></textarea></div></div>
      <div class="form-grid">
        <div><label>Bill-To Address</label><select id="po-bill-address"><option value="">- None -</option>${companyAddresses.filter(a => a.address_type === 'Billing').map(a => `<option value="${a.id}">${esc(a.label) || 'Billing'}</option>`).join('')}</select></div>
        <div><label>Ship-To Address</label><select id="po-ship-address"><option value="">- None -</option>${companyAddresses.filter(a => a.address_type === 'Shipping').map(a => `<option value="${a.id}">${esc(a.label) || 'Shipping'}</option>`).join('')}</select></div>
      </div>
      <button class="btn" onclick="addPO()" ${!vendors.length ? 'disabled' : ''}>Save as Draft</button>
      <p class="muted">Saves this as a Draft below - nothing is submitted for approval yet. Review it (Download PDF/Word for a preview, or Edit to change anything), then click Submit for Approval when it's ready.</p>
    `),
    'bulk-import': collapsiblePanel('new-po-bulk-import', 'Bulk Import Open POs', `
      <p class="muted">Bring in orders already open with a vendor before this system was used - each row becomes a real PO you can then receive, edit, cancel, or print, same as one created here. Vendor names not on file are added automatically; items are matched by Item Code or barcode.</p>
      <button class="btn outline" type="button" onclick="downloadPOImportTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('po-upload-file')}
      <button class="btn" onclick="uploadPOImportTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="po-upload-result" style="margin-top:10px;"></div>
    `),
    'list': collapsiblePanel('po-list', `<span id="po-count">Purchase Orders (${activeOrders.length})</span>`, `
      ${renderListSearch('purchase-orders', activeOrders, ['po_no', 'vendor_name', 'item_name', 'status'], (rows) => {
        document.getElementById('po-table-wrap').innerHTML = renderPORows(rows);
        document.getElementById('po-count').textContent = 'Purchase Orders (' + rows.length + ')';
      }, 'Search by PO no, vendor, item, status...')}
      <div id="po-table-wrap">${renderPORows(activeOrders)}</div>
    `),
    // Archive (2026-10-13) - a PO (or, for a multi-line one, every line
    // sharing its po_no) that's Received/Cancelled/Closed has nothing left
    // to act on, but the active list above kept growing with them forever.
    // A group only archives once EVERY line is terminal - one still-active
    // line (Open/PartiallyReceived/Draft/...) keeps the whole group in the
    // active list above, so nothing actionable ever disappears from view.
    // Collapsed by default, same "the one bucket that only ever grows gets
    // its own collapsiblePanel" precedent as the Service Request Queue's
    // Closed bucket and Site Visits' Closed bucket.
    'archive': collapsiblePanel('po-archive', `<span id="po-archive-count">Archive - Received / Cancelled / Closed (${archivedOrders.length})</span>`, `
      ${renderListSearch('purchase-orders-archive', archivedOrders, ['po_no', 'vendor_name', 'item_name', 'status'], (rows) => {
        document.getElementById('po-archive-table-wrap').innerHTML = renderPORows(rows);
        document.getElementById('po-archive-count').textContent = 'Archive - Received / Cancelled / Closed (' + rows.length + ')';
      }, 'Search by PO no, vendor, item, status...')}
      <div id="po-archive-table-wrap">${renderPORows(archivedOrders)}</div>
    `),
  };
  const poLabels = { 'new-po': 'New Purchase Order', 'bulk-import': 'Bulk Import Open POs', 'list': 'Purchase Orders List', 'archive': 'Archive' };
  el.innerHTML = reorderablePanelsHTML('purchase-orders', poPanels, poOrder, poLabels);
  renderPOLines();
};
// Grid-column track list shared by every New-PO-style line-item table in
// this file (PO_LINES here, PR_LINES/EDIT_PR_LINES/SO_LINES/FOC_LINES below)
// - declared once per table via gridLineTableHTML() so a column's width
// always matches its header, instead of racing each row's own hand-picked
// input width (2026-10-14, see gridLineTableHTML()'s own comment).
const PO_LINES_GRID_COLS = 'minmax(260px,1.8fr) minmax(140px,1.2fr) 100px 110px 110px 90px 110px 100px 44px';
function renderPOLines() {
  const el = document.getElementById('po-lines');
  if (!el) return;
  el.innerHTML = gridLineTableHTML(PO_LINES_GRID_COLS, ['Item', 'Additional Details', 'Quantity', 'Unit', 'Rate (₹)', 'Discount %', 'HSN Code', 'GST Rate (%)', ''], PO_LINES, (l, i) => `
      <div><div style="display:flex;gap:6px;align-items:flex-start;">
        <div style="flex:0 0 auto;">${itemPickerHTML(`po-item-${i}`, window.__PO_ITEMS || [], l.item_id,
          (selectedId, its) => its.map(it => `<option value="${it.id}" ${it.id===selectedId?'selected':''}>${esc(it.name)}${it.status === 'Pending' ? ' (pending review)' : ''}${it.status === 'Discontinued' ? ' (discontinued)' : ''}</option>`).join(''),
          `onchange="PO_LINES[${i}].item_id=this.value?Number(this.value):'';prefillPOLineUnit(${i});showVendorsForPOLines()"`)}</div>
        <button class="btn small outline" type="button" style="white-space:nowrap;" onclick="showItemPriceHistory(PO_LINES[${i}].item_id,{vendorSelectId:'po-vendor'})">Price History</button>
      </div></div>
      <div><input value="${esc(l.details||'')}" placeholder="e.g. grade, size, drawing ref" onchange="PO_LINES[${i}].details=this.value"></div>
      <div><input type="number" value="${l.quantity}" onchange="PO_LINES[${i}].quantity=Number(this.value)"></div>
      <div>${unitPickerHTML(`po-unit-${i}`, l.unit, `PO_LINES[${i}].unit`)}</div>
      <div><input type="number" value="${l.rate}" onchange="PO_LINES[${i}].rate=Number(this.value)"></div>
      <div><input type="number" value="${l.discount_percent||0}" min="0" max="100" onchange="PO_LINES[${i}].discount_percent=Number(this.value)"></div>
      <div><input value="${esc(l.hsn_code||'')}" onchange="PO_LINES[${i}].hsn_code=this.value"></div>
      <div><input type="number" value="${l.gst_rate}" onchange="PO_LINES[${i}].gst_rate=Number(this.value)"></div>
      <div>${PO_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="PO_LINES.splice(${i},1);renderPOLines()">✕</button>` : ''}</div>`);
}
// When an item is picked, default its line's Unit to that item's own Item
// Master unit (still freely overridable afterward) - skipped if the item
// has no unit on file, so it doesn't clobber a unit the user already typed.
window.prefillPOLineUnit = (i) => {
  const item = (window.__PO_ITEMS || []).find(it => it.id === PO_LINES[i].item_id);
  if (item && item.unit) { PO_LINES[i].unit = item.unit; renderPOLines(); }
};
window.addPOLine = () => { PO_LINES.push({ item_id: '', quantity: 1, rate: 0, hsn_code: '', gst_rate: 18, unit: 'Nos', discount_percent: 0, purchase_request_item_id: null, details: '' }); renderPOLines(); };
// A multi-item PO is several purchase_orders rows sharing one po_no (see
// routes/purchase.js's POST /orders); GET /orders returns them flat but
// consecutive (inserted in one transaction, so their ids sort together
// under the page's id-DESC order), so grouping is just "consecutive rows
// with the same po_no" - no separate aggregate endpoint needed.
function groupPORows(rows) {
  const groups = [];
  let current = null;
  for (const o of rows) {
    if (current && current.po_no === o.po_no) current.lines.push(o);
    else { current = { po_no: o.po_no, lines: [o] }; groups.push(current); }
  }
  return groups;
}
// Compact status summary for a group of PO lines - one badge per *distinct*
// status with a ×count, rather than one badge per line (2026-10-07: a
// 13-line PO that's just been submitted used to print "PendingApproval"
// thirteen times in a row). A group where every line shares one status
// (the common case) collapses to that single badge, same as it would read
// for a single-line PO; a genuinely mixed group (some Open, some Cancelled,
// ...) shows each status once with its own count.
function summarizePOGroupStatus(lines) {
  const counts = {};
  lines.forEach(l => { counts[l.status] = (counts[l.status] || 0) + 1; });
  const distinct = Object.keys(counts);
  if (distinct.length === 1) return badge(distinct[0]);
  return distinct.map(s => `${badge(s)} <span class="muted" style="font-size:11px;">×${counts[s]}</span>`).join(' ');
}
// Shared actions-cell wrapper (2026-10-07, grid layout added 2026-10-13) -
// every button group in the PO list used to be a bare run of inline
// <button>s with no layout container, which wrapped raggedly once it
// overflowed a cell's width. The actual grid/uniform-width rules live on
// the .po-actions class in public/index.html (so the same layout applies
// consistently everywhere this helper is used) - this just applies the
// class. Used for both the Documents cell and the action-buttons cell, in
// both the single-line row and the multi-line group header.
function poActionsCell(buttonsHtml) {
  return `<div class="po-actions">${buttonsHtml}</div>`;
}
function poAddLineForm(poId) {
  const items = window.__PO_ITEMS || [];
  return `<div class="form-grid">
    <div><label>Item</label>${itemPickerHTML(`po-addline-item-${poId}`, items, '',
      (selectedId, its) => its.map(it => `<option value="${it.id}" ${it.id===selectedId?'selected':''}>${esc(it.name)}</option>`).join(''))}</div>
    <div><label>Additional Details</label><input id="po-addline-details-${poId}" placeholder="e.g. grade, size, drawing ref"></div>
    <div><label>Quantity</label><input id="po-addline-qty-${poId}" type="number" value="1"></div>
    <div><label>Unit</label>${unitPickerHTML(`po-addline-unit-${poId}`, 'Nos')}</div>
    <div><label>Rate (₹)</label><input id="po-addline-rate-${poId}" type="number" value="0"></div>
    <div><label>Discount %</label><input id="po-addline-discount-${poId}" type="number" min="0" max="100" value="0"></div>
    <div><label>HSN Code</label><input id="po-addline-hsn-${poId}"></div>
    <div><label>GST Rate (%)</label><input id="po-addline-gst-${poId}" type="number" value="18"></div>
  </div>
  <button class="btn small" type="button" onclick="savePOAddLine(${poId})">Add Item</button>
  <div id="po-addline-err-${poId}" class="msg err" style="display:none;"></div>`;
}
window.togglePOAddLine = (id) => {
  const row = document.getElementById(`po-addline-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing && !row.dataset.built) {
    document.getElementById(`po-addline-body-${id}`).innerHTML = poAddLineForm(id);
    row.dataset.built = '1';
  }
};
window.savePOAddLine = async (id) => {
  const errEl = document.getElementById(`po-addline-err-${id}`);
  errEl.style.display = 'none';
  try {
    await api(`/purchase/orders/${id}/add-line`, { method: 'POST', body: JSON.stringify({
      item_id: val(`po-addline-item-${id}`) || null, details: val(`po-addline-details-${id}`),
      quantity: val(`po-addline-qty-${id}`), rate: val(`po-addline-rate-${id}`),
      unit: unitPickerValue(`po-addline-unit-${id}`), discount_percent: val(`po-addline-discount-${id}`),
      hsn_code: val(`po-addline-hsn-${id}`), gst_rate: val(`po-addline-gst-${id}`),
    })});
    navigate('purchase-orders');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
function renderSinglePORow(o) {
  return `
    <tr><td>${esc(o.po_no)}</td><td>${esc(o.vendor_name)}</td><td>${esc(o.item_name)}</td><td>${o.quantity}</td>
    <td>${o.received_qty > 0 ? `${o.received_qty} / ${o.quantity}` : '-'}</td>
    <td>₹${fmt(o.rate)}</td><td>₹${fmt(o.total_value)}</td><td>${badge(o.status)}</td>
    <td>${deliveryBadge(o.delivery_date)}</td>
    <td>${poActionsCell(`
      <button class="btn small outline" type="button" onclick="downloadPoPdf(${o.id}, '${esc(o.po_no)}')">PDF</button>
      <button class="btn small outline" type="button" onclick="downloadPoDocx(${o.id}, '${esc(o.po_no)}')">Word</button>
      <button class="btn small outline" type="button" onclick="emailPo(${o.id})">Email Vendor</button>
    `)}</td>
    <td>${poActionsCell(`
    <button class="btn small outline" type="button" onclick="togglePOAttachments(${o.id})">Attachments</button>
    <button class="btn small outline" type="button" onclick="togglePOTerms(${o.id})">Terms</button>
    ${o.status === 'Draft' ? `<button class="btn small" type="button" onclick="submitPOForApproval(${o.id})">Submit for Approval</button>` : ''}
    ${canAddPOLine(o) ? `<button class="btn small outline" type="button" onclick="togglePOAddLine(${o.id})">+ Add Line Item</button>` : ''}
    ${canEditPO(o) ? `<button class="btn small outline" type="button" onclick="togglePOEdit(${o.id})">Edit</button>` : ''}
    ${!['Received','Cancelled','Closed'].includes(o.status) ? `<button class="btn small red" type="button" onclick="cancelPO(${o.id})">Cancel</button>` : ''}
    ${['Open','PartiallyReceived'].includes(o.status) ? `<button class="btn small outline" type="button" onclick="closeShortShip(${o.id})">Short Ship</button>` : ''}
    ${o.status === 'Closed' && ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="reopenClosedPO(${o.id})">Reopen</button>` : ''}
    ${canDeletePO(o) ? `<button class="btn small red" type="button" onclick="deletePOLine(${o.id})">Delete</button>` : ''}
    <button class="btn small outline" type="button" onclick="togglePOHistory(${o.id})">History</button>`)}</td></tr>
    <tr id="po-att-row-${o.id}" style="display:none;"><td colspan="11"><div id="po-attachments-${o.id}"></div></td></tr>
    <tr id="po-terms-row-${o.id}" style="display:none;"><td colspan="11"><div id="po-terms-body-${o.id}"></div></td></tr>
    <tr id="po-addline-row-${o.id}" style="display:none;"><td colspan="11"><div id="po-addline-body-${o.id}"></div></td></tr>
    <tr id="po-history-row-${o.id}" style="display:none;"><td colspan="11"><div id="po-history-${o.id}"></div></td></tr>`;
}
// Multi-line groups (2026-10-07) default to collapsed - only the summary
// header row shows at first; the per-line rows (class po-group-row-<id>)
// are hidden until the "N items" toggle is clicked, same "collapsed by
// default, click to expand" discipline already used for the sidebar nav,
// specific list panels, and the To-Do board (see CLAUDE.md's standing rule
// on this, added the same day) - a 13-line PO no longer dumps 13 rows onto
// the page the moment the list loads.
window.togglePOGroupLines = (id) => {
  const rows = document.querySelectorAll(`.po-group-row-${id}`);
  const chev = document.getElementById(`po-group-chev-${id}`);
  const showing = rows.length && rows[0].style.display !== 'none';
  rows.forEach(r => { r.style.display = showing ? 'none' : ''; });
  if (chev) chev.textContent = showing ? '▸' : '▾';
};
function renderMultiLinePOGroup(lines) {
  const first = lines[0];
  const totalValue = lines.reduce((s, l) => s + Number(l.total_value || 0), 0);
  const totalQty = lines.reduce((s, l) => s + Number(l.quantity || 0), 0);
  const totalReceived = lines.reduce((s, l) => s + Number(l.received_qty || 0), 0);
  const anyCancellable = lines.some(l => !['Received', 'Cancelled', 'Closed'].includes(l.status));
  const anyDraft = lines.some(l => l.status === 'Draft');
  const allDeletable = isPurchaseApprover() && lines.every(l => ['Draft', 'Rejected', 'Cancelled'].includes(l.status));
  const groupId = first.id;
  const lineRows = lines.map(o => `
    <tr class="po-group-row-${groupId}" style="display:none;">
      <td colspan="2" class="muted" style="padding-left:20px;">↳</td>
      <td>${esc(o.item_name)}</td><td>${o.quantity}</td>
      <td>${o.received_qty > 0 ? `${o.received_qty} / ${o.quantity}` : '-'}</td>
      <td>₹${fmt(o.rate)}</td><td>₹${fmt(o.total_value)}</td><td>${badge(o.status)}</td>
      <td></td><td></td>
      <td>${poActionsCell(`
      ${o.status === 'Draft' ? `<button class="btn small" type="button" onclick="submitPOForApproval(${o.id})">Submit</button>` : ''}
      ${canEditPO(o) ? `<button class="btn small outline" type="button" onclick="togglePOEdit(${o.id})">Edit</button>` : ''}
      ${!['Received','Cancelled','Closed'].includes(o.status) ? `<button class="btn small red" type="button" onclick="cancelPO(${o.id})">Cancel</button>` : ''}
      ${['Open','PartiallyReceived'].includes(o.status) ? `<button class="btn small outline" type="button" onclick="closeShortShip(${o.id})">Short Ship</button>` : ''}
      ${o.status === 'Closed' && ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="reopenClosedPO(${o.id})">Reopen</button>` : ''}
      ${canDeletePO(o) ? `<button class="btn small red" type="button" onclick="deletePOLine(${o.id})">Delete</button>` : ''}`)}</td>
    </tr>`).join('');
  return `
    <tr style="background:#f7f9fb;">
      <td><a href="#" onclick="togglePOGroupLines(${groupId});return false;" style="text-decoration:none;"><span id="po-group-chev-${groupId}">▸</span> <b>${esc(first.po_no)}</b></a></td><td>${esc(first.vendor_name)}</td>
      <td><a href="#" onclick="togglePOGroupLines(${groupId});return false;">${lines.length} items</a></td><td>${fmt(totalQty)}</td>
      <td>${totalReceived > 0 ? `${fmt(totalReceived)} / ${fmt(totalQty)}` : '-'}</td>
      <td>-</td><td>₹${fmt(totalValue)}</td><td>${summarizePOGroupStatus(lines)}</td>
      <td>${deliveryBadge(first.delivery_date)}</td>
      <td>${poActionsCell(`
        <button class="btn small outline" type="button" onclick="downloadPoPdf(${first.id}, '${esc(first.po_no)}')">PDF</button>
        <button class="btn small outline" type="button" onclick="downloadPoDocx(${first.id}, '${esc(first.po_no)}')">Word</button>
        <button class="btn small outline" type="button" onclick="emailPo(${first.id})">Email Vendor</button>
      `)}</td>
      <td>${poActionsCell(`
      <button class="btn small outline" type="button" onclick="togglePOAttachments(${first.id})">Attachments</button>
      <button class="btn small outline" type="button" onclick="togglePOTerms(${first.id})">Terms</button>
      ${anyDraft ? `<button class="btn small" type="button" onclick="submitPOForApproval(${first.id})">Submit Whole PO for Approval</button>` : ''}
      ${canEditPO(first) ? `<button class="btn small outline" type="button" onclick="togglePOEdit(${first.id})">Edit</button>` : ''}
      ${canAddPOLine(first) ? `<button class="btn small outline" type="button" onclick="togglePOAddLine(${first.id})">+ Add Line Item</button>` : ''}
      ${anyCancellable ? `<button class="btn small red" type="button" onclick="cancelWholePO('${esc(first.po_no)}')">Cancel Whole PO</button>` : ''}
      ${allDeletable ? `<button class="btn small red" type="button" onclick="deleteWholePO('${esc(first.po_no)}')">Delete Whole PO</button>` : ''}
      <button class="btn small outline" type="button" onclick="togglePOHistory(${first.id})">History</button>`)}</td></tr>
    <tr id="po-att-row-${first.id}" style="display:none;"><td colspan="11"><div id="po-attachments-${first.id}"></div></td></tr>
    <tr id="po-terms-row-${first.id}" style="display:none;"><td colspan="11"><div id="po-terms-body-${first.id}"></div></td></tr>
    <tr id="po-addline-row-${first.id}" style="display:none;"><td colspan="11"><div id="po-addline-body-${first.id}"></div></td></tr>
    <tr id="po-history-row-${first.id}" style="display:none;"><td colspan="11"><div id="po-history-${first.id}"></div></td></tr>
    ${lineRows}`;
}
function renderPORows(rows) {
  const groups = groupPORows(rows);
  if (!groups.length) return '<div class="empty">No records yet.</div>';
  const body = groups.map(g => g.lines.length > 1 ? renderMultiLinePOGroup(g.lines) : renderSinglePORow(g.lines[0])).join('');
  return `<div style="overflow-x:auto;"><table><thead><tr>${['PO No', 'Vendor', 'Item', 'Qty', 'Received', 'Rate', 'Total', 'Status', 'Promised Delivery', 'Documents', ''].map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
// Starts approval for a Draft PO - the backend route acts on the whole
// po_no group from any one line's id, so this is the same call whether
// called from a single-line row's own button or the multi-line group's
// "Submit Whole PO" one.
window.submitPOForApproval = async (id) => {
  if (!confirm('Submit this Purchase Order for approval? Review it with Edit (or download a PDF/Word preview) first if anything needs changing.')) return;
  try {
    await api(`/purchase/orders/${id}/submit-for-approval`, { method: 'POST' });
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
window.cancelWholePO = async (poNo) => {
  const reason = prompt('Reason for cancelling this whole PO (optional):');
  if (reason === null) return;
  try {
    const orders = await api('/purchase/orders');
    const ids = orders.filter(o => o.po_no === poNo && !['Received', 'Cancelled', 'Closed'].includes(o.status)).map(o => o.id);
    await Promise.all(ids.map(id => api(`/purchase/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })));
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
window.deletePOLine = async (id) => {
  if (!confirm('Permanently delete this line? This cannot be undone - it removes the line from the database, not just marking it Cancelled.')) return;
  try {
    await api(`/purchase/orders/${id}`, { method: 'DELETE' });
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
window.deleteWholePO = async (poNo) => {
  if (!confirm(`Permanently delete every line of ${poNo}? This cannot be undone.`)) return;
  try {
    await api(`/purchase/orders/by-po/${encodeURIComponent(poNo)}`, { method: 'DELETE' });
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
function poEditForm(o) {
  const vendors = window.__PO_VENDORS || [];
  const items = window.__PO_ITEMS || [];
  const companyAddresses = window.__PO_COMPANY_ADDRESSES || [];
  return `<div class="form-grid" style="margin-top:8px;">
    <div><label>Vendor</label><select id="po-edit-vendor-${o.id}">${vendors.map(v => `<option value="${v.id}" ${v.id===o.vendor_id?'selected':''}>${esc(v.name)}</option>`).join('')}</select></div>
    <div><label>Item</label>${itemPickerHTML(`po-edit-item-${o.id}`, items, o.item_id, (selectedId, its) => its.map(i => `<option value="${i.id}" ${i.id===selectedId?'selected':''}>${esc(i.name)}</option>`).join(''))}</div>
    <div><label>Additional Details</label><input id="po-edit-details-${o.id}" value="${esc(o.details||'')}" placeholder="e.g. grade, size, drawing ref"></div>
    <div><label>Quantity</label><input id="po-edit-qty-${o.id}" type="number" value="${o.quantity}"></div>
    <div><label>Unit</label>${unitPickerHTML(`po-edit-unit-${o.id}`, o.unit)}</div>
    <div><label>Rate (₹)</label><input id="po-edit-rate-${o.id}" type="number" value="${o.rate}"></div>
    <div><label>Discount %</label><input id="po-edit-discount-${o.id}" type="number" min="0" max="100" value="${o.discount_percent||0}"></div>
    <div><label>HSN Code</label><input id="po-edit-hsn-${o.id}" value="${esc(o.hsn_code||'')}"></div>
    <div><label>GST Rate (%)</label><input id="po-edit-gst-${o.id}" type="number" value="${o.gst_rate}"></div>
    <div><label>Bill-To Address</label><select id="po-edit-bill-address-${o.id}"><option value="">- None -</option>${companyAddresses.filter(a => a.address_type === 'Billing').map(a => `<option value="${a.id}" ${a.id===o.company_address_id?'selected':''}>${esc(a.label) || 'Billing'}</option>`).join('')}</select></div>
    <div><label>Ship-To Address</label><select id="po-edit-ship-address-${o.id}"><option value="">- None -</option>${companyAddresses.filter(a => a.address_type === 'Shipping').map(a => `<option value="${a.id}" ${a.id===o.company_ship_address_id?'selected':''}>${esc(a.label) || 'Shipping'}</option>`).join('')}</select></div>
  </div>
  <div><label>Terms</label><textarea id="po-edit-terms-${o.id}" rows="2" style="width:100%;">${esc(o.terms||'')}</textarea></div>
  <button class="btn small" id="po-edit-save-${o.id}" type="button" onclick="savePOEdit(${o.id})">Save Changes</button>
  <div id="po-edit-err-${o.id}" class="msg err" style="display:none;margin-top:8px;"></div>`;
}
// Edit PO (2026-10-13: converted from an inline table row to the generic
// popup - see openEditVendor's own comment for why). id is always a
// specific PO line's own id - for a multi-line group's header Edit button,
// the caller passes the group's first line's id (see renderMultiLinePOGroup),
// since editing any one line already propagates shared header fields
// (vendor/addresses/freight/terms) onto every sibling line via PUT
// /orders/:id, same as editing any other line would.
window.togglePOEdit = (id) => {
  const o = (window.__PO_ORDERS_CACHE || []).find(x => x.id === id);
  if (!o) return;
  openAppModal('Edit PO — ' + esc(o.po_no), poEditForm(o));
};
window.savePOEdit = async (id) => {
  const errEl = document.getElementById(`po-edit-err-${id}`);
  errEl.style.display = 'none';
  try {
    await api(`/purchase/orders/${id}`, { method: 'PUT', body: JSON.stringify({
      vendor_id: val(`po-edit-vendor-${id}`), item_id: val(`po-edit-item-${id}`), details: val(`po-edit-details-${id}`),
      quantity: val(`po-edit-qty-${id}`), rate: val(`po-edit-rate-${id}`),
      unit: unitPickerValue(`po-edit-unit-${id}`), discount_percent: val(`po-edit-discount-${id}`),
      hsn_code: val(`po-edit-hsn-${id}`), gst_rate: val(`po-edit-gst-${id}`), terms: val(`po-edit-terms-${id}`),
      company_address_id: val(`po-edit-bill-address-${id}`) || null,
      company_ship_address_id: val(`po-edit-ship-address-${id}`) || null,
    })});
    confirmSavedThenClose(`po-edit-save-${id}`, 'purchase-orders');
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
// Close a line out as short-shipped (2026-10-16) - distinct from Cancel,
// which reads as "this never happened" even once real stock has already
// come in against a line. Already-received stock/GRN records are left
// completely untouched; only the line's own status changes.
window.closeShortShip = async (id) => {
  const reason = prompt('Reason for closing this line as short-shipped (required):');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required.'); return; }
  try {
    await api(`/purchase/orders/${id}/close-short-ship`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
// Admin-only recovery for a line Short Ship closed by mistake (2026-10-27) -
// e.g. the exact root-caused scenario where the real receive was never
// submitted before Short Ship was clicked. Reopens back to Open/
// PartiallyReceived (derived live from what's actually been received).
window.reopenClosedPO = async (id) => {
  const reason = prompt('Reason for reopening this closed line (required):');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required.'); return; }
  try {
    await api(`/purchase/orders/${id}/reopen-closed`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
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
// ---- Item Price History ----
// Pure read against purchase_orders (already carries item_id/vendor_id/
// rate/created_at per line, one row per PO line) - no new table. `opts.
// vendorSelectId`, when set, adds a "Use this vendor" button per row that
// writes straight into that <select> (the New/Edit PO form's single
// top-level vendor field - a PO is one vendor for every line, so this is
// how price history actually drives the vendor choice instead of just
// informing it). Omitted entirely from the Purchase Request context, which
// has no vendor field to set.
window.showItemPriceHistory = async (itemId, opts) => {
  if (!itemId) { alert('Pick an item first.'); return; }
  window.__IPH_OPTS = opts || {};
  const overlay = document.createElement('div');
  overlay.id = 'iph-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `<div style="background:#fff;border-radius:8px;max-width:800px;width:100%;max-height:85vh;overflow-y:auto;padding:20px;" onclick="event.stopPropagation()">
    <div id="iph-body"><p class="muted">Loading price history...</p></div>
  </div>`;
  overlay.onclick = () => closeItemPriceHistory();
  document.body.appendChild(overlay);
  await loadItemPriceHistory(itemId);
};
window.closeItemPriceHistory = () => {
  const el = document.getElementById('iph-overlay');
  if (el) el.remove();
};
window.loadItemPriceHistory = async (itemId, from, to) => {
  const body = document.getElementById('iph-body');
  if (!body) return;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const data = await api(`/purchase/items/${itemId}/price-history${qs.toString() ? '?' + qs.toString() : ''}`);
    const opts = window.__IPH_OPTS || {};
    const rates = data.rows.map(r => Number(r.rate));
    const min = rates.length ? Math.min(...rates) : null;
    const max = rates.length ? Math.max(...rates) : null;
    const latest = data.rows[0];
    const cols = ['Date', 'PO No', 'Vendor', 'Qty', 'Rate (₹)', 'Status'].concat(opts.vendorSelectId ? [''] : []);
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
        <h3 style="margin:0;">Price History — ${esc(data.item.name)}${data.item.item_code ? ' (' + esc(data.item.item_code) + ')' : ''}</h3>
        <button class="btn small outline" type="button" onclick="closeItemPriceHistory()">Close</button>
      </div>
      <div class="form-grid" style="margin-bottom:12px;">
        <div><label>From</label><input type="date" id="iph-from" value="${data.from}"></div>
        <div><label>To</label><input type="date" id="iph-to" value="${data.to}"></div>
        <div style="align-self:end;"><button class="btn small outline" type="button" onclick="loadItemPriceHistory(${itemId}, val('iph-from'), val('iph-to'))">Apply</button></div>
      </div>
      ${data.rows.length ? `
        <div class="form-grid" style="margin-bottom:12px;">
          <div><span class="muted">Lowest</span><br><b>₹${fmt(min)}</b></div>
          <div><span class="muted">Highest</span><br><b>₹${fmt(max)}</b></div>
          <div><span class="muted">Latest</span><br><b>₹${fmt(latest.rate)}</b> <span class="muted">(${esc(latest.vendor_name)||'-'}, ${new Date(latest.created_at).toLocaleDateString()})</span></div>
        </div>
        ${tableHTML(cols, data.rows, r => `
          <tr>
            <td>${new Date(r.created_at).toLocaleDateString()}</td>
            <td>${esc(r.po_no)}</td>
            <td>${esc(r.vendor_name)||'-'}</td>
            <td>${r.quantity}</td>
            <td>₹${fmt(r.rate)}</td>
            <td>${badge(r.status)}</td>
            ${opts.vendorSelectId ? `<td>${r.vendor_id ? `<button class="btn small outline" type="button" onclick="useVendorFromHistory(${r.vendor_id})">Use this vendor</button>` : ''}</td>` : ''}
          </tr>`)}
      ` : '<p class="muted">No purchase history for this item in the selected range.</p>'}
    `;
  } catch (e) {
    body.innerHTML = `<div class="msg err">${esc(e.message)}</div><button class="btn small outline" type="button" onclick="closeItemPriceHistory()" style="margin-top:10px;">Close</button>`;
  }
};
window.useVendorFromHistory = (vendorId) => {
  const opts = window.__IPH_OPTS || {};
  const sel = opts.vendorSelectId ? document.getElementById(opts.vendorSelectId) : null;
  if (sel) sel.value = vendorId;
  closeItemPriceHistory();
};

// Shows vendors matching ANY of the currently-picked line items (union),
// since a multi-line PO's lines can span more than one item - see
// PO_LINES/renderPOLines() above.
window.showVendorsForPOLines = async () => {
  const box = document.getElementById('po-vendor-suggestions');
  const itemIds = [...new Set(PO_LINES.map(l => l.item_id).filter(Boolean))];
  if (!itemIds.length) { box.style.display = 'none'; return; }
  try {
    const [catResults, historyResults] = await Promise.all([
      Promise.all(itemIds.map(id => api('/purchase/vendors-for-item/' + id).catch(() => ({ vendors: [], fallback: true })))),
      Promise.all(itemIds.map(id => api('/purchase/items/' + id + '/price-history').catch(() => ({ rows: [] })))),
    ]);
    const anyFallback = catResults.some(r => r.fallback);
    const vendorMap = new Map();
    catResults.forEach(r => (r.vendors || []).forEach(v => vendorMap.set(v.id, v)));
    const vendors = [...vendorMap.values()];
    // Most recent rate seen for each vendor across the picked items (not
    // which item it was for) - purely informational annotation, doesn't
    // change who's matched. Turns a bare name list into "ABC Steels - last
    // ₹105, 12 Jun 2026" so the suggestion box is actually useful for
    // deciding, not just listing candidates.
    const lastByVendor = new Map();
    historyResults.forEach(h => (h.rows || []).forEach(r => {
      const prev = lastByVendor.get(r.vendor_id);
      if (!prev || new Date(r.created_at) > new Date(prev.created_at)) lastByVendor.set(r.vendor_id, r);
    }));
    box.style.display = 'block';
    box.innerHTML = `<b>${anyFallback ? 'All vendors' : 'Vendors matching these items\' categories'}</b> (${vendors.length}): ${
      vendors.length ? vendors.map(v => {
        const last = lastByVendor.get(v.id);
        return esc(v.name) + (last ? ` <span class="muted">(last ₹${fmt(last.rate)}, ${new Date(last.created_at).toLocaleDateString()})</span>` : '');
      }).join(', ') : 'None on file yet.'
    }`;
  } catch (e) { box.style.display = 'none'; }
};
// Loads every line of the selected PR into PO_LINES (not just one at a
// time) - remove any already covered by an earlier PO with the line's own
// ✕ button before submitting.
window.fillPOFromPR = async () => {
  const id = Number(val('po-pr'));
  const detail = document.getElementById('po-pr-detail');
  if (!id) { detail.style.display = 'none'; return; }
  const r = (window.__PO_PRS || []).find(x => x.id === id);
  if (!r) { detail.style.display = 'none'; return; }
  const lines = await api('/purchase/requests/' + id + '/items').catch(() => []);
  detail.style.display = 'block';
  detail.innerHTML = `<b>${esc(r.pr_no)}</b> — ${lines.length} line item${lines.length===1?'':'s'} loaded below (remove any already covered by an earlier PO). &nbsp;
    Project: <b>${esc(r.project_code)||'-'}</b>`;
  PO_LINES = lines.length ? lines.map(l => ({
    item_id: l.item_id || '', quantity: l.quantity, rate: 0, hsn_code: '', gst_rate: 18, unit: l.item_unit || 'Nos', discount_percent: 0, purchase_request_item_id: l.id, details: l.details || '',
  })) : [{ item_id: '', quantity: 1, rate: 0, hsn_code: '', gst_rate: 18, unit: 'Nos', discount_percent: 0, purchase_request_item_id: null, details: '' }];
  renderPOLines();
  window.showVendorsForPOLines();
};
window.addPO = async () => {
  try {
    const r = await api('/purchase/orders', { method: 'POST', body: JSON.stringify({
      purchase_request_id: val('po-pr') || null,
      vendor_id: val('po-vendor'), lines: PO_LINES,
      delivery_date: val('po-delivery'), payment_terms: val('po-payment-terms') || null,
      company_address_id: val('po-bill-address') || null,
      company_ship_address_id: val('po-ship-address') || null,
      ld_percentage: val('po-ld-pct') || null, ld_cap_percentage: val('po-ld-cap') || null, ld_trigger_notes: val('po-ld-notes') || null,
      freight: val('po-freight') || 0, freight_gst_rate: val('po-freight-gst') || 18,
      freight_notes: val('po-freight-notes') || null, general_notes: val('po-general-notes') || null,
    })});
    alert(`Purchase Order ${r.po_no} saved as a Draft - review it below (Download PDF/Word for a preview, or Edit to make changes), then click Submit for Approval when it's ready. It can't be sent to the vendor or received against until approved.`);
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};
function poTermsForm(o) {
  return `<div class="form-grid" style="margin-top:8px;">
    <div><label>Promised Delivery Date</label><input id="po-terms-delivery-${o.id}" type="date" value="${o.delivery_date || ''}"></div>
    <div><label>Payment Terms</label><select id="po-terms-payment-${o.id}"><option value="">-</option>${(window.__PO_PAYMENT_TERMS||[]).map(t => `<option value="${esc(t)}" ${t===o.payment_terms?'selected':''}>${esc(t)}</option>`).join('')}</select></div>
  </div>
  <div class="form-grid" style="margin-top:8px;">
    <div><label>LD Rate (%)</label><input id="po-terms-ldpct-${o.id}" type="number" step="0.01" value="${o.ld_percentage ?? ''}"></div>
    <div><label>LD Cap (%)</label><input id="po-terms-ldcap-${o.id}" type="number" step="0.01" value="${o.ld_cap_percentage ?? ''}"></div>
    <div><label>Trigger Conditions/Notes</label><textarea id="po-terms-ldnotes-${o.id}" rows="2">${esc(o.ld_trigger_notes || '')}</textarea></div>
  </div>
  <div class="form-grid" style="margin-top:8px;">
    <div><label>Freight (₹)</label><input id="po-terms-freight-${o.id}" type="number" value="${o.freight || 0}"></div>
    <div><label>Freight GST (%)</label><input id="po-terms-freight-gst-${o.id}" type="number" value="${o.freight_gst_rate ?? 18}"></div>
    <div><label>Freight Comments</label><textarea id="po-terms-freight-notes-${o.id}" rows="2">${esc(o.freight_notes || '')}</textarea></div>
  </div>
  <div style="margin-top:8px;"><label>General Notes</label><textarea id="po-terms-general-notes-${o.id}" rows="2" style="width:100%;">${esc(o.general_notes || '')}</textarea></div>
  <button class="btn small" type="button" onclick="savePOTerms(${o.id})" style="margin-top:8px;">Save Terms</button>
  <p class="muted" style="margin-top:6px;">These apply to the whole PO - every line item shares one delivery date, payment terms, LD clause and freight.</p>`;
}
window.togglePOTerms = (id) => {
  const row = document.getElementById(`po-terms-row-${id}`);
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : '';
  if (!showing && !row.dataset.built) {
    const o = (window.__PO_ORDERS_CACHE || []).find(x => x.id === id);
    if (o) document.getElementById(`po-terms-body-${id}`).innerHTML = poTermsForm(o);
    row.dataset.built = '1';
  }
};
window.savePOTerms = async (id) => {
  try {
    await api(`/purchase/orders/${id}/commercial-terms`, { method: 'PATCH', body: JSON.stringify({
      delivery_date: val(`po-terms-delivery-${id}`) || null,
      payment_terms: val(`po-terms-payment-${id}`) || null,
      ld_percentage: val(`po-terms-ldpct-${id}`) || null,
      ld_cap_percentage: val(`po-terms-ldcap-${id}`) || null,
      ld_trigger_notes: val(`po-terms-ldnotes-${id}`) || null,
      freight: val(`po-terms-freight-${id}`) || 0, freight_gst_rate: val(`po-terms-freight-gst-${id}`) || 18,
      freight_notes: val(`po-terms-freight-notes-${id}`) || null, general_notes: val(`po-terms-general-notes-${id}`) || null,
    })});
    navigate('purchase-orders');
  } catch (e) { alert(e.message); }
};

// ---- RFQ Dashboard (cross-PR view, 2026-10-19) ----
// Every per-PR RFQ composer (the "Quotes / RFQ" button on Purchase Requests)
// stays untouched and still sends immediately - this is a separate,
// system-wide list of every RFQ ever created (Draft/Sent/Closed), backed by
// GET /purchase/rfqs, plus a standalone "Create RFQ" flow that supports
// saving a Draft before anything is actually emailed.
let RFQD_VENDORS_CACHE = null;
function rfqStatusBadge(s) { return badge(s); }
PAGES['rfq-dashboard'] = async (el) => {
  const [rfqs] = await Promise.all([api('/purchase/rfqs').catch(() => []), loadRFQDVendors()]);
  window.__RFQD_CACHE = rfqs;
  const row = (r) => `<tr>
      <td>${esc(r.purchase_request_no) || '-'}</td>
      <td>${esc(r.subject)}</td>
      <td>${rfqStatusBadge(r.status)}</td>
      <td>${r.target_vendor_count}</td>
      <td>${esc(r.created_by_name) || '-'}</td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
      <td>${actionButtonsCell(rfqDashboardActions(r))}</td>
    </tr>`;
  el.innerHTML = collapsiblePanel('rfq-dashboard-list', `RFQs (${rfqs.length})`, `
    <p class="muted">New RFQs are created from an approved Purchase Request (Purchase Requests &rarr; Quotes / RFQ). This list is the cross-request overview.</p>
    <button class="btn small outline" type="button" onclick="navigate('purchase-requests')" style="margin-bottom:10px;">Go to Purchase Requests</button>
    ${renderListSearch('rfq-dashboard', rfqs, ['purchase_request_no', 'subject', 'status', 'created_by_name'], (rowsFiltered) => {
      const bodyEl = document.getElementById('rfq-dashboard-tbody');
      if (bodyEl) bodyEl.innerHTML = rowsFiltered.map(row).join('') || `<tr><td colspan="7" class="muted">No RFQs yet.</td></tr>`;
    })}
    <div style="overflow-x:auto;">
    <table>
      <thead><tr><th>Purchase Request</th><th>Subject</th><th>Status</th><th>Target Vendors</th><th>Created By</th><th>Date</th><th></th></tr></thead>
      <tbody id="rfq-dashboard-tbody">${rfqs.map(row).join('') || `<tr><td colspan="7" class="muted">No RFQs yet.</td></tr>`}</tbody>
    </table>
    </div>
  `);
};
// Purchase Velocity: stat-card matrix, each card drills into its per-record
// rows (lazy-loaded once, collapsed by default).
const PV_CARDS = [
  { key: 'pr_po', title: 'PR → PO', sub: 'Purchase Request raised to first PO created', waiting: 'approved PRs with no PO yet' },
  { key: 'po_approval', title: 'PO → Approval', sub: 'PO submitted to final approval', waiting: 'POs awaiting approval' },
  { key: 'po_grn', title: 'PO → GRN', sub: 'PO approved to first receipt', waiting: 'approved POs with nothing received' },
];
const pvDays = (d) => (d == null ? '-' : Number(d).toFixed(1) + ' d');
PAGES['purchase-velocity'] = async (el) => {
  const r = window.__PV_RANGE || {};
  const d = await api('/purchase/velocity' + (r.from ? `?from=${r.from}&to=${r.to}` : ''));
  window.__PV_RANGE = { from: d.from, to: d.to };
  const cards = PV_CARDS.map((c) => {
    const m = d.metrics[c.key];
    const full = c.key === 'po_grn' ? `<div class="muted">Full receipt: ${pvDays(m.full.avg)} avg (${m.full.count} PO${m.full.count === 1 ? '' : 's'})</div>` : '';
    return `<div class="panel" style="cursor:pointer;margin:0;" tabindex="0" role="button" onclick="togglePvDrill('${c.key}')" onkeydown="if(event.key==='Enter')togglePvDrill('${c.key}')">
      <div class="muted">${c.title}</div>
      <div style="font-size:30px;font-weight:600;">${pvDays(m.avg)}</div>
      <div class="muted">${esc(c.sub)}</div>
      <div>${m.count} completed · slowest ${pvDays(m.max)}</div>
      ${full}
      <div>${m.in_flight} in flight <span class="muted">(${esc(c.waiting)})</span></div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="panel">
    <div class="form-grid">
      <div><label>From</label><input type="date" id="pv-from" value="${d.from}"></div>
      <div><label>To</label><input type="date" id="pv-to" value="${d.to}"></div>
    </div>
    <button class="btn small" type="button" onclick="applyPvRange()">Apply</button>
    <p class="muted">Per PO number (not per line). Draft, Cancelled and Rejected POs are excluded. Click a card for the underlying records.</p>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:12px;">${cards}</div>
  ${PV_CARDS.map((c) => `<div id="pv-drill-${c.key}" style="display:none;"></div>`).join('')}
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:12px;">
    <div class="panel" style="margin:0;">
      <div class="muted">Open Purchase Orders</div>
      <div style="font-size:14px;margin:4px 0 8px;">Every not-yet-fully-received PO line, across all time.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn small" type="button" onclick="togglePvOpenPos()">View Report</button>
        <button class="btn small outline" type="button" onclick="downloadTemplateFile('/purchase/velocity/open-pos/export.xlsx','Open_POs.xlsx')">Export Excel</button>
        <button class="btn small outline" type="button" onclick="downloadTemplateFile('/purchase/velocity/open-pos/export.pptx','Open_POs_Summary.pptx')">Export PPT</button>
      </div>
    </div>
    <div class="panel" style="margin:0;">
      <div class="muted">Open Purchase Requests</div>
      <div style="font-size:14px;margin:4px 0 8px;">Draft / Pending Quotes / Pending, across all time.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn small" type="button" onclick="togglePvOpenPrs()">View Report</button>
        <button class="btn small outline" type="button" onclick="downloadTemplateFile('/purchase/velocity/open-prs/export.xlsx','Open_PRs.xlsx')">Export Excel</button>
      </div>
    </div>
  </div>
  <div id="pv-open-pos" style="display:none;"></div>
  <div id="pv-open-prs" style="display:none;"></div>`;
};
window.togglePvOpenPos = async () => {
  const box = document.getElementById('pv-open-pos');
  if (!box) return;
  const open = box.style.display === 'none';
  box.style.display = open ? '' : 'none';
  if (!open || box.dataset.built) return;
  box.dataset.built = '1';
  box.innerHTML = '<div class="panel muted">Loading...</div>';
  try {
    const { rows } = await api('/purchase/velocity/open-pos');
    const day = (s) => (s ? esc(String(s).slice(0, 10)) : '-');
    const body = rows.map((r) => `<tr>
      <td>${esc(r.po_no)}</td><td>${day(r.po_date)}</td><td>${badge(r.status)}</td><td>${r.line_no}</td>
      <td>${esc(r.item_code) || '-'}</td><td>${esc(r.item_description) || '-'}</td><td>${r.item_qty}</td><td>${r.received_qty}</td>
      <td>${esc(r.vendor_name) || '-'}</td><td>${esc(r.vendor_address) || '-'}</td><td>${esc(r.vendor_phone) || '-'}</td><td>${esc(r.vendor_email) || '-'}</td>
      <td>${day(r.delivery_date)}</td><td ${r.delay_days > 0 ? 'style="color:#dc2626;font-weight:700;"' : ''}>${r.delay_days}</td>
    </tr>`).join('');
    box.innerHTML = `<div class="panel"><h3>Open Purchase Orders (${rows.length} line${rows.length === 1 ? '' : 's'})</h3>
      <div style="overflow-x:auto;"><table><thead><tr>
        <th>PO No.</th><th>PO Date</th><th>PO Status</th><th>Line No.</th><th>Item Code</th><th>Item Description</th>
        <th>Item Qty</th><th>Received Qty</th><th>Vendor Name</th><th>Vendor Address</th><th>Vendor Ph. No.</th><th>Vendor Email</th>
        <th>Promised Dispatch Date</th><th>Delay Days</th>
      </tr></thead><tbody>${body || '<tr><td colspan="14" class="muted">None.</td></tr>'}</tbody></table></div></div>`;
  } catch (e) {
    box.dataset.built = '';
    box.innerHTML = `<div class="panel">Could not load: ${esc(e.message)}</div>`;
  }
};
window.togglePvOpenPrs = async () => {
  const box = document.getElementById('pv-open-prs');
  if (!box) return;
  const open = box.style.display === 'none';
  box.style.display = open ? '' : 'none';
  if (!open || box.dataset.built) return;
  box.dataset.built = '1';
  box.innerHTML = '<div class="panel muted">Loading...</div>';
  try {
    const { rows } = await api('/purchase/velocity/open-prs');
    const day = (s) => (s ? esc(String(s).slice(0, 10)) : '-');
    const body = rows.map((r) => `<tr>
      <td>${esc(r.pr_no)}</td><td>${badge(r.status)}</td><td>${esc(r.item_code) || '-'}</td><td>${esc(r.item_description) || '-'}</td>
      <td>${esc(r.details) || '-'}</td><td>${esc(r.unit) || '-'}</td><td>${r.quantity}</td><td>${r.estimated_value != null ? fmt(r.estimated_value) : '-'}</td>
      <td>${day(r.created_at)}</td><td>${r.days_pending != null ? r.days_pending : '-'}</td>
      <td>${esc(r.created_by) || '-'}</td><td>${esc(r.department) || '-'}</td><td>${esc(r.project) || '-'}</td>
    </tr>`).join('');
    box.innerHTML = `<div class="panel"><h3>Open Purchase Requests (${rows.length} item${rows.length === 1 ? '' : 's'})</h3>
      <div style="overflow-x:auto;"><table><thead><tr>
        <th>PR No.</th><th>Status</th><th>Item Code</th><th>Item Description</th><th>Details</th><th>Unit</th><th>Qty</th><th>Est. Value</th>
        <th>PR Creation Date</th><th>Days Pending</th><th>Created By</th><th>Department</th><th>Project</th>
      </tr></thead><tbody>${body || '<tr><td colspan="13" class="muted">None.</td></tr>'}</tbody></table></div></div>`;
  } catch (e) {
    box.dataset.built = '';
    box.innerHTML = `<div class="panel">Could not load: ${esc(e.message)}</div>`;
  }
};
window.applyPvRange = () => {
  window.__PV_RANGE = { from: document.getElementById('pv-from').value, to: document.getElementById('pv-to').value };
  navigate('purchase-velocity');
};
window.togglePvDrill = async (key) => {
  const box = document.getElementById('pv-drill-' + key);
  if (!box) return;
  const open = box.style.display === 'none';
  box.style.display = open ? '' : 'none';
  if (!open || box.dataset.built) return;
  box.dataset.built = '1';
  box.innerHTML = '<div class="panel muted">Loading...</div>';
  try {
    const { from, to } = window.__PV_RANGE;
    const x = await api(`/purchase/velocity/drill?metric=${key}&from=${from}&to=${to}`);
    const day = (s) => (s ? esc(String(s).slice(0, 10)) : '-');
    const rows = (list, withFull) => list.map((i) => `<tr><td>${esc(i.ref)}</td><td>${esc(i.vendor_name) || '-'}</td><td>${esc(i.pr_no) || '-'}</td><td>${day(i.start)}</td><td>${day(i.end)}</td><td>${pvDays(i.days)}</td>${withFull ? `<td>${pvDays(i.full_days)}</td>` : ''}</tr>`).join('');
    const head = (withFull) => `<thead><tr><th>Ref</th><th>Vendor</th><th>PR</th><th>Start</th><th>End</th><th>Days</th>${withFull ? '<th>To full receipt</th>' : ''}</tr></thead>`;
    const withFull = key === 'po_grn';
    box.innerHTML = `<div class="panel"><h3>${esc(PV_CARDS.find((c) => c.key === key).title)} — completed (slowest first)</h3>
      <div style="overflow-x:auto;"><table>${head(withFull)}<tbody>${rows(x.done, withFull) || '<tr><td colspan="7" class="muted">None in range.</td></tr>'}</tbody></table></div>
      <h3>In flight (waiting longest first)</h3>
      <div style="overflow-x:auto;"><table>${head(false)}<tbody>${rows(x.in_flight, false) || '<tr><td colspan="6" class="muted">None.</td></tr>'}</tbody></table></div></div>`;
  } catch (e) {
    box.dataset.built = '';
    box.innerHTML = `<div class="panel">Could not load: ${esc(e.message)}</div>`;
  }
};
// ERP-wide "pending items outside of aligned dates" dashboard (2026-11-07) -
// one collapsed-by-default panel per source (lib/overdueItems.js's
// registry), each listing every row of that type whose own stored target
// date has already passed while it's still open. Deliberately covers only
// entity types with a genuine target-date field - Purchase Requests/Leave
// Requests/RFQ/etc. have no such field and already have their own
// approval-queue-age SLA coverage elsewhere (My Approvals/escalation mail).
PAGES['overdue-items'] = async (el) => {
  const d = await api('/reports/overdue-items');
  const sources = Object.entries(d.bySource);
  const summaryCards = sources.map(([name, rows]) => `<div class="panel" style="margin:0;${rows.length ? 'border-color:#dc2626;' : ''}">
    <div class="muted">${esc(name)}</div>
    <div style="font-size:26px;font-weight:600;${rows.length ? 'color:#dc2626;' : ''}">${rows.length}</div>
  </div>`).join('');
  const panels = sources.map(([name, rows]) => {
    const key = 'overdue-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const body = rows.length
      ? `<div style="overflow-x:auto;"><table><thead><tr><th>Reference</th><th>Label</th><th>Target Date</th><th>Days Overdue</th><th>Detail</th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${esc(r.ref) || '-'}</td><td>${esc(r.label)}</td><td>${esc(String(r.target_date).slice(0, 10))}</td>
            <td style="color:#dc2626;font-weight:700;">${r.days_overdue}</td><td>${esc(r.detail) || '-'}</td></tr>`).join('')}
         </tbody></table></div>`
      : '<p class="muted">Nothing overdue.</p>';
    return collapsiblePanel(key, `${esc(name)} (${rows.length})`, body);
  }).join('');
  el.innerHTML = `<div class="panel">
    <p class="muted">Every item, across the whole ERP, that is still open/pending and whose own stored target date has already passed - Purchase Order delivery dates, Job Card planned completion, Foreign Payment compliance dates, Bank Guarantee expiry, To-Do target dates, Referral Incentive probation end, Sales Order promised delivery, and Purchase Invoice payment due dates. Entities with no real target-date field (Purchase Requests, Leave Requests, RFQ, etc.) aren't listed here - they're already covered by My Approvals' own SLA/escalation mail.</p>
    <button class="btn small outline" type="button" onclick="downloadTemplateFile('/reports/overdue-items/export.xlsx','Overdue_Items.xlsx')">Export Excel</button>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:12px;">${summaryCards}</div>
  ${panels}`;
};
function rfqDashboardActions(r) {
  const btns = [];
  if (r.status === 'Draft') {
    btns.push(`<button class="btn small outline" type="button" onclick="goToPRQuotes(${r.purchase_request_id})">Open in PR</button>`);
    btns.push(`<button class="btn small" type="button" onclick="sendDraftRFQ(${r.id})">Send Now</button>`);
    btns.push(`<button class="btn small outline" type="button" onclick="deleteDraftRFQ(${r.id})">Delete</button>`);
  } else if (r.status === 'Sent') {
    btns.push(`<button class="btn small outline" type="button" onclick="closeRFQ(${r.id})">Close</button>`);
  }
  if (r.status === 'Sent' || r.status === 'Closed') btns.push(`<button class="btn small green" type="button" onclick="openRFQComparison(${r.id})">Compare Quotes</button>`);
  btns.push(`<button class="btn small outline" type="button" onclick="viewRFQRecipients(${r.id})">Recipients</button>`);
  return actionButtonsCell(btns.join(''));
}
// Side-by-side vendor quotation matrix (portal responses), 2026-10-20.
// Lowest unit rate per item and the lowest overall total are green.
window.openRFQComparison = async (id) => {
  openAppModal('Compare Quotes', '<span class="muted">Loading...</span>');
  let d;
  try { d = await api('/purchase/rfqs/' + id + '/comparison'); }
  catch (e) { return openAppModal('Compare Quotes', '<div class="msg err" style="display:block;">' + esc(e.message) + '</div>'); }
  const G = 'background:#dcfce7;font-weight:bold;';
  const vs = d.vendors;
  const head = vs.map(v => '<th style="min-width:130px;">' + esc(v.name) + (v.responded ? '' : '<br><span class="muted" style="font-weight:normal;">Awaiting response</span>') + '</th>').join('');
  const rows = d.items.map(it => '<tr><td style="position:sticky;left:0;background:#fff;"><b>' + esc(it.name) + '</b>' + (it.details ? '<br><small class="muted">(' + esc(it.details) + ')</small>' : '') + '<br><span class="muted">' + esc(it.quantity) + ' ' + esc(it.unit) + '</span></td>' +
    vs.map(v => {
      const l = v.lines[it.id];
      if (!l) return '<td class="muted">-</td>';
      if (l.declined) return '<td style="color:#b91c1c;">Declined' + (l.decline_reason ? '<br><span class="muted" style="font-weight:normal;color:#b91c1c;">' + esc(l.decline_reason) + '</span>' : '') + '</td>';
      const low = it.lowest_rate_vendor_ids.includes(v.vendor_id);
      return '<td style="' + (low ? G : '') + '">₹' + fmt(l.unit_rate) + '<br><span class="muted" style="font-weight:normal;">' + esc(l.lead_days) + ' days · ₹' + fmt(l.subtotal) + '</span></td>';
    }).join('') + '</tr>').join('');
  const totals = '<tr><td style="position:sticky;left:0;background:#fff;"><b>Total</b></td>' + vs.map(v => v.responded
    ? '<td style="' + (v.is_lowest_total ? G : 'font-weight:bold;') + '">₹' + fmt(v.total) + '<br><span class="muted" style="font-weight:normal;">Max lead ' + esc(v.max_lead_days) + ' days</span></td>'
    : '<td class="muted">-</td>').join('') + '</tr>';
  const remarks = '<tr><td style="position:sticky;left:0;background:#fff;"><b>Remarks</b></td>' + vs.map(v => '<td style="font-size:12px;white-space:pre-wrap;">' + esc(v.remarks || '') + '</td>').join('') + '</tr>';
  openAppModal('Compare Quotes - ' + d.rfq.reference,
    vs.length ? '<div style="overflow-x:auto;max-width:100%;"><table><thead><tr><th style="position:sticky;left:0;background:#fff;">Item</th>' + head + '</tr></thead><tbody>' + rows + totals + remarks + '</tbody></table></div>' +
      '<p class="muted" style="margin-top:8px;">Green = lowest unit rate per item / lowest overall total. Each cell: unit rate, then lead time and line total.</p>'
      : '<p class="muted">No vendors on this RFQ.</p>');
};
window.viewRFQRecipients = (id) => {
  const r = (window.__RFQD_CACHE || []).find(x => x.id === id);
  if (!r) return;
  const vendorLines = (r.vendor_ids || []).map(vid => {
    const v = (RFQD_VENDORS_CACHE || []).find(x => x.id === vid);
    return v ? esc(v.name) : `Vendor #${vid}`;
  });
  const lines = [...vendorLines, ...(r.extra_emails || [])];
  openAppModal('Recipients — ' + esc(r.subject), lines.length
    ? `<ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>`
    : `<p class="muted">No recipients recorded${r.status === 'Draft' ? ' yet - this is still a Draft.' : '.'}</p>`);
};
const afterRFQChange = (prId) => (prId ? renderRFQHistory(prId) : navigate('rfq-dashboard'));
window.closeRFQ = async (id, prId) => {
  if (!confirm('Close this RFQ? No more quotes are expected against it once closed.')) return;
  try { await api(`/purchase/rfqs/${id}/close`, { method: 'POST' }); afterRFQChange(prId); }
  catch (e) { alert(e.message); }
};
window.sendDraftRFQ = async (id, prId) => {
  if (!confirm('Send this RFQ now? This will email every targeted vendor/address.')) return;
  try {
    const r = await api(`/purchase/rfqs/${id}/send`, { method: 'POST' });
    const anyFailed = (r.results || []).some(x => x.email_status === 'Failed' || x.email_status === 'NoEmail');
    alert(anyFailed
      ? 'Sent, but some recipients failed:\n' + r.results.map(x => `${x.vendor_name || x.email}: ${x.email_status}${x.email_error ? ' - ' + x.email_error : ''}`).join('\n')
      : 'RFQ sent to every recipient.');
    afterRFQChange(prId);
  } catch (e) { alert(e.message); }
};
window.deleteDraftRFQ = async (id, prId) => {
  if (!confirm('Delete this Draft RFQ? This cannot be undone.')) return;
  try { await api(`/purchase/rfqs/${id}`, { method: 'DELETE' }); afterRFQChange(prId); }
  catch (e) { alert(e.message); }
};

async function loadRFQDVendors() {
  if (!RFQD_VENDORS_CACHE) RFQD_VENDORS_CACHE = await api('/masters/vendors').catch(() => []);
  return RFQD_VENDORS_CACHE;
}
// Opens the Purchase Requests page with this PR's Quotes / RFQ accordion expanded.
window.goToPRQuotes = (prId) => {
  navigate('purchase-requests');
  let tries = 0;
  const t = setInterval(() => {
    if (document.getElementById('pr-quotes-row-' + prId)) { clearInterval(t); togglePRQuotes(prId); }
    else if (++tries > 30) clearInterval(t);
  }, 150);
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
  const itemPanels = {
    'add-item': `
    <div class="panel"><h3>Add Item Master</h3>
      <div class="form-grid">
        <div><label>Name</label><input id="it-name"></div>
        <div><label>Unit</label><input id="it-unit" value="Nos"></div>
        <div><label>Category</label><input id="it-cat"></div>
        <div><label>HSN Code</label><input id="it-hsn"></div>
        <div><label>Rack / Location</label><input id="it-loc"></div>
        <div><label>Reorder Level</label><input id="it-reorder" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addItem()">Add Item</button>
      <div class="muted" style="margin-top:8px;">Item Code and barcode (EAN-13, internal-use 20-prefix range) are both generated automatically for every item.</div>
    </div>`,
    'pending-review': pendingItems.length ? collapsiblePanel('pending-item-review', `Pending Item Master Review (${pendingItems.length})`, `
      <p class="muted">These were typed freehand on a Purchase Request instead of picked from the master. Complete the details and Approve - typically while receiving the goods - to add them to the permanent Item Master (a barcode is generated at that point).</p>
      <div id="pending-items-body"></div>
    `) : '',
    'pending-changes': pendingChanges.length ? `<div class="panel"><h3>Pending Item Changes (${pendingChanges.length})</h3>
      <p class="muted">An edit or delete on an existing item doesn't take effect until an Admin approves it here, so nothing changes underneath a transaction already using the item's current details.</p>
      ${tableHTML(['Item', 'Change', 'Details', 'Requested By', ''], pendingChanges, c => `
        <tr><td>${esc(c.item_code)||''} ${esc(c.item_name)}</td><td>${badge(c.change_type)}</td>
        <td>${c.change_type === 'Edit' ? esc(Object.entries(JSON.parse(c.proposed_fields||'{}')).map(([k,v]) => `${k}: ${v}`).join(', ')) : '<span class="muted">Delete this item</span>'}</td>
        <td>${esc(c.requested_by_name)||'-'}</td>
        <td>${ME.role === 'Admin' ? actionButtonsCell(`<button class="btn small" type="button" onclick="approveItemChange(${c.id})">Approve</button>
          <button class="btn small outline" type="button" onclick="rejectItemChange(${c.id})">Reject</button>`) : '<span class="muted">Awaiting Admin</span>'}</td></tr>`)}
    </div>` : '',
    'bulk-upload': `
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per item, then upload it. Barcodes are generated automatically - don't include them in the file.</p>
      <button class="btn outline" type="button" onclick="downloadItemTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('it-upload-file')}
      <button class="btn" onclick="uploadItemTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="it-upload-result" style="margin-top:10px;"></div>
    </div>`,
    'list': collapsiblePanel('item-master-list', `<span id="im-count">Item Master (${approvedItems.length})</span>`, `
      ${renderListSearch('item-master', approvedItems, ['item_code', 'name', 'unit', 'category', 'location', 'barcode', 'hsn_code', 'status'], (rows) => {
        document.getElementById('im-table-wrap').innerHTML = itemMasterRowsHTML(rows);
        document.getElementById('im-count').textContent = 'Item Master (' + rows.length + ')';
      }, 'Search items by code, name, category, location, barcode...')}
      <div id="im-table-wrap">${itemMasterRowsHTML(approvedItems)}</div>
    `),
  };
  const itemLabels = { 'add-item': 'Add Item Master', 'pending-review': 'Pending Item Master Review', 'pending-changes': 'Pending Item Changes', 'bulk-upload': 'Bulk Upload via Excel Template', 'list': 'Item Master List' };
  const itemOrder = await fetchPanelOrder('store', Object.keys(itemPanels));
  el.innerHTML = reorderablePanelsHTML('store', itemPanels, itemOrder, itemLabels);
  if (pendingItems.length) renderPendingItemsPanel(pendingItems);
}
function itemMasterRowsHTML(rows) {
  return tableHTML(['Code', 'Name', 'Unit', 'Category', 'Location', 'Stock', 'Reorder Level', 'Barcode', 'Status', ''], rows, i => `
        <tr><td>${esc(i.item_code)}</td><td>${esc(i.name)}</td><td>${esc(i.unit)}</td><td>${esc(i.category)||'-'}</td><td>${esc(i.location)||'-'}</td>
          <td>${i.current_stock}${i.current_stock <= i.reorder_level ? ' ⚠️' : ''}</td><td>${i.reorder_level}</td>
          <td><span class="mono" style="letter-spacing:1px;">${esc(i.barcode)||'-'}</span></td>
          <td>${i.status === 'Discontinued' ? badge('Discontinued') : ''}</td>
          <td>${actionButtonsCell((i.status === 'Discontinued'
            ? (ME.role === 'Admin' ? `<button class="btn small outline" type="button" onclick="reactivateItem(${i.id})">Reactivate</button>` : '')
            : `<button class="btn small outline" type="button" onclick="openEditItem(${i.id})">Edit</button>
               <button class="btn small outline" type="button" onclick="deleteItem(${i.id})">Delete</button>`)
               + `<button class="btn small outline" type="button" onclick="showItemPriceHistory(${i.id})">Price History</button>`)}</td></tr>`);
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
// Edit Item (2026-10-13: converted from a bottom-of-page scroll-to panel to
// the generic popup - see openEditVendor's own comment for why).
window.openEditItem = (id) => {
  const i = (window.__ITEM_CACHE || []).find(x => x.id === id);
  if (!i) return;
  openAppModal('Edit Item — ' + esc(i.name), `
    <div class="form-grid">
      <div><label>Item Code</label><input id="ie-code" value="${esc(i.item_code)}"></div>
      <div><label>Name</label><input id="ie-name" value="${esc(i.name)}"></div>
      <div><label>Unit</label><input id="ie-unit" value="${esc(i.unit)}"></div>
      <div><label>Category</label><input id="ie-cat" value="${esc(i.category)}"></div>
      <div><label>HSN Code</label><input id="ie-hsn" value="${esc(i.hsn_code)}"></div>
      <div><label>Rack / Location</label><input id="ie-loc" value="${esc(i.location)}"></div>
      <div><label>Reorder Level</label><input id="ie-reorder" type="number" value="${i.reorder_level||0}"></div>
    </div>
    <button class="btn" id="ie-save-btn" onclick="saveEditItem(${id})">Save Changes</button>
    <div class="muted" style="margin-top:8px;">${ME.role === 'Admin' ? 'As Admin, this applies immediately.' : "This won't take effect until an Admin approves it - see Pending Item Changes above."}</div>
    <div id="ie-err" class="msg err" style="display:none;margin-top:8px;"></div>`);
};
window.saveEditItem = async (id) => {
  const errEl = document.getElementById('ie-err');
  try {
    const r = await api('/masters/items/' + id, { method: 'PUT', body: JSON.stringify({
      item_code: val('ie-code'), name: val('ie-name'), unit: val('ie-unit'), category: val('ie-cat'),
      hsn_code: val('ie-hsn'), location: val('ie-loc'), reorder_level: val('ie-reorder'),
    })});
    if (r.message) alert(r.message);
    confirmSavedThenClose('ie-save-btn', 'store');
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
    const r = await api('/masters/items', { method: 'POST', body: JSON.stringify({
      name: val('it-name'), unit: val('it-unit'), category: val('it-cat'),
      hsn_code: val('it-hsn'), location: val('it-loc'), reorder_level: val('it-reorder')
    })});
    alert(`Item added - assigned Item Code ${r.item_code}.`);
    navigate('store');
  } catch (e) { alert(e.message); }
};
window.downloadItemTemplate = () => downloadTemplateFile('/masters/items/template', 'item_master_upload_template.xlsx');
window.uploadItemTemplate = () => uploadTemplateFile('/masters/items/bulk-upload', 'it-upload-file', 'it-upload-result', () => navigate('store'));

// ---- Sheet 2: Stock In / Out ----
// Renders as two tabs (Receive / Issue to Production), same tab-bar pattern
// as the Offer Builder - CURRENT_STOCK_TAB persists across navigate()
// reloads (e.g. right after receiving/issuing something) so the user isn't
// bounced back to Receive every time.
let CURRENT_STOCK_TAB = 'receive';
function stockItemOptions(selectedId, items) {
  return items.length
    ? items.map(i => `<option value="${i.id}" ${selectedId && Number(selectedId) === i.id ? 'selected' : ''}>${esc(i.name)}${i.item_code ? ' (' + esc(i.item_code) + ')' : ''} - stock: ${i.current_stock}</option>`).join('')
    : '<option value="">- No items -</option>';
}
// A multi-line PO is several purchase_orders rows sharing one po_no (see
// routes/purchase.js) - GET /purchase/orders returns that flat per-line
// list, so it's grouped back into one entry per po_no here rather than
// showing each line as its own confusingly-similar dropdown option (the
// exact bug reported: a 2-line PO showed as 2 separate, easy-to-miss-the-
// other-one options).
function groupPOsByNo(openPOs) {
  const map = new Map();
  for (const po of openPOs) {
    if (!map.has(po.po_no)) map.set(po.po_no, { po_no: po.po_no, vendor_name: po.vendor_name, lines: [] });
    map.get(po.po_no).lines.push(po);
  }
  return Array.from(map.values());
}
function poGroupOptions(selectedPoNo, groups) {
  return `<option value="">- Not against a PO -</option>` +
    groups.map(g => `<option value="${esc(g.po_no)}" ${selectedPoNo === g.po_no ? 'selected' : ''}>${esc(g.po_no)} - ${esc(g.vendor_name)} (${g.lines.length} item${g.lines.length > 1 ? 's' : ''})</option>`).join('');
}
function poGroupMatch(g, q) {
  return (g.po_no || '').toLowerCase().includes(q) || (g.vendor_name || '').toLowerCase().includes(q) ||
    g.lines.some(l => (l.item_name || '').toLowerCase().includes(q));
}
async function renderStockInOutSheet(el) {
  // Previously 4 sequential awaits (6 total round trips once fetchPanelOrder's
  // own read is counted) - total wait time was their SUM, not their MAX. Same
  // fix already applied to Purchase Requests/Orders on 2026-10-04.
  const [itemsRaw, movements, posRaw, projects, departments, clients, grns, materialRequests] = await Promise.all([
    api('/masters/items'), api('/purchase/store/movements'), api('/purchase/orders'),
    api('/projects'), api('/masters/departments'), api('/masters/clients'),
    api('/purchase/store/grn-reconciliations'), api('/purchase/store/material-requests'),
  ]);
  const items = itemsRaw.filter(i => !['Pending', 'Discontinued'].includes(i.status));
  const openPOs = posRaw.filter(o => ['Open', 'PartiallyReceived'].includes(o.status));
  window.__STOCK_ITEMS = items;
  window.__GROUPED_POS = groupPOsByNo(openPOs);
  window.__STOCK_PROJECTS = projects;
  window.__STOCK_DEPARTMENTS = departments;
  window.__STOCK_CLIENTS = clients;
  window.__STOCK_GRNS = grns;
  const stockTabs = [['receive', 'Receive (IN)'], ['issue', 'Issue to Production (OUT)']];
  const stockPanels = {
    'scan-barcode': `
    <div class="panel"><h3>Scan Barcode</h3>
      <p class="muted">Click into the box and scan with a USB/Bluetooth barcode scanner (or type the code and press Enter) - it will select the matching item below.</p>
      <input id="st-scan" placeholder="Scan or type barcode, then press Enter" style="font-size:16px;padding:10px;width:320px;" autocomplete="off">
      <div id="st-scan-result" style="margin-top:8px;"></div>
    </div>`,
    'stock-in-out': `
    <div class="panel">
      <h3>Stock In / Out</h3>
      ${!items.length ? `<div class="msg err">No items in the Item Master yet - add one under <a href="#" onclick="navigate('store');return false;">Item Master</a> before recording a stock movement.</div>` : ''}
      <div class="tabs" id="stock-panel-tabs">${stockTabs.map(([id, label]) => `<div class="tab ${CURRENT_STOCK_TAB === id ? 'active' : ''}" data-tab-id="${id}" onclick="switchStockTab('${id}')">${label}</div>`).join('')}</div>
      <div id="stock-tab-content"></div>
    </div>`,
    'bulk-upload': `
    <div class="panel"><h3>Bulk Upload via Excel Template</h3>
      <p class="muted">Download the template, fill in one row per movement (item code or barcode, IN/OUT, quantity), then upload it.</p>
      <button class="btn outline" type="button" onclick="downloadStockTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('st-upload-file')}
      <button class="btn" onclick="uploadStockTemplate()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="st-upload-result" style="margin-top:10px;"></div>
    </div>`,
    'recent-movements': collapsiblePanel('recent-movements', 'Recent Movements', `
      ${tableHTML(['Item', 'Type', 'Qty', 'Department', 'Customer', 'Reference', 'Date'], movements.slice(0, 30), m => `
        <tr><td>${esc(m.item_name)}</td><td>${badge(m.movement_type === 'IN' ? 'Approved' : 'Pending')}${m.movement_type}</td><td>${m.quantity}</td>
          <td>${esc(m.department_name)||'-'}</td><td>${esc(m.client_name)||'-'}</td><td>${esc(m.po_no || m.project_code || m.reference)||''}</td><td>${new Date(m.moved_at).toLocaleString()}</td></tr>`)}
    `),
    'grn-reconciliation': collapsiblePanel('grn-reconciliation', `GRN Reconciliation (${grns.length})`, `
      <p class="muted">Every PO-line receipt goes to the Store HOD/Supervisor to reconcile the PO against the vendor's own invoice (My Approvals) before that quantity can be billed in Purchase Invoices (AP). Attach the vendor's invoice copy here if it wasn't uploaded at receiving time.</p>
      ${tableHTML(['PO No', 'Item', 'Vendor', 'Received Qty', 'PO Rate', 'Vendor Invoice', 'Vendor Qty/Rate', 'Status', ''], grns, g => {
        const qtyDiff = g.vendor_invoiced_qty != null && Number(g.vendor_invoiced_qty) !== Number(g.received_qty);
        const rateDiff = g.vendor_invoiced_rate != null && Number(g.vendor_invoiced_rate) !== Number(g.po_rate);
        const canEditRejected = g.status === 'Rejected' && (g.created_by === ME.id || isStoreApprover());
        const canRevoke = g.status === 'Approved' && ME.role === 'Admin';
        return `<tr><td>${esc(g.po_no)}</td><td>${esc(g.item_name)||'-'}</td><td>${esc(g.vendor_name)||'-'}</td>
          <td>${g.received_qty}</td><td>₹${fmt(g.po_rate)}</td>
          <td>${esc(g.vendor_invoice_no)||'-'}${g.vendor_invoice_date ? ' (' + esc(g.vendor_invoice_date) + ')' : ''}</td>
          <td>${g.vendor_invoiced_qty != null ? `<span style="${qtyDiff?'color:#b00;font-weight:bold;':''}">${g.vendor_invoiced_qty}</span>` : '-'} / ${g.vendor_invoiced_rate != null ? `<span style="${rateDiff?'color:#b00;font-weight:bold;':''}">₹${fmt(g.vendor_invoiced_rate)}</span>` : '-'}</td>
          <td>${badge(g.status)}</td>
          <td>${actionButtonsCell(`
            <button class="btn small outline" type="button" onclick="toggleGrnAttachments(${g.id})">Attach Invoice</button>
            ${canEditRejected ? `<button class="btn small" type="button" onclick="openEditGrn(${g.id})">Edit &amp; Resubmit</button>` : ''}
            ${canRevoke ? `<button class="btn small red" type="button" onclick="revokeGrn(${g.id})">Revoke</button>` : ''}
          `)}</td></tr>
          ${g.status === 'Rejected' && g.rejection_reason ? `<tr><td colspan="9"><div class="msg err" style="margin:0;">Rejected by ${esc(g.rejected_by_name)||'-'}: ${esc(g.rejection_reason)}</div></td></tr>` : ''}
          ${g.status === 'Revoked' && g.revoke_reason ? `<tr><td colspan="9"><div class="msg" style="margin:0;background:#ede9fe;color:#6d28d9;">Revoked by ${esc(g.revoked_by_name)||'-'}: ${esc(g.revoke_reason)} &mdash; back in My Approvals for a fresh decision.</div></td></tr>` : ''}
          <tr id="grn-attach-row-${g.id}" style="display:none;"><td colspan="9"><div id="grn-attach-${g.id}"></div></td></tr>`;
      })}
    `),
    'material-requests': collapsiblePanel('material-requests', `Store Q — Job Card Material Requests (${materialRequests.filter(m => m.status === 'Pending').length} pending)`, `
      <p class="muted">Material requisitions raised against a Job Card ("Request Material" button in the Job Card detail view). Issuing one decrements stock and logs a stock movement tagged against that job card's own project, same as a normal Issue.</p>
      ${tableHTML(['Job Card', 'Project', 'Department', 'Item', 'Qty', 'Requested By', 'Notes', 'Status', ''], materialRequests, r => `
        <tr><td>${esc(r.job_card_stage)||'-'} #${r.job_card_id}</td><td>${esc(r.project_code)||'-'}</td><td>${esc(r.department_name)||'-'}</td>
          <td>${esc(r.item_master_name || r.item_name)}</td><td>${r.quantity_requested} ${esc(r.unit || r.item_master_unit || '')}</td>
          <td>${esc(r.requested_by_name)||'-'}</td><td>${esc(r.request_notes)||'-'}</td><td>${badge(r.status)}</td>
          <td>${actionButtonsCell(r.status === 'Pending' ? `
            <button class="btn small green" type="button" onclick="actionMaterialRequest(${r.id}, 'Issue')">Issue</button>
            <button class="btn small red" type="button" onclick="actionMaterialRequest(${r.id}, 'Reject')">Reject</button>
          ` : (r.decision_notes ? esc(r.decision_notes) : ''))}</td></tr>`)}
    `),
  };
  const stockLabels = { 'scan-barcode': 'Scan Barcode', 'stock-in-out': 'Stock In / Out', 'bulk-upload': 'Bulk Upload via Excel Template', 'recent-movements': 'Recent Movements', 'grn-reconciliation': 'GRN Reconciliation', 'material-requests': 'Store Q - Material Requests' };
  const stockOrder = await fetchPanelOrder('stock-in-out', Object.keys(stockPanels));
  el.innerHTML = reorderablePanelsHTML('stock-in-out', stockPanels, stockOrder, stockLabels);
  renderStockTabBody();
  const scanEl = document.getElementById('st-scan');
  scanEl.addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter') return;
    const code = scanEl.value.trim();
    scanEl.value = '';
    if (!code) return;
    const resEl = document.getElementById('st-scan-result');
    try {
      const item = await api('/masters/items/by-barcode/' + encodeURIComponent(code));
      if (CURRENT_STOCK_TAB !== 'receive' || val('st-po')) { switchStockTab('receive'); document.getElementById('st-po') && (document.getElementById('st-po').value = ''); renderStockPoLines(); }
      const sel = document.getElementById('st-item');
      if (sel) sel.value = item.id;
      resEl.innerHTML = `<div class="msg ok">Matched: <b>${esc(item.name)}</b> (stock: ${item.current_stock})</div>`;
    } catch (e) { resEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
  scanEl.focus();
}
window.switchStockTab = (tab) => {
  CURRENT_STOCK_TAB = tab;
  const tabsBar = document.getElementById('stock-panel-tabs');
  if (tabsBar) tabsBar.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tabId === tab));
  renderStockTabBody();
};
function renderStockTabBody() {
  const el = document.getElementById('stock-tab-content');
  if (!el) return;
  if (CURRENT_STOCK_TAB === 'receive') return renderReceiveTab(el);
  if (CURRENT_STOCK_TAB === 'issue') return renderIssueTab(el);
}
function renderReceiveTab(el) {
  const groups = window.__GROUPED_POS || [];
  el.innerHTML = `
    <div class="form-grid">
      <div class="stock-input-group"><label>Receive against PO (optional)</label>
        ${searchPickerHTML('st-po', groups, '', poGroupOptions, poGroupMatch, 'onchange="renderStockPoLines()"', 'Search by PO no, vendor, or item...')}
        ${!groups.length ? `<div class="muted" style="margin-top:4px;">No Purchase Orders are currently Open - once one is created and not yet fully received, it will show up here.</div>` : ''}
      </div>
      <div class="stock-input-group"><label>Vendor</label><input id="st-po-vendor" value="" disabled></div>
    </div>
    <div id="st-po-lines" style="margin-top:10px;"></div>
  `;
  renderStockPoLines();
}
// Grid column widths for the Receive tab's selected-PO line table
// (2026-10-16) - this table used to be a plain <table> with each input's
// own hand-picked style="width:Npx" racing its <th>'s auto-computed width,
// the exact per-field-sizing anti-pattern PR #172/the 2026-10-14 New
// PO/PR/SO/FOC line-table round already fixed via gridLineTableHTML() -
// just never applied here. One declared track list now, shared by the
// header and every row, so a column's width is always exactly what's
// declared rather than whatever one row's own input happened to force.
const STOCK_RECEIVE_GRID_COLS = 'minmax(150px,1.4fr) 70px 70px 90px 70px 80px 100px 90px 90px minmax(110px,1fr)';
// Re-renders just the part of the Receive tab below the PO picker: either
// the selected PO's own line items (each with its own qty-to-receive input
// and Receive button, for partial/per-line shipments) or, with no PO
// selected, today's manual item+qty+Receive flow unchanged.
// Plain, read-only Bill-To/Ship-To text built from whichever company_address
// fields GET /orders already joins onto every PO line (same label/line1/
// line2/city/state/pincode/gstin shape the PO PDF's own boxes use) - "" when
// nothing was picked for that slot on the PO, so the caller can skip the box.
function stockPoAddressText(line, prefix) {
  const parts = [line[prefix + '_line1'], line[prefix + '_line2'], line[prefix + '_city'],
    line[prefix + '_state'], line[prefix + '_pincode']].filter(Boolean);
  if (!parts.length) return '';
  let text = parts.join(', ');
  if (line[prefix + '_gstin']) text += ' (GSTIN: ' + line[prefix + '_gstin'] + ')';
  return text;
}
function renderStockPoLines() {
  const poNo = val('st-po');
  const vendorInput = document.getElementById('st-po-vendor');
  const linesEl = document.getElementById('st-po-lines');
  if (!linesEl) return;
  const group = (window.__GROUPED_POS || []).find(g => g.po_no === poNo);
  if (vendorInput) vendorInput.value = group ? group.vendor_name : '';
  if (group) {
    const first = group.lines[0] || {};
    const billText = stockPoAddressText(first, 'company_address');
    const shipText = stockPoAddressText(first, 'company_ship_address');
    linesEl.innerHTML = `
      ${(billText || shipText) ? `
      <div class="panel" style="margin:10px 0;">
        <h4>Bill-To / Ship-To</h4>
        <div class="form-grid">
          <div><label>Bill-To Address${first.company_address_label ? ' (' + esc(first.company_address_label) + ')' : ''}</label><p style="margin:4px 0;">${esc(billText) || '-'}</p></div>
          <div><label>Ship-To Address${first.company_ship_address_label ? ' (' + esc(first.company_ship_address_label) + ')' : ''}</label><p style="margin:4px 0;">${esc(shipText) || '-'}</p></div>
        </div>
      </div>` : ''}
      <div class="panel" style="margin:10px 0;">
        <h4>🚛 Step 1: Attach Master Vendor Invoice Copy (Applies to all received lines)</h4>
        <div class="form-grid">
          <div class="stock-input-group"><label>Invoice File (required)</label><input id="st-batch-file" type="file" accept=".pdf,image/*"></div>
          <div class="stock-input-group"><label>Vendor Invoice No</label><input id="st-batch-vinv" placeholder="optional"></div>
          <div class="stock-input-group"><label>Invoice Date</label><input id="st-batch-vdate" type="date"></div>
        </div>
      </div>
      <p class="muted">Step 2: enter Qty to Receive on each line (0 = skip). Vendor qty/rate go to the Store HOD/Supervisor to reconcile against the PO.
        "Short Ship" is disabled while this line's own Qty to Receive is non-zero - receive it first (or clear the box to 0), then Short Ship the remainder, so an unsubmitted quantity can never be silently discarded.</p>
      ${gridLineTableHTML(STOCK_RECEIVE_GRID_COLS,
        ['Item', 'PO Rate', 'Disc %', 'After-Disc. Rate', 'Ordered', 'Received', 'Qty to Receive', 'Vendor Qty', 'Vendor Rate', ''],
        group.lines, l => {
          const remaining = Math.max(0, l.quantity - (l.received_qty || 0));
          const discountPct = Number(l.discount_percent) || 0;
          const afterDiscRate = Number(l.rate) * (1 - discountPct / 100);
          return `
            <div>${esc(l.item_name) || '-'}</div>
            <div>₹${fmt(l.rate)}</div>
            <div>${discountPct}%</div>
            <div><b>₹${fmt(afterDiscRate)}</b></div>
            <div>${l.quantity}</div>
            <div>${l.received_qty || 0}</div>
            <div><input id="st-po-line-qty-${l.id}" type="number" value="${remaining}" min="0" oninput="updateShortShipAvailability(${l.id})"></div>
            <div><input id="st-po-line-vqty-${l.id}" type="number" placeholder="optional"></div>
            <div><input id="st-po-line-vrate-${l.id}" type="number" placeholder="optional"></div>
            <div>${actionButtonsCell(`
              <button class="btn small outline" type="button" id="ss-btn-${l.id}" ${remaining > 0 ? 'disabled' : ''} onclick="closeShortShipReceiveLine(${l.id})">Short Ship</button>
            `)}</div>`;
        })}
      <button class="btn green" style="width:100%;padding:14px;font-size:16px;margin-top:12px;" onclick="receiveBatch()">Process Consolidated Batch Receipt</button>
    `;
  } else {
    const items = window.__STOCK_ITEMS || [];
    linesEl.innerHTML = `
      <div class="form-grid">
        <div class="stock-input-group"><label>Item</label>${itemPickerHTML('st-item', items, '', stockItemOptions)}</div>
        <div class="stock-input-group"><label>Quantity</label><input id="st-qty" type="number"></div>
      </div>
      <button class="btn green" onclick="storeMove('receive')" ${!items.length ? 'disabled' : ''}>Receive (IN)</button>
    `;
  }
}
// After receiving (or short-shipping) a line, refresh just the Receive
// tab's own data and re-render the lines table under the still-selected PO
// picker - a full navigate() used to rebuild the picker from scratch and
// silently deselect it, forcing a re-search of the same PO for every single
// line of a multi-line receive (2026-10-16). If that was the PO's last line
// still open, the picker is cleared too and a message explains why.
async function refreshStockReceiveLines(doneMessage) {
  const posRaw = await api('/purchase/orders');
  const openPOs = posRaw.filter(o => ['Open', 'PartiallyReceived'].includes(o.status));
  window.__GROUPED_POS = groupPOsByNo(openPOs);
  const poNo = val('st-po');
  const stillOpen = poNo && window.__GROUPED_POS.some(g => g.po_no === poNo);
  if (poNo && !stillOpen) {
    const poEl = document.getElementById('st-po');
    if (poEl) poEl.value = '';
  }
  renderStockPoLines();
  if (poNo && !stillOpen) {
    const linesEl = document.getElementById('st-po-lines');
    if (linesEl) linesEl.insertAdjacentHTML('afterbegin', `<div class="msg ok">${esc(doneMessage || 'No lines left open on that Purchase Order.')}</div>`);
  }
}
// One submit for every line with Qty to Receive > 0 plus the single master
// invoice file (mandatory) - POST /purchase/store/receive-batch, all-or-nothing.
window.receiveBatch = async () => {
  try {
    const group = (window.__GROUPED_POS || []).find(g => g.po_no === val('st-po'));
    if (!group) return;
    const file = document.getElementById('st-batch-file').files[0];
    if (!file) { alert('Attach the master vendor invoice copy first (Step 1).'); return; }
    const lines = group.lines
      .map(l => ({
        po_id: l.id,
        quantity: val(`st-po-line-qty-${l.id}`),
        vendor_invoiced_qty: val(`st-po-line-vqty-${l.id}`),
        vendor_invoiced_rate: val(`st-po-line-vrate-${l.id}`),
      }))
      .filter(l => Number(l.quantity) > 0);
    if (!lines.length) { alert('Enter a Qty to Receive greater than 0 on at least one line.'); return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('vendor_invoice_no', val('st-batch-vinv'));
    fd.append('vendor_invoice_date', val('st-batch-vdate'));
    fd.append('lines', JSON.stringify(lines));
    await apiUpload('/purchase/store/receive-batch', fd, 'POST');
    await refreshStockReceiveLines('All lines on this Purchase Order are now fully received.');
  } catch (e) { alert(e.message); }
};
// Grey out a line's Short Ship button the moment its own Qty to Receive
// stops being 0 (2026-10-27) - root-caused as the actual cause of a line
// closing at "received 0" despite the user having typed a real quantity:
// Short Ship never read that box, so whatever was typed there was silently
// discarded. Disabling it up front, rather than only rejecting after a
// click, is the main fix; the backend call below still sends pending_qty
// as defense in depth.
window.updateShortShipAvailability = (lineId) => {
  const btn = document.getElementById('ss-btn-' + lineId);
  if (!btn) return;
  const pending = Number(val('st-po-line-qty-' + lineId)) || 0;
  btn.disabled = pending > 0;
};
// Explicit "stop expecting more" for a line that's Open or PartiallyReceived
// (2026-10-16) - distinct from an outright Cancel, which reads as "this
// never happened" even once real stock has already come in against it.
// Already-received stock/GRN records are untouched; only the line's own
// status changes, so it drops out of the Receive picker going forward.
window.closeShortShipReceiveLine = async (lineId) => {
  const pendingQty = Number(val('st-po-line-qty-' + lineId)) || 0;
  if (pendingQty > 0) { alert(`There is still an unreceived Qty to Receive (${pendingQty}) on this line - receive it first (or clear the box to 0) before closing the rest as short-shipped.`); return; }
  const reason = prompt('Reason for closing this line as short-shipped (required):');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required.'); return; }
  try {
    await api(`/purchase/orders/${lineId}/close-short-ship`, { method: 'POST', body: JSON.stringify({ reason: reason.trim(), pending_qty: pendingQty }) });
    await refreshStockReceiveLines('Line closed as short-shipped - any remaining lines on this Purchase Order are still open above.');
  } catch (e) { alert(e.message); }
};
// Multi-line Issue (OUT) - department/project/customer are entered once and
// shared across every line (2026-10-16, mirroring how a multi-line PO
// shares one vendor, or FOC lines share one customer). Lines are built the
// same "+ Add Line Item" way as PO_LINES/FOC_LINES, through the same
// gridLineTableHTML() grid so the item/quantity columns stay aligned
// regardless of how many lines are added.
let ISSUE_LINES = [];
const ISSUE_LINES_GRID_COLS = 'minmax(260px,2fr) 120px 44px';
function renderIssueLines() {
  const el = document.getElementById('issue-lines');
  if (!el) return;
  const items = window.__STOCK_ITEMS || [];
  el.innerHTML = gridLineTableHTML(ISSUE_LINES_GRID_COLS, ['Item', 'Quantity', ''], ISSUE_LINES, (l, i) => `
      <div class="stock-input-group">${itemPickerHTML(`issue-item-${i}`, items, l.item_id, stockItemOptions, `onchange="ISSUE_LINES[${i}].item_id=this.value?Number(this.value):''"`)}</div>
      <div class="stock-input-group"><input type="number" value="${l.quantity}" onchange="ISSUE_LINES[${i}].quantity=Number(this.value)"></div>
      <div>${ISSUE_LINES.length > 1 ? `<button class="btn small outline" type="button" onclick="ISSUE_LINES.splice(${i},1);renderIssueLines()">✕</button>` : ''}</div>`);
}
window.addIssueLine = () => { ISSUE_LINES.push({ item_id: '', quantity: 1 }); renderIssueLines(); };
// Projects whose job cards are all Completed (projects.status is already
// derived by advanceProjectStatus() to exactly mean that - see
// lib/pipeline.js) have nothing left to issue material against, so they
// drop off the active Project picker and move into a collapsed-by-default
// "Closed Projects" reference list below it (2026-10-16), rather than
// staying in the active dropdown forever alongside projects still being
// worked.
function renderIssueTab(el) {
  const items = window.__STOCK_ITEMS || [];
  const departments = window.__STOCK_DEPARTMENTS || [];
  const allProjects = window.__STOCK_PROJECTS || [];
  const activeProjects = allProjects.filter(p => p.status !== 'Completed');
  const closedProjects = allProjects.filter(p => p.status === 'Completed');
  const clients = window.__STOCK_CLIENTS || [];
  ISSUE_LINES = [{ item_id: '', quantity: 1 }];
  el.innerHTML = `
    <div class="form-grid">
      <div class="stock-input-group"><label>Department <span class="muted">(who is this being issued to?)</span></label>
        <select id="st-department"><option value="">- Select department -</option>${departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
      </div>
      <div><label>Project (optional)</label>${projectPickerHTML('st-project', activeProjects, '')}</div>
      <div class="stock-input-group"><label>Customer (optional)</label>${clientPickerHTML('st-client', clients, '')}</div>
    </div>
    ${closedProjects.length ? collapsiblePanel('issue-closed-projects', `Closed Projects (${closedProjects.length}) <span class="muted" style="font-weight:normal;">- not offered above, every job card is Completed</span>`, `
      ${tableHTML(['Project Code', 'Title', 'Customer'], closedProjects, p => `
        <tr><td>${esc(p.project_code)}</td><td>${esc(p.title)}</td><td>${esc(p.client_name)||'-'}</td></tr>`)}
    `) : ''}
    <div id="issue-lines" style="margin-top:10px;"></div>
    <button class="btn small outline" type="button" onclick="addIssueLine()" style="margin-top:6px;">+ Add Line Item</button><br>
    <button class="btn red" onclick="storeIssue()" ${!items.length ? 'disabled' : ''} style="margin-top:10px;">Issue to Production (OUT)</button>
  `;
  renderIssueLines();
}
window.storeIssue = async () => {
  try {
    const departmentId = val('st-department');
    if (!departmentId) { alert('Pick which department this is being issued to.'); return; }
    const lines = ISSUE_LINES.filter(l => l.item_id && Number(l.quantity) > 0);
    if (!lines.length) { alert('Add at least one line item with an item and a quantity greater than 0.'); return; }
    const body = { department_id: departmentId, lines };
    const projectId = val('st-project');
    if (projectId) body.project_id = projectId;
    const clientId = val('st-client');
    if (clientId) body.client_id = clientId;
    await api('/purchase/store/issue', { method: 'POST', body: JSON.stringify(body) });
    navigate('stock-in-out');
  } catch (e) { alert(e.message); }
};
window.storeMove = async (type) => {
  try {
    const body = { item_id: val('st-item'), quantity: val('st-qty') };
    await api('/purchase/store/' + type, { method: 'POST', body: JSON.stringify(body) });
    navigate('stock-in-out');
  } catch (e) { alert(e.message); }
};
window.actionMaterialRequest = async (reqId, action) => {
  if (action === 'Reject' && !confirm('Reject this material request?')) return;
  const notes = prompt(action === 'Issue' ? 'Issue notes (optional):' : 'Reason for rejecting (optional):') || '';
  try {
    await api(`/purchase/store/material-requests/${reqId}/action`, { method: 'POST', body: JSON.stringify({ action, notes }) });
    navigate('stock-in-out');
  } catch (e) { alert(e.message); }
};
window.toggleGrnAttachments = (grnId) => {
  const row = document.getElementById('grn-attach-row-' + grnId);
  if (!row) return;
  const showing = row.style.display !== 'none';
  row.style.display = showing ? 'none' : 'table-row';
  if (!showing && !row.dataset.built) {
    row.dataset.built = '1';
    renderAttachmentsWidget('grn_reconciliation', grnId, document.getElementById('grn-attach-' + grnId));
  }
};
// Edit + resubmit a Rejected GRN reconciliation (2026-10-16, extended
// 2026-10-27) - originally scoped to just the vendor-invoice fields the
// clerk typed off the vendor's own bill. Received Qty / PO Rate are now
// also editable here (a clerk can mistype what was actually received), set
// apart visually since correcting them also adjusts the real linked stock
// movement and the item's current stock by the exact delta - see the
// backend route's own comment for why that's necessary rather than optional.
window.openEditGrn = (grnId) => {
  const g = (window.__STOCK_GRNS || []).find(x => x.id === grnId);
  if (!g) return;
  openAppModal(`Edit & Resubmit GRN — ${esc(g.po_no)} / ${esc(g.item_name)||''}`, `
    <p class="muted">Correct the vendor invoice details that caused this to be rejected, then resubmit it for Store HOD/Supervisor review.</p>
    <div class="form-grid">
      <div><label>Vendor Invoice No</label><input id="geg-invno" value="${esc(g.vendor_invoice_no)||''}"></div>
      <div><label>Vendor Invoice Date</label><input id="geg-invdate" type="date" value="${esc(g.vendor_invoice_date)||''}"></div>
      <div><label>Vendor Invoiced Qty</label><input id="geg-invqty" type="number" step="any" value="${g.vendor_invoiced_qty != null ? g.vendor_invoiced_qty : ''}"></div>
      <div><label>Vendor Invoiced Rate</label><input id="geg-invrate" type="number" step="any" value="${g.vendor_invoiced_rate != null ? g.vendor_invoiced_rate : ''}"></div>
    </div>
    <div class="box" style="margin-top:12px;border-color:#e6b800;background:#fff6e5;">
      <b>Correct what was actually received</b> - changing this also adjusts the item's real stock-on-hand by the difference. Only use this for a genuine data-entry error.
      <div class="form-grid" style="margin-top:8px;">
        <div><label>Received Qty</label><input id="geg-recqty" type="number" step="any" value="${g.received_qty != null ? g.received_qty : ''}"></div>
        <div><label>PO Rate</label><input id="geg-porate" type="number" step="any" value="${g.po_rate != null ? g.po_rate : ''}"></div>
      </div>
    </div>
    <button class="btn" id="geg-save-btn-${grnId}" onclick="saveEditGrn(${grnId})" style="margin-top:10px;">Save & Resubmit for Approval</button>
  `);
};
window.saveEditGrn = async (grnId) => {
  try {
    await api(`/purchase/store/grn-reconciliations/${grnId}`, { method: 'PATCH', body: JSON.stringify({
      vendor_invoice_no: val('geg-invno'), vendor_invoice_date: val('geg-invdate'),
      vendor_invoiced_qty: val('geg-invqty'), vendor_invoiced_rate: val('geg-invrate'),
      received_qty: val('geg-recqty'), po_rate: val('geg-porate'),
    })});
    confirmSavedThenClose(`geg-save-btn-${grnId}`, 'stock-in-out');
  } catch (e) { alert(e.message); }
};
// Admin "Revoke" on an already-Approved GRN (2026-11-18) - sends it back for
// a fresh Store HOD decision. Never touches stock (see routes/purchase.js's
// own revoke route comment - stock was credited at Receive time, never
// conditional on GRN approval), only pauses billing eligibility.
window.revokeGrn = async (grnId) => {
  const reason = prompt('Reason for revoking this approved reconciliation (required) - it will go back to Store for a fresh decision:');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required.'); return; }
  try {
    await api(`/purchase/store/grn-reconciliations/${grnId}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
    navigate('stock-in-out');
  } catch (e) { alert(e.message); }
};
// Transportation / Packing & Forwarding, entered by the Store approver on
// the My Approvals GRN drilldown before Approving (2026-10-27) - saved via
// its own small route rather than folded into the generic approve/reject
// action, so the figures are on file the moment Approve is actually clicked.
window.saveGrnCharges = async (grnId) => {
  try {
    await api(`/purchase/store/grn-reconciliations/${grnId}/charges`, { method: 'PATCH', body: JSON.stringify({
      transportation_amount: val(`grn-transport-${grnId}`) || 0,
      packing_forwarding_amount: val(`grn-pf-${grnId}`) || 0,
    })});
    const btn = document.getElementById(`grn-charges-save-${grnId}`);
    if (btn) { btn.textContent = 'Saved ✓'; btn.disabled = true; setTimeout(() => { btn.textContent = 'Save Charges'; btn.disabled = false; }, 1200); }
  } catch (e) { alert(e.message); }
};
window.downloadStockTemplate = () => downloadTemplateFile('/purchase/store/movements/template', 'stock_in_out_upload_template.xlsx');
window.uploadStockTemplate = () => uploadTemplateFile('/purchase/store/movements/bulk-upload', 'st-upload-file', 'st-upload-result', () => navigate('stock-in-out'));

// ---- Sheet 3: Challans ----
async function renderChallanSheet(el) {
  const challanPanels = {
    'form': `
    <div class="panel"><h3>Challans (Material Movement Between Locations)</h3>
      <p class="muted">Delivery challan for moving material between the company's own locations (factory to factory, or factory to site) - not a sale. Add line items, save, then Print or Download PDF for the vehicle.</p>
      <div id="challan-form"></div>
    </div>`,
    'list': `<div id="challan-list"></div>`,
    'report': `<div id="challan-report"></div>`,
  };
  const challanLabels = { 'form': 'Challans (Material Movement Between Locations)', 'list': 'Saved Challans', 'report': 'Open Returnable Challans Report' };
  const challanOrder = await fetchPanelOrder('challans', Object.keys(challanPanels));
  el.innerHTML = reorderablePanelsHTML('challans', challanPanels, challanOrder, challanLabels);
  const company = await api('/settings/company').catch(() => ({}));
  CHALLAN_DEFAULT_GST = Number(company.default_gst_rate) || 18;
  renderChallanForm();
  renderChallanList();
  renderChallanReport();
}

// ---- Challans ----
const CHALLAN_TYPES = ['Job Work', 'Stock Transfer', 'Delivery Challan', 'Purchase Return', 'Sales Return'];
let CHALLAN_DEFAULT_GST = 18;
function challanTypeOptions(selected) {
  return `<option value="">-- Select Challan Type --</option>` +
    CHALLAN_TYPES.map(t => `<option value="${t}" ${selected === t ? 'selected' : ''}>${t}</option>`).join('');
}
function challanReturnableOptions(selected) {
  return `<option value="No" ${!selected ? 'selected' : ''}>No</option><option value="Yes" ${selected ? 'selected' : ''}>Yes - expected back</option>`;
}
// Place of Supply (2026-11-18) - challans have no structured state field to
// auto-derive this from, so it's a plain required manual choice, same "must
// pick one" discipline as Challan Type itself.
function challanSupplyTypeOptions(selected) {
  return `<option value="">-- Select --</option>
    <option value="Intra" ${selected === 'Intra' ? 'selected' : ''}>Within State (CGST + SGST)</option>
    <option value="Inter" ${selected === 'Inter' ? 'selected' : ''}>Outside State (IGST)</option>`;
}
// Shared by the New Challan form and the Edit popup - same columns/markup,
// just a different backing array/rerender-function name per caller. The
// footer splits the combined GST into CGST+SGST or IGST per the currently
// selected Place of Supply (read live via supplyTypeFieldId, so flipping
// the dropdown re-renders the correct split with no separate recompute).
function challanItemsTableHTML(items, arrName, rerenderFn, supplyTypeFieldId) {
  const lineFigures = (it) => {
    const taxable = (Number(it.quantity) || 0) * (Number(it.rate) || 0);
    const gstAmt = taxable * (Number(it.gst_rate) || 0) / 100;
    return { taxable, gstAmt };
  };
  const totals = items.reduce((s, it) => { const { taxable, gstAmt } = lineFigures(it); return { taxable: s.taxable + taxable, gst: s.gst + gstAmt }; }, { taxable: 0, gst: 0 });
  const supplyType = supplyTypeFieldId ? val(supplyTypeFieldId) : '';
  const gstFooterRows = supplyType === 'Intra'
    ? `<tr><td colspan="8" style="text-align:right;">CGST</td><td colspan="2">₹${fmt(totals.gst / 2)}</td></tr><tr><td colspan="8" style="text-align:right;">SGST</td><td colspan="2">₹${fmt(totals.gst / 2)}</td></tr>`
    : supplyType === 'Inter'
      ? `<tr><td colspan="8" style="text-align:right;">IGST</td><td colspan="2">₹${fmt(totals.gst)}</td></tr>`
      : `<tr><td colspan="8" style="text-align:right;">GST</td><td colspan="2">₹${fmt(totals.gst)}</td></tr>`;
  return tableHTML(['Description', 'HSN Code', 'Qty', 'Unit', 'Rate (₹)', 'GST %', 'Taxable (₹)', 'GST (₹)', 'Line Total (₹)', ''], items, (it, i) => {
    const { taxable, gstAmt } = lineFigures(it);
    return `
    <tr>
      <td><input value="${esc(it.description)}" onchange="${arrName}[${i}].description=this.value"></td>
      <td><input value="${esc(it.hsn_code)}" onchange="${arrName}[${i}].hsn_code=this.value" style="width:80px;"></td>
      <td><input type="number" value="${it.quantity}" onchange="${arrName}[${i}].quantity=Number(this.value);${rerenderFn}()" style="width:70px;"></td>
      <td><input value="${esc(it.unit)}" onchange="${arrName}[${i}].unit=this.value" style="width:60px;"></td>
      <td><input type="number" value="${it.rate}" onchange="${arrName}[${i}].rate=Number(this.value);${rerenderFn}()" style="width:80px;"></td>
      <td><input type="number" value="${it.gst_rate}" onchange="${arrName}[${i}].gst_rate=Number(this.value);${rerenderFn}()" style="width:70px;"></td>
      <td>₹${fmt(taxable)}</td>
      <td>₹${fmt(gstAmt)}</td>
      <td>₹${fmt(taxable + gstAmt)}</td>
      <td><button class="btn small outline" type="button" onclick="${arrName}.splice(${i},1);${rerenderFn}()">✕</button></td>
    </tr>`;
  }).replace('</tbody></table>', `</tbody><tfoot>
    <tr><td colspan="8" style="text-align:right;">Taxable Value</td><td colspan="2">₹${fmt(totals.taxable)}</td></tr>
    ${gstFooterRows}
    <tr><td colspan="8" style="text-align:right;"><b>Grand Total</b></td><td colspan="2"><b>₹${fmt(totals.taxable + totals.gst)}</b></td></tr>
  </tfoot></table>`);
}
let CHALLAN_ITEMS = [{ description: '', hsn_code: '', quantity: 1, unit: 'Nos', rate: 0, gst_rate: 18 }];
function renderChallanForm() {
  const formEl = document.getElementById('challan-form');
  if (!formEl) return;
  formEl.innerHTML = `
    <div class="form-grid">
      <div><label>Challan Date</label><input id="ch-date" type="date" value="${today()}"></div>
      <div><label>Challan Type</label><select id="ch-type">${challanTypeOptions()}</select></div>
      <div><label>GST Type (Place of Supply)</label><select id="ch-supply" onchange="renderChallanItemRows()">${challanSupplyTypeOptions()}</select></div>
      <div><label>Returnable (expected back)?</label><select id="ch-returnable">${challanReturnableOptions(false)}</select></div>
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
  el.innerHTML = challanItemsTableHTML(CHALLAN_ITEMS, 'CHALLAN_ITEMS', 'renderChallanItemRows', 'ch-supply');
}
window.addChallanItemRow = () => { CHALLAN_ITEMS.push({ description: '', hsn_code: '', quantity: 1, unit: 'Nos', rate: 0, gst_rate: CHALLAN_DEFAULT_GST }); renderChallanItemRows(); };
window.saveChallan = async () => {
  if (!val('ch-type')) return alert('Pick a Challan Type before saving.');
  if (!val('ch-supply')) return alert('Pick a GST Type (Within State / Outside State) before saving.');
  try {
    await api('/purchase/store/challans', { method: 'POST', body: JSON.stringify({
      challan_type: val('ch-type'), supply_type: val('ch-supply'), is_returnable: val('ch-returnable') === 'Yes',
      from_location: val('ch-from'), to_location: val('ch-to'), vehicle_no: val('ch-vehicle'), transport_mode: val('ch-mode'),
      transporter_name: val('ch-transporter'), distance_km: val('ch-distance') || null, consignor_gstin: val('ch-cgstin'),
      consignee_name: val('ch-consignee'), consignee_gstin: val('ch-econgstin'), reason: val('ch-reason'),
      eway_bill_no: val('ch-eway'), po_no: val('ch-po'), items: CHALLAN_ITEMS.filter(it => it.description),
    })});
    CHALLAN_ITEMS = [{ description: '', hsn_code: '', quantity: 1, unit: 'Nos', rate: 0, gst_rate: CHALLAN_DEFAULT_GST }];
    navigate('challans');
  } catch (e) { alert(e.message); }
};
function challanReturnableStatusHTML(c) {
  if (!c.is_returnable) return 'No';
  if (c.received_back) return `Yes — Received ${new Date(c.received_at).toLocaleDateString()}`;
  if (c.has_partial_return) return 'Yes — <b style="color:#b45309;">Partially Received</b>';
  return 'Yes — <b style="color:#b45309;">Open</b>';
}
async function renderChallanList() {
  const listEl = document.getElementById('challan-list');
  if (!listEl) return;
  const challans = await api('/purchase/store/challans');
  const renderRows = (rows) => tableHTML(['Challan No', 'Date', 'Type', 'From', 'To', 'Vehicle', 'Items', 'Value', 'Returnable', ''], rows, c => `
      <tr><td>${esc(c.challan_no)}</td><td>${new Date(c.challan_date).toLocaleDateString()}</td><td>${esc(c.challan_type)||'-'}</td><td>${esc(c.from_location)}</td><td>${esc(c.to_location)}</td><td>${esc(c.vehicle_no)||'-'}</td><td>${c.item_count}</td><td>₹${fmt(c.total_value)}</td><td>${challanReturnableStatusHTML(c)}</td>
      <td>${actionButtonsCell(`<button class="btn small outline" onclick="editChallan(${c.id})">Edit</button>
        <button class="btn small outline" onclick="printChallan(${c.id})">Print</button>
        <button class="btn small outline" onclick="downloadChallanPdf(${c.id}, '${esc(c.challan_no)}')">Download PDF</button>
        ${c.is_returnable ? `<button class="btn small outline" onclick="showChallanReceiveHistory(${c.id}, '${esc(c.challan_no)}')">Receipt History</button>` : ''}
        ${c.is_returnable && !c.received_back ? `<button class="btn small" onclick="openRecordReceiptModal(${c.id})">Record Receipt</button>` : ''}`)}</td></tr>`);
  listEl.innerHTML = collapsiblePanel('challans-list', `<span id="ch-list-count">Saved Challans (${challans.length})</span>`, `
    ${renderListSearch('challans', challans, ['challan_no', 'vehicle_no', 'from_location', 'to_location', 'challan_type'], (rows) => {
      document.getElementById('ch-list-table').innerHTML = renderRows(rows);
      document.getElementById('ch-list-count').textContent = 'Saved Challans (' + rows.length + ')';
    }, 'Search by challan no, vehicle, from/to location...')}
    <div id="ch-list-table">${renderRows(challans)}</div>
  `);
}
// Record Receipt (2026-11-18) - replaces the old single whole-challan
// prompt() with a popup listing every line's own Ordered/Already Received/
// Outstanding figures and an editable "Receive Now" input (defaulting to
// the full outstanding amount, freely reducible for a genuine short/partial
// receipt) - a challan can be received back across any number of these
// events over time, each one its own logged history entry.
window.openRecordReceiptModal = async (id) => {
  const { challan: c, items } = await api('/purchase/store/challans/' + id);
  const rows = items.map(it => {
    const returned = Number(it.returned_qty) || 0;
    const remaining = Math.max(0, Number(it.quantity) - returned);
    return `<tr>
      <td>${esc(it.description)}</td><td>${it.quantity} ${esc(it.unit)}</td><td>${returned}</td><td><b>${remaining}</b></td>
      <td><input type="number" id="rr-qty-${it.id}" value="${remaining}" min="0" max="${remaining}" style="width:90px;" ${remaining <= 0 ? 'disabled' : ''}></td>
    </tr>`;
  }).join('');
  openAppModal('Record Receipt — ' + c.challan_no, `
    <p class="muted">Enter how much of each line is actually being received back this time - defaults to the full outstanding amount, but can be reduced for a genuine short/partial receipt. Received figures accumulate across however many times this is done.</p>
    <table><thead><tr><th>Description</th><th>Sent</th><th>Already Received</th><th>Outstanding</th><th>Receive Now</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:10px;"><label>Notes (optional)</label><textarea id="rr-notes" rows="2" style="width:100%;"></textarea></div>
    <div style="margin-top:12px;"><button class="btn" id="rr-save-btn-${id}" onclick="saveRecordReceipt(${id})">Record Receipt</button></div>
  `);
  window.__RR_ITEM_IDS = items.map(it => it.id);
};
window.saveRecordReceipt = async (id) => {
  const lines = (window.__RR_ITEM_IDS || []).map(itemId => ({ challan_item_id: itemId, qty: Number(val('rr-qty-' + itemId)) || 0 }));
  if (!lines.some(l => l.qty > 0)) return alert('Enter at least one quantity to record.');
  try {
    await api('/purchase/store/challans/' + id + '/receive-back', { method: 'POST', body: JSON.stringify({ lines, notes: val('rr-notes') || null }) });
    confirmSavedThenClose('rr-save-btn-' + id, 'challans');
  } catch (e) { alert(e.message); }
};
window.showChallanReceiveHistory = async (id, challanNo) => {
  const events = await api('/purchase/store/challans/' + id + '/receive-events');
  openAppModal('Receipt History — ' + challanNo, events.length ? events.map(e => `
    <div class="box" style="margin-bottom:10px;"><p style="margin:0 0 4px;"><b>${new Date(e.created_at).toLocaleString()}</b> &middot; ${esc(e.created_by_name)||'-'}</p>
      <ul style="margin:4px 0;">${e.items.map(it => `<li>${esc(it.description)}: ${it.qty_received}</li>`).join('')}</ul>
      ${e.notes ? `<p class="muted" style="margin:4px 0 0;">${esc(e.notes)}</p>` : ''}
    </div>`).join('') : '<p class="muted">No receipts recorded yet.</p>');
};
async function renderChallanReport() {
  const reportEl = document.getElementById('challan-report');
  if (!reportEl) return;
  const rows = await api('/purchase/store/challans/open-returnable');
  const today = new Date();
  const daysPending = (d) => Math.max(0, Math.round((today - new Date(d)) / 86400000));
  reportEl.innerHTML = collapsiblePanel('challans-report', `Open Returnable Challans Report (${rows.length})`, rows.length ? `
    <p class="muted">Every challan marked Returnable that isn't fully Received Back yet - oldest first. "Lines Outstanding" counts items still owed in full or in part.</p>
    ${tableHTML(['Challan No', 'Date', 'Days Pending', 'Type', 'Lines Outstanding', 'From', 'To', 'Consignee', 'Vehicle', 'Value', ''], rows, c => `
      <tr><td>${esc(c.challan_no)}</td><td>${new Date(c.challan_date).toLocaleDateString()}</td><td><b style="color:#b45309;">${daysPending(c.challan_date)}</b></td><td>${esc(c.challan_type)||'-'}</td><td>${c.lines_outstanding} / ${c.item_count}${c.has_partial_return ? ' <b style="color:#b45309;">(Partial)</b>' : ''}</td><td>${esc(c.from_location)}</td><td>${esc(c.to_location)}</td><td>${esc(c.consignee_name)||'-'}</td><td>${esc(c.vehicle_no)||'-'}</td><td>₹${fmt(c.total_value)}</td>
      <td>${actionButtonsCell(`<button class="btn small" onclick="openRecordReceiptModal(${c.id})">Record Receipt</button><button class="btn small outline" onclick="showChallanReceiveHistory(${c.id}, '${esc(c.challan_no)}')">History</button>`)}</td></tr>`)}
  ` : `<p class="muted">Nothing outstanding - every returnable challan has been received back in full.</p>`);
}
window.downloadChallanPdf = async (id, challanNo) => {
  try {
    const res = await fetch('/api/purchase/store/challans/' + id + '/pdf', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF generation failed'); }
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    openOrDownloadBlob(blob, match ? match[1] : (challanNo || 'challan') + '.pdf');
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
      <div><span>Challan Type:</span> <b>${esc(c.challan_type)||'-'}</b></div>
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
      <div><span>Place of Supply:</span> <b>${c.supply_type === 'Intra' ? 'Within State (CGST+SGST)' : c.supply_type === 'Inter' ? 'Outside State (IGST)' : '-'}</b></div>
      <div style="grid-column:1/-1;"><span>Reason for Transport:</span> <b>${esc(c.reason)}</b></div>
    </div>
    <div><span>Returnable:</span> <b>${c.is_returnable ? 'Yes' : 'No'}</b></div>
    ${c.is_returnable ? `<div><span>Received Back:</span> <b>${c.received_back ? 'Yes (' + new Date(c.received_at).toLocaleDateString() + ')' : 'No - still with the other party'}</b></div>` : ''}
    <table><thead><tr><th>#</th><th>Description</th><th>HSN Code</th><th>Qty</th><th>Unit</th><th>Rate (₹)</th><th>Taxable (₹)</th><th>GST %</th><th>GST (₹)</th><th>Line Total (₹)</th></tr></thead>
    <tbody>${items.map((it,i) => `<tr><td>${i+1}</td><td>${esc(it.description)}</td><td>${esc(it.hsn_code)||'-'}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${fmt(it.rate)}</td><td>${fmt(it.value)}</td><td>${fmt(it.gst_rate)}%</td><td>${fmt(it.gst_amount)}</td><td>${fmt((Number(it.value)||0)+(Number(it.gst_amount)||0))}</td></tr>`).join('')}</tbody>
    <tfoot>
      <tr><td colspan="9" style="text-align:right;">Taxable Value</td><td>₹${fmt(items.reduce((s,it) => s + (Number(it.value)||0), 0))}</td></tr>
      ${c.supply_type === 'Intra'
        ? `<tr><td colspan="9" style="text-align:right;">CGST</td><td>₹${fmt(c.cgst_amount)}</td></tr><tr><td colspan="9" style="text-align:right;">SGST</td><td>₹${fmt(c.sgst_amount)}</td></tr>`
        : `<tr><td colspan="9" style="text-align:right;">IGST</td><td>₹${fmt(c.igst_amount)}</td></tr>`}
      <tr><td colspan="9" style="text-align:right;"><b>Grand Total</b></td><td><b>₹${fmt(c.total_value)}</b></td></tr>
    </tfoot></table>
    <div class="foot"><div>Receiver's Signature</div><div>For Venkateshwara Engineers<br><br><br>Authorized Signatory</div></div>
    <script>window.onload = () => window.print();</script>
    </body></html>`);
  w.document.close();
};

let EDIT_CHALLAN_ITEMS = [];
window.editChallan = async (id) => {
  const { challan: c, items } = await api('/purchase/store/challans/' + id);
  EDIT_CHALLAN_ITEMS = items.map(it => ({ description: it.description, hsn_code: it.hsn_code || '', quantity: it.quantity, unit: it.unit, rate: it.rate, gst_rate: it.gst_rate || 0 }));
  openAppModal('Edit Challan — ' + c.challan_no, `
    <div class="form-grid">
      <div><label>Challan Type</label><select id="ech-type">${challanTypeOptions(c.challan_type)}</select></div>
      <div><label>GST Type (Place of Supply)</label><select id="ech-supply" onchange="renderEditChallanItemRows()">${challanSupplyTypeOptions(c.supply_type)}</select></div>
      <div><label>Returnable (expected back)?</label><select id="ech-returnable">${challanReturnableOptions(c.is_returnable)}</select></div>
      <div><label>From Location</label><input id="ech-from" value="${esc(c.from_location)}"></div>
      <div><label>To Location</label><input id="ech-to" value="${esc(c.to_location)}"></div>
      <div><label>Vehicle Number</label><input id="ech-vehicle" value="${esc(c.vehicle_no)||''}"></div>
      <div><label>Transport Mode</label><select id="ech-mode">${['Road','Rail','Air','Ship'].map(m => `<option ${c.transport_mode===m?'selected':''}>${m}</option>`).join('')}</select></div>
      <div><label>Transporter Name</label><input id="ech-transporter" value="${esc(c.transporter_name)||''}"></div>
      <div><label>Distance (km)</label><input id="ech-distance" type="number" value="${c.distance_km||''}"></div>
      <div><label>E-Way Bill No.</label><input id="ech-eway" value="${esc(c.eway_bill_no)||''}"></div>
      <div><label>PO / Reference No.</label><input id="ech-po" value="${esc(c.po_no)||''}"></div>
      <div><label>Consignor GSTIN</label><input id="ech-cgstin" value="${esc(c.consignor_gstin)||''}"></div>
      <div><label>Consignee Name</label><input id="ech-consignee" value="${esc(c.consignee_name)||''}"></div>
      <div><label>Consignee GSTIN</label><input id="ech-econgstin" value="${esc(c.consignee_gstin)||''}"></div>
      <div><label>Reason for Transport</label><input id="ech-reason" value="${esc(c.reason)||''}"></div>
    </div>
    <h4 style="margin:14px 0 8px;">Material Being Transported</h4>
    <div id="ech-items"></div>
    <button class="btn small outline" type="button" onclick="addEditChallanItemRow()">+ Add Line Item</button>
    <div style="margin-top:12px;"><button class="btn" id="ech-save-btn-${id}" onclick="saveEditChallan(${id})">Save Changes</button></div>
  `);
  renderEditChallanItemRows();
};
function renderEditChallanItemRows() {
  const el = document.getElementById('ech-items');
  if (!el) return;
  el.innerHTML = challanItemsTableHTML(EDIT_CHALLAN_ITEMS, 'EDIT_CHALLAN_ITEMS', 'renderEditChallanItemRows', 'ech-supply');
}
window.addEditChallanItemRow = () => { EDIT_CHALLAN_ITEMS.push({ description: '', hsn_code: '', quantity: 1, unit: 'Nos', rate: 0, gst_rate: CHALLAN_DEFAULT_GST }); renderEditChallanItemRows(); };
window.saveEditChallan = async (id) => {
  if (!val('ech-type')) return alert('Pick a Challan Type before saving.');
  if (!val('ech-supply')) return alert('Pick a GST Type (Within State / Outside State) before saving.');
  try {
    await api('/purchase/store/challans/' + id, { method: 'PUT', body: JSON.stringify({
      challan_type: val('ech-type'), supply_type: val('ech-supply'), is_returnable: val('ech-returnable') === 'Yes',
      from_location: val('ech-from'), to_location: val('ech-to'), vehicle_no: val('ech-vehicle'), transport_mode: val('ech-mode'),
      transporter_name: val('ech-transporter'), distance_km: val('ech-distance') || null, consignor_gstin: val('ech-cgstin'),
      consignee_name: val('ech-consignee'), consignee_gstin: val('ech-econgstin'), reason: val('ech-reason'),
      eway_bill_no: val('ech-eway'), po_no: val('ech-po'), items: EDIT_CHALLAN_ITEMS.filter(it => it.description),
    })});
    confirmSavedThenClose('ech-save-btn-' + id, 'challans');
  } catch (e) { alert(e.message); }
};

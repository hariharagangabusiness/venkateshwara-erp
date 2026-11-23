// approvals.js - My Approvals page, GRN batch cards, approval drill-down.

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
// One row's own <tr>s (the main row, its optional "previously rejected" note,
// and its hidden drilldown row) - pulled out of what used to be tableHTML()'s
// own inline rowRenderer so the whole page can share ONE <table> (see below).
function approvalRowHTML(r) {
  return `<tr><td>${esc(r.ref)||('#'+r.entity_id)}</td><td>${esc(r.summary)||'-'}${r.is_resubmission ? ' <span class="badge Rejected" title="This was rejected before and has since been resubmitted">Resubmitted</span>' : ''}</td><td>${esc(r.raised_by_name)||'-'}</td><td>₹${fmt(r.amount)}</td><td>${r.current_step ?? '-'}</td>
    <td>${new Date(r.created_at).toLocaleString()}</td>
    <td>${actionButtonsCell(approvalActionCell(r) + '<button class="btn small outline" type="button" onclick="toggleApprovalDrilldown(\'' + esc(r.source) + '-' + esc(r.id) + '\')">Details</button>', 'approval-actions')}</td></tr>
    ${r.is_resubmission && r.prior_rejection_reason ? `<tr><td></td><td colspan="6" style="padding-top:0;"><span class="muted" style="font-size:12px;">Previously rejected${r.prior_rejected_by_name ? ' by ' + esc(r.prior_rejected_by_name) : ''}: ${esc(r.prior_rejection_reason)}</span></td></tr>` : ''}
    <tr id="appr-drill-row-${r.source}-${r.id}" style="display:none;"><td colspan="7"><div id="appr-drill-${r.source}-${r.id}"></div></td></tr>`;
}
// GRN lines received in one consolidated batch (same non-null grn_batch_id)
// collapse into ONE parent card with the shared invoice metadata; the
// individual lines sit in an expandable inner list, each keeping its own
// approval/actions (one approval per GRN row is unchanged server-side).
function approvalRowsWithGrnBatches(rows) {
  const batches = {};
  rows.forEach(r => { if (r.entity_type === 'grn_reconciliation' && r.grn_batch_id) (batches[r.grn_batch_id] = batches[r.grn_batch_id] || []).push(r); });
  const done = new Set();
  return rows.map(r => {
    const lines = batches[r.grn_batch_id];
    if (!(r.entity_type === 'grn_reconciliation' && r.grn_batch_id && lines.length > 1)) return approvalRowHTML(r);
    if (done.has(r.grn_batch_id)) return '';
    done.add(r.grn_batch_id);
    return grnBatchCardHTML(r.grn_batch_id, lines);
  }).join('');
}
function grnBatchCardHTML(batchId, lines) {
  const f = lines[0];
  const ids = lines.map(l => l.id).join(',');
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  // Each line gets its own Details button + hidden drilldown row, same as a
  // standalone (non-batched) row's own approvalRowHTML() already does - a
  // batched line was previously missing this entirely, so there was no way
  // to reach the PO-vs-vendor-invoice comparison/attachments/history view
  // for a line once it was grouped into a batch.
  //
  // The inner Lines list is a genuine CSS grid (same .grid-line-table
  // component gridLineTableHTML() uses), not a plain <table> - every batch
  // card used to render its own independent <table>, whose column widths
  // auto-computed purely from that one batch's own content, so the Action
  // column (and its button grid) ended up a different width per batch -
  // the same "N independent auto-layout tables" root cause already fixed
  // elsewhere in this app (PR #172, the Offers/Sales Orders rollups, this
  // very page's own chain/department buckets). A declared
  // grid-template-columns gives every batch's inner list the same column
  // widths regardless of its own content.
  const COLS = '2fr 90px 90px 90px 90px 170px';
  const inner = lines.map(l => `
    <div class="glt-row" style="grid-template-columns:${COLS};">
      <div>${esc(l.grn_item_name) || '-'}</div><div>${esc(l.grn_received_qty)}</div><div>₹${fmt(l.grn_po_rate)}</div>
      <div>${l.grn_vendor_qty != null ? esc(l.grn_vendor_qty) : '-'}</div><div>${l.grn_vendor_rate != null ? '₹' + fmt(l.grn_vendor_rate) : '-'}</div>
      <div>${actionButtonsCell(approvalActionCell(l) + '<button class="btn small outline" type="button" onclick="toggleApprovalDrilldown(\'' + esc(l.source) + '-' + esc(l.id) + '\')">Details</button>', 'approval-actions')}</div>
    </div>
    <div id="appr-drill-row-${esc(l.source)}-${esc(l.id)}" style="display:none;"><div id="appr-drill-${esc(l.source)}-${esc(l.id)}"></div></div>
  `).join('');
  // The PO copy is the same document for every line in the batch (they
  // share one po_no) - shown once here at the batch header, not repeated
  // inside each line's own Details drilldown (see the grn_reconciliation
  // branch of renderApprovalDrilldown(), which hides its own copy of this
  // button once a line is part of a batch, for exactly this reason).
  return `<tr style="background:#fbfcfe;"><td>${esc(f.grn_po_no)} <span class="badge">Batch #${esc(batchId)}</span>
      ${f.grn_po_id ? `<br><button class="btn small outline" type="button" style="margin-top:4px;" onclick="downloadPoPdf(${Number(f.grn_po_id)}, '${esc(f.grn_po_no)}')">📄 View Original PO Copy</button>` : ''}</td>
    <td><strong>${lines.length} lines</strong> from ${esc(f.grn_vendor_name) || 'vendor'}<br><span class="muted">Invoice ${esc(f.grn_invoice_no) || '(no. not entered)'}${f.grn_invoice_date ? ' dated ' + esc(f.grn_invoice_date) : ''}</span></td>
    <td>${esc(f.raised_by_name) || '-'}</td><td>₹${fmt(total)}</td><td>${f.current_step ?? '-'}</td>
    <td>${new Date(f.created_at).toLocaleString()}</td>
    <td>${actionButtonsCell(`<button class="btn small green" onclick="actOnGrnBatch([${ids}], 'Approved')">Approve All</button>
      <button class="btn small red" onclick="actOnGrnBatch([${ids}], 'Rejected')">Reject All</button>
      <button class="btn small outline" type="button" onclick="var r=document.getElementById('grn-batch-${esc(batchId)}');r.style.display=r.style.display==='none'?'':'none'">Lines</button>`, 'approval-actions')}</td></tr>
    <tr id="grn-batch-${esc(batchId)}" style="display:none;"><td colspan="7">
      <div class="grid-line-table" style="overflow-x:auto;">
        <div class="glt-row glt-head" style="grid-template-columns:${COLS};"><div>Item</div><div>Received</div><div>PO Rate</div><div>Vendor Qty</div><div>Vendor Rate</div><div>Action</div></div>
        ${inner}
      </div>
    </td></tr>`;
}
window.actOnGrnBatch = async (ids, action) => {
  const comment = action === 'Rejected' ? prompt('Reason for rejecting all lines (optional):') : null;
  if (action === 'Rejected' && comment === null) return;
  if (!confirm(`${action === 'Approved' ? 'Approve' : 'Reject'} all ${ids.length} lines of this receipt?`)) return;
  try {
    for (const id of ids) await api(`/approvals/${id}/act`, { method: 'POST', body: JSON.stringify({ action, comment }) });
  } catch (e) { alert(e.message); }
  navigate('approvals');
};
// Button-grid alignment (2026-10-16 follow-up to PR #172/the 2026-10-14
// Offers-rollup fix) - this page used to call tableHTML() once per
// chain x department bucket, each producing its own independent <table>.
// Plain table-layout:auto computes a bucket's column widths purely from
// that bucket's own content/button-set, so the Action column (and the
// .row-actions grid inside it) ended up a different width in every bucket -
// exactly the per-table-own-widths root cause already fixed for the Offers/
// Sales Orders grouped rollups. Fixed the same way: ONE shared <table>, one
// <thead>, for the whole page - every chain/department bucket is now just a
// colspan header <tr> followed by its own rows inside that one table, so
// every bucket's Action column (and its button grid) is exactly the same
// width, page-wide, not per bucket.
//
// Same-day follow-up: each chain/department bucket is now collapsed by
// default behind its own clickable header (per this file's own standing
// collapse-by-default rule for grouped/repeating list UI), same
// chevron-toggle pattern as customerGroupedHTML()'s group rollups - the
// header row and its rows live in separate <tbody> elements so one can be
// hidden/shown independently without touching the shared <table>'s single
// <thead> (and therefore its column widths).
PAGES.approvals = async (el) => {
  const pending = await api('/approvals/pending');
  window.__APPROVALS_CACHE = pending;
  const byChain = {};
  pending.forEach(r => { (byChain[r.chain_name] = byChain[r.chain_name] || []).push(r); });
  const columns = ['Reference', 'Details', 'Requested By', 'Amount', 'Step', 'Requested', 'Action'];
  const colCount = columns.length;
  let bucketIdx = 0;
  const bodyHtml = Object.keys(byChain).sort().map(chainName => {
    const rows = byChain[chainName];
    const byDept = {};
    rows.forEach(r => { const dept = r.department_name || 'No department'; (byDept[dept] = byDept[dept] || []).push(r); });
    const chainHeader = `<tbody><tr><td colspan="${colCount}" style="background:#eef1f6;font-weight:600;padding:10px 8px;">
      ${esc(chainName)} <span class="muted" style="font-weight:normal;">(${rows.length})</span>
    </td></tr></tbody>`;
    const deptSections = Object.keys(byDept).sort().map(dept => {
      const bid = `appr-bucket-${bucketIdx++}`;
      return `<tbody><tr>
        <td colspan="${colCount}" style="cursor:pointer;font-weight:600;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.4px;background:#f7f9fb;padding:6px 8px;" onclick="toggleApprovalBucket('${bid}')">
          <span id="${bid}-chev">&#9654;</span> ${esc(dept)} <span class="muted" style="text-transform:none;letter-spacing:normal;font-weight:normal;">(${byDept[dept].length})</span>
        </td>
      </tr></tbody>
      <tbody id="${bid}-body" style="display:none;">${approvalRowsWithGrnBatches(byDept[dept])}</tbody>`;
    }).join('');
    return chainHeader + deptSections;
  }).join('');
  el.innerHTML = `<div class="panel"><h3>Pending My Approval (${pending.length})</h3>
    ${pending.length === 0 ? '<div class="empty">Nothing waiting on you right now.</div>' : ''}
  </div>` + (pending.length ? `<div class="panel"><div style="overflow-x:auto;"><table><thead><tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>${bodyHtml}</table></div></div>` : '');
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
      // A multi-item FOC request is several rows sharing one foc_no - show
      // every item in the group, not just the one the queue entry's
      // entity_id happens to point at.
      const groupItems = f ? rows.filter(x => x.foc_no === f.foc_no) : [];
      container.innerHTML = f ? `<div style="padding:10px;background:#f9f9f9;border-radius:6px;font-size:13px;">
        ${tableHTML(['Item', 'Qty', 'Unit', 'Est. Value (₹)'], groupItems, it => `
          <tr><td>${esc(it.item_description)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${fmt(it.estimated_value)}</td></tr>`)}
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
      extraHtml = `<h5 style="margin:8px 0 4px;">Line Items</h5>${tableHTML(['Item', 'Additional Details', 'Qty', 'Est. Value'], lines, l => `
        <tr><td>${esc(l.item_name)||esc(l.item_text)||'-'}</td><td>${esc(l.details)||'-'}</td><td>${l.quantity}</td><td>₹${fmt(l.estimated_value)}</td></tr>`)}`;
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
    } else if (r.entity_type === 'purchase_order') {
      // GET /orders already returns every column an approver would need
      // (vendor_name/item_name joined in, plus every terms/LD field) - no
      // dedicated single-PO endpoint exists, so filter the full list down
      // to this PO's po_no (a multi-item PO is several rows sharing one).
      const [allOrders, hist] = await Promise.all([api('/purchase/orders'), api(`/approvals/${r.id}/history`)]);
      const lines = allOrders.filter(o => o.po_no === r.ref);
      history = hist;
      attachType = 'purchase_order';
      if (!lines.length) {
        extraHtml = '<p class="muted">Purchase Order not found.</p>';
      } else {
        const first = lines[0];
        const vendor = await api(`/masters/vendors/${first.vendor_id}`).catch(() => null);
        const taxable = lines.reduce((s, l) => s + Number(l.total_value || 0), 0);
        const gstAmt = lines.reduce((s, l) => s + Number(l.gst_amount || 0), 0);
        const freight = Number(first.freight || 0);
        const freightGstRate = Number(first.freight_gst_rate || 0);
        const freightGst = freight * freightGstRate / 100;
        extraHtml = `
          <h5 style="margin:8px 0 4px;">Vendor</h5>
          <p style="font-size:13px;margin:0 0 8px;">
            <b>${esc((vendor && (vendor.legal_name || vendor.name)) || first.vendor_name)}</b> &nbsp; <b>GSTIN:</b> ${esc(vendor && vendor.gstin) || '-'}<br>
            ${vendor && vendor.contact_person ? `<b>Contact:</b> ${esc(vendor.contact_person)}${vendor.phone ? ' (' + esc(vendor.phone) + ')' : ''}<br>` : ''}
          </p>
          <h5 style="margin:8px 0 4px;">Terms</h5>
          <p style="font-size:13px;margin:0 0 8px;">
            <b>Payment Terms:</b> ${esc(first.payment_terms)||'-'} &nbsp; <b>Delivery Date:</b> ${esc(first.delivery_date)||'-'}<br>
            <b>Bill-To Address:</b> ${first.company_address_label ? esc(first.company_address_label) : '-'} &nbsp;
            <b>Ship-To Address:</b> ${first.company_ship_address_label ? esc(first.company_ship_address_label) : '-'}<br>
            <b>LD Rate:</b> ${first.ld_percentage != null ? first.ld_percentage + '%' : '-'} &nbsp; <b>LD Cap:</b> ${first.ld_cap_percentage != null ? first.ld_cap_percentage + '%' : '-'}
            ${first.ld_trigger_notes ? `<br><b>LD Trigger Notes:</b> ${esc(first.ld_trigger_notes)}` : ''}
            ${first.freight_notes ? `<br><b>Freight Comments:</b> ${esc(first.freight_notes)}` : ''}
            ${first.general_notes ? `<br><b>General Notes:</b> ${esc(first.general_notes)}` : ''}
            ${first.terms ? `<br><b>Additional Terms:</b> ${esc(first.terms)}` : ''}
          </p>
          <h5 style="margin:8px 0 4px;">Line Items</h5>
          ${tableHTML(['Item', 'Qty', 'Unit', 'Rate (₹)', 'Disc %', 'HSN', 'GST %', 'Total (₹)', 'Status', ''], lines, l => `
            <tr><td>${esc(l.item_name)||'-'}${l.details ? `<br><span class="muted" style="font-size:11px;">${esc(l.details)}</span>` : ''}</td><td>${l.quantity}</td><td>${esc(l.unit)||'Nos'}</td><td>₹${fmt(l.rate)}</td><td>${Number(l.discount_percent)||0}%</td><td>${esc(l.hsn_code)||'-'}</td><td>${l.gst_rate||0}%</td><td>₹${fmt(l.total_value)}</td><td>${badge(l.status)}</td>
            <td>${l.item_id ? `<button class="btn small outline" type="button" onclick="showItemPriceHistory(${l.item_id})">Price History</button>` : ''}</td></tr>`)}
          <p style="font-size:13px;margin:8px 0 0;text-align:right;"><b>Taxable:</b> ₹${fmt(taxable)} &nbsp; <b>GST:</b> ₹${fmt(gstAmt)}
            ${freight ? ` &nbsp; <b>Freight:</b> ₹${fmt(freight)} &nbsp; <b>Freight GST (${freightGstRate}%):</b> ₹${fmt(freightGst)}` : ''}
            &nbsp; <b>Grand Total:</b> ₹${fmt(taxable + gstAmt + freight + freightGst)}</p>
        `;
      }
    } else if (r.entity_type === 'purchase_invoice') {
      const [detail, hist] = await Promise.all([api(`/finance/purchase-invoices/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      const { invoice: inv, items } = detail;
      history = hist;
      attachType = 'purchase_invoice';
      const vendor = await api(`/masters/vendors/${inv.vendor_id}`).catch(() => null);
      extraHtml = `
        <h5 style="margin:8px 0 4px;">Vendor</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>${esc((vendor && (vendor.legal_name || vendor.name)) || inv.vendor_name)}</b> &nbsp; <b>GSTIN:</b> ${esc(inv.vendor_gstin)||'-'}<br>
          ${vendor && vendor.contact_person ? `<b>Contact:</b> ${esc(vendor.contact_person)}${vendor.phone ? ' (' + esc(vendor.phone) + ')' : ''}<br>` : ''}
        </p>
        <h5 style="margin:8px 0 4px;">Bill Details</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>Vendor's Invoice No:</b> ${esc(inv.vendor_invoice_no)} &nbsp; <b>Date:</b> ${esc(inv.vendor_invoice_date)} &nbsp;
          <b>Against PO:</b> ${esc(inv.po_no)||'-'}
        </p>
        <h5 style="margin:8px 0 4px;">Line Items</h5>
        ${tableHTML(['Item', 'Qty', 'Rate (₹)', 'HSN', 'GST %', 'Taxable (₹)', ''], items, it => `
          <tr><td>${esc(it.item_name)||esc(it.description)}</td><td>${it.quantity}</td><td>₹${fmt(it.rate)}</td><td>${esc(it.hsn_code)||'-'}</td><td>${it.gst_rate}%</td><td>₹${fmt(it.taxable_value)}</td>
          <td>${it.item_id ? `<button class="btn small outline" type="button" onclick="showItemPriceHistory(${it.item_id})">Price History</button>` : ''}</td></tr>`)}
        <p style="font-size:13px;margin:8px 0 0;text-align:right;">
          <b>Taxable:</b> ₹${fmt(inv.taxable_value)} &nbsp; <b>GST:</b> ₹${fmt(inv.cgst + inv.sgst + inv.igst)} &nbsp; <b>Total:</b> ₹${fmt(inv.total_value)}<br>
          ${inv.tds_amount > 0 ? `<b>TDS (${inv.tds_rate}%):</b> ₹${fmt(inv.tds_amount)} &nbsp; ` : ''}<b>Net Payable:</b> ₹${fmt(inv.net_payable)}
        </p>
      `;
    } else if (r.entity_type === 'referral_incentive') {
      const [list, hist] = await Promise.all([api('/hr/referral-incentives'), api(`/approvals/${r.id}/history`)]);
      const ri = list.find(x => x.id === r.entity_id);
      history = hist;
      extraHtml = ri ? `
        <h5 style="margin:8px 0 4px;">Referral Details</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>Referred Employee:</b> ${esc(ri.employee_name)} (${esc(ri.employee_status)}) &nbsp; <b>Referred By:</b> ${esc(ri.referred_by_name)}<br>
          <b>Incentive Amount:</b> ₹${fmt(ri.incentive_amount)} &nbsp; <b>Probation Ended:</b> ${ri.probation_end_date||'-'}
        </p>
      ` : '<p class="muted">Referral incentive record not found.</p>';
    } else if (r.entity_type === 'salary_hike_cycle') {
      const [bundle, hist] = await Promise.all([api(`/hr/salary-hike-cycles/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      const { cycle, items } = bundle;
      history = hist;
      extraHtml = `
        <h5 style="margin:8px 0 4px;">Cycle Details</h5>
        <p style="font-size:13px;margin:0 0 8px;"><b>${esc(cycle.cycle_name)}</b> &nbsp; <b>Effective Year:</b> ${cycle.effective_year||'-'}</p>
        <h5 style="margin:8px 0 4px;">Proposed Hikes (${items.length})</h5>
        ${tableHTML(['Employee', 'Department', 'Current (₹)', 'Hike', 'Proposed (₹)', 'Delta (₹)'], items, i => `
          <tr><td>${esc(i.employee_name)}</td><td>${esc(i.department_name)||'-'}</td><td>₹${fmt(i.current_salary)}</td>
          <td>${i.hike_type === 'Fixed' ? '₹' + fmt(i.hike_value) : i.hike_value + '%'}</td><td>₹${fmt(i.proposed_salary)}</td><td>₹${fmt(i.proposed_salary - i.current_salary)}</td></tr>`)}
        <p style="font-size:13px;margin:8px 0 0;text-align:right;">
          <b>Total Current:</b> ₹${fmt(items.reduce((s,i)=>s+i.current_salary,0))} &nbsp;
          <b>Total Proposed:</b> ₹${fmt(items.reduce((s,i)=>s+i.proposed_salary,0))}
        </p>
      `;
    } else if (r.entity_type === 'fg_dispatch') {
      const [bundle, hist] = await Promise.all([api(`/sales/dispatches/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      const { dispatch, items } = bundle;
      history = hist;
      attachType = 'fg_dispatch';
      extraHtml = `
        <h5 style="margin:8px 0 4px;">Dispatch Details</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>Against Order:</b> ${esc(dispatch.order_no)} &nbsp; <b>Vehicle:</b> ${esc(dispatch.vehicle_no)||'-'} &nbsp;
          <b>Transporter:</b> ${esc(dispatch.transporter_name)||'-'} &nbsp; <b>E-Way Bill:</b> ${esc(dispatch.eway_bill_no)||'-'}
        </p>
        ${dispatch.payment_override_note ? `<p class="msg err" style="display:block;">${esc(dispatch.payment_override_note)}</p>` : ''}
        <h5 style="margin:8px 0 4px;">Line Items (${items.length})</h5>
        ${tableHTML(['Description', 'Qty', 'Unit', 'HSN', 'Rate (₹)'], items, it => `
          <tr><td>${esc(it.description)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${esc(it.hsn_code)||'-'}</td><td>₹${fmt(it.rate)}</td></tr>`)}
      `;
    } else if (r.entity_type === 'service_request') {
      const [rows, hist] = await Promise.all([api('/service'), api(`/approvals/${r.id}/history`)]);
      const sr = rows.find(x => x.id === r.entity_id);
      history = hist;
      extraHtml = sr ? `
        <h5 style="margin:8px 0 4px;">Service Request Details</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>SR No:</b> ${esc(sr.sr_no)} &nbsp; <b>Customer:</b> ${esc(sr.client_master_name || sr.customer_name)||'-'}<br>
          <b>Contact:</b> ${esc(sr.contact_person)||'-'}${sr.contact_phone ? ' / ' + esc(sr.contact_phone) : ''}<br>
          <b>Issue:</b> ${esc(sr.issue_description)||'-'}
          ${sr.email_excerpt ? `<br><b>Email excerpt:</b> ${esc(sr.email_excerpt)}` : ''}
          ${sr.spare_parts_needed ? `<br><b>Spare Parts Needed:</b> ${esc(sr.spare_parts_needed)}` : ''}
        </p>
        <p class="muted" style="font-size:12px;">Auto-created from an inbound email to the Service mailbox - review the details above (correcting the customer/contact if the auto-match guessed wrong is done via the Service page's Edit action) before approving.</p>
        ${sr.source === 'Email' ? `
          <a href="#" style="font-size:12px;" onclick="toggleSrApprovalEmail('${key}',${sr.id});return false;">View Original Email</a>
          <div id="appr-drill-email-${key}" style="display:none;margin-top:6px;"></div>
        ` : ''}
      ` : '<p class="muted">Service request not found.</p>';
    } else if (r.entity_type === 'sale_rejection_mrn') {
      const [bundle, hist] = await Promise.all([api(`/sales/mrns/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      const { mrn, items } = bundle;
      history = hist;
      attachType = 'sale_rejection_mrn';
      extraHtml = `
        <h5 style="margin:8px 0 4px;">Rejection Details</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>Against Dispatch:</b> ${esc(mrn.dispatch_no)} (${esc(mrn.order_no)}) &nbsp; <b>Reason:</b> ${esc(mrn.reason)||'-'} &nbsp; <b>Disposition:</b> ${esc(mrn.disposition)}
        </p>
        ${mrn.description ? `<p style="font-size:13px;margin:0 0 8px;">${esc(mrn.description)}</p>` : ''}
        <h5 style="margin:8px 0 4px;">Rejected Lines (${items.length})</h5>
        ${tableHTML(['Description', 'Qty Rejected', 'Unit', 'Rate (₹)'], items, it => `
          <tr><td>${esc(it.description)}</td><td>${it.quantity_rejected}</td><td>${esc(it.unit)}</td><td>₹${fmt(it.rate)}</td></tr>`)}
      `;
    } else if (r.entity_type === 'sales_return') {
      const [bundle, hist] = await Promise.all([api(`/sales/returns/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      const { ret, items } = bundle;
      history = hist;
      attachType = 'sales_return';
      extraHtml = `
        <h5 style="margin:8px 0 4px;">Return Details</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>Customer:</b> ${esc(ret.client_name)} ${ret.order_no ? `&nbsp; <b>Linked Order:</b> ${esc(ret.order_no)}` : ''} ${ret.mrn_no ? `&nbsp; <b>Linked MRN:</b> ${esc(ret.mrn_no)}` : ''}<br>
          <b>Reason:</b> ${esc(ret.reason)||'-'}
        </p>
        <h5 style="margin:8px 0 4px;">Returned Lines (${items.length})</h5>
        ${tableHTML(['Item', 'Qty', 'Unit', 'Condition'], items, it => `
          <tr><td>${esc(it.item_text)}</td><td>${it.quantity}</td><td>${esc(it.unit)}</td><td>${badge(it.condition_status)}</td></tr>`)}
        <p class="muted" style="font-size:12px;">Approving confirms physical receipt - a Good-condition line is credited to stock immediately, a Damaged line is logged only. A paperwork Sales Return Challan is generated automatically.</p>
      `;
    } else if (r.entity_type === 'grn_reconciliation') {
      const [g, hist] = await Promise.all([api(`/purchase/store/grn-reconciliations/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      history = hist;
      attachType = 'grn_reconciliation';
      const qtyDiff = g.vendor_invoiced_qty != null && Number(g.vendor_invoiced_qty) !== Number(g.received_qty);
      const rateDiff = g.vendor_invoiced_rate != null && Number(g.vendor_invoiced_rate) !== Number(g.po_rate);
      // A batch of exactly 1 line renders as a plain standalone row on the
      // list (grnBatchCardHTML only kicks in once a batch has >1 line - see
      // approvalRowsWithGrnBatches()) - so gating this drilldown on bare
      // grn_batch_id truthiness alone hid the PO copy button and pointed at
      // a "batch card above" that was never actually rendered, making the
      // PO unreachable for a single-line batch. batch_line_count (from
      // GET /store/grn-reconciliations/:id) makes this match the list's
      // own real grouping decision instead of just checking for a batch id.
      const inMultiLineBatch = g.grn_batch_id && Number(g.batch_line_count) > 1;
      extraHtml = `
        ${g.status === 'Revoked' && g.revoked_by_name ? `<div class="msg" style="background:#ede9fe;color:#6d28d9;margin:0 0 8px;"><b>Revoked by ${esc(g.revoked_by_name)}${g.revoked_at ? ' &middot; ' + esc(new Date(g.revoked_at).toLocaleDateString()) : ''}</b><br>"${esc(g.revoke_reason)}"</div>` : ''}
        <h5 style="margin:8px 0 4px;">PO vs Vendor Invoice</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>PO No:</b> ${esc(g.po_no)} &nbsp; <b>Item:</b> ${esc(g.item_name)||'-'} &nbsp; <b>Vendor:</b> ${esc(g.vendor_name)||'-'} (${esc(g.vendor_gstin)||'GSTIN N/A'})
        </p>
        ${tableHTML(['', 'Qty', 'Rate (₹)'], [1], () => `
          <tr><td><b>As per PO (received)</b></td><td>${g.received_qty}</td><td>₹${fmt(g.po_rate)}</td></tr>
          <tr><td><b>As per Vendor Invoice${g.vendor_invoice_no ? ' (' + esc(g.vendor_invoice_no) + (g.vendor_invoice_date ? ', ' + esc(g.vendor_invoice_date) : '') + ')' : ''}</b></td>
            <td style="${qtyDiff?'color:#b00;font-weight:bold;':''}">${g.vendor_invoiced_qty != null ? g.vendor_invoiced_qty : 'Not yet on file'}</td>
            <td style="${rateDiff?'color:#b00;font-weight:bold;':''}">${g.vendor_invoiced_rate != null ? '₹' + fmt(g.vendor_invoiced_rate) : '-'}</td></tr>`)}
        ${(qtyDiff || rateDiff) ? `<p class="msg err" style="display:block;">Variance from the PO - verify against the attached invoice copy before approving.</p>` : ''}
        <h5 style="margin:8px 0 4px;">Document Verification</h5>
        ${actionButtonsCell(`
          ${inMultiLineBatch ? '' : `<button class="btn small outline" type="button" onclick="downloadPoPdf(${Number(g.po_id)}, '${esc(g.po_no)}')">📄 View Original PO Copy</button>`}
          ${g.invoice_attachment_path
            ? `<a class="btn small green" href="${esc(g.invoice_attachment_path)}" target="_blank" rel="noopener">🧾 View Attached Vendor Invoice</a>`
            : '<span class="muted" style="font-size:12px;">⚠️ No vendor invoice attached by receiving team</span>'}
        `)}
        ${inMultiLineBatch ? '<p class="muted" style="font-size:12px;">This receipt\'s PO copy is shown once on the batch card above.</p>' : ''}
        ${['PendingApproval', 'InfoRequested'].includes(g.status) && isStoreApprover() ? `
        <h5 style="margin:8px 0 4px;">Additional Charges <span class="muted" style="font-weight:normal;">(saved before you Approve; flow into the Purchase Invoice when Accounts bills this GRN)</span></h5>
        <div class="form-grid">
          <div><label>Transportation (₹)</label><input id="grn-transport-${r.entity_id}" type="number" step="any" value="${g.transportation_amount || ''}"></div>
          <div><label>Packing &amp; Forwarding (₹)</label><input id="grn-pf-${r.entity_id}" type="number" step="any" value="${g.packing_forwarding_amount || ''}"></div>
        </div>
        <button class="btn small outline" type="button" id="grn-charges-save-${r.entity_id}" onclick="saveGrnCharges(${r.entity_id})" style="margin-top:6px;">Save Charges</button>
        ` : (g.transportation_amount || g.packing_forwarding_amount ? `
        <h5 style="margin:8px 0 4px;">Additional Charges</h5>
        <p style="font-size:13px;margin:0;">Transportation: ₹${fmt(g.transportation_amount||0)} &nbsp; Packing &amp; Forwarding: ₹${fmt(g.packing_forwarding_amount||0)}</p>
        ` : '')}
      `;
    } else if (r.entity_type === 'todo') {
      const [t, hist] = await Promise.all([api(`/todos/${r.entity_id}`), api(`/approvals/${r.id}/history`)]);
      history = hist;
      extraHtml = `
        <h5 style="margin:8px 0 4px;">To-Do Details</h5>
        <p style="font-size:13px;margin:0 0 8px;">
          <b>${esc(t.brief_description)}</b>${t.priority === 'High' ? ' <span class="badge Rejected">HIGH</span>' : ''}<br>
          ${t.details ? esc(t.details) + '<br>' : ''}
          <b>Assigned To:</b> ${esc(t.assigned_to_name)||'-'} &nbsp; <b>HOD:</b> ${esc(t.hod_name)||'-'}<br>
          <b>Target Date:</b> ${esc(t.target_date)||'-'}
        </p>
      `;
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

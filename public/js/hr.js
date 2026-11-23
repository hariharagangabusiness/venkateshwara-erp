// hr.js - Employees, Referral/Salary pages, Attendance, Leave, Advances, Payroll, Technician Tour Expenses,
// Leave Balances.

// ---- Employees ----
const EXIT_REASONS = [
  'Resignation - Better Opportunity', 'Resignation - Personal Reasons', 'Resignation - Relocation', 'Resignation - Higher Studies',
  'Termination - Performance', 'Termination - Misconduct', 'Termination - Redundancy', 'Retirement', 'End of Contract', 'Other',
];
const EXIT_RECOMMENDATIONS = ['Eligible for Rehire', 'Not Eligible for Rehire', 'Eligible with Conditions'];
const EMP_LIST_COLUMNS = [
  { label: 'Code', field: 'employee_code' },
  { label: 'Name', field: 'full_name' },
  { label: 'Department', field: 'department_name' },
  { label: 'Designation', field: 'designation' },
  { label: 'Type', field: 'employment_type' },
  { label: 'Salary', field: 'monthly_salary', type: 'number' },
  { label: 'Status', field: 'status' },
  { label: 'Action' },
];
function employeeRowHTML(e) {
  const blank = !e.full_name || !e.full_name.trim();
  return `<tr id="emp-row-${e.id}"${blank ? ' style="background:#fef2f2;"' : ''}><td>${esc(e.employee_code)}</td><td>${blank ? '<span class="muted">(no name set)</span>' : esc(e.full_name)}</td><td>${esc(e.department_name)}</td><td>${esc(e.designation)}</td>
    <td>${esc(e.employment_type)||'Full-time'}</td><td>₹${fmt(e.monthly_salary)}</td><td>${badge(e.status)}</td>
    <td><button class="btn small outline" onclick="openEditEmployee(${e.id})">Edit</button></td></tr>`;
}
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
        <div><label>Permanent Address</label><textarea id="em-perm-address" rows="2" oninput="syncTempAddress('em')"></textarea></div>
        <div><label>Temporary Address <span style="font-weight:400;"><input type="checkbox" id="em-same-address" onchange="syncTempAddress('em')"> Same as Permanent Address</span></label><textarea id="em-temp-address" rows="2"></textarea></div>
      </div>
      <h4>Referral</h4>
      <div class="form-grid">
        <div><label>Referred By (if a referral hire)</label><select id="em-referred-by"><option value="">- Not a referral -</option>${emps.map(e => `<option value="${e.id}">${esc(e.full_name)}${e.employee_code ? ' (' + esc(e.employee_code) + ')' : ''}</option>`).join('')}</select></div>
        <div><label>Referral Incentive Amount (₹)</label><input id="em-referral-amount" type="number" placeholder="0"></div>
        <div><label>Probation End Date</label><input id="em-probation-end" type="date"></div>
      </div>
      <h4>Bank Details</h4>
      <div class="form-grid">
        <div><label>Bank Name</label><input id="em-bank-name"></div>
        <div><label>Account Number</label><input id="em-bank-acct"></div>
        <div><label>IFSC Code</label><input id="em-bank-ifsc"></div>
      </div>
      <h4>Identity Documents</h4>
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
      <div class="form-grid">
        <div><input id="em-upload-file" type="file" accept=".xlsx,.xls"></div>
        <div><button class="btn" onclick="uploadEmployeeTemplate()">Upload Filled Template</button></div>
      </div>
      <div id="em-upload-result"></div>
    </div>
    ${collapsiblePanel('employees-list', `Employees (${emps.length})`, `
      ${emps.some(e => !e.full_name || !e.full_name.trim()) ? '<div class="msg err">One or more employees below have a blank name (created before this was required) - click Edit on the highlighted row(s) and fill in Full Name.</div>' : ''}
      <div id="emp-table-container">${sortableTableHTML('employees', EMP_LIST_COLUMNS, emps, employeeRowHTML, html => { document.getElementById('emp-table-container').innerHTML = html; })}</div>
    `)}`;
  window.__EMP_CACHE = emps; window.__EMP_DEPTS = depts;
};
window.syncTempAddress = (pre) => {
  const cb = document.getElementById(pre + '-same-address'), t = document.getElementById(pre + '-temp-address');
  if (!cb || !t) return;
  if (cb.checked) t.value = document.getElementById(pre + '-perm-address').value;
  t.readOnly = cb.checked;
};
window.addEmployee = async () => {
  if (!val('em-name').trim()) { alert('Full Name is required.'); return; }
  try {
    await api('/hr/employees', { method: 'POST', body: JSON.stringify({
      employee_code: val('em-code'), full_name: val('em-name'), department_id: val('em-dept'), designation: val('em-desig'),
      employment_type: val('em-emptype'), date_of_joining: val('em-doj'), phone: val('em-phone'), email: val('em-email'),
      monthly_salary: val('em-salary'), pan_number: val('em-pan'), blood_group: val('em-blood'),
      emergency_contact_name: val('em-ec-name'), emergency_contact_phone: val('em-ec-phone'), permanent_address: val('em-perm-address'), temporary_address: val('em-temp-address'),
      bank_name: val('em-bank-name'), account_number: val('em-bank-acct'), ifsc_code: val('em-bank-ifsc'),
      aadhaar_number: val('em-aadhaar'), passport_number: val('em-passport'), visa_availability: val('em-visa'),
      driving_license_number: val('em-dl'),
      referred_by_employee_id: val('em-referred-by') || null, referral_incentive_amount: val('em-referral-amount') || 0,
      probation_end_date: val('em-probation-end') || null,
    })});
    navigate('employees');
  } catch (e) { alert(e.message); }
};
window.downloadEmployeeTemplate = () => downloadTemplateFile('/hr/employees/template', 'employee_upload_template.xlsx');
window.uploadEmployeeTemplate = () => uploadTemplateFile('/hr/employees/bulk-upload', 'em-upload-file', 'em-upload-result', () => navigate('employees'));

// Edit Employee (2026-10-13: converted from a bottom-of-page scroll-to
// panel to the generic popup - see openEditVendor's own comment for why).
window.openEditEmployee = (id) => {
  const e = (window.__EMP_CACHE || []).find(x => x.id === id);
  if (!e) return;
  const depts = window.__EMP_DEPTS || [];
  openAppModal('Edit Employee — ' + esc(e.full_name || e.employee_code || ''), `
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
      <div><label>Permanent Address</label><textarea id="eme-perm-address" rows="2" oninput="syncTempAddress('eme')">${esc(e.permanent_address||e.address)||''}</textarea></div>
        <div><label>Temporary Address <span style="font-weight:400;"><input type="checkbox" id="eme-same-address" onchange="syncTempAddress('eme')"> Same as Permanent Address</span></label><textarea id="eme-temp-address" rows="2">${esc(e.temporary_address)||''}</textarea></div>
      <div><label>Status</label><select id="eme-status"><option value="active" ${e.status==='active'?'selected':''}>Active</option><option value="resigned" ${e.status==='resigned'?'selected':''}>Resigned</option><option value="terminated" ${e.status==='terminated'?'selected':''}>Terminated</option></select></div>
      <div><label>Exit Date (if resigned/terminated)</label><input id="eme-exit" type="date" value="${e.exit_date||''}"></div>
      <div><label>Exit Reason</label><select id="eme-exit-reason"><option value="">-</option>${EXIT_REASONS.map(r => `<option ${r===e.exit_reason?'selected':''}>${r}</option>`).join('')}</select></div>
      <div><label>Exit Recommendation</label><select id="eme-exit-rec"><option value="">-</option>${EXIT_RECOMMENDATIONS.map(r => `<option ${r===e.exit_recommendation?'selected':''}>${r}</option>`).join('')}</select></div>
    </div>
    <h4>Referral</h4>
    <div class="form-grid">
      <div><label>Referred By (if a referral hire)</label><select id="eme-referred-by"><option value="">- Not a referral -</option>${(window.__EMP_CACHE||[]).filter(x => x.id !== e.id).map(x => `<option value="${x.id}" ${x.id===e.referred_by_employee_id?'selected':''}>${esc(x.full_name)}${x.employee_code ? ' (' + esc(x.employee_code) + ')' : ''}</option>`).join('')}</select></div>
      <div><label>Referral Incentive Amount (₹)</label><input id="eme-referral-amount" type="number" value="${e.referral_incentive_amount||0}"></div>
      <div><label>Probation End Date</label><input id="eme-probation-end" type="date" value="${e.probation_end_date||''}"></div>
    </div>
    <h4>Bank Details</h4>
    <div class="form-grid">
      <div><label>Bank Name</label><input id="eme-bank-name" value="${esc(e.bank_name)||''}"></div>
      <div><label>Account Number</label><input id="eme-bank-acct" value="${esc(e.account_number)||''}"></div>
      <div><label>IFSC Code</label><input id="eme-bank-ifsc" value="${esc(e.ifsc_code)||''}"></div>
    </div>
    <h4>Identity Documents</h4>
    <div class="form-grid">
      <div><label>Aadhaar Number</label><input id="eme-aadhaar" value="${esc(e.aadhaar_number)||''}"></div>
      <div><label>Passport Number</label><input id="eme-passport" value="${esc(e.passport_number)||''}"></div>
      <div><label>Visa Availability</label><input id="eme-visa" value="${esc(e.visa_availability)||''}"></div>
      <div><label>Driving License Number</label><input id="eme-dl" value="${esc(e.driving_license_number)||''}"></div>
    </div>
    <button class="btn" id="eme-save-btn-${id}" onclick="saveEditEmployee(${id})">Save Changes</button>
    <div id="eme-err" class="msg err" style="display:none;"></div>`);
};
window.saveEditEmployee = async (id) => {
  const errEl = document.getElementById('eme-err');
  if (!val('eme-name').trim()) { errEl.textContent = 'Full Name is required.'; errEl.style.display = 'block'; return; }
  try {
    await api('/hr/employees/' + id, { method: 'PUT', body: JSON.stringify({
      employee_code: val('eme-code'), full_name: val('eme-name'), department_id: val('eme-dept'), designation: val('eme-desig'),
      employment_type: val('eme-emptype'), date_of_joining: val('eme-doj'), phone: val('eme-phone'), email: val('eme-email'),
      monthly_salary: val('eme-salary'), pan_number: val('eme-pan'), blood_group: val('eme-blood'),
      emergency_contact_name: val('eme-ec-name'), emergency_contact_phone: val('eme-ec-phone'), permanent_address: val('eme-perm-address'), temporary_address: val('eme-temp-address'),
      status: val('eme-status'), exit_date: val('eme-exit') || null,
      exit_reason: val('eme-exit-reason') || null, exit_recommendation: val('eme-exit-rec') || null,
      bank_name: val('eme-bank-name'), account_number: val('eme-bank-acct'), ifsc_code: val('eme-bank-ifsc'),
      aadhaar_number: val('eme-aadhaar'), passport_number: val('eme-passport'), visa_availability: val('eme-visa'),
      driving_license_number: val('eme-dl'),
      referred_by_employee_id: val('eme-referred-by') || null, referral_incentive_amount: val('eme-referral-amount') || 0,
      probation_end_date: val('eme-probation-end') || null,
    })});
    confirmSavedThenClose(`eme-save-btn-${id}`, 'employees');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// ---- Referral Incentives ----
PAGES['referral-incentives'] = async (el) => {
  const list = await api('/hr/referral-incentives');
  const rows = r => `<tr>
    <td>${esc(r.employee_name)}</td><td>${esc(r.referred_by_name)}</td><td>₹${fmt(r.incentive_amount)}</td>
    <td>${r.probation_end_date||'-'}</td><td>${badge(r.status)}</td><td>${r.payment_reference ? esc(r.payment_reference) + (r.paid_date ? ' (' + r.paid_date + ')' : '') : '-'}</td>
    <td>${actionButtonsCell(`
      ${r.status === 'Eligible' ? `<button class="btn small" type="button" onclick="submitReferralIncentive(${r.id})">Submit for Approval</button>` : ''}
      ${r.status === 'Approved' ? `<button class="btn small" type="button" onclick="markReferralIncentivePaid(${r.id})">Mark Paid</button>` : ''}
    `)}</td></tr>`;
  el.innerHTML = `
    <div class="panel"><h3>Referral Incentives</h3>
      <p class="muted">Created automatically when an employee is added with a referrer and incentive amount (Add Employee's Referral section). Becomes Eligible once the referred employee's probation period passes - forfeited automatically if they exit before then.</p>
      ${tableHTML(['Referred Employee', 'Referred By', 'Amount', 'Probation Ends', 'Status', 'Payment Ref', ''], list, rows)}
    </div>`;
};
window.submitReferralIncentive = async (id) => {
  try { await api(`/hr/referral-incentives/${id}/submit-for-approval`, { method: 'POST', body: '{}' }); navigate('referral-incentives'); }
  catch (e) { alert(e.message); }
};
window.markReferralIncentivePaid = async (id) => {
  const ref = prompt('Payment reference (cheque no / UTR / mode - optional):') || '';
  try { await api(`/hr/referral-incentives/${id}/mark-paid`, { method: 'POST', body: JSON.stringify({ payment_reference: ref }) }); navigate('referral-incentives'); }
  catch (e) { alert(e.message); }
};

// ---- Salary Hike History ----
PAGES['salary-hikes'] = async (el) => {
  const emps = await api('/hr/employees');
  const hikes = await api('/hr/salary-hikes');
  el.innerHTML = `
    <div class="panel"><h3>Backfill Historical Hikes</h3>
      <p class="muted">For migrating past years' hike records - does NOT change an employee's current salary (use Edit Employee for that).</p>
      <button class="btn outline" type="button" onclick="downloadTemplateFile('/hr/salary-hikes/template', 'salary_hikes_upload_template.xlsx')">Download Template</button>
      ${bulkUploadPanelHTML('sh-upload-file')}
      <button class="btn" onclick="uploadTemplateFile('/hr/salary-hikes/bulk-upload', 'sh-upload-file', 'sh-upload-result', () => navigate('salary-hikes'))">Upload Filled Template</button>
      <div id="sh-upload-result"></div>
    </div>
    ${collapsiblePanel('salary-hike-history', `Hike History (${hikes.length})`, `
      ${tableHTML(['Employee', 'Previous (₹)', 'Hike', 'New (₹)', 'Year', 'Effective Date', 'Source'], hikes, h => `
        <tr><td>${esc(h.employee_name)}</td><td>₹${fmt(h.previous_salary)}</td>
        <td>${h.hike_type === 'Fixed' ? '₹' + fmt(h.hike_value) : h.hike_value + '%'}</td>
        <td>₹${fmt(h.new_salary)}</td><td>${h.effective_year||'-'}</td><td>${h.effective_date||'-'}</td><td>${esc(h.source)}</td></tr>`)}
    `)}`;
};

// ---- Salary Hike Cycles ----
PAGES['salary-hike-cycles'] = async (el) => {
  const cycles = await api('/hr/salary-hike-cycles');
  el.innerHTML = `
    <div class="panel"><h3>New Hike Cycle</h3>
      <div class="form-grid">
        <div><label>Cycle Name</label><input id="shc-name" placeholder="e.g. FY2026-27 Annual Hike"></div>
        <div><label>Effective Year</label><input id="shc-year" type="number" value="${new Date().getFullYear()}"></div>
      </div>
      <button class="btn" onclick="createHikeCycle()">Create Draft</button>
    </div>
    ${collapsiblePanel('hike-cycles-list', `Hike Cycles (${cycles.length})`, `
      ${tableHTML(['Cycle', 'Year', 'Employees', 'Total Increase (₹)', 'Status', ''], cycles, c => `
        <tr><td>${esc(c.cycle_name)}</td><td>${c.effective_year||'-'}</td><td>${c.item_count}</td><td>₹${fmt(c.total_increase)}</td><td>${badge(c.status)}</td>
        <td><button class="btn small outline" type="button" onclick="openHikeCycle(${c.id})">Open</button></td></tr>`)}
    `)}
    <div class="panel" id="shc-detail-panel" style="display:none;"></div>`;
};
window.createHikeCycle = async () => {
  if (!val('shc-name').trim()) { alert('Cycle name is required.'); return; }
  try {
    const r = await api('/hr/salary-hike-cycles', { method: 'POST', body: JSON.stringify({ cycle_name: val('shc-name'), effective_year: val('shc-year') }) });
    navigate('salary-hike-cycles');
    setTimeout(() => openHikeCycle(r.id), 300);
  } catch (e) { alert(e.message); }
};
window.openHikeCycle = async (id) => {
  const [bundle, depts] = await Promise.all([api(`/hr/salary-hike-cycles/${id}`), api('/masters/departments')]);
  const { cycle, items } = bundle;
  const panel = document.getElementById('shc-detail-panel');
  const totalCurrent = items.reduce((s, i) => s + i.current_salary, 0);
  const totalProposed = items.reduce((s, i) => s + i.proposed_salary, 0);
  const editable = cycle.status === 'Draft';
  panel.innerHTML = `
    <h3>${esc(cycle.cycle_name)} <span class="muted">(${cycle.effective_year||'-'})</span> ${badge(cycle.status)}</h3>
    ${editable ? `
      <h4>Bulk-Apply a Hike</h4>
      <div class="form-grid">
        <div><label>Department (optional - blank applies to every active employee)</label><select id="shc-bulk-dept"><option value="">- All departments -</option>${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Hike Type</label><select id="shc-bulk-type"><option value="Percent">Percent</option><option value="Fixed">Fixed (₹)</option></select></div>
        <div><label>Hike Value</label><input id="shc-bulk-value" type="number" placeholder="e.g. 10"></div>
      </div>
      <button class="btn small" type="button" onclick="bulkApplyHike(${cycle.id})">Apply</button>
      <h4>Add / Update One Employee</h4>
      <div class="form-grid">
        <div><label>Employee</label><select id="shc-item-emp">${(window.__EMP_CACHE||[]).map(e => `<option value="${e.id}">${esc(e.full_name)}</option>`).join('')}</select></div>
        <div><label>Hike Type</label><select id="shc-item-type"><option value="Percent">Percent</option><option value="Fixed">Fixed (₹)</option></select></div>
        <div><label>Hike Value</label><input id="shc-item-value" type="number"></div>
      </div>
      <button class="btn small outline" type="button" onclick="addHikeItem(${cycle.id})">Add/Update</button>
    ` : ''}
    <h4>Proposed Hikes (${items.length})</h4>
    ${tableHTML(['Employee', 'Department', 'Current (₹)', 'Hike', 'Proposed (₹)', 'Delta (₹)', editable ? '' : null].filter(x => x !== null), items, i => `
      <tr><td>${esc(i.employee_name)}</td><td>${esc(i.department_name)||'-'}</td><td>₹${fmt(i.current_salary)}</td>
      <td>${i.hike_type === 'Fixed' ? '₹' + fmt(i.hike_value) : i.hike_value + '%'}</td><td>₹${fmt(i.proposed_salary)}</td><td>₹${fmt(i.proposed_salary - i.current_salary)}</td>
      ${editable ? `<td><button class="btn small outline" type="button" onclick="removeHikeItem(${cycle.id},${i.id})">Remove</button></td>` : ''}</tr>`)}
    <p class="muted" style="text-align:right;"><b>Total Current:</b> ₹${fmt(totalCurrent)} &nbsp; <b>Total Proposed:</b> ₹${fmt(totalProposed)} &nbsp; <b>Total Increase:</b> ₹${fmt(totalProposed - totalCurrent)}</p>
    ${editable ? `<button class="btn" onclick="submitHikeCycle(${cycle.id})">Submit for Approval</button>` : ''}
    ${cycle.status === 'Rejected' ? `<button class="btn" onclick="reopenHikeCycle(${cycle.id})">Reopen as Draft</button>` : ''}
  `;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!window.__EMP_CACHE) window.__EMP_CACHE = await api('/hr/employees');
};
window.bulkApplyHike = async (cycleId) => {
  try {
    await api(`/hr/salary-hike-cycles/${cycleId}/bulk-apply`, { method: 'POST', body: JSON.stringify({
      department_id: val('shc-bulk-dept') || null, hike_type: val('shc-bulk-type'), hike_value: val('shc-bulk-value'),
    })});
    openHikeCycle(cycleId);
  } catch (e) { alert(e.message); }
};
window.addHikeItem = async (cycleId) => {
  try {
    await api(`/hr/salary-hike-cycles/${cycleId}/items`, { method: 'POST', body: JSON.stringify({
      employee_id: val('shc-item-emp'), hike_type: val('shc-item-type'), hike_value: val('shc-item-value'),
    })});
    openHikeCycle(cycleId);
  } catch (e) { alert(e.message); }
};
window.removeHikeItem = async (cycleId, itemId) => {
  try { await api(`/hr/salary-hike-cycles/${cycleId}/items/${itemId}`, { method: 'DELETE' }); openHikeCycle(cycleId); }
  catch (e) { alert(e.message); }
};
window.submitHikeCycle = async (cycleId) => {
  if (!confirm('Submit this cycle for approval? It will no longer be editable until a decision is made.')) return;
  try {
    await api(`/hr/salary-hike-cycles/${cycleId}/submit-for-approval`, { method: 'POST', body: '{}' });
    alert('Submitted for approval - HR HOD, then Management.');
    navigate('salary-hike-cycles');
  } catch (e) { alert(e.message); }
};
window.reopenHikeCycle = async (cycleId) => {
  try { await api(`/hr/salary-hike-cycles/${cycleId}/reopen`, { method: 'POST', body: '{}' }); openHikeCycle(cycleId); }
  catch (e) { alert(e.message); }
};

// ---- Salary Report (department-wise / org-wide, oversight-scoped) ----
PAGES['salary-report'] = async (el) => {
  const [report, cycles] = await Promise.all([api('/hr/salary-report'), api('/hr/salary-hike-cycles').catch(() => [])]);
  const appliedCycles = cycles.filter(c => c.status === 'Applied' || c.status === 'PendingApproval' || c.status === 'Approved');
  el.innerHTML = `
    <div class="panel"><h3>Salary Report</h3>
      <div class="form-grid">
        <div><label>Compare Against Cycle (optional)</label><select id="sr-cycle" onchange="loadSalaryReport()"><option value="">- Current salaries only -</option>${appliedCycles.map(c => `<option value="${c.id}">${esc(c.cycle_name)}</option>`).join('')}</select></div>
      </div>
      <div id="sr-body"></div>
    </div>`;
  renderSalaryReport(report);
};
window.loadSalaryReport = async () => {
  const cycleId = val('sr-cycle');
  const report = await api('/hr/salary-report' + (cycleId ? `?cycle_id=${cycleId}` : ''));
  renderSalaryReport(report);
};
function renderSalaryReport(report) {
  const body = document.getElementById('sr-body');
  const hasProposed = report.rows.some(r => r.proposed_salary != null);
  body.innerHTML = `
    <h4>By Department</h4>
    ${tableHTML(['Department', 'Headcount', 'Total Current (₹)', 'Min (₹)', 'Max (₹)'].concat(hasProposed ? ['Total Proposed (₹)', 'Min Proposed (₹)', 'Max Proposed (₹)'] : []), report.departments, d => `
      <tr><td>${esc(d.department_name)}</td><td>${d.headcount}</td><td>₹${fmt(d.total_current)}</td><td>₹${fmt(d.min_current)}</td><td>₹${fmt(d.max_current)}</td>
      ${hasProposed ? `<td>${d.total_proposed!=null?'₹'+fmt(d.total_proposed):'-'}</td><td>${d.min_proposed!=null?'₹'+fmt(d.min_proposed):'-'}</td><td>${d.max_proposed!=null?'₹'+fmt(d.max_proposed):'-'}</td>` : ''}</tr>`)}
    <p class="muted"><b>Org-wide:</b> ${report.org_wide.headcount} employees, total ₹${fmt(report.org_wide.total_current)}, min ₹${fmt(report.org_wide.min_current)}, max ₹${fmt(report.org_wide.max_current)}
      ${hasProposed && report.org_wide.total_proposed != null ? ` &rarr; proposed total ₹${fmt(report.org_wide.total_proposed)}, min ₹${fmt(report.org_wide.min_proposed)}, max ₹${fmt(report.org_wide.max_proposed)}` : ''}</p>
    ${collapsiblePanel('salary-report-detail', `Employee Detail (${report.rows.length})`, `
      ${tableHTML(['Employee', 'Department', 'Current (₹)'].concat(hasProposed ? ['Proposed (₹)'] : []), report.rows, r => `
        <tr><td>${esc(r.full_name)}</td><td>${esc(r.department_name)||'-'}</td><td>₹${fmt(r.current_salary)}</td>
        ${hasProposed ? `<td>${r.proposed_salary!=null?'₹'+fmt(r.proposed_salary):'-'}</td>` : ''}</tr>`)}
    `)}`;
}

// ---- Attendance ----
function renderTodayLeavesSummaryHTML(summary) {
  const departments = (summary && summary.departments) || [];
  const total = (summary && summary.total) || 0;
  if (!total) {
    return `<div class="panel"><h3>Today's Leave Status (${today()})</h3><p class="muted">Nobody is on approved leave today.</p></div>`;
  }
  const cards = departments.map(d => `
    <div class="panel" style="margin-bottom:10px;">
      <strong>${esc(d.department_name)}</strong> <span class="muted">(${d.employees.length} on leave)</span>
      <table style="margin-top:8px;"><thead><tr><th>Employee</th><th>Leave Type</th><th>Duration</th><th>Reason</th></tr></thead><tbody>
        ${d.employees.map(e => `<tr>
          <td>${esc(e.employee_name)}</td>
          <td>${badge(e.leave_type || '-')}</td>
          <td>${e.from_date} to ${e.to_date} (${e.days}d)</td>
          <td>${esc(e.reason || '-')}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>`).join('');
  return collapsiblePanel('today-leaves-summary', `Today's Leave Status (${today()}) - ${total} on leave`, cards);
}

// Next-4-weeks planning view (2026-10-26) - toggles between a by-department
// and a by-week grouping of the same already-fetched flat row list, rather
// than two separate fetches; the owner explicitly asked for both layouts
// with a toggle, not one or the other.
let UPCOMING_LEAVES_VIEW = 'department';
window.__UPCOMING_LEAVES_ROWS = [];
function dateAddDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
function upcomingLeaveRowHTML(r) {
  return `<tr>
    <td>${esc(r.department_name)}</td>
    <td>${esc(r.employee_name)}</td>
    <td>${badge(r.leave_type || '-')}</td>
    <td>${r.from_date} to ${r.to_date} (${r.days}d)</td>
    <td>${badge(r.status)}</td>
    <td>${esc(r.reason || '-')}</td>
  </tr>`;
}
function renderUpcomingLeavesByDepartment(rows) {
  const byDept = {};
  const order = [];
  rows.forEach(r => {
    const key = r.dept_id == null ? 'unassigned' : r.dept_id;
    if (!byDept[key]) { byDept[key] = { department_name: r.department_name, rows: [] }; order.push(key); }
    byDept[key].rows.push(r);
  });
  return order.map(key => {
    const d = byDept[key];
    return `<div class="panel" style="margin-bottom:10px;">
      <strong>${esc(d.department_name)}</strong> <span class="muted">(${d.rows.length} upcoming)</span>
      <table style="margin-top:8px;"><thead><tr><th>Department</th><th>Employee</th><th>Leave Type</th><th>Duration</th><th>Status</th><th>Reason</th></tr></thead><tbody>
        ${d.rows.map(upcomingLeaveRowHTML).join('')}
      </tbody></table>
    </div>`;
  }).join('');
}
function renderUpcomingLeavesByWeek(rows) {
  const start = today();
  const weeks = [0, 1, 2, 3].map(i => ({
    label: `Week ${i + 1} (${dateAddDays(start, i * 7)} to ${dateAddDays(start, i * 7 + 6)})`,
    from: dateAddDays(start, i * 7), to: dateAddDays(start, i * 7 + 6), rows: [],
  }));
  rows.forEach(r => {
    const w = weeks.find(w => r.from_date <= w.to && r.to_date >= w.from);
    if (w) w.rows.push(r);
  });
  return weeks.map(w => `
    <div class="panel" style="margin-bottom:10px;">
      <strong>${esc(w.label)}</strong> <span class="muted">(${w.rows.length} out)</span>
      ${w.rows.length ? `<table style="margin-top:8px;"><thead><tr><th>Department</th><th>Employee</th><th>Leave Type</th><th>Duration</th><th>Status</th><th>Reason</th></tr></thead><tbody>
        ${w.rows.map(upcomingLeaveRowHTML).join('')}
      </tbody></table>` : '<p class="muted" style="margin-top:6px;">Nobody out this week.</p>'}
    </div>`).join('');
}
window.switchUpcomingLeavesView = (view) => {
  UPCOMING_LEAVES_VIEW = view;
  const body = document.getElementById('upcoming-leaves-body');
  if (body) body.innerHTML = renderUpcomingLeavesBody(window.__UPCOMING_LEAVES_ROWS);
};
function renderUpcomingLeavesBody(rows) {
  const toggle = `<div style="margin-bottom:10px;">
    <button class="btn small ${UPCOMING_LEAVES_VIEW === 'department' ? '' : 'outline'}" type="button" onclick="switchUpcomingLeavesView('department')">By Department</button>
    <button class="btn small ${UPCOMING_LEAVES_VIEW === 'week' ? '' : 'outline'}" type="button" onclick="switchUpcomingLeavesView('week')">By Week</button>
  </div>`;
  if (!rows.length) return toggle + '<p class="muted">No approved or pending leave in the next 4 weeks.</p>';
  return toggle + (UPCOMING_LEAVES_VIEW === 'week' ? renderUpcomingLeavesByWeek(rows) : renderUpcomingLeavesByDepartment(rows));
}
function renderUpcomingLeavesSummaryHTML(summary) {
  const rows = (summary && summary.rows) || [];
  window.__UPCOMING_LEAVES_ROWS = rows;
  const total = (summary && summary.total) || 0;
  return collapsiblePanel('upcoming-leaves-summary', `Next 4 Weeks - Leave Planning (${total})`, `<div id="upcoming-leaves-body">${renderUpcomingLeavesBody(rows)}</div>`);
}

PAGES.attendance = async (el) => {
  const [emps, records, leaveToday, leaveUpcoming] = await Promise.all([
    api('/hr/employees'),
    api('/hr/attendance?month=' + thisMonth()),
    api('/hr/leaves/today-summary'),
    api('/hr/leaves/upcoming-summary'),
  ]);
  const recMap = {}; records.forEach(r => { recMap[r.employee_id] = recMap[r.employee_id] || {}; recMap[r.employee_id][r.work_date] = r.status; });
  el.innerHTML = `
    ${renderTodayLeavesSummaryHTML(leaveToday)}
    ${renderUpcomingLeavesSummaryHTML(leaveUpcoming)}
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
      <button class="btn" onclick="uploadAttendanceTemplate()">Upload Filled Template</button>
      <div id="at-upload-result"></div>
    </div>
    ${collapsiblePanel('attendance-records', `This Month's Records (${records.length})`, `
      ${tableHTML(['Employee', 'Date', 'Status'], records, r => `<tr><td>${esc(r.full_name)}</td><td>${r.work_date}</td><td>${badge(r.status==='Present'?'Approved':r.status==='Absent'?'Rejected':'Pending')}${r.status}</td></tr>`)}
    `)}`;
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
    ${collapsiblePanel('leave-requests-list', `Leave Requests (${reqs.length})`, `
      ${tableHTML(['Employee', 'Type', 'From', 'To', 'Days', 'Status', ''], reqs, r => `
        <tr><td>${esc(r.full_name)}</td><td>${esc(r.leave_type_name)}</td><td>${r.from_date}</td><td>${r.to_date}</td><td>${r.days}</td><td>${badge(r.status)}</td>
        <td><button class="btn small outline" type="button" onclick="toggleLeaveAttachments(${r.id})">Attachments</button></td></tr>
        <tr id="lv-att-row-${r.id}" style="display:none;"><td colspan="7"><div id="lv-attachments-${r.id}"></div></td></tr>`)}
    `)}`;
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
      <div class="muted">Approval chain: HR then Accounts.</div>
    </div>
    ${collapsiblePanel('advances-list', `Advances (${advs.length})`, `
      ${tableHTML(['Employee', 'Amount', 'Recovered', 'Installments', 'Status', 'Date', ''], advs, a => `
        <tr><td>${esc(a.full_name)}</td><td>₹${fmt(a.amount)}</td><td>₹${fmt(a.recovered_amount)} / ₹${fmt(a.amount)}</td>
        <td>${a.installments_paid || 0} / ${a.installments || 1} (₹${fmt(a.installment_amount)} each)</td>
        <td>${badge(a.status)}</td><td>${new Date(a.request_date).toLocaleDateString()}</td>
        <td><button class="btn small outline" type="button" onclick="toggleAdvanceAttachments(${a.id})">Attachments</button></td></tr>
        <tr id="ad-att-row-${a.id}" style="display:none;"><td colspan="7"><div id="ad-attachments-${a.id}"></div></td></tr>`)}
    `)}`;
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
    ${collapsiblePanel('salary-schedule', `Salary Schedule &mdash; ${month} (${schedule.length})`, `
      ${tableHTML(['Employee', 'Days Present', 'Gross', 'Leave Ded.', 'Advance Ded.', 'Net Pay', 'Status', 'Action'], schedule, s => `
        <tr><td>${esc(s.full_name)}</td><td>${s.days_present}</td><td>₹${fmt(s.gross)}</td><td>₹${fmt(s.leave_deduction)}</td><td>₹${fmt(s.advance_deduction)}</td><td>₹${fmt(s.net_pay)}</td><td>${badge(s.status)}</td>
        <td>${payrollActions(s)}</td></tr>`)}
    `)}`;
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

// ===================== Technician Tour Advance/Expense Ledger =====================
// "My Travel & Expense" (technician self-service, mobile-first day entry)
// and "Technician Expense Review" (Accounts/HOD line-by-line review) - see
// CLAUDE.md's 2026-11-15 entry for the full design.
window.TEM_STATE = { legs: [{ mode_of_transport: '', from_location: '', to_location: '', amount: '' }], legFiles: {}, lodgingOn: false, lodging: { name: '', amount: '' }, lodgingFile: null, foodOn: false, food: { amount: '' }, foodFile: null, editingId: null };
function temResetState() {
  window.TEM_STATE = { legs: [{ mode_of_transport: '', from_location: '', to_location: '', amount: '' }], legFiles: {}, lodgingOn: false, lodging: { name: '', amount: '' }, lodgingFile: null, foodOn: false, food: { amount: '' }, foodFile: null, editingId: null };
}
PAGES['tour-expenses-mine'] = async (el) => {
  if (!ME.employee_id) { el.innerHTML = `<div class="panel"><p class="msg err">Your login has no linked employee record, so there's nothing to log travel/expense against. Ask Admin to link one under Users & Roles.</p></div>`; return; }
  const month = window.__TEM_MONTH || thisMonth();
  window.__TEM_MONTH = month;
  const [days, months, advances] = await Promise.all([
    api(`/tour-expenses/days?month=${month}`), api('/tour-expenses/months'), api('/tour-expenses/advances'),
  ]);
  window.__TEM_DAYS = days;
  const monthRow = months.find(m => m.month === month);
  const totalAdvance = advances.reduce((s, a) => s + a.amount, 0);
  const locked = monthRow && monthRow.status !== 'Draft';
  temResetState();
  el.innerHTML = `
    <div class="panel">
      <h3>My Travel &amp; Expense</h3>
      <div class="form-grid">
        <div><label>Month</label><input type="month" id="tem-month" value="${month}" onchange="window.__TEM_MONTH=this.value;navigate('tour-expenses-mine')"></div>
        <div><label>Tour Advance Issued (all-time)</label><input value="&#8377;${fmt(totalAdvance)}" disabled></div>
        <div><label>Month Status</label><input value="${esc(monthRow ? monthRow.status : 'Draft')}" disabled></div>
      </div>
      ${locked ? `<p class="msg err">${esc(month)} has already been submitted for review - no further days can be logged or edited this month.</p>` :
        `<button class="btn" onclick="navigate('tour-expenses-mine');document.getElementById('tem-editor').scrollIntoView({behavior:'smooth'})">+ Log a day</button>
         <button class="btn outline" onclick="submitTemMonth()">Submit ${esc(month)} for Review</button>`}
      <div id="tem-editor" style="margin-top:14px;"></div>
    </div>
    ${collapsiblePanel('tem-days', `Logged Days (${days.length})`, `<div id="tem-days-body">${renderTemDaysList(days)}</div>`)}
    <div class="panel">
      <h3>Monthly Expense (separate lump-sum claim)</h3>
      <div class="form-grid">
        <div><label>What is it</label><input id="tem-allow-label" value="${esc(monthRow && monthRow.allowance_label || '')}" placeholder="e.g. Mobile &amp; data allowance" ${monthRow && monthRow.allowance_status !== 'Pending' && monthRow.allowance_amount != null ? 'disabled' : ''}></div>
        <div><label>Amount (&#8377;)</label><input type="number" id="tem-allow-amount" value="${monthRow && monthRow.allowance_amount != null ? monthRow.allowance_amount : ''}" ${monthRow && monthRow.allowance_status !== 'Pending' && monthRow.allowance_amount != null ? 'disabled' : ''}></div>
        <div><label>Receipt</label><input type="file" id="tem-allow-file" ${monthRow && monthRow.allowance_status !== 'Pending' && monthRow.allowance_amount != null ? 'disabled' : ''}></div>
      </div>
      ${monthRow && monthRow.allowance_amount != null ? `<p>Status: ${badge(monthRow.allowance_status)}${monthRow.allowance_reason ? ' - ' + esc(monthRow.allowance_reason) : ''}</p>` : ''}
      ${!monthRow || monthRow.allowance_status === 'Pending' || monthRow.allowance_amount == null ? `<button class="btn" onclick="saveTemAllowance()">Save Monthly Expense Claim</button>` : ''}
    </div>`;
  renderTemEditor();
};
function renderTemDaysList(days) {
  if (!days.length) return '<p class="muted">No days logged yet this month.</p>';
  return tableHTML(['Date', 'Travel', 'Lodging', 'Food', 'Claimed (&#8377;)', 'Status', ''], days, (d) => `
    <tr>
      <td>${esc(d.entry_date)}</td>
      <td>${d.legs.map(l => esc(l.mode_of_transport) + (l.from_location ? ' ' + esc(l.from_location) + '&rarr;' + esc(l.to_location || '') : '')).join(', ')}</td>
      <td>${d.lodging_claimed ? '&#8377;' + fmt(d.lodging_amount) : '-'}</td>
      <td>${d.food_claimed ? '&#8377;' + fmt(d.food_amount) : '-'}</td>
      <td>&#8377;${fmt(d.claimed_amount)}${d.status !== 'Open' ? ` (approved &#8377;${fmt(d.approved_amount)})` : ''}</td>
      <td>${badge(d.status)}${d.review_reason ? '<br><span class="muted">' + esc(d.review_reason) + '</span>' : ''}</td>
      <td>${actionButtonsCell(d.status === 'Open' ? `<button class="btn small outline" onclick="editTemDay(${d.id})">Edit</button><button class="btn small outline" onclick="deleteTemDay(${d.id})">Delete</button>` : '')}</td>
    </tr>`);
}
window.editTemDay = (id) => {
  const d = (window.__TEM_DAYS || []).find(x => x.id === id);
  if (!d) return;
  window.TEM_STATE = {
    editingId: d.id, legs: d.legs.map(l => ({ mode_of_transport: l.mode_of_transport, from_location: l.from_location || '', to_location: l.to_location || '', amount: l.amount })),
    legFiles: {}, lodgingOn: !!d.lodging_claimed, lodging: { name: d.lodging_name || '', amount: d.lodging_amount || '' }, lodgingFile: null,
    foodOn: !!d.food_claimed, food: { amount: d.food_amount || '' }, foodFile: null, entryDate: d.entry_date,
  };
  renderTemEditor();
  document.getElementById('tem-editor').scrollIntoView({ behavior: 'smooth' });
};
window.deleteTemDay = async (id) => {
  if (!confirm('Delete this day\'s entry?')) return;
  try { await api(`/tour-expenses/days/${id}`, { method: 'DELETE' }); navigate('tour-expenses-mine'); } catch (e) { alert(e.message); }
};
const TEM_MODES = ['Bus', 'Taxi', 'Auto', 'Train', 'Flight', 'Own Vehicle', 'Other'];
function renderTemEditor() {
  const el = document.getElementById('tem-editor');
  if (!el) return;
  const s = window.TEM_STATE;
  el.innerHTML = `
    <div class="panel" style="background:var(--panel-bg,#f7f8fa);">
      <h4 style="margin-top:0;">${s.editingId ? 'Edit' : 'Log'} Day ${s.entryDate ? '- ' + esc(s.entryDate) : ''}</h4>
      ${!s.editingId ? `<div class="form-grid"><div><label>Date</label><input type="date" id="tem-date" value="${today()}"></div></div>` : ''}
      <h5>Travel</h5>
      <div id="tem-legs">${s.legs.map((l, i) => `
        <div class="form-grid" style="margin-bottom:6px;">
          <div><label>Mode</label><select onchange="TEM_STATE.legs[${i}].mode_of_transport=this.value">
            <option value="">- select -</option>${TEM_MODES.map(m => `<option value="${m}" ${l.mode_of_transport===m?'selected':''}>${m}</option>`).join('')}
          </select></div>
          <div><label>From</label><input value="${esc(l.from_location)}" onchange="TEM_STATE.legs[${i}].from_location=this.value"></div>
          <div><label>To</label><input value="${esc(l.to_location)}" onchange="TEM_STATE.legs[${i}].to_location=this.value"></div>
          <div><label>Amount (&#8377;)</label><input type="number" value="${l.amount}" onchange="TEM_STATE.legs[${i}].amount=this.value"></div>
          <div><label>Receipt</label><input type="file" onchange="TEM_STATE.legFiles[${i}]=this.files[0]"></div>
          <div>${s.legs.length > 1 ? `<button class="btn small outline" type="button" onclick="TEM_STATE.legs.splice(${i},1);renderTemEditor()">Remove</button>` : ''}</div>
        </div>`).join('')}</div>
      <button class="btn small outline" type="button" onclick="TEM_STATE.legs.push({mode_of_transport:'',from_location:'',to_location:'',amount:''});renderTemEditor()">+ Add another leg</button>
      <h5>Lodging <label style="font-size:12px;font-weight:400;"><input type="checkbox" ${s.lodgingOn?'checked':''} onchange="TEM_STATE.lodgingOn=this.checked;renderTemEditor()"> had a stay today</label></h5>
      ${s.lodgingOn ? `<div class="form-grid">
        <div><label>Hotel / stay name</label><input value="${esc(s.lodging.name)}" onchange="TEM_STATE.lodging.name=this.value"></div>
        <div><label>Amount (&#8377;)</label><input type="number" value="${s.lodging.amount}" onchange="TEM_STATE.lodging.amount=this.value"></div>
        <div><label>Receipt</label><input type="file" onchange="TEM_STATE.lodgingFile=this.files[0]"></div>
      </div>` : ''}
      <h5>Food <label style="font-size:12px;font-weight:400;"><input type="checkbox" ${s.foodOn?'checked':''} onchange="TEM_STATE.foodOn=this.checked;renderTemEditor()"> separate claim today</label></h5>
      ${s.foodOn ? `<div class="form-grid">
        <div><label>Amount (&#8377;)</label><input type="number" value="${s.food.amount}" onchange="TEM_STATE.food.amount=this.value"></div>
        <div><label>Receipt (optional)</label><input type="file" onchange="TEM_STATE.foodFile=this.files[0]"></div>
      </div>` : ''}
      <button class="btn" onclick="saveTemDay()">Save this day</button>
      <button class="btn outline" type="button" onclick="temResetState();renderTemEditor()">Cancel</button>
      <div id="tem-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>`;
}
window.saveTemDay = async () => {
  const errEl = document.getElementById('tem-err');
  errEl.style.display = 'none';
  const s = window.TEM_STATE;
  const entryDate = s.editingId ? s.entryDate : val('tem-date');
  try {
    const day = await api('/tour-expenses/days', { method: 'POST', body: JSON.stringify({
      entry_date: entryDate,
      legs: s.legs.map(l => ({ mode_of_transport: l.mode_of_transport, from_location: l.from_location, to_location: l.to_location, amount: l.amount })),
      lodging: { claimed: s.lodgingOn, name: s.lodging.name, amount: s.lodging.amount },
      food: { claimed: s.foodOn, amount: s.food.amount },
    })});
    for (let i = 0; i < day.legs.length; i++) {
      const f = s.legFiles[i];
      if (f) { const fd = new FormData(); fd.append('file', f); await apiUpload(`/tour-expenses/legs/${day.legs[i].id}/receipt`, fd); }
    }
    if (s.lodgingOn && s.lodgingFile) { const fd = new FormData(); fd.append('file', s.lodgingFile); await apiUpload(`/tour-expenses/days/${day.id}/lodging-receipt`, fd); }
    if (s.foodOn && s.foodFile) { const fd = new FormData(); fd.append('file', s.foodFile); await apiUpload(`/tour-expenses/days/${day.id}/food-receipt`, fd); }
    navigate('tour-expenses-mine');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.submitTemMonth = async () => {
  if (!confirm(`Submit ${window.__TEM_MONTH} for review? No day this month can be edited after this.`)) return;
  try { await api('/tour-expenses/months/submit', { method: 'POST', body: JSON.stringify({ month: window.__TEM_MONTH }) }); navigate('tour-expenses-mine'); }
  catch (e) { alert(e.message); }
};
window.saveTemAllowance = async () => {
  try {
    await api('/tour-expenses/months/allowance', { method: 'POST', body: JSON.stringify({ month: window.__TEM_MONTH, label: val('tem-allow-label'), amount: val('tem-allow-amount') }) });
    const fileInput = document.getElementById('tem-allow-file');
    if (fileInput && fileInput.files.length) {
      const fd = new FormData(); fd.append('file', fileInput.files[0]); fd.append('month', window.__TEM_MONTH);
      await apiUpload('/tour-expenses/months/allowance/receipt', fd);
    }
    navigate('tour-expenses-mine');
  } catch (e) { alert(e.message); }
};

// ---- Technician Expense Review (Accounts/HOD) ----
PAGES['tour-expenses-review'] = async (el) => {
  const employees = await api('/hr/employees');
  window.__TER_EMPLOYEES = employees;
  const employeeId = window.__TER_EMPLOYEE_ID || (employees[0] && employees[0].id);
  const month = window.__TER_MONTH || thisMonth();
  window.__TER_EMPLOYEE_ID = employeeId; window.__TER_MONTH = month;
  el.innerHTML = `
    <div class="panel">
      <h3>Technician Expense Review</h3>
      <div class="form-grid">
        <div><label>Technician</label><select id="ter-emp" onchange="window.__TER_EMPLOYEE_ID=Number(this.value);navigate('tour-expenses-review')">
          ${employees.map(e => `<option value="${e.id}" ${e.id===employeeId?'selected':''}>${esc(e.full_name)}</option>`).join('')}
        </select></div>
        <div><label>Month</label><input type="month" value="${month}" onchange="window.__TER_MONTH=this.value;navigate('tour-expenses-review')"></div>
      </div>
    </div>
    <div class="panel">
      <h4>Issue Tour Advance</h4>
      <div class="form-grid">
        <div><label>Amount (&#8377;)</label><input type="number" id="ter-adv-amount"></div>
        <div><label>Date</label><input type="date" id="ter-adv-date" value="${today()}"></div>
        <div><label>Mode</label><select id="ter-adv-mode"><option>Cash</option><option>Bank</option></select></div>
        <div><label>Notes</label><input id="ter-adv-notes"></div>
      </div>
      <button class="btn" onclick="issueTourAdvance()">Issue Advance</button>
    </div>
    <div id="ter-body"></div>`;
  if (employeeId) await loadTerBundle();
};
window.issueTourAdvance = async () => {
  try {
    await api('/tour-expenses/advances', { method: 'POST', body: JSON.stringify({
      employee_id: window.__TER_EMPLOYEE_ID, amount: val('ter-adv-amount'), issued_date: val('ter-adv-date'), payment_mode: val('ter-adv-mode'), notes: val('ter-adv-notes'),
    })});
    navigate('tour-expenses-review');
  } catch (e) { alert(e.message); }
};
async function loadTerBundle() {
  const bundle = await api(`/tour-expenses/review-bundle?employee_id=${window.__TER_EMPLOYEE_ID}&month=${window.__TER_MONTH}`);
  window.__TER_BUNDLE = bundle;
  const t = bundle.totals;
  const body = document.getElementById('ter-body');
  if (!body) return;
  body.innerHTML = `
    <div class="panel">
      <div class="form-grid">
        <div><label>Advance Issued (all-time)</label><input value="&#8377;${fmt(t.advance)}" disabled></div>
        <div><label>Claimed (all sources, this month)</label><input value="&#8377;${fmt(t.claimed)}" disabled></div>
        <div><label>Approved So Far</label><input value="&#8377;${fmt(t.approved)}" disabled></div>
        <div><label>Balance to Return</label><input value="${t.balance >= 0 ? 'Returns' : 'Owed'} &#8377;${fmt(Math.abs(t.balance))}" disabled></div>
      </div>
    </div>
    ${collapsiblePanel('ter-days', `Daily Travel, Lodging &amp; Food (${bundle.days.length} days)`, `<div>${renderTerDaysTable(bundle.days)}</div>`)}
    ${collapsiblePanel('ter-svc', `Service Visit Charges - Up/Down &amp; Food (${bundle.serviceReports.length})`, `<div>${renderTerSvcTable(bundle.serviceReports)}</div>`)}
    <div class="panel">
      <h4>Monthly Expense Claim</h4>
      ${bundle.monthRow && bundle.monthRow.allowance_amount != null ? `
        <p>${esc(bundle.monthRow.allowance_label || 'Monthly expense')}: &#8377;${fmt(bundle.monthRow.allowance_amount)} - ${badge(bundle.monthRow.allowance_status)}
          ${bundle.monthRow.allowance_attachment_path ? ` <a href="${bundle.monthRow.allowance_attachment_path}" target="_blank">Receipt</a>` : ''}
          ${bundle.monthRow.allowance_reason ? '<br><span class="muted">' + esc(bundle.monthRow.allowance_reason) + '</span>' : ''}</p>
        ${bundle.monthRow.allowance_status === 'Pending' ? `
          <button class="btn small green" onclick="decideTerAllowance('Approve')">Approve</button>
          <button class="btn small outline" onclick="decideTerAllowance('Adjust')">Adjust</button>
          <button class="btn small outline" onclick="decideTerAllowance('Reject')">Reject</button>` : ''}
      ` : '<p class="muted">No monthly expense claim filed for this month.</p>'}
    </div>
    <div class="panel">
      <div class="form-grid">
        <div><label>Collected (approved Service Reports)</label><input value="&#8377;${fmt(t.collected)}" disabled></div>
        <div><label>Approved Expenses</label><input value="&#8377;${fmt(t.approvedExpenses)}" disabled></div>
        <div><label>Net (Earnings vs. Expenses)</label><input value="${t.net >= 0 ? 'Earns' : 'Expenses exceed by'} &#8377;${fmt(Math.abs(t.net))}" disabled></div>
      </div>
      <button class="btn" onclick="finalizeTerMonth()">Finalize Month &amp; Post to Ledger</button>
      <div id="ter-finalize-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>`;
}
function renderTerDaysTable(days) {
  if (!days.length) return '<p class="muted">No days logged yet this month.</p>';
  return tableHTML(['Date', 'Travel', 'Lodging', 'Food', 'Claimed (&#8377;)', 'Status', ''], days, (d) => `
    <tr>
      <td>${esc(d.entry_date)}</td>
      <td>${d.legs.map(l => `${esc(l.mode_of_transport)} ${esc(l.from_location||'')}&rarr;${esc(l.to_location||'')} (&#8377;${fmt(l.amount)})${l.attachment_path ? ` <a href="${l.attachment_path}" target="_blank">receipt</a>` : ' <span class="muted">(no receipt)</span>'}`).join('<br>')}</td>
      <td>${d.lodging_claimed ? `${esc(d.lodging_name||'')} &#8377;${fmt(d.lodging_amount)}${d.lodging_attachment_path ? ` <a href="${d.lodging_attachment_path}" target="_blank">receipt</a>` : ' <span class="muted">(no receipt)</span>'}` : '-'}</td>
      <td>${d.food_claimed ? `&#8377;${fmt(d.food_amount)}${d.food_attachment_path ? ` <a href="${d.food_attachment_path}" target="_blank">receipt</a>` : ''}` : '-'}</td>
      <td>&#8377;${fmt(d.claimed_amount)}</td>
      <td>${badge(d.status)}${d.review_reason ? '<br><span class="muted">' + esc(d.review_reason) + '</span>' : ''}${d.approved_amount != null ? '<br>Approved: &#8377;' + fmt(d.approved_amount) : ''}</td>
      <td>${actionButtonsCell(d.status === 'PendingReview' ? `
        <button class="btn small green" onclick="decideTerDay(${d.id},'Approve')">Approve</button>
        <button class="btn small outline" onclick="decideTerDay(${d.id},'Adjust')">Adjust</button>
        <button class="btn small outline" onclick="decideTerDay(${d.id},'Reject')">Reject</button>` : '')}</td>
    </tr>`);
}
function renderTerSvcTable(rows) {
  if (!rows.length) return '<p class="muted">No Service Reports with an Up/Down &amp; Food charge this month.</p>';
  return tableHTML(['Date', 'SR No', 'Customer', 'Claimed (&#8377;)', 'Status', ''], rows, (r) => `
    <tr>
      <td>${esc(r.activity_date)}</td><td>${esc(r.sr_no)}</td><td>${esc(r.client_name || r.customer_name || '-')}</td>
      <td>&#8377;${fmt(r.amount_updown_food)}</td>
      <td>${badge(r.updown_food_status)}${r.updown_food_reason ? '<br><span class="muted">' + esc(r.updown_food_reason) + '</span>' : ''}${r.updown_food_approved_amount != null ? '<br>Approved: &#8377;' + fmt(r.updown_food_approved_amount) : ''}</td>
      <td>${actionButtonsCell(r.updown_food_status === 'Pending' ? `
        <button class="btn small green" onclick="decideTerSvc(${r.id},'Approve')">Approve</button>
        <button class="btn small outline" onclick="decideTerSvc(${r.id},'Adjust')">Adjust</button>
        <button class="btn small outline" onclick="decideTerSvc(${r.id},'Reject')">Reject</button>` : '')}</td>
    </tr>`);
}
async function terReasonAndAmount(action, claimedAmount) {
  let approved_amount, reason;
  if (action === 'Adjust') {
    approved_amount = prompt(`Approve what amount (of ₹${fmt(claimedAmount)} claimed)?`, claimedAmount);
    if (approved_amount === null) return null;
    reason = prompt('Reason for the adjustment (shown to the technician):');
    if (reason === null || !reason.trim()) return null;
  } else if (action === 'Reject') {
    reason = prompt('Reason for rejecting this claim (shown to the technician):');
    if (reason === null || !reason.trim()) return null;
  }
  return { approved_amount, reason };
}
window.decideTerDay = async (id, action) => {
  const day = window.__TER_BUNDLE.days.find(d => d.id === id);
  const extra = await terReasonAndAmount(action, day.claimed_amount);
  if (action !== 'Approve' && !extra) return;
  try { await api(`/tour-expenses/days/${id}/decide`, { method: 'POST', body: JSON.stringify({ action, ...(extra || {}) }) }); navigate('tour-expenses-review'); }
  catch (e) { alert(e.message); }
};
window.decideTerAllowance = async (action) => {
  const m = window.__TER_BUNDLE.monthRow;
  const extra = await terReasonAndAmount(action, m.allowance_amount);
  if (action !== 'Approve' && !extra) return;
  try { await api(`/tour-expenses/months/${window.__TER_EMPLOYEE_ID}/${window.__TER_MONTH}/allowance/decide`, { method: 'POST', body: JSON.stringify({ action, ...(extra || {}) }) }); navigate('tour-expenses-review'); }
  catch (e) { alert(e.message); }
};
window.decideTerSvc = async (id, action) => {
  const r = window.__TER_BUNDLE.serviceReports.find(x => x.id === id);
  const extra = await terReasonAndAmount(action, r.amount_updown_food);
  if (action !== 'Approve' && !extra) return;
  try { await api(`/tour-expenses/service-reports/${id}/updown-decide`, { method: 'POST', body: JSON.stringify({ action, ...(extra || {}) }) }); navigate('tour-expenses-review'); }
  catch (e) { alert(e.message); }
};
window.finalizeTerMonth = async () => {
  const errEl = document.getElementById('ter-finalize-err');
  errEl.style.display = 'none';
  if (!confirm(`Finalize ${window.__TER_MONTH} for this technician? This locks the month.`)) return;
  try { await api(`/tour-expenses/months/${window.__TER_EMPLOYEE_ID}/${window.__TER_MONTH}/finalize`, { method: 'POST' }); navigate('tour-expenses-review'); }
  catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
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
          <td><input id="lt-name-${t.id}" value="${esc(t.name)}"></td>
          <td><input id="lt-quota-${t.id}" type="number" step="0.5" value="${t.annual_quota}"></td>
          <td><select id="lt-paid-${t.id}"><option value="1" ${t.is_paid ? 'selected' : ''}>Paid</option><option value="0" ${!t.is_paid ? 'selected' : ''}>Unpaid</option></select></td>
          <td><input id="lt-probation-${t.id}" type="number" min="0" value="${t.probation_months || 0}"></td>
          <td><input id="lt-accrual-${t.id}" value="${esc(t.accrual || 'Annual')}"></td>
          <td><select id="lt-carry-${t.id}"><option value="0" ${!t.carry_forward ? 'selected' : ''}>No</option><option value="1" ${t.carry_forward ? 'selected' : ''}>Yes</option></select></td>
          <td><input id="lt-maxcarry-${t.id}" type="number" step="0.5" value="${t.max_carry_forward || 0}"></td>
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

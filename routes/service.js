const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const { generateServiceReportPdf } = require('../lib/serviceReportPdf');
const { getCompanySettings, getServiceSettings } = require('../lib/settings');
const router = express.Router();
router.use(authRequired);

// Technician job-state machine (part B): Assigned/OnHold -> InProgress (Start/Restart),
// InProgress -> OnHold (Hold). Completed is set by the server on final report submit,
// never via this action endpoint.
const JOB_STATUS_TRANSITIONS = {
  start: { from: ['Assigned', 'OnHold'], to: 'InProgress' },
  hold: { from: ['InProgress'], to: 'OnHold' },
  restart: { from: ['OnHold'], to: 'InProgress' },
};

const { getUploadsSubdir } = require('../lib/paths');
const uploadDir = getUploadsSubdir('service-reports');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// Only the Service department's HOD/Supervisor (or Admin) can open a logged
// request and create its schedule (assign an employee + date) - anyone with
// service_request.manage can log step one, but scheduling is step two.
function isServiceHOD(user) {
  return user.role_name === 'Admin' || (user.role_name === 'Service' && !!user.is_supervisor);
}

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT sr.*, c.name as client_master_name, e.full_name as employee_name, u.full_name as assigned_to_name,
      (SELECT COUNT(*) FROM service_reports WHERE service_request_id = sr.id) as report_count
    FROM service_requests sr
    LEFT JOIN clients c ON c.id = sr.client_id
    LEFT JOIN employees e ON e.id = sr.employee_id
    LEFT JOIN users u ON u.id = sr.assigned_to
    ORDER BY sr.id DESC
  `).all();
  const windowDays = getServiceSettings().reopen_window_days;
  res.json(rows.map(r => {
    let can_reopen = false;
    if (r.status === 'Closed' && r.closed_at) {
      can_reopen = new Date() <= new Date(new Date(r.closed_at).getTime() + windowDays * 24 * 60 * 60 * 1000);
    }
    return { ...r, can_schedule: isServiceHOD(req.user), can_reopen };
  }));
});

// Step 1: log the request - just the customer/issue details, no schedule
// yet. Anyone with service_request.manage can do this (any Service team
// member, not just the HOD) - it lands in the Service Request Queue for
// the HOD/Supervisor to pick up next.
router.post('/', requirePermission('service_request.manage'), (req, res) => {
  const { client_id, customer_name, contact_person, contact_phone, project_id, issue_description, spare_parts_needed } = req.body;
  if (!client_id && !customer_name) {
    return res.status(400).json({ error: 'Pick a client, or enter a customer name manually.' });
  }
  if (!issue_description) return res.status(400).json({ error: 'Describe the issue.' });
  const srNo = 'SR-' + Date.now();
  const info = db.prepare(`
    INSERT INTO service_requests (sr_no, client_id, customer_name, contact_person, contact_phone, project_id,
      issue_description, spare_parts_needed)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(srNo, client_id || null, customer_name || null, contact_person || null, contact_phone || null,
    project_id || null, issue_description, spare_parts_needed || null);
  res.json({ id: info.lastInsertRowid, sr_no: srNo });
});

// Step 2: the Service HOD/Supervisor opens a logged request and schedules
// it - assigns a service employee (from the Employees table) and a date.
router.patch('/:id/schedule', requirePermission('service_request.manage'), (req, res) => {
  if (!isServiceHOD(req.user)) {
    return res.status(403).json({ error: 'Only the Service HOD/Supervisor (or Admin) can schedule a request.' });
  }
  const existing = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { employee_id, scheduled_date } = req.body;
  if (!employee_id || !scheduled_date) return res.status(400).json({ error: 'Pick both an employee and a date.' });
  db.prepare(`
    UPDATE service_requests SET employee_id = ?, scheduled_date = ?, status = CASE WHEN status IN ('Open','Pending Items') THEN 'Scheduled' ELSE status END
    WHERE id = ?
  `).run(employee_id, scheduled_date, existing.id);
  res.json({ ok: true });
});

router.patch('/:id', requirePermission('service_request.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const {
    status, assigned_to, employee_id, scheduled_date,
    customer_name, contact_person, contact_phone, issue_description, spare_parts_needed,
  } = req.body;
  if ((employee_id !== undefined || scheduled_date !== undefined) && !isServiceHOD(req.user)) {
    return res.status(403).json({ error: 'Only the Service HOD/Supervisor (or Admin) can change the schedule.' });
  }
  const fields = { status, assigned_to, employee_id, scheduled_date, customer_name, contact_person, contact_phone, issue_description, spare_parts_needed };
  const updates = [], params = [];
  Object.entries(fields).forEach(([k, v]) => { if (v !== undefined) { updates.push(`${k} = ?`); params.push(v === '' ? null : v); } });
  if (status === 'Closed' && existing.status !== 'Closed') { updates.push('closed_at = ?'); params.push(new Date().toISOString()); }
  if (!updates.length) return res.json({ ok: true });
  params.push(req.params.id);
  db.prepare(`UPDATE service_requests SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// ===================== Technician job-state actions (part B) =====================
// Start Work / Hold / Restart. Best-effort geolocation is captured on "start"
// only (job start location); the end location is captured on final report submit.
router.patch('/:id/job-status', (req, res) => {
  const sr = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!sr) return res.status(404).json({ error: 'Not found' });
  if (!canFillReport(req, sr)) return res.status(403).json({ error: 'Only the technician this request is scheduled to (or Admin) can update its job status.' });
  const { action, lat, lng } = req.body;
  const rule = JOB_STATUS_TRANSITIONS[action];
  if (!rule) return res.status(400).json({ error: 'Unknown action.' });
  const current = sr.job_status || 'Assigned';
  if (!rule.from.includes(current)) {
    return res.status(400).json({ error: `Cannot ${action} from job status "${current}".` });
  }
  const latNum = (lat !== undefined && lat !== null && lat !== '') ? Number(lat) : null;
  const lngNum = (lng !== undefined && lng !== null && lng !== '') ? Number(lng) : null;
  const tx = db.transaction(() => {
    const startCols = action === 'start'
      ? ', start_lat = ?, start_lng = ?, start_captured_at = CURRENT_TIMESTAMP'
      : '';
    const params = action === 'start' ? [rule.to, latNum, lngNum, sr.id] : [rule.to, sr.id];
    db.prepare(`UPDATE service_requests SET job_status = ?${startCols} WHERE id = ?`).run(...params);
    db.prepare(`
      INSERT INTO service_request_status_log (sr_id, from_status, to_status, changed_by, lat, lng)
      VALUES (?,?,?,?,?,?)
    `).run(sr.id, current, rule.to, req.user.id, latNum, lngNum);
  });
  tx();
  res.json({ ok: true, job_status: rule.to });
});

// History of every submitted service report for this SR (part A: so the
// assigner can review what a previous technician found/did before a
// re-queued SR - e.g. status 'Pending Items' - gets reassigned).
router.get('/:id/reports', (req, res) => {
  const rows = db.prepare(`
    SELECT sr.*, e.full_name as employee_name FROM service_reports sr
    LEFT JOIN employees e ON e.id = sr.employee_id
    WHERE sr.service_request_id = ? ORDER BY sr.id DESC
  `).all(req.params.id);
  res.json(rows);
});

// ===================== 15-day free-of-charge reopen (part C) =====================
router.post('/:id/reopen', requirePermission('service_request.manage'), (req, res) => {
  const sr = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!sr) return res.status(404).json({ error: 'Not found' });
  if (sr.status !== 'Closed') return res.status(400).json({ error: 'Only a Closed SR can be reopened.' });
  if (!sr.closed_at) return res.status(400).json({ error: 'No closure date on record for this SR - cannot verify the 15-day window.' });
  const windowDays = getServiceSettings().reopen_window_days;
  const closedAt = new Date(sr.closed_at);
  const deadline = new Date(closedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
  if (new Date() > deadline) {
    return res.status(400).json({ error: `This SR was closed on ${sr.closed_at.slice(0,10)} - the ${windowDays}-day free-of-charge reopen window has expired.` });
  }
  const { reason } = req.body;
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO service_request_reopenings (sr_id, original_closed_at, reopened_by, technician_id, reason)
      VALUES (?,?,?,?,?)
    `).run(sr.id, sr.closed_at, req.user.id, sr.employee_id || null, reason || null);
    db.prepare(`UPDATE service_requests SET status = 'Open', job_status = 'Assigned', closed_at = NULL WHERE id = ?`).run(sr.id);
    // Folds into the same activity timeline as ordinary notes (below) so
    // "why was this reopened" shows up right alongside everything else
    // support/ops logs against the SR, not only in the separate reopenings report.
    db.prepare(`
      INSERT INTO sr_updates (sr_id, user_id, note, status_change, action_taken) VALUES (?,?,?,?,?)
    `).run(sr.id, req.user.id, reason || null, 'Closed -> Open (reopened)', 'Reopened under the 15-day free-of-charge policy');
  });
  tx();
  res.json({ ok: true });
});

// ===================== Activity log (free-form updates, part E) =====================
// Independent of the formal status/job-status machines above - lets
// support/ops record "called customer, waiting on part" or similar without
// that being a status transition, and gives every real transition
// (including a reopen, logged above) one shared timeline to read back.
function canLogSrUpdate(req, sr) {
  if (req.user.role_name === 'Admin') return true;
  if (canFillReport(req, sr)) return true; // the technician this SR is scheduled to
  const rows = db.prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?
  `).all(req.user.role_id);
  return rows.some(r => r.code === 'service_request.manage');
}
router.get('/:id/updates', (req, res) => {
  const sr = db.prepare('SELECT id FROM service_requests WHERE id = ?').get(req.params.id);
  if (!sr) return res.status(404).json({ error: 'Not found' });
  res.json(db.prepare(`
    SELECT u.*, usr.full_name as user_name FROM sr_updates u LEFT JOIN users usr ON usr.id = u.user_id
    WHERE u.sr_id = ? ORDER BY u.created_at DESC, u.id DESC
  `).all(req.params.id));
});
router.post('/:id/updates', (req, res) => {
  const sr = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!sr) return res.status(404).json({ error: 'Not found' });
  if (!canLogSrUpdate(req, sr)) return res.status(403).json({ error: 'Only the Service team or the assigned technician can log an update on this SR.' });
  const { note, status_change, action_taken } = req.body;
  if (!String(note || '').trim() && !String(action_taken || '').trim()) {
    return res.status(400).json({ error: 'Enter a note or an action taken.' });
  }
  const info = db.prepare(`
    INSERT INTO sr_updates (sr_id, user_id, note, status_change, action_taken) VALUES (?,?,?,?,?)
  `).run(sr.id, req.user.id, note || null, status_change || null, action_taken || null);
  res.json({ id: info.lastInsertRowid });
});

// Simple reporting view: reopen counts grouped by technician, for spotting
// repeat-reopen patterns per company's 15-day free-service policy.
router.get('/reopenings-report', requirePermission('service_request.manage', 'report.view_all'), (req, res) => {
  const rows = db.prepare(`
    SELECT rr.*, sr.sr_no, e.full_name as technician_name
    FROM service_request_reopenings rr
    LEFT JOIN service_requests sr ON sr.id = rr.sr_id
    LEFT JOIN employees e ON e.id = rr.technician_id
    ORDER BY rr.reopened_at DESC
  `).all();
  const byTech = {};
  rows.forEach(r => {
    const key = r.technician_name || 'Unassigned';
    byTech[key] = (byTech[key] || 0) + 1;
  });
  const summary = Object.entries(byTech).map(([technician_name, count]) => ({ technician_name, count })).sort((a,b)=>b.count-a.count);
  res.json({ rows, summary });
});

// ===================== "My Service Requests" (employee's own queue) =====================
// The employee it's scheduled to (matched via users.employee_id) sees it here.
router.get('/mine', (req, res) => {
  if (!req.user.employee_id) return res.json([]);
  const rows = db.prepare(`
    SELECT sr.*, c.name as client_master_name,
      (SELECT id FROM service_reports WHERE service_request_id = sr.id ORDER BY id DESC LIMIT 1) as report_id,
      (SELECT status FROM service_reports WHERE service_request_id = sr.id ORDER BY id DESC LIMIT 1) as report_status
    FROM service_requests sr
    LEFT JOIN clients c ON c.id = sr.client_id
    WHERE sr.employee_id = ?
    ORDER BY sr.id DESC
  `).all(req.user.employee_id);
  res.json(rows);
});

// ===================== Service Reports (Round 3) =====================
// The employee fills this out for a request scheduled to them. Draft is
// editable/re-saveable; on Submit, pending_items routes the flow.
router.get('/:id/report', (req, res) => {
  const report = db.prepare(`
    SELECT sr.*, e.full_name as employee_name FROM service_reports sr LEFT JOIN employees e ON e.id = sr.employee_id
    WHERE sr.service_request_id = ? ORDER BY sr.id DESC LIMIT 1
  `).get(req.params.id);
  if (!report) return res.json(null);
  const spares = db.prepare(`
    SELECT s.*, i.name as item_name, i.unit, sc.name as service_center_name
    FROM service_report_spares s JOIN items i ON i.id = s.item_id LEFT JOIN service_centers sc ON sc.id = s.service_center_id
    WHERE s.service_report_id = ?
  `).all(report.id);
  res.json({ ...report, spares });
});

function canFillReport(req, sr) {
  if (req.user.role_name === 'Admin') return true;
  return req.user.employee_id && req.user.employee_id === sr.employee_id;
}

router.post('/:id/report', upload.single('handwritten_report'), (req, res) => {
  const sr = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!sr) return res.status(404).json({ error: 'Not found' });
  if (!canFillReport(req, sr)) return res.status(403).json({ error: 'Only the employee this request is scheduled to can fill its report.' });
  const {
    pending_items, pending_items_comments, amount_travel, amount_service, amount_spares, submit,
    service_center_id, spares,
    customer_name, customer_address, contact_person, contact_no, engineer_name,
    visit_from, visit_to, days_at_site, activity_date, activity_start_time, activity_end_time,
    machine_type, machine_capacity, type_of_visit, reason_for_visit, faults_found, action_taken,
    completion_remarks, amount_updown_food, machine_working_satisfactorily, visit_rating,
    overall_feedback, customer_remarks, customer_signatory_mobile, engineer_remarks, engineer_signatory_mobile,
    customer_signature_data, end_lat, end_lng,
  } = req.body;
  const existing = db.prepare(`SELECT * FROM service_reports WHERE service_request_id = ? ORDER BY id DESC LIMIT 1`).get(sr.id);
  // "Re-edit" (part B): a report stays editable while it's Draft or Submitted
  // (i.e. has pending items and is back in the assigner's queue) - once it
  // reaches Reconciliation/Approved it's locked for amount-review integrity.
  const isDraftEditable = !existing || existing.status === 'Draft' || existing.status === 'Submitted';
  if (existing && !isDraftEditable) {
    return res.status(400).json({ error: 'This report has moved into reconciliation and can no longer be edited.' });
  }
  const pendingFlag = pending_items === true || pending_items === 'true' || pending_items === '1' || pending_items === 1 ? 1 : 0;
  const isSubmit = submit === true || submit === 'true' || submit === '1';
  const status = isSubmit ? (pendingFlag ? 'Submitted' : 'Reconciliation') : 'Draft';
  const handwrittenPath = req.file ? '/uploads/service-reports/' + req.file.filename : (existing ? existing.handwritten_report_path : null);

  // Mandatory fields (part D): every field is required on FINAL submission,
  // except the attachment (handwritten_report) - a draft/hold save is exempt.
  if (isSubmit) {
    const required = {
      customer_name, customer_address, contact_person, contact_no, engineer_name,
      visit_from, visit_to, days_at_site, activity_date, activity_start_time, activity_end_time,
      machine_type, machine_capacity, type_of_visit, reason_for_visit, faults_found, action_taken,
      completion_remarks, machine_working_satisfactorily, visit_rating, overall_feedback,
      customer_remarks, customer_signatory_mobile, engineer_remarks, engineer_signatory_mobile,
    };
    const missing = Object.entries(required).filter(([k, v]) => v === undefined || v === null || String(v).trim() === '').map(([k]) => k);
    const hasSignature = (existing && existing.customer_signature_path) ||
      (customer_signature_data && /^data:image\/png;base64,/.test(customer_signature_data));
    if (!hasSignature) missing.push('customer_signature');
    if (missing.length) {
      return res.status(400).json({ error: `The following field(s) are required to submit the report: ${missing.join(', ')}.` });
    }
  }

  // Customer signature - drawn on the employee's phone/device (canvas ->
  // PNG data URL). Only overwrite the stored signature when the employee
  // actually drew something new; a blank/untouched canvas never gets sent
  // by the frontend, so any data URL here is a real signature.
  let signaturePath = existing ? existing.customer_signature_path : null;
  if (customer_signature_data && /^data:image\/png;base64,/.test(customer_signature_data)) {
    try {
      const sigDir = path.join(uploadDir, 'signatures');
      fs.mkdirSync(sigDir, { recursive: true });
      const fileName = 'sig-' + Date.now() + '-' + sr.id + '.png';
      fs.writeFileSync(path.join(sigDir, fileName), Buffer.from(customer_signature_data.split(',')[1], 'base64'));
      signaturePath = '/uploads/service-reports/signatures/' + fileName;
    } catch (e) { /* best-effort - don't fail the whole report save over a signature write */ }
  }

  // SL. No (the printed pad's office-copy serial) - auto-generated in
  // sequence the first time a report is created for a request, never
  // editable afterwards.
  let slNo = existing ? existing.sl_no : null;
  if (!existing) {
    const maxRow = db.prepare(`SELECT MAX(CAST(sl_no AS INTEGER)) as m FROM service_reports WHERE sl_no GLOB '[0-9]*'`).get();
    slNo = String((maxRow && maxRow.m ? maxRow.m : 0) + 1);
  }

  // Spares lines (multipart form field, so JSON-encoded) - only meaningful
  // on Submit, which deducts from that service center's stock. Draft saves
  // never touch stock, and a report can only be submitted once (guarded
  // above), so this deduction can never double-count.
  let spareLines = [];
  if (spares) {
    try { spareLines = JSON.parse(spares); } catch (e) { spareLines = []; }
    spareLines = (Array.isArray(spareLines) ? spareLines : []).filter(l => l && l.item_id && Number(l.quantity) > 0);
  }
  const isFirstSubmitCheck = !existing || existing.status === 'Draft';
  if (isSubmit && isFirstSubmitCheck && spareLines.length) {
    if (!service_center_id) return res.status(400).json({ error: 'Pick the service center the spares were drawn from.' });
    const center = db.prepare('SELECT * FROM service_centers WHERE id = ?').get(service_center_id);
    if (!center) return res.status(400).json({ error: 'That service center no longer exists.' });
    const qtyByItem = {};
    spareLines.forEach(l => { qtyByItem[l.item_id] = (qtyByItem[l.item_id] || 0) + Number(l.quantity); });
    for (const itemId of Object.keys(qtyByItem)) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
      if (!item) return res.status(400).json({ error: 'One of the spares no longer exists in the Item Master.' });
      const stockRow = db.prepare('SELECT quantity FROM service_center_stock WHERE service_center_id = ? AND item_id = ?').get(service_center_id, itemId);
      const available = stockRow ? stockRow.quantity : 0;
      if (available < qtyByItem[itemId]) {
        return res.status(400).json({ error: `Insufficient stock at ${center.name} for "${item.name}" - only ${available} ${item.unit || ''} available.` });
      }
    }
  }

  const tx = db.transaction(() => {
    let reportId;
    const extra = {
      sl_no: slNo, customer_name: customer_name || null, customer_address: customer_address || null,
      contact_person: contact_person || null, contact_no: contact_no || null, engineer_name: engineer_name || null,
      visit_from: visit_from || null, visit_to: visit_to || null, days_at_site: Number(days_at_site) || null,
      activity_date: activity_date || null, activity_start_time: activity_start_time || null, activity_end_time: activity_end_time || null,
      machine_type: machine_type || null, machine_capacity: machine_capacity || null, type_of_visit: type_of_visit || null,
      reason_for_visit: reason_for_visit || null, faults_found: faults_found || null, action_taken: action_taken || null,
      completion_remarks: completion_remarks || null, amount_updown_food: Number(amount_updown_food) || 0,
      machine_working_satisfactorily: machine_working_satisfactorily || null, visit_rating: visit_rating || null,
      overall_feedback: overall_feedback || null, customer_remarks: customer_remarks || null,
      customer_signatory_mobile: customer_signatory_mobile || null, customer_signature_path: signaturePath,
      engineer_remarks: engineer_remarks || null, engineer_signatory_mobile: engineer_signatory_mobile || null,
    };
    const extraCols = Object.keys(extra);
    if (existing) {
      db.prepare(`
        UPDATE service_reports SET
          pending_items=?, pending_items_comments=?, amount_travel=?, amount_service=?, amount_spares=?,
          handwritten_report_path=?, status=?, updated_at=CURRENT_TIMESTAMP,
          ${extraCols.map(c => `${c}=?`).join(', ')}
        WHERE id=?
      `).run(
        pendingFlag, pending_items_comments||null, Number(amount_travel)||0, Number(amount_service)||0, Number(amount_spares)||0,
        handwrittenPath, status, ...extraCols.map(c => extra[c]), existing.id);
      reportId = existing.id;
    } else {
      const info = db.prepare(`
        INSERT INTO service_reports (service_request_id, employee_id,
          pending_items, pending_items_comments,
          amount_travel, amount_service, amount_spares, handwritten_report_path, status,
          ${extraCols.join(', ')})
        VALUES (?,?,?,?,?,?,?,?,?,${extraCols.map(()=>'?').join(',')})
      `).run(sr.id, sr.employee_id, pendingFlag, pending_items_comments||null,
        Number(amount_travel)||0, Number(amount_service)||0, Number(amount_spares)||0, handwrittenPath, status,
        ...extraCols.map(c => extra[c]));
      reportId = info.lastInsertRowid;
    }
    // Spares are only deducted from stock on the FIRST submit of a report -
    // a later re-edit/resubmit (status was already 'Submitted') never
    // re-deducts, so this can never double-count stock.
    const isFirstSubmit = !existing || existing.status === 'Draft';
    if (isSubmit && isFirstSubmit && spareLines.length) {
      const insertSpare = db.prepare(`
        INSERT INTO service_report_spares (service_report_id, item_id, quantity, unit_rate, service_center_id) VALUES (?,?,?,?,?)
      `);
      const deductStock = db.prepare(`
        UPDATE service_center_stock SET quantity = quantity - ? WHERE service_center_id = ? AND item_id = ?
      `);
      const insertMove = db.prepare(`
        INSERT INTO stock_movements (item_id, movement_type, quantity, reference, moved_by, service_center_id) VALUES (?, 'OUT', ?, ?, ?, ?)
      `);
      spareLines.forEach(l => {
        const qty = Number(l.quantity);
        const rate = Number(l.unit_rate) || 0;
        insertSpare.run(reportId, l.item_id, qty, rate, service_center_id);
        deductStock.run(qty, service_center_id, l.item_id);
        insertMove.run(l.item_id, qty, 'SVC-report-' + reportId, req.user.id, service_center_id);
      });
    }
    if (isSubmit) {
      // Best-effort end-of-job geolocation (part B) - captured once, on final submit.
      const endLat = (end_lat !== undefined && end_lat !== null && end_lat !== '') ? Number(end_lat) : null;
      const endLng = (end_lng !== undefined && end_lng !== null && end_lng !== '') ? Number(end_lng) : null;
      if (pendingFlag) {
        // back into the Service Request queue for further action - job stays
        // "Assigned" (job_status) so it can be started again by whoever it's
        // reassigned to, but its end location for this leg is still logged.
        db.prepare(`
          UPDATE service_requests SET status = 'Pending Items', reopen_reason = ?, job_status = 'Assigned',
            end_lat = ?, end_lng = ?, end_captured_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(pending_items_comments || null, endLat, endLng, sr.id);
      } else {
        db.prepare(`
          UPDATE service_requests SET status = 'Resolved', job_status = 'Completed',
            end_lat = ?, end_lng = ?, end_captured_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(endLat, endLng, sr.id);
      }
      db.prepare(`
        INSERT INTO service_request_status_log (sr_id, from_status, to_status, changed_by, lat, lng)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sr.id, sr.job_status || 'InProgress', pendingFlag ? 'Assigned' : 'Completed', req.user.id, endLat, endLng);
    }
    return reportId;
  });
  res.json({ id: tx() });
});

// Generate PDF (part D) - reuses the same puppeteer/Chrome-based pattern as
// PO PDFs (lib/poPdf.js).
router.get('/:id/report/pdf', async (req, res) => {
  const report = db.prepare(`SELECT * FROM service_reports WHERE service_request_id = ? ORDER BY id DESC LIMIT 1`).get(req.params.id);
  const sr = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(req.params.id);
  if (!report || !sr) return res.status(404).json({ error: 'No service report found for this SR.' });
  const spares = db.prepare(`
    SELECT s.*, i.name as item_name, i.unit FROM service_report_spares s JOIN items i ON i.id = s.item_id
    WHERE s.service_report_id = ?
  `).all(report.id);
  try {
    const gen = await generateServiceReportPdf(report, sr, getCompanySettings(), spares);
    res.download(gen.outPath, `${sr.sr_no}-service-report.pdf`, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===================== Reconciliation (amount review) =====================
// Reports with status='Reconciliation' - reviewed/approved by Service
// HOD/Supervisor or Accounts, then consolidated under Monthly Reconciliation.
router.get('/reconciliation/queue', requirePermission('service_request.manage', 'expense_voucher.approve'), (req, res) => {
  const rows = db.prepare(`
    SELECT sr.*, e.full_name as employee_name, req.sr_no, req.issue_description, req.client_id,
      c.name as client_name
    FROM service_reports sr
    LEFT JOIN employees e ON e.id = sr.employee_id
    LEFT JOIN service_requests req ON req.id = sr.service_request_id
    LEFT JOIN clients c ON c.id = req.client_id
    WHERE sr.status = 'Reconciliation'
    ORDER BY sr.id DESC
  `).all();
  res.json(rows);
});
router.post('/reconciliation/:reportId/approve', requirePermission('service_request.manage', 'expense_voucher.approve'), (req, res) => {
  const report = db.prepare('SELECT * FROM service_reports WHERE id = ?').get(req.params.reportId);
  if (!report) return res.status(404).json({ error: 'Not found' });
  if (report.status !== 'Reconciliation') return res.status(400).json({ error: 'Must be in Reconciliation status.' });
  db.prepare(`UPDATE service_reports SET status = 'Approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(report.id);
  // Round 3 finance hook: record the amount collected against this service visit.
  try {
    const total = (report.amount_travel || 0) + (report.amount_service || 0) + (report.amount_spares || 0);
    const dept = db.prepare('SELECT department_id FROM employees WHERE id = ?').get(report.employee_id);
    db.prepare(`
      INSERT INTO finance_ledger (type, reference_table, reference_id, department_id, amount, direction, description, created_by)
      VALUES ('ServiceCollection', 'service_reports', ?, ?, ?, 'Inflow', 'Service report amount approved', ?)
    `).run(report.id, dept ? dept.department_id : null, total, req.user.id);
  } catch (e) { /* best-effort ledger hook */ }
  db.prepare(`UPDATE service_requests SET status = 'Resolved' WHERE id = ?`).run(report.service_request_id);
  res.json({ ok: true });
});

// ===================== Monthly Reconciliation (Supervisor/HOD -> Accounts) =====================
router.get('/reconciliation/monthly', requirePermission('service_request.manage', 'expense_voucher.approve'), (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT sr.*, e.full_name as employee_name, req.sr_no
    FROM service_reports sr
    LEFT JOIN employees e ON e.id = sr.employee_id
    LEFT JOIN service_requests req ON req.id = sr.service_request_id
    WHERE sr.status IN ('Approved','SubmittedToAccounts') AND sr.updated_at LIKE ?
    ORDER BY sr.id DESC
  `).all(month + '%');
  const total = rows.reduce((s, r) => s + (r.amount_travel||0) + (r.amount_service||0) + (r.amount_spares||0), 0);
  res.json({ month, rows, total, submitted: rows.length > 0 && rows.every(r => r.status === 'SubmittedToAccounts') });
});
router.post('/reconciliation/monthly/:month/submit-to-accounts', requirePermission('service_request.manage', 'expense_voucher.approve'), (req, res) => {
  const month = req.params.month;
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE service_reports SET status = 'SubmittedToAccounts', submitted_to_accounts_at = CURRENT_TIMESTAMP, submitted_to_accounts_by = ?
      WHERE status = 'Approved' AND updated_at LIKE ?
    `).run(req.user.id, month + '%');
  });
  tx();
  res.json({ ok: true });
});

// ===================== Dashboard / trends =====================
router.get('/dashboard/summary', requirePermission('service_request.manage', 'report.view_all'), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const all = db.prepare('SELECT * FROM service_requests').all();
  const counts = { pending: 0, delayed: 0, ongoing: 0, held: 0, pendingItems: 0, resolved: 0, closed: 0 };
  all.forEach(r => {
    if (r.status === 'Open' || r.status === 'Scheduled') counts.pending++;
    if (r.status === 'InProgress') counts.ongoing++;
    if (r.status === 'PartsOrdered') counts.held++;
    if (r.status === 'Pending Items') counts.pendingItems++;
    if (r.status === 'Resolved') counts.resolved++;
    if (r.status === 'Closed') counts.closed++;
    if (r.scheduled_date && r.scheduled_date < today && !['Resolved','Closed'].includes(r.status)) counts.delayed++;
  });
  const trendRows = db.prepare(`SELECT created_at FROM service_requests`).all();
  const byWeek = {}, byMonth = {}, byYear = {};
  trendRows.forEach(r => {
    const d = new Date(r.created_at);
    const year = d.getFullYear();
    const month = year + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = year + '-W' + String(Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7));
    byWeek[week] = (byWeek[week] || 0) + 1;
    byMonth[month] = (byMonth[month] || 0) + 1;
    byYear[year] = (byYear[year] || 0) + 1;
  });
  res.json({ counts, total: all.length, byWeek, byMonth, byYear });
});

module.exports = router;

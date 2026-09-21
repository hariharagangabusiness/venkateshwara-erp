const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

// Site Visit Tracker - replaces the team's "SITE STATUS" Excel tab. A visit
// stays open (Pending -> Working -> Hold/Closed) for as long as it actually
// runs, with multiple engineers assignable to one visit. Distinct from
// Service Requests, which close with a single-engineer formal report.

function loadVisit(id) {
  const visit = db.prepare('SELECT * FROM site_visits WHERE id = ?').get(id);
  if (!visit) return null;
  const engineers = db.prepare(`
    SELECT e.id, e.full_name FROM site_visit_engineers sve JOIN employees e ON e.id = sve.employee_id
    WHERE sve.site_visit_id = ? ORDER BY e.full_name
  `).all(id);
  return { ...visit, engineers };
}

router.get('/visits', requirePermission('site_visit.manage', 'report.view_all'), (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM site_visits WHERE status = ? ORDER BY arrival_date DESC, id DESC').all(status)
    : db.prepare('SELECT * FROM site_visits ORDER BY arrival_date DESC, id DESC').all();
  const engByVisit = {};
  const engRows = db.prepare(`
    SELECT sve.site_visit_id, e.id as employee_id, e.full_name FROM site_visit_engineers sve
    JOIN employees e ON e.id = sve.employee_id
  `).all();
  engRows.forEach(r => { (engByVisit[r.site_visit_id] = engByVisit[r.site_visit_id] || []).push({ id: r.employee_id, full_name: r.full_name }); });
  res.json(rows.map(v => ({ ...v, engineers: engByVisit[v.id] || [] })));
});

router.get('/visits/:id', requirePermission('site_visit.manage', 'report.view_all'), (req, res) => {
  const visit = loadVisit(req.params.id);
  if (!visit) return res.status(404).json({ error: 'Not found' });
  res.json(visit);
});

router.post('/visits', requirePermission('site_visit.manage'), (req, res) => {
  const { site_name, client_id, project_id, purpose, status, arrival_date, close_date, expenses_note, employee_ids } = req.body;
  if (!site_name) return res.status(400).json({ error: 'Enter a site name.' });
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO site_visits (site_name, client_id, project_id, purpose, status, arrival_date, close_date, expenses_note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(site_name, client_id || null, project_id || null, purpose || null, status || 'Pending',
      arrival_date || null, close_date || null, expenses_note || null, req.user.id);
    const visitId = info.lastInsertRowid;
    (employee_ids || []).forEach(eid => {
      db.prepare('INSERT OR IGNORE INTO site_visit_engineers (site_visit_id, employee_id) VALUES (?,?)').run(visitId, eid);
    });
    return visitId;
  });
  res.json({ id: tx() });
});

router.put('/visits/:id', requirePermission('site_visit.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM site_visits WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { site_name, client_id, project_id, purpose, status, arrival_date, close_date, expenses_note, employee_ids } = req.body;
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE site_visits SET site_name=?, client_id=?, project_id=?, purpose=?, status=?, arrival_date=?, close_date=?, expenses_note=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      site_name !== undefined ? site_name : existing.site_name,
      client_id !== undefined ? (client_id || null) : existing.client_id,
      project_id !== undefined ? (project_id || null) : existing.project_id,
      purpose !== undefined ? purpose : existing.purpose,
      status !== undefined ? status : existing.status,
      arrival_date !== undefined ? arrival_date : existing.arrival_date,
      close_date !== undefined ? close_date : existing.close_date,
      expenses_note !== undefined ? expenses_note : existing.expenses_note,
      existing.id
    );
    if (employee_ids !== undefined) {
      db.prepare('DELETE FROM site_visit_engineers WHERE site_visit_id = ?').run(existing.id);
      employee_ids.forEach(eid => {
        db.prepare('INSERT OR IGNORE INTO site_visit_engineers (site_visit_id, employee_id) VALUES (?,?)').run(existing.id, eid);
      });
    }
  });
  tx();
  res.json({ ok: true });
});

// ===================== Daily Work Log =====================
// One cell per engineer per day - a daily roll-call, independent of
// structured job-card timestamps elsewhere in the ERP. A supervisor can
// still just type a free-text note (the original shorthand-driven flow,
// unchanged), or additionally set a status when they're actively assigning
// that day's task rather than just recording what happened after the fact -
// status stays null/untouched for a plain logged note, same as before this
// was added.
const DWL_STATUSES = ['Pending', 'InProgress', 'Completed', 'OnHold'];
router.get('/daily-log', requirePermission('site_visit.manage', 'report.view_all'), (req, res) => {
  const month = req.query.month; // 'YYYY-MM'
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Pass ?month=YYYY-MM' });
  const rows = db.prepare(`
    SELECT dwl.*, u.full_name as assigned_by_name
    FROM daily_work_logs dwl LEFT JOIN users u ON u.id = dwl.assigned_by
    WHERE dwl.log_date LIKE ?
  `).all(month + '%');
  res.json(rows);
});

router.post('/daily-log/bulk', requirePermission('site_visit.manage'), (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'No entries to save.' });
  const upsert = db.prepare(`
    INSERT INTO daily_work_logs (employee_id, log_date, note, status, assigned_by, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(employee_id, log_date) DO UPDATE SET
      note = excluded.note, status = excluded.status, assigned_by = excluded.assigned_by,
      updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
  `);
  const del = db.prepare(`DELETE FROM daily_work_logs WHERE employee_id = ? AND log_date = ?`);
  const tx = db.transaction(() => {
    entries.forEach(e => {
      if (!e.employee_id || !e.log_date) return;
      const note = (e.note || '').trim();
      const status = e.status && DWL_STATUSES.includes(e.status) ? e.status : null;
      if (!note && !status) { del.run(e.employee_id, e.log_date); return; }
      // assigned_by only gets set/refreshed when a status is actually present -
      // a plain shorthand note with no status is just a log entry, not a task
      // assignment, so it shouldn't imply anyone "assigned" it.
      upsert.run(e.employee_id, e.log_date, note, status, status ? req.user.id : null, req.user.id, req.user.id);
    });
  });
  tx();
  res.json({ ok: true });
});

// Active employees eligible to appear on the roll-call / visit-assignment
// pickers. Not hard-filtered to Service/Electrical, since the source sheet
// covered a mixed engineering team - Admin can assign anyone active.
router.get('/engineers', requirePermission('site_visit.manage', 'report.view_all'), (req, res) => {
  res.json(db.prepare(`
    SELECT e.id, e.full_name, d.name as department FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.exit_date IS NULL ORDER BY e.full_name
  `).all());
});

module.exports = router;

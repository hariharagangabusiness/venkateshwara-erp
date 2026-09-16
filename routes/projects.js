const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const { PIPELINE_STAGES, createJobCardsForProject, combinedStagesForRole } = require('../lib/pipeline');
const router = express.Router();
router.use(authRequired);

const { getUploadsSubdir } = require('../lib/paths');
const uploadDir = getUploadsSubdir('job-cards');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// A department's HOD/Supervisor (or Admin) can start/complete any card in
// their own department and allocate work within it; a regular team member
// can only act on a card specifically assigned to them.
function isSupervisorOf(user, stage) {
  if (user.role_name === 'Admin') return true;
  if (user.role_name === stage) return !!user.is_supervisor;
  // The Manufacturing HOD supervises every sub-process card too (Fitting,
  // Tacking, Welding, BuffingSandblast, Painting) - the combined queue is
  // meant to put them in charge of the whole chain, not just the parent card.
  if (user.role_name === 'Manufacturing' && user.is_supervisor && combinedStagesForRole('Manufacturing').includes(stage)) return true;
  return false;
}
function canActOn(user, jc) {
  return isSupervisorOf(user, jc.stage) || jc.assigned_to === user.id;
}

router.get('/pipeline-stages', (req, res) => res.json(PIPELINE_STAGES));

router.get('/', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, so.order_no, c.name as client_name, u.full_name as pm_name
    FROM projects p
    LEFT JOIN sales_orders so ON so.id = p.sales_order_id
    LEFT JOIN clients c ON c.id = so.client_id
    LEFT JOIN users u ON u.id = p.pm_id
    ORDER BY p.id DESC
  `).all());
});

router.post('/', requirePermission('project.manage'), (req, res) => {
  const { sales_order_id, title, start_date, target_date } = req.body;
  const code = 'PRJ-' + Date.now();
  const info = db.prepare(`
    INSERT INTO projects (project_code, sales_order_id, title, pm_id, start_date, target_date)
    VALUES (?,?,?,?,?,?)
  `).run(code, sales_order_id || null, title, req.user.id, start_date, target_date);
  // auto-create the full two-level job-card tree (top-level departments,
  // plus nested sub-process cards for any department that has them)
  createJobCardsForProject(db, info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, project_code: code });
});

router.patch('/:id/status', requirePermission('project.manage'), (req, res) => {
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

// ===================== Targets sheet (PM top-level planning) =====================
router.get('/by-sales-order/:soId', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, so.order_no, c.name as client_name
    FROM projects p
    JOIN sales_orders so ON so.id = p.sales_order_id
    LEFT JOIN clients c ON c.id = so.client_id
    WHERE p.sales_order_id = ?
  `).get(req.params.soId);
  if (!project) return res.json({ project: null, jobCards: [] });
  const jobCards = db.prepare(`
    SELECT jc.*, u.full_name as assigned_to_name FROM job_cards jc LEFT JOIN users u ON u.id = jc.assigned_to
    WHERE jc.project_id = ? AND jc.parent_job_card_id IS NULL ORDER BY COALESCE(jc.sequence, jc.id)
  `).all(project.id);
  res.json({ project, jobCards });
});

router.put('/:id/plan', requirePermission('project.manage'), (req, res) => {
  const { start_date, stages } = req.body; // stages: [{id, duration_days}], in the order the user wants them to run
  if (!start_date || !Array.isArray(stages) || !stages.length) {
    return res.status(400).json({ error: 'start_date and a non-empty stages array are required' });
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tx = db.transaction(() => {
    let cursor = new Date(start_date + 'T00:00:00');
    stages.forEach((s, i) => {
      const days = Math.max(1, Number(s.duration_days) || 1);
      const plannedStart = cursor.toISOString().slice(0, 10);
      const end = new Date(cursor);
      end.setDate(end.getDate() + days - 1);
      const plannedEnd = end.toISOString().slice(0, 10);
      db.prepare(`UPDATE job_cards SET duration_days = ?, planned_start = ?, planned_end = ?, sequence = ? WHERE id = ? AND project_id = ? AND parent_job_card_id IS NULL`)
        .run(days, plannedStart, plannedEnd, i + 1, s.id, project.id);
      cursor = new Date(end);
      cursor.setDate(cursor.getDate() + 1);
    });
    const overallTarget = new Date(cursor);
    overallTarget.setDate(overallTarget.getDate() - 1);
    const targetDateStr = overallTarget.toISOString().slice(0, 10);
    db.prepare('UPDATE projects SET target_date = ? WHERE id = ?').run(targetDateStr, project.id);
    return targetDateStr;
  });
  const targetDate = tx();

  const jobCards = db.prepare(`
    SELECT jc.*, u.full_name as assigned_to_name FROM job_cards jc LEFT JOIN users u ON u.id = jc.assigned_to
    WHERE jc.project_id = ? AND jc.parent_job_card_id IS NULL ORDER BY COALESCE(jc.sequence, jc.id)
  `).all(project.id);
  res.json({ ok: true, targetDate, jobCards });
});

// ---- Job cards (per-department work items) ----
// Top-level stage cards for a project, each with its children (sub-processes
// and HOD-created sub-assemblies) nested under it - who allocated/started/
// completed what, at a glance, from the project's own detail view, instead
// of only being visible inside that department's own Job Cards workbench.
router.get('/:id/job-cards', (req, res) => {
  const cards = db.prepare(`
    SELECT jc.*, u.full_name as assigned_to_name,
      (SELECT COUNT(*) FROM job_cards child WHERE child.parent_job_card_id = jc.id) as child_count
    FROM job_cards jc LEFT JOIN users u ON u.id = jc.assigned_to
    WHERE jc.project_id = ? AND jc.parent_job_card_id IS NULL ORDER BY COALESCE(jc.sequence, jc.id)
  `).all(req.params.id);
  const children = db.prepare(`
    SELECT jc.*, u.full_name as assigned_to_name
    FROM job_cards jc LEFT JOIN users u ON u.id = jc.assigned_to
    WHERE jc.project_id = ? AND jc.parent_job_card_id IS NOT NULL ORDER BY COALESCE(jc.sequence, jc.id)
  `).all(req.params.id);
  const byParent = {};
  children.forEach(c => { (byParent[c.parent_job_card_id] = byParent[c.parent_job_card_id] || []).push(c); });
  res.json(cards.map(c => ({ ...c, children: byParent[c.id] || [] })));
});

router.get('/job-cards/mine', (req, res) => {
  // Department-scoped work queue (this doubles as "each department's own
  // tab" - a department's users only ever see their own department's
  // cards here). Includes: the department's regular pipeline stage(s) -
  // for Manufacturing, that means the parent stage AND every sub-process
  // (Fitting/Tacking/Welding/BuffingSandblast/Painting) combined into one
  // queue, so a sub-process login isn't limited to a narrow sliver - plus
  // HOD-created sub-assemblies within it, and hand-off cards routed in from
  // another department. Only surfaced once released (planned_start set).
  const stages = combinedStagesForRole(req.user.role_name);
  const placeholders = stages.map(() => '?').join(',');
  const cards = db.prepare(`
    SELECT jc.*, p.project_code, p.title as project_title,
      (SELECT COUNT(*) FROM job_cards child WHERE child.parent_job_card_id = jc.id) as child_count
    FROM job_cards jc JOIN projects p ON p.id = jc.project_id
    WHERE (jc.stage IN (${placeholders}) OR jc.assigned_to = ?) AND jc.planned_start IS NOT NULL
    ORDER BY COALESCE(jc.sequence, jc.id) ASC
  `).all(...stages, req.user.id);
  const withPerms = cards.map(c => ({ ...c, can_act: canActOn(req.user, c), is_supervisor: isSupervisorOf(req.user, c.stage) }));
  res.json(withPerms);
});

// One department's full queue, across every project - not filtered down to
// "assigned to me". Backs the separate per-department Job Cards tabs that
// Admin/PM see (one tab per department, so they can watch every
// department's work without switching logins), same shape as job-cards/mine.
router.get('/job-cards/by-stage/:stage', requirePermission('project.manage'), (req, res) => {
  const stages = combinedStagesForRole(req.params.stage);
  const placeholders = stages.map(() => '?').join(',');
  const cards = db.prepare(`
    SELECT jc.*, p.project_code, p.title as project_title,
      (SELECT COUNT(*) FROM job_cards child WHERE child.parent_job_card_id = jc.id) as child_count
    FROM job_cards jc JOIN projects p ON p.id = jc.project_id
    WHERE jc.stage IN (${placeholders}) AND jc.planned_start IS NOT NULL
    ORDER BY COALESCE(jc.sequence, jc.id) ASC
  `).all(...stages);
  const withPerms = cards.map(c => ({ ...c, can_act: canActOn(req.user, c), is_supervisor: isSupervisorOf(req.user, c.stage) }));
  res.json(withPerms);
});

// ===================== Department HOD workbench =====================

// Full detail for one job card: parent info, children, attachments, comments.
router.get('/job-cards/:id/detail', (req, res) => {
  const jc = db.prepare(`
    SELECT jc.*, u.full_name as assigned_to_name,
      so.id as so_id, so.annexure_path as so_annexure_path, so.order_no as so_order_no
    FROM job_cards jc LEFT JOIN users u ON u.id = jc.assigned_to
    LEFT JOIN projects p ON p.id = jc.project_id
    LEFT JOIN sales_orders so ON so.id = p.sales_order_id
    WHERE jc.id = ?
  `).get(req.params.id);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  const children = db.prepare(`
    SELECT jc.*, u.full_name as assigned_to_name FROM job_cards jc LEFT JOIN users u ON u.id = jc.assigned_to
    WHERE jc.parent_job_card_id = ? ORDER BY COALESCE(jc.sequence, jc.id)
  `).all(jc.id);
  const attachments = db.prepare(`
    SELECT a.*, u.full_name as uploaded_by_name FROM job_card_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.job_card_id = ? ORDER BY a.id DESC
  `).all(jc.id);
  const comments = db.prepare(`
    SELECT c.*, u.full_name as user_name FROM job_card_comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.job_card_id = ? ORDER BY c.id ASC
  `).all(jc.id);
  const dependsOn = db.prepare(`
    SELECT jc.id, jc.stage, jc.title, jc.status FROM job_card_dependencies d
    JOIN job_cards jc ON jc.id = d.depends_on_id WHERE d.job_card_id = ?
  `).all(jc.id);
  const routedTo = db.prepare(`
    SELECT jc.id, jc.stage, jc.title, jc.status FROM job_card_dependencies d
    JOIN job_cards jc ON jc.id = d.job_card_id WHERE d.depends_on_id = ?
  `).all(jc.id);
  res.json({
    jobCard: jc, children, attachments, comments, dependsOn, routedTo,
    canAct: canActOn(req.user, jc), isSupervisor: isSupervisorOf(req.user, jc.stage),
  });
});

router.put('/job-cards/:id/subplan', requirePermission('job_card.manage'), (req, res) => {
  const parent = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Not found' });
  if (req.user.role_name !== parent.stage && req.user.role_name !== 'Admin') {
    return res.status(403).json({ error: `Only the ${parent.stage} department can plan its own sub-processes.` });
  }
  if (!parent.planned_start) {
    return res.status(400).json({ error: 'The Project Manager has not released this department yet - it has no target window set.' });
  }
  const { start_date, stages } = req.body; // stages: [{id, duration_days}]
  if (!start_date || !Array.isArray(stages) || !stages.length) {
    return res.status(400).json({ error: 'start_date and a non-empty stages array are required' });
  }

  const tx = db.transaction(() => {
    let cursor = new Date(start_date + 'T00:00:00');
    stages.forEach((s, i) => {
      const days = Math.max(1, Number(s.duration_days) || 1);
      const plannedStart = cursor.toISOString().slice(0, 10);
      const end = new Date(cursor);
      end.setDate(end.getDate() + days - 1);
      const plannedEnd = end.toISOString().slice(0, 10);
      db.prepare(`UPDATE job_cards SET duration_days = ?, planned_start = ?, planned_end = ?, sequence = ? WHERE id = ? AND parent_job_card_id = ?`)
        .run(days, plannedStart, plannedEnd, i + 1, s.id, parent.id);
      cursor = new Date(end);
      cursor.setDate(cursor.getDate() + 1);
    });
    const overallEnd = new Date(cursor);
    overallEnd.setDate(overallEnd.getDate() - 1);
    return overallEnd.toISOString().slice(0, 10);
  });
  const subTargetDate = tx();

  const children = db.prepare(`
    SELECT jc.*, u.full_name as assigned_to_name FROM job_cards jc LEFT JOIN users u ON u.id = jc.assigned_to
    WHERE jc.parent_job_card_id = ? ORDER BY COALESCE(jc.sequence, jc.id)
  `).all(parent.id);
  res.json({ ok: true, subTargetDate, children });
});

// HOD/Supervisor adds an ad-hoc sub-assembly under their own department's
// card for this project (e.g. "Hopper Sub-Assembly", "Frame Sub-Assembly"),
// released immediately (it's created mid-flight, after the department was
// already released, so there's no PM step to wait on).
router.post('/job-cards/:id/subassemblies', requirePermission('job_card.manage'), (req, res) => {
  const parent = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Not found' });
  if (!isSupervisorOf(req.user, parent.stage)) {
    return res.status(403).json({ error: `Only the ${parent.stage} HOD/Supervisor can add sub-assemblies here.` });
  }
  const { title, duration_days } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const nextSeq = (db.prepare('SELECT MAX(sequence) as m FROM job_cards WHERE parent_job_card_id = ?').get(parent.id).m || 0) + 1;
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.max(1, Number(duration_days) || 7);
  const end = new Date(today + 'T00:00:00');
  end.setDate(end.getDate() + days - 1);
  const info = db.prepare(`
    INSERT INTO job_cards (project_id, stage, status, parent_job_card_id, title, is_adhoc, sequence, planned_start, planned_end, duration_days)
    VALUES (?, ?, 'Pending', ?, ?, 1, ?, ?, ?, ?)
  `).run(parent.project_id, parent.stage, parent.id, title, nextSeq, today, end.toISOString().slice(0, 10), days);
  res.json({ id: info.lastInsertRowid });
});

// HOD/Supervisor hands off completed work to one or more OTHER departments
// at once (e.g. Design finishing releases BOM to Purchase, cut/bend files
// to Laser & Bending, and drawings to Electrical, all in parallel) - not
// limited to "the next stage in sequence". Creates a new card in the
// target department for the same project, linked as depending on the
// source card; it auto-releases once the source card is Completed.
router.post('/job-cards/:id/route-to', requirePermission('job_card.manage'), (req, res) => {
  const source = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  if (!canActOn(req.user, source)) {
    return res.status(403).json({ error: 'Only this card\'s HOD/Supervisor or assignee can route it to another department.' });
  }
  const { stage, title, duration_days } = req.body;
  if (!stage || !title) return res.status(400).json({ error: 'stage and title are required' });

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO job_cards (project_id, stage, status, title, is_adhoc, duration_days)
      VALUES (?, ?, 'Pending', ?, 1, ?)
    `).run(source.project_id, stage, title, Math.max(1, Number(duration_days) || 7));
    db.prepare(`INSERT OR IGNORE INTO job_card_dependencies (job_card_id, depends_on_id) VALUES (?, ?)`).run(info.lastInsertRowid, source.id);
    // if the source is already Completed, release the new card immediately
    if (source.status === 'Completed') {
      const today = new Date().toISOString().slice(0, 10);
      db.prepare(`UPDATE job_cards SET planned_start = ? WHERE id = ?`).run(today, info.lastInsertRowid);
    }
    return info.lastInsertRowid;
  });
  res.json({ id: tx() });
});

// Team members in a given department/stage, for the HOD/Supervisor's
// "allocate to" dropdown when assigning a job card.
router.get('/department-users/:stage', requirePermission('job_card.manage'), (req, res) => {
  if (!isSupervisorOf(req.user, req.params.stage)) {
    return res.status(403).json({ error: `Only the ${req.params.stage} HOD/Supervisor can see its team list.` });
  }
  res.json(db.prepare(`
    SELECT u.id, u.full_name, u.is_supervisor FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = ? AND u.is_active = 1
    ORDER BY u.is_supervisor DESC, u.full_name
  `).all(req.params.stage));
});

// ---- Attachments ----
router.get('/job-cards/:id/attachments', (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, u.full_name as uploaded_by_name FROM job_card_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.job_card_id = ? ORDER BY a.id DESC
  `).all(req.params.id));
});
router.post('/job-cards/:id/attachments', requirePermission('job_card.manage'), upload.single('file'), (req, res) => {
  const jc = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  if (!canActOn(req.user, jc)) return res.status(403).json({ error: 'Not authorized for this job card.' });
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const info = db.prepare(`
    INSERT INTO job_card_attachments (job_card_id, file_path, file_name, uploaded_by)
    VALUES (?, ?, ?, ?)
  `).run(jc.id, '/uploads/job-cards/' + req.file.filename, req.file.originalname, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

// ---- Comments / handover notes ----
router.get('/job-cards/:id/comments', (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, u.full_name as user_name FROM job_card_comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.job_card_id = ? ORDER BY c.id ASC
  `).all(req.params.id));
});
router.post('/job-cards/:id/comments', requirePermission('job_card.manage'), (req, res) => {
  const jc = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  if (!canActOn(req.user, jc)) return res.status(403).json({ error: 'Not authorized for this job card.' });
  const { comment } = req.body;
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'comment is required' });
  const info = db.prepare(`INSERT INTO job_card_comments (job_card_id, user_id, comment) VALUES (?, ?, ?)`).run(jc.id, req.user.id, comment.trim());
  res.json({ id: info.lastInsertRowid });
});

// Time & Motion report: per-card allocation->start->completion durations,
// plus aggregates by department (stage) and by assignee. Filters are all
// optional and combine with AND.
router.get('/time-motion-report', (req, res) => {
  const { stage, project_id, assignee, date_from, date_to } = req.query;
  const where = [];
  const params = [];
  if (stage) { where.push('jc.stage = ?'); params.push(stage); }
  if (project_id) { where.push('jc.project_id = ?'); params.push(project_id); }
  if (assignee) { where.push('jc.assigned_to = ?'); params.push(assignee); }
  if (date_from) { where.push('date(jc.created_at) >= date(?)'); params.push(date_from); }
  if (date_to) { where.push('date(jc.created_at) <= date(?)'); params.push(date_to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT jc.id, jc.stage, jc.title, jc.project_id, p.title as project_name,
      jc.status, jc.assigned_to, u.full_name as assignee_name,
      jc.allocated_at, jc.started_at, jc.completed_at,
      (julianday(jc.started_at) - julianday(jc.allocated_at)) * 24 as alloc_to_start_hrs,
      (julianday(jc.completed_at) - julianday(jc.started_at)) * 24 as start_to_complete_hrs,
      (julianday(jc.completed_at) - julianday(jc.allocated_at)) * 24 as alloc_to_complete_hrs
    FROM job_cards jc
    LEFT JOIN users u ON u.id = jc.assigned_to
    LEFT JOIN projects p ON p.id = jc.project_id
    ${whereSql}
    ORDER BY jc.id DESC
  `).all(...params);

  const num = (v) => (v === null || v === undefined || isNaN(v)) ? null : v;
  const cards = rows.map(r => ({
    ...r,
    alloc_to_start_hrs: num(r.alloc_to_start_hrs),
    start_to_complete_hrs: num(r.start_to_complete_hrs),
    alloc_to_complete_hrs: num(r.alloc_to_complete_hrs),
  }));

  function aggregate(list, keyFn) {
    const groups = {};
    list.forEach(r => {
      const key = keyFn(r);
      if (key == null) return;
      if (!groups[key]) groups[key] = { key, count: 0, allocStart: [], startComplete: [], allocComplete: [] };
      groups[key].count++;
      if (r.alloc_to_start_hrs != null) groups[key].allocStart.push(r.alloc_to_start_hrs);
      if (r.start_to_complete_hrs != null) groups[key].startComplete.push(r.start_to_complete_hrs);
      if (r.alloc_to_complete_hrs != null) groups[key].allocComplete.push(r.alloc_to_complete_hrs);
    });
    const stat = (arr) => arr.length ? {
      avg: arr.reduce((a, b) => a + b, 0) / arr.length,
      min: Math.min(...arr), max: Math.max(...arr), n: arr.length,
    } : { avg: null, min: null, max: null, n: 0 };
    return Object.values(groups).map(g => ({
      key: g.key, count: g.count,
      alloc_to_start: stat(g.allocStart),
      start_to_complete: stat(g.startComplete),
      alloc_to_complete: stat(g.allocComplete),
    }));
  }

  const byDepartment = aggregate(cards, r => r.stage);
  const byAssignee = aggregate(cards, r => r.assignee_name);
  const overall = aggregate(cards, () => 'overall')[0] || null;

  res.json({ cards, byDepartment, byAssignee, overall });
});

router.patch('/job-cards/:id', requirePermission('job_card.manage'), (req, res) => {
  const { status, notes, assigned_to } = req.body;
  const jc = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!jc) return res.status(404).json({ error: 'Not found' });

  const supervisor = isSupervisorOf(req.user, jc.stage);

  // Allocating work (setting/changing who it's assigned to) is a
  // HOD/Supervisor-only action.
  if (assigned_to !== undefined && !supervisor) {
    return res.status(403).json({ error: `Only the ${jc.stage} HOD/Supervisor can allocate work to a team member.` });
  }

  // Starting or completing the job is restricted to the department's
  // HOD/Supervisor, or the specific team member it's been assigned to.
  if (status && !canActOn(req.user, jc)) {
    return res.status(403).json({ error: `Only the ${jc.stage} HOD/Supervisor, or whoever this card is assigned to, can update its status.` });
  }

  // Explicit hand-off dependencies (routed-in cards): can't start until
  // every department this card depends on has completed its part.
  if (status && status !== 'Pending') {
    const openDeps = db.prepare(`
      SELECT jc2.stage FROM job_card_dependencies d JOIN job_cards jc2 ON jc2.id = d.depends_on_id
      WHERE d.job_card_id = ? AND jc2.status != 'Completed' LIMIT 1
    `).get(jc.id);
    if (openDeps) {
      return res.status(400).json({ error: `Cannot start this yet - still waiting on hand-off from ${openDeps.stage}.` });
    }
  }

  // Handover gate: within the same level, a stage can only start once every
  // earlier one has finished - this is meant for genuinely sequential chains
  // (top-level departments among themselves, or a department's own defined
  // sub-processes among themselves, e.g. Manufacturing's Fitting must finish
  // before Tacking starts). It must NOT apply to ad-hoc sub-assemblies
  // (is_adhoc=1, created via "Add Sub-Assembly") - those are independent,
  // parallel pieces of work an HOD hands out to different team members, not
  // a fixed hand-off chain, and were previously getting wrongly blocked
  // waiting on a sibling sub-assembly (reported as "waiting on handover from
  // Design" when a second Design sub-assembly was started before the first
  // one finished).
  if (status && status !== 'Pending' && jc.sequence != null && !jc.is_adhoc) {
    const blocking = db.prepare(`
      SELECT stage FROM job_cards
      WHERE project_id = ? AND sequence < ? AND status != 'Completed' AND is_adhoc = 0
        AND parent_job_card_id IS ${jc.parent_job_card_id == null ? 'NULL' : '?'}
      ORDER BY sequence LIMIT 1
    `).get(...(jc.parent_job_card_id == null ? [jc.project_id, jc.sequence] : [jc.project_id, jc.sequence, jc.parent_job_card_id]));
    if (blocking) {
      return res.status(400).json({ error: `Cannot start this stage yet - waiting on handover from ${blocking.stage}.` });
    }
  }

  // A department with sub-processes (e.g. Manufacturing) can't be marked
  // Completed until every one of its own sub-process/sub-assembly cards is.
  if (status === 'Completed') {
    const openChildren = db.prepare(`SELECT COUNT(*) as n FROM job_cards WHERE parent_job_card_id = ? AND status != 'Completed'`).get(jc.id).n;
    if (openChildren > 0) {
      return res.status(400).json({ error: `Cannot complete this stage yet - ${openChildren} sub-process(es)/sub-assembly(ies) still pending.` });
    }
  }

  const updates = [];
  const params = [];
  if (status) {
    updates.push('status = ?'); params.push(status);
    if (status === 'InProgress' && !jc.started_at) { updates.push('started_at = CURRENT_TIMESTAMP'); }
    if (status === 'Completed') { updates.push('completed_at = CURRENT_TIMESTAMP'); }
  }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  if (assigned_to !== undefined) {
    updates.push('assigned_to = ?'); params.push(assigned_to);
    // Stamp allocation time whenever the assignee actually changes (new
    // assignment or reassignment to someone else) - not on a no-op write of
    // the same value. On reassignment we deliberately RESET the clock: the
    // metric "how long did THIS assignee sit on it before starting" should
    // start fresh for the new person, not carry over the old assignee's wait.
    if (assigned_to !== jc.assigned_to) {
      updates.push('allocated_at = CURRENT_TIMESTAMP');
    }
  }
  params.push(req.params.id);
  db.prepare(`UPDATE job_cards SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  if (status === 'Completed') {
    // advance project.status to next incomplete top-level stage automatically
    const remaining = db.prepare(`
      SELECT stage FROM job_cards WHERE project_id = ? AND parent_job_card_id IS NULL AND status != 'Completed'
      ORDER BY COALESCE(sequence, id) LIMIT 1
    `).get(jc.project_id);
    if (remaining) {
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(remaining.stage, jc.project_id);
    } else {
      db.prepare(`UPDATE projects SET status = 'Completed' WHERE id = ?`).run(jc.project_id);
    }

    // release any cards that were routed to other departments depending on
    // this one, once ALL of their dependencies are now satisfied
    const dependents = db.prepare(`SELECT job_card_id FROM job_card_dependencies WHERE depends_on_id = ?`).all(jc.id);
    const today = new Date().toISOString().slice(0, 10);
    dependents.forEach(({ job_card_id }) => {
      const stillOpen = db.prepare(`
        SELECT COUNT(*) as n FROM job_card_dependencies d JOIN job_cards jc2 ON jc2.id = d.depends_on_id
        WHERE d.job_card_id = ? AND jc2.status != 'Completed'
      `).get(job_card_id).n;
      if (stillOpen === 0) {
        db.prepare(`UPDATE job_cards SET planned_start = COALESCE(planned_start, ?) WHERE id = ?`).run(today, job_card_id);
      }
    });
  }
  res.json({ ok: true });
});

module.exports = router;

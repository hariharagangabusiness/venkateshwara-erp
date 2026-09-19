const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

const STATUSES = ['Pending', 'InProgress', 'Completed', 'OnHold'];

// A department HOD (is_supervisor), Admin, or Management can log a To-Do,
// hand it to someone, and act on ANY To-Do (change its status, redefine it,
// reassign it) - same access-control convention already used for
// supervisor-only actions elsewhere (routes/finance.js, routes/tickets.js),
// extended to Management by role rather than the per-user is_supervisor flag.
// A regular employee can see and update the status of To-Dos assigned to
// them, but can't create new ones or act on someone else's.
function canLog(user) {
  return user.role_name === 'Admin' || user.role_name === 'Management' || !!user.is_supervisor;
}
// Who may see every To-Do and its full update log without owning it. Kept as
// a separate function from canLog even though the two sets currently match -
// they answer different questions (view vs. act), and future roles may need
// one without the other.
function canView(user) {
  return user.role_name === 'Admin' || user.role_name === 'Management' || !!user.is_supervisor;
}

// People pickers for the "Log a New To-Do" form.
router.get('/people', (req, res) => {
  const hods = db.prepare(`
    SELECT u.id, u.full_name, d.name as department
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.is_active = 1 AND u.is_supervisor = 1
    ORDER BY d.name, u.full_name
  `).all();
  const assignees = db.prepare(`
    SELECT u.id, u.full_name, d.name as department
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.is_active = 1
    ORDER BY d.name, u.full_name
  `).all();
  res.json({ hods, assignees, can_log: canLog(req.user), can_view: canView(req.user) });
});

// To-Dos where I'm the one who has the action.
router.get('/mine', (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, h.full_name as hod_name
    FROM todos t LEFT JOIN users h ON h.id = t.hod_id
    WHERE t.assigned_to = ?
    ORDER BY CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END, t.target_date ASC
  `).all(req.user.id));
});

// Every To-Do logged, across everyone - Management/HOD/Admin oversight view.
// A regular employee only ever sees their own via /mine.
router.get('/', (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ error: 'Access denied' });
  res.json(db.prepare(`
    SELECT t.*, h.full_name as hod_name, a.full_name as assigned_to_name, c.full_name as created_by_name
    FROM todos t
    LEFT JOIN users h ON h.id = t.hod_id
    JOIN users a ON a.id = t.assigned_to
    LEFT JOIN users c ON c.id = t.created_by
    ORDER BY CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END, t.target_date ASC
  `).all());
});

router.post('/', (req, res) => {
  if (!canLog(req.user)) return res.status(403).json({ error: 'Only a department HOD or Admin can log a To-Do.' });
  const { hod_id, assigned_to, start_date, target_date, brief_description, details, priority } = req.body;
  if (!assigned_to) return res.status(400).json({ error: 'assigned_to is required' });
  const assignee = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(assigned_to);
  if (!assignee) return res.status(400).json({ error: 'That person no longer has an active login.' });
  if (hod_id) {
    const hod = db.prepare('SELECT id FROM users WHERE id = ? AND is_supervisor = 1').get(hod_id);
    if (!hod) return res.status(400).json({ error: 'That user is not marked as a department HOD.' });
  }
  if (!start_date || !target_date) return res.status(400).json({ error: 'start_date and target_date are required' });
  const brief = String(brief_description || '').trim();
  if (!brief) return res.status(400).json({ error: 'brief_description is required' });
  if (priority !== undefined && !['Normal', 'High'].includes(priority)) return res.status(400).json({ error: 'priority must be Normal or High' });
  const info = db.prepare(`
    INSERT INTO todos (hod_id, assigned_to, start_date, target_date, brief_description, details, priority, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(hod_id || null, assigned_to, start_date, target_date, brief, details || null, priority || 'Normal', req.user.id);
  db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`)
    .run(assigned_to, 'TODO_ASSIGNED', info.lastInsertRowid, `New To-Do assigned to you: ${brief}`);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const isOwner = t.assigned_to === req.user.id;
  const isManager = canLog(req.user);
  if (!isOwner && !isManager) return res.status(403).json({ error: 'Access denied' });
  const { status, start_date, target_date, brief_description, details, hod_id, assigned_to, priority } = req.body;
  const updates = []; const params = [];
  // Anyone with the action can move its status; only the logging HOD/Admin
  // can redefine the task itself or hand it to someone else.
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    updates.push('status = ?', 'completed_at = ?');
    params.push(status, status === 'Completed' ? new Date().toISOString() : null);
  }
  if (isManager) {
    if (start_date !== undefined) { updates.push('start_date = ?'); params.push(start_date); }
    if (target_date !== undefined) { updates.push('target_date = ?'); params.push(target_date); }
    if (brief_description !== undefined) { updates.push('brief_description = ?'); params.push(String(brief_description).trim()); }
    if (details !== undefined) { updates.push('details = ?'); params.push(details || null); }
    if (hod_id !== undefined) { updates.push('hod_id = ?'); params.push(hod_id || null); }
    if (assigned_to !== undefined) { updates.push('assigned_to = ?'); params.push(assigned_to); }
    if (priority !== undefined) {
      if (!['Normal', 'High'].includes(priority)) return res.status(400).json({ error: 'priority must be Normal or High' });
      updates.push('priority = ?'); params.push(priority);
    }
  }
  if (!updates.length) return res.json({ ok: true });
  params.push(req.params.id);
  db.prepare(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  // A status move is logged into the same timeline as manual notes, so the
  // two read as one thread instead of two disconnected logs.
  if (status !== undefined) {
    db.prepare(`INSERT INTO todo_updates (todo_id, user_id, note, status_at_update) VALUES (?,?,?,?)`)
      .run(t.id, req.user.id, `Status changed to ${status}`, status);
  }
  res.json({ ok: true });
});

// Activity log: notes the assignee (or the logging HOD/Admin) attaches over
// the To-Do's life, plus the auto-logged status-change entries above.
router.get('/:id/updates', (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.assigned_to !== req.user.id && !canView(req.user)) return res.status(403).json({ error: 'Access denied' });
  res.json(db.prepare(`
    SELECT tu.*, u.full_name as user_name FROM todo_updates tu LEFT JOIN users u ON u.id = tu.user_id
    WHERE tu.todo_id = ? ORDER BY tu.id DESC
  `).all(t.id));
});
router.post('/:id/updates', (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const isOwner = t.assigned_to === req.user.id;
  if (!isOwner && !canLog(req.user)) return res.status(403).json({ error: 'Only the assignee or the logging HOD/Admin can add an update.' });
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note is required' });
  const info = db.prepare(`INSERT INTO todo_updates (todo_id, user_id, note, status_at_update) VALUES (?,?,?,?)`)
    .run(t.id, req.user.id, note, t.status);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (req.user.role_name !== 'Admin' && t.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Only the person who logged this To-Do (or Admin) can delete it.' });
  }
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

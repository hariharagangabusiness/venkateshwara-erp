const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

function ticketRow(t) {
  return t;
}

router.get('/mine', (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, d.name as department_name, u.full_name as assigned_to_name
    FROM tickets t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.raised_by = ? ORDER BY t.id DESC
  `).all(req.user.id));
});

// Queue for the caller's own department - HOD/Supervisor and members see everything
// raised against their department; a plain member sees only tickets assigned to them.
router.get('/department', (req, res) => {
  const isPrivileged = req.user.role_name === 'Admin' || req.user.is_supervisor;
  let q = `
    SELECT t.*, d.name as department_name, ru.full_name as raised_by_name, au.full_name as assigned_to_name
    FROM tickets t LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN users ru ON ru.id = t.raised_by LEFT JOIN users au ON au.id = t.assigned_to
    WHERE t.department_id = ?
  `;
  const params = [req.user.department_id];
  if (!isPrivileged) { q += ' AND t.assigned_to = ?'; params.push(req.user.id); }
  q += ' ORDER BY t.id DESC';
  res.json(db.prepare(q).all(...params));
});

router.get('/:id', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, d.name as department_name, ru.full_name as raised_by_name, au.full_name as assigned_to_name
    FROM tickets t LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN users ru ON ru.id = t.raised_by LEFT JOIN users au ON au.id = t.assigned_to WHERE t.id = ?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const comments = db.prepare(`
    SELECT c.*, u.full_name as user_name FROM ticket_comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.ticket_id = ? ORDER BY c.id
  `).all(t.id);
  res.json({ ticket: t, comments });
});

router.post('/', (req, res) => {
  const { subject, description, category, priority, department_id } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject is required.' });
  if (!department_id) return res.status(400).json({ error: 'Pick a target department.' });
  const ticketNo = 'TKT-' + Date.now();
  const info = db.prepare(`
    INSERT INTO tickets (ticket_no, subject, description, category, priority, department_id, raised_by, status)
    VALUES (?,?,?,?,?,?,?,'Open')
  `).run(ticketNo, subject, description || null, category || 'General', priority || 'Medium', department_id, req.user.id);
  res.json({ id: info.lastInsertRowid, ticket_no: ticketNo });
});

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isPrivileged = req.user.role_name === 'Admin' || req.user.is_supervisor;
  const isOwner = existing.raised_by === req.user.id;
  const isAssignee = existing.assigned_to === req.user.id;
  if (!isPrivileged && !isOwner && !isAssignee) return res.status(403).json({ error: 'Not authorized to update this ticket.' });
  const { status, assigned_to } = req.body;
  const validStatuses = ['Open', 'InProgress', 'Resolved', 'Closed', 'Reopened'];
  const newStatus = status !== undefined ? status : existing.status;
  if (status !== undefined && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  db.prepare(`UPDATE tickets SET status=?, assigned_to=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(newStatus, assigned_to !== undefined ? (assigned_to || null) : existing.assigned_to, existing.id);
  res.json({ ok: true });
});

router.post('/:id/comments', (req, res) => {
  const existing = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { comment } = req.body;
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const info = db.prepare(`INSERT INTO ticket_comments (ticket_id, user_id, comment) VALUES (?,?,?)`)
    .run(existing.id, req.user.id, comment.trim());
  db.prepare(`UPDATE tickets SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(existing.id);
  res.json({ id: info.lastInsertRowid });
});

module.exports = router;

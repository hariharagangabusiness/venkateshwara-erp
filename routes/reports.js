const express = require('express');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { combinedStagesForRole } = require('../lib/pipeline');
const { listExportableTables, exportTableXlsx } = require('../lib/tableExport');
const router = express.Router();
router.use(authRequired);

// ===================== Full-field table export (Admin only) =====================
// Every raw column of any whitelisted table, straight to xlsx, for external
// deep-dive analysis (Power BI, Python/pandas) - see lib/tableExport.js for
// what's excluded and why. Admin-only: a raw dump includes internal FKs and
// audit columns not normally shown on any screen.
router.get('/export/tables', requireRole('Admin'), (req, res) => {
  res.json(listExportableTables());
});
router.get('/export/:table', requireRole('Admin'), (req, res) => {
  exportTableXlsx(res, req.params.table);
});

function isDeptSupervisor(user, stage) {
  if (user.role_name === 'Admin') return true;
  if (user.role_name === stage) return !!user.is_supervisor;
  if (user.role_name === 'Manufacturing' && user.is_supervisor && combinedStagesForRole('Manufacturing').includes(stage)) return true;
  return false;
}

// Department reporting: counts by status, average cycle time, active job
// cards with days-in-stage. Gated to that department's HOD/Supervisor (or Admin).
router.get('/department/:stage', (req, res) => {
  const stage = req.params.stage;
  if (!isDeptSupervisor(req.user, stage)) {
    return res.status(403).json({ error: `Only the ${stage} HOD/Supervisor (or Admin) can view this report.` });
  }
  const stages = combinedStagesForRole(stage);
  const placeholders = stages.map(() => '?').join(',');
  const cards = db.prepare(`
    SELECT jc.*, p.project_code, p.title as project_title
    FROM job_cards jc JOIN projects p ON p.id = jc.project_id
    WHERE jc.stage IN (${placeholders})
  `).all(...stages);

  const today = new Date().toISOString().slice(0, 10);
  const counts = { Pending: 0, InProgress: 0, Completed: 0, OnHold: 0, Delayed: 0 };
  let cycleDaysSum = 0, cycleCount = 0;
  const active = [];
  cards.forEach(c => {
    if (c.status === 'Completed') {
      counts.Completed++;
      if (c.started_at && c.completed_at) {
        const days = (new Date(c.completed_at) - new Date(c.started_at)) / 86400000;
        cycleDaysSum += days; cycleCount++;
      }
    } else {
      const isDelayed = c.planned_end && c.planned_end < today;
      if (isDelayed) counts.Delayed++;
      else counts[c.status] = (counts[c.status] || 0) + 1;
      if (c.planned_start) {
        const daysInStage = Math.floor((new Date() - new Date(c.started_at || c.planned_start)) / 86400000);
        active.push({ ...c, days_in_stage: Math.max(0, daysInStage), delayed: isDelayed });
      }
    }
  });
  res.json({
    stage, total: cards.length, counts,
    avg_cycle_days: cycleCount ? Math.round((cycleDaysSum / cycleCount) * 10) / 10 : null,
    active,
  });
});

module.exports = router;

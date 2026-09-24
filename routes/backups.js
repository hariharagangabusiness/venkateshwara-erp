const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { runBackup, listBackupRuns, getBackupRun } = require('../lib/backup');
const router = express.Router();
router.use(authRequired);
router.use(requireRole('Admin'));

router.get('/', (req, res) => {
  res.json(listBackupRuns(50));
});

router.post('/run', async (req, res) => {
  const result = await runBackup({ triggerType: 'Manual', triggeredBy: req.user.id });
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json(result);
});

router.get('/:id/download', (req, res) => {
  const run = getBackupRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (!run.artifact_path || !fs.existsSync(run.artifact_path)) {
    return res.status(410).json({ error: 'This backup has been purged by retention cleanup and is no longer on disk - the log entry is kept for the audit trail, but the file itself is gone.' });
  }
  if (!run.is_archive) {
    return res.status(400).json({ error: 'This backup is an uncompressed folder (tar was unavailable when it ran), not a single downloadable file - copy it directly from the server\'s backup directory instead.' });
  }
  res.download(run.artifact_path, path.basename(run.artifact_path));
});

router.delete('/:id', (req, res) => {
  const run = getBackupRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (run.artifact_path && fs.existsSync(run.artifact_path)) {
    fs.rmSync(run.artifact_path, { recursive: true, force: true });
  }
  db.prepare('DELETE FROM backup_runs WHERE id = ?').run(run.id);
  res.json({ ok: true });
});

module.exports = router;

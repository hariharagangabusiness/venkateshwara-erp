// Daily backup: a consistent SQLite snapshot (via VACUUM INTO, safe to run
// against a live database - no need to stop the app or lock out writers)
// plus a copy of the uploads directory, bundled into a single .tar.gz when
// the `tar` binary is available (falls back to a plain folder otherwise -
// still a fully valid, restorable backup, just not one file). Every run is
// logged to backup_runs (db/schema.sql) regardless of outcome, so an Admin
// always has an audit trail even once old artifacts are purged by
// retention cleanup.
//
// Migrating to a new environment: stop the app, replace its erp.db with
// the backup's erp.db and its uploads directory with the backup's uploads
// folder, then start the app pointed at those paths (DATA_DIR/UPLOADS_DIR).
// That's the whole procedure - nothing here is a proprietary format.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { db, dataDir } = require('../db');
const { getUploadsDir } = require('./paths');
const { sendMail } = require('./mailer');
const zohoWorkdrive = require('./zohoWorkdrive');

function getBackupDir() {
  const dir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRetentionDays() {
  const n = Number(process.env.BACKUP_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

// Max attachment size for emailing the backup - most SMTP providers reject
// well before 25MB once base64 overhead and headers are added, so this
// stays comfortably under that rather than finding out by a bounced send.
const EMAIL_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else { try { total += fs.statSync(full).size; } catch (e) {} }
  }
  return total;
}

function timestampSlug(d) {
  return d.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

// Escapes a path for embedding in a single-quoted SQL string literal - the
// path itself is always generated internally (never user input), so this
// is just correctness (a literal apostrophe in a directory name) rather
// than an injection concern.
function sqlQuote(p) {
  return p.replace(/'/g, "''");
}

// Recursive copy that skips a file it can't read instead of aborting the
// whole backup - fs.cpSync({recursive:true}) throws on the first error, so
// one corrupted file or broken symlink on the volume used to take the
// entire uploads folder down with it. Returns the list of {path, error}
// entries it had to skip.
function copyDirResilient(src, dest, skipped) {
  fs.mkdirSync(dest, { recursive: true });
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    skipped.push({ path: src, error: e.message });
    return;
  }
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        copyDirResilient(srcPath, destPath, skipped);
      } else if (entry.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(srcPath), destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (e) {
      skipped.push({ path: srcPath, error: e.message });
    }
  }
}

function tarAvailable() {
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

function insertRun(triggerType, triggeredBy) {
  const info = db.prepare(`INSERT INTO backup_runs (trigger_type, triggered_by, status) VALUES (?,?,'Running')`)
    .run(triggerType, triggeredBy || null);
  return info.lastInsertRowid;
}
function finishRun(id, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map(c => `${c}=?`).join(',');
  db.prepare(`UPDATE backup_runs SET finished_at=CURRENT_TIMESTAMP, ${sets} WHERE id=?`).run(...cols.map(c => fields[c]), id);
}

// Deletes backup artifacts (files or folders) older than the retention
// window. Deliberately leaves backup_runs rows alone - the log survives
// its own artifact being purged, per the table's own comment in schema.sql.
function purgeOldBackups() {
  const backupDir = getBackupDir();
  const cutoff = Date.now() - getRetentionDays() * 86400000;
  let entries;
  try { entries = fs.readdirSync(backupDir, { withFileTypes: true }); } catch (e) { return; }
  entries.forEach(entry => {
    const full = path.join(backupDir, entry.name);
    let mtimeMs;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (e) { return; }
    if (mtimeMs >= cutoff) return;
    try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
  });
}

async function runBackup({ triggerType, triggeredBy } = {}) {
  const runId = insertRun(triggerType || 'Manual', triggeredBy);
  const backupDir = getBackupDir();
  const slug = timestampSlug(new Date());
  const workDir = path.join(backupDir, slug);
  try {
    fs.mkdirSync(workDir, { recursive: true });

    // 1. Consistent DB snapshot - VACUUM INTO is safe against a live,
    // concurrently-written database (unlike copying the .db file by hand,
    // which can grab it mid-write under WAL).
    const dbBackupPath = path.join(workDir, 'erp.db');
    db.exec(`VACUUM INTO '${sqlQuote(dbBackupPath)}'`);
    const dbSize = fs.statSync(dbBackupPath).size;

    // 2. Uploaded files (PO/quote/BG documents, offer covers, etc.) -
    // copied file-by-file (not fs.cpSync) so one unreadable file doesn't
    // abort the whole backup; see copyDirResilient above.
    const uploadsSrc = getUploadsDir();
    const uploadsDest = path.join(workDir, 'uploads');
    const skippedFiles = [];
    copyDirResilient(uploadsSrc, uploadsDest, skippedFiles);
    const uploadsSize = dirSizeBytes(uploadsDest);
    if (skippedFiles.length) {
      console.error(`[backup] ${skippedFiles.length} file(s) under uploads could not be read and were skipped:`,
        skippedFiles.map(f => `${f.path} (${f.error})`).join('; '));
    }

    // 3. Bundle into one .tar.gz when possible - much easier to download,
    // email, or copy to another server than a loose folder tree.
    let artifactPath = workDir;
    let isArchive = false;
    if (tarAvailable()) {
      const archivePath = path.join(backupDir, slug + '.tar.gz');
      try {
        execFileSync('tar', ['-czf', archivePath, '-C', backupDir, slug]);
        fs.rmSync(workDir, { recursive: true, force: true });
        artifactPath = archivePath;
        isArchive = true;
      } catch (e) {
        // Tarring failed after the raw folder was already built - keep the
        // folder itself as the artifact rather than losing the backup.
        console.error('[backup] tar failed, keeping uncompressed folder:', e.message);
      }
    }
    const totalSize = isArchive ? fs.statSync(artifactPath).size : dbSize + uploadsSize;

    // 4. Optional offsite copy via email - the only "off this volume" copy
    // this app can make without new cloud-storage credentials. Skipped
    // (not failed) when unconfigured, too large, or not a single file.
    let emailed = 0, emailError = null;
    const emailTo = process.env.BACKUP_EMAIL_TO;
    if (!emailTo) {
      emailError = 'BACKUP_EMAIL_TO is not set - backup kept locally only.';
    } else if (!isArchive) {
      emailError = 'Could not email: tar is unavailable, so the backup is a folder, not a single file.';
    } else if (totalSize > EMAIL_SIZE_LIMIT_BYTES) {
      emailError = `Backup is ${(totalSize / 1024 / 1024).toFixed(1)}MB, over the ${EMAIL_SIZE_LIMIT_BYTES / 1024 / 1024}MB email limit - kept locally only.`;
    } else {
      const result = await sendMail({
        to: emailTo,
        subject: `ERP daily backup - ${slug}`,
        text: `Automated backup attached. DB: ${(dbSize / 1024).toFixed(0)}KB, Uploads: ${(uploadsSize / 1024).toFixed(0)}KB.`,
        attachments: [{ filename: path.basename(artifactPath), path: artifactPath }],
      });
      if (result.sent) emailed = 1;
      else emailError = result.reason || 'Unknown send failure.';
    }

    // 5. Optional additional offsite copy - Zoho WorkDrive. Independent of
    // the email step above (both can run, either can be configured alone);
    // same "not a single file" constraint as email applies.
    let zohoUploaded = 0, zohoFileId = null, zohoError = null;
    if (!isArchive) {
      zohoError = 'Could not upload: tar is unavailable, so the backup is a folder, not a single file.';
    } else {
      const zohoResult = await zohoWorkdrive.uploadFile(artifactPath);
      if (zohoResult.uploaded) { zohoUploaded = 1; zohoFileId = zohoResult.fileId; }
      else zohoError = zohoResult.reason;
    }

    finishRun(runId, {
      status: 'Success', artifact_path: artifactPath, is_archive: isArchive ? 1 : 0,
      db_size_bytes: dbSize, uploads_size_bytes: uploadsSize, total_size_bytes: totalSize,
      emailed, email_error: emailError,
      zoho_uploaded: zohoUploaded, zoho_file_id: zohoFileId, zoho_error: zohoError,
      skipped_files: skippedFiles.length ? JSON.stringify(skippedFiles) : null,
    });

    purgeOldBackups();
    return {
      ok: true, id: runId, artifactPath, totalSize, emailed: !!emailed, emailError, zohoUploaded: !!zohoUploaded, zohoError,
      skippedFiles,
    };
  } catch (e) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e2) {}
    finishRun(runId, { status: 'Failed', error_message: e.message });
    return { ok: false, id: runId, error: e.message };
  }
}

function listBackupRuns(limit) {
  return db.prepare(`
    SELECT b.*, u.full_name as triggered_by_name FROM backup_runs b LEFT JOIN users u ON u.id = b.triggered_by
    ORDER BY b.id DESC LIMIT ?
  `).all(limit || 50);
}
function getBackupRun(id) {
  return db.prepare(`SELECT * FROM backup_runs WHERE id = ?`).get(id);
}
// Has today's backup (any status) already run? Used to skip a redundant
// re-run on every server restart (frequent during active deploys) while
// still guaranteeing a true daily cadence in steady-state production.
function ranToday() {
  const today = new Date().toISOString().slice(0, 10);
  return !!db.prepare(`SELECT id FROM backup_runs WHERE substr(started_at, 1, 10) = ? AND trigger_type = 'Scheduled'`).get(today);
}

module.exports = { runBackup, listBackupRuns, getBackupRun, ranToday, getBackupDir, getRetentionDays, purgeOldBackups };

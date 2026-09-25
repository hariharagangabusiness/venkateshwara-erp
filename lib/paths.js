const fs = require('fs');
const path = require('path');

// Single source of truth for the uploads base directory.
//
// Default (UPLOADS_DIR unset): public/uploads under the app dir, exactly as
// before this helper existed — local dev behavior is unchanged.
//
// When UPLOADS_DIR is set (e.g. on Render, pointed at a mounted persistent
// disk), uploads are stored there instead so they survive redeploys.
function getUploadsDir() {
  const dir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Convenience for a named sub-directory under the uploads base
// (e.g. getUploadsSubdir('service-reports')).
function getUploadsSubdir(...segments) {
  const dir = path.join(getUploadsDir(), ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Converts a stored '/uploads/...' relative path (as saved in the DB) back
// to an absolute filesystem path, honoring UPLOADS_DIR. Several call sites
// used to hardcode path.join(__dirname, '..', 'public', relPath) instead -
// that only happens to work when UPLOADS_DIR is unset, since it defaults to
// public/uploads; once UPLOADS_DIR points elsewhere (as it does on the
// Oracle Cloud VM), those hardcoded paths silently miss real files.
function resolveUploadPath(relPath) {
  const rel = String(relPath || '').replace(/^\/?uploads\//, '');
  return path.join(getUploadsDir(), rel);
}

module.exports = { getUploadsDir, getUploadsSubdir, resolveUploadPath };

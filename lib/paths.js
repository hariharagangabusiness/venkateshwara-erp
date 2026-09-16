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

module.exports = { getUploadsDir, getUploadsSubdir };

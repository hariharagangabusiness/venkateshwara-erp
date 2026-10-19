const multer = require('multer');
const { getUploadsSubdir } = require('./paths');

function makeUpload(subdir, maxSizeMB, filename) {
  const uploadDir = getUploadsSubdir(subdir);
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: filename
        ? (req, file, cb) => cb(null, filename(file.originalname))
        : (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')),
    }),
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
  });
}

const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

module.exports = { makeUpload, uploadMemory };

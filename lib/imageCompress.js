const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// A photo uploaded straight off a phone/camera for an offer item, an
// equipment-description reference, or the Section Title library commonly
// runs 1-5MB at multi-megapixel resolution - miles more than a PDF/Word
// document showing it at a few hundred pixels wide ever needs, and neither
// Chromium's PDF printing pipeline nor the docx library re-samples an image
// on their own. Left uncompressed, a handful of such photos alone is enough
// to make a generated offer PDF several MB. These numbers (long edge, JPEG
// quality) are a deliberate "still looks sharp at max-height:280px in a
// PDF/Word doc" tradeoff, not a hard technical limit.
const MAX_DIMENSION = 1200;
const JPEG_QUALITY = 80;
// Skip re-compressing something already small enough that JPEG re-encoding
// would only spend CPU and re-encoding artifacts for no real size benefit.
const SKIP_BELOW_BYTES = 150 * 1024;

// Resizes (if needed) and re-encodes as JPEG. Returns { buffer, mime } where
// `mime` is null when the input was left untouched (already small, or
// unreadable/corrupt - sharp's own error, never thrown further) so a caller
// can tell whether it needs to change the file's extension/content-type.
// Never throws: a compression failure just means the original bytes are
// used as-is, exactly as before this existed.
async function compressImage(buffer) {
  try {
    const img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return { buffer, mime: null };
    if (meta.width <= MAX_DIMENSION && meta.height <= MAX_DIMENSION && buffer.length < SKIP_BELOW_BYTES) {
      return { buffer, mime: null };
    }
    const out = await img
      .rotate() // bakes in EXIF orientation before resizing, so a sideways phone photo doesn't end up sideways
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    // A tiny/simple source image (e.g. a small PNG icon) can occasionally
    // come out larger as re-encoded JPEG - only use the result if it's
    // actually smaller.
    if (out.length >= buffer.length) return { buffer, mime: null };
    return { buffer: out, mime: 'image/jpeg' };
  } catch (e) {
    return { buffer, mime: null };
  }
}

// Upload-time counterpart: compresses a just-saved file in place, renaming
// it to .jpg when the content actually changed format (so the stored
// extension always matches its real bytes). Returns the filename to use
// (unchanged if compression didn't help or the file couldn't be read) -
// never throws, so a compression hiccup never fails the upload itself.
async function compressUploadedImageFile(absPath) {
  try {
    const original = fs.readFileSync(absPath);
    const { buffer, mime } = await compressImage(original);
    if (!mime) return path.basename(absPath);
    const dir = path.dirname(absPath);
    const newName = path.basename(absPath, path.extname(absPath)) + '.jpg';
    const newPath = path.join(dir, newName);
    fs.writeFileSync(newPath, buffer);
    if (newPath !== absPath) fs.unlinkSync(absPath);
    return newName;
  } catch (e) {
    return path.basename(absPath);
  }
}

module.exports = { compressImage, compressUploadedImageFile };

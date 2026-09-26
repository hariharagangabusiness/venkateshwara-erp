// Builds the filename a browser saves a generated document under - the
// actual intent behind "every generated PDF/document must carry the
// transaction name, customer name if available, date, and version": this
// was first implemented as text printed inside the PDF body, which was a
// misread of the request. The real ask was the downloaded FILE's name.
//
// version follows the same rule used elsewhere in this app: Offers have a
// real revision counter (offers.version) and pass that in directly (e.g.
// 'v2'); every other document type has no revision concept in the schema,
// so callers pass a generation timestamp instead - buildVersionStamp() below
// produces the filename-safe form of that timestamp.
function sanitizeFilenamePart(s) {
  return String(s || '')
    .trim()
    // Characters illegal (or awkward) in a filename on Windows/macOS/Linux.
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// Compact, filename-safe local timestamp (no colons) - e.g. 20260926-1435.
function buildVersionStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// docType/reference/partyName/date/version are joined with underscores,
// each sanitized and empty pieces dropped - so a document type with no
// natural counterparty (e.g. an SOA with no client name on file) still
// produces a sane filename instead of a stray double-underscore.
function buildDownloadFilename({ docType, reference, partyName, date, version, ext }) {
  const parts = [docType, reference, partyName, date, version]
    .map(sanitizeFilenamePart)
    .filter(Boolean);
  return parts.join('_') + '.' + (ext || 'pdf');
}

module.exports = { buildDownloadFilename, buildVersionStamp, sanitizeFilenamePart };

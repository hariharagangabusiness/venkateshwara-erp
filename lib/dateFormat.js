// Shared DD/MM/YYYY date formatter for every PDF/Word document generator
// (2026-10-10) - previously each generator formatted dates its own way (some
// via a bare `new Date(x).toLocaleDateString()`, which reads M/D/YYYY in
// this app's server locale and is easily misread as day-first; others via
// an 'en-GB' day/short-month/year style like "9 Oct 2026"; several fields -
// PO Delivery Date, Foreign Payment's License/Forward-Contract/Declaration/
// BOE-Due dates, Service Report's Activity Date - printed the raw stored
// string with no formatting at all) - now one shared, consistent
// zero-padded DD/MM/YYYY everywhere a date appears on a generated document.
function formatDate(d) {
  if (!d) return '';
  // A bare 'YYYY-MM-DD' (from an <input type="date">) or SQLite's
  // 'YYYY-MM-DD HH:MM:SS'/'...T...Z' - read the calendar date straight out
  // of the string rather than through `new Date(...)`, which parses a
  // date-only string as UTC midnight and can roll back a day once read in a
  // negative-UTC-offset local time zone. The date recorded is the date
  // meant, not something to re-derive via a timezone conversion.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

module.exports = { formatDate };

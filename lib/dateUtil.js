'use strict';
// Shared IST-safe "what is today/now" helpers (2026-11-20) - the server
// process runs with TZ=Asia/Kolkata (set as the very first line of
// server.js), so every local Date getter (getFullYear/getMonth/getDate/
// getHours/...) already reads the correct IST wall-clock value with no
// conversion needed. The one thing to actively avoid is ever routing a date
// through .toISOString() for "what calendar day/time is this" purposes -
// that method is UTC by spec regardless of the process timezone, so it
// silently reintroduces the exact bug this round fixed: a value that's
// already local (IST) gets converted backward to UTC, which can roll the
// calendar day back by up to a full day during the ~5.5-hour window between
// IST midnight and the following UTC midnight.
function pad(n) { return String(n).padStart(2, '0'); }

// Formats a JS Date using the process's own local (IST) wall-clock fields -
// never UTC. Use for "now" or a computed future/past Date (e.g. N days
// ahead via `new Date(Date.now() + n*86400000)`) - never for an
// already-stored date/datetime string (use localDateFromValue for that
// instead, which skips Date parsing entirely).
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localMonthStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function localDateTimeStr(d = new Date()) {
  return `${localDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// The safe way to get a 'YYYY-MM-DD' out of either a Date object (formatted
// via local/IST wall-clock fields) or an already-stored date/datetime
// string (regex-extracts the leading YYYY-MM-DD directly - the same
// zone-safe technique lib/dateFormat.js's own formatDate() already uses for
// display, never parsed through `new Date(...)`, which would re-interpret
// the string under the process's local zone and risks shifting the
// calendar day for a value that carries a time component).
function localDateFromValue(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : localDateStr(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (m) return m[1];
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : localDateStr(d);
}

module.exports = { localDateStr, localMonthStr, localDateTimeStr, localDateFromValue };

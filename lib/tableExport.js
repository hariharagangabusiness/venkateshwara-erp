const XLSX = require('xlsx');
const { db } = require('../db');

// Exclude-list, not an include-list: "any ERP data table" (per the ask)
// should stay true as new tables get added, without someone having to
// remember to whitelist each one. Only these few are blocked outright -
// credentials, or internal access-control plumbing that isn't business data.
const EXCLUDED_TABLES = new Set([
  'users',                  // password_hash must never leave the system as a flat file
  'settings',               // generic key-value store - may hold SMTP/API credentials
  'permissions', 'role_permissions', 'roles', 'role_page_access', 'role_access_configured', 'extra_page_access', // ACL config, not business data
]);

function listExportableTables() {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()
    .map(r => r.name).filter(t => !EXCLUDED_TABLES.has(t)).sort();
}

// Every raw column as-is - FKs, status codes, timestamps included - for
// deep-dive external analysis (Power BI, Python/pandas). No formatting,
// joins, or column renaming: that's what the app's own report pages are for.
function exportTableXlsx(res, table) {
  if (!listExportableTables().includes(table)) {
    return res.status(404).json({ error: 'Unknown or non-exportable table' });
  }
  const rows = db.prepare(`SELECT * FROM ${table}`).all(); // table is whitelist-checked above, never raw user input in the query
  const wb = XLSX.utils.book_new();
  const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['(no rows)']]);
  XLSX.utils.book_append_sheet(wb, ws, table.slice(0, 31));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${table}_full_export.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

module.exports = { listExportableTables, exportTableXlsx };

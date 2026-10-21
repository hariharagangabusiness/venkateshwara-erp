// One-off repair: link PO-1791952194670's unapproved, unbatched GRN rows (and
// their stock movements) under a single new grn_batches header.
// Usage: node scripts/consolidate-historical-grn.js <path-to-erp.db> [--apply]
// Dry run by default; back up erp.db first and boot the server once on the new
// code so the grn_batches / grn_batch_id / is_placeholder migrations exist.
const { DatabaseSync } = require('node:sqlite');

const PO_NO = 'PO-1791952194670';
const PLACEHOLDER = 'PLACEHOLDER - vendor invoice not yet received';
const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dbPath || dbPath.startsWith('--')) { console.error('Usage: node scripts/consolidate-historical-grn.js <db path> [--apply]'); process.exit(1); }

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
if (!hasCol('grn_reconciliations', 'grn_batch_id') || !hasCol('stock_movements', 'grn_batch_id') || !hasCol('grn_batches', 'is_placeholder')) {
  console.error('Schema is missing grn_batches / grn_batch_id / is_placeholder - start the server once on the latest code first.');
  process.exit(1);
}

const rows = db.prepare(`
  SELECT g.id, g.stock_movement_id, g.vendor_invoice_no, g.vendor_invoice_date, g.po_id
  FROM grn_reconciliations g JOIN purchase_orders po ON po.id = g.po_id
  WHERE po.po_no = ? AND g.status IN ('PendingApproval', 'InfoRequested') AND g.grn_batch_id IS NULL
  ORDER BY g.id`).all(PO_NO);
if (!rows.length) { console.error(`No unapproved, unbatched GRN rows found for ${PO_NO}.`); process.exit(1); }

const invoices = new Set(rows.map(r => (r.vendor_invoice_no || '').trim()));
if (invoices.size !== 1) { console.error(`Aborting: rows carry different vendor invoice values: ${[...invoices].map(v => JSON.stringify(v)).join(', ')}`); process.exit(1); }
const missingMv = rows.filter(r => !r.stock_movement_id);
if (missingMv.length) { console.error(`Aborting: GRN rows without a stock movement: ${missingMv.map(r => r.id).join(', ')}`); process.exit(1); }

console.log(`${PO_NO}: ${rows.length} GRN rows (ids ${rows.map(r => r.id).join(', ')}), invoice ${JSON.stringify([...invoices][0])}`);
if (rows.length !== 13) console.warn(`WARNING: expected 13 lines, found ${rows.length}.`);
if (!apply) { console.log('Dry run - nothing changed. Re-run with --apply to write.'); process.exit(0); }

db.exec('BEGIN IMMEDIATE');
try {
  const batchId = db.prepare('INSERT INTO grn_batches (po_id, invoice_attachment_path, is_placeholder) VALUES (?,?,1)').run(rows[0].po_id, PLACEHOLDER).lastInsertRowid;
  const g = db.prepare('UPDATE grn_reconciliations SET grn_batch_id = ? WHERE id = ?');
  const m = db.prepare('UPDATE stock_movements SET grn_batch_id = ? WHERE id = ?');
  for (const r of rows) { g.run(batchId, r.id); m.run(batchId, r.stock_movement_id); }
  db.exec('COMMIT');
  console.log(`Applied: grn_batches #${batchId} now holds ${rows.length} lines.`);
} catch (e) { db.exec('ROLLBACK'); console.error('Rolled back:', e.message); process.exit(1); }

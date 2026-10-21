// One-off repair: link every PO's unapproved, unbatched GRN rows (and their
// stock movements) under a grn_batches header, so pre-deployment receipts
// get the same consolidated-approval-card treatment as the new batch
// receive flow gives going forward.
//
// Grouped by (po_no, vendor_invoice_no), not po_id - a multi-line PO in
// this app is several purchase_orders rows sharing one po_no (grn_batches
// itself only stores one representative line's po_id, same as the real
// receive-batch route's own INSERT), so po_no is the real "this is one PO"
// key, not the per-line po_id. A PO received against genuinely different
// vendor invoices over time is never forced into one batch, since that
// would misrepresent what was actually billed. A row with a blank/missing
// invoice number is left exactly as it is today (not merged with any other
// row, blank or not - we can't safely assume two blank-invoice rows
// represent the same real invoice). Only groups of 2+ rows are batched; a
// lone row already renders fine as a single approval card.
//
// Usage: node scripts/consolidate-historical-grn.js <path-to-erp.db> [--apply]
// Dry run by default; back up erp.db first and boot the server once on the
// new code so the grn_batches / grn_batch_id / is_placeholder migrations exist.
const { DatabaseSync } = require('node:sqlite');

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
  SELECT g.id, g.stock_movement_id, g.vendor_invoice_no, g.vendor_invoice_date, g.po_id, po.po_no
  FROM grn_reconciliations g JOIN purchase_orders po ON po.id = g.po_id
  WHERE g.status IN ('PendingApproval', 'InfoRequested') AND g.grn_batch_id IS NULL
  ORDER BY g.po_id, g.id`).all();

if (!rows.length) { console.error('No unapproved, unbatched GRN rows found anywhere.'); process.exit(0); }

// Group by (po_no, trimmed invoice no) - a blank invoice no gets its own
// singleton group per row, never merged with another row.
const groups = new Map();
let blankCounter = 0;
for (const r of rows) {
  const inv = (r.vendor_invoice_no || '').trim();
  const key = inv ? `${r.po_no}::${inv}` : `${r.po_no}::__blank_${blankCounter++}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const eligible = [...groups.values()].filter(g => g.length >= 2);
const skippedSingles = rows.length - eligible.reduce((n, g) => n + g.length, 0);

if (!eligible.length) {
  console.log(`${rows.length} unbatched row(s) found, but none share a PO + invoice number with another row - nothing to consolidate.`);
  process.exit(0);
}

console.log(`Found ${eligible.length} batchable group(s) across ${new Set(eligible.flatMap(g => g.map(r => r.po_no))).size} PO(s), covering ${eligible.reduce((n, g) => n + g.length, 0)} GRN rows. ${skippedSingles} row(s) left as-is (no matching sibling).`);
for (const g of eligible) {
  console.log(`  ${g[0].po_no} / invoice ${JSON.stringify(g[0].vendor_invoice_no || '')}: ${g.length} rows (ids ${g.map(r => r.id).join(', ')})`);
}

const missingMv = eligible.flatMap(g => g.filter(r => !r.stock_movement_id));
if (missingMv.length) { console.error(`Aborting: GRN rows without a stock movement: ${missingMv.map(r => r.id).join(', ')}`); process.exit(1); }

if (!apply) { console.log('Dry run - nothing changed. Re-run with --apply to write.'); process.exit(0); }

db.exec('BEGIN IMMEDIATE');
try {
  const insertBatch = db.prepare('INSERT INTO grn_batches (po_id, invoice_attachment_path, is_placeholder) VALUES (?,?,1)');
  const g = db.prepare('UPDATE grn_reconciliations SET grn_batch_id = ? WHERE id = ?');
  const m = db.prepare('UPDATE stock_movements SET grn_batch_id = ? WHERE id = ?');
  let batchCount = 0;
  for (const group of eligible) {
    const batchId = insertBatch.run(group[0].po_id, PLACEHOLDER).lastInsertRowid;
    for (const r of group) { g.run(batchId, r.id); m.run(batchId, r.stock_movement_id); }
    batchCount++;
  }
  db.exec('COMMIT');
  console.log(`Applied: created ${batchCount} batch(es) covering ${eligible.reduce((n, grp) => n + grp.length, 0)} GRN rows.`);
} catch (e) { db.exec('ROLLBACK'); console.error('Rolled back:', e.message); process.exit(1); }

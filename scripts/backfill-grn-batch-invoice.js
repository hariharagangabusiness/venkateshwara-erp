// One-off migration: put vendor invoice no/date on grn_batches headers and
// move per-line GRN attachments onto the batch. Idempotent.
//  A. existing batches inherit invoice no/date from their first line
//  B. unbatched GRN lines get a placeholder batch: lines sharing
//     (po_no, invoice no, invoice date) share ONE batch; a blank invoice no is
//     never merged (one batch per line)
//  C. grn_reconciliation attachments move to grn_batches (deduped by file)
// Usage: node scripts/backfill-grn-batch-invoice.js <erp.db> [--apply]
// Back up first; boot the server once on the new code so the columns exist.
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dbPath || dbPath.startsWith('--')) { console.error('Usage: node scripts/backfill-grn-batch-invoice.js <db path> [--apply]'); process.exit(1); }
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
if (!db.prepare('PRAGMA table_info(grn_batches)').all().some(c => c.name === 'vendor_invoice_no')) {
  console.error('grn_batches.vendor_invoice_no missing - start the server once on the latest code first.'); process.exit(1);
}
const PLACEHOLDER = 'PLACEHOLDER - vendor invoice not yet received';
db.exec('BEGIN IMMEDIATE');
try {
  const a = db.prepare(`
    UPDATE grn_batches SET
      vendor_invoice_no = (SELECT g.vendor_invoice_no FROM grn_reconciliations g WHERE g.grn_batch_id = grn_batches.id AND g.vendor_invoice_no IS NOT NULL ORDER BY g.id LIMIT 1),
      vendor_invoice_date = (SELECT g.vendor_invoice_date FROM grn_reconciliations g WHERE g.grn_batch_id = grn_batches.id AND g.vendor_invoice_date IS NOT NULL ORDER BY g.id LIMIT 1)
    WHERE vendor_invoice_no IS NULL AND vendor_invoice_date IS NULL`).run().changes;

  const rows = db.prepare(`SELECT g.id, g.po_id, g.stock_movement_id, g.vendor_invoice_no, g.vendor_invoice_date, po.po_no
    FROM grn_reconciliations g JOIN purchase_orders po ON po.id = g.po_id WHERE g.grn_batch_id IS NULL ORDER BY g.id`).all();
  const groups = new Map();
  rows.forEach((r, i) => {
    const inv = (r.vendor_invoice_no || '').trim();
    const key = inv ? `${r.po_no}::${inv}::${r.vendor_invoice_date || ''}` : `blank::${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const insB = db.prepare('INSERT INTO grn_batches (po_id, invoice_attachment_path, is_placeholder, vendor_invoice_no, vendor_invoice_date) VALUES (?,?,1,?,?)');
  const updG = db.prepare('UPDATE grn_reconciliations SET grn_batch_id = ? WHERE id = ?');
  const updM = db.prepare('UPDATE stock_movements SET grn_batch_id = ? WHERE id = ?');
  for (const grp of groups.values()) {
    const f = grp[0];
    const bid = insB.run(f.po_id, PLACEHOLDER, (f.vendor_invoice_no || '').trim() || null, f.vendor_invoice_date || null).lastInsertRowid;
    for (const r of grp) { updG.run(bid, r.id); if (r.stock_movement_id) updM.run(bid, r.stock_movement_id); }
  }

  const atts = db.prepare(`SELECT a.*, g.grn_batch_id FROM attachments a JOIN grn_reconciliations g ON g.id = a.entity_id
    WHERE a.entity_type = 'grn_reconciliation' AND g.grn_batch_id IS NOT NULL`).all();
  const hasB = db.prepare(`SELECT 1 FROM attachments WHERE entity_type = 'grn_batches' AND entity_id = ? AND file_path = ?`);
  const insA = db.prepare(`INSERT INTO attachments (entity_type, entity_id, file_path, original_name, uploaded_by, document_type) VALUES ('grn_batches', ?, ?, ?, ?, ?)`);
  const delA = db.prepare('DELETE FROM attachments WHERE id = ?');
  for (const t of atts) {
    if (!hasB.get(t.grn_batch_id, t.file_path)) insA.run(t.grn_batch_id, t.file_path, t.original_name, t.uploaded_by, t.document_type);
    delA.run(t.id);
  }
  console.log(`headers filled: ${a}; new batches: ${groups.size} covering ${rows.length} lines; attachments moved: ${atts.length}`);
  if (apply) { db.exec('COMMIT'); console.log('Applied.'); } else { db.exec('ROLLBACK'); console.log('Dry run - rolled back. Re-run with --apply.'); }
} catch (e) { db.exec('ROLLBACK'); console.error('Rolled back:', e.message); process.exit(1); }

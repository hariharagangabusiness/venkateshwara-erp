#!/usr/bin/env node
// One-off cleanup for the duplicate-PO-approval bug fixed in PR #255
// (resubmitPoGroup() only superseding the one approval_id it was handed,
// instead of every live approval for the po_no group).
//
// Finds every po_no that currently has MORE THAN ONE 'Pending'/
// 'InfoRequested' approval alive at once (the exact symptom reported for
// PO-1793773966158 - the same PO showing up 3 times in My Approvals), and
// supersedes every one of them except the single most-recently-created
// (highest id) live approval, which is left as the one genuine live entry.
//
// Dry-run by default (prints what it WOULD change, writes nothing).
// Pass --apply to actually write.
//
// Usage: node fix-duplicate-po-approvals.js <path-to-erp.db> [--apply]

const path = require('path');
const DatabaseSync = require('node:sqlite').DatabaseSync;

const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dbPath) {
  console.error('Usage: node fix-duplicate-po-approvals.js <path-to-erp.db> [--apply]');
  process.exit(1);
}

const db = new DatabaseSync(path.resolve(dbPath));

const liveApprovals = db.prepare(`
  SELECT a.id as approval_id, a.entity_id, a.status, a.created_at, po.po_no
  FROM approvals a
  JOIN purchase_orders po ON po.id = a.entity_id
  WHERE a.entity_type = 'purchase_order' AND a.status IN ('Pending', 'InfoRequested')
  ORDER BY po.po_no, a.id
`).all();

const byPoNo = new Map();
for (const row of liveApprovals) {
  if (!byPoNo.has(row.po_no)) byPoNo.set(row.po_no, []);
  byPoNo.get(row.po_no).push(row);
}

const duplicateGroups = [...byPoNo.entries()].filter(([, rows]) => rows.length > 1);

if (!duplicateGroups.length) {
  console.log('No po_no group currently has more than one live (Pending/InfoRequested) approval. Nothing to do.');
  process.exit(0);
}

console.log(`Found ${duplicateGroups.length} po_no group(s) with duplicate live approvals:\n`);

const supersede = db.prepare(`UPDATE approvals SET status = 'Superseded' WHERE id = ?`);

for (const [poNo, rows] of duplicateGroups) {
  // Keep the highest-id (most recently created) live approval; supersede the rest.
  const keep = rows.reduce((a, b) => (b.approval_id > a.approval_id ? b : a));
  const toSupersede = rows.filter(r => r.approval_id !== keep.approval_id);
  console.log(`${poNo}: ${rows.length} live approvals - keeping #${keep.approval_id} (entity_id=${keep.entity_id}, ${keep.status}, created ${keep.created_at}), superseding: ${toSupersede.map(r => `#${r.approval_id} (entity_id=${r.entity_id}, ${r.status}, created ${r.created_at})`).join(', ')}`);
  if (apply) {
    for (const r of toSupersede) supersede.run(r.approval_id);
  }
}

console.log(apply ? '\nApplied.' : '\nDry run only - no changes written. Re-run with --apply to write these changes.');

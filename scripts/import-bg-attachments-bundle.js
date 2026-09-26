#!/usr/bin/env node
// One-time import for the export bundle produced by
// GET /api/bg/export-attachments (routes/bankGuarantees.js) - a small
// tar.gz of just the Bank Guarantee attachment rows + their physical files.
// Built to avoid needing a full DB+uploads backup (which can need more free
// disk than a host actually has) just to recover a handful of BG scans from
// an old environment (e.g. Railway).
//
// Usage:
//   tar xzf bg-attachments-export.tar.gz -C /some/dir
//   node scripts/import-bg-attachments-bundle.js --bundle /some/dir/bg-attachments-<ts> [--apply]
//
// The bundle's manifest.json holds { manifest: [{bg_no, original_name,
// uploaded_at, stored_filename}], skipped: [...] } - stored_filename names
// the file under the bundle's files/ subfolder. Entries are matched to this
// DB's Bank Guarantees by bg_no (unique on both ends).
//
// Dry run by default; --apply copies files and inserts rows. Idempotent -
// safe to re-run, skips attachments already present locally.

const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { getUploadsSubdir } = require('../lib/paths');

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle') args.bundle = argv[++i];
    else if (argv[i] === '--apply') args.apply = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle) {
    console.error('Usage: node scripts/import-bg-attachments-bundle.js --bundle <extracted-bundle-dir> [--apply]');
    process.exit(1);
  }
  const manifestPath = path.join(args.bundle, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest.json not found in ${args.bundle} - pass the directory the export's tar.gz extracted into.`);
    process.exit(1);
  }
  const { manifest, skipped: exportSkipped } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (exportSkipped && exportSkipped.length) {
    console.warn(`Note: the export itself skipped ${exportSkipped.length} attachment(s) it couldn't read on the source server:`);
    exportSkipped.forEach(s => console.warn(`  BG ${s.bg_no}: ${s.original_name} - ${s.error}`));
  }

  console.log(`Bundle: ${manifest.length} BG attachment(s) across ${new Set(manifest.map(m => m.bg_no)).size} distinct BG(s).`);
  if (!args.apply) console.log('(dry run - pass --apply to actually copy files and write DB rows)\n');

  const destUploadDir = getUploadsSubdir('attachments');
  const findLocalBg = db.prepare('SELECT id FROM bank_guarantees WHERE bg_no = ?');
  const findExisting = db.prepare(`
    SELECT id FROM attachments WHERE entity_type = 'bank_guarantee' AND entity_id = ? AND original_name = ?
  `);
  const insertAttachment = db.prepare(`
    INSERT INTO attachments (entity_type, entity_id, file_path, original_name, uploaded_at)
    VALUES ('bank_guarantee', ?, ?, ?, ?)
  `);

  let migrated = 0, skippedDup = 0, skippedNoFile = 0;
  const noBgList = [];

  for (const row of manifest) {
    const localBg = findLocalBg.get(row.bg_no);
    if (!localBg) { noBgList.push(row.bg_no); continue; }

    const already = findExisting.get(localBg.id, row.original_name);
    if (already) { skippedDup++; continue; }

    const srcFilePath = path.join(args.bundle, 'files', row.stored_filename);
    if (!fs.existsSync(srcFilePath)) {
      skippedNoFile++;
      console.warn(`  MISSING FILE in bundle: ${srcFilePath} (BG ${row.bg_no})`);
      continue;
    }

    let destFilename = row.stored_filename;
    let destFilePath = path.join(destUploadDir, destFilename);
    if (fs.existsSync(destFilePath)) {
      // Filenames already carry a Date.now() prefix so a collision here means
      // a different file landed under the same name - keep both.
      destFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${destFilename}`;
      destFilePath = path.join(destUploadDir, destFilename);
    }
    const destRelPath = '/uploads/attachments/' + destFilename;

    console.log(`${args.apply ? 'COPY' : '[dry-run] would copy'}: BG ${row.bg_no} <- ${row.original_name} (${destFilename})`);
    if (args.apply) {
      fs.copyFileSync(srcFilePath, destFilePath);
      insertAttachment.run(localBg.id, destRelPath, row.original_name, row.uploaded_at || new Date().toISOString());
    }
    migrated++;
  }

  console.log('\n--- Summary ---');
  console.log(`${args.apply ? 'Migrated' : 'Would migrate'}: ${migrated}`);
  console.log(`Skipped (already present locally): ${skippedDup}`);
  console.log(`Skipped (file missing in bundle): ${skippedNoFile}`);
  console.log(`Skipped (no matching BG by bg_no in this DB): ${noBgList.length}${noBgList.length ? ' -> ' + [...new Set(noBgList)].join(', ') : ''}`);
  if (!args.apply) console.log('\nThis was a DRY RUN. Re-run with --apply to actually copy files and insert DB rows.');
}

main();

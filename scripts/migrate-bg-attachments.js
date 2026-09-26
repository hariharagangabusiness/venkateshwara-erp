#!/usr/bin/env node
// One-time migration: copy across ONLY the Bank Guarantee attachments (BG
// scanned-copy uploads) from the old Railway erp.db + uploads folder into
// this app's current DB and UPLOADS_DIR.
//
// Attachments aren't a bespoke BG table - every entity in this app shares one
// `attachments` table (entity_type/entity_id) and one flat uploads folder,
// so "BG attachments" here means: rows where entity_type = 'bank_guarantee'.
// Row ids differ between the Railway DB and this one (BGs were already
// migrated once before), so rows are matched across the two databases by
// bg_no, which is UNIQUE in both.
//
// uploaded_by is not carried over: user ids aren't guaranteed to line up
// between the two environments, and a wrong id would violate the
// attachments.uploaded_by foreign key - safer to leave it NULL than guess.
//
// Usage:
//   node scripts/migrate-bg-attachments.js --source-db <path-to-railway-erp.db> --source-uploads <path-to-railway-uploads-dir> [--apply]
//
// Without --apply this is a dry run: it prints exactly what it would copy
// and insert without touching this app's DB or files. Re-run with --apply
// once the dry-run output looks right.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { db } = require('../db');
const { getUploadsSubdir } = require('../lib/paths');

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source-db') args.sourceDb = argv[++i];
    else if (argv[i] === '--source-uploads') args.sourceUploads = argv[++i];
    else if (argv[i] === '--apply') args.apply = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sourceDb || !args.sourceUploads) {
    console.error('Usage: node scripts/migrate-bg-attachments.js --source-db <path-to-railway-erp.db> --source-uploads <path-to-railway-uploads-dir> [--apply]');
    process.exit(1);
  }
  if (!fs.existsSync(args.sourceDb)) {
    console.error(`Source DB not found: ${args.sourceDb}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.sourceUploads)) {
    console.error(`Source uploads dir not found: ${args.sourceUploads}`);
    process.exit(1);
  }

  const srcDb = new DatabaseSync(args.sourceDb, { readOnly: true });
  const srcAttachments = srcDb.prepare(`
    SELECT a.*, bg.bg_no AS src_bg_no
    FROM attachments a
    JOIN bank_guarantees bg ON bg.id = a.entity_id
    WHERE a.entity_type = 'bank_guarantee'
  `).all();
  srcDb.close();

  console.log(`Source: ${srcAttachments.length} BG attachment row(s) found across ${new Set(srcAttachments.map(a => a.src_bg_no)).size} distinct BG(s).`);
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

  for (const row of srcAttachments) {
    const localBg = findLocalBg.get(row.src_bg_no);
    if (!localBg) { noBgList.push(row.src_bg_no); continue; }

    const already = findExisting.get(localBg.id, row.original_name);
    if (already) { skippedDup++; continue; }

    const relFromUploads = String(row.file_path || '').replace(/^\/?uploads\//, '');
    const srcFilePath = path.join(args.sourceUploads, relFromUploads);
    if (!fs.existsSync(srcFilePath)) {
      skippedNoFile++;
      console.warn(`  MISSING FILE on source disk: ${srcFilePath} (BG ${row.src_bg_no})`);
      continue;
    }

    let destFilename = path.basename(srcFilePath);
    let destFilePath = path.join(destUploadDir, destFilename);
    if (fs.existsSync(destFilePath)) {
      // Filenames already carry a Date.now() prefix so a collision here means
      // a different file landed under the same name - keep both.
      destFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${destFilename}`;
      destFilePath = path.join(destUploadDir, destFilename);
    }
    const destRelPath = '/uploads/attachments/' + destFilename;

    console.log(`${args.apply ? 'COPY' : '[dry-run] would copy'}: BG ${row.src_bg_no} <- ${row.original_name} (${destFilename})`);
    if (args.apply) {
      fs.copyFileSync(srcFilePath, destFilePath);
      insertAttachment.run(localBg.id, destRelPath, row.original_name, row.uploaded_at || new Date().toISOString());
    }
    migrated++;
  }

  console.log('\n--- Summary ---');
  console.log(`${args.apply ? 'Migrated' : 'Would migrate'}: ${migrated}`);
  console.log(`Skipped (already present locally): ${skippedDup}`);
  console.log(`Skipped (file missing on source disk): ${skippedNoFile}`);
  console.log(`Skipped (no matching BG by bg_no in this DB): ${noBgList.length}${noBgList.length ? ' -> ' + [...new Set(noBgList)].join(', ') : ''}`);
  if (!args.apply) console.log('\nThis was a DRY RUN. Re-run with --apply to actually copy files and insert DB rows.');
}

main();

#!/usr/bin/env node
// Read-only diagnostic for "RFQ vendor picker only shows 2 vendors" reports.
// Reproduces routes/purchase.js's vendors-for-item logic exactly (same
// normalizeCategory()/exact/partial/fallback tiers) for every item on a
// given Purchase Request, then also reproduces the frontend's own
// po_email/email filter (renderPRQuotesPanel() in public/js/app.js) - so
// this prints, per item, which vendors matched at which tier and which of
// those were then silently dropped from the picker for having no email on
// file. Never writes anything.
//
// Usage: node scripts/diagnose-rfq-vendor-match.js <path-to-erp.db> <pr_no>
'use strict';
const path = require('path');
const dbPath = process.argv[2];
const prNo = process.argv[3];
if (!dbPath || !prNo) {
  console.error('Usage: node scripts/diagnose-rfq-vendor-match.js <path-to-erp.db> <pr_no>');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

function normalizeCategory(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/s$/, '');
}

function vendorsForItem(item) {
  let vendors = [];
  if (item.category) {
    const itemNorm = normalizeCategory(item.category);
    const allVendors = db.prepare(`SELECT * FROM vendors WHERE status = 'Active' OR status IS NULL ORDER BY name`).all();
    if (itemNorm) {
      // Exact and partial are merged, not mutually exclusive - matches
      // routes/purchase.js's fixed /vendors-for-item/:itemId exactly.
      const byId = new Map();
      for (const v of allVendors) {
        const vNorm = normalizeCategory(v.category);
        if (!vNorm) continue;
        if (vNorm === itemNorm) byId.set(v.id, Object.assign({}, v, { match_type: 'exact' }));
        else if (vNorm.includes(itemNorm) || itemNorm.includes(vNorm)) byId.set(v.id, Object.assign({}, v, { match_type: 'partial' }));
      }
      vendors = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  if (vendors.length === 0) {
    vendors = db.prepare(`
      SELECT * FROM vendors
      WHERE (status = 'Active' OR status IS NULL) AND category IS NOT NULL AND TRIM(category) != ''
      ORDER BY name
    `).all().map(v => Object.assign({}, v, { match_type: 'fallback' }));
  }
  return { vendors };
}

const pr = db.prepare(`SELECT * FROM purchase_requests WHERE pr_no = ?`).get(prNo);
if (!pr) {
  console.error(`No purchase_requests row with pr_no = ${prNo}`);
  process.exit(1);
}
console.log(`PR ${prNo} (id ${pr.id}, status ${pr.status})`);

// Line items: prefer the child table, fall back to the legacy single-item shape.
let lines = db.prepare(`SELECT * FROM purchase_request_items WHERE purchase_request_id = ?`).all(pr.id);
if (!lines.length) {
  lines = [{ item_id: pr.item_id, item_text: pr.item_description, quantity: pr.quantity }];
}

const allCategorizedVendors = db.prepare(`
  SELECT name, category, email, po_email, status FROM vendors
  WHERE (status = 'Active' OR status IS NULL) AND category IS NOT NULL AND TRIM(category) != ''
  ORDER BY name
`).all();
console.log(`\n--- Every Active vendor with a category on file (${allCategorizedVendors.length}) ---`);
for (const v of allCategorizedVendors) {
  const hasEmail = !!(v.po_email || v.email);
  console.log(`  ${v.name} | category="${v.category}" | email=${v.po_email || v.email || '(none)'}${hasEmail ? '' : '  <-- NO EMAIL, filtered from RFQ picker'}`);
}

const mergedVendorMap = new Map();
for (const line of lines) {
  if (!line.item_id) {
    console.log(`\n--- Line "${line.item_text || '(no text)'}" has no item_id - vendors-for-item is never called for it ---`);
    continue;
  }
  const item = db.prepare(`SELECT * FROM items WHERE id = ?`).get(line.item_id);
  if (!item) {
    console.log(`\n--- Line item_id=${line.item_id} not found in items table ---`);
    continue;
  }
  const { vendors } = vendorsForItem(item);
  console.log(`\n--- Item "${item.name}" (item_code=${item.item_code || '-'}, category="${item.category || '(blank)'}") -> ${vendors.length} vendor(s) ---`);
  for (const v of vendors) {
    const hasEmail = !!(v.po_email || v.email);
    console.log(`  ${v.name} | match_type=${v.match_type} | vendor category="${v.category}" | email=${v.po_email || v.email || '(none)'}${hasEmail ? '' : '  <-- NO EMAIL, filtered from RFQ picker'}`);
    if (hasEmail) mergedVendorMap.set(v.id, v);
  }
}

console.log(`\n=== Final RFQ picker contents (merged across all lines, email-filtered) - ${mergedVendorMap.size} vendor(s) ===`);
for (const v of mergedVendorMap.values()) {
  console.log(`  ${v.name} (category="${v.category}")`);
}

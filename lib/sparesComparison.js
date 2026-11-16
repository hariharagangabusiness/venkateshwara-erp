// Finance's "what did we quote vs. what did they actually order" review for
// spares RFQs (2026-11-01) - per-customer lookup plus a QoQ/YoY rollup across
// every customer. Built entirely off data that already exists (Spares-format
// Offer lines = quoted; the offer's own linked Sales Order = ordered, once
// confirmed) - no new workflow, just a read-side comparison.
//
// "Ordered" is read from the Offer's OWN line (unit_price/qty), not a fresh
// join to a possibly-since-edited sales_order_items row - sales_order_items
// is a point-in-time copy made at confirm time (see routes/offers.js's
// offer-confirm transaction), matched back here by sort_order (both are
// built in the same loop order at that moment). If Sales later edits the
// order's own line items, this comparison still reflects what was actually
// quoted-and-accepted at confirmation, which is the real "did our quote
// land" answer Finance is after - a deliberate simplification over trying to
// track every subsequent SO-side edit.
//
// Two sources of a "quoted" price, both pulled in (2026-11-16): a priced
// Scope of Supply line (offer_items) - the only source this file originally
// read - and an Annexure row (offer_annexures), a pasted/uploaded price list
// printed as the Offer PDF's last page. An Annexure row never flows into a
// Sales Order (only offer_items does, at confirm time), so an Annexure-only
// row's "ordered" side always reads null unless the same spare also shows
// up as a confirmed Scope of Supply line - the two then merge into one
// comparison entry via the matching below. Every row downstream carries its
// own `source` ('scope' | 'annexure') so a report reader always knows where
// a figure came from.
//
// Matching the SAME real-world spare across different offers/customers/time
// (needed for every view in this file) has three tiers, per the owner's
// locked answers (2026-11-01, extended 2026-11-16): a Scope of Supply line
// picked from the Spares Library (spares_library_id set) is matched by that
// stable id - the most reliable tier. An Annexure row (which has no library
// link at all) is matched by its own Item Code when one was typed/pasted -
// also treated as reliable, since an item code is a real, reused identifier
// unlike free-typed wording. Anything left - an older/freshly-typed Scope of
// Supply line with no library id, or an Annexure row with no item code -
// falls back to a normalized description match, flagged `approximate: true`
// so a report reader knows it's a text match, not a verified identity.
const { db } = require('../db');

function normalizeDesc(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchKeyAndLabel(row) {
  if (row.spares_library_id) {
    return { key: 'lib:' + row.spares_library_id, label: row.lib_title || row.description, approximate: false };
  }
  if (row.item_code && normalizeDesc(row.item_code)) {
    return { key: 'code:' + normalizeDesc(row.item_code), label: row.description || row.item_code, approximate: false };
  }
  return { key: 'txt:' + normalizeDesc(row.description), label: row.description, approximate: true };
}

// One row per Spares-format offer's priced Scope of Supply line, across
// every offer version on file (not just the latest - a superseded version
// was still a real quote at the time), joined to its client and, when the
// offer went on to become a Sales Order, that same line's own ordered
// qty/rate.
function fetchScopeRows() {
  return db.prepare(`
    SELECT
      'scope' as source,
      oi.id as offer_item_id, oi.offer_id, oi.description, oi.qty, oi.unit_price, oi.item_code,
      oi.spares_library_id,
      sl.title as lib_title,
      o.client_id, o.created_at as quote_date,
      c.name as client_name,
      o.sales_order_id,
      soi.rate as ordered_rate, soi.quantity as ordered_qty, so.order_date
    FROM offer_items oi
    JOIN offers o ON o.id = oi.offer_id
    JOIN clients c ON c.id = o.client_id
    LEFT JOIN spares_library sl ON sl.id = oi.spares_library_id
    LEFT JOIN sales_orders so ON so.id = o.sales_order_id
    LEFT JOIN sales_order_items soi ON soi.sales_order_id = o.sales_order_id AND soi.sort_order = oi.sort_order
    WHERE o.offer_format = 'Spares' AND o.is_template = 0
  `).all();
}

// One row per Spares-format offer's Annexure line - a pasted/uploaded price
// list with no Spares Library link and no path into a Sales Order (see the
// file header above), so ordered_rate/ordered_qty/order_date are always
// null here; a row only ever gains an "ordered" figure by merging with a
// matching Scope of Supply row in the grouping logic below.
function fetchAnnexureRows() {
  return db.prepare(`
    SELECT
      'annexure' as source,
      an.id as offer_item_id, an.offer_id, an.description, an.qty, an.rate as unit_price, an.item_code,
      NULL as spares_library_id, NULL as lib_title,
      o.client_id, o.created_at as quote_date,
      c.name as client_name,
      o.sales_order_id,
      NULL as ordered_rate, NULL as ordered_qty, NULL as order_date
    FROM offer_annexures an
    JOIN offers o ON o.id = an.offer_id
    JOIN clients c ON c.id = o.client_id
    WHERE o.offer_format = 'Spares' AND o.is_template = 0
  `).all();
}

function fetchSparesRows() {
  return fetchScopeRows().concat(fetchAnnexureRows())
    .sort((a, b) => new Date(a.quote_date) - new Date(b.quote_date));
}

// Per-customer lookup: one row per distinct spare this client has ever been
// quoted, with the latest quote and latest actual order (if any).
function perCustomer(clientId) {
  const rows = fetchSparesRows().filter(r => Number(r.client_id) === Number(clientId));
  const groups = new Map();
  for (const r of rows) {
    const { key, label, approximate } = matchKeyAndLabel(r);
    if (!groups.has(key)) groups.set(key, { key, label, approximate, rows: [] });
    groups.get(key).rows.push(r);
  }
  return Array.from(groups.values()).map(g => {
    const sorted = g.rows.slice().sort((a, b) => new Date(a.quote_date) - new Date(b.quote_date));
    const last = sorted[sorted.length - 1];
    const ordered = sorted.filter(r => r.ordered_rate != null);
    const lastOrdered = ordered[ordered.length - 1];
    return {
      spare: g.label,
      approximate: g.approximate,
      source: last.source,
      last_quoted_rate: last.unit_price,
      last_quoted_qty: last.qty,
      last_quoted_date: last.quote_date,
      last_ordered_rate: lastOrdered ? lastOrdered.ordered_rate : null,
      last_ordered_qty: lastOrdered ? lastOrdered.ordered_qty : null,
      last_ordered_date: lastOrdered ? lastOrdered.order_date : null,
      quote_count: sorted.length,
      order_count: ordered.length,
    };
  }).sort((a, b) => new Date(b.last_quoted_date) - new Date(a.last_quoted_date));
}

function periodKey(dateStr, period) {
  const d = new Date(dateStr);
  if (period === 'year') return String(d.getFullYear());
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} ${d.getFullYear()}`;
}

// QoQ/YoY rollup across every customer: for each spare, in each period, the
// average quoted rate vs. the average ordered rate (and how many of each) -
// the core price-trend view the owner locked, not win-rate or volume.
function trend(period) {
  const rows = fetchSparesRows();
  const buckets = new Map();
  for (const r of rows) {
    const { key, label, approximate } = matchKeyAndLabel(r);
    const p = periodKey(r.quote_date, period);
    const bucketKey = p + '|' + key;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { period: p, spare: label, approximate, quotedSum: 0, quotedCount: 0, orderedSum: 0, orderedCount: 0 });
    }
    const b = buckets.get(bucketKey);
    b.quotedSum += Number(r.unit_price) || 0;
    b.quotedCount++;
    if (r.ordered_rate != null) {
      b.orderedSum += Number(r.ordered_rate) || 0;
      b.orderedCount++;
    }
  }
  return Array.from(buckets.values()).map(b => ({
    period: b.period,
    spare: b.spare,
    approximate: b.approximate,
    avg_quoted_rate: b.quotedCount ? b.quotedSum / b.quotedCount : null,
    avg_ordered_rate: b.orderedCount ? b.orderedSum / b.orderedCount : null,
    quote_count: b.quotedCount,
    order_count: b.orderedCount,
  })).sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
}

// Search by spare part (new, 2026-11-02; extended 2026-11-16 to also match
// an Annexure row's own Item Code): the mirror image of perCustomer() -
// instead of "for this customer, every spare", this is "for this spare
// (matched by name/code/description), every customer" - one row per
// customer that's ever quoted/ordered a matching spare, same
// last-quoted/last-ordered columns. Matches against a Spares Library title,
// an Item Code (Annexure rows), and the line's own free-typed description,
// case-insensitively, substring - so a search also surfaces older/free-typed
// lines never picked from a library and never carrying a code.
function searchBySpare(query) {
  const q = normalizeDesc(query);
  if (!q) return [];
  const rows = fetchSparesRows().filter(r => {
    const title = normalizeDesc(r.lib_title);
    const desc = normalizeDesc(r.description);
    const code = normalizeDesc(r.item_code);
    return title.includes(q) || desc.includes(q) || code.includes(q);
  });
  const groups = new Map();
  for (const r of rows) {
    const ckey = String(r.client_id);
    if (!groups.has(ckey)) groups.set(ckey, { client_id: r.client_id, client_name: r.client_name, rows: [] });
    groups.get(ckey).rows.push(r);
  }
  return Array.from(groups.values()).map(g => {
    const sorted = g.rows.slice().sort((a, b) => new Date(a.quote_date) - new Date(b.quote_date));
    const last = sorted[sorted.length - 1];
    const { label, approximate } = matchKeyAndLabel(last);
    const ordered = sorted.filter(r => r.ordered_rate != null);
    const lastOrdered = ordered[ordered.length - 1];
    return {
      client_id: g.client_id,
      client_name: g.client_name,
      spare: label,
      approximate,
      source: last.source,
      last_quoted_rate: last.unit_price,
      last_quoted_qty: last.qty,
      last_quoted_date: last.quote_date,
      last_ordered_rate: lastOrdered ? lastOrdered.ordered_rate : null,
      last_ordered_qty: lastOrdered ? lastOrdered.ordered_qty : null,
      last_ordered_date: lastOrdered ? lastOrdered.order_date : null,
      quote_count: sorted.length,
      order_count: ordered.length,
    };
  }).sort((a, b) => new Date(b.last_quoted_date) - new Date(a.last_quoted_date));
}

module.exports = { perCustomer, trend, searchBySpare, fetchSparesRows };

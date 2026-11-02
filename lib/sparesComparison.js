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
// Matching the SAME real-world spare across different offers/customers/time
// (needed for both the per-customer and the QoQ/YoY views) has two tiers,
// per the owner's locked 2026-11-01 answer: a line picked from the Spares
// Library (spares_library_id set) is matched by that stable id; an older or
// freshly-typed line with no library id falls back to a normalized
// description match - flagged `approximate: true` so a report reader knows
// it's a text match, not a verified identity.
const { db } = require('../db');

function normalizeDesc(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchKeyAndLabel(row) {
  if (row.spares_library_id) {
    return { key: 'lib:' + row.spares_library_id, label: row.lib_title || row.description, approximate: false };
  }
  return { key: 'txt:' + normalizeDesc(row.description), label: row.description, approximate: true };
}

// One row per Spares-format offer line, across every offer version on file
// (not just the latest - a superseded version was still a real quote at the
// time), joined to its client and, when the offer went on to become a Sales
// Order, that same line's own ordered qty/rate.
function fetchSparesRows() {
  return db.prepare(`
    SELECT
      oi.id as offer_item_id, oi.offer_id, oi.description, oi.qty, oi.unit_price, oi.sort_order, oi.spares_library_id,
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
    ORDER BY o.created_at
  `).all();
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

// Search by spare part (new, 2026-11-02): the mirror image of perCustomer()
// - instead of "for this customer, every spare", this is "for this spare
// (matched by name/description), every customer" - one row per customer
// that's ever quoted/ordered a matching spare, same last-quoted/last-ordered
// columns. Matches against both a Spares Library title (when the line was
// picked from the library) and the line's own free-typed description, case-
// insensitively, substring - so a search also surfaces older/free-typed
// lines that were never picked from the library, consistent with this
// file's own two-tier matching used everywhere else.
function searchBySpare(query) {
  const q = normalizeDesc(query);
  if (!q) return [];
  const rows = fetchSparesRows().filter(r => {
    const title = normalizeDesc(r.lib_title);
    const desc = normalizeDesc(r.description);
    return title.includes(q) || desc.includes(q);
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

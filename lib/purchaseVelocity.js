// Purchase Velocity + Open PO / Open PR queries, shared by the dashboard routes (routes/purchase.js) and the
// Daily Purchase Digest email (lib/purchaseDailyDigest.js) so the two can never drift apart. Moved here verbatim from
// routes/purchase.js; the only additions are velocityMetrics() (the /velocity handler's own loop) and the extra
// fields on openPoRows() (unit, rate, approval date, pending qty/value) that the digest's Excel needs.
const { db } = require('../db');
const { localDateStr } = require('./dateUtil');
const { poReceivedQty } = require('./purchaseOrders');

// ---- Purchase Velocity Dashboard ----
// One row per po_no (a multi-line PO is several rows sharing it). Clocks:
// PR->PO = PR created to first PO row; PO->Approval = latest approval's
// submit to its final Approved action (Draft time excluded); PO->GRN = that
// approval to first IN receipt, plus to full receipt (all live lines Received).
const VELOCITY_SQL = `
  WITH g AS (
    SELECT po.po_no, MIN(po.created_at) po_created, MIN(po.purchase_request_id) pr_id, MIN(po.vendor_id) vendor_id,
      COUNT(*) total_lines, SUM(po.status = 'Received') received_lines,
      SUM(po.status IN ('Open','PartiallyReceived','PendingApproval')) open_lines
    FROM purchase_orders po
    WHERE po.po_no IS NOT NULL AND po.status NOT IN ('Draft','Cancelled','Rejected')
    GROUP BY po.po_no),
  la AS (
    SELECT po.po_no, MAX(a.id) approval_id FROM approvals a
    JOIN purchase_orders po ON a.entity_type = 'purchase_order' AND a.entity_id = po.id
    GROUP BY po.po_no),
  ap AS (
    SELECT la.po_no, a.created_at submitted_at, a.status ap_status,
      (SELECT MAX(x.acted_at) FROM approval_actions x WHERE x.approval_id = a.id AND x.action = 'Approved' AND a.status = 'Approved') approved_at
    FROM la JOIN approvals a ON a.id = la.approval_id),
  gr AS (
    SELECT po.po_no, MIN(sm.moved_at) first_grn, MAX(sm.moved_at) last_grn FROM purchase_orders po
    JOIN stock_movements sm ON sm.reference = 'PO#' || po.id AND sm.movement_type = 'IN'
    GROUP BY po.po_no),
  r AS (
    SELECT g.po_no, v.name vendor_name, pr.pr_no, pr.created_at pr_created, g.po_created, g.open_lines,
      ap.submitted_at, ap.ap_status, ap.approved_at, gr.first_grn,
      CASE WHEN g.received_lines = g.total_lines THEN gr.last_grn END full_grn
    FROM g LEFT JOIN vendors v ON v.id = g.vendor_id
      LEFT JOIN purchase_requests pr ON pr.id = g.pr_id
      LEFT JOIN ap ON ap.po_no = g.po_no LEFT JOIN gr ON gr.po_no = g.po_no
    WHERE date(g.po_created) BETWEEN date(?) AND date(?))
  SELECT r.*,
    julianday(po_created) - julianday(pr_created) d_pr_po,
    julianday(approved_at) - julianday(submitted_at) d_approval,
    julianday(first_grn) - julianday(approved_at) d_grn,
    julianday(full_grn) - julianday(approved_at) d_full,
    julianday('now', 'localtime') - julianday(submitted_at) w_approval,
    julianday('now', 'localtime') - julianday(approved_at) w_grn
  FROM r`;

// "In flight" = started but the end event hasn't happened yet.
const VELOCITY_INFLIGHT = {
  po_approval: (r) => r.submitted_at && !r.approved_at && ['Pending', 'InfoRequested'].includes(r.ap_status),
  po_grn: (r) => r.approved_at && !r.first_grn && r.open_lines > 0,
};
const VELOCITY_KEYS = { pr_po: 'd_pr_po', po_approval: 'd_approval', po_grn: 'd_grn' };
const VELOCITY_WAIT = { po_approval: 'w_approval', po_grn: 'w_grn' };
// Approved PRs with no live PO yet (the PR->PO in-flight set). "Live" = not Cancelled, the same rule the PR page's own
// unpo_line_count uses (lib/prLines.js): a PR whose only PO was Cancelled is back to waiting for one.
const PR_WAITING_SQL = `
  SELECT pr.pr_no, pr.created_at, julianday('now', 'localtime') - julianday(pr.created_at) wait_days FROM purchase_requests pr
  WHERE pr.status = 'Approved' AND date(pr.created_at) BETWEEN date(?) AND date(?)
    AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.purchase_request_id = pr.id AND po.status != 'Cancelled')
  ORDER BY wait_days DESC`;

function velocityStats(vals) {
  const v = vals.filter((x) => x != null);
  return { count: v.length, avg: v.length ? v.reduce((s, x) => s + x, 0) / v.length : null, max: v.length ? Math.max(...v) : null };
}

// Same numbers GET /velocity returns: avg/max/count per metric, in-flight counts, and PO->GRN full-receipt stats.
function velocityMetrics(from, to) {
  const rows = db.prepare(VELOCITY_SQL).all(from, to);
  const metrics = {};
  for (const m of Object.keys(VELOCITY_KEYS)) {
    metrics[m] = velocityStats(rows.map((r) => r[VELOCITY_KEYS[m]]));
    metrics[m].in_flight = m === 'pr_po'
      ? db.prepare(PR_WAITING_SQL).all(from, to).length
      : rows.filter(VELOCITY_INFLIGHT[m]).length;
  }
  metrics.po_grn.full = velocityStats(rows.map((r) => r.d_full));
  return metrics;
}

// ---- Open PO / Open PR report (Purchase Velocity, Round "Open PO & PR") ----
// "Open" = anything still not fully received for PO, still pre-approval for
// PR - locked with the repo owner before building (see CLAUDE.md). One row
// per purchase_orders line (a multi-item PO is several rows sharing one
// po_no, same convention this whole file already follows) / one row per PR
// item (flattens the legacy single-item PR shape and the newer
// purchase_request_items child-table shape into one result set, same
// flattening GET /requests already does via item_summary).
const OPEN_PO_STATUSES = ['Draft', 'PendingApproval', 'Open', 'PartiallyReceived'];
// 'Approved' included deliberately (2026-11-13) - a PR only flips to
// 'OrderPlaced' once a PO is actually raised against it, so 'Approved' means
// exactly "cleared approval, but no PO created yet" - still open work from a
// procurement standpoint, not yet closed out just because it's signed off.
// InfoRequested = approval paused until the requester answers: still pre-approval, so still open.
const OPEN_PR_STATUSES = ['Draft', 'PendingQuotes', 'Pending', 'InfoRequested', 'Approved'];

function openPoRows() {
  const rows = db.prepare(`
    SELECT po.id, po.po_no, po.created_at as po_date, po.status, po.quantity, po.delivery_date, po.unit, po.rate, po.discount_percent,
      (SELECT MAX(x.acted_at) FROM approval_actions x JOIN approvals a ON a.id = x.approval_id
        WHERE a.entity_type = 'purchase_order' AND a.entity_id = po.id AND a.status = 'Approved' AND x.action = 'Approved') as approval_date,
      i.item_code, i.name as item_name,
      v.name as vendor_name, v.address as vendor_address, v.phone as vendor_phone, v.email as vendor_email
    FROM purchase_orders po
    LEFT JOIN items i ON i.id = po.item_id
    LEFT JOIN vendors v ON v.id = po.vendor_id
    WHERE po.status IN (${OPEN_PO_STATUSES.map(() => '?').join(',')})
    ORDER BY po.po_no, po.id
  `).all(...OPEN_PO_STATUSES);
  const lineNoByPoNo = {};
  const today = localDateStr();
  return rows.map((r) => {
    lineNoByPoNo[r.po_no] = (lineNoByPoNo[r.po_no] || 0) + 1;
    const received_qty = poReceivedQty(r.id);
    const outstanding = received_qty < r.quantity;
    let delay_days = 0;
    if (outstanding && r.delivery_date) {
      const delivery = String(r.delivery_date).slice(0, 10);
      const d = Math.round((new Date(today) - new Date(delivery)) / 86400000);
      delay_days = Math.max(0, d);
    }
    // Pending = what is still to arrive (never negative); value is net of the line's discount, ex-GST.
    const pending_qty = Math.max(0, (r.quantity || 0) - received_qty);
    const pending_value = pending_qty * (r.rate || 0) * (1 - (Number(r.discount_percent) || 0) / 100);
    return {
      po_no: r.po_no, po_date: r.po_date, status: r.status, line_no: lineNoByPoNo[r.po_no],
      unit: r.unit, rate: r.rate, approval_date: r.approval_date, pending_qty, pending_value,
      item_code: r.item_code, item_description: r.item_name, item_qty: r.quantity, received_qty,
      vendor_name: r.vendor_name, vendor_address: r.vendor_address, vendor_phone: r.vendor_phone, vendor_email: r.vendor_email,
      delivery_date: r.delivery_date, delay_days,
    };
  });
}

function openPrRows() {
  const placeholders = OPEN_PR_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT pr.pr_no, pr.status, COALESCE(i.item_code, pri.item_text) as item_code,
      COALESCE(i.name, pri.item_text) as item_description, COALESCE(pri.unit, i.unit) as unit, pri.details,
      pri.quantity, pri.estimated_value,
      pr.created_at, u.full_name as created_by, d.name as department, p.project_code as project
    FROM purchase_request_items pri
    JOIN purchase_requests pr ON pr.id = pri.purchase_request_id
    LEFT JOIN items i ON i.id = pri.item_id
    LEFT JOIN users u ON u.id = pr.raised_by
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN projects p ON p.id = pr.project_id
    WHERE pr.status IN (${placeholders}) AND pri.cancelled_at IS NULL

    UNION ALL

    SELECT pr.pr_no, pr.status, i.item_code,
      COALESCE(i.name, 'Item') as item_description, i.unit as unit, NULL as details,
      pr.quantity, pr.estimated_value,
      pr.created_at, u.full_name as created_by, d.name as department, p.project_code as project
    FROM purchase_requests pr
    LEFT JOIN items i ON i.id = pr.item_id
    LEFT JOIN users u ON u.id = pr.raised_by
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN projects p ON p.id = pr.project_id
    WHERE pr.status IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM purchase_request_items pri2 WHERE pri2.purchase_request_id = pr.id)
    ORDER BY pr_no
  `).all(...OPEN_PR_STATUSES, ...OPEN_PR_STATUSES);
  const today = localDateStr();
  return rows.map((r) => {
    const created = String(r.created_at || '').slice(0, 10);
    const days_pending = created ? Math.max(0, Math.round((new Date(today) - new Date(created)) / 86400000)) : null;
    return { ...r, days_pending };
  });
}

module.exports = {
  VELOCITY_SQL, VELOCITY_INFLIGHT, VELOCITY_KEYS, VELOCITY_WAIT, PR_WAITING_SQL, velocityStats, velocityMetrics,
  OPEN_PO_STATUSES, OPEN_PR_STATUSES, openPoRows, openPrRows,
};

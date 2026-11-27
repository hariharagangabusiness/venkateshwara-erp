const { db } = require('../db');
const { advanceProjectStatus, releaseDependents, recallBlocker } = require('./pipeline');

// How much of a sales_order_items line has already been claimed by a
// not-yet-rejected/cancelled dispatch - a PendingApproval dispatch reserves
// its quantity the same as an already-Dispatched one, so two separate
// dispatches can't both claim the same units while one is still awaiting
// sign-off. Mirrors Purchase Invoice's poLineBillableQty() discipline
// against PO lines (routes/finance.js), just for Sales Orders dispatching
// out instead of Purchase Orders receiving in.
function soLineDispatchedQty(soItemId) {
  return db.prepare(`
    SELECT COALESCE(SUM(fdi.quantity), 0) as n FROM fg_dispatch_items fdi
    JOIN fg_dispatches fd ON fd.id = fdi.dispatch_id
    WHERE fdi.sales_order_item_id = ? AND fd.status NOT IN ('Rejected', 'Cancelled')
  `).get(soItemId).n;
}
function soLineDispatchableQty(soItem) {
  return Math.max(0, Number(soItem.quantity || 0) - soLineDispatchedQty(soItem.id));
}

// How much of a specific dispatched line has already been claimed by a
// not-yet-rejected/cancelled MRN - same reservation logic as above, one
// level down (a dispatch line instead of an order line).
function dispatchItemRejectedQty(fgDispatchItemId) {
  return db.prepare(`
    SELECT COALESCE(SUM(mi.quantity_rejected), 0) as n FROM sale_rejection_mrn_items mi
    JOIN sale_rejection_mrns m ON m.id = mi.mrn_id
    WHERE mi.fg_dispatch_item_id = ? AND m.status NOT IN ('Rejected', 'Cancelled')
  `).get(fgDispatchItemId).n;
}
function dispatchItemRejectableQty(fgDispatchItem) {
  return Math.max(0, Number(fgDispatchItem.quantity || 0) - dispatchItemRejectedQty(fgDispatchItem.id));
}

// What has genuinely left the gate: ONLY an approved dispatch (status
// 'Dispatched') counts. soLineDispatchedQty() above is the reservation count
// and also includes PendingApproval/InfoRequested, so it can't answer this.
// Sale Rejection MRNs deliberately don't reopen a line - their resolution is a
// credit note or an FOC replacement, never a second dispatch on the same order.
function soDispatchProgress(orderId) {
  const lines = db.prepare(`
    SELECT soi.description, soi.unit, soi.quantity, soi.rate,
      COALESCE((SELECT SUM(fdi.quantity) FROM fg_dispatch_items fdi JOIN fg_dispatches fd ON fd.id = fdi.dispatch_id
        WHERE fdi.sales_order_item_id = soi.id AND fd.status = 'Dispatched'), 0) AS dispatched
    FROM sales_order_items soi WHERE soi.sales_order_id = ? ORDER BY soi.sort_order, soi.id
  `).all(orderId);
  const out = { lineCount: lines.length, anyDispatched: false, orderedQty: 0, orderedValue: 0, pending: [], pendingValue: 0 };
  for (const l of lines) {
    const qty = Number(l.quantity || 0), rate = Number(l.rate || 0);
    const done = Math.min(qty, Number(l.dispatched || 0));
    const left = Math.round((qty - done) * 1000) / 1000;
    out.orderedQty += qty;
    out.orderedValue += qty * rate;
    if (done > 0) out.anyDispatched = true;
    if (left > 0.0001) {
      out.pending.push({ description: l.description, unit: l.unit, quantity: qty, pendingQty: left });
      out.pendingValue += left * rate;
    }
  }
  return out;
}

// Keeps sales_orders.status in step with approved dispatches: every line fully
// covered -> 'Dispatched', some -> 'PartiallyDispatched'. Only touches an order
// that is still in the fulfilment cycle - Completed / Cancelled / Invoiced are
// further along (or set by another workflow) and are never overwritten.
const SO_FULFILMENT_STATUSES = ['Confirmed', 'InProduction', 'PartiallyDispatched', 'Dispatched'];
// opts.allowRevert (only the Admin dispatch delete passes it): with NO approved dispatch left, a Dispatched / PartiallyDispatched
// order goes back to Confirmed. Every other caller keeps the old rule (nothing approved = leave the status alone, so a legacy
// or hand-set status is never rewritten). opts.silent skips the history row when the caller writes its own.
function syncSalesOrderDispatchStatus(orderId, actorId, opts = {}) {
  const so = db.prepare('SELECT status FROM sales_orders WHERE id = ?').get(orderId);
  if (!so || !SO_FULFILMENT_STATUSES.includes(so.status)) return null;
  const p = soDispatchProgress(orderId);
  if (!p.anyDispatched && !(opts.allowRevert && ['PartiallyDispatched', 'Dispatched'].includes(so.status))) return null;
  const next = !p.anyDispatched ? 'Confirmed' : (p.pending.length ? 'PartiallyDispatched' : 'Dispatched');
  if (next === so.status) return next;
  db.prepare('UPDATE sales_orders SET status = ? WHERE id = ?').run(next, orderId);
  if (opts.silent) return next;
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)')
      .run(actorId || null, 'order_status_synced', 'sales_order', Number(orderId),
        `Status ${so.status} -> ${next} (${p.pending.length ? p.pending.length + ' line(s) still to dispatch' : 'all lines covered by approved FG dispatches'}).`);
  } catch (e) { /* history entry is best-effort, never blocks the transition */ }
  return next;
}

// The single "an FG dispatch has been approved" transition, shared by the
// approval hook (routes/approvals.js) and the no-chain auto-approve path in
// POST /dispatches (lib/approvals.js startApproval never calls the hook).
// Flips the dispatch to 'Dispatched', syncs the order's status, and
// auto-completes the project's Packing/Shipping job card stages (if not
// already) - closes the loop between production and dispatch tracking without
// a second, parallel "mark as shipped" step. Deliberately raw UPDATEs rather
// than the interactive PATCH /job-cards/:id route - that route's HOD/assignee
// permission checks are for a human acting on their own department's card, not
// a system-triggered completion once Sales/Accounts/Management have approved
// the goods actually leaving.
function markFgDispatchApproved(dispatchId, actorId) {
  const dispatch = db.prepare('SELECT * FROM fg_dispatches WHERE id = ?').get(dispatchId);
  if (!dispatch) return;
  db.prepare(`UPDATE fg_dispatches SET status = 'Dispatched' WHERE id = ?`).run(dispatchId);
  if (dispatch.project_id) {
    ['Packing', 'Shipping'].forEach(stage => {
      const jc = db.prepare(`SELECT * FROM job_cards WHERE project_id = ? AND stage = ? AND parent_job_card_id IS NULL`).get(dispatch.project_id, stage);
      if (jc && jc.status !== 'Completed' && jc.status !== 'NotApplicable') {
        db.prepare(`UPDATE job_cards SET status = 'Completed', completed_at = (datetime('now','localtime')) WHERE id = ?`).run(jc.id);
        // Marker: lets an Admin dispatch delete tell a card THIS approval completed from one a department completed itself.
        db.prepare('INSERT INTO job_card_comments (job_card_id, user_id, comment) VALUES (?,?,?)')
          .run(jc.id, actorId || dispatch.created_by || null, `Auto-completed: FG dispatch ${dispatch.dispatch_no} approved`);
        advanceProjectStatus(db, dispatch.project_id);
        releaseDependents(db, jc.id);
      }
    });
  }
  syncSalesOrderDispatchStatus(dispatch.sales_order_id, actorId);
}

// Admin dispatch delete: pull the Packing / Shipping cards the approval completed back out of Completed - but only when no
// OTHER approved dispatch still covers the order, only cards the approval itself completed (marker comment; older approvals fall
// back to "completed at or after this dispatch's approval"), and only when no later work has started (same guard as the Admin
// recall). Call AFTER the dispatch row is gone. A card never started goes back to Pending, a started one to InProgress.
// Returns { reopened: [stage], kept: [{ stage, reason }] } - a card that cannot be reopened is reported, never forced.
function reopenDispatchJobCards(dispatch, approvedAt, actorId) {
  const out = { reopened: [], kept: [] };
  if (!dispatch.project_id) return out;
  const others = db.prepare(`SELECT COUNT(*) as n FROM fg_dispatches WHERE sales_order_id = ? AND status = 'Dispatched'`).get(dispatch.sales_order_id).n;
  if (others) return out;
  const stages = ['Packing', 'Shipping'];
  const cards = stages.map(stage => db.prepare(`SELECT * FROM job_cards WHERE project_id = ? AND stage = ? AND parent_job_card_id IS NULL`).get(dispatch.project_id, stage))
    .filter(jc => jc && jc.status === 'Completed')
    .filter(jc => db.prepare(`SELECT 1 FROM job_card_comments WHERE job_card_id = ? AND comment LIKE 'Auto-completed: FG dispatch %'`).get(jc.id)
      || (approvedAt && jc.completed_at && jc.completed_at >= approvedAt));
  const blocked = {};
  for (const jc of cards) {
    const b = recallBlocker(db, jc, cards.map(c => c.stage));
    if (b) blocked[jc.stage] = b;
  }
  for (const jc of cards) {
    if (blocked[jc.stage]) { out.kept.push({ stage: jc.stage, reason: `${blocked[jc.stage].stage} has already started` }); continue; }
    db.prepare(`UPDATE job_cards SET status = ?, completed_at = NULL WHERE id = ?`).run(jc.started_at ? 'InProgress' : 'Pending', jc.id);
    db.prepare('INSERT INTO job_card_comments (job_card_id, user_id, comment) VALUES (?,?,?)')
      .run(jc.id, actorId || null, `Reopened: FG dispatch ${dispatch.dispatch_no} was deleted by Admin`);
    out.reopened.push(jc.stage);
  }
  if (out.reopened.length) advanceProjectStatus(db, dispatch.project_id);
  return out;
}

module.exports = {
  soLineDispatchedQty, soLineDispatchableQty, dispatchItemRejectedQty, dispatchItemRejectableQty,
  soDispatchProgress, syncSalesOrderDispatchStatus, markFgDispatchApproved, reopenDispatchJobCards,
};

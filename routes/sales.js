const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { authRequired, requirePermission, requireRole } = require('../middleware/auth');
const { generateAnnexureDocx } = require('../lib/annexureDocx');
const { createJobCardsForProject } = require('../lib/pipeline');
const { resolveUploadPath } = require('../lib/paths');
const { recomputePoTermsStatus } = require('../lib/poTerms');
const router = express.Router();
router.use(authRequired);

// Creates the execution-queue project + job cards for a sales order if one
// doesn't already exist (offers.js does this itself on confirm; this covers
// orders created directly from the Sales Orders page, and lets old orders
// be backfilled on demand).
function ensureProjectForOrder(salesOrder, userId) {
  let project = db.prepare('SELECT * FROM projects WHERE sales_order_id = ?').get(salesOrder.id);
  if (project) return project;
  const projCode = 'PRJ-' + Date.now();
  const projInfo = db.prepare(`
    INSERT INTO projects (project_code, sales_order_id, title, pm_id, start_date)
    VALUES (?,?,?,?, date('now'))
  `).run(projCode, salesOrder.id, salesOrder.description || salesOrder.order_no, userId);
  const projectId = projInfo.lastInsertRowid;
  createJobCardsForProject(db, projectId);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
}

// Generates (or regenerates) the annexure for a sales order and stores its
// path. Looks up a linked offer for technical content if one exists;
// otherwise produces the header-only annexure (see lib/annexureDocx.js).
async function ensureAnnexureForOrder(salesOrder) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(salesOrder.client_id);
  const offer = db.prepare('SELECT * FROM offers WHERE sales_order_id = ?').get(salesOrder.id);
  let items = [], techSpecs = [], boughtOut = [];
  if (offer) {
    items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY id').all(offer.id);
    techSpecs = db.prepare('SELECT * FROM offer_tech_specs WHERE offer_id = ? ORDER BY id').all(offer.id);
    boughtOut = db.prepare('SELECT * FROM offer_bought_out_items WHERE offer_id = ? ORDER BY id').all(offer.id);
  }
  const annex = await generateAnnexureDocx({ salesOrder, client, offer, items, techSpecs, boughtOut });
  db.prepare('UPDATE sales_orders SET annexure_path = ? WHERE id = ?').run(annex.relativePath, salesOrder.id);
  return annex;
}

const LEAD_SOURCES = ['Website', 'Referral', 'Cold Call', 'Exhibition', 'Existing Client', 'Advertisement', 'Other'];
const LEAD_STAGES = ['New', 'Quoted', 'Negotiation', 'Won', 'Lost'];
const LOST_REASONS = ['Price', 'Timeline', 'Competitor', 'No Budget', 'No Response', 'Requirement Changed', 'Other'];

router.get('/leads', (req, res) => {
  res.json(db.prepare(`
    SELECT l.*, c.name as client_name, u.full_name as owner_name,
      CAST(julianday('now') - julianday(COALESCE(l.stage_changed_at, l.created_at)) AS INTEGER) as days_in_stage
    FROM leads l
    LEFT JOIN clients c ON c.id = l.client_id LEFT JOIN users u ON u.id = l.owner_id
    ORDER BY l.id DESC
  `).all());
});
router.get('/leads/meta', (req, res) => {
  res.json({ sources: LEAD_SOURCES, stages: LEAD_STAGES, lostReasons: LOST_REASONS });
});
// "Today's Follow-ups" widget/page: activities due today or overdue, not yet
// completed, scoped to the logged-in user's leads (Admin / report.view_all sees all).
router.get('/leads/followups', (req, res) => {
  const seeAll = req.user.role_name === 'Admin' || hasPerm(req.user, 'report.view_all');
  const rows = db.prepare(`
    SELECT a.*, l.client_id, l.owner_id, c.name as client_name, u.full_name as owner_name
    FROM lead_activities a
    JOIN leads l ON l.id = a.lead_id
    LEFT JOIN clients c ON c.id = l.client_id
    LEFT JOIN users u ON u.id = l.owner_id
    WHERE a.completed_at IS NULL AND a.due_date IS NOT NULL AND a.due_date <= date('now')
      ${seeAll ? '' : 'AND l.owner_id = ?'}
    ORDER BY a.due_date
  `).all(...(seeAll ? [] : [req.user.id]));
  res.json(rows);
});
function hasPerm(user, code) {
  if (user.role_name === 'Admin') return true;
  const row = db.prepare(`
    SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ? AND p.code = ?
  `).get(user.role_id, code);
  return !!row;
}

router.get('/leads/:id', (req, res) => {
  const lead = db.prepare(`
    SELECT l.*, c.name as client_name, u.full_name as owner_name FROM leads l
    LEFT JOIN clients c ON c.id = l.client_id LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.id = ?
  `).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const activities = db.prepare(`
    SELECT a.*, u.full_name as created_by_name FROM lead_activities a
    LEFT JOIN users u ON u.id = a.created_by WHERE a.lead_id = ? ORDER BY a.due_date IS NULL, a.due_date DESC, a.id DESC
  `).all(req.params.id);
  res.json({ lead, activities });
});

router.post('/leads', requirePermission('lead.manage'), (req, res) => {
  const { client_id, enquiry_details, product_interest, expected_value, lead_source } = req.body;
  const info = db.prepare(`
    INSERT INTO leads (client_id, enquiry_details, product_interest, owner_id, expected_value, lead_source, stage_changed_at)
    VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).run(client_id, enquiry_details, product_interest, req.user.id, expected_value || 0, lead_source || null);
  res.json({ id: info.lastInsertRowid });
});

// Stage change (used by both the list view's dropdown and the kanban board's
// drag-and-drop). Moving to Lost requires a reason - the frontend collects
// it via a small prompt before calling this, but we also enforce it here so
// the API itself can never silently set Lost without one.
router.patch('/leads/:id/stage', requirePermission('lead.manage'), (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const { stage, lost_reason, lost_reason_detail } = req.body;
  if (!LEAD_STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage.' });
  if (stage === 'Lost') {
    if (!lost_reason || !LOST_REASONS.includes(lost_reason)) {
      return res.status(400).json({ error: 'A lost reason is required when moving a lead to Lost.' });
    }
    if (lost_reason === 'Other' && !String(lost_reason_detail || '').trim()) {
      return res.status(400).json({ error: 'Please provide a detail for "Other".' });
    }
    db.prepare(`UPDATE leads SET stage=?, lost_reason=?, lost_reason_detail=?, stage_changed_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(stage, lost_reason, lost_reason_detail || null, lead.id);
  } else {
    db.prepare(`UPDATE leads SET stage=?, stage_changed_at=CURRENT_TIMESTAMP WHERE id=?`).run(stage, lead.id);
  }
  res.json({ ok: true });
});

// ===================== Lead activities / follow-ups =====================

router.get('/leads/:id/activities', (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, u.full_name as created_by_name FROM lead_activities a
    LEFT JOIN users u ON u.id = a.created_by WHERE a.lead_id = ? ORDER BY a.due_date IS NULL, a.due_date DESC, a.id DESC
  `).all(req.params.id));
});
router.post('/leads/:id/activities', requirePermission('lead.manage'), (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const { activity_type, notes, due_date, completed } = req.body;
  if (!activity_type) return res.status(400).json({ error: 'activity_type is required' });
  const info = db.prepare(`
    INSERT INTO lead_activities (lead_id, activity_type, notes, due_date, completed_at, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(lead.id, activity_type, notes || null, due_date || null, completed ? new Date().toISOString() : null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});
router.patch('/leads/activities/:activityId/complete', requirePermission('lead.manage'), (req, res) => {
  const a = db.prepare('SELECT * FROM lead_activities WHERE id = ?').get(req.params.activityId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE lead_activities SET completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

// ===================== Sales analytics & targets =====================

router.get('/analytics', requirePermission('lead.manage', 'sales_order.manage', 'report.view_all'), (req, res) => {
  const leads = db.prepare('SELECT * FROM leads').all();
  const stageOrder = ['New', 'Quoted', 'Negotiation', 'Won'];
  // Funnel: a lead counts at a funnel stage if it currently sits there, or
  // has progressed past it (Won counts at every earlier stage; Lost counts
  // only up to the stage it reached before being lost - approximated here
  // as "New" since we don't track intermediate stage history).
  const funnel = stageOrder.map((stage, i) => {
    const atOrPast = leads.filter(l => {
      if (l.stage === 'Won') return true;
      if (l.stage === 'Lost') return i === 0;
      return stageOrder.indexOf(l.stage) >= i;
    });
    return { stage, count: atOrPast.length, value: atOrPast.reduce((a, b) => a + Number(b.expected_value || 0), 0) };
  });
  const conversion = funnel.map((f, i) => {
    if (i === 0) return { ...f, conversion_pct: null };
    const prev = funnel[i - 1];
    return { ...f, conversion_pct: prev.count ? Math.round(1000 * f.count / prev.count) / 10 : null };
  });

  const won = leads.filter(l => l.stage === 'Won');
  const lost = leads.filter(l => l.stage === 'Lost');
  const closed = won.length + lost.length;
  const winRate = closed ? Math.round(1000 * won.length / closed) / 10 : null;

  const cycleDays = won
    .map(l => (new Date(l.stage_changed_at || l.created_at) - new Date(l.created_at)) / 86400000)
    .filter(d => d >= 0);
  const avgCycleDays = cycleDays.length ? Math.round(10 * cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length) / 10 : null;

  const lostReasons = {};
  lost.forEach(l => { const r = l.lost_reason || 'Unspecified'; lostReasons[r] = (lostReasons[r] || 0) + 1; });

  const repPerf = db.prepare(`
    SELECT u.id as owner_id, u.full_name as owner_name,
      COUNT(l.id) as leads_owned,
      SUM(CASE WHEN l.stage='Won' THEN 1 ELSE 0 END) as won_count,
      SUM(CASE WHEN l.stage='Won' THEN l.expected_value ELSE 0 END) as won_value
    FROM users u JOIN leads l ON l.owner_id = u.id
    GROUP BY u.id ORDER BY won_value DESC
  `).all();

  const targets = db.prepare(`
    SELECT t.*, u.full_name as owner_name FROM sales_targets t LEFT JOIN users u ON u.id = t.owner_id
    ORDER BY t.period DESC
  `).all();
  const targetVsAchievement = targets.map(t => {
    const achieved = db.prepare(`
      SELECT COALESCE(SUM(order_value),0) as v FROM sales_orders
      WHERE strftime('%Y-%m', order_date) = ? ${t.owner_id ? 'AND created_by = ?' : ''}
    `).get(...(t.owner_id ? [t.period, t.owner_id] : [t.period])).v;
    return { ...t, achieved_value: achieved, achievement_pct: t.target_value ? Math.round(1000 * achieved / t.target_value) / 10 : null };
  });

  res.json({ funnel: conversion, winRate, avgCycleDays, lostReasons, repPerf, targetVsAchievement });
});

router.get('/targets', requirePermission('lead.manage', 'sales_order.manage', 'report.view_all'), (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, u.full_name as owner_name FROM sales_targets t LEFT JOIN users u ON u.id = t.owner_id ORDER BY t.period DESC, t.id DESC
  `).all());
});
router.post('/targets', requirePermission('sales_order.manage', 'report.view_all'), (req, res) => {
  const { period, owner_id, target_value } = req.body;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
  const info = db.prepare(`INSERT INTO sales_targets (period, owner_id, target_value, created_by) VALUES (?,?,?,?)`)
    .run(period, owner_id || null, Number(target_value) || 0, req.user.id);
  res.json({ id: info.lastInsertRowid });
});
router.delete('/targets/:id', requirePermission('sales_order.manage', 'report.view_all'), (req, res) => {
  db.prepare('DELETE FROM sales_targets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/orders', (req, res) => {
  res.json(db.prepare(`
    SELECT so.*, c.name as client_name FROM sales_orders so JOIN clients c ON c.id = so.client_id ORDER BY so.id DESC
  `).all());
});
router.post('/orders', requirePermission('sales_order.manage'), async (req, res) => {
  const { lead_id, client_id, description, order_value } = req.body;
  const orderNo = 'SO-' + Date.now();
  const info = db.prepare(`
    INSERT INTO sales_orders (order_no, lead_id, client_id, description, order_value, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(orderNo, lead_id || null, client_id, description, order_value, req.user.id);
  if (lead_id) db.prepare(`UPDATE leads SET stage = 'Won' WHERE id = ?`).run(lead_id);

  const result = { id: info.lastInsertRowid, order_no: orderNo };
  const salesOrder = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(result.id);

  // Same as the offer-confirm flow: stand up the execution queue (project +
  // per-department job cards) and the internal annexure automatically, so
  // every order - whether it came from an offer or was entered directly -
  // ends up with both.
  try {
    const project = ensureProjectForOrder(salesOrder, req.user.id);
    result.projectId = project.id;
  } catch (e) {
    console.error('Project/job-card creation failed:', e);
  }
  try {
    const annex = await ensureAnnexureForOrder(salesOrder);
    result.annexureFile = annex.fileName;
  } catch (e) {
    console.error('Annexure generation failed:', e);
    result.annexureError = e.message;
  }

  res.json(result);
});

// Admin-only permanent delete, for cleaning up an order that was created by
// mistake before any real work happened on it. Every order gets a project +
// job cards (and usually an order-confirmation/annexure review pair)
// automatically the moment it's created - see ensureProjectForOrder above -
// so their mere existence isn't a sign of real progress; what actually
// blocks deletion is any of that scaffolding having moved past its
// untouched starting state, or any genuinely separate document (invoice,
// BG, milestone, FOC request) having been raised against this order.
router.delete('/orders/:id', requireRole('Admin'), (req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.status !== 'Confirmed') {
    return res.status(400).json({ error: `This order has moved to ${order.status} - only a Confirmed order with nothing built on it yet can be deleted.` });
  }
  const project = db.prepare('SELECT * FROM projects WHERE sales_order_id = ?').get(order.id);
  if (project) {
    // Excluding a stage (status = 'NotApplicable') is a planning decision,
    // not production activity - it must not itself count as "started" here,
    // or excluding even one stage would wrongly block deleting an order
    // nothing has actually been built against yet.
    const startedJobCard = db.prepare(`
      SELECT id FROM job_cards WHERE project_id = ? AND ((status != 'Pending' AND status != 'NotApplicable') OR started_at IS NOT NULL) LIMIT 1
    `).get(project.id);
    if (startedJobCard) {
      return res.status(400).json({ error: 'Production has already started on this order (at least one job card is in progress or further along) and it cannot be deleted.' });
    }
  }
  const blockers = [
    ['Tax Invoice', db.prepare('SELECT COUNT(*) as n FROM sales_invoices WHERE sales_order_id = ?').get(order.id).n],
    ['Proforma Invoice', db.prepare('SELECT COUNT(*) as n FROM proforma_invoices WHERE sales_order_id = ?').get(order.id).n],
    ['Bank Guarantee', db.prepare(`SELECT COUNT(*) as n FROM bank_guarantees WHERE order_type = 'SO' AND order_id = ?`).get(order.id).n],
    ['Payment Milestone', db.prepare(`SELECT COUNT(*) as n FROM payment_milestones WHERE order_type = 'SO' AND order_id = ?`).get(order.id).n],
    ['FOC Request', db.prepare('SELECT COUNT(*) as n FROM foc_requests WHERE sales_order_id = ?').get(order.id).n],
  ].filter(([, n]) => n > 0);
  const oc = db.prepare('SELECT status FROM order_confirmations WHERE sales_order_id = ?').get(order.id);
  if (oc && oc.status !== 'Draft') blockers.push(['Order Confirmation letter', 1]);
  const ar = db.prepare('SELECT status FROM annexure_reviews WHERE sales_order_id = ?').get(order.id);
  if (ar && ar.status !== 'Draft') blockers.push(['Annexure review', 1]);
  if (blockers.length) {
    return res.status(400).json({ error: `This order already has real activity against it (${blockers.map(([label]) => label).join(', ')}) and cannot be deleted.` });
  }

  const tx = db.transaction(() => {
    if (project) {
      db.prepare(`DELETE FROM job_card_attachments WHERE job_card_id IN (SELECT id FROM job_cards WHERE project_id = ?)`).run(project.id);
      db.prepare('DELETE FROM job_cards WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    }
    db.prepare('DELETE FROM order_confirmations WHERE sales_order_id = ?').run(order.id);
    db.prepare('DELETE FROM annexure_reviews WHERE sales_order_id = ?').run(order.id);
    // If this order came from a confirmed offer, undo that conversion so the
    // offer becomes a normal, editable Sent offer again rather than being
    // left locked and pointing at a sales order that no longer exists.
    const offer = db.prepare('SELECT id FROM offers WHERE sales_order_id = ?').get(order.id);
    if (offer) {
      db.prepare(`
        UPDATE offers SET status = 'Sent', sales_order_id = NULL, locked = 0, locked_at = NULL, locked_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(offer.id);
    }
    db.prepare('DELETE FROM sales_orders WHERE id = ?').run(order.id);
  });
  tx();
  res.json({ ok: true });
});

// Commercial terms (Round 16): promised delivery date + LD clause, plus
// (Round 28) Bank Guarantee terms - whether an Advance/Performance BG is
// required, its percentage/flat amount, and how many days of validity it
// needs from issue. Kept as a lightweight PATCH so it can be filled in any
// time after order creation, not just at entry.
router.patch('/orders/:id/commercial-terms', requirePermission('sales_order.manage'), (req, res) => {
  const order = db.prepare('SELECT id FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const {
    promised_delivery_date, ld_percentage, ld_cap_percentage, ld_trigger_notes,
    abg_required, abg_percentage, abg_amount, abg_validity_days,
    pbg_required, pbg_percentage, pbg_amount, pbg_validity_days, bg_terms_notes,
  } = req.body;
  db.prepare(`
    UPDATE sales_orders SET promised_delivery_date = ?, ld_percentage = ?, ld_cap_percentage = ?, ld_trigger_notes = ?,
      abg_required = ?, abg_percentage = ?, abg_amount = ?, abg_validity_days = ?,
      pbg_required = ?, pbg_percentage = ?, pbg_amount = ?, pbg_validity_days = ?, bg_terms_notes = ?
    WHERE id = ?
  `).run(promised_delivery_date || null, ld_percentage || null, ld_cap_percentage || null, ld_trigger_notes || null,
    abg_required ? 1 : 0, abg_percentage || null, abg_amount || null, abg_validity_days || null,
    pbg_required ? 1 : 0, pbg_percentage || null, pbg_amount || null, pbg_validity_days || null, bg_terms_notes || null,
    req.params.id);
  // Our own side of the terms just changed - re-check against whatever PO
  // is already on file rather than leaving a stale comparison in place.
  recomputePoTermsStatus(db, req.params.id);
  res.json({ ok: true });
});

// ===================== Customer PO capture + cross-check =====================
// Not every order comes with a formal customer PO - po_status lets that be
// stated explicitly (NotProvided) so the order runs on its own terms (which
// trace back to the confirmed offer) with no gate in effect, rather than
// leaving po_terms_status permanently unresolved. Received logs the PO's own
// stated terms and diffs them against the fields above - see lib/poTerms.js.
router.put('/orders/:id/po', requirePermission('sales_order.manage'), (req, res) => {
  const order = db.prepare('SELECT id FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { po_status } = req.body;
  if (!['NotProvided', 'Received'].includes(po_status)) {
    return res.status(400).json({ error: 'po_status must be NotProvided or Received.' });
  }
  if (po_status === 'NotProvided') {
    db.prepare(`
      UPDATE sales_orders SET po_status = 'NotProvided', po_number = NULL, po_date = NULL, po_delivery_date = NULL,
        po_ld_percentage = NULL, po_ld_cap_percentage = NULL,
        po_abg_required = 0, po_abg_percentage = NULL, po_abg_amount = NULL, po_abg_validity_days = NULL,
        po_pbg_required = 0, po_pbg_percentage = NULL, po_pbg_amount = NULL, po_pbg_validity_days = NULL
      WHERE id = ?
    `).run(order.id);
    const result = recomputePoTermsStatus(db, order.id);
    return res.json({ ok: true, ...result });
  }
  const {
    po_number, po_date, po_delivery_date, po_ld_percentage, po_ld_cap_percentage,
    po_abg_required, po_abg_percentage, po_abg_amount, po_abg_validity_days,
    po_pbg_required, po_pbg_percentage, po_pbg_amount, po_pbg_validity_days,
  } = req.body;
  if (!po_number) return res.status(400).json({ error: "Enter the customer's PO number." });
  db.prepare(`
    UPDATE sales_orders SET po_status = 'Received', po_number = ?, po_date = ?, po_delivery_date = ?,
      po_ld_percentage = ?, po_ld_cap_percentage = ?,
      po_abg_required = ?, po_abg_percentage = ?, po_abg_amount = ?, po_abg_validity_days = ?,
      po_pbg_required = ?, po_pbg_percentage = ?, po_pbg_amount = ?, po_pbg_validity_days = ?
    WHERE id = ?
  `).run(po_number, po_date || null, po_delivery_date || null, po_ld_percentage || null, po_ld_cap_percentage || null,
    po_abg_required ? 1 : 0, po_abg_percentage || null, po_abg_amount || null, po_abg_validity_days || null,
    po_pbg_required ? 1 : 0, po_pbg_percentage || null, po_pbg_amount || null, po_pbg_validity_days || null,
    order.id);
  const result = recomputePoTermsStatus(db, order.id);
  res.json({ ok: true, ...result });
});

// Accepts the customer's PO terms as our own - overwrites the SO's own
// commercial terms with whatever was logged from the PO, which by
// definition clears the mismatch (nothing left to differ). Distinct from
// acknowledge-mismatch below: this changes our records to match the
// customer's; that one keeps our records as-is and just accepts the gap.
router.post('/orders/:id/po/accept-po-terms', requirePermission('sales_order.manage'), (req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.po_status !== 'Received') return res.status(400).json({ error: 'No customer PO is on file for this order.' });
  db.prepare(`
    UPDATE sales_orders SET promised_delivery_date = po_delivery_date, ld_percentage = po_ld_percentage, ld_cap_percentage = po_ld_cap_percentage,
      abg_required = po_abg_required, abg_percentage = po_abg_percentage, abg_amount = po_abg_amount, abg_validity_days = po_abg_validity_days,
      pbg_required = po_pbg_required, pbg_percentage = po_pbg_percentage, pbg_amount = po_pbg_amount, pbg_validity_days = po_pbg_validity_days
    WHERE id = ?
  `).run(order.id);
  const result = recomputePoTermsStatus(db, order.id);
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)`)
    .run(req.user.id, 'po_terms_accepted', 'sales_order', order.id, `Accepted customer PO ${order.po_number}'s terms as the order's own terms.`);
  res.json({ ok: true, ...result });
});

// Accepts a mismatch as-is (e.g. the discrepancy was negotiated over a call
// and isn't going to be reflected in either record) - clears the block
// without changing either side's terms. A mandatory reason, audit-logged,
// same escape-hatch pattern as offer unlock.
router.post('/orders/:id/po/acknowledge-mismatch', requirePermission('sales_order.manage'), (req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.po_terms_status !== 'MismatchPending') return res.status(400).json({ error: 'No pending mismatch to acknowledge.' });
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'Enter a reason for acknowledging this mismatch.' });
  db.prepare(`
    UPDATE sales_orders SET po_terms_status = 'MismatchAcknowledged', po_terms_resolution_notes = ?, po_terms_resolved_by = ?, po_terms_resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, req.user.id, order.id);
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)`)
    .run(req.user.id, 'po_terms_mismatch_acknowledged', 'sales_order', order.id, reason);
  res.json({ ok: true });
});

router.get('/orders/:id/annexure', async (req, res) => {
  let order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });

  // The annexure is written to disk at generation time, not stored in the
  // DB itself - on a host without a persistent volume (e.g. Railway without
  // a mounted disk), that file does not survive a container restart or
  // redeploy even though sales_orders.annexure_path still points at it.
  // Rather than surface that as a dead end, regenerate on demand: the same
  // ensureAnnexureForOrder() used at order-creation time rebuilds it from
  // the order/offer data (which does live in the DB) and re-serves it.
  let abs = order.annexure_path ? resolveUploadPath(order.annexure_path) : null;
  if (!abs || !fs.existsSync(abs)) {
    try {
      const annex = await ensureAnnexureForOrder(order);
      order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
      abs = resolveUploadPath(order.annexure_path);
      if (!fs.existsSync(abs)) throw new Error('Annexure regeneration did not produce a file.');
    } catch (e) {
      console.error('Annexure auto-regeneration failed:', e);
      return res.status(500).json({ error: 'The annexure file was missing and could not be regenerated: ' + e.message });
    }
  }
  res.download(abs, path.basename(abs));
});

// Backfill / regenerate: for orders created before this feature existed, or
// any time the annexure needs to be rebuilt (e.g. offer content changed).
router.post('/orders/:id/regenerate-annexure', requirePermission('sales_order.manage'), async (req, res) => {
  const salesOrder = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!salesOrder) return res.status(404).json({ error: 'Not found' });
  const review = db.prepare('SELECT locked, status FROM annexure_reviews WHERE sales_order_id = ?').get(salesOrder.id);
  if (review && review.locked) {
    return res.status(400).json({ error: 'This annexure has already been approved and is locked. Reject it under Order Confirmation & Annexure review first if a genuine revision is needed.' });
  }
  if (review && review.status === 'PendingApproval') {
    return res.status(400).json({ error: 'This annexure is awaiting approval and cannot be regenerated - it must be approved or rejected first.' });
  }
  try {
    ensureProjectForOrder(salesOrder, req.user.id);
    const annex = await ensureAnnexureForOrder(salesOrder);
    res.json({ ok: true, annexureFile: annex.fileName });
  } catch (e) {
    console.error('Annexure regeneration failed:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

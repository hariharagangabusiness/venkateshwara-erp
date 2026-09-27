// Single source of truth for the default production pipeline (execution
// queue) stages. Two levels:
//
//  - PIPELINE_STAGES: the top-level departments a Project Manager plans on
//    the Targets sheet (Design -> Purchase/Electrical -> Store -> Laser &
//    Bending -> Manufacturing -> Assembling -> Packing -> Shipping ->
//    Installation). This is only the *starting* order - a PM can reorder a
//    given project's actual sequence from the Targets sheet.
//
//  - SUB_STAGES: departments that are themselves broken into sequential
//    sub-processes with their own internal handover (right now, only
//    Manufacturing: Fitting -> Tacking -> Welding -> Buffing/Sandblast ->
//    Painting). Each sub-stage becomes its own job card, nested under its
//    parent department's job card (job_cards.parent_job_card_id). The PM
//    only plans the parent's overall window on the Targets sheet; the
//    department's own HOD (the user whose role matches the parent stage)
//    then breaks that window down into sub-process targets from their Job
//    Cards workbench, once the PM has released the parent stage to them.
const PIPELINE_STAGES = [
  'Design',
  'Purchase',       // BOM / raw material & component procurement, after Design hands off BOM
  'Electrical',      // control panel & electrical systems design, after Design hands off details
  'Store',          // GRN / issue to production
  'LaserBending',
  'Manufacturing',   // has sub-stages - see SUB_STAGES below
  'Assembling',
  'Packing',
  'Shipping',
  'Installation',
];

const SUB_STAGES = {
  Manufacturing: ['Fitting', 'Tacking', 'Welding', 'BuffingSandblast', 'Painting'],
};

// Creates the full two-level job-card tree for a brand-new project: one
// top-level card per PIPELINE_STAGES entry (in default sequence order), plus
// - for any stage listed in SUB_STAGES - a set of child cards nested under
// it via parent_job_card_id (their own 1..n sequence, scoped to that
// parent). Shared by every place that stands up a project (offer confirm,
// direct sales-order creation, manual project creation) so the tree can't
// drift out of sync between them.
function createJobCardsForProject(db, projectId) {
  const insertTop = db.prepare(`INSERT INTO job_cards (project_id, stage, status, sequence) VALUES (?, ?, 'Pending', ?)`);
  const insertChild = db.prepare(`INSERT INTO job_cards (project_id, stage, status, sequence, parent_job_card_id) VALUES (?, ?, 'Pending', ?, ?)`);
  PIPELINE_STAGES.forEach((stage, i) => {
    const info = insertTop.run(projectId, stage, i + 1);
    const subStages = SUB_STAGES[stage];
    if (subStages) {
      subStages.forEach((sub, j) => insertChild.run(projectId, sub, j + 1, info.lastInsertRowid));
    }
  });
}

// A stage a project genuinely doesn't need (e.g. a bought-out/trading order
// never touches Design, Electrical, Manufacturing or any of its 5 sub-
// stages - only Purchase and Store apply) is marked with this status rather
// than deleted or just left unplanned. Deleting would lose the audit trail
// of what was deliberately excluded vs. never got around to; leaving it
// unplanned doesn't work because the handover gate and completion checks
// below only ever tested status != 'Completed' - an unplanned-but-Pending
// stage would silently block every later stage from starting and the
// project from ever completing.
const NOT_APPLICABLE = 'NotApplicable';

// Recomputes projects.status from whichever top-level stage is next in line
// - the first one that's neither Completed nor excluded - or 'Completed' if
// none remain. Shared by the job-card completion handler and by excluding a
// stage (excluding the project's current stage needs to advance it exactly
// the same way finishing that stage would).
function advanceProjectStatus(db, projectId) {
  const remaining = db.prepare(`
    SELECT stage FROM job_cards WHERE project_id = ? AND parent_job_card_id IS NULL AND status NOT IN ('Completed', ?)
    ORDER BY COALESCE(sequence, id) LIMIT 1
  `).get(projectId, NOT_APPLICABLE);
  if (remaining) {
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(remaining.stage, projectId);
  } else {
    db.prepare(`UPDATE projects SET status = 'Completed' WHERE id = ?`).run(projectId);
  }
}

// Releases any routed hand-off card(s) whose only remaining job_card_dependencies
// entry was this job card, now that it's Completed or excluded - same
// dependency-satisfied logic either way. Shared by the completion handler
// and by excludeJobCard.
function releaseDependents(db, jobCardId) {
  const dependents = db.prepare(`SELECT job_card_id FROM job_card_dependencies WHERE depends_on_id = ?`).all(jobCardId);
  const today = new Date().toISOString().slice(0, 10);
  dependents.forEach(({ job_card_id }) => {
    const stillOpen = db.prepare(`
      SELECT COUNT(*) as n FROM job_card_dependencies d JOIN job_cards jc2 ON jc2.id = d.depends_on_id
      WHERE d.job_card_id = ? AND jc2.status NOT IN ('Completed', ?)
    `).get(job_card_id, NOT_APPLICABLE).n;
    if (stillOpen === 0) {
      db.prepare(`UPDATE job_cards SET planned_start = COALESCE(planned_start, ?) WHERE id = ?`).run(today, job_card_id);
    }
  });
}

// Excludes one job card (a top-level stage, or an individual Manufacturing
// sub-stage) from a project's flow. Only allowed while it's still Pending -
// once a department has actually started or finished it, excluding it
// retroactively would misrepresent real work, so that's refused outright
// rather than silently allowed. Excluding a top-level stage that itself has
// sub-stages (Manufacturing) cascades to every one of its still-Pending
// children too, per the same reasoning: there's no scenario where the
// parent department is skipped but one of its own sub-processes still runs.
// Clears planned_start/planned_end so the existing "planned_start IS NOT
// NULL" gate on every department queue keeps it out of anyone's workbench
// without needing that filter duplicated everywhere.
function excludeJobCard(db, jobCardId, userId) {
  const jc = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(jobCardId);
  if (!jc) throw new Error('Job card not found.');
  if (jc.status === NOT_APPLICABLE) return; // already excluded - no-op
  if (jc.status !== 'Pending') {
    throw new Error(`Cannot exclude ${STAGE_LABELS[jc.stage] || jc.stage} - it is already ${jc.status}, not Pending.`);
  }
  const children = db.prepare('SELECT * FROM job_cards WHERE parent_job_card_id = ?').all(jc.id);
  const touchedChild = children.find(c => c.status !== 'Pending' && c.status !== NOT_APPLICABLE);
  if (touchedChild) {
    throw new Error(`Cannot exclude ${STAGE_LABELS[jc.stage] || jc.stage} - its ${STAGE_LABELS[touchedChild.stage] || touchedChild.stage} sub-process is already ${touchedChild.status}.`);
  }
  const tx = db.transaction(() => {
    const exclude = db.prepare(`
      UPDATE job_cards SET status = ?, planned_start = NULL, planned_end = NULL, excluded_at = CURRENT_TIMESTAMP, excluded_by = ? WHERE id = ?
    `);
    exclude.run(NOT_APPLICABLE, userId, jc.id);
    children.forEach(c => exclude.run(NOT_APPLICABLE, userId, c.id));
    if (jc.parent_job_card_id == null) {
      advanceProjectStatus(db, jc.project_id);
    }
    releaseDependents(db, jc.id);
  });
  tx();
}

// Reverses excludeJobCard for one job card - does NOT cascade back onto a
// parent's children (Manufacturing coming back doesn't mean every one of
// its sub-processes is needed again; each is re-included individually).
// Does not restore any prior schedule - it goes back to Pending, ready to
// be planned again from the Targets sheet (or the sub-plan screen).
function includeJobCard(db, jobCardId) {
  const jc = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(jobCardId);
  if (!jc) throw new Error('Job card not found.');
  if (jc.status !== NOT_APPLICABLE) return; // not excluded - no-op
  db.prepare(`UPDATE job_cards SET status = 'Pending', excluded_at = NULL, excluded_by = NULL WHERE id = ?`).run(jc.id);
  if (jc.parent_job_card_id == null) {
    advanceProjectStatus(db, jc.project_id);
  }
}

// The full set of job_cards.stage values a given role's queue should
// include. For a plain stage (e.g. 'Design') that's just itself. For
// Manufacturing - and for any of its sub-process roles (Fitting, Tacking,
// Welding, BuffingSandblast, Painting) - it's the parent stage PLUS every
// sub-stage, so the whole sub-process chain shows up together in one
// combined queue instead of each sub-role only ever seeing its own sliver.
function combinedStagesForRole(roleName) {
  if (roleName === 'Manufacturing' || (SUB_STAGES.Manufacturing || []).includes(roleName)) {
    return ['Manufacturing', ...SUB_STAGES.Manufacturing];
  }
  return [roleName];
}

// Server-side mirror of public/js/app.js's STAGE_LABELS - kept only for
// composing human-readable text server-side (e.g. the routed-from note
// seeded on a job card's comment trail in routes/projects.js). Keep the two
// in sync if a stage is renamed.
const STAGE_LABELS = {
  Design: 'Design', Purchase: 'Purchase (BOM / Procurement)', Electrical: 'Electrical (Control Panel & Systems)',
  Store: 'Store (GRN / Issue)', LaserBending: 'Laser & Bending Processing',
  Fitting: 'Manufacturing — Fitting', Tacking: 'Manufacturing — Tacking', Welding: 'Manufacturing — Welding',
  BuffingSandblast: 'Manufacturing — Buffing / Sandblast', Painting: 'Manufacturing — Painting',
  Manufacturing: 'Manufacturing', Assembling: 'Assembling',
  Packing: 'Packing', Shipping: 'Shipping', Installation: 'Installation',
};

module.exports = {
  PIPELINE_STAGES, SUB_STAGES, STAGE_LABELS, createJobCardsForProject, combinedStagesForRole,
  NOT_APPLICABLE, excludeJobCard, includeJobCard, advanceProjectStatus, releaseDependents,
};

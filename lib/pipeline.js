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

module.exports = { PIPELINE_STAGES, SUB_STAGES, createJobCardsForProject, combinedStagesForRole };

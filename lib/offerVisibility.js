const { db } = require('../db');
const { oversightDepartmentIds } = require('./roleOversight');
const { getOfferGovernanceSettings } = require('./settings');

// A "family" of an offer's versions all share one root: the version-1
// offer's own id. parent_offer_id always points directly at that root
// rather than the immediately-previous version (see
// lib/offerVersioning.js's own rootId computation - every fork reads
// `offer.parent_offer_id || offer.id` as the new row's parent), so
// resolving it is always a single hop, never a chain to walk.
function offerFamilyRootId(offer) {
  return offer.parent_offer_id || offer.id;
}

// The user who raised this offer "family" in the first place - a later
// revision's own created_by can be someone else entirely (e.g. a Sales HOD
// editing a subordinate's Sent offer forks a new version under their own
// id), but visibility is always decided by whoever originally raised it,
// not whoever happened to touch the latest version.
function offerRootCreatorId(offer) {
  const rootId = offerFamilyRootId(offer);
  if (rootId === offer.id) return offer.created_by;
  const root = db.prepare('SELECT created_by FROM offers WHERE id = ?').get(rootId);
  return root ? root.created_by : offer.created_by;
}

function offersIsGlobal(user) {
  return user.role_name === 'Admin' || user.role_name === 'Management';
}

// Own department plus any cross-department oversight grant (role_oversight)
// - the same "HOD who covers two departments in the real org" model
// routes/todos.js's own visibleTodosWhere() already uses.
function offersScopedDepartmentIds(user) {
  const ids = oversightDepartmentIds(db, user.id);
  if (user.department_id != null) ids.push(user.department_id);
  return ids;
}

// SQL fragment resolving an aliased `o` offers row's root-creator id, for
// embedding directly in a list query - COALESCEs the root version's own
// created_by (one correlated lookup) over this row's created_by when there
// is no parent (the row IS the root).
const ROOT_CREATOR_SQL = `COALESCE((SELECT root_o.created_by FROM offers root_o WHERE root_o.id = o.parent_offer_id), o.created_by)`;

// WHERE-clause (+ optional JOIN) builder for a list query that aliases the
// offers table as `o` - mirrors routes/todos.js's visibleTodosWhere(). Gated
// by the restrict_offers_to_creator governance flag; OFF (the default)
// returns an unconditional '1=1', preserving today's unrestricted behavior
// exactly. When ON: Admin/Management are never restricted; a department
// supervisor additionally sees every offer whose root creator shares their
// own department scope (home department + any oversight grant); everyone
// else sees only offers they themselves raised.
function offerVisibilityWhere(user) {
  const governance = getOfferGovernanceSettings();
  if (!governance.restrict_offers_to_creator || offersIsGlobal(user)) {
    return { join: '', where: '1=1', params: [] };
  }
  if (user.is_supervisor) {
    const deptIds = offersScopedDepartmentIds(user);
    return {
      join: `LEFT JOIN users ov_root_u ON ov_root_u.id = ${ROOT_CREATOR_SQL}`,
      where: `(${ROOT_CREATOR_SQL} = ? OR (ov_root_u.department_id IS NOT NULL AND ov_root_u.department_id IN (${deptIds.map(() => '?').join(',') || 'NULL'})))`,
      params: [user.id, ...deptIds],
    };
  }
  return { join: '', where: `${ROOT_CREATOR_SQL} = ?`, params: [user.id] };
}

// Single-offer visibility check (an already-fetched row, e.g. for a detail
// read) - same rule as offerVisibilityWhere() above, without needing SQL.
function canSeeOffer(user, offer) {
  const governance = getOfferGovernanceSettings();
  if (!governance.restrict_offers_to_creator || offersIsGlobal(user)) return true;
  const rootCreatorId = offerRootCreatorId(offer);
  if (rootCreatorId != null && rootCreatorId === user.id) return true;
  if (!user.is_supervisor || rootCreatorId == null) return false;
  const rootCreator = db.prepare('SELECT department_id FROM users WHERE id = ?').get(rootCreatorId);
  if (!rootCreator || rootCreator.department_id == null) return false;
  return offersScopedDepartmentIds(user).includes(rootCreator.department_id);
}

module.exports = { offerFamilyRootId, offerRootCreatorId, offersIsGlobal, offersScopedDepartmentIds, offerVisibilityWhere, canSeeOffer };

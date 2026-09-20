const { db } = require('../db');

// All descendant org_nodes ids of a node, INCLUDING itself - a plain
// recursive CTE, the standard SQLite way to walk a self-referential tree.
// Shared by routes/orgHierarchy.js (the rollup report) and
// routes/approvals.js (filtering the unified queue to one part of the org).
function descendantNodeIds(nodeId) {
  return db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM org_nodes WHERE id = ?
      UNION ALL
      SELECT o.id FROM org_nodes o JOIN sub ON o.parent_id = sub.id
    )
    SELECT id FROM sub
  `).all(nodeId).map(r => r.id);
}

// Every real department id that rolls up under a node (its own department_id,
// plus every descendant node's).
function departmentIdsUnderNode(nodeId) {
  const ids = descendantNodeIds(nodeId);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT DISTINCT department_id FROM org_nodes WHERE id IN (${placeholders}) AND department_id IS NOT NULL`)
    .all(...ids).map(r => r.department_id);
}

module.exports = { descendantNodeIds, departmentIdsUnderNode };

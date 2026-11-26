// Purchase Request line helpers shared by the PR routes, the Purchase Velocity report and the PR list.
// A PR line is "active" while cancelled_at IS NULL. A PO covers a line if it points at it
// (purchase_request_item_id) or, for older POs raised before lines existed, at the PR alone.
//  - LIVE: any PO that is not Cancelled (blocks cancelling the PR / line - an in-progress PO is never orphaned).
//  - ORDERED: a PO that has been submitted and is not Draft / Rejected / Cancelled (a line counts as ordered for the Archive).
const COVERS = `(po.purchase_request_item_id = pri.id OR (po.purchase_request_item_id IS NULL AND po.purchase_request_id = pri.purchase_request_id))`;
const LIVE_PO_COND = `po.status != 'Cancelled' AND ${COVERS}`;
const ORDERED_PO_COND = `po.status NOT IN ('Draft', 'Rejected', 'Cancelled') AND ${COVERS}`;
const existsPo = (cond) => `EXISTS (SELECT 1 FROM purchase_orders po WHERE ${cond})`;
module.exports = { LIVE_PO_COND, ORDERED_PO_COND, existsPo };

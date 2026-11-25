// One definition of a "live" Bank Guarantee (not yet Released). The BG page, its summary tiles, the Pending Reminders
// panel and the Overdue Items rollup all use this so their counts cannot drift. 'Extended' is not a status any route
// ever sets, so it is deliberately not listed.
const LIVE_BG_STATUSES = ['Active', 'PendingRelease'];
const LIVE_BG_SQL = "('Active','PendingRelease')";
module.exports = { LIVE_BG_STATUSES, LIVE_BG_SQL };

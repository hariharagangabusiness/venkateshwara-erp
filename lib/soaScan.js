// Generates a Statement of Accounts for every client due one, on a Monthly
// or Quarterly cadence (org-wide default, overridable per client - see
// routes/soa.js). Runs on the same timer as the BG/delivery scan
// (server.js) - idempotent per (client, period_end), so re-running it never
// creates a duplicate statement for a period already generated.
//
// This only ever creates a PendingReview row in soa_dispatch_log - it never
// emails anyone by itself. A human (Accounts) verifies and sends it via
// POST /soa/:id/verify then /soa/:id/send-email, the same two-step pattern
// bg_reminder_log already uses, so no statement reaches a customer's inbox
// unchecked.
const { db } = require('../db');
const { computeClientLedger } = require('./soaLedger');
const { localDateStr, localDateTimeStr } = require('./dateUtil');

// Local (IST) calendar fields throughout, not UTC - this is "the previous
// month/quarter as of right now in IST", so building the boundary dates via
// Date.UTC()/getUTC* and reading them back via toISOString() (both always
// UTC regardless of the process timezone) could pick the wrong month/
// quarter during the ~5.5-hour window where the UTC calendar day/month has
// already moved on but the IST one hasn't.
function previousMonthPeriod(now) {
  const y = now.getFullYear(), m = now.getMonth();
  const prevM = m - 1, prevY = prevM < 0 ? y - 1 : y, pm = (prevM + 12) % 12;
  return { start: localDateStr(new Date(prevY, pm, 1)), end: localDateStr(new Date(prevY, pm + 1, 0)) };
}
function previousQuarterPeriod(now) {
  const y = now.getFullYear(), q = Math.floor(now.getMonth() / 3);
  const prevQ = q - 1, prevY = prevQ < 0 ? y - 1 : y, pq = (prevQ + 4) % 4;
  const startMonth = pq * 3;
  return { start: localDateStr(new Date(prevY, startMonth, 1)), end: localDateStr(new Date(prevY, startMonth + 3, 0)) };
}

function effectiveSettingsForClient(clientId) {
  const override = db.prepare('SELECT * FROM soa_settings WHERE client_id = ?').get(clientId);
  if (override) return override;
  return db.prepare('SELECT * FROM soa_settings WHERE client_id IS NULL').get() || { frequency: 'Off', enabled: 0 };
}

function runSoaScan() {
  const now = new Date();
  let created = 0;
  db.prepare('SELECT id FROM clients').all().forEach(c => {
    const settings = effectiveSettingsForClient(c.id);
    if (!settings.enabled || settings.frequency === 'Off') return;

    const period = settings.frequency === 'Monthly' ? previousMonthPeriod(now) : previousQuarterPeriod(now);
    const existing = db.prepare(`SELECT id FROM soa_dispatch_log WHERE client_id = ? AND period_end = ?`).get(c.id, period.end);
    if (existing) return;

    const ledger = computeClientLedger(c.id, { from: period.start, to: period.end });
    // Nothing happened this period AND nothing was already owed - skip
    // rather than generate a statement with no content for a dormant account.
    if (!ledger.rows.length && !ledger.openingBalance) return;

    db.prepare(`INSERT INTO soa_dispatch_log (client_id, period_start, period_end, closing_balance) VALUES (?,?,?,?)`)
      .run(c.id, period.start, period.end, ledger.closingBalance);
    created++;
  });
  return { created, ranAt: localDateTimeStr() };
}

module.exports = { runSoaScan, previousMonthPeriod, previousQuarterPeriod };

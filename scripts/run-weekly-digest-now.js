// One-off FORCE RUN of the weekly, department-wise pending-approvals digest
// (lib/weeklyApprovalDigest.js) against the real production database and
// mailer - requested directly by the repo owner (2026-11-13) to see one of
// these go out for real, right now, rather than waiting for its own
// Admin-configured schedule.
//
// Unlike every other scripts/diagnose-*.js in this repo, this one is NOT
// read-only - it sends real emails to real department approvers and CCs the
// real Company Settings Email Settings CC list, exactly like the live
// scheduled run would. It calls runWeeklyApprovalDigest({ force: true }),
// which bypasses the enabled flag, the day/hour check, and the "already
// sent this week" guard - then updates weekly_digest.last_sent_at, same as
// a real scheduled firing would.
//
// Usage: node scripts/run-weekly-digest-now.js <path-to-erp.db>
const path = require('path');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node scripts/run-weekly-digest-now.js <path-to-erp.db>');
  process.exit(1);
}
process.env.DATA_DIR = path.dirname(dbPath);

const { getEmailSettings } = require('../lib/settings');
const { resolveConfig, isConfigured } = require('../lib/mailer');
const {
  runWeeklyApprovalDigest,
  allApprovingDepartments,
  recipientsForRole,
  pendingItemsForRole,
} = require('../lib/weeklyApprovalDigest');

async function main() {
  console.log('==> DATA_DIR:', process.env.DATA_DIR);

  const emailCfg = getEmailSettings();
  const cfg = resolveConfig({});
  console.log('==> Email Settings on file: host=%s user=%s from=%s ccList=%s',
    emailCfg.smtp_host || '(none)', emailCfg.smtp_user || '(none)', emailCfg.from_address || '(none)',
    JSON.stringify(emailCfg.cc_list || []));

  if (!isConfigured(cfg)) {
    console.log('==> SMTP IS NOT CONFIGURED. The digest will run but every department send will silently no-op (sendMail() returns {sent:false}).');
    console.log('==> Nothing will actually be emailed. Configure Company Settings > Email Settings first.');
  } else {
    console.log('==> SMTP is configured - this run WILL send real emails.');
  }

  console.log('\n==> Departments that could receive a digest, and who would get it:');
  const depts = allApprovingDepartments();
  for (const d of depts) {
    const recipients = recipientsForRole(d.role_id);
    const pending = pendingItemsForRole(d.role_id);
    console.log(`    - ${d.dept_name}: ${recipients.length} recipient(s) [${recipients.map(r => r.email).join(', ') || 'none'}], ${pending.length} pending item(s)`);
  }

  console.log('\n==> Forcing the real run now (runWeeklyApprovalDigest({ force: true }))...');
  const result = runWeeklyApprovalDigest({ force: true });
  console.log('==> runWeeklyApprovalDigest() returned:', JSON.stringify(result));

  // sendMail() calls inside the digest are fire-and-forget (.catch(()=>{}),
  // not awaited by the digest itself) - give them a few seconds to actually
  // reach the SMTP server before this process exits and the event loop is
  // torn down mid-send.
  console.log('==> Waiting 8s for outbound sends to flush...');
  await new Promise(r => setTimeout(r, 8000));
  console.log('==> Done.');
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});

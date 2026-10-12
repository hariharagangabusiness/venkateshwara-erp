// Looks up a department's own outgoing-email identity - both the plain
// "From" display override (email_from_name/email_from_address, the
// original 2026-10-0x feature) and, since 2026-10-12, a genuine separate
// authenticated SMTP account (smtp_host/port/user/pass/secure). All are
// optional per department and independent of each other; a department with
// no SMTP account still relays through the global Email Settings account
// (lib/mailer.js's own default) but can still show its own From name/
// address on that mail, exactly as before. A department WITH its own SMTP
// account defaults its From address to that account's own smtp_user when
// no explicit email_from_address is set, since sending mail "from" an
// address other than the one you just authenticated as is exactly the
// "550 5.7.1 Sender is not allowed to relay" mismatch this feature exists
// to avoid.
//
// Returns {} - meaning "no override at all" - when the department doesn't
// exist or has configured neither piece, so a call site can always just
// spread the result into sendMail() and get the global Email Settings
// identity by default.
const { db } = require('../db');

function getDepartmentEmailIdentity(departmentName) {
  const dept = db.prepare(`
    SELECT email_from_name, email_from_address, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure
    FROM departments WHERE name = ?
  `).get(departmentName);
  if (!dept) return {};

  const out = {};
  const hasOwnSmtp = !!(dept.smtp_host && dept.smtp_user);
  if (hasOwnSmtp) {
    out.smtp_host = dept.smtp_host;
    if (dept.smtp_port) out.smtp_port = dept.smtp_port;
    out.smtp_user = dept.smtp_user;
    if (dept.smtp_pass) out.smtp_pass = dept.smtp_pass;
    if (dept.smtp_secure !== null && dept.smtp_secure !== undefined) out.smtp_secure = !!dept.smtp_secure;
  }
  if (dept.email_from_address) {
    out.fromName = dept.email_from_name || undefined;
    out.fromAddress = dept.email_from_address;
  } else if (hasOwnSmtp) {
    out.fromName = dept.email_from_name || undefined;
    out.fromAddress = dept.smtp_user;
  }
  return out;
}

module.exports = { getDepartmentEmailIdentity };

// Looks up a department's own outgoing-email identity (the
// email_from_name/email_from_address columns added to `departments` - see
// db/index.js's MIGRATIONS). Both are optional per department; returns {} -
// meaning "no override" - whenever the department doesn't exist or hasn't
// set a From address, so a call site can always just spread the result into
// sendMail() and get the global Email Settings identity by default.
const { db } = require('../db');

function getDepartmentEmailIdentity(departmentName) {
  const dept = db.prepare('SELECT email_from_name, email_from_address FROM departments WHERE name = ?').get(departmentName);
  if (!dept || !dept.email_from_address) return {};
  return { fromName: dept.email_from_name || undefined, fromAddress: dept.email_from_address };
}

module.exports = { getDepartmentEmailIdentity };

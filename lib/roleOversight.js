// Cross-department oversight: lets Admin grant a specific user (e.g. a HOD
// who covers two departments in the real org, like Electrical & Service)
// full supervisor-level reach into another role's domain, WITHOUT merging
// the underlying departments/roles - Job Cards' pipeline stages, employee/
// payroll department attribution, and the permission model all assume one
// department/role per business function, and collapsing that would corrupt
// existing data and break the production pipeline. This is purely additive:
// the granted user keeps their own role/department, and simply also counts
// as a supervisor of the role(s) they've been granted oversight of.
//
// A grant of "oversees role X" is treated as fully supervisor-equivalent for
// X's domain, regardless of the grantee's own is_supervisor flag - the grant
// itself IS the authority being extended, same as an HOD's own is_supervisor.

function oversightRoleIds(db, userId) {
  return db.prepare('SELECT oversees_role_id FROM role_oversight WHERE user_id = ?').all(userId).map(r => r.oversees_role_id);
}

function oversightRoleNames(db, userId) {
  const roleIds = oversightRoleIds(db, userId);
  if (!roleIds.length) return [];
  const placeholders = roleIds.map(() => '?').join(',');
  return db.prepare(`SELECT name FROM roles WHERE id IN (${placeholders})`).all(...roleIds).map(r => r.name);
}

// Departments associated with the role(s) a user has been granted oversight
// of - resolved from the department(s) that role's own users actually belong
// to (there's no formal roles.department_id FK; role and department names
// don't always match, e.g. role 'Service' vs department 'Service & Spare
// Parts'), rather than assumed from naming.
function oversightDepartmentIds(db, userId) {
  const roleIds = oversightRoleIds(db, userId);
  if (!roleIds.length) return [];
  const placeholders = roleIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT department_id FROM users WHERE role_id IN (${placeholders}) AND department_id IS NOT NULL
  `).all(...roleIds).map(r => r.department_id);
}

// Whether `user` has supervisor-level reach into `departmentId` - either it's
// their own home department, or they've been granted oversight of a role
// whose users belong to it.
function inOversightDept(db, user, departmentId) {
  if (departmentId == null) return false;
  if (user.department_id === departmentId) return true;
  return oversightDepartmentIds(db, user.id).includes(departmentId);
}

module.exports = { oversightRoleIds, oversightRoleNames, oversightDepartmentIds, inOversightDept };

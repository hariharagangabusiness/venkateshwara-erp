#!/usr/bin/env node
// Read-only diagnostic for "why can't employee X see the Job Cards board for
// their own department" reports. Mirrors routes/projects.js's isSupervisorOf()
// and GET /job-cards/by-stage/:stage exactly, plus public/js/app.js's own
// boot()-time sidebar logic that decides whether a login gets its own
// DEPT_OWN_GROUP ("<department> Job Cards") nav entry at all. Never writes
// anything.
//
// Usage: node scripts/diagnose-jobcard-visibility.js <path-to-erp.db> <employee_code-or-name-substring>
'use strict';
const dbPath = process.argv[2];
const needle = process.argv[3];
if (!dbPath || !needle) {
  console.error('Usage: node scripts/diagnose-jobcard-visibility.js <path-to-erp.db> <employee_code-or-name-substring>');
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });

// Mirrors lib/pipeline.js's PIPELINE_STAGES/SUB_STAGES and combinedStagesForRole().
const PIPELINE_STAGES = ['Design', 'Purchase', 'Electrical', 'Store', 'LaserBending', 'Manufacturing', 'Assembling', 'Packing', 'Shipping', 'Installation'];
const SUB_STAGES = { Manufacturing: ['Fitting', 'Tacking', 'Welding', 'BuffingSandblast', 'Painting'] };
function combinedStagesForRole(roleName) {
  if (roleName === 'Manufacturing') return [roleName, ...SUB_STAGES.Manufacturing];
  return [roleName];
}

const users = db.prepare(`
  SELECT u.id, u.username, u.full_name, u.is_active, u.is_supervisor,
         u.role_id, r.name AS role_name,
         u.department_id, d.name AS department_name,
         u.employee_id, e.employee_code, e.full_name AS employee_full_name
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN employees e ON e.id = u.employee_id
  WHERE u.username LIKE ? OR u.full_name LIKE ? OR e.employee_code LIKE ? OR e.full_name LIKE ?
`).all(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`);

if (!users.length) {
  console.log(`No user/employee found matching "${needle}".`);
  process.exit(0);
}

for (const u of users) {
  console.log('='.repeat(70));
  console.log(`User #${u.id}  username=${u.username}  full_name=${u.full_name}  is_active=${u.is_active}`);
  console.log(`  role_id=${u.role_id}  role_name=${JSON.stringify(u.role_name)}  is_supervisor=${u.is_supervisor}`);
  console.log(`  department_id=${u.department_id}  department_name=${JSON.stringify(u.department_name)}`);
  console.log(`  linked employee_id=${u.employee_id}  employee_code=${u.employee_code}  employee_full_name=${u.employee_full_name}`);

  if (!u.is_active) console.log(`  >>> ISSUE: this login is INACTIVE (is_active=0) - would be blocked at auth, not just job cards.`);
  if (!u.role_name) console.log(`  >>> ISSUE: role_id ${u.role_id} does not resolve to any real role row.`);
  if (!u.department_name) console.log(`  >>> ISSUE: department_id ${u.department_id} does not resolve to any real department row, or department_id is NULL.`);

  // 1. Sidebar nav: does this login even get a "<dept> Job Cards" entry?
  // Mirrors public/js/app.js boot()'s own condition exactly.
  const getsOwnGroup = u.department_name && !['Admin', 'ProjectManager'].includes(u.role_name || '');
  console.log(`  Sidebar: gets own "<department> Job Cards" nav group? ${getsOwnGroup ? 'YES' : 'NO'}`);
  if (!getsOwnGroup) {
    if (!u.department_name) console.log(`    -> because department_name is empty (see ISSUE above).`);
    else console.log(`    -> because role_name is Admin/ProjectManager (they get a generic "My Job Cards" item instead, under Projects Management).`);
  }

  // 2. Is role_name a real pipeline stage, i.e. does isSupervisorOf() ever
  // match user.role_name === stage for this login at all (outside Admin)?
  const roleIsAStage = PIPELINE_STAGES.includes(u.role_name || '');
  console.log(`  Is role_name a real pipeline stage (PIPELINE_STAGES)? ${roleIsAStage ? 'YES' : 'NO'} ${roleIsAStage ? '' : '(role_name=' + JSON.stringify(u.role_name) + ' vs stages=' + JSON.stringify(PIPELINE_STAGES) + ')'}`);
  if (!roleIsAStage) {
    console.log(`    >>> ISSUE: isSupervisorOf() requires user.role_name === jc.stage exactly. If role_name isn't one of the ${PIPELINE_STAGES.length} real stage names, this login can never be treated as a supervisor of ANY job card via that path (oversight grants, checked below, are the only other way).`);
  }

  // 3. is_supervisor flag itself.
  console.log(`  is_supervisor flag set? ${u.is_supervisor ? 'YES' : 'NO (0/null)'}`);
  if (!u.is_supervisor && u.role_name !== 'Admin') {
    console.log(`    >>> If this is meant to be the department's HOD/supervisor, is_supervisor must be 1 - without it, isSupervisorOf() only returns true via Admin or an oversight grant, never via role_name===stage alone.`);
  }

  // 4. Any oversight grant giving this specific user supervisor authority
  // over another role's stage? (role_oversight is keyed on user_id, per
  // lib/roleOversight.js's oversightRoleNames().)
  let oversight = [];
  try {
    oversight = db.prepare(`
      SELECT ro.oversees_role_id, r2.name AS oversees_role_name
      FROM role_oversight ro
      LEFT JOIN roles r2 ON r2.id = ro.oversees_role_id
      WHERE ro.user_id = ?
    `).all(u.id);
  } catch (e) { oversight = []; }
  console.log(`  role_oversight grants for this user (oversees_role_name): ${oversight.length ? JSON.stringify(oversight.map(o => o.oversees_role_name)) : 'none'}`);

  // 5. What does combinedStagesForRole(role_name) resolve to, and does
  // GET /job-cards/mine's own stage set end up non-empty?
  const stages = combinedStagesForRole(u.role_name || '');
  console.log(`  combinedStagesForRole(role_name) => ${JSON.stringify(stages)}`);

  // 6. How many job cards actually exist at the stage(s) this role would see,
  // and is is_supervisor the only thing standing between "sees nothing" and
  // "sees the board"?
  if (roleIsAStage) {
    const placeholders = stages.map(() => '?').join(',');
    const count = db.prepare(`SELECT COUNT(*) as n FROM job_cards WHERE stage IN (${placeholders})`).get(...stages).n;
    console.log(`  Real job_cards rows at stage(s) ${JSON.stringify(stages)}: ${count} total in the whole system (board shows these regardless of is_supervisor - is_supervisor only gates WHICH ACTIONS are available, not visibility of the board itself for a role whose name matches a real stage).`);
  }

  console.log(`  --- Conclusion for this login ---`);
  if (!getsOwnGroup) {
    console.log(`  Will not even see a "<department> Job Cards" sidebar entry. Fix: set department_id to a real department row.`);
  } else if (!roleIsAStage) {
    console.log(`  Has a "<department> Job Cards" sidebar entry (so the PAGE loads), but role_name (${JSON.stringify(u.role_name)}) does not match any real pipeline stage name, so GET /job-cards/by-stage/:stage's own backend route (called with the stage derived from role_name) will likely return an empty/wrong board, or the board route itself resolves a DIFFERENT stage than intended. Check whether role_name should instead be exactly "Store" (case-sensitive) to match the pipeline stage.`);
  } else {
    console.log(`  Sidebar entry present, role_name correctly matches a real stage - board SHOULD show every job card at that stage regardless of is_supervisor. If is_supervisor=0, this user can VIEW the board but cannot act (start/complete/hold) on a card not directly assigned to them - that is likely the actual "not able to" symptom, not an invisible board.`);
  }
}

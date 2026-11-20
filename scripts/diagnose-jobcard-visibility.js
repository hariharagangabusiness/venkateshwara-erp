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

    // GET /job-cards/mine (what a non-Admin/PM login like this one actually
    // hits) only ever surfaces a card once it's been released/planned
    // (planned_start IS NOT NULL) and not NotApplicable - this is the gate
    // most likely to explain "0 cards visible" despite real rows existing.
    const visibleCount = db.prepare(`SELECT COUNT(*) as n FROM job_cards WHERE stage IN (${placeholders}) AND planned_start IS NOT NULL AND status != 'NotApplicable'`).get(...stages).n;
    const noPlanCount = db.prepare(`SELECT COUNT(*) as n FROM job_cards WHERE stage IN (${placeholders}) AND planned_start IS NULL`).get(...stages).n;
    const notApplicableCount = db.prepare(`SELECT COUNT(*) as n FROM job_cards WHERE stage IN (${placeholders}) AND status = 'NotApplicable'`).get(...stages).n;
    console.log(`  Of those ${count}: ${visibleCount} would actually appear on GET /job-cards/mine (planned_start set AND status != NotApplicable); ${noPlanCount} have no planned_start yet (never released via a project's Plan/Edit Department Targets step); ${notApplicableCount} are excluded from this project's plan (NotApplicable).`);
    if (count > 0 && visibleCount === 0) {
      console.log(`    >>> LIKELY ROOT CAUSE: every real Store job card in the system is still unplanned (planned_start NULL) or excluded (NotApplicable) - GET /job-cards/mine's own WHERE clause hides ALL of them regardless of role/supervisor correctness. This would read as "can't see Job Cards" even though the config is otherwise entirely correct.`);
    }
  }

  // 7. Role-based page-visibility restriction (User Access screen) - the
  // sidebar filters NAV items through ALLOWED_PAGES (see
  // lib/pageAccess.js's computeAllowedPages()), completely independent of
  // the DEPT_OWN_GROUP logic above. A page id missing from an Admin's
  // explicitly-configured role access (or revoked for this one user via
  // user_page_overrides) silently disappears from the sidebar with no
  // error anywhere - this exact bug class has hit this app before.
  let configured = null;
  try { configured = db.prepare('SELECT 1 FROM role_access_configured WHERE role_id = ?').get(u.role_id); } catch (e) { configured = null; }
  console.log(`  Role Access configured (restricted) for role_id ${u.role_id}? ${configured ? 'YES - this role is restricted to a specific page list' : 'NO - unrestricted, sees every page by default'}`);
  let roleHasJobcards = null;
  if (configured) {
    const row = db.prepare(`SELECT 1 FROM role_page_access WHERE role_id = ? AND page_id = 'jobcards'`).get(u.role_id);
    roleHasJobcards = !!row;
    console.log(`    Does the role's configured page list include "jobcards"? ${roleHasJobcards ? 'YES' : 'NO'}`);
    if (!roleHasJobcards) console.log(`    >>> ISSUE: role_page_access for role_id ${u.role_id} does NOT include "jobcards" - every user with this role has it hidden from their sidebar entirely, regardless of department/is_supervisor.`);
  }
  let extra = [];
  try {
    extra = db.prepare(`SELECT page_id FROM extra_page_access WHERE (user_id = ? OR (department_id IS NOT NULL AND department_id = ?)) AND page_id = 'jobcards'`).all(u.id, u.department_id || -1);
  } catch (e) { extra = []; }
  if (configured && !roleHasJobcards) {
    console.log(`    Extra Page Access grants of "jobcards" for this user/department: ${extra.length ? JSON.stringify(extra) : 'none'}`);
  }
  let overrides = [];
  try { overrides = db.prepare(`SELECT page_id, access FROM user_page_overrides WHERE user_id = ? AND page_id = 'jobcards'`).all(u.id); } catch (e) { overrides = []; }
  console.log(`  Per-user override on "jobcards" for this specific login: ${overrides.length ? JSON.stringify(overrides) : 'none'}`);
  if (overrides.some(o => o.access !== 'granted')) console.log(`    >>> ISSUE: this specific user has an explicit REVOKE override on "jobcards" - hidden for them individually even if their role/department would otherwise show it.`);

  const sidebarWillShowJobcards = u.role_name === 'Admin' ? true
    : (!configured && !overrides.some(o => o.access !== 'granted'))
    || (configured && (roleHasJobcards || extra.length > 0) && !overrides.some(o => o.access !== 'granted'))
    || overrides.some(o => o.access === 'granted');
  console.log(`  FINAL: will "jobcards" actually render in this login's sidebar once ALLOWED_PAGES is applied? ${sidebarWillShowJobcards ? 'YES' : 'NO'}`);

  // 8. Rule out a duplicate/second login against the same employee - if the
  // person is actually signing in with a DIFFERENT username than this one,
  // every check above is answering the wrong question.
  const siblingLogins = db.prepare(`SELECT id, username, is_active FROM users WHERE employee_id = ? AND id != ?`).all(u.employee_id, u.id);
  if (siblingLogins.length) {
    console.log(`  >>> NOTE: employee_id ${u.employee_id} has ${siblingLogins.length} OTHER user login(s) too: ${JSON.stringify(siblingLogins)} - if the real person is signing in under one of THOSE usernames instead of "${u.username}", every check above answers the wrong question.`);
  }

  console.log(`  --- Conclusion for this login ---`);
  if (!getsOwnGroup) {
    console.log(`  Will not even see a "<department> Job Cards" sidebar entry. Fix: set department_id to a real department row.`);
  } else if (!sidebarWillShowJobcards) {
    console.log(`  >>> ROOT CAUSE: the DEPT_OWN_GROUP logic WOULD add a "jobcards" nav item, but the sidebar then filters every item through ALLOWED_PAGES (the role's configured page-visibility list from the User Access screen) - and "jobcards" is not in it for this login. The item never renders, with no error anywhere. Fix: on the User Access page, either tick "jobcards" under this role's configured page list, or grant it via "Grant Extra Page Access" for this user/department.`);
  } else if (!roleIsAStage) {
    console.log(`  Has a "<department> Job Cards" sidebar entry (so the PAGE loads), but role_name (${JSON.stringify(u.role_name)}) does not match any real pipeline stage name, so GET /job-cards/by-stage/:stage's own backend route (called with the stage derived from role_name) will likely return an empty/wrong board, or the board route itself resolves a DIFFERENT stage than intended. Check whether role_name should instead be exactly "Store" (case-sensitive) to match the pipeline stage.`);
  } else {
    console.log(`  Sidebar entry present, role_name correctly matches a real stage - board SHOULD show every job card at that stage regardless of is_supervisor. If is_supervisor=0, this user can VIEW the board but cannot act (start/complete/hold) on a card not directly assigned to them - that is likely the actual "not able to" symptom, not an invisible board.`);
  }
}

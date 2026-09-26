const { ALL_PAGE_IDS } = require('./pageCatalog');

// The single place role_page_access, extra_page_access and
// user_page_overrides are merged into the page list a user actually sees.
// Used both by routes/auth.js's /my-pages (for the logged-in user) and by
// routes/admin.js's per-user access screen (for an arbitrary target user).
//
// Returns null for "unrestricted" (sees every page - today's default until
// an Admin explicitly configures the role) unless overrides force it to be
// materialized (see below), or an array of page ids otherwise.
function computeAllowedPages(db, user) {
  if (user.role_name === 'Admin') return null; // Admin can't be restricted, by anything
  const configured = db.prepare('SELECT 1 FROM role_access_configured WHERE role_id = ?').get(user.role_id);
  let pages = null;
  if (configured) {
    const rows = db.prepare('SELECT page_id FROM role_page_access WHERE role_id = ?').all(user.role_id);
    pages = new Set(rows.map(r => r.page_id));
    // Round 3: additive department/individual grants on top of the role's
    // configured list.
    const extra = db.prepare(`
      SELECT page_id FROM extra_page_access WHERE user_id = ? OR (department_id IS NOT NULL AND department_id = ?)
    `).all(user.id, user.department_id || -1);
    extra.forEach(r => pages.add(r.page_id));
  }
  const overrides = db.prepare('SELECT page_id, access FROM user_page_overrides WHERE user_id = ?').all(user.id);
  if (overrides.length) {
    // A revoke has to mean something even under an unrestricted role/no
    // role config - "unrestricted" can no longer be represented as the null
    // sentinel once one specific page is being taken away, so materialize
    // the full catalog first and then apply grants/revokes on top of it.
    if (pages === null) pages = new Set(ALL_PAGE_IDS);
    overrides.forEach(o => { if (o.access === 'granted') pages.add(o.page_id); else pages.delete(o.page_id); });
  }
  return pages === null ? null : Array.from(pages);
}

module.exports = { computeAllowedPages };

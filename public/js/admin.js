// admin.js - Offer Options/PDF Designer, Users, Access, Approval Matrix, Company Settings, Assets, Tickets,
// Full Data Export, Backups, Org Hierarchy, Data Import.

// ---- Offer Field Options (Application / Type of System / Material of Construction) ----
const OFFER_OPTION_FIELDS = [['application', 'Application'], ['type_of_system', 'Type Of System'], ['material_of_construction', 'Material Of Construction'], ['unit', 'Unit']];
let OFFER_OPTIONS_TAB = 'application';
// ---- Offer Clause Library categories - ids must match routes/offers.js's CLAUSE_CATEGORIES ----
const CLAUSE_CATEGORIES = [['term', 'Terms & Conditions'], ['inclusion', 'Inclusions'], ['exclusion', 'Exclusions'], ['utilities', 'Utilities Requirement'], ['instrument_air', 'Instrument Air Supply']];
let CLAUSE_LIBRARY_TAB = 'term';
// Plain <input>/<textarea> fields, not contenteditable spans - contenteditable
// text selection/replacement is unreliable with real mouse clicks (e.g. a
// triple-click meant to select-all and retype instead inserts the new text
// mid-string), which is what made these look broken/uneditable in practice
// even though the save wiring underneath was fine.
function renderOfferOptionRows(rows, isAdmin) {
  return `<table><thead><tr><th>Value</th><th>Sort</th><th>Active</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(o => `<tr>
      <td>${isAdmin ? `<input type="text" value="${esc(o.value)}" onchange="editOfferOption(${o.id}, 'value', this.value)" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;">` : esc(o.value)}</td>
      <td>${isAdmin ? `<input type="number" value="${o.sort_order}" onchange="editOfferOption(${o.id}, 'sort_order', this.value)" style="width:80px;border:1px solid var(--border);border-radius:4px;padding:5px;">` : o.sort_order}</td>
      <td>${o.active ? 'Yes' : 'No'}</td>
      ${isAdmin ? `<td><button class="btn small outline" onclick="editOfferOption(${o.id}, 'active', ${o.active ? 0 : 1})">${o.active ? 'Deactivate' : 'Activate'}</button></td>` : ''}
    </tr>`).join('') || `<tr><td colspan="${isAdmin ? 4 : 3}" class="empty">No options yet.</td></tr>`}
  </tbody></table>`;
}
function renderSectionTitleRows(rows, isAdmin) {
  return `<table><thead><tr><th>Title</th><th>Description</th><th>Summary</th><th>Picture</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(s => `<tr>
      <td>${isAdmin ? `<input type="text" value="${esc(s.title)}" onchange="editSectionTitle(${s.id}, 'title', this.value, this)" style="width:100%;min-width:160px;border:1px solid var(--border);border-radius:4px;padding:5px;">` : esc(s.title)}</td>
      <td style="max-width:220px;">${isAdmin ? `<textarea onchange="editSectionTitle(${s.id}, 'description', this.value, this)" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;font-family:inherit;">${esc(s.description)}</textarea>` : (esc(s.description)||'-')}</td>
      <td style="max-width:220px;">${isAdmin ? `<textarea onchange="editSectionTitle(${s.id}, 'summary', this.value, this)" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;font-family:inherit;">${esc(s.summary)}</textarea>` : (esc(s.summary)||'-')}</td>
      <td>
        ${s.image_path ? `<img src="${esc(s.image_path)}" style="max-width:50px;max-height:50px;display:block;margin-bottom:4px;">` : ''}
        ${isAdmin ? `<input type="file" accept="image/*" onchange="replaceSectionTitleImage(${s.id}, this)" style="font-size:11px;width:110px;">` : (s.image_path ? '' : '-')}
      </td>
      ${isAdmin ? `<td><button class="btn small outline" onclick="moveLibraryEntry('section-titles', ${s.id}, 'move-to-spares')">Move to Spares</button> <button class="btn small red" onclick="deleteSectionTitle(${s.id})">Delete</button></td>` : ''}
    </tr>`).join('') || `<tr><td colspan="${isAdmin ? 5 : 4}" class="empty">No section titles yet.</td></tr>`}
  </tbody></table>`;
}
function renderSparesLibraryRows(rows, isAdmin) {
  return `<table><thead><tr><th>Title</th><th>Description</th><th>Summary</th><th>Rate</th><th>Unit</th><th>Picture</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(s => `<tr>
      <td>${isAdmin ? `<input type="text" value="${esc(s.title)}" onchange="editSparesLibraryEntry(${s.id}, 'title', this.value, this)" style="width:100%;min-width:140px;border:1px solid var(--border);border-radius:4px;padding:5px;">` : esc(s.title)}</td>
      <td style="max-width:200px;">${isAdmin ? `<textarea onchange="editSparesLibraryEntry(${s.id}, 'description', this.value, this)" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;font-family:inherit;">${esc(s.description)}</textarea>` : (esc(s.description)||'-')}</td>
      <td style="max-width:200px;">${isAdmin ? `<textarea onchange="editSparesLibraryEntry(${s.id}, 'summary', this.value, this)" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;font-family:inherit;">${esc(s.summary)}</textarea>` : (esc(s.summary)||'-')}</td>
      <td>${isAdmin ? `<input type="number" value="${s.rate||0}" onchange="editSparesLibraryEntry(${s.id}, 'rate', this.value, this)" style="width:90px;border:1px solid var(--border);border-radius:4px;padding:5px;">` : ('₹' + fmt(s.rate||0))}</td>
      <td>${isAdmin ? `<input type="text" value="${esc(s.unit||'Nos')}" onchange="editSparesLibraryEntry(${s.id}, 'unit', this.value, this)" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:5px;">` : esc(s.unit||'Nos')}</td>
      <td>
        ${s.image_path ? `<img src="${esc(s.image_path)}" style="max-width:50px;max-height:50px;display:block;margin-bottom:4px;">` : ''}
        ${isAdmin ? `<input type="file" accept="image/*" onchange="replaceSparesLibraryImage(${s.id}, this)" style="font-size:11px;width:110px;">` : (s.image_path ? '' : '-')}
      </td>
      ${isAdmin ? `<td><button class="btn small outline" onclick="moveLibraryEntry('spares-library', ${s.id}, 'move-to-machine')">Move to Machine</button> <button class="btn small red" onclick="deleteSparesLibraryEntry(${s.id})">Delete</button></td>` : ''}
    </tr>`).join('') || `<tr><td colspan="${isAdmin ? 7 : 6}" class="empty">No spares in the library yet.</td></tr>`}
  </tbody></table>`;
}
PAGES['offer-options'] = async (el) => {
  // Field options / Section Title library are master template controls
  // (values every Sales user's offers draw from) - only Admin can add,
  // edit, deactivate or delete entries; everyone else gets a read-only
  // view to browse what's available while building an offer. The bulk
  // admin listing (incl. inactive, for toggling) is Admin-only now, so
  // everyone else reads just the active options for the open tab - the
  // same endpoint the offer builder itself uses to populate its dropdowns.
  const isAdmin = ME.role === 'Admin';
  const [rows, sectionTitles, sparesLibrary, pdfTemplate, governance, clauses, suggestions, offerTemplates] = await Promise.all([
    isAdmin ? api('/offers/field-options').then(all => all.filter(o => o.field_name === OFFER_OPTIONS_TAB)) : api('/offers/field-options/' + OFFER_OPTIONS_TAB),
    api('/offers/section-titles'),
    api('/offers/spares-library'),
    api('/offers/pdf-template').catch(() => null), // Admin-only - null for everyone else, panel just doesn't render
    api('/offers/governance').catch(() => null), // Admin-only - same
    isAdmin ? api('/offers/clause-library') : Promise.resolve([]), // Admin-only bulk (incl. inactive) view
    isAdmin ? api('/offers/section-title-suggestions') : Promise.resolve([]), // Admin-only review queue
    api('/offers/templates'), // everyone with offer access browses; only Admin gets Edit/Delete/New below
  ]);
  el.innerHTML = `
    <div class="panel">
      ${collapsiblePanel('offer-templates', `Offer Templates (${offerTemplates.length})`, `
        <p class="muted">Standard, reusable offers not tied to any customer - Admin builds out a template's scope, specs, terms and pictures here; anyone with offer access can start a real customer offer from one via "Create Offer from Template", which copies its full content into a brand-new, fully independent, fully-editable offer.</p>
        ${isAdmin ? `<div class="form-grid">
          <div><label>New Template Name</label><input id="ot-subject" placeholder="e.g. Standard Electronic Weighing &amp; Bagging System"></div>
        </div>
        <button class="btn" onclick="createOfferTemplate()">New Template</button>
        <div id="ot-err" class="msg err" style="display:none;margin-top:10px;"></div>` : ''}
        <div style="margin-top:14px;">
        ${tableHTML(['Name', 'Application', 'Type Of System', 'Updated', ''], offerTemplates, t => `
          <tr><td>${esc(t.subject)||'-'}</td><td>${esc(t.application)||'-'}</td><td>${esc(t.type_of_system)||'-'}</td><td>${new Date(t.updated_at).toLocaleDateString()}</td>
          <td>${actionButtonsCell(`<button class="btn small outline" onclick="useTemplate(${t.id}, '${esc(t.subject)}')">Create Offer from Template</button>
          ${isAdmin ? `<button class="btn small outline" onclick="openOfferBuilder(${t.id})">Edit</button>
          <button class="btn small red" onclick="deleteOfferTemplate(${t.id})">Delete</button>` : ''}`)}</td></tr>`)}
        </div>
      `)}
    </div>
    <div class="panel">
      <div class="tabs">${OFFER_OPTION_FIELDS.map(([id, label]) => `<div class="tab ${OFFER_OPTIONS_TAB === id ? 'active' : ''}" onclick="switchOfferOptionsTab('${id}')">${label}</div>`).join('')}</div>
      ${isAdmin ? `<div style="margin-top:14px;" class="form-grid">
        <div><label>New Value</label><input id="oo-value"></div>
        <div><label>Sort Order</label><input id="oo-sort" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addOfferOption()">Add Option</button>` : ''}
      <div style="margin-top:14px;">
      ${collapsiblePanel('offer-field-values', `Values (${rows.length})`, `
        ${renderListSearch('offer-field-values', rows, ['value'], (filtered) => {
          document.getElementById('oo-table-wrap').innerHTML = renderOfferOptionRows(filtered, isAdmin);
        }, 'Search values...')}
        <div id="oo-table-wrap">${renderOfferOptionRows(rows, isAdmin)}</div>
      `)}
      </div>
    </div>
    ${isAdmin && suggestions.length ? `<div class="panel"><h3>Pending Library Entries for Review (${suggestions.length})</h3>
      <p class="muted">Typed directly on an offer instead of picked from the library - Approve to add it to the Machine Library (or Spares Library, for a Spares-format offer's entry) below for everyone to reuse, or Reject to discard it. The offer item itself already saved either way.</p>
      ${tableHTML(['Add to', 'Title', 'Description', 'Summary', 'Picture', 'Offer', 'Suggested By', ''], suggestions, s => `
        <tr>
          <td><select id="sug-lib-${s.id}" title="Which library to add this to"><option value="Machine" ${s.library_type !== 'Spares' ? 'selected' : ''}>Machine Library</option><option value="Spares" ${s.library_type === 'Spares' ? 'selected' : ''}>Spares Library</option></select></td>
          <td>${esc(s.title)}</td>
          <td style="white-space:pre-wrap;max-width:200px;">${esc(s.description)||'-'}</td>
          <td style="white-space:pre-wrap;max-width:200px;">${esc(s.summary)||'-'}</td>
          <td>${s.image_path ? `<img src="${esc(s.image_path)}" style="max-width:50px;max-height:50px;">` : '-'}</td>
          <td>${esc(s.offer_no)||'-'}</td>
          <td>${esc(s.suggested_by_name)||'-'}</td>
          <td>${actionButtonsCell(`<button class="btn small green" onclick="approveSectionTitleSuggestion(${s.id})">Approve</button>
          <button class="btn small red" onclick="rejectSectionTitleSuggestion(${s.id})">Reject</button>`)}</td>
        </tr>`)}
    </div>` : ''}
    <div class="panel">
      ${collapsiblePanel('section-title-library', `Machine Library (${sectionTitles.length})`, `
        <p class="muted">Named machinery/scope lines with a default description, summary and picture - picking one on a Standard offer's "Add Machinery / Scope Line" form auto-fills the line instead of retyping it every time. A Spares-format offer uses the separate Spares Library below instead.</p>
        ${renderListSearch('section-title-library', sectionTitles, ['title', 'description', 'summary'], (filtered) => {
          document.getElementById('stl-table-wrap').innerHTML = renderSectionTitleRows(filtered, isAdmin);
        }, 'Search title, description, summary...')}
        <div id="stl-table-wrap">${renderSectionTitleRows(sectionTitles, isAdmin)}</div>
        ${isAdmin ? `<h4>Add to Machine Library</h4>
        <div class="form-grid">
          <div><label>Title</label><input id="stl-title" placeholder="e.g. Electronic Net Weighing And Bagging System"></div>
          <div><label>Picture (optional)</label><input id="stl-image" type="file" accept="image/*"></div>
        </div>
        <label>Description</label>
        <textarea id="stl-desc" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
        <label>Summary</label>
        <textarea id="stl-summary" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;" placeholder="Short reference note"></textarea>
        <div style="margin-top:8px;"><button class="btn" onclick="addSectionTitle()">Add to Library</button></div>
        <div id="stl-err" class="msg err" style="display:none;margin-top:10px;"></div>` : ''}
      `)}
    </div>
    <div class="panel">
      ${collapsiblePanel('spares-library', `Spares Library (${sparesLibrary.length})`, `
        <p class="muted">Reusable spare parts with a default description, summary, rate and unit - picking one on a Spares-format offer's "Add Line" form auto-fills the line instead of retyping it every time.</p>
        ${renderListSearch('spares-library', sparesLibrary, ['title', 'description', 'summary'], (filtered) => {
          document.getElementById('spl-table-wrap').innerHTML = renderSparesLibraryRows(filtered, isAdmin);
        }, 'Search title, description, summary...')}
        <div id="spl-table-wrap">${renderSparesLibraryRows(sparesLibrary, isAdmin)}</div>
        ${isAdmin ? `<h4>Add to Spares Library</h4>
        <div class="form-grid">
          <div><label>Title</label><input id="spl-title" placeholder="e.g. Ball Bearing 6205"></div>
          <div><label>Rate (₹)</label><input id="spl-rate" type="number" value="0"></div>
          <div><label>Unit</label><input id="spl-unit" value="Nos"></div>
          <div><label>Picture (optional)</label><input id="spl-image" type="file" accept="image/*"></div>
        </div>
        <label>Description</label>
        <textarea id="spl-desc" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
        <label>Summary</label>
        <textarea id="spl-summary" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;" placeholder="Short reference note"></textarea>
        <div style="margin-top:8px;"><button class="btn" onclick="addSparesLibraryEntry()">Add to Library</button></div>
        <div id="spl-err" class="msg err" style="display:none;margin-top:10px;"></div>
        <h4 style="margin-top:18px;">Bulk Upload via Excel</h4>
        <p class="muted">Columns: Title / Description / Summary / Rate / Unit (header row optional - with no header, read in that column order). A title that already exists in the library is skipped, not overwritten.</p>
        <input id="spl-bulk-file" type="file" accept=".xlsx,.xls,.csv">
        <button class="btn outline" onclick="uploadSparesLibraryBulk()">Upload</button>
        <div id="spl-bulk-msg" class="msg" style="display:none;margin-top:10px;"></div>` : ''}
      `)}
    </div>
    ${isAdmin ? collapsiblePanel('offer-clause-library', 'Offer Clause Library', `
      <p class="muted">Pre-approved Terms &amp; Conditions / Inclusions / Exclusions / Utilities Requirement / Instrument Air Supply clauses - Sales picks from these on the offer builder's Terms and Inclusions/Exclusions tabs instead of always typing from scratch.</p>
      <div class="tabs">${CLAUSE_CATEGORIES.map(([id, label]) => `<div class="tab ${CLAUSE_LIBRARY_TAB === id ? 'active' : ''}" onclick="switchClauseLibraryTab('${id}')">${label}</div>`).join('')}</div>
      <table style="margin-top:14px;"><thead><tr><th>Label</th><th>Clause Text</th><th>Sort</th><th>Active</th><th></th></tr></thead><tbody>
        ${clauses.filter(c => c.category === CLAUSE_LIBRARY_TAB).map(c => `<tr>
          <td><input type="text" value="${esc(c.label)}" onchange="editClause(${c.id}, 'label', this.value)" style="width:100%;min-width:120px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td style="max-width:320px;"><textarea onchange="editClause(${c.id}, 'body', this.value)" rows="2" style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px;font-family:inherit;">${esc(c.body)}</textarea></td>
          <td><input type="number" value="${c.sort_order}" onchange="editClause(${c.id}, 'sort_order', this.value)" style="width:70px;border:1px solid var(--border);border-radius:4px;padding:5px;"></td>
          <td>${c.active ? 'Yes' : 'No'}</td>
          <td>${actionButtonsCell(`<button class="btn small outline" onclick="editClause(${c.id}, 'active', ${c.active ? 0 : 1})">${c.active ? 'Deactivate' : 'Activate'}</button>
              <button class="btn small red" onclick="deleteClause(${c.id})">Delete</button>`)}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">No clauses yet in this category.</td></tr>'}
      </tbody></table>
      <h4>Add Clause</h4>
      <div class="form-grid">
        <div><label>Label</label><input id="cl-label" placeholder="e.g. Payment Terms"></div>
        <div><label>Sort Order</label><input id="cl-sort" type="number" value="0"></div>
      </div>
      <label>Clause Text</label>
      <textarea id="cl-body" rows="3" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:13px;"></textarea>
      <div style="margin-top:8px;"><button class="btn" onclick="addClause()">Add to Library</button></div>
      <div id="cl-err" class="msg err" style="display:none;margin-top:10px;"></div>
    `) : ''}
    ${pdfTemplate ? collapsiblePanel('offer-pdf-template', 'Offer PDF Template (Optional Override)', `
      <p class="muted">Offers use the built-in letterhead by default. Upload a header, footer and/or cover page image below and check "Active" to override just that piece - anything left unchecked keeps using the default, pixel-matched letterhead. Checking "Active" with no image uploaded (yet) has no effect. For a full custom design, use the Offer PDF Layout Designer instead.</p>
      <table><thead><tr><th>Piece</th><th>Current</th><th>Active</th><th>Upload New</th></tr></thead><tbody>
        ${['header', 'footer', 'cover'].map(piece => `<tr>
          <td style="text-transform:capitalize;">${piece}</td>
          <td>${pdfTemplate[piece + '_image_path'] ? `<img src="${esc(pdfTemplate[piece + '_image_path'])}" style="max-height:40px;max-width:120px;">` : '<span class="muted">Default (built-in)</span>'}</td>
          <td><input type="checkbox" id="pt-${piece}-active" ${pdfTemplate[piece + '_active'] ? 'checked' : ''}></td>
          <td><input type="file" id="pt-${piece}-file" accept="image/*"></td>
        </tr>`).join('')}
      </tbody></table>

      <div style="margin-top:14px;">
        <button class="btn" onclick="savePdfTemplate()">Save Template Settings</button>
        <button class="btn outline" onclick="resetPdfTemplate()">Reset All to Default</button>
      </div>
      <div id="pt-err" class="msg err" style="display:none;margin-top:10px;"></div>
    `) : ''}
    ${governance ? collapsiblePanel('offer-governance', 'Offer Governance', `
      <p class="muted">Compliance kill switches - each is instantly reversible, no code change or redeploy needed.</p>
      <label style="display:block;margin-bottom:8px;"><input type="checkbox" id="gov-lock-on-so" ${governance.lock_on_so_conversion ? 'checked' : ''}>
        Lock an offer against further edits once it's converted to a Sales Order (Admin can still unlock a specific offer from its builder page if needed)</label>
      <label style="display:block;margin-bottom:8px;"><input type="checkbox" id="gov-require-library" ${governance.require_library_clauses ? 'checked' : ''}>
        Require Sales to pick Terms/Inclusions/Exclusions from the clause library below rather than typing their own</label>
      <label style="display:block;margin-bottom:8px;"><input type="checkbox" id="gov-restrict-creator" ${governance.restrict_offers_to_creator ? 'checked' : ''}>
        Restrict who can see an Offer - a Sales person sees only their own; a department HOD/supervisor also sees their own department's (Admin/Management always see everything)</label>
      <div style="margin-top:8px;"><button class="btn" onclick="saveOfferGovernance()">Save Governance Settings</button></div>
      <div id="gov-err" class="msg err" style="display:none;margin-top:10px;"></div>
    `) : ''}
    `;
};
window.saveOfferGovernance = async () => {
  const errEl = document.getElementById('gov-err');
  errEl.style.display = 'none';
  try {
    await api('/offers/governance', { method: 'PUT', body: JSON.stringify({
      lock_on_so_conversion: document.getElementById('gov-lock-on-so').checked,
      require_library_clauses: document.getElementById('gov-require-library').checked,
      restrict_offers_to_creator: document.getElementById('gov-restrict-creator').checked,
    })});
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.switchOfferOptionsTab = (id) => { OFFER_OPTIONS_TAB = id; navigate('offer-options'); };
window.addOfferOption = async () => {
  try {
    await api('/offers/field-options', { method: 'POST', body: JSON.stringify({ field_name: OFFER_OPTIONS_TAB, value: val('oo-value'), sort_order: val('oo-sort') }) });
    navigate('offer-options');
  } catch (e) { alert(e.message); }
};
window.editOfferOption = async (id, field, value) => {
  try { await api('/offers/field-options/' + id, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); navigate('offer-options'); }
  catch (e) { alert(e.message); navigate('offer-options'); }
};
window.addSectionTitle = async () => {
  const errEl = document.getElementById('stl-err');
  errEl.style.display = 'none';
  try {
    const fd = new FormData();
    fd.append('title', val('stl-title'));
    fd.append('description', val('stl-desc'));
    fd.append('summary', val('stl-summary'));
    const fileInput = document.getElementById('stl-image');
    if (fileInput.files[0]) fd.append('image', fileInput.files[0]);
    await apiUpload('/offers/section-titles', fd, 'POST');
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteSectionTitle = async (id) => {
  if (!confirm('Delete this section title from the library?')) return;
  try { await api('/offers/section-titles/' + id, { method: 'DELETE' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
// Saves on change only (never on a bare click/blur) and stays on the page - a brief green outline confirms it.
// A failed save alerts and reloads so the field shows the stored value again.
function flashSaved(el) { if (!el) return; el.style.outline = '2px solid #1a7f37'; setTimeout(() => { el.style.outline = ''; }, 900); }
window.editSectionTitle = async (id, field, value, el) => {
  try {
    const fd = new FormData();
    fd.append(field, value);
    await apiUpload('/offers/section-titles/' + id, fd, 'PUT');
    flashSaved(el);
  } catch (e) { alert(e.message); navigate('offer-options'); }
};
window.moveLibraryEntry = async (kind, id, action) => {
  const toSpares = action === 'move-to-spares';
  if (!confirm(toSpares ? 'Move this entry to the Spares Library? Its rate starts blank and unit at Nos - edit them there afterwards.' : 'Move this entry to the Machine Library? Its rate and unit will be dropped.')) return;
  try { await api('/offers/' + kind + '/' + id + '/' + action, { method: 'POST' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.replaceSectionTitleImage = async (id, fileInput) => {
  if (!fileInput.files[0]) return;
  try {
    const fd = new FormData();
    fd.append('image', fileInput.files[0]);
    await apiUpload('/offers/section-titles/' + id, fd, 'PUT');
    navigate('offer-options');
  } catch (e) { alert(e.message); }
};
window.approveSectionTitleSuggestion = async (id) => {
  try { await api('/offers/section-title-suggestions/' + id + '/approve', { method: 'POST', body: JSON.stringify({ library_type: val('sug-lib-' + id) }) }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.rejectSectionTitleSuggestion = async (id) => {
  if (!confirm('Reject this suggestion? It will be discarded - the offer item that suggested it is unaffected.')) return;
  try { await api('/offers/section-title-suggestions/' + id + '/reject', { method: 'POST' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.addSparesLibraryEntry = async () => {
  const errEl = document.getElementById('spl-err');
  errEl.style.display = 'none';
  try {
    const fd = new FormData();
    fd.append('title', val('spl-title'));
    fd.append('description', val('spl-desc'));
    fd.append('summary', val('spl-summary'));
    fd.append('rate', val('spl-rate'));
    fd.append('unit', val('spl-unit'));
    const fileInput = document.getElementById('spl-image');
    if (fileInput.files[0]) fd.append('image', fileInput.files[0]);
    await apiUpload('/offers/spares-library', fd, 'POST');
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteSparesLibraryEntry = async (id) => {
  if (!confirm('Delete this spare from the library?')) return;
  try { await api('/offers/spares-library/' + id, { method: 'DELETE' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.editSparesLibraryEntry = async (id, field, value, el) => {
  try {
    const fd = new FormData();
    fd.append(field, value);
    await apiUpload('/offers/spares-library/' + id, fd, 'PUT');
    flashSaved(el);
  } catch (e) { alert(e.message); navigate('offer-options'); }
};
window.replaceSparesLibraryImage = async (id, fileInput) => {
  if (!fileInput.files[0]) return;
  try {
    const fd = new FormData();
    fd.append('image', fileInput.files[0]);
    await apiUpload('/offers/spares-library/' + id, fd, 'PUT');
    navigate('offer-options');
  } catch (e) { alert(e.message); }
};
window.uploadSparesLibraryBulk = async () => {
  const msgEl = document.getElementById('spl-bulk-msg');
  msgEl.style.display = 'none';
  const fileInput = document.getElementById('spl-bulk-file');
  if (!fileInput.files[0]) { alert('Choose a file first.'); return; }
  try {
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    const r = await apiUpload('/offers/spares-library/bulk-upload', fd, 'POST');
    msgEl.className = 'msg ok';
    msgEl.textContent = `Done: ${r.inserted} added, ${r.skipped} skipped (blank title or already in the library).`;
    msgEl.style.display = 'block';
    navigate('offer-options');
  } catch (e) { msgEl.className = 'msg err'; msgEl.textContent = e.message; msgEl.style.display = 'block'; }
};
window.switchClauseLibraryTab = (id) => { CLAUSE_LIBRARY_TAB = id; navigate('offer-options'); };
window.addClause = async () => {
  const errEl = document.getElementById('cl-err');
  errEl.style.display = 'none';
  try {
    await api('/offers/clause-library', { method: 'POST', body: JSON.stringify({
      category: CLAUSE_LIBRARY_TAB, label: val('cl-label'), body: val('cl-body'), sort_order: val('cl-sort'),
    })});
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.editClause = async (id, field, value) => {
  try { await api('/offers/clause-library/' + id, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); navigate('offer-options'); }
  catch (e) { alert(e.message); navigate('offer-options'); }
};
window.deleteClause = async (id) => {
  if (!confirm('Delete this clause from the library?')) return;
  try { await api('/offers/clause-library/' + id, { method: 'DELETE' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
window.savePdfTemplate = async () => {
  const errEl = document.getElementById('pt-err');
  errEl.style.display = 'none';
  try {
    const fd = new FormData();
    ['header', 'footer', 'cover'].forEach(piece => {
      fd.append(piece + '_active', document.getElementById(`pt-${piece}-active`).checked);
      const fileEl = document.getElementById(`pt-${piece}-file`);
      if (fileEl.files[0]) fd.append(piece + '_image', fileEl.files[0]);
    });
    await apiUpload('/offers/pdf-template', fd, 'POST');
    navigate('offer-options');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.resetPdfTemplate = async () => {
  if (!confirm('Reset the Offer PDF template to the default letterhead? This removes any uploaded header/footer/cover images.')) return;
  try { await api('/offers/pdf-template', { method: 'DELETE' }); navigate('offer-options'); }
  catch (e) { alert(e.message); }
};
// ===================== Offer PDF Layout Designer (GrapesJS) =====================
// Visual header/footer/cover-page builder backing routes/offers.js's
// /offers/pdf-layout endpoints (see lib/settings.js for storage). GrapesJS
// and its webpage preset are heavy and only needed on this one page, so
// they're loaded lazily (see loadOfferPdfDesignerAssets) rather than in
// index.html's <head>.
//
// Keep this token list in sync with lib/offerPdf.js's mergeTokenMap - an
// unrecognized {{token}} is left as literal text in the rendered PDF rather
// than silently disappearing, so this is the one true list admins should
// pick from instead of typing tokens by hand.
const PDF_DESIGNER_TOKENS = [
  'client.name', 'offer.no', 'offer.subject', 'offer.date', 'offer.version',
  'offer.application', 'offer.type_of_system', 'offer.material_of_construction',
  'company.legal_name', 'company.registered_address', 'company.gstin', 'company.pan',
];
// width/height approximate real print dimensions at 96dpi (A4 width, and the
// PDF's actual top/bottom margins for header/footer) so proportions look
// right while designing - see setDevice('PDF') in initOfferPdfDesignerTab.
// smallText mirrors the fact that Puppeteer's header/footer template
// rendering context (NOT the cover, which renders as part of the normal PDF
// body flow) doesn't inherit the page's CSS at all - lib/offerPdf.js wraps
// designed header/footer content in a 10px Arial default so it isn't
// invisible in the actual PDF, so the canvas should default to roughly the
// same thing while designing.
const PDF_DESIGNER_PIECES = [
  { id: 'header', label: 'Header', width: 794, height: 110, smallText: true },
  { id: 'footer', label: 'Footer', width: 794, height: 98, smallText: true },
  { id: 'cover', label: 'Cover Page', width: 794, height: 1123, smallText: false },
];
let PDF_DESIGNER_TAB = 'header';
let PDF_DESIGNER_LAYOUT = null; // { header, footer, cover }, each { active, html, css, project }
let PDF_DESIGNER_EDITORS = {}; // piece id -> live grapesjs Editor instance for this page visit
let PDF_DESIGNER_ASSETS_PROMISE = null; // guards against loading the vendor <script>/<link> tags twice

function loadOfferPdfDesignerAssets() {
  if (PDF_DESIGNER_ASSETS_PROMISE) return PDF_DESIGNER_ASSETS_PROMISE;
  PDF_DESIGNER_ASSETS_PROMISE = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/vendor/grapesjs/css/grapes.min.css';
    document.head.appendChild(link);
    const gjsScript = document.createElement('script');
    gjsScript.src = '/vendor/grapesjs/grapes.min.js';
    gjsScript.onload = () => {
      const presetScript = document.createElement('script');
      presetScript.src = '/vendor/grapesjs-preset-webpage/index.js';
      presetScript.onload = () => {
        // grapesjs-preset-webpage's own default block set is just Link/Quote/
        // Text (3 blocks total) - this adds Image and 1/2/3-column layout
        // blocks, the actual capability a header/footer/cover designer needs
        // (e.g. a logo image beside company text in two columns).
        const blocksScript = document.createElement('script');
        blocksScript.src = '/vendor/grapesjs-blocks-basic/index.js';
        blocksScript.onload = () => resolve();
        blocksScript.onerror = () => reject(new Error('Failed to load the GrapesJS basic blocks plugin.'));
        document.head.appendChild(blocksScript);
      };
      presetScript.onerror = () => reject(new Error('Failed to load the GrapesJS webpage preset.'));
      document.head.appendChild(presetScript);
    };
    gjsScript.onerror = () => reject(new Error('Failed to load GrapesJS.'));
    document.head.appendChild(gjsScript);
  });
  return PDF_DESIGNER_ASSETS_PROMISE;
}

function renderOfferPdfDesignerPanel(piece) {
  const data = (PDF_DESIGNER_LAYOUT && PDF_DESIGNER_LAYOUT[piece.id]) || { active: false };
  return `
  <div class="pdfd-panel" data-piece="${piece.id}" style="${PDF_DESIGNER_TAB === piece.id ? '' : 'display:none;'}">
    <label style="display:block;margin-bottom:10px;">
      <input type="checkbox" id="pdfd-active-${piece.id}" ${data.active ? 'checked' : ''}>
      Active (use this designed ${esc(piece.label.toLowerCase())} on offer PDFs instead of the built-in default)
    </label>
    <div class="pdfd-body">
      <div class="pdfd-canvas-col">
        <div class="pdfd-gjs-wrap"><div id="pdfd-canvas-${piece.id}"></div></div>
      </div>
      <div class="pdfd-side">
        <h4 style="margin-top:0;">Merge Fields</h4>
        <p class="muted" style="font-size:12px;">Select an element on the canvas, then click a field to insert it there. With nothing selected, it's copied to the clipboard instead.</p>
        <div class="pdfd-tokens">
          ${PDF_DESIGNER_TOKENS.map(t => `<button type="button" class="pdfd-token-btn" onclick="insertOfferPdfDesignerToken('${piece.id}','${t}')">{{${t}}}</button>`).join('')}
        </div>
        <div style="margin-top:16px;">
          <button class="btn" onclick="saveOfferPdfDesignerPiece('${piece.id}')">Save ${esc(piece.label)}</button><br>
          ${piece.id !== 'cover' ? `<button class="btn outline" onclick="previewOfferPdfDesignerFullPage('${piece.id}')" style="margin-top:8px;">Preview in Full Page</button><br>` : ''}
          <button class="btn outline" onclick="resetOfferPdfDesignerPiece('${piece.id}')" style="margin-top:8px;">Reset ${esc(piece.label)}</button>
        </div>
        <div id="pdfd-err-${piece.id}" class="msg err" style="display:none;margin-top:10px;"></div>
        <div id="pdfd-ok-${piece.id}" class="msg ok" style="display:none;margin-top:10px;"></div>
      </div>
    </div>
  </div>`;
}

PAGES['offer-pdf-designer'] = async (el) => {
  if (ME.role !== 'Admin') {
    el.innerHTML = `<div class="panel"><p class="muted">This page is only available to Admins.</p></div>`;
    return;
  }
  // Tear down any editors left over from a previous visit to this page in
  // this session - the containers below are about to be recreated, so their
  // old iframes/listeners would otherwise just leak.
  Object.values(PDF_DESIGNER_EDITORS).forEach(ed => { try { ed.destroy(); } catch (e) {} });
  PDF_DESIGNER_EDITORS = {};
  const [layout, template] = await Promise.all([api('/offers/pdf-layout'), api('/offers/pdf-template')]);
  PDF_DESIGNER_LAYOUT = layout;
  el.innerHTML = `
    <div class="panel">
      <h3>Offer PDF Layout Designer</h3>
      <p class="muted">Design the offer PDF's header, footer and cover page visually. Each piece can be toggled active independently - leaving a piece inactive keeps the existing built-in default for it. Changes here only apply once you click that piece's Save button.</p>
      <div class="tabs">
        ${PDF_DESIGNER_PIECES.map(p => `<div class="tab pdfd-tab ${PDF_DESIGNER_TAB === p.id ? 'active' : ''}" data-tab="${p.id}" onclick="switchOfferPdfDesignerTab('${p.id}')">${esc(p.label)}</div>`).join('')}
      </div>
      ${PDF_DESIGNER_PIECES.map(p => renderOfferPdfDesignerPanel(p)).join('')}
    </div>
    ${collapsiblePanel('custom-body-template', 'Full Custom Body Template (Word Upload)', `
      <p class="muted">Upload a Word (.docx) document to replace the entire offer body (everything except the header/footer/cover above) with your own layout. The upload is converted to HTML once for you to review and mark up below - it isn't saved or activated until you click Save.</p>
      <p class="muted">Use <code>{{client.name}}</code>, <code>{{offer.subject}}</code>, <code>{{offer.grand_total}}</code>, etc. anywhere as merge fields (unrecognized tokens are left as literal text, so a typo is obvious rather than silently blank). For the scope-of-supply line items, wrap a row template in <code>{{#offer_items}}...{{/offer_items}}</code> - inside it, use <code>{{item.description}}</code>, <code>{{item.qty}}</code>, <code>{{item.unit_price}}</code>, <code>{{item.total_price}}</code>, <code>{{item.item_code}}</code>.</p>
      <input type="file" id="cbt-file" accept=".docx">
      <button class="btn small outline" type="button" onclick="convertCustomBodyDocx()">Convert Uploaded Word Doc to HTML</button>
      <div id="cbt-convert-msg" class="msg" style="display:none;margin-top:8px;"></div>
      <div style="margin-top:10px;">
        <label>Template HTML (edit freely, or paste your own)</label>
        <textarea id="cbt-html" rows="16" style="width:100%;font-family:monospace;font-size:12px;">${esc(template.custom_body_html)}</textarea>
      </div>
      <label style="display:block;margin-top:8px;"><input type="checkbox" id="cbt-active" ${template.custom_body_active ? 'checked' : ''}> Active - use this template instead of the built-in offer body</label>
      <button class="btn small" type="button" onclick="saveCustomBodyTemplate()" style="margin-top:8px;">Save</button>
      <div id="cbt-err" class="msg err" style="display:none;margin-top:8px;"></div>
    `)}`;
  await loadOfferPdfDesignerAssets();
  initOfferPdfDesignerTab(PDF_DESIGNER_TAB);
};
window.convertCustomBodyDocx = async () => {
  const fileInput = document.getElementById('cbt-file');
  const msgEl = document.getElementById('cbt-convert-msg');
  if (!fileInput.files.length) { alert('Choose a .docx file first.'); return; }
  const fd = new FormData();
  fd.append('docx', fileInput.files[0]);
  msgEl.className = 'msg'; msgEl.style.display = 'block'; msgEl.textContent = 'Converting...';
  try {
    const r = await apiUpload('/offers/pdf-template/convert-docx', fd);
    document.getElementById('cbt-html').value = r.html;
    msgEl.className = 'msg ok';
    msgEl.textContent = r.warnings && r.warnings.length ? `Converted, with ${r.warnings.length} note(s): ${r.warnings.join('; ')}` : 'Converted - review and edit the HTML below before saving.';
  } catch (e) { msgEl.className = 'msg err'; msgEl.textContent = e.message; }
};
window.saveCustomBodyTemplate = async () => {
  const errEl = document.getElementById('cbt-err');
  errEl.style.display = 'none';
  try {
    await api('/offers/pdf-template/custom-body', { method: 'PUT', body: JSON.stringify({
      active: document.getElementById('cbt-active').checked, html: val('cbt-html'),
    })});
    navigate('offer-pdf-designer');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};

// GrapesJS canvases need to be visible/sized to lay themselves out
// correctly, so each tab's editor is only created the first time that tab
// is actually switched to (or, for the initial tab, right after this page's
// markup lands in the DOM) - not eagerly for all three up front.
async function initOfferPdfDesignerTab(pieceId) {
  if (PDF_DESIGNER_EDITORS[pieceId]) return; // already mounted this page visit - don't recreate and lose in-progress edits
  await loadOfferPdfDesignerAssets();
  const pieceCfg = PDF_DESIGNER_PIECES.find(p => p.id === pieceId);
  const data = (PDF_DESIGNER_LAYOUT && PDF_DESIGNER_LAYOUT[pieceId]) || {};
  const editor = grapesjs.init({
    container: '#pdfd-canvas-' + pieceId,
    height: pieceId === 'cover' ? '760px' : '340px',
    width: 'auto',
    fromElement: false,
    storageManager: false,
    plugins: ['grapesjs-preset-webpage', 'gjs-blocks-basic'],
    pluginsOpts: {
      'grapesjs-preset-webpage': {},
      // video/map are excluded - neither renders meaningfully in a static
      // printed PDF, so they'd just be dead weight in the block list.
      'gjs-blocks-basic': { blocks: ['column1', 'column2', 'column3', 'text', 'image', 'link'] },
    },
    deviceManager: {
      devices: [
        { id: 'pdf-' + pieceId, name: 'PDF', width: pieceCfg.width + 'px', height: pieceCfg.height + 'px' },
      ],
    },
  });
  try { editor.setDevice('PDF'); } catch (e) { /* non-fatal - editor still usable at its default device */ }
  // Style Manager's "Dimension" sector (margin/padding/width/height) starts
  // collapsed by default and is easy to miss behind a generic accordion
  // label - spacing is the single most-needed control when laying out a
  // header/footer, so auto-open it whenever something gets selected.
  editor.on('component:selected', () => {
    try {
      const dim = editor.StyleManager.getSector('dimension');
      if (dim) dim.set('open', true);
    } catch (e) { /* non-fatal - Style Manager still usable, just collapsed */ }
  });
  if (pieceCfg.smallText) {
    // Puppeteer's header/footer template context doesn't inherit the page's
    // CSS at all (see lib/offerPdf.js) - approximate its 10px Arial default
    // here too, so what's designed isn't wildly bigger than the real PDF.
    editor.on('load', () => {
      const doc = editor.Canvas.getDocument();
      if (!doc || !doc.body) return;
      doc.body.style.fontSize = '10px';
      doc.body.style.fontFamily = 'Arial, sans-serif';
      if (!doc.getElementById('pdfd-base-style')) {
        const style = doc.createElement('style');
        style.id = 'pdfd-base-style';
        style.textContent = 'body{font-size:10px;font-family:Arial,sans-serif;}';
        doc.head.appendChild(style);
      }
    });
  }
  if (data.project) {
    try { editor.loadProjectData(data.project); }
    catch (e) { console.error('offer-pdf-designer: failed to load saved project data for ' + pieceId, e); }
  }
  PDF_DESIGNER_EDITORS[pieceId] = editor;
}

window.switchOfferPdfDesignerTab = (id) => {
  if (PDF_DESIGNER_TAB === id) return;
  PDF_DESIGNER_TAB = id;
  document.querySelectorAll('.pdfd-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('.pdfd-panel').forEach(p => { p.style.display = p.dataset.piece === id ? '' : 'none'; });
  initOfferPdfDesignerTab(id);
};

function offerPdfDesignerToast(pieceId, msg, isErr) {
  const okEl = document.getElementById('pdfd-ok-' + pieceId);
  const errEl = document.getElementById('pdfd-err-' + pieceId);
  if (isErr) {
    if (okEl) okEl.style.display = 'none';
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  } else {
    if (errEl) errEl.style.display = 'none';
    if (okEl) { okEl.textContent = msg; okEl.style.display = 'block'; }
  }
}

window.insertOfferPdfDesignerToken = (pieceId, token) => {
  const text = '{{' + token + '}}';
  const editor = PDF_DESIGNER_EDITORS[pieceId];
  const selected = editor && editor.getSelected();
  if (selected) {
    try {
      selected.append(text);
      offerPdfDesignerToast(pieceId, 'Inserted ' + text + ' into the selected element.');
      return;
    } catch (e) { /* fall through to clipboard */ }
  }
  const copied = () => offerPdfDesignerToast(pieceId, 'Copied ' + text + ' to the clipboard - select a text element on the canvas first, or paste it in now.');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(copied).catch(() => alert('Merge field: ' + text));
  } else {
    alert('Merge field: ' + text);
  }
};

window.saveOfferPdfDesignerPiece = async (pieceId) => {
  const editor = PDF_DESIGNER_EDITORS[pieceId];
  if (!editor) { offerPdfDesignerToast(pieceId, 'Editor is not ready yet - try again in a moment.', true); return; }
  try {
    const html = editor.getHtml();
    const css = editor.getCss() || '';
    const project = editor.getProjectData();
    const active = document.getElementById('pdfd-active-' + pieceId).checked;
    // The endpoint returns the FULL {header,footer,cover} layout (matching
    // GET), not just this one piece - replace the whole cached copy, don't
    // nest it under pieceId.
    PDF_DESIGNER_LAYOUT = await api('/offers/pdf-layout/' + pieceId, {
      method: 'PUT',
      body: JSON.stringify({ active, html, css, project }),
    });
    offerPdfDesignerToast(pieceId, 'Saved.');
  } catch (e) { offerPdfDesignerToast(pieceId, e.message, true); }
};

// Shows the designed header/footer inside a full A4 page mockup, at the
// exact proportions generateOfferPdf() actually renders at (page.pdf()'s
// margin: top 30mm, bottom 26mm, left/right 15mm - lib/offerPdf.js). The
// isolated per-piece canvas above only ever shows the header/footer's own
// small strip, which was the whole complaint: no way to see how it sits
// against real body content or the page's other margins. Unlike the body,
// a designed header/footer spans the FULL page width with no left/right
// inset (see headerTemplate()/footerTemplate()'s Layout-Designer branch,
// which wraps designed html with no margin, vs the built-in default's own
// `margin:0 15mm`) - so this mockup deliberately does NOT inset the piece
// being previewed, only the placeholder body text, to show that difference
// rather than hide it.
window.previewOfferPdfDesignerFullPage = (pieceId) => {
  const editor = PDF_DESIGNER_EDITORS[pieceId];
  if (!editor) { offerPdfDesignerToast(pieceId, 'Editor is not ready yet - try again in a moment.', true); return; }
  const html = editor.getHtml();
  const css = editor.getCss() || '';
  const otherId = pieceId === 'header' ? 'footer' : 'header';
  const otherLabel = pieceId === 'header' ? 'Footer' : 'Header';
  const pieceLabel = pieceId === 'header' ? 'Header' : 'Footer';
  const placeholderBody = `
    <h2 style="font-size:14px;text-decoration:underline;margin:0 0 10px;">Sample Section Title</h2>
    <p style="margin:0 0 10px;">This placeholder text stands in for the offer's actual body content (Company Profile, Project Data Sheet, Scope Of Supply, etc.) so you can see how much room is left between the ${pieceLabel.toLowerCase()} and the rest of the page.</p>
    <p style="margin:0 0 10px;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>
    <p style="margin:0;">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>`;
  const otherPlaceholder = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px;font-family:Arial,sans-serif;border:1px dashed #ccc;box-sizing:border-box;">${esc(otherLabel)} area (design it on the ${esc(otherLabel)} tab to see it here too)</div>`;
  const headerContent = pieceId === 'header' ? `<style>${css}</style><div style="font-size:10px;font-family:Arial,sans-serif;">${html}</div>` : otherPlaceholder;
  const footerContent = pieceId === 'footer' ? `<style>${css}</style><div style="font-size:10px;font-family:Arial,sans-serif;">${html}</div>` : otherPlaceholder;
  const pageMockup = `
    <div style="width:210mm;min-height:297mm;background:#fff;margin:20px auto;box-shadow:0 0 12px rgba(0,0,0,.25);position:relative;overflow:hidden;font-family:Arial,sans-serif;">
      <div style="position:absolute;top:0;left:0;right:0;height:30mm;box-sizing:border-box;overflow:hidden;border-bottom:1px dotted #c00;">${headerContent}</div>
      <div style="position:absolute;top:30mm;bottom:26mm;left:15mm;right:15mm;box-sizing:border-box;overflow:hidden;">${placeholderBody}</div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:26mm;box-sizing:border-box;overflow:hidden;border-top:1px dotted #c00;">${footerContent}</div>
    </div>`;
  const bodyHTML = `
    <p class="muted" style="font-size:12px;">Actual A4 proportions (210mm x 297mm) at the real page margins this offer PDF prints with. The dotted red lines mark where the header/footer strip ends and the body's own margin begins - notice the header/footer span the full page width, while body text is inset 15mm on each side.</p>
    <div style="max-height:75vh;overflow:auto;background:#eee;padding:12px;border-radius:6px;">${pageMockup}</div>`;
  openMiniModal(pieceLabel + ' - Full Page Preview', bodyHTML, 860);
};

window.resetOfferPdfDesignerPiece = async (pieceId) => {
  if (!confirm('Reset this ' + pieceId + ' back to blank/inactive? This discards its saved design and cannot be undone.')) return;
  try {
    await api('/offers/pdf-layout/' + pieceId, { method: 'DELETE' });
    navigate('offer-pdf-designer');
  } catch (e) { alert(e.message); }
};

// ---- Users & Roles ----
// Roles whose Job Cards workbench depends on the user's ROLE matching one
// of these exactly (see lib/pipeline.js PIPELINE_STAGES/SUB_STAGES, plus
// Service) - used only to warn the Admin in the UI when department is left
// blank or looks mismatched, since that silently breaks the account's job
// card visibility with no obvious symptom (a real, previously-reported bug:
// an HOD set on a role but the tab was empty/missing because the account's
// department was blank or the role picked didn't actually match).
const DEPT_SCOPED_ROLE_NAMES = ['Design', 'Purchase', 'Electrical', 'Store', 'LaserBending', 'Manufacturing',
  'Fitting', 'Tacking', 'Welding', 'BuffingSandblast', 'Painting', 'Assembling', 'Packing', 'Shipping', 'Installation', 'Service'];
PAGES.users = async (el) => {
  const users = await api('/masters/users');
  const roles = await api('/masters/roles');
  const depts = await api('/masters/departments');
  const freeEmployees = await api('/masters/employees-without-login');
  window.__FREE_EMPLOYEES = freeEmployees;
  window.__USER_ROLES = roles; window.__USER_DEPTS = depts; window.__USER_CACHE = users;
  el.innerHTML = `
    <div class="panel"><h3>Add User</h3>
      <div class="form-grid">
        <div><label>Username</label><input id="us-username"></div>
        <div><label>Full Name</label><input id="us-name"></div>
        <div><label>Email (for welcome email &amp; password reset)</label><input id="us-email" type="email"></div>
        <div><label>Password</label><input id="us-pass" type="text" placeholder="Leave blank to auto-generate + email"></div>
        <div><label>Role</label><select id="us-role" onchange="checkUserDeptWarning()">${roles.map(r => `<option value="${r.id}" data-name="${esc(r.name)}">${esc(r.name)}</option>`).join('')}</select></div>
        <div><label>Department</label><select id="us-dept" onchange="checkUserDeptWarning()"><option value="">-</option>${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="us-supervisor" type="checkbox"> Supervisor / HOD (can act on every card in this role's queue, allocate work, and see the full department report)</label></div>
        <div><label>Employee (links this login to their HR/payroll record)</label>
          <select id="us-employee">
            <option value="">- No linked employee -</option>
            ${freeEmployees.map(e => `<option value="${e.id}">${esc(e.employee_code || '')} - ${esc(e.full_name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="us-dept-warning" class="msg err" style="display:none;margin-top:8px;"></div>
      <button class="btn" onclick="addUser()">Create User</button>
    </div>
    ${collapsiblePanel('users-list', `Users (${users.length})`, `
      ${tableHTML(['Username', 'Name', 'Email', 'Role', 'Department', 'Supervisor', 'Linked Employee', 'Status', 'Action'], users, u => `
        <tr><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.email)||'<span class="muted">Not set</span>'}</td><td>${esc(u.role)}</td><td>${esc(u.department)||'<span class="muted">Not set</span>'}</td>
        <td>${u.is_supervisor ? badge('active') : '-'}</td>
        <td>${u.employee_id ? esc(u.employee_code || '') + ' - ' + esc(u.employee_name) : '<span class="muted">Not linked</span>'}</td>
        <td>${badge(u.is_active ? 'active' : 'Rejected')}${u.must_change_password ? ' <span class="badge Pending" title="Must set their own password at next login">Pending activation</span>' : ''}</td>
        <td>${actionButtonsCell(`
          <button class="btn small outline" onclick="openEditUser(${u.id})">Edit</button>
          <button class="btn small outline" onclick="toggleUser(${u.id})">${u.is_active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn small outline" onclick="linkUserEmployee(${u.id})">${u.employee_id ? 'Change Link' : 'Link Employee'}</button>
        `)}</td></tr>`)}
    `)}
    <div class="panel" id="user-edit-panel" style="display:none;"><h3>Edit User</h3><div id="user-edit-body"></div></div>`;
};
// A role like Design/Purchase/LaserBending/etc. only gets its own "Job
// Cards" sidebar tab and workbench if the account ALSO has a Department set
// (see boot()'s DEPT_OWN_GROUP logic) - the role decides WHICH cards show,
// the department decides WHETHER the tab appears at all. Leaving department
// blank on one of these roles silently produces an account with no Job
// Cards tab whatsoever, which is easy to miss when creating a user.
window.checkUserDeptWarning = (prefix) => {
  prefix = prefix || 'us';
  const roleSel = document.getElementById(prefix + '-role');
  const deptSel = document.getElementById(prefix + '-dept');
  const warnEl = document.getElementById(prefix + '-dept-warning');
  if (!roleSel || !deptSel || !warnEl) return;
  const roleName = roleSel.selectedOptions[0] && roleSel.selectedOptions[0].getAttribute('data-name');
  if (DEPT_SCOPED_ROLE_NAMES.includes(roleName) && !deptSel.value) {
    warnEl.style.display = 'block';
    warnEl.textContent = `The "${roleName}" role needs a Department set, or this user won't get a Job Cards tab at all.`;
  } else {
    warnEl.style.display = 'none';
  }
};
window.addUser = async () => {
  try {
    const r = await api('/masters/users', { method: 'POST', body: JSON.stringify({
      username: val('us-username'), password: val('us-pass'), full_name: val('us-name'), email: val('us-email'), role_id: val('us-role'),
      department_id: val('us-dept') || null, employee_id: val('us-employee') || null,
      is_supervisor: document.getElementById('us-supervisor').checked,
    })});
    if (r.welcome_email && r.welcome_email.attempted) {
      alert(r.welcome_email.sent
        ? 'User created. A welcome email with login details was sent.'
        : `User created, but the welcome email was not sent: ${r.welcome_email.reason || 'unknown reason'}.${r.password_used ? ' Temporary password: ' + r.password_used : ''}`);
    } else if (r.password_used) {
      alert(`User created. No email on file, so nothing was sent - temporary password: ${r.password_used}`);
    }
    navigate('users');
  } catch (e) { alert(e.message); }
};
// Edit User (2026-10-13: converted from a bottom-of-page scroll-to panel to
// the generic popup - see openEditVendor's own comment for why). The
// #user-edit-panel bottom panel stays in the page for linkUserEmployee's
// own Change Link flow (not part of this ask) - independent now, no
// conflict since the popup is a floating overlay.
window.openEditUser = (id) => {
  const u = (window.__USER_CACHE || []).find(x => x.id === id);
  if (!u) return;
  const roles = window.__USER_ROLES || [];
  const depts = window.__USER_DEPTS || [];
  openAppModal('Edit User — ' + esc(u.username), `
    <div class="form-grid">
      <div><label>Full Name</label><input id="ue-name" value="${esc(u.full_name)}"></div>
      <div><label>Email</label><input id="ue-email" type="email" value="${esc(u.email)}"></div>
      <div><label>Role</label><select id="ue-role" onchange="checkUserDeptWarning('ue')">${roles.map(r => `<option value="${r.id}" data-name="${esc(r.name)}" ${r.id===u.role_id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div><label>Department</label><select id="ue-dept" onchange="checkUserDeptWarning('ue')"><option value="">-</option>${depts.map(d => `<option value="${d.id}" ${d.id===u.department_id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="ue-supervisor" type="checkbox" ${u.is_supervisor?'checked':''}> Supervisor / HOD</label></div>
      <div><label>Reset Password (optional)</label><input id="ue-pass" type="text" placeholder="Leave blank to keep current password"></div>
    </div>
    <div id="ue-dept-warning" class="msg err" style="display:none;margin-top:8px;"></div>
    <button class="btn" id="ue-save-btn" onclick="saveEditUser(${id})">Save Changes</button>
    <div id="ue-err" class="msg err" style="display:none;margin-top:8px;"></div>`);
  checkUserDeptWarning('ue');
};
window.saveEditUser = async (id) => {
  const errEl = document.getElementById('ue-err');
  try {
    const body = {
      full_name: val('ue-name'), email: val('ue-email'), role_id: val('ue-role'), department_id: val('ue-dept') || null,
      is_supervisor: document.getElementById('ue-supervisor').checked,
    };
    if (val('ue-pass').trim()) body.password = val('ue-pass').trim();
    await api(`/masters/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    confirmSavedThenClose('ue-save-btn', 'users');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.toggleUser = async (id) => {
  await api(`/masters/users/${id}/toggle`, { method: 'PATCH' });
  navigate('users');
};
// Opens the shared Edit-panel area with a searchable employee picker instead
// of the old native prompt() numbered list (2026-10-08) - that list was every
// active employee without a login, which in a real install runs into the
// hundreds; Chrome's prompt() dialog has no scrollbar once its text exceeds
// a fixed height, so anything past roughly the first 20 entries was simply
// unreachable, with no error or indication more existed beyond the "..." cutoff.
window.linkUserEmployee = async (id) => {
  const u = (window.__USER_CACHE || []).find(x => x.id === id);
  if (!u) return;
  const freeEmployees = window.__FREE_EMPLOYEES || await api('/masters/employees-without-login');
  // employees-without-login deliberately excludes every already-linked
  // employee, including this user's own current one - re-add it here so
  // "Change Link" shows (and defaults to) what's actually linked today,
  // not an empty/blank picker that looks like nothing is set.
  const options = u.employee_id && !freeEmployees.some(e => e.id === u.employee_id)
    ? [{ id: u.employee_id, employee_code: u.employee_code, full_name: u.employee_name }, ...freeEmployees]
    : freeEmployees;
  const panel = document.getElementById('user-edit-panel');
  document.getElementById('user-edit-body').innerHTML = `
    <h3 style="margin-top:0;">${u.employee_id ? 'Change' : 'Link'} Employee - ${esc(u.full_name)}</h3>
    <div class="form-grid">
      <div><label>Employee</label>${employeePickerHTML('lue-employee', options, u.employee_id)}</div>
    </div>
    <button class="btn" type="button" onclick="saveLinkUserEmployee(${id})">Save</button>
    <button class="btn outline" type="button" onclick="document.getElementById('user-edit-panel').style.display='none'">Cancel</button>
    ${u.employee_id ? `<button class="btn outline" type="button" style="margin-left:6px;" onclick="unlinkUserEmployee(${id})">Unlink</button>` : ''}
    <div id="lue-err" class="msg err" style="display:none;margin-top:8px;"></div>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.saveLinkUserEmployee = async (id) => {
  const errEl = document.getElementById('lue-err');
  errEl.style.display = 'none';
  const employee_id = val('lue-employee');
  if (!employee_id) { errEl.textContent = 'Pick an employee, or use Unlink to remove the current link.'; errEl.style.display = 'block'; return; }
  try {
    await api(`/masters/users/${id}/link-employee`, { method: 'PATCH', body: JSON.stringify({ employee_id: Number(employee_id) }) });
    navigate('users');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.unlinkUserEmployee = async (id) => {
  if (!confirm('Unlink this employee from the login?')) return;
  try {
    await api(`/masters/users/${id}/link-employee`, { method: 'PATCH', body: JSON.stringify({ employee_id: null }) });
    navigate('users');
  } catch (e) { alert(e.message); }
};

// ---- User Access (Admin only): which pages each role can see ----
PAGES.access = async (el) => {
  const data = await api('/admin/access');
  el.innerHTML = `
    <div class="panel">
      <h3>Access by User</h3>
      <p class="muted">Pick a person to see and change exactly what they can see, grouped the same way as the sidebar. Tick a whole group to grant every page in it at once, then expand the group to remove specific pages within it. Anything you don't touch here just follows their role's default access, configured further down.</p>
      <select id="au-user-select" onchange="loadUserAccess(this.value)"><option value="">Loading users...</option></select>
      <div id="au-body" style="margin-top:12px;"></div>
    </div>
    ${collapsiblePanel('extra-page-access', 'Grant Extra Page Access (Round 3)', `
      <p class="muted">On top of the role-based matrix below, grant one page either to an entire department (applies to every current AND future user in it) or to specific individual users. Useful for one-off exceptions without changing a whole role's config. This only makes a page <b>visible</b> - if it's a page where the user needs to actually submit/approve/manage something (e.g. Service & Spares), also grant Extra Permission Access or Cross-Department Oversight below for that role, or they'll see the page but get "Access denied: missing permission" when they try to act on it.</p>
      <div id="extra-access-form"></div>
      <div id="extra-access-list"></div>
    `)}
    ${collapsiblePanel('extra-permission-access', 'Grant Extra Permission Access', `
      <p class="muted">The other half of Extra Page Access above: grant one specific action permission (e.g. store.manage) to an entire department or to specific individual users, without widening it to their whole role via the Role Permissions matrix below. Pair this with Extra Page Access when someone needs to both see a page and actually act on it, without granting the whole role those rights.</p>
      <div id="extra-perm-form"></div>
      <div id="extra-perm-list"></div>
    `)}
    ${collapsiblePanel('role-oversight', 'Cross-Department Oversight (Round 22)', `
      <p class="muted">Grant a specific user full supervisor-level reach into another role's domain - Job Cards allocation, To-Do oversight, and any permission-gated page that role has - without changing that user's own role or department. For a real-world HOD who covers two departments (e.g. Electrical & Service) rather than actually merging those departments/roles. This grants back-end authority only; pair it with Extra Page Access above if their own role's page list doesn't already show the other department's pages.</p>
      <div id="role-oversight-form"></div>
      <div id="role-oversight-list"></div>
    `)}
    ${collapsiblePanel('access-by-role', 'User Access by Role', `
      <p class="muted">Tick the pages a role is allowed to see in the sidebar. A role with nothing configured (marked "Unrestricted") sees every page, same as today - saving any selection for a role switches it to that fixed list. Admin can always see everything and can't be restricted.</p>
      <div id="access-body"></div>
    `)}
    ${collapsiblePanel('role-permissions', 'Role Permissions', `
      <p class="muted">Tick the actions a role is allowed to perform (separate from page visibility above - a role can see a page and still be blocked from acting on it if it's missing the permission that page's actions check). Unlike page visibility, there's no "unrestricted by default" here - a role's own starting set is whatever was granted when the app was built; use this to add or remove from it, e.g. letting a non-Store role manage Item Master.</p>
      <div class="panel" style="margin-bottom:12px;">
        <label style="font-weight:600;">Scope for "Plan / Edit Department Targets - Spares projects"</label>
        <p class="muted" style="margin-top:2px;">Whoever is granted this permission below can open the Targets sheet's Plan/Edit Department Targets without needing Project Manager/Admin access. This one setting decides how far that reach goes, for every role it's granted to.</p>
        <select id="rp-spares-mode" style="margin-top:6px;">
          <option value="spares_only">Spares projects only (default) - a Standard project still needs project.manage</option>
          <option value="same_as_manage">Same as full Plan access - any project</option>
        </select>
        <button class="btn small" style="margin-left:8px;" onclick="saveProjectPlanSparesMode()">Save Scope</button>
      </div>
      <div id="role-perm-body"></div>
    `)}`;
  const sparesMode = await api('/settings/project-plan-spares-mode');
  document.getElementById('rp-spares-mode').value = sparesMode.mode;
  await renderUserAccessPanel(data.pageCatalog);
  await renderExtraAccessPanel(data.pageCatalog);
  await renderExtraPermissionAccessPanel();
  await renderRoleOversightPanel();
  await renderRolePermissionsPanel();
  const body = document.getElementById('access-body');
  // "User Access" and "Approval Matrix" are always Admin-only regardless of
  // any role's configured pages (see NAV's hardcoded filter), so offering
  // them as checkboxes here would be meaningless - ticking them would have
  // no visible effect for anyone but Admin.
  const catalogForRoles = filterAccessCatalog(data.pageCatalog);
  body.innerHTML = data.roles.filter(r => r.name !== 'Admin').map(r => `
    <div class="panel access-role-panel collapsed" style="margin-bottom:12px;" id="access-panel-${r.id}">
      <h4 class="access-role-head" onclick="toggleAccessRolePanel(${r.id})">
        <span>${esc(r.name)} ${r.configured ? '<span class="badge OnHold">Restricted</span>' : '<span class="muted">(Unrestricted - sees everything)</span>'}</span>
        <span class="chev">&#9660;</span>
      </h4>
      <div class="access-grid" id="access-role-${r.id}">
        ${catalogForRoles.map(g => {
          const groupIds = g.items.map(it => it.id);
          const checkedCount = groupIds.filter(id => !r.configured || (r.allowedPages||[]).includes(id)).length;
          return `
          <div class="access-group">
            <div class="access-group-title">
              <label style="margin:0;cursor:pointer;font-weight:inherit;">
                <input type="checkbox" class="ar-group-toggle" data-role="${r.id}" data-group="${esc(g.group)}" ${checkedCount === groupIds.length ? 'checked' : ''} onchange="toggleArGroup(this)">
                ${esc(g.group)}
              </label>
            </div>
            ${g.items.map(it => `
              <label class="access-item"><input type="checkbox" class="ar-page" data-role="${r.id}" data-group="${esc(g.group)}" value="${it.id}" ${(!r.configured || (r.allowedPages||[]).includes(it.id)) ? 'checked' : ''}> ${esc(it.label)}</label>
            `).join('')}
          </div>`;
        }).join('')}
      </div>
      <div class="access-role-actions" style="margin-top:10px;">
        <button class="btn small" onclick="saveAccess(${r.id})">Save Access for ${esc(r.name)}</button>
        ${r.configured ? `<button class="btn small outline" onclick="resetAccess(${r.id})">Reset to Unrestricted</button>` : ''}
      </div>
    </div>`).join('');
};
window.toggleAccessRolePanel = (roleId) => {
  const panel = document.getElementById(`access-panel-${roleId}`);
  if (panel) panel.classList.toggle('collapsed');
};
// Module/group-level "select all" header (2026-10-08) - ticking the group
// checkbox grants or revokes every page in that module for this role at
// once, instead of clicking each page individually; mirrors the per-user
// screen's own au-group-toggle above, just scoped by role too since every
// role's panel renders on this same page simultaneously (the per-user
// screen only ever shows one user's panel at a time, so it didn't need the
// extra scoping).
window.toggleArGroup = (checkbox) => {
  const role = checkbox.dataset.role, group = checkbox.dataset.group;
  document.querySelectorAll('.ar-page').forEach(cb => {
    if (cb.dataset.role === role && cb.dataset.group === group) cb.checked = checkbox.checked;
  });
};
// "User Access" and "Approval Matrix" are always Admin-only client-side
// (see NAV's hardcoded filter above) no matter what any role/user access
// config says - shared by the role matrix and the per-user screen below so
// neither offers a checkbox that can never actually do anything.
function filterAccessCatalog(pageCatalog) {
  return pageCatalog
    .map(g => ({ group: g.group, items: g.items.filter(it => it.id !== 'access' && it.id !== 'approval-matrix') }))
    .filter(g => g.items.length);
}
// Role Permissions (2026-10-09) - grant/revoke an action-level permission
// code per role, admin-UI-driven and freely revocable (unlike a boot-time
// bootstrap*() grant in db/index.js, which re-applies on every restart and
// so can never actually be taken away through the app). Same accordion/
// group-toggle/checkbox shape as the User Access by Role matrix above, just
// over lib/permissionCatalog.js's PERMISSION_CATALOG instead of pages.
async function renderRolePermissionsPanel() {
  const data = await api('/admin/permissions');
  window.__PERMISSION_CATALOG = data.permissionCatalog;
  const body = document.getElementById('role-perm-body');
  body.innerHTML = data.roles.map(r => `
    <div class="panel access-role-panel collapsed" style="margin-bottom:12px;" id="rp-panel-${r.id}">
      <h4 class="access-role-head" onclick="toggleRolePermPanel(${r.id})">
        <span>${esc(r.name)} <span class="muted">(${r.grantedCodes.length} permission${r.grantedCodes.length === 1 ? '' : 's'} granted)</span></span>
        <span class="chev">&#9660;</span>
      </h4>
      <div class="access-grid" id="rp-role-${r.id}">
        ${data.permissionCatalog.map(g => {
          const groupCodes = g.items.map(it => it.code);
          const checkedCount = groupCodes.filter(c => r.grantedCodes.includes(c)).length;
          return `
          <div class="access-group">
            <div class="access-group-title">
              <label style="margin:0;cursor:pointer;font-weight:inherit;">
                <input type="checkbox" class="rp-group-toggle" data-role="${r.id}" data-group="${esc(g.group)}" ${checkedCount === groupCodes.length ? 'checked' : ''} onchange="toggleRpGroup(this)">
                ${esc(g.group)}
              </label>
            </div>
            ${g.items.map(it => `
              <label class="access-item"><input type="checkbox" class="rp-code" data-role="${r.id}" data-group="${esc(g.group)}" value="${esc(it.code)}" ${r.grantedCodes.includes(it.code) ? 'checked' : ''}> ${esc(it.label)}</label>
            `).join('')}
          </div>`;
        }).join('')}
      </div>
      <div class="access-role-actions" style="margin-top:10px;">
        <button class="btn small" onclick="saveRolePermissions(${r.id})">Save Permissions for ${esc(r.name)}</button>
      </div>
    </div>`).join('');
}
window.toggleRolePermPanel = (roleId) => {
  const panel = document.getElementById(`rp-panel-${roleId}`);
  if (panel) panel.classList.toggle('collapsed');
};
window.saveProjectPlanSparesMode = async () => {
  const mode = document.getElementById('rp-spares-mode').value;
  try {
    await api('/settings/project-plan-spares-mode', { method: 'PUT', body: JSON.stringify({ mode }) });
    alert('Scope saved.');
  } catch (e) { alert(e.message); }
};
window.toggleRpGroup = (checkbox) => {
  const role = checkbox.dataset.role, group = checkbox.dataset.group;
  document.querySelectorAll('.rp-code').forEach(cb => {
    if (cb.dataset.role === role && cb.dataset.group === group) cb.checked = checkbox.checked;
  });
};
window.saveRolePermissions = async (roleId) => {
  const codes = Array.from(document.querySelectorAll(`.rp-code[data-role="${roleId}"]:checked`)).map(cb => cb.value);
  try {
    await api(`/admin/permissions/${roleId}`, { method: 'PUT', body: JSON.stringify({ codes }) });
    await renderRolePermissionsPanel();
  } catch (e) { alert(e.message); }
};
async function renderUserAccessPanel(pageCatalog) {
  const users = await api('/masters/users');
  const selectEl = document.getElementById('au-user-select');
  const selectable = users.filter(u => u.role !== 'Admin' && u.is_active);
  selectEl.innerHTML = `<option value="">- Select a user -</option>` +
    selectable.map(u => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.role)}${u.department ? ' - ' + esc(u.department) : ''})</option>`).join('');
}
window.loadUserAccess = async (userId) => {
  const bodyEl = document.getElementById('au-body');
  if (!userId) { bodyEl.innerHTML = ''; return; }
  const data = await api('/admin/access/user/' + userId);
  window.__AU_DATA = data;
  const catalog = filterAccessCatalog(data.pageCatalog);
  const allIds = catalog.flatMap(g => g.items.map(it => it.id));
  const effective = new Set(data.baselinePages === null ? allIds : data.baselinePages.filter(id => allIds.includes(id)));
  Object.entries(data.overrides).forEach(([pid, access]) => {
    if (access === 'granted') effective.add(pid); else effective.delete(pid);
  });
  bodyEl.innerHTML = `
    <p class="muted">${esc(data.user.full_name)} &mdash; Role: ${esc(data.user.role_name)}${data.user.department_name ? ' &middot; ' + esc(data.user.department_name) : ''}
      ${data.roleConfigured ? '' : ' <span class="muted">(role is Unrestricted by default - everything below starts checked unless you uncheck it)</span>'}</p>
    ${catalog.map(g => {
      const groupIds = g.items.map(it => it.id);
      const checkedCount = groupIds.filter(id => effective.has(id)).length;
      const groupKey = 'au-group-' + g.group.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return collapsiblePanel(groupKey, `
        <label style="margin:0;" onclick="event.stopPropagation();">
          <input type="checkbox" class="au-group-toggle" data-group="${esc(g.group)}" ${checkedCount === groupIds.length ? 'checked' : ''} onchange="toggleAuGroup(this)">
          <b>${esc(g.group)}</b>
        </label> <span class="muted">(${checkedCount}/${groupIds.length})</span>
      `, `
        ${g.items.map(it => `<label class="access-item" style="display:block;"><input type="checkbox" class="au-page" data-group="${esc(g.group)}" value="${it.id}" ${effective.has(it.id) ? 'checked' : ''}> ${esc(it.label)}</label>`).join('')}
      `);
    }).join('')}
    <div style="margin-top:10px;">
      <button class="btn" onclick="saveUserAccess()">Save Access for ${esc(data.user.full_name)}</button>
      <button class="btn outline" onclick="resetUserAccess()">Reset to Role Default</button>
    </div>
    <div id="au-err" class="msg err" style="display:none;margin-top:10px;"></div>`;
};
window.toggleAuGroup = (checkbox) => {
  const group = checkbox.dataset.group;
  document.querySelectorAll('.au-page').forEach(cb => { if (cb.dataset.group === group) cb.checked = checkbox.checked; });
};
window.saveUserAccess = async () => {
  const data = window.__AU_DATA;
  if (!data) return;
  const baselineSet = new Set(data.baselinePages === null ? ALL_PAGE_CATALOG_IDS(data.pageCatalog) : data.baselinePages);
  const overrides = {};
  document.querySelectorAll('.au-page').forEach(cb => {
    const inBaseline = baselineSet.has(cb.value);
    if (cb.checked && !inBaseline) overrides[cb.value] = 'granted';
    else if (!cb.checked && inBaseline) overrides[cb.value] = 'revoked';
    // else matches the role/extra-access baseline already - no override needed
  });
  const errEl = document.getElementById('au-err');
  try {
    await api('/admin/access/user/' + data.user.id, { method: 'PUT', body: JSON.stringify({ overrides }) });
    loadUserAccess(data.user.id);
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.resetUserAccess = async () => {
  const data = window.__AU_DATA;
  if (!data) return;
  if (!confirm(`Reset ${data.user.full_name}'s access back to their role's default? This removes every individual override for them.`)) return;
  await api('/admin/access/user/' + data.user.id, { method: 'PUT', body: JSON.stringify({ overrides: {} }) });
  loadUserAccess(data.user.id);
};
function ALL_PAGE_CATALOG_IDS(pageCatalog) { return pageCatalog.flatMap(g => g.items.map(it => it.id)); }
async function renderExtraAccessPanel(pageCatalog) {
  const [depts, users, extras] = await Promise.all([api('/masters/departments'), api('/masters/users'), api('/admin/extra-access')]);
  const allPages = pageCatalog.flatMap(g => g.items);
  const formEl = document.getElementById('extra-access-form');
  formEl.innerHTML = `
    <div class="form-grid">
      <div><label>Scope</label><select id="ea-scope" onchange="toggleEAscope()"><option value="Department">Entire Department</option><option value="User">Specific Users</option></select></div>
      <div id="ea-dept-wrap"><label>Department</label><select id="ea-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div id="ea-users-wrap" style="display:none;grid-column:1/-1;"><label>Users</label>
        <div style="max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:5px;padding:6px;">
          ${users.map(u => `<label style="display:block;font-weight:normal;"><input type="checkbox" class="ea-user" value="${u.id}"> ${esc(u.full_name)} (${esc(u.department)||'-'})</label>`).join('')}
        </div>
      </div>
      <div><label>Page</label><select id="ea-page">${allPages.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></div>
    </div>
    <button class="btn small" onclick="saveExtraAccess()">Grant Access</button>`;
  const listEl = document.getElementById('extra-access-list');
  listEl.innerHTML = extras.length ? tableHTML(['Scope', 'Target', 'Page', ''], extras, e => `
    <tr><td>${esc(e.scope)}</td><td>${esc(e.scope === 'Department' ? e.department_name : e.user_name)}</td><td>${esc((allPages.find(p=>p.id===e.page_id)||{}).label || e.page_id)}</td>
    <td><button class="btn small outline" onclick="removeExtraAccess(${e.id})">Remove</button></td></tr>`) : '<div class="empty">No extra grants yet.</div>';
}
window.toggleEAscope = () => {
  const isDept = val('ea-scope') === 'Department';
  document.getElementById('ea-dept-wrap').style.display = isDept ? '' : 'none';
  document.getElementById('ea-users-wrap').style.display = isDept ? 'none' : '';
};
window.saveExtraAccess = async () => {
  const scope = val('ea-scope');
  const page_id = val('ea-page');
  try {
    if (scope === 'Department') {
      await api('/admin/extra-access', { method: 'POST', body: JSON.stringify({ scope, department_id: val('ea-dept'), page_id }) });
    } else {
      const ids = Array.from(document.querySelectorAll('.ea-user:checked')).map(b => Number(b.value));
      if (!ids.length) { alert('Pick at least one user.'); return; }
      await api('/admin/extra-access', { method: 'POST', body: JSON.stringify({ scope, user_ids: ids, page_id }) });
    }
    navigate('access');
  } catch (e) { alert(e.message); }
};
window.removeExtraAccess = async (id) => {
  await api('/admin/extra-access/' + id, { method: 'DELETE' });
  navigate('access');
};
async function renderExtraPermissionAccessPanel() {
  const [depts, users, permData, extras] = await Promise.all([
    api('/masters/departments'), api('/masters/users'), api('/admin/permissions'), api('/admin/extra-permission-access')
  ]);
  const allCodes = permData.permissionCatalog.flatMap(g => g.items);
  const formEl = document.getElementById('extra-perm-form');
  formEl.innerHTML = `
    <div class="form-grid">
      <div><label>Scope</label><select id="epa-scope" onchange="toggleEPAscope()"><option value="Department">Entire Department</option><option value="User">Specific Users</option></select></div>
      <div id="epa-dept-wrap"><label>Department</label><select id="epa-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div id="epa-users-wrap" style="display:none;grid-column:1/-1;"><label>Users</label>
        <div style="max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:5px;padding:6px;">
          ${users.map(u => `<label style="display:block;font-weight:normal;"><input type="checkbox" class="epa-user" value="${u.id}"> ${esc(u.full_name)} (${esc(u.department)||'-'})</label>`).join('')}
        </div>
      </div>
      <div><label>Permission</label><select id="epa-code">${permData.permissionCatalog.map(g => `<optgroup label="${esc(g.group)}">${g.items.map(it => `<option value="${esc(it.code)}">${esc(it.label)}</option>`).join('')}</optgroup>`).join('')}</select></div>
    </div>
    <button class="btn small" onclick="saveExtraPermissionAccess()">Grant Permission</button>`;
  const listEl = document.getElementById('extra-perm-list');
  listEl.innerHTML = extras.length ? tableHTML(['Scope', 'Target', 'Permission', ''], extras, e => `
    <tr><td>${esc(e.scope)}</td><td>${esc(e.scope === 'Department' ? e.department_name : e.user_name)}</td><td>${esc((allCodes.find(p=>p.code===e.permission_code)||{}).label || e.permission_code)}</td>
    <td><button class="btn small outline" onclick="removeExtraPermissionAccess(${e.id})">Remove</button></td></tr>`) : '<div class="empty">No extra permission grants yet.</div>';
}
window.toggleEPAscope = () => {
  const isDept = val('epa-scope') === 'Department';
  document.getElementById('epa-dept-wrap').style.display = isDept ? '' : 'none';
  document.getElementById('epa-users-wrap').style.display = isDept ? 'none' : '';
};
window.saveExtraPermissionAccess = async () => {
  const scope = val('epa-scope');
  const permission_code = val('epa-code');
  try {
    if (scope === 'Department') {
      await api('/admin/extra-permission-access', { method: 'POST', body: JSON.stringify({ scope, department_id: val('epa-dept'), permission_code }) });
    } else {
      const ids = Array.from(document.querySelectorAll('.epa-user:checked')).map(b => Number(b.value));
      if (!ids.length) { alert('Pick at least one user.'); return; }
      await api('/admin/extra-permission-access', { method: 'POST', body: JSON.stringify({ scope, user_ids: ids, permission_code }) });
    }
    navigate('access');
  } catch (e) { alert(e.message); }
};
window.removeExtraPermissionAccess = async (id) => {
  await api('/admin/extra-permission-access/' + id, { method: 'DELETE' });
  navigate('access');
};
async function renderRoleOversightPanel() {
  const [users, roles, grants] = await Promise.all([api('/masters/users'), api('/masters/roles'), api('/admin/role-oversight')]);
  const nonAdminRoles = roles.filter(r => r.name !== 'Admin');
  const formEl = document.getElementById('role-oversight-form');
  formEl.innerHTML = `
    <div class="form-grid">
      <div><label>User (the HOD/supervisor being granted oversight)</label>
        <select id="ro-user">${users.map(u => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.department)||'-'})</option>`).join('')}</select></div>
      <div><label>Grant Oversight Of Role</label>
        <select id="ro-role">${nonAdminRoles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
    </div>
    <button class="btn small" onclick="saveRoleOversight()">Grant Oversight</button>`;
  const listEl = document.getElementById('role-oversight-list');
  listEl.innerHTML = grants.length ? tableHTML(['User', 'Oversees Role', ''], grants, g => `
    <tr><td>${esc(g.user_name)}</td><td>${esc(g.oversees_role_name)}</td>
    <td><button class="btn small outline" onclick="removeRoleOversight(${g.id})">Revoke</button></td></tr>`) : '<div class="empty">No cross-department oversight grants yet.</div>';
}
window.saveRoleOversight = async () => {
  try {
    await api('/admin/role-oversight', { method: 'POST', body: JSON.stringify({ user_id: val('ro-user'), oversees_role_id: val('ro-role') }) });
    navigate('access');
  } catch (e) { alert(e.message); }
};
window.removeRoleOversight = async (id) => {
  await api('/admin/role-oversight/' + id, { method: 'DELETE' });
  navigate('access');
};
window.saveAccess = async (roleId) => {
  // Only the per-page checkboxes carry a real page id as their value - the
  // group-level "select all" checkboxes added above have none, and would
  // otherwise leak a bogus empty/"on" entry into pageIds if selected here too.
  const boxes = document.querySelectorAll(`#access-role-${roleId} input.ar-page`);
  const pageIds = Array.from(boxes).filter(b => b.checked).map(b => b.value);
  try {
    await api(`/admin/access/${roleId}`, { method: 'PUT', body: JSON.stringify({ page_ids: pageIds }) });
    navigate('access');
  } catch (e) { alert(e.message); }
};
window.resetAccess = async (roleId) => {
  await api(`/admin/access/${roleId}`, { method: 'DELETE' });
  navigate('access');
};

// ---- Approval Matrix (Admin only) ----
PAGES['approval-matrix'] = async (el) => {
  const data = await api('/admin/approval-matrix');
  el.innerHTML = `
    <div class="panel">
      <h3>Approval Matrix</h3>
      <p class="muted">Configure who approves each kind of request, in order, and at what value each step kicks in. "Requires HOD/Supervisor" means only the department head for that role can act on that step - not just anyone holding the role. Admin can always act at any step regardless of this matrix.</p>
    </div>
    <div id="matrix-body"></div>`;
  const body = document.getElementById('matrix-body');
  body.innerHTML = data.chains.map(c => `
    <div class="panel" style="margin-bottom:12px;">
      <h4 style="margin:0 0 4px;">${esc(c.name)}</h4>
      <p class="muted" style="margin-top:0;">${esc(c.description)||''}</p>
      <div id="matrix-chain-${c.id}"></div>
      <button class="btn small outline" type="button" onclick="addMatrixStep(${c.id})">+ Add Step</button>
      <button class="btn small" onclick="saveMatrixChain(${c.id})" style="margin-left:8px;">Save ${esc(c.name)}</button>
    </div>`).join('');
  window.__MATRIX_ROLES = data.roles;
  data.chains.forEach(c => renderMatrixSteps(c.id, c.steps));
};
function renderMatrixSteps(chainId, steps) {
  const el = document.getElementById('matrix-chain-' + chainId);
  const roles = window.__MATRIX_ROLES || [];
  el.innerHTML = `<table><thead><tr><th>Step</th><th>Approver Role</th><th>Min. Amount (₹)</th><th>Requires HOD/Supervisor</th><th></th></tr></thead>
    <tbody id="matrix-rows-${chainId}">
      ${steps.map((s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><select class="mx-role">${roles.map(r => `<option value="${r.id}" ${r.id===s.approver_role_id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></td>
          <td><input class="mx-amount" type="number" value="${s.min_amount||0}" style="width:110px;"></td>
          <td style="text-align:center;"><input class="mx-hod" type="checkbox" ${s.requires_supervisor ? 'checked' : ''}></td>
          <td><button class="btn small outline" type="button" onclick="this.closest('tr').remove()">Remove</button></td>
        </tr>`).join('')}
    </tbody></table>`;
}
window.addMatrixStep = (chainId) => {
  const tbody = document.getElementById('matrix-rows-' + chainId);
  const roles = window.__MATRIX_ROLES || [];
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${tbody.children.length + 1}</td>
    <td><select class="mx-role">${roles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></td>
    <td><input class="mx-amount" type="number" value="0" style="width:110px;"></td>
    <td style="text-align:center;"><input class="mx-hod" type="checkbox"></td>
    <td><button class="btn small outline" type="button" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
};
window.saveMatrixChain = async (chainId) => {
  const rows = document.querySelectorAll(`#matrix-rows-${chainId} tr`);
  const steps = Array.from(rows).map(tr => ({
    approver_role_id: Number(tr.querySelector('.mx-role').value),
    min_amount: Number(tr.querySelector('.mx-amount').value) || 0,
    requires_supervisor: tr.querySelector('.mx-hod').checked,
  }));
  try {
    await api(`/admin/approval-matrix/${chainId}`, { method: 'PUT', body: JSON.stringify({ steps }) });
    navigate('approval-matrix');
  } catch (e) { alert(e.message); }
};

// ===================== Round 5: Company Settings =====================
PAGES['company-settings'] = async (el) => {
  const [company, email, inboundMail, purchaseInboundMail, purchaseSettings, departments, sidebarOrderResp, emailTemplates, weeklyDigest, dailyPurchaseDigest] = await Promise.all([
    api('/settings/company'), api('/settings/email').catch(() => null),
    api('/settings/inbound-mail').catch(() => null), api('/settings/purchase-inbound-mail').catch(() => null),
    api('/settings/purchase').catch(() => null),
    api('/masters/departments'),
    api('/settings/sidebar-group-order').catch(() => ({ order: [] })),
    api('/admin/email-templates').catch(() => []),
    api('/settings/weekly-digest').catch(() => null),
    api('/settings/daily-purchase-digest').catch(() => null),
  ]);
  // Every group label the Admin might want to position: the 11 static NAV
  // groups, plus every real department name (covers both the per-login
  // "<department> Job Cards" own-group and, since the Admin/PM per-department
  // tabs - Design/Laser & Bending Processing/Manufacturing - are themselves
  // named after real departments, those too). Deduped since a department can
  // share a label with a static group (e.g. "Purchase").
  const sidebarGroupLabels = Array.from(new Set([...NAV.map(g => g.group), ...departments.map(d => d.name)]));
  const sidebarGroupOrder = resolvePanelOrder(sidebarOrderResp.order, sidebarGroupLabels);
  el.innerHTML = `
    ${collapsiblePanel('company-details', 'Company Details', `
      <div class="form-grid">
        <div><label>Legal Name</label><input id="cs-legal" value="${esc(company.legal_name)}"></div>
        <div><label>Trade Name</label><input id="cs-trade" value="${esc(company.trade_name)}"></div>
        <div><label>GSTIN</label><input id="cs-gstin" value="${esc(company.gstin)}"></div>
        <div><label>PAN</label><input id="cs-pan" value="${esc(company.pan)}"></div>
        <div><label>CIN</label><input id="cs-cin" value="${esc(company.cin)}"></div>
        <div><label>State</label>${statePickerHTML('cs-state', company.state)}</div>
        <div><label>State Code</label><input id="cs-state-code" value="${esc(company.state_code)}"></div>
        <div><label>Default Place of Supply</label><input id="cs-pos" value="${esc(company.default_place_of_supply)}"></div>
        <div><label>Default GST Rate (%)</label><input id="cs-gst-rate" type="number" value="${esc(company.default_gst_rate)}"></div>
      </div>
      <div><label>Registered Address</label><textarea id="cs-reg-addr" rows="2" style="width:100%;">${esc(company.registered_address)}</textarea></div>
      <div><label>Factory/Branch Address</label><textarea id="cs-factory-addr" rows="2" style="width:100%;">${esc(company.factory_address)}</textarea></div>
      <h4>Bank Details (for receiving payments)</h4>
      <div class="form-grid">
        <div><label>Bank Name</label><input id="cs-bank-name" value="${esc(company.bank_name)}"></div>
        <div><label>Account Number</label><input id="cs-bank-acc" value="${esc(company.bank_account_number)}"></div>
        <div><label>IFSC</label><input id="cs-bank-ifsc" value="${esc(company.bank_ifsc)}"></div>
        <div><label>Branch</label><input id="cs-bank-branch" value="${esc(company.bank_branch)}"></div>
      </div>
      <h4>Authorized Signatory</h4>
      <p class="muted">Every signed document prints "Authorized Signatory" as line 1; the designation below prints as line 2, per document type (e.g. "Head of Purchase", "Head of Sales").</p>
      <div class="form-grid">
        <div><label>Purchase Order</label><input id="cs-sig-po" value="${esc(company.po_signatory_designation)}" placeholder="e.g. Head of Purchase"></div>
        <div><label>Sales Invoice</label><input id="cs-sig-sinv" value="${esc(company.sales_invoice_signatory_designation)}" placeholder="e.g. Head of Sales"></div>
        <div><label>Proforma Invoice</label><input id="cs-sig-proforma" value="${esc(company.proforma_signatory_designation)}" placeholder="e.g. Head of Sales"></div>
        <div><label>Order Confirmation</label><input id="cs-sig-oc" value="${esc(company.order_confirmation_signatory_designation)}" placeholder="e.g. Head of Sales"></div>
        <div><label>Foreign Payment</label><input id="cs-sig-fp" value="${esc(company.foreign_payment_signatory_designation)}" placeholder="e.g. Head of Accounts"></div>
      </div>
      <h4>Logo</h4>
      ${company.logo_path ? `<img src="${esc(company.logo_path)}" style="max-height:60px;display:block;margin-bottom:8px;">` : ''}
      <input type="file" id="cs-logo-file" accept="image/*">
      <button class="btn small outline" type="button" onclick="uploadCompanyLogo()">Upload Logo</button>
      <div style="margin-top:12px;">
        <button class="btn" onclick="saveCompanySettings()">Save Company Details</button>
      </div>
      <div id="cs-err" class="msg err" style="display:none;margin-top:8px;"></div>
    `)}
    <div id="co-addresses-panel"></div>
    ${collapsiblePanel('email-settings', 'Email Settings', `
      ${email ? collapsibleSubsection('email-settings-smtp', 'SMTP Settings', `
        <p class="muted">DB values here override the SMTP_* environment variables. Leave blank to fall back to env vars. If neither is set, automated emails are skipped gracefully with a clear message.</p>
        <div class="form-grid">
          <div><label>SMTP Host</label><input id="es-host" value="${esc(email.smtp_host)}"></div>
          <div><label>SMTP Port</label><input id="es-port" type="number" value="${esc(email.smtp_port)}"></div>
          <div><label>SMTP User</label><input id="es-user" value="${esc(email.smtp_user)}"></div>
          <div><label>SMTP Password</label><input id="es-pass" type="password" value="${esc(email.smtp_pass)}"></div>
          <div><label>Use TLS/SSL (secure)</label><select id="es-secure"><option value="false" ${!email.smtp_secure ? 'selected' : ''}>No</option><option value="true" ${email.smtp_secure ? 'selected' : ''}>Yes</option></select></div>
          <div><label>From Name</label><input id="es-from-name" value="${esc(email.from_name)}"></div>
          <div><label>From Address</label><input id="es-from-addr" value="${esc(email.from_address)}"></div>
        </div>
        <div><label>Always CC (comma-separated)</label><input id="es-cc" style="width:100%;" value="${esc((email.cc_list||[]).join(', '))}"></div>
        <button class="btn" onclick="saveEmailSettings()" style="margin-top:10px;">Save Email Settings</button>
        <div id="es-err" class="msg err" style="display:none;margin-top:8px;"></div>
        <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">
          <div class="form-grid">
            <div><label>Send Test Email To</label><input id="es-test-to" placeholder="you@example.com"></div>
            <div style="align-self:end;"><button class="btn small outline" type="button" onclick="sendTestEmail()">Send Test Email</button></div>
          </div>
          <p class="muted">Sends a one-off test message using whatever's saved above (or the SMTP_* env vars if left blank) - the quickest way to confirm delivery actually works.</p>
          <div id="es-test-result" class="msg" style="display:none;"></div>
        </div>
      `) : ''}
      ${inboundMail ? collapsibleSubsection('inbound-mail-settings', 'Inbound Mail (Service Requests via Email)', `
        <p class="muted">Reads a dedicated mailbox over IMAP. A genuinely new request automatically creates a Service Request and routes it to the Service HOD/Supervisor for approval (My Approvals) - a follow-up in an existing conversation is appended to that request instead of creating a new one, and a message that can't be processed automatically is quarantined for manual review. See the Service Requests page's Incoming Requests panel for the acknowledgement-email template and the review queue.</p>
        <div class="form-grid">
          <div><label>Enabled</label><select id="im-enabled"><option value="false" ${!inboundMail.enabled ? 'selected' : ''}>No</option><option value="true" ${inboundMail.enabled ? 'selected' : ''}>Yes</option></select></div>
          <div><label>IMAP Host</label><input id="im-host" value="${esc(inboundMail.imap_host)}"></div>
          <div><label>IMAP Port</label><input id="im-port" type="number" value="${esc(inboundMail.imap_port)}"></div>
          <div><label>Use TLS/SSL (secure)</label><select id="im-secure"><option value="false" ${!inboundMail.imap_secure ? 'selected' : ''}>No</option><option value="true" ${inboundMail.imap_secure ? 'selected' : ''}>Yes</option></select></div>
          <div><label>Mailbox Username</label><input id="im-user" value="${esc(inboundMail.imap_user)}"></div>
          <div><label>Mailbox Password</label><input id="im-pass" type="password" value="${esc(inboundMail.imap_pass)}"></div>
          <div><label>Folder</label><input id="im-mailbox" value="${esc(inboundMail.mailbox)}"></div>
          <div><label>Poll Every (minutes)</label><input id="im-poll" type="number" value="${esc(inboundMail.poll_minutes)}"></div>
          <div><label>Scan Window (days)</label><input id="im-scan-window" type="number" value="${esc(inboundMail.scan_window_days)}"></div>
        </div>
        <p class="muted" style="font-size:12px;">Scan Window bounds how far back each poll looks for unread mail - turning this on for the first time (or after an extended outage) won't flood the approval queue with a mailbox's entire unread backlog.</p>
        <button class="btn" onclick="saveInboundMailSettings()" style="margin-top:10px;">Save Inbound Mail Settings</button>
        <button class="btn small outline" type="button" onclick="testInboundMailConnection()" style="margin-top:10px;">Test Connection</button>
        <div id="im-err" class="msg err" style="display:none;margin-top:8px;"></div>
        <div id="im-test-result" class="msg" style="display:none;margin-top:8px;"></div>
      `) : ''}
      ${purchaseInboundMail ? collapsibleSubsection('purchase-inbound-mail-settings', 'Inbound Mail (Vendor Quote Responses via Email)', `
        <p class="muted">Reads a dedicated mailbox over IMAP - separate from the Service inbox above - and drops each vendor reply into the Purchase team's Vendor Quote Responses queue (see the Purchase Requests page) for confirmation into a real quote. Nothing is auto-created from an email without a human confirming it.</p>
        <div class="form-grid">
          <div><label>Enabled</label><select id="pim-enabled"><option value="false" ${!purchaseInboundMail.enabled ? 'selected' : ''}>No</option><option value="true" ${purchaseInboundMail.enabled ? 'selected' : ''}>Yes</option></select></div>
          <div><label>IMAP Host</label><input id="pim-host" value="${esc(purchaseInboundMail.imap_host)}"></div>
          <div><label>IMAP Port</label><input id="pim-port" type="number" value="${esc(purchaseInboundMail.imap_port)}"></div>
          <div><label>Use TLS/SSL (secure)</label><select id="pim-secure"><option value="false" ${!purchaseInboundMail.imap_secure ? 'selected' : ''}>No</option><option value="true" ${purchaseInboundMail.imap_secure ? 'selected' : ''}>Yes</option></select></div>
          <div><label>Mailbox Username</label><input id="pim-user" value="${esc(purchaseInboundMail.imap_user)}"></div>
          <div><label>Mailbox Password</label><input id="pim-pass" type="password" value="${esc(purchaseInboundMail.imap_pass)}"></div>
          <div><label>Folder</label><input id="pim-mailbox" value="${esc(purchaseInboundMail.mailbox)}"></div>
          <div><label>Poll Every (minutes)</label><input id="pim-poll" type="number" value="${esc(purchaseInboundMail.poll_minutes)}"></div>
        </div>
        <button class="btn" onclick="savePurchaseInboundMailSettings()" style="margin-top:10px;">Save Inbound Mail Settings</button>
        <button class="btn small outline" type="button" onclick="testPurchaseInboundMailConnection()" style="margin-top:10px;">Test Connection</button>
        <div id="pim-err" class="msg err" style="display:none;margin-top:8px;"></div>
        <div id="pim-test-result" class="msg" style="display:none;margin-top:8px;"></div>
      `) : ''}
      ${email ? collapsibleSubsection('department-email-identities', 'Department Email Identities', `
        <p class="muted">Each department can have its own genuinely separate SMTP mailbox - not just a "From" display name riding on the one shared account above - so a department's own emails actually authenticate as that department's own mailbox instead of risking a "Sender is not allowed to relay" rejection when the From address doesn't match the account that logged in. Leave a department's SMTP fields blank and it keeps relaying through the global Email Settings account above, with just its From Name/Address (also optional) shown on the mail. Expand a department to configure either.</p>
        ${departments.map(d => collapsiblePanel('dept-email-' + d.id, `${esc(d.name)}${d.smtp_host ? ' <span class="badge active" style="font-size:10px;">Own SMTP</span>' : (d.email_from_address ? ' <span class="muted" style="font-size:11px;">(From override only)</span>' : '')}`, `
          <div class="form-grid">
            <div><label>From Name</label><input id="dept-from-name-${d.id}" value="${esc(d.email_from_name)}" placeholder="${esc(email ? email.from_name : '')}"></div>
            <div><label>From Address</label><input id="dept-from-addr-${d.id}" value="${esc(d.email_from_address)}" placeholder="${esc(email ? email.from_address : '')}"></div>
          </div>
          <h5 style="margin:12px 0 4px;">Separate SMTP Account <span class="muted" style="font-weight:normal;">(optional - leave blank to keep relaying through the global account above)</span></h5>
          <div class="form-grid">
            <div><label>SMTP Host</label><input id="dept-smtp-host-${d.id}" value="${esc(d.smtp_host)}"></div>
            <div><label>SMTP Port</label><input id="dept-smtp-port-${d.id}" type="number" value="${esc(d.smtp_port)}"></div>
            <div><label>Use TLS/SSL (secure)</label><select id="dept-smtp-secure-${d.id}"><option value="" ${d.smtp_secure === null || d.smtp_secure === undefined ? 'selected' : ''}>- Use global default -</option><option value="false" ${d.smtp_secure === 0 ? 'selected' : ''}>No</option><option value="true" ${d.smtp_secure === 1 ? 'selected' : ''}>Yes</option></select></div>
            <div><label>Mailbox Username</label><input id="dept-smtp-user-${d.id}" value="${esc(d.smtp_user)}"></div>
            <div><label>Mailbox Password</label><input id="dept-smtp-pass-${d.id}" type="password" value="${esc(d.smtp_pass)}"></div>
          </div>
          <div style="margin-top:8px;">
            <button class="btn small" type="button" onclick="saveDepartmentEmailIdentity(${d.id})">Save</button>
            <button class="btn small outline" type="button" onclick="testDepartmentEmail(${d.id}, '${esc(d.name).replace(/'/g, "\\'")}')">Send Test Email</button>
          </div>
          <div id="dept-email-err-${d.id}" class="msg err" style="display:none;margin-top:8px;"></div>
        `)).join('')}
      `) : ''}
    `)}
    ${purchaseSettings ? collapsiblePanel('purchase-settings', 'Purchase Settings', `
      <div class="form-grid">
        <div><label>Vendor Quote Threshold (₹)</label><input id="ps-quote-threshold" type="number" value="${esc(purchaseSettings.quote_threshold)}"></div>
        <div><label>RFQ Portal Link Validity (days)</label><input id="ps-rfq-expiry" type="number" min="1" max="365" value="${esc(purchaseSettings.rfq_default_expiry_days || 14)}"></div>
      </div>
      <label>Payment Terms Options <span class="muted">(one per line - feeds the Payment Terms dropdown on the Purchase Order form)</span></label>
      <textarea id="ps-payment-terms" rows="6" style="width:100%;">${esc((purchaseSettings.payment_terms_options||[]).join('\n'))}</textarea>
      <div style="margin-top:10px;">
        <label><input type="checkbox" id="ps-allow-pending-email" ${purchaseSettings.allow_pending_po_email ? 'checked' : ''}>
          Allow emailing/downloading a Purchase Order that's still pending approval <span class="muted">(shows a "Pending Approval" banner on the document - off by default, since a PO can't be sent to a vendor until Purchase HOD/Management sign off)</span></label>
      </div>
      <h4 style="margin-top:18px;">PO Document Template</h4>
      <p class="muted">Controls every Purchase Order PDF/Word document generated from now on - not a per-order setting.</p>
      <label>Default Terms &amp; Conditions <span class="muted">(pre-fills a new PO's Terms field when left blank; also what the document falls back to if a specific PO's own Terms is blank)</span></label>
      ${richTextToolbarHTML('ps-default-po-terms')}
      <textarea id="ps-default-po-terms" rows="4" style="width:100%;">${esc(purchaseSettings.default_po_terms)}</textarea>
      ${richTextLegendHTML()}
      <label style="margin-top:10px;">Delivery Guidelines <span class="muted">(a standing instruction - packaging, labeling, delivery-slip requirements etc. - printed identically on every PO, right after Terms & Conditions; not editable per-order)</span></label>
      ${richTextToolbarHTML('ps-delivery-guidelines')}
      <textarea id="ps-delivery-guidelines" rows="4" style="width:100%;">${esc(purchaseSettings.delivery_guidelines)}</textarea>
      ${richTextLegendHTML()}
      <label style="margin-top:10px;display:block;">Fields visible on the PO document</label>
      <div class="form-grid">
        ${[
          ['delivery_date', 'Delivery Date'], ['payment_terms', 'Payment Terms'], ['ld_terms', 'LD Terms'],
          ['freight', 'Freight / Freight GST'], ['status', 'Status'], ['vendor_contact', 'Vendor Contact (address/phone)'],
          ['terms', 'Terms & Conditions'], ['delivery_guidelines', 'Delivery Guidelines'],
        ].map(([key, label]) => `<div><label><input type="checkbox" class="ps-po-vis" data-key="${key}" ${(purchaseSettings.po_visible_fields||{})[key] !== false ? 'checked' : ''}> ${esc(label)}</label></div>`).join('')}
      </div>
      <button class="btn" onclick="savePurchaseSettings()" style="margin-top:10px;">Save Purchase Settings</button>
      <div id="ps-err" class="msg err" style="display:none;margin-top:8px;"></div>
    `) : ''}
    ${collapsiblePanel('email-template-customizer', 'Email Template Customizer', `
      <p class="muted">Pick a template to see and edit its current subject/body - a template left untouched keeps sending the same built-in text it always has. {{tokens}} are plain mail-merge placeholders filled in automatically when the email is sent; leave them exactly as shown to keep that behavior.</p>
      <div class="form-grid">
        <div><label>Template</label><select id="etc-key" onchange="etcTemplateChanged()">
          ${emailTemplates.map(t => `<option value="${esc(t.key)}">${esc(t.label)}${t.is_customized ? ' (customized)' : ''}</option>`).join('')}
        </select></div>
      </div>
      <div id="etc-body"></div>
    `)}
    ${weeklyDigest ? collapsiblePanel('weekly-digest', 'Weekly Approval Digest', `
      <p class="muted">A weekly, department-wise email summarizing every pending approval sitting with that department, color-coded by how many days it's been waiting - separate from the per-item "awaiting your approval" email and the 24h/12h escalation reminder, which keep firing as before. This is the one approval-related email that still copies the Company Settings Email Settings CC list. A department with nothing pending still gets a short "all clear" email that week.</p>
      <div class="form-grid">
        <div><label><input type="checkbox" id="wd-enabled" ${weeklyDigest.enabled ? 'checked' : ''}> Enabled</label></div>
        <div><label>Day of week</label><select id="wd-day">
          ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => `<option value="${i}" ${Number(weeklyDigest.day_of_week) === i ? 'selected' : ''}>${d}</option>`).join('')}
        </select></div>
        <div><label>Hour (server time, 24h)</label><select id="wd-hour">
          ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${Number(weeklyDigest.hour) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
        </select></div>
      </div>
      <div class="form-grid" style="margin-top:4px;">
        <div><label>Green bucket - up to this many days</label><input id="wd-bucket1" type="number" min="0" value="${esc(weeklyDigest.bucket1_max_days)}"></div>
        <div><label>Amber bucket - up to this many days</label><input id="wd-bucket2" type="number" min="1" value="${esc(weeklyDigest.bucket2_max_days)}"></div>
        <div><label class="muted" style="display:block;margin-top:24px;">Beyond the amber cutoff is Red.</label></div>
      </div>
      <button class="btn" id="wd-save-btn" onclick="saveWeeklyDigestSettings()" style="margin-top:10px;">Save Weekly Digest Settings</button>
      <div id="wd-err" class="msg err" style="display:none;margin-top:8px;"></div>
      ${weeklyDigest.last_sent_at ? `<p class="muted" style="margin-top:6px;">Last sent ${new Date(weeklyDigest.last_sent_at).toLocaleString()}.</p>` : `<p class="muted" style="margin-top:6px;">Not sent yet.</p>`}
    `) : ''}
    ${dailyPurchaseDigest ? collapsiblePanel('daily-purchase-digest', 'Daily Purchase Digest', `
      <p class="muted">A daily email with the Purchase Velocity snapshot (PR → PO, PO → Approval, PO → GRN, Open POs and PRs), a call-out of every open PO and PR older than 5 days, and an Excel attachment listing all open PO lines and PR items. Sent once a day at the time below (IST); a restart never re-sends it.</p>
      <div class="form-grid">
        <div><label><input type="checkbox" id="dpd-enabled" ${dailyPurchaseDigest.enabled ? 'checked' : ''}> Enabled</label></div>
        <div><label>Send time (IST, 24h)</label><input type="time" id="dpd-time" value="${esc(dailyPurchaseDigest.send_time)}"></div>
        <div><label><input type="checkbox" id="dpd-hod" ${dailyPurchaseDigest.include_hod_management ? 'checked' : ''}> Also send to Purchase HOD(s) and Management</label></div>
      </div>
      <div style="margin-top:4px;"><label class="muted" style="display:block;margin-bottom:3px;">Extra recipients (comma-separated emails)</label>
        <textarea id="dpd-recipients" rows="2" style="width:100%;" placeholder="name@company.com, other@company.com">${esc(dailyPurchaseDigest.recipients)}</textarea></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <button class="btn" id="dpd-save-btn" onclick="saveDailyPurchaseDigest()">Save Daily Purchase Digest</button>
        <button class="btn outline" id="dpd-send-btn" onclick="sendDailyPurchaseDigestNow()">Send Daily Purchase Report Now</button>
      </div>
      <div id="dpd-err" class="msg err" style="display:none;margin-top:8px;"></div>
      <div id="dpd-ok" class="msg ok" style="display:none;margin-top:8px;"></div>
      ${dailyPurchaseDigest.last_sent_at ? `<p class="muted" style="margin-top:6px;">Last scheduled send ${esc(dailyPurchaseDigest.last_sent_at)}.</p>` : `<p class="muted" style="margin-top:6px;">No scheduled send yet.</p>`}
    `) : ''}
    ${collapsiblePanel('sidebar-group-order', 'Sidebar Group Order', `
      <p class="muted">Sets one sidebar group order that applies to every user, replacing the default alphabetical order. Includes every department-specific "Job Cards" group (a department's own tab, and the Admin/Project Manager per-department tabs) alongside the regular menu groups, so those can be positioned too instead of always sitting wherever they land by default.</p>
      <div class="muted" style="margin-bottom:8px;">Drag a group by its ⠿ handle to rearrange, then Save Order.
        <button class="btn small outline" type="button" onclick="saveSidebarGroupOrder()" style="margin-left:8px;">Save Order</button>
        <button class="btn small outline" type="button" onclick="resetSidebarGroupOrder()">Reset to Default</button>
      </div>
      <div id="sidebar-order-list">${sidebarGroupOrder.map(label => `
        <div class="reorder-panel" draggable="true" data-key="${esc(label)}"
          ondragstart="panelDragStart(event)" ondragover="panelDragOver(event,'sidebar-order-list')" ondragend="panelDragEnd(event)"
          style="padding:8px 10px;border:1px solid var(--border,#ddd);border-radius:6px;margin-bottom:4px;cursor:move;">
          <span style="color:var(--muted,#888);">&#10021;</span> ${esc(label)}
        </div>`).join('')}</div>
      <div id="sg-err" class="msg err" style="display:none;margin-top:8px;"></div>
    `)}
  `;
  window.__EMAIL_TEMPLATES = emailTemplates;
  renderCompanyAddressesPanel();
  etcTemplateChanged();
};
window.etcTemplateChanged = () => {
  const bodyEl = document.getElementById('etc-body');
  if (!bodyEl) return;
  const key = val('etc-key');
  const tpl = (window.__EMAIL_TEMPLATES || []).find(t => t.key === key);
  if (!tpl) { bodyEl.innerHTML = ''; return; }
  bodyEl.innerHTML = `
    <p class="muted" style="margin-top:10px;">${esc(tpl.description)}</p>
    <p><b>Variables available:</b> ${tpl.variables.map(v => `<code>{{${esc(v)}}}</code>`).join(', ')}</p>
    <div class="form-grid"><div><label>Subject</label><input id="etc-subject" value="${esc(tpl.subject)}"></div></div>
    <div class="form-grid"><div><label>Body</label><textarea id="etc-body-text" rows="8">${esc(tpl.body)}</textarea></div></div>
    <div style="margin-top:10px;">
      <button class="btn" id="etc-save-btn" onclick="saveEmailTemplate()">Save Template</button>
      ${tpl.is_customized ? `<button class="btn small outline" type="button" onclick="resetEmailTemplateField()">Reset to Default</button>` : ''}
    </div>
    <div id="etc-err" class="msg err" style="display:none;margin-top:8px;"></div>
    ${tpl.is_customized ? `<p class="muted" style="margin-top:6px;">Last customized ${new Date(tpl.updated_at).toLocaleString()}.</p>` : ''}
  `;
};
window.resetEmailTemplateField = async () => {
  if (!confirm('Restore this template to its original built-in wording? Your customization will be lost.')) return;
  const key = val('etc-key');
  try {
    await api(`/admin/email-templates/${key}`, { method: 'DELETE' });
    navigate('company-settings');
  } catch (e) { alert(e.message); }
};
window.saveEmailTemplate = async () => {
  const errEl = document.getElementById('etc-err');
  errEl.style.display = 'none';
  const key = val('etc-key');
  try {
    await api(`/admin/email-templates/${key}`, { method: 'PUT', body: JSON.stringify({
      subject: val('etc-subject'), body: document.getElementById('etc-body-text').value,
    })});
    confirmSavedThenClose('etc-save-btn', 'company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.saveWeeklyDigestSettings = async () => {
  const errEl = document.getElementById('wd-err');
  errEl.style.display = 'none';
  try {
    await api('/settings/weekly-digest', { method: 'PUT', body: JSON.stringify({
      enabled: document.getElementById('wd-enabled').checked,
      day_of_week: val('wd-day'), hour: val('wd-hour'),
      bucket1_max_days: val('wd-bucket1'), bucket2_max_days: val('wd-bucket2'),
    })});
    confirmSavedThenClose('wd-save-btn', 'company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
// Daily Purchase Digest settings (see lib/purchaseDailyDigest.js)
const dpdBody = () => ({
  enabled: document.getElementById('dpd-enabled').checked,
  send_time: val('dpd-time'),
  include_hod_management: document.getElementById('dpd-hod').checked,
  recipients: val('dpd-recipients'),
});
window.saveDailyPurchaseDigest = async () => {
  const errEl = document.getElementById('dpd-err');
  errEl.style.display = 'none';
  try {
    await api('/settings/daily-purchase-digest', { method: 'PUT', body: JSON.stringify(dpdBody()) });
    confirmSavedThenClose('dpd-save-btn', 'company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
// Saves what's on screen first, so the test send uses the recipients just typed, then sends immediately.
window.sendDailyPurchaseDigestNow = async () => {
  const errEl = document.getElementById('dpd-err'), okEl = document.getElementById('dpd-ok'), btn = document.getElementById('dpd-send-btn');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending...';
  try {
    await api('/settings/daily-purchase-digest', { method: 'PUT', body: JSON.stringify(dpdBody()) });
    const r = await api('/settings/daily-purchase-digest/send', { method: 'POST' });
    okEl.textContent = `Sent to ${r.recipients.length} recipient(s): ${r.recipients.join(', ')}. ${r.open_pos} open PO(s) (${r.over_5_pos} older than 5 days), ${r.open_prs} open PR(s) (${r.over_5_prs} older than 5 days).`;
    okEl.style.display = 'block';
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  finally { btn.disabled = false; btn.textContent = label; }
};
window.saveSidebarGroupOrder = async () => {
  const order = Array.from(document.querySelectorAll('#sidebar-order-list .reorder-panel')).map(w => w.dataset.key);
  const errEl = document.getElementById('sg-err');
  errEl.style.display = 'none';
  try {
    const r = await api('/settings/sidebar-group-order', { method: 'PUT', body: JSON.stringify({ order }) });
    SIDEBAR_GROUP_ORDER = r.order || order;
    renderSidebar();
    alert('Sidebar group order saved.');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.resetSidebarGroupOrder = async () => {
  if (!confirm('Reset the sidebar back to its default order?')) return;
  try {
    const r = await api('/settings/sidebar-group-order', { method: 'PUT', body: JSON.stringify({ order: [] }) });
    SIDEBAR_GROUP_ORDER = r.order || [];
    renderSidebar();
    navigate('company-settings');
  } catch (e) { alert(e.message); }
};
window.saveDepartmentEmailIdentity = async (id) => {
  const errEl = document.getElementById(`dept-email-err-${id}`);
  errEl.style.display = 'none';
  const secureVal = val(`dept-smtp-secure-${id}`);
  try {
    await api(`/masters/departments/${id}`, { method: 'PUT', body: JSON.stringify({
      email_from_name: val(`dept-from-name-${id}`), email_from_address: val(`dept-from-addr-${id}`),
      smtp_host: val(`dept-smtp-host-${id}`), smtp_port: val(`dept-smtp-port-${id}`),
      smtp_user: val(`dept-smtp-user-${id}`), smtp_pass: val(`dept-smtp-pass-${id}`),
      smtp_secure: secureVal === '' ? undefined : secureVal === 'true',
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.testDepartmentEmail = async (id, deptName) => {
  const to = prompt(`Send a test email using ${deptName}'s mail settings to:`);
  if (!to) return;
  const errEl = document.getElementById(`dept-email-err-${id}`);
  errEl.style.display = 'none';
  try {
    const r = await api(`/masters/departments/${id}/test-email`, { method: 'POST', body: JSON.stringify({ to }) });
    alert(r.sent ? `Sent successfully to ${to}. Check that inbox to confirm.` : (r.reason || 'Failed to send.'));
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
async function renderCompanyAddressesPanel() {
  const panel = document.getElementById('co-addresses-panel');
  if (!panel) return;
  const addresses = await api('/settings/company-addresses');
  const addrRow = (a) => `<tr>
      <td>${esc(a.address_type)}${a.is_default ? ' <span class="badge active">Default</span>' : ''}</td>
      <td>${esc(a.label)||'-'}</td>
      <td>${[a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).map(esc).join(', ')}</td>
      <td>${esc(a.gstin)||'-'}</td>
      <td><button class="btn small outline" onclick="deleteCompanyAddress(${a.id})">Delete</button></td>
    </tr>`;
  panel.innerHTML = collapsiblePanel('company-addresses', 'Company Bill-to / Ship-to Addresses', `
      <p class="muted">Separate factory/office locations, each selectable when creating a Purchase Order so the right address flows into the PO's PDF/Word document.</p>
      ${tableHTML(['Type', 'Label', 'Address', 'GSTIN', ''], addresses, addrRow)}
      <div class="form-grid" style="margin-top:10px;">
        <div><label>Type</label><select id="coaddr-type"><option value="Billing">Billing</option><option value="Shipping">Shipping</option></select></div>
        <div><label>Label</label><input id="coaddr-label" placeholder="e.g. Head Office, Factory - Faridabad"></div>
        <div><label>GSTIN</label><input id="coaddr-gstin"></div>
        <div style="grid-column:1/-1;"><label>Address Line 1</label><input id="coaddr-line1"></div>
        <div style="grid-column:1/-1;"><label>Address Line 2</label><input id="coaddr-line2"></div>
        <div><label>City</label><input id="coaddr-city"></div>
        <div><label>State</label>${statePickerHTML('coaddr-state', '')}</div>
        <div><label>State Code</label><input id="coaddr-state-code" placeholder="e.g. 06"></div>
        <div><label>Pincode</label><input id="coaddr-pincode"></div>
        <div style="display:flex;align-items:center;gap:6px;padding-top:22px;"><label style="margin:0;"><input id="coaddr-default" type="checkbox"> Set as default for this type</label></div>
      </div>
      <button class="btn" onclick="addCompanyAddress()">Add Address</button>
      <div id="coaddr-err" class="msg err" style="display:none;margin-top:10px;"></div>
    `);
}
window.addCompanyAddress = async () => {
  const errEl = document.getElementById('coaddr-err');
  errEl.style.display = 'none';
  try {
    await api('/settings/company-addresses', { method: 'POST', body: JSON.stringify({
      address_type: val('coaddr-type'), label: val('coaddr-label'), line1: val('coaddr-line1'), line2: val('coaddr-line2'),
      city: val('coaddr-city'), state: val('coaddr-state'), state_code: val('coaddr-state-code'), pincode: val('coaddr-pincode'),
      gstin: val('coaddr-gstin'), is_default: document.getElementById('coaddr-default').checked,
    })});
    renderCompanyAddressesPanel();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteCompanyAddress = async (id) => {
  if (!confirm('Delete this address?')) return;
  try { await api('/settings/company-addresses/' + id, { method: 'DELETE' }); renderCompanyAddressesPanel(); }
  catch (e) { alert(e.message); }
};
window.saveCompanySettings = async () => {
  const errEl = document.getElementById('cs-err'); errEl.style.display = 'none';
  try {
    await api('/settings/company', { method: 'PUT', body: JSON.stringify({
      legal_name: val('cs-legal'), trade_name: val('cs-trade'), gstin: val('cs-gstin'), pan: val('cs-pan'), cin: val('cs-cin'),
      state: val('cs-state'), state_code: val('cs-state-code'), default_place_of_supply: val('cs-pos'), default_gst_rate: val('cs-gst-rate'),
      registered_address: val('cs-reg-addr'), factory_address: val('cs-factory-addr'),
      bank_name: val('cs-bank-name'), bank_account_number: val('cs-bank-acc'), bank_ifsc: val('cs-bank-ifsc'), bank_branch: val('cs-bank-branch'),
      po_signatory_designation: val('cs-sig-po'), sales_invoice_signatory_designation: val('cs-sig-sinv'),
      proforma_signatory_designation: val('cs-sig-proforma'), order_confirmation_signatory_designation: val('cs-sig-oc'),
      foreign_payment_signatory_designation: val('cs-sig-fp'),
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.uploadCompanyLogo = async () => {
  const fileEl = document.getElementById('cs-logo-file');
  if (!fileEl.files.length) { alert('Choose a logo image first.'); return; }
  const fd = new FormData(); fd.append('logo', fileEl.files[0]);
  try { await apiUpload('/settings/company/logo', fd, 'POST'); navigate('company-settings'); } catch (e) { alert(e.message); }
};
window.saveEmailSettings = async () => {
  const errEl = document.getElementById('es-err'); errEl.style.display = 'none';
  try {
    await api('/settings/email', { method: 'PUT', body: JSON.stringify({
      smtp_host: val('es-host'), smtp_port: val('es-port'), smtp_user: val('es-user'), smtp_pass: val('es-pass'),
      smtp_secure: val('es-secure') === 'true', from_name: val('es-from-name'), from_address: val('es-from-addr'), cc_list: val('es-cc'),
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.sendTestEmail = async () => {
  const resultEl = document.getElementById('es-test-result');
  const to = val('es-test-to');
  if (!to) { alert('Enter an email address to send the test to.'); return; }
  resultEl.className = 'msg';
  resultEl.style.display = 'block';
  resultEl.textContent = 'Sending...';
  try {
    const r = await api('/settings/email/test', { method: 'POST', body: JSON.stringify({ to }) });
    resultEl.className = r.sent ? 'msg ok' : 'msg err';
    resultEl.textContent = r.sent ? `Sent successfully to ${to}. Check that inbox to confirm.` : (r.reason || 'Failed to send - check the SMTP settings above.');
  } catch (e) {
    resultEl.className = 'msg err';
    resultEl.textContent = e.message;
  }
};
// Lightweight formatting toolbar for the two PO Document Template textareas
// (2026-10-09) - deliberately NOT a contenteditable/WYSIWYG editor (this app
// has no rich-text editor anywhere else to reuse, and browser-generated
// contenteditable HTML is inconsistent across browsers to parse reliably).
// Instead the buttons wrap/prefix the textarea's own plain-text selection
// with a small fixed token vocabulary (**bold**, *italic*, ++underline++,
// [color=NAME]/[size=NAME], a leading "- "/"1. " for lists) that
// lib/richText.js (both lib/poPdf.js and lib/poDocx.js) parses the exact
// same way server-side. Storage stays a plain string - a value saved before
// this existed has no tokens in it, so it renders identically to before, no
// migration needed. Color/size buttons just wrap the current selection like
// bold/italic/underline do, so they freely nest/combine with each other and
// with bold/italic/underline (e.g. bold a selection, then re-select the same
// now-**wrapped** text and apply a color) - a deliberately small closed
// palette/size set (not a free color picker/arbitrary pt size) so the
// printed PO can't end up looking like an accidental mix of colors/sizes;
// must match lib/richText.js's own COLOR_HEX/SIZE_PX keys exactly.
const RT_COLORS = [['red', '#C0392B'], ['blue', '#2563EB'], ['green', '#15803D'], ['orange', '#D97706']];
function richTextToolbarHTML(textareaId) {
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;align-items:center;">
    <button type="button" class="btn small outline" onclick="rtWrapSelection('${textareaId}','**','**')" title="Bold"><b>B</b></button>
    <button type="button" class="btn small outline" onclick="rtWrapSelection('${textareaId}','*','*')" title="Italic"><i>I</i></button>
    <button type="button" class="btn small outline" onclick="rtWrapSelection('${textareaId}','++','++')" title="Underline"><u>U</u></button>
    <button type="button" class="btn small outline" onclick="rtPrefixLines('${textareaId}','bullet')" title="Bullet list">&bull; List</button>
    <button type="button" class="btn small outline" onclick="rtPrefixLines('${textareaId}','number')" title="Numbered list">1. List</button>
    <button type="button" class="btn small outline" onclick="rtPrefixLines('${textareaId}','none')" title="Remove list formatting">Clear List</button>
    <span style="width:1px;height:20px;background:var(--border);display:inline-block;margin:0 2px;"></span>
    ${RT_COLORS.map(([name, hex]) => `<button type="button" class="btn small outline" style="padding:2px 8px;" onclick="rtWrapSelection('${textareaId}','[color=${name}]','[/color]')" title="${esc(name[0].toUpperCase()+name.slice(1))} text"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${hex};vertical-align:middle;"></span></button>`).join('')}
    <button type="button" class="btn small outline" onclick="rtWrapSelection('${textareaId}','[size=small]','[/size]')" title="Small text">A<sub>-</sub></button>
    <button type="button" class="btn small outline" onclick="rtWrapSelection('${textareaId}','[size=large]','[/size]')" title="Large text">A<sup>+</sup></button>
  </div>`;
}
function richTextLegendHTML() {
  return `<p class="muted" style="margin:2px 0 0;font-size:11px;">Formatting: <b>**bold**</b>, <i>*italic*</i>, <u>++underline++</u>, [color=red/blue/green/orange]...[/color], [size=small/large]...[/size], a line starting with "- " for a bullet, "1. " for a numbered list - or just use the buttons above (color/size buttons apply to whatever text is currently selected).</p>`;
}
window.rtWrapSelection = (textareaId, before, after) => {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || 'text';
  ta.value = ta.value.slice(0, start) + before + selected + after + ta.value.slice(end);
  ta.focus();
  ta.setSelectionRange(start + before.length, start + before.length + selected.length);
};
window.rtPrefixLines = (textareaId, mode) => {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  const value = ta.value;
  const lineStart = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let lineEnd = value.indexOf('\n', ta.selectionEnd);
  if (lineEnd === -1) lineEnd = value.length;
  let n = 1;
  const newBlock = value.slice(lineStart, lineEnd).split('\n').map(line => {
    const stripped = line.replace(/^(-\s+|\d+\.\s+)/, '');
    if (mode === 'bullet') return '- ' + stripped;
    if (mode === 'number') return (n++) + '. ' + stripped;
    return stripped;
  }).join('\n');
  ta.value = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
  ta.focus();
  ta.setSelectionRange(lineStart, lineStart + newBlock.length);
};
window.savePurchaseSettings = async () => {
  const errEl = document.getElementById('ps-err'); errEl.style.display = 'none';
  try {
    const paymentTerms = document.getElementById('ps-payment-terms').value.split('\n').map(s => s.trim()).filter(Boolean);
    // po_visible_fields is a nested object stored via a shallow Object.assign
    // merge server-side (lib/settings.js) - always send every key, never a
    // partial diff, or an untouched key would be silently dropped.
    const poVisibleFields = {};
    document.querySelectorAll('.ps-po-vis').forEach(cb => { poVisibleFields[cb.dataset.key] = cb.checked; });
    await api('/settings/purchase', { method: 'PUT', body: JSON.stringify({
      quote_threshold: val('ps-quote-threshold'), rfq_default_expiry_days: Number(val('ps-rfq-expiry')) || 14, payment_terms_options: paymentTerms,
      allow_pending_po_email: document.getElementById('ps-allow-pending-email').checked,
      default_po_terms: val('ps-default-po-terms'), delivery_guidelines: val('ps-delivery-guidelines'), po_visible_fields: poVisibleFields,
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.saveInboundMailSettings = async () => {
  const errEl = document.getElementById('im-err'); errEl.style.display = 'none';
  try {
    await api('/settings/inbound-mail', { method: 'PUT', body: JSON.stringify({
      enabled: val('im-enabled') === 'true', imap_host: val('im-host'), imap_port: val('im-port'),
      imap_secure: val('im-secure') === 'true', imap_user: val('im-user'), imap_pass: val('im-pass'),
      mailbox: val('im-mailbox'), poll_minutes: val('im-poll'), scan_window_days: val('im-scan-window'),
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.testInboundMailConnection = async () => {
  const resultEl = document.getElementById('im-test-result');
  resultEl.className = 'msg';
  resultEl.style.display = 'block';
  resultEl.textContent = 'Connecting...';
  try {
    const r = await api('/settings/inbound-mail/test', { method: 'POST' });
    resultEl.className = r.ok ? 'msg ok' : 'msg err';
    resultEl.textContent = r.ok ? 'Connected successfully.' : (r.reason || 'Connection failed.');
  } catch (e) {
    resultEl.className = 'msg err';
    resultEl.textContent = e.message;
  }
};
window.savePurchaseInboundMailSettings = async () => {
  const errEl = document.getElementById('pim-err'); errEl.style.display = 'none';
  try {
    await api('/settings/purchase-inbound-mail', { method: 'PUT', body: JSON.stringify({
      enabled: val('pim-enabled') === 'true', imap_host: val('pim-host'), imap_port: val('pim-port'),
      imap_secure: val('pim-secure') === 'true', imap_user: val('pim-user'), imap_pass: val('pim-pass'),
      mailbox: val('pim-mailbox'), poll_minutes: val('pim-poll'),
    })});
    navigate('company-settings');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.testPurchaseInboundMailConnection = async () => {
  const resultEl = document.getElementById('pim-test-result');
  resultEl.className = 'msg';
  resultEl.style.display = 'block';
  resultEl.textContent = 'Connecting...';
  try {
    const r = await api('/settings/purchase-inbound-mail/test', { method: 'POST' });
    resultEl.className = r.ok ? 'msg ok' : 'msg err';
    resultEl.textContent = r.ok ? 'Connected successfully.' : (r.reason || 'Connection failed.');
  } catch (e) {
    resultEl.className = 'msg err';
    resultEl.textContent = e.message;
  }
};

// Proforma Invoice surcharge field (2026-11-23) - Packing & Forwarding,
// Courier Charges and Insurance all used to be two separate inputs (a %
// box and a flat-₹-override box shown at once); replaced with one input
// plus a Percentage/Amount type selector so only the relevant field shows.
// Whichever mode is selected is simply the one key sent to the backend
// (the other is sent blank) - computeProformaCharges() in routes/finance.js
// already treats "amount given" as an override of percent, so no backend
// schema/logic change was needed beyond adding the new Insurance pair of
// columns. Shared by both the New Proforma form (prefix "pf") and the Edit
// Draft Proforma popup (prefix "pfe") so the two forms can't drift apart.
function proformaChargeFieldHTML(idPrefix, label, percentVal, amountVal) {
  // A stored % always wins the mode guess (same priority the old two-field
  // layout had: typing a % hid the computed flat-amount column) - only
  // falls to "amount" when there's no % on file at all.
  const mode = (Number(percentVal) || 0) > 0 ? 'percent' : ((Number(amountVal) || 0) > 0 ? 'amount' : 'percent');
  const value = mode === 'amount' ? (amountVal || '') : (percentVal || '');
  return `<div>
    <label>${esc(label)}</label>
    <div style="display:flex;gap:6px;">
      <select id="${idPrefix}-mode" style="width:128px;flex:0 0 auto;" onchange="proformaChargeModeChanged('${idPrefix}')">
        <option value="percent" ${mode === 'percent' ? 'selected' : ''}>Percentage (%)</option>
        <option value="amount" ${mode === 'amount' ? 'selected' : ''}>Fixed Amount (₹)</option>
      </select>
      <input id="${idPrefix}-value" type="number" value="${esc(value)}" placeholder="${mode === 'percent' ? 'e.g. 2.5' : 'Flat amount in ₹'}" style="flex:1;">
    </div>
  </div>`;
}
window.proformaChargeModeChanged = (idPrefix) => {
  const inp = document.getElementById(idPrefix + '-value');
  if (!inp) return;
  inp.placeholder = val(idPrefix + '-mode') === 'percent' ? 'e.g. 2.5' : 'Flat amount in ₹';
};
// Reads one charge field back into the two request-body keys the backend
// expects - whichever mode isn't selected is sent blank, so it can never
// linger from a previous save made in the other mode.
function proformaChargePayload(idPrefix, percentKey, amountKey) {
  const mode = val(idPrefix + '-mode');
  const value = val(idPrefix + '-value') || '';
  return mode === 'amount' ? { [percentKey]: '', [amountKey]: value } : { [percentKey]: value, [amountKey]: '' };
}

// ===================== Round 5: Asset Management =====================
PAGES['assets'] = async (el) => {
  const [assets, vendors, depts, employees] = await Promise.all([
    api('/assets'), api('/masters/vendors'), api('/masters/departments'), api('/hr/employees').catch(() => []),
  ]);
  el.innerHTML = `
    <div class="panel"><h3>Add Asset</h3>
      <div class="form-grid">
        <div><label>Asset Code</label><input id="as-code" placeholder="Auto if blank"></div>
        <div><label>Name</label><input id="as-name"></div>
        <div><label>Category</label><input id="as-category"></div>
        <div><label>Purchase Date</label><input id="as-purchase-date" type="date"></div>
        <div><label>Purchase Value (₹)</label><input id="as-purchase-value" type="number"></div>
        <div><label>Vendor</label><select id="as-vendor"><option value="">-</option>${vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
        <div><label>Department/Location</label><select id="as-dept"><option value="">-</option>${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Custodian</label><select id="as-custodian"><option value="">-</option>${(employees||[]).map(e => `<option value="${e.id}">${esc(e.full_name)}</option>`).join('')}</select></div>
        <div><label>Useful Life (Years)</label><input id="as-life" type="number" value="5"></div>
        <div><label>Salvage Value (₹)</label><input id="as-salvage" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addAsset()">Add Asset</button>
      <div id="as-err" class="msg err" style="display:none;margin-top:8px;"></div>
    </div>
    <div class="panel"><h3>Filter</h3>
      <div class="form-grid">
        <div><label>Status</label><select id="as-filter-status" onchange="navigateAssetsFilter()"><option value="">All</option><option>Active</option><option>UnderMaintenance</option><option>Disposed</option><option>EOL</option></select></div>
      </div>
    </div>
    ${collapsiblePanel('asset-register-list', `Asset Register (${assets.length})`, `
      ${tableHTML(['Code', 'Name', 'Category', 'Dept', 'Custodian', 'Purchase Value', 'Book Value', 'Status', ''], assets, a => `
        <tr><td>${esc(a.asset_code)}</td><td>${esc(a.name)}</td><td>${esc(a.category)||'-'}</td><td>${esc(a.department_name)||'-'}</td>
        <td>${esc(a.custodian_name)||'-'}</td><td>₹${fmt(a.purchase_value)}</td><td>₹${fmt(a.book_value)}</td><td>${badge(a.status)}</td>
        <td><button class="btn small outline" type="button" onclick="viewAsset(${a.id})">Maintenance Log</button></td></tr>`)}
    `)}
    <div class="panel" id="as-detail-panel" style="display:none;"><h3>Asset Detail</h3><div id="as-detail-body"></div></div>`;
};
window.navigateAssetsFilter = () => navigate('assets');
window.addAsset = async () => {
  const errEl = document.getElementById('as-err'); errEl.style.display = 'none';
  try {
    await api('/assets', { method: 'POST', body: JSON.stringify({
      asset_code: val('as-code'), name: val('as-name'), category: val('as-category'), purchase_date: val('as-purchase-date'),
      purchase_value: val('as-purchase-value'), vendor_id: val('as-vendor') || null, department_id: val('as-dept') || null,
      custodian_id: val('as-custodian') || null, useful_life_years: val('as-life'), salvage_value: val('as-salvage'),
    })});
    navigate('assets');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.viewAsset = async (id) => {
  const { asset, logs } = await api('/assets/' + id);
  const panel = document.getElementById('as-detail-panel');
  document.getElementById('as-detail-body').innerHTML = `
    <p><b>${esc(asset.name)}</b> (${esc(asset.asset_code)}) — Book Value: ₹${fmt(asset.book_value)} — Status: ${badge(asset.status)}</p>
    <div class="form-grid">
      <div><label>Log Date</label><input id="ml-date" type="date"></div>
      <div><label>Type</label><select id="ml-type"><option>Preventive</option><option>Breakdown</option><option>Repair</option></select></div>
      <div><label>Cost (₹)</label><input id="ml-cost" type="number"></div>
      <div><label>Performed By</label><input id="ml-performed-by"></div>
      <div><label>Next Due Date</label><input id="ml-next-due" type="date"></div>
    </div>
    <div><label>Description</label><input id="ml-desc" style="width:100%;"></div>
    <button class="btn" onclick="addMaintenanceLog(${id})" style="margin-top:8px;">Add Maintenance Entry</button>
    ${tableHTML(['Date', 'Type', 'Description', 'Cost', 'Performed By', 'Next Due'], logs, l => `
      <tr><td>${new Date(l.log_date).toLocaleDateString()}</td><td>${esc(l.type)}</td><td>${esc(l.description)}</td><td>₹${fmt(l.cost)}</td><td>${esc(l.performed_by)}</td><td>${esc(l.next_due_date)||'-'}</td></tr>`)}
    <div class="form-grid" style="margin-top:12px;">
      <div><label>Status</label><select id="ml-status">
        ${['Active','UnderMaintenance','Disposed','EOL'].map(s => `<option ${s===asset.status?'selected':''}>${s}</option>`).join('')}
      </select></div>
      <div><label>Disposal Date</label><input id="ml-disposal-date" type="date" value="${esc(asset.disposal_date)||''}"></div>
      <div><label>Disposal Value (₹)</label><input id="ml-disposal-value" type="number" value="${asset.disposal_value||''}"></div>
    </div>
    <button class="btn outline" type="button" onclick="updateAssetStatus(${id})" style="margin-top:8px;">Update Status</button>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
window.addMaintenanceLog = async (assetId) => {
  try {
    await api(`/assets/${assetId}/maintenance`, { method: 'POST', body: JSON.stringify({
      log_date: val('ml-date') || undefined, type: val('ml-type'), description: val('ml-desc'), cost: val('ml-cost'),
      performed_by: val('ml-performed-by'), next_due_date: val('ml-next-due') || null,
    })});
    viewAsset(assetId);
  } catch (e) { alert(e.message); }
};
window.updateAssetStatus = async (assetId) => {
  try {
    await api(`/assets/${assetId}`, { method: 'PUT', body: JSON.stringify({
      status: val('ml-status'), disposal_date: val('ml-disposal-date') || null, disposal_value: val('ml-disposal-value') || null,
    })});
    navigate('assets');
  } catch (e) { alert(e.message); }
};
PAGES['assets-maintenance'] = async (el) => {
  const [due, eol] = await Promise.all([api('/assets/due-for-maintenance'), api('/assets/nearing-eol')]);
  el.innerHTML = `
    <div class="panel"><h3>Assets Due for Maintenance (next 30 days)</h3>
      ${tableHTML(['Code', 'Name', 'Next Due'], due, d => `<tr><td>${esc(d.asset_code)}</td><td>${esc(d.name)}</td><td>${esc(d.next_due_date)}</td></tr>`)}
    </div>
    <div class="panel"><h3>Assets Nearing End of Life (book value ≤ 15% of purchase value)</h3>
      ${tableHTML(['Code', 'Name', 'Purchase Value', 'Book Value'], eol, a => `<tr><td>${esc(a.asset_code)}</td><td>${esc(a.name)}</td><td>₹${fmt(a.purchase_value)}</td><td>₹${fmt(a.book_value)}</td></tr>`)}
    </div>`;
};

// ===================== Round 5: Ticketing =====================
PAGES['tickets-raise'] = async (el) => {
  const depts = await api('/masters/departments');
  el.innerHTML = `
    <div class="panel"><h3>Raise a Ticket</h3>
      <div class="form-grid">
        <div><label>Subject</label><input id="tk-subject"></div>
        <div><label>Category</label><input id="tk-category" placeholder="IT / Facilities / HR / Other"></div>
        <div><label>Priority</label><select id="tk-priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Urgent</option></select></div>
        <div><label>Target Department</label><select id="tk-dept">${depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      </div>
      <div><label>Description</label><textarea id="tk-desc" rows="3"></textarea></div>
      <div><label>Attachment (optional)</label><input id="tk-file" type="file"></div>
      <button class="btn" onclick="raiseTicket()">Submit Ticket</button>
      <div id="tk-err" class="msg err" style="display:none;"></div>
    </div>`;
};
window.raiseTicket = async () => {
  const errEl = document.getElementById('tk-err'); errEl.style.display = 'none';
  try {
    const result = await api('/tickets', { method: 'POST', body: JSON.stringify({
      subject: val('tk-subject'), description: val('tk-desc'), category: val('tk-category'), priority: val('tk-priority'), department_id: val('tk-dept'),
    })});
    const fileEl = document.getElementById('tk-file');
    if (fileEl && fileEl.files.length) {
      const fd = new FormData();
      fd.append('file', fileEl.files[0]);
      await apiUpload(`/attachments/ticket/${result.id}`, fd, 'POST');
    }
    navigate('tickets-mine');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
PAGES['tickets-mine'] = async (el) => renderTicketQueue(el, '/tickets/mine', 'My Tickets');
PAGES['tickets-department'] = async (el) => renderTicketQueue(el, '/tickets/department', "Department Tickets");
async function renderTicketQueue(el, apiPath, title) {
  const rows = await api(apiPath);
  const key = 'tickets-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const renderRows = (rs) => tableHTML(['Ticket No', 'Subject', 'Priority', 'Status', 'Department', 'Assigned To', ''], rs, t => `
        <tr><td>${esc(t.ticket_no)}</td><td>${esc(t.subject)}</td><td>${badge(t.priority)}</td><td>${badge(t.status)}</td>
        <td>${esc(t.department_name)||'-'}</td><td>${esc(t.assigned_to_name)||'-'}</td>
        <td><button class="btn small outline" type="button" onclick="viewTicket(${t.id})">Open</button></td></tr>`);
  el.innerHTML = `
    ${collapsiblePanel(key, `<span id="${key}-count">${esc(title)} (${rows.length})</span>`, `
      ${renderListSearch(key, rows, ['ticket_no', 'subject', 'department_name', 'assigned_to_name', 'status'], (filtered) => {
        document.getElementById(key + '-table').innerHTML = renderRows(filtered);
        document.getElementById(key + '-count').textContent = title + ' (' + filtered.length + ')';
      }, 'Search by ticket no, subject, department, assignee, status...')}
      <div id="${key}-table">${renderRows(rows)}</div>
    `)}
    <div class="panel" id="tk-detail-panel" style="display:none;"><h3>Ticket Detail</h3><div id="tk-detail-body"></div></div>`;
  window.__TICKET_REFRESH = () => renderTicketQueue(el, apiPath, title);
}
window.viewTicket = async (id) => {
  const { ticket, comments } = await api('/tickets/' + id);
  const panel = document.getElementById('tk-detail-panel');
  document.getElementById('tk-detail-body').innerHTML = `
    <p><b>${esc(ticket.subject)}</b> — ${badge(ticket.priority)} ${badge(ticket.status)}<br>
    Department: ${esc(ticket.department_name)||'-'} &nbsp; Raised by: ${esc(ticket.raised_by_name)||'-'} &nbsp; Assigned to: ${esc(ticket.assigned_to_name)||'Unassigned'}</p>
    <p>${esc(ticket.description)||''}</p>
    <div class="form-grid">
      <div><label>Status</label><select id="tk-status">${['Open','InProgress','Resolved','Closed','Reopened'].map(s => `<option ${s===ticket.status?'selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <button class="btn outline" type="button" onclick="updateTicket(${id})">Update Status</button>
    <h4>Comments</h4>
    <div>${comments.map(c => `<div class="ticket-comment"><b>${esc(c.user_name)}</b> <span class="muted">${new Date(c.created_at).toLocaleString()}</span><br>${esc(c.comment)}</div>`).join('') || '<span class="muted">No comments yet.</span>'}</div>
    <textarea id="tk-comment" rows="2" placeholder="Add a reply..."></textarea>
    <button class="btn" onclick="addTicketComment(${id})">Post Comment</button>
    <h4>Attachments</h4>
    <div id="tk-attachments-${id}"></div>`;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  renderAttachmentsWidget('ticket', id, document.getElementById(`tk-attachments-${id}`));
};
window.updateTicket = async (id) => {
  try { await api(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ status: val('tk-status') }) }); if (window.__TICKET_REFRESH) window.__TICKET_REFRESH(); else viewTicket(id); }
  catch (e) { alert(e.message); }
};
window.addTicketComment = async (id) => {
  const comment = val('tk-comment');
  if (!comment.trim()) return;
  try { await api(`/tickets/${id}/comments`, { method: 'POST', body: JSON.stringify({ comment }) }); viewTicket(id); }
  catch (e) { alert(e.message); }
};

// ===================== Full Data Export (Admin only) =====================
// Every raw column of any table in the system, straight to xlsx, for
// external deep-dive analysis in Power BI/Python - see lib/tableExport.js
// for exactly what's excluded (credentials, internal ACL plumbing) and why.
PAGES['full-data-export'] = async (el) => {
  const tables = await api('/reports/export/tables');
  el.innerHTML = `
    <div class="panel"><h3>Full Data Export</h3>
      <p class="muted">Every raw field of a table - including internal IDs, foreign keys, and timestamps not shown on any screen - as a single Excel file. For loading into Power BI, Python/pandas, or similar external analysis, not for everyday reporting (see the built-in report pages for that).</p>
      <div class="form-grid">
        <div><label>Table</label><select id="fde-table">${tables.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
      </div>
      <button class="btn" onclick="downloadFullTableExport()">Download Export</button>
    </div>`;
};
window.downloadFullTableExport = () => {
  const table = val('fde-table');
  downloadTemplateFile(`/reports/export/${table}`, `${table}_full_export.xlsx`);
};

// ===================== Backups (Admin only) =====================
// Daily automated backup (DB snapshot + uploaded files) plus a manual
// "run now" - see lib/backup.js for what each run actually does. This page
// is the audit log an Admin uses to check backup health and grab the
// right file to migrate to a new server.
function fmtBytes(n) {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
PAGES['backups'] = async (el) => {
  el.innerHTML = `
    <div class="panel"><h3>Daily Backups</h3>
      <p class="muted">Runs automatically once a day (DB snapshot via SQLite's own VACUUM INTO, safe against a live database, plus a copy of every uploaded file), bundled into one .tar.gz when possible. Kept for the retention window (default 14 days, <code>BACKUP_RETENTION_DAYS</code>), optionally emailed offsite if <code>BACKUP_EMAIL_TO</code> is set, and optionally uploaded to Zoho WorkDrive if <code>ZOHO_WORKDRIVE_*</code> is configured (see README).</p>
      <p class="muted"><b>To migrate to a new server:</b> download a backup below, stop the app there, replace its <code>erp.db</code> with the backup's <code>erp.db</code> and its uploads folder with the backup's <code>uploads</code> folder, then start it again. Nothing proprietary - it's a plain SQLite file and a plain folder of files.</p>
      <button class="btn" onclick="runBackupNow()">Run Backup Now</button>
      <div id="backup-run-result" style="margin-top:8px;"></div>
    </div>
    ${collapsiblePanel('backup-history', 'Backup History', '<div id="backup-history-body"></div>')}`;
  renderBackupHistory();
};
async function renderBackupHistory() {
  const bodyEl = document.getElementById('backup-history-body');
  if (!bodyEl) return;
  const runs = await api('/backups');
  bodyEl.innerHTML = tableHTML(['Started', 'Finished', 'Status', 'Trigger', 'By', 'DB Size', 'Uploads Size', 'Total Size', 'Emailed', 'Zoho WorkDrive', ''], runs, r => `
    <tr>
      <td>${new Date(r.started_at).toLocaleString()}</td>
      <td>${r.finished_at ? new Date(r.finished_at).toLocaleString() : '-'}</td>
      <td>${badge(r.status)}</td>
      <td>${esc(r.trigger_type)}</td>
      <td>${esc(r.triggered_by_name) || '-'}</td>
      <td>${fmtBytes(r.db_size_bytes)}</td>
      <td>${fmtBytes(r.uploads_size_bytes)}</td>
      <td>${fmtBytes(r.total_size_bytes)}</td>
      <td>${r.emailed ? '✓' : (r.email_error ? `<span class="muted" title="${esc(r.email_error)}">No</span>` : '-')}</td>
      <td>${r.zoho_uploaded ? '✓' : (r.zoho_error ? `<span class="muted" title="${esc(r.zoho_error)}">No</span>` : '-')}</td>
      <td>${actionButtonsCell(`
        ${r.status === 'Success' && r.is_archive ? `<button class="btn small outline" type="button" onclick="downloadBackup(${r.id})">Download</button>` : ''}
        <button class="btn small outline" type="button" onclick="deleteBackup(${r.id})">Delete</button>
      `)}</td>
    </tr>
    ${r.status === 'Failed' && r.error_message ? `<tr><td></td><td colspan="10" style="padding-top:0;"><span class="muted" style="font-size:12px;">${esc(r.error_message)}</span></td></tr>` : ''}
    ${r.skipped_files ? (() => { const skipped = JSON.parse(r.skipped_files); return `<tr><td></td><td colspan="10" style="padding-top:0;">
      <span style="color:#b45309;font-size:12px;" title="${esc(skipped.map(s => s.path + ': ' + s.error).join('\n'))}">⚠ ${skipped.length} file(s) under uploads could not be read and are missing from this backup - hover for the list.</span>
    </td></tr>`; })() : ''}
  `);
}
window.runBackupNow = async () => {
  const resultEl = document.getElementById('backup-run-result');
  resultEl.innerHTML = '<span class="muted">Running - this can take a moment for a large uploads folder...</span>';
  try {
    const result = await api('/backups/run', { method: 'POST' });
    const skippedNote = result.skippedFiles && result.skippedFiles.length
      ? ` <span style="color:#b45309;">- ${result.skippedFiles.length} file(s) under uploads could not be read and were skipped (see Backup History below).</span>` : '';
    resultEl.innerHTML = `<div class="msg ok">Backup complete: ${fmtBytes(result.totalSize)}${result.emailed ? ', emailed offsite' : ''}${result.zohoUploaded ? ', uploaded to Zoho WorkDrive' : ''}.${skippedNote}</div>`;
    renderBackupHistory();
  } catch (e) { resultEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};
window.downloadBackup = (id) => {
  downloadTemplateFile(`/backups/${id}/download`, `erp-backup-${id}.tar.gz`);
};
window.deleteBackup = async (id) => {
  if (!confirm('Delete this backup? This removes the file from disk and its log entry.')) return;
  try { await api(`/backups/${id}`, { method: 'DELETE' }); renderBackupHistory(); }
  catch (e) { alert(e.message); }
};

// ===================== Organizational Hierarchy =====================
// A reporting rollup tree (Region -> Unit -> Department -> Team) that sits
// ABOVE the app's real department/role/HOD model, purely for grouping KPIs -
// it never changes who can see or do what elsewhere in the app. Managing the
// tree (add/edit/delete nodes) is Admin-only; viewing the rollup matches
// whoever can already see cross-department reports (report.view_all).
let ORG_HIERARCHY_SELECTED = null;
PAGES['org-hierarchy'] = async (el) => {
  const [nodes, departments] = await Promise.all([api('/org-hierarchy/tree'), api('/masters/departments')]);
  const isAdmin = ME.role === 'Admin';
  const byParent = {};
  nodes.forEach(n => { const key = n.parent_id || 'root'; (byParent[key] = byParent[key] || []).push(n); });
  const renderNode = (n, depth) => {
    const children = byParent[n.id] || [];
    return `<div style="padding:6px 0 6px ${depth * 22}px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span class="badge active">${esc(n.node_type)}</span>
      <b>${esc(n.name)}</b>
      ${n.department_name ? `<span class="muted">&rarr; ${esc(n.department_name)}</span>` : ''}
      <button class="btn small outline" onclick="viewOrgRollup(${n.id})">View Rollup</button>
      ${isAdmin ? `<button class="btn small outline" onclick="deleteOrgNode(${n.id})">Delete</button>` : ''}
    </div>${children.map(c => renderNode(c, depth + 1)).join('')}`;
  };
  const roots = byParent.root || [];
  el.innerHTML = `
    ${isAdmin ? `
    <div class="panel"><h3>Add Node</h3>
      <div class="form-grid">
        <div><label>Name</label><input id="on-name" placeholder="e.g. North Region"></div>
        <div><label>Type</label><select id="on-type"><option value="Region">Region</option><option value="Unit">Unit</option><option value="Department">Department</option><option value="Team">Team</option></select></div>
        <div><label>Parent Node (optional)</label><select id="on-parent"><option value="">— top level —</option>${nodes.map(n => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select></div>
        <div><label>Maps to Department (optional)</label><select id="on-dept"><option value="">— none —</option>${departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
        <div><label>Sort Order</label><input id="on-sort" type="number" value="0"></div>
      </div>
      <button class="btn" onclick="addOrgNode()">Add Node</button>
      <div id="on-err" class="msg err" style="display:none;margin-top:10px;"></div>
    </div>` : ''}
    <div class="panel"><h3>Hierarchy</h3>
      ${roots.length ? roots.map(n => renderNode(n, 0)).join('') : '<div class="empty">No nodes yet.</div>'}
    </div>
    <div class="panel" id="org-rollup-panel" style="display:none;"></div>`;
};
window.addOrgNode = async () => {
  const errEl = document.getElementById('on-err');
  try {
    await api('/org-hierarchy/nodes', { method: 'POST', body: JSON.stringify({
      name: val('on-name'), node_type: val('on-type'), parent_id: val('on-parent') || null, department_id: val('on-dept') || null, sort_order: val('on-sort'),
    })});
    navigate('org-hierarchy');
  } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
};
window.deleteOrgNode = async (id) => {
  if (!confirm('Delete this node?')) return;
  try { await api('/org-hierarchy/nodes/' + id, { method: 'DELETE' }); navigate('org-hierarchy'); }
  catch (e) { alert(e.message); }
};
window.viewOrgRollup = async (id) => {
  ORG_HIERARCHY_SELECTED = id;
  const panel = document.getElementById('org-rollup-panel');
  panel.style.display = 'block';
  const data = await api(`/org-hierarchy/nodes/${id}/rollup`);
  panel.innerHTML = `
    <h3>Rollup - ${esc(data.node.name)}</h3>
    <div class="cards">
      <div class="card"><div class="num">${data.totals.headcount}</div><div class="label">Active Headcount</div></div>
      <div class="card"><div class="num">₹${fmt(data.totals.monthly_salary_cost)}</div><div class="label">Monthly Salary Cost</div></div>
    </div>
    ${tableHTML(['Department', 'Headcount', 'Monthly Salary Cost', ''], data.by_department, d => `
      <tr><td>${esc(d.department_name)}</td><td>${d.headcount}</td><td>₹${fmt(d.monthly_salary_cost)}</td>
      <td><button class="btn small outline" onclick="drillOrgDepartment(${d.department_id})">Drill Down</button></td></tr>`)}
    <div id="org-drill-wrap"></div>`;
  panel.scrollIntoView({ behavior: 'smooth' });
};
window.drillOrgDepartment = async (deptId) => {
  const wrap = document.getElementById('org-drill-wrap');
  const employees = await api(`/org-hierarchy/departments/${deptId}/employees`);
  wrap.innerHTML = `<h4 style="margin-top:14px;">Employees</h4>${tableHTML(['Code', 'Name', 'Designation', 'Monthly Salary'], employees, e => `
    <tr><td>${esc(e.employee_code)||'-'}</td><td>${esc(e.full_name)}</td><td>${esc(e.designation)||'-'}</td><td>₹${fmt(e.monthly_salary)}</td></tr>`)}`;
};

// ===================== Data Import (generic migration tool, Admin only) =====================
PAGES['data-import'] = async (el) => {
  const entities = await api('/data-import/entities');
  window.__DI_ENTITIES = entities;
  el.innerHTML = `
    <div class="panel"><h3>Data Import</h3>
      <p class="muted">Bring master/transactional data over from Excel - pick a data type, download its template, fill it in, then upload it. Re-uploading the same file is safe where the entity has a natural key (e.g. item code, employee code, expense category + date); everything else is skipped as a duplicate rather than double-inserted.</p>
      <div class="form-grid">
        <div><label>Data Type</label>
          <select id="di-entity">${entities.map(e => `<option value="${e.id}">${esc(e.label)}</option>`).join('')}</select>
        </div>
      </div>
      <button class="btn outline" type="button" onclick="downloadDataImportTemplate()">Download Template</button>
      ${bulkUploadPanelHTML('di-upload-file')}
      <button class="btn" onclick="uploadDataImportFile()" style="margin-top:6px;">Upload Filled Template</button>
      <div id="di-upload-result" style="margin-top:10px;"></div>
    </div>`;
};
window.downloadDataImportTemplate = () => {
  const entity = val('di-entity');
  downloadTemplateFile(`/data-import/${entity}/template`, `${entity}_import_template.xlsx`);
};
window.uploadDataImportFile = async () => {
  const entity = val('di-entity');
  const resultEl = document.getElementById('di-upload-result');
  const fileEl = document.getElementById('di-upload-file');
  if (!fileEl.files.length) { alert('Choose a filled template file first.'); return; }
  try {
    const fd = new FormData();
    fd.append('file', fileEl.files[0]);
    const result = await apiUpload(`/data-import/${entity}/upload`, fd, 'POST');
    resultEl.innerHTML = `<div class="msg ${result.errors.length ? 'err' : 'ok'}">
      Inserted: <b>${result.inserted}</b>, Skipped: <b>${result.skipped}</b>
      ${result.errors.length ? '<table style="margin-top:8px;"><thead><tr><th>Row error</th></tr></thead><tbody>' + result.errors.map(e => `<tr><td>${esc(e)}</td></tr>`).join('') + '</tbody></table>' : ''}
    </div>`;
  } catch (e) { resultEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};

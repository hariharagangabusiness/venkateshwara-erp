const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requirePermission, requireRole } = require('../middleware/auth');
const defaults = require('../lib/offerDefaults');
const { generateOfferPdf } = require('../lib/offerPdf');
const { generateAnnexureDocx } = require('../lib/annexureDocx');
const { createJobCardsForProject } = require('../lib/pipeline');
const { ensureEditableVersion } = require('../lib/offerVersioning');
const { getOfferPdfTemplate, setOfferPdfTemplate, DEFAULT_OFFER_PDF_TEMPLATE, getOfferGovernanceSettings, setOfferGovernanceSettings, getOfferDesignTokens, setOfferDesignTokens, DEFAULT_OFFER_DESIGN_TOKENS } = require('../lib/settings');

const router = express.Router();
router.use(authRequired);

const { getUploadsSubdir, resolveUploadPath } = require('../lib/paths');
const uploadDir = getUploadsSubdir('offers');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function offerPerm() { return requirePermission('sales_order.manage', 'lead.manage'); }

// A scope line picked from the Section Title library needs its own copy of
// the library's picture, not a shared reference to it - editing/deleting an
// offer_items row already unlinks its image_path from disk (see PUT/DELETE
// /:id/items/:itemId below), which would otherwise take the library's own
// picture out from under every other line and the library entry itself.
function copyLibraryImage(libraryImagePath) {
  if (!libraryImagePath) return null;
  const srcAbs = resolveUploadPath(libraryImagePath);
  if (!fs.existsSync(srcAbs)) return null;
  const destName = Date.now() + '-libcopy' + path.extname(libraryImagePath);
  fs.copyFileSync(srcAbs, path.join(uploadDir, destName));
  return '/uploads/offers/' + destName;
}

// ===================== Admin-editable dropdown options =====================
// Application / Type of System / Material of Construction - one generic
// table for all three fields (see db/index.js Round 21). Values are never
// hard-deleted (only deactivated) so an offer written before a value was
// retired still displays it correctly. Mutation routes are Admin-only (a
// master template control, not a Sales function, per Round 40's RBAC
// tightening) - Sales still reads the active list via offerPerm() below to
// pick a value when building an offer.
const OFFER_OPTION_FIELDS = ['application', 'type_of_system', 'material_of_construction'];

router.get('/field-options/:field', offerPerm(), (req, res) => {
  if (!OFFER_OPTION_FIELDS.includes(req.params.field)) return res.status(404).json({ error: 'Unknown field' });
  res.json(db.prepare(`
    SELECT * FROM offer_field_options WHERE field_name = ? AND active = 1 ORDER BY sort_order, value
  `).all(req.params.field));
});
// Admin view lists every option (including inactive) so they can be reactivated.
router.get('/field-options', requireRole('Admin'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM offer_field_options ORDER BY field_name, sort_order, value`).all());
});
router.post('/field-options', requireRole('Admin'), (req, res) => {
  const { field_name, value, sort_order } = req.body;
  if (!OFFER_OPTION_FIELDS.includes(field_name)) return res.status(400).json({ error: 'field_name must be application, type_of_system, or material_of_construction' });
  if (!String(value || '').trim()) return res.status(400).json({ error: 'Enter a value.' });
  try {
    const info = db.prepare(`INSERT INTO offer_field_options (field_name, value, sort_order) VALUES (?,?,?)`)
      .run(field_name, value.trim(), Number(sort_order) || 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'That value already exists for this field.' });
  }
});
router.put('/field-options/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM offer_field_options WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { value, sort_order, active } = req.body;
  db.prepare(`UPDATE offer_field_options SET value=?, sort_order=?, active=? WHERE id=?`).run(
    value !== undefined ? value : existing.value,
    sort_order !== undefined ? Number(sort_order) : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    existing.id
  );
  res.json({ ok: true });
});

// ===================== Section Title library =====================
// Admin-managed catalog (title + description + summary + picture) the Offer
// Builder's "Add Machinery / Scope Line" form picks from to auto-fill the
// line's description/image. Entries are hard-deletable (unlike the
// field-options above) since offer_items copies the text/image at the time
// a line is added rather than referencing this table by id - nothing on an
// existing offer breaks if a library entry is later edited or removed.
// Mutation routes (incl. the image/description asset uploads) are
// Admin-only - Sales reads it via offerPerm() to pick from, never to edit.
router.get('/section-titles', offerPerm(), (req, res) => {
  res.json(db.prepare('SELECT * FROM section_title_library ORDER BY title').all());
});
router.post('/section-titles', requireRole('Admin'), upload.single('image'), (req, res) => {
  const { title, description, summary } = req.body;
  if (!String(title || '').trim()) return res.status(400).json({ error: 'Enter a title.' });
  const imagePath = req.file ? '/uploads/offers/' + req.file.filename : null;
  try {
    const info = db.prepare(`INSERT INTO section_title_library (title, description, summary, image_path, created_by) VALUES (?,?,?,?,?)`)
      .run(title.trim(), description || null, summary || null, imagePath, req.user.id);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'That section title already exists in the library.' });
  }
});
router.put('/section-titles/:id', requireRole('Admin'), upload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM section_title_library WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { title, description, summary } = req.body;
  let imagePath = existing.image_path;
  if (req.file) {
    imagePath = '/uploads/offers/' + req.file.filename;
    if (existing.image_path) fs.unlink(resolveUploadPath(existing.image_path), () => {});
  }
  try {
    db.prepare(`UPDATE section_title_library SET title=?, description=?, summary=?, image_path=? WHERE id=?`).run(
      title !== undefined ? title.trim() : existing.title,
      description !== undefined ? description : existing.description,
      summary !== undefined ? summary : existing.summary,
      imagePath, existing.id
    );
    res.json({ ok: true, image_path: imagePath });
  } catch (e) {
    res.status(400).json({ error: 'That section title already exists in the library.' });
  }
});
router.delete('/section-titles/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM section_title_library WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.image_path) fs.unlink(resolveUploadPath(existing.image_path), () => {});
  db.prepare('DELETE FROM section_title_library WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// ===================== Offer Clause Library =====================
// Admin-managed reusable clauses for Terms & Conditions / Inclusions /
// Exclusions / Utilities Requirement / Instrument Air Supply - Sales picks
// from these (offerPerm(), active-only, one category at a time) instead of
// only ever typing free text; mutation is Admin-only, same as the other
// master template controls above. Entries are hard-deletable, same
// reasoning as Section Title library: offer_terms/offer text fields copy
// the label/body text at pick time rather than referencing this row.
const CLAUSE_CATEGORIES = ['term', 'inclusion', 'exclusion', 'utilities', 'instrument_air'];

router.get('/clause-library/:category', offerPerm(), (req, res) => {
  if (!CLAUSE_CATEGORIES.includes(req.params.category)) return res.status(404).json({ error: 'Unknown category' });
  res.json(db.prepare(`
    SELECT * FROM offer_clause_library WHERE category = ? AND active = 1 ORDER BY sort_order, label
  `).all(req.params.category));
});
// Admin view lists every clause (including inactive) across all categories.
router.get('/clause-library', requireRole('Admin'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM offer_clause_library ORDER BY category, sort_order, label`).all());
});
router.post('/clause-library', requireRole('Admin'), (req, res) => {
  const { category, label, body, sort_order } = req.body;
  if (!CLAUSE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'category must be one of: ' + CLAUSE_CATEGORIES.join(', ') });
  if (!String(label || '').trim()) return res.status(400).json({ error: 'Enter a label.' });
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Enter the clause text.' });
  const info = db.prepare(`INSERT INTO offer_clause_library (category, label, body, sort_order, created_by) VALUES (?,?,?,?,?)`)
    .run(category, label.trim(), body.trim(), Number(sort_order) || 0, req.user.id);
  res.json({ id: info.lastInsertRowid });
});
router.put('/clause-library/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM offer_clause_library WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { label, body, sort_order, active } = req.body;
  db.prepare(`UPDATE offer_clause_library SET label=?, body=?, sort_order=?, active=? WHERE id=?`).run(
    label !== undefined ? label : existing.label,
    body !== undefined ? body : existing.body,
    sort_order !== undefined ? Number(sort_order) : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    existing.id
  );
  res.json({ ok: true });
});
router.delete('/clause-library/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM offer_clause_library WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM offer_clause_library WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// ===================== Offer PDF Template override (optional) =====================
// Admin-uploaded header/footer/cover images that can OPTIONALLY replace
// pieces of the hand-tuned, pixel-matched default letterhead in
// lib/offerPdf.js. Every piece starts - and stays, until an admin
// explicitly uploads an image AND switches it on - inactive, so this
// feature existing never changes what any offer's PDF looks like on its
// own. Admin-only, same as the rest of Company/branding settings.
router.get('/pdf-template', requireRole('Admin'), (req, res) => {
  res.json(getOfferPdfTemplate());
});
const uploadPdfTemplate = upload.fields([
  { name: 'header_image', maxCount: 1 },
  { name: 'footer_image', maxCount: 1 },
  { name: 'cover_image', maxCount: 1 },
  { name: 'cover_docx', maxCount: 1 },
  { name: 'cover_pdf', maxCount: 1 },
]);
// Rich-text header/footer HTML comes from a contenteditable toolbar
// (public/js/app.js) that only ever runs execCommand/DOM APIs against its
// own editor - it can't itself produce a <script> tag, but this strips one
// anyway as a defense-in-depth floor before the HTML is stored and later
// injected as-is into the PDF's header/footer template.
function stripScriptTags(html) {
  return String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}
router.post('/pdf-template', requireRole('Admin'), uploadPdfTemplate, (req, res) => {
  const current = getOfferPdfTemplate();
  const files = req.files || {};
  const update = {};
  ['header', 'footer', 'cover'].forEach(piece => {
    const uploaded = files[piece + '_image'] && files[piece + '_image'][0];
    if (uploaded) {
      const newPath = '/uploads/offers/' + uploaded.filename;
      if (current[piece + '_image_path']) fs.unlink(resolveUploadPath(current[piece + '_image_path']), () => {});
      update[piece + '_image_path'] = newPath;
    }
    const activeField = piece + '_active';
    if (req.body[activeField] !== undefined) {
      update[activeField] = req.body[activeField] === 'true' || req.body[activeField] === true;
    }
  });

  // Word cover page (.docx) - a separate upload slot from cover_image above;
  // lib/offerPdf.js's coverPage() parses it via mammoth at render time.
  const docxFile = files.cover_docx && files.cover_docx[0];
  if (docxFile) {
    if (!/\.docx$/i.test(docxFile.originalname)) {
      fs.unlink(docxFile.path, () => {});
      return res.status(400).json({ error: 'Cover page upload must be a .docx file.' });
    }
    if (current.cover_docx_path) fs.unlink(resolveUploadPath(current.cover_docx_path), () => {});
    update.cover_docx_path = '/uploads/offers/' + docxFile.filename;
  }
  if (req.body.cover_docx_active !== undefined) {
    update.cover_docx_active = req.body.cover_docx_active === 'true' || req.body.cover_docx_active === true;
  }

  // Uploaded PDF cover - highest-precedence cover source (see
  // lib/offerPdf.js's coverPage()/mergeCoverPdf()): its own pages are
  // prepended onto the generated offer PDF as-is, rather than approximated
  // in HTML.
  const pdfFile = files.cover_pdf && files.cover_pdf[0];
  if (pdfFile) {
    if (!/\.pdf$/i.test(pdfFile.originalname)) {
      fs.unlink(pdfFile.path, () => {});
      return res.status(400).json({ error: 'Cover page upload must be a .pdf file.' });
    }
    if (current.cover_pdf_path) fs.unlink(resolveUploadPath(current.cover_pdf_path), () => {});
    update.cover_pdf_path = '/uploads/offers/' + pdfFile.filename;
  }
  if (req.body.cover_pdf_active !== undefined) {
    update.cover_pdf_active = req.body.cover_pdf_active === 'true' || req.body.cover_pdf_active === true;
  }

  // Rich-text header/footer overrides - formatted HTML from the toolbar,
  // stored as-is (Admin-only input) and injected directly into the PDF's
  // header/footer template by lib/offerPdf.js.
  ['header', 'footer'].forEach(piece => {
    const field = piece + '_richtext';
    if (req.body[field] !== undefined) update[field] = stripScriptTags(req.body[field]);
    const activeField = field + '_active';
    if (req.body[activeField] !== undefined) {
      update[activeField] = req.body[activeField] === 'true' || req.body[activeField] === true;
    }
  });

  setOfferPdfTemplate(update);
  res.json(getOfferPdfTemplate());
});
// Reset to the default letterhead - clears every uploaded override image,
// the uploaded Word and PDF cover pages, and the rich-text header/footer,
// switching every piece back off.
router.delete('/pdf-template', requireRole('Admin'), (req, res) => {
  const current = getOfferPdfTemplate();
  ['header_image_path', 'footer_image_path', 'cover_image_path', 'cover_docx_path', 'cover_pdf_path'].forEach(f => {
    if (current[f]) fs.unlink(resolveUploadPath(current[f]), () => {});
  });
  setOfferPdfTemplate(DEFAULT_OFFER_PDF_TEMPLATE);
  res.json(getOfferPdfTemplate());
});

// ===================== Offer governance (immutability / clause-library toggles) =====================
// Admin-only kill switches - see lib/settings.js's DEFAULT_OFFER_GOVERNANCE
// for what each flag controls and why it's deliberately reversible.
router.get('/governance', requireRole('Admin'), (req, res) => {
  res.json(getOfferGovernanceSettings());
});
router.put('/governance', requireRole('Admin'), (req, res) => {
  const { lock_on_so_conversion, require_library_clauses } = req.body;
  const update = {};
  if (lock_on_so_conversion !== undefined) update.lock_on_so_conversion = !!lock_on_so_conversion;
  if (require_library_clauses !== undefined) update.require_library_clauses = !!require_library_clauses;
  setOfferGovernanceSettings(update);
  res.json(getOfferGovernanceSettings());
});

// ===================== Offer PDF design tokens (typography governance) =====================
// Admin-only - see lib/settings.js's DEFAULT_OFFER_DESIGN_TOKENS for what
// each field controls; every default matches what used to be hardcoded in
// lib/offerPdf.js exactly, so an untouched installation is unaffected.
const DESIGN_TOKEN_FIELDS = Object.keys(DEFAULT_OFFER_DESIGN_TOKENS);
router.get('/design-tokens', requireRole('Admin'), (req, res) => {
  res.json(getOfferDesignTokens());
});
router.put('/design-tokens', requireRole('Admin'), (req, res) => {
  const update = {};
  DESIGN_TOKEN_FIELDS.forEach(f => {
    if (req.body[f] === undefined) return;
    if (f === 'show_page_numbers') update[f] = !!req.body[f];
    else if (f === 'body_font_family' || f.endsWith('_color') || f === 'legal_notice_text') update[f] = String(req.body[f]);
    else update[f] = Number(req.body[f]);
  });
  setOfferDesignTokens(update);
  res.json(getOfferDesignTokens());
});
router.delete('/design-tokens', requireRole('Admin'), (req, res) => {
  setOfferDesignTokens(DEFAULT_OFFER_DESIGN_TOKENS);
  res.json(getOfferDesignTokens());
});

// ===================== List / Detail =====================

router.get('/', (req, res) => {
  const { client_id, lead_id } = req.query;
  let q = `
    SELECT o.*, c.name as client_name, l.enquiry_details as lead_enquiry_details
    FROM offers o JOIN clients c ON c.id = o.client_id LEFT JOIN leads l ON l.id = o.lead_id WHERE 1=1
  `;
  const params = [];
  if (client_id) { q += ' AND o.client_id = ?'; params.push(client_id); }
  if (lead_id) { q += ' AND o.lead_id = ?'; params.push(lead_id); }
  q += ' ORDER BY o.id DESC';
  res.json(db.prepare(q).all(...params));
});

function getFullOffer(id) {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(id);
  if (!offer) return null;
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(offer.client_id);
  const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  const techSpecs = db.prepare('SELECT * FROM offer_tech_specs WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  const boughtOut = db.prepare('SELECT * FROM offer_bought_out_items WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  const terms = db.prepare('SELECT * FROM offer_terms WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  return { offer, client, items, techSpecs, boughtOut, terms };
}

router.get('/:id', (req, res) => {
  const full = getFullOffer(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  res.json(full);
});

// ===================== Versioning =====================
// A "family" of an offer's versions all share the same root: the version-1
// offer's own id, referenced by every later version's parent_offer_id.
function familyRootId(offer) { return offer.parent_offer_id || offer.id; }

router.get('/:id/versions', (req, res) => {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  const rootId = familyRootId(offer);
  const versions = db.prepare(`
    SELECT id, offer_no, version, status, offer_date, updated_at, revision_reason FROM offers
    WHERE id = ? OR parent_offer_id = ? ORDER BY version
  `).all(rootId, rootId);
  res.json(versions);
});

// ===================== Create =====================

router.post('/', offerPerm(), (req, res) => {
  const { client_id, lead_id, subject, contact_person, contact_phone, contact_email, application, type_of_system, material_of_construction, drawing_no } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  const offerNo = 'OFR-' + Date.now();

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO offers (offer_no, client_id, lead_id, contact_person, contact_phone, contact_email, subject,
        application, type_of_system, material_of_construction, drawing_no,
        inclusions, exclusions, utilities_requirement, instrument_air_supply, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(offerNo, client_id, lead_id || null, contact_person, contact_phone, contact_email, subject,
      application, type_of_system, material_of_construction, drawing_no,
      defaults.INCLUSIONS, defaults.EXCLUSIONS, defaults.UTILITIES_REQUIREMENT, defaults.INSTRUMENT_AIR_SUPPLY, req.user.id);
    const offerId = info.lastInsertRowid;

    const specStmt = db.prepare(`INSERT INTO offer_tech_specs (offer_id, spec_key, spec_value, sort_order) VALUES (?,?,?,?)`);
    defaults.TECH_SPECS.forEach(([k, v], i) => specStmt.run(offerId, k, v, i));

    const boStmt = db.prepare(`INSERT INTO offer_bought_out_items (offer_id, component, make, sort_order) VALUES (?,?,?,?)`);
    defaults.BOUGHT_OUT_ITEMS.forEach(([c, m], i) => boStmt.run(offerId, c, m, i));

    const termStmt = db.prepare(`INSERT INTO offer_terms (offer_id, term_key, term_value, sort_order) VALUES (?,?,?,?)`);
    defaults.TERMS.forEach(([k, v], i) => termStmt.run(offerId, k, v, i));

    return offerId;
  });

  const offerId = tx();
  res.json({ id: offerId, offer_no: offerNo });
});

// ===================== Update header / narrative fields =====================

// Once an offer has moved past Draft (Sent or later), a header edit is a
// material change to a document that may already be in the customer's
// hands - so instead of silently overwriting it, fork a new version that
// carries the edit, keeping the earlier version exactly as it was sent.
// A plain status change (e.g. Draft -> Sent, or Won/Lost) on the *current*
// version is not itself forked - only real content edits are - so callers
// that only flip status (offer builder's own Confirm/etc. flows) pass no
// other changed fields and are cheap to detect: we fork whenever the offer
// being edited is not in Draft, which covers "materially edited after Sent".
router.put('/:id', offerPerm(), (req, res) => {
  const f = req.body;
  const existing = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  let targetId = existing.id;
  let forked = false;
  if (existing.status !== 'Draft' && !f.statusOnly) {
    const version = ensureEditableVersion(existing.id, req.user.id, f.revision_reason);
    targetId = version.id;
    forked = true;
  }

  db.prepare(`
    UPDATE offers SET subject=?, contact_person=?, contact_phone=?, contact_email=?,
      application=?, type_of_system=?, material_of_construction=?, drawing_no=?,
      inclusions=?, exclusions=?, utilities_requirement=?, instrument_air_supply=?,
      show_tech_specs=?, show_bought_out=?, show_inclusions_exclusions=?,
      status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(f.subject, f.contact_person, f.contact_phone, f.contact_email,
    f.application, f.type_of_system, f.material_of_construction, f.drawing_no,
    f.inclusions, f.exclusions, f.utilities_requirement, f.instrument_air_supply,
    f.show_tech_specs !== undefined ? (f.show_tech_specs ? 1 : 0) : existing.show_tech_specs,
    f.show_bought_out !== undefined ? (f.show_bought_out ? 1 : 0) : existing.show_bought_out,
    f.show_inclusions_exclusions !== undefined ? (f.show_inclusions_exclusions ? 1 : 0) : existing.show_inclusions_exclusions,
    forked ? 'Draft' : (f.status || existing.status || 'Draft'), targetId);
  res.json({ ok: true, newVersion: forked, id: targetId });
});

// ===================== Scope of Supply items (machinery, qty, price, picture) =====================

router.post('/:id/items', offerPerm(), upload.single('image'), (req, res) => {
  const { item_code, section_title, description, qty, unit_price, sort_order, revision_reason, section_title_id } = req.body;
  const version = ensureEditableVersion(req.params.id, req.user.id, revision_reason);
  const q = Number(qty || 1), rate = Number(unit_price || 0);
  let imagePath = req.file ? '/uploads/offers/' + req.file.filename : null;
  // No file uploaded by hand, but a library entry was picked and it has a
  // picture on file - a browser can't pre-fill a file input for security
  // reasons, so this is how the picture actually carries over.
  if (!imagePath && section_title_id) {
    const lib = db.prepare('SELECT image_path FROM section_title_library WHERE id = ?').get(section_title_id);
    if (lib) imagePath = copyLibraryImage(lib.image_path);
  }
  const info = db.prepare(`
    INSERT INTO offer_items (offer_id, item_code, section_title, description, image_path, qty, unit_price, total_price, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(version.id, item_code, section_title, description, imagePath, q, rate, q * rate, sort_order || 0);
  res.json({ id: info.lastInsertRowid, image_path: imagePath, newVersion: version.forked, offerId: version.id });
});

router.put('/:id/items/:itemId', offerPerm(), upload.single('image'), (req, res) => {
  const { item_code, section_title, description, qty, unit_price, sort_order, revision_reason, section_title_id } = req.body;
  const q = Number(qty || 1), rate = Number(unit_price || 0);
  const existing = db.prepare('SELECT * FROM offer_items WHERE id = ?').get(req.params.itemId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const version = ensureEditableVersion(existing.offer_id, req.user.id, revision_reason);
  const targetItemId = version.itemIdMap.get(existing.id);
  let imagePath = existing.image_path;
  if (req.file) {
    imagePath = '/uploads/offers/' + req.file.filename;
    // Only delete the old file in place (Draft edit, one row references it) -
    // a forked copy's row still points at the same file, so the frozen
    // earlier version needs it to keep existing.
    if (existing.image_path && !version.forked) {
      fs.unlink(resolveUploadPath(existing.image_path), () => {});
    }
  } else if (section_title_id) {
    // Same "no manual file, but a library entry was picked" fallback as
    // create - gets its own fresh copy, same unlink-the-old-one rule as above.
    const lib = db.prepare('SELECT image_path FROM section_title_library WHERE id = ?').get(section_title_id);
    const copied = lib ? copyLibraryImage(lib.image_path) : null;
    if (copied) {
      if (existing.image_path && !version.forked) {
        fs.unlink(resolveUploadPath(existing.image_path), () => {});
      }
      imagePath = copied;
    }
  }
  db.prepare(`
    UPDATE offer_items SET item_code=?, section_title=?, description=?, image_path=?, qty=?, unit_price=?, total_price=?, sort_order=?
    WHERE id=?
  `).run(item_code, section_title, description, imagePath, q, rate, q * rate, sort_order || existing.sort_order, targetItemId);
  res.json({ ok: true, image_path: imagePath, newVersion: version.forked, offerId: version.id });
});

router.delete('/:id/items/:itemId', offerPerm(), (req, res) => {
  const existing = db.prepare('SELECT * FROM offer_items WHERE id = ?').get(req.params.itemId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const version = ensureEditableVersion(existing.offer_id, req.user.id, req.body && req.body.revision_reason);
  const targetItemId = version.itemIdMap.get(existing.id);
  // Same reasoning as the image replacement above - a forked copy's row
  // shares the physical file with the frozen earlier version's row.
  if (existing.image_path && !version.forked) {
    fs.unlink(resolveUploadPath(existing.image_path), () => {});
  }
  db.prepare('DELETE FROM offer_items WHERE id = ?').run(targetItemId);
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});

// ===================== Bulk-replace helpers for the editable sheets =====================
// Each of tech-specs / bought-out / terms is a simple ordered key-value list;
// the frontend sends the full current list back and we replace wholesale -
// this keeps prefilled-but-editable-and-addable rows simple to implement.

function bulkReplace(table, offerId, rows, colA, colB) {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${table} WHERE offer_id = ?`).run(offerId);
    const stmt = db.prepare(`INSERT INTO ${table} (offer_id, ${colA}, ${colB}, sort_order) VALUES (?,?,?,?)`);
    rows.forEach((r, i) => stmt.run(offerId, r[colA], r[colB], i));
  });
  tx();
}

router.put('/:id/tech-specs', offerPerm(), (req, res) => {
  const version = ensureEditableVersion(req.params.id, req.user.id, req.body.revision_reason);
  bulkReplace('offer_tech_specs', version.id, req.body.rows || [], 'spec_key', 'spec_value');
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});
router.put('/:id/bought-out', offerPerm(), (req, res) => {
  const version = ensureEditableVersion(req.params.id, req.user.id, req.body.revision_reason);
  bulkReplace('offer_bought_out_items', version.id, req.body.rows || [], 'component', 'make');
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});
router.put('/:id/terms', offerPerm(), (req, res) => {
  const version = ensureEditableVersion(req.params.id, req.user.id, req.body.revision_reason);
  bulkReplace('offer_terms', version.id, req.body.rows || [], 'term_key', 'term_value');
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});

// ===================== PDF generation =====================

router.get('/:id/pdf', async (req, res) => {
  const full = getFullOffer(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  const itemsForPdf = full.items.map(it => {
    let image_data_uri = null;
    if (it.image_path) {
      try {
        const abs = resolveUploadPath(it.image_path);
        const ext = path.extname(abs).slice(1).toLowerCase() || 'jpeg';
        const b64 = fs.readFileSync(abs).toString('base64');
        image_data_uri = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}`;
      } catch (e) { /* image missing on disk - skip silently */ }
    }
    return { ...it, image_data_uri };
  });
  try {
    const gen = await generateOfferPdf(full.offer, full.client, itemsForPdf, full.techSpecs, full.boughtOut, full.terms);
    res.download(gen.outPath, `${full.offer.offer_no}.pdf`, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ===================== Confirm -> Sales Order + Execution Queue (Project) =====================

router.post('/:id/confirm', requirePermission('sales_order.manage'), async (req, res) => {
  const full = getFullOffer(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  if (full.offer.status === 'Won' && full.offer.sales_order_id) {
    return res.status(400).json({ error: 'Offer already confirmed into a sales order' });
  }
  const orderValue = full.items.reduce((a, b) => a + Number(b.total_price || 0), 0);

  const tx = db.transaction(() => {
    const orderNo = 'SO-' + Date.now();
    const soInfo = db.prepare(`
      INSERT INTO sales_orders (order_no, client_id, description, order_value, created_by)
      VALUES (?,?,?,?,?)
    `).run(orderNo, full.offer.client_id, full.offer.subject, orderValue, req.user.id);
    const salesOrderId = soInfo.lastInsertRowid;

    const projCode = 'PRJ-' + Date.now();
    const projInfo = db.prepare(`
      INSERT INTO projects (project_code, sales_order_id, title, pm_id, start_date)
      VALUES (?,?,?,?, date('now'))
    `).run(projCode, salesOrderId, full.offer.subject || full.client.name, req.user.id);
    const projectId = projInfo.lastInsertRowid;

    createJobCardsForProject(db, projectId);

    // Round 40: lock the offer against further edits/forks the moment it
    // becomes a real Sales Order - gated by an admin-editable, reversible
    // setting rather than hardcoded on, so a site that needs the old
    // "conversion never locks" behavior can flip it off instantly.
    const governance = getOfferGovernanceSettings();
    const lockIt = governance.lock_on_so_conversion;
    db.prepare(`
      UPDATE offers SET status = 'Won', sales_order_id = ?, locked = ?, locked_at = ?, locked_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(salesOrderId, lockIt ? 1 : 0, lockIt ? new Date().toISOString() : null,
      lockIt ? ('Converted to Sales Order ' + orderNo) : null, full.offer.id);

    return { salesOrderId, orderNo, projectId, projCode };
  });

  const result = tx();

  // Generate the internal execution annexure (technical content only, no
  // pricing) and attach it to the new sales order. Failure here shouldn't
  // block the order from being created - it can be regenerated on demand.
  try {
    const salesOrder = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(result.salesOrderId);
    const annex = await generateAnnexureDocx({
      salesOrder, client: full.client, offer: full.offer,
      items: full.items, techSpecs: full.techSpecs, boughtOut: full.boughtOut,
    });
    db.prepare('UPDATE sales_orders SET annexure_path = ? WHERE id = ?').run(annex.relativePath, result.salesOrderId);
    result.annexureFile = annex.fileName;
  } catch (e) {
    console.error('Annexure generation failed:', e);
    result.annexureError = e.message;
  }

  res.json(result);
});

// Emergency escape hatch for a locked offer (e.g. a conversion recorded in
// error) - Admin-only, and requires a reason so the audit_log entry it
// writes actually explains why. Unlike lock_on_so_conversion above, this
// reverses a SPECIFIC offer's lock, not the policy that sets it.
router.post('/:id/unlock', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!existing.locked) return res.status(400).json({ error: 'This offer is not locked.' });
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'Enter a reason for unlocking this offer.' });
  db.prepare(`UPDATE offers SET locked = 0, locked_at = NULL, locked_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
  db.prepare(`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)`)
    .run(req.user.id, 'offer_unlock', 'offer', existing.id, reason);
  res.json({ ok: true });
});

module.exports = router;

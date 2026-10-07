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
const { offerVisibilityWhere, canSeeOffer } = require('../lib/offerVisibility');
const { getOfferPdfTemplate, setOfferPdfTemplate, DEFAULT_OFFER_PDF_TEMPLATE, getOfferGovernanceSettings, setOfferGovernanceSettings, getOfferPdfLayout, setOfferPdfLayoutPiece, getCompanySettings } = require('../lib/settings');
const { compressImage, compressUploadedImageFile } = require('../lib/imageCompress');

const router = express.Router();
router.use(authRequired);

const { getUploadsSubdir, resolveUploadPath } = require('../lib/paths');
const { buildDownloadFilename } = require('../lib/downloadFilename');
const uploadDir = getUploadsSubdir('offers');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function offerPerm() { return requirePermission('sales_order.manage', 'lead.manage'); }

// Runs right after multer's upload.single('image') so every offer/library
// image is shrunk on the way in, not just at PDF/Word render time - keeps
// disk usage down and makes every later generation cheaper. A compression
// failure never fails the upload itself (see lib/imageCompress.js).
async function compressUploadedImage(req, res, next) {
  if (!req.file) return next();
  try {
    const newFilename = await compressUploadedImageFile(req.file.path);
    req.file.filename = newFilename;
    req.file.path = path.join(path.dirname(req.file.path), newFilename);
  } catch (e) { /* leave the file exactly as multer saved it */ }
  next();
}

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

// A user typing a brand-new section title on an offer item (the "type a
// new one" path, bypassing the library dropdown) never reaches
// section_title_library on its own - this is what gets it in front of an
// Admin instead of just vanishing onto that one offer item. Never touches
// the offer item itself (that already saved with its typed text either
// way); skipped entirely if the title already matches something in the
// library, or a suggestion for it is already pending, so re-saving the
// same item repeatedly doesn't spam the review queue.
function maybeSuggestNewSectionTitle({ offerId, itemId, title, description, summary, imagePath, userId }) {
  const trimmed = String(title || '').trim();
  if (!trimmed) return;
  const inLibrary = db.prepare(`SELECT id FROM section_title_library WHERE LOWER(title) = LOWER(?)`).get(trimmed);
  if (inLibrary) return;
  const alreadyPending = db.prepare(`SELECT id FROM section_title_suggestions WHERE LOWER(title) = LOWER(?) AND status = 'Pending'`).get(trimmed);
  if (alreadyPending) return;

  const suggestionImagePath = imagePath ? copyLibraryImage(imagePath) : null;
  const info = db.prepare(`
    INSERT INTO section_title_suggestions (title, description, summary, image_path, offer_id, offer_item_id, suggested_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(trimmed, description || null, summary || null, suggestionImagePath, offerId, itemId || null, userId);

  const brief = `Review new Section Title suggestion: "${trimmed}"`;
  const admins = db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Admin' AND u.is_active = 1`).all();
  const today = new Date().toISOString().slice(0, 10);
  const targetDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  for (const admin of admins) {
    db.prepare(`
      INSERT INTO todos (hod_id, assigned_to, start_date, target_date, brief_description, details, priority, source_type, source_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(admin.id, admin.id, today, targetDate, brief,
      `Typed on an offer instead of picked from the library - review on the Offer Field Options page and Approve to add it to the Section Title Library, or Reject to discard.`,
      'Normal', 'SECTION_TITLE_SUGGESTION', info.lastInsertRowid);
    db.prepare(`INSERT INTO notifications (user_id, source_type, source_id, message) VALUES (?,?,?,?)`)
      .run(admin.id, 'SECTION_TITLE_SUGGESTION', info.lastInsertRowid, brief);
  }
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
router.post('/section-titles', requireRole('Admin'), upload.single('image'), compressUploadedImage, (req, res) => {
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
router.put('/section-titles/:id', requireRole('Admin'), upload.single('image'), compressUploadedImage, (req, res) => {
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

// ---- Section Title suggestions review queue (see maybeSuggestNewSectionTitle) ----
router.get('/section-title-suggestions', requireRole('Admin'), (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, o.offer_no, u.full_name as suggested_by_name
    FROM section_title_suggestions s
    LEFT JOIN offers o ON o.id = s.offer_id
    LEFT JOIN users u ON u.id = s.suggested_by
    WHERE s.status = 'Pending'
    ORDER BY s.id DESC
  `).all());
});
router.post('/section-title-suggestions/:id/approve', requireRole('Admin'), (req, res) => {
  const suggestion = db.prepare(`SELECT * FROM section_title_suggestions WHERE id = ?`).get(req.params.id);
  if (!suggestion) return res.status(404).json({ error: 'Not found' });
  if (suggestion.status !== 'Pending') return res.status(400).json({ error: 'This suggestion has already been reviewed.' });
  try {
    db.prepare(`INSERT INTO section_title_library (title, description, summary, image_path, created_by) VALUES (?,?,?,?,?)`)
      .run(suggestion.title, suggestion.description, suggestion.summary, suggestion.image_path, req.user.id);
  } catch (e) {
    return res.status(400).json({ error: 'That title already exists in the library - reject this suggestion instead.' });
  }
  db.prepare(`UPDATE section_title_suggestions SET status = 'Approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.user.id, suggestion.id);
  res.json({ ok: true });
});
router.post('/section-title-suggestions/:id/reject', requireRole('Admin'), (req, res) => {
  const suggestion = db.prepare(`SELECT * FROM section_title_suggestions WHERE id = ?`).get(req.params.id);
  if (!suggestion) return res.status(404).json({ error: 'Not found' });
  if (suggestion.status !== 'Pending') return res.status(400).json({ error: 'This suggestion has already been reviewed.' });
  if (suggestion.image_path) fs.unlink(resolveUploadPath(suggestion.image_path), () => {});
  db.prepare(`UPDATE section_title_suggestions SET status = 'Rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.user.id, suggestion.id);
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
]);
// Trusted, Admin-only input (same trust level as the uploaded image paths)
// so a piece designed in the Offer PDF Layout Designer is stored as-is, but
// this strips a <script> tag anyway as a defense-in-depth floor before it's
// ever injected into the PDF's header/footer/cover template.
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

  setOfferPdfTemplate(update);
  res.json(getOfferPdfTemplate());
});
// Reset to the default letterhead - clears every uploaded override image,
// switching every piece back off.
router.delete('/pdf-template', requireRole('Admin'), (req, res) => {
  const current = getOfferPdfTemplate();
  ['header_image_path', 'footer_image_path', 'cover_image_path'].forEach(f => {
    if (current[f]) fs.unlink(resolveUploadPath(current[f]), () => {});
  });
  setOfferPdfTemplate(DEFAULT_OFFER_PDF_TEMPLATE);
  res.json(getOfferPdfTemplate());
});

// ===================== Full custom body template (Word upload) =====================
// One-time conversion step: an uploaded .docx becomes HTML the Admin then
// hand-edits (inserting {{token}} merge fields and a repeat block for the
// scope-of-supply rows - see lib/offerPdf.js's bodyHtml()/expandRepeatBlocks)
// before saving it as the active template via PUT /pdf-template/custom-body
// below. This route only converts and returns the HTML - it does NOT save
// or activate anything on its own, so an Admin can review/edit first.
router.post('/pdf-template/convert-docx', requireRole('Admin'), upload.single('docx'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.convertToHtml({ path: req.file.path });
    res.json({ html: result.value, warnings: (result.messages || []).map(m => m.message) });
  } catch (e) {
    res.status(400).json({ error: 'Could not read that file - is it a valid .docx? (' + e.message + ')' });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});
router.put('/pdf-template/custom-body', requireRole('Admin'), (req, res) => {
  const { active, html } = req.body;
  const update = {};
  if (active !== undefined) update.custom_body_active = !!active;
  if (html !== undefined) update.custom_body_html = stripScriptTags(String(html));
  setOfferPdfTemplate(update);
  res.json(getOfferPdfTemplate());
});

// ===================== Offer PDF Layout Designer (visual drag-and-drop) =====================
// A newer, higher-precedence alternative to the override pieces above - see
// lib/settings.js's DEFAULT_OFFER_PDF_LAYOUT for the data shape and
// lib/offerPdf.js's headerTemplate()/footerTemplate()/coverPage() for where
// it slots into the render precedence. Admin-only, same as the rest of this
// template-manager area.
const PDF_LAYOUT_PIECES = ['header', 'footer', 'cover'];

router.get('/pdf-layout', requireRole('Admin'), (req, res) => {
  res.json(getOfferPdfLayout());
});

// Saves one piece at a time (the designer UI edits header/footer/cover as
// separate tabs) - html/css are GrapesJS's own exported strings, project is
// its full project data (so the designer can re-open this piece later).
router.put('/pdf-layout/:piece', requireRole('Admin'), (req, res) => {
  const { piece } = req.params;
  if (!PDF_LAYOUT_PIECES.includes(piece)) return res.status(400).json({ error: 'piece must be one of: ' + PDF_LAYOUT_PIECES.join(', ') });
  const { active, html, css, project } = req.body;
  const update = {};
  if (active !== undefined) update.active = !!active;
  if (html !== undefined) update.html = stripScriptTags(String(html));
  if (css !== undefined) update.css = String(css);
  if (project !== undefined) update.project = project;
  res.json(setOfferPdfLayoutPiece(piece, update));
});

// Clears one piece back to inactive/empty - the other two pieces (and their
// own active state) are untouched.
router.delete('/pdf-layout/:piece', requireRole('Admin'), (req, res) => {
  const { piece } = req.params;
  if (!PDF_LAYOUT_PIECES.includes(piece)) return res.status(400).json({ error: 'piece must be one of: ' + PDF_LAYOUT_PIECES.join(', ') });
  res.json(setOfferPdfLayoutPiece(piece, { active: false, html: '', css: '', project: null }));
});

// ===================== Offer governance (immutability / clause-library toggles) =====================
// Admin-only kill switches - see lib/settings.js's DEFAULT_OFFER_GOVERNANCE
// for what each flag controls and why it's deliberately reversible.
router.get('/governance', requireRole('Admin'), (req, res) => {
  res.json(getOfferGovernanceSettings());
});
router.put('/governance', requireRole('Admin'), (req, res) => {
  const { lock_on_so_conversion, require_library_clauses, restrict_offers_to_creator } = req.body;
  const update = {};
  if (lock_on_so_conversion !== undefined) update.lock_on_so_conversion = !!lock_on_so_conversion;
  if (require_library_clauses !== undefined) update.require_library_clauses = !!require_library_clauses;
  if (restrict_offers_to_creator !== undefined) update.restrict_offers_to_creator = !!restrict_offers_to_creator;
  setOfferGovernanceSettings(update);
  res.json(getOfferGovernanceSettings());
});

// ===================== List / Detail =====================

router.get('/', (req, res) => {
  const { client_id, lead_id } = req.query;
  // Standard Templates (is_template=1) are never real customer quotes, so
  // they're excluded from this list by default - see GET /templates below,
  // the library view every offer-permission user (not just Admin) can
  // browse to pick one to copy from.
  // Offers visibility restriction (2026-10-07, Admin-editable governance
  // flag, off by default) - see lib/offerVisibility.js for the rule.
  const vis = offerVisibilityWhere(req.user);
  let q = `
    SELECT o.*, c.name as client_name, l.enquiry_details as lead_enquiry_details
    FROM offers o JOIN clients c ON c.id = o.client_id LEFT JOIN leads l ON l.id = o.lead_id
    ${vis.join}
    WHERE o.is_template = 0 AND (${vis.where})
  `;
  const params = [...vis.params];
  if (client_id) { q += ' AND o.client_id = ?'; params.push(client_id); }
  if (lead_id) { q += ' AND o.lead_id = ?'; params.push(lead_id); }
  q += ' ORDER BY o.id DESC';
  res.json(db.prepare(q).all(...params));
});

// Offer Templates library (2026-10-06) - Standard Templates an Admin
// maintains for Sales to reuse. Open to anyone with offer access to browse
// (so they can pick one to copy from via POST /:id/copy - "Create Offer
// from Template" in the UI); only Admin can create/edit/delete one (see
// the is_template branch of POST / below, and ensureEditableVersion's own
// is_template guard in lib/offerVersioning.js). Registered before GET
// /:id - Express matches routes in registration order and ':id' would
// otherwise swallow the literal string "templates", the same
// :id-before-literal-sibling bug already hit and fixed several times
// elsewhere in this codebase (Employee/Vendor "Download Template", the
// Purchase Invoice line picker).
router.get('/templates', offerPerm(), (req, res) => {
  res.json(db.prepare(`SELECT * FROM offers WHERE is_template = 1 ORDER BY id DESC`).all());
});

function getFullOffer(id) {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(id);
  if (!offer) return null;
  // A Standard Template has no client (client_id is null) - see is_template
  // above.
  const client = offer.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(offer.client_id) : null;
  const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  const techSpecs = db.prepare('SELECT * FROM offer_tech_specs WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  const boughtOut = db.prepare('SELECT * FROM offer_bought_out_items WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  const terms = db.prepare('SELECT * FROM offer_terms WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  const equipmentReferences = db.prepare('SELECT * FROM offer_equipment_references WHERE offer_id = ? ORDER BY sort_order, id').all(id);
  return { offer, client, items, techSpecs, boughtOut, terms, equipmentReferences };
}

router.get('/:id', (req, res) => {
  const full = getFullOffer(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  // Offers visibility restriction (2026-10-07) - see lib/offerVisibility.js.
  // Detail-only: every mutating route below stays gated purely by the
  // existing offerPerm()/is_template checks, not this - it's about who can
  // see an offer, not who can act on one they already know the id of.
  if (!canSeeOffer(req.user, full.offer)) return res.status(403).json({ error: 'Access denied' });
  res.json(full);
});

// Commercial terms (delivery/LD/BG) - same shape and same "lightweight PATCH,
// no version fork" reasoning as sales_orders' equivalent endpoint. These
// aren't customer-facing offer content being revised, just the internal
// record of what we're proposing to commit to, filled in whenever it's known
// (often before all of the offer's other content is finalized). Copied into
// the Sales Order as its starting terms when the offer is confirmed (see
// POST /:id/confirm below).
router.patch('/:id/commercial-terms', offerPerm(), (req, res) => {
  const existing = db.prepare('SELECT id, is_template FROM offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.is_template && req.user.role_name !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can edit a Standard Template - use "Create Offer from Template" to start a real customer offer from it.' });
  }
  const {
    promised_delivery_date, ld_percentage, ld_cap_percentage, ld_trigger_notes,
    abg_required, abg_percentage, abg_amount, abg_validity_days,
    pbg_required, pbg_percentage, pbg_amount, pbg_validity_days, bg_terms_notes,
  } = req.body;
  db.prepare(`
    UPDATE offers SET promised_delivery_date = ?, ld_percentage = ?, ld_cap_percentage = ?, ld_trigger_notes = ?,
      abg_required = ?, abg_percentage = ?, abg_amount = ?, abg_validity_days = ?,
      pbg_required = ?, pbg_percentage = ?, pbg_amount = ?, pbg_validity_days = ?, bg_terms_notes = ?
    WHERE id = ?
  `).run(promised_delivery_date || null, ld_percentage || null, ld_cap_percentage || null, ld_trigger_notes || null,
    abg_required ? 1 : 0, abg_percentage || null, abg_amount || null, abg_validity_days || null,
    pbg_required ? 1 : 0, pbg_percentage || null, pbg_amount || null, pbg_validity_days || null, bg_terms_notes || null,
    req.params.id);
  res.json({ ok: true });
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
  const { client_id, lead_id, subject, contact_person, contact_phone, contact_email, application, type_of_system, material_of_construction, drawing_no, is_template } = req.body;
  // A Standard Template (Offer Templates library, 2026-10-06) isn't tied to
  // any real customer - Admin-only to create (and, via
  // ensureEditableVersion's own guard, to edit afterward); everyone else
  // with offer access can only browse the library and copy one into a real
  // customer offer (POST /:id/copy - unaffected, see that route's comment).
  if (is_template && req.user.role_name !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can create a Standard Template.' });
  }
  if (!is_template && !client_id) return res.status(400).json({ error: 'client_id is required' });
  const offerNo = 'OFR-' + Date.now();

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO offers (offer_no, client_id, lead_id, contact_person, contact_phone, contact_email, subject,
        application, type_of_system, material_of_construction, drawing_no,
        inclusions, exclusions, utilities_requirement, instrument_air_supply, is_template, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(offerNo, is_template ? null : client_id, is_template ? null : (lead_id || null), contact_person, contact_phone, contact_email, subject,
      application, type_of_system, material_of_construction, drawing_no,
      defaults.INCLUSIONS, defaults.EXCLUSIONS, defaults.UTILITIES_REQUIREMENT, defaults.INSTRUMENT_AIR_SUPPLY, is_template ? 1 : 0, req.user.id);
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

// Duplicates an image file under uploads/offers with a guaranteed-unique
// name. copyLibraryImage() above (Date.now()-only) is fine for its
// single-call-per-request use sites, but copying every item/equipment-
// reference picture of a whole offer in one request can easily complete
// more than one fs.copyFileSync within the same millisecond and collide -
// the counter guarantees uniqueness regardless of how fast the loop runs.
let offerCopySeq = 0;
function duplicateOfferImage(imagePath) {
  if (!imagePath) return null;
  const srcAbs = resolveUploadPath(imagePath);
  if (!fs.existsSync(srcAbs)) return null;
  const destName = `${Date.now()}-${offerCopySeq++}-copy${path.extname(imagePath)}`;
  fs.copyFileSync(srcAbs, path.join(uploadDir, destName));
  return '/uploads/offers/' + destName;
}

// Duplicates an entire offer's content into a brand-new, fully independent
// offer for a DIFFERENT customer - new offer_no, version 1, no lineage back
// to the source. This is deliberately separate from ensureEditableVersion's
// fork (lib/offerVersioning.js), which revises the SAME offer for the SAME
// customer and keeps a version-history link; a copy is an unrelated new
// document that just happens to start from the same content.
//
// Every picture is physically duplicated on disk (never the path string
// reused) so later editing/deleting a picture on the new offer can never
// touch the source offer's files - unlike a version fork, these two offers
// share no lineage or immutability relationship that would make reusing the
// file safe.
//
// Can copy from an offer in any status, including locked/Won ones -
// copying never writes to the source, so its lock is irrelevant here.
router.post('/:id/copy', offerPerm(), (req, res) => {
  const source = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const { client_id, lead_id, contact_person, contact_phone, contact_email } = req.body;
  if (!client_id) return res.status(400).json({ error: 'Pick a customer to copy this offer to.' });
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(400).json({ error: 'That customer no longer exists - refresh and try again.' });

  const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY sort_order, id').all(source.id);
  const techSpecs = db.prepare('SELECT * FROM offer_tech_specs WHERE offer_id = ? ORDER BY sort_order, id').all(source.id);
  const boughtOut = db.prepare('SELECT * FROM offer_bought_out_items WHERE offer_id = ? ORDER BY sort_order, id').all(source.id);
  const terms = db.prepare('SELECT * FROM offer_terms WHERE offer_id = ? ORDER BY sort_order, id').all(source.id);
  const equipmentRefs = db.prepare('SELECT * FROM offer_equipment_references WHERE offer_id = ? ORDER BY sort_order, id').all(source.id);
  const offerNo = 'OFR-' + Date.now();

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO offers (offer_no, client_id, lead_id, contact_person, contact_phone, contact_email, subject,
        drawing_no, application, type_of_system, material_of_construction,
        inclusions, exclusions, utilities_requirement, instrument_air_supply,
        show_tech_specs, show_bought_out, show_inclusions_exclusions,
        promised_delivery_date, ld_percentage, ld_cap_percentage, ld_trigger_notes,
        abg_required, abg_percentage, abg_amount, abg_validity_days,
        pbg_required, pbg_percentage, pbg_amount, pbg_validity_days, bg_terms_notes,
        created_by)
      VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?)
    `).run(offerNo, client_id, lead_id || null, contact_person || null, contact_phone || null, contact_email || null, source.subject,
      source.drawing_no, source.application, source.type_of_system, source.material_of_construction,
      source.inclusions, source.exclusions, source.utilities_requirement, source.instrument_air_supply,
      source.show_tech_specs, source.show_bought_out, source.show_inclusions_exclusions,
      source.promised_delivery_date, source.ld_percentage, source.ld_cap_percentage, source.ld_trigger_notes,
      source.abg_required, source.abg_percentage, source.abg_amount, source.abg_validity_days,
      source.pbg_required, source.pbg_percentage, source.pbg_amount, source.pbg_validity_days, source.bg_terms_notes,
      req.user.id);
    const newId = Number(info.lastInsertRowid);

    const itemStmt = db.prepare(`
      INSERT INTO offer_items (offer_id, item_code, section_title, description, summary, image_path, qty, unit_price, total_price, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    items.forEach(it => {
      itemStmt.run(newId, it.item_code, it.section_title, it.description, it.summary, duplicateOfferImage(it.image_path), it.qty, it.unit_price, it.total_price, it.sort_order);
    });
    const specStmt = db.prepare(`INSERT INTO offer_tech_specs (offer_id, spec_key, spec_value, sort_order) VALUES (?,?,?,?)`);
    techSpecs.forEach(s => specStmt.run(newId, s.spec_key, s.spec_value, s.sort_order));
    const boStmt = db.prepare(`INSERT INTO offer_bought_out_items (offer_id, component, make, sort_order) VALUES (?,?,?,?)`);
    boughtOut.forEach(b => boStmt.run(newId, b.component, b.make, b.sort_order));
    const termStmt = db.prepare(`INSERT INTO offer_terms (offer_id, term_key, term_value, sort_order) VALUES (?,?,?,?)`);
    terms.forEach(t => termStmt.run(newId, t.term_key, t.term_value, t.sort_order));
    const refStmt = db.prepare(`
      INSERT INTO offer_equipment_references (offer_id, section_title_library_id, title, summary, image_path, sort_order)
      VALUES (?,?,?,?,?,?)
    `);
    equipmentRefs.forEach(r => refStmt.run(newId, r.section_title_library_id, r.title, r.summary, duplicateOfferImage(r.image_path), r.sort_order));

    return newId;
  });
  const newId = tx();
  res.json({ id: newId, offer_no: offerNo });
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
  // A Standard Template stays Draft forever (mark-sent is blocked on one -
  // see POST /:id/mark-sent), so the ensureEditableVersion() call below
  // never actually runs for it (it's conditional on having left Draft) -
  // its own is_template guard would never fire here. Checked directly
  // instead, same as commercial-terms/mark-sent/confirm above.
  if (existing.is_template && req.user.role_name !== 'Admin') {
    return res.status(403).json({ error: 'Only Admin can edit a Standard Template - use "Create Offer from Template" to start a real customer offer from it.' });
  }

  let targetId = existing.id;
  let forked = false;
  if (existing.status !== 'Draft' && !f.statusOnly) {
    const version = ensureEditableVersion(existing.id, req.user.id, f.revision_reason, req.user.role_name === 'Admin');
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

router.post('/:id/items', offerPerm(), upload.single('image'), compressUploadedImage, (req, res) => {
  const { item_code, section_title, description, summary, qty, unit_price, sort_order, revision_reason, section_title_id } = req.body;
  const version = ensureEditableVersion(req.params.id, req.user.id, revision_reason, req.user.role_name === 'Admin');
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
    INSERT INTO offer_items (offer_id, item_code, section_title, description, summary, image_path, qty, unit_price, total_price, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(version.id, item_code, section_title, description, summary || null, imagePath, q, rate, q * rate, sort_order || 0);
  if (!section_title_id) {
    maybeSuggestNewSectionTitle({
      offerId: version.id, itemId: info.lastInsertRowid, title: section_title,
      description, summary, imagePath, userId: req.user.id,
    });
  }
  res.json({ id: info.lastInsertRowid, image_path: imagePath, newVersion: version.forked, offerId: version.id });
});

router.put('/:id/items/:itemId', offerPerm(), upload.single('image'), compressUploadedImage, (req, res) => {
  const { item_code, section_title, description, summary, qty, unit_price, sort_order, revision_reason, section_title_id } = req.body;
  const q = Number(qty || 1), rate = Number(unit_price || 0);
  const existing = db.prepare('SELECT * FROM offer_items WHERE id = ?').get(req.params.itemId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const version = ensureEditableVersion(existing.offer_id, req.user.id, revision_reason, req.user.role_name === 'Admin');
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
    UPDATE offer_items SET item_code=?, section_title=?, description=?, summary=?, image_path=?, qty=?, unit_price=?, total_price=?, sort_order=?
    WHERE id=?
  `).run(item_code, section_title, description, summary || null, imagePath, q, rate, q * rate, sort_order || existing.sort_order, targetItemId);
  if (!section_title_id) {
    maybeSuggestNewSectionTitle({
      offerId: version.id, itemId: targetItemId, title: section_title,
      description, summary, imagePath, userId: req.user.id,
    });
  }
  res.json({ ok: true, image_path: imagePath, newVersion: version.forked, offerId: version.id });
});

router.delete('/:id/items/:itemId', offerPerm(), (req, res) => {
  const existing = db.prepare('SELECT * FROM offer_items WHERE id = ?').get(req.params.itemId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const version = ensureEditableVersion(existing.offer_id, req.user.id, req.body && req.body.revision_reason, req.user.role_name === 'Admin');
  const targetItemId = version.itemIdMap.get(existing.id);
  // Same reasoning as the image replacement above - a forked copy's row
  // shares the physical file with the frozen earlier version's row.
  if (existing.image_path && !version.forked) {
    fs.unlink(resolveUploadPath(existing.image_path), () => {});
  }
  // Same FK reasoning as the offer-delete route above - a suggestion
  // (see maybeSuggestNewSectionTitle) can reference this exact item row.
  db.prepare('DELETE FROM section_title_suggestions WHERE offer_item_id = ?').run(targetItemId);
  db.prepare('DELETE FROM offer_items WHERE id = ?').run(targetItemId);
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});

// ===================== Equipment Description references (customer-reference
// pictures/summaries, decoupled from pricing - see db/index.js's
// offer_equipment_references comment) =====================
router.post('/:id/equipment-references', offerPerm(), (req, res) => {
  const { section_title_library_id, revision_reason } = req.body;
  if (!section_title_library_id) return res.status(400).json({ error: 'Pick a library entry.' });
  const lib = db.prepare('SELECT * FROM section_title_library WHERE id = ?').get(section_title_library_id);
  if (!lib) return res.status(400).json({ error: 'That library entry no longer exists - refresh and pick again.' });
  const version = ensureEditableVersion(req.params.id, req.user.id, revision_reason, req.user.role_name === 'Admin');
  const imagePath = lib.image_path ? copyLibraryImage(lib.image_path) : null;
  const info = db.prepare(`
    INSERT INTO offer_equipment_references (offer_id, section_title_library_id, title, summary, image_path, sort_order)
    VALUES (?,?,?,?,?,?)
  `).run(version.id, lib.id, lib.title, lib.summary || null, imagePath, req.body.sort_order || 0);
  res.json({ id: info.lastInsertRowid, newVersion: version.forked, offerId: version.id });
});
router.delete('/:id/equipment-references/:refId', offerPerm(), (req, res) => {
  const existing = db.prepare('SELECT * FROM offer_equipment_references WHERE id = ?').get(req.params.refId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const version = ensureEditableVersion(existing.offer_id, req.user.id, req.body && req.body.revision_reason, req.user.role_name === 'Admin');
  const targetRefId = version.equipmentRefIdMap.get(existing.id);
  // Same reasoning as the Scope-of-Supply item delete above - a forked
  // copy's row shares the physical file with the frozen earlier version's.
  if (existing.image_path && !version.forked) {
    fs.unlink(resolveUploadPath(existing.image_path), () => {});
  }
  db.prepare('DELETE FROM offer_equipment_references WHERE id = ?').run(targetRefId);
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
  const version = ensureEditableVersion(req.params.id, req.user.id, req.body.revision_reason, req.user.role_name === 'Admin');
  bulkReplace('offer_tech_specs', version.id, req.body.rows || [], 'spec_key', 'spec_value');
  if (req.body.show_tech_specs !== undefined) {
    db.prepare('UPDATE offers SET show_tech_specs = ? WHERE id = ?').run(req.body.show_tech_specs ? 1 : 0, version.id);
  }
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});
router.put('/:id/bought-out', offerPerm(), (req, res) => {
  const version = ensureEditableVersion(req.params.id, req.user.id, req.body.revision_reason, req.user.role_name === 'Admin');
  bulkReplace('offer_bought_out_items', version.id, req.body.rows || [], 'component', 'make');
  if (req.body.show_bought_out !== undefined) {
    db.prepare('UPDATE offers SET show_bought_out = ? WHERE id = ?').run(req.body.show_bought_out ? 1 : 0, version.id);
  }
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});
router.put('/:id/terms', offerPerm(), (req, res) => {
  const version = ensureEditableVersion(req.params.id, req.user.id, req.body.revision_reason, req.user.role_name === 'Admin');
  bulkReplace('offer_terms', version.id, req.body.rows || [], 'term_key', 'term_value');
  res.json({ ok: true, newVersion: version.forked, offerId: version.id });
});

// ===================== PDF generation =====================

// Puppeteer renders from an HTML string with no access to this server's own
// disk, so every image an offer PDF might show (a Scope-of-Supply item's
// picture, or a reference-only Equipment Description entry's) has to travel
// as an inline data: URI rather than a file path. Also re-runs the same
// compressImage() pass used at upload time (lib/imageCompress.js) on
// whatever bytes are actually on disk - a safety net for any image that was
// uploaded before that upload-time compression existed, so an old offer's
// PDF/Word doc shrinks too without needing a one-off backfill migration.
async function withImageDataUri(row) {
  let image_data_uri = null;
  if (row.image_path) {
    try {
      const abs = resolveUploadPath(row.image_path);
      const original = fs.readFileSync(abs);
      const { buffer, mime } = await compressImage(original);
      const ext = mime ? 'jpeg' : (path.extname(abs).slice(1).toLowerCase() || 'jpeg');
      image_data_uri = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buffer.toString('base64')}`;
    } catch (e) { /* image missing on disk - skip silently */ }
  }
  return { ...row, image_data_uri };
}

router.get('/:id/pdf', async (req, res) => {
  const full = getFullOffer(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  const itemsForPdf = await Promise.all(full.items.map(withImageDataUri));
  const equipmentReferencesForPdf = await Promise.all(full.equipmentReferences.map(withImageDataUri));
  try {
    const gen = await generateOfferPdf(full.offer, full.client, itemsForPdf, full.techSpecs, full.boughtOut, full.terms, equipmentReferencesForPdf);
    const filename = buildDownloadFilename({
      docType: 'Offer',
      reference: full.offer.offer_no,
      partyName: full.client && full.client.name,
      date: new Date(full.offer.offer_date).toISOString().slice(0, 10),
      version: full.offer.version ? 'v' + full.offer.version : undefined,
    });
    res.download(gen.outPath, filename, () => {
      fs.rm(gen.tmpDir, { recursive: true, force: true }, () => {});
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Marks a Draft offer as Sent - the point at which it's considered actually
// handed to the customer, distinct from just drafting it. Refreshes
// offer_date to today at the same moment: "offer date" should mean "the day
// this was sent", not "the day someone started typing it", and PDF
// generation never touches it (it's a pure read of whatever's already
// stored) - without an explicit action like this the date would otherwise
// sit stale at Draft-creation time indefinitely, however long it took to
// actually finish and send the quote.
router.post('/:id/mark-sent', offerPerm(), (req, res) => {
  const existing = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // A Standard Template was never meant to go to anyone - unlike the
  // content-edit routes, nobody (not even Admin) can mark one Sent.
  if (existing.is_template) {
    return res.status(400).json({ error: 'A Standard Template cannot be marked Sent - use "Create Offer from Template" to start a real customer offer first.' });
  }
  if (existing.status !== 'Draft') {
    return res.status(400).json({ error: `This offer is already ${existing.status} - only a Draft offer can be marked as Sent.` });
  }
  db.prepare(`UPDATE offers SET status = 'Sent', offer_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
  res.json({ ok: true });
});

// ===================== Confirm -> Sales Order + Execution Queue (Project) =====================

router.post('/:id/confirm', requirePermission('sales_order.manage'), async (req, res) => {
  const full = getFullOffer(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  // A Standard Template has no real customer to create a Sales Order
  // against (client_id is null) - nobody can confirm one, same as mark-sent.
  if (full.offer.is_template) {
    return res.status(400).json({ error: 'A Standard Template cannot be confirmed into a Sales Order - use "Create Offer from Template" to start a real customer offer first.' });
  }
  if (full.offer.status === 'Won' && full.offer.sales_order_id) {
    return res.status(400).json({ error: 'Offer already confirmed into a sales order' });
  }
  const orderValue = full.items.reduce((a, b) => a + Number(b.total_price || 0), 0);

  const tx = db.transaction(() => {
    const orderNo = 'SO-' + Date.now();
    const soInfo = db.prepare(`
      INSERT INTO sales_orders (order_no, client_id, description, order_value, created_by,
        promised_delivery_date, ld_percentage, ld_cap_percentage, ld_trigger_notes,
        abg_required, abg_percentage, abg_amount, abg_validity_days,
        pbg_required, pbg_percentage, pbg_amount, pbg_validity_days, bg_terms_notes)
      VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?)
    `).run(orderNo, full.offer.client_id, full.offer.subject, orderValue, req.user.id,
      full.offer.promised_delivery_date, full.offer.ld_percentage, full.offer.ld_cap_percentage, full.offer.ld_trigger_notes,
      full.offer.abg_required, full.offer.abg_percentage, full.offer.abg_amount, full.offer.abg_validity_days,
      full.offer.pbg_required, full.offer.pbg_percentage, full.offer.pbg_amount, full.offer.pbg_validity_days, full.offer.bg_terms_notes);
    const salesOrderId = soInfo.lastInsertRowid;

    // Copy the offer's line items across so the order has real dispatchable
    // lines from day one (FG Dispatch/Sale Rejection MRN need these - see
    // routes/sales.js) - offer_items has no GST rate field, so each line
    // defaults to the company's standard rate; Sales can correct any line
    // afterwards via the Sales Order's own item editor.
    if (full.items.length) {
      const insertSoItem = db.prepare(`
        INSERT INTO sales_order_items (sales_order_id, description, quantity, unit, rate, value, gst_rate, sort_order)
        VALUES (?,?,?,?,?,?,18,?)
      `);
      full.items.forEach(it => insertSoItem.run(
        salesOrderId, it.section_title || it.description || it.item_code || 'Item',
        Number(it.qty) || 1, 'Nos', Number(it.unit_price) || 0, Number(it.total_price) || 0, it.sort_order || 0
      ));
    }

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

// Admin-only permanent delete, for cleaning up an offer that never went
// anywhere (a mistaken Draft/Sent/Lost quote) rather than leaving it in the
// list forever. Two safety gates, both hard blocks (no override):
//   - locked (converted to a Sales Order) - that's real downstream data,
//     not this route's job; unlock via the escape hatch above first if it
//     genuinely needs undoing.
//   - has a later revision built on it (another offer's parent_offer_id
//     points here) - deleting it would orphan that revision's FK. Only a
//     leaf version (or a standalone single-version offer) can go.
router.delete('/:id', requireRole('Admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM offers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.locked) {
    return res.status(400).json({ error: 'This offer is locked (converted to a Sales Order) and cannot be deleted. Unlock it first if this conversion genuinely needs undoing.' });
  }
  const childCount = db.prepare('SELECT COUNT(*) as n FROM offers WHERE parent_offer_id = ?').get(existing.id).n;
  if (childCount > 0) {
    return res.status(400).json({ error: 'This offer has a later revision built on it and cannot be deleted directly - delete the newest version first, then work backwards.' });
  }
  const tx = db.transaction(() => {
    // A pending/reviewed Section Title suggestion (see maybeSuggestNewSectionTitle
    // above) references the offer/item it came from - the suggestion itself is
    // just a review-queue record, not something worth blocking an offer delete
    // over, so it goes with the offer rather than orphaning the FK.
    db.prepare('DELETE FROM section_title_suggestions WHERE offer_id = ?').run(existing.id);
    db.prepare('DELETE FROM offer_items WHERE offer_id = ?').run(existing.id);
    db.prepare('DELETE FROM offer_tech_specs WHERE offer_id = ?').run(existing.id);
    db.prepare('DELETE FROM offer_bought_out_items WHERE offer_id = ?').run(existing.id);
    db.prepare('DELETE FROM offer_terms WHERE offer_id = ?').run(existing.id);
    db.prepare('DELETE FROM offers WHERE id = ?').run(existing.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const defaults = require('../lib/offerDefaults');
const { generateOfferPdf } = require('../lib/offerPdf');
const { generateAnnexureDocx } = require('../lib/annexureDocx');
const { createJobCardsForProject } = require('../lib/pipeline');

const router = express.Router();
router.use(authRequired);

const { getUploadsSubdir } = require('../lib/paths');
const uploadDir = getUploadsSubdir('offers');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function offerPerm() { return requirePermission('sales_order.manage', 'lead.manage'); }

// ===================== Admin-editable dropdown options =====================
// Application / Type of System / Material of Construction - one generic
// table for all three fields (see db/index.js Round 21). Values are never
// hard-deleted (only deactivated) so an offer written before a value was
// retired still displays it correctly.
const OFFER_OPTION_FIELDS = ['application', 'type_of_system', 'material_of_construction'];

router.get('/field-options/:field', offerPerm(), (req, res) => {
  if (!OFFER_OPTION_FIELDS.includes(req.params.field)) return res.status(404).json({ error: 'Unknown field' });
  res.json(db.prepare(`
    SELECT * FROM offer_field_options WHERE field_name = ? AND active = 1 ORDER BY sort_order, value
  `).all(req.params.field));
});
// Admin view lists every option (including inactive) so they can be reactivated.
router.get('/field-options', requirePermission('offer_options.manage'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM offer_field_options ORDER BY field_name, sort_order, value`).all());
});
router.post('/field-options', requirePermission('offer_options.manage'), (req, res) => {
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
router.put('/field-options/:id', requirePermission('offer_options.manage'), (req, res) => {
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

// ===================== List / Detail =====================

router.get('/', (req, res) => {
  const { client_id } = req.query;
  let q = `SELECT o.*, c.name as client_name FROM offers o JOIN clients c ON c.id = o.client_id WHERE 1=1`;
  const params = [];
  if (client_id) { q += ' AND o.client_id = ?'; params.push(client_id); }
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
    SELECT id, offer_no, version, status, offer_date, updated_at FROM offers
    WHERE id = ? OR parent_offer_id = ? ORDER BY version
  `).all(rootId, rootId);
  res.json(versions);
});

// ===================== Create =====================

router.post('/', offerPerm(), (req, res) => {
  const { client_id, subject, contact_person, contact_phone, contact_email, application, type_of_system, material_of_construction, drawing_no } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  const offerNo = 'OFR-' + Date.now();

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO offers (offer_no, client_id, contact_person, contact_phone, contact_email, subject,
        application, type_of_system, material_of_construction, drawing_no,
        inclusions, exclusions, utilities_requirement, instrument_air_supply, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(offerNo, client_id, contact_person, contact_phone, contact_email, subject,
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

  if (existing.status !== 'Draft' && !f.statusOnly) {
    const rootId = existing.parent_offer_id || existing.id;
    const maxVersion = db.prepare(`
      SELECT MAX(version) as v FROM offers WHERE id = ? OR parent_offer_id = ?
    `).get(rootId, rootId).v || existing.version || 1;

    const full = getFullOffer(existing.id);
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO offers (offer_no, client_id, contact_person, contact_phone, contact_email, subject,
          drawing_no, application, type_of_system, material_of_construction,
          inclusions, exclusions, utilities_requirement, instrument_air_supply,
          status, version, created_by, parent_offer_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(existing.offer_no, existing.client_id, f.contact_person, f.contact_phone, f.contact_email, f.subject,
        f.drawing_no, f.application, f.type_of_system, f.material_of_construction,
        f.inclusions, f.exclusions, f.utilities_requirement, f.instrument_air_supply,
        'Draft', maxVersion + 1, req.user.id, rootId);
      const newId = info.lastInsertRowid;
      const itemStmt = db.prepare(`INSERT INTO offer_items (offer_id, item_code, section_title, description, image_path, qty, unit_price, total_price, sort_order) VALUES (?,?,?,?,?,?,?,?,?)`);
      full.items.forEach(it => itemStmt.run(newId, it.item_code, it.section_title, it.description, it.image_path, it.qty, it.unit_price, it.total_price, it.sort_order));
      const specStmt = db.prepare(`INSERT INTO offer_tech_specs (offer_id, spec_key, spec_value, sort_order) VALUES (?,?,?,?)`);
      full.techSpecs.forEach(s => specStmt.run(newId, s.spec_key, s.spec_value, s.sort_order));
      const boStmt = db.prepare(`INSERT INTO offer_bought_out_items (offer_id, component, make, sort_order) VALUES (?,?,?,?)`);
      full.boughtOut.forEach(b => boStmt.run(newId, b.component, b.make, b.sort_order));
      const termStmt = db.prepare(`INSERT INTO offer_terms (offer_id, term_key, term_value, sort_order) VALUES (?,?,?,?)`);
      full.terms.forEach(t => termStmt.run(newId, t.term_key, t.term_value, t.sort_order));
      return newId;
    });
    const newId = tx();
    return res.json({ ok: true, newVersion: true, id: newId });
  }

  db.prepare(`
    UPDATE offers SET subject=?, contact_person=?, contact_phone=?, contact_email=?,
      application=?, type_of_system=?, material_of_construction=?, drawing_no=?,
      inclusions=?, exclusions=?, utilities_requirement=?, instrument_air_supply=?,
      status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(f.subject, f.contact_person, f.contact_phone, f.contact_email,
    f.application, f.type_of_system, f.material_of_construction, f.drawing_no,
    f.inclusions, f.exclusions, f.utilities_requirement, f.instrument_air_supply,
    f.status || existing.status || 'Draft', req.params.id);
  res.json({ ok: true });
});

// ===================== Scope of Supply items (machinery, qty, price, picture) =====================

router.post('/:id/items', offerPerm(), upload.single('image'), (req, res) => {
  const { item_code, section_title, description, qty, unit_price, sort_order } = req.body;
  const q = Number(qty || 1), rate = Number(unit_price || 0);
  const imagePath = req.file ? '/uploads/offers/' + req.file.filename : null;
  const info = db.prepare(`
    INSERT INTO offer_items (offer_id, item_code, section_title, description, image_path, qty, unit_price, total_price, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.params.id, item_code, section_title, description, imagePath, q, rate, q * rate, sort_order || 0);
  res.json({ id: info.lastInsertRowid, image_path: imagePath });
});

router.put('/:id/items/:itemId', offerPerm(), upload.single('image'), (req, res) => {
  const { item_code, section_title, description, qty, unit_price, sort_order } = req.body;
  const q = Number(qty || 1), rate = Number(unit_price || 0);
  const existing = db.prepare('SELECT * FROM offer_items WHERE id = ?').get(req.params.itemId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  let imagePath = existing.image_path;
  if (req.file) {
    imagePath = '/uploads/offers/' + req.file.filename;
    if (existing.image_path) {
      const oldPath = path.join(__dirname, '..', 'public', existing.image_path);
      fs.unlink(oldPath, () => {});
    }
  }
  db.prepare(`
    UPDATE offer_items SET item_code=?, section_title=?, description=?, image_path=?, qty=?, unit_price=?, total_price=?, sort_order=?
    WHERE id=?
  `).run(item_code, section_title, description, imagePath, q, rate, q * rate, sort_order || existing.sort_order, req.params.itemId);
  res.json({ ok: true, image_path: imagePath });
});

router.delete('/:id/items/:itemId', offerPerm(), (req, res) => {
  const existing = db.prepare('SELECT * FROM offer_items WHERE id = ?').get(req.params.itemId);
  if (existing && existing.image_path) {
    fs.unlink(path.join(__dirname, '..', 'public', existing.image_path), () => {});
  }
  db.prepare('DELETE FROM offer_items WHERE id = ?').run(req.params.itemId);
  res.json({ ok: true });
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
  bulkReplace('offer_tech_specs', req.params.id, req.body.rows || [], 'spec_key', 'spec_value');
  res.json({ ok: true });
});
router.put('/:id/bought-out', offerPerm(), (req, res) => {
  bulkReplace('offer_bought_out_items', req.params.id, req.body.rows || [], 'component', 'make');
  res.json({ ok: true });
});
router.put('/:id/terms', offerPerm(), (req, res) => {
  bulkReplace('offer_terms', req.params.id, req.body.rows || [], 'term_key', 'term_value');
  res.json({ ok: true });
});

// ===================== PDF generation =====================

router.get('/:id/pdf', async (req, res) => {
  const full = getFullOffer(req.params.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  const itemsForPdf = full.items.map(it => {
    let image_data_uri = null;
    if (it.image_path) {
      try {
        const abs = path.join(__dirname, '..', 'public', it.image_path);
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

    db.prepare(`UPDATE offers SET status = 'Won', sales_order_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(salesOrderId, full.offer.id);

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

module.exports = router;

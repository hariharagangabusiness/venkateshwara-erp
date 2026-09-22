const { db } = require('../db');

function getFullOfferForClone(offerId) {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  if (!offer) return null;
  const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY sort_order, id').all(offerId);
  const techSpecs = db.prepare('SELECT * FROM offer_tech_specs WHERE offer_id = ? ORDER BY sort_order, id').all(offerId);
  const boughtOut = db.prepare('SELECT * FROM offer_bought_out_items WHERE offer_id = ? ORDER BY sort_order, id').all(offerId);
  const terms = db.prepare('SELECT * FROM offer_terms WHERE offer_id = ? ORDER BY sort_order, id').all(offerId);
  return { offer, items, techSpecs, boughtOut, terms };
}

// Any content edit on an offer that has left Draft (Sent/Won/Lost) must not
// silently mutate a version that may already be in the customer's hands, so
// it forks a full copy - header, items, tech specs, bought-out list, terms -
// as a new Draft version and hands back that copy's id (plus an old-item-id
// -> new-item-id map, since a line item's own id is addressed directly by
// edit/delete calls) for the caller to apply its edit against. A Draft offer
// is still edited in place, same as always.
//
// Every mutating offer route (header PUT, item add/edit/delete, tech-specs/
// bought-out/terms bulk-replace) funnels through this, closing a real gap:
// those item/tech-spec/bought-out/terms routes used to write straight into
// whatever offer id was in the URL regardless of its status, so editing the
// scope of supply or terms on an already-Sent offer silently rewrote the
// version the customer already has - only a header edit used to fork.
function ensureEditableVersion(offerId, userId, reason) {
  const full = getFullOfferForClone(offerId);
  if (!full) throw new Error('Offer not found');
  const { offer } = full;

  if (offer.status === 'Draft') {
    return { id: offer.id, forked: false, itemIdMap: new Map(full.items.map(it => [it.id, it.id])) };
  }

  const rootId = offer.parent_offer_id || offer.id;
  const maxVersion = db.prepare(`
    SELECT MAX(version) as v FROM offers WHERE id = ? OR parent_offer_id = ?
  `).get(rootId, rootId).v || offer.version || 1;

  let newId;
  const itemIdMap = new Map();
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO offers (offer_no, client_id, lead_id, contact_person, contact_phone, contact_email, subject,
        drawing_no, application, type_of_system, material_of_construction,
        inclusions, exclusions, utilities_requirement, instrument_air_supply,
        show_tech_specs, show_bought_out, show_inclusions_exclusions,
        status, version, created_by, parent_offer_id, revision_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(offer.offer_no, offer.client_id, offer.lead_id, offer.contact_person, offer.contact_phone, offer.contact_email, offer.subject,
      offer.drawing_no, offer.application, offer.type_of_system, offer.material_of_construction,
      offer.inclusions, offer.exclusions, offer.utilities_requirement, offer.instrument_air_supply,
      // NULL on the parent (a pre-toggle offer) means "show", same as 1 -
      // preserve that literally rather than coercing to 1, so a parent that
      // predates this feature keeps behaving exactly as it did before.
      offer.show_tech_specs, offer.show_bought_out, offer.show_inclusions_exclusions,
      'Draft', maxVersion + 1, userId, rootId, reason || null);
    newId = Number(info.lastInsertRowid);

    const itemStmt = db.prepare(`INSERT INTO offer_items (offer_id, item_code, section_title, description, image_path, qty, unit_price, total_price, sort_order) VALUES (?,?,?,?,?,?,?,?,?)`);
    full.items.forEach(it => {
      const r = itemStmt.run(newId, it.item_code, it.section_title, it.description, it.image_path, it.qty, it.unit_price, it.total_price, it.sort_order);
      itemIdMap.set(it.id, Number(r.lastInsertRowid));
    });
    const specStmt = db.prepare(`INSERT INTO offer_tech_specs (offer_id, spec_key, spec_value, sort_order) VALUES (?,?,?,?)`);
    full.techSpecs.forEach(s => specStmt.run(newId, s.spec_key, s.spec_value, s.sort_order));
    const boStmt = db.prepare(`INSERT INTO offer_bought_out_items (offer_id, component, make, sort_order) VALUES (?,?,?,?)`);
    full.boughtOut.forEach(b => boStmt.run(newId, b.component, b.make, b.sort_order));
    const termStmt = db.prepare(`INSERT INTO offer_terms (offer_id, term_key, term_value, sort_order) VALUES (?,?,?,?)`);
    full.terms.forEach(t => termStmt.run(newId, t.term_key, t.term_value, t.sort_order));
  });
  tx();

  return { id: newId, forked: true, itemIdMap };
}

module.exports = { ensureEditableVersion };

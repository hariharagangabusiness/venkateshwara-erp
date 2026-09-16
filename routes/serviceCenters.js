const express = require('express');
const { db } = require('../db');
const { authRequired, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

// ===================== Service Center Master =====================
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM service_centers ORDER BY name').all());
});
router.post('/', requirePermission('store.manage', 'service_center.manage'), (req, res) => {
  const { name, city, address, contact_person, phone, email, status } = req.body;
  if (!name) return res.status(400).json({ error: 'Enter a service center name.' });
  const info = db.prepare(`
    INSERT INTO service_centers (name, city, address, contact_person, phone, email, status)
    VALUES (?,?,?,?,?,?,?)
  `).run(name, city || null, address || null, contact_person || null, phone || null, email || null, status || 'Active');
  res.json({ id: info.lastInsertRowid });
});
router.put('/:id', requirePermission('store.manage', 'service_center.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM service_centers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, city, address, contact_person, phone, email, status } = req.body;
  db.prepare(`
    UPDATE service_centers SET name=?, city=?, address=?, contact_person=?, phone=?, email=?, status=? WHERE id=?
  `).run(
    name !== undefined ? name : existing.name,
    city !== undefined ? city : existing.city,
    address !== undefined ? address : existing.address,
    contact_person !== undefined ? contact_person : existing.contact_person,
    phone !== undefined ? phone : existing.phone,
    email !== undefined ? email : existing.email,
    status !== undefined ? status : existing.status,
    existing.id
  );
  res.json({ ok: true });
});

// ===================== Per-location stock =====================
router.get('/:id/stock', (req, res) => {
  const center = db.prepare('SELECT * FROM service_centers WHERE id = ?').get(req.params.id);
  if (!center) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(`
    SELECT scs.*, i.name as item_name, i.item_code, i.unit
    FROM service_center_stock scs JOIN items i ON i.id = scs.item_id
    WHERE scs.service_center_id = ? AND scs.quantity > 0
    ORDER BY i.name
  `).all(center.id);
  res.json({ center, rows });
});

// Company-wide: central store stock vs total distributed across all centers.
router.get('/stock/summary', (req, res) => {
  const items = db.prepare('SELECT id, item_code, name, unit, current_stock FROM items ORDER BY name').all();
  const centerRows = db.prepare(`
    SELECT scs.item_id, scs.quantity, sc.id as service_center_id, sc.name as service_center_name
    FROM service_center_stock scs JOIN service_centers sc ON sc.id = scs.service_center_id
    WHERE scs.quantity > 0
  `).all();
  const byItem = {};
  centerRows.forEach(r => {
    if (!byItem[r.item_id]) byItem[r.item_id] = [];
    byItem[r.item_id].push({ service_center_id: r.service_center_id, service_center_name: r.service_center_name, quantity: r.quantity });
  });
  const out = items.map(i => {
    const centers = byItem[i.id] || [];
    const totalAtCenters = centers.reduce((s, c) => s + (c.quantity || 0), 0);
    return { ...i, total_at_centers: totalAtCenters, centers };
  }).filter(i => i.current_stock > 0 || i.total_at_centers > 0);
  res.json(out);
});

// ===================== Transfers: Store -> Service Center =====================
router.get('/transfers/all', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, sc.name as service_center_name, sc.city as service_center_city,
      u1.full_name as dispatched_by_name, u2.full_name as received_by_name,
      (SELECT COUNT(*) FROM service_center_transfer_items ti WHERE ti.transfer_id = t.id) as item_count
    FROM service_center_transfers t
    JOIN service_centers sc ON sc.id = t.service_center_id
    LEFT JOIN users u1 ON u1.id = t.dispatched_by
    LEFT JOIN users u2 ON u2.id = t.received_by
    ORDER BY t.id DESC
  `).all();
  res.json(rows);
});

router.get('/transfers/:id', (req, res) => {
  const transfer = db.prepare(`
    SELECT t.*, sc.name as service_center_name, sc.city as service_center_city
    FROM service_center_transfers t JOIN service_centers sc ON sc.id = t.service_center_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!transfer) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT ti.*, i.name as item_name, i.item_code, i.unit
    FROM service_center_transfer_items ti JOIN items i ON i.id = ti.item_id
    WHERE ti.transfer_id = ?
  `).all(transfer.id);
  res.json({ transfer, items });
});

// Create a dispatch: deducts central store stock, logs stock_movements OUT,
// sets status Dispatched. Reuses the /store/issue insufficient-stock guard.
router.post('/transfers', requirePermission('store.manage'), (req, res) => {
  const { service_center_id, notes, items } = req.body;
  if (!service_center_id) return res.status(400).json({ error: 'Pick a service center.' });
  const center = db.prepare('SELECT * FROM service_centers WHERE id = ?').get(service_center_id);
  if (!center) return res.status(400).json({ error: 'That service center no longer exists.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item line.' });

  // Validate lines up-front (aggregate duplicate item_ids so a stock check
  // against two lines of the same item is accurate), same style as /store/issue.
  const qtyByItem = {};
  for (const line of items) {
    if (!line.item_id) return res.status(400).json({ error: 'Every line needs an item.' });
    const qty = Number(line.quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Every line needs a quantity greater than 0.' });
    qtyByItem[line.item_id] = (qtyByItem[line.item_id] || 0) + qty;
  }
  for (const itemId of Object.keys(qtyByItem)) {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    if (!item) return res.status(400).json({ error: 'One of the items no longer exists - refresh and try again.' });
    if (item.current_stock < qtyByItem[itemId]) {
      return res.status(400).json({ error: `Insufficient stock for "${item.name}" - only ${item.current_stock} ${item.unit || ''} available.` });
    }
  }

  const transferNo = 'SCT-' + Date.now();
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO service_center_transfers (transfer_no, service_center_id, status, dispatched_by, notes)
      VALUES (?,?, 'Dispatched', ?, ?)
    `).run(transferNo, service_center_id, req.user.id, notes || null);
    const transferId = info.lastInsertRowid;
    const insertLine = db.prepare(`
      INSERT INTO service_center_transfer_items (transfer_id, item_id, quantity_sent, unit_rate) VALUES (?,?,?,?)
    `);
    const insertMove = db.prepare(`
      INSERT INTO stock_movements (item_id, movement_type, quantity, reference, moved_by, service_center_id)
      VALUES (?, 'OUT', ?, ?, ?, ?)
    `);
    const deduct = db.prepare('UPDATE items SET current_stock = current_stock - ? WHERE id = ?');
    items.forEach(line => {
      const qty = Number(line.quantity);
      const rate = Number(line.unit_rate) || 0;
      insertLine.run(transferId, line.item_id, qty, rate);
      insertMove.run(line.item_id, qty, transferNo, req.user.id, service_center_id);
      deduct.run(qty, line.item_id);
    });
    return transferId;
  });
  const transferId = tx();
  res.json({ id: transferId, transfer_no: transferNo });
});

// Confirm receipt at the service center - actual received quantity per line
// (may differ from sent), increments service_center_stock and resolves the
// transfer's status. `disputed: true` flags it Disputed regardless of qty match.
router.post('/transfers/:id/receive', requirePermission('service_center.manage'), (req, res) => {
  const transfer = db.prepare('SELECT * FROM service_center_transfers WHERE id = ?').get(req.params.id);
  if (!transfer) return res.status(404).json({ error: 'Not found' });
  if (!['Dispatched', 'PartiallyReceived'].includes(transfer.status)) {
    return res.status(400).json({ error: `This transfer is already ${transfer.status} and cannot be re-confirmed.` });
  }
  const { items, notes, disputed } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Enter received quantities for at least one line.' });
  const existingLines = db.prepare('SELECT * FROM service_center_transfer_items WHERE transfer_id = ?').all(transfer.id);
  const lineById = Object.fromEntries(existingLines.map(l => [l.id, l]));

  for (const line of items) {
    if (!lineById[line.transfer_item_id]) return res.status(400).json({ error: 'One of the transfer lines is invalid.' });
    const qty = Number(line.quantity_received);
    if (qty === undefined || qty === null || isNaN(qty) || qty < 0) {
      return res.status(400).json({ error: 'Enter a valid received quantity (0 or more) for every line.' });
    }
  }

  const tx = db.transaction(() => {
    const updateLine = db.prepare('UPDATE service_center_transfer_items SET quantity_received = ? WHERE id = ?');
    const upsertStock = db.prepare(`
      INSERT INTO service_center_stock (service_center_id, item_id, quantity) VALUES (?, ?, ?)
      ON CONFLICT(service_center_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `);
    let anyShort = false;
    items.forEach(line => {
      const orig = lineById[line.transfer_item_id];
      const qtyReceived = Number(line.quantity_received);
      updateLine.run(qtyReceived, orig.id);
      if (qtyReceived > 0) upsertStock.run(transfer.service_center_id, orig.item_id, qtyReceived);
      if (qtyReceived < orig.quantity_sent) anyShort = true;
    });
    // Any lines not included in this call keep quantity_received NULL - treat
    // as not-yet-received (short) for status purposes.
    const allLines = db.prepare('SELECT * FROM service_center_transfer_items WHERE transfer_id = ?').all(transfer.id);
    const allAccountedFor = allLines.every(l => l.quantity_received !== null);
    let status;
    if (disputed) status = 'Disputed';
    else if (allAccountedFor && !anyShort && allLines.every(l => l.quantity_received === l.quantity_sent)) status = 'Received';
    else status = 'PartiallyReceived';
    db.prepare(`
      UPDATE service_center_transfers SET status = ?, received_by = ?, received_at = CURRENT_TIMESTAMP,
        notes = COALESCE(?, notes) WHERE id = ?
    `).run(status, req.user.id, notes || null, transfer.id);
    return status;
  });
  const status = tx();
  res.json({ ok: true, status });
});

// ===================== Financial Reconciliation =====================
// Per service center (and company-wide): dispatched value, received value,
// consumed value (service visits), current on-hand value, and the variance
// between what should be on hand (received - consumed) vs what's actually
// recorded - a shrinkage/loss indicator.
router.get('/reconciliation', requirePermission('report.view_all', 'store.manage', 'service_center.manage'), (req, res) => {
  const { service_center_id } = req.query;
  const centers = db.prepare('SELECT * FROM service_centers ORDER BY name').all()
    .filter(c => !service_center_id || String(c.id) === String(service_center_id));

  // Latest known rate per item, used to value on-hand stock: prefer the most
  // recent transfer line's unit_rate, fall back to the most recent spares
  // consumption unit_rate.
  const rateRows = db.prepare(`
    SELECT item_id, unit_rate FROM service_center_transfer_items WHERE unit_rate > 0 ORDER BY id DESC
  `).all();
  const spareRateRows = db.prepare(`
    SELECT item_id, unit_rate FROM service_report_spares WHERE unit_rate > 0 ORDER BY id DESC
  `).all();
  const itemRate = {};
  spareRateRows.forEach(r => { if (!(r.item_id in itemRate)) itemRate[r.item_id] = r.unit_rate; });
  rateRows.forEach(r => { if (!(r.item_id in itemRate)) itemRate[r.item_id] = r.unit_rate; });

  const dispatchedStmt = db.prepare(`
    SELECT COALESCE(SUM(ti.quantity_sent * ti.unit_rate), 0) as v
    FROM service_center_transfer_items ti JOIN service_center_transfers t ON t.id = ti.transfer_id
    WHERE t.service_center_id = ?
  `);
  const receivedStmt = db.prepare(`
    SELECT COALESCE(SUM(ti.quantity_received * ti.unit_rate), 0) as v
    FROM service_center_transfer_items ti JOIN service_center_transfers t ON t.id = ti.transfer_id
    WHERE t.service_center_id = ? AND ti.quantity_received IS NOT NULL
  `);
  const consumedStmt = db.prepare(`
    SELECT COALESCE(SUM(quantity * unit_rate), 0) as v FROM service_report_spares WHERE service_center_id = ?
  `);
  const stockStmt = db.prepare(`
    SELECT item_id, quantity FROM service_center_stock WHERE service_center_id = ? AND quantity > 0
  `);

  const rows = centers.map(center => {
    const dispatched_value = dispatchedStmt.get(center.id).v;
    const received_value = receivedStmt.get(center.id).v;
    const consumed_value = consumedStmt.get(center.id).v;
    const onhand_value = stockStmt.all(center.id).reduce((s, r) => s + r.quantity * (itemRate[r.item_id] || 0), 0);
    const expected_onhand_value = received_value - consumed_value;
    const variance_value = expected_onhand_value - onhand_value; // positive = shrinkage/loss
    const transit_discrepancy_value = dispatched_value - received_value; // positive = lost/damaged in transit
    return {
      service_center_id: center.id, name: center.name, city: center.city,
      dispatched_value, received_value, consumed_value, onhand_value,
      expected_onhand_value, variance_value, transit_discrepancy_value,
    };
  });
  const totals = rows.reduce((t, r) => ({
    dispatched_value: t.dispatched_value + r.dispatched_value,
    received_value: t.received_value + r.received_value,
    consumed_value: t.consumed_value + r.consumed_value,
    onhand_value: t.onhand_value + r.onhand_value,
    expected_onhand_value: t.expected_onhand_value + r.expected_onhand_value,
    variance_value: t.variance_value + r.variance_value,
    transit_discrepancy_value: t.transit_discrepancy_value + r.transit_discrepancy_value,
  }), { dispatched_value: 0, received_value: 0, consumed_value: 0, onhand_value: 0, expected_onhand_value: 0, variance_value: 0, transit_discrepancy_value: 0 });

  res.json({ rows, totals });
});

module.exports = router;

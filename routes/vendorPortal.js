// Public (unauthenticated) vendor quotation portal. Access is gated only by an
// unguessable per-(RFQ, vendor) token - see issueRfqToken() in db/index.js.
// Every bad/expired/revoked/closed-RFQ token gets the identical 404 so tokens
// can't be probed. Mounted at /api/public in server.js; deliberately has no
// authRequired.
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');

const router = express.Router();

// ---- tiny in-memory per-IP rate limiter (no dependency) ----
// shortcut: per-process memory, resets on restart and isn't shared across
// instances - move to a shared store if this is ever scaled out.
const WINDOW_MS = 60 * 1000;
const MAX_REQS = 30;
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
}, WINDOW_MS).unref();

function clientIp(req) {
  // Behind a proxy the last X-Forwarded-For entry is the one the proxy itself appended.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
}
router.use((req, res, next) => {
  const ip = clientIp(req), now = Date.now();
  let h = hits.get(ip);
  if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + WINDOW_MS }; hits.set(ip, h); }
  if (++h.count > MAX_REQS) {
    res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests - please wait a minute and try again.' });
  }
  next();
});

const NOT_FOUND = { error: 'This link is invalid or has expired.' };

// Resolves a raw token to its live rfq_tokens row + RFQ, or null.
function resolveToken(rawToken) {
  if (!/^[0-9a-f]{64}$/.test(String(rawToken || ''))) return null;
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return db.prepare(`
    SELECT t.id as token_id, t.expires_at, r.id as rfq_id, r.purchase_request_id, r.item_ids,
      pr.pr_no, c.name as client_name
    FROM rfq_tokens t
    JOIN rfq_requests r ON r.id = t.rfq_request_id
    JOIN purchase_requests pr ON pr.id = r.purchase_request_id
    LEFT JOIN projects p ON p.id = pr.project_id
    LEFT JOIN sales_orders so ON so.id = p.sales_order_id
    LEFT JOIN clients c ON c.id = so.client_id
    WHERE t.token_hash = ? AND t.revoked = 0 AND t.expires_at > datetime('now') AND r.status = 'Sent'
  `).get(hash) || null;
}

function rfqLines(rfq) {
  const ids = JSON.parse(rfq.item_ids || '[]').map(Number);
  if (!ids.length) return [];
  return db.prepare(`
    SELECT pri.id, COALESCE(i.name, pri.item_text) as name, pri.item_text as spec, pri.quantity, COALESCE(i.unit, 'Nos') as unit
    FROM purchase_request_items pri LEFT JOIN items i ON i.id = pri.item_id
    WHERE pri.id IN (${ids.map(() => '?').join(',')}) ORDER BY pri.sort_order, pri.id
  `).all(...ids);
}

router.get('/vendor-portal/rfq/:token', (req, res) => {
  const rfq = resolveToken(req.params.token);
  if (!rfq) return res.status(404).json(NOT_FOUND);
  db.prepare("UPDATE rfq_tokens SET last_opened_at = CURRENT_TIMESTAMP WHERE id = ?").run(rfq.token_id);
  const submitted = !!db.prepare('SELECT 1 FROM vendor_responses WHERE rfq_token_id = ?').get(rfq.token_id);
  res.json({
    reference: rfq.pr_no || ('RFQ-' + rfq.rfq_id),
    closing_date: rfq.expires_at,
    client_name: rfq.client_name || null,
    already_submitted: submitted,
    items: rfqLines(rfq).map(l => ({ id: l.id, name: l.name, spec: l.name === l.spec ? '' : (l.spec || ''), quantity: l.quantity, unit: l.unit })),
  });
});

router.post('/vendor-portal/rfq/:token/submit', (req, res) => {
  const rfq = resolveToken(req.params.token);
  if (!rfq) return res.status(404).json(NOT_FOUND);

  const wanted = rfqLines(rfq).map(l => l.id);
  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const remarks = String(body.remarks || '').trim().slice(0, 2000);

  const seen = new Set();
  for (const l of lines) {
    const id = Number(l && l.purchase_request_item_id);
    const rate = Number(l && l.unit_rate), lead = Number(l && l.lead_days);
    if (!wanted.includes(id) || seen.has(id)) return res.status(400).json({ error: 'Quotation lines do not match this RFQ.' });
    if (!(rate > 0) || !isFinite(rate)) return res.status(400).json({ error: 'Every unit rate must be a number above 0.' });
    if (!Number.isInteger(lead) || lead < 0 || lead > 365) return res.status(400).json({ error: 'Lead time must be a whole number of days from 0 to 365.' });
    seen.add(id);
  }
  if (seen.size !== wanted.length) return res.status(400).json({ error: 'Please quote every item on the RFQ.' });

  try {
    db.transaction(() => {
      // Re-checked inside the transaction so two simultaneous submits can't both pass.
      if (db.prepare('SELECT 1 FROM vendor_responses WHERE rfq_token_id = ?').get(rfq.token_id)) {
        const e = new Error('dup'); e.code = 'DUP'; throw e;
      }
      const info = db.prepare('INSERT INTO vendor_responses (rfq_token_id, remarks) VALUES (?, ?)').run(rfq.token_id, remarks || null);
      const ins = db.prepare('INSERT INTO vendor_response_lines (vendor_response_id, purchase_request_item_id, unit_rate, lead_days) VALUES (?,?,?,?)');
      for (const l of lines) ins.run(info.lastInsertRowid, Number(l.purchase_request_item_id), Number(l.unit_rate), Number(l.lead_days));
    })();
  } catch (e) {
    if (e.code === 'DUP' || /UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'A quotation has already been submitted for this link.' });
    console.error('[vendorPortal] submit failed:', e.message);
    return res.status(500).json({ error: 'Could not save your quotation. Please try again.' });
  }
  res.json({ ok: true });
});

module.exports = router;

// Reads a dedicated Purchase inbox over IMAP and drops each unseen vendor
// reply into incoming_rfq_responses as a review queue - never straight into
// purchase_request_quotes. Same "review queue, human confirms" reasoning as
// lib/inboundMail.js's Service inbox, and structurally similar (own IMAP
// poll rather than sharing lib/inboundMail.js's, so a bug here can't affect
// the already-working Service scan and vice versa).
//
// The one materially different piece is matching: instead of guessing a
// customer from an arbitrary inbound address, we already know exactly which
// vendors/addresses an RFQ was sent to (rfq_request_vendors/
// rfq_request_emails) - so a reply is matched, in order of confidence:
//   1. ThreadMatch - the reply's In-Reply-To/References header names the
//      exact Message-ID of an RFQ email we sent (captured at send time in
//      routes/purchase.js). Reliable even if a vendor has several open RFQs
//      from us at once.
//   2. SenderMatch - no header match, but the sender's address matches a
//      vendor (or manually-typed recipient) some RFQ was sent to. Falls back
//      to that vendor's most recently sent RFQ - flagged as a weaker
//      confidence since a vendor with multiple open RFQs is ambiguous here.
//   3. No match - filed anyway so nothing is silently dropped; the Purchase
//      Executive picks the right RFQ/vendor by hand at confirm time.
const { getPurchaseInboundMailSettings } = require('./settings');
const { db } = require('../db');

function resolveConfig() {
  const cfg = getPurchaseInboundMailSettings();
  return {
    enabled: !!cfg.enabled,
    host: cfg.imap_host || '',
    port: Number(cfg.imap_port || 993),
    user: cfg.imap_user || '',
    pass: cfg.imap_pass || '',
    secure: cfg.imap_secure !== undefined ? !!cfg.imap_secure : true,
    mailbox: cfg.mailbox || 'INBOX',
    pollMinutes: Number(cfg.poll_minutes || 5),
  };
}

function isConfigured(cfg) {
  return !!(cfg.host && cfg.user && cfg.pass);
}

function normalizeMessageIds(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split(/\s+/);
  return arr.map(v => String(v).trim()).filter(Boolean);
}

// Thread match: does any Message-ID this reply references correspond to an
// RFQ email we actually sent? Checked against both recipient tables, since
// an RFQ can go to Vendor Master contacts and manually-typed addresses.
function matchByThread(candidateIds) {
  if (!candidateIds.length) return null;
  const placeholders = candidateIds.map(() => '?').join(',');
  const vendorRow = db.prepare(`
    SELECT rfq_request_id, vendor_id FROM rfq_request_vendors WHERE sent_message_id IN (${placeholders}) LIMIT 1
  `).get(...candidateIds);
  if (vendorRow) return { rfqRequestId: vendorRow.rfq_request_id, vendorId: vendorRow.vendor_id, confidence: 'ThreadMatch' };
  const emailRow = db.prepare(`
    SELECT rfq_request_id FROM rfq_request_emails WHERE sent_message_id IN (${placeholders}) LIMIT 1
  `).get(...candidateIds);
  if (emailRow) return { rfqRequestId: emailRow.rfq_request_id, vendorId: null, confidence: 'ThreadMatch' };
  return null;
}

// Sender-address fallback: the vendor's most recently sent RFQ, or a
// manually-typed recipient's most recent RFQ. Ambiguous if that vendor/
// address has more than one open RFQ from us, hence the weaker confidence.
function matchBySender(fromAddress) {
  const addr = String(fromAddress || '').trim().toLowerCase();
  if (!addr) return null;
  const vendor = db.prepare(`SELECT id FROM vendors WHERE LOWER(email) = ? OR LOWER(po_email) = ?`).get(addr, addr);
  if (vendor) {
    const row = db.prepare(`
      SELECT rfq_request_id, vendor_id FROM rfq_request_vendors WHERE vendor_id = ? ORDER BY id DESC LIMIT 1
    `).get(vendor.id);
    if (row) return { rfqRequestId: row.rfq_request_id, vendorId: row.vendor_id, confidence: 'SenderMatch' };
  }
  const emailRow = db.prepare(`
    SELECT rfq_request_id FROM rfq_request_emails WHERE LOWER(email) = ? ORDER BY id DESC LIMIT 1
  `).get(addr);
  if (emailRow) return { rfqRequestId: emailRow.rfq_request_id, vendorId: null, confidence: 'SenderMatch' };
  return null;
}

// Loose best-effort amount extractor - a review-queue hint for the Purchase
// Executive to eyeball and correct, not a validated field. Looks for a
// number near a currency marker (₹, Rs., INR) first, since that's the most
// reliable signal in a vendor's free-text reply; falls back to the first
// plausible-looking number in the body if no currency marker is found.
function extractQuotedAmount(bodyText) {
  if (!bodyText) return null;
  const currencyMatch = bodyText.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const candidate = currencyMatch ? currencyMatch[1] : (bodyText.match(/\b([\d]{2,3}(?:,\d{2,3})*(?:\.\d{1,2})?)\b/) || [])[1];
  if (!candidate) return null;
  const num = Number(candidate.replace(/,/g, ''));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function alreadySeen(messageId) {
  if (!messageId) return false;
  return !!db.prepare('SELECT id FROM incoming_rfq_responses WHERE message_id = ?').get(messageId);
}

function storeIncomingResponse({ messageId, fromAddress, fromName, subject, bodyText, receivedAt, inReplyTo, references }) {
  const candidateIds = [...normalizeMessageIds(inReplyTo), ...normalizeMessageIds(references)];
  const match = matchByThread(candidateIds) || matchBySender(fromAddress);
  const guessedAmount = extractQuotedAmount(bodyText);
  db.prepare(`
    INSERT INTO incoming_rfq_responses
      (message_id, from_address, from_name, subject, body_text, received_at, matched_rfq_request_id, matched_vendor_id, match_confidence, guessed_quoted_amount)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(messageId || null, fromAddress, fromName || null, subject || null, bodyText || null,
    receivedAt || new Date().toISOString(),
    match ? match.rfqRequestId : null, match ? match.vendorId : null, match ? match.confidence : null, guessedAmount);
}

// Connects, authenticates, and immediately disconnects - Settings > Purchase
// Inbound Mail's Test Connection button.
async function testConnection() {
  const cfg = resolveConfig();
  if (!isConfigured(cfg)) {
    return { ok: false, reason: 'Fill in IMAP host, username, and password first.' };
  }
  let ImapFlow;
  try {
    ({ ImapFlow } = require('imapflow'));
  } catch (e) {
    return { ok: false, reason: 'The imapflow package is not installed on the server.' };
  }
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'Connection failed: ' + e.message };
  }
}

// The actual poll - same shape as lib/inboundMail.js's runInboundMailScan(),
// see that file's header comment for the per-message error-isolation and
// \Seen-after-store reasoning.
async function runInboundRfqScan() {
  const cfg = resolveConfig();
  if (!cfg.enabled) return { ran: false, reason: 'Purchase inbound mail is disabled in Settings.' };
  if (!isConfigured(cfg)) return { ran: false, reason: 'Purchase inbound mail is not fully configured.' };

  let ImapFlow, simpleParser;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch (e) {
    return { ran: false, reason: 'imapflow/mailparser package not installed: ' + e.message };
  }

  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  let stored = 0, skipped = 0, failed = 0;
  try {
    await client.connect();
  } catch (e) {
    console.error('[inboundRfqMail] connect failed:', e.message);
    return { ran: false, reason: 'Could not connect: ' + e.message };
  }
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) { failed++; continue; }
          const parsed = await simpleParser(msg.source);
          const messageId = parsed.messageId || null;
          if (alreadySeen(messageId)) { skipped++; }
          else {
            const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
            storeIncomingResponse({
              messageId,
              fromAddress: from.address || '',
              fromName: from.name || '',
              subject: parsed.subject || '(no subject)',
              bodyText: parsed.text || '',
              receivedAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
              inReplyTo: parsed.inReplyTo,
              references: parsed.references,
            });
            stored++;
          }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (e) {
          console.error('[inboundRfqMail] failed to process message uid', uid, ':', e.message);
          failed++;
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('[inboundRfqMail] scan failed:', e.message);
    await client.logout().catch(() => {});
    return { ran: false, reason: 'Scan failed: ' + e.message };
  }
  await client.logout().catch(() => {});
  return { ran: true, stored, skipped, failed, ranAt: new Date().toISOString() };
}

module.exports = { runInboundRfqScan, testConnection, resolveConfig, isConfigured, matchByThread, matchBySender, extractQuotedAmount };

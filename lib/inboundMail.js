// Reads a dedicated Service inbox over IMAP and drops each unseen message
// into incoming_service_emails as a review-queue item - never straight into
// service_requests. A misdirected email or spam reaching that inbox would
// otherwise silently become a live, visible SR; instead the Service
// HOD/Supervisor confirms each item into a real SR (routes/service.js
// POST /inbox/:id/confirm) or dismisses it.
//
// This is a standalone poll (see server.js's setInterval), independent of
// any interactive session - same reasoning as lib/mailer.js being a plain
// server-side SMTP client rather than relying on any AI session's own mail
// access, which only exists while that session is open.
const { getInboundMailSettings } = require('./settings');
const { db } = require('../db');

function resolveConfig() {
  const cfg = getInboundMailSettings();
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

// Free webmail domains are common enough (gmail.com, yahoo.com, ...) that a
// domain-only match against one of them would false-positive across
// unrelated clients who happen to share a provider - only a real company
// domain is worth treating as a signal.
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com',
  'live.com', 'rediffmail.com', 'icloud.com', 'aol.com', 'protonmail.com',
]);

function domainOf(address) {
  const at = String(address || '').lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

// Exact sender-email match is the only case treated as a confident link to
// a known client. A same-domain (different mailbox) match is surfaced only
// as a naming hint - see matchClient() below - not as matched_client_id,
// since two people at the same company are not the same client contact.
function matchClient(fromAddress) {
  const addr = String(fromAddress || '').trim().toLowerCase();
  if (!addr) return { matchedClientId: null, domainHint: null };
  const exact = db.prepare(`SELECT id, name FROM clients WHERE LOWER(email) = ?`).get(addr);
  if (exact) return { matchedClientId: exact.id, domainHint: null };

  const domain = domainOf(addr);
  if (!domain || GENERIC_EMAIL_DOMAINS.has(domain)) return { matchedClientId: null, domainHint: null };
  const domainMatches = db.prepare(`SELECT id, name FROM clients WHERE LOWER(email) LIKE ?`).all('%@' + domain);
  if (domainMatches.length === 1) {
    return { matchedClientId: null, domainHint: domainMatches[0].name };
  }
  return { matchedClientId: null, domainHint: null };
}

const GENERIC_LOCAL_PARTS = new Set(['info', 'sales', 'support', 'contact', 'admin', 'no-reply', 'noreply', 'enquiry', 'enquiries', 'help', 'office']);

function titleCase(s) {
  return s.replace(/[._-]+/g, ' ').trim().split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

// Best-effort signature scrape: looks for a name on the line right after a
// common sign-off ("Regards,", "Thanks,", ...), which is the most reliable
// free-text signal a plain-text business email actually offers.
function guessNameFromSignature(bodyText) {
  if (!bodyText) return null;
  const lines = bodyText.split(/\r?\n/).map(l => l.trim());
  const signoffRe = /^(regards|best regards|warm regards|thanks|thank you|thanks & regards|sincerely|yours faithfully|yours truly)[,.]?\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    if (signoffRe.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const candidate = lines[j];
        if (candidate && candidate.length <= 60 && /^[A-Za-z][A-Za-z .'-]*$/.test(candidate)) {
          return candidate;
        }
        if (candidate) break; // first non-empty line wasn't name-shaped - stop looking
      }
      break;
    }
  }
  return null;
}

function guessCustomerName(fromName, fromAddress, bodyText, domainHint) {
  const localPart = String(fromAddress || '').split('@')[0].toLowerCase();
  const nameLooksReal = fromName && fromName.trim() && fromName.trim().toLowerCase() !== fromAddress.toLowerCase()
    && !GENERIC_LOCAL_PARTS.has(localPart);
  if (nameLooksReal) {
    return domainHint ? `${fromName.trim()} (${domainHint})` : fromName.trim();
  }
  const sigName = guessNameFromSignature(bodyText);
  if (sigName) return domainHint ? `${sigName} (${domainHint})` : sigName;
  if (domainHint) return `${domainHint} (domain match - verify)`;
  return titleCase(localPart) || fromAddress;
}

// Loose but deliberately permissive phone matcher - Indian mobile/landline
// formats vary a lot (+91, 0-prefixed STD codes, spaced/hyphenated groups);
// this is a review-queue hint for the HOD to eyeball, not a validated field.
function extractPhone(bodyText) {
  if (!bodyText) return null;
  const match = bodyText.match(/(?:\+?\d[\d\s\-()]{7,}\d)/);
  if (!match) return null;
  const digits = match[0].replace(/[^\d+]/g, '');
  return digits.length >= 8 ? match[0].trim() : null;
}

function alreadySeen(messageId) {
  if (!messageId) return false;
  return !!db.prepare('SELECT id FROM incoming_service_emails WHERE message_id = ?').get(messageId);
}

function storeIncomingEmail({ messageId, fromAddress, fromName, subject, bodyText, receivedAt }) {
  const { matchedClientId, domainHint } = matchClient(fromAddress);
  const guessedName = guessCustomerName(fromName, fromAddress, bodyText, domainHint);
  const guessedPhone = extractPhone(bodyText);
  db.prepare(`
    INSERT INTO incoming_service_emails
      (message_id, from_address, from_name, subject, body_text, received_at, matched_client_id, guessed_customer_name, guessed_contact_phone)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(messageId || null, fromAddress, fromName || null, subject || null, bodyText || null,
    receivedAt || new Date().toISOString(), matchedClientId, guessedName, guessedPhone);
}

// Connects, authenticates, and immediately disconnects - used by
// Settings > Inbound Mail's "Test Connection" so an Admin can confirm the
// IMAP credentials actually work without waiting for the next poll.
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

// The actual poll: connects, opens the configured mailbox, fetches every
// unseen message, parses it, and files it into the review queue. Each
// message is handled independently (one bad/unparseable message never
// blocks the rest of the batch) and is only marked \Seen after it's safely
// stored, so a mid-run crash just re-processes it next poll rather than
// losing it - alreadySeen()'s message-id dedupe guards against that
// re-processing creating a duplicate row.
async function runInboundMailScan() {
  const cfg = resolveConfig();
  if (!cfg.enabled) return { ran: false, reason: 'Inbound mail is disabled in Settings.' };
  if (!isConfigured(cfg)) return { ran: false, reason: 'Inbound mail is not fully configured.' };

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
    console.error('[inboundMail] connect failed:', e.message);
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
            storeIncomingEmail({
              messageId,
              fromAddress: from.address || '',
              fromName: from.name || '',
              subject: parsed.subject || '(no subject)',
              bodyText: parsed.text || '',
              receivedAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            });
            stored++;
          }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (e) {
          console.error('[inboundMail] failed to process message uid', uid, ':', e.message);
          failed++;
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('[inboundMail] scan failed:', e.message);
    await client.logout().catch(() => {});
    return { ran: false, reason: 'Scan failed: ' + e.message };
  }
  await client.logout().catch(() => {});
  return { ran: true, stored, skipped, failed, ranAt: new Date().toISOString() };
}

module.exports = { runInboundMailScan, testConnection, resolveConfig, isConfigured, matchClient, guessCustomerName, extractPhone };

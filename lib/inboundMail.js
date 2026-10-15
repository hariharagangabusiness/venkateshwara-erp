// Reads a dedicated Service inbox over IMAP. A genuinely new conversation
// (no thread match - see findThreadMatch() below) immediately becomes a
// real service_requests row (sr_no assigned right away, status
// 'PendingApproval') and starts the single-step 'ServiceRequest' approval
// chain for the Service HOD/Supervisor to sign off - see
// db/index.js's bootstrapServiceRequestApproval(). A reply/follow-up in a
// thread that's already linked to an SR is appended to that SR's activity
// log instead (no new SR, no new approval - this is the "no repeat email
// gets a new approval" rule). A message that can't be trusted enough to act
// on automatically (unparseable, no sender, a bounce/mailer-daemon address)
// is quarantined instead - see quarantine() - for a human to recover via
// the existing Confirm/Dismiss actions (routes/service.js) rather than
// silently becoming an SR or silently vanishing.
//
// 2026-10-11: this replaced an earlier "every email sits in a review queue
// until a human manually Confirms it into an SR" design - the review queue
// (incoming_service_emails) still exists and still records every message,
// but now purely as an audit trail of what the pipeline above decided, not
// a mandatory human gate. Automated spam/content classification (AI-driven
// parsing, point 6 of the inbound-mail scope discussion) is deliberately
// NOT part of this - see this file's own PR/CLAUDE.md note for why that's
// deferred to a later phase.
//
// This is a standalone poll (see server.js's setInterval), independent of
// any interactive session - same reasoning as lib/mailer.js being a plain
// server-side SMTP client rather than relying on any AI session's own mail
// access, which only exists while that session is open.
const { getInboundMailSettings, getServiceAckMailSettings } = require('./settings');
const { startApproval } = require('./approvals');
const { sendMail } = require('./mailer');
const { getDepartmentEmailIdentity } = require('./departmentEmail');
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
    scanWindowDays: Number(cfg.scan_window_days || 14),
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

// mailparser's inReplyTo/references come back as a string, an array, or
// undefined depending on the message - flattens whatever's given into one
// deduped list of Message-IDs to match against.
function headerIds(...vals) {
  const out = [];
  vals.forEach(v => {
    if (!v) return;
    if (Array.isArray(v)) out.push(...v); else out.push(v);
  });
  return Array.from(new Set(out.filter(Boolean)));
}
function joinHeaderIds(v) {
  if (!v) return null;
  return Array.isArray(v) ? v.join(' ') : String(v);
}

// Is this new message a reply/follow-up in a thread we already linked to a
// service request? Matches its In-Reply-To/References against every
// message_id and resolved thread_root_message_id already on file that has
// a linked_sr_id - the standard email-threading mechanism (same headers
// Gmail/Outlook use), not a subject/body guess, so this never false-
// -positives across two unrelated conversations.
function findThreadMatch(candidateIds) {
  if (!candidateIds.length) return null;
  const placeholders = candidateIds.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT linked_sr_id, thread_root_message_id, message_id FROM incoming_service_emails
    WHERE linked_sr_id IS NOT NULL AND (message_id IN (${placeholders}) OR thread_root_message_id IN (${placeholders}))
    ORDER BY id DESC LIMIT 1
  `).get(...candidateIds, ...candidateIds);
  if (!row) return null;
  return { srId: row.linked_sr_id, threadRootMessageId: row.thread_root_message_id || row.message_id };
}

const BOUNCE_LOCAL_PARTS = new Set(['mailer-daemon', 'postmaster', 'bounce', 'bounces']);

// Deliberately minimal, deterministic checks only - no content/spam
// classification (that's AI-driven parsing, explicitly deferred - see this
// file's header comment). Just enough to keep an automated bounce/delivery-
// failure notice, or a message with nothing to act on, from becoming a
// numbered SR.
function quarantineReason(fromAddress, bodyText, autoSubmitted) {
  if (!fromAddress) return 'No sender address found on the message.';
  const local = String(fromAddress).split('@')[0].toLowerCase();
  if (BOUNCE_LOCAL_PARTS.has(local)) return 'Sender address looks like an automated bounce/mailer-daemon notice.';
  if (autoSubmitted) return 'Message is marked Auto-Submitted (automated notice, not a real request).';
  if (!bodyText || !bodyText.trim()) return 'Message has no readable body text.';
  return null;
}

function insertQuarantined({ messageId, fromAddress, fromName, subject, bodyText, receivedAt, reason }) {
  db.prepare(`
    INSERT INTO incoming_service_emails
      (message_id, from_address, from_name, subject, body_text, received_at, status, quarantine_reason)
    VALUES (?,?,?,?,?,?, 'Quarantined', ?)
  `).run(messageId || null, fromAddress || '', fromName || null, subject || null, bodyText || null,
    receivedAt || new Date().toISOString(), reason);
}

// Appends a thread-matched follow-up to the existing SR's activity log
// (sr_updates) instead of creating a new SR/approval - this is the "no
// repeat email gets a fresh approval" rule.
function linkToExistingThread({ srId, threadRootMessageId, messageId, fromAddress, fromName, subject, bodyText, receivedAt, inReplyTo, references }) {
  db.prepare(`
    INSERT INTO incoming_service_emails
      (message_id, from_address, from_name, subject, body_text, received_at, status, linked_sr_id, thread_root_message_id, in_reply_to, references_text)
    VALUES (?,?,?,?,?,?, 'ThreadLinked', ?,?,?,?)
  `).run(messageId, fromAddress, fromName || null, subject, bodyText, receivedAt,
    srId, threadRootMessageId, joinHeaderIds(inReplyTo), joinHeaderIds(references));
  db.prepare(`
    INSERT INTO sr_updates (sr_id, note, action_taken) VALUES (?, ?, 'Follow-up email received')
  `).run(srId, `From ${fromName || fromAddress} <${fromAddress}> - Subject: ${subject}\n\n${(bodyText || '').slice(0, 1500)}`);
}

// Best-effort "what does this email actually say" snippet - the first few
// non-blank lines of the body, capped in length. Separate from
// issue_description (which stays the subject, a short label) so an
// approver/HOD gets real content without having to go dig up the original
// email - see this file's header comment and CLAUDE.md's 2026-10-12 entry.
// Deliberately crude (no quoted-reply stripping, no signature removal) -
// same "deterministic, not content-classifying" philosophy as
// quarantineReason() above; a slightly noisy excerpt still beats none.
const EMAIL_EXCERPT_MAX_LINES = 3;
const EMAIL_EXCERPT_MAX_CHARS = 300;
function emailExcerpt(bodyText) {
  if (!bodyText) return null;
  const lines = bodyText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  let excerpt = lines.slice(0, EMAIL_EXCERPT_MAX_LINES).join(' ');
  if (excerpt.length > EMAIL_EXCERPT_MAX_CHARS) excerpt = excerpt.slice(0, EMAIL_EXCERPT_MAX_CHARS).trim() + '...';
  else if (lines.length > EMAIL_EXCERPT_MAX_LINES) excerpt += '...';
  return excerpt;
}

// Auto-creates a real SR (sr_no assigned immediately, status
// 'PendingApproval', source 'Email') from a new, non-thread-matched inbound
// email, and starts the single-step ServiceRequest approval chain - see
// this file's header comment and db/index.js's
// bootstrapServiceRequestApproval(). requested_by is left null (the
// approvals table allows it) since this is system-triggered, not raised by
// any logged-in user.
function autoCreateServiceRequest({ fromAddress, fromName, subject, bodyText }) {
  const { matchedClientId, domainHint } = matchClient(fromAddress);
  const guessedName = guessCustomerName(fromName, fromAddress, bodyText, domainHint);
  const guessedPhone = extractPhone(bodyText);
  const srNo = 'SR-' + Date.now();
  const issue = subject && subject !== '(no subject)' ? subject : ((bodyText || '').slice(0, 500) || 'Service request received via email.');
  const excerpt = emailExcerpt(bodyText);
  const info = db.prepare(`
    INSERT INTO service_requests (sr_no, client_id, customer_name, contact_phone, issue_description, email_excerpt, status, source)
    VALUES (?,?,?,?,?,?, 'PendingApproval', 'Email')
  `).run(srNo, matchedClientId || null, matchedClientId ? null : guessedName, guessedPhone, issue, excerpt);
  const srId = info.lastInsertRowid;
  startApproval('ServiceRequest', 'service_request', srId, 0, null);
  return { srId, srNo, matchedClientId, guessedName, guessedPhone };
}

// Sends the "we've received your request" email - only ever called once,
// on first contact (a brand new SR being created), never on a thread-
// matched follow-up, so a customer's own out-of-office/auto-responder can't
// loop with ours. Merge fields: {{sr_no}}, {{customer_name}}, {{subject}}.
// Best-effort - lib/mailer.js already no-ops silently when SMTP isn't
// configured, and a send failure here must never roll back the SR that was
// already created.
async function sendAcknowledgement(toAddress, srNo, customerName, subject) {
  if (!toAddress) return;
  const ackCfg = getServiceAckMailSettings();
  if (!ackCfg.enabled) return;
  const fill = (s) => String(s || '')
    .replace(/\{\{sr_no\}\}/g, srNo || '')
    .replace(/\{\{customer_name\}\}/g, customerName || 'Customer')
    .replace(/\{\{subject\}\}/g, subject || '');
  try {
    // 'Service' is a ROLE name (db/seed.js), not the DEPARTMENT name - the
    // actual departments row is 'Service & Spare Parts'. Calling this with
    // the role name silently found no department row, so this ack mail
    // always fell back to the global Email Settings account regardless of
    // whatever SMTP account was configured against the real department row
    // in Company Settings (2026-10-15).
    await sendMail({ to: toAddress, subject: fill(ackCfg.subject), text: fill(ackCfg.body), ...getDepartmentEmailIdentity('Service & Spare Parts') });
  } catch (e) { /* best-effort - never let an ack failure affect SR creation */ }
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
// unseen message from the last scanWindowDays, and routes each one through
// the pipeline described at the top of this file (thread-link / auto-
// create-SR+approval / quarantine). Each message is handled independently
// (one bad message never blocks the rest of the batch) and is only marked
// \Seen after it's safely recorded, so a mid-run crash just re-processes it
// next poll rather than losing it - alreadySeen()'s message-id dedupe
// guards against that re-processing creating a duplicate row/SR.
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

  let created = 0, threadLinked = 0, quarantined = 0, skipped = 0, failed = 0;
  try {
    await client.connect();
  } catch (e) {
    console.error('[inboundMail] connect failed:', e.message);
    return { ran: false, reason: 'Could not connect: ' + e.message };
  }
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const since = new Date(Date.now() - cfg.scanWindowDays * 24 * 60 * 60 * 1000);
      const uids = await client.search({ seen: false, since }, { uid: true });
      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) { failed++; continue; }

          let parsed;
          try {
            parsed = await simpleParser(msg.source);
          } catch (parseErr) {
            insertQuarantined({ subject: '(parse failed)', reason: 'Failed to parse message: ' + parseErr.message });
            quarantined++;
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }

          const messageId = parsed.messageId || null;
          if (alreadySeen(messageId)) {
            skipped++;
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }

          const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
          const fromAddress = from.address || '';
          const fromName = from.name || '';
          const subject = parsed.subject || '(no subject)';
          const bodyText = parsed.text || '';
          const receivedAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
          const autoSubmitted = (parsed.headers && typeof parsed.headers.get === 'function') ? parsed.headers.get('auto-submitted') : null;

          const qReason = quarantineReason(fromAddress, bodyText, autoSubmitted);
          if (qReason) {
            insertQuarantined({ messageId, fromAddress, fromName, subject, bodyText, receivedAt, reason: qReason });
            quarantined++;
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }

          const candidateIds = headerIds(parsed.inReplyTo, parsed.references);
          const threadMatch = findThreadMatch(candidateIds);
          if (threadMatch) {
            linkToExistingThread({
              srId: threadMatch.srId, threadRootMessageId: threadMatch.threadRootMessageId,
              messageId, fromAddress, fromName, subject, bodyText, receivedAt,
              inReplyTo: parsed.inReplyTo, references: parsed.references,
            });
            threadLinked++;
          } else {
            const { srId, srNo, guessedName, guessedPhone, matchedClientId } = autoCreateServiceRequest({ fromAddress, fromName, subject, bodyText });
            db.prepare(`
              INSERT INTO incoming_service_emails
                (message_id, from_address, from_name, subject, body_text, received_at, status, linked_sr_id, thread_root_message_id, matched_client_id, guessed_customer_name, guessed_contact_phone)
              VALUES (?,?,?,?,?,?, 'AutoCreated', ?,?,?,?,?)
            `).run(messageId, fromAddress, fromName, subject, bodyText, receivedAt, srId, messageId, matchedClientId, guessedName, guessedPhone);
            await sendAcknowledgement(fromAddress, srNo, guessedName, subject);
            created++;
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
  return { ran: true, created, threadLinked, quarantined, skipped, failed, ranAt: new Date().toISOString() };
}

module.exports = {
  runInboundMailScan, testConnection, resolveConfig, isConfigured, matchClient, guessCustomerName, extractPhone,
  findThreadMatch, quarantineReason, autoCreateServiceRequest, emailExcerpt,
};

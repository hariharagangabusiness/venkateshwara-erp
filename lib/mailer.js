// Thin mailer wrapper: a per-call `override` (a department's own SMTP
// account, see lib/departmentEmail.js) takes priority over DB (Company
// Settings > Email Settings), which takes priority over env vars, the
// fallback/default. If nothing at any level is configured, every send()
// call no-ops with a clear "not configured" result instead of crashing -
// the app must keep working end-to-end with no SMTP set up.
const { getEmailSettings, getEmailChannel, getWorkflowChannel, workflowAllowsExtras } = require('./settings');

function resolveConfig(override) {
  const o = override || {};
  const dbCfg = getEmailSettings();
  const host = o.smtp_host || dbCfg.smtp_host || process.env.SMTP_HOST || '';
  const port = Number(o.smtp_port || dbCfg.smtp_port || process.env.SMTP_PORT || 587);
  const user = o.smtp_user || dbCfg.smtp_user || process.env.SMTP_USER || '';
  const pass = o.smtp_pass || dbCfg.smtp_pass || process.env.SMTP_PASS || '';
  const secure = o.smtp_secure !== undefined ? !!o.smtp_secure
    : (dbCfg.smtp_secure !== undefined && dbCfg.smtp_secure !== '' ? !!dbCfg.smtp_secure : (String(process.env.SMTP_SECURE).toLowerCase() === 'true'));
  const fromName = o.fromName || dbCfg.from_name || process.env.SMTP_FROM_NAME || 'Venkateshwara Engineers';
  const fromAddress = o.fromAddress || dbCfg.from_address || process.env.SMTP_FROM_ADDRESS || user;
  const ccList = (dbCfg.cc_list && dbCfg.cc_list.length) ? dbCfg.cc_list
    : (process.env.SMTP_DEFAULT_CC ? process.env.SMTP_DEFAULT_CC.split(',').map(s => s.trim()).filter(Boolean) : []);
  return { host, port, user, pass, secure, fromName, fromAddress, ccList };
}

function isConfigured(cfg) {
  return !!(cfg.host && cfg.user && cfg.fromAddress);
}

// Sends an email. Returns { sent: true, ... } or { sent: false, reason }.
// Never throws - callers should always get a usable response, not a crash.
// fromName/fromAddress alone override just the display identity while still
// relaying through the one shared SMTP account - the mail server has to
// actually accept sending as that address (an alias/mailbox it recognizes)
// or it may reject the send (the classic "550 5.7.1 Sender is not allowed
// to relay") or silently rewrite the From header. Passing smtp_host/port/
// user/pass/secure too (see lib/departmentEmail.js's
// getDepartmentEmailIdentity()) authenticates as a genuinely different
// account instead, which is what actually avoids that rejection.
async function deliver({ to, cc, subject, text, html, attachments, fromName, fromAddress, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, skipDefaultCc }) {
  const cfg = resolveConfig({ fromName, fromAddress, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure });
  if (!isConfigured(cfg)) {
    console.log('[mailer] SMTP not configured - skipping send. Configure SMTP_HOST/SMTP_USER/SMTP_PASS env vars or Company Settings > Email Settings.');
    return { sent: false, reason: 'SMTP is not configured. Set it up under Company Settings > Email Settings (or SMTP_* environment variables) to enable email delivery.' };
  }
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    console.error('[mailer] nodemailer package not installed:', e.message);
    return { sent: false, reason: 'The nodemailer package is not installed on the server.' };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      // Without these, a bad host/port/TLS combination (or a network path
      // that silently drops the connection instead of refusing it) leaves
      // the caller waiting indefinitely with no error and no timeout -
      // nodemailer's own defaults are long enough that "Send Test Email"
      // can look permanently stuck. 15s to connect/greet is generous for
      // any real SMTP server; 30s for the data transfer covers a PO/invoice
      // attachment too.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    const ccAll = Array.from(new Set([...(Array.isArray(cc) ? cc : (cc ? [cc] : [])), ...(skipDefaultCc ? [] : cfg.ccList)])).filter(Boolean);
    const info = await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
      to, cc: ccAll.length ? ccAll.join(',') : undefined,
      subject, text, html, attachments,
    });
    return { sent: true, messageId: info.messageId, from: cfg.fromAddress };
  } catch (e) {
    console.error('[mailer] send failed:', e.message);
    return { sent: false, reason: 'Sending failed: ' + e.message };
  }
}

// Public entry point. Without `channel` this is exactly deliver(). With `channel` ('daily_reports' | 'weekly_summary' |
// 'escalations' | 'app_user', see lib/settings.js) the mail goes out from that channel's own From address/name, and
// authenticates with the channel's own SMTP user+password when both are set (else the global account).
// If the mail server REJECTS the channel sender (e.g. the mailbox/alias isn't set up yet), it is retried once from the
// normal sender so a password reset or escalation is not lost; the result then carries fellBack:true and the
// channelError. Pass noFallback:true (the per-channel Send Test Email does) to see the real error instead.
// Workflow sends: `workflow: 'key'` resolves the channel the Admin assigned to that workflow AND merges the channel's
// extra recipients (Company Settings > System Outbound Channels) in one place, so no call site repeats that logic.
//  - include_default_recipients on : the caller's own To stays, extras are added to Cc (de-duplicated, case-insensitive).
//  - include_default_recipients off: the mail goes ONLY to the extras (To); nothing left -> skipped and logged, never thrown.
//  - workflows flagged extras:false (account / password mails, client-facing BG follow-up) never get extras.
const addrKey = (a) => { const m = String(a).match(/<([^>]+)>/); return (m ? m[1] : String(a)).trim().toLowerCase(); };
const splitAddrs = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map(s => String(s).trim()).filter(Boolean);
function resolveWorkflowOpts(opts) {
  const { workflow, ...rest } = opts;
  const channel = getWorkflowChannel(workflow);
  const out = { ...rest, channel };
  const chan = getEmailChannel(channel);
  if (!chan || !workflowAllowsExtras(workflow)) return { out };
  const extras = chan.extra_recipients || [];
  const includeDefaults = chan.include_default_recipients !== false;
  if (includeDefaults && !extras.length) return { out };
  const seen = new Set();
  const uniq = (arr) => arr.filter(a => { const k = addrKey(a); if (seen.has(k)) return false; seen.add(k); return true; });
  if (includeDefaults) {
    const to = uniq(splitAddrs(rest.to));
    const cc = uniq([...splitAddrs(rest.cc), ...extras]);
    out.to = to.length ? to.join(', ') : cc.join(', ');
    out.cc = to.length ? cc : undefined;
    return { out };
  }
  if (!extras.length) {
    try {
      require('../db').db.prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?)')
        .run(null, 'email_skipped_no_recipients', 'email_channel', null, `${workflow} via ${channel}: default recipients switched off and no extra recipients - "${rest.subject || ''}" not sent`);
    } catch (e) { /* logging must never break the caller */ }
    return { skip: { sent: false, skipped: true, reason: 'No recipients: default recipients are switched off for this channel and it has no extra recipients.' } };
  }
  out.to = extras.join(', '); out.cc = undefined;
  return { out };
}
async function sendMail(opts) {
  if (opts && opts.workflow) {
    const r = resolveWorkflowOpts(opts);
    if (r.skip) return r.skip;
    opts = r.out;
  }
  if (!opts || !opts.channel) return deliver(opts);
  const { channel, noFallback, ...rest } = opts;
  const chan = getEmailChannel(channel);
  if (!chan) return deliver(rest);
  const viaChannel = { ...rest, fromName: chan.from_name || rest.fromName, fromAddress: chan.from_address || rest.fromAddress };
  if (chan.smtp_user && chan.smtp_pass) { viaChannel.smtp_user = chan.smtp_user; viaChannel.smtp_pass = chan.smtp_pass; }
  const first = await deliver(viaChannel);
  if (first.sent || noFallback || !/^Sending failed/.test(first.reason || '')) return { ...first, channel };
  console.error(`[mailer] channel "${channel}" send failed (${first.reason}); retrying from the global sender`);
  const second = await deliver(rest);
  return { ...second, channel, fellBack: !!second.sent, channelError: first.reason };
}

module.exports = { sendMail, resolveConfig, isConfigured };

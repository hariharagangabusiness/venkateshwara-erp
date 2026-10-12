// Thin mailer wrapper: a per-call `override` (a department's own SMTP
// account, see lib/departmentEmail.js) takes priority over DB (Company
// Settings > Email Settings), which takes priority over env vars, the
// fallback/default. If nothing at any level is configured, every send()
// call no-ops with a clear "not configured" result instead of crashing -
// the app must keep working end-to-end with no SMTP set up.
const { getEmailSettings } = require('./settings');

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
async function sendMail({ to, cc, subject, text, html, attachments, fromName, fromAddress, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure }) {
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
    const ccAll = Array.from(new Set([...(Array.isArray(cc) ? cc : (cc ? [cc] : [])), ...cfg.ccList])).filter(Boolean);
    const info = await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
      to, cc: ccAll.length ? ccAll.join(',') : undefined,
      subject, text, html, attachments,
    });
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    console.error('[mailer] send failed:', e.message);
    return { sent: false, reason: 'Sending failed: ' + e.message };
  }
}

module.exports = { sendMail, resolveConfig, isConfigured };

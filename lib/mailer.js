// Thin mailer wrapper: DB (Company Settings > Email Settings) overrides env
// vars, which are the fallback/default. If neither is configured, every
// send() call no-ops with a clear "not configured" result instead of
// crashing - the app must keep working end-to-end with no SMTP set up.
const { getEmailSettings } = require('./settings');

function resolveConfig() {
  const dbCfg = getEmailSettings();
  const host = dbCfg.smtp_host || process.env.SMTP_HOST || '';
  const port = Number(dbCfg.smtp_port || process.env.SMTP_PORT || 587);
  const user = dbCfg.smtp_user || process.env.SMTP_USER || '';
  const pass = dbCfg.smtp_pass || process.env.SMTP_PASS || '';
  const secure = dbCfg.smtp_secure !== undefined && dbCfg.smtp_secure !== '' ? !!dbCfg.smtp_secure : (String(process.env.SMTP_SECURE).toLowerCase() === 'true');
  const fromName = dbCfg.from_name || process.env.SMTP_FROM_NAME || 'Venkateshwara Engineers';
  const fromAddress = dbCfg.from_address || process.env.SMTP_FROM_ADDRESS || user;
  const ccList = (dbCfg.cc_list && dbCfg.cc_list.length) ? dbCfg.cc_list
    : (process.env.SMTP_DEFAULT_CC ? process.env.SMTP_DEFAULT_CC.split(',').map(s => s.trim()).filter(Boolean) : []);
  return { host, port, user, pass, secure, fromName, fromAddress, ccList };
}

function isConfigured(cfg) {
  return !!(cfg.host && cfg.user && cfg.fromAddress);
}

// Sends an email. Returns { sent: true, ... } or { sent: false, reason }.
// Never throws - callers should always get a usable response, not a crash.
async function sendMail({ to, cc, subject, text, html, attachments }) {
  const cfg = resolveConfig();
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

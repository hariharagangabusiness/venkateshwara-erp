// Minimal Zoho WorkDrive integration for backup uploads: refresh an OAuth
// access token from a long-lived refresh token (the standard server-side
// "Self Client" OAuth flow - see README's "Backups & migration" section for
// exactly how to obtain one, since that requires a human to walk through
// Zoho's API Console and can't be done from here), then upload one file via
// WorkDrive's REST API. Used by lib/backup.js as an optional additional
// offsite copy alongside the existing email option - skips gracefully
// (never throws) when unconfigured, exactly like lib/mailer.js's sendMail
// does when SMTP isn't set up.
const fs = require('fs');
const path = require('path');

function getConfig() {
  return {
    clientId: process.env.ZOHO_WORKDRIVE_CLIENT_ID || '',
    clientSecret: process.env.ZOHO_WORKDRIVE_CLIENT_SECRET || '',
    refreshToken: process.env.ZOHO_WORKDRIVE_REFRESH_TOKEN || '',
    folderId: process.env.ZOHO_WORKDRIVE_FOLDER_ID || '',
    // Zoho's data-center domain suffix - an account created on the India
    // data center (the default for an Indian company signup) uses zoho.in,
    // a US one uses zoho.com, etc. Get this wrong and every call 404s/400s.
    dc: process.env.ZOHO_WORKDRIVE_DC || 'in',
  };
}
function isConfigured(cfg) {
  return !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken && cfg.folderId);
}

// Test-only escape hatches so the real HTTP request/response handling below
// can be exercised against a local mock server, without touching Zoho's
// actual API or adding a mocking library - never set these in production.
function tokenUrl(cfg) {
  return process.env.ZOHO_WORKDRIVE_TOKEN_URL_OVERRIDE || `https://accounts.zoho.${cfg.dc}/oauth/v2/token`;
}
function uploadUrl(cfg) {
  return process.env.ZOHO_WORKDRIVE_UPLOAD_URL_OVERRIDE || `https://www.zohoapis.${cfg.dc}/workdrive/api/v1/upload`;
}

async function getAccessToken(cfg) {
  const params = new URLSearchParams({
    refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(tokenUrl(cfg), { method: 'POST', body: params });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error(`Zoho token refresh failed (HTTP ${resp.status}): ${json.error || JSON.stringify(json).slice(0, 300)}`);
  }
  return json.access_token;
}

// Uploads one file to the configured WorkDrive folder. Returns
// { uploaded: true, fileId } or { uploaded: false, reason }. Never throws -
// callers should always get a usable result, not a crash, same convention
// as lib/mailer.js's sendMail.
async function uploadFile(filePath) {
  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    return { uploaded: false, reason: 'Zoho WorkDrive is not configured (set ZOHO_WORKDRIVE_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/FOLDER_ID to enable it).' };
  }
  try {
    const accessToken = await getAccessToken(cfg);
    const fileBuffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('parent_id', cfg.folderId);
    form.append('override-name-exist', 'true');
    form.append('content', new Blob([fileBuffer]), path.basename(filePath));
    const resp = await fetch(uploadUrl(cfg), {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      body: form,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { uploaded: false, reason: `Zoho upload failed (HTTP ${resp.status}): ${JSON.stringify(json).slice(0, 300)}` };
    }
    const entry = Array.isArray(json.data) ? json.data[0] : json.data;
    const fileId = entry && (entry.attributes ? (entry.attributes.resource_id || entry.id) : entry.id);
    return { uploaded: true, fileId: fileId || null };
  } catch (e) {
    return { uploaded: false, reason: e.message };
  }
}

module.exports = { uploadFile, isConfigured, getConfig };

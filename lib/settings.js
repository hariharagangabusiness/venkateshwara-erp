// Generic key-value settings store (db/schema `settings` table via migration).
// Company Settings / Email Settings are stored as JSON blobs under fixed keys.
const { db } = require('../db');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

function setSetting(key, value) {
  const json = JSON.stringify(value);
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, json);
}

const DEFAULT_COMPANY = {
  legal_name: 'Venkateshwara Engineers',
  trade_name: 'Venkateshwara Engineers',
  gstin: '',
  pan: '',
  cin: '',
  registered_address: 'Faridabad, Haryana, India',
  factory_address: '',
  state: 'Haryana',
  state_code: '06',
  default_place_of_supply: 'Haryana',
  bank_name: '',
  bank_account_number: '',
  bank_ifsc: '',
  bank_branch: '',
  authorized_signatory_name: '',
  authorized_signatory_designation: '',
  logo_path: '',
  default_gst_rate: 18,
};

const DEFAULT_EMAIL = {
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_pass: '',
  smtp_secure: false,
  from_name: 'Venkateshwara Engineers',
  from_address: '',
  cc_list: [], // array of email strings, always CC'd on automated emails
};

function getCompanySettings() {
  return Object.assign({}, DEFAULT_COMPANY, getSetting('company', {}));
}
function setCompanySettings(v) {
  setSetting('company', Object.assign({}, DEFAULT_COMPANY, getCompanySettings(), v));
}
const DEFAULT_PURCHASE = {
  quote_threshold: 200000, // estimated_value at/above this requires >=2 vendor quotes before approval starts
};

function getPurchaseSettings() {
  return Object.assign({}, DEFAULT_PURCHASE, getSetting('purchase', {}));
}
function setPurchaseSettings(v) {
  setSetting('purchase', Object.assign({}, DEFAULT_PURCHASE, getPurchaseSettings(), v));
}

const DEFAULT_SERVICE = {
  reopen_window_days: 15, // free-of-charge SR reopen window from the technician's closure date
};

function getServiceSettings() {
  return Object.assign({}, DEFAULT_SERVICE, getSetting('service', {}));
}
function setServiceSettings(v) {
  setSetting('service', Object.assign({}, DEFAULT_SERVICE, getServiceSettings(), v));
}

function getEmailSettings() {
  return Object.assign({}, DEFAULT_EMAIL, getSetting('email', {}));
}
function setEmailSettings(v) {
  setSetting('email', Object.assign({}, DEFAULT_EMAIL, getEmailSettings(), v));
}

module.exports = { getSetting, setSetting, getCompanySettings, setCompanySettings, getEmailSettings, setEmailSettings, getPurchaseSettings, setPurchaseSettings, getServiceSettings, setServiceSettings, DEFAULT_COMPANY, DEFAULT_EMAIL, DEFAULT_PURCHASE, DEFAULT_SERVICE };

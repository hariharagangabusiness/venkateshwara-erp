// Admin-editable store for the outbound emails that used to be hardcoded
// strings scattered across this app - see CLAUDE.md's 2026-10-14 backlog
// entry ("Admin-editable content for outbound document/action emails").
// A template key with no row in `email_templates` falls back to
// DEFAULT_TEMPLATES, so an install that's never touched the Email
// Template Customizer keeps sending exactly the same text it always has.
//
// `{{token}}` is the only substitution syntax - the same plain mail-merge
// already used for RFQ's own {{vendor_name}} token (routes/purchase.js),
// not a general templating engine, so what an Admin types in the editor
// is always the literal source of truth with no hidden logic.
const { db } = require('../db');

// Each entry's `variables` is documentation for the frontend editor, not
// enforced server-side - renderTemplate() just leaves an unknown token's
// literal `{{...}}` text in place if a caller forgets to supply it, same
// as the existing {{vendor_name}} RFQ behavior.
const DEFAULT_TEMPLATES = {
  rfq_dispatch: {
    label: 'RFQ Dispatch to Vendors',
    description: 'Sent to every vendor targeted by a Request for Quotation. {{vendor_name}} personalizes each copy.',
    variables: ['vendor_name', 'portal_link'],
    subject: 'Request for Quotation',
    body: 'Dear {{vendor_name}},\n\nPlease find below our requirement. Kindly submit your best quotation online at the earliest:\n{{portal_link}}\n\nRegards,\nVenkateshwara Engineers',
  },
  approval_outcome_approved: {
    label: 'Approval Outcome - Approved',
    description: 'Sent to the original requester once their item clears every approval step.',
    variables: ['requester_name', 'entity_label', 'ref', 'summary', 'actor_name'],
    subject: '{{entity_label}} {{ref}} - Approved',
    body: 'Hello {{requester_name}},\n\nYour {{entity_label}} {{ref}}{{summary}} has been approved by {{actor_name}}.\n\nRegards,\nVenkateshwara Engineers ERP',
  },
  approval_outcome_rejected: {
    label: 'Approval Outcome - Rejected',
    description: 'Sent to the original requester when an approver rejects their item.',
    variables: ['requester_name', 'entity_label', 'ref', 'summary', 'actor_name', 'reason'],
    subject: '{{entity_label}} {{ref}} - Rejected',
    body: 'Hello {{requester_name}},\n\nYour {{entity_label}} {{ref}}{{summary}} has been rejected by {{actor_name}}.\n\n{{reason}}\n\nRegards,\nVenkateshwara Engineers ERP',
  },
  action_pending: {
    label: 'Action Pending (Approver Notification)',
    description: 'Sent to an approver the moment something lands in their queue (a new approval, or one that reaches their step).',
    variables: ['approver_name', 'entity_label', 'ref', 'summary'],
    subject: '{{entity_label}} {{ref}} awaiting your approval',
    body: 'Hello {{approver_name}},\n\nA {{entity_label}} {{ref}}{{summary}} is awaiting your approval.\n\nPlease review it in My Approvals at your earliest convenience.\n\nRegards,\nVenkateshwara Engineers ERP',
  },
};

function listEmailTemplateKeys() {
  return Object.keys(DEFAULT_TEMPLATES);
}

function getEmailTemplateCatalog() {
  const rows = db.prepare('SELECT * FROM email_templates').all();
  const byKey = Object.fromEntries(rows.map(r => [r.template_key, r]));
  return Object.entries(DEFAULT_TEMPLATES).map(([key, def]) => ({
    key,
    label: def.label,
    description: def.description,
    variables: def.variables,
    subject: byKey[key] ? byKey[key].subject : def.subject,
    body: byKey[key] ? byKey[key].body : def.body,
    is_customized: !!byKey[key],
    updated_at: byKey[key] ? byKey[key].updated_at : null,
  }));
}

// Returns {subject, body} - the saved override if one exists, else the
// built-in default. Throws if `key` isn't a real template key, so a typo
// in a call site fails loudly rather than silently sending blank mail.
function getEmailTemplate(key) {
  const def = DEFAULT_TEMPLATES[key];
  if (!def) throw new Error('Unknown email template: ' + key);
  const row = db.prepare('SELECT subject, body FROM email_templates WHERE template_key = ?').get(key);
  return row || { subject: def.subject, body: def.body };
}

function setEmailTemplate(key, subject, body, userId) {
  if (!DEFAULT_TEMPLATES[key]) throw new Error('Unknown email template: ' + key);
  if (!String(subject || '').trim()) throw new Error('Subject is required.');
  if (!String(body || '').trim()) throw new Error('Email body is required.');
  db.prepare(`
    INSERT INTO email_templates (template_key, subject, body, updated_by, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(template_key) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
  `).run(key, subject.trim(), body, userId || null);
}

// Replaces every {{token}} in subject/body with vars[token] - a token with
// no matching key in `vars` is left as literal text rather than erroring,
// same as the pre-existing {{vendor_name}} RFQ behavior this generalizes.
// Deletes a saved customization outright, so the catalog falls back to
// DEFAULT_TEMPLATES again - a genuine "restore the original wording" action
// for the Email Template Customizer's Reset button, not just clearing the
// textarea for an Admin to retype the built-in text from memory.
function resetEmailTemplate(key) {
  if (!DEFAULT_TEMPLATES[key]) throw new Error('Unknown email template: ' + key);
  db.prepare('DELETE FROM email_templates WHERE template_key = ?').run(key);
}

function renderTemplate(tpl, vars) {
  const sub = (s) => String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
  return { subject: sub(tpl.subject), body: sub(tpl.body) };
}

module.exports = { DEFAULT_TEMPLATES, listEmailTemplateKeys, getEmailTemplateCatalog, getEmailTemplate, setEmailTemplate, resetEmailTemplate, renderTemplate };

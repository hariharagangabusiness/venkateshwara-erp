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
const { getSetting, setSetting } = require('./settings');

// Each entry's `variables` is documentation for the frontend editor, not
// enforced server-side - renderTemplate() just leaves an unknown token's
// literal `{{...}}` text in place if a caller forgets to supply it, same
// as the existing {{vendor_name}} RFQ behavior.
const DEFAULT_TEMPLATES = {
  so_annexure_hods: {
    label: 'Sales Order Annexure to HODs',
    description: 'Sent to every active department HOD when someone uses "Email Annexure to HODs" on a Sales Order; the Annexure PDF is attached.',
    variables: ['order_no', 'client_name', 'order_date', 'delivery_date', 'sender_name'],
    subject: 'Sales Order {{order_no}} - Annexure ({{client_name}})',
    body: 'Dear HOD,\n\nPlease find attached the Annexure for Sales Order {{order_no}} ({{client_name}}).\n\nOrder date: {{order_date}}\nPromised delivery: {{delivery_date}}\n\nKindly review the scope relevant to your department and plan accordingly.\n\nRegards,\n{{sender_name}}',
  },
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
  purchase_request_rejected: {
    label: 'Purchase Request Rejected (to Requestor)',
    description: 'Sent to the person who raised a Purchase Request when it is rejected, with the rejection reason.',
    variables: ['requester_name', 'pr_no', 'pr_date', 'department', 'items', 'actor_name', 'actor_role', 'rejected_at', 'reason'],
    subject: 'Purchase Request {{pr_no}} - Rejected',
    body: 'Hello {{requester_name}},\n\nYour Purchase Request {{pr_no}} has been rejected.\n\nREJECTION REASON:\n{{reason}}\n\nPR Number: {{pr_no}}\nPR Date: {{pr_date}}\nDepartment: {{department}}\nItems: {{items}}\nRejected by: {{actor_name}} ({{actor_role}})\nRejected on: {{rejected_at}}\n\nYou can review the reason under Purchase Requests in the ERP, revise the request and resubmit it.\n\nRegards,\nVenkateshwara Engineers ERP',
  },
  purchase_request_cancelled: {
    label: 'Purchase Request Cancelled (to Requestor)',
    description: 'Sent to the person who raised a Purchase Request when an Admin cancels it after approval, with the reason.',
    variables: ['requester_name', 'pr_no', 'pr_date', 'department', 'items', 'actor_name', 'actor_role', 'cancelled_at', 'reason'],
    subject: 'Purchase Request {{pr_no}} - Cancelled',
    body: 'Hello {{requester_name}},\n\nYour Purchase Request {{pr_no}} has been cancelled.\n\nREASON:\n{{reason}}\n\nPR Number: {{pr_no}}\nPR Date: {{pr_date}}\nDepartment: {{department}}\nItems: {{items}}\nCancelled by: {{actor_name}} ({{actor_role}})\nCancelled on: {{cancelled_at}}\n\nRegards,\nVenkateshwara Engineers ERP',
  },
  purchase_request_line_cancelled: {
    label: 'Purchase Request Line Cancelled (to Requestor)',
    description: 'Sent to the person who raised a Purchase Request when an Admin cancels one of its line items, with the reason.',
    variables: ['requester_name', 'pr_no', 'pr_date', 'department', 'item', 'quantity', 'actor_name', 'actor_role', 'cancelled_at', 'reason'],
    subject: 'Purchase Request {{pr_no}} - Line Cancelled',
    body: 'Hello {{requester_name}},\n\nOne line of your Purchase Request {{pr_no}} has been cancelled.\n\nCANCELLED ITEM:\n{{item}} (Qty: {{quantity}})\n\nREASON:\n{{reason}}\n\nThe rest of the request is unchanged.\n\nPR Number: {{pr_no}}\nPR Date: {{pr_date}}\nCancelled by: {{actor_name}} ({{actor_role}})\nCancelled on: {{cancelled_at}}\n\nRegards,\nVenkateshwara Engineers ERP',
  },
  action_pending: {
    label: 'Action Pending (Approver Notification)',
    description: 'Sent to an approver the moment something lands in their queue (a new approval, or one that reaches their step).',
    variables: ['approver_name', 'entity_label', 'ref', 'summary'],
    subject: '{{entity_label}} {{ref}} awaiting your approval',
    body: 'Hello {{approver_name}},\n\nA {{entity_label}} {{ref}}{{summary}} is awaiting your approval.\n\nPlease review it in My Approvals at your earliest convenience.\n\nRegards,\nVenkateshwara Engineers ERP',
  },
  action_escalation: {
    label: 'Action Pending - Escalation Reminder',
    description: 'Sent when an approval has sat un-acted at its current step for 24+ hours, then repeats every 12 hours until it is approved/rejected.',
    variables: ['approver_name', 'entity_label', 'ref', 'summary', 'hours_pending'],
    subject: 'Escalation: {{entity_label}} {{ref}} still awaiting your approval',
    body: 'Hello {{approver_name}},\n\nThis is an escalation reminder - a {{entity_label}} {{ref}}{{summary}} has been awaiting your approval for over {{hours_pending}} hours.\n\nPlease review it in My Approvals as soon as possible.\n\nRegards,\nVenkateshwara Engineers ERP',
  },
  // 2026-11-13: the one email in this whole family that DOES carry the
  // Company Settings Email Settings CC list - the normal "awaiting your
  // approval" notification and the escalation reminder above both now
  // deliberately skip it. Sent weekly, once per approving department, by
  // lib/weeklyApprovalDigest.js. Unlike every other template here, the body
  // is rendered as HTML (sent via sendMail's `html` param, not `text`) so
  // the age-bucket table can be color-coded - {{items_html}} is the
  // auto-generated table itself and isn't meant to be retyped by hand; a
  // literal `<br>` is a real line break here, not a typo.
  weekly_approval_summary: {
    label: 'Weekly Approval Digest (Department Summary)',
    description: 'Sent once a week, one email per approving department, to whoever can act on that department\'s pending approvals - always copies the Company Settings Email Settings CC list. The body is HTML; {{items_html}} is the auto-generated, color-coded pending-items table and cannot be hand-edited here, only the text around it.',
    variables: ['hod_name', 'department', 'total', 'items_html'],
    subject: 'Weekly Summary Report - {{department}} - {{total}} pending item(s)',
    body: 'Hello {{hod_name}},<br><br>Here is this week\'s summary of pending approvals for the {{department}} department.<br><br>{{items_html}}<br><br>Regards,<br>Venkateshwara Engineers ERP',
  },
};

function listEmailTemplateKeys() {
  return Object.keys(DEFAULT_TEMPLATES);
}

function getEmailTemplateCatalog() {
  const rows = db.prepare('SELECT * FROM email_templates').all();
  const byKey = Object.fromEntries(rows.filter(r => !r.is_custom).map(r => [r.template_key, r]));
  const builtIn = Object.entries(DEFAULT_TEMPLATES).map(([key, def]) => ({
    key,
    label: def.label,
    description: def.description,
    variables: def.variables,
    subject: byKey[key] ? byKey[key].subject : def.subject,
    body: byKey[key] ? byKey[key].body : def.body,
    is_customized: !!byKey[key],
    is_custom: false,
    updated_at: byKey[key] ? byKey[key].updated_at : null,
  }));
  // Admin-created templates (always keyed custom_*), listed after the built-ins.
  const custom = rows.filter(r => r.is_custom).sort((a, b) => String(a.label).localeCompare(String(b.label))).map(r => ({
    key: r.template_key, label: r.label || r.template_key, description: r.description || '', variables: parseJsonArray(r.variables),
    subject: r.subject, body: r.body, is_customized: false, is_custom: true, updated_at: r.updated_at,
  }));
  return [...builtIn, ...custom];
}
function parseJsonArray(s) { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function isCustomTemplate(key) { return !!db.prepare('SELECT 1 FROM email_templates WHERE template_key = ? AND is_custom = 1').get(key); }
const templateTokens = (tpl) => [...new Set([...String(tpl.subject || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g), ...String(tpl.body || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]))];

// Creates an Admin-defined template. The key is forced to start with custom_, so it can never collide with a built-in
// (current or future) template key.
function createCustomTemplate({ key, name, description, subject, body, placeholders }, userId) {
  const label = String(name || '').trim();
  if (!label) throw new Error('Template name is required.');
  if (!String(subject || '').trim()) throw new Error('Subject is required.');
  if (!String(body || '').trim()) throw new Error('Email body is required.');
  let slug = String(key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug.startsWith('custom_')) slug = 'custom_' + slug;
  if (slug === 'custom_' || slug.length > 60) throw new Error('Template key must be 1-53 letters/numbers after "custom_".');
  if (DEFAULT_TEMPLATES[slug] || db.prepare('SELECT 1 FROM email_templates WHERE template_key = ?').get(slug)) throw new Error('A template with the key "' + slug + '" already exists.');
  const list = Array.isArray(placeholders) ? placeholders : String(placeholders || '').split(/[,;\s]+/);
  const vars = [...new Set(list.map(s => String(s).replace(/[{}]/g, '').trim()).filter(Boolean))];
  const badVar = vars.find(v => !/^\w+$/.test(v));
  if (badVar) throw new Error('Placeholder names may only contain letters, numbers and underscores: ' + badVar);
  db.prepare(`INSERT INTO email_templates (template_key, subject, body, updated_by, updated_at, is_custom, label, description, variables)
    VALUES (?, ?, ?, ?, (datetime('now','localtime')), 1, ?, ?, ?)`).run(slug, String(subject).trim(), body, userId || null, label, String(description || '').trim(), JSON.stringify(vars));
  return slug;
}
// Deletes a custom template only (built-ins use Reset). Refused while a workflow still uses it.
function deleteCustomTemplate(key) {
  if (DEFAULT_TEMPLATES[key]) throw new Error('Built-in templates cannot be deleted - use Reset to Default to restore the original wording.');
  if (!isCustomTemplate(key)) { const e = new Error('Template not found.'); e.status = 404; throw e; }
  const used = Object.entries(getWorkflowTemplateAssignments()).filter(([, v]) => v === key).map(([pair]) => pair.split('|')[0]);
  if (used.length) {
    const { EMAIL_WORKFLOWS, getEmailChannels, getEmailWorkflowChannels } = require('./settings');
    const chans = getEmailChannels(), assigned = getEmailWorkflowChannels();
    throw new Error('This template is still assigned to: ' + [...new Set(used)].map(w => `${(EMAIL_WORKFLOWS[w] || {}).label || w} (channel: ${(chans[assigned[w]] || {}).label || assigned[w]})`).join('; ') + '. Switch those workflows back to the default template first.');
  }
  db.prepare('DELETE FROM email_templates WHERE template_key = ? AND is_custom = 1').run(key);
}

// ---- Workflow -> template assignment ({ 'workflow|defaultTemplateKey': customTemplateKey }, settings 'email_workflow_templates') ----
function getWorkflowTemplateAssignments() { return getSetting('email_workflow_templates', {}); }
// Returns an error string if the custom template can't stand in for `defaultKey` in `workflowKey`: it must exist and may only use
// the placeholders that default template's send site fills in (otherwise a literal {{...}} would reach the recipient).
function validateTemplateAssignment(workflowKey, defaultKey, customKey) {
  const { EMAIL_WORKFLOWS } = require('./settings');
  const wf = EMAIL_WORKFLOWS[workflowKey];
  if (!wf || !wf.templates.includes(defaultKey) || !DEFAULT_TEMPLATES[defaultKey]) return `Unknown workflow template ${workflowKey}|${defaultKey}.`;
  const row = db.prepare('SELECT subject, body, label FROM email_templates WHERE template_key = ? AND is_custom = 1').get(customKey);
  if (!row) return 'Unknown custom template ' + customKey + '.';
  const allowed = new Set(DEFAULT_TEMPLATES[defaultKey].variables);
  const unknown = templateTokens(row).filter(t => !allowed.has(t));
  if (unknown.length) return `"${row.label}" uses placeholders that "${DEFAULT_TEMPLATES[defaultKey].label}" does not provide: ${unknown.map(t => '{{' + t + '}}').join(', ')}. Available: ${DEFAULT_TEMPLATES[defaultKey].variables.map(t => '{{' + t + '}}').join(', ')}.`;
  return null;
}
function setWorkflowTemplateAssignments(map) {
  const cur = Object.assign({}, getWorkflowTemplateAssignments());
  for (const [pair, customKey] of Object.entries(map || {})) { if (customKey) cur[pair] = customKey; else delete cur[pair]; }
  setSetting('email_workflow_templates', cur);
}
// Runtime lookup used by every workflow send site: the template the Admin assigned to this workflow (when it still exists), else the
// built-in/overridden default - so an unassigned workflow sends exactly what it always did.
function getWorkflowTemplate(workflowKey, defaultKey) {
  const assigned = getWorkflowTemplateAssignments()[workflowKey + '|' + defaultKey];
  if (assigned) { try { return getEmailTemplate(assigned); } catch (e) { /* deleted / missing -> default */ } }
  return getEmailTemplate(defaultKey);
}

// Returns {subject, body} - the saved override if one exists, else the
// built-in default. Throws if `key` isn't a real template key, so a typo
// in a call site fails loudly rather than silently sending blank mail.
function getEmailTemplate(key) {
  const def = DEFAULT_TEMPLATES[key];
  if (!def) {
    const c = db.prepare('SELECT subject, body FROM email_templates WHERE template_key = ? AND is_custom = 1').get(key);
    if (c) return c;
    throw new Error('Unknown email template: ' + key);
  }
  let row = db.prepare('SELECT subject, body FROM email_templates WHERE template_key = ?').get(key);
  // HODs must not see commercial values: drop any saved "order value" line from this template (keeps other Admin edits).
  if (row && key === 'so_annexure_hods' && /\{\{\s*order_value\s*\}\}/.test(row.subject + row.body)) {
    const strip = t => String(t).split('\n').filter(l => !/\{\{\s*order_value\s*\}\}/.test(l)).join('\n');
    row = { subject: strip(row.subject) || def.subject, body: strip(row.body) };
    db.prepare('UPDATE email_templates SET subject = ?, body = ? WHERE template_key = ?').run(row.subject, row.body, key);
  }
  return row || { subject: def.subject, body: def.body };
}

function setEmailTemplate(key, subject, body, userId) {
  if (!DEFAULT_TEMPLATES[key] && !isCustomTemplate(key)) throw new Error('Unknown email template: ' + key);
  if (!String(subject || '').trim()) throw new Error('Subject is required.');
  if (!String(body || '').trim()) throw new Error('Email body is required.');
  db.prepare(`
    INSERT INTO email_templates (template_key, subject, body, updated_by, updated_at)
    VALUES (?, ?, ?, ?, (datetime('now','localtime')))
    ON CONFLICT(template_key) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by, updated_at = (datetime('now','localtime'))
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
  if (isCustomTemplate(key)) throw new Error('This is a custom template - delete it instead of resetting it.');
  if (!DEFAULT_TEMPLATES[key]) throw new Error('Unknown email template: ' + key);
  db.prepare('DELETE FROM email_templates WHERE template_key = ?').run(key);
}

function renderTemplate(tpl, vars) {
  const sub = (s) => String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
  return { subject: sub(tpl.subject), body: sub(tpl.body) };
}

module.exports = { DEFAULT_TEMPLATES, listEmailTemplateKeys, getEmailTemplateCatalog, getEmailTemplate, setEmailTemplate, resetEmailTemplate, renderTemplate,
  createCustomTemplate, deleteCustomTemplate, isCustomTemplate, templateTokens, getWorkflowTemplate, getWorkflowTemplateAssignments, setWorkflowTemplateAssignments, validateTemplateAssignment };

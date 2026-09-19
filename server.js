require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// initializes db + runs schema on require
const { isNew } = require('./db');
const { getUploadsDir } = require('./lib/paths');

// Seed roles/departments/permissions/demo users/admin login whenever the
// database file did not already exist before this boot - covers a fresh
// deploy target (e.g. Railway with no persistent volume yet, or the first
// boot on a new one) where nobody has a chance to run db/seed.js by hand.
// seed.js is idempotent (INSERT OR IGNORE / upsert throughout) so this is
// also safe to leave running against a carried-forward database.
if (isNew) {
  console.log('New database detected - running seed...');
  require('./db/seed');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Explicit mount so uploaded files stay servable at /uploads/... even when
// UPLOADS_DIR points outside public/ (e.g. a Render persistent disk).
app.use('/uploads', express.static(getUploadsDir()));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/masters', require('./routes/masters'));
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/hr', require('./routes/hr'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/expense-tracker', require('./routes/expenseTracker'));
app.use('/api/site-visits', require('./routes/siteVisits'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/offers', require('./routes/offers'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/purchase', require('./routes/purchase'));
app.use('/api/service', require('./routes/service'));
app.use('/api/service-centers', require('./routes/serviceCenters'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/assets', require('./routes/assets'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/data-import', require('./routes/dataImport'));
app.use('/api/bg', require('./routes/bankGuarantees'));
app.use('/api/todos', require('./routes/todos'));

app.get('/health', (req, res) => res.json({ ok: true }));

// PO/SO delivery-date and Bank Guarantee expiry/reminder scan (Round 16).
// No background job runner in this app - a plain setInterval is the
// simplest fit for a single-process app; runs once at boot, then every
// 6 hours. Never let a scan failure crash the process.
const { runScan } = require('./lib/bgReminderScan');
function runReminderScanSafely() {
  try {
    const result = runScan();
    if (result.deliveryAlerts || result.bgReminders) {
      console.log(`[bg-scan] ${result.deliveryAlerts} delivery alert(s), ${result.bgReminders} BG reminder(s) raised`);
    }
  } catch (e) {
    console.error('[bg-scan] failed:', e.message);
  }
}
setTimeout(runReminderScanSafely, 5000); // let the server finish booting first
setInterval(runReminderScanSafely, 6 * 60 * 60 * 1000);


// Friendly names for UNIQUE-indexed columns, so a raw SQLite constraint
// error ("UNIQUE constraint failed: clients.gstin") becomes a clean message
// instead of leaking a raw 500/stack trace to the UI. Express 5 forwards a
// synchronous route-handler throw here automatically, so this single
// handler covers every UNIQUE index added across the app (existing
// server-generated numbers like pr_no/po_no/project_code never actually
// collide in practice, so they've never needed this - but this now also
// protects them if that ever changes).
const UNIQUE_FIELD_LABELS = {
  'clients.gstin': 'A client with this GSTIN already exists.',
  'vendors.gstin': 'A vendor with this GSTIN already exists.',
  'service_reports.sl_no': 'This report serial number is already in use - please retry the save.',
  'users.username': 'That username is already taken.',
  'items.item_code': 'An item with this item code already exists.',
  'employees.employee_code': 'An employee with this employee code already exists.',
};
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && /UNIQUE constraint failed/i.test(err.message || '')) {
    const m = /UNIQUE constraint failed:\s*([\w.]+)/i.exec(err.message);
    const field = m && m[1];
    const friendly = (field && UNIQUE_FIELD_LABELS[field]) || 'This record duplicates one that already exists.';
    return res.status(400).json({ error: friendly });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Venkateshwara Engineers ERP running on http://localhost:${PORT}`));

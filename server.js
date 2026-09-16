require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// initializes db + runs schema on require
require('./db');
const { getUploadsDir } = require('./lib/paths');

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

app.get('/health', (req, res) => res.json({ ok: true }));

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

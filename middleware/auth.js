const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { oversightRoleIds } = require('../lib/roleOversight');
const SECRET = process.env.JWT_SECRET || 'venkateshwara-erp-dev-secret';

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare(`
      SELECT u.*, r.name as role_name FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.is_active = 1
    `).get(payload.id);
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Checks that the user's role has ANY of the given permission codes,
// OR that the user's role is 'Admin' (Admin bypasses all checks), OR that
// the user has been granted cross-department oversight (role_oversight) of
// another role that itself holds one of the codes - e.g. a unified
// Electrical & Service HOD picks up Service's permissions on top of their
// own without their account's actual role/department changing.
function requirePermission(...codes) {
  return (req, res, next) => {
    if (req.user.role_name === 'Admin') return next();
    const roleIds = [req.user.role_id, ...oversightRoleIds(db, req.user.id)];
    const placeholders = roleIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT p.code FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id IN (${placeholders})
    `).all(...roleIds);
    const granted = new Set(rows.map(r => r.code));
    if (codes.some(c => granted.has(c))) return next();
    return res.status(403).json({ error: 'Access denied: missing permission ' + codes.join(',') });
  };
}

function requireRole(...roleNames) {
  return (req, res, next) => {
    if (req.user.role_name === 'Admin') return next();
    if (roleNames.includes(req.user.role_name)) return next();
    return res.status(403).json({ error: 'Access denied: role required ' + roleNames.join(',') });
  };
}

module.exports = { authRequired, requirePermission, requireRole, SECRET };

const crypto = require('crypto');
const { db } = require('../db');

const TOKEN_TTL_MINUTES = 30;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

// Setting a first password on a brand-new account (AccountActivation) and
// resetting a forgotten one (PasswordReset) are the same operation - a token
// proves "this really is that account's owner", then a new password gets
// set - so `purpose` only changes the email copy, not the verify/consume
// logic below. Only the token's hash is ever persisted, same reasoning as a
// password hash: a stolen DB dump shouldn't hand out live reset links.
function createToken(userId, purpose) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60000).toISOString();
  // Only one live "set your password" link per account at a time - issuing a
  // new one retires any earlier unused link so a stale copy of an old email
  // can't be replayed after a newer request superseded it.
  db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(userId);
  db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, purpose, expires_at) VALUES (?,?,?,?)`)
    .run(userId, hashToken(rawToken), purpose, expiresAt);
  return rawToken;
}

// Throws a user-safe message on any invalid/used/expired token; returns the
// token row (has user_id, purpose) on success. Deliberately doesn't leak
// *why* a token looks wrong beyond that - same not-found-vs-expired
// ambiguity a login form gives for a bad password.
function verifyToken(rawToken) {
  const row = db.prepare(`SELECT * FROM password_reset_tokens WHERE token_hash = ?`).get(hashToken(rawToken));
  if (!row) throw new Error('This link is invalid. Please request a new one.');
  if (row.used_at) throw new Error('This link has already been used. Please request a new one.');
  if (new Date(row.expires_at) < new Date()) throw new Error('This link has expired. Please request a new one.');
  return row;
}

function consumeToken(tokenRowId) {
  db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(tokenRowId);
}

// A random, human-typeable temporary password for a welcome email - drawn
// from a fixed alphanumeric charset (no symbols an email client could
// mangle in transit) via crypto.randomInt, so every password is exactly 12
// characters with no weak fallback padding needed.
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // excludes look-alikes (0/O, 1/l/I)
function generateTempPassword(length = 12) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TEMP_PASSWORD_CHARS[crypto.randomInt(TEMP_PASSWORD_CHARS.length)];
  }
  return out;
}

module.exports = { createToken, verifyToken, consumeToken, generateTempPassword, TOKEN_TTL_MINUTES };

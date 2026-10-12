'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const SESSION_COOKIE = 'cl_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) cookies[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// A valid hash to compare against when the email is unknown, so response time
// does not reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now + SESSION_TTL_MS,
    now,
  );
  return token;
}

function setSessionCookie(res, token, { secure }) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res, { secure }) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
}

/** Attaches req.user when a valid session cookie is present. Only the token's hash is stored. */
function sessionMiddleware(db) {
  const lookup = db.prepare(
    `SELECT u.id, u.email, u.reporting_currency, u.include_fees_in_cost_basis
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  );
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const user = lookup.get(sha256(token), Date.now());
      if (user) {
        req.user = user;
        req.sessionTokenHash = sha256(token);
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
}

/** Small in-memory limiter for login/registration attempts. */
function rateLimiter({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    }
    return entry.count <= max;
  };
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  requireAuth,
  rateLimiter,
  sha256,
};

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'mc_session';
export const VISITOR_COOKIE = 'mc_vid';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function createSessionStore(db, { sessionDays }) {
  const ttl = sessionDays * 24 * 3600 * 1000;
  const insert = db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const lookup = db.prepare(
    `SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  );
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const touch = db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?');

  return {
    ttl,
    create(userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      insert.run(sha256(token), userId, now, now + ttl);
      return token;
    },
    resolve(token) {
      if (!token || token.length > 100) return null;
      const now = Date.now();
      const user = lookup.get(sha256(token), now);
      if (!user) return null;
      if (!user.last_seen_at || now - user.last_seen_at > 60_000) touch.run(now, user.id);
      return user;
    },
    destroy(token) {
      if (token) remove.run(sha256(token));
    },
    destroyAllFor(userId) {
      removeUser.run(userId);
    },
    purgeExpired() {
      purge.run(Date.now());
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie mal formé : ignoré */
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join('; ');
}

export function visitorHash(visitorId) {
  return sha256(`mycity-visitor:${visitorId}`).slice(0, 24);
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

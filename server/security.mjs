import { createHash, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveAsync = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function digest(value) { return createHash('sha256').update(value).digest('hex'); }

export function createCodeVerifier(code, salt) {
  const expected = scryptSync(code, salt, 32, SCRYPT_OPTIONS);
  return {
    version: digest(expected),
    async verify(candidate) {
      const actual = await deriveAsync(candidate, salt, 32, SCRYPT_OPTIONS);
      return timingSafeEqual(actual, expected);
    },
  };
}

export function readSessionToken(req) {
  const part = (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('stage_session='));
  const token = part?.slice('stage_session='.length);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function createRateLimiter({ limit, windowMs }) {
  const entries = new Map();
  return {
    take(key) {
      const now = Date.now();
      let entry = entries.get(key);
      if (!entry || entry.expiresAt <= now) {
        if (entries.size >= 10_000) {
          for (const [candidate, value] of entries) if (value.expiresAt <= now) entries.delete(candidate);
          if (entries.size >= 10_000) return false;
        }
        entry = { count: 0, expiresAt: now + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= limit;
    },
    reset(key) { entries.delete(key); },
  };
}

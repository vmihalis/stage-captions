import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function resolveAccessCode(config) {
  if (config.teamAccessCode) {
    if (config.teamAccessCode.length < 12 || config.teamAccessCode.length > 256) {
      throw new Error('TEAM_ACCESS_CODE must contain 12–256 characters. Use at least 16 random characters.');
    }
    return { code: config.teamAccessCode, path: null };
  }
  if (!LOOPBACK.has(config.host) || !LOOPBACK.has(new URL(config.publicOrigin).hostname)) {
    throw new Error('Set TEAM_ACCESS_CODE before making Stage accessible outside this computer.');
  }
  const directory = dirname(config.databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'team-access-code.txt');
  if (existsSync(path)) {
    const code = readFileSync(path, 'utf8').trim();
    if (code.length < 12 || code.length > 256) throw new Error('The saved team access code is invalid. Replace it with 12–256 characters.');
    chmodSync(path, 0o600);
    return { code, path };
  }
  const code = randomBytes(24).toString('base64url');
  writeFileSync(path, `${code}\n`, { mode: 0o600, flag: 'wx' });
  return { code, path };
}

import { resolve } from 'node:path';
import { isIP } from 'node:net';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const port = Number(env.PORT || 4310);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a valid port number.');
  }
  const publicUrl = new URL(env.PUBLIC_ORIGIN || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP or HTTPS origin without a path.');
  }
  if (publicUrl.protocol !== 'https:' && !LOOPBACK_HOSTS.has(publicUrl.hostname)) {
    throw new Error('PUBLIC_ORIGIN must use HTTPS outside localhost, 127.0.0.1, or ::1.');
  }
  const proxySetting = (env.TRUSTED_PROXY_IPS || '').trim();
  const trustedProxyIps = proxySetting ? proxySetting.split(',').map((ip) => ip.trim()) : [];
  if (trustedProxyIps.some((ip) => !isIP(ip) || ip.includes('%'))) {
    throw new Error('TRUSTED_PROXY_IPS must contain only comma-separated exact IPv4 or IPv6 addresses.');
  }
  const teamTokenLimitPerMinute = Number(env.TEAM_TOKEN_LIMIT_PER_MINUTE || 60);
  if (!Number.isSafeInteger(teamTokenLimitPerMinute) || teamTokenLimitPerMinute < 1) {
    throw new Error('TEAM_TOKEN_LIMIT_PER_MINUTE must be a positive integer.');
  }
  const sonioxRegion = (env.SONIOX_REGION || 'global').toLowerCase();
  if (!['global', 'eu', 'jp'].includes(sonioxRegion)) {
    throw new Error('SONIOX_REGION must be global, eu, or jp.');
  }
  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicOrigin: publicUrl.origin,
    databasePath: resolve(cwd, env.DATABASE_PATH || 'data/stage.db'),
    distPath: resolve(cwd, 'dist'),
    sonioxApiKey: (env.SONIOX_API_KEY || '').trim(),
    sonioxRegion,
    teamAccessCode: env.TEAM_ACCESS_CODE || '',
    trustedProxyIps: [...new Set(trustedProxyIps)],
    teamTokenLimitPerMinute,
  };
}

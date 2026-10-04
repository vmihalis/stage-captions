import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.mjs';
import { resolveAccessCode } from '../../server/access-code.mjs';

const CODE = 'shared-team-test-code-123456';
const MASTER_KEY = 'server-only-master-key-123456';
const ORIGIN = 'https://stage.test';

async function fixture(t, { provider, code = CODE, directory, config: overrides = {} } = {}) {
  const root = directory || await mkdtemp(join(tmpdir(), 'stage-server-'));
  const config = { databasePath: join(root, 'stage.db'), publicOrigin: ORIGIN, distPath: join(root, 'dist'), teamAccessCode: code, sonioxApiKey: '', sonioxRegion: 'global', ...overrides };
  const app = createApp({ config, provider });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.locals.store.close();
  }
  t.after(async () => { await close(); if (!directory) await rm(root, { recursive: true, force: true }); });
  function client() {
    let cookie;
    return {
      get cookie() { return cookie; },
      async call(path, { method = 'GET', body, origin = ORIGIN, raw, cookieOverride, forwardedFor } = {}) {
        const headers = {};
        if (origin !== null) headers.Origin = origin;
        if (cookieOverride || cookie) headers.Cookie = cookieOverride || cookie;
        if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
        if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;
        const response = await fetch(`${base}${path}`, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const payload = await response.json();
        return { status: response.status, headers: response.headers, body: payload };
      },
      async unlock(accessCode = code) { return this.call('/api/auth/unlock', { method: 'POST', body: { code: accessCode } }); },
    };
  }
  return { root, config, client, close, base };
}

test('shared access is required and public session response contains no credentials or glossary', async (t) => {
  const fx = await fixture(t);
  const client = fx.client();
  const state = await client.call('/api/session');
  assert.deepEqual(state.body, { authenticated: false, team: { name: 'Your team' }, provider: { configured: false, region: 'global' } });
  assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.equal((await client.call('/api/team')).status, 401);
  assert.equal((await client.call('/api/team', { method: 'PATCH', body: { name: 'Changed' } })).status, 401);
  assert.equal((await client.call('/api/speech/token', { method: 'POST' })).status, 401);
  assert.equal((await client.call('/api/auth/signup', { method: 'POST', body: {} })).status, 404);
  assert.ok(!JSON.stringify(state.body).includes(CODE));
});

test('unlock creates a protected opaque session, stores only its hash, and logout revokes it', async (t) => {
  const fx = await fixture(t);
  const client = fx.client();
  assert.equal((await client.unlock('incorrect-code')).status, 401);
  const unlocked = await client.unlock();
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.body.authenticated, true);
  const cookie = client.cookie;
  const cookieHeader = unlocked.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  assert.match(cookieHeader, /; Secure(?:;|$)/i);
  assert.match(cookieHeader, /Max-Age=604800/);
  assert.equal((await client.call('/api/session')).body.authenticated, true);
  const db = new DatabaseSync(fx.config.databasePath, { readOnly: true });
  const stored = db.prepare('SELECT token_hash FROM sessions').get().token_hash;
  db.close();
  assert.notEqual(stored, cookie.slice('stage_session='.length));
  assert.match(stored, /^[a-f0-9]{64}$/);
  assert.equal((await client.call('/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await client.call('/api/session', { cookieOverride: cookie })).body.authenticated, false);
});

test('all team-code holders share persisted team vocabulary and updates are bounded', async (t) => {
  const fx = await fixture(t);
  const first = fx.client();
  const second = fx.client();
  await first.unlock();
  await second.unlock();
  const team = { name: 'Japan presentation team', glossary: { terms: ['Stage', 'Stage'], translationTerms: [{ source: 'Stage', target: 'ステージ' }], background: 'Our product demonstration.' } };
  const updated = await first.call('/api/team', { method: 'PATCH', body: team });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.glossary.terms, ['Stage']);
  assert.deepEqual((await second.call('/api/team')).body, updated.body);
  assert.equal((await first.call('/api/team', { method: 'PATCH', body: { name: '' } })).status, 400);
  assert.equal((await first.call('/api/team', { method: 'PATCH', body: { glossary: { terms: [], translationTerms: [], background: 'x'.repeat(6001) } } })).status, 400);
  assert.equal((await first.call('/api/team', { method: 'PATCH', raw: '{' })).status, 400);
  assert.equal((await first.call('/api/team', { method: 'PATCH', raw: JSON.stringify({ name: 'x'.repeat(50_000) }) })).status, 413);
});

test('mutations reject absent or foreign origins and API errors remain JSON', async (t) => {
  const fx = await fixture(t);
  const client = fx.client();
  assert.equal((await client.call('/api/auth/unlock', { method: 'POST', origin: null, body: { code: CODE } })).status, 403);
  assert.equal((await client.call('/api/auth/unlock', { method: 'POST', origin: 'http://another-site.test', body: { code: CODE } })).status, 403);
  await client.unlock();
  assert.equal((await client.call('/api/team', { method: 'PATCH', origin: 'null', body: { name: 'Changed' } })).status, 403);
  const missing = await client.call('/api/missing');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error, 'string');
});

test('incorrect access codes are rate limited', async (t) => {
  const fx = await fixture(t);
  const client = fx.client();
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await client.unlock('wrong')).status, 401);
  const limited = await client.unlock();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
});

test('untrusted forwarding headers cannot choose the login limiter address', async (t) => {
  for (const trustedProxyIps of [[], ['192.0.2.10']]) {
    const fx = await fixture(t, { config: { trustedProxyIps } });
    const client = fx.client();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await client.call('/api/auth/unlock', {
        method: 'POST', body: { code: 'wrong' }, forwardedFor: `198.51.100.${attempt + 1}`,
      });
      assert.equal(result.status, 401);
    }
    const blocked = await client.call('/api/auth/unlock', {
      method: 'POST', body: { code: CODE }, forwardedFor: '203.0.113.50',
    });
    assert.equal(blocked.status, 429);
  }
});

test('an explicitly trusted proxy separates clients and stops at the first untrusted hop', async (t) => {
  const fx = await fixture(t, { config: { trustedProxyIps: ['127.0.0.1'] } });
  const client = fx.client();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await client.call('/api/auth/unlock', {
      method: 'POST', body: { code: 'wrong' },
      forwardedFor: `203.0.113.${attempt + 1}, 198.51.100.20`,
    });
    assert.equal(result.status, 401);
  }
  const blocked = await client.call('/api/auth/unlock', {
    method: 'POST', body: { code: CODE }, forwardedFor: '203.0.113.100, 198.51.100.20',
  });
  assert.equal(blocked.status, 429);
  const anotherClient = await client.call('/api/auth/unlock', {
    method: 'POST', body: { code: CODE }, forwardedFor: '198.51.100.21',
  });
  assert.equal(anotherClient.status, 200);
});

test('live translation gives a configuration error until a provider key is installed', async (t) => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const result = await client.call('/api/speech/token', { method: 'POST' });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /not configured/);
});

test('authenticated speech route returns only temporary credential fields and current context', async (t) => {
  const references = [];
  const fx = await fixture(t, { provider: {
    configured: true, region: 'jp', async issue(reference) {
      references.push(reference);
      return { apiKey: 'temporary-test-key', websocketUrl: 'wss://stt-rt.jp.soniox.com/transcribe-websocket', model: 'stt-rt-v5', masterKey: MASTER_KEY, debug: 'private' };
    },
  } });
  const client = fx.client();
  await client.unlock();
  await client.call('/api/team', { method: 'PATCH', body: { glossary: { terms: ['Stage'], translationTerms: [{ source: 'Stage', target: 'ステージ' }], background: 'Product demo' } } });
  const result = await client.call('/api/speech/token', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    apiKey: 'temporary-test-key', websocketUrl: 'wss://stt-rt.jp.soniox.com/transcribe-websocket', model: 'stt-rt-v5',
    context: { text: 'Product demo', terms: ['Stage'], translation_terms: [{ source: 'Stage', target: 'ステージ' }] },
  });
  assert.equal(references.length, 1);
  assert.notEqual(references[0], CODE);
  assert.ok(!JSON.stringify(result.body).includes(MASTER_KEY));
});

test('the team token limit is shared across logins and blocks calls before the provider', async (t) => {
  let issued = 0;
  const fx = await fixture(t, {
    config: { teamTokenLimitPerMinute: 2 },
    provider: {
      configured: true, region: 'global', async issue() {
        issued += 1;
        return { apiKey: 'temporary-test-key', websocketUrl: 'wss://stt-rt.soniox.com/transcribe-websocket', model: 'stt-rt-v5' };
      },
    },
  });
  const first = fx.client();
  const second = fx.client();
  await first.unlock();
  await second.unlock();
  assert.equal((await first.call('/api/speech/token', { method: 'POST' })).status, 200);
  assert.equal((await second.call('/api/speech/token', { method: 'POST' })).status, 200);
  const blocked = await first.call('/api/speech/token', { method: 'POST' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  // A fresh authenticated session must not reset the team-wide allowance.
  const third = fx.client();
  await third.unlock();
  assert.equal((await third.call('/api/speech/token', { method: 'POST' })).status, 429);
  assert.equal(issued, 2);
});

test('restarting with a rotated shared code revokes sessions and preserves glossary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stage-rotation-'));
  let fx;
  let rotated;
  // Windows cannot unlink a SQLite database while another fixture still has it open.
  t.after(async () => {
    await rotated?.close();
    await fx?.close();
    await rm(root, { recursive: true, force: true });
  });
  fx = await fixture(t, { directory: root });
  const oldClient = fx.client();
  await oldClient.unlock();
  await oldClient.call('/api/team', { method: 'PATCH', body: { name: 'Saved team' } });
  const oldCookie = oldClient.cookie;
  await fx.close();
  rotated = await fixture(t, { directory: root, code: 'different-team-code-987654' });
  const client = rotated.client();
  assert.equal((await client.call('/api/session', { cookieOverride: oldCookie })).body.authenticated, false);
  assert.equal((await client.unlock(CODE)).status, 401);
  assert.equal((await client.unlock()).status, 200);
  assert.equal((await client.call('/api/team')).body.name, 'Saved team');
});

test('local bootstrap persists a private code and remote hosting requires an explicit code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stage-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { host: '127.0.0.1', publicOrigin: 'http://localhost:4310', databasePath: join(root, 'data/stage.db'), teamAccessCode: '' };
  const first = resolveAccessCode(config);
  assert.match(first.code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(resolveAccessCode(config).code, first.code);
  if (process.platform !== 'win32') assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.throws(() => resolveAccessCode({ ...config, host: '0.0.0.0' }), /TEAM_ACCESS_CODE/);
});

test('production serves the built client for page routes while retaining API 404s', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stage-static-'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.html'), '<!doctype html><title>Stage fixture</title>');
  const fx = await fixture(t, { directory: root });
  // Register after the fixture's close hook so Windows releases its database files first.
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = await fetch(`${fx.base}/present`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stage fixture/);
  assert.equal((await fx.client().call('/api/not-a-route')).status, 404);
});

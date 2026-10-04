import test from 'node:test';
import assert from 'node:assert/strict';
import { createSonioxProvider, glossaryToContext } from '../../server/soniox.mjs';
import { loadConfig } from '../../server/config.mjs';

test('provider issues a restricted single-use key through the chosen regional endpoint', async () => {
  let request;
  const provider = createSonioxProvider({
    apiKey: 'server-only-test-key', region: 'jp',
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return Response.json({ api_key: 'temporary-test-credential', expires_at: 'ignored', extra: 'never-return-this' }, { status: 201 });
    },
  });
  const result = await provider.issue('presenter-test-id');
  assert.equal(request.url, 'https://api.jp.soniox.com/v1/auth/temporary-api-key');
  assert.equal(request.headers.Authorization, 'Bearer server-only-test-key');
  assert.deepEqual(JSON.parse(request.body), {
    usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true,
    max_session_duration_seconds: 18000, client_reference_id: 'presenter-test-id',
  });
  assert.deepEqual(result, { apiKey: 'temporary-test-credential', websocketUrl: 'wss://stt-rt.jp.soniox.com/transcribe-websocket', model: 'stt-rt-v5' });
  assert.ok(!JSON.stringify(result).includes('server-only-test-key'));
  assert.ok(!JSON.stringify(result).includes('never-return-this'));
});

test('unconfigured and failed providers return useful sanitized failures', async () => {
  await assert.rejects(createSonioxProvider().issue('id'), { status: 503 });
  const provider = createSonioxProvider({ apiKey: 'secret', fetchImpl: async () => Response.json({ message: 'secret' }, { status: 401 }) });
  await assert.rejects(provider.issue('id'), (error) => error.status === 502 && !error.message.includes('secret'));
  const failed = createSonioxProvider({ apiKey: 'secret', fetchImpl: async () => { throw new Error('secret'); } });
  await assert.rejects(failed.issue('id'), (error) => error.status === 502 && !error.message.includes('secret'));
});

test('long-lived key cannot be relayed by a malformed provider response', async () => {
  const provider = createSonioxProvider({ apiKey: 'server-only-test-key', fetchImpl: async () => Response.json({ api_key: 'server-only-test-key' }) });
  await assert.rejects(provider.issue('id'), { status: 502 });
});

test('shared glossary maps to Soniox context without changing translation preferences', () => {
  assert.deepEqual(glossaryToContext({ background: 'Product launch', terms: ['Stage'], translationTerms: [{ source: 'Stage', target: 'ステージ' }] }), {
    text: 'Product launch', terms: ['Stage'], translation_terms: [{ source: 'Stage', target: 'ステージ' }],
  });
  assert.deepEqual(glossaryToContext({ background: '', terms: [], translationTerms: [] }), {});
});

test('configuration validates regional and public origin settings', () => {
  assert.equal(loadConfig({}).publicOrigin, 'http://localhost:4310');
  assert.equal(loadConfig({ SONIOX_REGION: 'JP' }).sonioxRegion, 'jp');
  assert.throws(() => loadConfig({ SONIOX_REGION: 'unknown' }));
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://example.com/path' }));
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://user:pass@example.com' }));
});

test('HTTP origins are allowed only for local development', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4310', 'http://[::1]:4310']) {
    assert.equal(loadConfig({ PUBLIC_ORIGIN: origin }).publicOrigin, origin);
  }
  for (const origin of ['http://stage.example', 'http://192.168.1.5:4310', 'http://0.0.0.0:4310', 'http://localhost.evil.test']) {
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: origin }), /must use HTTPS/);
  }
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'https://stage.example' }).publicOrigin, 'https://stage.example');
});

test('proxy trust defaults off and accepts only exact IP addresses', () => {
  assert.deepEqual(loadConfig({}).trustedProxyIps, []);
  assert.deepEqual(loadConfig({ TRUSTED_PROXY_IPS: ' 127.0.0.1, ::1, 127.0.0.1 ' }).trustedProxyIps, ['127.0.0.1', '::1']);
  for (const value of ['true', '1', '*', 'loopback', 'localhost', '127.0.0.0/8', '10.0.0.1,', 'fe80::1%eth0']) {
    assert.throws(() => loadConfig({ TRUSTED_PROXY_IPS: value }), /exact IPv4 or IPv6/);
  }
});

test('the team token limit defaults to 60 and requires a positive integer', () => {
  assert.equal(loadConfig({}).teamTokenLimitPerMinute, 60);
  assert.equal(loadConfig({ TEAM_TOKEN_LIMIT_PER_MINUTE: '20' }).teamTokenLimitPerMinute, 20);
  for (const value of ['0', '-1', '1.5', 'unlimited', 'Infinity', '9007199254740992']) {
    assert.throws(() => loadConfig({ TEAM_TOKEN_LIMIT_PER_MINUTE: value }), /positive integer/);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { summaryEnvironment } = require('../../electron/summary-config.cjs');

test('owner summary configuration survives a launch without shell environment settings', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-summary-config-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const settings = { STAGE_SUMMARY_RUNTIME: path.join(profile, 'bun'), STAGE_SUMMARY_WORKER: path.join(profile, 'cli.mjs'), STAGE_SUMMARY_MODEL: 'configured-model' };
  await fs.writeFile(path.join(profile, 'summary-worker.json'), JSON.stringify(settings));
  assert.deepEqual(await summaryEnvironment(profile, { HOME: profile }), { HOME: profile, ...settings });
  assert.equal((await summaryEnvironment(profile, { STAGE_SUMMARY_MODEL: 'explicit-override' })).STAGE_SUMMARY_MODEL, 'explicit-override');
});
test('missing, malformed, oversized and credential-bearing config cannot enable a worker', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-summary-invalid-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const env = { HOME: profile };
  assert.deepEqual(await summaryEnvironment(profile, env), env);
  for (const content of ['{', 'null', '[]', JSON.stringify({ STAGE_SUMMARY_MODEL: 123 }), JSON.stringify({ OPENAI_API_KEY: 'not-a-config-field', STAGE_SUMMARY_MODEL: 'anything' }), ' '.repeat(4097)]) {
    await fs.writeFile(path.join(profile, 'summary-worker.json'), content);
    assert.deepEqual(await summaryEnvironment(profile, env), env);
  }
});

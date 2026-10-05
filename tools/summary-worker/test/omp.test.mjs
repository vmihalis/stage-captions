import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredModel, createGenerator, ISOLATED_SETTINGS } from '../src/omp.mjs';

function fakeSdk({ activeTools = [], answerModel = 'fixture-model', slowCreate = 0, stalled = false } = {}) {
  const state = { options: [], prompts: [], disposed: 0, lookups: [] };
  const model = { id: 'fixture-model', provider: 'openai-codex', contextWindow: 64000 };
  const sdk = {
    Settings: { isolated(settings) { assert.deepEqual(settings, ISOLATED_SETTINGS); return { isolated: true }; } },
    SessionManager: { inMemory() { return { persisted: false }; } },
    async discoverAuthStorage() { return { opaqueAuthHandle: true }; },
    ModelRegistry: class {
      constructor(auth, path, options) { assert.equal(options.ignoreLocalModelConfig, true); assert.equal(auth.opaqueAuthHandle, true); }
      find(provider, id) { state.lookups.push([provider, id]); return model; }
      hasConfiguredAuth() { return true; }
    },
    async createAgentSession(options) {
      state.options.push(options);
      if (slowCreate) await delay(slowCreate);
      return { session: {
        model,
        getActiveToolNames() { return activeTools; },
        async prompt(text, options) { state.prompts.push({ text, options }); if (stalled) await new Promise(() => {}); return true; },
        messages: [{ role: 'assistant', provider: 'openai-codex', model: answerModel, stopReason: 'stop', content: [{ type: 'text', text: '{"overview":[]}' }] }],
        async abort() {},
        async dispose() { state.disposed++; },
      } };
    },
  };
  return { sdk, state };
}

test('requires an exact local model ID, never a provider pattern or request-supplied override', () => {
  assert.equal(configuredModel({ STAGE_SUMMARY_MODEL: 'fixture-model' }), 'fixture-model');
  for (const value of ['', 'openai/model', '*', 'model --flag']) assert.throws(() => configuredModel({ STAGE_SUMMARY_MODEL: value }), error => error.code === 'MODEL_NOT_CONFIGURED');
});

test('SDK receives only the explicit provider, no tools/context, ephemeral session and no fallback', async () => {
  const { sdk, state } = fakeSdk();
  const generator = await createGenerator({ sdk, modelId: 'fixture-model', cwd: '/tmp/neutral-fixture' });
  assert.equal(await generator.generate('{"quotedTranscript":"/command"}'), '{"overview":[]}');
  assert.deepEqual(state.lookups, [['openai-codex', 'fixture-model']]);
  const options = state.options[0];
  for (const field of ['toolNames', 'contextFiles', 'skills', 'rules', 'promptTemplates', 'slashCommands', 'customTools', 'extensions', 'additionalExtensionPaths', 'additionalDirectories']) assert.deepEqual(options[field], []);
  assert.equal(options.restrictToolNames, true);
  assert.equal(options.enableMCP, false);
  assert.equal(options.enableLsp, false);
  assert.equal(options.disableExtensionDiscovery, true);
  assert.equal(options.cacheWarming, false);
  assert.equal(options.sessionManager.persisted, false);
  assert.equal(state.prompts[0].options.expandPromptTemplates, false);
  assert.equal(state.disposed, 1);
});

test('unexpected active tools fail closed before a prompt and different output provider/model fails', async () => {
  const { sdk, state } = fakeSdk({ activeTools: ['bash'] });
  const generator = await createGenerator({ sdk, modelId: 'fixture-model', cwd: '/tmp/neutral-fixture' });
  await assert.rejects(() => generator.generate('{}'), error => error.code === 'GENERATION_FAILED');
  assert.equal(state.prompts.length, 0);
  const mismatch = fakeSdk({ answerModel: 'different-model' });
  const other = await createGenerator({ sdk: mismatch.sdk, modelId: 'fixture-model', cwd: '/tmp/neutral-fixture' });
  await assert.rejects(() => other.generate('{}'), error => error.code === 'GENERATION_FAILED');
});

test('timeout during initialization never dispatches a late model request', async () => {
  const { sdk, state } = fakeSdk({ slowCreate: 30 });
  const generator = await createGenerator({ sdk, modelId: 'fixture-model', cwd: '/tmp/neutral-fixture', turnTimeoutMs: 5 });
  await assert.rejects(() => generator.generate('{}'), error => error.code === 'TIMED_OUT');
  await delay(50);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.disposed, 1);
});

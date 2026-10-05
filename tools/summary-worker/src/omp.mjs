import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TURN_MS, SYSTEM_PROMPT, WorkerError, promptBudget } from './core.mjs';

export const OMP_VERSION = '18.6.1';
export function configuredModel(env = process.env) {
  const model = env.STAGE_SUMMARY_MODEL;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) throw new WorkerError('MODEL_NOT_CONFIGURED');
  return model;
}
function runtimeReady(version = process.versions.bun) {
  if (!version) throw new WorkerError('RUNTIME_UNAVAILABLE');
  const [major, minor, patch] = version.split('.').map(Number);
  if (!(major > 1 || major === 1 && (minor > 3 || minor === 3 && patch >= 14))) throw new WorkerError('RUNTIME_UNAVAILABLE');
}
async function checkPackage() {
  try {
    const source = import.meta.resolve('@oh-my-pi/pi-coding-agent/sdk');
    const metadata = JSON.parse(await readFile(new URL('../package.json', source), 'utf8'));
    if (metadata.version !== OMP_VERSION) throw new Error();
    import.meta.resolve('@oh-my-pi/pi-utils/logger');
  } catch { throw new WorkerError('SDK_UNAVAILABLE'); }
}
// Verify the actual dependency graph, including the platform binding. No auth
// store, session or model request is opened by this probe.
export async function readiness() {
  await loadSdk();
  return { ok: true, available: true, provider: 'openai-codex', model: configuredModel(), authenticationChecked: false };
}

export const ISOLATED_SETTINGS = Object.freeze({
  'advisor.enabled': false,
  'autolearn.enabled': false,
  'memories.enabled': false,
  'telemetry.otlpExportEnabled': false,
  'secrets.enabled': false,
  'compaction.enabled': false,
  'compaction.midTurnEnabled': false,
  'retry.enabled': false,
  'retry.modelFallback': false,
  'retry.fallbackChains': {},
  'providers.openaiWebsockets': 'off',
  includeWorkspaceTree: false,
  'tools.format': 'native',
});

export function sessionOptions(sdk, { cwd, settings, authStorage, modelRegistry, model, deadline }) {
  return {
    cwd, settings, authStorage, modelRegistry, model, deadline,
    rebindModelAfterDiscovery: false,
    sessionManager: sdk.SessionManager.inMemory(),
    systemPrompt: SYSTEM_PROMPT,
    thinkingLevel: 'low', thinkingLevelCeiling: 'low',
    toolNames: [], restrictToolNames: true, requireYieldTool: false,
    enableMCP: false, enableLsp: false, enableIrc: false,
    skipPythonPreflight: true, disableExtensionDiscovery: true,
    contextFiles: [], skills: [], rules: [], promptTemplates: [], slashCommands: [],
    customTools: [], extensions: [], additionalExtensionPaths: [], additionalDirectories: [],
    workspaceTree: { rootPath: cwd, rendered: '', truncated: false, totalLines: 0, agentsMdFiles: [] },
    cacheWarming: false, hasUI: false, interactivePrompts: false,
    spawns: '', inheritedSessionAgents: [],
  };
}

export async function loadSdk() {
  runtimeReady(); await checkPackage(); configuredModel();
  try {
    // Configure OMP's supported logger before importing the agent engine. Never
    // persist transcript/provider diagnostics or echo an underlying SDK error.
    const logger = await import('@oh-my-pi/pi-utils/logger');
    logger.setTransports({ console: false, file: false });
    return await import('@oh-my-pi/pi-coding-agent');
  } catch { throw new WorkerError('SDK_UNAVAILABLE'); }
}

export async function createGenerator({ sdk, modelId, cwd, now = Date.now, turnTimeoutMs = MAX_TURN_MS }) {
  const settings = sdk.Settings.isolated(ISOLATED_SETTINGS);
  let authStorage;
  try { authStorage = await sdk.discoverAuthStorage(undefined, { cwd }); }
  catch { throw new WorkerError('AUTH_UNAVAILABLE'); }
  // Use the bundled catalog. No ambient models.yml, configured endpoint/key,
  // extension provider or fuzzy model match participates in summary requests.
  const modelRegistry = new sdk.ModelRegistry(authStorage, undefined, { settings, ignoreLocalModelConfig: true });
  const model = modelRegistry.find('openai-codex', modelId);
  if (!model || model.provider !== 'openai-codex' || model.id !== modelId) throw new WorkerError('MODEL_UNAVAILABLE');
  if (!modelRegistry.hasConfiguredAuth(model)) throw new WorkerError('AUTH_UNAVAILABLE');
  promptBudget(model.contextWindow);

  return {
    modelId: model.id, contextWindow: model.contextWindow,
    dispose() { authStorage.close?.(); },
    async generate(prompt, { signal } = {}) {
      if (signal?.aborted) throw new WorkerError('CANCELLED');
      let session; let timer; let timedOut = false;
      const abort = () => { void session?.abort().catch(() => {}); };
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; abort(); reject(new WorkerError('TIMED_OUT')); }, turnTimeoutMs);
        });
        const work = async () => {
          const result = await sdk.createAgentSession(sessionOptions(sdk, {
            cwd, settings, authStorage, modelRegistry, model, deadline: now() + turnTimeoutMs,
          }));
          session = result.session;
          if (timedOut) { await session.dispose().catch(() => {}); throw new WorkerError('TIMED_OUT'); }
          if (signal?.aborted) throw new WorkerError('CANCELLED');
          if (session.model?.provider !== 'openai-codex' || session.model?.id !== modelId || session.getActiveToolNames().length !== 0) {
            throw new WorkerError('GENERATION_FAILED');
          }
          const dispatched = await session.prompt(prompt, { expandPromptTemplates: false, throwOnDrop: true });
          if (!dispatched) throw new WorkerError('GENERATION_FAILED');
          const answer = session.messages.filter(message => message.role === 'assistant').at(-1);
          if (!answer || answer.stopReason !== 'stop' || answer.provider !== 'openai-codex' || answer.model !== modelId ||
              answer.content.some(part => !['text', 'thinking', 'redactedThinking'].includes(part.type))) {
            throw new WorkerError('GENERATION_FAILED');
          }
          return answer.content.filter(part => part.type === 'text').map(part => part.text).join('');
        };
        signal?.addEventListener('abort', abort, { once: true });
        return await Promise.race([work(), timeout]);
      } catch (error) { throw error instanceof WorkerError ? error : new WorkerError('GENERATION_FAILED'); }
      finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        // The CLI also has a hard process deadline in case a provider's cleanup
        // cannot complete. Never return a partial assistant message on timeout.
        if (session) await session.dispose().catch(() => {});
      }
    },
  };
}

export async function withLocalGenerator(action) {
  process.env.PI_NO_TITLE = '1';
  const sdk = await loadSdk();
  const cwd = await mkdtemp(join(tmpdir(), 'stage-summary-'));
  let generator;
  try {
    generator = await createGenerator({ sdk, modelId: configuredModel(), cwd });
    return await action(generator);
  } finally {
    try { generator?.dispose(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  }
}

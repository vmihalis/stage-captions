const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_INPUT = 20 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const failure = (code, message) => ({ ok: false, error: { code, message, recoverable: true } });
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid object.');
}
const text = (value, max) => typeof value === 'string' && value.length <= max;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && UUID.test(value);

function validateExport(value) {
  object(value, ['meeting', 'entries', 'bookmarks']);
  const { meeting, entries, bookmarks } = value;
  object(meeting, ['id', 'title', 'mode', 'status', 'startedAt', 'endedAt', 'updatedAt', 'entryCount', 'bookmarkCount']);
  if (!id(meeting.id) || !text(meeting.title, 160) || !['auto', 'en_to_ja', 'ja_to_en'].includes(meeting.mode)
    || !['recording', 'ended', 'interrupted'].includes(meeting.status) || !integer(meeting.startedAt)
    || !integer(meeting.updatedAt) || !(meeting.endedAt === null || integer(meeting.endedAt))
    || !Array.isArray(entries) || !Array.isArray(bookmarks) || entries.length !== meeting.entryCount
    || bookmarks.length !== meeting.bookmarkCount || entries.length > 100_000 || bookmarks.length > 100_000) throw new Error('Invalid meeting.');
  let bytes = Buffer.byteLength(JSON.stringify(meeting), 'utf8');
  const entryIds = new Set();
  for (const [index, entry] of entries.entries()) {
    object(entry, ['id', 'sequence', 'kind', 'language', 'text', 'receivedAt', 'segment']);
    if (!id(entry.id) || entryIds.has(entry.id) || entry.sequence !== index + 1
      || !['source', 'translation'].includes(entry.kind) || !['en', 'ja', 'unknown'].includes(entry.language)
      || !text(entry.text, 16_000) || !entry.text.length || !integer(entry.receivedAt)
      || !(entry.segment === undefined || integer(entry.segment))) throw new Error('Invalid transcript.');
    bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (bytes > MAX_INPUT) throw new Error('Meeting too large.');
    entryIds.add(entry.id);
  }
  const bookmarkIds = new Set();
  for (const bookmark of bookmarks) {
    object(bookmark, ['id', 'entryId', 'createdAt', 'label']);
    if (!id(bookmark.id) || bookmarkIds.has(bookmark.id) || !integer(bookmark.createdAt)
      || !text(bookmark.label, 160) || !(bookmark.entryId == null || entryIds.has(bookmark.entryId))) throw new Error('Invalid bookmark.');
    bytes += Buffer.byteLength(JSON.stringify(bookmark), 'utf8');
    if (bytes > MAX_INPUT) throw new Error('Meeting too large.');
    bookmarkIds.add(bookmark.id);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_INPUT) throw new Error('Meeting too large.');
  return { json, entryIds, entryCount: entries.length };
}

const workerErrors = new Set(['INVALID_REQUEST', 'INPUT_TOO_LARGE', 'NO_TRANSCRIPT', 'INCOMPLETE_TRANSCRIPT',
  'RUNTIME_UNAVAILABLE', 'SDK_UNAVAILABLE', 'MODEL_NOT_CONFIGURED', 'MODEL_UNAVAILABLE', 'AUTH_UNAVAILABLE',
  'CONTEXT_UNSUPPORTED', 'INVALID_SUMMARY', 'SUMMARY_TOO_LARGE', 'GENERATION_FAILED', 'TIMED_OUT', 'CANCELLED']);
function validateResult(value, input) {
  if (value?.ok === false && workerErrors.has(value.error?.code)) {
    const code = value.error.code;
    return failure(code, code === 'AUTH_UNAVAILABLE'
      ? 'The local summary worker needs an existing owner login. Check its local setup, then try again.'
      : 'The local summary worker could not finish. Check its local setup or export the transcript and try again.');
  }
  if (value?.ok !== true || !value.summary || value.meta?.provider !== 'openai-codex') throw new Error('Invalid response.');
  const summary = {};
  for (const key of ['overview', 'decisions', 'actions', 'openQuestions']) {
    if (!Array.isArray(value.summary[key]) || value.summary[key].length > 1000) throw new Error('Invalid summary.');
    summary[key] = value.summary[key].map(item => {
      if (!text(item?.text, 16_000) || !item.text.trim() || !Array.isArray(item.evidenceEntryIds)
        || !item.evidenceEntryIds.length || item.evidenceEntryIds.length > input.entryCount
        || item.evidenceEntryIds.some(entryId => !input.entryIds.has(entryId))) throw new Error('Invalid evidence.');
      const claim = { text: item.text, evidenceEntryIds: item.evidenceEntryIds };
      if (key === 'actions') {
        if (!(item.assignee === null || text(item.assignee, 300)) || !(item.dueDate === null || text(item.dueDate, 300))) throw new Error('Invalid action.');
        claim.assignee = item.assignee; claim.dueDate = item.dueDate;
      }
      return claim;
    });
  }
  const meta = value.meta;
  if (!text(meta.model, 200) || meta.entryCount !== input.entryCount || !integer(meta.chunkCount)
    || !integer(meta.generatedAt) || meta.generatedAt > 8_640_000_000_000_000) throw new Error('Invalid metadata.');
  const safeMeta = { provider: 'openai-codex', model: meta.model, entryCount: meta.entryCount, chunkCount: meta.chunkCount, generatedAt: meta.generatedAt };
  for (const key of ['modelRequests', 'reductionRounds']) if (integer(meta[key])) safeMeta[key] = meta[key];
  if (typeof meta.inputDigest === 'string' && /^[a-f0-9]{64}$/.test(meta.inputDigest)) safeMeta.inputDigest = meta.inputDigest;
  return { ok: true, summary, meta: safeMeta };
}

function createSummaryRunner({ env = process.env, spawnProcess = spawn, timeoutMs = 600_000 } = {}) {
  const worker = env.STAGE_SUMMARY_WORKER;
  const runtime = env.STAGE_SUMMARY_RUNTIME;
  let available = false;
  try {
    available = typeof worker === 'string' && path.isAbsolute(worker) && worker.endsWith('.mjs')
      && typeof runtime === 'string' && path.isAbsolute(runtime) && /^bun(?:\.exe)?$/.test(path.basename(runtime))
      && fs.statSync(worker).isFile() && fs.statSync(runtime).isFile();
    if (available) fs.accessSync(runtime, fs.constants.X_OK);
  } catch { available = false; }
  let active;
  function cancel() { active?.cancel(); }
  return {
    available,
    cancel,
    async run(value) {
      if (!available) return failure('RUNTIME_UNAVAILABLE', 'Configure the local summary worker and Bun runtime to summarize on this computer.');
      if (active) return failure('BUSY', 'A meeting summary is already running. Wait or cancel it first.');
      let input;
      try { input = validateExport(value); }
      catch { return failure('INVALID_REQUEST', 'Provide the complete meeting export, up to 20 MB, with every saved entry.'); }
      if (!input.entryCount) return failure('NO_TRANSCRIPT', 'This meeting has no saved transcript to summarize.');
      return new Promise(resolve => {
        let child;
        let timer;
        let bytes = 0;
        let done = false;
        const chunks = [];
        const finish = result => {
          if (done) return;
          done = true; clearTimeout(timer); active = undefined;
          resolve(result);
        };
        const stop = (code, message) => {
          if (done) return;
          finish(failure(code, message));
          try { child?.kill('SIGKILL'); } catch { /* The worker may have already exited. */ }
        };
        active = { cancel: () => stop('CANCELLED', 'The summary was cancelled. Your transcript is still saved.') };
        try {
          // Only local configuration chooses code or runtime. No shell, remote
          // executable paths, inherited API keys, or auth files enter the bridge.
          const workerEnv = { HOME: env.HOME || '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
          if (env.TMPDIR) workerEnv.TMPDIR = env.TMPDIR;
          if (env.STAGE_SUMMARY_MODEL) workerEnv.STAGE_SUMMARY_MODEL = env.STAGE_SUMMARY_MODEL;
          child = spawnProcess(runtime, [worker], { cwd: path.dirname(worker), env: workerEnv,
            shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
          timer = setTimeout(() => stop('TIMED_OUT', 'The summary reached its time limit. Your transcript is still saved.'), Math.min(600_000, Math.max(1, timeoutMs)));
          child.on('error', () => finish(failure('RUNTIME_UNAVAILABLE', 'Could not start the configured local summary worker.')));
          child.stdout.on('data', chunk => {
            if (done) return;
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT) { stop('SUMMARY_TOO_LARGE', 'The summary exceeded its output limit. Your transcript is still saved.'); return; }
            chunks.push(Buffer.from(chunk));
          });
          child.on('close', code => {
            if (done) return;
            try {
              const result = validateResult(JSON.parse(Buffer.concat(chunks).toString('utf8')), input);
              if (code !== 0 && result.ok) throw new Error('Unsuccessful exit.');
              finish(result);
            } catch { finish(failure('INVALID_SUMMARY', 'The worker returned an incomplete or invalid summary. Your transcript is still saved.')); }
          });
          child.stdin.on('error', () => stop('GENERATION_FAILED', 'The local summary worker stopped before receiving the transcript.'));
          child.stdin.end(input.json);
        } catch { stop('RUNTIME_UNAVAILABLE', 'Could not start the configured local summary worker.'); }
      });
    },
  };
}

module.exports = { createSummaryRunner, validateExport, validateResult };

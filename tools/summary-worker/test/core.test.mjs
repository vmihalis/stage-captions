import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { byteLength, failure, mapPrompt, promptBudget, summarize, transcriptChunks, validateRequest, validateSummary } from '../src/core.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(count = 3) {
  return {
    meeting: { id: id(0), title: 'Stage team sync', mode: 'auto', status: 'ended', startedAt: 1000, endedAt: 2000, updatedAt: 2000, entryCount: count, bookmarkCount: 1 },
    entries: Array.from({ length: count }, (_, i) => ({ id: id(i + 1), sequence: i + 1, kind: i % 2 ? 'translation' : 'source', language: i % 2 ? 'ja' : 'en', text: `Caption ${i + 1}`, receivedAt: 1000 + i })),
    bookmarks: [{ id: id(999999), entryId: id(1), createdAt: 1100, label: 'Decision' }],
  };
}
const emptySummary = () => ({ overview: [], decisions: [], actions: [], openQuestions: [] });
function summary(ids) { return { ...emptySummary(), overview: [{ text: 'The team discussed the launch.', evidenceEntryIds: ids }] }; }
const code = expected => error => error.code === expected;

test('requires complete ordered pages and includes translations without mutation', () => {
  const request = fixture(); const original = structuredClone(request);
  assert.equal(validateRequest(request), request);
  assert.deepEqual(request, original);
  assert.throws(() => validateRequest({ ...request, entries: request.entries.slice(0, -1) }), code('INCOMPLETE_TRANSCRIPT'));
  const missingSequence = structuredClone(request); missingSequence.entries[1].sequence = 3;
  assert.throws(() => validateRequest(missingSequence), code('INCOMPLETE_TRANSCRIPT'));
  const duplicate = structuredClone(request); duplicate.entries[1].id = duplicate.entries[0].id;
  assert.throws(() => validateRequest(duplicate), code('INVALID_REQUEST'));
  const missingBookmark = structuredClone(request); missingBookmark.bookmarks = [];
  assert.throws(() => validateRequest(missingBookmark), code('INCOMPLETE_TRANSCRIPT'));
});

test('unknown fields and cross-meeting bookmarks are rejected before model work', () => {
  const injected = { ...fixture(), model: 'another-provider' };
  assert.throws(() => validateRequest(injected), code('INVALID_REQUEST'));
  const request = fixture(); request.bookmarks[0].entryId = id(500);
  assert.throws(() => validateRequest(request), code('INVALID_REQUEST'));
});

test('preserves whitespace-only finalized entries and rejects an entirely blank transcript', () => {
  const request = fixture(); request.entries[1].text = ' \n\t';
  assert.equal(validateRequest(request).entries[1].text, ' \n\t');
  request.entries.forEach(entry => { entry.text = ' '; });
  assert.throws(() => validateRequest(request), code('NO_TRANSCRIPT'));
});

test('Unicode and escaped large entries are split losslessly within full prompt budget', () => {
  const request = fixture(5);
  request.entries[0].text = '日本語🙂"\\\n'.repeat(1500);
  request.entries[1].text = '終'.repeat(16000);
  request.entries[4].text = 'Important final commitment';
  validateRequest(request);
  const budget = 12_000;
  const chunks = transcriptChunks(request, budget);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) assert.ok(byteLength(mapPrompt(request.meeting, chunk)) <= budget);
  const records = chunks.flat();
  for (const entry of request.entries) {
    const pieces = records.filter(row => row.type === 'entry' && row.id === entry.id);
    assert.equal(pieces.map(row => row.text).join(''), entry.text);
    if (pieces.length > 1) assert.deepEqual(pieces.map(row => row.part.index), pieces.map((_, i) => i + 1));
  }
  assert.deepEqual(records.filter(row => row.type === 'bookmark').map(({ type, ...row }) => row), request.bookmarks);
});

test('output validation rejects fabricated citations, executable-looking fields and missing uncertainty', () => {
  const ids = new Set([id(1)]);
  assert.deepEqual(validateSummary(JSON.stringify(summary([id(1)])), ids), summary([id(1)]));
  assert.throws(() => validateSummary(JSON.stringify(summary([id(2)])), ids), code('INVALID_SUMMARY'));
  assert.throws(() => validateSummary(JSON.stringify(summary([])), ids), code('INVALID_SUMMARY'));
  assert.throws(() => validateSummary('```json\n{}\n```', ids), code('INVALID_SUMMARY'));
  assert.throws(() => validateSummary(JSON.stringify({ ...summary([id(1)]), command: 'run this' }), ids), code('INVALID_SUMMARY'));
  const action = { ...emptySummary(), actions: [{ text: 'Prepare slides', evidenceEntryIds: [id(1)] }] };
  assert.throws(() => validateSummary(JSON.stringify(action), ids), code('INVALID_SUMMARY'));
  action.actions[0].assignee = null; action.actions[0].dueDate = null;
  assert.deepEqual(validateSummary(JSON.stringify(action), ids), action);
});

test('map/reduce visits every caption, validates each scope, and reports all exported entries', async () => {
  const request = fixture(100);
  request.entries.forEach(entry => { entry.text = `Entry ${entry.sequence}: ${'あ'.repeat(1000)}`; });
  const seen = []; const calls = [];
  const generator = {
    contextWindow: 40_000, modelId: 'test-model',
    async generate(prompt) {
      const data = JSON.parse(prompt); calls.push(data);
      assert.ok(byteLength(prompt) <= promptBudget(this.contextWindow));
      if (data.task === 'summarize_transcript') {
        const entries = data.records.filter(row => row.type === 'entry');
        seen.push(...entries.map(entry => entry.id));
        return JSON.stringify(entries.length ? summary([entries[0].id]) : emptySummary());
      }
      return JSON.stringify(summary(data.summaries.flatMap(item => item.overview.flatMap(row => row.evidenceEntryIds)).slice(0, 32)));
    },
  };
  const result = await summarize(request, generator);
  assert.equal(result.ok, true);
  assert.deepEqual(seen, request.entries.map(entry => entry.id));
  assert.equal(result.meta.entryCount, 100);
  assert.equal(result.meta.modelRequests, calls.length);
  assert.ok(result.meta.chunkCount > 1);
  assert.ok(calls.some(call => call.task === 'merge_summaries'));
  assert.match(result.meta.inputDigest, /^[a-f0-9]{64}$/);
});

test('one failed chunk fails the whole operation without publishing earlier summaries', async () => {
  const request = fixture(3); request.entries.forEach(entry => { entry.text = 'あ'.repeat(10000); });
  let calls = 0;
  await assert.rejects(() => summarize(request, {
    contextWindow: 40_000, modelId: 'test-model',
    async generate(prompt) {
      if (++calls === 2) return JSON.stringify(summary([id(999)]));
      return JSON.stringify(summary([JSON.parse(prompt).records[0].id]));
    },
  }), code('INVALID_SUMMARY'));
  assert.equal(calls, 2);
});

test('large intermediate summaries use multiple bounded merge rounds', async () => {
  const request = fixture(40);
  request.entries.forEach(entry => { entry.text = 'あ'.repeat(10000); });
  let mergeCalls = 0;
  const result = await summarize(request, {
    contextWindow: 40_000, modelId: 'fixture-model',
    async generate(prompt) {
      const data = JSON.parse(prompt);
      const evidence = data.task === 'summarize_transcript'
        ? data.records.find(row => row.type === 'entry')?.id
        : data.summaries.flatMap(item => item.overview).at(0)?.evidenceEntryIds[0];
      if (data.task === 'merge_summaries') mergeCalls++;
      return JSON.stringify({ ...emptySummary(), overview: evidence ? Array.from({ length: 9 }, () => ({ text: 'a'.repeat(580), evidenceEntryIds: [evidence] })) : [] });
    },
  });
  assert.ok(result.meta.reductionRounds > 1);
  assert.ok(mergeCalls > 1);
  assert.equal(result.meta.entryCount, request.entries.length);
});

test('unknown SDK failures are sanitized and cancellation prevents work', async () => {
  assert.equal(JSON.stringify(failure(new Error('private transcript and secret'))).includes('private'), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => summarize(fixture(), { contextWindow: 64000, generate() { assert.fail(); } }, { signal: controller.signal }), code('CANCELLED'));
});

test('CLI malformed input yields exactly one safe JSON response without SDK or auth', () => {
  const script = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { input: '{bad json', encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_REQUEST');
  const probe = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(probe.status, 0);
  assert.equal(JSON.parse(probe.stdout).error.code, 'RUNTIME_UNAVAILABLE');
});

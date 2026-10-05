const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSummaryRunner, validateExport } = require('../../electron/summary.cjs');

const meetingId = '12345678-1234-1234-1234-123456789000';
const entryId = '12345678-1234-1234-1234-123456789001';
const data = {
  meeting: { id: meetingId, title: 'Demo', mode: 'auto', status: 'ended', startedAt: 10, endedAt: 20, updatedAt: 20, entryCount: 1, bookmarkCount: 0 },
  entries: [{ id: entryId, sequence: 1, kind: 'source', language: 'en', text: 'Ship the preview after review.', receivedAt: 15 }],
  bookmarks: [],
};
const success = {
  ok: true,
  summary: { overview: [{ text: 'Preview review comes before shipping.', evidenceEntryIds: [entryId] }], decisions: [], actions: [], openQuestions: [] },
  meta: { provider: 'openai-codex', model: 'configured-model', entryCount: 1, chunkCount: 1, generatedAt: Date.parse('2026-10-05T00:00:00Z') },
};
function fixture(t, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-summary-unit-'));
  const runtime = path.join(dir, 'bun');
  const worker = path.join(dir, 'worker.mjs');
  fs.writeFileSync(runtime, '', { mode: 0o700 });
  fs.writeFileSync(worker, '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let child;
  let invocation;
  const runner = createSummaryRunner({ timeoutMs,
    env: { STAGE_SUMMARY_RUNTIME: runtime, STAGE_SUMMARY_WORKER: worker, HOME: '/owner/home',
      OPENAI_API_KEY: 'must-never-reach-worker', NODE_OPTIONS: '--require unwanted', STAGE_SUMMARY_MODEL: 'configured-model' },
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
      child.kill = signal => { child.signal = signal; child.emit('close', null); };
      return child;
    },
  });
  return { runner, get child() { return child; }, get invocation() { return invocation; },
    complete(value, exit = 0) { child.stdout.write(JSON.stringify(value)); child.emit('close', exit); } };
}

test('complete export validation rejects omitted, duplicate, out-of-order, unknown and cross-meeting content', () => {
  assert.equal(validateExport(data).entryCount, 1);
  for (const invalid of [
    { ...data, entries: [] },
    { ...data, entries: [{ ...data.entries[0], sequence: 2 }] },
    { ...data, entries: [{ ...data.entries[0], arbitraryPath: '/tmp/secret' }] },
    { ...data, meeting: { ...data.meeting, entryCount: 2 }, entries: [data.entries[0], { ...data.entries[0], sequence: 2 }] },
    { ...data, meeting: { ...data.meeting, bookmarkCount: 1 }, bookmarks: [{ id: meetingId, entryId: meetingId, createdAt: 15, label: 'Wrong meeting' }] },
  ]) assert.throws(() => validateExport(invalid));
});

test('complete transcript input preserves finalized whitespace tokens verbatim', () => {
  const spaced = { ...data, entries: [{ ...data.entries[0], text: ' ' }] };
  assert.deepEqual(JSON.parse(validateExport(spaced).json), spaced);
  assert.throws(() => validateExport({ ...data, entries: [{ ...data.entries[0], text: '' }] }));
});

test('local worker receives bounded validated stdin without inherited credentials or shell execution', async t => {
  const f = fixture(t);
  assert.equal(f.runner.available, true);
  const pending = f.runner.run(data);
  assert.equal(f.invocation.options.shell, false);
  assert.equal(f.invocation.args.length, 1);
  assert.equal(f.invocation.options.stdio[2], 'ignore');
  assert.equal(f.invocation.options.env.OPENAI_API_KEY, undefined);
  assert.equal(f.invocation.options.env.NODE_OPTIONS, undefined);
  assert.equal(f.invocation.options.env.HOME, '/owner/home');
  assert.deepEqual(JSON.parse(f.child.stdin.read().toString()), data);
  const busy = await f.runner.run(data);
  assert.equal(busy.error.code, 'BUSY');
  f.complete({ ...success, meta: { ...success.meta, auth: 'never-return-this' } });
  assert.deepEqual(await pending, success);
});

test('cancellation and timeout kill the worker and return recoverable failures', async t => {
  const f = fixture(t);
  const pending = f.runner.run(data);
  f.runner.cancel();
  assert.equal((await pending).error.code, 'CANCELLED');
  assert.equal(f.child.signal, 'SIGKILL');
  const slow = fixture(t, 5);
  assert.equal((await slow.runner.run(data)).error.code, 'TIMED_OUT');
  assert.equal(slow.child.signal, 'SIGKILL');
});

test('excess output, invalid evidence, failed exit and raw worker errors never become a successful summary', async t => {
  const f = fixture(t);
  let pending = f.runner.run(data);
  f.child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await pending).error.code, 'SUMMARY_TOO_LARGE');
  assert.equal(f.child.signal, 'SIGKILL');
  pending = f.runner.run(data);
  f.complete({ ...success, summary: { ...success.summary, overview: [{ text: 'Invented', evidenceEntryIds: [meetingId] }] } });
  assert.equal((await pending).error.code, 'INVALID_SUMMARY');
  pending = f.runner.run(data);
  f.complete(success, 1);
  assert.equal((await pending).error.code, 'INVALID_SUMMARY');
  pending = f.runner.run(data);
  f.complete({ ok: false, error: { code: 'AUTH_UNAVAILABLE', message: 'sensitive raw stderr' } }, 1);
  const result = await pending;
  assert.equal(result.error.code, 'AUTH_UNAVAILABLE');
  assert.equal(result.error.recoverable, true);
  assert.doesNotMatch(result.error.message, /sensitive raw stderr/);
});

test('no local worker configuration is a recoverable unsupported capability', async () => {
  const runner = createSummaryRunner({ env: {} });
  assert.equal(runner.available, false);
  assert.equal((await runner.run(data)).error.code, 'RUNTIME_UNAVAILABLE');
});

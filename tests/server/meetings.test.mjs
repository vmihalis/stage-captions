import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.mjs';

const CODE = 'shared-meeting-test-code-123456';
const ORIGIN = 'https://stage.test';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stage-meetings-'));
  const config = { databasePath: join(root, 'stage.db'), publicOrigin: ORIGIN, distPath: join(root, 'dist'), teamAccessCode: CODE, sonioxApiKey: '', sonioxRegion: 'global' };
  let app;
  let server;
  let base;
  async function open() {
    app = createApp({ config });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    app.locals.store.close();
  }
  await open();
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  function client() {
    let cookie;
    return {
      async call(path, { method = 'GET', body, origin = ORIGIN } = {}) {
        const headers = {};
        if (origin !== null) headers.Origin = origin;
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        return { status: response.status, body: await response.json(), headers: response.headers };
      },
      async unlock() { return this.call('/api/auth/unlock', { method: 'POST', body: { code: CODE } }); },
    };
  }
  return { client, config, restart: async () => { await close(); await open(); } };
}

const newMeeting = (extra = {}) => ({ id: randomUUID(), title: 'Team meeting', mode: 'auto', startedAt: 1_800_000_000_000, ...extra });
const entry = (extra = {}) => ({ id: randomUUID(), kind: 'source', language: 'en', text: 'Hello team.', receivedAt: 1_800_000_000_100, ...extra });
const batch = entries => ({ batchId: randomUUID(), entries });
const path = meeting => `/api/meetings/${meeting.id}`;
async function create(client, meeting = newMeeting()) {
  const result = await client.call('/api/meetings', { method: 'POST', body: meeting });
  assert.equal(result.status, 200);
  return result.body.meeting;
}
async function append(client, meeting, payload) { return client.call(`${path(meeting)}/entries`, { method: 'POST', body: payload }); }

test('meeting reads and mutations require a session; origin protections cover every route', async t => {
  const fx = await fixture(t);
  const guest = fx.client();
  const signedIn = fx.client();
  await signedIn.unlock();
  const meeting = await create(signedIn);
  const routes = [
    ['/api/meetings', {}], ['/api/meetings', { method: 'POST', body: newMeeting() }],
    [path(meeting), {}], [`${path(meeting)}/export`, {}],
    [path(meeting), { method: 'PATCH', body: { title: 'Changed' } }],
    [`${path(meeting)}/entries`, { method: 'POST', body: batch([entry()]) }],
    [`${path(meeting)}/bookmarks`, { method: 'POST', body: { id: randomUUID() } }],
    [`${path(meeting)}/end`, { method: 'POST', body: { status: 'ended' } }],
  ];
  for (const [route, options] of routes) {
    assert.equal((await guest.call(route, options)).status, 401, route);
    assert.equal((await signedIn.call(route, { ...options, origin: 'https://foreign.test' })).status, 403, route);
    if (options.method) assert.equal((await signedIn.call(route, { ...options, origin: null })).status, 403, route);
  }
  const read = await signedIn.call(path(meeting), { origin: null });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal((await signedIn.call(`/api/meetings/${randomUUID()}`)).status, 404);
});

test('all code holders share meetings; creation replay is safe through rename and preserves team data', async t => {
  const fx = await fixture(t);
  const first = fx.client();
  const second = fx.client();
  await first.unlock();
  await second.unlock();
  await first.call('/api/team', { method: 'PATCH', body: { name: 'Shared team', glossary: { terms: ['Stage'], translationTerms: [], background: 'Meeting context' } } });
  const input = newMeeting();
  const meeting = await create(first, input);
  assert.equal(meeting.status, 'recording');
  assert.equal(meeting.entryCount, 0);
  assert.equal((await second.call('/api/meetings')).body.meetings[0].id, meeting.id);
  assert.deepEqual((await second.call(path(meeting))).body.meeting, meeting);
  const renamed = await second.call(path(meeting), { method: 'PATCH', body: { title: ' Planning session ' } });
  assert.equal(renamed.body.meeting.title, 'Planning session');
  assert.equal((await create(first, input)).title, 'Planning session');
  assert.equal((await first.call('/api/meetings', { method: 'POST', body: { ...input, mode: 'ja_to_en' } })).status, 409);
  assert.equal((await second.call('/api/meetings')).body.meetings.length, 1);
  assert.equal((await second.call('/api/team')).body.glossary.background, 'Meeting context');
});

test('source and translation append independently in arrival order and retry acknowledgments stay stable', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const meeting = await create(client);
  const source = entry({ text: '  A sentence.\nAnother sentence. ', segment: 0 });
  const translation = entry({ kind: 'translation', language: 'ja', text: '  翻訳です。\n', segment: 0 });
  const first = batch([source]);
  assert.deepEqual((await append(client, meeting, first)).body, { acknowledgedThrough: 1, entryCount: 1 });
  assert.deepEqual((await append(client, meeting, batch([translation]))).body, { acknowledgedThrough: 2, entryCount: 2 });
  assert.deepEqual((await append(client, meeting, first)).body, { acknowledgedThrough: 1, entryCount: 2 });
  const changed = { ...first, entries: [{ ...source, text: 'Changed words' }] };
  assert.equal((await append(client, meeting, changed)).status, 409);
  assert.equal((await append(client, meeting, batch([source]))).status, 409);
  const read = (await client.call(path(meeting))).body;
  assert.deepEqual(read.entries, [{ ...source, sequence: 1 }, { ...translation, sequence: 2 }]);
  assert.equal(read.meeting.entryCount, 2);
});

test('batch validation and conflicts are atomic, IDs are scoped safely, and JSON size is bounded', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const meeting = await create(client);
  const other = await create(client);
  const saved = entry();
  await append(client, other, batch([saved]));
  const valid = entry();
  const invalidBatches = [
    batch([valid, entry({ language: 'fr' })]),
    batch([valid, entry({ kind: 'partial' })]),
    batch([valid, entry({ text: '' })]),
    batch([valid, entry({ receivedAt: -1 })]),
    batch([valid, entry({ unexpected: 'field' })]),
    batch([valid, entry({ segment: 0.5 })]),
    batch([valid, valid]), batch([]), batch(Array.from({ length: 101 }, () => entry())),
    { ...batch([valid]), extra: true },
  ];
  for (const payload of invalidBatches) assert.equal((await append(client, meeting, payload)).status, 400);
  assert.equal((await append(client, meeting, batch([valid, saved]))).status, 409);
  assert.equal((await client.call(path(meeting))).body.meeting.entryCount, 0);
  const oversize = batch([entry({ text: 'x'.repeat(16_000) }), entry({ text: 'x'.repeat(16_000) }), entry({ text: 'x'.repeat(16_000) }), entry({ text: 'x'.repeat(1_000) })]);
  assert.equal((await append(client, meeting, oversize)).status, 413);
  assert.equal((await client.call(path(meeting))).body.entries.length, 0);
  assert.equal((await append(client, meeting, batch([valid]))).body.acknowledgedThrough, 1);
  assert.equal((await client.call(`${path(meeting)}?after=-1`)).status, 400);
  assert.equal((await client.call(`${path(meeting)}?limit=501`)).status, 400);
  assert.equal((await client.call(`${path(meeting)}?limit=1&limit=2`)).status, 400);
  assert.equal((await client.call('/api/meetings?before=broken')).status, 400);
  assert.equal((await client.call('/api/meetings', { method: 'POST', body: newMeeting({ extra: 'field' }) })).status, 400);
});

test('standalone finalized whitespace survives saving and export without blocking later words', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const meeting = await create(client);
  const pieces = ['Hello', ' ', 'team', '\n', '\t', 'Next paragraph.'];
  for (const piece of pieces) assert.equal((await append(client, meeting, batch([entry({ text: piece })]))).status, 200);
  const saved = (await client.call(`${path(meeting)}/export`)).body;
  assert.deepEqual(saved.entries.map(item => item.text), pieces);
  assert.equal(saved.entries.map(item => item.text).join(''), pieces.join(''));
  assert.equal((await append(client, meeting, batch([entry({ text: '' })]))).status, 400);
  assert.equal((await client.call(path(meeting))).body.meeting.entryCount, pieces.length);
});

test('storage failure rolls back entries, counts, and batch acknowledgment together', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const meeting = await create(client);
  const db = new DatabaseSync(fx.config.databasePath);
  db.exec("CREATE TRIGGER fail_meeting_entry BEFORE INSERT ON meeting_entries WHEN NEW.text = 'storage-failure-fixture' BEGIN SELECT RAISE(ABORT, 'fixture error'); END");
  const payload = batch([entry(), entry({ text: 'storage-failure-fixture' })]);
  const result = await append(client, meeting, payload);
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result.body).includes('storage-failure-fixture'), false);
  assert.equal((await client.call(path(meeting))).body.entries.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meeting_batches').get().count, 0);
  db.exec('DROP TRIGGER fail_meeting_entry');
  db.close();
  assert.equal((await append(client, meeting, payload)).body.acknowledgedThrough, 2);
});

test('marked moments persist once, reference only entries in their meeting, and remain available after ending', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const meeting = await create(client);
  const other = await create(client);
  const ownEntry = entry();
  const otherEntry = entry();
  await append(client, meeting, batch([ownEntry]));
  await append(client, other, batch([otherEntry]));
  const mark = { id: randomUUID(), entryId: ownEntry.id, label: 'Decision', createdAt: 1_800_000_000_500 };
  const route = `${path(meeting)}/bookmarks`;
  const saved = await client.call(route, { method: 'POST', body: mark });
  assert.deepEqual(saved.body.bookmark, mark);
  assert.deepEqual((await client.call(route, { method: 'POST', body: mark })).body, saved.body);
  assert.equal((await client.call(route, { method: 'POST', body: { ...mark, label: 'Changed' } })).status, 409);
  assert.equal((await client.call(`${path(other)}/bookmarks`, { method: 'POST', body: mark })).status, 409);
  assert.equal((await client.call(route, { method: 'POST', body: { id: randomUUID(), entryId: otherEntry.id } })).status, 400);
  assert.equal((await client.call(route, { method: 'POST', body: { id: randomUUID(), entryId: randomUUID() } })).status, 400);
  const ended = await client.call(`${path(meeting)}/end`, { method: 'POST', body: { status: 'ended' } });
  assert.equal(ended.status, 200);
  const timeOnly = await client.call(route, { method: 'POST', body: { id: randomUUID() } });
  assert.equal(timeOnly.body.bookmark.entryId, null);
  assert.equal(timeOnly.body.bookmark.label, 'Marked moment');
  const read = (await client.call(path(meeting))).body;
  assert.equal(read.meeting.bookmarkCount, 2);
  assert.equal(read.bookmarks.length, 2);
});

test('ending is explicit and idempotent; reads never change state and completed batches can still be acknowledged', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const meeting = await create(client);
  const payload = batch([entry()]);
  await append(client, meeting, payload);
  await client.call('/api/meetings');
  await client.call(`${path(meeting)}/export`);
  assert.equal((await client.call(path(meeting))).body.meeting.status, 'recording');
  const end = { status: 'interrupted', endedAt: 1_800_000_001_000 };
  const ended = await client.call(`${path(meeting)}/end`, { method: 'POST', body: end });
  assert.equal(ended.body.meeting.status, 'interrupted');
  assert.equal(ended.body.meeting.endedAt, end.endedAt);
  assert.deepEqual((await client.call(`${path(meeting)}/end`, { method: 'POST', body: end })).body, ended.body);
  assert.equal((await client.call(`${path(meeting)}/end`, { method: 'POST', body: { status: 'ended' } })).status, 409);
  assert.equal((await append(client, meeting, batch([entry()]))).status, 409);
  assert.deepEqual((await append(client, meeting, payload)).body, { acknowledgedThrough: 1, entryCount: 1 });
});

test('long meetings retain the entire source and translation across pagination, export, and server reopen', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const meetingInput = newMeeting();
  const meeting = await create(client, meetingInput);
  const expected = [entry({ text: 'Complete words remain. '.repeat(300) })];
  const initialBatch = batch([...expected]);
  await append(client, meeting, initialBatch);
  for (let group = 0; group < 17; group += 1) {
    const next = Array.from({ length: 100 }, (_, index) => entry({ kind: index % 2 ? 'translation' : 'source', language: index % 2 ? 'ja' : 'en', text: `${group}:${index} ${index % 2 ? '保存された翻訳。' : 'Saved source words.'}` }));
    expected.push(...next);
    assert.equal((await append(client, meeting, batch(next))).status, 200);
  }
  const marked = { id: randomUUID(), entryId: expected[1600].id, label: 'Later moment', createdAt: 1_800_000_010_000 };
  await client.call(`${path(meeting)}/bookmarks`, { method: 'POST', body: marked });
  await client.call(`${path(meeting)}/end`, { method: 'POST', body: { status: 'ended' } });
  const paged = [];
  let after = 0;
  do {
    const page = (await client.call(`${path(meeting)}?limit=500&after=${after}`)).body;
    assert.ok(page.entries.length <= 500);
    paged.push(...page.entries);
    after = page.nextCursor;
  } while (after !== null);
  assert.equal(paged.length, 1701);
  assert.deepEqual(paged.map(({ sequence, ...saved }) => saved), expected);
  assert.deepEqual(paged.map(saved => saved.sequence), Array.from({ length: 1701 }, (_, index) => index + 1));
  const beforeRestart = (await client.call(`${path(meeting)}/export`)).body;
  assert.deepEqual(beforeRestart.entries, paged);
  assert.deepEqual(beforeRestart.bookmarks, [marked]);
  await fx.restart();
  const afterRestart = (await client.call(`${path(meeting)}/export`)).body;
  assert.deepEqual(afterRestart, beforeRestart);
  assert.equal((await create(client, meetingInput)).status, 'ended');
  assert.deepEqual((await append(client, meeting, initialBatch)).body, { acknowledgedThrough: 1, entryCount: 1701 });
});

test('meeting list pagination uses stable time and ID ordering without returning transcript text', async t => {
  const fx = await fixture(t);
  const client = fx.client();
  await client.unlock();
  const created = [];
  for (let index = 0; index < 5; index += 1) created.push(await create(client, newMeeting({ startedAt: 1_800_000_000_000 + Math.floor(index / 2) })));
  await append(client, created[0], batch([entry({ text: 'A private transcript stays in the detail view.' })]));
  const listed = [];
  let cursor;
  do {
    const response = await client.call(`/api/meetings?limit=2${cursor ? `&before=${cursor}` : ''}`);
    listed.push(...response.body.meetings);
    assert.equal(JSON.stringify(response.body).includes('A private transcript'), false);
    cursor = response.body.nextCursor;
  } while (cursor !== null);
  assert.equal(listed.length, 5);
  assert.equal(new Set(listed.map(meeting => meeting.id)).size, 5);
  assert.deepEqual(listed.map(meeting => meeting.id), created.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)).map(meeting => meeting.id));
});

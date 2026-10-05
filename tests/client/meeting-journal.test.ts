import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MeetingJournal, type JournalData, type JournalStorage } from '../../src/lib/meeting-journal';
import { finalizedEntries, type NewEntry } from '../../src/lib/meetings';
import { createMeetingStore, registerMeetingRoutes } from '../../server/meetings.mjs';

function ids() { let next = 0; return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`; }
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
const entry = (text: string, uuid = ids()): NewEntry =>
  ({ id: uuid(), kind: 'source', language: 'en', text, receivedAt: Date.now(), segment: 0 });

class Storage implements JournalStorage {
  data: JournalData | null = null;
  beforeSave?: (data: JournalData) => Promise<void> | void;
  async load() { return structuredClone(this.data); }
  async save(data: JournalData) {
    const candidate = structuredClone(data);
    await this.beforeSave?.(candidate);
    this.data = candidate;
  }
}

test('concurrent append during an in-flight request survives a lost acknowledgement with identical batch replay', async () => {
  const storage = new Storage(); const uuid = ids(); const first = gate();
  const sent: { path: string; body: any }[] = [];
  let failFirst = true;
  const journal = new MeetingJournal(storage, async (path, body) => {
    sent.push({ path, body: structuredClone(body) });
    if (path.endsWith('/entries') && failFirst) { failFirst = false; await first.wait; throw new Error('Lost acknowledgement'); }
  }, uuid);
  await journal.restore(); await journal.start('auto');
  await journal.append([entry('First final sentence.', uuid)]);
  await journal.append([entry('Second final sentence.', uuid)]);
  assert.equal(storage.data!.queue.length, 2, 'both batches must be durable before the first reply');
  first.release(); await journal.flush();
  assert.equal(journal.snapshot().pending, 2);
  await journal.flush();
  assert.equal(journal.snapshot().pending, 0);
  const batches = sent.filter(request => request.path.endsWith('/entries'));
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[0], batches[1], 'retry body and IDs must remain identical');
  assert.equal(batches[0].body.entries[0].text, 'First final sentence.');
  assert.equal(batches[2].body.entries[0].text, 'Second final sentence.');
  assert.equal(journal.snapshot().meeting!.entryCount, 2);
});

test('a failed local acknowledgement save retains the exact queue item for retry', async () => {
  const storage = new Storage(); const uuid = ids();
  const sent: unknown[] = []; let failAcknowledgement = false;
  const journal = new MeetingJournal(storage, async (path, body) => {
    if (path.endsWith('/entries')) { sent.push(structuredClone(body)); failAcknowledgement = sent.length === 1; }
  }, uuid);
  await journal.restore(); await journal.start('auto');
  storage.beforeSave = data => {
    if (failAcknowledgement && !data.queue.length) { failAcknowledgement = false; throw new Error('Disk temporarily unavailable'); }
  };
  await journal.append([entry('Durable words.', uuid)]); await journal.flush();
  assert.equal(journal.snapshot().pending, 1);
  assert.equal(storage.data!.queue.length, 1);
  await journal.flush();
  assert.equal(journal.snapshot().pending, 0);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});

test('a failed local append save retains the new final text in memory until a later retry succeeds', async () => {
  const storage = new Storage(); const uuid = ids(); const sent: any[] = [];
  const journal = new MeetingJournal(storage, async (path, body) => { if (path.endsWith('/entries')) sent.push(body); }, uuid);
  await journal.restore(); await journal.start('en_to_ja');
  let fail = true;
  storage.beforeSave = data => { if (fail && data.queue.length) { fail = false; throw new Error('Quota'); } };
  await assert.rejects(journal.append([entry('Keep these words.', uuid)]), /recovery copy/);
  assert.equal(journal.snapshot().pending, 1);
  await journal.flush();
  assert.equal(sent[0].entries[0].text, 'Keep these words.');
  assert.equal(journal.snapshot().pending, 0);
});

test('restoring an unfinished recording uploads its preserved batches before marking it interrupted', async () => {
  const storage = new Storage(); const uuid = ids(); let offline = false;
  const journal = new MeetingJournal(storage, async () => { if (offline) throw new Error('Offline'); }, uuid);
  await journal.restore(); await journal.start('ja_to_en'); offline = true;
  await journal.append([entry('Before interruption.', uuid)]); await journal.flush();
  const original = structuredClone(storage.data!.queue[0]);
  const replay: { path: string; body: any }[] = [];
  const restored = new MeetingJournal(storage, async (path, body) => { replay.push({ path, body: structuredClone(body) }); }, uuid);
  await restored.restore();
  assert.equal(replay.length, 2);
  assert.deepEqual(replay[0], { path: original.path, body: original.body });
  assert.ok(replay[1].path.endsWith('/end'));
  assert.equal(replay[1].body.status, 'interrupted');
  assert.equal(restored.snapshot().meeting!.status, 'interrupted');
  assert.equal(restored.snapshot().pending, 0);
});

test('new meetings cannot replace a previous unsaved queue and final entries after end are rejected', async () => {
  const storage = new Storage(); const uuid = ids(); let offline = false;
  const journal = new MeetingJournal(storage, async () => { if (offline) throw new Error('Offline'); }, uuid);
  await journal.restore(); const meeting = await journal.start('auto'); offline = true;
  await journal.append([entry('Pending.', uuid)]); await journal.end();
  await assert.rejects(journal.start('auto'), /previous meeting/);
  assert.equal(journal.snapshot().meeting!.id, meeting.id);
  await assert.rejects(journal.append([entry('Too late.', uuid)]), /ended/);
  offline = false; await journal.flush();
  const next = await journal.start('auto');
  assert.notEqual(next.id, meeting.id);
});

test('storage load failure prevents a new recording from overwriting an unknown recovery journal', async () => {
  const journal = new MeetingJournal({ load: async () => { throw new Error('Unavailable'); }, save: async () => {} }, async () => {});
  await journal.restore();
  assert.equal(journal.snapshot().ready, false);
  await assert.rejects(journal.start('auto'), /not ready/);
});

test('concurrent start requests create exactly one recording and reject the second request', async () => {
  const created: unknown[] = [];
  const journal = new MeetingJournal(new Storage(), async (path, body) => { if (path === '/api/meetings') created.push(body); }, ids());
  await journal.restore();
  const results = await Promise.allSettled([journal.start('auto'), journal.start('auto')]);
  assert.equal(created.length, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('a journal batch owns its entry values so external mutation cannot change a retry body', async () => {
  const sent: unknown[] = []; const uuid = ids(); let offline = true;
  const journal = new MeetingJournal(new Storage(), async (path, body) => {
    if (!path.endsWith('/entries')) return;
    sent.push(structuredClone(body));
    if (offline) throw new Error('Offline');
  }, uuid);
  await journal.restore(); await journal.start('auto');
  const original = entry('Original final words.', uuid);
  const entries = [original];
  await journal.append(entries); await journal.flush();
  original.text = 'An unrelated mutation'; entries.length = 0;
  offline = false; await journal.flush();
  assert.deepEqual(sent[0], sent.at(-1));
});

test('real meeting route validators accept default bookmarks and preserve final whitespace through export', async t => {
  // Calls the real route handlers and SQLite store in memory; no socket or provider.
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = createMeetingStore(db); const posts = new Map<string, (req: any, res: any) => any>();
  registerMeetingRoutes({ use() {}, get() {}, patch() {}, post(path: string, handler: any) { posts.set(path, handler); } }, store, () => {});
  const send = async (path: string, body: unknown) => {
    const match = /^\/api\/meetings\/([^/]+)(\/.*)?$/.exec(path);
    const route = match ? `/api/meetings/:id${match[2] ?? ''}` : path;
    const handler = posts.get(route); assert.ok(handler, route);
    let response: unknown;
    handler({ body: JSON.parse(JSON.stringify(body)), params: { id: match?.[1] } }, { json(value: unknown) { response = value; } });
    return response;
  };
  const uuid = ids(); const journal = new MeetingJournal(new Storage(), send, uuid);
  await journal.restore(); const meeting = await journal.start('auto');
  await journal.bookmark(); await journal.flush();
  await journal.append(finalizedEntries([{ text: ' ', is_final: true, language: 'en' },
    { text: '翻訳です。', is_final: true, language: 'ja', translation_status: 'translation' }], Date.now(), 0, uuid));
  await journal.end();
  assert.equal(journal.snapshot().error, '');
  assert.equal(journal.snapshot().pending, 0);
  const exported = store.export(meeting.id);
  assert.equal(exported.bookmarks.length, 1);
  assert.equal(exported.bookmarks[0].label, 'Marked moment');
  assert.deepEqual(exported.entries.map((item: any) => item.text), [' ', '翻訳です。']);
  assert.equal(exported.meeting.status, 'ended');
});

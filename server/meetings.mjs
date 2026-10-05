import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MODES = ['auto', 'en_to_ja', 'ja_to_en'];
const MAX_TIMESTAMP = 8_640_000_000_000_000;

function object(value, keys, label = 'Request') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new HttpError(400, `${label} contains invalid fields.`);
  }
  return value;
}

function id(value, label = 'ID') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${label} must be a UUID.`);
  return value.toLowerCase();
}

function text(value, label, max, { empty = false, trim = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new HttpError(400, `${label} is invalid.`);
  return trim ? value.trim() : value;
}

function integer(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new HttpError(400, `${label} is invalid.`);
  return value;
}

function timestamp(value, label) { return integer(value, label, MAX_TIMESTAMP); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function missing() { throw new HttpError(404, 'This meeting does not exist.'); }
function conflict(message) { throw new HttpError(409, message); }

function queryInteger(value, fallback, max, label, min = 0) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new HttpError(400, `${label} is invalid.`);
  const result = integer(Number(value), label, max);
  if (result < min) throw new HttpError(400, `${label} is invalid.`);
  return result;
}

function validateCreation(body) {
  object(body, ['id', 'title', 'mode', 'startedAt']);
  if (!MODES.includes(body.mode)) throw new HttpError(400, 'Meeting mode is invalid.');
  return {
    id: id(body.id, 'Meeting ID'),
    title: body.title === undefined ? 'Untitled meeting' : text(body.title, 'Meeting title', 160, { trim: true }),
    mode: body.mode,
    ...(body.startedAt === undefined ? {} : { startedAt: timestamp(body.startedAt, 'Start time') }),
  };
}

function validateBatch(body) {
  object(body, ['batchId', 'entries']);
  const batchId = id(body.batchId, 'Batch ID');
  if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 100) throw new HttpError(400, 'Provide between 1 and 100 transcript entries per batch.');
  const ids = new Set();
  const entries = body.entries.map(value => {
    object(value, ['id', 'kind', 'language', 'text', 'receivedAt', 'segment'], 'Transcript entry');
    const entryId = id(value.id, 'Entry ID');
    if (ids.has(entryId)) throw new HttpError(400, 'Each entry in a batch needs a different ID.');
    ids.add(entryId);
    if (!['source', 'translation'].includes(value.kind)) throw new HttpError(400, 'Transcript entry kind is invalid.');
    if (!['en', 'ja', 'unknown'].includes(value.language)) throw new HttpError(400, 'Transcript language is invalid.');
    return {
      id: entryId, kind: value.kind, language: value.language,
      // A provider may finalize a separator in its own frame. Preserve it so
      // reconstructing the full transcript never joins formerly separate words.
      text: text(value.text, 'Transcript text', 16_000, { empty: true }),
      receivedAt: timestamp(value.receivedAt, 'Received time'),
      ...(value.segment === undefined ? {} : { segment: integer(value.segment, 'Segment') }),
    };
  });
  if (entries.some(entry => entry.text.length === 0)) throw new HttpError(400, 'Transcript text is invalid.');
  return { batchId, entries };
}

function validateBookmark(body) {
  object(body, ['id', 'entryId', 'createdAt', 'label']);
  return {
    id: id(body.id, 'Bookmark ID'),
    ...(body.entryId === undefined ? {} : { entryId: id(body.entryId, 'Entry ID') }),
    ...(body.createdAt === undefined ? {} : { createdAt: timestamp(body.createdAt, 'Bookmark time') }),
    label: body.label === undefined ? 'Marked moment' : text(body.label, 'Bookmark label', 160, { trim: true }),
  };
}

const MEETING_COLUMNS = `id, title, mode, status, started_at AS startedAt,
  ended_at AS endedAt, updated_at AS updatedAt, entry_count AS entryCount,
  bookmark_count AS bookmarkCount`;
const ENTRY_COLUMNS = `id, sequence, kind, language, text, received_at AS receivedAt, segment`;
const BOOKMARK_COLUMNS = `id, entry_id AS entryId, created_at AS createdAt, label`;
const plain = row => row ? { ...row } : row;

// This store shares the existing team's SQLite file. No browser copy or session
// ownership is needed: every current team-code holder has the same access.
export function createMeetingStore(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      creation_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL,
      entry_count INTEGER NOT NULL DEFAULT 0,
      bookmark_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS meetings_started ON meetings(started_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS meeting_entries (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      language TEXT NOT NULL,
      text TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      segment INTEGER,
      UNIQUE(meeting_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS meeting_batches (
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      batch_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      acknowledged_through INTEGER NOT NULL,
      PRIMARY KEY(meeting_id, batch_id)
    );
    CREATE TABLE IF NOT EXISTS meeting_bookmarks (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      entry_id TEXT REFERENCES meeting_entries(id),
      creation_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      label TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meeting_bookmarks_order ON meeting_bookmarks(meeting_id, created_at, id);
  `);

  const findMeeting = db.prepare(`SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ?`);
  const findEntry = db.prepare('SELECT meeting_id FROM meeting_entries WHERE id = ?');
  const getMeeting = meetingId => plain(findMeeting.get(meetingId)) || missing();
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const bookmarks = meetingId => db.prepare(`SELECT ${BOOKMARK_COLUMNS} FROM meeting_bookmarks WHERE meeting_id = ? ORDER BY created_at, id`).all(meetingId).map(plain);
  const entries = (meetingId, after, limit) => db.prepare(`SELECT ${ENTRY_COLUMNS} FROM meeting_entries WHERE meeting_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(meetingId, after, limit).map(row => {
    const entry = plain(row);
    if (entry.segment === null) delete entry.segment;
    return entry;
  });

  return {
    create(input) {
      return transaction(() => {
        const creationHash = hash(input);
        const existing = db.prepare('SELECT creation_hash FROM meetings WHERE id = ?').get(input.id);
        if (existing) {
          if (existing.creation_hash !== creationHash) conflict('This meeting ID was already used with different details.');
          return getMeeting(input.id);
        }
        db.prepare('INSERT INTO meetings (id, creation_hash, title, mode, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(input.id, creationHash, input.title, input.mode, input.startedAt ?? Date.now(), Date.now());
        return getMeeting(input.id);
      });
    },
    list({ limit, before }) {
      const rows = before
        ? db.prepare(`SELECT ${MEETING_COLUMNS} FROM meetings WHERE started_at < ? OR (started_at = ? AND id < ?) ORDER BY started_at DESC, id DESC LIMIT ?`).all(before.startedAt, before.startedAt, before.id, limit + 1)
        : db.prepare(`SELECT ${MEETING_COLUMNS} FROM meetings ORDER BY started_at DESC, id DESC LIMIT ?`).all(limit + 1);
      const meetings = rows.slice(0, limit).map(plain);
      const last = meetings.at(-1);
      return { meetings, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ startedAt: last.startedAt, id: last.id })).toString('base64url') : null };
    },
    detail(meetingId, { after, limit }) {
      const meeting = getMeeting(meetingId);
      const page = entries(meetingId, after, limit + 1);
      const visible = page.slice(0, limit);
      return { meeting, entries: visible, bookmarks: bookmarks(meetingId), nextCursor: page.length > limit ? visible.at(-1).sequence : null };
    },
    append(meetingId, batch) {
      return transaction(() => {
        const meeting = getMeeting(meetingId);
        const contentHash = hash(batch.entries);
        const existing = db.prepare('SELECT content_hash, acknowledged_through FROM meeting_batches WHERE meeting_id = ? AND batch_id = ?').get(meetingId, batch.batchId);
        if (existing) {
          if (existing.content_hash !== contentHash) conflict('This batch ID was already used with different transcript entries.');
          return { acknowledgedThrough: existing.acknowledged_through, entryCount: meeting.entryCount };
        }
        if (meeting.status !== 'recording') conflict('This meeting has ended. Start a new meeting to save more captions.');
        // Check the complete batch before any write, including IDs already used
        // by another meeting. A conflict can never partially append a batch.
        for (const entry of batch.entries) if (findEntry.get(entry.id)) conflict('A transcript entry ID has already been saved. Retry its original batch.');
        const insert = db.prepare('INSERT INTO meeting_entries (id, meeting_id, sequence, kind, language, text, received_at, segment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        let sequence = meeting.entryCount;
        for (const entry of batch.entries) insert.run(entry.id, meetingId, ++sequence, entry.kind, entry.language, entry.text, entry.receivedAt, entry.segment ?? null);
        db.prepare('INSERT INTO meeting_batches (meeting_id, batch_id, content_hash, acknowledged_through) VALUES (?, ?, ?, ?)').run(meetingId, batch.batchId, contentHash, sequence);
        db.prepare('UPDATE meetings SET entry_count = ?, updated_at = ? WHERE id = ?').run(sequence, Date.now(), meetingId);
        return { acknowledgedThrough: sequence, entryCount: sequence };
      });
    },
    rename(meetingId, title) {
      getMeeting(meetingId);
      db.prepare('UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), meetingId);
      return getMeeting(meetingId);
    },
    end(meetingId, input) {
      return transaction(() => {
        const meeting = getMeeting(meetingId);
        if (meeting.status !== 'recording') {
          if (meeting.status !== input.status || (input.endedAt !== undefined && meeting.endedAt !== input.endedAt)) conflict('This meeting has already ended with different details.');
          return meeting;
        }
        db.prepare('UPDATE meetings SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?').run(input.status, input.endedAt ?? Date.now(), Date.now(), meetingId);
        return getMeeting(meetingId);
      });
    },
    bookmark(meetingId, input) {
      return transaction(() => {
        getMeeting(meetingId);
        const creationHash = hash(input);
        const existing = db.prepare(`SELECT ${BOOKMARK_COLUMNS}, meeting_id, creation_hash FROM meeting_bookmarks WHERE id = ?`).get(input.id);
        if (existing) {
          if (existing.meeting_id !== meetingId || existing.creation_hash !== creationHash) conflict('This bookmark ID was already used with different details.');
          const { meeting_id, creation_hash, ...bookmark } = existing;
          return bookmark;
        }
        if (input.entryId !== undefined && findEntry.get(input.entryId)?.meeting_id !== meetingId) throw new HttpError(400, 'The bookmarked entry must belong to this meeting.');
        const bookmark = { id: input.id, entryId: input.entryId ?? null, createdAt: input.createdAt ?? Date.now(), label: input.label };
        db.prepare('INSERT INTO meeting_bookmarks (id, meeting_id, entry_id, creation_hash, created_at, label) VALUES (?, ?, ?, ?, ?, ?)').run(bookmark.id, meetingId, bookmark.entryId, creationHash, bookmark.createdAt, bookmark.label);
        db.prepare('UPDATE meetings SET bookmark_count = bookmark_count + 1, updated_at = ? WHERE id = ?').run(Date.now(), meetingId);
        return bookmark;
      });
    },
    export(meetingId) {
      return { meeting: getMeeting(meetingId), entries: entries(meetingId, 0, -1), bookmarks: bookmarks(meetingId) };
    },
  };
}

export function registerMeetingRoutes(app, meetings, requireSession) {
  app.use('/api/meetings', requireSession);
  app.post('/api/meetings', (req, res) => res.json({ meeting: meetings.create(validateCreation(req.body)) }));
  app.get('/api/meetings', (req, res) => {
    object(req.query, ['limit', 'before'], 'Query');
    const limit = queryInteger(req.query.limit, 30, 100, 'Page size', 1);
    let before;
    if (req.query.before !== undefined) {
      if (typeof req.query.before !== 'string' || req.query.before.length > 160 || !/^[A-Za-z0-9_-]+$/.test(req.query.before)) throw new HttpError(400, 'Meeting cursor is invalid.');
      try {
        const decoded = object(JSON.parse(Buffer.from(req.query.before, 'base64url').toString()), ['startedAt', 'id']);
        before = { startedAt: timestamp(decoded.startedAt, 'Cursor time'), id: id(decoded.id) };
      } catch { throw new HttpError(400, 'Meeting cursor is invalid.'); }
    }
    res.json(meetings.list({ limit, before }));
  });
  app.get('/api/meetings/:id', (req, res) => {
    object(req.query, ['after', 'limit'], 'Query');
    const after = queryInteger(req.query.after, 0, Number.MAX_SAFE_INTEGER, 'Entry cursor');
    const limit = queryInteger(req.query.limit, 200, 500, 'Page size', 1);
    res.json(meetings.detail(id(req.params.id, 'Meeting ID'), { after, limit }));
  });
  app.post('/api/meetings/:id/entries', (req, res) => res.json(meetings.append(id(req.params.id, 'Meeting ID'), validateBatch(req.body))));
  app.patch('/api/meetings/:id', (req, res) => {
    object(req.body, ['title']);
    res.json({ meeting: meetings.rename(id(req.params.id, 'Meeting ID'), text(req.body.title, 'Meeting title', 160, { trim: true })) });
  });
  app.post('/api/meetings/:id/end', (req, res) => {
    object(req.body, ['status', 'endedAt']);
    if (!['ended', 'interrupted'].includes(req.body.status)) throw new HttpError(400, 'Meeting status is invalid.');
    const input = { status: req.body.status, ...(req.body.endedAt === undefined ? {} : { endedAt: timestamp(req.body.endedAt, 'End time') }) };
    res.json({ meeting: meetings.end(id(req.params.id, 'Meeting ID'), input) });
  });
  app.post('/api/meetings/:id/bookmarks', (req, res) => res.json({ bookmark: meetings.bookmark(id(req.params.id, 'Meeting ID'), validateBookmark(req.body)) }));
  app.get('/api/meetings/:id/export', (req, res) => res.json(meetings.export(id(req.params.id, 'Meeting ID'))));
}

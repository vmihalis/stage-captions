import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export function createStore(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      code_version TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (!get.get('team')) set.run('team', JSON.stringify({ name: 'Your team', glossary: { terms: [], translationTerms: [], background: '' } }));
  if (!get.get('code_salt')) set.run('code_salt', randomBytes(32).toString('base64url'));

  return {
    get salt() { return get.get('code_salt').value; },
    getTeam() { return JSON.parse(get.get('team').value); },
    updateTeam(team) { set.run('team', JSON.stringify(team)); return team; },
    activateCodeVersion(version) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (get.get('code_version')?.value !== version) {
          db.prepare('DELETE FROM sessions').run();
          set.run('code_version', version);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createSession(tokenHash, version, expiresAt) {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      const session = { id: randomUUID(), expiresAt };
      db.prepare('INSERT INTO sessions (token_hash, id, code_version, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, session.id, version, expiresAt);
      return session;
    },
    findSession(tokenHash, version) {
      return db.prepare('SELECT id, expires_at AS expiresAt FROM sessions WHERE token_hash = ? AND code_version = ? AND expires_at > ?').get(tokenHash, version, Date.now());
    },
    deleteSession(tokenHash) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); },
    close() { db.close(); },
  };
}

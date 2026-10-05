import type { Meeting, NewEntry } from './meetings';
import { entryBatches } from './meetings';
import type { TranslationMode } from './speech-config';

type Request = { id: string; path: string; body: unknown };
export type JournalData = { meeting: Meeting | null; queue: Request[] };
export interface JournalStorage { load(): Promise<JournalData | null>; save(data: JournalData): Promise<void> }
export interface JournalState { meeting: Meeting | null; pending: number; saving: boolean; error: string; ready: boolean }
type Send = (path: string, body: unknown) => Promise<unknown>;

// Network acknowledgements and local writes are separate: incoming final text
// can be journaled while an earlier immutable batch is still in flight.
export class MeetingJournal {
  private data: JournalData = { meeting: null, queue: [] };
  private writes: Promise<void> = Promise.resolve();
  private flight: Promise<void> | null = null;
  private ready = false;
  private starting = false;
  private error = '';
  private listeners = new Set<() => void>();
  constructor(private storage: JournalStorage, private send: Send,
    private uuid: () => string = () => crypto.randomUUID()) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  snapshot = (): JournalState => ({ meeting: this.data.meeting, pending: this.data.queue.length, saving: !!this.flight, error: this.error, ready: this.ready });
  private write(mutate: () => void) {
    const task = this.writes.then(async () => {
      mutate();
      try { await this.storage.save(this.data); }
      catch { this.error = 'This computer could not save the transcript recovery copy. Keep Stage open and export the meeting before leaving.'; this.emit(); throw new Error(this.error); }
      this.emit();
    });
    this.writes = task.catch(() => {});
    return task;
  }
  async restore() {
    try {
      this.data = await this.storage.load() ?? { meeting: null, queue: [] };
      this.ready = true;
      if (this.data.meeting?.status === 'recording') await this.end('interrupted');
      else await this.flush();
    } catch (error) { this.error ||= error instanceof Error ? error.message : 'Meeting recovery is unavailable.'; }
    this.emit();
  }
  async start(mode: TranslationMode) {
    if (this.starting) throw new Error('A meeting is already starting.');
    this.starting = true;
    try { return await this.startOnce(mode); } finally { this.starting = false; }
  }
  private async startOnce(mode: TranslationMode) {
    if (!this.ready) throw new Error('Meeting storage is not ready. Reload Stage and try again.');
    await this.flush();
    if (this.data.queue.length) throw new Error('Save the previous meeting before starting another one. Retry its pending upload.');
    if (this.data.meeting?.status === 'recording') throw new Error('A meeting is already recording.');
    const startedAt = Date.now();
    const id = this.uuid();
    const title = `Meeting · ${new Date(startedAt).toLocaleString()}`;
    await this.write(() => {
      this.data.meeting = { id, title, mode, startedAt, endedAt: null, updatedAt: startedAt, entryCount: 0, bookmarkCount: 0, status: 'recording' };
      this.data.queue.push({ id: this.uuid(), path: '/api/meetings', body: { id, title, mode, startedAt } });
    });
    await this.flush();
    if (this.data.queue.length) { await this.end('interrupted'); throw new Error(this.error || 'Could not start meeting storage. Retry when the team server is connected.'); }
    return this.data.meeting!;
  }
  append(entries: NewEntry[]) {
    if (!entries.length) return Promise.resolve();
    const immutableEntries = structuredClone(entries);
    return this.write(() => {
      const meeting = this.data.meeting;
      if (!meeting || meeting.status !== 'recording') throw new Error('Meeting has ended.');
      for (const batch of entryBatches(immutableEntries)) this.data.queue.push({ id: this.uuid(), path: `/api/meetings/${meeting.id}/entries`, body: { batchId: this.uuid(), entries: batch } });
      this.data.meeting = { ...meeting, entryCount: meeting.entryCount + immutableEntries.length, updatedAt: Date.now() };
    }).then(() => { void this.flush(); });
  }
  async bookmark(label = '') {
    await this.write(() => {
      const meeting = this.data.meeting;
      if (!meeting) throw new Error('Start a meeting first.');
      this.data.queue.push({ id: this.uuid(), path: `/api/meetings/${meeting.id}/bookmarks`, body: { id: this.uuid(), createdAt: Date.now(), ...(label.trim() ? { label: label.trim().slice(0, 160) } : {}) } });
      this.data.meeting = { ...meeting, bookmarkCount: meeting.bookmarkCount + 1 };
    });
    void this.flush();
  }
  async end(status: 'ended' | 'interrupted' = 'ended') {
    await this.write(() => {
      const meeting = this.data.meeting;
      if (!meeting || meeting.status !== 'recording') return;
      const endedAt = Date.now();
      this.data.queue.push({ id: this.uuid(), path: `/api/meetings/${meeting.id}/end`, body: { status, endedAt } });
      this.data.meeting = { ...meeting, status, endedAt, updatedAt: endedAt };
    });
    await this.flush();
  }
  flush(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.drain().finally(() => { this.flight = null; this.emit(); });
    this.emit(); return this.flight;
  }
  private async drain() {
    await this.writes;
    while (this.data.queue.length) {
      const request = this.data.queue[0]!;
      try {
        // A failed local acknowledgement keeps exactly the same batch for retry.
        await this.storage.save(this.data);
        await this.send(request.path, request.body);
        const acknowledgement = this.writes.then(async () => {
          const candidate = { ...this.data, queue: this.data.queue.filter(item => item.id !== request.id) };
          await this.storage.save(candidate);
          this.data = candidate;
          this.emit();
        });
        this.writes = acknowledgement.catch(() => {});
        await acknowledgement;
        this.error = '';
      } catch {
        this.error ||= 'Transcript upload paused. New text stays on this computer until the team server reconnects. Keep Stage open or return here to resume.';
        this.emit(); return;
      }
    }
  }
}

export function browserJournalStorage(): JournalStorage {
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('stage-meeting-recovery', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Local meeting recovery storage is unavailable.'));
  });
  return {
    async load() {
      const db = await database;
      return new Promise((resolve, reject) => {
        const request = db.transaction('journal').objectStore('journal').get('current');
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    },
    async save(data) {
      const db = await database;
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('journal', 'readwrite');
        transaction.objectStore('journal').put(data, 'current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    },
  };
}

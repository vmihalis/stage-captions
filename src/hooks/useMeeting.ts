import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { MeetingJournal, browserJournalStorage } from '../lib/meeting-journal';
import type { JournalState } from '../lib/meeting-journal';
import { finalizedEntries } from '../lib/meetings';
import type { Token } from '../lib/captions';
import type { TranslationMode } from '../lib/speech-config';

export function useMeeting(authorized: boolean) {
  const journal = useRef<MeetingJournal | null>(null);
  const [state, setState] = useState<JournalState>({ meeting: null, pending: 0, saving: false, error: '', ready: false });
  const [lockError, setLockError] = useState('');
  useEffect(() => {
    if (!authorized) return;
    let disposed = false;
    let release: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const attach = async () => {
      const next = new MeetingJournal(browserJournalStorage(), (path, body) => api(path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }));
      journal.current = next;
      unsubscribe = next.subscribe(() => { if (!disposed) setState(next.snapshot()); });
      await next.restore();
      if (!disposed) timer = setInterval(() => void next.flush(), 5000);
    };
    if (!navigator.locks) { setLockError('This browser does not support safe meeting recovery. Use the current Stage app or a current Chrome, Edge, Safari, or Firefox.'); return; }
    void navigator.locks.request('stage-meeting-recorder', { ifAvailable: true }, async lock => {
      if (disposed) return;
      if (!lock) { setLockError('Another Stage tab is managing meeting recording. Close it, then reload this tab. Meeting history is still available here.'); return; }
      setLockError('');
      const held = new Promise<void>(resolve => { release = resolve; });
      await attach();
      await held;
    });
    return () => { disposed = true; unsubscribe?.(); if (timer) clearInterval(timer); journal.current = null; release?.(); };
  }, [authorized]);
  useEffect(() => {
    if (!state.pending && state.meeting?.status !== 'recording') return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.pending, state.meeting?.status]);
  const start = useCallback((mode: TranslationMode) => {
    if (!journal.current) return Promise.reject(new Error('Meeting storage is not ready. Check the message above and reload Stage.'));
    return journal.current.start(mode);
  }, []);
  const onTokens = useCallback((tokens: Token[], segment: number) => {
    const entries = finalizedEntries(tokens, Date.now(), segment);
    void journal.current?.append(entries).catch(() => {}); // Journal exposes a recoverable storage error in the UI.
  }, []);
  const end = useCallback((interrupted = false) => journal.current?.end(interrupted ? 'interrupted' : 'ended') ?? Promise.resolve(), []);
  const bookmark = useCallback(() => journal.current?.bookmark() ?? Promise.resolve(), []);
  const retry = useCallback(async () => {
    const current = journal.current;
    await current?.flush();
    return current?.snapshot();
  }, []);
  return { ...state, error: lockError || state.error, start, onTokens, end, bookmark, retry };
}

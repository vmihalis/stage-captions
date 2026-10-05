import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Download, FileText, LoaderCircle, RefreshCw, Search, Sparkles } from 'lucide-react';
import { api } from './lib/api';
import { meetingMarkdown, saveText, summaryBrief } from './lib/meetings';
import type { Meeting, MeetingEntry, Bookmark as Moment, MeetingExport } from './lib/meetings';
import type { MeetingSummary } from './types';

const stamp = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const elapsed = (time: number, start: number) => {
  const seconds = Math.max(0, Math.floor((time - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function MeetingHistory({ authenticated, onConnect, selectedId, onSelect, summaryAvailable }: {
  authenticated: boolean; onConnect: () => void; selectedId: string | null; onSelect: (id: string | null) => void; summaryAvailable: boolean;
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [entries, setEntries] = useState<MeetingEntry[]>([]);
  const [marks, setMarks] = useState<Moment[]>([]);
  const [after, setAfter] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const generation = useRef(0);
  const load = async (more = false) => {
    const current = generation.current;
    setLoading(true); setError('');
    try {
      if (selectedId) {
        const result = await api<{ meeting: Meeting; entries: MeetingEntry[]; bookmarks: Moment[]; nextCursor: number | null }>(`/api/meetings/${selectedId}?after=${more ? after ?? 0 : 0}&limit=200`);
        if (current !== generation.current) return;
        setMeeting(result.meeting); setEntries(previous => more ? [...previous, ...result.entries] : result.entries);
        setMarks(result.bookmarks); setAfter(result.nextCursor);
      } else {
        const result = await api<{ meetings: Meeting[]; nextCursor: string | null }>(`/api/meetings?limit=30${more && cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
        if (current !== generation.current) return;
        setMeetings(previous => more ? [...previous, ...result.meetings] : result.meetings); setCursor(result.nextCursor);
      }
    } catch (failure) { if (current === generation.current) setError((failure as Error).message); }
    finally { if (current === generation.current) setLoading(false); }
  };
  useEffect(() => {
    generation.current++; setEntries([]); setMeeting(null); setQuery(''); setSummary(null); setMessage(''); setError(''); setWorking(false);
    if (authenticated) void load();
    return () => { generation.current++; void window.stageDesktop?.cancelSummary?.(); };
    // Each selected meeting owns one set of requests. Load-more uses its current cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, authenticated]);
  const exportMeeting = async (kind: 'json' | 'md' | 'brief' | 'summary') => {
    if (!selectedId) return;
    const current = generation.current;
    setWorking(true); setError(''); setMessage('');
    try {
      const data = await api<MeetingExport>(`/api/meetings/${selectedId}/export`);
      if (current !== generation.current) return;
      if (kind === 'summary') {
        if (data.meeting.status === 'recording') throw new Error('Stop the meeting and wait for transcript saving to finish before creating a summary.');
        if (!window.stageDesktop?.summarizeMeeting) throw new Error('A local summary worker has not been configured on this computer. Download the summary brief to use it in your AI app.');
        const result = await window.stageDesktop.summarizeMeeting(data);
        if (current !== generation.current) return;
        if (!result.ok) throw new Error(result.error.message);
        setSummary(result.summary); setMessage('AI draft · Check cited transcript entries before relying on decisions or action items.');
      } else {
        const text = kind === 'json' ? JSON.stringify(data, null, 2) : kind === 'brief' ? summaryBrief(data) : meetingMarkdown(data);
        const format = kind === 'json' ? 'json' : 'md';
        const result = await saveText(`stage-${selectedId}${kind === 'brief' ? '-summary-brief' : ''}.${format}`, text, format);
        if (result.saved) setMessage(kind === 'brief' ? 'Summary brief saved with the complete transcript and marked moments. Open it in your preferred AI app.' : 'Complete meeting transcript saved.');
      }
    } catch (failure) { if (current === generation.current) setError((failure as Error).message); }
    finally { if (current === generation.current) setWorking(false); }
  };
  const loadAll = async () => {
    if (!selectedId) return;
    const current = generation.current; setLoading(true);
    try {
      const data = await api<MeetingExport>(`/api/meetings/${selectedId}/export`);
      if (current !== generation.current) return;
      setEntries(data.entries); setMarks(data.bookmarks); setMeeting(data.meeting); setAfter(null);
      return data.entries;
    } catch (failure) { if (current === generation.current) setError((failure as Error).message); }
    finally { if (current === generation.current) setLoading(false); }
  };
  const cite = async (entryId: string) => {
    setQuery('');
    if (!entries.some(entry => entry.id === entryId)) await loadAll();
    requestAnimationFrame(() => document.getElementById(`entry-${entryId}`)?.scrollIntoView({ block: 'center', behavior: 'instant' }));
  };
  const visitMark = async (mark: Moment) => {
    if (mark.entryId) { await cite(mark.entryId); return; }
    const complete = after !== null ? await loadAll() : entries;
    const target = complete?.find(entry => entry.receivedAt >= mark.createdAt) ?? complete?.at(-1);
    if (target) await cite(target.id);
  };
  const visible = entries.filter(entry => !query || entry.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="history-page">
    <div className="page-heading"><div>{selectedId && <button className="text-button history-back" onClick={() => onSelect(null)}><ArrowLeft size={16} /> All meetings</button>}<h1>{meeting?.title || (selectedId ? 'Meeting transcript' : 'Team meetings')}</h1><p>{meeting ? `${stamp(meeting.startedAt)} · ${meeting.status === 'recording' ? 'Recording' : meeting.status === 'interrupted' ? 'Interrupted session' : 'Finished'} · ${meeting.entryCount.toLocaleString()} transcript entries` : 'Full transcripts and marked moments, shared with everyone holding the team code.'}</p></div>{authenticated && <button className="button secondary small" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>}</div>
    {!authenticated ? <div className="notice"><span>Connect your team to view its meeting history.</span><button className="text-button" onClick={onConnect}>Connect team</button></div> : <>
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {!selectedId ? <>
        <div className="meeting-list">{meetings.map(item => <button key={item.id} className="meeting-row" onClick={() => onSelect(item.id)}><FileText size={20} /><span><strong>{item.title}</strong><span>{stamp(item.startedAt)} · {item.status === 'recording' ? 'Recording' : item.status === 'interrupted' ? 'Interrupted' : 'Finished'} · {item.entryCount.toLocaleString()} entries</span></span>{item.bookmarkCount > 0 && <span className="moment-count"><Bookmark size={15} /> {item.bookmarkCount}</span>}</button>)}</div>
        {!loading && !meetings.length && <div className="history-empty"><FileText size={30} /><h2>Your next meeting starts here</h2><p>Start live captions to save the finalized speech and translations. Rehearsals stay separate.</p></div>}
        {cursor && <button className="button secondary" disabled={loading} onClick={() => void load(true)}>Earlier meetings</button>}
      </> : meeting && <>
        <div className="history-actions">{working && summaryAvailable && <button className="text-button" onClick={() => void window.stageDesktop?.cancelSummary?.()}>Cancel summary</button>}<button className="button secondary small" disabled={working} onClick={() => void exportMeeting('md')}><Download size={16} /> Transcript</button><button className="button secondary small" disabled={working} onClick={() => void exportMeeting('json')}>JSON</button><button className="button secondary small" disabled={working || meeting.status === 'recording'} onClick={() => void exportMeeting('brief')}><Sparkles size={16} /> Summary brief</button>{summaryAvailable && <button className="button primary small" disabled={working || meeting.status === 'recording'} onClick={() => void exportMeeting('summary')}><Sparkles size={16} /> {working ? 'Preparing…' : 'Summarize on this Mac'}</button>}</div>
        {!summaryAvailable && <p className="field-hint">Summary brief includes the whole transcript and evidence IDs, ready for your AI app. Automatic summaries need a locally configured OMP worker; your personal login stays on your computer.</p>}
        {summary && <section className="meeting-summary" aria-label="AI meeting summary"><h2>Meeting summary <span className="field-hint">AI draft</span></h2>{(['overview', 'decisions', 'actions', 'openQuestions'] as const).map(section => <div key={section}><h3>{({overview:'Overview',decisions:'Decisions',actions:'Action items',openQuestions:'Open questions'})[section]}</h3>{summary[section].length ? <ul>{summary[section].map((item, index) => <li key={index}>{item.text}{'assignee' in item && <span className="field-hint"> · Owner: {item.assignee || 'Unspecified'} · Due: {item.dueDate || 'Unspecified'}</span>}<span className="summary-citations">{item.evidenceEntryIds.map((id, i) => <button className="text-button" key={id} onClick={() => void cite(id)}>[{i + 1}]</button>)}</span></li>)}</ul> : <p className="muted">None identified.</p>}</div>)}</section>}
        {!!marks.length && <div className="marked-moments"><h2><Bookmark size={17} /> Marked moments</h2>{marks.map(mark => <button className="moment-chip" key={mark.id} onClick={() => void visitMark(mark)}>{elapsed(mark.createdAt, meeting.startedAt)} · {mark.label || 'Worth revisiting'}</button>)}</div>}
        <div className="transcript-tools"><label className="history-search"><Search size={17} /><input aria-label="Find in loaded transcript" placeholder="Find in transcript…" value={query} onChange={event => setQuery(event.target.value)} /></label>{after !== null && <button className="text-button" disabled={loading} onClick={() => void loadAll()}>Load whole meeting for search</button>}</div>
        <p className="field-hint">Finalized text only. Times show when Stage received it; translations can arrive later. {entries.length.toLocaleString()} of {meeting.entryCount.toLocaleString()} entries loaded.</p>
        <div className="meeting-transcript">{visible.map(entry => <article id={`entry-${entry.id}`} key={entry.id} className={`transcript-entry ${entry.kind}`}><div><time>{elapsed(entry.receivedAt, meeting.startedAt)}</time><span>{entry.kind === 'source' ? 'Spoken' : 'Translation'} · {entry.language}</span></div><p lang={entry.language === 'unknown' ? undefined : entry.language}>{entry.text}</p></article>)}</div>
        {!loading && !visible.length && <p className="muted">{query ? 'No matches in the loaded transcript.' : 'No finalized words saved yet.'}</p>}
        {after !== null && <button className="button secondary" disabled={loading} onClick={() => void load(true)}>Load more transcript</button>}
      </>}
      {loading && <p className="loading-line" role="status"><LoaderCircle className="spin" size={17} /> Loading meeting history…</p>}
    </>}
  </section>;
}

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Captions, Check, CircleHelp, FileText, LoaderCircle, X } from 'lucide-react';
import { api } from './lib/api';
import { parseTranslations } from './lib/captions';
import MeetingHistory from './MeetingHistory';
import type { Session, Team } from './types';

const emptyTeam: Team = { name: 'Team captions', glossary: { terms: [], translationTerms: [], background: '' } };
type View = 'meetings' | 'vocabulary' | 'setup';

// Workspaces deliberately have no microphone or meeting-recorder hooks. Opening
// history must not acquire the recorder lock or interrupt a running meeting.
export default function Workspace() {
  const query = new URLSearchParams(window.location.search);
  const [view, setView] = useState<View>(query.get('view') === 'vocabulary' ? 'vocabulary' : query.get('view') === 'setup' ? 'setup' : 'meetings');
  const [selectedId, setSelectedId] = useState<string | null>(query.get('meeting'));
  const [session, setSession] = useState<Session | null>(null);
  const [team, setTeam] = useState<Team>(emptyTeam);
  const [summaryAvailable, setSummaryAvailable] = useState(false);
  const [error, setError] = useState('');
  const [connect, setConnect] = useState(false);
  const [code, setCode] = useState('');
  const [connecting, setConnecting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Session>('/api/session'); setSession(next);
      if (next.authenticated) { setTeam(await api<Team>('/api/team')); setConnect(false); }
      setError('');
    } catch (failure) { setError((failure as Error).message); }
  }, []);
  useEffect(() => { void refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
  useEffect(() => {
    document.title = 'Stage · ' + (view === 'vocabulary' ? 'Vocabulary' : view === 'setup' ? 'Help' : 'Meetings');
    const next = new URLSearchParams({ view }); if (view === 'meetings' && selectedId) next.set('meeting', selectedId);
    window.history.replaceState(null, '', `/workspace?${next}`);
  }, [view, selectedId]);
  useEffect(() => { void window.stageDesktop?.getCapabilities?.().then(caps => setSummaryAvailable(!!caps.summaryWorker)).catch(() => {}); }, []);
  const unlock = async (event: React.FormEvent) => {
    event.preventDefault(); setConnecting(true); setError('');
    try { await api('/api/auth/unlock', { method: 'POST', body: JSON.stringify({ code }) }); setCode(''); await refresh(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setConnecting(false); }
  };
  return <div className="workspace-shell">
    <header className="workspace-header"><span className="workspace-brand"><Captions size={22} /><strong>Stage</strong></span><nav aria-label="Workspace">{([{ id: 'meetings', label: 'Meetings', icon: FileText }, { id: 'vocabulary', label: 'Vocabulary', icon: BookOpen }, { id: 'setup', label: 'Help', icon: CircleHelp }] as const).map(item => <button key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><item.icon size={16} />{item.label}</button>)}</nav><button className="icon-button" onClick={() => window.close()} title="Close workspace" aria-label="Close workspace"><X size={18} /></button></header>
    <main className="workspace-content">
      {error && <div className="notice error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void refresh()}>Retry</button></div>}
      {connect && <form className="workspace-connect" onSubmit={unlock}><label htmlFor="workspace-code">Team access code</label><input autoFocus required type="password" autoComplete="off" id="workspace-code" maxLength={256} value={code} onChange={event => setCode(event.target.value)} /><button className="button primary" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</button><button type="button" className="icon-button" aria-label="Cancel connection" onClick={() => { setConnect(false); setCode(''); }}><X size={18} /></button></form>}
      {view === 'meetings' && <MeetingHistory authenticated={!!session?.authenticated} onConnect={() => setConnect(true)} selectedId={selectedId} onSelect={setSelectedId} summaryAvailable={summaryAvailable} />}
      <div hidden={view !== 'vocabulary'}><Vocabulary team={team} authenticated={!!session?.authenticated} onConnect={() => setConnect(true)} onSaved={setTeam} /></div>
      {view === 'setup' && <Help session={session} />}
    </main>
  </div>;
}

function Help({ session }: { session: Session | null }) {
  return <section className="settings-page"><div className="page-heading"><h1>A quick check</h1></div>
    <dl className="help-list">
      <div><dt>Before speaking</dt><dd>Choose your mic in <strong>⋯ → Settings</strong>. Use <strong>Check mic</strong>, then <strong>⋯ → Rehearse</strong> to test the captions without sending audio.</dd></div>
      <div><dt>Keep slides visible</dt><dd><strong>Overlay</strong> floats above apps. <strong>Window</strong> sits beside a windowed presentation. <strong>Slides + strip</strong> fits your content and captions on a separate extended projector.</dd></div>
      <div><dt>During a talk</dt><dd><strong>Pause</strong> pauses speech while keeping the microphone session open; <strong>Resume</strong> continues the same meeting. The bookmark saves a moment. <strong>⋯ → End & save</strong> finishes the meeting.</dd></div>
      <div><dt>Hide captions</dt><dd>Use the output button or <kbd>⌘ / Ctrl + Shift + H</kbd>. Hiding captions keeps the microphone on. Hide the remote from <strong>⋯</strong> and restore it from the menu bar or system tray.</dd></div>
      <div><dt>Saved with your team</dt><dd>Everyone with the team code can read and export finalized speech, translations, and bookmarks in Meetings. Stage does not store microphone audio. Tell participants before you start.</dd></div>
    </dl>
    <details className="help-details"><summary>Translation service</summary><p>{session?.provider.configured ? 'Soniox is connected. Test with your speakers and projector before the event.' : 'Ask your organizer to configure Soniox on the team server. Rehearsal works without an account.'}</p><p>Live microphone audio goes directly to Soniox. A local summary worker, when configured, sends a meeting transcript to your chosen model after you request a summary.</p></details>
  </section>;
}

export function Vocabulary({ team, authenticated, onConnect, onSaved }: { team: Team; authenticated: boolean; onConnect: () => void; onSaved: (team: Team) => void }) {
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState(team.name);
  const [terms, setTerms] = useState(team.glossary.terms.join('\n'));
  const [translations, setTranslations] = useState(team.glossary.translationTerms.map(pair => `${pair.source} = ${pair.target}`).join('\n'));
  const [background, setBackground] = useState(team.glossary.background);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (dirty) return; setName(team.name); setTerms(team.glossary.terms.join('\n')); setTranslations(team.glossary.translationTerms.map(pair => `${pair.source} = ${pair.target}`).join('\n')); setBackground(team.glossary.background); }, [team, dirty]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setMessage(''); setSaving(true);
    try {
      const next = { name: name.trim(), glossary: { terms: terms.split('\n').map(value => value.trim()).filter(Boolean), translationTerms: parseTranslations(translations), background: background.trim() } };
      await api('/api/team', { method: 'PATCH', body: JSON.stringify(next) });
      setDirty(false); onSaved(next); setMessage('Saved. Applies to new sessions.');
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  return <section className="settings-page"><div className="page-heading"><div><h1>Team vocabulary</h1><p>Shared names, terms, and context.</p></div><BookOpen size={28} className="heading-icon" /></div>
    {!authenticated && <div className="notice"><span>Connect your team to view and edit its shared vocabulary.</span><button className="text-button" onClick={onConnect}>Connect team <ArrowRight size={15} /></button></div>}
    <form className="vocabulary-form" onSubmit={save}><fieldset disabled={!authenticated || saving}><div className="settings-row"><div><h2>Team name</h2><p>Shown on every presenter’s control screen.</p></div><div><label className="sr-only" htmlFor="team-name">Team name</label><input id="team-name" value={name} onChange={event => { setDirty(true); setName(event.target.value); }} maxLength={80} required /></div></div>
      <div className="settings-row"><div><h2>Names & technical terms</h2><p>Help recognize products, people, and acronyms. Use one term per line.</p></div><div><label className="sr-only" htmlFor="terms">Names and technical terms</label><textarea id="terms" rows={5} value={terms} onChange={event => { setDirty(true); setTerms(event.target.value); }} placeholder={'Your company name\nYour product name\nA technical acronym'} maxLength={12000} /></div></div>
      <div className="settings-row"><div><h2>Preferred translations</h2><p>One source = target pair per line. Keep names unchanged with GitHub = GitHub.</p></div><div><label className="sr-only" htmlFor="translations">Preferred translations</label><textarea id="translations" rows={4} value={translations} onChange={event => { setDirty(true); setTranslations(event.target.value); }} placeholder={'English term = 日本語訳\n日本語の用語 = English translation\nGitHub = GitHub'} maxLength={16000} /><p className="field-hint">Add a reverse pair for translation in both directions.</p></div></div>
      <div className="settings-row"><div><h2>Presentation background</h2><p>A short description of what your team is presenting helps with context.</p></div><div><label className="sr-only" htmlFor="background">Presentation background</label><textarea id="background" rows={4} value={background} onChange={event => { setDirty(true); setBackground(event.target.value); }} maxLength={5000} placeholder="For example: A product demonstration for a Japanese engineering team. Keep product names in English." /><span className="character-count">{background.length.toLocaleString()} / 5,000</span></div></div>
      <div className="form-actions"><span>{dirty ? 'Unsaved changes' : 'Shared with your team'}</span><button className="button primary" type="submit">{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{saving ? 'Saving…' : 'Save vocabulary'}</button></div></fieldset>{message && <div className="notice success" role="status"><Check size={18} />{message}</div>}{error && <p className="form-error" role="alert">{error}</p>}</form>
  </section>;
}


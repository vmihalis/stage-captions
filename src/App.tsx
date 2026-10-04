import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ArrowRight, AudioLines, BookOpen, Captions as CaptionsIcon, Check, ChevronRight, CircleHelp, CircleStop, ExternalLink, Globe2, KeyRound, LoaderCircle, LogOut, Mic, Monitor, Play, Radio, Settings2, SlidersHorizontal, Volume2, X } from 'lucide-react';
import { api } from './lib/api';
import { captionTail, parseTranslations } from './lib/captions';
import { toOverlayPayload } from './lib/caption-output';
import { useCaptions } from './hooks/useCaptions';
import type { CaptionPace, TranslationMode } from './lib/speech-config';
import CaptionText from './CaptionText';
import RehearsalSlide from './RehearsalSlide';
import type { Display, OverlayOptions, OverlayPayload, OverlayState, Session, Team } from './types';

const emptyTeam: Team = { name: 'Team captions', glossary: { terms: [], translationTerms: [], background: '' } };
const statusNames = { idle: 'Ready to present', connecting: 'Connecting', live: 'Live captions', rehearsal: 'Rehearsal', reconnecting: 'Reconnecting', stopping: 'Stopping', stopped: 'Session stopped', error: 'Session interrupted' };
const busyStates = ['live', 'connecting', 'reconnecting', 'stopping', 'rehearsal'];

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

export default function App() {
  const [tab, setTab] = useState<'present' | 'vocabulary' | 'setup'>('present');
  const [session, setSession] = useState<Session | null>(null);
  const [team, setTeam] = useState<Team>(emptyTeam);
  const [serverError, setServerError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const [accessCode, setAccessCode] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [deviceId, setDeviceId] = useState('default');
  const [pace, setPace] = useState<CaptionPace>('responsive');
  const [mode, setMode] = useState<TranslationMode>('auto');
  const [previewLayout, setPreviewLayout] = useState<'overlay' | 'reserved'>('reserved');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micChecking, setMicChecking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState('');
  const [displays, setDisplays] = useState<Display[]>([]);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [shortcutRegistered, setShortcutRegistered] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [options, setOptions] = useState<OverlayOptions>({ fontSize: 42, position: 'bottom', showEnglish: false, opacity: 0.9, clickThrough: true });
  const [fontSizeInput, setFontSizeInput] = useState('42');
  const [now, setNow] = useState(Date.now());
  const channelId = useRef(crypto.randomUUID());
  const channel = useRef<BroadcastChannel | null>(null);
  const outputWindow = useRef<Window | null>(null);
  const micCleanup = useRef<(() => void) | null>(null);
  const micGeneration = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const live = useCaptions();
  const desktop = window.stageDesktop;
  const localPreview = import.meta.env.VITE_STAGE_PREVIEW === 'true';
  const shortcut = /Mac/i.test(navigator.platform) ? '⌘⇧H' : 'Ctrl+Shift+H';
  const isBusy = busyStates.includes(live.status);
  const authorized = session?.authenticated ?? false;
  const ready = authorized && session?.provider.configured;
  const interrupted = ['error', 'reconnecting', 'stopping', 'stopped'].includes(live.status);
  const elapsed = live.startedAt ? Math.max(0, (now - live.startedAt) / 1000) : 0;
  const outputPayload: OverlayPayload = toOverlayPayload(live.audienceCaptions, live.status);
  const presenterSpeech = captionTail(live.captions.source + live.captions.partialSource, 500);
  const modeLabel = mode === 'auto' ? 'English ↔ 日本語' : mode === 'ja_to_en' ? '日本語 → English' : 'English → 日本語';
  const outputState = useRef({ payload: outputPayload, options });
  outputState.current = { payload: outputPayload, options };

  const changeFontSize = (value: string) => {
    setFontSizeInput(value);
    const size = Number(value);
    if (value.trim() && Number.isInteger(size) && size >= 24 && size <= 96) {
      setOptions(previous => ({ ...previous, fontSize: size }));
    }
  };
  const finishFontSize = () => {
    const entered = Number(fontSizeInput);
    const size = fontSizeInput.trim() && Number.isFinite(entered)
      ? Math.min(96, Math.max(24, Math.round(entered))) : options.fontSize;
    setFontSizeInput(String(size));
    setOptions(previous => ({ ...previous, fontSize: size }));
  };

  const refresh = useCallback(async () => {
    try {
      const next = await api<Session>('/api/session');
      setSession(next); setServerError('');
      if (next.authenticated) setTeam(await api<Team>('/api/team'));
    } catch (error) { setServerError((error as Error).message); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (connectOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [connectOpen]);
  useEffect(() => {
    const bus = new BroadcastChannel(`stage-${channelId.current}`);
    channel.current = bus;
    const send = () => bus.postMessage({ type: 'caption-state', ...outputState.current });
    bus.onmessage = event => { if (event.data.type === 'ready') send(); };
    const timer = setInterval(() => {
      send();
      if (outputWindow.current?.closed) { outputWindow.current = null; setOverlayOpen(false); }
    }, 1000);
    return () => { clearInterval(timer); bus.close(); outputWindow.current?.close(); };
  }, []);
  useEffect(() => {
    const payload = outputState.current.payload;
    channel.current?.postMessage({ type: 'caption-state', payload, options });
    // Keep the native cache fresh even while hidden/closed so a global shortcut
    // can restore current captions without waiting for another speech result.
    if (desktop) desktop.updateOverlay(payload);
  }, [live.audienceCaptions, live.status, options, overlayOpen, desktop]);
  useEffect(() => {
    if (!desktop) return;
    void desktop.getDisplays().then(setDisplays).catch(() => setNotice('Could not read displays. Reconnect your projector and try opening captions again.'));
    let disposed = false;
    const reflectState = (state: OverlayState) => {
      if (disposed) return;
      setOverlayOpen(state.visible);
      setShortcutRegistered(state.shortcutRegistered);
    };
    const stopClosed = desktop.onOverlayClosed(() => setOverlayOpen(false));
    const stopState = desktop.onOverlayStateChanged?.(reflectState);
    void desktop.getOverlayState?.().then(reflectState).catch(() => setNotice('Could not check caption window visibility. Try showing captions again.'));
    return () => { disposed = true; stopClosed(); stopState?.(); };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    const update = desktop.configureOverlay ? desktop.configureOverlay(options)
      : overlayOpen ? desktop.openOverlay(options) : undefined;
    void update?.catch(() => setNotice('Could not update the caption window. Close it and try again.'));
  }, [options, desktop, overlayOpen]);

  const loadDevices = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')); }
    catch { /* Permission labels may remain unavailable until microphone check. */ }
  }, []);
  useEffect(() => {
    void loadDevices();
    navigator.mediaDevices?.addEventListener('devicechange', loadDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', loadDevices);
      micGeneration.current++; micCleanup.current?.();
    };
  }, [loadDevices]);

  const stopMicCheck = () => { micGeneration.current++; micCleanup.current?.(); micCleanup.current = null; setMicChecking(false); setMicLevel(0); };
  const checkMic = async () => {
    if (micChecking) { stopMicCheck(); return; }
    const generation = ++micGeneration.current;
    setMicError(''); setMicChecking(true);
    let pendingStream: MediaStream | undefined;
    let pendingContext: AudioContext | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs the desktop app or a secure HTTPS connection.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } } });
      pendingStream = stream;
      if (generation !== micGeneration.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const context = new AudioContext();
      pendingContext = context;
      const analyser = context.createAnalyser(); analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
        setMicLevel(Math.min(1, rms * 5));
      }, 80);
      const timeout = setTimeout(stopMicCheck, 10000);
      micCleanup.current = () => { clearInterval(timer); clearTimeout(timeout); stream.getTracks().forEach(track => track.stop()); void context.close(); };
      await loadDevices();
    } catch (error) {
      pendingStream?.getTracks().forEach(track => track.stop());
      if (pendingContext?.state !== 'closed') void pendingContext?.close();
      if (generation !== micGeneration.current) return;
      stopMicCheck(); setMicError((error as Error).name === 'NotAllowedError' ? 'Allow microphone access in your system or browser settings.' : (error as Error).message);
    }
  };

  const openOutput = async () => {
    setNotice('');
    try {
      if (overlayOpen) {
        if (desktop) await desktop.closeOverlay();
        else outputWindow.current?.close();
        setOverlayOpen(false); return;
      }
      if (desktop) {
        setDisplays(await desktop.getDisplays());
        await desktop.openOverlay(options);
        desktop.updateOverlay(outputState.current.payload);
      } else {
        outputWindow.current = window.open(`/captions?channel=${channelId.current}`, 'stage-captions', 'popup,width=1100,height=350');
        if (!outputWindow.current) throw new Error('Allow pop-up windows for Stage, then open captions again.');
      }
      setOverlayOpen(true);
    } catch (error) { setNotice((error as Error).message); }
  };

  const startPresentation = async (rehearsal = false) => {
    if (isBusy || starting) return;
    if (!rehearsal && !authorized) { setConnectOpen(true); return; }
    if (!rehearsal && !ready) { setTab('setup'); return; }
    setStarting(true); setNotice(''); stopMicCheck();
    try {
      if (desktop) {
        desktop.updateOverlay({ english: '', japanese: '', partialJapanese: '', status: 'idle' });
        await desktop.openOverlay(options);
        setOverlayOpen(true);
      }
      if (rehearsal) live.rehearse(mode);
      else live.start(deviceId, pace, mode);
    } catch {
      setNotice('Could not show captions on your screen. Try Show captions on screen before starting again.');
    } finally { setStarting(false); }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault(); setConnecting(true); setConnectError('');
    try {
      await api('/api/auth/unlock', { method: 'POST', body: JSON.stringify({ code: accessCode }) });
      setAccessCode(''); await refresh(); setConnectOpen(false);
    } catch (error) { setConnectError((error as Error).message); }
    finally { setConnecting(false); }
  };

  const logout = async () => {
    await live.stop(); stopMicCheck();
    try { await api('/api/auth/logout', { method: 'POST' }); setTeam(emptyTeam); await refresh(); }
    catch (error) { setNotice((error as Error).message); }
  };

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Stage home"><span className="brand-mark"><CaptionsIcon size={23} strokeWidth={1.8} /></span><strong>Stage</strong><span className="brand-divider" /><span className="workspace-name">{authorized ? team.name : 'Team captions'}</span></a>
      <div className="topbar-actions"><span className="language-pill">{mode === 'ja_to_en' ? <span lang="ja">日本語</span> : 'English'} {mode === 'auto' ? <ArrowLeftRight size={13} /> : <ArrowRight size={13} />} {mode === 'ja_to_en' ? 'English' : <span lang="ja">日本語</span>}</span>
        {authorized ? <button className="quiet connected-button" onClick={logout} title="Disconnect this laptop"><span className="status-dot" /> Team connected <LogOut size={14} /></button> : <button className="button secondary small" onClick={() => setConnectOpen(true)}><KeyRound size={15} /> Connect team</button>}
      </div>
    </header>
    <div className="page-width">
      <nav className="tabs" aria-label="Workspace"><button className={tab === 'present' ? 'active' : ''} onClick={() => setTab('present')}><Radio size={17} /> Present</button><button className={tab === 'vocabulary' ? 'active' : ''} onClick={() => setTab('vocabulary')}><BookOpen size={17} /> Team vocabulary</button><button className={tab === 'setup' ? 'active' : ''} onClick={() => setTab('setup')}><CircleHelp size={17} /> Setup guide</button><span className="platform-label">{desktop ? 'Desktop app' : 'Browser preview'}</span></nav>
      {localPreview && <div className="notice" role="status">Local preview · Run a rehearsal with sample captions and presentation layouts. Live translation and app capture are not configured here.</div>}
      {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={16} /></button></div>}
      {serverError && <div className="notice error" role="alert"><span>{serverError} Rehearsal remains available.</span><button className="text-button" onClick={refresh}>Retry connection</button></div>}
      {tab === 'present' && <>
        <div className="page-heading"><div><h1>Live captions</h1><p>{mode === 'auto' ? 'Speak English or Japanese. Captions translate into the other language.' : mode === 'ja_to_en' ? 'Your voice in Japanese. Your audience follows in English.' : 'Your voice in English. Your audience follows in Japanese.'}</p></div><div className={`session-status ${live.status}`}><span className="status-dot" />{statusNames[live.status]}{isBusy && <span className="timer">{formatTime(elapsed)}</span>}</div></div>
        <div className="present-layout">
          <section className="preview-section" aria-label="Audience caption preview">
            <div className="section-toolbar"><div><Monitor size={17} /><strong>Audience preview</strong></div><span className="field-hint">{desktop ? overlayOpen ? 'On-screen captions shown' : 'On-screen captions hidden' : 'Presenter preview'}</span></div>
            <div className={`stage-preview ${options.position} ${localPreview && previewLayout === 'reserved' ? 'reserved' : ''}`}>
              {localPreview && previewLayout === 'reserved' ? <RehearsalSlide /> : <div className="slide-placeholder" aria-hidden="true"><span className="slide-small-line" /><span className="slide-large-line" /><span className="slide-medium-line" /><div className="slide-chart"><span /><span /><span /><span /><span /></div><p>Your slides or live demo</p></div>}
              <div className="preview-captions" style={{ backgroundColor: `oklch(0.12 0 0 / ${options.opacity})`, '--caption-size': `${options.fontSize}px` } as React.CSSProperties}>
                {live.status === 'rehearsal' && <span className="rehearsal-label">Rehearsal · Sample text · Microphone off</span>}
                {interrupted ? <p className="caption-placeholder">{statusNames[live.status]}</p> : (outputPayload.japanese || outputPayload.partialJapanese) ? <>
                  {options.showEnglish && <p className="caption-source">{outputPayload.english}</p>}
                  <CaptionText final={outputPayload.japanese} partial={outputPayload.partialJapanese} language={outputPayload.translationLanguage} />
                </> : <div className="empty-caption"><CaptionsIcon size={26} /><p>Translated captions will appear here</p><span>{live.status === 'live' ? 'Listening for your voice…' : 'Run a rehearsal to check the layout.'}</span></div>}
              </div>
            </div>
            <div className="preview-footnote"><span><span className={`status-dot ${isBusy ? 'on' : ''}`} /> {live.status === 'rehearsal' ? 'Sample captions. No audio is recorded or sent.' : live.status === 'live' ? 'Microphone audio is being sent to Soniox.' : ['connecting', 'reconnecting'].includes(live.status) ? 'Microphone active. Connecting to the translation service…' : live.status === 'stopping' ? 'Ending the session and releasing the microphone…' : 'Your microphone is off unless you run a check.'}</span><button className="text-button" disabled={!outputPayload.english && !outputPayload.japanese && !outputPayload.partialJapanese} onClick={live.clear}>Clear captions</button></div>
            <div className="transcript-section"><div className="transcript-label"><AudioLines size={17} /> Spoken text <span>Presenter view only</span></div><p className={presenterSpeech ? '' : 'muted'}>{presenterSpeech || 'Recognized speech will appear here once the session starts.'}</p></div>
            {(live.error || micError) && <div className="notice error" role="alert">{live.error || micError}</div>}
            {live.muted && <div className="notice" role="alert">Your microphone is muted by the system or device.</div>}
            {live.status === 'live' && live.lastUpdate && now - live.lastUpdate > 20000 && <div className="notice" role="status">No new words recently. If you are speaking, check the microphone and connection.</div>}
          </section>
          <aside className="session-controls" aria-label="Presentation controls">
            <div className="controls-heading"><h2>Session controls</h2><SlidersHorizontal size={18} /></div>
            <label className="field-label" htmlFor="translation-mode">Translation</label>
            <select id="translation-mode" value={mode} disabled={isBusy || starting} aria-describedby="translation-mode-hint" onChange={event => setMode(event.target.value as TranslationMode)}><option value="auto">Automatic · English ↔ Japanese</option><option value="en_to_ja">English → Japanese</option><option value="ja_to_en">Japanese → English</option></select>
            <p className="field-hint" id="translation-mode-hint">{mode === 'auto' ? 'Follows the sentence language, including mixed-language speech. Short phrases may be misidentified; choose a fixed direction if needed.' : 'Captions stay in the selected audience language. English names and technical terms can still appear in Japanese speech.'} Choose before starting captions.</p>
            <label className="field-label" htmlFor="microphone">Microphone</label>
            <div className="select-with-icon"><Mic size={17} /><select id="microphone" value={deviceId} disabled={isBusy || micChecking} onChange={event => setDeviceId(event.target.value)}><option value="default">System default microphone</option>{devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>
            <div className="mic-check-row"><div className="level-meter" aria-label={micChecking ? 'Microphone input level' : 'Microphone check inactive'}>{Array.from({ length: 16 }, (_, index) => <i key={index} className={micChecking && index / 16 < micLevel ? 'lit' : ''} />)}</div><button className="text-button" disabled={isBusy} onClick={checkMic}>{micChecking ? 'Stop check' : 'Check mic'}</button></div>
            {micChecking && <p className="field-hint">Local check only. Stops after 10 seconds.</p>}
            <label className="field-label" htmlFor="caption-pace">Caption pace</label>
            <select id="caption-pace" value={pace} disabled={isBusy || starting} aria-describedby="caption-pace-hint" onChange={event => setPace(event.target.value as CaptionPace)}><option value="responsive">Responsive</option><option value="context">More context</option></select>
            <p className="field-hint" id="caption-pace-hint">{pace === 'responsive' ? 'Earlier phrase boundaries. Draft words may change as you speak.' : 'Waits longer for complete phrases. Useful if you pause mid-sentence.'} Choose before starting captions.</p>
            <div className="control-separator" />
            {localPreview && <><label className="field-label" htmlFor="preview-layout">Layout preview</label><select id="preview-layout" value={previewLayout} onChange={event => setPreviewLayout(event.target.value as 'overlay' | 'reserved')}><option value="reserved">Reserved caption strip</option><option value="overlay">Floating overlay</option></select><p className="field-hint">Sample layout only. Reserved space fits the whole slide above or below captions. Live app capture has not been added.</p></>}
            <label className="field-label" htmlFor="display">Caption output</label>
            {desktop ? <select id="display" value={options.displayId ?? ''} onFocus={() => void desktop.getDisplays().then(setDisplays)} onChange={event => setOptions({ ...options, displayId: event.target.value || undefined })}><option value="">Primary display</option>{displays.map(display => <option key={display.id} value={display.id}>{display.label} · {display.width} × {display.height}</option>)}</select> : <div className="browser-output"><Monitor size={18} /><div><strong>Separate browser window</strong><span>Use the desktop app to float captions over slides.</span></div></div>}
            <button className="button secondary full" onClick={() => void openOutput()} aria-pressed={overlayOpen}><ExternalLink size={17} />{overlayOpen ? 'Hide captions' : desktop ? 'Show captions on screen' : 'Open caption window'}</button>
            {desktop && <p className="field-hint">{shortcutRegistered === false ? 'Shortcut unavailable: another app may be using it. Use this button' : `${shortcut} · ${shortcutRegistered === null ? 'hide/show an open caption window' : 'show/hide captions'}`}. Hiding keeps the microphone on.</p>}
            <p className="field-hint">Old captions clear after 6 seconds without new words. Listening continues.</p>
            <div className="field-pair"><div><label className="field-label" htmlFor="position">Position</label><select id="position" value={options.position} onChange={event => setOptions({ ...options, position: event.target.value as 'top' | 'bottom' })}><option value="bottom">Bottom</option><option value="top">Top</option></select></div><div><label className="field-label" htmlFor="font-size">Text size (px)</label><input id="font-size" type="number" min="24" max="96" step="1" inputMode="numeric" value={fontSizeInput} aria-describedby="font-size-hint" onChange={event => changeFontSize(event.target.value)} onBlur={finishFontSize} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><p className="field-hint" id="font-size-hint">24–96 px</p></div></div>
            <label className="check-label"><input type="checkbox" checked={options.showEnglish} onChange={event => setOptions({ ...options, showEnglish: event.target.checked })} /><span>Also show spoken text</span></label>
            <label className="range-label" htmlFor="opacity"><span>Background opacity</span><output>{Math.round(options.opacity * 100)}%</output></label><input id="opacity" type="range" min="0.4" max="1" step="0.05" value={options.opacity} onChange={event => setOptions({ ...options, opacity: Number(event.target.value) })} />
            <div className="control-separator" />
            {isBusy ? <button className="button stop full" disabled={live.status === 'stopping'} onClick={() => void live.stop()}><CircleStop size={18} />{live.status === 'stopping' ? 'Stopping…' : live.status === 'rehearsal' ? 'Stop rehearsal' : 'Stop captions'}</button> : <button className="button primary full" disabled={starting} onClick={() => void startPresentation()}><Mic size={18} />{starting ? 'Preparing captions…' : !authorized ? 'Connect team to go live' : !ready ? 'Finish live setup' : 'Start captions'}</button>}
            <button className="button secondary full" disabled={isBusy || starting} onClick={() => void startPresentation(true)}><Play size={16} /> Run a rehearsal</button>
            <p className="control-note">{ready ? 'Live translation uses your team’s Soniox account.' : 'Rehearsal works without an account or microphone.'}</p>
          </aside>
        </div>
        <div className="presentation-tip"><Volume2 size={18} /><p>A headset or presenter microphone gives the clearest captions. Do a short rehearsal on the actual projected screen.</p><button className="text-button" onClick={() => setTab('setup')}>Setup guide <ChevronRight size={16} /></button></div>
      </>}
      {tab === 'vocabulary' && <Vocabulary team={team} authenticated={authorized} onConnect={() => setConnectOpen(true)} onSaved={setTeam} />}
      {tab === 'setup' && <SetupGuide session={session} desktop={!!desktop} onConnect={() => setConnectOpen(true)} onRehearse={() => { setTab('present'); void startPresentation(true); }} />}
      <footer><span>Stage <span className="footer-dot">·</span> {modeLabel}</span><span>{session?.provider.configured ? `Soniox · ${session.provider.region === 'jp' ? 'Japan' : session.provider.region === 'eu' ? 'Europe' : 'Global'} region` : 'Live translation not connected'} <span className="footer-dot">·</span> Captions stay in this session</span></footer>
    </div>
    <dialog ref={dialogRef} className="connect-dialog" onCancel={() => { setConnectOpen(false); setAccessCode(''); }} onClose={() => setConnectOpen(false)}><form onSubmit={unlock}><div className="dialog-heading"><span className="brand-mark"><KeyRound size={22} /></span><button type="button" className="icon-button" onClick={() => { setConnectOpen(false); setAccessCode(''); }} aria-label="Close team connection"><X size={20} /></button></div><h2>Connect your team</h2><p>Enter the shared access code from your organizer. This laptop will stay connected for seven days.</p><label className="field-label" htmlFor="team-code">Team access code</label><input autoFocus id="team-code" type="password" autoComplete="off" required maxLength={256} value={accessCode} onChange={event => setAccessCode(event.target.value)} placeholder="Enter your team code" />{connectError && <p className="form-error" role="alert">{connectError}</p>}<button className="button primary full" disabled={connecting}>{connecting ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{connecting ? 'Connecting…' : 'Connect team'}</button><p className="dialog-footnote">No individual account needed. Your organizer manages the translation account.</p></form></dialog>
  </div>;
}

function Vocabulary({ team, authenticated, onConnect, onSaved }: { team: Team; authenticated: boolean; onConnect: () => void; onSaved: (team: Team) => void }) {
  const [name, setName] = useState(team.name);
  const [terms, setTerms] = useState(team.glossary.terms.join('\n'));
  const [translations, setTranslations] = useState(team.glossary.translationTerms.map(pair => `${pair.source} = ${pair.target}`).join('\n'));
  const [background, setBackground] = useState(team.glossary.background);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setName(team.name); setTerms(team.glossary.terms.join('\n')); setTranslations(team.glossary.translationTerms.map(pair => `${pair.source} = ${pair.target}`).join('\n')); setBackground(team.glossary.background); }, [team]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setMessage(''); setSaving(true);
    try {
      const next = { name: name.trim(), glossary: { terms: terms.split('\n').map(value => value.trim()).filter(Boolean), translationTerms: parseTranslations(translations), background: background.trim() } };
      await api('/api/team', { method: 'PATCH', body: JSON.stringify(next) });
      onSaved(next); setMessage('Saved for the team. New sessions will use these terms.');
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  return <section className="settings-page"><div className="page-heading"><div><h1>Team vocabulary</h1><p>Give the translator context before anyone takes the stage.</p></div><BookOpen size={28} className="heading-icon" /></div>
    {!authenticated && <div className="notice"><span>Connect your team to view and edit its shared vocabulary.</span><button className="text-button" onClick={onConnect}>Connect team <ArrowRight size={15} /></button></div>}
    <form className="vocabulary-form" onSubmit={save}><fieldset disabled={!authenticated || saving}><div className="settings-row"><div><h2>Team name</h2><p>Shown on every presenter’s control screen.</p></div><div><label className="sr-only" htmlFor="team-name">Team name</label><input id="team-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></div></div>
      <div className="settings-row"><div><h2>Names & technical terms</h2><p>Help recognize products, people, and acronyms. Use one term per line.</p></div><div><label className="sr-only" htmlFor="terms">Names and technical terms</label><textarea id="terms" rows={5} value={terms} onChange={event => setTerms(event.target.value)} placeholder={'Your company name\nYour product name\nA technical acronym'} maxLength={12000} /></div></div>
      <div className="settings-row"><div><h2>Preferred translations</h2><p>Guide terms in either direction. To keep a name unchanged, use GitHub = GitHub. These are preferences, not guaranteed replacements.</p></div><div><label className="sr-only" htmlFor="translations">Preferred translations</label><textarea id="translations" rows={4} value={translations} onChange={event => setTranslations(event.target.value)} placeholder={'English term = 日本語訳\n日本語の用語 = English translation\nGitHub = GitHub'} maxLength={16000} /><p className="field-hint">One source = target pair per line. Add a separate reverse pair when needed.</p></div></div>
      <div className="settings-row"><div><h2>Presentation background</h2><p>A short description of what your team is presenting helps with context.</p></div><div><label className="sr-only" htmlFor="background">Presentation background</label><textarea id="background" rows={4} value={background} onChange={event => setBackground(event.target.value)} maxLength={5000} placeholder="For example: A product demonstration for a Japanese engineering team. Keep product names in English." /><span className="character-count">{background.length.toLocaleString()} / 5,000</span></div></div>
      <div className="form-actions"><span>Shared with everyone who uses your team code.</span><button className="button primary" type="submit">{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{saving ? 'Saving…' : 'Save vocabulary'}</button></div></fieldset>{message && <div className="notice success" role="status"><Check size={18} />{message}</div>}{error && <p className="form-error" role="alert">{error}</p>}</form>
  </section>;
}

function SetupGuide({ session, desktop, onConnect, onRehearse }: { session: Session | null; desktop: boolean; onConnect: () => void; onRehearse: () => void }) {
  return <section className="settings-page"><div className="page-heading"><div><h1>Ready for the room</h1><p>A short check before your first presentation.</p></div><Settings2 className="heading-icon" size={28} /></div>
    <ol className="setup-steps"><li><span className="step-number">1</span><div><h2>Connect this laptop</h2><p>Your organizer shares the app, a team server address, and one access code. Enter the code once. It is remembered on this laptop for seven days.</p>{session?.authenticated ? <span className="inline-success"><Check size={16} /> Team connected</span> : <button className="button secondary small" onClick={onConnect}><KeyRound size={15} /> Enter team code</button>}</div></li>
      <li><span className="step-number">2</span><div><h2>Choose your microphone and screen</h2><p>Select your headset or presenter microphone. In the desktop app, choose the projected display under Caption output. The caption window floats above your slides and live demos.</p><p className="setup-detail">{desktop ? 'Use Cmd/Ctrl + Shift + H to hide or show the native caption window.' : 'You are in the browser preview. It can open a separate caption page; floating over other applications requires the desktop app.'}</p></div></li>
      <li><span className="step-number">3</span><div><h2>Rehearse on the projector</h2><p>Run a rehearsal to open captions automatically in the desktop app. Check that the back row can read them, then switch between your slides, browser, and demo. Rehearsal uses sample text and keeps your microphone off.</p><button className="button secondary small" onClick={onRehearse}><Play size={15} /> Run a rehearsal</button></div></li>
      <li><span className="step-number">4</span><div><h2>Start captions when you are ready</h2><p>Choose automatic English ↔ Japanese translation, or a fixed audience language. Live mode sends microphone audio to Soniox over the internet. Early wording and detected language may change as more context arrives. Stop captions when you finish.</p></div></li></ol>
    <div className="organizer-note"><Globe2 size={22} /><div><h2>For the organizer</h2><p>{session?.provider.configured ? 'The translation service is configured. Use a real speaker rehearsal to check accent accuracy and delay before the event.' : 'The server needs a Soniox API key before live translation can start. Set SONIOX_API_KEY and SONIOX_REGION on the server, then restart it. Presenters never enter this key.'}</p><p>Publish the team server over HTTPS, and distribute an installer for each operating system. Japan-region processing requires an enabled Soniox regional project. Audio and transcripts are not saved by this app.</p></div></div>
  </section>;
}

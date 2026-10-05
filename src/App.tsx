import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, ArrowRight, Bookmark, BookOpen, Check, ChevronRight, CircleHelp, CircleStop, Ellipsis, Eye, EyeOff, FileText, GripVertical, KeyRound, LoaderCircle, LogOut, Mic, Monitor, PanelsTopLeft, Pause, Play, Settings2, X } from 'lucide-react';
import { api } from './lib/api';
import { readControllerPreferences, saveControllerPreferences } from './lib/controller-preferences';
import { toOverlayPayload } from './lib/caption-output';
import { useCaptions } from './hooks/useCaptions';
import { useMeeting } from './hooks/useMeeting';
import type { CaptionPace, TranslationMode } from './lib/speech-config';
import type { Display, OverlayOptions, OverlayPayload, OverlayState, Session, Team } from './types';

const emptyTeam: Team = { name: 'Team captions', glossary: { terms: [], translationTerms: [], background: '' } };
const statusNames = { idle: 'Ready', connecting: 'Connecting', live: 'Live', rehearsal: 'Rehearsal', reconnecting: 'Reconnecting', stopping: 'Saving', stopped: 'Ready', error: 'Interrupted' };
type Panel = 'language' | 'output' | 'more' | 'settings' | 'connect' | null;
const busyStates = ['live', 'connecting', 'reconnecting', 'stopping', 'rehearsal'];

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

export default function App() {
  const [initial] = useState(readControllerPreferences);
  const [panel, setPanel] = useState<Panel>(null);
  const [nativeCompact, setNativeCompact] = useState(false);
  const [controllerShortcut, setControllerShortcut] = useState(false);
  const [marked, setMarked] = useState(false);
  const [savedDismissed, setSavedDismissed] = useState(false);
  const remoteRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [team, setTeam] = useState<Team>(emptyTeam);
  const [serverError, setServerError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [deviceId, setDeviceId] = useState(initial.deviceId);
  const [pace, setPace] = useState<CaptionPace>(initial.pace);
  const [mode, setMode] = useState<TranslationMode>(initial.mode);
  const [displayMode, setDisplayMode] = useState<'readable' | 'drafts'>(initial.displayMode);
  const [nativeModes, setNativeModes] = useState<string[]>(['overlay']);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micChecking, setMicChecking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState('');
  const [displays, setDisplays] = useState<Display[]>([]);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [shortcutRegistered, setShortcutRegistered] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [options, setOptions] = useState<OverlayOptions>(initial.options);
  const [fontSizeInput, setFontSizeInput] = useState(String(initial.options.fontSize));
  const [now, setNow] = useState(Date.now());
  const channelId = useRef(crypto.randomUUID());
  const channel = useRef<BroadcastChannel | null>(null);
  const outputWindow = useRef<Window | null>(null);
  const micCleanup = useRef<(() => void) | null>(null);
  const micGeneration = useRef(0);
  const selectedWidth = displays.find(display => display.id === options.displayId)?.width ?? displays.find(display => display.primary)?.width ?? 1100;
  const captionWidth = Math.max(300, (options.outputMode === 'window' ? Math.min(selectedWidth, 1100) : selectedWidth) - 140);
  const lineCapacity = { en: Math.min(60, Math.max(8, Math.floor(captionWidth / (options.fontSize * .65)))), ja: Math.min(30, Math.max(8, Math.floor(captionWidth / options.fontSize))) };
  const meeting = useMeeting(session?.authenticated ?? false);
  const live = useCaptions({ maxLineCharacters: lineCapacity, onTokens: meeting.onTokens, onEnded: interrupted => { void meeting.end(interrupted).catch(error => setNotice((error as Error).message)); } });
  const desktop = window.stageDesktop;
  const localPreview = import.meta.env.VITE_STAGE_PREVIEW === 'true' || (['127.0.0.1', 'localhost'].includes(window.location.hostname) && window.location.port === '4318');
  useEffect(() => { if (localPreview) document.title = 'Stage Preview · Live captions'; }, [localPreview]);
  const shortcut = /Mac/i.test(navigator.platform) ? '⌘⇧H' : 'Ctrl+Shift+H';
  const isBusy = busyStates.includes(live.status);
  const authorized = session?.authenticated ?? false;
  const ready = authorized && session?.provider.configured;
  const elapsed = live.startedAt ? Math.max(0, (now - live.startedAt) / 1000) : 0;
  const outputPayload: OverlayPayload = toOverlayPayload(live.audienceCaptions, live.status);
  const modeLabel = mode === 'auto' ? 'EN ⇄ JA' : mode === 'ja_to_en' ? 'JA → EN' : 'EN → JA';
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

  useEffect(() => { void refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
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
    void desktop.getCapabilities?.().then(capabilities => { setNativeModes(capabilities.outputModes); setNativeCompact(!!capabilities.compactController); setControllerShortcut(capabilities.controllerShortcutRegistered === true); setOptions(previous => capabilities.outputModes.includes(previous.outputMode ?? 'overlay') ? previous : { ...previous, outputMode: 'overlay' }); }).catch(() => {});
    void desktop.getDisplays().then(setDisplays).catch(() => setNotice('Could not read displays. Reconnect your projector and try opening captions again.'));
    let disposed = false;
    const reflectState = (state: OverlayState) => {
      if (disposed) return;
      setOverlayOpen(state.visible);
      setShortcutRegistered(state.shortcutRegistered);
      if (state.presentationError) setNotice(state.presentationError);
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
        if (desktop) { if (desktop.toggleOverlay) await desktop.toggleOverlay(); else await desktop.closeOverlay(); }
        else outputWindow.current?.close();
        setOverlayOpen(false); return;
      }
      if (desktop) {
        setDisplays(await desktop.getDisplays());
        const state = await desktop.getOverlayState?.();
        if (state?.open && desktop.toggleOverlay) await desktop.toggleOverlay();
        else await desktop.openOverlay(options);
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
    if (!rehearsal && !authorized) { setPanel('connect'); return; }
    if (!rehearsal && !ready) { setNotice('Your organizer needs to connect Soniox. Rehearsal is available in ⋯.'); return; }
    setStarting(true); setNotice(''); setSavedDismissed(false); stopMicCheck();
    try {
      if (desktop && !overlayOpen) {
        desktop.updateOverlay({ english: '', japanese: '', partialJapanese: '', status: 'idle' });
        await desktop.openOverlay(options);
        setOverlayOpen(true);
      }
      if (!desktop && !overlayOpen) {
        outputWindow.current = window.open(`/captions?channel=${channelId.current}`, 'stage-captions', 'popup,width=1100,height=350');
        if (!outputWindow.current) throw new Error('Allow pop-up windows for Stage, then start again.');
        setOverlayOpen(true);
      }
      setPanel(null);
      if (rehearsal) live.rehearse(mode, displayMode);
      else { await meeting.start(mode); live.start(deviceId, pace, mode, displayMode); }
    } catch (error) {
      if (!rehearsal) await meeting.end(true).catch(() => {});
      setNotice((error as Error).message || 'Could not start captions. Check the selected output and team connection.');
    } finally { setStarting(false); }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault(); setConnecting(true); setConnectError('');
    try {
      await api('/api/auth/unlock', { method: 'POST', body: JSON.stringify({ code: accessCode }) });
      setAccessCode(''); await refresh(); setPanel(null);
    } catch (error) { setConnectError((error as Error).message); }
    finally { setConnecting(false); }
  };

  const logout = async () => {
    try {
      await live.stop(); await meeting.end(); stopMicCheck();
      const saved = await meeting.retry();
      if (saved?.pending || saved?.error) { setNotice('Wait for the transcript to finish saving before disconnecting the team.'); return; }
      await api('/api/auth/logout', { method: 'POST' }); setTeam(emptyTeam); await refresh(); setPanel('connect');
    } catch (error) { setNotice((error as Error).message); }
  };

  const closePanel = useCallback(() => {
    setPanel(null); setAccessCode(''); setConnectError('');
    triggerRef.current?.focus();
  }, []);
  const togglePanel = (next: Exclude<Panel, null>) => {
    if (panel === next) { closePanel(); return; }
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  };
  const openWorkspace = async (view: 'meetings' | 'vocabulary' | 'setup', meetingId?: string) => {
    try {
      if (desktop?.openWorkspace) await desktop.openWorkspace(view, meetingId);
      else if (desktop) throw new Error('Update the Stage desktop app to open Meetings, Vocabulary, and Help. Your current captions keep running.');
      else {
        const query = new URLSearchParams({ view }); if (meetingId) query.set('meeting', meetingId);
        if (!window.open(`/workspace?${query}`, 'stage-workspace', 'popup,width=1040,height=780')) throw new Error('Allow pop-ups for Stage to open this window.');
      }
      closePanel();
    } catch (error) { setNotice((error as Error).message); }
  };
  const toggleRecording = () => {
    if (['connecting', 'reconnecting', 'stopping'].includes(live.status) || starting) return;
    if (isBusy) {
      if (live.paused) live.resume(); else live.pause();
    } else void startPresentation();
  };
  const endMeeting = async () => {
    if (!isBusy || live.status === 'stopping') return;
    closePanel(); await live.stop();
  };
  const markMoment = async () => {
    try { await meeting.bookmark(); setMarked(true); }
    catch (error) { setNotice((error as Error).message); }
  };
  useEffect(() => {
    saveControllerPreferences({ deviceId, pace, mode, displayMode, options });
  }, [deviceId, pace, mode, displayMode, options]);
  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(() => setMarked(false), 2400); return () => clearTimeout(timer);
  }, [marked]);
  useEffect(() => { if (panel !== 'settings') stopMicCheck(); }, [panel]);
  useEffect(() => {
    if (panel !== 'connect') { setAccessCode(''); setConnectError(''); }
    if (!panel) return;
    const focus = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(panel === 'connect' ? 'input' : 'button, select, input')?.focus());
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closePanel(); } };
    const outside = (event: PointerEvent) => { if (!remoteRef.current?.contains(event.target as Node)) closePanel(); };
    window.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    return () => { cancelAnimationFrame(focus); window.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
  }, [panel, closePanel]);
  useEffect(() => {
    document.documentElement.classList.add('controller-route');
    return () => document.documentElement.classList.remove('controller-route');
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('native-controller', nativeCompact);
    return () => document.documentElement.classList.remove('native-controller');
  }, [nativeCompact]);
  useEffect(() => {
    const node = remoteRef.current;
    if (!node || !nativeCompact || !desktop?.setControllerLayout) return;
    const resize = () => void desktop.setControllerLayout!({ height: Math.ceil(node.getBoundingClientRect().height) + 16 }).catch(() => {});
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    return () => observer.disconnect();
  }, [nativeCompact, desktop]);
  const controllerAction = useRef({ toggleRecording, endMeeting });
  controllerAction.current = { toggleRecording, endMeeting };
  useEffect(() => desktop?.onControllerAction?.(action => {
    if (action === 'settings' || action === 'output') setPanel(action);
    else if (action === 'toggle-recording') controllerAction.current.toggleRecording();
    else if (action === 'end-meeting') void controllerAction.current.endMeeting();
  }), [desktop]);
  useEffect(() => {
    desktop?.updateControllerState?.({ status: live.status, paused: live.paused, pending: meeting.pending });
  }, [desktop, live.status, live.paused, meeting.pending]);

  const saving = meeting.pending > 0 || meeting.saving;
  const statusLabel = live.paused ? 'Paused' : starting ? 'Preparing' : live.status === 'stopping' || (!isBusy && saving) ? 'Saving' : statusNames[live.status];
  const inputLocked = isBusy || starting;
  const canPause = live.status === 'live' || live.status === 'rehearsal';
  const stateTitle = live.paused ? live.status === 'rehearsal' ? 'Rehearsal paused · Microphone off' : 'Speech paused. End to release the mic.' : live.status === 'rehearsal' ? `Sample captions · Microphone off · ${formatTime(elapsed)}` : isBusy ? `Microphone active · ${formatTime(elapsed)}` : saving ? 'Saving the transcript to your team server.' : 'Microphone off';
  const panelTitles: Record<Exclude<Panel, null>, string> = { language: 'Languages', output: 'Caption output', more: 'Stage', settings: 'Settings', connect: 'Connect team' };
  const extendedAvailable = displays.length > 1;
  const savedMeeting = meeting.meeting && meeting.meeting.status !== 'recording' && !saving && !meeting.error && !isBusy;

  return <main className={`controller-page ${nativeCompact ? 'is-native' : ''}`}>
    <div className="remote-shell" ref={remoteRef}>
      {!desktop && <span className="controller-preview">{localPreview ? 'Preview' : 'Browser'}</span>}
      <div className="remote-bar" aria-label="Stage controls">
        <span className="remote-drag" title={desktop ? 'Drag Stage' : 'Stage'} aria-hidden="true"><GripVertical size={16} /></span>
        <button className="remote-start" disabled={starting || (isBusy && !canPause)} onClick={toggleRecording} aria-label={isBusy ? live.paused ? 'Resume captions' : 'Pause captions' : 'Start captions'} title={isBusy ? live.paused ? 'Resume this meeting' : 'Pause speech, keep this meeting open' : 'Start live captions'}>
          {starting || (isBusy && !canPause) ? <LoaderCircle size={17} className="spin" /> : isBusy && !live.paused ? <Pause size={16} /> : live.paused ? <Play size={16} /> : <Mic size={17} />}
          <span>{isBusy ? live.paused ? 'Resume' : 'Pause' : 'Start'}</span>
        </button>
        <span className={`remote-status ${live.paused ? 'paused' : live.status}`} title={stateTitle} aria-live="polite"><i aria-hidden="true" />{statusLabel}</span>
        <span className="remote-divider" aria-hidden="true" />
        <button className="remote-language" onClick={() => togglePanel('language')} title="Translation languages" aria-label={`Translation languages: ${modeLabel}`} aria-expanded={panel === 'language'} aria-controls={panel === 'language' ? 'remote-panel' : undefined}>{modeLabel}</button>
        <button className={`remote-icon ${panel === 'output' ? 'selected' : ''}`} onClick={() => togglePanel('output')} title="Caption output" aria-label="Caption output" aria-expanded={panel === 'output'} aria-controls={panel === 'output' ? 'remote-panel' : undefined}><PanelsTopLeft size={18} /></button>
        <button className={`remote-icon ${marked ? 'marked' : ''}`} disabled={!meeting.meeting || meeting.meeting.status !== 'recording' || live.status === 'rehearsal'} onClick={() => void markMoment()} title={marked ? 'Moment marked' : 'Mark moment'} aria-label={marked ? 'Moment marked' : 'Mark moment'}>{marked ? <Check size={18} /> : <Bookmark size={18} />}</button>
        <button className={`remote-icon ${panel === 'more' ? 'selected' : ''}`} onClick={() => togglePanel('more')} title="More" aria-label="More options" aria-expanded={panel === 'more'} aria-controls={panel === 'more' ? 'remote-panel' : undefined}><Ellipsis size={20} /></button>
      </div>
      {panel && <section className={`remote-panel ${panel === 'more' ? 'remote-menu' : ''}`} ref={panelRef} id="remote-panel" aria-label={panelTitles[panel]}>
        <div className="remote-panel-heading">{panel === 'settings' && <button className="icon-button" aria-label="Back to menu" onClick={() => setPanel('more')}><ArrowLeft size={16} /></button>}<h1>{panelTitles[panel]}</h1><button className="icon-button" aria-label="Close panel" onClick={closePanel}><X size={16} /></button></div>
        {panel === 'language' && <>
          <div className="remote-choices">{([{ id: 'auto', label: 'English ⇄ Japanese', detail: 'Automatic' }, { id: 'en_to_ja', label: 'English → Japanese', detail: '' }, { id: 'ja_to_en', label: 'Japanese → English', detail: '' }] as const).map(item => <button key={item.id} className={mode === item.id ? 'chosen' : ''} disabled={inputLocked} aria-pressed={mode === item.id} onClick={() => { setMode(item.id); closePanel(); }}><ArrowLeftRight size={17} /><span>{item.label}{item.detail && <small>{item.detail}</small>}</span>{mode === item.id && <Check size={16} />}</button>)}</div>
          <p className="remote-hint">{inputLocked ? 'End this meeting to change languages.' : 'Automatic follows the language of each sentence.'}</p>
        </>}
        {panel === 'output' && <>
          <div className="remote-choices output-choices">{([{ id: 'overlay', label: 'Overlay', detail: 'Above your apps', icon: PanelsTopLeft }, { id: 'window', label: 'Window', detail: 'Beside windowed slides', icon: Monitor }, { id: 'presentation', label: 'Slides + strip', detail: 'A separate extended projector', icon: Monitor }] as const).map(item => <button key={item.id} className={options.outputMode === item.id ? 'chosen' : ''} disabled={item.id === 'overlay' ? !desktop : item.id === 'presentation' ? !nativeModes.includes('presentation') || !extendedAvailable : !!desktop && !nativeModes.includes('window')} aria-pressed={options.outputMode === item.id} onClick={() => setOptions(previous => ({ ...previous, outputMode: item.id, ...(item.id === 'presentation' ? { displayId: displays.find(display => !display.primary)?.id } : {}) }))}><item.icon size={18} /><span>{item.label}<small>{item.detail}</small></span>{options.outputMode === item.id && <Check size={16} />}</button>)}</div>
          {desktop ? <label className="remote-field"><span>Screen</span><select aria-label="Caption screen" value={options.displayId ?? ''} onFocus={() => void desktop.getDisplays().then(setDisplays)} onChange={event => setOptions(previous => ({ ...previous, displayId: event.target.value || undefined }))}><option value="">Primary display</option>{displays.filter(display => options.outputMode !== 'presentation' || !display.primary).map(display => <option key={display.id} value={display.id}>{display.label}</option>)}</select></label> : <p className="remote-hint">Desktop Stage adds overlays and projector sharing.</p>}
          {desktop && !nativeModes.includes('window') && <p className="remote-hint">Update Stage to use Window and Slides + strip.</p>}
          {desktop && nativeModes.includes('presentation') && !extendedAvailable && <p className="remote-hint">Connect an extended display for Slides + strip.</p>}
          <button className="button primary full" onClick={() => void openOutput()}>{overlayOpen ? <EyeOff size={17} /> : <Eye size={17} />}{overlayOpen ? 'Hide captions' : options.outputMode === 'presentation' ? 'Choose content' : 'Show captions'}</button>
          <p className="remote-hint">{options.outputMode === 'window' ? 'Use windowed slides to leave room for captions.' : options.outputMode === 'presentation' ? 'Stage shares your chosen app with space for captions.' : desktop ? shortcutRegistered === false ? 'Caption shortcut unavailable. Use Show captions.' : `${shortcut} to show or hide captions.` : 'Allow pop-ups to open the caption window.'}{isBusy && ' Hiding keeps speech active.'}</p>
        </>}
        {panel === 'more' && <>
          <button className="remote-menu-item" onClick={() => setPanel('settings')}><Settings2 size={17} /><span>Settings</span><ChevronRight size={15} /></button>
          <button className="remote-menu-item" onClick={() => void openWorkspace('meetings', meeting.meeting?.id)}><FileText size={17} /><span>Meetings</span></button>
          <button className="remote-menu-item" onClick={() => void openWorkspace('vocabulary')}><BookOpen size={17} /><span>Vocabulary</span></button>
          <button className="remote-menu-item" disabled={inputLocked} onClick={() => void startPresentation(true)}><Play size={17} /><span>Rehearse</span><small>Mic off</small></button>
          <button className="remote-menu-item" onClick={() => void openWorkspace('setup')}><CircleHelp size={17} /><span>Help</span></button>
          {desktop?.hideController && <button className="remote-menu-item" onClick={() => { closePanel(); void desktop.hideController!(); }}><EyeOff size={17} /><span>Hide remote</span><small>{controllerShortcut ? /Mac/i.test(navigator.platform) ? '⌘⇧B' : 'Ctrl⇧B' : 'Tray'}</small></button>}
          <div className="remote-separator" />
          {isBusy ? <button className="remote-menu-item destructive" disabled={live.status === 'stopping'} onClick={() => void endMeeting()}><CircleStop size={17} /><span>{live.status === 'rehearsal' ? 'End rehearsal' : 'End & save'}</span><small>{formatTime(elapsed)}</small></button> : <button className="remote-menu-item" onClick={() => setPanel('connect')}><KeyRound size={17} /><span>{authorized ? team.name : 'Connect team'}</span>{authorized && <Check size={16} />}</button>}
          <p className="remote-hint privacy-note">{isBusy && live.status !== 'rehearsal' ? 'Transcript shared with your team.' : 'Live transcripts are shared with your team.'}</p>
        </>}
        {panel === 'settings' && <>
          <label className="remote-field stacked"><span>Microphone</span><select aria-label="Microphone" value={deviceId} disabled={inputLocked || micChecking} onChange={event => setDeviceId(event.target.value)}><option value="default">System default</option>{devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label>
          <div className="mic-check-row"><div className="level-meter" aria-label={micChecking ? 'Microphone input level' : 'Microphone check inactive'}>{Array.from({ length: 20 }, (_, index) => <i key={index} className={micChecking && index / 20 < micLevel ? 'lit' : ''} />)}</div><button className="text-button" disabled={inputLocked} onClick={() => void checkMic()}>{micChecking ? 'Stop check' : 'Check mic'}</button></div>
          {micChecking && <p className="remote-hint" role="status">Listening locally · Stops in 10 seconds</p>}
          <details className="remote-details" open><summary>Caption style</summary><div className="remote-detail-fields">
            <label className="remote-field"><span>Text size</span><div className="size-field"><input aria-label="Text size in pixels" title="24–96 px" type="number" min="24" max="96" step="1" inputMode="numeric" value={fontSizeInput} onChange={event => changeFontSize(event.target.value)} onBlur={finishFontSize} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><span>px</span></div></label>
            <label className="remote-field"><span>Position</span><select aria-label="Caption position" value={options.position} onChange={event => setOptions(previous => ({ ...previous, position: event.target.value as 'top' | 'bottom' }))}><option value="bottom">Bottom</option><option value="top">Top</option></select></label>
            <label className="remote-field opacity-field"><span>Background <small>{Math.round(options.opacity * 100)}%</small></span><input aria-label="Background opacity" type="range" min="0.4" max="1" step="0.05" value={options.opacity} onChange={event => setOptions(previous => ({ ...previous, opacity: Number(event.target.value) }))} /></label>
            <label className="check-label"><input type="checkbox" checked={options.showEnglish} onChange={event => setOptions(previous => ({ ...previous, showEnglish: event.target.checked }))} /><span>Also show spoken text</span></label>
          </div></details>
          <details className="remote-details"><summary>Reading & speed</summary><div className="remote-detail-fields">
            <label className="remote-field"><span>Reading</span><select aria-label="Audience reading" value={displayMode} disabled={inputLocked} onChange={event => setDisplayMode(event.target.value as 'readable' | 'drafts')}><option value="readable">Steady phrases</option><option value="drafts">Live drafts</option></select></label>
            <p className="remote-hint">{displayMode === 'readable' ? 'Final phrases stay still for easier reading.' : 'Fast updates. Words can change while you speak.'}</p>
            <label className="remote-field"><span>Processing</span><select aria-label="Speech processing" value={pace} disabled={inputLocked} onChange={event => setPace(event.target.value as CaptionPace)}><option value="responsive">Responsive</option><option value="context">More context</option></select></label>
            {inputLocked && <p className="remote-hint">End this meeting to change reading or processing.</p>}
          </div></details>
          <button className="remote-menu-item" disabled={!outputPayload.english && !outputPayload.japanese && !outputPayload.partialJapanese} onClick={live.clear}><X size={16} /><span>Clear visible captions</span></button>
          <button className="remote-menu-item" onClick={() => setPanel('connect')}><KeyRound size={16} /><span>{authorized ? team.name : 'Connect team'}</span><ChevronRight size={15} /></button>
        </>}
        {panel === 'connect' && (authorized ? <>
          <div className="remote-team"><span className="status-dot on" /><strong>{team.name}</strong><span>Connected</span></div>
          <p className="remote-hint">Live audio goes to Soniox. Transcripts are shared with everyone holding the team code.</p>
          <button className="button secondary full" disabled={inputLocked || saving} onClick={() => void logout()}><LogOut size={16} />Disconnect this computer</button>
          {(inputLocked || saving) && <p className="remote-hint">End and save this meeting before disconnecting.</p>}
        </> : <form onSubmit={unlock}>
          <label className="field-label" htmlFor="team-code">Team access code</label><input id="team-code" type="password" autoComplete="off" required maxLength={256} value={accessCode} onChange={event => setAccessCode(event.target.value)} placeholder="From your organizer" />
          {connectError && <p className="form-error" role="alert">{connectError}</p>}
          <button className="button primary full" disabled={connecting}>{connecting ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{connecting ? 'Connecting…' : 'Connect'}</button>
          <p className="remote-hint">Shared access for 7 days. No individual account.</p>
        </form>)}
      </section>}
      {notice && <div className="remote-alert" role="status"><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={15} /></button></div>}
      {serverError && <div className="remote-alert error" role="alert"><span>{serverError}</span><button className="text-button" onClick={() => void refresh()}>Retry</button></div>}
      {meeting.error && <div className="remote-alert error" role="alert"><span>{meeting.error}</span><button className="text-button" onClick={() => void meeting.retry()}>Retry saving</button></div>}
      {(live.error || micError) && <div className="remote-alert error" role="alert"><span>{live.error || micError}</span><button className="text-button" onClick={() => setPanel('settings')}>Settings</button></div>}
      {live.muted && !live.paused && <div className="remote-alert error" role="alert">Your microphone is muted by the system or device.</div>}
      {live.status === 'live' && !live.paused && live.lastUpdate && now - live.lastUpdate > 20000 && <div className="remote-alert" role="status"><span>No new words. Speaking?</span><button className="text-button" onClick={() => setPanel('settings')}>Check mic</button></div>}
      {live.paused && <div className="remote-footnote"><span>{live.status === 'rehearsal' ? 'Rehearsal paused · Microphone off' : 'Speech paused. End to release the mic.'}</span><button className="text-button" onClick={() => void endMeeting()}>{live.status === 'rehearsal' ? 'End rehearsal' : 'End & save'}</button></div>}
      {isBusy && !overlayOpen && <div className="remote-footnote"><span>Captions hidden</span><button className="text-button" onClick={() => void openOutput()}>Show</button></div>}
      {savedMeeting && !savedDismissed && <div className="remote-footnote" role="status"><span><Check size={13} /> Meeting saved</span><button className="text-button" onClick={() => void openWorkspace('meetings', meeting.meeting!.id)}>Review</button><button className="icon-button" aria-label="Dismiss saved meeting" onClick={() => setSavedDismissed(true)}><X size={13} /></button></div>}
      <span className="sr-only" role="status">{marked ? 'Moment marked' : ''}</span>
    </div>
  </main>;
}

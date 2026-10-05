import { useCallback, useEffect, useRef, useState } from 'react';
import { MicrophoneSource, SonioxClient } from '@soniox/client';
import type { Recording, TranscriptionContext } from '@soniox/client';
import { stopRecording } from '../lib/stop-recording';
import { api } from '../lib/api';
import { fallbackTranslationLanguage, speechConfig } from '../lib/speech-config';
import type { CaptionPace, TranslationMode } from '../lib/speech-config';
import { accumulate, emptyCaptions, rehearsalLines } from '../lib/captions';
import { createCaptionDisplay, configureCaptionDisplay, receiveCaptionDisplay, tickCaptionDisplay, clearCaptionDisplay, captionDisplayOutput } from '../lib/caption-display';
import type { Token } from '../lib/captions';
import type { Captions, CaptionStatus } from '../types';

interface TokenResponse { apiKey: string; websocketUrl: string; model: string; context: TranscriptionContext }

export function useCaptions(callbacks: { onTokens?: (tokens: Token[], segment: number) => void; onEnded?: (interrupted: boolean) => void; maxLineCharacters?: { en: number; ja: number } } = {}) {
  const handlers = useRef(callbacks);
  handlers.current = callbacks;
  const segment = useRef(0);
  const recentSource = useRef('');
  const displayConfig = useRef({ mode: 'readable' as 'readable' | 'drafts', fallbackLanguage: 'ja' as 'en' | 'ja' | null, maxLineCharacters: callbacks.maxLineCharacters });
  const [captions, setCaptions] = useState<Captions>(emptyCaptions);
  const [audienceCaptions, setAudienceCaptions] = useState<Captions>(emptyCaptions);
  const audience = useRef(createCaptionDisplay());
  const [status, setStatus] = useState<CaptionStatus>('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const pauseRequested = useRef(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const stopping = useRef(false);
  const recording = useRef<Recording | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const capacity = handlers.current.maxLineCharacters;
    if (!capacity) return;
    displayConfig.current.maxLineCharacters = capacity;
    audience.current = configureCaptionDisplay(audience.current, { maxLineCharacters: capacity });
    setAudienceCaptions(captionDisplayOutput(audience.current));
  }, [callbacks.maxLineCharacters?.en, callbacks.maxLineCharacters?.ja]);

  const resetAudience = useCallback(() => {
    audience.current = createCaptionDisplay(displayConfig.current);
    setAudienceCaptions(captionDisplayOutput(audience.current));
  }, []);

  useEffect(() => {
    if (status !== 'live' && status !== 'rehearsal') return;
    const expiryTimer = setInterval(() => {
      const next = tickCaptionDisplay(audience.current, Date.now());
      if (next === audience.current) return;
      audience.current = next;
      setAudienceCaptions(captionDisplayOutput(next));
    }, 250);
    return () => clearInterval(expiryTimer);
  }, [status]);

  const cancel = useCallback(() => {
    generation.current++;
    pauseRequested.current = false;
    setPaused(false);
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    recording.current?.cancel();
    recording.current = null;
  }, []);

  useEffect(() => {
    const leave = () => cancel();
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); cancel(); };
  }, [cancel]);

  const pause = useCallback(() => {
    if (timer.current) {
      pauseRequested.current = true;
      setPaused(true);
      return;
    }
    // The SDK pauses both microphone capture and audio transmission, finalizes
    // the current phrase, and keeps this same recording/session alive.
    const active = recording.current;
    if (active?.state !== 'recording') return;
    active.pause();
  }, []);

  const resume = useCallback(() => {
    if (timer.current) {
      pauseRequested.current = false;
      setPaused(false);
      return;
    }
    const active = recording.current;
    if (active?.state !== 'paused') return;
    active.resume();
  }, []);

  const stop = useCallback(async () => {
    if (timer.current) {
      cancel();
      setStatus('stopped');
      return;
    }
    const active = recording.current;
    if (!active) { cancel(); setStatus('stopped'); return; }
    stopping.current = true; setStatus('stopping');
    const result = await stopRecording(active);
    cancel(); stopping.current = false; setStatus('stopped'); setMuted(false);
    handlers.current.onEnded?.(result.interrupted);
  }, [cancel]);

  const start = useCallback((deviceId: string, pace: CaptionPace = 'responsive', mode: TranslationMode = 'en_to_ja', displayMode: 'readable' | 'drafts' = 'readable') => {
    cancel();
    const current = generation.current;
    const fallbackLanguage = fallbackTranslationLanguage(mode);
    const initialLanguage = fallbackLanguage ?? 'ja';
    setCaptions(emptyCaptions(initialLanguage));
    displayConfig.current = { mode: displayMode, fallbackLanguage, maxLineCharacters: handlers.current.maxLineCharacters };
    audience.current = createCaptionDisplay(displayConfig.current);
    setAudienceCaptions(captionDisplayOutput(audience.current));
    segment.current = 0; recentSource.current = '';
    setError(''); setStatus('connecting');
    setStartedAt(null); setLastUpdate(null); setMuted(false);
    const client = new SonioxClient({
      config: async () => {
        const config = await api<TokenResponse>('/api/speech/token', { method: 'POST' });
        if (current !== generation.current) throw new Error('Session canceled.');
        return {
          api_key: config.apiKey,
          stt_ws_url: config.websocketUrl,
          stt_defaults: { model: config.model, context: {
            ...config.context,
            // Bounded recent finalized speech helps reconnects; full meeting
            // history is stored separately rather than sent as endless context.
            text: [config.context?.text, recentSource.current && JSON.stringify(config.context).length < 4200 && `Recent speech from this meeting:\n${recentSource.current}`].filter(Boolean).join('\n\n'),
          } },
        };
      },
    });
    const source = new MicrophoneSource({
      constraints: {
        ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
      timesliceMs: 60,
    });
    const active = client.realtime.record({
      model: 'stt-rt-v5',
      source,
      session_config: resolved => speechConfig(resolved.stt_defaults, pace, mode),
      auto_reconnect: true,
      max_reconnect_attempts: 3,
      reconnect_base_delay_ms: 800,
      // Limit the speech backlog after a network break to about six seconds.
      buffer_queue_size: 100,
      reset_transcript_on_reconnect: true,
    });
    recording.current = active;
    const valid = () => current === generation.current;
    active.on('result', result => {
      if (!valid()) return;
      setCaptions(previous => accumulate(previous, result.tokens, fallbackLanguage));
      handlers.current.onTokens?.(result.tokens, segment.current);
      const source = result.tokens.filter(token => token.is_final && token.translation_status !== 'translation' && !/^<(end|fin)>$/.test(token.text)).map(token => token.text).join('');
      recentSource.current = (recentSource.current + source).slice(-1800);
      const next = receiveCaptionDisplay(audience.current, result.tokens, Date.now());
      if (result.tokens.some(token => token.text && !/^<(end|fin)>$/.test(token.text))) setLastUpdate(Date.now());
      audience.current = next;
      setAudienceCaptions(captionDisplayOutput(next));
    });
    active.on('connected', () => { if (valid()) { setStatus('live'); setStartedAt(value => value ?? Date.now()); } });
    active.on('reconnecting', () => { if (valid()) { segment.current++; setStatus('reconnecting'); setCaptions(emptyCaptions()); resetAudience(); } });
    active.on('reconnected', () => { if (valid()) setStatus('live'); });
    active.on('session_restart', () => { if (valid()) { setCaptions(emptyCaptions()); resetAudience(); } });
    active.on('source_muted', () => { if (valid()) setMuted(true); });
    active.on('source_unmuted', () => { if (valid()) setMuted(false); });
    active.on('state_change', ({ new_state }) => {
      if (!valid()) return;
      if (new_state === 'paused' || new_state === 'recording') {
        pauseRequested.current = new_state === 'paused';
        setPaused(pauseRequested.current);
      }
      if (new_state === 'stopped' || new_state === 'canceled') {
        pauseRequested.current = false; setPaused(false);
        setStatus('stopped'); if (!stopping.current) handlers.current.onEnded?.(new_state === 'canceled');
      }
    });
    active.on('error', failure => {
      if (!valid()) return;
      generation.current++;
      pauseRequested.current = false; setPaused(false);
      setStatus('error'); setCaptions(emptyCaptions()); resetAudience();
      const code = 'code' in failure ? String(failure.code) : '';
      if (/permission|denied/i.test(code + failure.name)) setError('Microphone access was denied. Allow it in your system or browser settings, then try again.');
      else if (/device|unavailable/i.test(code + failure.name)) setError('The selected microphone is unavailable. Choose a connected microphone and try again.');
      else setError('The live session could not continue. Check the microphone, network, and team connection, then restart captions.');
      // Do not surface raw provider errors, which may contain request details.
      active.cancel();
      recording.current = null;
      handlers.current.onEnded?.(true);
    });
  }, [cancel, resetAudience]);

  const rehearse = useCallback((mode: TranslationMode = 'en_to_ja', displayMode: 'readable' | 'drafts' = 'readable') => {
    cancel(); setError(''); setMuted(false); setCaptions(emptyCaptions());
    displayConfig.current = { mode: displayMode, fallbackLanguage: fallbackTranslationLanguage(mode), maxLineCharacters: handlers.current.maxLineCharacters };
    resetAudience();
    setStatus('rehearsal'); setStartedAt(Date.now()); setLastUpdate(null);
    let tick = 0;
    const update = () => {
      if (pauseRequested.current) return;
      const index = Math.floor(tick / 60) % rehearsalLines.length;
      const phase = tick % 60;
      const line = rehearsalLines[index];
      const reverse = mode === 'ja_to_en' || (mode === 'auto' && index % 2 === 1);
      const translation = reverse ? line.en : line.ja;
      const source = reverse ? line.ja : line.en;
      if (phase <= 27) {
        const partial = Array.from(translation).slice(0, Math.max(1, Math.ceil(Array.from(translation).length * phase / 27))).join('');
        const tokens: Token[] = [
          { text: source, is_final: phase === 27, language: reverse ? 'ja' : 'en' },
          { text: phase === 27 ? translation : partial, is_final: phase === 27, translation_status: 'translation', language: reverse ? 'en' : 'ja' },
        ];
        setCaptions(previous => accumulate(previous, tokens, fallbackTranslationLanguage(mode)));
        audience.current = receiveCaptionDisplay(audience.current, tokens, Date.now());
        setAudienceCaptions(captionDisplayOutput(audience.current));
        setLastUpdate(Date.now());
      }
      tick++;
    };
    update(); timer.current = setInterval(update, 100);
  }, [cancel, resetAudience]);

  const clear = useCallback(() => {
    setCaptions(emptyCaptions());
    audience.current = clearCaptionDisplay(audience.current, Date.now());
    setAudienceCaptions(captionDisplayOutput(audience.current));
  }, []);

  return { captions, audienceCaptions, status, error, muted, paused, startedAt, lastUpdate, start, stop, pause, resume, rehearse, clear };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { MicrophoneSource, SonioxClient } from '@soniox/client';
import type { Recording, TranscriptionContext } from '@soniox/client';
import { api } from '../lib/api';
import { accumulate, emptyCaptions, rehearsalLines } from '../lib/captions';
import { advanceAudienceCaptions, clearAudienceCaptions, emptyAudienceCaptions, expireAudienceCaptions } from '../lib/audience-captions';
import type { Captions, CaptionStatus } from '../types';

interface TokenResponse { apiKey: string; websocketUrl: string; model: string; context: TranscriptionContext }

export function useCaptions() {
  const [captions, setCaptions] = useState<Captions>(emptyCaptions);
  const [audienceCaptions, setAudienceCaptions] = useState<Captions>(emptyCaptions);
  const audience = useRef(emptyAudienceCaptions());
  const [status, setStatus] = useState<CaptionStatus>('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const recording = useRef<Recording | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const generation = useRef(0);

  const resetAudience = useCallback(() => {
    audience.current = emptyAudienceCaptions();
    setAudienceCaptions(audience.current.captions);
  }, []);

  useEffect(() => {
    if (status !== 'live') return;
    const expiryTimer = setInterval(() => {
      const next = expireAudienceCaptions(audience.current, Date.now());
      if (next === audience.current) return;
      audience.current = next;
      setAudienceCaptions(next.captions);
    }, 250);
    return () => clearInterval(expiryTimer);
  }, [status]);

  const cancel = useCallback(() => {
    generation.current++;
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

  const stop = useCallback(async () => {
    if (timer.current) {
      cancel();
      setStatus('stopped');
      return;
    }
    const active = recording.current;
    if (!active) { cancel(); setStatus('stopped'); return; }
    setStatus('stopping');
    // Bound finalization waiting; cancel always releases microphone and connection.
    const timeout = setTimeout(() => active.cancel(), 3500);
    try { await active.stop(); } catch { /* Cancellation is expected on timeout. */ }
    finally { clearTimeout(timeout); cancel(); setStatus('stopped'); setMuted(false); }
  }, [cancel]);

  const start = useCallback((deviceId: string) => {
    cancel();
    const current = generation.current;
    setCaptions(emptyCaptions()); resetAudience(); setError(''); setStatus('connecting');
    setStartedAt(null); setLastUpdate(null); setMuted(false);
    const client = new SonioxClient({
      config: async () => {
        const config = await api<TokenResponse>('/api/speech/token', { method: 'POST' });
        if (current !== generation.current) throw new Error('Session canceled.');
        return {
          api_key: config.apiKey,
          stt_ws_url: config.websocketUrl,
          stt_defaults: { model: config.model, context: config.context },
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
      session_config: resolved => ({
        ...resolved.stt_defaults,
        model: resolved.stt_defaults?.model ?? 'stt-rt-v5',
        language_hints: ['en'],
        translation: { type: 'one_way', target_language: 'ja' },
        enable_endpoint_detection: true,
      }),
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
      setCaptions(previous => accumulate(previous, result.tokens));
      const next = advanceAudienceCaptions(audience.current, result.tokens, Date.now());
      if (next.lastActivityAt !== null && next.lastActivityAt !== audience.current.lastActivityAt) setLastUpdate(next.lastActivityAt);
      audience.current = next;
      setAudienceCaptions(next.captions);
    });
    active.on('connected', () => { if (valid()) { setStatus('live'); setStartedAt(value => value ?? Date.now()); } });
    active.on('reconnecting', () => { if (valid()) { setStatus('reconnecting'); setCaptions(emptyCaptions()); resetAudience(); } });
    active.on('reconnected', () => { if (valid()) setStatus('live'); });
    active.on('session_restart', () => { if (valid()) { setCaptions(emptyCaptions()); resetAudience(); } });
    active.on('source_muted', () => { if (valid()) setMuted(true); });
    active.on('source_unmuted', () => { if (valid()) setMuted(false); });
    active.on('state_change', ({ new_state }) => {
      if (!valid()) return;
      if (new_state === 'stopped' || new_state === 'canceled') setStatus('stopped');
    });
    active.on('error', failure => {
      if (!valid()) return;
      generation.current++;
      setStatus('error'); setCaptions(emptyCaptions()); resetAudience();
      const code = 'code' in failure ? String(failure.code) : '';
      if (/permission|denied/i.test(code + failure.name)) setError('Microphone access was denied. Allow it in your system or browser settings, then try again.');
      else if (/device|unavailable/i.test(code + failure.name)) setError('The selected microphone is unavailable. Choose a connected microphone and try again.');
      else setError('The live session could not continue. Check the microphone, network, and team connection, then restart captions.');
      // Do not surface raw provider errors, which may contain request details.
      active.cancel();
      recording.current = null;
    });
  }, [cancel, resetAudience]);

  const rehearse = useCallback(() => {
    cancel(); setError(''); setMuted(false); setCaptions(emptyCaptions()); resetAudience();
    setStatus('rehearsal'); setStartedAt(Date.now()); setLastUpdate(null);
    let tick = 0;
    const update = () => {
      const index = Math.floor(tick / 50) % rehearsalLines.length;
      const progress = Math.min((tick % 50) / 27, 1);
      const line = rehearsalLines[index];
      const partial = Array.from(line.ja).slice(0, Math.max(1, Math.ceil(Array.from(line.ja).length * progress))).join('');
      const sample = { english: line.en, partialEnglish: '', japanese: progress === 1 ? line.ja : '', partialJapanese: progress < 1 ? partial : '' };
      setCaptions(sample); setAudienceCaptions(sample);
      setLastUpdate(Date.now()); tick++;
    };
    update(); timer.current = setInterval(update, 100);
  }, [cancel, resetAudience]);

  const clear = useCallback(() => {
    setCaptions(emptyCaptions());
    audience.current = clearAudienceCaptions(audience.current);
    setAudienceCaptions(audience.current.captions);
  }, []);

  return { captions, audienceCaptions, status, error, muted, startedAt, lastUpdate, start, stop, rehearse, clear };
}

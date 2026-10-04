import { useEffect, useState } from 'react';
import { Maximize, X } from 'lucide-react';
import type { OverlayOptions, OverlayPayload } from './types';
import JapaneseCaption from './JapaneseCaption';

export default function CaptionWindow() {
  const [payload, setPayload] = useState<OverlayPayload>({ english: '', japanese: '', status: 'idle' });
  const [options, setOptions] = useState<OverlayOptions>({ fontSize: 42, position: 'bottom', showEnglish: true, opacity: 0.9, clickThrough: false });
  const [offline, setOffline] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  useEffect(() => {
    document.title = 'Stage · Caption output';
    const id = new URLSearchParams(window.location.search).get('channel');
    if (!id) { setOffline(true); return; }
    const channel = new BroadcastChannel(`stage-${id}`);
    let lastSeen = Date.now();
    channel.onmessage = event => {
      if (event.data.type !== 'caption-state') return;
      setPayload(event.data.payload); setOptions(event.data.options);
      setOffline(false); lastSeen = Date.now();
    };
    channel.postMessage({ type: 'ready' });
    const timer = setInterval(() => { if (Date.now() - lastSeen > 4500) setOffline(true); }, 1000);
    return () => { clearInterval(timer); channel.close(); };
  }, []);
  const inactive = offline || ['stopped', 'error', 'reconnecting'].includes(payload.status);
  return <main className={`caption-output ${options.position}`} style={{ '--caption-size': `${options.fontSize}px` } as React.CSSProperties}>
    <div className="output-toolbar"><span>Stage / Caption output</span><div>
      <button onClick={() => document.documentElement.requestFullscreen().catch(() => setFullscreenError('Fullscreen is unavailable. Maximize this window instead.'))}><Maximize size={16} /> Fullscreen</button>
      <button onClick={() => window.close()} aria-label="Close caption window"><X size={18} /></button>
    </div></div>
    {fullscreenError && <p className="output-notice">{fullscreenError}</p>}
    <div className="output-caption" style={{ backgroundColor: `oklch(0.14 0 0 / ${options.opacity})` }}>
      {payload.status === 'rehearsal' && <span className="rehearsal-label">Rehearsal · Sample text · Microphone off</span>}
      {inactive ? <p className="output-state">{offline ? 'Presenter disconnected' : payload.status === 'reconnecting' ? 'Reconnecting…' : payload.status === 'error' ? 'Captions interrupted' : 'Captions stopped'}</p> : <>
        {options.showEnglish && <p className="caption-english">{payload.english}</p>}
        <JapaneseCaption final={payload.japanese} partial={payload.partialJapanese} />
        {!payload.japanese && !payload.partialJapanese && <p className="output-state">Waiting for captions</p>}
      </>}
    </div>
  </main>;
}

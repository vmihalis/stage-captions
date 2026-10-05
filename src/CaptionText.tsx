import { useLayoutEffect, useRef } from 'react';
import type { CaptionLanguage } from './types';

export default function CaptionText({ final = '', partial = '', language = 'ja', stableLines }: { final?: string; partial?: string; language?: CaptionLanguage; stableLines?: string[] }) {
  const element = useRef<HTMLParagraphElement>(null);
  const fixed = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = fixed.current;
    if (!node || !stableLines) return;
    const fit = () => {
      const lines = Array.from(node.querySelectorAll<HTMLElement>('.stable-caption-line > span'));
      const widest = Math.max(1, ...lines.map(line => line.scrollWidth));
      const scale = Math.min(1, node.clientWidth / widest);
      for (const line of lines) line.style.transform = `scale(${scale})`;
    };
    fit();
    const observer = new ResizeObserver(fit); observer.observe(node);
    void document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [stableLines]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || stableLines) return;
    const revealLatest = () => { node.scrollTop = node.scrollHeight; };
    revealLatest();
    const observer = new ResizeObserver(revealLatest);
    observer.observe(node);
    return () => observer.disconnect();
  }, [final, partial, stableLines]);
  if (stableLines) return <div ref={fixed} className="caption-primary stable-caption" lang={language}>{[0, 1].map(index => <div className="stable-caption-line" key={index}><span>{stableLines[index] || '\u00a0'}</span></div>)}</div>;
  return <p ref={element} className="caption-primary" lang={language}>{final}<span className="partial">{partial}</span></p>;
}

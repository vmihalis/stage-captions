import { useLayoutEffect, useRef } from 'react';
import type { CaptionLanguage } from './types';

export default function CaptionText({ final = '', partial = '', language = 'ja' }: { final?: string; partial?: string; language?: CaptionLanguage }) {
  const element = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const revealLatest = () => { node.scrollTop = node.scrollHeight; };
    revealLatest();
    const observer = new ResizeObserver(revealLatest);
    observer.observe(node);
    return () => observer.disconnect();
  }, [final, partial]);
  return <p ref={element} className="caption-primary" lang={language}>{final}<span className="partial">{partial}</span></p>;
}

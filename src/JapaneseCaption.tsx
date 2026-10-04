import { useLayoutEffect, useRef } from 'react';

export default function JapaneseCaption({ final = '', partial = '' }: { final?: string; partial?: string }) {
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
  return <p ref={element} className="caption-japanese" lang="ja">{final}<span className="partial">{partial}</span></p>;
}

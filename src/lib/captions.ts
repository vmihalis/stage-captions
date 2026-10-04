import type { Captions } from '../types';

export type Token = { text: string; is_final?: boolean; translation_status?: string; language?: string };
export const emptyCaptions = (): Captions => ({ english: '', japanese: '', partialEnglish: '', partialJapanese: '' });

// Each response replaces the uncommitted hypothesis. Final tokens arrive once.
// Keep source and target independent: translated text may arrive after source endpoints.
export function accumulate(previous: Captions, tokens: Token[]): Captions {
  const next = { ...previous, partialEnglish: '', partialJapanese: '' };
  for (const token of tokens) {
    if (/^<(end|fin)>$/.test(token.text)) continue;
    const translated = token.translation_status === 'translation';
    if (translated && token.language && token.language !== 'ja') continue;
    if (token.is_final) {
      if (translated) next.japanese += token.text;
      else next.english += token.text;
    } else if (translated) next.partialJapanese += token.text;
    else next.partialEnglish += token.text;
  }
  // A session may last hours. The UI is a rolling caption, not a transcript store.
  next.english = next.english.slice(-1600);
  next.japanese = next.japanese.slice(-1000);
  return next;
}

export function captionTail(text: string, max: number): string {
  const trimmed = text.trim();
  if (Array.from(trimmed).length <= max) return trimmed;
  const tail = Array.from(trimmed).slice(-max).join('');
  const boundary = tail.search(/[。！？.!?]\s*/u);
  if (boundary >= 0 && boundary < tail.length * 0.5) return tail.slice(boundary + 1).trim();
  const space = tail.indexOf(' ');
  if (space > 0 && space < 25) return tail.slice(space + 1);
  return tail;
}

export function japaneseWindow(final: string, partial: string, max = 90) {
  const tail = captionTail(final + partial, max);
  const end = (final + partial).trimEnd().length;
  const start = end - tail.length;
  const boundary = Math.max(0, Math.min(tail.length, final.length - start));
  return { japanese: tail.slice(0, boundary), partialJapanese: tail.slice(boundary) };
}

export const rehearsalLines = [
  { en: 'Thank you for joining us today.', ja: '本日はご参加いただき、ありがとうございます。' },
  { en: 'We will start with an overview, then move into a live demonstration.', ja: 'まず概要をご説明し、その後、実際のデモをご覧いただきます。' },
  { en: 'Our team works across different countries and time zones.', ja: '私たちのチームは、さまざまな国やタイムゾーンで働いています。' },
  { en: 'Please feel free to ask questions at the end.', ja: '最後に、どうぞお気軽にご質問ください。' },
];

export function parseTranslations(value: string) {
  return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const at = line.indexOf('=');
    if (at <= 0 || at === line.length - 1) throw new Error('Use one English = Japanese pair per line.');
    const source = line.slice(0, at).trim();
    const target = line.slice(at + 1).trim();
    if (!source || !target) throw new Error('Each preferred translation needs both languages.');
    return { source, target };
  });
}

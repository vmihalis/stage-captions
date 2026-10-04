import type { CaptionLanguage, Captions } from '../types';

export type Token = { text: string; is_final?: boolean; translation_status?: string; language?: string; source_language?: string };
export const emptyCaptions = (translationLanguage: CaptionLanguage = 'ja'): Captions => ({
  source: '', translation: '', partialSource: '', partialTranslation: '', translationLanguage,
});

export function routeCaptionTokens(tokens: Token[], fallbackLanguage: CaptionLanguage | null = 'ja') {
  const routed: { text: string; is_final?: boolean; translationLanguage: CaptionLanguage | null }[] = [];
  for (const token of tokens) {
    if (!token.text || /^<(end|fin)>$/.test(token.text)) continue;
    if (token.translation_status !== 'translation') {
      // Preserve code-switching and borrowed terms as recognized, without guessing from their script.
      routed.push({ text: token.text, is_final: token.is_final, translationLanguage: null });
      continue;
    }
    const language = token.language || fallbackLanguage;
    if (language !== 'en' && language !== 'ja') continue;
    // source_language identifies the spoken language, never the translated output language.
    routed.push({ text: token.text, is_final: token.is_final, translationLanguage: language });
  }
  return routed;
}

// Each text-bearing response replaces the uncommitted hypothesis. Final tokens arrive once.
// Keep source and target independent: translated text may arrive after source endpoints.
export function accumulate(previous: Captions, tokens: Token[], fallbackLanguage: CaptionLanguage | null = 'ja'): Captions {
  // The SDK strips endpoint/finalization markers, leaving an empty result.
  // Such a result carries no replacement text and must not erase the current hypothesis.
  const accepted = routeCaptionTokens(tokens, fallbackLanguage);
  if (!accepted.length) return previous;
  const next = { ...previous, partialSource: '', partialTranslation: '' };
  for (const token of accepted) {
    const translated = token.translationLanguage !== null;
    if (token.translationLanguage && token.translationLanguage !== next.translationLanguage) {
      next.translation = ''; next.partialTranslation = '';
      next.translationLanguage = token.translationLanguage;
    }
    if (token.is_final) {
      if (translated) next.translation += token.text;
      else next.source += token.text;
    } else if (translated) next.partialTranslation += token.text;
    else next.partialSource += token.text;
  }
  // A session may last hours. The UI is a rolling caption, not a transcript store.
  next.source = next.source.slice(-1600);
  next.translation = next.translation.slice(-1000);
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

export function captionWindow(final: string, partial: string, max = 90) {
  const tail = captionTail(final + partial, max);
  const end = (final + partial).trimEnd().length;
  const start = end - tail.length;
  const boundary = Math.max(0, Math.min(tail.length, final.length - start));
  return { final: tail.slice(0, boundary), partial: tail.slice(boundary) };
}

export const rehearsalLines = [
  { en: 'Thank you for joining us today.', ja: '本日はご参加いただき、ありがとうございます。' },
  { en: 'We will demonstrate the GitHub API, then take questions.', ja: 'GitHubのAPIを実演し、その後、ご質問を受け付けます。' },
  { en: 'Our team works across different countries and time zones.', ja: '私たちのチームは、さまざまな国やタイムゾーンで働いています。' },
  { en: 'Please feel free to ask questions at the end.', ja: '最後に、どうぞお気軽にご質問ください。' },
];

export function parseTranslations(value: string) {
  return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const at = line.indexOf('=');
    if (at <= 0 || at === line.length - 1) throw new Error('Use one source = target pair per line.');
    const source = line.slice(0, at).trim();
    const target = line.slice(at + 1).trim();
    if (!source || !target) throw new Error('Each preferred translation needs both languages.');
    return { source, target };
  });
}

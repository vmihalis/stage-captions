import { accumulate, emptyCaptions } from './captions';
import type { Token } from './captions';
import type { Captions } from '../types';

// A pilot reading window, measured from incoming words rather than microphone noise.
export const CAPTION_IDLE_MS = 6000;

export interface AudienceCaptionState {
  captions: Captions;
  lastActivityAt: number | null;
  suppressedEnglish: string;
  suppressedJapanese: string;
}

export function emptyAudienceCaptions(): AudienceCaptionState {
  return { captions: emptyCaptions(), lastActivityAt: null, suppressedEnglish: '', suppressedJapanese: '' };
}

export function clearAudienceCaptions(state: AudienceCaptionState): AudienceCaptionState {
  return {
    captions: emptyCaptions(),
    lastActivityAt: null,
    // The provider may repeat or finalize these hypotheses after they disappear.
    suppressedEnglish: state.captions.partialEnglish || state.suppressedEnglish,
    suppressedJapanese: state.captions.partialJapanese || state.suppressedJapanese,
  };
}

export function expireAudienceCaptions(state: AudienceCaptionState, now: number): AudienceCaptionState {
  if (state.lastActivityAt === null || now - state.lastActivityAt < CAPTION_IDLE_MS) return state;
  return clearAudienceCaptions(state);
}

function excludeExpiredPartial(final: string, partial: string, suppressed: string) {
  if (!suppressed) return { final, partial, suppressed: '' };
  if (suppressed.startsWith(final)) {
    const remaining = suppressed.slice(final.length);
    if (!partial || partial === remaining) return { final: '', partial: '', suppressed: remaining };
    // A revised hypothesis is fresh information, even when translation is late.
    return { final: '', partial, suppressed: '' };
  }
  if (final.startsWith(suppressed)) return { final: final.slice(suppressed.length), partial, suppressed: '' };
  return { final, partial, suppressed: '' };
}

export function advanceAudienceCaptions(previous: AudienceCaptionState, tokens: Token[], now: number): AudienceCaptionState {
  // Also expire here: background scheduling can delay a browser's timer callback.
  const state = expireAudienceCaptions(previous, now);
  const words = tokens.filter(token => !/^<(end|fin)>$/.test(token.text)
    && (token.translation_status !== 'translation' || !token.language || token.language === 'ja'));
  if (!words.some(token => token.text.trim())) return state;

  const incoming = accumulate(emptyCaptions(), words);
  const english = excludeExpiredPartial(incoming.english, incoming.partialEnglish, state.suppressedEnglish);
  const japanese = excludeExpiredPartial(incoming.japanese, incoming.partialJapanese, state.suppressedJapanese);
  const changed = Boolean(english.final.trim() || japanese.final.trim()
    || (english.partial.trim() && english.partial !== state.captions.partialEnglish)
    || (japanese.partial.trim() && japanese.partial !== state.captions.partialJapanese));

  return {
    captions: {
      english: (state.captions.english + english.final).slice(-1600),
      japanese: (state.captions.japanese + japanese.final).slice(-1000),
      partialEnglish: english.partial,
      partialJapanese: japanese.partial,
    },
    lastActivityAt: changed ? now : state.lastActivityAt,
    suppressedEnglish: english.suppressed,
    suppressedJapanese: japanese.suppressed,
  };
}

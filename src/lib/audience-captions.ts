import { accumulate, emptyCaptions, routeCaptionTokens } from './captions';
import type { Token } from './captions';
import type { CaptionLanguage, Captions } from '../types';

// A pilot reading window, measured from incoming words rather than microphone noise.
export const CAPTION_IDLE_MS = 6000;

export interface AudienceCaptionState {
  captions: Captions;
  lastActivityAt: number | null;
  suppressedSource: string;
  suppressedTranslation: Record<CaptionLanguage, string>;
}

export function emptyAudienceCaptions(translationLanguage: CaptionLanguage = 'ja'): AudienceCaptionState {
  return { captions: emptyCaptions(translationLanguage), lastActivityAt: null,
    suppressedSource: '', suppressedTranslation: { en: '', ja: '' } };
}

export function clearAudienceCaptions(state: AudienceCaptionState): AudienceCaptionState {
  return {
    captions: emptyCaptions(state.captions.translationLanguage),
    lastActivityAt: null,
    // The provider may repeat or finalize these hypotheses after they disappear.
    suppressedSource: state.captions.partialSource || state.suppressedSource,
    suppressedTranslation: { ...state.suppressedTranslation,
      [state.captions.translationLanguage]: state.captions.partialTranslation || state.suppressedTranslation[state.captions.translationLanguage] },
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

export function advanceAudienceCaptions(previous: AudienceCaptionState, tokens: Token[], now: number,
  fallbackLanguage: CaptionLanguage | null = 'ja'): AudienceCaptionState {
  // Also expire here: background scheduling can delay a browser's timer callback.
  const state = expireAudienceCaptions(previous, now);
  const words = routeCaptionTokens(tokens, fallbackLanguage);
  if (!words.some(token => token.text.trim())) return state;

  const incoming = accumulate(emptyCaptions(state.captions.translationLanguage), tokens, fallbackLanguage);
  const source = excludeExpiredPartial(incoming.source, incoming.partialSource, state.suppressedSource);
  const runs: { language: CaptionLanguage; final: string; partial: string }[] = [];
  for (const token of words) {
    if (!token.translationLanguage) continue;
    let run = runs.at(-1);
    if (!run || run.language !== token.translationLanguage) {
      run = { language: token.translationLanguage, final: '', partial: '' }; runs.push(run);
    }
    if (token.is_final) run.final += token.text;
    else run.partial += token.text;
  }
  const suppressedTranslation = { ...state.suppressedTranslation };
  let language = state.captions.translationLanguage;
  let final = state.captions.translation;
  let partial = '';
  let changedTranslation = false;
  let acceptedTranslation = false;
  let suppressedOtherLanguage = false;
  for (const run of runs) {
    const suppressed = suppressedTranslation[run.language];
    const next = excludeExpiredPartial(run.final, run.partial, suppressed);
    suppressedTranslation[run.language] = next.suppressed;
    // Consume old finalizations even when another language follows in this result.
    // They must not displace fresh output or suppress a later, genuinely new term.
    if (suppressed && !next.final && !next.partial) {
      suppressedOtherLanguage ||= run.language !== language;
      continue;
    }
    const switched = run.language !== language;
    if (switched) { final = ''; partial = ''; language = run.language; }
    final += next.final;
    partial += next.partial;
    acceptedTranslation = true;
    changedTranslation ||= Boolean(next.final.trim()
      || (next.partial.trim() && (switched || next.partial !== state.captions.partialTranslation)));
  }
  if (!acceptedTranslation && suppressedOtherLanguage && !words.some(token => token.translationLanguage === null)) {
    partial = state.captions.partialTranslation;
  }
  const changed = changedTranslation || Boolean(source.final.trim()
    || (source.partial.trim() && source.partial !== state.captions.partialSource));

  return {
    captions: {
      source: (state.captions.source + source.final).slice(-1600),
      translation: final.slice(-1000),
      partialSource: source.partial,
      partialTranslation: partial,
      translationLanguage: language,
    },
    lastActivityAt: changed ? now : state.lastActivityAt,
    suppressedSource: source.suppressed,
    suppressedTranslation,
  };
}

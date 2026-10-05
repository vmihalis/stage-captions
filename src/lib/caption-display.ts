import type { CaptionLanguage, Captions } from '../types';
import { emptyCaptions, routeCaptionTokens, type Token } from './captions';
import { advanceAudienceCaptions, clearAudienceCaptions, emptyAudienceCaptions,
  expireAudienceCaptions, type AudienceCaptionState } from './audience-captions';

export type CaptionDisplayMode = 'readable' | 'drafts';

export interface CaptionDisplayOptions {
  mode?: CaptionDisplayMode;
  /** Batch provider-final words; elapsed time does not make a draft final. */
  settleMs?: number;
  fallbackLanguage?: CaptionLanguage | null;
  /** The renderer should choose these from its available width and font size. */
  maxLineCharacters?: { en: number; ja: number };
  minDisplayMs?: number;
  maxDisplayMs?: number;
  idleMs?: number;
}

interface DisplayOptions {
  mode: CaptionDisplayMode;
  settleMs: number;
  fallbackLanguage: CaptionLanguage | null;
  maxLineCharacters: { en: number; ja: number };
  minDisplayMs: number;
  maxDisplayMs: number;
  idleMs: number;
}

export interface CaptionCard {
  /** Retains separators so queued cards can be joined without losing words. */
  text: string;
  lines: string[];
  language: CaptionLanguage;
  receivedAt: number;
}

export interface CaptionDisplayState {
  options: DisplayOptions;
  audience: AudienceCaptionState;
  buffer: string;
  bufferLanguage: CaptionLanguage;
  bufferStartedAt: number | null;
  queue: CaptionCard[];
  current: CaptionCard | null;
  shownAt: number | null;
  clearedTranslation: Record<CaptionLanguage, string>;
  now: number;
}

const finite = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
  Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value!)) : fallback;

export function createCaptionDisplay(options: CaptionDisplayOptions = {}): CaptionDisplayState {
  const fallbackLanguage = options.fallbackLanguage === undefined ? 'ja' : options.fallbackLanguage;
  const minDisplayMs = finite(options.minDisplayMs, 1500, 250, 10000);
  return {
    options: {
      mode: options.mode ?? 'readable',
      settleMs: finite(options.settleMs, 600, 0, 2000),
      fallbackLanguage,
      maxLineCharacters: {
        en: Math.floor(finite(options.maxLineCharacters?.en, 60, 8, 120)),
        ja: Math.floor(finite(options.maxLineCharacters?.ja, 30, 8, 60)),
      },
      minDisplayMs,
      maxDisplayMs: Math.max(minDisplayMs, finite(options.maxDisplayMs, 3500, 250, 10000)),
      idleMs: finite(options.idleMs, 6000, 1000, 30000),
    },
    audience: emptyAudienceCaptions(fallbackLanguage ?? 'ja'),
    buffer: '', bufferLanguage: fallbackLanguage ?? 'ja', bufferStartedAt: null,
    queue: [], current: null, shownAt: null, clearedTranslation: { en: '', ja: '' }, now: 0,
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const forbiddenLineStart = /^[、。，．！？!?：:；;）)］\]｝}」』】〉》ぁぃぅぇぉっゃゅょァィゥェォッャュョー]/u;
const forbiddenLineEnd = /[（(［\[｛{「『【〈《]$/u;
const latinWord = /^[\p{Script=Latin}\p{N}_]$/u;

/** Wrap once, before display. Never reflow a visible card when another word arrives. */
function takeLine(text: string, capacity: number) {
  const leading = text.length - text.trimStart().length;
  const units = Array.from(graphemes.segment(text.slice(leading)), item => item.segment);
  if (units.length <= capacity) return { line: text.trim(), consumed: text.length };

  let cut = capacity;
  let lastSpace = -1;
  for (let index = 0; index <= capacity; index++) if (/\s/u.test(units[index])) lastSpace = index;
  if (lastSpace > capacity * 0.3) cut = lastSpace;
  else if (latinWord.test(units[cut - 1]) && latinWord.test(units[cut])) {
    let boundary = cut;
    while (boundary > 0 && latinWord.test(units[boundary - 1])) boundary--;
    if (boundary > capacity * 0.3) cut = boundary;
  }
  // A few common Japanese line-breaking restrictions, not a full typesetting engine.
  while (cut > 1 && (forbiddenLineStart.test(units[cut]) || forbiddenLineEnd.test(units[cut - 1]))) cut--;
  let consumed = leading + units.slice(0, cut).join('').length;
  while (/\s/u.test(text[consumed] ?? '') && consumed < text.length) consumed++;
  return { line: text.slice(0, consumed).trim(), consumed };
}

function cardsFor(text: string, language: CaptionLanguage, receivedAt: number, capacity: number): CaptionCard[] {
  const result: CaptionCard[] = [];
  let remaining = text;
  while (remaining.trim()) {
    const lines: string[] = [];
    let length = 0;
    while (lines.length < 2 && remaining.slice(length).trim()) {
      const line = takeLine(remaining.slice(length), capacity);
      length += line.consumed;
      if (line.line) lines.push(line.line);
    }
    result.push({ text: remaining.slice(0, length), lines, language, receivedAt });
    remaining = remaining.slice(length);
  }
  // Keep trailing spaces in the previous chunk, including between SDK frames.
  if (remaining && result.length) result[result.length - 1].text += remaining;
  return result;
}

/** A display/font change can repack unseen cards without moving the current text. */
export function configureCaptionDisplay(state: CaptionDisplayState,
  options: Pick<CaptionDisplayOptions, 'maxLineCharacters'>): CaptionDisplayState {
  const previous = state.options.maxLineCharacters;
  const maxLineCharacters = {
    en: Math.floor(finite(options.maxLineCharacters?.en, previous.en, 8, 120)),
    ja: Math.floor(finite(options.maxLineCharacters?.ja, previous.ja, 8, 60)),
  };
  if (maxLineCharacters.en === previous.en && maxLineCharacters.ja === previous.ja) return state;
  return { ...state,
    options: { ...state.options, maxLineCharacters },
    queue: state.queue.flatMap(card => cardsFor(card.text, card.language, card.receivedAt, maxLineCharacters[card.language])),
  };
}

function flushBuffer(state: CaptionDisplayState): CaptionDisplayState {
  if (!state.buffer.trim()) return state;
  const queue = [...state.queue];
  const last = queue.at(-1);
  const capacity = state.options.maxLineCharacters[state.bufferLanguage];
  let text = state.buffer;
  let receivedAt = state.bufferStartedAt ?? state.now;
  // Unseen text can still be packed efficiently. A card already on screen is immutable.
  if (last && last.language === state.bufferLanguage && last.lines.length < 2) {
    queue.pop(); text = last.text + text; receivedAt = last.receivedAt;
  }
  queue.push(...cardsFor(text, state.bufferLanguage, receivedAt, capacity));
  return { ...state, queue, buffer: '', bufferStartedAt: null };
}

function readingTime(card: CaptionCard, state: CaptionDisplayState) {
  // Pilot pacing, not a claim about Japanese or second-language reading speed.
  const length = Array.from(graphemes.segment(card.text.trim())).length;
  const desired = length * (card.language === 'ja' ? 120 : 60);
  const normal = Math.max(state.options.minDisplayMs, Math.min(state.options.maxDisplayMs, desired));
  // Reduce optional dwell when behind, but never silently drop a finalized card.
  const oldestWaiting = state.queue[0]?.receivedAt ?? state.bufferStartedAt;
  return oldestWaiting !== null && oldestWaiting !== undefined && state.now - oldestWaiting > 6000
    ? state.options.minDisplayMs : normal;
}

export function tickCaptionDisplay(previous: CaptionDisplayState, now: number): CaptionDisplayState {
  let state = { ...previous, now: Math.max(previous.now, now), audience: expireAudienceCaptions(previous.audience, now) };
  if (state.options.mode === 'drafts') return state;
  if (state.bufferStartedAt !== null && state.now - state.bufferStartedAt >= state.options.settleMs) state = flushBuffer(state);
  if (state.queue.length && (!state.current || state.shownAt === null || state.now - state.shownAt >= readingTime(state.current, state))) {
    const [current, ...queue] = state.queue;
    // Advance at most one card per tick: a suspended/background tab must not skip unread cards.
    state = { ...state, current, queue, shownAt: state.now };
  }
  const lastActivity = Math.max(state.audience.lastActivityAt ?? 0, state.shownAt ?? 0);
  if (state.current && !state.queue.length && !state.buffer.trim() && state.now - lastActivity >= state.options.idleMs) {
    state = { ...state, current: null, shownAt: null };
  }
  return state;
}

// The provider may finalize a hypothesis after Clear. Consume that known prefix
// without resurrecting it; any newly revised words remain eligible. A silence
// timeout alone must not suppress a final that readable mode has never displayed.
function excludeCleared(final: string, partial: string, suppressed: string) {
  if (!suppressed) return { final, suppressed: '' };
  if (suppressed.startsWith(final)) {
    const remaining = suppressed.slice(final.length);
    return { final: '', suppressed: !partial || partial === remaining ? remaining : '' };
  }
  if (final.startsWith(suppressed)) return { final: final.slice(suppressed.length), suppressed: '' };
  return { final, suppressed: '' };
}

export function receiveCaptionDisplay(previous: CaptionDisplayState, tokens: Token[], now: number): CaptionDisplayState {
  let state = tickCaptionDisplay(previous, now);
  const audience = advanceAudienceCaptions(state.audience, tokens, state.now, state.options.fallbackLanguage);
  if (state.options.mode === 'drafts') return { ...state, audience };

  const runs: { language: CaptionLanguage; final: string; partial: string }[] = [];
  for (const token of routeCaptionTokens(tokens, state.options.fallbackLanguage)) {
    if (!token.translationLanguage) continue;
    let run = runs.at(-1);
    if (!run || run.language !== token.translationLanguage) {
      run = { language: token.translationLanguage, final: '', partial: '' }; runs.push(run);
    }
    if (token.is_final) run.final += token.text;
    else run.partial += token.text;
  }
  const suppressed = { ...state.clearedTranslation };
  for (const run of runs) {
    const accepted = excludeCleared(run.final, run.partial, suppressed[run.language]);
    suppressed[run.language] = accepted.suppressed;
    if (!accepted.final) continue;
    if (run.language !== state.bufferLanguage && state.buffer.trim()) state = flushBuffer(state);
    state = { ...state,
      buffer: state.buffer + accepted.final,
      bufferLanguage: run.language,
      bufferStartedAt: state.bufferStartedAt ?? (accepted.final.trim() ? state.now : null),
    };
  }
  return tickCaptionDisplay({ ...state, audience, clearedTranslation: suppressed }, state.now);
}

/** Explicit clear discards queued context; reconnect/direction changes should create a fresh state. */
export function clearCaptionDisplay(state: CaptionDisplayState, now: number): CaptionDisplayState {
  const audience = clearAudienceCaptions(state.audience);
  return { ...state, now: Math.max(state.now, now), audience,
    buffer: '', bufferStartedAt: null, queue: [], current: null, shownAt: null,
    clearedTranslation: {
      en: audience.suppressedTranslation.en || state.clearedTranslation.en,
      ja: audience.suppressedTranslation.ja || state.clearedTranslation.ja,
    } };
}

export function captionDisplayOutput(state: CaptionDisplayState): Captions & { stableLines?: string[]; displayLagMs: number } {
  if (state.options.mode === 'drafts') return { ...state.audience.captions, displayLagMs: 0 };
  const pendingAt = state.queue[0]?.receivedAt ?? state.bufferStartedAt;
  const displayLagMs = Math.max(0,
    state.current && state.shownAt !== null ? state.shownAt - state.current.receivedAt : 0,
    pendingAt !== null ? state.now - pendingAt : 0);
  const current = state.current;
  return {
    ...emptyCaptions(current?.language ?? state.audience.captions.translationLanguage),
    source: state.audience.captions.source,
    partialSource: state.audience.captions.partialSource,
    translation: current?.text.trim() ?? '',
    partialTranslation: '',
    stableLines: current ? [...current.lines] : [],
    displayLagMs,
  };
}

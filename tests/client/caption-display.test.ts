import test from 'node:test';
import assert from 'node:assert/strict';
import { captionDisplayOutput, clearCaptionDisplay, configureCaptionDisplay, createCaptionDisplay, receiveCaptionDisplay,
  tickCaptionDisplay, type CaptionDisplayState } from '../../src/lib/caption-display';
import type { Token } from '../../src/lib/captions';

const translated = (text: string, is_final = true, language = 'en'): Token =>
  ({ text, is_final, language, translation_status: 'translation' });
const normalized = (text: string) => text.replace(/\s/gu, '');
const visible = (state: CaptionDisplayState) => captionDisplayOutput(state).translation;

test('readable mode keeps provisional reordering private, then publishes a frozen final card after one bounded batch window', () => {
  let state = createCaptionDisplay({ fallbackLanguage: null });
  state = receiveCaptionDisplay(state, [translated('We will approve the plan', false)], 100);
  state = receiveCaptionDisplay(state, [translated('We will not approve the plan', false)], 400);
  assert.equal(visible(state), '');
  state = receiveCaptionDisplay(state, [translated('We will not approve the plan.')], 600);
  assert.equal(visible(tickCaptionDisplay(state, 1199)), '');
  state = tickCaptionDisplay(state, 1200);
  assert.equal(visible(state), 'We will not approve the plan.');
  assert.equal(captionDisplayOutput(state).partialTranslation, '');
  const snapshot = JSON.stringify(state);
  const lines = captionDisplayOutput(state).stableLines;
  const revised = receiveCaptionDisplay(state, [translated('But maybe', false)], 1400);
  assert.deepEqual(captionDisplayOutput(revised).stableLines, lines);
  assert.equal(JSON.stringify(state), snapshot, 'transitions must not mutate React ref snapshots');
});

test('continuous final words cannot postpone publication by repeatedly restarting a debounce', () => {
  let state = createCaptionDisplay();
  for (let now = 0; now < 600; now += 100) state = receiveCaptionDisplay(state, [translated(`${now} `)], now);
  state = tickCaptionDisplay(state, 600);
  assert.equal(visible(state), '0 100 200 300 400 500');
  assert.equal(captionDisplayOutput(state).displayLagMs, 600);
});

test('a large finalized burst is paginated without the 1000-character rolling caption truncation', () => {
  const text = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ');
  let state = createCaptionDisplay({ settleMs: 0, maxLineCharacters: { en: 24, ja: 12 }, minDisplayMs: 1000, maxDisplayMs: 1000 });
  state = receiveCaptionDisplay(state, [translated(text)], 10);
  const displayed: string[] = [];
  let now = 10;
  do {
    const output = captionDisplayOutput(state);
    displayed.push(output.translation);
    assert.ok(output.stableLines!.length <= 2);
    assert.ok(output.stableLines!.every(line => Array.from(line).length <= 24));
    if (!state.queue.length) break;
    now += 1000; state = tickCaptionDisplay(state, now);
  } while (displayed.length < 1000);
  assert.equal(normalized(displayed.join('')), normalized(text));
  assert.ok(displayed.length > 30);
});

test('a delayed timer advances one unread card and gives it a new reading window', () => {
  let state = createCaptionDisplay({ settleMs: 0, maxLineCharacters: { en: 8, ja: 8 }, minDisplayMs: 1500 });
  state = receiveCaptionDisplay(state, [translated('one two three four five six seven eight nine ten eleven twelve')], 1);
  const pending = state.queue.length;
  state = tickCaptionDisplay(state, 20000);
  assert.equal(state.queue.length, pending - 1);
  assert.equal(state.shownAt, 20000);
  const text = visible(state);
  assert.equal(visible(tickCaptionDisplay(state, 20001)), text);
});

test('a late final translation receives a fresh reading window after source speech has stopped', () => {
  let state = createCaptionDisplay({ settleMs: 0 });
  state = receiveCaptionDisplay(state, [{ text: 'hello', is_final: true }], 0);
  state = tickCaptionDisplay(state, 6000);
  state = receiveCaptionDisplay(state, [translated('こんにちは。', true, 'ja')], 7000);
  assert.equal(visible(tickCaptionDisplay(state, 12999)), 'こんにちは。');
  assert.equal(visible(tickCaptionDisplay(state, 13000)), '');
});

test('fresh source activity keeps the current card visible while speech continues', () => {
  let state = createCaptionDisplay({ settleMs: 0 });
  state = receiveCaptionDisplay(state, [translated('A visible sentence.')], 0);
  state = receiveCaptionDisplay(state, [{ text: 'Continuing', is_final: false }], 5500);
  state = tickCaptionDisplay(state, 6500);
  assert.equal(visible(state), 'A visible sentence.');
  state = tickCaptionDisplay(state, 11500);
  assert.equal(visible(state), '');
});

test('keepalives and identical drafts neither enqueue words nor extend the idle window', () => {
  let state = createCaptionDisplay({ settleMs: 0 });
  state = receiveCaptionDisplay(state, [translated('Read this.'), translated('Maybe', false)], 0);
  state = receiveCaptionDisplay(state, [translated('Maybe', false)], 3000);
  state = receiveCaptionDisplay(state, [{ text: '<end>' }, { text: '' }], 4500);
  assert.equal(state.queue.length, 0);
  assert.equal(visible(tickCaptionDisplay(state, 6000)), '');
});

test('manual clear flushes queued finals and consumes later finalization of the cleared hypothesis', () => {
  let state = createCaptionDisplay({ settleMs: 0, maxLineCharacters: { en: 8, ja: 8 } });
  state = receiveCaptionDisplay(state, [translated('This is enough text to create several cards.'), translated('Old draft', false)], 0);
  assert.ok(state.queue.length > 0);
  state = clearCaptionDisplay(state, 100);
  assert.equal(state.queue.length, 0);
  state = receiveCaptionDisplay(state, [translated('Old'), translated(' draft', false)], 200);
  assert.equal(visible(state), '');
  state = receiveCaptionDisplay(state, [translated(' draft')], 300);
  assert.equal(visible(state), '');
  state = receiveCaptionDisplay(state, [translated(' Fresh text.')], 400);
  assert.equal(visible(state), 'Fresh text.');
});

test('a silence-expired draft remains eligible when finalized because readable mode has never displayed it', () => {
  let state = createCaptionDisplay({ settleMs: 0 });
  state = receiveCaptionDisplay(state, [translated('Old words', false)], 0);
  state = tickCaptionDisplay(state, 6000);
  state = receiveCaptionDisplay(state, [translated('Old words')], 6500);
  assert.equal(visible(state), 'Old words');
  assert.equal(visible(tickCaptionDisplay(state, 12499)), 'Old words');
  assert.equal(visible(tickCaptionDisplay(state, 12500)), '');
});

test('automatic bilingual turns retain every final card in order and use the card language for the primary output', () => {
  let state = createCaptionDisplay({ fallbackLanguage: null, settleMs: 0, minDisplayMs: 1000, maxDisplayMs: 1000 });
  state = receiveCaptionDisplay(state, [translated('最初の文です。', true, 'ja')], 0);
  state = receiveCaptionDisplay(state, [translated('The GitHub API works.', true, 'en')], 100);
  state = receiveCaptionDisplay(state, [translated('次の文です。', true, 'ja')], 200);
  assert.equal(visible(state), '最初の文です。');
  assert.equal(captionDisplayOutput(state).translationLanguage, 'ja');
  state = tickCaptionDisplay(state, 1000);
  assert.equal(visible(state), 'The GitHub API works.');
  assert.equal(captionDisplayOutput(state).translationLanguage, 'en');
  state = tickCaptionDisplay(state, 2000);
  assert.equal(visible(state), '次の文です。');
  assert.equal(captionDisplayOutput(state).translationLanguage, 'ja');
});

test('unsupported translated metadata in auto mode cannot add a card or switch language', () => {
  let state = createCaptionDisplay({ fallbackLanguage: null, settleMs: 0 });
  state = receiveCaptionDisplay(state, [translated('Keep this.')], 0);
  state = receiveCaptionDisplay(state, [translated('foreign', true, 'fr'), { text: 'missing', is_final: true, translation_status: 'translation' }], 100);
  assert.equal(visible(state), 'Keep this.');
  assert.equal(state.queue.length, 0);
  assert.equal(captionDisplayOutput(state).translationLanguage, 'en');
});

test('live drafts mode retains immediate interim revisions and the existing silence behavior', () => {
  let state = createCaptionDisplay({ mode: 'drafts', fallbackLanguage: null });
  state = receiveCaptionDisplay(state, [translated('Can approve', false)], 0);
  assert.equal(captionDisplayOutput(state).partialTranslation, 'Can approve');
  assert.equal(captionDisplayOutput(state).stableLines, undefined);
  state = receiveCaptionDisplay(state, [translated('Cannot approve', false)], 100);
  assert.equal(captionDisplayOutput(state).partialTranslation, 'Cannot approve');
  assert.equal(captionDisplayOutput(tickCaptionDisplay(state, 6100)).partialTranslation, '');
});

test('Japanese cards preserve borrowed words, grapheme clusters, and all punctuation', () => {
  const text = '日本語でGitHubのAPIを確認します。Jose\u0301さん、ありがとう！次の説明です。';
  let state = createCaptionDisplay({ settleMs: 0, maxLineCharacters: { en: 12, ja: 12 }, minDisplayMs: 1000, maxDisplayMs: 1000 });
  state = receiveCaptionDisplay(state, [translated(text, true, 'ja')], 0);
  const cards = [state.current!, ...state.queue];
  assert.equal(cards.map(card => card.text).join(''), text);
  const lines = cards.flatMap(card => card.lines);
  assert.ok(lines.every(line => !/^[、。！）」』】]/u.test(line)));
  assert.ok(lines.some(line => line.includes('GitHub')));
  assert.ok(lines.some(line => line.includes('Jose\u0301')));
});

test('adding queued content cannot change a card the audience is already reading', () => {
  let state = createCaptionDisplay({ settleMs: 0, maxLineCharacters: { en: 24, ja: 12 } });
  state = receiveCaptionDisplay(state, [translated('A first complete thought.')], 0);
  const current = state.current;
  state = receiveCaptionDisplay(state, [translated(' A second')], 100);
  state = receiveCaptionDisplay(state, [translated(' complete thought.')], 200);
  assert.equal(state.current, current);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].text.trim(), 'A second complete thought.');
});

test('reset for reconnect or an explicit direction change starts empty without retaining a previous queue', () => {
  let state = createCaptionDisplay({ settleMs: 0 });
  state = receiveCaptionDisplay(state, [translated('Previous recording.')], 0);
  state = createCaptionDisplay({ fallbackLanguage: 'en' });
  assert.equal(visible(tickCaptionDisplay(state, 5000)), '');
  assert.equal(state.queue.length, 0);
  assert.equal(captionDisplayOutput(state).translationLanguage, 'en');
});

test('a font or output-width change repacks unread words losslessly while preserving the visible card and pending buffer', () => {
  let state = createCaptionDisplay({ settleMs: 600, fallbackLanguage: null, maxLineCharacters: { en: 30, ja: 20 } });
  state = receiveCaptionDisplay(state, [translated('A first sentence followed by much more final text which needs several separate readable caption cards. More words follow this one.')], 0);
  state = tickCaptionDisplay(state, 600);
  state = receiveCaptionDisplay(state, [translated(' そして日本語の字幕も表示します。この文も失わずに読むことができます。', true, 'ja')], 700);
  state = tickCaptionDisplay(state, 1300);
  state = receiveCaptionDisplay(state, [translated(' A pending phrase')], 1400);
  const before = JSON.stringify(state);
  const resized = configureCaptionDisplay(state, { maxLineCharacters: { en: 12, ja: 8 } });
  assert.equal(JSON.stringify(state), before);
  assert.equal(resized.current, state.current);
  assert.deepEqual(captionDisplayOutput(resized).stableLines, captionDisplayOutput(state).stableLines);
  assert.equal(resized.buffer, state.buffer);
  assert.equal(resized.bufferStartedAt, state.bufferStartedAt);
  assert.equal(resized.audience, state.audience);
  assert.equal(resized.queue.map(card => card.text).join(''), state.queue.map(card => card.text).join(''));
  for (const card of resized.queue) {
    assert.ok(card.lines.length <= 2);
    assert.ok(card.lines.every(line => Array.from(line).length <= (card.language === 'en' ? 12 : 8)));
    assert.ok(state.queue.some(original => original.receivedAt === card.receivedAt && original.language === card.language));
  }
  assert.equal(configureCaptionDisplay(resized, { maxLineCharacters: { en: 12, ja: 8 } }), resized);
});

test('final whitespace preserves its separator without starting a visible-delay timer', () => {
  let state = createCaptionDisplay({ settleMs: 600 });
  state = receiveCaptionDisplay(state, [translated(' ')], 0);
  state = tickCaptionDisplay(state, 10000);
  assert.equal(captionDisplayOutput(state).displayLagMs, 0);
  state = receiveCaptionDisplay(state, [translated('Words')], 10000);
  assert.equal(visible(tickCaptionDisplay(state, 10599)), '');
  assert.equal(visible(tickCaptionDisplay(state, 10600)), 'Words');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, captionTail, emptyCaptions, japaneseWindow, parseTranslations } from '../../src/lib/captions.ts';

test('provisional text is replaced rather than accumulated', () => {
  const first = accumulate(emptyCaptions(), [{ text: 'Thanks', is_final: false, translation_status: 'original' }, { text: 'ありが', is_final: false, translation_status: 'translation', language: 'ja' }]);
  const second = accumulate(first, [{ text: 'Thank you', is_final: true, translation_status: 'original' }, { text: 'ありがとうございます', is_final: false, translation_status: 'translation', language: 'ja' }]);
  assert.equal(second.english, 'Thank you'); assert.equal(second.partialEnglish, '');
  assert.equal(second.japanese, ''); assert.equal(second.partialJapanese, 'ありがとうございます');
});
test('translation arriving after an English endpoint remains visible', () => {
  let state = accumulate(emptyCaptions(), [{ text: 'Hello.', is_final: true, translation_status: 'original' }, { text: '<end>', is_final: true }]);
  state = accumulate(state, [{ text: 'こんにちは。', is_final: true, translation_status: 'translation', language: 'ja' }]);
  assert.equal(state.english, 'Hello.'); assert.equal(state.japanese, 'こんにちは。');
});
test('committed tokens survive partial revisions and ignore control markers', () => {
  let state = accumulate(emptyCaptions(), [{ text: '本日は', is_final: true, translation_status: 'translation' }, { text: 'ご', is_final: false, translation_status: 'translation' }]);
  state = accumulate(state, [{ text: 'ありがとうございます。', is_final: true, translation_status: 'translation' }, { text: '<fin>', is_final: true, translation_status: 'translation' }]);
  assert.equal(state.japanese, '本日はありがとうございます。'); assert.equal(state.partialJapanese, '');
});
test('long sessions retain bounded state and only target language translations', () => {
  const state = accumulate(emptyCaptions(), [{ text: 'x'.repeat(8000), is_final: true }, { text: '日'.repeat(5000), is_final: true, translation_status: 'translation', language: 'ja' }, { text: 'bonjour', is_final: true, translation_status: 'translation', language: 'fr' }]);
  assert.equal(state.english.length, 1600); assert.equal(state.japanese.length, 1000);
});
test('caption rolling window preserves whole Unicode characters', () => {
  assert.equal(captionTail('hello😀😀😀', 3), '😀😀😀');
  assert.equal(captionTail('こんにちは。ありがとうございます。', 12), 'ありがとうございます。');
});
test('glossary pairs reject malformed input instead of silently dropping terms', () => {
  assert.deepEqual(parseTranslations(' Product = 製品\n\nLive demo = 実演'), [{ source: 'Product', target: '製品' }, { source: 'Live demo', target: '実演' }]);
  assert.throws(() => parseTranslations('Product'), /English = Japanese/);
  assert.throws(() => parseTranslations('Product =  '), /English = Japanese|both languages/);
});

test('visible caption budget includes provisional words so newest words are not lost', () => {
  const output = japaneseWindow('日'.repeat(90), '最新の言葉', 12);
  assert.equal(output.partialJapanese, '最新の言葉');
  assert.equal(Array.from(output.japanese + output.partialJapanese).length, 12);
  const partialOnly = japaneseWindow('', 'あ'.repeat(120), 12);
  assert.equal(partialOnly.japanese, ''); assert.equal(partialOnly.partialJapanese.length, 12);
  assert.deepEqual(japaneseWindow('本日は', 'ありがとう  '), { japanese: '本日は', partialJapanese: 'ありがとう' });
});

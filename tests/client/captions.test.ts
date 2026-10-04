import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, captionTail, emptyCaptions, captionWindow, parseTranslations } from '../../src/lib/captions.ts';

test('provisional text is replaced rather than accumulated', () => {
  const first = accumulate(emptyCaptions(), [{ text: 'Thanks', is_final: false, translation_status: 'original' }, { text: 'ありが', is_final: false, translation_status: 'translation', language: 'ja' }]);
  const second = accumulate(first, [{ text: 'Thank you', is_final: true, translation_status: 'original' }, { text: 'ありがとうございます', is_final: false, translation_status: 'translation', language: 'ja' }]);
  assert.equal(second.source, 'Thank you'); assert.equal(second.partialSource, '');
  assert.equal(second.translation, ''); assert.equal(second.partialTranslation, 'ありがとうございます');
});
test('empty and control-only results preserve provisional captions until replacement text arrives', () => {
  let state = accumulate(emptyCaptions(), [
    { text: 'Today ', is_final: true, translation_status: 'original' },
    { text: 'we are', is_final: false, translation_status: 'original' },
    { text: '本日は', is_final: true, translation_status: 'translation', language: 'ja' },
    { text: 'ご紹介', is_final: false, translation_status: 'translation', language: 'ja' },
  ]);
  const beforeControl = { ...state };
  for (const tokens of [[], [{ text: '<end>', is_final: true }],
    [{ text: '<fin>', is_final: true }, { text: '<end>', is_final: true }, { text: '' }]]) {
    state = accumulate(state, tokens);
    assert.deepEqual(state, beforeControl);
  }

  state = accumulate(state, [
    { text: 'we introduce', is_final: false, translation_status: 'original' },
    { text: '新しい製品を紹介', is_final: false, translation_status: 'translation', language: 'ja' },
  ]);
  assert.equal(state.partialSource, 'we introduce');
  assert.equal(state.partialTranslation, '新しい製品を紹介');
  state = accumulate(state, [
    { text: 'we introduce a product.', is_final: true, translation_status: 'original' },
    { text: '新しい製品を紹介します。', is_final: true, translation_status: 'translation', language: 'ja' },
    { text: '<end>', is_final: true },
  ]);
  assert.deepEqual(state, { source: 'Today we introduce a product.', translation: '本日は新しい製品を紹介します。',
    partialSource: '', partialTranslation: '', translationLanguage: 'ja' });
});
test('text-bearing results still replace the whole provisional hypothesis', () => {
  const previous = accumulate(emptyCaptions(), [
    { text: 'an early guess', is_final: false, translation_status: 'original' },
    { text: '仮の訳', is_final: false, translation_status: 'translation', language: 'ja' },
  ]);
  const next = accumulate(previous, [{ text: 'a revised guess', is_final: false, translation_status: 'original' }]);
  assert.equal(next.partialSource, 'a revised guess');
  assert.equal(next.partialTranslation, '', 'A genuine replacement result can withdraw provisional Japanese.');
});
test('translation arriving after an English endpoint remains visible', () => {
  let state = accumulate(emptyCaptions(), [{ text: 'Hello.', is_final: true, translation_status: 'original' }, { text: '<end>', is_final: true }]);
  state = accumulate(state, [{ text: 'こんにちは。', is_final: true, translation_status: 'translation', language: 'ja' }]);
  assert.equal(state.source, 'Hello.'); assert.equal(state.translation, 'こんにちは。');
});
test('committed tokens survive partial revisions and ignore control markers', () => {
  let state = accumulate(emptyCaptions(), [{ text: '本日は', is_final: true, translation_status: 'translation' }, { text: 'ご', is_final: false, translation_status: 'translation' }]);
  state = accumulate(state, [{ text: 'ありがとうございます。', is_final: true, translation_status: 'translation' }, { text: '<fin>', is_final: true, translation_status: 'translation' }]);
  assert.equal(state.translation, '本日はありがとうございます。'); assert.equal(state.partialTranslation, '');
});
test('long sessions retain bounded state and only target language translations', () => {
  const state = accumulate(emptyCaptions(), [{ text: 'x'.repeat(8000), is_final: true }, { text: '日'.repeat(5000), is_final: true, translation_status: 'translation', language: 'ja' }, { text: 'bonjour', is_final: true, translation_status: 'translation', language: 'fr' }]);
  assert.equal(state.source.length, 1600); assert.equal(state.translation.length, 1000);
});
test('automatic translation follows output language and preserves mixed-language spoken text', () => {
  let state = accumulate(emptyCaptions(), [
    { text: 'Welcome. ', is_final: true, translation_status: 'original', language: 'en' },
    { text: 'ようこそ。', is_final: true, translation_status: 'translation', language: 'ja', source_language: 'en' },
    { text: '続き', is_final: false, translation_status: 'translation', language: 'ja' },
  ], null);
  state = accumulate(state, [
    { text: 'この ', is_final: true, translation_status: 'original', language: 'ja' },
    { text: 'API', is_final: true, translation_status: 'original', language: 'en' },
    { text: ' は GitHub で公開しています。', is_final: true, translation_status: 'original', language: 'ja' },
  ], null);
  assert.equal(state.source, 'Welcome. この API は GitHub で公開しています。');
  assert.equal(state.translationLanguage, 'ja', 'Borrowed English words must not change the target.');
  assert.equal(state.translation, 'ようこそ。');
  state = accumulate(state, [{ text: 'This API is on GitHub.', is_final: false,
    translation_status: 'translation', language: 'en', source_language: 'ja' }], null);
  assert.equal(state.translationLanguage, 'en');
  assert.equal(state.translation, '', 'Changing target language removes the previous language buffer.');
  assert.equal(state.partialTranslation, 'This API is on GitHub.');
  state = accumulate(state, [{ text: 'The API is available on GitHub.', is_final: true,
    translation_status: 'translation', language: 'en', source_language: 'ja' }], null);
  assert.equal(state.translation, 'The API is available on GitHub.');
  assert.equal(state.partialTranslation, '');
});
test('the last accepted target-language run replaces earlier target text within one result', () => {
  const previous = accumulate(emptyCaptions(), [{ text: '以前の訳。', is_final: true, translation_status: 'translation', language: 'ja' }], null);
  const next = accumulate(previous, [
    { text: 'English in between.', is_final: true, translation_status: 'translation', language: 'en' },
    { text: 'API', is_final: false, translation_status: 'translation', language: 'ja', source_language: 'en' },
  ], null);
  assert.equal(next.translationLanguage, 'ja');
  assert.equal(next.translation, '');
  assert.equal(next.partialTranslation, 'API', 'Latin text with Japanese output metadata remains literal Japanese-lane output.');
});
test('automatic mode ignores missing or unsupported translation metadata without erasing valid drafts', () => {
  const previous = accumulate(emptyCaptions(), [
    { text: 'Recognized draft', is_final: false, translation_status: 'original' },
    { text: '翻訳途中', is_final: false, translation_status: 'translation', language: 'ja' },
  ], null);
  for (const token of [
    { text: 'No output language', source_language: 'ja' },
    { text: 'bonjour', language: 'fr', source_language: 'en' },
  ]) {
    assert.deepEqual(accumulate(previous, [{ ...token, translation_status: 'translation', is_final: false }], null), previous);
  }
});
test('fixed modes use a fallback only for missing output language metadata', () => {
  const previous = emptyCaptions('en');
  const next = accumulate(previous, [{ text: 'A translated draft', is_final: false,
    translation_status: 'translation', source_language: 'ja' }], 'en');
  assert.equal(next.translationLanguage, 'en');
  assert.equal(next.partialTranslation, 'A translated draft');
  assert.deepEqual(accumulate(next, [{ text: 'bonjour', translation_status: 'translation', language: 'fr' }], 'en'), next);
  const explicit = accumulate(next, [{ text: '日本語', is_final: true, translation_status: 'translation', language: 'ja' }], 'en');
  assert.equal(explicit.translationLanguage, 'ja', 'Explicit output language wins over the compatibility fallback.');
  assert.equal(explicit.translation, '日本語');
});
test('caption rolling window preserves whole Unicode characters', () => {
  assert.equal(captionTail('hello😀😀😀', 3), '😀😀😀');
  assert.equal(captionTail('こんにちは。ありがとうございます。', 12), 'ありがとうございます。');
});
test('glossary pairs reject malformed input instead of silently dropping terms', () => {
  assert.deepEqual(parseTranslations(' Product = 製品\n\nLive demo = 実演'), [{ source: 'Product', target: '製品' }, { source: 'Live demo', target: '実演' }]);
  assert.deepEqual(parseTranslations('GitHub = GitHub\n製品 = product'), [{ source: 'GitHub', target: 'GitHub' }, { source: '製品', target: 'product' }]);
  assert.throws(() => parseTranslations('Product'), /source = target/);
  assert.throws(() => parseTranslations('Product =  '), /source = target|both languages/);
});

test('visible caption budget includes provisional words so newest words are not lost', () => {
  const output = captionWindow('日'.repeat(90), '最新の言葉', 12);
  assert.equal(output.partial, '最新の言葉');
  assert.equal(Array.from(output.final + output.partial).length, 12);
  const partialOnly = captionWindow('', 'あ'.repeat(120), 12);
  assert.equal(partialOnly.final, ''); assert.equal(partialOnly.partial.length, 12);
  assert.deepEqual(captionWindow('本日は', 'ありがとう  '), { final: '本日は', partial: 'ありがとう' });
});

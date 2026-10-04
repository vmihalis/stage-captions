import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceAudienceCaptions, CAPTION_IDLE_MS, clearAudienceCaptions, emptyAudienceCaptions, expireAudienceCaptions } from '../../src/lib/audience-captions.ts';
import { accumulate, emptyCaptions } from '../../src/lib/captions.ts';
import type { Token } from '../../src/lib/captions.ts';

const ja = (text: string, is_final = true): Token => ({ text, is_final, translation_status: 'translation', language: 'ja' });
const en = (text: string, is_final = true): Token => ({ text, is_final, translation_status: 'original' });

test('audience clears after six seconds while presenter context is retained', () => {
  const tokens = [en('Welcome.'), ja('ようこそ。')];
  const presenter = accumulate(emptyCaptions(), tokens);
  const state = advanceAudienceCaptions(emptyAudienceCaptions(), tokens, 100);
  assert.equal(expireAudienceCaptions(state, 100 + CAPTION_IDLE_MS - 1), state);
  assert.deepEqual(expireAudienceCaptions(state, 100 + CAPTION_IDLE_MS).captions, emptyCaptions());
  assert.equal(presenter.english, 'Welcome.');
  assert.equal(presenter.japanese, 'ようこそ。');
});

test('empty responses, control markers and identical hypotheses do not postpone expiry', () => {
  const partial = [en('Hello', false), ja('こんにちは', false)];
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), partial, 0);
  state = advanceAudienceCaptions(state, [], 1000);
  state = advanceAudienceCaptions(state, [{ text: '<end>', is_final: true }, { text: '<fin>', is_final: true }], 2000);
  state = advanceAudienceCaptions(state, partial, 5000);
  assert.equal(state.lastActivityAt, 0);
  assert.equal(state.captions.partialJapanese, 'こんにちは');
  assert.deepEqual(expireAudienceCaptions(state, CAPTION_IDLE_MS).captions, emptyCaptions());
});

test('continuous source speech keeps current Japanese visible while translation catches up', () => {
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), [ja('最初の言葉。')], 0);
  for (const now of [5000, 10000, 15000]) {
    state = advanceAudienceCaptions(state, [en(' More words.')], now);
    assert.equal(state.captions.japanese, '最初の言葉。');
    assert.equal(expireAudienceCaptions(state, now + 5999), state);
  }
  assert.deepEqual(expireAudienceCaptions(state, 21000).captions, emptyCaptions());
});

test('late Japanese gets a fresh reading window and control markers do not truncate it', () => {
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), [en('Thank you.'), { text: '<end>', is_final: true }], 0);
  state = expireAudienceCaptions(state, 6000);
  state = advanceAudienceCaptions(state, [ja('ありがとうございます。')], 7500);
  state = advanceAudienceCaptions(state, [{ text: '<end>', is_final: true }], 8000);
  assert.equal(state.captions.japanese, 'ありがとうございます。');
  assert.equal(state.lastActivityAt, 7500);
  assert.equal(expireAudienceCaptions(state, 13499), state);
  assert.deepEqual(expireAudienceCaptions(state, 13500).captions, emptyCaptions());
});

test('next utterance never restores expired finalized Japanese', () => {
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), [en('Old.'), ja('古い文。')], 0);
  // A result can arrive before a throttled expiry callback runs.
  state = advanceAudienceCaptions(state, [en('New.')], 8000);
  assert.equal(state.captions.english, 'New.');
  assert.equal(state.captions.japanese, '');
  state = advanceAudienceCaptions(state, [ja('新しい文。')], 9000);
  assert.equal(state.captions.japanese, '新しい文。');
});

test('expired hypotheses do not reappear when repeated or finalized alongside new speech', () => {
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), [ja('古い文', false)], 0);
  state = expireAudienceCaptions(state, 6000);
  state = advanceAudienceCaptions(state, [en('New speech.'), ja('古い文', false)], 7000);
  assert.equal(state.captions.partialJapanese, '');
  state = advanceAudienceCaptions(state, [ja('古い'), ja('文', false)], 7100);
  assert.equal(state.captions.japanese, '');
  assert.equal(state.captions.partialJapanese, '');
  state = advanceAudienceCaptions(state, [ja('文'), ja('新しい文', false)], 7200);
  assert.equal(state.captions.japanese, '');
  assert.equal(state.captions.partialJapanese, '新しい文');
});

test('new final words following an expired hypothesis remain visible', () => {
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), [ja('古い文。', false)], 0);
  state = expireAudienceCaptions(state, 6000);
  state = advanceAudienceCaptions(state, [ja('古い文。新しい文。')], 7000);
  assert.equal(state.captions.japanese, '新しい文。');
});

test('a genuinely revised late hypothesis becomes visible with a fresh window', () => {
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), [ja('ありが', false)], 0);
  state = expireAudienceCaptions(state, 6000);
  state = advanceAudienceCaptions(state, [ja('ありがとうございます', false)], 7000);
  assert.equal(state.captions.partialJapanese, 'ありがとうございます');
  assert.equal(state.lastActivityAt, 7000);
});

test('manual audience clearing also suppresses old pending text', () => {
  let state = advanceAudienceCaptions(emptyAudienceCaptions(), [ja('古い言葉', false)], 0);
  state = clearAudienceCaptions(state);
  state = advanceAudienceCaptions(state, [ja('古い言葉', false)], 1000);
  assert.deepEqual(state.captions, emptyCaptions());
  assert.equal(state.lastActivityAt, null);
});

test('audience state remains bounded and ignores unrelated translation languages', () => {
  const state = advanceAudienceCaptions(emptyAudienceCaptions(), [en('x'.repeat(2000)), ja('日'.repeat(1500)), { text: 'bonjour', is_final: true, translation_status: 'translation', language: 'fr' }], 0);
  assert.equal(state.captions.english.length, 1600);
  assert.equal(state.captions.japanese.length, 1000);
  const ignored = advanceAudienceCaptions(state, [{ text: 'bonjour', is_final: false, translation_status: 'translation', language: 'fr' }], 5000);
  assert.equal(ignored, state);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { normalizeCaptionPayload } = require('../../electron/guards.cjs');

// Run the actual overlay renderer with a small DOM fixture, without opening
// the installed app or touching a presenter's screen.
function overlayFixture() {
  const elements = Object.fromEntries(['caption-card', 'japanese', 'committed', 'partial', 'english', 'caption-status']
    .map(id => [id, { textContent: '', hidden: false, dataset: {}, style: {}, lang: '', scrollHeight: 0, scrollWidth: 0 }]));
  const properties = new Map();
  let update;
  vm.runInNewContext(readFileSync(join(__dirname, '../../electron/overlay.js'), 'utf8'), {
    document: {
      getElementById: id => elements[id],
      documentElement: { style: { getPropertyValue: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) } },
      body: { classList: { toggle() {} } },
      fonts: { ready: Promise.resolve(), addEventListener() {} },
    },
    requestAnimationFrame: callback => callback(),
    ResizeObserver: class { observe() {} },
    window: { stageCaptions: { onUpdate(callback) { update = callback; }, ready() {} } },
  });
  return { elements, update(captions, showEnglish = false) {
    update({ captions: normalizeCaptionPayload(captions), options: {
      fontSize: 42, opacity: .9, position: 'bottom', showEnglish,
    } });
  } };
}

test('English translation uses the visible primary bar while Japanese spoken text is optional', () => {
  const { elements, update } = overlayFixture();
  const captions = { english: 'GitHubのAPIを使います。', japanese: 'We use the GitHub API.',
    partialJapanese: ' Let me show you.', translationLanguage: 'en', status: 'live' };
  update(captions);
  assert.equal(elements.japanese.hidden, false);
  assert.equal(elements.japanese.lang, 'en');
  assert.equal(elements.committed.textContent, 'We use the GitHub API.');
  assert.equal(elements.partial.textContent, ' Let me show you.');
  assert.equal(elements.english.hidden, true);
  assert.equal(elements['caption-card'].hidden, false);
  update(captions, true);
  assert.equal(elements.english.hidden, false);
  assert.equal(elements.english.textContent, 'GitHubのAPIを使います。');
});

test('language changes replace primary words and empty live captions hide the card', () => {
  const { elements, update } = overlayFixture();
  update({ english: '日本語', japanese: 'English.', translationLanguage: 'en', status: 'live' });
  update({ english: 'English', japanese: '', partialJapanese: '日本語の字幕', translationLanguage: 'ja', status: 'live' });
  assert.equal(elements.japanese.lang, 'ja');
  assert.equal(elements.committed.textContent, '');
  assert.equal(elements.partial.textContent, '日本語の字幕');
  update({ english: '', japanese: '', partialJapanese: '', translationLanguage: 'ja', status: 'live' });
  assert.equal(elements['caption-card'].hidden, true);
});

test('legacy caption payloads still render Japanese without new language metadata', () => {
  const { elements, update } = overlayFixture();
  update({ english: 'Hello.', japanese: 'こんにちは。', status: 'live' });
  assert.equal(elements.japanese.lang, 'ja');
  assert.equal(elements.committed.textContent, 'こんにちは。');
  assert.equal(elements.partial.textContent, '');
});

test('stable captions occupy two anchored rows and never scroll to a moving tail', () => {
  const { elements, update } = overlayFixture();
  elements.japanese.scrollHeight = 1000;
  elements.japanese.scrollTop = 500;
  update({ english: '', japanese: 'Legacy text ignored', partialJapanese: 'Draft ignored',
    stableLines: ['Already read words', 'Only this line grows'], status: 'live' });
  assert.equal(elements.committed.textContent, 'Already read words');
  assert.equal(elements.partial.textContent, 'Only this line grows');
  assert.equal(elements.japanese.scrollTop, 0);
  assert.equal(elements['caption-card'].hidden, false);
  update({ english: '', japanese: 'Legacy text ignored', stableLines: ['', ''], status: 'live' });
  assert.equal(elements['caption-card'].hidden, true);
});


test('stable lines scale together to fit narrow native output without wrapping or dropping words', () => {
  const { elements, update } = overlayFixture();
  elements.japanese.clientWidth = 300;
  elements.committed.scrollWidth = 600;
  elements.partial.scrollWidth = 450;
  update({ english: '', japanese: '', stableLines: ['A long line remains whole', 'Both rows share a fitted size'], status: 'live' });
  assert.equal(elements.japanese.style.fontSize, '21px');
  assert.equal(elements.committed.textContent, 'A long line remains whole');
  assert.equal(elements.partial.textContent, 'Both rows share a fitted size');
});

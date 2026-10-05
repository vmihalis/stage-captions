const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeServerOrigin, matchesOrigin, normalizeOverlayOptions, normalizeCaptionPayload,
  chooseDisplay, overlayBounds } = require('../../electron/guards.cjs');

const options = { fontSize: 48, position: 'bottom', showEnglish: true, opacity: .88, clickThrough: true };

test('team server origin excludes credentials, paths, insecure remote origins, and alternate protocols', () => {
  assert.equal(normalizeServerOrigin('  https://stage.example.com/ '), 'https://stage.example.com');
  assert.equal(normalizeServerOrigin('https://stage.example.com:8443'), 'https://stage.example.com:8443');
  for (const url of ['http://stage.example.com', 'file:///tmp/index.html', 'javascript:alert(1)',
    'https://user:secret@stage.example.com', 'https://stage.example.com/secret',
    'https://stage.example.com/?invite=secret', 'https://stage.example.com/#token']) {
    assert.throws(() => normalizeServerOrigin(url));
  }
});

test('HTTP is restricted to loopback origins and explicit development mode', () => {
  for (const address of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
    assert.throws(() => normalizeServerOrigin(address));
    assert.equal(normalizeServerOrigin(address, { allowDevelopmentHttp: true }), address);
  }
  assert.throws(() => normalizeServerOrigin('http://localhost.example.com', { allowDevelopmentHttp: true }));
  assert.throws(() => normalizeServerOrigin('http://192.168.1.2:5173', { allowDevelopmentHttp: true }));
});

test('same-origin checks compare scheme, host and port', () => {
  const origin = 'https://stage.example.com';
  assert.equal(matchesOrigin(`${origin}/present`, origin), true);
  for (const other of ['https://stage.example.com.attacker.example', 'http://stage.example.com',
    'https://stage.example.com:8443', 'data:text/html,caption', 'invalid']) {
    assert.equal(matchesOrigin(other, origin), false);
  }
});

test('screen selection keeps explicit external display and handles unplug fallback', () => {
  const primary = { id: 9 };
  const external = { id: 12 };
  assert.equal(chooseDisplay([primary, external], 9, '12'), external);
  assert.equal(chooseDisplay([primary], 9, '12'), primary);
  assert.equal(chooseDisplay([external], 9), external);
});

test('placement stays within external displays with negative desktop coordinates', () => {
  const workAreas = [
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { x: 0, y: -1440, width: 2560, height: 1440 },
    { x: 1920, y: 240, width: 800, height: 480 },
  ];
  for (const area of workAreas) for (const position of ['top', 'bottom']) {
    const bounds = overlayBounds(area, { ...options, fontSize: 96, position });
    assert.ok(bounds.x >= area.x);
    assert.ok(bounds.y >= area.y);
    assert.ok(bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y + bounds.height <= area.y + area.height);
    assert.ok(bounds.width > 0 && bounds.height > 0);
  }
});

test('IPC settings validate numeric limits instead of accepting unexpected payloads', () => {
  assert.deepEqual(normalizeOverlayOptions(options), { ...options, displayId: undefined });
  for (const invalid of [null, [], { ...options, fontSize: Infinity }, { ...options, opacity: NaN },
    { ...options, position: 'left' }, { ...options, opacity: -1 }, { ...options, clickThrough: 'true' }]) {
    assert.throws(() => normalizeOverlayOptions(invalid));
  }
});

test('caption payloads preserve literal text, accept provisional Japanese and reject oversized updates', () => {
  const caption = { english: '<img src=x>', japanese: 'こんにちは', partialJapanese: '世界', status: 'rehearsal' };
  assert.deepEqual(normalizeCaptionPayload(caption), caption);
  assert.throws(() => normalizeCaptionPayload({ ...caption, status: 'unexpected' }));
  assert.throws(() => normalizeCaptionPayload({ ...caption, japanese: 'あ'.repeat(6001) }));
  assert.throws(() => normalizeCaptionPayload({ ...caption, english: { html: 'bad' } }));
});

test('caption metadata supports both target languages while preserving legacy payloads', () => {
  const caption = { english: 'GitHubを使います。', japanese: 'We use GitHub.', partialJapanese: '',
    translationLanguage: 'en', status: 'live' };
  assert.deepEqual(normalizeCaptionPayload(caption), caption);
  assert.deepEqual(normalizeCaptionPayload({ ...caption, translationLanguage: 'ja' }), { ...caption, translationLanguage: 'ja' });
  for (const language of ['fr', '', null, {}]) {
    assert.throws(() => normalizeCaptionPayload({ ...caption, translationLanguage: language }));
  }
});

test('output modes and anchored lines validate the optional extension without changing old payloads', () => {
  for (const outputMode of ['overlay', 'window', 'presentation']) {
    assert.equal(normalizeOverlayOptions({ ...options, outputMode }).outputMode, outputMode);
  }
  assert.throws(() => normalizeOverlayOptions({ ...options, outputMode: 'capture-anything' }));
  const caption = { english: '', japanese: '', status: 'live', stableLines: ['Completed words.', 'Next line.'] };
  assert.deepEqual(normalizeCaptionPayload(caption).stableLines, caption.stableLines);
  for (const stableLines of [null, ['one', 'two', 'three'], ['new\nline'], [3]]) {
    assert.throws(() => normalizeCaptionPayload({ ...caption, stableLines }));
  }
});

test('capture sources exclude Stage, the output screen, missing display IDs, and mirrored screens', () => {
  const { captureSourceAllowed } = require('../../electron/guards.cjs');
  const control = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const output = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const check = source => captureSourceAllowed(source, output, [control, output], ['window:4:0']);
  assert.equal(check({ id: 'window:3:0' }), true);
  assert.equal(check({ id: 'window:4:0' }), false);
  assert.equal(check({ id: 'window:5:1' }), false);
  assert.equal(check({ id: 'screen:0:0', display_id: '1' }), true);
  assert.equal(check({ id: 'screen:1:0', display_id: '2' }), false);
  assert.equal(check({ id: 'screen:0:0', display_id: '' }), false);
  assert.equal(captureSourceAllowed({ id: 'screen:0:0', display_id: '1' }, output,
    [{ ...control, bounds: output.bounds }, output], []), false);
});

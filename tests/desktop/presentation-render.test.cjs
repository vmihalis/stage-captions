const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function fixture(capture) {
  function element() {
    return { hidden: false, children: [], listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
      querySelectorAll() { return this.children; }, async play() {} };
  }
  const elements = Object.fromEntries(['presentation-video', 'source-picker', 'presentation-output', 'source-list', 'load-sources', 'capture-error']
    .map(id => [id, element()]));
  const events = {};
  let reset;
  let started = 0;
  let captures = 0;
  vm.runInNewContext(readFileSync(join(__dirname, '../../electron/presentation.js'), 'utf8'), {
    document: { getElementById: id => elements[id], createElement: element },
    window: {
      addEventListener: (type, fn) => { events[type] = fn; },
      stagePresentation: {
        async getSources() { return [{ id: 'window:8:0', name: '<b>Slides</b>', kind: 'window' }]; },
        async selectSource() {}, async started() { started++; }, async stop() {}, error() {},
        onReset(fn) { reset = fn; },
      },
    },
    navigator: { mediaDevices: { getDisplayMedia(options) {
      captures++;
      assert.equal(options.audio, false);
      return capture();
    } } },
  });
  return { elements, events, reset: () => reset(), get captures() { return captures; }, get started() { return started; },
    async choose() {
      await elements['load-sources'].listeners.click();
      assert.equal(elements['source-list'].children[0].textContent, 'Window · <b>Slides</b>');
      return elements['source-list'].children[0].listeners.click();
    } };
}
function media() {
  let stops = 0;
  const track = { onended: null, stop() { stops++; } };
  return { track, get stops() { return stops; }, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}

test('local presentation capture starts only after a chosen source, and reset/unload stop every track', async () => {
  const first = media();
  const f = fixture(async () => first.stream);
  assert.equal(f.captures, 0);
  await f.choose();
  assert.equal(f.captures, 1);
  assert.equal(f.started, 1);
  assert.equal(f.elements['presentation-output'].hidden, false);
  f.reset();
  assert.equal(first.stops, 1);
  assert.equal(first.track.onended, null);
  assert.equal(f.elements['presentation-video'].srcObject, null);
  assert.equal(f.elements['presentation-output'].hidden, true);
  await f.choose();
  f.events.beforeunload();
  assert.equal(first.stops, 2);
  assert.equal(f.elements['presentation-video'].srcObject, null);
});

test('late stream grants are stopped after source changes or closure', async () => {
  const source = media();
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const opening = f.choose();
  await new Promise(done => setImmediate(done));
  f.reset();
  resolve(source.stream);
  await opening;
  assert.equal(source.stops, 1);
  assert.equal(f.started, 0);
  assert.equal(f.elements['presentation-video'].srcObject, null);
});

test('an ended source clears its video and returns to selection', async () => {
  const source = media();
  const f = fixture(async () => source.stream);
  await f.choose();
  source.track.onended();
  assert.equal(source.stops, 1);
  assert.equal(f.elements['source-picker'].hidden, false);
  assert.equal(f.elements['presentation-output'].hidden, true);
});

test('a failed OS permission request allows retry from the existing source button', async () => {
  const source = media();
  let attempts = 0;
  const f = fixture(async () => {
    if (++attempts === 1) throw new Error('Permission denied');
    return source.stream;
  });
  await f.choose();
  const sameButton = f.elements['source-list'].children[0];
  assert.equal(sameButton.disabled, false);
  assert.equal(f.elements['capture-error'].hidden, false);
  assert.equal(f.started, 0);
  await sameButton.listeners.click();
  assert.equal(f.captures, 2);
  assert.equal(f.started, 1);
  assert.equal(f.elements['presentation-output'].hidden, false);
});

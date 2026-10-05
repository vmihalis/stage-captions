const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPresentation } = require('../../electron/presentation.cjs');

function fixture() {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.fullscreen = false;
      this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: 'file:///stage/presentation.html' };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.send = (...args) => this.messages.push(args);
      windows.push(this);
    }
    static getAllWindows() { return windows; }
    isDestroyed() { return this.destroyed; }
    isFullScreen() { return this.fullscreen; }
    setFullScreen(value) { this.fullscreen = value; if (!value) this.emit('leave-full-screen'); }
    getMediaSourceId() { return 'window:100:0'; }
    setBounds(value) { this.bounds = value; }
    show() { this.emit('show'); }
    async loadFile() {}
    close() { this.destroy(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
  ];
  const handlers = new Map();
  const permission = {};
  const partition = {
    setPermissionRequestHandler(fn) { permission.request = fn; },
    setPermissionCheckHandler(fn) { permission.check = fn; },
    setDisplayMediaRequestHandler(fn) { permission.capture = fn; },
    setDevicePermissionHandler(fn) { permission.device = fn; },
    on() {},
  };
  let enumerations = 0;
  const output = createPresentation({ BrowserWindow: Window,
    desktopCapturer: { async getSources() {
      enumerations++;
      return [{ id: 'window:8:0', name: 'Slides' }, { id: 'window:100:0', name: 'Stage' },
        { id: 'screen:0:0', display_id: '1', name: 'Control' }, { id: 'screen:1:0', display_id: '2', name: 'Projector' }];
    } },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] },
    session: { fromPartition: () => partition },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => handlers.set(key, fn) },
    rendererPreferences: () => ({}), guardNavigation() {},
    requireSender(event, window, allowed) {
      if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame || !allowed(event.senderFrame.url)) throw new Error('Denied');
    },
    localURL: file => `file:///stage/${file}`, onState() {}, getCaptionState: () => ({ captions: { japanese: 'Hello' } }),
  });
  const event = () => ({ sender: output.window.webContents, senderFrame: output.window.webContents.mainFrame });
  const invoke = (channel, value) => handlers.get(`stage:presentation-${channel}`)(event(), value);
  const request = overrides => {
    let answer;
    permission.capture({ frame: output.window?.webContents.mainFrame, videoRequested: true,
      audioRequested: false, userGesture: true, ...overrides }, value => { answer = value; });
    return answer;
  };
  return { output, invoke, request, event, handlers, permission, displays, get enumerations() { return enumerations; } };
}

test('capture requires local choice and grants video once to only the local top-level frame', async () => {
  const f = fixture();
  await f.output.open({ displayId: '2', outputMode: 'presentation' });
  assert.equal(f.enumerations, 0, 'Opening the picker must not enumerate or start screen capture.');
  assert.deepEqual(f.request(), {});
  const sources = await f.invoke('sources');
  assert.deepEqual(sources.map(source => source.name), ['Slides', 'Control']);
  assert.ok(sources.every(source => !('thumbnail' in source) && !('display_id' in source)));
  assert.throws(() => f.handlers.get('stage:presentation-select')({ ...f.event(), senderFrame: { url: f.event().senderFrame.url } }, 'window:8:0'));
  f.invoke('select', 'window:8:0');
  assert.deepEqual(f.request({ audioRequested: true }), {});
  assert.deepEqual(f.request({ userGesture: false }), {});
  assert.deepEqual(f.request({ frame: { url: 'https://stage.example.com/' } }), {});
  assert.deepEqual(f.request(), { video: { id: 'window:8:0', name: 'Slides' } });
  assert.deepEqual(f.request(), {}, 'A source grant must not be reusable.');
  f.invoke('started');
  assert.equal(f.output.status, 'sharing');
  assert.deepEqual(f.output.window.bounds, f.displays[1].bounds);
  assert.equal(f.output.window.isFullScreen(), true);
});

test('changing source, losing output display, and closing revoke capture grants', async () => {
  const f = fixture();
  await f.output.open({ displayId: '2', outputMode: 'presentation' });
  await f.invoke('sources');
  f.invoke('select', 'screen:0:0');
  f.output.configure({ displayId: '1', outputMode: 'presentation' });
  assert.deepEqual(f.request(), {});
  assert.ok(f.output.window.messages.some(([channel]) => channel === 'stage:presentation-reset'));
  f.output.configure({ displayId: '2', outputMode: 'presentation' });
  await f.invoke('sources');
  f.invoke('select', 'screen:0:0');
  f.displays.splice(1, 1);
  f.output.displaysChanged();
  assert.deepEqual(f.request(), {});
  const owner = f.output.window;
  f.output.close();
  assert.equal(owner.isDestroyed(), true);
  assert.equal(f.output.status, null);
  assert.equal(f.permission.check(owner.webContents, 'display-capture', '', { requestingUrl: 'file:///stage/presentation.html', isMainFrame: true }), false);
});

test('denied capture revokes its grant but allows explicitly retrying the same listed source', async () => {
  const f = fixture();
  await f.output.open({ displayId: '2', outputMode: 'presentation' });
  await f.invoke('sources');
  f.invoke('select', 'window:8:0');
  assert.deepEqual(f.request(), { video: { id: 'window:8:0', name: 'Slides' } });
  f.invoke('error'); // The OS rejects the capture after source selection.
  assert.equal(f.output.status, 'error');
  assert.deepEqual(f.request(), {}, 'Failure must revoke the old grant.');
  assert.throws(() => f.invoke('started'), /no longer available/);
  f.invoke('select', 'window:8:0'); // Retry after granting OS permission; no refresh.
  assert.equal(f.enumerations, 1);
  assert.deepEqual(f.request(), { video: { id: 'window:8:0', name: 'Slides' } });
  f.invoke('started');
  assert.equal(f.output.status, 'sharing');
  f.output.window.webContents.emit('did-start-loading');
  assert.throws(() => f.invoke('select', 'window:8:0'), /available source/,
    'A new document must still enumerate its own sources.');
});

test('presentation session denies microphone, camera, subframes, hosted renderer and unchosen capture', async () => {
  const f = fixture();
  await f.output.open({ displayId: '2' });
  const contents = f.output.window.webContents;
  const details = { requestingUrl: contents.getURL(), isMainFrame: true };
  for (const permission of ['media', 'camera', 'microphone', 'display-capture']) {
    assert.equal(f.permission.check(contents, permission, '', details), false);
  }
  await f.invoke('sources'); f.invoke('select', 'window:8:0');
  assert.equal(f.permission.check(contents, 'display-capture', '', details), true);
  assert.equal(f.permission.check(contents, 'display-capture', '', { ...details, isMainFrame: false }), false);
  assert.equal(f.permission.check(contents, 'display-capture', '', { ...details, requestingUrl: 'https://stage.example.com/' }), false);
  assert.equal(f.permission.device({}), false);
  f.output.window.webContents.emit('did-start-loading');
  assert.deepEqual(f.request(), {}, 'Reloading must revoke a source selected by the previous document.');
});

test('mirrored or single-display setups receive windowed guidance without opening a picker', async () => {
  const f = fixture();
  f.displays[1].bounds = { ...f.displays[0].bounds };
  await assert.rejects(f.output.open({ displayId: '2' }), /extended display/);
  assert.equal(f.output.window, undefined);
  assert.equal(f.enumerations, 0);
});

// Run with: npx electron tests/desktop/native-smoke.cjs
// Uses a loopback fixture and synthetic microphone; never contacts Soniox or records a real device.
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const temporary = fsSync.mkdtempSync(path.join(os.tmpdir(), 'stage-desktop-smoke-'));
const dataDirectory = path.join(temporary, 'profile');
app.setPath('userData', dataDirectory);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, preloadPath, error) => console.error(`Preload failed: ${preloadPath}: ${error.message}`));
  contents.on('did-fail-load', (_event, code, description, url) => console.error(`Load failed: ${code} ${description} ${url}`));
  contents.on('console-message', (_event, details) => {
    if (details.level === 'error' || details.level === 3) console.error(`Renderer: ${details.message}`);
  });
});
let fixture;
let finishing = false;
let testStage = 'loading the main fixture';

function eventually(predicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
      } catch { /* A renderer may be between document loads. */ }
      if (Date.now() - start >= timeout) return reject(new Error('Timed out waiting for the native app.'));
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
  app.exit(code);
}

async function smoke() {
  const main = await eventually(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1')));
  testStage = 'loading the desktop bridge';
  await eventually(() => main.webContents.executeJavaScript('Boolean(window.stageDesktop)'));
  const displays = await main.webContents.executeJavaScript('window.stageDesktop.getDisplays()');
  assert.ok(displays.length > 0);
  const selected = displays[displays.length - 1];
  testStage = 'opening the caption window';
  await main.webContents.executeJavaScript(`window.stageDesktop.openOverlay(${JSON.stringify({ displayId: selected.id, fontSize: 48,
    position: 'bottom', showEnglish: true, opacity: .88, clickThrough: true })})`);
  testStage = 'loading the caption window';
  const overlay = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  assert.equal(overlay.isAlwaysOnTop(), true);
  assert.equal(overlay.isResizable(), false);
  assert.equal(overlay.isMovable(), false);
  assert.equal(overlay.isFocusable(), false);
  const preferences = main.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  const caption = { english: 'Welcome to our presentation.', japanese: '本日はプレゼンテーションにご参加いただき、',
    partialJapanese: 'ありがとうございます。', status: 'rehearsal' };
  await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify(caption)})`);
  testStage = 'displaying the caption payload';
  await eventually(async () => (await overlay.webContents.executeJavaScript('document.getElementById("partial").textContent')) === caption.partialJapanese);
  const exposed = await overlay.webContents.executeJavaScript('({ desktop: typeof window.stageDesktop, connection: typeof window.stageConnection, node: typeof require })');
  assert.deepEqual(exposed, { desktop: 'undefined', connection: 'undefined', node: 'undefined' });
  await overlay.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  const sampleImage = await overlay.webContents.capturePage();
  const screenshot = path.join(temporary, 'overlay.png');
  await fs.writeFile(screenshot, sampleImage.toPNG());

  testStage = 'large captions showing the newest words';
  await main.webContents.executeJavaScript('window.stageDesktop.openOverlay({ fontSize:80, position:"bottom", showEnglish:true, opacity:.88, clickThrough:true })');
  overlay.setBounds({ ...overlay.getBounds(), width: 1280 });
  const rollingCaption = { english: 'Earlier English. '.repeat(15) + 'Newest English words.',
    japanese: '前の文章が長くても、新しい言葉を表示します。'.repeat(6), partialJapanese: '最後の新しい言葉です。', status: 'live' };
  await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify(rollingCaption)})`);
  await eventually(async () => overlay.webContents.executeJavaScript(`(() => {
    const viewport = document.getElementById('japanese');
    return viewport.scrollTop > 0 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1;
  })()`));
  const finalWordVisible = await overlay.webContents.executeJavaScript(`(() => {
    const text = document.getElementById('partial').firstChild;
    const range = document.createRange();
    range.setStart(text, text.length - 1);
    range.setEnd(text, text.length);
    const glyph = range.getBoundingClientRect();
    const viewport = document.getElementById('japanese').getBoundingClientRect();
    return glyph.top >= viewport.top - 1 && glyph.bottom <= viewport.bottom + 1;
  })()`);
  assert.equal(finalWordVisible, true, 'The final provisional word must remain in the visible two-line viewport.');
  const rollingScreenshot = path.join(temporary, 'overlay-newest-words.png');
  await fs.writeFile(rollingScreenshot, (await overlay.webContents.capturePage()).toPNG());

  testStage = 'clearing stale captions outside active sessions';
  for (const state of ['stopped', 'reconnecting', 'error', 'idle']) {
    await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify({ ...rollingCaption, status: state })})`);
    await eventually(async () => overlay.webContents.executeJavaScript(`document.getElementById('caption-status').dataset.status === '${state}'`));
    assert.deepEqual(await overlay.webContents.executeJavaScript(`({
      japanese: document.getElementById('japanese').textContent,
      english: document.getElementById('english').textContent,
      hidden: document.getElementById('japanese').hidden && document.getElementById('english').hidden,
      statusVisible: !document.getElementById('caption-status').hidden,
    })`), { japanese: '', english: '', hidden: true, statusVisible: true });
  }

  // Synthetic media checks exercise our permission handlers without accessing physical devices.
  testStage = 'synthetic microphone permissions';
  const media = await main.webContents.executeJavaScript(`(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const count = stream.getAudioTracks().length;
    stream.getTracks().forEach(track => track.stop());
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: true });
      camera.getTracks().forEach(track => track.stop());
      return { audioTracks: count, videoDenied: false };
    } catch { return { audioTracks: count, videoDenied: true }; }
  })()`);
  assert.equal(media.audioTracks, 1);
  assert.equal(media.videoDenied, true);
  testStage = 'literal captions';

  // The caption renderer displays literal text and never interprets it as markup.
  await main.webContents.executeJavaScript('window.stageDesktop.updateOverlay({ english: "", japanese: "<b>literal</b>", status: "live" })');
  await eventually(async () => await overlay.webContents.executeJavaScript('document.getElementById("committed").textContent === "<b>literal</b>"'));
  assert.equal(await overlay.webContents.executeJavaScript('document.querySelectorAll("b").length'), 0);

  await main.webContents.executeJavaScript('window.stageDesktop.openOverlay({ fontSize:48, position:"top", showEnglish:false, opacity:.8, clickThrough:false })');
  const bounds = overlay.getBounds();
  await main.webContents.executeJavaScript('window.stageDesktop.closeOverlay()');
  testStage = 'closing the caption window';
  await eventually(() => overlay.isDestroyed());
  assert.equal(BrowserWindow.getAllWindows().length, 1);

  const before = main.webContents.getURL();
  await main.webContents.executeJavaScript('window.location.href = "https://example.invalid"; true');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(main.webContents.getURL(), before);

  // Switching servers closes the presenter renderer and presents the local setup page.
  Menu.getApplicationMenu().items[0].submenu.items[0].click();
  testStage = 'switching to connection setup';
  const connection = await eventually(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/connection.html')));
  await eventually(() => connection.webContents.executeJavaScript('Boolean(window.stageConnection)'));
  assert.equal(main.isDestroyed(), true);
  const denied = await connection.webContents.executeJavaScript('window.stageConnection.connect("http://remote.example")');
  assert.equal(denied.ok, false);
  assert.equal(await connection.webContents.executeJavaScript('typeof window.stageDesktop'), 'undefined');
  console.log(JSON.stringify({ ok: true, platform: process.platform, displays: displays.length, selectedDisplay: selected.id,
    bounds, syntheticMicrophone: media, screenshot, rollingScreenshot, checks: ['bridge', 'screen selection', 'overlay rendering',
      'newest words at 80px/1280px', 'inactive states clear stale captions',
      'renderer isolation', 'microphone-only permission', 'literal text', 'overlay teardown', 'external navigation denied', 'connection reset'] }));
  await finish(0);
}

fixture = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; frame-src 'none'" });
  response.end('<!doctype html><html><head><title>Stage desktop fixture</title></head><body><h1>Stage native smoke test</h1></body></html>');
});
fixture.listen(0, '127.0.0.1', () => {
  process.env.STAGE_SERVER_URL = `http://127.0.0.1:${fixture.address().port}`;
  require('../../electron/main.cjs');
  app.whenReady().then(smoke).catch(async error => {
    console.error(`Failed while ${testStage}: ${error.stack}`);
    console.error(JSON.stringify(BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), url: window.webContents.getURL() }))));
    await finish(1);
  });
});
setTimeout(() => {
  console.error(`Native smoke test timed out while ${testStage}.`);
  console.error(JSON.stringify(BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), url: window.webContents.getURL(), loading: window.webContents.isLoading() }))));
  finish(1);
}, 90000).unref();

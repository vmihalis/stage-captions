// Run with: npx electron tests/desktop/native-smoke.cjs
// Uses a loopback fixture and synthetic microphone; never contacts Soniox or records a real device.
const { app, BrowserWindow, Menu, globalShortcut } = require('electron');
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
  const toggle = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.accelerator === 'CommandOrControl+Shift+H');
  assert.ok(toggle, 'The caption shortcut must have an application menu fallback.');
  const initialState = await main.webContents.executeJavaScript('window.stageDesktop.getOverlayState()');
  assert.deepEqual(initialState, { open: false, visible: false,
    shortcutRegistered: globalShortcut.isRegistered('CommandOrControl+Shift+H'),
    outputMode: 'overlay', presentationStatus: null });
  await main.webContents.executeJavaScript(`(() => {
    window.overlayStates = [];
    window.closedEvents = 0;
    window.stopOverlayStates = window.stageDesktop.onOverlayStateChanged(state => window.overlayStates.push(state));
    window.stageDesktop.onOverlayClosed(() => window.closedEvents++);
  })()`);
  const caption = { english: 'Welcome to our presentation.', japanese: '本日はプレゼンテーションにご参加いただき、',
    partialJapanese: 'ありがとうございます。', status: 'rehearsal' };
  testStage = 'caching captions and settings before the shortcut opens output';
  await main.webContents.executeJavaScript(`window.stageDesktop.configureOverlay(${JSON.stringify({ displayId: selected.id, fontSize: 48,
    position: 'bottom', showEnglish: true, opacity: .88, clickThrough: true })})`);
  await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify(caption)})`);
  assert.equal((await main.webContents.executeJavaScript('window.stageDesktop.getOverlayState()')).open, false);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await assert.rejects(main.webContents.executeJavaScript('window.stageDesktop.configureOverlay({fontSize: -1})'));
  toggle.click();
  testStage = 'loading the caption window';
  const overlay = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  await eventually(async () => (await main.webContents.executeJavaScript('window.stageDesktop.getOverlayState()')).visible);
  assert.equal(overlay.isAlwaysOnTop(), true);
  assert.equal(overlay.isResizable(), false);
  assert.equal(overlay.isMovable(), false);
  assert.equal(overlay.isFocusable(), false);
  if (process.platform !== 'win32') assert.equal(overlay.isVisibleOnAllWorkspaces(), true);
  if (process.platform === 'darwin') assert.equal(app.dock.isVisible(), true, 'Opening captions must preserve Stage in the Dock.');
  const preferences = main.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  testStage = 'displaying the caption payload';
  await eventually(async () => (await overlay.webContents.executeJavaScript('document.getElementById("partial").textContent')) === caption.partialJapanese);
  const exposed = await overlay.webContents.executeJavaScript('({ desktop: typeof window.stageDesktop, connection: typeof window.stageConnection, node: typeof require })');
  assert.deepEqual(exposed, { desktop: 'undefined', connection: 'undefined', node: 'undefined' });
  await overlay.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  testStage = 'capturing the rendered overlay';
  const sampleImage = await eventually(() => overlay.webContents.capturePage());
  const screenshot = path.join(temporary, 'overlay.png');
  await fs.writeFile(screenshot, sampleImage.toPNG());

  testStage = 'hiding output without losing updated captions or settings';
  toggle.click();
  await eventually(async () => !(await main.webContents.executeJavaScript('window.stageDesktop.getOverlayState()')).visible);
  assert.equal(overlay.isDestroyed(), false);
  const hiddenBounds = overlay.getBounds();
  await main.webContents.executeJavaScript('window.stageDesktop.configureOverlay({ fontSize:64, position:"top", showEnglish:true, opacity:.8, clickThrough:true })');
  assert.notDeepEqual(overlay.getBounds(), hiddenBounds);
  assert.equal((await main.webContents.executeJavaScript('window.stageDesktop.getOverlayState()')).visible, false,
    'Changing caption settings must not reveal hidden output.');
  const hiddenCaption = { ...caption, partialJapanese: '非表示中にも字幕を更新します。' };
  await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify(hiddenCaption)})`);
  await eventually(async () => (await overlay.webContents.executeJavaScript('document.getElementById("partial").textContent')) === hiddenCaption.partialJapanese);
  toggle.click();
  await eventually(async () => (await main.webContents.executeJavaScript('window.stageDesktop.getOverlayState()')).visible);
  assert.equal(overlay.isFocusable(), false);
  assert.equal(BrowserWindow.getAllWindows().filter(window => window.getTitle() === 'Stage captions').length, 1);

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
  await eventually(async () => (await main.webContents.executeJavaScript('window.closedEvents')) === 1);

  testStage = 'reopening closed output with the latest cached captions';
  const reopenedCaption = { english: 'These words arrived after closing the overlay.', japanese: '閉じた後の最新の字幕です。',
    partialJapanese: '', status: 'live' };
  await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify(reopenedCaption)})`);
  await main.webContents.executeJavaScript('window.stageDesktop.configureOverlay({ fontSize:48, position:"bottom", showEnglish:false, opacity:.8, clickThrough:true })');
  toggle.click();
  const reopened = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  await eventually(async () => (await reopened.webContents.executeJavaScript('document.getElementById("committed").textContent')) === reopenedCaption.japanese);
  await eventually(async () => (await main.webContents.executeJavaScript('window.stageDesktop.getOverlayState()')).visible);
  const states = await main.webContents.executeJavaScript('window.overlayStates');
  assert.ok(states.some(state => state.open && state.visible));
  assert.ok(states.some(state => state.open && !state.visible));
  assert.ok(states.some(state => !state.open && !state.visible));
  assert.ok(states.every(state => state.shortcutRegistered === initialState.shortcutRegistered));
  await main.webContents.executeJavaScript('window.stopOverlayStates(); window.stageDesktop.closeOverlay()');
  await eventually(() => reopened.isDestroyed());
  assert.equal(await main.webContents.executeJavaScript('window.overlayStates.length'), states.length,
    'The bridge must remove state subscriptions when asked.');

  testStage = 'movable caption window and stable rows';
  const capabilities = await main.webContents.executeJavaScript('window.stageDesktop.getCapabilities()');
  assert.equal(typeof capabilities.summaryWorker, 'boolean');
  assert.equal(capabilities.controllerShortcutRegistered, globalShortcut.isRegistered('CommandOrControl+Shift+B'));
  assert.deepEqual({ ...capabilities, summaryWorker: false, controllerShortcutRegistered: false },
    { apiVersion: 2, outputModes: ['overlay', 'window', 'presentation'], stableLines: true, saveMeetingExport: true, summaryWorker: false,
      compactController: true, controllerShortcutRegistered: false });
  await assert.rejects(main.webContents.executeJavaScript(`window.stageDesktop.saveMeetingExport({filename:'../not-allowed',text:'test',format:'md'})`));
  const windowOptions = { displayId: selected.id, fontSize: 48, position: 'bottom', showEnglish: false,
    opacity: .88, clickThrough: true, outputMode: 'window' };
  await main.webContents.executeJavaScript(`window.stageDesktop.openOverlay(${JSON.stringify(windowOptions)})`);
  const movable = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  assert.equal(movable.isResizable(), true);
  assert.equal(movable.isMovable(), true);
  assert.equal(movable.isFocusable(), true);
  assert.equal(movable.isAlwaysOnTop(), false);
  const manualBounds = { ...movable.getBounds(), x: movable.getBounds().x + 10, width: 800, height: 340 };
  movable.setBounds(manualBounds);
  await main.webContents.executeJavaScript(`window.stageDesktop.configureOverlay(${JSON.stringify({ ...windowOptions, fontSize: 52 })})`);
  assert.deepEqual(movable.getBounds(), manualBounds, 'Font changes must preserve a manually sized caption window.');
  await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify({ english: '', japanese: 'Ignored legacy words',
    stableLines: ['First anchored line', 'Second anchored line'], translationLanguage: 'en', status: 'live' })})`);
  await eventually(() => movable.webContents.executeJavaScript(`document.getElementById('partial').textContent === 'Second anchored line'`));
  assert.deepEqual(await movable.webContents.executeJavaScript(`(() => {
    const top = document.getElementById('committed').getBoundingClientRect();
    const bottom = document.getElementById('partial').getBoundingClientRect();
    return { separateRows: bottom.top >= top.bottom - 1, scrollTop: document.getElementById('japanese').scrollTop,
      mode: document.body.classList.contains('windowed') };
  })()`), { separateRows: true, scrollTop: 0, mode: true });
  movable.setBounds({ ...manualBounds, width: 520 });
  await main.webContents.executeJavaScript(`window.stageDesktop.configureOverlay(${JSON.stringify({ ...windowOptions, fontSize: 96 })})`);
  await main.webContents.executeJavaScript(`window.stageDesktop.updateOverlay(${JSON.stringify({ english: '', japanese: '',
    stableLines: ['This entire fixed caption line must fit inside a small window.', 'Both lines keep their original breaks.'], status: 'live' })})`);
  await eventually(() => movable.webContents.executeJavaScript(`(() => {
    const row = document.getElementById('committed');
    const range = document.createRange(); range.selectNodeContents(row);
    const text = range.getBoundingClientRect();
    const viewport = document.getElementById('japanese').getBoundingClientRect();
    return parseFloat(getComputedStyle(document.getElementById('japanese')).fontSize) < 96 && text.right <= viewport.right + 1;
  })()`));
  await main.webContents.executeJavaScript(`window.stageDesktop.openOverlay(${JSON.stringify({ ...windowOptions, outputMode: 'overlay' })})`);
  await eventually(() => movable.isDestroyed());
  const switched = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  assert.equal(switched.isMovable(), false, 'Switching modes must replace native window properties.');
  await main.webContents.executeJavaScript('window.stageDesktop.closeOverlay()');
  await eventually(() => switched.isDestroyed());

  const before = main.webContents.getURL();
  await main.webContents.executeJavaScript('window.location.href = "https://example.invalid"; true');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(main.webContents.getURL(), before);

  testStage = 'opting into the compact native controller';
  assert.ok(main.getBounds().width >= 860, 'Older hosted pages retain a usable large window until opting in.');
  await assert.rejects(main.webContents.executeJavaScript('window.stageDesktop.setControllerLayout({height:70, width:1000})'));
  await main.webContents.executeJavaScript('window.stageDesktop.setControllerLayout({height:72})');
  assert.equal(main.getBounds().width, 440);
  assert.equal(main.getBounds().height, 72);
  assert.equal(main.isResizable(), false);
  assert.equal(main.isAlwaysOnTop(), true);
  if (process.platform !== 'win32') assert.equal(main.isVisibleOnAllWorkspaces(), true);
  const controllerToggle = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.accelerator === 'CommandOrControl+Shift+B');
  assert.ok(controllerToggle, 'The remote shortcut must have a menu fallback.');
  await main.webContents.executeJavaScript(`(async () => {
    window.controllerIdentity = 'synthetic-session-stays-mounted';
    window.controllerStream = await navigator.mediaDevices.getUserMedia({audio:true});
    window.controllerActions = [];
    window.unsubscribeController = window.stageDesktop.onControllerAction(action => window.controllerActions.push(action));
    window.stageDesktop.updateControllerState({status:'live',paused:false,pending:2});
    window.stageDesktop.updateControllerState({status:'invalid',paused:false,pending:2});
  })()`);
  await main.webContents.executeJavaScript(`window.stageDesktop.openOverlay(${JSON.stringify(windowOptions)})`);
  const retainedOutput = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  testStage = 'hiding the remote without ending audio or caption output';
  await main.webContents.executeJavaScript('window.stageDesktop.hideController()');
  assert.equal(main.isVisible(), false);
  assert.equal(main.isDestroyed(), false);
  assert.equal(retainedOutput.isVisible(), true);
  assert.equal(await main.webContents.executeJavaScript('window.controllerStream.getAudioTracks()[0].readyState'), 'live');
  controllerToggle.click();
  await eventually(() => main.isVisible());
  main.close();
  assert.equal(main.isDestroyed(), false, 'Closing the compact remote must hide, not end the meeting.');
  await eventually(() => !main.isVisible());
  controllerToggle.click();
  await eventually(() => main.isVisible());
  const previousBounds = main.getBounds();
  main.setPosition(previousBounds.x - 20, previousBounds.y + 12);
  await eventually(async () => {
    try { const saved = JSON.parse(await fs.readFile(path.join(dataDirectory, 'controller-window.json'), 'utf8'));
      return saved.x === previousBounds.x - 20 && saved.y === previousBounds.y + 12;
    } catch { return false; }
  });
  await main.webContents.executeJavaScript('window.stageDesktop.setControllerLayout({height:320})');
  assert.equal(main.getBounds().height, 320);
  await main.webContents.executeJavaScript('window.stageDesktop.setControllerLayout({height:72})');
  assert.equal(main.getBounds().x, previousBounds.x - 20);

  testStage = 'independent workspace window and restricted bridge';
  const selectedMeeting = '09b2b180-ac00-4eef-9d16-fb21e35096d9';
  await main.webContents.executeJavaScript(`window.stageDesktop.openWorkspace('meetings', '${selectedMeeting}')`);
  const workspace = await eventually(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/workspace?view=meetings')));
  assert.equal(workspace.isAlwaysOnTop(), false);
  assert.equal(workspace.isResizable(), true);
  assert.equal(workspace.webContents.session, main.webContents.session);
  assert.equal((await workspace.webContents.executeJavaScript('window.stageDesktop.getCapabilities()')).compactController, true);
  assert.equal(main.webContents.getURL(), before);
  assert.equal(await main.webContents.executeJavaScript('window.controllerIdentity'), 'synthetic-session-stays-mounted');
  for (const call of ['getDisplays()', 'setControllerLayout({height:64})', 'hideController()', 'closeOverlay()',
    'toggleOverlay()', 'openWorkspace("setup")', 'getOverlayState()']) {
    await assert.rejects(workspace.webContents.executeJavaScript(`window.stageDesktop.${call}`), /cannot perform that action/);
  }
  await assert.rejects(workspace.webContents.executeJavaScript('window.stageDesktop.saveMeetingExport({filename:"../no",text:"test",format:"md"})'), /Invalid meeting export/);
  await workspace.webContents.executeJavaScript('window.stageDesktop.cancelSummary()');
  const workspaceMicDenied = await workspace.webContents.executeJavaScript(`(async () => {
    try { const stream = await navigator.mediaDevices.getUserMedia({audio:true}); stream.getTracks().forEach(track => track.stop()); return false; }
    catch { return true; }
  })()`);
  assert.equal(workspaceMicDenied, true);
  const workspaceBefore = workspace.webContents.getURL();
  await workspace.webContents.executeJavaScript('window.location.href = "/"; true');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(workspace.webContents.getURL(), workspaceBefore);
  await main.webContents.executeJavaScript('window.stageDesktop.openWorkspace("vocabulary")');
  assert.ok(workspace.webContents.getURL().endsWith('/workspace?view=vocabulary'));
  assert.equal(BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes('/workspace?')).length, 1);
  workspace.close();
  await eventually(() => workspace.isDestroyed());
  assert.equal(await main.webContents.executeJavaScript('window.controllerStream.getAudioTracks()[0].readyState'), 'live');
  assert.equal(retainedOutput.isVisible(), true);
  await main.webContents.executeJavaScript('window.stageDesktop.toggleOverlay()');
  assert.equal(retainedOutput.isDestroyed(), false);
  assert.equal(retainedOutput.isVisible(), false);
  await main.webContents.executeJavaScript('window.stageDesktop.toggleOverlay()');
  assert.equal(retainedOutput.isVisible(), true);
  main.webContents.send('stage:controller-action', 'settings');
  await eventually(async () => await main.webContents.executeJavaScript('window.controllerActions.length === 1'));
  await main.webContents.executeJavaScript('window.unsubscribeController(); window.controllerStream.getTracks().forEach(track => track.stop())');
  main.webContents.send('stage:controller-action', 'output');
  assert.deepEqual(await main.webContents.executeJavaScript('window.controllerActions'), ['settings']);
  await main.webContents.executeJavaScript('window.stageDesktop.openWorkspace("setup")');
  const setupWorkspace = await eventually(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/workspace?view=setup')));

  // Switching servers closes the presenter renderer and presents the local setup page.
  Menu.getApplicationMenu().items[0].submenu.items[0].click();
  testStage = 'switching to connection setup';
  const connection = await eventually(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/connection.html')));
  await eventually(() => connection.webContents.executeJavaScript('Boolean(window.stageConnection)'));
  assert.equal(main.isDestroyed(), true);
  assert.equal(setupWorkspace.isDestroyed(), true);
  assert.equal(globalShortcut.isRegistered('CommandOrControl+Shift+B'), false);
  await toggle.click();
  assert.equal(BrowserWindow.getAllWindows().filter(window => window.getTitle() === 'Stage captions').length, 0,
    'The shortcut must not create output while setting up a team server.');
  const denied = await connection.webContents.executeJavaScript('window.stageConnection.connect("http://remote.example")');
  assert.equal(denied.ok, false);
  assert.equal(await connection.webContents.executeJavaScript('typeof window.stageDesktop'), 'undefined');
  console.log(JSON.stringify({ ok: true, platform: process.platform, displays: displays.length, selectedDisplay: selected.id,
    shortcutRegistered: initialState.shortcutRegistered,
    bounds, syntheticMicrophone: media, screenshot, rollingScreenshot, checks: ['bridge', 'screen selection', 'overlay rendering',
      'newest words at 80px/1280px', 'inactive states clear stale captions',
      'shortcut opens closed output', 'settings preserve hidden output', 'fresh captions after reopen',
      'overlay lifecycle state and subscriptions', 'shortcut availability state',
      'compact controller geometry and persistence', 'hidden controller retains synthetic microphone and output',
      'separate workspace identity and permission boundaries', 'workspace closes without stopping captions',
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

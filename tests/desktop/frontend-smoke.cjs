// Run after `npm run dev`: npx electron tests/desktop/frontend-smoke.cjs
// Exercises the real React UI through the native bridge. Rehearsal only; no provider credentials.
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const profile = fsSync.mkdtempSync(path.join(os.tmpdir(), 'stage-frontend-smoke-'));
const output = process.env.STAGE_SMOKE_OUTPUT_DIR || path.resolve('outputs');
const origin = process.env.STAGE_SERVER_URL || 'http://127.0.0.1:5173';
process.env.STAGE_SERVER_URL = origin;
app.setPath('userData', profile);
// A programming regression must never make this test use a physical microphone.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
let stage = 'loading the React app';
let finished = false;

const eventually = (predicate, timeout = 30000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeout;
  const poll = async () => {
    try { const result = await predicate(); if (result) return resolve(result); } catch { /* Renderer startup. */ }
    if (Date.now() > deadline) return reject(new Error(`Timed out while ${stage}.`));
    setTimeout(poll, 100);
  };
  poll();
});

async function finish(code) {
  if (finished) return;
  finished = true;
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  app.exit(code);
}

async function click(main, label) {
  const clicked = await main.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === ${JSON.stringify(label)} && !element.disabled);
    if (!button) return false;
    button.click(); return true;
  })()`);
  assert.equal(clicked, true, `Missing enabled button: ${label}`);
}

const hasButton = (main, label) => main.webContents.executeJavaScript(
  `[...document.querySelectorAll('button')].some(button => button.textContent.trim() === ${JSON.stringify(label)})`);

async function smoke() {
  const main = await eventually(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith(origin)));
  await eventually(() => main.webContents.executeJavaScript('document.querySelector(".platform-label")?.textContent === "Desktop app"'));
  const buttons = await main.webContents.executeJavaScript('[...document.querySelectorAll("button")].map(button => button.textContent.trim())');
  assert.ok(buttons.includes('Run a rehearsal'));
  assert.ok(buttons.includes('Show captions on screen'));
  const toggle = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.accelerator === 'CommandOrControl+Shift+H');
  assert.ok(toggle, 'The global caption shortcut must have a menu fallback.');
  await main.webContents.executeJavaScript(`(() => {
    window.__stageTestMediaCalls = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.__stageTestMediaCalls++; return original(...args); };
  })()`);
  assert.equal(main.webContents.getBackgroundThrottling(), false);

  stage = 'starting a rehearsal from the actual UI';
  await click(main, 'Run a rehearsal');
  await eventually(() => main.webContents.executeJavaScript('Boolean(document.querySelector(".session-status.rehearsal"))'));
  let overlay = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  await eventually(() => hasButton(main, 'Hide captions'));
  assert.equal(overlay.isVisible(), true, 'Starting a rehearsal must automatically show native captions.');
  await eventually(() => overlay.webContents.executeJavaScript('document.getElementById("caption-status")?.dataset.status === "rehearsal" && document.getElementById("japanese")?.textContent.length > 0'));
  await overlay.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await fs.mkdir(output, { recursive: true });
  const mainScreenshot = path.join(output, 'desktop-rehearsal.png');
  const overlayScreenshot = path.join(output, 'desktop-rehearsal-overlay.png');
  await fs.writeFile(mainScreenshot, (await main.webContents.capturePage()).toPNG());
  await fs.writeFile(overlayScreenshot, (await eventually(() => overlay.webContents.capturePage())).toPNG());

  stage = 'reflecting the caption shortcut in React';
  toggle.click();
  await eventually(() => hasButton(main, 'Show captions on screen'));
  assert.equal(overlay.isVisible(), false);
  assert.equal(overlay.isDestroyed(), false, 'The shortcut must hide without closing output.');

  stage = 'changing settings while native output stays hidden';
  const beforeSettings = overlay.getBounds();
  await main.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('font-size');
    select.value = '64';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await eventually(() => overlay.getBounds().height !== beforeSettings.height);
  assert.equal(overlay.isVisible(), false, 'React settings changes must not reveal hidden captions.');
  assert.equal(await hasButton(main, 'Show captions on screen'), true);

  toggle.click();
  await eventually(() => hasButton(main, 'Hide captions'));
  assert.equal(overlay.isVisible(), true);

  stage = 'reopening closed output with the shortcut during rehearsal';
  await click(main, 'Hide captions');
  await eventually(() => overlay.isDestroyed());
  await eventually(() => hasButton(main, 'Show captions on screen'));
  toggle.click();
  overlay = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  await eventually(() => hasButton(main, 'Hide captions'));
  await eventually(() => overlay.webContents.executeJavaScript('document.getElementById("caption-status")?.dataset.status === "rehearsal" && document.getElementById("japanese")?.textContent.length > 0'));

  stage = 'stopping a rehearsal through the React controls';
  await click(main, 'Stop rehearsal');
  await eventually(() => overlay.webContents.executeJavaScript('document.getElementById("caption-status")?.dataset.status === "stopped"'));
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("japanese").textContent'), '');
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("english").textContent'), '');
  assert.equal(await main.webContents.executeJavaScript('window.__stageTestMediaCalls'), 0, 'Rehearsal must not request a microphone.');

  stage = 'closing output through React and checking UI state';
  await click(main, 'Hide captions');
  await eventually(() => overlay.isDestroyed());
  await eventually(() => hasButton(main, 'Show captions on screen'));
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  console.log(JSON.stringify({ ok: true, origin, platform: process.platform, microphoneCalls: 0, mainScreenshot, overlayScreenshot,
    checks: ['actual React desktop detection', 'rehearsal automatically opens captions', 'sample captions reach overlay',
      'menu shortcut updates React visibility', 'settings preserve hidden output', 'closed output reopens with current rehearsal captions',
      'React stop clears overlay', 'microphone stays off', 'close output updates React state'] }));
  await finish(0);
}

require('../../electron/main.cjs');
app.whenReady().then(smoke).catch(async error => { console.error(error.stack); await finish(1); });
setTimeout(() => { console.error(`Frontend smoke timed out while ${stage}.`); finish(1); }, 120000).unref();

// Run after `npm run dev`: npx electron tests/desktop/frontend-smoke.cjs
// Exercises the real React UI through the native bridge. Rehearsal only; no provider credentials.
const { app, BrowserWindow } = require('electron');
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

async function smoke() {
  const main = await eventually(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith(origin)));
  await eventually(() => main.webContents.executeJavaScript('document.querySelector(".platform-label")?.textContent === "Desktop app"'));
  const buttons = await main.webContents.executeJavaScript('[...document.querySelectorAll("button")].map(button => button.textContent.trim())');
  assert.ok(buttons.includes('Run a rehearsal'));
  assert.ok(buttons.includes('Open caption window'));
  await main.webContents.executeJavaScript(`(() => {
    window.__stageTestMediaCalls = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.__stageTestMediaCalls++; return original(...args); };
  })()`);
  assert.equal(main.webContents.getBackgroundThrottling(), false);

  stage = 'starting a rehearsal from the actual UI';
  await click(main, 'Run a rehearsal');
  await eventually(() => main.webContents.executeJavaScript('Boolean(document.querySelector(".session-status.rehearsal"))'));
  await click(main, 'Open caption window');
  const overlay = await eventually(() => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Stage captions'));
  await eventually(() => overlay.webContents.executeJavaScript('document.getElementById("caption-status")?.dataset.status === "rehearsal" && document.getElementById("japanese")?.textContent.length > 0'));
  await overlay.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await fs.mkdir(output, { recursive: true });
  const mainScreenshot = path.join(output, 'desktop-rehearsal.png');
  const overlayScreenshot = path.join(output, 'desktop-rehearsal-overlay.png');
  await fs.writeFile(mainScreenshot, (await main.webContents.capturePage()).toPNG());
  await fs.writeFile(overlayScreenshot, (await overlay.webContents.capturePage()).toPNG());

  stage = 'stopping a rehearsal through the React controls';
  await click(main, 'Stop rehearsal');
  await eventually(() => overlay.webContents.executeJavaScript('document.getElementById("caption-status")?.dataset.status === "stopped"'));
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("japanese").textContent'), '');
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("english").textContent'), '');
  assert.equal(await main.webContents.executeJavaScript('window.__stageTestMediaCalls'), 0, 'Rehearsal must not request a microphone.');

  stage = 'closing output through React and checking UI state';
  await click(main, 'Close caption window');
  await eventually(() => overlay.isDestroyed());
  await eventually(() => main.webContents.executeJavaScript('[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Open caption window")'));
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  console.log(JSON.stringify({ ok: true, origin, platform: process.platform, microphoneCalls: 0, mainScreenshot, overlayScreenshot,
    checks: ['actual React desktop detection', 'rehearsal starts', 'React opens native captions', 'sample captions reach overlay',
      'React stop clears overlay', 'microphone stays off', 'close output updates React state'] }));
  await finish(0);
}

require('../../electron/main.cjs');
app.whenReady().then(smoke).catch(async error => { console.error(error.stack); await finish(1); });
setTimeout(() => { console.error(`Frontend smoke timed out while ${stage}.`); finish(1); }, 120000).unref();

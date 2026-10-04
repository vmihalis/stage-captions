import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Run manually after packaging: node tests/desktop/packaged-smoke.mjs <app-binary> [screenshot]
// This opens the packaged local setup window. It never accepts an address,
// requests microphone access, or connects to a speech service.
const executable = process.argv[2];
if (!executable) throw new Error('Pass the path to a packaged Stage executable.');
const screenshot = resolve(process.argv[3] || 'outputs/packaged-setup.png');
const profile = await mkdtemp(join(tmpdir(), 'stage-package-smoke-'));
const portReservation = createServer();
portReservation.listen(0, '127.0.0.1');
await once(portReservation, 'listening');
const port = portReservation.address().port;
await new Promise((done) => portReservation.close(done));
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
let child;
let socket;
let browserLog = '';
try {
  const env = { ...process.env, STAGE_SERVER_URL: 'http://invalid.example' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(resolve(executable), [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.stderr.on('data', (chunk) => { browserLog = (browserLog + chunk.toString()).slice(-12_000); });
  let target;
  const deadline = Date.now() + 25_000;
  while (!target && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Packaged app exited before setup loaded (${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json();
      target = targets.find((page) => page.type === 'page' && page.url.startsWith('file:') && page.url.endsWith('/connection.html'));
    } catch { /* The native app may still be starting. */ }
    if (!target) await delay(100);
  }
  assert.ok(target, `Packaged local setup did not appear. ${browserLog}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  const requests = new Map();
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiting = requests.get(message.id);
    if (!waiting) return;
    requests.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 8000);
    requests.set(id, { resolve: done, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  const config = await evaluate('window.stageConnection.getConfiguration()');
  assert.equal(config.development, false, 'The packaged app must enforce production address rules.');
  assert.equal(await evaluate('Boolean(document.querySelector("#connection-form"))'), true);
  assert.equal(await evaluate('document.querySelector("#development-note").hidden'), true);
  for (const address of ['http://localhost:5173', 'http://example.invalid', 'https://name:password@example.invalid', 'https://example.invalid/path']) {
    const result = await evaluate(`window.stageConnection.connect(${JSON.stringify(address)})`);
    assert.equal(result.ok, false, `Unexpectedly accepted ${address}`);
    assert.equal(typeof result.error, 'string');
  }
  await evaluate('document.fonts.ready.then(() => true)');
  const capture = await call('Page.captureScreenshot', { format: 'png' });
  const pixels = Buffer.from(capture.data, 'base64');
  assert.ok(pixels.length > 5000, 'Setup screenshot is unexpectedly small.');
  await mkdir(dirname(screenshot), { recursive: true });
  await writeFile(screenshot, pixels);
  console.log('Packaged setup passed: production mode, preload IPC, invalid address rejection, and rendered local UI.');
  console.log(`Screenshot: ${screenshot}`);
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([exited, delay(4000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  await rm(profile, { recursive: true, force: true });
}

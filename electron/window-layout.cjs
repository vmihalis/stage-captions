const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function safeWindowArea(workArea, strip, position) {
  if (!workArea || !strip || !['top', 'bottom'].includes(position)) return null;
  const top = position === 'top' ? strip.y + strip.height : workArea.y;
  const bottom = position === 'bottom' ? strip.y : workArea.y + workArea.height;
  if (![workArea.x, workArea.y, workArea.width, workArea.height, strip.x, strip.y, strip.width, strip.height, top, bottom]
    .every(Number.isFinite) || strip.x !== workArea.x || strip.width !== workArea.width ||
    top < workArea.y || bottom > workArea.y + workArea.height || bottom - top < 100) return null;
  return { x: workArea.x, y: top, width: workArea.width, height: bottom - top };
}

function createWindowLayout({ app, platform = process.platform, spawnProcess = spawn, helperPath } = {}) {
  const binary = helperPath || (app.isPackaged
    ? path.join(process.resourcesPath, '..', 'Helpers', 'StageWindowLayout.app', 'Contents', 'MacOS', 'StageWindowLayout')
    : path.join(__dirname, '..', 'build', 'mac', 'StageWindowLayout.app', 'Contents', 'MacOS', 'StageWindowLayout'));
  let child;
  let pending;
  let signature;
  const statusPath = app.getPath ? path.join(app.getPath('userData'), 'window-layout-status.json') : null;
  function status(state) {
    if (statusPath) try {
      fs.writeFileSync(statusPath, JSON.stringify({ state, at: new Date().toISOString() }), { mode: 0o600 });
    } catch { /* Diagnostics must not interrupt captions. */ }
  }

  function stop() {
    clearTimeout(pending);
    pending = undefined;
    signature = undefined;
    if (!child) return;
    const previous = child;
    child = undefined;
    if (!previous.killed) {
      previous.stdin?.end('stop\n');
      const fallback = setTimeout(() => { if (previous.exitCode === null) previous.kill('SIGTERM'); }, 1500);
      fallback.unref();
      previous.once('exit', () => clearTimeout(fallback));
    }
  }

  function start(workArea, strip, position) {
    if (platform !== 'darwin') return;
    const safe = safeWindowArea(workArea, strip, position);
    if (!safe || !fs.existsSync(binary)) { stop(); status('unavailable'); return; }
    const next = JSON.stringify({ workArea, safe });
    if (signature === next) return;
    stop();
    signature = next;
    pending = setTimeout(() => {
      pending = undefined;
      const args = ['--watch', ...['x', 'y', 'width', 'height'].map(key => String(workArea[key])),
        ...['x', 'y', 'width', 'height'].map(key => String(safe[key])), String(process.pid)];
      try {
        child = spawnProcess(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const own = child;
        own.stdin?.on('error', () => {});
        let output = '';
        own.stdout?.on('data', chunk => {
          output += chunk.toString();
          for (let end = output.indexOf('\n'); end !== -1; end = output.indexOf('\n')) {
            const line = output.slice(0, end);
            output = output.slice(end + 1);
            try { status(JSON.parse(line).state); } catch { /* Ignore malformed helper output. */ }
          }
          if (output.length > 1024) output = '';
        });
        own.on('error', () => { if (child === own) { child = undefined; signature = undefined; status('error'); } });
        own.on('exit', () => { if (child === own) { child = undefined; signature = undefined; } });
      } catch { signature = undefined; status('error'); }
    }, 450);
    pending.unref();
  }

  return { start, stop };
}

module.exports = { safeWindowArea, createWindowLayout };

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { safeWindowArea, createWindowLayout } = require('../../electron/window-layout.cjs');

test('macOS window layout excludes the entire caption strip at either edge', () => {
  const workArea = { x: -1680, y: 25, width: 1680, height: 1000 };
  const bottom = { x: -1680, y: 775, width: 1680, height: 250 };
  assert.deepEqual(safeWindowArea(workArea, bottom, 'bottom'),
    { x: -1680, y: 25, width: 1680, height: 750 });
  const top = { x: -1680, y: 25, width: 1680, height: 250 };
  assert.deepEqual(safeWindowArea(workArea, top, 'top'),
    { x: -1680, y: 275, width: 1680, height: 750 });
  assert.equal(safeWindowArea(workArea, { ...bottom, y: 100 }, 'bottom'), null);
});

test('opt-in layout helper receives the safe area and stops when captions hide', async () => {
  const workArea = { x: 0, y: 25, width: 1680, height: 1000 };
  const strip = { x: 0, y: 775, width: 1680, height: 250 };
  const calls = [];
  let stopped = false;
  const helper = new EventEmitter();
  helper.stdin = { on() {}, end: value => { stopped = value === 'stop\n'; } };
  helper.stdout = { on() {} };
  helper.exitCode = null;
  const layout = createWindowLayout({ app: { isPackaged: false }, platform: 'darwin', helperPath: process.execPath,
    spawnProcess: (binary, args) => { calls.push({ binary, args }); return helper; } });
  layout.start(workArea, strip, 'bottom');
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 10), ['--watch', '0', '25', '1680', '1000', '0', '25', '1680', '750', String(process.pid)]);
  layout.stop();
  assert.equal(stopped, true);
  helper.emit('exit');
});

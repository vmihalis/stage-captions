const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeControllerState, normalizeControllerLayout, savedControllerPosition, controllerBounds,
  workspaceURL, isWorkspaceURL, controllerLabel, trayBitmap, createOwnedSummaryRunner } = require('../../electron/controller.cjs');

test('controller bridge accepts only small explicit state and size values', () => {
  const state = { status: 'live', paused: false, pending: 2 };
  assert.deepEqual(normalizeControllerState(state), state);
  for (const invalid of [null, [], { ...state, audio: 'not allowed' }, { ...state, paused: 'true' },
    { ...state, status: 'unknown' }, { ...state, pending: -1 }, { ...state, pending: 1.5 }, { ...state, pending: 100001 }]) {
    assert.throws(() => normalizeControllerState(invalid));
  }
  assert.deepEqual(normalizeControllerLayout({ height: -100 }), { height: 64 });
  assert.deepEqual(normalizeControllerLayout({ height: 10000 }), { height: 760 });
  assert.deepEqual(normalizeControllerLayout({ height: 250.7 }), { height: 251 });
  for (const invalid of [null, [], { height: Infinity }, { height: NaN }, { height: '70' }, { height: 70, width: 1000 }]) {
    assert.throws(() => normalizeControllerLayout(invalid));
  }
});

test('floating controller fits work areas and recovers from unplugged displays', () => {
  const main = { id: 1, workArea: { x: 0, y: 24, width: 1440, height: 850 } };
  const left = { id: 2, workArea: { x: -1920, y: 30, width: 1920, height: 1050 } };
  const above = { id: 3, workArea: { x: 0, y: -900, width: 1440, height: 900 } };
  const position = { x: -500, y: 1010 };
  const bounds = controllerBounds([main, left, above], 1, position, 600);
  assert.deepEqual(bounds, { x: -500, y: 480, width: 440, height: 600 });
  assert.deepEqual(controllerBounds([main], 1, position, 600), { x: 0, y: 274, width: 440, height: 600 });
  assert.equal(controllerBounds([main], 1, undefined, 64).width, 440);
  assert.equal(controllerBounds([main], 1, undefined, 900).height, 760);
  assert.deepEqual(controllerBounds([{ id: 1, workArea: { x: 200, y: 100, width: 300, height: 240 } }], 1, undefined, 600),
    { x: 200, y: 100, width: 300, height: 240 });
  assert.deepEqual(savedControllerPosition({ x: -500, y: 80 }), { x: -500, y: 80 });
  assert.equal(savedControllerPosition({ x: 0, y: 1, url: 'https://unexpected.example' }), undefined);
  assert.equal(savedControllerPosition({ x: Infinity, y: 1 }), undefined);
});

test('workspace routes cannot introduce arbitrary URLs, views, or query data', () => {
  const origin = 'https://team.example';
  const id = '09b2b180-ac00-4eef-9d16-fb21e35096d9';
  for (const view of ['meetings', 'vocabulary', 'setup']) {
    assert.equal(workspaceURL(origin, view), `${origin}/workspace?view=${view}`);
    assert.equal(isWorkspaceURL(workspaceURL(origin, view), origin), true);
  }
  assert.equal(isWorkspaceURL(workspaceURL(origin, 'meetings', id), origin), true);
  for (const view of ['/admin', 'https://elsewhere.example', 'present', null]) assert.throws(() => workspaceURL(origin, view));
  assert.throws(() => workspaceURL(origin, 'meetings', '../../private'));
  assert.throws(() => workspaceURL(origin, 'vocabulary', id));
  for (const url of [`${origin}/`, `${origin}/workspace?view=meetings#extra`, `${origin}/workspace?view=meetings&view=setup`,
    `${origin}/workspace?view=meetings&url=https://elsewhere.example`, 'https://elsewhere.example/workspace?view=meetings',
    'https://user:pass@team.example/workspace?view=meetings', `${origin}/workspace/?view=meetings`]) {
    assert.equal(isWorkspaceURL(url, origin), false);
  }
});

test('tray status distinguishes actual speech, rehearsal, pause, errors, and pending saves', () => {
  assert.match(controllerLabel({ status: 'live', paused: false, pending: 0 }), /microphone on/);
  assert.equal(controllerLabel({ status: 'live', paused: true, pending: 0 }), 'Speech paused');
  assert.match(controllerLabel({ status: 'rehearsal', paused: false, pending: 0 }), /microphone off/);
  assert.match(controllerLabel({ status: 'error', paused: false, pending: 2 }), /interrupted.*saving 2/);
  const normal = trayBitmap({ status: 'live', paused: false });
  assert.equal(normal.length, 32 * 32 * 4);
  assert.ok(normal.some((value, index) => index % 4 === 3 && value === 255));
  assert.ok(normal.some((value, index) => index % 4 === 3 && value === 0));
  assert.notDeepEqual(trayBitmap({ status: 'live', paused: true }), normal);
});

test('summary cancellation belongs to the window that started it', async () => {
  const main = {}, workspace = {};
  let resolve;
  let cancels = 0;
  const owned = createOwnedSummaryRunner({ run: () => new Promise(done => { resolve = done; }), cancel: () => { cancels++; resolve({ ok: false }); } });
  const first = owned.run(workspace, {});
  owned.cancel(main);
  assert.equal(cancels, 0, 'Closing or cancelling from an unrelated window must not end this worker.');
  assert.equal((await owned.run(main, {})).error.code, 'BUSY');
  owned.cancel(workspace);
  assert.equal(cancels, 1);
  await first;
  const second = owned.run(main, {});
  owned.cancel();
  await second;
  assert.equal(cancels, 2, 'Application quit cancels whichever window owns the active worker.');
});

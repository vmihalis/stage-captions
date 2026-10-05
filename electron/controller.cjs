const fs = require('node:fs/promises');
const path = require('node:path');

const STATUSES = new Set(['idle', 'connecting', 'live', 'rehearsal', 'reconnecting', 'error', 'stopped', 'stopping']);
const VIEWS = new Set(['meetings', 'vocabulary', 'setup']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeControllerState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['status', 'paused', 'pending'].includes(key))
    || !STATUSES.has(value.status) || typeof value.paused !== 'boolean'
    || !Number.isSafeInteger(value.pending) || value.pending < 0 || value.pending > 100000) {
    throw new Error('Invalid controller state.');
  }
  return { status: value.status, paused: value.paused, pending: value.pending };
}

function normalizeControllerLayout(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'height')
    || typeof value.height !== 'number' || !Number.isFinite(value.height)) {
    throw new Error('Invalid controller size.');
  }
  return { height: Math.max(64, Math.min(760, Math.round(value.height))) };
}

function savedControllerPosition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['x', 'y'].includes(key))
    || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)
    || Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000) return undefined;
  return { x: value.x, y: value.y };
}

function controllerBounds(displays, primaryId, position, requestedHeight) {
  const primary = displays.find(display => display.id === primaryId) || displays[0];
  if (!primary) throw new Error('No display is available.');
  const anchor = savedControllerPosition(position);
  const score = display => {
    if (!anchor) return 0;
    const area = display.workArea;
    return Math.max(0, Math.min(anchor.x + 440, area.x + area.width) - Math.max(anchor.x, area.x))
      * Math.max(0, Math.min(anchor.y + 64, area.y + area.height) - Math.max(anchor.y, area.y));
  };
  const display = displays.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best, primary);
  const area = display.workArea;
  const width = Math.max(1, Math.min(440, area.width));
  const height = Math.max(1, Math.min(Math.max(64, requestedHeight), 760, area.height));
  const x = anchor?.x ?? area.x + area.width - width - 24;
  const y = anchor?.y ?? area.y + 24;
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width, height };
}

function workspaceURL(origin, view, meetingId) {
  if (!VIEWS.has(view) || (meetingId !== undefined && (view !== 'meetings' || typeof meetingId !== 'string' || !UUID.test(meetingId)))) {
    throw new Error('Choose a valid workspace view.');
  }
  const url = new URL('/workspace', origin);
  url.searchParams.set('view', view);
  if (meetingId !== undefined) url.searchParams.set('meeting', meetingId);
  return url.href;
}

function isWorkspaceURL(value, origin) {
  try {
    const url = new URL(value);
    return Boolean(origin) && url.origin === origin && url.pathname === '/workspace'
      && value === workspaceURL(origin, url.searchParams.get('view'), url.searchParams.get('meeting') ?? undefined);
  } catch { return false; }
}

function controllerLabel(state) {
  let label;
  if (state.status === 'rehearsal') label = state.paused ? 'Rehearsal paused · microphone off' : 'Rehearsal · microphone off';
  else if (state.paused) label = 'Speech paused';
  else if (state.status === 'live') label = 'Live · microphone on';
  else if (state.status === 'connecting') label = 'Connecting · microphone starting';
  else if (state.status === 'reconnecting') label = 'Reconnecting · microphone on';
  else if (state.status === 'stopping') label = 'Finishing · microphone stopping';
  else if (state.status === 'error') label = 'Session interrupted · microphone off';
  else label = 'Ready · microphone off';
  return state.pending > 0 ? `${label} · saving ${state.pending}` : label;
}

function trayBitmap(state) {
  const bytes = Buffer.alloc(32 * 32 * 4);
  const color = state.status === 'error' ? [62, 69, 191] : state.paused ? [36, 157, 214]
    : state.status === 'live' ? [70, 139, 74] : [44, 62, 62];
  const rect = (x, y, width, height) => {
    for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
      const offset = (row * 32 + col) * 4;
      bytes[offset] = color[0]; bytes[offset + 1] = color[1]; bytes[offset + 2] = color[2]; bytes[offset + 3] = 255;
    }
  };
  // A small caption frame remains legible in monochrome menu bars.
  rect(3, 5, 26, 3); rect(3, 24, 26, 3); rect(3, 8, 3, 16); rect(26, 8, 3, 16);
  if (state.paused) { rect(10, 11, 4, 10); rect(18, 11, 4, 10); }
  else { rect(9, 12, 6, 3); rect(18, 12, 5, 3); rect(9, 18, 14, 3); }
  return bytes;
}

function createOwnedSummaryRunner(runner) {
  let active;
  return {
    async run(owner, payload) {
      if (active) return { ok: false, error: { code: 'BUSY', message: 'A meeting summary is already running. Wait or cancel it first.', recoverable: true } };
      const task = { owner };
      active = task;
      try { return await runner.run(payload); }
      finally { if (active === task) active = undefined; }
    },
    cancel(owner) {
      if (!active || (owner !== undefined && active.owner !== owner)) return;
      active = undefined;
      runner.cancel();
    },
  };
}

function createController({ app, screen, Tray, Menu, nativeImage, onAction, onWorkspace }) {
  let window;
  let tray;
  let compact = false;
  let position;
  let appliedPosition;
  let requestedHeight = 64;
  let persistTimer;
  let shortcutRegistered = false;
  let state = { status: 'idle', paused: false, pending: 0 };
  const settingsPath = path.join(app.getPath('userData'), 'controller-window.json');
  const active = () => window && !window.isDestroyed();

  async function persist() {
    if (!position) return;
    const content = JSON.stringify(position);
    try {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, content, { mode: 0o600 });
    } catch { /* A remembered position is optional; never interrupt recording. */ }
  }
  function icon() {
    const image = nativeImage.createFromBitmap(trayBitmap(state), { width: 32, height: 32 }).resize({ width: process.platform === 'darwin' ? 18 : 24 });
    if (process.platform === 'darwin') image.setTemplateImage(true);
    return image;
  }
  function show() {
    if (!active()) return;
    if (compact) layout({ height: requestedHeight });
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); refreshTray();
  }
  function hide() {
    if (!active()) return;
    // Keep a recovery path if the desktop has no tray implementation.
    if (!tray && !shortcutRegistered && process.platform !== 'darwin') return;
    window.hide(); refreshTray();
  }
  function toggle() { if (active() && window.isVisible()) hide(); else show(); }
  function action(value) { if (!active()) return; show(); onAction(value); }
  function refreshTray() {
    if (!tray || tray.isDestroyed()) return;
    tray.setImage(icon());
    tray.setToolTip(`Stage · ${controllerLabel(state)}`);
    const running = ['live', 'rehearsal'].includes(state.status);
    const canStart = ['idle', 'stopped', 'error'].includes(state.status);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: controllerLabel(state), enabled: false },
      { type: 'separator' },
      { label: active() && window.isVisible() ? 'Hide Stage remote' : 'Show Stage remote', enabled: Boolean(active()), click: toggle },
      { label: running ? (state.paused ? 'Resume captions' : 'Pause captions') : 'Start captions', enabled: Boolean(active()) && (running || canStart), click: () => action('toggle-recording') },
      { label: 'End meeting', enabled: Boolean(active()) && ['connecting', 'live', 'rehearsal', 'reconnecting'].includes(state.status), click: () => action('end-meeting') },
      { type: 'separator' },
      { label: 'Caption output', enabled: Boolean(active()), click: () => action('output') },
      { label: 'Settings', enabled: Boolean(active()), click: () => action('settings') },
      { label: 'Meetings', enabled: Boolean(active()), click: () => onWorkspace('meetings') },
      { type: 'separator' }, { role: 'quit', label: 'Quit Stage' },
    ]));
  }
  async function initialize() {
    if (tray && !tray.isDestroyed()) return;
    try {
      const info = await fs.stat(settingsPath);
      if (!position && info.size <= 1024) position = savedControllerPosition(JSON.parse(await fs.readFile(settingsPath, 'utf8')));
    } catch { /* First launch or malformed saved position uses the primary screen. */ }
    try {
      tray = new Tray(icon());
      tray.on('click', toggle);
      refreshTray();
    } catch { tray = undefined; }
  }
  function attach(nextWindow) {
    window = nextWindow; compact = false;
    state = { status: 'idle', paused: false, pending: 0 };
    appliedPosition = undefined;
    window.on('move', () => {
      if (!compact || !active()) return;
      const { x, y } = window.getBounds();
      if (appliedPosition?.x === x && appliedPosition?.y === y) return;
      position = { x, y };
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persist, 180);
    });
    window.on('show', refreshTray); window.on('hide', refreshTray);
    window.on('closed', () => { if (window === nextWindow) window = undefined; refreshTray(); });
    refreshTray();
  }
  function layout(value) {
    const next = normalizeControllerLayout(value);
    if (!active()) return;
    requestedHeight = next.height;
    const bounds = controllerBounds(screen.getAllDisplays(), screen.getPrimaryDisplay().id, position, requestedHeight);
    compact = true;
    // Clear previous minimums before shrinking the legacy presenter window.
    window.setMinimumSize(1, 1);
    window.setMaximumSize(100000, 100000);
    appliedPosition = { x: bounds.x, y: bounds.y };
    if (!position) position = appliedPosition;
    window.setBounds(bounds, false);
    window.setMinimumSize(bounds.width, Math.min(64, bounds.height));
    window.setMaximumSize(bounds.width, Math.max(bounds.height, Math.min(760, screen.getDisplayMatching(bounds).workArea.height)));
    window.setResizable(false); window.setMaximizable(false); window.setFullScreenable(false);
    window.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    else if (process.platform === 'linux') window.setVisibleOnAllWorkspaces(true);
  }
  function update(value) {
    const next = normalizeControllerState(value);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next; refreshTray();
  }
  function dispose() {
    clearTimeout(persistTimer); void persist();
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = undefined;
  }
  return { initialize, attach, layout, update, show, hide, toggle, dispose,
    displaysChanged: () => { if (compact) layout({ height: requestedHeight }); },
    setShortcutRegistered(value) { shortcutRegistered = Boolean(value); },
    get compact() { return compact; }, get shortcutRegistered() { return shortcutRegistered; } };
}

module.exports = { createController, normalizeControllerState, normalizeControllerLayout, savedControllerPosition,
  controllerBounds, workspaceURL, isWorkspaceURL, controllerLabel, trayBitmap, createOwnedSummaryRunner };

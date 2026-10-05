const path = require('node:path');
const { captureSourceAllowed } = require('./guards.cjs');

// Capture permissions belong only to this local renderer. No capture identifiers,
// window titles, thumbnails or MediaStreams cross the hosted Stage bridge.
function createPresentation({ BrowserWindow, desktopCapturer, screen, session, ipcMain,
  rendererPreferences, guardNavigation, requireSender, localURL, onState, onClosed = () => {}, getCaptionState }) {
  let window;
  let options;
  let ready = false;
  let state = 'choosing';
  let sources = new Map();
  let selection;
  let grantPending = false;
  const url = localURL('presentation.html');
  const partition = session.fromPartition('stage-presentation');
  const active = () => window && !window.isDestroyed();
  const trusted = (contents, requestURL, isMainFrame) => Boolean(active()
    && contents === window.webContents && contents.getURL() === url
    && requestURL === url && isMainFrame === true);
  const requireLocal = event => requireSender(event, window, candidate => candidate === url);
  const target = () => screen.getAllDisplays().find(display => String(display.id) === options?.displayId);
  const ownIds = () => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => win.getMediaSourceId());
  const allowed = source => Boolean(target() && captureSourceAllowed(source, target(), screen.getAllDisplays(), ownIds()));
  function revokeSelection() { selection = undefined; grantPending = false; }
  function clearSelection() { revokeSelection(); sources.clear(); }
  function report(next) { state = next; onState(); }
  function send() {
    if (active() && ready) window.webContents.send('stage:caption-state', getCaptionState());
  }
  function chooser() {
    if (!active()) return;
    clearSelection();
    window.webContents.send('stage:presentation-reset');
    report('choosing');
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = { x: area.x + 32, y: area.y + 32, width: Math.min(920, area.width - 64), height: Math.min(720, area.height - 64) };
    if (window.isFullScreen()) {
      window.once('leave-full-screen', () => { if (active()) window.setBounds(bounds); });
      window.setFullScreen(false);
    } else window.setBounds(bounds);
    window.show();
  }
  partition.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'display-capture' && grantPending
      && trusted(contents, details.requestingUrl, details.isMainFrame));
  });
  partition.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === 'display-capture' && grantPending && trusted(contents, details.requestingUrl, details.isMainFrame));
  partition.setDevicePermissionHandler(() => false);
  partition.setDisplayMediaRequestHandler((request, callback) => {
    if (!active() || request.frame !== window.webContents.mainFrame || request.frame.url !== url
      || !request.userGesture || !request.videoRequested || request.audioRequested || !grantPending || !allowed(selection)) {
      callback({});
      return;
    }
    grantPending = false;
    callback({ video: { id: selection.id, name: selection.name } });
  }, { useSystemPicker: false });
  partition.on('will-download', event => event.preventDefault());
  ipcMain.handle('stage:presentation-sources', async event => {
    requireLocal(event);
    const owner = window;
    // Enumeration happens only after a local picker button click. No thumbnails.
    const found = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    requireLocal(event);
    if (window !== owner) throw new Error('The source picker was closed.');
    sources = new Map(found.filter(allowed).map(source => [source.id, source]));
    return Array.from(sources.values(), source => ({ id: source.id, name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window' }));
  });
  ipcMain.handle('stage:presentation-select', (event, id) => {
    requireLocal(event);
    const source = typeof id === 'string' && sources.get(id);
    if (!source || !allowed(source)) throw new Error('Choose an available source outside the output screen.');
    selection = source;
    grantPending = true;
  });
  ipcMain.handle('stage:presentation-started', event => {
    requireLocal(event);
    if (!selection || grantPending || !allowed(selection)) throw new Error('The selected screen is no longer available.');
    window.setBounds(target().bounds);
    window.setFullScreen(true);
    report('sharing');
  });
  ipcMain.handle('stage:presentation-stop', event => { requireLocal(event); chooser(); });
  ipcMain.on('stage:presentation-ready', event => {
    try { requireLocal(event); ready = true; send(); } catch { /* No other privileges. */ }
  });
  ipcMain.on('stage:presentation-error', event => {
    try {
      requireLocal(event);
      // The picker still displays these sources after an OS permission failure.
      // Retain the list for an explicit retry, but never retain its capture grant.
      revokeSelection();
      report('error');
    } catch { /* Ignore untrusted senders. */ }
  });
  return {
    get window() { return active() ? window : undefined; },
    get status() { return active() ? state : null; },
    send,
    configure(next) {
      const changedDisplay = options?.displayId !== next.displayId;
      options = next;
      if (active() && changedDisplay) chooser();
      send();
    },
    displaysChanged() {
      if (active() && (!target() || (selection && !allowed(selection)))) chooser();
    },
    async open(next) {
      options = next;
      const displays = screen.getAllDisplays();
      if (!target() || !displays.some(display => display.id !== target().id
        && (display.bounds.x !== target().bounds.x || display.bounds.y !== target().bounds.y))) {
        throw new Error('Presentation output needs an extended display. For a mirrored projector, use a separate caption window beside your windowed slides.');
      }
      if (active()) { chooser(); return; }
      window = new BrowserWindow({ title: 'Stage presentation', width: 920, height: 720,
        minWidth: 640, minHeight: 480, show: false, backgroundColor: '#111710',
        webPreferences: rendererPreferences('presentation-preload.cjs', 'stage-presentation') });
      const owner = window;
      ready = false;
      guardNavigation(owner, candidate => candidate === url);
      owner.on('closed', () => {
        if (window !== owner) return;
        clearSelection(); window = undefined; ready = false; onState(); onClosed();
      });
      owner.on('show', onState);
      owner.on('hide', onState);
      owner.webContents.on('did-start-loading', () => { clearSelection(); ready = false; report('choosing'); });
      owner.webContents.on('render-process-gone', () => { if (!owner.isDestroyed()) owner.destroy(); });
      owner.on('leave-full-screen', () => {
        if (state === 'sharing') chooser();
      });
      try { await owner.loadFile(path.join(__dirname, 'presentation.html')); }
      catch (error) { if (!owner.isDestroyed()) owner.destroy(); throw error; }
      if (owner.isDestroyed() || window !== owner) return;
      chooser(); send();
    },
    close(force = false) {
      if (!active()) return;
      window.webContents.send('stage:presentation-reset');
      clearSelection();
      if (force) window.destroy();
      else window.close();
    },
  };
}

module.exports = { createPresentation };

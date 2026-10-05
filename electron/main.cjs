const { app, BrowserWindow, ipcMain, screen, session, globalShortcut, Menu, desktopCapturer, dialog, Tray, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeServerOrigin, matchesOrigin, normalizeOverlayOptions, normalizeCaptionPayload,
  chooseDisplay, overlayBounds, separateWindowBounds } = require('./guards.cjs');

const { createPresentation } = require('./presentation.cjs');
const { createSummaryRunner } = require('./summary.cjs');
const { summaryEnvironment } = require('./summary-config.cjs');
const { createController, workspaceURL, isWorkspaceURL, createOwnedSummaryRunner } = require('./controller.cjs');
let summaryRunner = createSummaryRunner();
let summaryTasks = createOwnedSummaryRunner(summaryRunner);

const localURL = file => pathToFileURL(path.join(__dirname, file)).href;
let mainWindow;
let workspaceWindow;
let workspaceGeneration = 0;
let controller;
let connectionWindow;
let overlayWindow;
let presentation;
let trustedOrigin = '';
let connectionMessage = '';
let changingServer = false;
let quitting = false;
let overlayReady = false;
let overlayLoading;
let overlayToggleQueue = Promise.resolve();
let shortcutRegistered = false;
let overlayOptions = { fontSize: 48, position: 'bottom', showEnglish: false, opacity: .88, clickThrough: true };
let captions = { english: '', japanese: '', partialJapanese: '', status: 'idle' };

function rendererPreferences(preload, partition) {
  return { preload: path.join(__dirname, preload), contextIsolation: true, sandbox: true,
    nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false,
    webviewTag: false, partition };
}

function guardNavigation(window, allowed) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => { if (!allowed(event.url)) event.preventDefault(); });
  window.webContents.on('will-redirect', event => { if (!allowed(event.url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Closing Stage must always end capture, even if the loaded page registers beforeunload.
  window.webContents.on('will-prevent-unload', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => {
    // Subframes are unnecessary in a caption app, including ones at the same origin.
    if (!event.isMainFrame || !allowed(event.url)) event.preventDefault();
  });
}

function requireSender(event, window, allowed) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      !event.senderFrame || event.senderFrame !== window.webContents.mainFrame || !allowed(event.senderFrame.url)) {
    throw new Error('This window cannot perform that action.');
  }
}
const requireMainSender = event => requireSender(event, mainWindow, url => matchesOrigin(url, trustedOrigin));
const requireConnectionSender = event => requireSender(event, connectionWindow, url => url === localURL('connection.html'));
const requireAppSender = event => {
  if (workspaceWindow && !workspaceWindow.isDestroyed() && event.sender === workspaceWindow.webContents) {
    requireSender(event, workspaceWindow, url => isWorkspaceURL(url, trustedOrigin));
    return workspaceWindow;
  }
  requireMainSender(event);
  return mainWindow;
};

function denyPermissions(partition) {
  const localSession = session.fromPartition(partition);
  localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  localSession.setPermissionCheckHandler(() => false);
  localSession.setDevicePermissionHandler(() => false);
}

function installMainPermissions() {
  const mainSession = session.fromPartition('persist:stage-team');
  const trusted = (contents, url, isMainFrame) => Boolean(mainWindow && !mainWindow.isDestroyed()
    && contents === mainWindow.webContents && isMainFrame === true
    && matchesOrigin(contents.getURL(), trustedOrigin) && matchesOrigin(url, trustedOrigin));
  mainSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'audio');
    callback(permission === 'media' && audioOnly && trusted(contents, details.requestingUrl, details.isMainFrame));
  });
  mainSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && trusted(contents, origin, details.isMainFrame));
  mainSession.setDevicePermissionHandler(() => false);
  mainSession.on('will-download', event => event.preventDefault());
}

function sendCaptions() {
  presentation?.send();
  if (overlayReady && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('stage:caption-state', { options: overlayOptions, captions });
  }
}

function getOverlayState() {
  const output = presentation?.window || overlayWindow;
  const open = Boolean(output && !output.isDestroyed());
  return { open, visible: open && output.isVisible(), shortcutRegistered,
    outputMode: overlayOptions.outputMode || 'overlay', presentationStatus: presentation?.status || null };
}

function sendOverlayState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stage:overlay-state', getOverlayState());
  }
}

function positionOverlay(force = false) {
  presentation?.displaysChanged();
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = chooseDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, overlayOptions.displayId);
  if (!display) return;
  const mode = overlayOptions.outputMode || 'overlay';
  const movedDisplay = overlayOptions.displayId !== String(display.id);
  overlayOptions.displayId = String(display.id);
  // A normal caption window belongs to the presenter: font changes preserve its bounds.
  if (mode === 'window' && !force && !movedDisplay) return;
  overlayWindow.setBounds((mode === 'window' ? separateWindowBounds : overlayBounds)(display.workArea, overlayOptions), false);
}

function configureOverlay(options) {
  const next = normalizeOverlayOptions(options);
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const preferred = next.displayId || (next.outputMode === 'presentation' ? String(displays.find(display => display.id !== primaryId)?.id || primaryId) : undefined);
  next.displayId = String(chooseDisplay(displays, primaryId, preferred)?.id || '');
  const changedMode = (next.outputMode || 'overlay') !== (overlayOptions.outputMode || 'overlay');
  const changedDisplay = next.displayId !== overlayOptions.displayId;
  if (changedMode) closeOverlay(true);
  overlayOptions = next;
  if (next.outputMode === 'presentation') presentation.configure(next);
  else {
    positionOverlay(changedDisplay);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(next.outputMode !== 'window' && next.clickThrough);
    }
  }
  sendCaptions();
  sendOverlayState();
}

async function openOverlay(options) {
  configureOverlay(options);
  if (overlayOptions.outputMode === 'presentation') { await presentation.open(overlayOptions); return; }
  const windowed = overlayOptions.outputMode === 'window';
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    const display = chooseDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, overlayOptions.displayId);
    if (!display) throw new Error('No display is available for captions.');
    overlayWindow = new BrowserWindow({ ...(windowed ? separateWindowBounds : overlayBounds)(display.workArea, overlayOptions),
      title: 'Stage captions', show: false, transparent: !windowed, frame: windowed, hasShadow: windowed,
      resizable: windowed, movable: windowed, minimizable: windowed, maximizable: windowed,
      ...(windowed ? { minWidth: 420, minHeight: 180, backgroundColor: '#151b12' } : {}),
      fullscreenable: false, focusable: windowed, skipTaskbar: !windowed,
      ...(!windowed && process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: rendererPreferences('overlay-preload.cjs', 'stage-overlay') });
    const createdWindow = overlayWindow;
    guardNavigation(createdWindow, url => url === localURL('overlay.html'));
    if (!windowed) createdWindow.setAlwaysOnTop(true, 'screen-saver');
    if (!windowed && process.platform === 'darwin') {
      // A nonactivating panel joins fullscreen Spaces without hiding Stage's Dock icon.
      createdWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    } else if (!windowed && process.platform === 'linux') createdWindow.setVisibleOnAllWorkspaces(true);
    createdWindow.on('show', sendOverlayState);
    createdWindow.on('hide', sendOverlayState);
    createdWindow.on('closed', () => {
      if (overlayWindow !== createdWindow) return;
      overlayWindow = undefined;
      overlayReady = false;
      sendOverlayState();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stage:overlay-closed');
    });
    const loading = createdWindow.loadFile(path.join(__dirname, 'overlay.html')).catch(error => {
      if (!createdWindow.isDestroyed()) createdWindow.destroy();
      throw error;
    }).finally(() => { if (overlayLoading === loading) overlayLoading = undefined; });
    overlayLoading = loading;
    sendOverlayState();
  }
  const ownWindow = overlayWindow;
  if (overlayLoading) await overlayLoading;
  // The presenter can close Stage or change servers while the overlay loads.
  if (ownWindow.isDestroyed() || overlayWindow !== ownWindow) return;
  positionOverlay();
  ownWindow.setIgnoreMouseEvents(!windowed && overlayOptions.clickThrough);
  if (windowed) ownWindow.show();
  else ownWindow.showInactive();
  sendCaptions();
  sendOverlayState();
}

function closeOverlay(force = false) {
  presentation?.close(force === true);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (force === true) overlayWindow.destroy();
    else overlayWindow.close();
  }
}

async function createMain(origin) {
  trustedOrigin = origin;
  await controller.initialize();
  mainWindow = new BrowserWindow({ title: 'Stage', width: 1440, height: 980, minWidth: 860, minHeight: 680,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true, show: false,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: rendererPreferences('preload.cjs', 'persist:stage-team') });
  const ownWindow = mainWindow;
  controller.attach(ownWindow);
  registerShortcuts();
  guardNavigation(ownWindow, url => matchesOrigin(url, trustedOrigin));
  ownWindow.on('close', event => {
    if (!changingServer && !quitting && controller.compact) { event.preventDefault(); controller.hide(); }
  });
  ownWindow.on('closed', () => {
    summaryTasks.cancel(ownWindow);
    if (mainWindow === ownWindow) mainWindow = undefined;
    closeOverlay();
    closeWorkspace();
    if (!changingServer && !quitting) app.quit();
  });
  ownWindow.webContents.on('render-process-gone', () => {
    summaryTasks.cancel(ownWindow);
    captions = { english: '', japanese: '', partialJapanese: '', status: 'error' };
    controller.update({ status: 'error', paused: false, pending: 0 });
    sendCaptions();
  });
  ownWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) summaryTasks.cancel(ownWindow); });
  try {
    await ownWindow.loadURL(origin);
    ownWindow.show();
  } catch {
    changingServer = true;
    ownWindow.destroy();
    clearControllerShell();
    changingServer = false;
    connectionMessage = 'Could not reach the team server. Check the address and your connection.';
    await showConnection();
  }
}

function closeWorkspace() {
  workspaceGeneration++;
  if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.destroy();
  workspaceWindow = undefined;
}

async function openWorkspace(view, meetingId) {
  const target = workspaceURL(trustedOrigin, view, meetingId);
  if (!mainWindow || mainWindow.isDestroyed() || changingServer || quitting) return;
  if (!workspaceWindow || workspaceWindow.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea;
    workspaceWindow = new BrowserWindow({ title: 'Stage workspace', width: Math.min(1180, area.width), height: Math.min(820, area.height),
      minWidth: Math.min(720, area.width), minHeight: Math.min(520, area.height), backgroundColor: '#f7f8f2', show: false,
      webPreferences: rendererPreferences('preload.cjs', 'persist:stage-team') });
    const created = workspaceWindow;
    guardNavigation(created, url => isWorkspaceURL(url, trustedOrigin));
    created.on('closed', () => { summaryTasks.cancel(created); if (workspaceWindow === created) workspaceWindow = undefined; });
    created.webContents.on('render-process-gone', () => summaryTasks.cancel(created));
    created.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) summaryTasks.cancel(created); });
  }
  const ownWindow = workspaceWindow;
  const current = ++workspaceGeneration;
  try {
    if (ownWindow.webContents.getURL() !== target) await ownWindow.loadURL(target);
    if (workspaceGeneration !== current || ownWindow.isDestroyed()) return;
    if (ownWindow.isMinimized()) ownWindow.restore();
    ownWindow.show(); ownWindow.focus();
  } catch {
    if (workspaceGeneration !== current || ownWindow.isDestroyed()) return;
    ownWindow.destroy();
    throw new Error('Could not open the workspace. Check the team connection and try again.');
  }
}

function sendControllerAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stage:controller-action', action);
}

function registerShortcuts() {
  globalShortcut.unregister('CommandOrControl+Shift+H');
  globalShortcut.unregister('CommandOrControl+Shift+B');
  try { shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+H', toggleOverlay); }
  catch { shortcutRegistered = false; }
  try { controller.setShortcutRegistered(globalShortcut.register('CommandOrControl+Shift+B', () => controller.toggle())); }
  catch { controller.setShortcutRegistered(false); }
}

function clearControllerShell() {
  globalShortcut.unregister('CommandOrControl+Shift+H');
  globalShortcut.unregister('CommandOrControl+Shift+B');
  shortcutRegistered = false;
  controller?.setShortcutRegistered(false);
  controller?.dispose();
  closeWorkspace();
}

async function showConnection() {
  if (connectionWindow && !connectionWindow.isDestroyed()) { connectionWindow.show(); return; }
  connectionWindow = new BrowserWindow({ title: 'Connect Stage', width: 640, height: 750, minWidth: 540,
    minHeight: 680, show: false, backgroundColor: '#f7f8f2',
    webPreferences: rendererPreferences('connection-preload.cjs', 'stage-connection') });
  guardNavigation(connectionWindow, url => url === localURL('connection.html'));
  connectionWindow.on('closed', () => {
    connectionWindow = undefined;
    if (!mainWindow && !changingServer && !quitting) app.quit();
  });
  await connectionWindow.loadFile(path.join(__dirname, 'connection.html'));
  connectionWindow.show();
}

function registerIPC() {
  ipcMain.handle('stage:summarize-meeting', async (event, payload) => {
    const owner = requireAppSender(event);
    return summaryTasks.run(owner, payload);
  });
  ipcMain.handle('stage:cancel-summary', event => { summaryTasks.cancel(requireAppSender(event)); });
  ipcMain.handle('stage:capabilities', event => {
    requireAppSender(event);
    return { apiVersion: 2, outputModes: ['overlay', 'window', 'presentation'], stableLines: true, saveMeetingExport: true, summaryWorker: summaryRunner.available,
      compactController: true, controllerShortcutRegistered: controller.shortcutRegistered };
  });
  ipcMain.handle('stage:controller-layout', (event, layout) => { requireMainSender(event); controller.layout(layout); });
  ipcMain.handle('stage:hide-controller', event => { requireMainSender(event); controller.hide(); });
  ipcMain.on('stage:controller-state', (event, state) => {
    try { requireMainSender(event); controller.update(state); } catch { /* Ignore malformed send-only updates. */ }
  });
  ipcMain.handle('stage:open-workspace', (event, view, meetingId) => { requireMainSender(event); return openWorkspace(view, meetingId); });
  ipcMain.handle('stage:save-meeting-export', async (event, payload) => {
    const parent = requireAppSender(event);
    if (!payload || typeof payload !== 'object' || !['json', 'md'].includes(payload.format)
      || typeof payload.text !== 'string' || Buffer.byteLength(payload.text, 'utf8') > 20 * 1024 * 1024
      || typeof payload.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,180}$/.test(payload.filename)) {
      throw new Error('Invalid meeting export.');
    }
    const result = await dialog.showSaveDialog(parent, { title: 'Save meeting transcript',
      defaultPath: payload.filename, filters: [{ name: payload.format === 'json' ? 'JSON' : 'Markdown', extensions: [payload.format] }] });
    requireAppSender(event);
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.writeFile(result.filePath, payload.text, { encoding: 'utf8', mode: 0o600 });
    return { saved: true };
  });
  ipcMain.handle('stage:displays', event => {
    requireMainSender(event);
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display, index) => ({ id: String(display.id),
      label: display.label || `Screen ${index + 1}`, width: display.size.width, height: display.size.height,
      primary: display.id === primaryId }));
  });
  ipcMain.handle('stage:open-overlay', async (event, options) => { requireMainSender(event); await openOverlay(options); });
  ipcMain.handle('stage:configure-overlay', (event, options) => { requireMainSender(event); configureOverlay(options); });
  ipcMain.handle('stage:overlay-state', event => { requireMainSender(event); return getOverlayState(); });
  ipcMain.handle('stage:close-overlay', event => { requireMainSender(event); closeOverlay(); });
  ipcMain.handle('stage:toggle-overlay', event => { requireMainSender(event); return toggleOverlay(); });
  ipcMain.on('stage:update-overlay', (event, payload) => {
    // Send-only IPC must not crash the app when a renderer passes malformed data.
    try { requireMainSender(event); captions = normalizeCaptionPayload(payload); sendCaptions(); } catch { /* Ignore invalid updates. */ }
  });
  ipcMain.on('stage:overlay-ready', event => {
    try {
      requireSender(event, overlayWindow, url => url === localURL('overlay.html'));
      overlayReady = true;
      sendCaptions();
    } catch { /* The overlay has no other privileges. */ }
  });
  ipcMain.handle('stage:connection-config', event => {
    requireConnectionSender(event);
    return { origin: trustedOrigin, message: connectionMessage, development: !app.isPackaged };
  });
  ipcMain.handle('stage:connect', async (event, rawOrigin) => {
    requireConnectionSender(event);
    let origin;
    try { origin = normalizeServerOrigin(rawOrigin, { allowDevelopmentHttp: !app.isPackaged }); }
    catch (error) { return { ok: false, error: error.message }; }
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(path.join(app.getPath('userData'), 'connection.json'), JSON.stringify({ origin }), { mode: 0o600 });
    } catch { return { ok: false, error: 'Could not save this address. Check local storage permissions.' }; }
    connectionMessage = '';
    // Let the invoke result reach the local page before destroying its renderer.
    setImmediate(async () => {
      changingServer = true;
      if (connectionWindow && !connectionWindow.isDestroyed()) connectionWindow.destroy();
      changingServer = false;
      await createMain(origin);
    });
    return { ok: true };
  });
}

function configureMenu() {
  const appMenu = { label: 'Stage', submenu: [
    { label: 'Change team server…', click: async () => {
      changingServer = true;
      closeOverlay();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      clearControllerShell();
      changingServer = false;
      await showConnection();
    } },
    { label: 'Hide / show Stage remote', accelerator: 'CommandOrControl+Shift+B', click: () => controller?.toggle() },
    { label: 'Hide / show captions', accelerator: 'CommandOrControl+Shift+H', click: toggleOverlay },
    { label: 'Close captions', click: closeOverlay },
    { type: 'separator' }, { role: 'quit' },
  ] };
  Menu.setApplicationMenu(Menu.buildFromTemplate([appMenu, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }]));
}

function toggleOverlay() {
  overlayToggleQueue = overlayToggleQueue.then(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || changingServer || quitting) return;
    const output = presentation?.window || overlayWindow;
    if (output && !output.isDestroyed()) {
      if (output.isVisible()) output.hide();
      else if (overlayOptions.outputMode === 'overlay' || !overlayOptions.outputMode) output.showInactive();
      else output.show();
      sendOverlayState();
    } else await openOverlay(overlayOptions);
  }).catch(() => {
    console.error('Could not open the caption window. Try opening it from Stage.');
    sendOverlayState();
  });
  return overlayToggleQueue;
}

async function savedOrigin() {
  const options = { allowDevelopmentHttp: !app.isPackaged };
  if (process.env.STAGE_SERVER_URL) return normalizeServerOrigin(process.env.STAGE_SERVER_URL, options);
  try {
    const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'connection.json'), 'utf8'));
    return normalizeServerOrigin(saved.origin, options);
  } catch {
    return app.isPackaged ? '' : 'http://localhost:5173';
  }
}

app.whenReady().then(async () => {
  summaryRunner = createSummaryRunner({ env: await summaryEnvironment(app.getPath('userData')) });
  summaryTasks = createOwnedSummaryRunner(summaryRunner);
  controller = createController({ app, screen, Tray, Menu, nativeImage, onAction: sendControllerAction,
    onWorkspace: view => { void openWorkspace(view).catch(() => {}); } });
  denyPermissions('stage-overlay');
  denyPermissions('stage-connection');
  presentation = createPresentation({ BrowserWindow, desktopCapturer, screen, session, ipcMain,
    rendererPreferences, guardNavigation, requireSender, localURL, onState: sendOverlayState,
    onClosed: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stage:overlay-closed'); },
    getCaptionState: () => ({ options: overlayOptions, captions }) });
  installMainPermissions();
  registerIPC();
  configureMenu();
  screen.on('display-removed', () => { positionOverlay(); controller.displaysChanged(); });
  screen.on('display-metrics-changed', () => { positionOverlay(true); controller.displaysChanged(); });
  screen.on('display-added', () => { positionOverlay(); controller.displaysChanged(); });
  let origin;
  try { origin = await savedOrigin(); }
  catch { connectionMessage = 'The configured team server address is invalid. Enter an HTTPS address.'; }
  if (origin) await createMain(origin);
  else await showConnection();
});

app.on('activate', () => { if (mainWindow && !mainWindow.isDestroyed()) controller?.show(); else connectionWindow?.show(); });
app.on('before-quit', () => { quitting = true; summaryTasks.cancel(); closeOverlay(); clearControllerShell(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!changingServer) app.quit(); });

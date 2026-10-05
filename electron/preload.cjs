const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stageDesktop', Object.freeze({
  isDesktop: true,
  summarizeMeeting: payload => ipcRenderer.invoke('stage:summarize-meeting', payload),
  cancelSummary: () => ipcRenderer.invoke('stage:cancel-summary'),
  saveMeetingExport: payload => ipcRenderer.invoke('stage:save-meeting-export', payload),
  getCapabilities: () => ipcRenderer.invoke('stage:capabilities'),
  setControllerLayout: layout => ipcRenderer.invoke('stage:controller-layout', layout),
  hideController: () => ipcRenderer.invoke('stage:hide-controller'),
  updateControllerState: state => ipcRenderer.send('stage:controller-state', state),
  openWorkspace: (view, meetingId) => ipcRenderer.invoke('stage:open-workspace', view, meetingId),
  onControllerAction: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
    const listener = (_event, action) => {
      if (['settings', 'output', 'toggle-recording', 'end-meeting'].includes(action)) callback(action);
    };
    ipcRenderer.on('stage:controller-action', listener);
    return () => ipcRenderer.removeListener('stage:controller-action', listener);
  },
  getDisplays: () => ipcRenderer.invoke('stage:displays'),
  openOverlay: options => ipcRenderer.invoke('stage:open-overlay', options),
  configureOverlay: options => ipcRenderer.invoke('stage:configure-overlay', options),
  getOverlayState: () => ipcRenderer.invoke('stage:overlay-state'),
  updateOverlay: payload => ipcRenderer.send('stage:update-overlay', payload),
  closeOverlay: () => ipcRenderer.invoke('stage:close-overlay'),
  toggleOverlay: () => ipcRenderer.invoke('stage:toggle-overlay'),
  onOverlayStateChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('stage:overlay-state', listener);
    return () => ipcRenderer.removeListener('stage:overlay-state', listener);
  },
  onOverlayClosed: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
    const listener = () => callback();
    ipcRenderer.on('stage:overlay-closed', listener);
    return () => ipcRenderer.removeListener('stage:overlay-closed', listener);
  },
}));

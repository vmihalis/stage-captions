const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stageDesktop', Object.freeze({
  isDesktop: true,
  getDisplays: () => ipcRenderer.invoke('stage:displays'),
  openOverlay: options => ipcRenderer.invoke('stage:open-overlay', options),
  configureOverlay: options => ipcRenderer.invoke('stage:configure-overlay', options),
  getOverlayState: () => ipcRenderer.invoke('stage:overlay-state'),
  updateOverlay: payload => ipcRenderer.send('stage:update-overlay', payload),
  closeOverlay: () => ipcRenderer.invoke('stage:close-overlay'),
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

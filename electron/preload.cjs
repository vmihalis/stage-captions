const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stageDesktop', Object.freeze({
  isDesktop: true,
  getDisplays: () => ipcRenderer.invoke('stage:displays'),
  openOverlay: options => ipcRenderer.invoke('stage:open-overlay', options),
  updateOverlay: payload => ipcRenderer.send('stage:update-overlay', payload),
  closeOverlay: () => ipcRenderer.invoke('stage:close-overlay'),
  onOverlayClosed: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
    const listener = () => callback();
    ipcRenderer.on('stage:overlay-closed', listener);
    return () => ipcRenderer.removeListener('stage:overlay-closed', listener);
  },
}));

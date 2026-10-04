const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stageCaptions', Object.freeze({
  onUpdate: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('stage:caption-state', listener);
    return () => ipcRenderer.removeListener('stage:caption-state', listener);
  },
  ready: () => ipcRenderer.send('stage:overlay-ready'),
}));

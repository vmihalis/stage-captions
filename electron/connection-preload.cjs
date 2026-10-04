const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stageConnection', Object.freeze({
  connect: origin => ipcRenderer.invoke('stage:connect', origin),
  getConfiguration: () => ipcRenderer.invoke('stage:connection-config'),
}));

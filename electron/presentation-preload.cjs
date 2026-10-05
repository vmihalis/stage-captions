const { contextBridge, ipcRenderer } = require('electron');
const listen = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('stageCaptions', Object.freeze({
  onUpdate: callback => listen('stage:caption-state', callback),
  ready: () => ipcRenderer.send('stage:presentation-ready'),
}));
contextBridge.exposeInMainWorld('stagePresentation', Object.freeze({
  getSources: () => ipcRenderer.invoke('stage:presentation-sources'),
  selectSource: id => ipcRenderer.invoke('stage:presentation-select', id),
  started: () => ipcRenderer.invoke('stage:presentation-started'),
  stop: () => ipcRenderer.invoke('stage:presentation-stop'),
  error: () => ipcRenderer.send('stage:presentation-error'),
  onReset: callback => listen('stage:presentation-reset', callback),
}));

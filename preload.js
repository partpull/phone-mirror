const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phoneAPI', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  connectDevice: (payload) => ipcRenderer.invoke('device:connect', payload),
  pairDevice: (payload) => ipcRenderer.invoke('device:pair', payload),
  disconnectDevice: (serial) => ipcRenderer.invoke('device:disconnect', serial),
  enableWifi: (serial) => ipcRenderer.invoke('device:wifi', serial),
  startMirror: (payload) => ipcRenderer.invoke('mirror:start', payload),
  stopMirror: () => ipcRenderer.invoke('mirror:stop'),
  getMirrorState: () => ipcRenderer.invoke('mirror:state'),
  getLogs: () => ipcRenderer.invoke('mirror:logs'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  openLogFolder: () => ipcRenderer.invoke('app:open-log-folder'),
  onLog: (callback) => ipcRenderer.on('mirror:log', (event, payload) => callback(payload)),
  onMirrorState: (callback) => ipcRenderer.on('mirror:state', (event, payload) => callback(payload)),
});

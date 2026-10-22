'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = channel => cb => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: opts => ipcRenderer.invoke('pick-folder', opts),
  expandPaths: (paths, opts) => ipcRenderer.invoke('expand-paths', paths, opts),
  pathForFile: file => webUtils.getPathForFile(file),
  pickOutputDir: current => ipcRenderer.invoke('pick-output-dir', current),
  thumbnail: p => ipcRenderer.invoke('thumbnail', p),
  startJob: payload => ipcRenderer.invoke('start-job', payload),
  cancelJob: () => ipcRenderer.invoke('cancel-job'),
  openPath: p => ipcRenderer.invoke('open-path', p),
  reveal: p => ipcRenderer.invoke('reveal', p),
  loadState: () => ipcRenderer.invoke('load-state'),
  saveState: data => ipcRenderer.invoke('save-state', data),
  setTheme: mode => ipcRenderer.invoke('set-theme', mode),
  appInfo: () => ipcRenderer.invoke('app-info'),
  onProgress: listen('job-progress'),
  onExternalFiles: listen('external-files'),
});

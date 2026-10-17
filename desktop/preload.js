'use strict';
// The page (static/app.js) looks for window.YTHost to use desktop features.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('YTHost', {
  platform: 'desktop',
  os: process.platform,
  save: jobId => ipcRenderer.invoke('save', jobId),
  reveal: filePath => ipcRenderer.invoke('reveal', filePath),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  getFolder: () => ipcRenderer.invoke('get-folder'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  progress: p => ipcRenderer.send('progress', p),
  attention: () => ipcRenderer.send('attention'),
  theme: (bg, fg) => ipcRenderer.send('theme', { bg, fg }),
  restart: () => ipcRenderer.invoke('restart-backend'),
  onOpenUrl: cb => ipcRenderer.on('open-url', (_e, url) => cb(url)),
});

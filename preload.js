'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // ---- 宠物窗口 ----
  getMeta: () => ipcRenderer.invoke('pet:meta'),
  ready: () => ipcRenderer.send('pet:ready'),
  openMenu: () => ipcRenderer.send('pet:menu'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  onEnv: (cb) => ipcRenderer.on('pet:env', (_e, s) => cb(s)),
  onCmd: (cb) => ipcRenderer.on('pet:cmd', (_e, s) => cb(s)),

  // ---- 控制台窗口 ----
  panelInit: () => ipcRenderer.invoke('panel:init'),
  panelSet: (patch) => ipcRenderer.send('panel:set', patch),
  panelAction: (action) => ipcRenderer.send('panel:action', action),
  panelClose: () => ipcRenderer.send('panel:close'),
  onPanelSync: (cb) => ipcRenderer.on('panel:sync', (_e, s) => cb(s))
});

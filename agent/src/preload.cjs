'use strict';
// The only bridge between the screens and the app. The screens cannot reach the file system, the network or the token.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('emns', {
  onAlerts: (cb) => ipcRenderer.on('alerts', (_e, payload) => cb(payload)),
  shown: (id) => ipcRenderer.invoke('alert-shown', id),
  ack: (id, response) => ipcRenderer.invoke('alert-ack', { id, response }),
  dismiss: (id) => ipcRenderer.invoke('alert-dismiss', id),
  enroll: (data) => ipcRenderer.invoke('enroll', data),
});

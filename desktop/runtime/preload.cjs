'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strongholdClient', {
  platform: 'windows',
  tcpAvailable: true,
  tcpConnect: (id, host, port) => ipcRenderer.send('sp-tcp-connect', { id, host, port }),
  tcpSend: (id, data) => ipcRenderer.send('sp-tcp-send', { id, data }),
  tcpClose: (id, code, reason) => ipcRenderer.send('sp-tcp-close', { id, code, reason }),
  onTcpEvent: (listener) => {
    if (typeof listener !== 'function') return;
    ipcRenderer.on('sp-tcp-event', (_event, payload) => listener(payload));
  },
  readClipboardText: () => ipcRenderer.invoke('sp-read-clipboard'),
});


/**
 * preload.cjs — the only bridge between the window and Node.
 * Sandboxed + contextIsolated: the page sees exactly these functions.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('builder', {
  start: (text, concurrency, smoke) => ipcRenderer.invoke('batch:start', { text, concurrency, smoke }),
  stop: () => ipcRenderer.invoke('batch:stop'),
  lines: (id) => ipcRenderer.invoke('batch:lines', id),
  snapshot: () => ipcRenderer.invoke('batch:snapshot'),
  limits: () => ipcRenderer.invoke('app:limits'),
  openOutput: () => ipcRenderer.invoke('app:openOutput'),
  reveal: (file) => ipcRenderer.invoke('app:reveal', file),
  onEvent: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('builder:event', listener)
    return () => ipcRenderer.removeListener('builder:event', listener)
  }
})

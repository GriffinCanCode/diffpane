const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('diffpane', {
  language: {
    open: input => ipcRenderer.invoke('language-open', input),
    request: input => ipcRenderer.invoke('language-request', input),
    cancel: id => ipcRenderer.invoke('language-cancel', id),
    close: path => ipcRenderer.invoke('language-close', path),
    status: () => ipcRenderer.invoke('language-status'),
    onEvent: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('language-event', listener);
      return () => ipcRenderer.removeListener('language-event', listener);
    },
  },
  snapshot: () => ipcRenderer.invoke('snapshot'),
  files: () => ipcRenderer.invoke('files'),
  document: (path, comparison = 'head') => ipcRenderer.invoke('document', path, comparison),
  refresh: () => ipcRenderer.invoke('refresh'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  onChange: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('change', listener);
    return () => ipcRenderer.removeListener('change', listener);
  },
  onError: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('backend-error', listener);
    return () => ipcRenderer.removeListener('backend-error', listener);
  },
});

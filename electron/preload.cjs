const electron_1 = require('electron');
const listen = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  electron_1.ipcRenderer.on(channel, listener);
  return () => electron_1.ipcRenderer.removeListener(channel, listener);
};
electron_1.contextBridge.exposeInMainWorld('diffpane', {
  howmany: {
    export: () => electron_1.ipcRenderer.invoke('howmany-export'),
    analyze: force => electron_1.ipcRenderer.invoke('howmany-analyze', force),
    file: path => electron_1.ipcRenderer.invoke('howmany-file', path),
    close: path => electron_1.ipcRenderer.invoke('howmany-close', path),
    onEvent: callback => listen('howmany-event', callback),
  },
  language: {
    open: input => electron_1.ipcRenderer.invoke('language-open', input),
    request: input => electron_1.ipcRenderer.invoke('language-request', input),
    cancel: id => electron_1.ipcRenderer.invoke('language-cancel', id),
    close: path => electron_1.ipcRenderer.invoke('language-close', path),
    status: () => electron_1.ipcRenderer.invoke('language-status'),
    onEvent: callback => listen('language-event', callback),
  },
  snapshot: () => electron_1.ipcRenderer.invoke('snapshot'),
  files: () => electron_1.ipcRenderer.invoke('files'),
  filesDelta: revision => electron_1.ipcRenderer.invoke('files-delta', revision),
  directoryExpanded: (path, expanded) =>
    electron_1.ipcRenderer.invoke('directory-expanded', path, expanded),
  document: (path, comparison = 'head') =>
    electron_1.ipcRenderer.invoke('document', path, comparison),
  save: (path, text, expected) => electron_1.ipcRenderer.invoke('save', path, text, expected),
  rename: (path, name) => electron_1.ipcRenderer.invoke('rename', path, name),
  fileAction: (action, path) => electron_1.ipcRenderer.invoke('file-action', action, path),
  onFlushSaves: callback => listen('flush-saves', callback),
  onResumeEditing: callback => listen('resume-editing', callback),
  savesFlushed: success => electron_1.ipcRenderer.send('saves-flushed', success),
  media: path => electron_1.ipcRenderer.invoke('media', path),
  refresh: () => electron_1.ipcRenderer.invoke('refresh'),
  openFolder: () => electron_1.ipcRenderer.invoke('open-folder'),
  openExternal: url => electron_1.ipcRenderer.invoke('open-external', url),
  onChange: callback => listen('change', callback),
  onPaths: callback => listen('paths', callback),
  onError: callback => listen('backend-error', callback),
});

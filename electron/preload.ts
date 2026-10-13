import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type Unsubscribe = () => void;
const listen = <T>(channel: string, callback: (value: T) => void): Unsubscribe => {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('diffpane', {
  howmany: {
    export: () => ipcRenderer.invoke('howmany-export'),
    analyze: (force?: boolean) => ipcRenderer.invoke('howmany-analyze', force),
    file: (path: string) => ipcRenderer.invoke('howmany-file', path),
    close: (path: string) => ipcRenderer.invoke('howmany-close', path),
    onEvent: (callback: (value: unknown) => void) => listen('howmany-event', callback),
  },
  language: {
    open: (input: unknown) => ipcRenderer.invoke('language-open', input),
    request: (input: unknown) => ipcRenderer.invoke('language-request', input),
    cancel: (id: number) => ipcRenderer.invoke('language-cancel', id),
    close: (path: string) => ipcRenderer.invoke('language-close', path),
    status: () => ipcRenderer.invoke('language-status'),
    onEvent: (callback: (value: unknown) => void) => listen('language-event', callback),
  },
  snapshot: () => ipcRenderer.invoke('snapshot'),
  files: () => ipcRenderer.invoke('files'),
  filesDelta: (revision: number | null) => ipcRenderer.invoke('files-delta', revision),
  document: (path: string, comparison = 'head') => ipcRenderer.invoke('document', path, comparison),
  save: (path: string, text: string, expected: string) =>
    ipcRenderer.invoke('save', path, text, expected),
  onFlushSaves: (callback: () => void) => listen('flush-saves', callback),
  onResumeEditing: (callback: () => void) => listen('resume-editing', callback),
  savesFlushed: (success: boolean) => ipcRenderer.send('saves-flushed', success),
  media: (path: string) => ipcRenderer.invoke('media', path),
  refresh: () => ipcRenderer.invoke('refresh'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  onChange: (callback: (value: unknown) => void) => listen('change', callback),
  onPaths: (callback: (paths: string[]) => void) => listen('paths', callback),
  onError: (callback: (value: unknown) => void) => listen('backend-error', callback),
});

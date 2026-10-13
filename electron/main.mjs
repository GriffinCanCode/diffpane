import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();
let nextRequest = 0;
let quitting = false;
const shutdowns = new Set();
app.setName('Diffpane');

function createWindow(directory) {
  const window = new BrowserWindow({
    width: 1400, height: 960, minWidth: 650, minHeight: 420,
    title: `${path.basename(directory)} · Diffpane`, backgroundColor: '#111315',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 21 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  const worker = new Worker(new URL('./session.mjs', import.meta.url), { workerData: { directory } });
  const requests = new Map();
  let fatal;
  const languageProcesses = new Set();
  const killLanguageProcesses = () => {
    for (const pid of languageProcesses) {
      try { process.platform === 'win32' ? process.kill(pid) : process.kill(-pid, 'SIGKILL'); } catch { /* An owned server has already stopped. */ }
    }
    languageProcesses.clear();
  };
  const fail = error => {
    fatal = error.message ?? String(error);
    killLanguageProcesses();
    for (const request of requests.values()) request.reject(new Error(fatal));
    requests.clear();
    if (!window.isDestroyed()) window.webContents.send('backend-error', fatal);
  };
  worker.on('error', fail);
  worker.on('exit', code => { if (code && !window.isDestroyed()) fail(new Error(`Git worker exited (${code})`)); });
  worker.on('message', message => {
    if (message.event) {
      if (message.event === 'language-event' && message.value.type === 'process') {
        const { status, pid } = message.value;
        if (status === 'started') languageProcesses.add(pid);
        if (status === 'stopped') languageProcesses.delete(pid);
      }
      if (!window.isDestroyed()) window.webContents.send(message.event === 'error' ? 'backend-error' : message.event, message.value);
    } else {
      const request = requests.get(message.id);
      if (request) { requests.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.value); }
    }
  });
  const windowId = window.webContents.id;
  const session = {
    call(method, args = []) {
      if (fatal) return Promise.reject(new Error(fatal));
      return new Promise((resolve, reject) => { const id = ++nextRequest; requests.set(id, { resolve, reject }); worker.postMessage({ id, method, args }); });
    },
    stop() {
      if (this.stopping) return this.stopping;
      this.stopping = (async () => {
        let timer;
        try {
          await Promise.race([this.call('language-dispose'), new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
        } catch { /* A crashed worker is already covered by process cleanup. */ }
        finally {
          clearTimeout(timer);
          killLanguageProcesses();
          for (const request of requests.values()) request.reject(new Error('Window closed'));
          requests.clear();
          await worker.terminate();
        }
      })();
      shutdowns.add(this.stopping);
      void this.stopping.finally(() => shutdowns.delete(this.stopping));
      return this.stopping;
    },
  };
  sessions.set(windowId, session);
  window.on('closed', () => {
    sessions.delete(windowId);
    void session.stop();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  void window.loadFile(path.join(here, '../dist/index.html'));
  return window;
}

for (const method of ['snapshot', 'files', 'document', 'refresh', 'language-open', 'language-request', 'language-cancel', 'language-close', 'language-status']) {
  ipcMain.handle(method, (event, ...args) => {
    const session = sessions.get(event.sender.id);
    if (!session) throw new Error('Unknown window');
    return session.call(method, args);
  });
}
ipcMain.handle('open-folder', async event => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory'], title: 'Open a Git working directory' });
  if (!result.canceled) createWindow(result.filePaths[0]);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Diffpane', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => { const window = BrowserWindow.getFocusedWindow(); if (window) void dialog.showOpenDialog(window, { properties: ['openDirectory'] }).then(result => { if (!result.canceled) createWindow(result.filePaths[0]); }); } }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }, { role: 'paste' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
  const args = process.argv.slice(1).filter(argument => !argument.startsWith('--'));
  if (!app.isPackaged) args.shift();
  createWindow(path.resolve(args[0] ?? process.cwd()));
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(process.cwd()); });
});
app.on('before-quit', event => {
  if (quitting || (!sessions.size && !shutdowns.size)) return;
  event.preventDefault();
  const pending = [...sessions.values()].map(session => session.stop());
  void Promise.allSettled([...pending, ...shutdowns]).then(() => { quitting = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());

// Keep the native watcher library loaded while worker teardown joins its native threads.
import '@parcel/watcher';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { mediaResponse } from './media.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();
const mediaSessions = new Map();
protocol.registerSchemesAsPrivileged([
  { scheme: 'diffpane-media', privileges: { standard: true, secure: true, stream: true } },
]);
let nextRequest = 0;
let quitting = false;
const shutdowns = new Set();
app.setName('Diffpane');

function createWindow(directory) {
  const window = new BrowserWindow({
    width: 1400,
    height: 960,
    minWidth: 650,
    minHeight: 420,
    title: `${path.basename(directory)} · Diffpane`,
    backgroundColor: '#111315',
    icon: path.join(here, '../dist/img/diffpane.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 10 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const worker = new Worker(new URL('./session.mjs', import.meta.url), {
    workerData: { directory },
  });
  const requests = new Map();
  let fatal;
  const languageProcesses = new Set();
  const killLanguageProcesses = () => {
    for (const pid of languageProcesses) {
      try {
        process.platform === 'win32' ? process.kill(pid) : process.kill(-pid, 'SIGKILL');
      } catch {
        /* An owned server has already stopped. */
      }
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
  worker.on('exit', code => {
    if (code && !window.isDestroyed()) fail(new Error(`Git worker exited (${code})`));
  });
  worker.on('message', message => {
    if (message.event) {
      if (
        ['language-event', 'howmany-event'].includes(message.event) &&
        message.value.type === 'process'
      ) {
        const { status, pid } = message.value;
        if (status === 'started') languageProcesses.add(pid);
        if (status === 'stopped') languageProcesses.delete(pid);
      }
      if (!window.isDestroyed())
        window.webContents.send(
          message.event === 'error' ? 'backend-error' : message.event,
          message.value,
        );
    } else {
      const request = requests.get(message.id);
      if (request) {
        requests.delete(message.id);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
      }
    }
  });
  const windowId = window.webContents.id;
  const session = {
    mediaToken: randomUUID(),
    flush() {
      if (fatal || window.isDestroyed() || window.webContents.isLoadingMainFrame())
        return Promise.resolve(!fatal);
      if (!this.flushing)
        this.flushing = new Promise(resolve => {
          this.finishFlush = success => {
            this.flushing = null;
            resolve(success);
          };
          window.webContents.send('flush-saves');
        });
      return this.flushing;
    },
    call(method, args = []) {
      if (fatal) return Promise.reject(new Error(fatal));
      return new Promise((resolve, reject) => {
        const id = ++nextRequest;
        requests.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
      });
    },
    stop() {
      if (this.stopping) return this.stopping;
      this.stopping = (async () => {
        let timer;
        try {
          await Promise.race([
            this.call('language-dispose'),
            new Promise(resolve => {
              timer = setTimeout(resolve, 2500);
            }),
          ]);
        } catch {
          /* A crashed worker is already covered by process cleanup. */
        } finally {
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
  mediaSessions.set(session.mediaToken, session);
  let allowClose = false;
  window.on('close', event => {
    if (quitting || allowClose) return;
    event.preventDefault();
    void session.flush().then(success => {
      if (success && !window.isDestroyed()) {
        allowClose = true;
        window.close();
      }
    });
  });
  window.on('closed', () => {
    sessions.delete(windowId);
    mediaSessions.delete(session.mediaToken);
    void session.stop();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const devServer = !app.isPackaged && process.env.DIFFPANE_DEV_SERVER_URL;
  if (devServer && new URL(devServer).origin === 'http://127.0.0.1:5173')
    void window.loadURL(devServer);
  else void window.loadFile(path.join(here, '../dist/index.html'));
  return window;
}

ipcMain.handle('open-external', async (event, href) => {
  if (!sessions.has(event.sender.id)) throw new Error('Unknown window');
  const url = new URL(href);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Unsupported link');
  await shell.openExternal(url.href);
});

ipcMain.handle('media', async (event, filePath) => {
  const session = sessions.get(event.sender.id);
  if (!session) throw new Error('Unknown window');
  const media = await session.call('media', [filePath]);
  return {
    type: media.type,
    url: `diffpane-media://${session.mediaToken}/${encodeURIComponent(media.path)}?v=${++nextRequest}`,
  };
});

for (const method of [
  'snapshot',
  'files',
  'files-delta',
  'directory-expanded',
  'document',
  'save',
  'rename',
  'refresh',
  'language-open',
  'language-request',
  'language-cancel',
  'language-close',
  'language-status',
  'howmany-analyze',
  'howmany-file',
  'howmany-close',
]) {
  ipcMain.handle(method, (event, ...args) => {
    const session = sessions.get(event.sender.id);
    if (!session) throw new Error('Unknown window');
    return session.call(method, args);
  });
}
ipcMain.handle('file-action', async (event, action, filePath) => {
  const session = sessions.get(event.sender.id);
  if (!session) throw new Error('Unknown window');
  if (!['trash', 'reveal', 'copy-path', 'copy-relative-path'].includes(action))
    throw new Error('Unknown file action');
  const absolute = await session.call('operation-path', [filePath]);
  if (action === 'trash') {
    await shell.trashItem(absolute);
    await session.call('refresh');
  } else if (action === 'reveal') shell.showItemInFolder(absolute);
  else await clipboard.writeText(action === 'copy-path' ? absolute : filePath);
});

ipcMain.on('saves-flushed', (event, success) => {
  sessions.get(event.sender.id)?.finishFlush?.(success === true);
});
ipcMain.handle('open-folder', async event => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: ['openDirectory'],
    title: 'Open a Git working directory',
  });
  if (!result.canceled) createWindow(result.filePaths[0]);
});
ipcMain.handle('howmany-export', async event => {
  const session = sessions.get(event.sender.id);
  if (!session) throw new Error('Unknown window');
  const { report } = await session.call('howmany-analyze');
  if (!report) throw new Error('Analyze the workspace before exporting');
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Export HowMany report',
    defaultPath: 'howmany-report.json',
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return true;
});

void app.whenReady().then(() => {
  protocol.handle('diffpane-media', async request => {
    try {
      const url = new URL(request.url);
      const session = mediaSessions.get(url.hostname);
      if (!session) return new Response(null, { status: 403 });
      const media = await session.call('media', [decodeURIComponent(url.pathname.slice(1))]);
      return mediaResponse(media.root, media.path, request);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  if (process.platform === 'darwin' && !app.isPackaged)
    app.dock.setIcon(path.join(here, '../dist/img/diffpane.png'));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Diffpane',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'Open Folder…',
            accelerator: 'CmdOrCtrl+O',
            click: () => {
              const window = BrowserWindow.getFocusedWindow();
              if (window)
                void dialog
                  .showOpenDialog(window, { properties: ['openDirectory'] })
                  .then(result => {
                    if (!result.canceled) createWindow(result.filePaths[0]);
                  });
            },
          },
          { role: 'close' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'resetZoom' },
          { role: 'togglefullscreen' },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]),
  );
  const args = process.argv.slice(1).filter(argument => !argument.startsWith('--'));
  if (!app.isPackaged) args.shift();
  createWindow(path.resolve(args[0] ?? process.cwd()));
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow(process.cwd());
  });
});
let preparingQuit = false;
app.on('before-quit', event => {
  if (quitting || (!sessions.size && !shutdowns.size)) return;
  event.preventDefault();
  if (preparingQuit) return;
  preparingQuit = true;
  void (async () => {
    try {
      const results = await Promise.all([...sessions.values()].map(session => session.flush()));
      if (results.some(success => !success)) {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send('resume-editing');
        return;
      }
      const pending = [...sessions.values()].map(session => session.stop());
      await Promise.allSettled([...pending, ...shutdowns]);
      quitting = true;
      app.quit();
    } finally {
      preparingQuit = false;
    }
  })();
});
app.on('window-all-closed', () => app.quit());

// Keep the native watcher library loaded while worker teardown joins its native threads.
import '@parcel/watcher';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { mediaResponse } from './media.ts';
import { RecentTargets } from './recent-targets.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();
const mediaSessions = new Map();
protocol.registerSchemesAsPrivileged([
  { scheme: 'diffpane-media', privileges: { standard: true, secure: true, stream: true } },
]);
let nextRequest = 0;
let quitting = false;
const shutdowns = new Set();
const pendingOpenPaths = [];
app.setName('Diffpane');
const recentTargetsReady = app.whenReady().then(async () => {
  const history = new RecentTargets(path.join(app.getPath('userData'), 'recent-targets.json'));
  await history.ready;
  return history;
});
let recentUpdates = Promise.resolve();
let updatingRecents = false;

function rememberTarget(target) {
  updatingRecents = true;
  const update = (recentUpdates = recentUpdates
    .then(async () => (await recentTargetsReady).record(target))
    .catch(() => {}));
  void update.finally(() => {
    if (recentUpdates === update) updatingRecents = false;
  });
}

function createWindow(directory = null) {
  const window = new BrowserWindow({
    width: 1400,
    height: 960,
    minWidth: 650,
    minHeight: 420,
    title: directory ? `${path.basename(directory)} · Diffpane` : 'Diffpane',
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
  const worker = directory
    ? new Worker(new URL('./session.mjs', import.meta.url), { workerData: { directory } })
    : null;
  const workerExited = worker
    ? new Promise(resolve => worker.once('exit', resolve))
    : Promise.resolve();
  const requests = new Map();
  let fatal;
  let remembered = false;
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
    if (fatal) return;
    fatal = error.message ?? String(error);
    killLanguageProcesses();
    for (const request of requests.values()) request.reject(new Error(fatal));
    requests.clear();
    session.finishFlush?.(false);
    if (!window.isDestroyed()) window.webContents.send('backend-error', fatal);
  };
  worker?.on('error', fail);
  worker?.on('exit', code => {
    if (!session.stopping && !window.isDestroyed()) fail(new Error(`Git worker exited (${code})`));
  });
  worker?.on('message', message => {
    if (message.event) {
      if (message.event === 'change' && message.value?.root && !remembered) {
        remembered = true;
        rememberTarget(directory);
      }
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
    directory,
    mediaToken: randomUUID(),
    hasPendingSaves: false,
    rendererReady: false,
    flush() {
      // Startup and empty windows have no editable buffers to flush. Their close
      // action must not depend on a worker or a renderer that failed to initialize.
      if (window.isDestroyed()) return Promise.resolve(true);
      const unavailable =
        fatal ||
        !this.rendererReady ||
        window.webContents.isDestroyed() ||
        window.webContents.isLoadingMainFrame();
      if (!this.hasPendingSaves && (!directory || unavailable)) return Promise.resolve(true);
      if (unavailable) return Promise.resolve(false);
      // A healthy project renderer also freezes clean editors, preventing new
      // edits while application quit waits for workers to finish shutting down.
      if (!this.flushing)
        this.flushing = new Promise(resolve => {
          const timer = setTimeout(() => this.finishFlush?.(false), 5000);
          this.finishFlush = success => {
            clearTimeout(timer);
            this.flushing = null;
            this.finishFlush = null;
            if (success) this.hasPendingSaves = false;
            resolve(success);
          };
          window.webContents.send('flush-saves');
        });
      return this.flushing;
    },
    call(method, args = []) {
      if (!worker)
        return method === 'snapshot'
          ? Promise.resolve(null)
          : Promise.reject(new Error('Open a file or folder first.'));
      if (fatal) return Promise.reject(new Error(fatal));
      return new Promise((resolve, reject) => {
        const id = ++nextRequest;
        requests.set(id, { resolve, reject });
        try {
          worker.postMessage({ id, method, args });
        } catch (error) {
          requests.delete(id);
          reject(error);
        }
      });
    },
    stop() {
      if (this.stopping) return this.stopping;
      this.stopping = (async () => {
        if (!worker) return;
        let timer;
        let graceful = false;
        try {
          if (!fatal)
            graceful = await Promise.race([
              this.call('language-dispose')
                .then(() => workerExited)
                .then(() => true),
              new Promise(resolve => {
                timer = setTimeout(() => resolve(false), 2500);
              }),
            ]);
        } catch {
          /* A crashed worker is already covered by process cleanup. */
        } finally {
          clearTimeout(timer);
          killLanguageProcesses();
          for (const request of requests.values()) request.reject(new Error('Window closed'));
          requests.clear();
          // Native watcher completion callbacks must drain in the worker's live
          // environment. Force termination is reserved for failed or stuck workers.
          if (!graceful) await worker.terminate();
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
      } else if (!window.isDestroyed()) window.webContents.send('resume-editing');
    });
  });
  window.on('closed', () => {
    sessions.delete(windowId);
    mediaSessions.delete(session.mediaToken);
    session.finishFlush?.(true);
    void session.stop();
  });
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    session.rendererReady = false;
    session.finishFlush?.(false);
  });
  window.webContents.on('render-process-gone', () => {
    session.rendererReady = false;
    session.finishFlush?.(false);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const devServer = !app.isPackaged && process.env.DIFFPANE_DEV_SERVER_URL;
  if (devServer && new URL(devServer).origin === 'http://127.0.0.1:5173')
    void window.loadURL(devServer);
  else void window.loadFile(path.join(here, '../dist/index.html'));
  return window;
}

function openTarget(target, source = BrowserWindow.getFocusedWindow()) {
  const window = createWindow(path.resolve(target));
  if (source && !source.isDestroyed() && sessions.get(source.webContents.id)?.directory === null)
    source.close();
  return window;
}

async function chooseTarget(window, kind) {
  const options = {
    properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    title: kind === 'file' ? 'Open a file' : 'Open a folder',
  };
  const result = await (window
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options));
  if (result.canceled || !result.filePaths[0]) return false;
  openTarget(result.filePaths[0], window);
  return true;
}

// Finder can supply files before Electron has finished creating its first window.
app.on('open-file', (event, filename) => {
  event.preventDefault();
  if (app.isReady()) openTarget(filename);
  else pendingOpenPaths.push(filename);
});

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
ipcMain.on('save-state', (event, dirty) => {
  const session = sessions.get(event.sender.id);
  if (session) session.hasPendingSaves = dirty === true;
});
ipcMain.on('renderer-ready', event => {
  const session = sessions.get(event.sender.id);
  if (session) session.rendererReady = true;
});
for (const kind of ['folder', 'file'])
  ipcMain.handle(`open-${kind}`, event => {
    if (!sessions.has(event.sender.id)) throw new Error('Unknown window');
    return chooseTarget(BrowserWindow.fromWebContents(event.sender), kind);
  });
ipcMain.handle('recent-targets', async event => {
  if (!sessions.has(event.sender.id)) throw new Error('Unknown window');
  await recentUpdates;
  return (await recentTargetsReady).list();
});
ipcMain.handle('open-recent', async (event, target) => {
  if (!sessions.has(event.sender.id)) throw new Error('Unknown window');
  await recentUpdates;
  const history = await recentTargetsReady;
  const recent = (await history.list()).find(entry => entry.path === target);
  if (!recent) return false;
  const info = await stat(recent.path).catch(() => null);
  if (!info || (recent.kind === 'file' ? !info.isFile() : !info.isDirectory())) {
    await history.remove(recent.path);
    return false;
  }
  openTarget(recent.path, BrowserWindow.fromWebContents(event.sender));
  return true;
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
            label: 'New Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => createWindow(),
          },
          {
            label: 'Open Folder…',
            accelerator: 'CmdOrCtrl+O',
            click: () => void chooseTarget(BrowserWindow.getFocusedWindow(), 'folder'),
          },
          {
            label: 'Open File…',
            accelerator: 'CmdOrCtrl+Shift+O',
            click: () => void chooseTarget(BrowserWindow.getFocusedWindow(), 'file'),
          },
          { type: 'separator' },
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
  const args = process.argv.slice(1).filter(argument => !argument.startsWith('-'));
  if (!app.isPackaged) args.shift();
  const targets = new Set(pendingOpenPaths.splice(0));
  if (args[0]) targets.add(path.resolve(args[0]));
  if (targets.size) for (const target of targets) openTarget(target);
  else createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
let preparingQuit = false;
app.on('before-quit', event => {
  if (quitting || (!sessions.size && !shutdowns.size && !updatingRecents)) return;
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
      await Promise.allSettled([...pending, ...shutdowns, recentUpdates]);
      quitting = true;
      app.quit();
    } finally {
      preparingQuit = false;
    }
  })();
});
app.on('window-all-closed', () => app.quit());

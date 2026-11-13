// MONOLITHIC: Electron window registration, worker ownership, save flushing and application shutdown share the session registry. Extract IPC families once their session and shutdown boundaries can be tested independently.
// Keep the native watcher library loaded while worker teardown joins its native threads.
import '@parcel/watcher'
import { randomUUID } from 'node:crypto'
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } from 'electron'
import {
  effectiveBinding,
  electronAccelerator,
  isShortcutAction,
  shortcuts,
} from '../../../shared/preferences/shortcuts.ts'
import { appError, attempt, attemptAsync, serializeAppError } from '../../../shared/recovery/app-errors.ts'
import { formatReviewHandoff } from '../../../shared/review/review-notes.ts'
import { LocalState } from '../../persistence/database/local-state.ts'
import { localStateKeys } from '../../persistence/database/secure-storage.mjs'
import { RecentTargets } from '../../persistence/preferences/recent-targets.ts'
import { ShortcutPreferences } from '../../persistence/preferences/shortcut-preferences.ts'
import {
  applyUiPreferencePatch,
  parseUiPreference,
  parseUiPreferencePatch,
  parseUiPreferences,
  uiPreferenceKeys,
} from '../../persistence/preferences/ui-preferences.ts'
import { IdeaStore } from '../../persistence/project/idea-store.ts'
import { ReviewNotesStore } from '../../persistence/project/review-notes.ts'
import { ClaudeCredentials } from '../../tools/assistant/claude-credentials.mjs'
import { ClaudeSession } from '../../tools/assistant/claude-session.mjs'
import { mediaResponse } from '../../workspace/documents/media.ts'

/** @import { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions, WebContents } from 'electron' */
/** @import { AppError } from '../../../shared/recovery/app-errors.ts' */
/** @import { IdeaChange } from '../../../shared/ideas/ideas.ts' */
/** @import { ShortcutAction, ShortcutOverrides } from '../../../shared/preferences/shortcuts.ts' */
/** @typedef {{root: string, scope: string}} WorkspaceLocation */
/** @typedef {{root: string, path: string, type: string}} WorkspaceMedia */
/** @typedef {{resolve: (value: unknown) => void, reject: (error: unknown) => void}} WorkerRequest */
/** @typedef {{directory: string | null, contents: WebContents, claude: ClaudeSession, mediaToken: string, hasPendingSaves: boolean, rendererReady: boolean, settingsRequested: boolean, repositoryRoot?: string, repositoryScope?: string, flushing?: {id: number, promise: Promise<boolean>}, finishFlush?: (success: boolean) => void, stopping?: Promise<void>, restarting?: Promise<unknown>, root: () => Promise<string>, reviewWorkspace: () => Promise<WorkspaceLocation>, flush: () => Promise<boolean>, call: (method: string, args?: readonly unknown[]) => Promise<unknown>, restart: () => Promise<unknown>, announceFatal: () => void, stop: () => Promise<void>}} WindowSession */

const here = path.dirname(fileURLToPath(import.meta.url))
/** @type {Map<number, WindowSession>} */
const sessions = new Map()
/** @type {Map<string, WindowSession>} */
const mediaSessions = new Map()
/** @type {Map<string, Promise<unknown>>} */
const fileChanges = new Map()
protocol.registerSchemesAsPrivileged([
  { scheme: 'diffpane-media', privileges: { standard: true, secure: true, stream: true } },
])
let nextRequest = 0
let nextFlush = 0
/** @type {'running' | 'flushing' | 'draining' | 'quitting'} */
let quitPhase = 'running'
/** @type {Set<Promise<void>>} */
const shutdowns = new Set()
/** @type {string[]} */
const pendingOpenPaths = []
app.setName('Diffpane')
const userData = app.getPath('userData')
const localState = new LocalState(path.join(userData, 'state', 'local.sqlite'), localStateKeys)
const shortcutPreferences = new ShortcutPreferences(localState, path.join(userData, 'shortcuts.sqlite'))
/** @type {ShortcutOverrides} */
let shortcutOverrides = {}
let shortcutUpdates = Promise.resolve()
const claudeCredentials = new ClaudeCredentials(path.join(userData, 'claude-key'))
const ideaStore = new IdeaStore(localState, path.join(userData, 'ideas.sqlite'))
const reviewNotes = new ReviewNotesStore(localState, path.join(userData, 'review-notes', 'notes.sqlite'))
let reviewNoteUpdates = Promise.resolve()
const recentTargets = new RecentTargets(localState, path.join(userData, 'recent-targets.json'), error =>
  logError(error, 'recent-targets-storage'),
)
let recentUpdates = Promise.resolve()
let preferenceUpdates = Promise.resolve()
let preferenceRevision = 0
/** @type {Set<Promise<unknown>>} */
const storageOperations = new Set()

/** @type {Set<Promise<unknown>>} */
const mutationOperations = new Set()

/** @template T @param {Set<Promise<unknown>>} operations @param {Promise<T>} pending */
async function trackOperation(operations, pending) {
  operations.add(pending)
  try {
    return await pending
  } finally {
    operations.delete(pending)
  }
}

/** @param {unknown} error @param {string} operation */
function logError(error, operation) {
  const { code, message } = serializeAppError(error, { operation })
  console.error(`Diffpane [${operation}] ${code}: ${message}`)
}

/** @param {string} operation @param {() => unknown} run @param {(error: AppError) => unknown} [onError] */
async function background(operation, run, onError) {
  const result = await attemptAsync(run, { operation })
  if (result.ok) return
  logError(result.error, operation)
  if (!onError) return
  const recovery = await attemptAsync(() => onError(result.error))
  if (!recovery.ok) logError(recovery.error, operation)
}

/** @param {string} operation @param {() => unknown} run @param {(error: AppError) => unknown} [onError] */
function runBackground(operation, run, onError) {
  background(operation, run, onError).catch((/** @type {unknown} */ cause) => logError(cause, operation))
}

/** @param {WebContents} contents @param {string} channel @param {unknown[]} args */
function send(contents, channel, ...args) {
  if (contents.isDestroyed()) return false
  const result = attempt(() => contents.send(channel, ...args), { operation: channel })
  if (!result.ok) logError(result.error, channel)
  return result.ok
}

/** @param {IpcMainEvent | IpcMainInvokeEvent} event */
function sessionFor(event) {
  const session = sessions.get(event.sender.id)
  if (!session || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    throw appError('This Diffpane window is no longer available.', { code: 'WINDOW_UNAVAILABLE' })
  return session
}

/** @param {unknown} value @returns {WorkspaceLocation | undefined} */
function workspaceLocation(value) {
  if (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'scope' in value &&
    typeof value.scope === 'string'
  )
    return { root: value.root, scope: value.scope }
  return undefined
}

/** @param {unknown} value @returns {WorkspaceMedia} */
function workspaceMedia(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('root' in value) ||
    typeof value.root !== 'string' ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    !('type' in value) ||
    typeof value.type !== 'string'
  )
    throw new Error('Invalid workspace media response.')
  return { root: value.root, path: value.path, type: value.type }
}

/** @param {string} channel @param {(session: WindowSession, event: IpcMainInvokeEvent, ...args: unknown[]) => unknown} listener */
function handle(channel, listener) {
  ipcMain.handle(channel, async (event, ...args) => {
    const input = /** @type {unknown[]} */ (args)
    const result = await attemptAsync(
      () => {
        if (quitPhase === 'draining' || quitPhase === 'quitting')
          throw appError('Diffpane is closing.', { code: 'WINDOW_UNAVAILABLE' })
        return listener(sessionFor(event), event, ...input)
      },
      {
        operation: channel,
      },
    )
    if (result.ok) return result
    if (result.error.code === 'UNEXPECTED') logError(result.error, channel)
    return { ok: false, error: serializeAppError(result.error) }
  })
}

/** @param {string} channel @param {(session: WindowSession, ...args: unknown[]) => void} listener */
function onRenderer(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
    const input = /** @type {unknown[]} */ (args)
    const result = attempt(() => listener(sessionFor(event), ...input), { operation: channel })
    if (!result.ok && result.error.code !== 'WINDOW_UNAVAILABLE') logError(result.error, channel)
  })
}

/** @param {string} operation @param {() => unknown} run */
function windowAction(operation, run) {
  if (quitPhase !== 'running') return
  runBackground(operation, run, error => dialog.showErrorBox('Diffpane could not complete that action', error.message))
}

/** @param {string} target */
function rememberTarget(target) {
  if (quitPhase === 'draining' || quitPhase === 'quitting') return
  recentUpdates = recentUpdates.then(() => background('record-recent-target', () => recentTargets.record(target)))
  runBackground('record-recent-target', () => trackOperation(storageOperations, recentUpdates))
}

/** @template T @param {WindowSession} session @param {readonly string[]} files @param {() => Promise<T>} change */
function changeFiles(session, files, change) {
  return trackOperation(
    mutationOperations,
    session.root().then(async root => {
      const keys = [...new Set(files.map(file => path.resolve(root, file)))]
      const previous = keys.flatMap(key => {
        const operation = fileChanges.get(key)
        return operation ? [operation] : []
      })
      const pending = (async () => {
        await Promise.allSettled(previous)
        return change()
      })()
      for (const key of keys) fileChanges.set(key, pending)
      try {
        return await pending
      } finally {
        for (const key of keys) if (fileChanges.get(key) === pending) fileChanges.delete(key)
      }
    }),
  )
}

/** @param {string | null} [directory] */
function createWindow(directory = null) {
  const window = new BrowserWindow({
    width: 1400,
    height: 960,
    minWidth: 650,
    minHeight: 420,
    title: directory ? `${path.basename(directory)} · Diffpane` : 'Diffpane',
    backgroundColor: '#111315',
    icon: path.join(app.getAppPath(), 'dist/img/diffpane.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 10 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  /** @type {Worker | undefined} */
  let worker
  /** @type {Promise<void>} */
  let workerExited = Promise.resolve()
  /** @type {Map<number, WorkerRequest>} */
  const requests = new Map()
  const versions = { revision: 0, catalogRevision: 0, reviewVersion: 0, checkpointId: 0 }
  /** @type {AppError | undefined} */
  let fatal
  let remembered = false
  /** @type {Set<number>} */
  const languageProcesses = new Set()
  function killLanguageProcesses() {
    for (const pid of languageProcesses) {
      try {
        if (process.platform === 'win32') process.kill(pid)
        else process.kill(-pid, 'SIGKILL')
      } catch {
        /* An owned server has already stopped. */
      }
    }
    languageProcesses.clear()
  }
  /** @param {unknown} cause */
  function fail(cause) {
    if (fatal) return
    fatal = appError(cause, {
      code: 'BACKEND_UNAVAILABLE',
      operation: 'workspace-worker',
      recoverable: false,
    })
    logError(fatal, 'workspace-worker')
    killLanguageProcesses()
    for (const request of requests.values()) request.reject(fatal)
    requests.clear()
    session.finishFlush?.(false)
    if (session.rendererReady) send(session.contents, 'backend-error', serializeAppError(fatal))
  }

  /** @param {unknown} message */
  function receive(message) {
    if (typeof message !== 'object' || message === null) throw new Error('Invalid workspace worker message.')
    if ('event' in message) {
      if (message.event === 'error' && 'failure' in message) {
        send(session.contents, 'backend-error', serializeAppError(message.failure))
        return
      }
      if (!('value' in message)) throw new Error('Invalid workspace worker event.')
      const { value } = message
      if (message.event === 'change') {
        const location = workspaceLocation(value)
        if (!location) throw new Error('Invalid workspace snapshot location.')
        if ('versions' in message && typeof message.versions === 'object' && message.versions !== null) {
          for (const key of ['revision', 'catalogRevision', 'reviewVersion', 'checkpointId']) {
            const version = /** @type {unknown} */ (Reflect.get(message.versions, key))
            if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0)
              Reflect.set(versions, key, version)
          }
        }
        session.repositoryRoot = location.root
        session.repositoryScope = location.scope
        if (!remembered && directory) {
          remembered = true
          rememberTarget(directory)
        }
      }
      if (
        (message.event === 'language-event' || message.event === 'howmany-event') &&
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        value.type === 'process' &&
        'status' in value &&
        'pid' in value &&
        typeof value.pid === 'number' &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0
      ) {
        const { status, pid } = value
        if (status === 'started') languageProcesses.add(pid)
        if (status === 'stopped') languageProcesses.delete(pid)
      }
      if (
        message.event === 'change' ||
        message.event === 'language-event' ||
        message.event === 'howmany-event' ||
        message.event === 'paths'
      )
        send(session.contents, message.event, value)
    } else if ('id' in message && typeof message.id === 'number') {
      const request = requests.get(message.id)
      if (request) {
        requests.delete(message.id)
        if ('failure' in message) request.reject(appError(message.failure))
        else if ('error' in message) request.reject(appError(message.error))
        else if ('value' in message) request.resolve(message.value)
        else request.reject(new Error('Invalid workspace worker response.'))
      }
    }
  }

  function startWorker() {
    fatal = undefined
    const result = attempt(
      () => new Worker(new URL('../session/session.mjs', import.meta.url), { workerData: { directory, versions } }),
    )
    if (!result.ok) {
      fail(result.error)
      return
    }
    const current = (worker = result.value)
    workerExited = new Promise(resolve => {
      current.once('exit', () => resolve())
    })
    current.on('error', error => {
      if (worker === current) fail(error)
    })
    current.on('exit', code => {
      if (worker === current && !session.stopping && !window.isDestroyed())
        fail(new Error(`The workspace worker exited (${code}).`))
    })
    current.on('message', message => {
      if (worker !== current || fatal) return
      const received = attempt(() => receive(message))
      if (!received.ok) logError(received.error, 'receive-workspace-message')
    })
    current.on('messageerror', error => {
      if (worker === current) {
        fail(error)
        runBackground('terminate-workspace-worker', () => current.terminate())
      }
    })
  }

  const windowId = window.webContents.id
  /** @type {WindowSession} */
  const session = {
    directory,
    contents: window.webContents,
    claude: new ClaudeSession(),
    mediaToken: randomUUID(),
    hasPendingSaves: false,
    rendererReady: false,
    settingsRequested: false,
    async root() {
      this.repositoryRoot ??= workspaceLocation(await this.call('snapshot'))?.root
      if (!this.repositoryRoot) throw appError('Open a file or folder first.', { code: 'WORKSPACE_REQUIRED' })
      return this.repositoryRoot
    },
    async reviewWorkspace() {
      if (!this.repositoryScope) {
        const snapshot = workspaceLocation(await this.call('snapshot'))
        this.repositoryRoot = snapshot?.root
        this.repositoryScope = snapshot?.scope
      }
      if (!this.repositoryRoot || !this.repositoryScope)
        throw appError('Open a file or folder first.', { code: 'WORKSPACE_REQUIRED' })
      return { root: this.repositoryRoot, scope: this.repositoryScope }
    },
    flush() {
      // Startup and empty windows have no editable buffers to flush. Their close
      // action must not depend on a worker or a renderer that failed to initialize.
      if (window.isDestroyed()) return Promise.resolve(true)
      const unavailable =
        fatal !== undefined ||
        !this.rendererReady ||
        window.webContents.isDestroyed() ||
        window.webContents.isLoadingMainFrame()
      if (!this.hasPendingSaves && unavailable) return Promise.resolve(true)
      if (unavailable) return Promise.resolve(false)
      // A healthy project renderer also freezes clean editors, preventing new
      // edits while application quit waits for workers to finish shutting down.
      if (!this.flushing) {
        const id = ++nextFlush
        const promise = new Promise(
          /** @type {(resolve: (success: boolean) => void) => void} */ (
            resolve => {
              const timer = setTimeout(() => this.finishFlush?.(false), 5000)
              this.finishFlush = (/** @type {boolean} */ success) => {
                clearTimeout(timer)
                this.flushing = undefined
                this.finishFlush = undefined
                if (success) this.hasPendingSaves = false
                resolve(success)
              }
            }
          ),
        )
        this.flushing = { id, promise }
        if (!send(this.contents, 'flush-saves', id)) this.finishFlush?.(false)
        return promise
      }
      return this.flushing.promise
    },
    call(method, args = []) {
      if (this.stopping) return Promise.reject(appError('This window is closing.', { code: 'WINDOW_UNAVAILABLE' }))
      if (fatal) return Promise.reject(fatal)
      const current = worker
      if (!current)
        return method === 'snapshot'
          ? Promise.resolve(null)
          : Promise.reject(appError('Open a file or folder first.', { code: 'WORKSPACE_REQUIRED' }))
      return new Promise((resolve, reject) => {
        const id = ++nextRequest
        requests.set(id, { resolve, reject })
        try {
          current.postMessage({ id, method, args })
        } catch (error) {
          requests.delete(id)
          reject(error)
        }
      })
    },
    restart() {
      if (this.restarting) return this.restarting
      if (!directory || !fatal) return this.call('snapshot')
      this.restarting = (async () => {
        await workerExited
        if (this.stopping) return this.call('snapshot')
        worker = undefined
        startWorker()
        return this.call('snapshot')
      })().finally(() => {
        this.restarting = undefined
      })
      return this.restarting
    },
    announceFatal() {
      if (fatal) send(this.contents, 'backend-error', serializeAppError(fatal))
    },
    stop() {
      if (this.stopping) return this.stopping
      this.claude.reset()
      this.stopping = (async () => {
        if (!worker) return
        /** @type {NodeJS.Timeout | undefined} */
        let timer
        let graceful = false
        try {
          if (!fatal) {
            const disposed = this.call('language-dispose').then(
              () => workerExited,
              async (/** @type {unknown} */ error) => {
                if (!fatal) logError(error, 'dispose-workspace')
                await workerExited
              },
            )
            graceful = await Promise.race([
              disposed.then(() => true),
              new Promise(
                /** @type {(resolve: (success: boolean) => void) => void} */ (
                  resolve => {
                    timer = setTimeout(() => resolve(false), 2500)
                  }
                ),
              ),
            ])
          }
        } catch (error) {
          if (!fatal) logError(error, 'dispose-workspace')
        } finally {
          clearTimeout(timer)
          killLanguageProcesses()
          for (const request of requests.values())
            request.reject(appError('This window is closing.', { code: 'WINDOW_UNAVAILABLE' }))
          requests.clear()
          // Native watcher completion callbacks must drain in the worker's live
          // environment. Force termination is reserved for failed or stuck workers.
          if (!graceful) await worker.terminate()
        }
      })()
      const stopping = this.stopping
      shutdowns.add(stopping)
      runBackground('stop-workspace', async () => {
        try {
          await stopping
        } finally {
          shutdowns.delete(stopping)
        }
      })
      return this.stopping
    },
  }
  sessions.set(windowId, session)
  mediaSessions.set(session.mediaToken, session)
  if (directory) startWorker()
  let allowClose = false
  window.on('close', event => {
    if (quitPhase === 'quitting' || allowClose) return
    event.preventDefault()
    if (quitPhase !== 'running') return
    runBackground(
      'close-window',
      async () => {
        const flushed = await session.flush()
        if (quitPhase !== 'running') return
        if (flushed && !window.isDestroyed()) {
          allowClose = true
          window.close()
        } else send(session.contents, 'resume-editing')
      },
      () => {
        if (quitPhase === 'running') send(session.contents, 'resume-editing')
      },
    )
  })
  window.on('closed', () => {
    sessions.delete(windowId)
    mediaSessions.delete(session.mediaToken)
    session.finishFlush?.(true)
    runBackground('close-workspace', () => session.stop())
  })
  function detachRenderer() {
    const wasReady = session.rendererReady
    session.rendererReady = false
    session.claude.reset()
    session.finishFlush?.(false)
    if (directory && wasReady && !fatal)
      runBackground('cancel-workspace-search', () => session.call('content-search-cancel'))
    session.contents.setIgnoreMenuShortcuts(false)
  }
  window.webContents.on('did-start-navigation', ({ isSameDocument, isMainFrame }) => {
    if (isMainFrame && !isSameDocument) runBackground('detach-renderer', detachRenderer)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    const hadPendingSaves = session.hasPendingSaves
    // An exited renderer has no buffers left to flush. Keep the flag for the warning.
    session.hasPendingSaves = false
    runBackground('detach-renderer', detachRenderer)
    if (quitPhase === 'running' && details.reason !== 'clean-exit') {
      const error = appError(`The window stopped responding (${details.reason}).`, {
        code: 'RENDERER_UNAVAILABLE',
        operation: 'render-window',
      })
      logError(error, 'render-window')
      runBackground('recover-window', () => offerWindowRecovery(error, { crashed: true, hadPendingSaves }))
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const devServer = !app.isPackaged && process.env.DIFFPANE_DEV_SERVER_URL
  let recoveryOpen = false
  /** @param {AppError} error @param {{crashed?: boolean, hadPendingSaves?: boolean}} [state] */
  async function offerWindowRecovery(error, { crashed = false, hadPendingSaves = session.hasPendingSaves } = {}) {
    if (window.isDestroyed() || recoveryOpen) return
    recoveryOpen = true
    let response
    try {
      const choice = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Diffpane',
        message: 'This window needs to reload',
        detail: `${error.message}${hadPendingSaves ? '\n\nThis window had unsaved changes.' : ''}`,
        buttons: crashed ? ['Reload Window', 'Close Window', 'Cancel'] : ['Reload Window', 'Cancel'],
        defaultId: hadPendingSaves ? (crashed ? 2 : 1) : 0,
        cancelId: crashed ? 2 : 1,
      })
      response = choice.response
    } finally {
      recoveryOpen = false
    }
    if (window.isDestroyed()) return
    if (response === 0) await loadWindow()
    else if (crashed && response === 1) window.close()
  }
  function loadWindow() {
    return background(
      'load-window',
      () => {
        if (devServer && new URL(devServer).origin === 'http://127.0.0.1:5173') return window.loadURL(devServer)
        return window.loadFile(path.join(app.getAppPath(), 'dist/index.html'))
      },
      error => {
        if (error.code !== 'ERR_ABORTED') runBackground('recover-window', () => offerWindowRecovery(error))
      },
    )
  }
  runBackground('load-window', loadWindow)
  return window
}

/** @param {string} target */
function openTarget(target, source = BrowserWindow.getFocusedWindow()) {
  const window = createWindow(path.resolve(target))
  if (source && !source.isDestroyed() && sessions.get(source.webContents.id)?.directory === null) source.close()
  return window
}

function openSettings() {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
  if (window.isMinimized()) window.restore()
  window.focus()
  const session = sessions.get(window.webContents.id)
  if (!session) return
  if (session.rendererReady) send(session.contents, 'open-settings')
  else session.settingsRequested = true
}

/** @param {() => Promise<ShortcutOverrides>} read */
function updateShortcuts(read) {
  const result = shortcutUpdates.then(async () => {
    const overrides = await read()
    const changed = Object.keys(shortcuts)
      .filter(isShortcutAction)
      .filter(action => overrides[action] !== shortcutOverrides[action])
    if (changed.length) {
      shortcutOverrides = overrides
      if (changed.some(action => shortcuts[action].scope === 'native')) setApplicationMenu()
      for (const session of sessions.values()) {
        if (session.rendererReady) send(session.contents, 'shortcuts-updated', overrides)
      }
    }
    return overrides
  })
  shortcutUpdates = result.then(
    () => undefined,
    () => undefined,
  )
  return trackOperation(storageOperations, result)
}

function refreshShortcuts() {
  return updateShortcuts(() => shortcutPreferences.get())
}

/** @param {BrowserWindow | null} window @param {'file' | 'folder'} kind */
async function chooseTarget(window, kind) {
  /** @type {OpenDialogOptions} */
  const options = {
    properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    title: kind === 'file' ? 'Open a file' : 'Open a folder',
  }
  const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
  if (result.canceled || !result.filePaths[0] || quitPhase !== 'running') return false
  openTarget(result.filePaths[0], window)
  return true
}

// Finder can supply files before Electron has finished creating its first window.
app.on('open-file', (event, filename) => {
  event.preventDefault()
  if (app.isReady()) windowAction('open-file', () => openTarget(filename))
  else pendingOpenPaths.push(filename)
})

handle('open-external', async (_session, _event, href) => {
  if (typeof href !== 'string') throw appError('This link cannot be opened.', { code: 'INVALID_LINK' })
  const parsed = attempt(() => new URL(href))
  if (!parsed.ok || !['https:', 'http:', 'mailto:'].includes(parsed.value.protocol))
    throw appError('This link cannot be opened.', { code: 'INVALID_LINK' })
  const url = parsed.value
  await shell.openExternal(url.href)
})

handle('media', async (session, _event, filePath) => {
  const media = workspaceMedia(await session.call('media', [filePath]))
  return {
    type: media.type,
    url: `diffpane-media://${session.mediaToken}/${encodeURIComponent(media.path)}?v=${++nextRequest}`,
  }
})

/** @type {Record<string, (session: WindowSession, input: unknown) => unknown>} */
const claudeHandlers = {
  status: () => claudeCredentials.status(),
  'save-key': async (_session, key) => {
    if (typeof key !== 'string') throw new Error('Enter a valid API key.')
    const status = await claudeCredentials.save(key)
    resetClaudeSessions(status)
    return status
  },
  'remove-key': async () => {
    const status = await claudeCredentials.remove()
    resetClaudeSessions(status)
    return status
  },
  send: (session, input) => {
    if (!session.directory) throw new Error('Open a file or folder to ask about your project.')
    return session.claude.send(
      input,
      () => claudeCredentials.key(),
      {
        async list(query) {
          const value = await session.call('claude-list', [query])
          if (
            typeof value !== 'object' ||
            value === null ||
            !('paths' in value) ||
            !Array.isArray(value.paths) ||
            !('truncated' in value) ||
            typeof value.truncated !== 'boolean'
          ) {
            throw new Error('The project file list is unavailable.')
          }
          const entries = /** @type {unknown[]} */ (value.paths)
          const paths = entries.filter(filename => typeof filename === 'string')
          if (paths.length !== value.paths.length) throw new Error('The project file list is unavailable.')
          return { paths, truncated: value.truncated }
        },
        read: async (filename, side) => {
          const text = await session.call('claude-read', [filename, side]).catch(() => {
            throw new Error('This project text file could not be read.')
          })
          if (typeof text !== 'string') throw new Error('This project text file could not be read.')
          return text
        },
        listIdeas: async query => ideaStore.summaries(await session.root(), query),
        readIdea: async id => ideaStore.get(await session.root(), id),
      },
      activity => send(session.contents, 'claude-activity', activity),
    )
  },
  apply: (session, id) => {
    if (typeof id !== 'string') throw new Error('Invalid proposal.')
    return session.claude.apply(id, {
      saveFile: (filename, text, expected) =>
        changeFiles(session, [filename], () => session.call('claude-save', [filename, text, expected])),
      saveIdea: async (idea, expected) => {
        const root = await session.root()
        const saved = await ideaStore.applyDraft(root, idea, expected)
        broadcastIdeaChange(root, null, { type: 'upsert', idea: saved })
        return saved
      },
    })
  },
  discard: (session, id) => {
    if (typeof id !== 'string') throw new Error('Invalid proposal.')
    return session.claude.discard(id)
  },
  reset: session => session.claude.reset(),
  cancel: session => session.claude.cancel(),
}

/** @param {Awaited<ReturnType<ClaudeCredentials['status']>>} status */
function resetClaudeSessions(status) {
  for (const session of sessions.values()) {
    session.claude.reset()
    send(session.contents, 'claude-reset', status)
  }
}

for (const [method, handler] of Object.entries(claudeHandlers)) {
  handle(`claude-${method}`, (session, _event, input) => {
    if (method === 'apply') return trackOperation(mutationOperations, Promise.resolve(handler(session, input)))
    if (method === 'save-key' || method === 'remove-key')
      return trackOperation(storageOperations, Promise.resolve(handler(session, input)))
    return handler(session, input)
  })
}

/** @type {Record<string, (store: IdeaStore, root: string, input: unknown, sender: WebContents) => unknown>} */
const ideaHandlers = {
  list: (store, root) => store.list(root),
  upsert: async (store, root, idea, sender) => {
    const saved = await store.upsert(root, idea)
    broadcastIdeaChange(root, sender, { type: 'upsert', idea: saved })
    return saved
  },
  delete: async (store, root, id, sender) => {
    if (typeof id !== 'string') throw new Error('Invalid idea ID.')
    if (await store.delete(root, id)) broadcastIdeaChange(root, sender, { type: 'delete', id })
  },
}

/** @param {string} root @param {WebContents | null} sender @param {IdeaChange} change */
function broadcastIdeaChange(root, sender, change) {
  for (const session of sessions.values()) {
    if (session.repositoryRoot === root && session.contents !== sender) send(session.contents, 'ideas-change', change)
  }
}

for (const [method, handler] of Object.entries(ideaHandlers)) {
  handle(`ideas-${method}`, (session, event, input) =>
    trackOperation(
      storageOperations,
      session.root().then(root => handler(ideaStore, root, input, event.sender)),
    ),
  )
}

for (const method of ['list', 'change', 'copy']) {
  const updateNotes = async (/** @type {WindowSession} */ session, /** @type {unknown} */ input) => {
    const { root, scope } = await session.reviewWorkspace()
    if (method === 'change') {
      const result = reviewNoteUpdates.then(async () => {
        const notes = await reviewNotes.change(root, scope, input)
        const scopes = new Map([[scope, Promise.resolve(notes)]])
        const recipients = [...sessions.values()].filter(
          other => other.repositoryRoot === root && other.repositoryScope && other.rendererReady,
        )
        const delivered = await Promise.allSettled(
          recipients.map(async other => {
            const otherScope = other.repositoryScope
            if (!otherScope) return
            const pending = scopes.get(otherScope) ?? reviewNotes.list(root, otherScope)
            scopes.set(otherScope, pending)
            const visible = await pending
            send(other.contents, 'review-notes-updated', visible)
          }),
        )
        for (const delivery of delivered) {
          if (delivery.status === 'rejected') logError(delivery.reason, 'broadcast-review-notes')
        }
        return notes
      })
      reviewNoteUpdates = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    await reviewNoteUpdates
    const notes = await reviewNotes.list(root, scope)
    if (method === 'list') return notes
    const { count, text } = formatReviewHandoff(notes)
    if (count) await clipboard.writeText(text)
    return count
  }
  handle(`review-notes-${method}`, (session, _event, input) =>
    trackOperation(storageOperations, updateNotes(session, input)),
  )
}

handle('restart-workspace', session => session.restart())

for (const method of [
  'capture-checkpoint',
  'content-search',
  'content-search-cancel',
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
  handle(method, (session, _event, ...args) => {
    const [filename, name] = args
    if (method === 'save' && typeof filename === 'string')
      return changeFiles(session, [filename], () => session.call(method, args))
    if (method === 'rename' && typeof filename === 'string' && typeof name === 'string')
      return changeFiles(session, [filename, path.join(path.dirname(filename), name)], () => session.call(method, args))
    return session.call(method, args)
  })
}
handle('file-action', async (session, _event, action, filePath) => {
  if (action !== 'trash' && action !== 'reveal' && action !== 'copy-path' && action !== 'copy-relative-path')
    throw appError('Unknown file action.', { code: 'INVALID_FILE_ACTION' })
  if (typeof filePath !== 'string')
    throw appError('Choose a file or folder inside this project.', { code: 'INVALID_FILE_ACTION' })
  const operationPath = async () => {
    const absolute = await session.call('operation-path', [filePath])
    if (typeof absolute !== 'string') throw new Error('Invalid workspace path response.')
    return absolute
  }
  if (action === 'trash') {
    await changeFiles(session, [filePath], async () => {
      await shell.trashItem(await operationPath())
      await background('refresh-after-trash', () => session.call('refresh'))
    })
    return
  }
  const absolute = await operationPath()
  if (action === 'reveal') shell.showItemInFolder(absolute)
  else await clipboard.writeText(action === 'copy-path' ? absolute : filePath)
})

onRenderer('saves-flushed', (session, success, id) => {
  if (session.flushing && session.flushing.id === id) session.finishFlush?.(success === true)
})
onRenderer('save-state', (session, dirty) => {
  session.hasPendingSaves = dirty === true
})
onRenderer('renderer-ready', session => {
  session.rendererReady = true
  session.announceFatal()
  if (session.settingsRequested && send(session.contents, 'open-settings')) session.settingsRequested = false
})
/** @type {Record<string, (sender: WebContents, ...args: unknown[]) => unknown>} */
const shortcutHandlers = {
  get: refreshShortcuts,
  set: (_sender, action, binding) => updateShortcuts(() => shortcutPreferences.set(action, binding)),
  reset: (_sender, action) => updateShortcuts(() => shortcutPreferences.reset(action)),
  capture: (sender, active) => sender.setIgnoreMenuShortcuts(active === true),
}
for (const [method, handler] of Object.entries(shortcutHandlers)) {
  handle(`shortcuts-${method}`, (_session, event, ...args) => handler(event.sender, ...args))
}

/** @template T @param {() => Promise<T>} update */
function queuePreferenceUpdate(update) {
  const result = preferenceUpdates.then(update)
  preferenceUpdates = result.then(
    () => undefined,
    () => undefined,
  )
  return trackOperation(storageOperations, result)
}

const uiPreferenceCollection = 'ui-preferences'
/** @param {import('../../persistence/database/local-state.ts').StateRecords} records */
function readUiPreferences(records) {
  /** @type {Partial<import('../../persistence/preferences/ui-preferences.ts').UiPreferences>} */
  const preferences = {}
  for (const key of uiPreferenceKeys) {
    const value = records.get(uiPreferenceCollection, '', key)
    if (value !== undefined) {
      const update = parseUiPreference(key, value)
      Object.assign(preferences, { [update.key]: update.value })
    }
  }
  return preferences
}

handle('preferences-get', (_session, _event, legacy) =>
  queuePreferenceUpdate(() => {
    const previous = parseUiPreferences(legacy)
    if (!Object.keys(previous).length) return localState.read(readUiPreferences)
    return localState.write(records => {
      const stored = readUiPreferences(records)
      for (const key of uiPreferenceKeys) {
        if (stored[key] === undefined && previous[key] !== undefined)
          records.put(uiPreferenceCollection, '', key, previous[key])
      }
      return { ...previous, ...stored }
    })
  }),
)

handle('preferences-set', (_session, _event, key, input) =>
  queuePreferenceUpdate(async () => {
    const patch = parseUiPreferencePatch(key, input)
    const updated = await localState.write(records => {
      const current = records.get(uiPreferenceCollection, '', patch.key)
      const next = applyUiPreferencePatch(patch, current)
      if (JSON.stringify(current) !== JSON.stringify(next.value))
        records.put(uiPreferenceCollection, '', next.key, next.value)
      return next
    })
    const event = { ...updated, revision: ++preferenceRevision }
    for (const session of sessions.values()) send(session.contents, 'preferences-updated', event)
    return event
  }),
)

for (const kind of /** @type {const} */ (['folder', 'file']))
  handle(`open-${kind}`, (_session, event) => chooseTarget(BrowserWindow.fromWebContents(event.sender), kind))
handle('recent-targets', () =>
  trackOperation(
    storageOperations,
    recentUpdates.then(() => recentTargets.list()),
  ),
)
handle('open-recent', (_session, event, target) =>
  trackOperation(
    storageOperations,
    recentUpdates.then(async () => {
      const recent = (await recentTargets.list()).find(entry => entry.path === target)
      if (!recent) return false
      const metadata = await attemptAsync(() => stat(recent.path))
      if (!metadata.ok && !['ENOENT', 'ENOTDIR'].includes(metadata.error.code)) throw metadata.error
      const info = metadata.ok ? metadata.value : null
      if (!info || (recent.kind === 'file' ? !info.isFile() : !info.isDirectory())) {
        await recentTargets.remove(recent.path)
        return false
      }
      if (quitPhase !== 'running') return false
      openTarget(recent.path, BrowserWindow.fromWebContents(event.sender))
      return true
    }),
  ),
)
handle('howmany-export', async (session, event) => {
  const analysis = await session.call('howmany-analyze')
  if (typeof analysis !== 'object' || analysis === null || !('report' in analysis) || !analysis.report)
    throw appError('Analyze the workspace before exporting.', { code: 'REPORT_REQUIRED' })
  /** @type {SaveDialogOptions} */
  const options = {
    title: 'Export HowMany report',
    defaultPath: 'howmany-report.json',
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  }
  const window = BrowserWindow.fromWebContents(event.sender)
  const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, `${JSON.stringify(analysis.report, null, 2)}\n`, 'utf8')
  return true
})

function setApplicationMenu() {
  const isMac = process.platform === 'darwin'
  /** @param {ShortcutAction} action */
  const accelerator = action => electronAccelerator(effectiveBinding(action, shortcutOverrides), isMac) ?? undefined
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Diffpane',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: accelerator('openSettings'),
            click: () => windowAction('open-settings', openSettings),
          },
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
            accelerator: accelerator('newWindow'),
            click: () => windowAction('new-window', () => createWindow()),
          },
          {
            label: 'Open Folder…',
            accelerator: accelerator('openFolder'),
            click: () => windowAction('open-folder', () => chooseTarget(BrowserWindow.getFocusedWindow(), 'folder')),
          },
          {
            label: 'Open File…',
            accelerator: accelerator('openFile'),
            click: () => windowAction('open-file', () => chooseTarget(BrowserWindow.getFocusedWindow(), 'file')),
          },
          { type: 'separator' },
          { role: 'close', accelerator: accelerator('closeWindow') },
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
        submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]),
  )
}

runBackground(
  'start-app',
  async () => {
    await app.whenReady()
    protocol.handle('diffpane-media', async request => {
      const result = await attemptAsync(async () => {
        const url = new URL(request.url)
        const session = mediaSessions.get(url.hostname)
        if (!session) return new Response(null, { status: 403 })
        const media = workspaceMedia(await session.call('media', [decodeURIComponent(url.pathname.slice(1))]))
        return mediaResponse(media.root, media.path, request)
      })
      return result.ok ? result.value : new Response(null, { status: 404 })
    })
    if (process.platform === 'darwin' && !app.isPackaged)
      app.dock?.setIcon(path.join(app.getAppPath(), 'dist/img/diffpane.png'))
    setApplicationMenu()
    runBackground('load-shortcuts', refreshShortcuts)
    runBackground('migrate-local-state', () =>
      trackOperation(
        storageOperations,
        Promise.all([
          background('migrate-ideas', () => ideaStore.initialize()),
          background('migrate-review-notes', () => reviewNotes.initialize()),
          background('migrate-recent-targets', () => recentTargets.initialize()),
        ]),
      ),
    )
    app.on('browser-window-focus', () => {
      if (quitPhase === 'running') runBackground('load-shortcuts', refreshShortcuts)
    })
    const args = process.argv.slice(1).filter(argument => !argument.startsWith('-'))
    if (!app.isPackaged) args.shift()
    const targets = new Set(pendingOpenPaths.splice(0))
    if (args[0]) targets.add(path.resolve(args[0]))
    if (targets.size) for (const target of targets) openTarget(target)
    else createWindow()
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) windowAction('new-window', () => createWindow())
    })
  },
  error => {
    dialog.showErrorBox('Diffpane could not start', error.message)
    app.exit(1)
  },
)
function resumeEditing() {
  for (const session of sessions.values()) send(session.contents, 'resume-editing')
}
app.on('before-quit', event => {
  if (quitPhase === 'quitting') return
  if (
    quitPhase === 'running' &&
    !sessions.size &&
    !shutdowns.size &&
    !storageOperations.size &&
    !mutationOperations.size
  )
    return
  event.preventDefault()
  if (quitPhase !== 'running') return
  quitPhase = 'flushing'
  runBackground(
    'quit-app',
    async () => {
      try {
        const results = await Promise.all([...sessions.values()].map(session => session.flush()))
        if (results.some(success => !success)) {
          resumeEditing()
          return
        }
        quitPhase = 'draining'
        await Promise.allSettled(mutationOperations)
        const pending = [...sessions.values()].map(session => session.stop())
        await Promise.allSettled([...pending, ...shutdowns, ...storageOperations])
        quitPhase = 'quitting'
        app.quit()
      } finally {
        if (quitPhase !== 'quitting') quitPhase = 'running'
      }
    },
    resumeEditing,
  )
})
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  const result = attempt(() => localState.close())
  if (!result.ok) logError(result.error, 'close-local-state')
})

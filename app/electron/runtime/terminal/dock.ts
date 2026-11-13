import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, dialog, net, session, WebContentsView } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { colorHex } from '../../../shared/appearance/palette.ts'
import type { TerminalStartResult } from '../../../shared/terminal/protocol.ts'
import { TerminalProcess, validTerminalSize } from './pty.ts'

export const terminalScheme = 'diffpane-terminal'
const terminalOrigin = `${terminalScheme}://ui`
const terminalPath = '/terminal.html'
const partitionName = 'diffpane-terminal'
let terminalSession: Electron.Session | undefined

function rendererSession() {
  if (terminalSession) return terminalSession
  const isolated = session.fromPartition(partitionName)
  isolated.setPermissionCheckHandler(() => false)
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.on('will-download', event => event.preventDefault())
  const developmentAssets = process.env['DIFFPANE_DEV_TERMINAL_ASSETS']
  const assets =
    !app.isPackaged && developmentAssets && path.isAbsolute(developmentAssets)
      ? developmentAssets
      : path.join(app.getAppPath(), 'dist')
  isolated.protocol.handle(terminalScheme, request => {
    const url = new URL(request.url)
    if (
      request.method !== 'GET' ||
      url.host !== 'ui' ||
      (url.pathname !== terminalPath && !/^\/assets\/[\w.-]+$/.test(url.pathname))
    ) {
      return new Response(null, { status: 404 })
    }
    return net.fetch(pathToFileURL(path.join(assets, url.pathname)).href)
  })
  terminalSession = isolated
  return isolated
}

interface DockOptions {
  window: BrowserWindow
  eligible: () => boolean
  workspace: () => Promise<string>
  onVisibility: (visible: boolean) => void
}

interface Surface {
  view: WebContentsView
  shown: boolean
  loaded: boolean
  focusOnShow: boolean
  prompt?: AbortController
  process?: TerminalProcess
  stopping?: Promise<void>
}

function denied(message = 'The terminal is unavailable in this window.'): TerminalStartResult {
  return { ok: false, message }
}

async function workspaceDirectory(cwd: string) {
  const canonical = await realpath(cwd)
  const directory = await stat(canonical, { bigint: true })
  if (canonical !== cwd || !directory.isDirectory()) throw new Error('The workspace directory changed.')
  return directory
}

function displayPath(cwd: string) {
  return Array.from(cwd, character =>
    /[\p{Cc}\p{Bidi_Control}]/u.test(character) ? `\\u{${character.charCodeAt(0).toString(16)}}` : character,
  ).join('')
}

export function createTerminalDock({ window, eligible, workspace, onVisibility }: DockOptions) {
  let surface: Surface | undefined
  let draining: Promise<void> | undefined
  let layout: { height: number; bottom: number } | undefined
  let theme: 'dark' | 'light' = 'dark'

  const canShow = () => eligible() && !window.isDestroyed()
  const active = (current: Surface) =>
    surface === current && current.shown && current.loaded && Boolean(layout) && canShow()
  const keyboardTarget = (current: Surface) =>
    active(current) && window.isFocused() && current.view.webContents.isFocused()

  function syncLayout() {
    if (!surface || window.isDestroyed()) return
    const { view, shown, loaded, focusOnShow } = surface
    const mounted = shown && layout
    if (mounted) {
      const { width, height } = window.getContentBounds()
      const zoom = window.webContents.getZoomFactor()
      const bottom = Math.min(86, Math.round(mounted.bottom * zoom))
      const panelHeight = Math.min(Math.max(1, Math.round(mounted.height * zoom)), Math.floor(height * 0.48))
      view.setBounds({ x: 0, y: height - panelHeight - bottom, width, height: panelHeight })
    }
    view.setVisible(Boolean(mounted))
    if (mounted && loaded && focusOnShow && window.isFocused()) {
      surface.focusOnShow = false
      view.webContents.focus()
    }
  }

  function visibility(current: Surface, shown: boolean) {
    current.shown = shown
    current.focusOnShow = shown
    if (!shown) {
      layout = undefined
      current.prompt?.abort()
      if (!window.isDestroyed() && !current.view.webContents.isDestroyed() && current.view.webContents.isFocused())
        window.webContents.focus()
    }
    syncLayout()
    onVisibility(shown)
  }

  function stop(current: Surface) {
    if (!current.process) return current.stopping ?? Promise.resolve()
    const process = current.process
    current.process = undefined
    const pending = process.dispose().finally(() => {
      if (current.stopping === pending) current.stopping = undefined
    })
    current.stopping = pending
    return pending
  }

  function reset() {
    const current = surface
    if (!current) return draining ?? Promise.resolve()
    surface = undefined
    current.prompt?.abort()
    layout = undefined
    const previous = draining
    const pending = Promise.allSettled([previous, stop(current)]).then(() => {
      if (draining === pending) draining = undefined
      return undefined
    })
    draining = pending
    if (!window.isDestroyed()) {
      if (!current.view.webContents.isDestroyed() && current.view.webContents.isFocused()) window.webContents.focus()
      window.contentView.removeChildView(current.view)
    }
    if (!current.view.webContents.isDestroyed()) current.view.webContents.close()
    onVisibility(false)
    return pending
  }

  function discard(current: Surface) {
    if (surface === current) reset().catch(() => console.warn('Diffpane could not close the terminal view.'))
  }

  async function start(current: Surface, cols: unknown, rows: unknown): Promise<TerminalStartResult> {
    if (!keyboardTarget(current) || current.process || current.prompt || current.stopping || draining) return denied()
    if (typeof cols !== 'number' || typeof rows !== 'number' || !validTerminalSize(cols, rows))
      return denied('The terminal is too small to start.')
    const prompt = new AbortController()
    current.prompt = prompt
    try {
      const cwd = await workspace()
      const original = await workspaceDirectory(cwd)
      if (prompt.signal.aborted || !keyboardTarget(current)) return denied()
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Diffpane Terminal',
        message: 'Start a shell in this folder?',
        detail: `The shell runs with your user account’s permissions and loads your shell configuration.\n\n${displayPath(cwd)}`,
        buttons: ['Cancel', 'Start Shell'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: prompt.signal,
      })
      if (prompt.signal.aborted || !active(current)) return denied()
      if (response !== 1) return denied('Shell start canceled.')
      const approved = await workspaceDirectory(cwd)
      if (prompt.signal.aborted || !active(current)) return denied()
      if (approved.dev !== original.dev || approved.ino !== original.ino)
        return denied('The workspace folder changed. Reopen it before starting a shell.')
      current.process = new TerminalProcess({
        cwd,
        cols,
        rows,
        onData: (data, bytes) => {
          if (surface === current && !current.view.webContents.isDestroyed())
            current.view.webContents.send('terminal-data', data, bytes)
        },
        onExit: (code, reason) => {
          if (code === null) stop(current).catch(() => console.warn('Diffpane could not stop the terminal shell.'))
          else current.process = undefined
          if (surface === current && !current.view.webContents.isDestroyed())
            current.view.webContents.send('terminal-exit', code, reason)
        },
      })
      return { ok: true }
    } catch {
      return denied(
        'Could not start the local shell. Check that your shell and the Diffpane installation are available.',
      )
    } finally {
      current.prompt = undefined
    }
  }

  async function open() {
    const target = `${terminalOrigin}${terminalPath}`
    const view = new WebContentsView({
      webPreferences: {
        session: rendererSession(),
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        navigateOnDragDrop: false,
      },
    })
    const current: Surface = { view, shown: false, loaded: false, focusOnShow: false }
    surface = current
    const contents = view.webContents
    const authentic = (event: IpcMainEvent | IpcMainInvokeEvent) =>
      surface === current &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      event.senderFrame?.url === target
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-frame-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('did-start-navigation', ({ isMainFrame, url }) => {
      if (isMainFrame && (current.loaded || url !== target)) discard(current)
    })
    contents.on('render-process-gone', () => discard(current))
    contents.on('preload-error', () => discard(current))
    contents.once('destroyed', () => discard(current))
    contents.on('before-input-event', (event, input) => {
      const mac = process.platform === 'darwin'
      const edit = !input.alt && (mac ? input.meta && !input.control : input.control && input.shift && !input.meta)
      contents.setIgnoreMenuShortcuts(!mac && input.control)
      if (!edit || (input.code !== 'KeyC' && input.code !== 'KeyV')) return
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) {
        if (input.code === 'KeyC') contents.copy()
        else contents.paste()
      }
    })
    contents.ipc.handle('terminal-start', (event, cols: unknown, rows: unknown) =>
      authentic(event) ? start(current, cols, rows) : denied(),
    )
    contents.ipc.handle('terminal-stop', event => {
      if (!authentic(event) || !keyboardTarget(current)) throw new Error('The terminal is unavailable.')
      return stop(current)
    })
    contents.ipc.on('terminal-input', (event, data: unknown) => {
      if (authentic(event) && keyboardTarget(current)) current.process?.write(data)
    })
    contents.ipc.on('terminal-resize', (event, cols: unknown, rows: unknown) => {
      if (authentic(event) && active(current)) current.process?.resize(cols, rows)
    })
    contents.ipc.on('terminal-ack', (event, bytes: unknown) => {
      if (authentic(event)) current.process?.acknowledge(bytes)
    })
    contents.ipc.on('terminal-hide', event => {
      if (authentic(event)) visibility(current, false)
    })
    window.contentView.addChildView(view)
    view.setBackgroundColor(colorHex(theme, 'canvas'))
    visibility(current, true)
    try {
      await contents.loadURL(target)
      if (surface !== current) return false
      current.loaded = true
      contents.send('terminal-theme', theme)
      syncLayout()
      return current.shown
    } catch {
      if (surface !== current) return false
      await reset()
      throw new Error('Could not open the terminal panel.')
    }
  }

  window.on('resize', syncLayout)
  window.on('focus', syncLayout)
  return {
    toggle() {
      if (!canShow()) return false
      if (!surface) return open()
      visibility(surface, !surface.shown)
      return surface.shown
    },
    layout(height: unknown, bottom: unknown, scheme: unknown) {
      if (!surface?.shown || !canShow()) return
      layout =
        typeof height === 'number' &&
        Number.isFinite(height) &&
        height > 0 &&
        height <= 600 &&
        typeof bottom === 'number' &&
        Number.isFinite(bottom) &&
        bottom >= 0 &&
        bottom <= 86
          ? { height, bottom }
          : undefined
      if ((scheme === 'light' || scheme === 'dark') && scheme !== theme) {
        theme = scheme
        surface.view.setBackgroundColor(colorHex(theme, 'canvas'))
        if (surface.loaded) surface.view.webContents.send('terminal-theme', theme)
      }
      syncLayout()
    },
    reset,
  }
}

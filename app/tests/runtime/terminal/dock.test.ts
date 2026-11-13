import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rename, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { test, vi } from 'vite-plus/test'

type Dock = typeof import('../../../electron/runtime/terminal/dock.ts')
type ProcessOptions = ConstructorParameters<
  typeof import('../../../electron/runtime/terminal/pty.ts').TerminalProcess
>[0]

const terminalUrl = 'diffpane-terminal://ui/terminal.html'

const { authorize, spawn, write, dispose, setPermissionCheckHandler, setPermissionRequestHandler } = vi.hoisted(() => ({
  authorize: vi.fn<(_window: unknown, options: { signal: AbortSignal }) => Promise<{ response: number }>>(),
  spawn: vi.fn<(options: ProcessOptions) => void>(),
  write: vi.fn<(data: unknown) => void>(),
  dispose: vi.fn<() => Promise<void>>(async () => {}),
  setPermissionCheckHandler: () => {},
  setPermissionRequestHandler: () => {},
}))

class Contents extends EventEmitter {
  mainFrame = { url: '' }
  destroyed = false
  focused = false
  send() {}
  setWindowOpenHandler() {}
  isDestroyed = () => this.destroyed
  isFocused = () => this.focused
  focus = () => (this.focused = true)
  copy() {}
  paste() {}
  setIgnoreMenuShortcuts() {}
  ipc = {
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    events: new EventEmitter(),
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      this.ipc.handlers.set(channel, handler),
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) =>
      this.ipc.events.on(channel, handler),
  }

  loadURL(url: string) {
    this.mainFrame.url = url
    return Promise.resolve()
  }

  close() {
    this.destroyed = true
    this.emit('destroyed')
  }
}

class View {
  webContents = new Contents()
  setVisible() {}
  setBounds() {}
  setBackgroundColor() {}
}

vi.doMock('electron', () => ({
  app: { getAppPath: () => '.', isPackaged: true },
  dialog: { showMessageBox: authorize },
  net: {},
  session: {
    fromPartition: () =>
      Object.assign(new EventEmitter(), {
        setPermissionCheckHandler,
        setPermissionRequestHandler,
        protocol: { handle() {} },
      }),
  },
  WebContentsView: View,
}))
vi.doMock('../../../electron/runtime/terminal/pty.ts', () => ({
  validTerminalSize: (cols: unknown, rows: unknown) => cols === 80 && rows === 24,
  TerminalProcess: class {
    write = write
    dispose = dispose
    resize() {}
    acknowledge() {}

    constructor(options: ProcessOptions) {
      spawn(options)
    }
  },
}))
const { createTerminalDock }: Dock = await import('../../../electron/runtime/terminal/dock.ts')

function fixture(cwd: string) {
  const views: View[] = []
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: Object.assign(new Contents(), { getZoomFactor: () => 1 }),
    getContentBounds: () => ({ width: 1000, height: 720 }),
    contentView: {
      addChildView: (view: View) => views.push(view),
      removeChildView() {},
    },
  })
  let eligible = false
  const dock = createTerminalDock({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the Electron window methods exercised here are mocked.
    window: window as unknown as BrowserWindow,
    eligible: () => eligible,
    workspace: async () => cwd,
    onVisibility() {},
  })
  return {
    dock,
    views,
    async open() {
      eligible = true
      assert.equal(await dock.toggle(), true)
      dock.layout(230, 24, 'light')
      const contents = views.at(-1)?.webContents
      assert.ok(contents)
      assert.equal(contents.mainFrame.url, terminalUrl)
      const event = () => ({ sender: contents, senderFrame: contents.mainFrame })
      const start = contents.ipc.handlers.get('terminal-start')
      assert.ok(start)
      return { contents, event, start }
    },
  }
}

test('only the focused terminal main frame can start or type into the workspace shell', async () => {
  vi.clearAllMocks()
  const cwd = await realpath(tmpdir())
  const workspace = fixture(cwd)
  assert.equal(await workspace.dock.toggle(), false)
  assert.equal(workspace.views.length, 0)
  const terminal = await workspace.open()
  try {
    const invalidSenders = [
      { ...terminal.event(), sender: new Contents() },
      { ...terminal.event(), senderFrame: { url: terminalUrl } },
    ]
    const rejectedStarts = await Promise.all(invalidSenders.map(event => terminal.start(event, 80, 24)))
    for (const rejected of rejectedStarts) {
      assert.deepEqual(rejected, {
        ok: false,
        message: 'The terminal is unavailable in this window.',
      })
    }
    terminal.contents.mainFrame.url = 'https://example.org/terminal.html'
    assert.deepEqual(await terminal.start(terminal.event(), 80, 24), {
      ok: false,
      message: 'The terminal is unavailable in this window.',
    })
    terminal.contents.mainFrame.url = terminalUrl
    assert.deepEqual(await terminal.start(terminal.event(), 0, 24), {
      ok: false,
      message: 'The terminal is too small to start.',
    })
    assert.equal(authorize.mock.calls.length, 0)

    authorize.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    assert.deepEqual(await terminal.start(terminal.event(), 80, 24), { ok: false, message: 'Shell start canceled.' })
    assert.equal(spawn.mock.calls.length, 0)
    assert.deepEqual(await terminal.start(terminal.event(), 80, 24), { ok: true })
    assert.equal(spawn.mock.calls.length, 1)
    const options = spawn.mock.calls[0]?.[0]
    assert.ok(options)
    assert.deepEqual([options.cwd, options.cols, options.rows], [cwd, 80, 24])

    terminal.contents.ipc.events.emit('terminal-input', terminal.event(), 'local input')
    terminal.contents.ipc.events.emit('terminal-input', { ...terminal.event(), senderFrame: {} }, 'subframe')
    assert.equal(await workspace.dock.toggle(), false)
    terminal.contents.ipc.events.emit('terminal-input', terminal.event(), 'hidden input')
    assert.deepEqual(write.mock.calls, [['local input']])
    assert.equal(dispose.mock.calls.length, 0)
  } finally {
    await workspace.dock.reset()
  }
  assert.equal(dispose.mock.calls.length, 1)
  assert.ok(terminal.contents.destroyed)
})

test('closing the view or replacing the folder during consent invalidates a pending start', async () => {
  vi.clearAllMocks()
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-terminal-dock-')))
  const cwd = path.join(scratch, 'project')
  await mkdir(cwd)
  const workspace = fixture(cwd)
  try {
    const entered = Promise.withResolvers<AbortSignal>()
    const consent = Promise.withResolvers<{ response: number }>()
    authorize.mockImplementationOnce((_window, options) => {
      entered.resolve(options.signal)
      return consent.promise
    })
    const first = await workspace.open()
    const pending = first.start(first.event(), 80, 24)
    const signal = await entered.promise
    await workspace.dock.reset()
    assert.ok(signal.aborted)
    consent.resolve({ response: 1 })
    assert.deepEqual(await pending, { ok: false, message: 'The terminal is unavailable in this window.' })

    authorize.mockImplementationOnce(async () => {
      await rename(cwd, path.join(scratch, 'previous'))
      await mkdir(cwd)
      return { response: 1 }
    })
    const second = await workspace.open()
    assert.deepEqual(await second.start(second.event(), 80, 24), {
      ok: false,
      message: 'The workspace folder changed. Reopen it before starting a shell.',
    })
    assert.equal(spawn.mock.calls.length, 0)
  } finally {
    await workspace.dock.reset()
    await rm(scratch, { recursive: true, force: true })
  }
})

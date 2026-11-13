import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test, vi } from 'vite-plus/test'
import { LocalState } from '../../../electron/persistence/database/local-state.ts'

test('application quit waits for accepted storage work and rejects new writes during teardown', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'diffpane-window-shutdown-'))
  const app = new EventEmitter()
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: {},
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
  })
  const ipc = new EventEmitter()
  /** @type {Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>} */
  const handlers = new Map()
  const exited = Promise.withResolvers()
  const loaded = Promise.withResolvers()
  const appQuit = () => {
    let prevented = false
    app.emit('before-quit', { preventDefault: () => (prevented = true) })
    if (!prevented) app.emit('will-quit', { preventDefault: () => (prevented = true) })
    if (!prevented) exited.resolve(undefined)
  }
  class MockWindow extends EventEmitter {
    webContents = contents

    isDestroyed() {
      return false
    }

    loadFile() {
      loaded.resolve(undefined)
      return Promise.resolve()
    }
  }
  const startup = Promise.withResolvers()
  vi.doMock('electron', () => ({
    app: Object.assign(app, {
      getPath: () => scratch,
      getAppPath: () => tmpdir(),
      getVersion: () => '0.0.0',
      getAppMetrics: () => [],
      setName: vi.fn(),
      whenReady: () => startup.promise,
      quit: appQuit,
      isPackaged: false,
      dock: { setIcon: vi.fn() },
    }),
    BrowserWindow: MockWindow,
    clipboard: {},
    dialog: {},
    ipcMain: Object.assign(ipc, { handle: handlers.set.bind(handlers) }),
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    safeStorage: {},
    shell: {},
  }))
  const migrated = vi.spyOn(LocalState.prototype, 'migrate').mockResolvedValue()
  const closed = vi.spyOn(LocalState.prototype, 'close').mockImplementation(() => {})
  const records = { get: () => undefined, list: () => [], put: () => {}, delete: () => false }
  const reads = vi.spyOn(LocalState.prototype, 'read').mockImplementation(async use => use(records))
  const writeStarted = Promise.withResolvers()
  const writeRelease = Promise.withResolvers()
  const writes = vi.spyOn(LocalState.prototype, 'write').mockImplementation(async use => {
    writeStarted.resolve(undefined)
    await writeRelease.promise
    return use(records)
  })
  const originalArgv = process.argv
  process.argv = [originalArgv[0] ?? 'node', 'diffpane']
  try {
    await import('../../../electron/runtime/window/main.mjs')
    startup.resolve(undefined)
    await loaded.promise
    const event = { sender: contents, senderFrame: contents.mainFrame }
    const setPreference = handlers.get('preferences-set')
    assert.ok(setPreference)
    /** @type {PromiseWithResolvers<number>} */
    const flushStarted = Promise.withResolvers()
    contents.send.mockImplementation((channel, id) => {
      if (channel === 'flush-saves' && typeof id === 'number') flushStarted.resolve(id)
    })
    ipc.emit('renderer-ready', event)
    appQuit()
    const flushId = await flushStarted.promise
    // The renderer can begin saving while the quit flush is in progress.
    const accepted = setPreference(event, 'ideasVisible', true)
    await writeStarted.promise
    ipc.emit('saves-flushed', event, true, flushId)
    await nextTurn()
    const duringTeardown = setPreference(event, 'ideasVisible', false)
    const afterWrite = closed.mock.calls.length
    writeRelease.resolve(undefined)
    assert.deepEqual(await duringTeardown, {
      ok: false,
      error: {
        code: 'WINDOW_UNAVAILABLE',
        operation: 'preferences-set',
        message: 'Diffpane is closing.',
        recoverable: true,
      },
    })
    assert.equal(afterWrite, 0)
    assert.deepEqual(await accepted, { ok: true, value: { key: 'ideasVisible', value: true, revision: 1 } })
    await exited.promise
    assert.equal(closed.mock.calls.length, 1)
  } finally {
    writeRelease.resolve(undefined)
    process.argv = originalArgv
    writes.mockRestore()
    reads.mockRestore()
    closed.mockRestore()
    migrated.mockRestore()
    vi.doUnmock('electron')
    await rm(scratch, { recursive: true, force: true })
  }
})

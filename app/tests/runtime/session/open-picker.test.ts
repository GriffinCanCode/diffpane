import assert from 'node:assert/strict'
import type { ExecFileOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { RmOptions } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { beforeEach, test, vi } from 'vite-plus/test'
import { openPickerFlag, pickMacTarget } from '../../../electron/runtime/window/open-picker.ts'
import type { OpenKind } from '../../../electron/runtime/window/open-picker.ts'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: vi.fn<() => string>() },
  execute:
    vi.fn<
      (
        executable: string,
        args: string[],
        options: ExecFileOptions,
      ) => Promise<{ stdout: string }> & { child: EventEmitter }
    >(),
  mkdtemp: vi.fn<(prefix: string) => Promise<string>>(),
  rm: vi.fn<(profile: string, options: RmOptions) => Promise<void>>(),
}))

vi.mock('electron', () => ({ app: mocks.app, dialog: {} }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execute }) }
})
vi.mock('node:fs/promises', () => ({ mkdtemp: mocks.mkdtemp, rm: mocks.rm }))

const profile = path.join(tmpdir(), 'diffpane-picker-test')
const appPath = path.join(tmpdir(), 'diffpane-app-test')
const selectedFile = path.join(tmpdir(), 'a file\nwith a line break.txt')

beforeEach(() => {
  mocks.app.isPackaged = false
  mocks.app.getAppPath.mockReset().mockReturnValue(appPath)
  mocks.execute.mockReset()
  mocks.mkdtemp.mockReset().mockResolvedValue(profile)
  mocks.rm.mockReset().mockResolvedValue(undefined)
})

async function startPicker(kind: OpenKind, signal = new AbortController().signal) {
  const child = new EventEmitter()
  const execution = Promise.withResolvers<{ stdout: string }>()
  const started = Promise.withResolvers<void>()
  mocks.execute.mockImplementationOnce(() => {
    started.resolve()
    return Object.assign(execution.promise, { child })
  })
  const result = pickMacTarget(kind, signal)
  await started.promise
  return { child, execution, result }
}

test('returns a selected path from the development picker and removes its temporary profile', async () => {
  const { child, execution, result } = await startPicker('file')
  assert.deepEqual(mocks.execute.mock.calls[0]?.slice(0, 2), [
    process.execPath,
    [appPath, openPickerFlag, 'file', `--user-data-dir=${profile}`],
  ])
  execution.resolve({ stdout: JSON.stringify(selectedFile) })
  child.emit('close')
  assert.equal(await result, selectedFile)
  assert.deepEqual(mocks.rm.mock.calls, [[profile, { recursive: true, force: true }]])
})

test('returns null when the packaged folder picker is dismissed', async () => {
  mocks.app.isPackaged = true
  const { child, execution, result } = await startPicker('folder')
  assert.deepEqual(mocks.execute.mock.calls[0]?.[1], [openPickerFlag, 'folder', `--user-data-dir=${profile}`])
  assert.equal(mocks.app.getAppPath.mock.calls.length, 0)
  execution.resolve({ stdout: 'null' })
  child.emit('close')
  assert.equal(await result, null)
  assert.equal(mocks.rm.mock.calls.length, 1)
})

test('reports an unavailable picker if the helper fails', async () => {
  const { child, execution, result } = await startPicker('folder')
  const rejected = assert.rejects(result, { code: 'PICKER_UNAVAILABLE', operation: 'open-folder' })
  execution.reject(new Error('The child could not open its dialog.'))
  child.emit('close')
  await rejected
  assert.equal(mocks.rm.mock.calls.length, 1)
})

test('reports an unavailable picker if the helper returns a relative path', async () => {
  const { child, execution, result } = await startPicker('file')
  const rejected = assert.rejects(result, { code: 'PICKER_UNAVAILABLE', operation: 'open-file' })
  execution.resolve({ stdout: '"relative.txt"' })
  child.emit('close')
  await rejected
  assert.equal(mocks.rm.mock.calls.length, 1)
})

test('kills an aborted picker and waits for the helper to close before removing its profile', async () => {
  const controller = new AbortController()
  const { child, execution, result } = await startPicker('folder', controller.signal)
  const options = mocks.execute.mock.calls[0]?.[2]
  assert.equal(options?.signal, controller.signal)
  assert.equal(options?.killSignal, 'SIGKILL')
  controller.abort()
  execution.reject(Object.assign(new Error('Picker aborted.'), { code: 'ABORT_ERR' }))
  await nextTurn()
  assert.equal(mocks.rm.mock.calls.length, 0)
  child.emit('close')
  assert.equal(await result, null)
  assert.equal(mocks.rm.mock.calls.length, 1)
})

test('cleans up without launching a picker when the owner has already cancelled', async () => {
  assert.equal(await pickMacTarget('folder', AbortSignal.abort()), null)
  assert.equal(mocks.execute.mock.calls.length, 0)
  assert.equal(mocks.rm.mock.calls.length, 1)
})

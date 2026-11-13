import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vite-plus/test'
import { createDiagnosticLog } from '../../../electron/runtime/diagnostics/diagnostic-log.ts'
import { createDiagnostics, parseDiagnostic } from '../../../shared/diagnostics/diagnostics.ts'
import type { DiagnosticEvent } from '../../../shared/diagnostics/diagnostics.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'

test('diagnostics preserve results and errors while recording only safe failure fields', async () => {
  const records: DiagnosticEvent[] = []
  const diagnostics = createDiagnostics('main', event => records.push(event))
  const cause = appError(new Error('private file, prompt, and response'), { code: 'SAVE_CONFLICT', recoverable: false })
  expect(diagnostics.run('save', () => false)).toBe(false)
  expect(() =>
    diagnostics.run('save', () => {
      throw cause
    }),
  ).toThrow(cause)
  await expect(diagnostics.run('save', async () => 'result')).resolves.toBe('result')
  await expect(diagnostics.run('save', () => Promise.reject(cause))).rejects.toBe(cause)
  diagnostics.error('unknown-error', appError(cause, { code: 'PRIVATE_CODE' }))
  expect(records).toHaveLength(5)
  expect(records[3]).toMatchObject({
    kind: 'duration',
    outcome: 'failure',
    failure: { code: 'SAVE_CONFLICT', recoverable: false },
  })
  expect(records[4]).toMatchObject({ failure: { code: 'UNEXPECTED' } })
  const canceled = new DOMException('private operation', 'AbortError')
  await expect(diagnostics.run('search', () => Promise.reject(canceled))).rejects.toBe(canceled)
  expect(records[5]).toMatchObject({ outcome: 'canceled', failure: { code: 'ABORT_ERR' } })
  expect(JSON.stringify(records)).not.toContain('private')
  const broken = createDiagnostics('main', () => {
    throw new Error('Diagnostic sink is unavailable')
  })
  await expect(broken.run('save', async () => true)).resolves.toBe(true)
})

test('IPC accepts a projected diagnostic with safe fields and verified provenance', () => {
  const event = {
    source: 'renderer',
    kind: 'duration',
    level: 'info',
    outcome: 'success',
    operation: 'renderer.document-load',
    durationMs: 24,
    requestId: 5,
    path: '/private/file',
  }
  expect(parseDiagnostic(event, 'renderer')).toEqual({
    source: 'renderer',
    kind: 'duration',
    level: 'info',
    outcome: 'success',
    operation: 'renderer.document-load',
    durationMs: 24,
  })
  expect(parseDiagnostic(event, 'workspace')).toBeUndefined()
  expect(parseDiagnostic({ ...event, durationMs: Infinity }, 'renderer')).toBeUndefined()
  expect(parseDiagnostic({ ...event, operation: '/private/file' }, 'renderer')).toBeUndefined()
  expect(
    parseDiagnostic(
      {
        ...event,
        kind: 'event',
        failure: { code: 'SAVE_CONFLICT', recoverable: true, message: 'private file' },
      },
      'renderer',
    ),
  ).toMatchObject({ level: 'warn', failure: { code: 'SAVE_CONFLICT', recoverable: true } })
})

test('the local log drains queued records and keeps one previous file per launch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'diffpane-diagnostics-'))
  try {
    const config = { appVersion: 'test', maxFileBytes: 150 }
    const log = createDiagnosticLog(directory, config)
    log.record({ source: 'main', operation: 'start-app', kind: 'event', level: 'info' })
    await log.flush()
    log.record({ source: 'main', operation: 'start-workspace', kind: 'event', level: 'info' }, { windowId: 1 })
    await log.flush()
    log.record({ source: 'main', operation: 'stop-app', kind: 'event', level: 'info' })
    await log.close()
    const names = await readdir(directory)
    expect(names).toHaveLength(2)
    const lines = (await Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8')))).join('')
    expect(lines).toContain('"operation":"stop-app"')
    expect(lines).toContain('"operation":"start-workspace"')
    expect(lines).toContain('"windowId":1')
    expect(lines).not.toContain('"operation":"start-app"')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the emitted preload reports transport and malformed replies while preserving application errors', async () => {
  const source = await readFile(new URL('../../../electron/runtime/window/preload.cjs', import.meta.url), 'utf8')
  const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
  const invoke = vi.fn<() => Promise<unknown>>()
  const exposeInMainWorld =
    vi.fn<
      (
        name: string,
        api: { openExternal: (url: string) => Promise<void>; reportDiagnostic: (event: unknown) => void },
      ) => void
    >()
  runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { send, invoke } }),
    performance,
    process: { platform: process.platform },
  })
  const bridge = exposeInMainWorld.mock.calls[0]?.[1]
  if (!bridge) throw new Error('Preload did not expose the desktop bridge')
  invoke.mockResolvedValueOnce({ ok: true, value: undefined })
  await expect(bridge.openExternal('https://example.test')).resolves.toBeUndefined()
  const failure = { code: 'INVALID_LINK', operation: 'open-external', message: 'Invalid link', recoverable: true }
  invoke.mockResolvedValueOnce({ ok: false, error: failure })
  await expect(bridge.openExternal('invalid')).rejects.toEqual(failure)
  expect(send).not.toHaveBeenCalled()
  invoke.mockResolvedValueOnce({ ok: true, value: 'invalid reply' })
  await expect(bridge.openExternal('https://example.test')).rejects.toMatchObject({ code: 'INVALID_IPC_RESPONSE' })
  expect(send).toHaveBeenLastCalledWith(
    'preload-diagnostic',
    'open-external',
    expect.any(Number),
    'INVALID_IPC_RESPONSE',
  )
  invoke.mockRejectedValueOnce(new Error('Disconnected'))
  await expect(bridge.openExternal('https://example.test')).rejects.toMatchObject({ code: 'IPC_UNAVAILABLE' })
  expect(send).toHaveBeenLastCalledWith('preload-diagnostic', 'open-external', expect.any(Number), 'IPC_UNAVAILABLE')
  bridge.reportDiagnostic({
    source: 'renderer',
    operation: 'renderer.error',
    level: 'warn',
    kind: 'event',
    message: 'private file',
    failure: { code: 'SAVE_CONFLICT', recoverable: true, message: 'private file' },
  })
  expect(send).toHaveBeenLastCalledWith('renderer-diagnostic', {
    source: 'renderer',
    operation: 'renderer.error',
    level: 'warn',
    kind: 'event',
    failure: { code: 'SAVE_CONFLICT', recoverable: true },
  })
})

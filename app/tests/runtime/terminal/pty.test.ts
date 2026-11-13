import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { TerminalProcess } from '../../../electron/runtime/terminal/pty.ts'

type TerminalOptions = ConstructorParameters<typeof TerminalProcess>[0]

function fakePty() {
  let dataListener: Parameters<IPty['onData']>[0] | undefined
  let exitListener: Parameters<IPty['onExit']>[0] | undefined
  const pty = {
    pid: 0,
    cols: 80,
    rows: 24,
    process: 'test shell',
    handleFlowControl: false,
    onData(listener) {
      dataListener = listener
      return {
        dispose: () => {
          dataListener = undefined
        },
      }
    },
    onExit(listener) {
      exitListener = listener
      return {
        dispose: () => {
          exitListener = undefined
        },
      }
    },
    write: vi.fn<IPty['write']>(),
    resize: vi.fn<IPty['resize']>(),
    pause: vi.fn<IPty['pause']>(),
    resume: vi.fn<IPty['resume']>(),
    clear: vi.fn<IPty['clear']>(),
    kill: vi.fn<IPty['kill']>(() => {
      exitListener?.({ exitCode: 1 })
    }),
  } satisfies IPty
  return {
    pty,
    emit: (data: string) => {
      dataListener?.(data)
    },
    exit: (exitCode: number, signal?: number) => {
      exitListener?.({ exitCode, signal })
    },
    spawn: vi.fn<NonNullable<ConstructorParameters<typeof TerminalProcess>[1]>>(() => pty),
  }
}

afterEach(() => vi.unstubAllEnvs())

test('uses an absolute OS shell and excludes launcher credentials, overrides and repository paths', async () => {
  const cwd = process.cwd()
  vi.stubEnv('ANTHROPIC_API_KEY', 'ancestor-secret')
  vi.stubEnv('NODE_OPTIONS', '--require ./ancestor.js')
  vi.stubEnv('DIFFPANE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
  vi.stubEnv('BASH_ENV', path.join(cwd, 'repo-hook'))
  vi.stubEnv('SHELL', path.join(cwd, 'repo-executable'))
  vi.stubEnv('PATH', `${path.join(cwd, 'node_modules', '.bin')}${path.delimiter}.${path.delimiter}`)
  const { spawn } = fakePty()
  const callbacks = { onData: vi.fn<TerminalOptions['onData']>(), onExit: vi.fn<TerminalOptions['onExit']>() }
  expect(() => new TerminalProcess({ cwd: '.', cols: 80, rows: 24, ...callbacks }, spawn)).toThrow(
    'Invalid terminal workspace or dimensions.',
  )
  expect(() => new TerminalProcess({ cwd, cols: 80, rows: 0, ...callbacks }, spawn)).toThrow(
    'Invalid terminal workspace or dimensions.',
  )
  expect(spawn).not.toHaveBeenCalled()

  const terminal = new TerminalProcess({ cwd, cols: 80, rows: 24, ...callbacks }, spawn)
  await terminal.dispose()
  expect(spawn).toHaveBeenCalledOnce()
  const call = spawn.mock.calls[0]
  if (!call) throw new Error('Expected the shell to have been spawned.')
  const [shell, , options] = call
  expect(path.isAbsolute(shell)).toBe(true)
  expect(shell).not.toBe(process.env['SHELL'])
  expect(options).toMatchObject({ name: 'xterm-256color', cwd, cols: 80, rows: 24 })
  for (const key of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'DIFFPANE_DEV_SERVER_URL', 'BASH_ENV']) {
    expect(options.env?.[key]).toBeUndefined()
  }
  expect(
    options.env?.['PATH']?.split(path.delimiter).every(entry => path.isAbsolute(entry) && !entry.startsWith(cwd)),
  ).toBe(true)
})

test('bounds IPC input and dimensions, and invalid acknowledgements cannot release backpressure', async () => {
  const { emit, pty, spawn } = fakePty()
  const onData = vi.fn<TerminalOptions['onData']>()
  const onExit = vi.fn<TerminalOptions['onExit']>()
  const terminal = new TerminalProcess({ cwd: process.cwd(), cols: 80, rows: 24, onData, onExit }, spawn)

  terminal.write(['command'])
  terminal.write('😀'.repeat(16_385))
  terminal.write('\x03')
  expect(pty.write.mock.calls).toEqual([['\x03']])
  terminal.resize(Infinity, 24)
  terminal.resize(80, 301)
  terminal.resize(80, 24)
  terminal.resize(132, 40)
  expect(pty.resize.mock.calls).toEqual([[132, 40]])

  const data = ' é 😀 '.repeat(65_536)
  const outputBytes = Buffer.byteLength(data)
  emit(data)
  expect(onData).toHaveBeenCalledExactlyOnceWith(data, outputBytes)
  expect(pty.pause).toHaveBeenCalledOnce()
  terminal.acknowledge(outputBytes + 1)
  terminal.acknowledge(-1)
  expect(pty.resume).not.toHaveBeenCalled()
  terminal.acknowledge(outputBytes)
  expect(pty.resume).toHaveBeenCalledOnce()

  emit(data)
  await terminal.dispose()
  await terminal.dispose()
  terminal.write('printf should-not-run')
  emit('stale')
  expect(pty.kill).toHaveBeenCalledOnce()
  expect(pty.resume).toHaveBeenCalledTimes(2)
  expect(pty.write).toHaveBeenCalledOnce()
  expect(onData).toHaveBeenCalledTimes(2)
  expect(onExit).not.toHaveBeenCalled()
})

test('uses the conventional shell exit status when the PTY shell is signaled', async () => {
  const { exit, pty, spawn } = fakePty()
  const onExit = vi.fn<TerminalOptions['onExit']>()
  const terminal = new TerminalProcess({ cwd: process.cwd(), cols: 80, rows: 24, onData() {}, onExit }, spawn)

  exit(0, 15)
  terminal.write('stale')
  await terminal.dispose()
  expect(onExit).toHaveBeenCalledExactlyOnceWith(143)
  expect(pty.write).not.toHaveBeenCalled()
  expect(pty.kill).not.toHaveBeenCalled()
})

test.skipIf(process.platform === 'win32')(
  'runs an interactive PTY in the workspace and propagates resize and exit',
  async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-terminal-')))
    let terminal: TerminalProcess | undefined
    let output = ''
    const exited = Promise.withResolvers<number | null>()
    try {
      terminal = new TerminalProcess({
        cwd,
        cols: 80,
        rows: 24,
        onData(data, bytes) {
          output += data
          terminal?.acknowledge(bytes)
        },
        onExit: exitCode => exited.resolve(exitCode),
      })
      terminal.resize(101, 34)
      terminal.write("printf 'DIFFPANE_%s\\n' WORKSPACE\r")
      terminal.write("pwd -P; test -t 0 && printf 'DIFFPANE_%s\\n' INTERACTIVE; stty size; exit 7\r")
      try {
        await vi.waitFor(() => expect(output).toContain('DIFFPANE_INTERACTIVE'), { timeout: 4000 })
      } catch (cause) {
        throw new Error(`Terminal output: ${JSON.stringify(output)}`, { cause })
      }
      expect(await exited.promise).toBe(7)
      expect(output).toContain('DIFFPANE_WORKSPACE')
      expect(output).toContain(cwd)
      expect(output).toContain('34 101')
    } finally {
      await terminal?.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  },
  8000,
)

test.skipIf(process.platform === 'win32')('disposing the PTY hangs up its foreground job', async () => {
  let output = ''
  let foregroundPid: number | undefined
  const terminal = new TerminalProcess({
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    onData(data, bytes) {
      output += data
      terminal.acknowledge(bytes)
    },
    onExit() {},
  })
  try {
    terminal.write(`/bin/sh -c 'printf "DIFFPANE_JOB_%d\\n" "$$"; exec sleep 20'\r`)
    const match = await vi.waitFor(() => {
      const pid = /DIFFPANE_JOB_(\d+)/.exec(output)?.[1]
      if (!pid) throw new Error('No foreground job started.')
      return Number(pid)
    })
    foregroundPid = match
    await terminal.dispose()
    await vi.waitFor(() => {
      expect(() => process.kill(match, 0)).toThrow('ESRCH')
    })
    foregroundPid = undefined
  } finally {
    await terminal.dispose()
    if (foregroundPid) {
      try {
        process.kill(foregroundPid, 'SIGKILL')
      } catch {
        // The foreground process already stopped.
      }
    }
  }
})

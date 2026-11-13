import { accessSync, constants, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import path from 'node:path'
import type { IDisposable, IPty } from 'node-pty'
import {
  terminalMaximumColumns,
  terminalMaximumInputBytes,
  terminalMaximumRows,
  terminalMinimumColumns,
  terminalMinimumRows,
} from '../../../shared/terminal/protocol.ts'

const require = createRequire(import.meta.url)
const outputHighWater = 512 * 1024
const outputLowWater = 128 * 1024
const inputBurstBytes = 1024 * 1024
const inputBytesPerMs = inputBurstBytes / 1000
const standardUnixPath = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin']
const macOsPath = ['/opt/homebrew/bin', '/opt/homebrew/sbin', ...standardUnixPath]
const loginShells = new Set(['ash', 'bash', 'csh', 'dash', 'fish', 'ksh', 'mksh', 'nu', 'sh', 'tcsh', 'zsh'])

type SpawnPty = typeof import('node-pty').spawn

interface TerminalOptions {
  cwd: string
  cols: number
  rows: number
  onData: (data: string, bytes: number) => void
  onExit: (exitCode: number | null, reason?: string) => void
}

interface DestroyablePty extends IPty {
  destroy(): void
}

function canDestroy(pty: IPty): pty is DestroyablePty {
  return 'destroy' in pty && typeof pty.destroy === 'function'
}

function validDimension(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function validTerminalSize(cols: unknown, rows: unknown) {
  return (
    validDimension(cols, terminalMinimumColumns, terminalMaximumColumns) &&
    validDimension(rows, terminalMinimumRows, terminalMaximumRows)
  )
}

function executable(filename: string) {
  if (!path.isAbsolute(filename)) return false
  try {
    accessSync(filename, constants.X_OK)
    return statSync(filename).isFile()
  } catch {
    return false
  }
}

function unixShell(shell: string | null) {
  if (shell && executable(shell)) return shell
  return process.platform === 'darwin' && executable('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}

function shellSettings() {
  const user = userInfo()
  const env: Record<string, string | undefined> = { TERM_PROGRAM: 'Diffpane', COLORTERM: 'truecolor' }
  for (const key of [
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'LC_COLLATE',
    'LC_MESSAGES',
    'LC_MONETARY',
    'LC_NUMERIC',
    'LC_TIME',
    'TZ',
  ]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (process.platform === 'win32') {
    const windows = process.env['SystemRoot'] ?? 'C:\\Windows'
    if (!/^[A-Za-z]:\\[^\0]+$/.test(windows)) throw new Error('The Windows system directory is unavailable.')
    const system32 = path.win32.join(windows, 'System32')
    const powershell = path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const cmd = path.win32.join(system32, 'cmd.exe')
    Object.assign(env, {
      PATH: [system32, windows, path.win32.join(system32, 'Wbem'), path.win32.dirname(powershell)].join(';'),
      USERNAME: user.username,
      USERPROFILE: user.homedir,
      HOME: user.homedir,
      APPDATA: path.win32.join(user.homedir, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.win32.join(user.homedir, 'AppData', 'Local'),
      TEMP: path.win32.join(user.homedir, 'AppData', 'Local', 'Temp'),
      TMP: path.win32.join(user.homedir, 'AppData', 'Local', 'Temp'),
      SystemRoot: windows,
      WINDIR: windows,
      ComSpec: cmd,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      NoDefaultCurrentDirectoryInExePath: '1',
    })
    return executable(powershell) ? { shell: powershell, args: ['-NoLogo'], env } : { shell: cmd, args: ['/D'], env }
  }

  const shell = unixShell(user.shell)
  // Login profiles can add user tools. Exclude launcher paths such as a repository's npm bin directory.
  Object.assign(env, {
    PATH: (process.platform === 'darwin' ? macOsPath : standardUnixPath).join(':'),
    HOME: user.homedir,
    USER: user.username,
    LOGNAME: user.username,
    SHELL: shell,
  })
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env['LANG'] ??= process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  const args = loginShells.has(path.basename(shell)) ? ['-l'] : []
  return { shell, args, env }
}

export class TerminalProcess {
  readonly #pty: IPty
  readonly #data: IDisposable
  readonly #exit: IDisposable
  readonly #onExit: TerminalOptions['onExit']
  #outstanding = 0
  #paused = false
  #inputBudget = inputBurstBytes
  #lastInput = performance.now()
  #stopped = false
  #exited = false
  readonly #closed = Promise.withResolvers<void>()
  #forceKill: NodeJS.Timeout | undefined
  #closeDeadline: NodeJS.Timeout | undefined

  constructor({ cwd, cols, rows, onData, onExit }: TerminalOptions, spawnPty?: SpawnPty) {
    if (!path.isAbsolute(cwd) || cwd.includes('\0') || !validTerminalSize(cols, rows))
      throw new Error('Invalid terminal workspace or dimensions.')

    const { shell, args, env } = shellSettings()
    // Load the native addon at start so a missing binding leaves the rest of Diffpane usable.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Resolve the installed addon lazily with its published types.
    const spawn = spawnPty ?? (require('node-pty') as typeof import('node-pty')).spawn
    this.#pty = spawn(shell, args, { name: 'xterm-256color', cwd, cols, rows, env })
    this.#onExit = onExit
    this.#data = this.#pty.onData(data => {
      if (this.#stopped || !data) return
      const bytes = Buffer.byteLength(data)
      this.#outstanding += bytes
      if (!this.#paused && this.#outstanding >= outputHighWater) {
        this.#paused = true
        this.#pty.pause()
      }
      onData(data, bytes)
    })
    this.#exit = this.#pty.onExit(({ exitCode, signal }) => {
      this.#exited = true
      clearTimeout(this.#forceKill)
      clearTimeout(this.#closeDeadline)
      this.#data.dispose()
      this.#exit.dispose()
      this.#closed.resolve()
      if (this.#stopped) return
      this.#stopped = true
      onExit(signal ? 128 + signal : exitCode)
    })
  }

  write(data: unknown) {
    if (this.#stopped || typeof data !== 'string' || !data || data.length > terminalMaximumInputBytes) return
    const bytes = Buffer.byteLength(data)
    if (bytes > terminalMaximumInputBytes) return
    const now = performance.now()
    this.#inputBudget = Math.min(inputBurstBytes, this.#inputBudget + (now - this.#lastInput) * inputBytesPerMs)
    this.#lastInput = now
    if (bytes > this.#inputBudget) {
      this.#stop()
      this.#onExit(null, 'The terminal received input faster than it could safely handle.')
      return
    }
    this.#inputBudget -= bytes
    try {
      this.#pty.write(data)
    } catch {
      this.#stop()
      this.#onExit(null, 'The terminal could not write to the shell.')
    }
  }

  resize(cols: unknown, rows: unknown) {
    if (
      this.#stopped ||
      !validDimension(cols, terminalMinimumColumns, terminalMaximumColumns) ||
      !validDimension(rows, terminalMinimumRows, terminalMaximumRows)
    )
      return
    if (cols === this.#pty.cols && rows === this.#pty.rows) return
    try {
      this.#pty.resize(cols, rows)
    } catch {
      // The PTY may already be closed while its exit event is pending.
    }
  }

  acknowledge(bytes: unknown) {
    if (this.#stopped || !validDimension(bytes, 1, this.#outstanding)) return
    this.#outstanding -= bytes
    if (this.#paused && this.#outstanding <= outputLowWater) {
      this.#paused = false
      this.#pty.resume()
    }
  }

  dispose() {
    this.#stop()
    return this.#closed.promise
  }

  #terminate(signal?: 'SIGHUP' | 'SIGKILL') {
    if (signal && this.#pty.pid > 0) {
      try {
        process.kill(-this.#pty.pid, signal)
        return
      } catch {
        // If the shell changed process groups, signal its PID through node-pty.
      }
    }
    try {
      this.#pty.kill(signal)
    } catch {
      // The native binding may already be closing the pseudoterminal.
    }
  }

  #stop() {
    if (this.#stopped) return
    this.#stopped = true
    this.#data.dispose()
    if (process.platform !== 'win32' && canDestroy(this.#pty)) {
      // Close the master to hang up the foreground job's process group as well as the shell.
      this.#pty.destroy()
    } else {
      if (this.#paused) this.#pty.resume()
      this.#terminate(process.platform === 'win32' ? undefined : 'SIGHUP')
    }
    if (this.#exited) return
    if (process.platform !== 'win32') {
      this.#forceKill = setTimeout(() => this.#terminate('SIGKILL'), 300)
      this.#forceKill.unref()
    }
    this.#closeDeadline = setTimeout(() => this.#closed.resolve(), 900)
    this.#closeDeadline.unref()
  }
}

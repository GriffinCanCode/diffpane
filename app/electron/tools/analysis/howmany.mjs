// MONOLITHIC: Workspace report and file-analysis generations share subprocess cancellation and teardown. Extract file analysis once its invalidation and shutdown are independently owned.
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { LanguageRuntime } from '../languages/language.mjs'

const ANALYSIS_ARGS = ['--output', 'json', '--no-interactive', '--no-cache', '--no-detect', '--threads', '2']
const MAX_OUTPUT = 16 * 1024 * 1024
const MAX_AUTOMATIC_COOLDOWN_MS = 60_000
const MISSING_TOOL = 'HowMany is unavailable. Reinstall Diffpane, or run npm run setup:howmany for source development.'

export function discoverHowMany(env = process.env) {
  if (env.DIFFPANE_HOWMANY_BINARY) return env.DIFFPANE_HOWMANY_BINARY
  const bundled = fileURLToPath(new URL('../../../../resources/howmany/howmany', import.meta.url)).replace(
    /\.asar([\\/])/,
    '.asar.unpacked$1',
  )
  try {
    accessSync(bundled, constants.X_OK)
    return bundled
  } catch {
    /* Development can use PATH. */
  }
  const directories = [
    ...new Set(
      [
        ...(env.PATH ?? '').split(path.delimiter),
        path.join(homedir(), '.local/bin'),
        path.join(homedir(), '.cargo/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(homedir(), '.local/share/mise/shims'),
      ].filter(Boolean),
    ),
  ]
  for (const directory of directories) {
    const candidate = path.join(directory, process.platform === 'win32' ? 'howmany.exe' : 'howmany')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* Try the next location. */
    }
  }
  return null
}

/** @type {ReadonlyArray<'file_count' | keyof LineCounts>} */
const COUNT_FIELDS = [
  'file_count',
  'total_lines',
  'code_lines',
  'doc_lines',
  'comment_lines',
  'blank_lines',
  'total_size',
]

/** @typedef {{total_lines: number, code_lines: number, doc_lines: number, comment_lines: number, blank_lines: number, total_size: number}} LineCounts */
/** @typedef {LineCounts & {total_files: number}} BasicCounts */
/** @typedef {LineCounts & {file_count: number}} SourceCounts */
/** @typedef {'code' | 'config' | 'data' | 'docs'} Category */
/** @typedef {SourceCounts & {language: string, category: Category}} BreakdownRow */
/** @typedef {{basic: BasicCounts, source?: SourceCounts, breakdown?: {rows: BreakdownRow[]}}} Report */
/** @typedef {{status: 'idle' | 'analyzing' | 'ready' | 'error', report: Report | null, message: string, updatedAt: number | null}} AnalysisState */
/** @typedef {{path: string, title: string, live?: boolean, message?: string}} HowManyFile */
/** @typedef {{type: 'analysis'} & AnalysisState} AnalysisEvent */
/** @typedef {{type: 'process', status: 'started' | 'stopped', pid: number}} ProcessEvent */
/** @typedef {{type: 'file', path: string, diagnostics: unknown, request: string}} FileEvent */
/** @typedef {AnalysisEvent | ProcessEvent | FileEvent} HowManyEvent */
/** @typedef {{command?: string | null, env?: NodeJS.ProcessEnv, timeoutMs?: number, debounceMs?: number}} HowManyOptions */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} count @returns {count is number} */
function isCount(count) {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
}

/**
 * @template {'file_count' | 'total_files'} Key
 * @param {unknown} value
 * @param {Key} fileKey
 * @returns {value is LineCounts & Record<Key, number>}
 */
function validCounts(value, fileKey) {
  if (!isRecord(value)) return false
  const {
    total_lines: total,
    code_lines: code,
    doc_lines: doc,
    comment_lines: comment,
    blank_lines: blank,
    total_size: size,
  } = value
  return (
    isCount(value[fileKey]) &&
    isCount(total) &&
    isCount(code) &&
    isCount(doc) &&
    isCount(comment) &&
    isCount(blank) &&
    isCount(size) &&
    total === code + doc + comment + blank
  )
}

/** @param {unknown} value @returns {value is BreakdownRow} */
function isBreakdownRow(value) {
  if (!isRecord(value)) return false
  const { language, category } = value
  return (
    validCounts(value, 'file_count') &&
    typeof language === 'string' &&
    language.length > 0 &&
    (category === 'code' || category === 'config' || category === 'data' || category === 'docs')
  )
}

/** @param {Record<string, unknown>} report @returns {report is Record<string, unknown> & Report} */
function hasSourceReport(report) {
  const { basic, source, breakdown } = report
  const rows = isRecord(breakdown) ? breakdown.rows : undefined
  return (
    validCounts(basic, 'total_files') &&
    validCounts(source, 'file_count') &&
    Array.isArray(rows) &&
    rows.every(isBreakdownRow) &&
    COUNT_FIELDS.every(key => {
      const sourceTotal = rows.filter(row => row.category === 'code').reduce((total, row) => total + row[key], 0)
      const total = rows.reduce((sum, row) => sum + row[key], 0)
      return source[key] === sourceTotal && basic[key === 'file_count' ? 'total_files' : key] === total
    })
  )
}

/** @param {unknown} report @param {boolean} [requireSource] @returns {Report} */
export function validateReport(report, requireSource = true) {
  if (!isRecord(report)) throw new Error('HowMany returned an invalid report')
  const { basic, source } = report
  if (!validCounts(basic, 'total_files')) throw new Error('HowMany returned an invalid report')
  if (!source && !requireSource) return { ...report, basic }
  if (!source)
    throw new Error('HowMany source totals are unavailable. Reinstall Diffpane or run npm run setup:howmany.')
  if (!hasSourceReport(report)) throw new Error('HowMany returned an invalid report')
  return report
}

/** @param {BasicCounts} basic */
export function fileBreakdown(basic) {
  /** @type {ReadonlyArray<readonly [keyof LineCounts, string]>} */
  const fields = [
    ['total_lines', 'lines'],
    ['code_lines', 'code'],
    ['doc_lines', 'doc'],
    ['comment_lines', 'comment'],
    ['blank_lines', 'blank'],
  ]
  return fields
    .filter(([key], index) => index === 0 || basic[key] > 0)
    .map(([key, label]) => `${basic[key].toLocaleString()} ${label}`)
    .join(' · ')
}

/** One debounced workspace analysis and one active document, isolated from language services. */
export class HowManyRuntime {
  /** @type {AnalysisState} */
  state = { status: 'idle', report: null, message: '', updatedAt: null }
  /** @type {Set<import('node:child_process').ChildProcess>} */
  processes = new Set()
  /** @type {Set<Promise<string>>} */
  work = new Set()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  timer
  /** @type {Promise<AnalysisState> | null} */
  analysis = null
  /** @type {Set<Promise<void>>} */
  retiringLanguages = new Set()
  /** @type {Promise<void> | undefined} */
  shutdown
  /** @type {number | undefined} */
  analyzedGeneration
  /** @type {string | undefined} */
  configuration
  /** @type {Promise<boolean> | undefined} */
  version
  /** @type {string | null} */
  activeFile = null
  /** @type {AbortController | null} */
  fileAbort = null
  /** @type {{path: string, version: number, request: string} | null} */
  liveFile = null

  /**
   * @param {string} root
   * @param {string} [scope]
   * @param {(event: HowManyEvent) => void} [onEvent]
   * @param {HowManyOptions} [options]
   */
  constructor(root, scope = root, onEvent = () => {}, options = {}) {
    this.root = root
    this.scope = scope
    this.onEvent = onEvent
    this.options = options
    this.command = options.command ?? discoverHowMany()
    this.generation = 0
    this.fileGeneration = 0
    this.disposed = false
    this.enabled = false
    this.nextAutomaticAnalysisAt = 0
    this.languages = this.createLanguages()
  }

  createLanguages() {
    const languages = new LanguageRuntime(
      this.root,
      (/** @type {unknown} */ event) => {
        if (!isRecord(event)) return
        if (
          event.type === 'process' &&
          typeof event.pid === 'number' &&
          (event.status === 'started' || event.status === 'stopped')
        )
          this.onEvent({ ...event, type: 'process', status: event.status, pid: event.pid })
        else if (event.type === 'diagnostics') {
          const file = this.liveFile
          if (
            languages === this.languages &&
            file &&
            file.path === event.path &&
            file.version === this.fileGeneration + 1 &&
            (event.version === undefined || event.version === file.version)
          )
            this.onEvent({
              ...event,
              type: 'file',
              path: file.path,
              diagnostics: event.diagnostics,
              request: file.request,
            })
        }
      },
      {
        servers: {
          howmany: {
            name: 'HowMany',
            command: this.command,
            args: ['lsp'],
            env: this.options.env ?? process.env,
            manifests: [],
          },
        },
        maxServers: 1,
        initializeTimeoutMs: 5000,
      },
    )
    return languages
  }

  /** @param {Partial<AnalysisState>} update */
  publish(update) {
    if (this.disposed) return
    this.state = { ...this.state, ...update }
    this.onEvent({ type: 'analysis', ...this.state })
  }

  /** @param {readonly string[]} args @param {AbortSignal} [signal] @returns {Promise<string>} */
  run(args, signal) {
    if (this.disposed) return Promise.reject(new Error('HowMany is closed'))
    if (!this.command) return Promise.reject(new Error(MISSING_TOOL))
    if (signal?.aborted) return Promise.reject(new Error('Analysis canceled'))
    const command = this.command
    /** @type {Promise<string>} */
    const operation = new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.scope,
        env: this.options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
      this.processes.add(child)
      if (child.pid) this.onEvent({ type: 'process', status: 'started', pid: child.pid })
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      let stderr = ''
      /** @type {Error | undefined} */
      let failure
      /** @param {Error} error */
      const stop = error => {
        failure ??= error
        this.kill(child)
      }
      const abort = () => stop(new Error('Analysis canceled'))
      const timer = setTimeout(() => stop(new Error('HowMany analysis timed out')), this.options.timeoutMs ?? 30_000)
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
        size += chunk.length
        if (size > MAX_OUTPUT) stop(new Error('HowMany report exceeds 16 MiB'))
        else chunks.push(chunk)
      })
      child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096)
      })
      child.on('error', error => {
        failure ??=
          'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')
            ? new Error(MISSING_TOOL, { cause: error })
            : error
      })
      child.on('close', code => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.processes.delete(child)
        if (child.pid) this.onEvent({ type: 'process', status: 'stopped', pid: child.pid })
        if (failure || code !== 0) reject(failure ?? new Error(stderr.trim() || `HowMany exited (${code})`))
        else resolve(Buffer.concat(chunks).toString('utf8'))
      })
    })
    this.work.add(operation)
    void operation.then(
      () => this.work.delete(operation),
      () => this.work.delete(operation),
    )
    return operation
  }

  /** @param {import('node:child_process').ChildProcess} child */
  kill(child) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {
      /* Already exited. */
    }
  }

  analyze(force = false) {
    this.enabled = true
    clearTimeout(this.timer)
    if (this.disposed) return Promise.resolve(this.state)
    if (this.analysis) return this.analysis
    if (!force && this.state.status === 'ready' && this.analyzedGeneration === this.generation)
      return Promise.resolve(this.state)
    this.command = this.options.command ?? discoverHowMany()
    const generation = this.generation
    const startedAt = performance.now()
    this.publish({ status: 'analyzing', message: '' })
    this.analysis = (async () => {
      try {
        const report = validateReport(JSON.parse(await this.run([this.scope, ...ANALYSIS_ARGS])))
        this.analyzedGeneration = generation
        this.publish({ status: 'ready', report, updatedAt: Date.now(), message: '' })
      } catch (error) {
        this.publish({ status: 'error', message: error instanceof Error ? error.message : 'HowMany analysis failed.' })
      } finally {
        // A large workspace must spend more time idle than counting. Repeated
        // saves (or watcher recovery) can otherwise keep a full scan running
        // continuously. Explicit refreshes still start immediately.
        const finishedAt = performance.now()
        this.nextAutomaticAnalysisAt = finishedAt + Math.min(MAX_AUTOMATIC_COOLDOWN_MS, (finishedAt - startedAt) * 4)
        this.analysis = null
        if (!this.disposed && generation !== this.generation) this.schedule()
      }
      return this.state
    })()
    return this.analysis
  }

  schedule() {
    clearTimeout(this.timer)
    if (this.enabled && !this.disposed)
      this.timer = setTimeout(
        () => {
          void this.analyze(true).catch((/** @type {unknown} */ error) => {
            process.emitWarning(error instanceof Error ? error : 'HowMany analysis failed.')
          })
        },
        Math.max(this.options.debounceMs ?? 1200, this.nextAutomaticAnalysisAt - performance.now()),
      )
  }

  /** @param {readonly string[]} paths */
  changed(paths) {
    if (this.disposed || !paths.length) return
    this.generation++
    this.schedule()
  }

  /** @param {AbortSignal} signal */
  async configure(signal) {
    const env = this.options.env ?? process.env
    const home = env.HOME?.length ? env.HOME : homedir()
    const base =
      process.platform === 'darwin'
        ? path.join(home, 'Library/Application Support')
        : process.platform === 'win32'
          ? env.APPDATA?.length
            ? env.APPDATA
            : path.join(home, 'AppData/Roaming')
          : env.XDG_CONFIG_HOME?.length
            ? env.XDG_CONFIG_HOME
            : path.join(home, '.config')
    const config = await stat(path.join(base, 'howmany/config.toml')).catch(() => null)
    if (signal.aborted) return
    const command = this.options.command ?? discoverHowMany()
    const signature = `${command}:${config?.mtimeMs}:${config?.size}`
    if (signature === this.configuration) return
    this.configuration = signature
    this.command = command
    this.version = undefined
    const previous = this.languages
    this.languages = this.createLanguages()
    const retiring = previous.dispose()
    this.retiringLanguages.add(retiring)
    try {
      await retiring
    } finally {
      this.retiringLanguages.delete(retiring)
    }
  }

  /**
   * @param {string} relative
   * @param {() => Promise<string | null>} readText
   * @param {string} request
   * @returns {Promise<HowManyFile | null>}
   */
  async file(relative, readText, request) {
    if (this.disposed) return null
    if (this.activeFile === relative) {
      // A new request can update the open LSP document without clearing its diagnostics.
      this.fileGeneration++
      this.fileAbort?.abort()
    } else this.closeFile()
    const generation = this.fileGeneration
    // Claim the request before the session starts reading the document. Closing
    // or switching files also cancels reads that have not reached the server yet.
    this.activeFile = relative
    this.fileAbort = new AbortController()
    const signal = this.fileAbort.signal
    let text, languages, absolute
    try {
      text = await readText()
      if (signal.aborted) return null
      if (text === null) {
        this.closeFile(relative)
        return null
      }
      await this.configure(signal)
      if (signal.aborted) return null
      languages = this.languages
      ;({ absolute } = await languages.documentPath(relative))
    } catch (error) {
      if (signal.aborted) return null
      this.closeFile(relative)
      throw error
    }
    if (signal.aborted) return null
    try {
      this.version ??= this.run(['--version'])
        .then(value => {
          const match = value.match(/howmany\s+(\d+)\.(\d+)/)
          const major = Number(match?.[1])
          const minor = Number(match?.[2])
          return (
            Number.isSafeInteger(major) && Number.isSafeInteger(minor) && (major > 3 || (major === 3 && minor >= 1))
          )
        })
        .catch(() => false)
      const live = await this.version
      if (signal.aborted) return null
      if (live) {
        // Versions increase even though Diffpane only displays saved contents.
        const version = generation + 1
        this.liveFile = { path: relative, version, request }
        const result = await languages.open(
          { path: relative, language: 'howmany', languageId: 'howmany', text, version },
          undefined,
          signal,
        )
        if (signal.aborted) return null
        if (result.available) {
          /** @type {unknown} */
          const lenses = await languages.request({
            path: relative,
            language: 'howmany',
            method: 'textDocument/codeLens',
            version,
            signal,
            text: undefined,
            requestId: undefined,
          })
          if (signal.aborted) return null
          /** @type {unknown} */
          const lens = Array.isArray(lenses) ? lenses[0] : undefined
          const command = isRecord(lens) ? lens.command : undefined
          const title = isRecord(command) && typeof command.title === 'string' ? command.title : ''
          return { path: relative, title, live: true }
        }
        this.liveFile = null
        languages.close(relative)
      }
      const report = validateReport(JSON.parse(await this.run([absolute, ...ANALYSIS_ARGS], signal)), false)
      if (signal.aborted) return null
      return {
        path: relative,
        title: report.basic.total_files ? fileBreakdown(report.basic) : '',
        live: false,
      }
    } catch (error) {
      if (signal.aborted || this.disposed) return null
      return { path: relative, title: '', message: error instanceof Error ? error.message : 'HowMany failed.' }
    }
  }

  /** @param {string} [relative] */
  closeFile(relative) {
    if (relative && relative !== this.activeFile) return
    this.fileGeneration++
    this.fileAbort?.abort()
    this.fileAbort = null
    this.liveFile = null
    if (this.activeFile) this.languages.close(this.activeFile)
    this.activeFile = null
  }

  async dispose() {
    if (this.disposed) return this.shutdown
    this.disposed = true
    clearTimeout(this.timer)
    this.closeFile()
    for (const child of this.processes) this.kill(child)
    this.shutdown = Promise.allSettled([
      this.analysis,
      ...this.work,
      ...this.retiringLanguages,
      this.languages.dispose(),
    ]).then(() => undefined)
    return this.shutdown
  }
}

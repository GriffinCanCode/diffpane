// MONOLITHIC: Language-server negotiation, document versions and request cancellation share connection state. Extract the framed transport once its process-lifetime contract is independently exercised.
import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discoverServers } from './servers.ts'

/** @import { DiscoveredServer } from './servers.ts' */
/** @typedef {Pick<DiscoveredServer, 'name' | 'command' | 'args' | 'env'> & Partial<Pick<DiscoveredServer, 'manifests' | 'settings'>>} ServerSpec */
/** @typedef {Parameters<typeof discoverServers>[0] & {servers?: Record<string, ServerSpec>, requestTimeoutMs?: number, initializeTimeoutMs?: number, retryMs?: number, idleMs?: number, maxServers?: number}} RuntimeOptions */
/** @typedef {{resolve: (value: unknown) => void, reject: (error: unknown) => void, cleanup: () => void}} PendingRequest */
/** @typedef {{uri: string, workspace: string, language: string, languageId: string, text: string, version: number}} LanguageDocument */
/** @typedef {{uri: string, type: number}} WatchedChange */
/** @typedef {{path: string, type: 'create' | 'update' | 'delete'}} FileEvent */
/** @typedef {{tokenTypes: string[], tokenModifiers: string[]}} SemanticLegend */
/** @typedef {Record<string, unknown> & {semanticTokensProvider?: {legend?: SemanticLegend, range?: boolean, full?: boolean | Record<string, unknown>}, diagnosticProvider?: {identifier?: string}, textDocumentSync?: number | {change?: number}, positionEncoding?: string}} ServerCapabilities */
/** @typedef {{language: string, workspace: string, spec: ServerSpec, used: number, status: 'starting' | 'ready' | 'error', capabilities: ServerCapabilities, docs: Map<string, LanguageDocument>, diagnosticTimers: Map<string, NodeJS.Timeout>, diagnosticRequests: Map<string, AbortController>, watchedChanges: Map<string, WatchedChange>, ready: Promise<Server | null> | null, connection: Connection, message?: string, failedAt?: number, idle?: NodeJS.Timeout}} Server */
/** @typedef {{path: string, language: string, languageId?: string, text: string, version?: number}} OpenDocumentRequest */
/** @typedef {{path: string, language: string, method: string, params?: Record<string, unknown>, text?: string, version?: number, requestId?: number | string, signal?: AbortSignal}} FeatureRequest */
/** @typedef {{type: 'status', language: string, status: string, message: string, pid?: number, capabilities?: ServerCapabilities} | {type: 'process', language: string, status: 'started' | 'stopped', pid: number} | {type: 'diagnostics', language: string, path: string, version?: number, diagnostics: unknown[]} | {type: 'refresh', language: string}} LanguageEvent */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {value is SemanticLegend} */
function isSemanticLegend(value) {
  return (
    isRecord(value) &&
    Array.isArray(value.tokenTypes) &&
    value.tokenTypes.every(token => typeof token === 'string') &&
    Array.isArray(value.tokenModifiers) &&
    value.tokenModifiers.every(token => typeof token === 'string')
  )
}

/** @param {unknown} value @returns {ServerCapabilities} */
function serverCapabilities(value) {
  if (!isRecord(value)) return {}
  const { semanticTokensProvider, diagnosticProvider, textDocumentSync, positionEncoding, ...other } = value
  return {
    ...other,
    semanticTokensProvider: isRecord(semanticTokensProvider)
      ? {
          legend: isSemanticLegend(semanticTokensProvider.legend) ? semanticTokensProvider.legend : undefined,
          range: Boolean(semanticTokensProvider.range),
          full: isRecord(semanticTokensProvider.full)
            ? semanticTokensProvider.full
            : Boolean(semanticTokensProvider.full),
        }
      : undefined,
    diagnosticProvider: isRecord(diagnosticProvider)
      ? {
          identifier: typeof diagnosticProvider.identifier === 'string' ? diagnosticProvider.identifier : undefined,
        }
      : undefined,
    textDocumentSync:
      typeof textDocumentSync === 'number'
        ? textDocumentSync
        : isRecord(textDocumentSync) && typeof textDocumentSync.change === 'number'
          ? { change: textDocumentSync.change }
          : undefined,
    positionEncoding: typeof positionEncoding === 'string' ? positionEncoding : undefined,
  }
}

const MAX_MESSAGE = 16 * 1024 * 1024
const MAX_DOCUMENT = 2 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })
const semanticTypes = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
]
const semanticModifiers = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
]
/** @type {Readonly<Record<string, string>>} */
const feature = {
  'textDocument/codeLens': 'codeLensProvider',
  'textDocument/hover': 'hoverProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider',
  'textDocument/foldingRange': 'foldingRangeProvider',
  'textDocument/semanticTokens/full': 'semanticTokensProvider',
  'textDocument/semanticTokens/range': 'semanticTokensProvider',
  'textDocument/inlayHint': 'inlayHintProvider',
  'textDocument/definition': 'definitionProvider',
  'textDocument/diagnostic': 'diagnosticProvider',
}

/** @param {unknown} message */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

export class FrameDecoder {
  /** @param {(message: Record<string, unknown>) => void} onMessage */
  constructor(onMessage, maxBytes = MAX_MESSAGE) {
    this.onMessage = onMessage
    this.maxBytes = maxBytes
    this.header = Buffer.alloc(0)
    /** @type {Buffer | null} */
    this.body = null
    this.received = 0
    /** @type {number | null} */
    this.remaining = null
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    let offset = 0
    while (offset < chunk.length) {
      if (this.remaining === null) {
        const limit = Math.min(chunk.length, offset + 16 * 1024 - this.header.length + 4)
        const candidate = Buffer.concat([this.header, chunk.subarray(offset, limit)])
        const boundary = candidate.indexOf('\r\n\r\n')
        if (boundary < 0) {
          if (candidate.length > 16 * 1024) throw new Error('Language server header exceeds 16 KiB')
          this.header = candidate
          return
        }
        if (boundary > 16 * 1024) throw new Error('Language server header exceeds 16 KiB')
        const fields = candidate.subarray(0, boundary).toString('ascii').split('\r\n')
        const lengths = fields.filter(field => field.slice(0, field.indexOf(':')).toLowerCase() === 'content-length')
        const field = lengths[0]
        const value = field?.slice(field.indexOf(':') + 1).trim()
        if (lengths.length !== 1 || !/^\d+$/.test(value ?? ''))
          throw new Error('Invalid language server Content-Length')
        const length = Number(value)
        if (!Number.isSafeInteger(length) || length < 1 || length > this.maxBytes)
          throw new Error('Language server message exceeds the size limit')
        offset += boundary + 4 - this.header.length
        this.header = Buffer.alloc(0)
        this.remaining = length
        this.body = Buffer.allocUnsafe(length)
        this.received = 0
      }
      const length = Math.min(this.remaining, chunk.length - offset)
      const body = this.body
      if (!body) throw new Error('Language server frame has no body')
      if (length) body.set(chunk.subarray(offset, offset + length), this.received)
      this.received += length
      offset += length
      this.remaining -= length
      if (this.remaining === 0) {
        this.body = null
        this.remaining = null
        const message = /** @type {unknown} */ (JSON.parse(utf8.decode(body)))
        if (!isRecord(message)) throw new Error('Invalid language server message')
        this.onMessage(message)
      }
    }
  }
}

class Connection {
  /** @type {Promise<void> | undefined} */
  stopped

  /** @param {ServerSpec & {command: string}} spec @param {string} root @param {(message: Record<string, unknown>, connection: Connection) => void} onMessage @param {(expected: boolean, message: string) => void} onExit @param {RuntimeOptions} options */
  constructor(spec, root, onMessage, onExit, options) {
    /** @type {Map<number, PendingRequest>} */
    this.pending = new Map()
    this.sequence = 0
    this.timeoutMs = options.requestTimeoutMs ?? 12_000
    this.closed = false
    this.processClosed = false
    this.stopping = false
    this.onExit = onExit
    this.stderr = ''
    this.child = spawn(spec.command, spec.args, {
      cwd: root,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
    })
    const parser = new FrameDecoder(message => {
      if (typeof message.method === 'string') onMessage(message, this)
      else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        pending.cleanup()
        if (isRecord(message.error))
          pending.reject(
            Object.assign(
              new Error(
                typeof message.error.message === 'string' ? message.error.message : 'Language server request failed',
              ),
              {
                code: message.error.code,
              },
            ),
          )
        else pending.resolve(message.result ?? null)
      }
    })
    this.child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      try {
        parser.push(chunk)
      } catch (error) {
        this.fail(error)
      }
    })
    this.child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4096)
    })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(this.stderr.trim() || `Language server exited (${signal ?? code})`), this.stopping)
    })
    this.child.once('close', () => {
      this.processClosed = true
    })
  }

  /** @param {Record<string, unknown>} message */
  send(message) {
    if (this.closed || this.child.stdin.destroyed) return false
    const bytes = encodeMessage({ jsonrpc: '2.0', ...message })
    if (bytes.length + this.child.stdin.writableLength > MAX_MESSAGE) {
      this.fail(new Error('Language server write queue exceeds the size limit'))
      return false
    }
    this.child.stdin.write(bytes)
    return true
  }

  /** @param {string} method @param {unknown} [params] */
  notify(method, params) {
    this.send({ method, params })
  }

  /** @param {string} method @param {unknown} params @param {AbortSignal} [signal] @returns {Promise<unknown>} */
  request(method, params, signal, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('Language server is closed'))
    if (signal?.aborted)
      return Promise.reject(Object.assign(new Error('Language request canceled'), { name: 'AbortError' }))
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many language server requests'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const abort = () => {
        if (!this.pending.delete(id)) return
        cleanup()
        this.notify('$/cancelRequest', { id })
        reject(Object.assign(new Error('Language request canceled'), { name: 'AbortError' }))
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        cleanup()
        this.notify('$/cancelRequest', { id })
        reject(new Error(`Language server timed out: ${method}`))
      }, timeoutMs)
      timer.unref()
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup })
      if (!this.send({ id, method, params })) {
        this.pending.delete(id)
        cleanup()
        reject(new Error('Language server is closed'))
      }
    })
  }

  /** @param {unknown} error */
  fail(error, expected = this.stopping) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
    // oxlint-disable-next-line promise/no-promise-in-callback -- The connection starts owned process teardown when any stream fails.
    this.stopProcess().catch((/** @type {unknown} */ cause) => console.error('Could not stop language server', cause))
    this.onExit(expected, error instanceof Error ? error.message : 'Language server connection failed')
  }

  /** @returns {Promise<void>} */
  stopProcess() {
    /** @param {NodeJS.Signals} signal */
    const kill = signal => {
      try {
        if (process.platform === 'win32') this.child.kill(signal)
        else if (this.child.pid) process.kill(-this.child.pid, signal)
      } catch {
        /* The owned process group has already exited. */
      }
    }
    if (this.stopped) return this.stopped
    if (this.processClosed) {
      // The process group can outlive the leader and its pipes.
      kill('SIGKILL')
      return Promise.resolve()
    }
    /** @type {PromiseWithResolvers<void>} */
    const { promise, resolve } = Promise.withResolvers()
    this.stopped = promise
    const timer = setTimeout(() => {
      kill('SIGKILL')
    }, 1000)
    this.child.once('close', () => {
      clearTimeout(timer)
      if (process.platform !== 'win32') {
        // Finish descendants that inherited the group but closed the parent's pipes.
        kill('SIGKILL')
      }
      resolve()
    })
    kill('SIGTERM')
    return this.stopped
  }

  async dispose() {
    if (this.closed) return this.stopped
    this.stopping = true
    try {
      await this.request('shutdown', null, undefined, 400)
      this.notify('exit')
    } catch {
      /* Terminate unresponsive servers below. */
    }
    this.fail(new Error('Language server stopped'))
    await this.stopped
  }
}

/** @param {string} root @param {string} file */
function within(root, file) {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** @param {string} text */
function replacementRange(text) {
  const breaks = /\r\n|\n|\r/g
  let line = 0
  let lineStart = 0
  while (breaks.test(text)) {
    line++
    lineStart = breaks.lastIndex
  }
  return {
    start: { line: 0, character: 0 },
    end: { line, character: text.length - lineStart },
  }
}

function clientCapabilities() {
  return {
    general: { positionEncodings: ['utf-16'] },
    window: { workDoneProgress: true },
    workspace: {
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
      applyEdit: false,
      semanticTokens: { refreshSupport: true },
      inlayHint: { refreshSupport: true },
      diagnostics: { refreshSupport: true },
    },
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        didSave: false,
        willSave: false,
        willSaveWaitUntil: false,
      },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      foldingRange: { lineFoldingOnly: true },
      publishDiagnostics: {
        versionSupport: true,
        relatedInformation: true,
        tagSupport: { valueSet: [1, 2] },
      },
      semanticTokens: {
        dynamicRegistration: true,
        requests: { range: true, full: true },
        tokenTypes: semanticTypes,
        tokenModifiers: semanticModifiers,
        formats: ['relative'],
        overlappingTokenSupport: false,
        multilineTokenSupport: false,
      },
      inlayHint: { dynamicRegistration: true },
      diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
    },
  }
}

export class LanguageRuntime {
  /** @param {string} root @param {(event: LanguageEvent) => void} [onEvent] @param {RuntimeOptions} [options] */
  constructor(root, onEvent = () => {}, options = {}) {
    this.root = path.resolve(root)
    this.onEvent = onEvent
    this.options = options
    this.specs = options.servers ?? discoverServers(options)
    /** @type {Map<string, Server>} */
    this.servers = new Map()
    /** @type {Map<string, LanguageDocument>} */
    this.documents = new Map()
    /** @type {Map<string, object>} */
    this.openings = new Map()
    /** @type {Map<number | string, AbortController>} */
    this.requests = new Map()
    /** @type {Set<Promise<void>>} */
    this.stopping = new Set()
    this.disposed = false
    this.clock = 0
  }

  status() {
    return Object.entries(this.specs).map(([language, spec]) => {
      const server = this.servers.get(language)
      return {
        language,
        name: spec.name,
        command: spec.command,
        status: server?.status ?? (spec.command ? 'available' : 'missing'),
        message: server?.message ?? (spec.command ? 'Starts when a file is viewed' : `${spec.name} is not installed`),
        capabilities: server?.capabilities ?? null,
        pid: server?.connection?.child.pid ?? null,
        workspace: server?.workspace ?? null,
      }
    })
  }

  /** @param {LanguageEvent} event */
  event(event) {
    if (!this.disposed || event.type === 'process') this.onEvent(event)
  }

  /** @param {unknown} relative */
  async documentPath(relative) {
    if (
      typeof relative !== 'string' ||
      !relative ||
      relative.includes('\0') ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).includes('..')
    )
      throw new Error('Invalid language document path')
    const absolute = path.resolve(this.root, relative)
    if (!within(this.root, absolute)) throw new Error('Language document is outside this directory')
    const [root, resolved] = await Promise.all([realpath(this.root), realpath(absolute)])
    if (!within(root, resolved)) throw new Error('Language document is outside this directory')
    return { absolute, uri: pathToFileURL(absolute).href }
  }

  /** @param {string} absolute @param {string} language */
  async projectRoot(absolute, language) {
    const spec = this.specs[language]
    for (let directory = path.dirname(absolute); within(this.root, directory); directory = path.dirname(directory)) {
      for (const filename of spec?.manifests ?? []) {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Search nearest project manifests first and bound filesystem probes.
          if ((await stat(path.join(directory, filename))).isFile()) return directory
        } catch {
          /* Continue toward the selected directory root. */
        }
      }
      if (directory === this.root) break
    }
    return this.root
  }

  /** @param {string} language @returns {Promise<Server | null>} */
  async server(language, workspace = this.root) {
    if (this.disposed) throw new Error('Language runtime is closed')
    let spec = this.specs[language]
    if (!spec) return null
    if ((!spec.command || this.servers.get(language)?.status === 'error') && !this.options.servers) {
      spec = discoverServers(this.options)[language]
      if (!spec) return null
      this.specs[language] = spec
    }
    if (!spec.command) {
      this.event({
        type: 'status',
        language,
        status: 'missing',
        message: `${spec.name} is not installed`,
      })
      return null
    }
    let server = this.servers.get(language)
    if (server && server.workspace !== workspace) {
      this.stop(language)
      server = undefined
    }
    if (server?.status === 'error') {
      if (Date.now() - (server.failedAt ?? 0) < (this.options.retryMs ?? 2000)) return null
      this.stop(language)
      server = undefined
    }
    if (server) {
      server.used = ++this.clock
      if (server.status === 'ready') this.idle(server)
      return server.ready
    }
    const maximum = this.options.maxServers ?? 2
    const active = [...this.servers.values()].filter(value => value.status !== 'error')
    if (active.length >= maximum) {
      const victim = active.toSorted((a, b) => a.used - b.used)[0]
      if (victim) this.stop(victim.language)
    }
    const { command } = spec
    const connection = new Connection(
      { ...spec, command },
      workspace,
      (message, owner) => {
        const activeServer = this.servers.get(language)
        if (activeServer?.connection === owner) this.receive(activeServer, message, owner)
      },
      (expected, message) => {
        if (!expected && this.servers.get(language) === starting) {
          starting.status = 'error'
          starting.failedAt = Date.now()
          starting.message = message
          this.event({ type: 'status', language, status: 'error', message, pid: connection.child.pid })
        }
        const pid = connection.child.pid
        if (pid) {
          connection.stopped
            ?.then(() => {
              this.event({ type: 'process', language, pid, status: 'stopped' })
              return undefined
            })
            .catch((/** @type {unknown} */ cause) => console.error('Could not report language server shutdown', cause))
        }
      },
      this.options,
    )
    /** @type {Server} */
    const starting = {
      language,
      workspace,
      spec,
      connection,
      used: ++this.clock,
      status: 'starting',
      capabilities: {},
      docs: new Map(),
      diagnosticTimers: new Map(),
      diagnosticRequests: new Map(),
      watchedChanges: new Map(),
      ready: null,
    }
    this.servers.set(language, starting)
    server = starting
    this.event({
      type: 'status',
      language,
      status: 'starting',
      message: `Starting ${spec.name}`,
      pid: server.connection.child.pid,
    })
    if (server.connection.child.pid)
      this.event({
        type: 'process',
        language,
        pid: server.connection.child.pid,
        status: 'started',
      })
    server.ready = this.initialize(server).catch((/** @type {unknown} */ error) => {
      starting.connection.fail(error)
      return null
    })
    return server.ready
  }

  /** @param {Server} server */
  async initialize(server) {
    const settings = server.spec.settings ?? {}
    const initializationOptions = server.language === 'rust' ? settings['rust-analyzer'] : undefined
    const result = await server.connection.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Diffpane', version: '0.4.0' },
        rootPath: server.workspace,
        rootUri: pathToFileURL(server.workspace).href,
        workspaceFolders: [{ uri: pathToFileURL(server.workspace).href, name: path.basename(server.workspace) }],
        capabilities: clientCapabilities(),
        initializationOptions,
      },
      undefined,
      this.options.initializeTimeoutMs ?? 30_000,
    )
    if (server.connection.closed || this.servers.get(server.language) !== server) return null
    server.capabilities = serverCapabilities(isRecord(result) ? result.capabilities : undefined)
    if (server.capabilities.positionEncoding && server.capabilities.positionEncoding !== 'utf-16')
      throw new Error(`Unsupported position encoding: ${server.capabilities.positionEncoding}`)
    server.connection.notify('initialized', {})
    server.connection.notify('workspace/didChangeConfiguration', { settings })
    if (server.watchedChanges.size) {
      server.connection.notify('workspace/didChangeWatchedFiles', {
        changes: [...server.watchedChanges.values()],
      })
      server.watchedChanges.clear()
    }
    server.status = 'ready'
    server.message = server.spec.name
    this.event({
      type: 'status',
      language: server.language,
      status: 'ready',
      message: server.spec.name,
      pid: server.connection.child.pid,
      capabilities: server.capabilities,
    })
    this.idle(server)
    return server
  }

  /** @param {Server} server @param {Record<string, unknown>} message @param {Connection} connection */
  receive(server, message, connection) {
    if (this.servers.get(server.language) !== server || connection.closed) return
    const params = isRecord(message.params) ? message.params : undefined
    if (typeof message.method !== 'string') return
    if (message.method === '$/progress' && isRecord(params?.value) && params.value.kind === 'end') {
      this.refresh(server)
    } else if (message.method === 'textDocument/publishDiagnostics') {
      let absolute
      try {
        if (typeof params?.uri !== 'string') return
        absolute = fileURLToPath(params.uri)
      } catch {
        return
      }
      if (!within(this.root, absolute)) return
      const relative = path.relative(this.root, absolute)
      const document = this.documents.get(relative)
      if (!document || server.docs.get(relative) !== document) return
      const version = typeof params.version === 'number' ? params.version : undefined
      if (version !== undefined && version < document.version) return
      this.event({
        type: 'diagnostics',
        language: server.language,
        path: relative,
        version,
        diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
      })
    } else if (typeof message.id === 'number' || typeof message.id === 'string') {
      /** @type {unknown} */
      let result = null
      if (message.method === 'workspace/configuration') {
        const items = Array.isArray(params?.items) ? params.items : []
        result = items.map((/** @type {unknown} */ item) => {
          /** @type {unknown} */
          let value = server.spec.settings ?? {}
          const section = isRecord(item) && typeof item.section === 'string' ? item.section : ''
          for (const key of section.split('.').filter(Boolean))
            value = isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined
          return value ?? null
        })
      } else if (message.method === 'workspace/workspaceFolders')
        result = [{ uri: pathToFileURL(server.workspace).href, name: path.basename(server.workspace) }]
      else if (message.method === 'workspace/applyEdit')
        result = {
          applied: false,
          failureReason: 'Server-initiated workspace edits are not supported.',
        }
      else if (message.method === 'client/registerCapability') {
        const registrations = Array.isArray(params?.registrations) ? params.registrations : []
        for (const registration of /** @type {unknown[]} */ (registrations)) {
          if (!isRecord(registration) || typeof registration.method !== 'string') continue
          const capability =
            feature[registration.method] ??
            (registration.method === 'textDocument/semanticTokens' ? 'semanticTokensProvider' : null)
          if (capability === 'semanticTokensProvider') {
            server.capabilities.semanticTokensProvider = serverCapabilities({
              semanticTokensProvider: registration.registerOptions,
            }).semanticTokensProvider
          } else if (capability) server.capabilities[capability] = registration.registerOptions ?? true
        }
        this.refresh(server)
      } else if (message.method.endsWith('/refresh')) this.refresh(server)
      else if (
        !['client/unregisterCapability', 'window/workDoneProgress/create', 'window/showMessageRequest'].includes(
          message.method,
        )
      ) {
        connection.send({
          id: message.id,
          error: { code: -32601, message: 'Client method is not supported' },
        })
        return
      }
      connection.send({ id: message.id, result })
    }
  }

  /** @param {Server} server */
  refresh(server) {
    this.event({ type: 'refresh', language: server.language })
    for (const relative of server.docs.keys()) this.scheduleDiagnostics(server, relative)
  }

  /** @param {Server} server @param {string} relative */
  scheduleDiagnostics(server, relative) {
    const provider = server.capabilities.diagnosticProvider
    if (!provider || !server.docs.has(relative)) return
    clearTimeout(server.diagnosticTimers.get(relative))
    server.diagnosticRequests.get(relative)?.abort()
    const pull = async () => {
      server.diagnosticTimers.delete(relative)
      const document = this.documents.get(relative)
      if (!document || server.docs.get(relative) !== document) return
      const controller = new AbortController()
      server.diagnosticRequests.set(relative, controller)
      try {
        const result = await server.connection.request(
          'textDocument/diagnostic',
          {
            textDocument: { uri: document.uri },
            identifier: provider.identifier,
          },
          controller.signal,
        )
        if (
          this.documents.get(relative) === document &&
          !controller.signal.aborted &&
          isRecord(result) &&
          result.kind === 'full'
        ) {
          this.event({
            type: 'diagnostics',
            language: server.language,
            path: relative,
            version: document.version,
            diagnostics: Array.isArray(result.items) ? result.items : [],
          })
        }
      } catch {
        /* Canceled or failed pulls are retried when the document or server refreshes. */
      } finally {
        if (server.diagnosticRequests.get(relative) === controller) server.diagnosticRequests.delete(relative)
      }
    }
    const timer = setTimeout(() => {
      pull().catch((/** @type {unknown} */ cause) => console.error('Could not update language diagnostics', cause))
    }, 60)
    timer.unref()
    server.diagnosticTimers.set(relative, timer)
  }

  /** @param {OpenDocumentRequest} input @param {() => Promise<void>} [validate] */
  async open({ path: relative, language, languageId, text, version = 1 }, validate) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_DOCUMENT)
      throw new Error('Language document exceeds 2 MiB')
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid language document version')
    const opening = {}
    this.openings.set(relative, opening)
    try {
      await validate?.()
      if (this.openings.get(relative) !== opening) return { available: false, stale: true }
      const { uri, absolute } = await this.documentPath(relative)
      const workspace = await this.projectRoot(absolute, language)
      if (this.openings.get(relative) !== opening) return { available: false, stale: true }
      const previous = this.documents.get(relative)
      if (previous && previous.language !== language) this.close(relative)
      const document = this.documents.get(relative)
      if (document && version < document.version) return { available: false, stale: true }
      languageId ??= document?.languageId ?? language
      const current =
        document?.version === version &&
        document.text === text &&
        document.languageId === languageId &&
        document.workspace === workspace
          ? document
          : { uri, workspace, language, languageId, text, version }
      this.documents.set(relative, current)
      const server = await this.server(language, workspace)
      if (!server) return { available: false, capabilities: {} }
      if (!this.syncDocument(server, relative, current)) return { available: false, stale: true }
      return {
        available: true,
        workspace,
        capabilities: server.capabilities,
        legend: server.capabilities.semanticTokensProvider?.legend ?? null,
      }
    } finally {
      if (this.openings.get(relative) === opening) this.openings.delete(relative)
    }
  }

  /** @param {Server} server @param {string} relative @param {LanguageDocument} document */
  syncDocument(server, relative, document) {
    if (
      this.documents.get(relative) !== document ||
      this.servers.get(document.language) !== server ||
      server.connection.closed
    )
      return false
    clearTimeout(server.idle)
    const previous = server.docs.get(relative)
    if (previous === document) return true
    const { uri, languageId, version, text } = document
    if (previous && previous.languageId !== languageId)
      server.connection.notify('textDocument/didClose', { textDocument: { uri } })
    if (!previous || previous.languageId !== languageId) {
      server.connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version, text },
      })
    } else {
      const sync = server.capabilities.textDocumentSync
      const change = typeof sync === 'number' ? sync : sync?.change
      if (change !== 0) {
        const edit = change === 2 ? { range: replacementRange(previous.text), text } : { text }
        server.connection.notify('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [edit],
        })
      }
    }
    if (server.connection.closed) return false
    server.docs.set(relative, document)
    this.scheduleDiagnostics(server, relative)
    return true
  }

  /** @param {FeatureRequest} input */
  async request({ path: relative, language, method, params = {}, text, version, requestId, signal }) {
    const capability = Object.hasOwn(feature, method) ? feature[method] : undefined
    if (!capability) throw new Error('Unsupported language feature request')
    let controller
    if (requestId !== undefined) {
      this.cancel(requestId)
      controller = new AbortController()
      this.requests.set(requestId, controller)
    }
    const cancellation = controller?.signal ?? signal
    try {
      if (cancellation?.aborted) return null
      if (text !== undefined && !(await this.open({ path: relative, language, text, version })).available) return null
      const document = this.documents.get(relative)
      if (
        cancellation?.aborted ||
        !document ||
        document.language !== language ||
        (version !== undefined && document.version !== version)
      )
        return null
      const server = await this.server(language, document.workspace)
      if (cancellation?.aborted || !server || !this.syncDocument(server, relative, document)) return null
      const supported = server.capabilities[capability]
      if (
        !supported ||
        (method.endsWith('/range') && (!isRecord(supported) || !supported.range)) ||
        (method === 'textDocument/semanticTokens/full' && (!isRecord(supported) || !supported.full))
      )
        return null
      const result = await server.connection.request(
        method,
        { ...params, textDocument: { uri: document.uri } },
        cancellation,
      )
      return !cancellation?.aborted &&
        this.documents.get(relative) === document &&
        this.servers.get(language) === server
        ? result
        : null
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' ||
          ('code' in error && typeof error.code === 'number' && [-32601, -32800, -32801, -32802].includes(error.code)))
      )
        return null
      throw error
    } finally {
      if (controller && requestId !== undefined && this.requests.get(requestId) === controller)
        this.requests.delete(requestId)
    }
  }

  /** @param {readonly FileEvent[]} events */
  changed(events) {
    if (this.disposed || !this.servers.size) return
    /** @type {Map<string, WatchedChange>} */
    const changes = new Map()
    for (const event of events) {
      if (!event || typeof event.path !== 'string' || event.path.includes('\0')) continue
      const absolute = path.resolve(this.root, event.path)
      const type = { create: 1, update: 2, delete: 3 }[event.type]
      if (!type || !within(this.root, absolute)) continue
      changes.set(absolute, { uri: pathToFileURL(absolute).href, type })
      if (changes.size >= 4096) break
    }
    for (const server of this.servers.values()) {
      if (!['ready', 'starting'].includes(server.status)) continue
      const relevant = [...changes].filter(([absolute]) => within(server.workspace, absolute))
      if (server.status === 'ready') {
        if (relevant.length)
          server.connection.notify('workspace/didChangeWatchedFiles', {
            changes: relevant.map(([, change]) => change),
          })
      } else {
        for (const [absolute, change] of relevant) {
          server.watchedChanges.set(absolute, change)
          if (server.watchedChanges.size >= 4096) break
        }
      }
    }
  }

  /** @param {number | string} requestId */
  cancel(requestId) {
    this.requests.get(requestId)?.abort()
    this.requests.delete(requestId)
  }

  /** @param {string} relative */
  close(relative) {
    this.openings.delete(relative)
    const document = this.documents.get(relative)
    if (!document) return
    this.documents.delete(relative)
    const server = this.servers.get(document.language)
    if (!server) return
    const opened = server.docs.delete(relative)
    clearTimeout(server.diagnosticTimers.get(relative))
    server.diagnosticTimers.delete(relative)
    server.diagnosticRequests.get(relative)?.abort()
    server.diagnosticRequests.delete(relative)
    if (opened) server.connection.notify('textDocument/didClose', { textDocument: { uri: document.uri } })
    this.event({
      type: 'diagnostics',
      language: document.language,
      path: relative,
      diagnostics: [],
    })
    this.idle(server)
  }

  /** @param {Server} server */
  idle(server) {
    if (server.status !== 'ready' || server.docs.size || this.servers.get(server.language) !== server) return
    clearTimeout(server.idle)
    server.idle = setTimeout(() => this.stop(server.language), this.options.idleMs ?? 15_000)
    server.idle.unref()
  }

  /** @param {string} language */
  stop(language) {
    const server = this.servers.get(language)
    if (!server) return
    clearTimeout(server.idle)
    this.servers.delete(language)
    for (const timer of server.diagnosticTimers.values()) clearTimeout(timer)
    for (const request of server.diagnosticRequests.values()) request.abort()
    for (const relative of server.docs.keys())
      this.event({ type: 'diagnostics', language, path: relative, diagnostics: [] })
    this.event({
      type: 'status',
      language,
      status: 'available',
      message: 'Stopped while not in use',
    })
    const stopping = server.connection.dispose()
    this.stopping.add(stopping)
    stopping
      .finally(() => this.stopping.delete(stopping))
      .catch((/** @type {unknown} */ cause) => console.error('Could not dispose language server', cause))
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const requestId of this.requests.keys()) this.cancel(requestId)
    for (const language of this.servers.keys()) this.stop(language)
    this.documents.clear()
    this.openings.clear()
    await Promise.allSettled(this.stopping)
  }
}

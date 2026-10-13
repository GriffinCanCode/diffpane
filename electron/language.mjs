import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverServers } from './servers.ts';

const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_DOCUMENT = 2 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
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
];
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
];
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
};

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

export class FrameDecoder {
  constructor(onMessage, maxBytes = MAX_MESSAGE) {
    this.onMessage = onMessage;
    this.maxBytes = maxBytes;
    this.header = Buffer.alloc(0);
    this.body = null;
    this.received = 0;
    this.remaining = null;
  }

  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === null) {
        const limit = Math.min(chunk.length, offset + 16 * 1024 - this.header.length + 4);
        const candidate = Buffer.concat([this.header, chunk.subarray(offset, limit)]);
        const boundary = candidate.indexOf('\r\n\r\n');
        if (boundary < 0) {
          if (candidate.length > 16 * 1024)
            throw new Error('Language server header exceeds 16 KiB');
          this.header = candidate;
          return;
        }
        if (boundary > 16 * 1024) throw new Error('Language server header exceeds 16 KiB');
        const fields = candidate.subarray(0, boundary).toString('ascii').split('\r\n');
        const lengths = fields.filter(
          field => field.slice(0, field.indexOf(':')).toLowerCase() === 'content-length',
        );
        const value = lengths[0]?.slice(lengths[0].indexOf(':') + 1).trim();
        if (lengths.length !== 1 || !/^\d+$/.test(value ?? ''))
          throw new Error('Invalid language server Content-Length');
        const length = Number(value);
        if (!Number.isSafeInteger(length) || length < 1 || length > this.maxBytes)
          throw new Error('Language server message exceeds the size limit');
        offset += boundary + 4 - this.header.length;
        this.header = Buffer.alloc(0);
        this.remaining = length;
        this.body = Buffer.allocUnsafe(length);
        this.received = 0;
      }
      const length = Math.min(this.remaining, chunk.length - offset);
      if (length) this.body.set(chunk.subarray(offset, offset + length), this.received);
      this.received += length;
      offset += length;
      this.remaining -= length;
      if (this.remaining === 0) {
        const body = this.body;
        this.body = null;
        this.remaining = null;
        const message = JSON.parse(utf8.decode(body));
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new Error('Invalid language server message');
        this.onMessage(message);
      }
    }
  }
}

class Connection {
  constructor(spec, root, onMessage, onExit, options) {
    this.pending = new Map();
    this.sequence = 0;
    this.timeoutMs = options.requestTimeoutMs ?? 12_000;
    this.closed = false;
    this.stopping = false;
    this.onExit = onExit;
    this.stderr = '';
    this.child = spawn(spec.command, spec.args, {
      cwd: root,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
    });
    const parser = new FrameDecoder(message => {
      if (message.method) onMessage(message, this);
      else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.error)
          pending.reject(
            Object.assign(new Error(message.error.message ?? 'Language server request failed'), {
              code: message.error.code,
            }),
          );
        else pending.resolve(message.result ?? null);
      }
    });
    this.child.stdout.on('data', chunk => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4096);
    });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(
        new Error(this.stderr.trim() || `Language server exited (${signal ?? code})`),
        this.stopping,
      );
    });
  }

  send(message) {
    if (this.closed || this.child.stdin.destroyed) return false;
    const bytes = encodeMessage({ jsonrpc: '2.0', ...message });
    if (bytes.length + this.child.stdin.writableLength > MAX_MESSAGE) {
      this.fail(new Error('Language server write queue exceeds the size limit'));
      return false;
    }
    this.child.stdin.write(bytes);
    return true;
  }

  notify(method, params) {
    this.send({ method, params });
  }

  request(method, params, signal, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('Language server is closed'));
    if (signal?.aborted)
      return Promise.reject(
        Object.assign(new Error('Language request canceled'), { name: 'AbortError' }),
      );
    if (this.pending.size >= 64)
      return Promise.reject(new Error('Too many language server requests'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.notify('$/cancelRequest', { id });
        reject(Object.assign(new Error('Language request canceled'), { name: 'AbortError' }));
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.notify('$/cancelRequest', { id });
        reject(new Error(`Language server timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      if (!this.send({ id, method, params })) {
        this.pending.delete(id);
        cleanup();
        reject(new Error('Language server is closed'));
      }
    });
  }

  fail(error, expected = this.stopping) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    this.onExit(expected, error.message);
    void this.stopProcess();
  }

  stopProcess() {
    const kill = signal => {
      try {
        if (process.platform === 'win32') this.child.kill(signal);
        else if (this.child.pid) process.kill(-this.child.pid, signal);
      } catch {
        /* The owned process group has already exited. */
      }
    };
    if (this.stopped) return this.stopped;
    kill('SIGTERM');
    this.stopped = new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        kill('SIGKILL');
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      this.child.once('close', finish);
    });
    return this.stopped;
  }

  async dispose() {
    if (this.closed) return this.stopped;
    this.stopping = true;
    try {
      await this.request('shutdown', null, undefined, 400);
      this.notify('exit');
    } catch {
      /* Terminate unresponsive servers below. */
    }
    this.fail(new Error('Language server stopped'));
    await this.stopped;
  }
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
  };
}

export class LanguageRuntime {
  constructor(root, onEvent = () => {}, options = {}) {
    this.root = path.resolve(root);
    this.onEvent = onEvent;
    this.options = options;
    this.specs = options.servers ?? discoverServers(options);
    this.servers = new Map();
    this.documents = new Map();
    this.openings = new Map();
    this.requests = new Map();
    this.stopping = new Set();
    this.disposed = false;
    this.clock = 0;
  }

  status() {
    return Object.entries(this.specs).map(([language, spec]) => {
      const server = this.servers.get(language);
      return {
        language,
        name: spec.name,
        command: spec.command,
        status: server?.status ?? (spec.command ? 'available' : 'missing'),
        message:
          server?.message ??
          (spec.command ? 'Starts when a file is viewed' : `${spec.name} is not installed`),
        capabilities: server?.capabilities ?? null,
        pid: server?.connection?.child.pid ?? null,
        workspace: server?.workspace ?? null,
      };
    });
  }

  event(event) {
    if (!this.disposed || event.type === 'process') this.onEvent(event);
  }

  async documentPath(relative) {
    if (
      typeof relative !== 'string' ||
      !relative ||
      relative.includes('\0') ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).includes('..')
    )
      throw new Error('Invalid language document path');
    const absolute = path.resolve(this.root, relative);
    if (!within(this.root, absolute))
      throw new Error('Language document is outside this directory');
    const [root, resolved] = await Promise.all([realpath(this.root), realpath(absolute)]);
    if (!within(root, resolved)) throw new Error('Language document is outside this directory');
    return { absolute, uri: pathToFileURL(absolute).href };
  }

  async projectRoot(absolute, language) {
    for (
      let directory = path.dirname(absolute);
      within(this.root, directory);
      directory = path.dirname(directory)
    ) {
      for (const filename of this.specs[language]?.manifests ?? []) {
        try {
          if ((await stat(path.join(directory, filename))).isFile()) return directory;
        } catch {
          /* Continue toward the selected directory root. */
        }
      }
      if (directory === this.root) break;
    }
    return this.root;
  }

  async server(language, workspace = this.root) {
    if (this.disposed) throw new Error('Language runtime is closed');
    let spec = this.specs[language];
    if (!spec) return null;
    if (
      (!spec.command || this.servers.get(language)?.status === 'error') &&
      !this.options.servers
    ) {
      spec = discoverServers(this.options)[language];
      this.specs[language] = spec;
    }
    if (!spec.command) {
      this.event({
        type: 'status',
        language,
        status: 'missing',
        message: `${spec.name} is not installed`,
      });
      return null;
    }
    let server = this.servers.get(language);
    if (server && server.workspace !== workspace) {
      this.stop(language);
      server = null;
    }
    if (server?.status === 'error') {
      if (Date.now() - server.failedAt < (this.options.retryMs ?? 2000)) return null;
      this.stop(language);
      server = null;
    }
    if (server) {
      server.used = ++this.clock;
      clearTimeout(server.idle);
      return server.ready;
    }
    const maximum = this.options.maxServers ?? 2;
    const active = [...this.servers.values()].filter(value => value.status !== 'error');
    if (active.length >= maximum) {
      const victim = active.sort((a, b) => a.used - b.used)[0];
      this.stop(victim.language);
    }
    server = {
      language,
      workspace,
      spec,
      used: ++this.clock,
      status: 'starting',
      capabilities: {},
      docs: new Set(),
      diagnosticTimers: new Map(),
      diagnosticRequests: new Map(),
      watchedChanges: new Map(),
      ready: null,
    };
    this.servers.set(language, server);
    server.connection = new Connection(
      spec,
      workspace,
      (message, connection) => this.receive(server, message, connection),
      (expected, message) => {
        if (!expected && this.servers.get(language) === server) {
          server.status = 'error';
          server.failedAt = Date.now();
          server.message = message;
          this.event({
            type: 'status',
            language,
            status: 'error',
            message,
            pid: server.connection?.child.pid,
          });
        }
        queueMicrotask(() => {
          void server.connection?.stopped?.then(() =>
            this.event({
              type: 'process',
              language,
              pid: server.connection.child.pid,
              status: 'stopped',
            }),
          );
        });
      },
      this.options,
    );
    this.event({
      type: 'status',
      language,
      status: 'starting',
      message: `Starting ${spec.name}`,
      pid: server.connection.child.pid,
    });
    if (server.connection.child.pid)
      this.event({
        type: 'process',
        language,
        pid: server.connection.child.pid,
        status: 'started',
      });
    server.ready = this.initialize(server).catch(error => {
      if (this.servers.get(language) === server) {
        server.status = 'error';
        server.failedAt = Date.now();
        server.message = error.message;
        this.event({ type: 'status', language, status: 'error', message: error.message });
      }
      server.connection.fail(error);
      return null;
    });
    return server.ready;
  }

  async initialize(server) {
    const settings = server.spec.settings ?? {};
    const initializationOptions =
      server.language === 'rust' ? settings['rust-analyzer'] : undefined;
    const result = await server.connection.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Diffpane', version: '0.4.0' },
        rootPath: server.workspace,
        rootUri: pathToFileURL(server.workspace).href,
        workspaceFolders: [
          { uri: pathToFileURL(server.workspace).href, name: path.basename(server.workspace) },
        ],
        capabilities: clientCapabilities(),
        initializationOptions,
      },
      undefined,
      this.options.initializeTimeoutMs ?? 30_000,
    );
    if (server.connection.closed || this.disposed) return null;
    server.capabilities = result?.capabilities ?? {};
    if (server.capabilities.positionEncoding && server.capabilities.positionEncoding !== 'utf-16')
      throw new Error(`Unsupported position encoding: ${server.capabilities.positionEncoding}`);
    server.connection.notify('initialized', {});
    server.connection.notify('workspace/didChangeConfiguration', { settings });
    if (server.watchedChanges.size) {
      server.connection.notify('workspace/didChangeWatchedFiles', {
        changes: [...server.watchedChanges.values()],
      });
      server.watchedChanges.clear();
    }
    server.status = 'ready';
    server.message = server.spec.name;
    this.event({
      type: 'status',
      language: server.language,
      status: 'ready',
      message: server.spec.name,
      pid: server.connection.child.pid,
      capabilities: server.capabilities,
    });
    this.idle(server);
    return server;
  }

  receive(server, message, connection) {
    if (message.method === '$/progress' && message.params?.value?.kind === 'end') {
      this.refresh(server);
    } else if (message.method === 'textDocument/publishDiagnostics') {
      let absolute;
      try {
        absolute = fileURLToPath(message.params.uri);
      } catch {
        return;
      }
      if (!within(this.root, absolute)) return;
      const relative = path.relative(this.root, absolute);
      const document = this.documents.get(relative);
      if (!document || document.language !== server.language || !server.docs.has(relative)) return;
      const version = message.params.version;
      if (version !== undefined && version < document.version) return;
      this.event({
        type: 'diagnostics',
        language: server.language,
        path: relative,
        version,
        diagnostics: message.params.diagnostics ?? [],
      });
    } else if (message.id !== undefined) {
      let result = null;
      if (message.method === 'workspace/configuration') {
        result = (message.params?.items ?? []).map(item => {
          let value = server.spec.settings ?? {};
          for (const key of (item.section ?? '').split('.').filter(Boolean)) value = value?.[key];
          return value ?? null;
        });
      } else if (message.method === 'workspace/workspaceFolders')
        result = [
          { uri: pathToFileURL(server.workspace).href, name: path.basename(server.workspace) },
        ];
      else if (message.method === 'workspace/applyEdit')
        result = {
          applied: false,
          failureReason: 'Server-initiated workspace edits are not supported.',
        };
      else if (message.method === 'client/registerCapability') {
        for (const registration of message.params?.registrations ?? []) {
          const capability =
            feature[registration.method] ??
            (registration.method === 'textDocument/semanticTokens'
              ? 'semanticTokensProvider'
              : null);
          if (capability) server.capabilities[capability] = registration.registerOptions ?? true;
        }
        this.refresh(server);
      } else if (message.method.endsWith('/refresh')) this.refresh(server);
      else if (
        ![
          'client/unregisterCapability',
          'window/workDoneProgress/create',
          'window/showMessageRequest',
        ].includes(message.method)
      ) {
        connection.send({
          id: message.id,
          error: { code: -32601, message: 'Client method is not supported' },
        });
        return;
      }
      connection.send({ id: message.id, result });
    }
  }

  refresh(server) {
    this.event({ type: 'refresh', language: server.language });
    for (const relative of server.docs) this.scheduleDiagnostics(server, relative);
  }

  scheduleDiagnostics(server, relative) {
    if (!server.capabilities.diagnosticProvider || !server.docs.has(relative)) return;
    clearTimeout(server.diagnosticTimers.get(relative));
    server.diagnosticRequests.get(relative)?.abort();
    const timer = setTimeout(async () => {
      server.diagnosticTimers.delete(relative);
      const document = this.documents.get(relative);
      if (!document || !server.docs.has(relative)) return;
      const controller = new AbortController();
      server.diagnosticRequests.set(relative, controller);
      try {
        const result = await server.connection.request(
          'textDocument/diagnostic',
          {
            textDocument: { uri: document.uri },
            identifier: server.capabilities.diagnosticProvider.identifier,
          },
          controller.signal,
        );
        if (
          this.documents.get(relative) === document &&
          !controller.signal.aborted &&
          result?.kind === 'full'
        ) {
          this.event({
            type: 'diagnostics',
            language: server.language,
            path: relative,
            version: document.version,
            diagnostics: result.items ?? [],
          });
        }
      } catch {
        /* Canceled or failed pulls are retried when the document or server refreshes. */
      } finally {
        if (server.diagnosticRequests.get(relative) === controller)
          server.diagnosticRequests.delete(relative);
      }
    }, 60);
    timer.unref();
    server.diagnosticTimers.set(relative, timer);
  }

  async open({ path: relative, language, languageId = language, text, version = 1 }) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_DOCUMENT)
      throw new Error('Language document exceeds 2 MiB');
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Invalid language document version');
    const opening = {};
    this.openings.set(relative, opening);
    try {
      const { uri, absolute } = await this.documentPath(relative);
      const workspace = await this.projectRoot(absolute, language);
      if (this.openings.get(relative) !== opening) return { available: false, stale: true };
      const previous = this.documents.get(relative);
      if (previous && previous.language !== language) this.close(relative);
      const document = this.documents.get(relative);
      if (document && version < document.version) return { available: false, stale: true };
      const current = { uri, workspace, language, languageId, text, version };
      this.documents.set(relative, current);
      const server = await this.server(language, workspace);
      if (!server) return { available: false, capabilities: {} };
      if (this.documents.get(relative) !== current || this.servers.get(language) !== server)
        return { available: false, stale: true };
      clearTimeout(server.idle);
      if (!server.docs.has(relative)) {
        server.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version, text },
        });
        server.docs.add(relative);
      } else if (previous?.text !== text) {
        server.connection.notify('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      }
      this.scheduleDiagnostics(server, relative);
      return {
        available: true,
        workspace,
        capabilities: server.capabilities,
        legend: server.capabilities.semanticTokensProvider?.legend ?? null,
      };
    } finally {
      if (this.openings.get(relative) === opening) this.openings.delete(relative);
    }
  }

  async request({
    path: relative,
    language,
    method,
    params = {},
    text,
    version,
    requestId,
    signal,
  }) {
    if (!Object.hasOwn(feature, method)) throw new Error('Unsupported language feature request');
    let controller;
    if (requestId !== undefined) {
      this.cancel(requestId);
      controller = new AbortController();
      this.requests.set(requestId, controller);
    }
    const cancellation = controller?.signal ?? signal;
    try {
      if (cancellation?.aborted) return null;
      if (text !== undefined) await this.open({ path: relative, language, text, version });
      const document = this.documents.get(relative);
      if (
        cancellation?.aborted ||
        !document ||
        document.language !== language ||
        (version !== undefined && document.version !== version)
      )
        return null;
      const server = await this.server(language, document.workspace);
      if (cancellation?.aborted || !server) return null;
      if (!server.docs.has(relative)) await this.open({ path: relative, ...document });
      const supported = server.capabilities[feature[method]];
      if (
        !supported ||
        (method.endsWith('/range') && !supported.range) ||
        (method === 'textDocument/semanticTokens/full' && !supported.full)
      )
        return null;
      return await server.connection.request(
        method,
        { ...params, textDocument: { uri: document.uri } },
        cancellation,
      );
    } catch (error) {
      if ([-32601, -32800, -32801, -32802].includes(error.code) || error.name === 'AbortError')
        return null;
      throw error;
    } finally {
      if (controller && this.requests.get(requestId) === controller)
        this.requests.delete(requestId);
    }
  }

  changed(events) {
    if (this.disposed || !this.servers.size || !Array.isArray(events)) return;
    const changes = new Map();
    for (const event of events) {
      if (!event || typeof event.path !== 'string' || event.path.includes('\0')) continue;
      const absolute = path.resolve(this.root, event.path);
      const type = { create: 1, update: 2, delete: 3 }[event.type];
      if (!type || !within(this.root, absolute)) continue;
      changes.set(absolute, { uri: pathToFileURL(absolute).href, type });
      if (changes.size >= 4096) break;
    }
    for (const server of this.servers.values()) {
      if (!['ready', 'starting'].includes(server.status)) continue;
      const relevant = [...changes].filter(([absolute]) => within(server.workspace, absolute));
      if (server.status === 'ready') {
        if (relevant.length)
          server.connection.notify('workspace/didChangeWatchedFiles', {
            changes: relevant.map(([, change]) => change),
          });
      } else {
        for (const [absolute, change] of relevant) {
          server.watchedChanges.set(absolute, change);
          if (server.watchedChanges.size >= 4096) break;
        }
      }
    }
  }

  cancel(requestId) {
    this.requests.get(requestId)?.abort();
    this.requests.delete(requestId);
  }

  close(relative) {
    this.openings.delete(relative);
    const document = this.documents.get(relative);
    if (!document) return;
    this.documents.delete(relative);
    const server = this.servers.get(document.language);
    if (!server) return;
    const opened = server.docs.delete(relative);
    clearTimeout(server.diagnosticTimers.get(relative));
    server.diagnosticTimers.delete(relative);
    server.diagnosticRequests.get(relative)?.abort();
    server.diagnosticRequests.delete(relative);
    if (opened)
      server.connection.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
    this.event({
      type: 'diagnostics',
      language: document.language,
      path: relative,
      diagnostics: [],
    });
    this.idle(server);
  }

  idle(server) {
    if (server.docs.size || this.servers.get(server.language) !== server) return;
    clearTimeout(server.idle);
    server.idle = setTimeout(() => this.stop(server.language), this.options.idleMs ?? 15_000);
    server.idle.unref();
  }

  stop(language) {
    const server = this.servers.get(language);
    if (!server) return;
    clearTimeout(server.idle);
    this.servers.delete(language);
    for (const timer of server.diagnosticTimers.values()) clearTimeout(timer);
    for (const request of server.diagnosticRequests.values()) request.abort();
    for (const relative of server.docs)
      this.event({ type: 'diagnostics', language, path: relative, diagnostics: [] });
    this.event({
      type: 'status',
      language,
      status: 'available',
      message: 'Stopped while not in use',
    });
    const stopping = server.connection.dispose();
    this.stopping.add(stopping);
    void stopping.finally(() => this.stopping.delete(stopping));
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const requestId of this.requests.keys()) this.cancel(requestId);
    for (const language of this.servers.keys()) this.stop(language);
    this.documents.clear();
    this.openings.clear();
    await Promise.allSettled(this.stopping);
  }
}

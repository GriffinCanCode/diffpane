import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageRuntime } from './language.mjs';

const ANALYSIS_ARGS = [
  '--output',
  'json',
  '--no-interactive',
  '--no-cache',
  '--no-detect',
  '--threads',
  '2',
];
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_AUTOMATIC_COOLDOWN_MS = 60_000;
const MISSING_TOOL =
  'HowMany is unavailable. Reinstall Diffpane, or run npm run setup:howmany for source development.';

export function discoverHowMany(env = process.env) {
  if (env.DIFFPANE_HOWMANY_BINARY) return env.DIFFPANE_HOWMANY_BINARY;
  const bundled = fileURLToPath(new URL('../resources/howmany/howmany', import.meta.url)).replace(
    /\.asar([\\/])/,
    '.asar.unpacked$1',
  );
  try {
    accessSync(bundled, constants.X_OK);
    return bundled;
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
  ];
  for (const directory of directories) {
    const candidate = path.join(
      directory,
      process.platform === 'win32' ? 'howmany.exe' : 'howmany',
    );
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next location. */
    }
  }
  return null;
}

export function validateReport(report) {
  const basic = report?.basic;
  if (
    !basic ||
    ![
      'total_files',
      'total_lines',
      'code_lines',
      'doc_lines',
      'comment_lines',
      'blank_lines',
      'total_size',
    ].every(key => Number.isFinite(basic[key]) && basic[key] >= 0)
  )
    throw new Error('HowMany returned an invalid report');
  return report;
}

export function fileBreakdown(basic) {
  return [
    ['total_lines', 'lines'],
    ['code_lines', 'code'],
    ['doc_lines', 'doc'],
    ['comment_lines', 'comment'],
    ['blank_lines', 'blank'],
  ]
    .filter(([key], index) => index === 0 || basic[key] > 0)
    .map(([key, label]) => `${basic[key].toLocaleString()} ${label}`)
    .join(' · ');
}

/** One debounced workspace analysis and one active document, isolated from language services. */
export class HowManyRuntime {
  constructor(root, scope = root, onEvent = () => {}, options = {}) {
    this.root = root;
    this.scope = scope;
    this.onEvent = onEvent;
    this.options = options;
    this.command = options.command ?? discoverHowMany();
    this.state = { status: 'idle', report: null, message: '', updatedAt: null };
    this.processes = new Set();
    this.generation = 0;
    this.fileGeneration = 0;
    this.disposed = false;
    this.enabled = false;
    this.nextAutomaticAnalysisAt = 0;
    this.languages = this.createLanguages();
  }

  createLanguages() {
    return new LanguageRuntime(
      this.root,
      event => {
        if (event.type === 'process') this.onEvent({ type: 'process', ...event });
        else if (event.type === 'diagnostics') this.onEvent({ ...event, type: 'file' });
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
    );
  }

  publish(update) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    this.onEvent({ type: 'analysis', ...this.state });
  }

  run(args, signal) {
    if (this.disposed) return Promise.reject(new Error('HowMany is closed'));
    if (!this.command) return Promise.reject(new Error(MISSING_TOOL));
    if (signal?.aborted) return Promise.reject(new Error('Analysis canceled'));
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: this.scope,
        env: this.options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.processes.add(child);
      if (child.pid) this.onEvent({ type: 'process', status: 'started', pid: child.pid });
      const chunks = [];
      let size = 0;
      let stderr = '';
      let failure;
      const stop = error => {
        failure ??= error;
        this.kill(child);
      };
      const abort = () => stop(new Error('Analysis canceled'));
      const timer = setTimeout(
        () => stop(new Error('HowMany analysis timed out')),
        this.options.timeoutMs ?? 30_000,
      );
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_OUTPUT) stop(new Error('HowMany report exceeds 16 MiB'));
        else chunks.push(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      child.on('error', error => {
        failure = ['ENOENT', 'EACCES'].includes(error.code) ? new Error(MISSING_TOOL) : error;
      });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.processes.delete(child);
        if (child.pid) this.onEvent({ type: 'process', status: 'stopped', pid: child.pid });
        if (failure || code !== 0)
          reject(failure ?? new Error(stderr.trim() || `HowMany exited (${code})`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  }

  kill(child) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* Already exited. */
    }
  }

  analyze(force = false) {
    this.enabled = true;
    clearTimeout(this.timer);
    if (this.disposed) return Promise.resolve(this.state);
    if (this.analysis) return this.analysis;
    if (!force && this.state.status === 'ready' && this.analyzedGeneration === this.generation)
      return Promise.resolve(this.state);
    this.command = this.options.command ?? discoverHowMany();
    const generation = this.generation;
    const startedAt = performance.now();
    this.publish({ status: 'analyzing', message: '' });
    this.analysis = (async () => {
      try {
        const report = validateReport(JSON.parse(await this.run([this.scope, ...ANALYSIS_ARGS])));
        this.analyzedGeneration = generation;
        this.publish({ status: 'ready', report, updatedAt: Date.now(), message: '' });
      } catch (error) {
        this.publish({ status: 'error', message: error.message });
      } finally {
        // A large workspace must spend more time idle than counting. Repeated
        // saves (or watcher recovery) can otherwise keep a full scan running
        // continuously. Explicit refreshes still start immediately.
        const finishedAt = performance.now();
        this.nextAutomaticAnalysisAt =
          finishedAt + Math.min(MAX_AUTOMATIC_COOLDOWN_MS, (finishedAt - startedAt) * 4);
        this.analysis = null;
        if (!this.disposed && generation !== this.generation) this.schedule();
      }
      return this.state;
    })();
    return this.analysis;
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.enabled && !this.disposed)
      this.timer = setTimeout(
        () => void this.analyze(true),
        Math.max(this.options.debounceMs ?? 1200, this.nextAutomaticAnalysisAt - performance.now()),
      );
  }

  changed(paths) {
    if (this.disposed || !paths.length) return;
    this.generation++;
    this.schedule();
  }

  async configure() {
    const env = this.options.env ?? process.env;
    const home = env.HOME || homedir();
    const base =
      process.platform === 'darwin'
        ? path.join(home, 'Library/Application Support')
        : process.platform === 'win32'
          ? env.APPDATA || path.join(home, 'AppData/Roaming')
          : env.XDG_CONFIG_HOME || path.join(home, '.config');
    const config = await stat(path.join(base, 'howmany/config.toml')).catch(() => null);
    const command = this.options.command ?? discoverHowMany();
    const signature = `${command}:${config?.mtimeMs}:${config?.size}`;
    if (signature === this.configuration) return;
    this.configuration = signature;
    this.command = command;
    this.version = undefined;
    const previous = this.languages;
    this.languages = this.createLanguages();
    await previous.dispose();
  }

  async file(relative, text) {
    if (this.disposed) return null;
    this.closeFile();
    const generation = this.fileGeneration;
    await this.configure();
    if (generation !== this.fileGeneration || this.disposed) return null;
    const languages = this.languages;
    const { absolute } = await languages.documentPath(relative);
    if (generation !== this.fileGeneration || this.disposed) return null;
    this.activeFile = relative;
    this.fileAbort = new AbortController();
    const signal = this.fileAbort.signal;
    try {
      this.version ??= this.run(['--version'])
        .then(value => {
          const match = value.match(/howmany\s+(\d+)\.(\d+)/);
          return !!match && (+match[1] > 3 || (+match[1] === 3 && +match[2] >= 1));
        })
        .catch(() => false);
      const live = await this.version;
      if (signal.aborted) return null;
      if (live) {
        // Versions increase even though Diffpane only displays saved contents.
        const version = generation + 1;
        const result = await languages.open({ path: relative, language: 'howmany', text, version });
        if (signal.aborted) return null;
        if (!result.available) throw new Error('HowMany live counts unavailable');
        const lenses = await languages.request({
          path: relative,
          language: 'howmany',
          method: 'textDocument/codeLens',
          version,
          signal,
        });
        if (signal.aborted) return null;
        return { path: relative, title: lenses?.[0]?.command?.title ?? '', live: true };
      }
      const report = validateReport(
        JSON.parse(await this.run([absolute, ...ANALYSIS_ARGS], signal)),
      );
      if (signal.aborted) return null;
      return {
        path: relative,
        title: report.basic.total_files ? fileBreakdown(report.basic) : '',
        live: false,
      };
    } catch (error) {
      if (signal.aborted || this.disposed) return null;
      return { path: relative, title: '', message: error.message };
    }
  }

  closeFile(relative) {
    if (relative && relative !== this.activeFile) return;
    this.fileGeneration++;
    this.fileAbort?.abort();
    if (this.activeFile) this.languages.close(this.activeFile);
    this.activeFile = null;
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.closeFile();
    for (const child of this.processes) this.kill(child);
    await Promise.allSettled([this.analysis, this.languages.dispose()]);
  }
}

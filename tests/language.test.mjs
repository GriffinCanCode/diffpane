import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vite-plus/test';
import { FrameDecoder, LanguageRuntime, encodeMessage } from '../electron/language.mjs';
import { discoverServers } from '../electron/servers.ts';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for language server state');
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-language-')));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

// These are protocol bytes, not a substitute server; integration tests below run real servers.
test('LSP frames preserve UTF-8 across every split and coalesced message boundary', () => {
  const messages = [
    { jsonrpc: '2.0', id: 1, result: '雪☃ café' },
    { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { diagnostics: [] } },
  ];
  const bytes = Buffer.concat(messages.map(encodeMessage));
  for (let boundary = 1; boundary < bytes.length; boundary++) {
    const received = [];
    const decoder = new FrameDecoder(message => received.push(message));
    decoder.push(bytes.subarray(0, boundary));
    decoder.push(bytes.subarray(boundary));
    assert.deepEqual(received, messages, `Byte boundary ${boundary}`);
  }
  const received = [];
  const decoder = new FrameDecoder(message => received.push(message));
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(received, messages);
});

test('LSP frames reject invalid, duplicate, oversized, and unterminated headers', () => {
  for (const bytes of [
    'Content-Length: -1\r\n\r\n',
    'Content-Length: 2x\r\n\r\n',
    'Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
    'Content-Length: 0\r\n\r\n',
    'Content-Length: 16777217\r\n\r\n',
    'x'.repeat(16 * 1024 + 1),
    'Content-Length: 4\r\n\r\nnull',
    'Content-Length: 2\r\n\r\n[]',
    'Content-Length: 1\r\n\r\n{',
  ])
    assert.throws(
      () => new FrameDecoder(() => {}).push(Buffer.from(bytes)),
      undefined,
      bytes.slice(0, 80),
    );
  assert.throws(
    () =>
      new FrameDecoder(() => {}).push(
        Buffer.concat([
          Buffer.from('Content-Length: 5\r\n\r\n'),
          Buffer.from([34, 97, 255, 98, 34]),
        ]),
      ),
    /encoded data/,
  );
  const received = [];
  new FrameDecoder(message => received.push(message)).push(
    Buffer.from(
      'content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}',
    ),
  );
  assert.deepEqual(received, [{}]);
});

test('language discovery stays lazy and managed tools take precedence over PATH shims', async t => {
  const root = await fixture(t);
  const runtime = new LanguageRuntime(root);
  t.onTestFinished(() => runtime.dispose());
  assert.equal(runtime.servers.size, 0);
  assert.equal(runtime.status().length, 6);
  assert.ok(
    runtime
      .status()
      .every(server => server.pid === null && ['missing', 'available'].includes(server.status)),
  );
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'bin'));
  await symlink(process.execPath, path.join(root, 'bin', 'gopls'));
  const discovered = discoverServers({ toolsDir: root, moduleRoot: path.join(root, 'no-modules') });
  assert.equal(discovered.go.command, path.join(root, 'bin/gopls'));
  assert.deepEqual(discovered.go.args, ['serve']);
  assert.equal(discovered.elixir.env.ERL_FLAGS, process.env.ERL_FLAGS ?? '+S 2:2 +SDcpu 1 +SDio 1');
});

test('language document paths and input sizes are confined before starting a server', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(path.join(outside, 'secret.py'), 'secret = 42\n');
  await symlink(path.join(outside, 'secret.py'), path.join(root, 'link.py'));
  const runtime = new LanguageRuntime(root);
  t.onTestFinished(() => runtime.dispose());
  for (const file of [
    '../secret.py',
    '/absolute.py',
    'folder/../secret.py',
    'nul\0.py',
    'link.py',
  ]) {
    await assert.rejects(
      runtime.open({ path: file, language: 'python', text: '', version: 1 }),
      /outside|Invalid/,
    );
  }
  await assert.rejects(
    runtime.open({ path: 'a.py', language: 'python', text: 'x'.repeat(2 * 1024 * 1024 + 1) }),
    /2 MiB/,
  );
  await assert.rejects(
    runtime.request({ path: 'a.py', language: 'python', method: 'workspace/executeCommand' }),
    /Unsupported/,
  );
  assert.equal(runtime.servers.size, 0);
});

const discovered = discoverServers();
for (const [language, filename, text, hover] of /** @type {const} */ ([
  [
    'python',
    'example.py',
    'total = len("hello")\n\ndef greet(name: str) -> str:\n    return name\n\nwrong: int = "not an integer"\n',
    { line: 2, character: 5 },
  ],
  [
    'typescript',
    'example.ts',
    'const total = 1 + 2;\n\nfunction greet(name: string): string {\n  return name;\n}\n\nconst wrong: number = "not a number";\n',
    { line: 2, character: 10 },
  ],
])) {
  test(
    `real ${language} server supplies symbols, hover, colors, hints and diagnostics and stops when idle`,
    { skip: !discovered[language].command, timeout: 60_000 },
    async t => {
      const root = await fixture(t);
      await writeFile(path.join(root, filename), text);
      const events = [];
      const runtime = new LanguageRuntime(root, event => events.push(event), { idleMs: 80 });
      t.onTestFinished(() => runtime.dispose());
      assert.equal(runtime.servers.size, 0);
      const opened = await runtime.open({ path: filename, language, text, version: 1 });
      assert.equal(opened.available, true, JSON.stringify(events));
      const ask = (method, params = {}, extra = {}) =>
        runtime.request({ path: filename, language, method, params, ...extra });
      const symbols = await ask('textDocument/documentSymbol');
      assert.ok(
        symbols?.some(symbol => symbol.name === 'greet'),
        JSON.stringify(symbols),
      );
      const hoverResult = await ask('textDocument/hover', { position: hover });
      assert.ok(hoverResult?.contents, JSON.stringify(hoverResult));
      const colors = await ask('textDocument/semanticTokens/full');
      if (opened.capabilities.semanticTokensProvider?.full) assert.ok(colors?.data?.length > 0);
      const hints = await ask('textDocument/inlayHint', {
        range: { start: { line: 0, character: 0 }, end: { line: 7, character: 0 } },
      });
      if (opened.capabilities.inlayHintProvider)
        assert.ok(hints?.length > 0, JSON.stringify(hints));
      await until(
        () =>
          events.some(
            event =>
              event.type === 'diagnostics' &&
              event.path === filename &&
              event.diagnostics.some(diagnostic => diagnostic.severity === 1),
          ),
        25_000,
      );
      const updated = text.replace(
        language === 'python' ? '"not an integer"' : '"not a number"',
        '42',
      );
      await runtime.open({ path: filename, language, text: updated, version: 2 });
      await until(
        () =>
          events.some(
            event =>
              event.type === 'diagnostics' &&
              event.path === filename &&
              (event.version === undefined || event.version === 2) &&
              event.diagnostics.every(diagnostic => diagnostic.severity !== 1),
          ),
        25_000,
      );
      assert.equal(
        (await runtime.open({ path: filename, language, text, version: 1 })).stale,
        true,
      );
      assert.equal(await ask('textDocument/hover', { position: hover }, { version: 1 }), null);
      const controller = new AbortController();
      controller.abort();
      assert.equal(
        await ask('textDocument/hover', { position: hover }, { signal: controller.signal }),
        null,
      );
      const pid = runtime.status().find(server => server.language === language).pid;
      assert.ok(pid > 0);
      runtime.close(filename);
      await until(() => runtime.servers.size === 0);
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(runtime.documents.size, 0);
    },
  );
}

test(
  'closing a document during real server initialization releases the empty process',
  { skip: !discovered.python.command, timeout: 40_000 },
  async t => {
    const root = await fixture(t);
    await writeFile(path.join(root, 'a.py'), 'answer = 42\n');
    const runtime = new LanguageRuntime(root, () => {}, { idleMs: 100 });
    t.onTestFinished(() => runtime.dispose());
    const opening = runtime.open({ path: 'a.py', language: 'python', text: 'answer = 42\n' });
    await until(() => runtime.servers.has('python'));
    const pid = runtime.status().find(server => server.language === 'python').pid;
    runtime.close('a.py');
    assert.equal((await opening).available, false);
    await until(() => runtime.servers.size === 0);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  },
);

test(
  'a real crashed server recovers on the next request and early cancellation stays canceled',
  { skip: !discovered.python.command, timeout: 40_000 },
  async t => {
    const root = await fixture(t);
    const text = 'def greet(name: str) -> str:\n    return name\n';
    await writeFile(path.join(root, 'a.py'), text);
    const runtime = new LanguageRuntime(root, () => {}, { retryMs: 0 });
    t.onTestFinished(() => runtime.dispose());
    await runtime.open({ path: 'a.py', language: 'python', text });
    const pid = runtime.status().find(server => server.language === 'python').pid;
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
    await until(
      () => runtime.status().find(server => server.language === 'python').status === 'error',
    );
    const request = runtime.request({
      path: 'a.py',
      language: 'python',
      method: 'textDocument/hover',
      params: { position: { line: 0, character: 5 } },
      requestId: 'canceled-before-initialize',
    });
    runtime.cancel('canceled-before-initialize');
    assert.equal(await request, null);
    const result = await runtime.request({
      path: 'a.py',
      language: 'python',
      method: 'textDocument/hover',
      params: { position: { line: 0, character: 5 } },
    });
    assert.ok(result?.contents);
    assert.notEqual(runtime.status().find(server => server.language === 'python').pid, pid);
  },
);

test('manifest discovery selects the nearest real project without escaping the opened directory', async t => {
  const root = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'outer/inner/src'), { recursive: true });
  await writeFile(path.join(root, 'outer/Cargo.toml'), '[workspace]\n');
  await writeFile(
    path.join(root, 'outer/inner/Cargo.toml'),
    '[package]\nname="inner"\nversion="0.1.0"\n',
  );
  await writeFile(path.join(root, 'outer/inner/go.mod'), 'module example.com/inner\n');
  await writeFile(path.join(root, 'outer/inner/src/file.rs'), 'fn main() {}\n');
  const runtime = new LanguageRuntime(root);
  t.onTestFinished(() => runtime.dispose());
  for (const language of ['rust', 'go'])
    assert.equal(
      await runtime.projectRoot(path.join(root, 'outer/inner/src/file.rs'), language),
      path.join(root, 'outer/inner'),
    );
  assert.equal(
    await runtime.projectRoot(path.join(root, 'outer/inner/src/file.rs'), 'swift'),
    root,
  );
  assert.equal(runtime.servers.size, 0);
});

test(
  'closing during path validation cannot resurrect a language document',
  { skip: !discovered.python.command },
  async t => {
    const root = await fixture(t);
    await writeFile(path.join(root, 'a.py'), 'answer = 42\n');
    const runtime = new LanguageRuntime(root);
    t.onTestFinished(() => runtime.dispose());
    const opening = runtime.open({ path: 'a.py', language: 'python', text: 'answer = 42\n' });
    runtime.close('a.py');
    assert.equal((await opening).stale, true);
    assert.equal(runtime.documents.size, 0);
    assert.equal(runtime.servers.size, 0);
  },
);

test(
  'server LRU eviction enforces the process cap and transparently reopens real documents',
  { skip: !discovered.python.command || !discovered.typescript.command, timeout: 40_000 },
  async t => {
    const root = await fixture(t);
    const python = 'def greet(name: str) -> str:\n    return name\n';
    const typescript = 'function greet(name: string): string { return name; }\n';
    await writeFile(path.join(root, 'a.py'), python);
    await writeFile(path.join(root, 'a.ts'), typescript);
    const events = [];
    const runtime = new LanguageRuntime(root, event => events.push(event), { maxServers: 1 });
    t.onTestFinished(() => runtime.dispose());
    await runtime.open({ path: 'a.py', language: 'python', text: python });
    const first = runtime.status().find(server => server.language === 'python').pid;
    await runtime.open({ path: 'a.ts', language: 'typescript', text: typescript });
    await Promise.allSettled(runtime.stopping);
    assert.equal(runtime.servers.size, 1);
    assert.ok(runtime.servers.has('typescript'));
    assert.throws(() => process.kill(first, 0));
    const symbols = await runtime.request({
      path: 'a.py',
      language: 'python',
      method: 'textDocument/documentSymbol',
    });
    assert.ok(symbols.some(symbol => symbol.name === 'greet'));
    assert.equal(runtime.servers.size, 1);
    assert.ok(runtime.servers.has('python'));
    await runtime.dispose();
    const started = events
      .filter(event => event.type === 'process' && event.status === 'started')
      .map(event => event.pid);
    const stopped = events
      .filter(event => event.type === 'process' && event.status === 'stopped')
      .map(event => event.pid);
    assert.equal(started.length, 3);
    assert.deepEqual(
      started.sort((a, b) => a - b),
      stopped.sort((a, b) => a - b),
    );
  },
);

test('bundled JavaScript servers resolve to unpacked paths for subprocess workers', async t => {
  const root = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  const moduleRoot = path.join(root, 'app.asar/node_modules');
  const physical = path.join(root, 'app.asar.unpacked/node_modules');
  await mkdir(path.join(physical, 'basedpyright/dist'), { recursive: true });
  await mkdir(path.join(physical, 'typescript-language-server/lib'), { recursive: true });
  await writeFile(path.join(physical, 'basedpyright/dist/pyright-langserver.js'), '');
  await writeFile(path.join(physical, 'typescript-language-server/lib/cli.mjs'), '');
  const specs = discoverServers({ moduleRoot });
  assert.equal(
    specs.python.args[0],
    path.join(physical, 'basedpyright/dist/pyright-langserver.js'),
  );
  assert.equal(
    specs.typescript.args[0],
    path.join(physical, 'typescript-language-server/lib/cli.mjs'),
  );
  assert.equal(specs.python.env.ELECTRON_RUN_AS_NODE, '1');
});

test(
  'real Python diagnostics refresh when an imported file changes outside the visible document',
  { skip: !discovered.python.command, timeout: 40_000 },
  async t => {
    const root = await fixture(t);
    await writeFile(path.join(root, 'source.py'), 'value: int = 42\n');
    const text = 'from source import value\nanswer: int = value\n';
    await writeFile(path.join(root, 'a.py'), text);
    const events = [];
    const runtime = new LanguageRuntime(root, event => events.push(event));
    t.onTestFinished(() => runtime.dispose());
    await runtime.open({ path: 'a.py', language: 'python', text });
    await until(() => events.some(event => event.type === 'diagnostics' && event.path === 'a.py'));
    assert.ok(
      events
        .filter(event => event.type === 'diagnostics')
        .every(event => event.diagnostics.every(diagnostic => diagnostic.severity !== 1)),
    );
    await writeFile(path.join(root, 'source.py'), 'value: str = "changed"\n');
    runtime.changed([{ path: path.join(root, 'source.py'), type: 'update' }]);
    await until(
      () =>
        events.some(
          event =>
            event.type === 'diagnostics' &&
            event.path === 'a.py' &&
            event.diagnostics.some(diagnostic => diagnostic.severity === 1),
        ),
      25_000,
    );
    assert.equal(runtime.documents.size, 1);
  },
);

test(
  'a stalled real server times out and cancels requests without poisoning later responses',
  { skip: !discovered.python.command || process.platform === 'win32', timeout: 40_000 },
  async t => {
    const root = await fixture(t);
    const text = 'def greet(name: str) -> str:\n    return name\n';
    await writeFile(path.join(root, 'a.py'), text);
    const runtime = new LanguageRuntime(root, () => {}, { requestTimeoutMs: 120 });
    t.onTestFinished(() => runtime.dispose());
    assert.equal((await runtime.open({ path: 'a.py', language: 'python', text })).available, true);
    const server = runtime.servers.get('python');
    const pid = server.connection.child.pid;
    const ask = extra =>
      runtime.request({
        path: 'a.py',
        language: 'python',
        method: 'textDocument/hover',
        params: { position: { line: 0, character: 5 } },
        ...extra,
      });
    process.kill(-pid, 'SIGSTOP');
    try {
      await assert.rejects(ask(), /timed out/);
      const canceled = ask({ requestId: 'stalled' });
      await until(() => runtime.requests.has('stalled'), 1000);
      runtime.cancel('stalled');
      assert.equal(await canceled, null);
      assert.ok(
        server.connection.pending.size <= 1,
        'Only a concurrent diagnostic pull may remain',
      );
    } finally {
      process.kill(-pid, 'SIGCONT');
    }
    server.connection.timeoutMs = 12_000;
    const result = await ask();
    assert.ok(result?.contents);
  },
);

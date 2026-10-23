import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath, symlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HowManyRuntime, discoverHowMany } from '../electron/howmany.mjs';
import { verifyHowManySource } from '../setup-howmany.ts';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for HowMany');
}
async function fixture(t, { wait = 0, output = 'valid' } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-')));
  const command = path.join(root, 'howmany-fixture');
  // Protocol boundary fixture: check argument passing, subprocess ownership and retry behavior.
  await writeFile(
    command,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('howmany 3.0.0'); process.exit(0); }
if (args.includes('lsp')) process.exit(99);
if (!args.includes('--no-cache') || !args.includes('--no-interactive')) process.exit(98);
setTimeout(() => {
  if (${JSON.stringify(output)} === 'invalid') { console.log('{}'); return; }
  const basic = { total_files: 1, total_lines: 4, code_lines: 2, comment_lines: 1, doc_lines: 0, blank_lines: 1, total_size: 50, stats_by_extension: {} };
  console.log(JSON.stringify({basic, metadata:{version:'3.0.0'}}));
}, ${wait});
`,
    { mode: 0o755 },
  );
  const events = [];
  const runtime = new HowManyRuntime(root, root, event => events.push(event), {
    command,
    debounceMs: 30,
    timeoutMs: 5000,
  });
  t.onTestFinished(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'name with spaces;echo.js'), '// comment\nconst a = 1;\n\na;\n');
  return { root, command, runtime, events };
}

test('workspace analysis coalesces calls and catches saves arriving during an analysis', async t => {
  const { runtime, events } = await fixture(t, { wait: 150 });
  assert.equal(events.length, 0, 'constructing the runtime starts no processes');
  const first = runtime.analyze();
  assert.equal(runtime.analyze(), first);
  runtime.changed(['a.js']);
  runtime.changed(['b.js']);
  assert.equal((await first).status, 'ready');
  await until(() => events.filter(event => event.status === 'ready').length === 2);
  assert.equal(
    events.filter(event => event.type === 'process' && event.status === 'started').length,
    2,
  );
  const previous = events.length;
  await runtime.analyze();
  assert.equal(events.length, previous, 'unchanged reports reuse the result');
});

test('expensive workspace scans leave an idle interval while explicit refresh stays immediate', async t => {
  const { runtime, events } = await fixture(t, { wait: 150 });
  await runtime.analyze();
  const report = runtime.state.report;
  const started = () =>
    events.filter(event => event.type === 'process' && event.status === 'started').length;

  runtime.changed(['a.js']);
  runtime.changed(['b.js']);
  await delay(150);
  assert.equal(started(), 1, 'saves must not immediately restart an expensive full scan');
  assert.equal(runtime.state.report, report, 'the previous report remains available');

  const manual = runtime.analyze(true);
  assert.equal(started(), 2, 'an explicit refresh bypasses the automatic cooldown');
  await manual;
  runtime.changed(['c.js']);
  await until(() => events.filter(event => event.status === 'ready').length === 3);
  assert.equal(started(), 3, 'pending saves eventually receive one fresh report');
});

test('timed-out workspace scans also back off before retrying automatically', async t => {
  const { runtime, events } = await fixture(t, { wait: 30_000 });
  runtime.options.timeoutMs = 100;
  assert.match((await runtime.analyze()).message, /timed out/);
  runtime.changed(['a.js']);
  await delay(150);
  assert.equal(
    events.filter(event => event.type === 'process' && event.status === 'started').length,
    1,
    'an analysis that times out must not become a tight retry loop',
  );
});

test('older CLI counts files with literal argument paths and never launches its missing LSP', async t => {
  const { runtime } = await fixture(t);
  const result = await runtime.file('name with spaces;echo.js', '');
  assert.equal(result.live, false);
  assert.equal(result.title, '4 lines · 2 code · 1 comment · 1 blank');
  assert.equal(runtime.languages.servers.size, 0);
});

test('file requests reject traversal and symlink escapes before launching HowMany', async t => {
  const { root, runtime, events } = await fixture(t);
  await symlink('/etc/hosts', path.join(root, 'outside.js'));
  for (const filename of ['../secret.js', '/etc/hosts', 'outside.js', 'nul\0.js'])
    await assert.rejects(runtime.file(filename, ''), /Invalid|outside/);
  assert.equal(events.length, 0);
});

test('invalid reports and missing tools produce recoverable analysis errors', async t => {
  const { runtime, root } = await fixture(t, { output: 'invalid' });
  assert.match((await runtime.analyze()).message, /invalid report/);
  runtime.options.command = path.join(root, 'missing');
  const state = await runtime.analyze(true);
  assert.equal(state.status, 'error');
  assert.equal(state.report, null);
  assert.equal(runtime.processes.size, 0);
});

test('timeouts and disposal terminate owned analysis processes', async t => {
  const { runtime, events } = await fixture(t, { wait: 30_000 });
  runtime.options.timeoutMs = 100;
  assert.match((await runtime.analyze()).message, /timed out/);
  runtime.options.timeoutMs = 30_000;
  const pending = runtime.analyze(true);
  await until(() => runtime.processes.size > 0);
  await runtime.dispose();
  await pending;
  assert.equal(runtime.processes.size, 0);
  assert.equal(
    events.filter(event => event.type === 'process' && event.status === 'started').length,
    events.filter(event => event.type === 'process' && event.status === 'stopped').length,
  );
});

test('bundling rejects a changed source archive before compilation', () => {
  assert.throws(() => verifyHowManySource(Buffer.from('changed source')), /checksum mismatch/);
});

const bundled = new URL('../resources/howmany/howmany', import.meta.url);
test.skipIf(!existsSync(bundled))(
  'bundled HowMany produces real counts, thresholds, config reloads and shuts down its LSP',
  async t => {
    const { root } = await fixture(t);
    const events = [];
    const runtime = new HowManyRuntime(root, root, event => events.push(event), {
      command: bundled.pathname,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, '.config'),
        APPDATA: path.join(root, 'AppData'),
      },
    });
    t.onTestFinished(() => runtime.dispose());
    const config = path.join(
      root,
      process.platform === 'darwin'
        ? 'Library/Application Support/howmany/config.toml'
        : process.platform === 'win32'
          ? 'AppData/howmany/config.toml'
          : '.config/howmany/config.toml',
    );
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, '[lsp]\nmax_file_lines = 2\nmin_doc_ratio = 0\n');
    const filename = 'sample.py';
    const text = '# explanation\nx = 1\n\nprint(x)\n';
    await writeFile(path.join(root, filename), text);
    const counts = await runtime.file(filename, text);
    assert.equal(counts.live, true);
    assert.match(counts.title, /4 Python.*2 code.*1 comment.*1 blank/);
    await until(() =>
      events.some(
        event => event.type === 'file' && event.diagnostics.some(item => item.code === 'long-file'),
      ),
    );
    const report = await runtime.analyze();
    assert.equal(report.status, 'ready');
    assert.ok(report.report.basic.total_lines >= 4);
    const changed = '# explanation\nx = 1\n';
    await writeFile(path.join(root, filename), changed);
    assert.match((await runtime.file(filename, changed)).title, /2 Python.*1 code.*1 comment/);
    await writeFile(config, '[lsp]\ncode_lens = false\nmax_file_lines = 0\nmin_doc_ratio = 0\n');
    assert.equal(
      (await runtime.file(filename, await readFile(path.join(root, filename), 'utf8'))).title,
      '',
    );
    await runtime.dispose();
    assert.equal(runtime.languages.servers.size, 0);
    assert.equal(runtime.processes.size, 0);
    assert.ok(discoverHowMany({ PATH: '' }).includes('resources/howmany/howmany'));
  },
);

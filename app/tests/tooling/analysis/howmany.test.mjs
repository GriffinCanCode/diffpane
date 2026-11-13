import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, mkdir, rm, realpath, symlink, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test, vi } from 'vite-plus/test'
import { HowManyRuntime, discoverHowMany, validateReport } from '../../../electron/tools/analysis/howmany.mjs'
import { verifyHowManySource } from '../../../tooling/dependencies/setup-howmany.ts'

/**
 * @import { TestContext } from 'vite-plus/test'
 * @import { HowManyEvent } from '../../../electron/tools/analysis/howmany.mjs'
 */

/** @param {() => boolean} predicate */
async function until(predicate) {
  await vi.waitFor(() => assert.equal(predicate(), true, 'Timed out waiting for HowMany'), {
    interval: 20,
    timeout: 10_000,
  })
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function diagnostics(value) {
  if (!Array.isArray(value)) throw new Error('Expected HowMany diagnostics')
  return value.map((/** @type {unknown} */ item) => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid HowMany diagnostic')
    return { ...item }
  })
}
function sourceReport() {
  const source = {
    file_count: 1,
    total_lines: 4,
    code_lines: 2,
    comment_lines: 1,
    doc_lines: 0,
    blank_lines: 1,
    total_size: 50,
  }
  const { file_count, ...counts } = source
  /** @type {import('../../../electron/tools/analysis/howmany.mjs').BreakdownRow[]} */
  const rows = [{ ...source, language: 'JavaScript', category: 'code' }]
  return {
    basic: { ...counts, total_files: file_count, stats_by_extension: {} },
    source,
    breakdown: { rows },
    metadata: { version: '3.1.0' },
  }
}

/** @param {TestContext} t @param {{ wait?: number, output?: string, version?: string }} [options] */
async function fixture(t, { wait = 0, output = 'valid', version = '3.1.0' } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-')))
  const command = path.join(root, 'howmany-fixture')
  const source = sourceReport()
  source.metadata.version = version
  const report = version === '3.0.0' ? { basic: source.basic, metadata: source.metadata } : source
  // Protocol boundary fixture: check argument passing, subprocess ownership and retry behavior.
  await writeFile(
    command,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(`howmany ${version}`)}); process.exit(0); }
if (args.includes('lsp')) process.exit(99);
if (!args.includes('--no-cache') || !args.includes('--no-interactive')) process.exit(98);
setTimeout(() => {
  if (${JSON.stringify(output)} === 'invalid') { console.log('{}'); return; }
  console.log(${JSON.stringify(JSON.stringify(report))});
}, ${wait});
`,
    { mode: 0o755 },
  )
  /** @type {HowManyEvent[]} */
  const events = []
  const runtime = new HowManyRuntime(root, root, event => events.push(event), {
    command,
    debounceMs: 30,
    timeoutMs: 5000,
  })
  t.onTestFinished(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(path.join(root, 'name with spaces;echo.js'), '// comment\nconst a = 1;\n\na;\n')
  return { root, command, runtime, events }
}

test(
  'workspace analysis coalesces calls and catches saves arriving during an analysis',
  { timeout: 15_000 },
  async t => {
    const { runtime, events } = await fixture(t, { wait: 150 })
    assert.equal(events.length, 0, 'constructing the runtime starts no processes')
    const first = runtime.analyze()
    assert.equal(runtime.analyze(), first)
    runtime.changed(['a.js'])
    runtime.changed(['b.js'])
    assert.equal((await first).status, 'ready')
    await until(() => events.filter(event => event.type === 'analysis' && event.status === 'ready').length === 2)
    assert.equal(events.filter(event => event.type === 'process' && event.status === 'started').length, 2)
    const previous = events.length
    await runtime.analyze()
    assert.equal(events.length, previous, 'unchanged reports reuse the result')
  },
)

test('expensive workspace scans leave an idle interval while explicit refresh stays immediate', async t => {
  const { runtime, events } = await fixture(t, { wait: 150 })
  await runtime.analyze()
  const report = runtime.state.report
  const started = () => events.filter(event => event.type === 'process' && event.status === 'started').length

  runtime.changed(['a.js'])
  runtime.changed(['b.js'])
  await delay(150)
  assert.equal(started(), 1, 'saves must not immediately restart an expensive full scan')
  assert.equal(runtime.state.report, report, 'the previous report remains available')

  const manual = runtime.analyze(true)
  assert.equal(started(), 2, 'an explicit refresh bypasses the automatic cooldown')
  await manual
  runtime.changed(['c.js'])
  await until(() => events.filter(event => event.type === 'analysis' && event.status === 'ready').length === 3)
  assert.equal(started(), 3, 'pending saves eventually receive one fresh report')
})

test('timed-out workspace scans also back off before retrying automatically', async t => {
  const { runtime, events } = await fixture(t, { wait: 30_000 })
  runtime.options.timeoutMs = 100
  assert.match((await runtime.analyze()).message, /timed out/)
  runtime.changed(['a.js'])
  await delay(150)
  assert.equal(
    events.filter(event => event.type === 'process' && event.status === 'started').length,
    1,
    'an analysis that times out must not become a tight retry loop',
  )
})

test('older CLI counts files with literal argument paths and never launches its missing LSP', async t => {
  const { runtime } = await fixture(t, { version: '3.0.0' })
  const result = await runtime.file('name with spaces;echo.js', async () => '', 'literal-path')
  assert.equal(result?.live, false)
  assert.equal(result?.title, '4 lines · 2 code · 1 comment · 1 blank')
  assert.equal(runtime.languages.servers.size, 0)
})

test('file counts fall back to the CLI when an advertised live server cannot start', async t => {
  const { runtime } = await fixture(t)
  const result = await runtime.file('name with spaces;echo.js', async () => '', 'failed-server')

  assert.equal(result?.live, false)
  assert.equal(result?.title, '4 lines · 2 code · 1 comment · 1 blank')
  assert.equal(runtime.languages.documents.size, 0)
})

test('workspace reports require source totals instead of relabeling older all-content totals', async t => {
  const { runtime } = await fixture(t, { version: '3.0.0' })
  const state = await runtime.analyze()
  assert.equal(state.status, 'error')
  assert.equal(state.report, null)
  assert.match(state.message, /source totals are unavailable/)
})

test('report validation keeps data outside source totals and rejects inconsistent counts', () => {
  const report = sourceReport()
  const data = {
    language: 'JSON',
    category: /** @type {const} */ ('data'),
    file_count: 1,
    total_lines: 100,
    code_lines: 100,
    comment_lines: 0,
    doc_lines: 0,
    blank_lines: 0,
    total_size: 1000,
  }
  report.breakdown.rows.push(data)
  report.basic.total_files += data.file_count
  report.basic.total_lines += data.total_lines
  report.basic.code_lines += data.code_lines
  report.basic.total_size += data.total_size
  assert.equal(validateReport(report), report)
  assert.equal(report.source.code_lines, 2)
  assert.equal(report.basic.code_lines, 102)

  const [sourceRow, dataRow] = report.breakdown.rows
  assert.ok(sourceRow && dataRow)
  const invalidReports = [
    { ...report, source: { ...report.source, code_lines: -1 } },
    { ...report, source: { ...report.source, file_count: 1.5 } },
    { ...report, source: { ...report.source, total_size: Infinity } },
    { ...report, source: { ...report.source, file_count: 2 } },
    { ...report, basic: { ...report.basic, total_lines: report.basic.total_lines + 1 } },
    { ...report, breakdown: { rows: [{ ...sourceRow, language: null }, dataRow] } },
    { ...report, breakdown: { rows: [{ ...sourceRow, category: 'unknown' }, dataRow] } },
    { ...report, breakdown: { rows: [sourceRow, { ...dataRow, file_count: 2 }] } },
    { ...report, breakdown: { rows: null } },
  ]
  for (const invalid of invalidReports) {
    assert.throws(() => validateReport(invalid), /invalid report/)
  }
})

for (const filename of ['../secret.js', '/etc/hosts', 'outside.js', 'nul\0.js']) {
  test(`file requests reject the invalid path ${JSON.stringify(filename)} before launching HowMany`, async t => {
    const { root, runtime, events } = await fixture(t)
    await symlink('/etc/hosts', path.join(root, 'outside.js'))
    await assert.rejects(
      runtime.file(filename, async () => '', 'invalid-path'),
      /Invalid|outside/,
    )
    assert.equal(events.length, 0)
  })
}

test('a slow file read cannot supersede a later count or reopen a closed document', async t => {
  const { runtime, root, events } = await fixture(t, { version: '3.0.0' })
  const first = 'name with spaces;echo.js'
  const second = 'second.js'
  await writeFile(path.join(root, second), 'const b = 2;\n')

  await [first, second].reduce(async (previous, latest) => {
    await previous
    /** @type {PromiseWithResolvers<string>} */
    const read = Promise.withResolvers()
    const slow = runtime.file(first, () => read.promise, 'older')
    assert.equal((await runtime.file(latest, async () => '', 'latest'))?.path, latest)
    const before = events.length
    read.resolve('old contents')
    assert.equal(await slow, null)
    assert.equal(runtime.activeFile, latest)
    assert.equal(events.length, before, 'obsolete reads must not start HowMany')
  }, Promise.resolve())

  /** @type {PromiseWithResolvers<string>} */
  const read = Promise.withResolvers()
  const closing = runtime.file(first, () => read.promise, 'closing')
  runtime.closeFile(first)
  read.resolve('closed contents')
  assert.equal(await closing, null)
  assert.equal(runtime.activeFile, null)
})

test('invalid reports and missing tools produce recoverable analysis errors', async t => {
  const { runtime, root } = await fixture(t, { output: 'invalid' })
  assert.match((await runtime.analyze()).message, /invalid report/)
  runtime.options.command = path.join(root, 'missing')
  const state = await runtime.analyze(true)
  assert.equal(state.status, 'error')
  assert.equal(state.report, null)
  assert.equal(runtime.processes.size, 0)
})

test('timeouts and disposal terminate owned analysis processes', async t => {
  const { runtime, events } = await fixture(t, { wait: 30_000 })
  runtime.options.timeoutMs = 100
  assert.match((await runtime.analyze()).message, /timed out/)
  runtime.options.timeoutMs = 30_000
  const pending = runtime.analyze(true)
  await until(() => runtime.processes.size > 0)
  await runtime.dispose()
  await pending
  assert.equal(runtime.processes.size, 0)
  assert.equal(
    events.filter(event => event.type === 'process' && event.status === 'started').length,
    events.filter(event => event.type === 'process' && event.status === 'stopped').length,
  )
})

test('shutdown waits for a language runtime being replaced by a config reload', async t => {
  const { runtime } = await fixture(t)
  /** @type {PromiseWithResolvers<void>} */
  const retired = Promise.withResolvers()
  const previous = runtime.languages
  vi.spyOn(previous, 'dispose').mockReturnValueOnce(retired.promise)
  const configuration = runtime.configure(new AbortController().signal)
  await vi.waitFor(() => assert.notEqual(runtime.languages, previous))

  const shutdown = runtime.dispose()
  const repeated = runtime.dispose()
  const firstFinished = vi.fn()
  const secondFinished = vi.fn()
  const observed = [shutdown.then(firstFinished), repeated.then(secondFinished)]
  await delay(0)
  const finishedEarly = [firstFinished.mock.calls.length, secondFinished.mock.calls.length]
  retired.resolve()
  await Promise.all([configuration, ...observed])

  assert.deepEqual(finishedEarly, [0, 0])
})

test('bundling rejects a changed source archive before compilation', () => {
  assert.throws(() => verifyHowManySource(Buffer.from('changed source')), /checksum mismatch/)
})

const bundled = new URL('../../../../resources/howmany/howmany', import.meta.url)
test.skipIf(!existsSync(bundled))(
  'bundled HowMany produces real counts, thresholds, config reloads and shuts down its LSP',
  async t => {
    const { root } = await fixture(t)
    /** @type {HowManyEvent[]} */
    const events = []
    const runtime = new HowManyRuntime(root, root, event => events.push(event), {
      command: bundled.pathname,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, '.config'),
        APPDATA: path.join(root, 'AppData'),
      },
    })
    t.onTestFinished(() => runtime.dispose())
    const config = path.join(
      root,
      process.platform === 'darwin'
        ? 'Library/Application Support/howmany/config.toml'
        : process.platform === 'win32'
          ? 'AppData/howmany/config.toml'
          : '.config/howmany/config.toml',
    )
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(config, '[lsp]\nmax_file_lines = 2\nmin_doc_ratio = 0\n')
    const filename = 'sample.py'
    const text = '# explanation\nx = 1\n\nprint(x)\n'
    await writeFile(path.join(root, filename), text)
    const counts = await runtime.file(filename, async () => text, 'initial')
    assert.equal(counts?.live, true)
    assert.match(counts?.title ?? '', /4 Python.*2 code.*1 comment.*1 blank/)
    await until(() =>
      events.some(
        event => event.type === 'file' && diagnostics(event.diagnostics).some(item => item.code === 'long-file'),
      ),
    )
    const report = await runtime.analyze()
    assert.equal(report.status, 'ready')
    assert.ok(report.report && report.report.basic.total_lines >= 4)
    const longer = `${text}print(x + 1)\n`
    await writeFile(path.join(root, filename), longer)
    const beforeLonger = events.length
    assert.match((await runtime.file(filename, async () => longer, 'longer'))?.title ?? '', /5 Python/)
    await until(() =>
      events
        .slice(beforeLonger)
        .some(
          event =>
            event.type === 'file' &&
            diagnostics(event.diagnostics).some(
              item => item.code === 'long-file' && typeof item.message === 'string' && /5 lines/.test(item.message),
            ),
        ),
    )
    assert.equal(
      events.slice(beforeLonger).some(event => event.type === 'file' && diagnostics(event.diagnostics).length === 0),
      false,
      'refreshing the active file keeps its existing warnings until replacements arrive',
    )
    const changed = '# explanation\nx = 1\n'
    await writeFile(path.join(root, filename), changed)
    const beforeShorter = events.length
    assert.match(
      (await runtime.file(filename, async () => changed, 'shorter'))?.title ?? '',
      /2 Python.*1 code.*1 comment/,
    )
    await until(() =>
      events.slice(beforeShorter).some(event => event.type === 'file' && diagnostics(event.diagnostics).length === 0),
    )
    await writeFile(config, '[lsp]\ncode_lens = false\nmax_file_lines = 0\nmin_doc_ratio = 0\n')
    assert.equal(
      (await runtime.file(filename, () => readFile(path.join(root, filename), 'utf8'), 'configured'))?.title,
      '',
    )
    await runtime.dispose()
    assert.equal(runtime.languages.servers.size, 0)
    assert.equal(runtime.processes.size, 0)
    assert.ok(discoverHowMany({ PATH: '' })?.includes('resources/howmany/howmany'))
  },
)

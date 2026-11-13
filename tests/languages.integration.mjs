import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { LanguageRuntime } from '../electron/language.mjs'
import {
  documentSymbols,
  hasHover,
  isDiagnosticError,
  isRecord,
  serverPid,
  symbolCount,
  tokenCount,
} from './language-fixture.ts'

/** @import { LanguageEvent } from '../electron/language.mjs' */

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-language-matrix-')))
const fixtures = [
  {
    language: 'python',
    directory: 'python',
    manifest: 'pyproject.toml',
    config: '[project]\nname = "viewer"\nversion = "0.1.0"\n',
    file: 'viewer.py',
    text: 'total = len("hello")\n\ndef greet(name: str) -> str:\n    return name\n\nwrong: int = "not an integer"\n',
    position: { line: 2, character: 5 },
  },
  {
    language: 'typescript',
    directory: 'typescript',
    manifest: 'tsconfig.json',
    config: '{"compilerOptions":{"strict":true}}\n',
    file: 'viewer.ts',
    text: 'const total = 1 + 2;\n\nexport function greet(name: string): string {\n  return name;\n}\n\nconst wrong: number = "not a number";\n',
    position: { line: 2, character: 17 },
  },
  {
    language: 'rust',
    directory: 'rust',
    manifest: 'Cargo.toml',
    config: '[package]\nname = "viewer"\nversion = "0.1.0"\nedition = "2021"\n',
    file: 'src/lib.rs',
    text: 'pub fn greet(name: &str) -> String {\n    let total = name.len();\n    format!("hello {name}: {total}")\n}\n',
    position: { line: 0, character: 9 },
  },
  {
    language: 'go',
    directory: 'go',
    manifest: 'go.mod',
    config: 'module example.com/viewer\n\ngo 1.23\n',
    file: 'viewer.go',
    text: 'package viewer\n\nfunc Greet(name string) string {\n    total := len(name)\n    _ = total\n    return name\n}\n',
    position: { line: 2, character: 7 },
  },
  {
    language: 'swift',
    directory: 'swift',
    manifest: 'Package.swift',
    config:
      '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Viewer", targets: [.target(name: "Viewer")])\n',
    file: 'Sources/Viewer/Viewer.swift',
    text: 'public func greet(name: String) -> String {\n    let total = name.count\n    return "hello \\(name): \\(total)"\n}\n',
    position: { line: 0, character: 14 },
  },
  {
    language: 'elixir',
    directory: 'elixir',
    manifest: 'mix.exs',
    config:
      'defmodule Viewer.MixProject do\n  use Mix.Project\n  def project, do: [app: :viewer, version: "0.1.0", elixir: ">= 1.15.0", deps: []]\n  def application, do: []\nend\n',
    file: 'lib/viewer.ex',
    text: 'defmodule Viewer do\n  @doc "Greet someone."\n  def greet(name) do\n    String.upcase(name)\n  end\nend\n',
    position: { line: 2, character: 7 },
  },
]
/** @type {LanguageEvent[]} */
const events = []
const runtime = new LanguageRuntime(root, event => events.push(event), {
  idleMs: 1000,
  initializeTimeoutMs: 60_000,
  requestTimeoutMs: 30_000,
})
/** @param {number} started */
function elapsed(started) {
  return Math.round(performance.now() - started)
}

/** @type {Array<Awaited<ReturnType<typeof runFixture>>>} */
const report = []
/**
 * @template T
 * @param {() => T | Promise<T>} operation
 * @param {(result: T) => boolean} predicate
 */
async function eventually(operation, predicate, timeout = 45_000) {
  const deadline = Date.now() + timeout
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Retry only after the previous feature request completes.
    const result = await operation()
    if (predicate(result)) return result
    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the server before retrying the feature.
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error('Language feature never became ready')
}
/** @param {(typeof fixtures)[number]} fixture */
async function runFixture(fixture) {
  const directory = path.join(root, fixture.directory)
  const filename = path.join(fixture.directory, fixture.file)
  await mkdir(path.dirname(path.join(root, filename)), { recursive: true })
  await writeFile(path.join(directory, fixture.manifest), fixture.config)
  await writeFile(path.join(root, filename), fixture.text)
  const started = performance.now()
  const opened = await runtime.open({
    path: filename,
    language: fixture.language,
    text: fixture.text,
    version: 1,
  })
  assert.ok(opened.available, `${fixture.language}: ${JSON.stringify(runtime.status())}`)
  assert.equal(opened.workspace, directory, `${fixture.language} must initialize at its nested project manifest`)
  /** @param {string} method @param {Record<string, unknown>} [params] */
  const ask = (method, params = {}) => runtime.request({ path: filename, language: fixture.language, method, params })
  const symbols = documentSymbols(await ask('textDocument/documentSymbol'))
  assert.ok(symbolCount(symbols) > 0, `${fixture.language}: no real document symbols`)
  const hover = await eventually(() => ask('textDocument/hover', { position: fixture.position }), hasHover)
  assert.ok(hasHover(hover), `${fixture.language}: no hover content`)
  const capabilities = opened.capabilities
  assert.ok(isRecord(capabilities))
  const semantic = capabilities.semanticTokensProvider
  let tokens = null
  if (isRecord(semantic) && semantic.full) {
    tokens = await eventually(
      () => ask('textDocument/semanticTokens/full'),
      result => tokenCount(result) > 0,
    )
  } else if (isRecord(semantic) && semantic.range)
    tokens = await eventually(
      () =>
        ask('textDocument/semanticTokens/range', {
          range: {
            start: { line: 0, character: 0 },
            end: { line: fixture.text.split('\n').length - 1, character: 0 },
          },
        }),
      result => tokenCount(result) > 0,
    )
  const hints = await ask('textDocument/inlayHint', {
    range: {
      start: { line: 0, character: 0 },
      end: { line: fixture.text.split('\n').length - 1, character: 0 },
    },
  })
  const folding = await ask('textDocument/foldingRange')
  if (capabilities.semanticTokensProvider)
    assert.ok(tokenCount(tokens) > 0, `${fixture.language}: advertised semantic coloring returned no data`)
  if (['python', 'typescript'].includes(fixture.language))
    await eventually(
      () =>
        events.some(
          event => event.type === 'diagnostics' && event.path === filename && event.diagnostics.some(isDiagnosticError),
        ),
      result => result,
    )
  const pid = serverPid(runtime, fixture.language)
  const entry = {
    language: fixture.language,
    workspace: path.relative(root, directory),
    initializeAndFeaturesMs: elapsed(started),
    symbols: symbolCount(symbols),
    hover: hasHover(hover),
    semanticTokens: tokenCount(tokens) / 5,
    semanticRange: isRecord(semantic) && Boolean(semantic.range),
    inlaySupported: Boolean(capabilities.inlayHintProvider),
    hints: Array.isArray(hints) ? hints.length : 0,
    foldingSupported: Boolean(capabilities.foldingRangeProvider),
    folds: Array.isArray(folding) ? folding.length : 0,
    diagnostics: events.reduce(
      (count, event) =>
        count + (event.type === 'diagnostics' && event.path === filename ? event.diagnostics.length : 0),
      0,
    ),
    pid,
  }
  console.info(JSON.stringify(entry))
  runtime.close(filename)
  runtime.stop(fixture.language)
  await Promise.allSettled(runtime.stopping)
  assert.throws(() => process.kill(pid, 0), `${fixture.language}: language process survived disposal`)
  return entry
}

try {
  assert.equal(runtime.servers.size, 0)
  for (const fixture of fixtures) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Verify each isolated language process exits before opening the next one.
    report.push(await runFixture(fixture))
  }
  console.info(
    JSON.stringify({
      passed: report.length,
      languages: report.map(entry => entry.language),
      finalProcesses: runtime.servers.size,
    }),
  )
} finally {
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
}

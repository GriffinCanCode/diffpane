import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { LanguageRuntime } from '../electron/language.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-language-matrix-')));
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
];
const events = [];
const runtime = new LanguageRuntime(root, event => events.push(event), {
  idleMs: 1000,
  initializeTimeoutMs: 60_000,
  requestTimeoutMs: 30_000,
});
const symbolCount = symbols =>
  (symbols ?? []).reduce((total, symbol) => total + 1 + symbolCount(symbol.children), 0);
const elapsed = started => Math.round(performance.now() - started);
const report = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(operation, predicate, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await operation();
    if (predicate(result)) return result;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('Language feature never became ready');
}
try {
  assert.equal(runtime.servers.size, 0);
  for (const fixture of fixtures) {
    const directory = path.join(root, fixture.directory);
    const filename = path.join(fixture.directory, fixture.file);
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(directory, fixture.manifest), fixture.config);
    await writeFile(path.join(root, filename), fixture.text);
    const started = performance.now();
    const opened = await runtime.open({
      path: filename,
      language: fixture.language,
      text: fixture.text,
      version: 1,
    });
    assert.equal(
      opened.available,
      true,
      `${fixture.language}: ${JSON.stringify(runtime.status())}`,
    );
    assert.equal(
      opened.workspace,
      directory,
      `${fixture.language} must initialize at its nested project manifest`,
    );
    const ask = (method, params = {}) =>
      runtime.request({ path: filename, language: fixture.language, method, params });
    const symbols = await ask('textDocument/documentSymbol');
    assert.ok(symbolCount(symbols) > 0, `${fixture.language}: no real document symbols`);
    const hover = await eventually(
      () => ask('textDocument/hover', { position: fixture.position }),
      result => Boolean(result?.contents),
    );
    assert.ok(hover?.contents, `${fixture.language}: no hover content`);
    const capabilities = opened.capabilities;
    let tokens = null;
    if (capabilities.semanticTokensProvider?.full)
      tokens = await ask('textDocument/semanticTokens/full');
    else if (capabilities.semanticTokensProvider?.range)
      tokens = await ask('textDocument/semanticTokens/range', {
        range: {
          start: { line: 0, character: 0 },
          end: { line: fixture.text.split('\n').length - 1, character: 0 },
        },
      });
    const hints = await ask('textDocument/inlayHint', {
      range: {
        start: { line: 0, character: 0 },
        end: { line: fixture.text.split('\n').length - 1, character: 0 },
      },
    });
    const folding = await ask('textDocument/foldingRange');
    if (capabilities.semanticTokensProvider)
      assert.ok(
        tokens?.data?.length > 0,
        `${fixture.language}: advertised semantic coloring returned no data`,
      );
    if (['python', 'typescript'].includes(fixture.language))
      await eventually(
        () => events.filter(event => event.type === 'diagnostics' && event.path === filename),
        results =>
          results.some(event => event.diagnostics.some(diagnostic => diagnostic.severity === 1)),
      );
    const state = runtime.status().find(server => server.language === fixture.language);
    report.push({
      language: fixture.language,
      workspace: path.relative(root, opened.workspace),
      initializeAndFeaturesMs: elapsed(started),
      symbols: symbolCount(symbols),
      hover: Boolean(hover?.contents),
      semanticTokens: tokens?.data?.length / 5 || 0,
      semanticRange: Boolean(capabilities.semanticTokensProvider?.range),
      inlaySupported: Boolean(capabilities.inlayHintProvider),
      hints: hints?.length ?? 0,
      foldingSupported: Boolean(capabilities.foldingRangeProvider),
      folds: folding?.length ?? 0,
      diagnostics: events
        .filter(event => event.type === 'diagnostics' && event.path === filename)
        .reduce((count, event) => count + event.diagnostics.length, 0),
      pid: state.pid,
    });
    console.log(JSON.stringify(report.at(-1)));
    runtime.close(filename);
    runtime.stop(fixture.language);
    await Promise.allSettled(runtime.stopping);
    assert.throws(
      () => process.kill(state.pid, 0),
      `${fixture.language}: language process survived disposal`,
    );
  }
  console.log(
    JSON.stringify({
      passed: report.length,
      languages: report.map(entry => entry.language),
      finalProcesses: runtime.servers.size,
    }),
  );
} finally {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
}

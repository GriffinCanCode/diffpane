import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-ide-'));
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const catalogSize = 1200;
const python =
  'total = len("hello")\n\ndef greet(name: str) -> str:\n    """Return the supplied name."""\n    return name\n\nwrong: int = "not an integer"\n';
const typescript =
  'export class Greeter {\n  greet(name: string) {\n    return `hello ${name}`;\n  }\n}\nconst greeter = new Greeter();\nexport const greeting = greeter.greet("world");\nconst wrong: number = "not a number";\n';
const syntaxFixtures = [
  { file: 'python/viewer.py', text: python, comment: '# syntax check', language: 'Python' },
  {
    file: 'typescript/viewer.ts',
    text: typescript,
    comment: '// syntax check',
    language: 'TypeScript',
  },
  {
    file: 'syntax/viewer.rs',
    text: 'pub fn greet(name: &str) -> String { name.to_owned() }\n',
    comment: '// syntax check',
    language: 'Rust',
  },
  {
    file: 'syntax/viewer.ex',
    text: 'defmodule Viewer do\n  def greet(name), do: name\nend\n',
    comment: '# syntax check',
    language: 'Elixir',
  },
  {
    file: 'syntax/viewer.go',
    text: 'package viewer\nfunc Greet(name string) string { return name }\n',
    comment: '// syntax check',
    language: 'Go',
  },
  {
    file: 'syntax/viewer.swift',
    text: 'func greet(name: String) -> String { name }\n',
    comment: '// syntax check',
    language: 'Swift',
  },
];
const longDocument =
  Array.from(
    { length: 2000 },
    (_, index) =>
      `LINE_${String(index).padStart(4, '0')} - the entire unchanged file stays readable`,
  ).join('\n') + '\n';
let application;
let page;
const errors = [];
const metrics = {};
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

function card(file) {
  return page.locator(`#feed .file-card[data-path="${file}"]`);
}
async function findFile(file, source = false) {
  await page.locator('.navigator-search input').fill(file);
  const row = page.locator(`.navigator-row[data-kind="file"][data-path="${file}"]`);
  await row.waitFor({ state: 'visible' });
  await row.click();
  if (source) {
    await card(file).locator('.markdown-preview').waitFor();
    await card(file)
      .getByRole('group', { name: 'Markdown view' })
      .getByRole('button', { name: 'Source', exact: true })
      .click();
  }
  await page.waitForFunction(
    file =>
      window.__diffpane.stats().openedPath === file &&
      window.__diffpane.stats().activeEditors === 1,
    file,
  );
  await card(file).locator('.view-lines').waitFor({ state: 'visible' });
}
async function languageReady(file) {
  await page.waitForFunction(
    file =>
      document.querySelector(`#feed .file-card[data-path="${file}"] .language-state`)?.dataset
        .status === 'ready',
    file,
    { timeout: 30_000 },
  );
}
async function waitForError(file) {
  await page.waitForFunction(
    file => document.querySelector(`#feed .file-card[data-path="${file}"] .squiggly-error`),
    file,
    { timeout: 30_000 },
  );
}
async function showSymbols(file, name) {
  await card(file).locator('.symbol-outline summary').click();
  await card(file)
    .locator('.symbol-item')
    .filter({ hasText: name })
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  await card(file).locator('.symbol-item').filter({ hasText: name }).first().click();
  assert.equal(
    await card(file).locator('.symbol-outline').getAttribute('open'),
    null,
    'choosing a symbol should jump into the editor and close the outline',
  );
}

try {
  for (const directory of ['catalog', 'docs', 'python', 'typescript', 'syntax', 'ignored'])
    await mkdir(path.join(root, directory));
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  for (let index = 0; index < catalogSize; index++)
    await writeFile(
      path.join(root, `catalog/entry${String(index).padStart(4, '0')}.txt`),
      `unchanged file ${index}\n`,
    );
  await writeFile(path.join(root, 'docs/long.md'), longDocument);
  await writeFile(
    path.join(root, 'python/pyproject.toml'),
    '[project]\nname = "diffpane-fixture"\nversion = "0.1.0"\n',
  );
  await writeFile(path.join(root, 'python/viewer.py'), python);
  await writeFile(
    path.join(root, 'typescript/tsconfig.json'),
    '{"compilerOptions":{"strict":true,"target":"ES2022"}}\n',
  );
  await writeFile(path.join(root, 'typescript/viewer.ts'), typescript);
  for (const fixture of syntaxFixtures.filter(fixture => fixture.file.startsWith('syntax/')))
    await writeFile(path.join(root, fixture.file), fixture.text);
  await writeFile(path.join(root, 'ignored/private.py'), 'secret = "never listed"\n');
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'initial',
  );

  const packaged = process.env.DIFFPANE_EXECUTABLE;
  application = await electron.launch({
    executablePath: packaged || executablePath,
    args: packaged ? [root] : [process.env.DIFFPANE_TEST_APP || '.', root],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(
    count =>
      window.__diffpane?.stats().navigator.inventoryFiles === count &&
      !window.__diffpane.stats().navigator.loading,
    catalogSize + 10,
    { timeout: 15_000 },
  );
  assert.equal(await page.locator('#navigator').isVisible(), true);
  assert.equal(
    await page.locator('.navigator-row[data-path="catalog"]').getAttribute('aria-expanded'),
    'false',
    'folders start collapsed',
  );
  assert.equal(
    await page.locator('.navigator-row[data-path="ignored"]').count(),
    0,
    'ignored files stay outside the explorer',
  );
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().models),
    0,
    'a clean repository must not load document models',
  );
  const initiallyAvailable = await page.evaluate(() => window.diffpane.language.status());
  assert.ok(
    initiallyAvailable.every(server => server.pid === null),
    'no language server starts just because a project opens',
  );
  metrics.cleanStartup = await page.evaluate(() => window.__diffpane.stats());
  metrics.cleanMemoryKB = await application.evaluate(({ app }) =>
    app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0),
  );

  await page.locator('.navigator-row[data-path="catalog"]').click();
  await page.waitForFunction(
    count => window.__diffpane.stats().navigator.visibleRows > count,
    catalogSize,
  );
  const tree = page.locator('.navigator-tree');
  const viewportHeight = await tree.evaluate(element => element.clientHeight);
  assert.ok(
    (await page.locator('.navigator-row').count()) <= Math.ceil(viewportHeight / 22) + 8,
    'only visible explorer rows and a small margin should mount',
  );
  await page.locator('.navigator-search input').fill('catalog/');
  await tree.evaluate(element => {
    element.scrollTop = 700 * 22;
  });
  await page.waitForTimeout(100);
  const explorerScroll = await tree.evaluate(element => element.scrollTop);
  const catalogBefore = await page.evaluate(
    () => window.__diffpane.stats().navigator.catalogRequests,
  );
  await writeFile(path.join(root, 'catalog/entry0800.txt'), 'this existing file changed\n');
  await page.waitForFunction(
    async () =>
      (await window.diffpane.snapshot()).files.some(
        file => file.path === 'catalog/entry0800.txt',
      ) && !window.__diffpane.stats().navigator.loading,
  );
  assert.equal(
    await tree.evaluate(element => element.scrollTop),
    explorerScroll,
    'live catalog refresh should retain the explorer scroll anchor',
  );
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().navigator.catalogRequests),
    catalogBefore,
    'content edits must not reload the file inventory',
  );
  metrics.virtualized = await page.evaluate(() => window.__diffpane.stats().navigator);

  await page.keyboard.press(`${modifier}+b`);
  await page.locator('#navigator').waitFor({ state: 'hidden' });
  await page.keyboard.press(`${modifier}+b`);
  await page.locator('#navigator').waitFor({ state: 'visible' });
  const widthBefore = await page.locator('#navigator').evaluate(element => element.clientWidth);
  await page.locator('#navigator-resize').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page.locator('#navigator').evaluate(element => element.clientWidth),
    widthBefore + 16,
    'the explorer divider should resize with the keyboard',
  );

  await findFile('docs/long.md', true);
  assert.equal(
    await card('docs/long.md').locator('.diff-gutter-added').count(),
    0,
    'unchanged documents should not acquire diff highlights',
  );
  await card('docs/long.md').locator('.monaco-editor').hover();
  await page.mouse.wheel(0, 950);
  await page.waitForTimeout(350);
  const firstLineBefore = await card('docs/long.md').locator('.view-line').first().innerText();
  assert.equal(
    firstLineBefore.includes('LINE_0000'),
    false,
    'the full file viewer must scroll through unchanged code',
  );
  const liveSaveStart = performance.now();
  await writeFile(path.join(root, 'docs/long.md'), longDocument + 'LIVE_APPEND_AT_END\n');
  await page.waitForFunction(
    () =>
      document
        .querySelector('#feed [data-path="docs/long.md"] .line-count')
        ?.textContent.includes('2,002'),
    undefined,
    { timeout: 5000 },
  );
  metrics.fullFileSaveMs = performance.now() - liveSaveStart;
  assert.equal(
    await card('docs/long.md').locator('.view-line').first().innerText(),
    firstLineBefore,
    'a live edit outside the viewport must preserve the visible code',
  );
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().models),
    1,
    'file viewing keeps one Monaco document',
  );
  assert.ok(
    (await page.evaluate(() => window.diffpane.language.status())).every(
      server => server.pid === null,
    ),
    'viewing plain text must not start unrelated language servers',
  );
  await page.locator('.navigator-search input').fill('catalog/');
  await tree.evaluate(element => {
    element.scrollTop = 700 * 22;
  });
  await page.waitForTimeout(100);
  const browsingScroll = await tree.evaluate(element => element.scrollTop);
  const browsingCatalog = await page.evaluate(
    () => window.__diffpane.stats().navigator.catalogRequests,
  );
  await writeFile(
    path.join(root, 'catalog/entry0801.txt'),
    'another file changed while a document stays open\n',
  );
  await page.waitForFunction(
    async () =>
      (await window.diffpane.snapshot()).files.some(
        file => file.path === 'catalog/entry0801.txt',
      ) && !window.__diffpane.stats().navigator.loading,
  );
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().navigator.catalogRequests),
    browsingCatalog,
    'editing an existing file must not reload inventory',
  );
  assert.equal(
    await page.locator('.navigator-search input').inputValue(),
    'catalog/',
    'a live edit must preserve the explorer search while another file is open',
  );
  assert.equal(
    await tree.evaluate(element => element.scrollTop),
    browsingScroll,
    'live edits must not scroll the explorer back to the open file',
  );

  // Syntax follows each selected file; unused language servers stay asleep.
  assert.ok(
    (await page.evaluate(() => window.diffpane.language.status())).every(
      server => server.pid === null,
    ),
  );

  await findFile('python/viewer.py');
  await languageReady('python/viewer.py');
  await waitForError('python/viewer.py');
  await showSymbols('python/viewer.py', 'greet');
  const pythonServers = await page.evaluate(() => window.diffpane.language.status());
  assert.ok(
    pythonServers.find(server => server.language === 'python').pid > 0,
    'viewing Python should start its actual language server',
  );
  assert.equal(
    pythonServers.find(server => server.language === 'typescript').pid,
    null,
    'TypeScript stays asleep until its own file is used',
  );
  const pythonSaveStart = performance.now();
  await writeFile(path.join(root, 'python/viewer.py'), python.replace('"not an integer"', '42'));
  await page.waitForFunction(
    () => {
      const file = document.querySelector('#feed [data-path="python/viewer.py"]');
      return (
        file?.querySelector('.view-lines')?.textContent.includes('42') &&
        !file.querySelector('.squiggly-error')
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  metrics.pythonDiagnosticRecoveryMs = performance.now() - pythonSaveStart;
  metrics.python = await page.evaluate(() => window.__diffpane.stats());

  await findFile('typescript/viewer.ts');
  await languageReady('typescript/viewer.ts');
  await waitForError('typescript/viewer.ts');
  await showSymbols('typescript/viewer.ts', 'greet');
  await page.waitForFunction(
    () =>
      /greeting:\s*string/.test(
        document.querySelector('#feed [data-path="typescript/viewer.ts"] .view-lines')
          ?.textContent ?? '',
      ),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll('#feed [data-path="typescript/viewer.ts"] .view-line span'),
      ].some(
        element =>
          element.textContent.trim() === 'greet' &&
          getComputedStyle(element).color === 'rgb(239, 171, 116)',
      ),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector('#feed [data-path="typescript/viewer.ts"] .codicon-folding-expanded'),
    undefined,
    { timeout: 15_000 },
  );
  await card('typescript/viewer.ts')
    .locator('.view-lines')
    .getByText('greet', { exact: true })
    .first()
    .hover();
  await page
    .locator('.monaco-hover')
    .filter({ hasText: 'greet' })
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 });
  metrics.typescript = await page.evaluate(() => window.__diffpane.stats());
  assert.ok(
    metrics.typescript.languages.semanticTokens > 0,
    'the Monaco semantic provider should render actual server tokens',
  );
  assert.ok(
    metrics.typescript.languages.inlayHints > 0,
    'the Monaco inlay provider should render actual server hints',
  );
  metrics.activeLanguagesMemoryKB = await application.evaluate(({ app }) =>
    app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0),
  );
  const servers = await page.evaluate(() => window.diffpane.language.status());
  assert.ok(
    servers.find(server => server.language === 'typescript').pid > 0,
    'TypeScript features should come from the actual server',
  );
  assert.ok(
    servers.filter(server => server.pid).length <= 2,
    'language processes should remain bounded while switching files',
  );
  assert.ok(
    servers
      .filter(server => !['python', 'typescript'].includes(server.language))
      .every(server => server.pid === null),
    'other language servers stay asleep',
  );

  await writeFile(
    path.join(root, 'typescript/viewer.tsx'),
    'declare namespace JSX { interface IntrinsicElements { div: { children?: string } } }\nexport const view = <div>hello</div>;\nconst wrong: number = "not a number";\n',
  );
  await findFile('typescript/viewer.tsx');
  await languageReady('typescript/viewer.tsx');
  await waitForError('typescript/viewer.tsx');
  await showSymbols('typescript/viewer.tsx', 'view');
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().openedLanguage),
    'tsx',
    'TSX keeps JSX syntax and actual TypeScript services',
  );

  await page.mouse.move(0, 0);
  await page.locator('.navigator-search input').fill('');
  await page.locator('.navigator-actions [data-action="collapse"]').click();
  await page.locator('.navigator-row[data-path="typescript"]').click();
  await page.locator('.navigator-row[data-path="typescript/viewer.ts"]').click();
  await languageReady('typescript/viewer.ts');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/ide.png' });
  const pids = servers.filter(server => server.pid).map(server => server.pid);
  assert.deepEqual(errors, [], 'the integrated explorer and language providers must not throw');
  await application.close();
  application = null;
  const deadline = Date.now() + 5000;
  const alive = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (pids.some(alive) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(
    pids.every(pid => !alive(pid)),
    'closing the app must terminate its owned language processes',
  );
  console.log(JSON.stringify({ ...metrics, rendererErrors: errors }, null, 2));
} catch (error) {
  console.error('renderer errors', errors);
  if (page && application && !page.isClosed()) {
    console.error(await page.locator('body').innerText());
    console.error(await page.evaluate(() => window.__diffpane?.stats()));
    console.error(
      await page.locator('.view-lines .view-line span').evaluateAll(elements =>
        elements
          .filter(element => element.textContent.includes('greet'))
          .map(element => ({
            text: element.textContent,
            color: getComputedStyle(element).color,
            className: element.className,
          })),
      ),
    );
    console.error(await page.evaluate(() => window.diffpane.language.status()));
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/ide-failure.png' });
  }
  throw error;
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true });
}

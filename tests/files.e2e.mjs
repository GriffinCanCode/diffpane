import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-files-'));
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const commit = message =>
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  );
const initialCode = [
  '// UNCHANGED_FILE_START',
  'export const firstValue = 1;',
  '',
  'export function readWholeFile() {',
  '  const untouchedMiddle = "the entire file stays readable";',
  '  return untouchedMiddle;',
  '}',
  '',
  '// UNCHANGED_FILE_END',
  '',
].join('\n');
let application;
const failures = [];
const metrics = {};

async function launch(target) {
  application = await electron.launch({
    executablePath: process.env.DIFFPANE_EXECUTABLE || executablePath,
    args: process.env.DIFFPANE_EXECUTABLE
      ? [target]
      : [process.env.DIFFPANE_TEST_APP || '.', target],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const page = await application.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  await page.waitForFunction(() => window.__diffpane?.stats().activeEditors > 0, undefined, {
    timeout: 15000,
  });
  return page;
}

function currentCard(page, file) {
  return page.locator(`#feed .file-card[data-path="${file}"]`);
}

async function waitForCode(page, file, snippet) {
  await page.waitForFunction(
    ({ file, snippet }) => {
      const card = [...document.querySelectorAll('#feed .file-card')].find(
        element => element.dataset.path === file,
      );
      return card
        ?.querySelector('.view-lines, .markdown-preview, .preview-text')
        ?.textContent.includes(snippet);
    },
    { file, snippet },
    { timeout: 5000 },
  );
}

try {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'ignored'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await writeFile(path.join(root, 'src/unchanged.ts'), initialCode);
  await writeFile(path.join(root, 'src/changed.ts'), 'export const changedValue = 1;\n');
  await writeFile(path.join(root, 'docs/notes.md'), 'This nested document has no changes.\n');
  await writeFile(path.join(root, 'ignored/secret.ts'), 'export const ignoredValue = true;\n');
  git('init', '-q');
  git('add', '.');
  commit('initial');
  await writeFile(path.join(root, 'src/changed.ts'), 'export const changedValue = 2;\n');
  await writeFile(path.join(root, 'src/new.ts'), 'export const newValue = true;\n');

  let page = await launch(root);
  await page.waitForFunction(() => window.__diffpane.stats().files === 1);
  await page.locator('#navigator').waitFor({ state: 'visible' });
  assert.equal(
    await page.locator('aside#navigator').count(),
    1,
    'the explorer should stay visible while viewing full files',
  );
  assert.equal(
    await page.getByText('ORIGINAL · HEAD').count(),
    0,
    'the original pane must stay absent',
  );

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await page.locator('#file-picker').waitFor({ state: 'visible' });
  await page.locator('#file-list button[data-path="src/unchanged.ts"]').waitFor();
  const catalog = await page
    .locator('#file-list button[data-path]')
    .evaluateAll(buttons => buttons.map(button => button.dataset.path));
  assert.ok(catalog.includes('src/changed.ts'), 'modified files should remain available');
  assert.ok(catalog.includes('src/new.ts'), 'untracked files should remain available');
  assert.ok(catalog.includes('docs/notes.md'), 'unchanged nested files should be discoverable');
  assert.equal(
    catalog.some(file => file.startsWith('ignored/')),
    false,
    'Git-ignored files should stay out of the picker',
  );

  assert.equal(await page.getByRole('dialog', { name: 'Search files' }).count(), 1);
  assert.equal(
    await page.locator('#file-search').evaluate(input => input === document.activeElement),
    true,
    'search should take keyboard focus',
  );
  assert.ok(
    (await page.locator('.picker-context').innerText()).includes(root),
    'search should identify its project',
  );
  await page.locator('#file-search').fill('src unch');
  await page.locator('#file-list button[data-path="src/unchanged.ts"]').waitFor();
  assert.ok((await page.locator('#file-list mark').count()) > 0, 'matches should be highlighted');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  assert.equal(
    await page.locator('#file-search').inputValue(),
    'src unch',
    'repeating the shortcut must preserve the query',
  );
  await page.locator('.picker-clear').click();
  assert.equal(await page.locator('#file-search').inputValue(), '');
  await page.locator('#file-search').fill('no-such-file-exists');
  await page.getByText('No files or folders found', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  assert.equal(
    await page.locator('#file-picker').isVisible(),
    true,
    'Enter with no match must keep search open',
  );
  await page.locator('#file-search').fill('src');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(
    await page.locator('#file-list [aria-selected="true"]').getAttribute('data-path'),
    'src/changed.ts',
  );
  const activeId = await page.locator('#file-search').getAttribute('aria-activedescendant');
  assert.equal(
    await page.locator(`#${activeId}`).getAttribute('aria-selected'),
    'true',
    'assistive focus should follow keyboard selection',
  );
  await page.locator('.picker-close').click();
  await page.locator('#file-picker').waitFor({ state: 'hidden' });
  await page.locator('.navigator-action[data-action="open-file"]').click();
  await page.locator('#file-search').fill('unchanged');
  await page.waitForFunction(() => {
    const files = [...document.querySelectorAll('#file-list button[data-path]')].filter(
      button => !button.hidden && button.getClientRects().length,
    );
    return files.length === 1 && files[0].dataset.path === 'src/unchanged.ts';
  });
  await page.locator('#file-list button[data-path="src/unchanged.ts"]').click();
  await page.locator('#file-picker').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.__diffpane.stats().openedPath === 'src/unchanged.ts');
  await waitForCode(page, 'src/unchanged.ts', 'UNCHANGED_FILE_START');
  await waitForCode(page, 'src/unchanged.ts', 'untouchedMiddle');
  await waitForCode(page, 'src/unchanged.ts', 'UNCHANGED_FILE_END');
  assert.equal(
    await page.locator('#feed .file-card').count(),
    1,
    'file view should show one complete current document',
  );
  assert.equal(
    await currentCard(page, 'src/unchanged.ts').locator('.diff-gutter-added').count(),
    0,
    'unchanged code must not be marked as added',
  );

  const saveStart = performance.now();
  await writeFile(
    path.join(root, 'src/unchanged.ts'),
    initialCode.replace('firstValue = 1', 'firstValue = 333') + '// LIVE_UNCHANGED_SAVE\n',
  );
  await waitForCode(page, 'src/unchanged.ts', 'LIVE_UNCHANGED_SAVE');
  metrics.liveSaveMs = performance.now() - saveStart;
  await page.waitForFunction(() =>
    document.querySelector('#feed [data-path="src/unchanged.ts"] .diff-gutter-added'),
  );
  assert.ok(
    await currentCard(page, 'src/unchanged.ts').locator('.diff-gutter-modified').count(),
    'edits receive their own blue gutter marker',
  );
  assert.equal(
    await currentCard(page, 'src/unchanged.ts').locator('.diff-word-added').count(),
    0,
    'changes appear at the edges without inline highlights',
  );
  assert.equal(
    await page.locator('.diff-line-added').count(),
    0,
    'whole lines must not receive a green fill',
  );
  await writeFile(
    path.join(root, 'src/unchanged.ts'),
    initialCode
      .replace('firstValue = 1', 'firstValue = 333')
      .replace('  return untouchedMiddle;\n', '') + '// LIVE_UNCHANGED_SAVE\n',
  );
  await page.waitForFunction(() => document.querySelector('.diff-gutter-deleted'));
  const markerStyles = await page.evaluate(() =>
    Object.fromEntries(
      ['added', 'modified', 'deleted'].map(kind => {
        const element = document.querySelector(`.diff-gutter-${kind}`);
        const style = getComputedStyle(element, kind === 'deleted' ? '::before' : null);
        return [
          kind,
          {
            color: style.borderLeftColor,
            width: style.borderLeftWidth,
            background: getComputedStyle(element).backgroundColor,
          },
        ];
      }),
    ),
  );
  assert.equal(
    new Set(Object.values(markerStyles).map(style => style.color)).size,
    3,
    'added, modified and deleted markers must have distinct visible colors',
  );
  assert.ok(
    Object.values(markerStyles).every(style => Number.parseFloat(style.width) >= 2),
    'minimal gutter marks must remain visible',
  );
  assert.ok(
    Object.values(markerStyles).every(style => style.background === 'rgba(0, 0, 0, 0)'),
    'gutter marks must not tint the code background',
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/inline-changes.png' });
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().models),
    1,
    'opening a file should only retain its current Monaco model',
  );

  git('add', '.');
  commit('save changes');
  await page.waitForFunction(
    () => {
      const card = document.querySelector('#feed [data-path="src/unchanged.ts"]');
      return (
        card?.querySelector('.view-lines')?.textContent.includes('LIVE_UNCHANGED_SAVE') &&
        !card.querySelector('[class*="diff-gutter-"]')
      );
    },
    undefined,
    { timeout: 5000 },
  );
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().openedPath),
    'src/unchanged.ts',
    'committing must keep the open document',
  );

  await writeFile(path.join(root, 'src/changed.ts'), 'export const changedValue = 444;\n');
  await page.waitForFunction(async () =>
    (await window.diffpane.snapshot()).files.some(file => file.path === 'src/changed.ts'),
  );
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().openedPath),
    'src/unchanged.ts',
    'edits to another file must not change the open document',
  );
  assert.equal(await page.locator('#feed .file-card').count(), 1);
  await page.locator('.navigator-search input').fill('src/changed.ts');
  await page.locator('.navigator-row[data-path="src/changed.ts"]').click();
  await waitForCode(page, 'src/changed.ts', '444');
  await page.waitForFunction(() => document.querySelector('.diff-gutter-modified'));

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await page.locator('#file-picker').waitFor({ state: 'visible' });
  await page.locator('#file-search').fill('notes.md');
  await page.keyboard.press('Enter');
  await waitForCode(page, 'docs/notes.md', 'nested');
  await page.locator('.navigator-action[data-action="open-file"]').click();
  await page.locator('#file-picker').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#file-picker').waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().openedPath),
    'docs/notes.md',
    'dismissing the picker must retain the open file',
  );
  assert.deepEqual(
    failures,
    [],
    'the renderer should not throw while browsing, saving, committing, or switching files',
  );
  metrics.browsing = await page.evaluate(() => window.__diffpane.stats());
  await application.close();
  application = null;

  page = await launch(path.join(root, 'src/unchanged.ts'));
  await page.waitForFunction(() => window.__diffpane.stats().openedPath === 'src/unchanged.ts');
  await waitForCode(page, 'src/unchanged.ts', 'UNCHANGED_FILE_START');
  await waitForCode(page, 'src/unchanged.ts', 'LIVE_UNCHANGED_SAVE');
  assert.equal(
    await page.locator('#feed .file-card').count(),
    1,
    'a file path from the terminal must directly open that file',
  );
  assert.equal(
    await page.locator('#file-picker').isVisible(),
    false,
    'direct file launch should not require the picker',
  );
  assert.deepEqual(failures, [], 'direct file launch should not throw in the renderer');
  metrics.directFile = await page.evaluate(() => window.__diffpane.stats());
  await mkdir(path.join(root, 'src/catalog'), { recursive: true });
  for (let index = 0; index < 200; index++)
    await writeFile(
      path.join(root, `src/catalog/document-${String(index).padStart(3, '0')}.txt`),
      'Search inventory\n',
    );
  await page.evaluate(() => window.diffpane.refresh());
  await page.locator('.navigator-action[data-action="open-file"]').click();
  await page.locator('#file-search').fill('catalog');
  await page.waitForFunction(() =>
    document.querySelector('.picker-summary').textContent.startsWith('201 items'),
  );
  assert.ok(
    (await page.locator('#file-list button').count()) < 25,
    'large result sets must keep mounted rows bounded',
  );
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  assert.ok(
    (await page.locator('#file-list').evaluate(list => list.scrollTop)) > 0,
    'page navigation must scroll results',
  );
  const selectedPath = await page
    .locator('#file-list [aria-selected="true"]')
    .getAttribute('data-path');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(650, 420),
  );
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator('#file-list [aria-selected="true"]').getAttribute('data-path'),
    selectedPath,
  );
  const fits = await page.locator('#file-picker').evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && rect.width <= innerWidth;
  });
  assert.equal(fits, true, 'the search window must fit the minimum app size');
  await page.locator('.picker-close').click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1200, 850),
  );
  await page.locator('.navigator-action[data-action="open-file"]').click();
  await page.locator('#file-search').fill('catalog doc');
  await page.waitForFunction(() =>
    document.querySelector('.picker-summary').textContent.startsWith('200 items'),
  );
  await mkdir('test-results', { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/file-search.png' });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/search-top-bar.png' });
  const bar = await page.locator('.titlebar').boundingBox();
  const search = await page.locator('.navigator-action[data-action="open-file"]').boundingBox();
  assert.ok(
    bar.height <= 36 && search.height <= 26,
    'the title bar and explorer search action should stay compact',
  );
  assert.ok(search.x + search.width <= 1200, 'explorer search action should remain visible');
  assert.deepEqual(failures, [], 'large search and resizing should not throw');
  console.log(JSON.stringify({ ...metrics, rendererErrors: failures }, null, 2));
} catch (error) {
  if (application) {
    const pages = application.windows();
    if (pages[0]) {
      console.error(await pages[0].locator('body').innerText());
      await mkdir('test-results', { recursive: true });
      await pages[0].screenshot({ path: 'test-results/files-failure.png' });
    }
  }
  console.error('renderer errors', failures);
  throw error;
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true });
}

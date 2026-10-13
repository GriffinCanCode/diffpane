import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-files-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], {
  stdio: 'pipe',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
const commit = message => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
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
    executablePath,
    args: ['.', target],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const page = await application.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  await page.waitForFunction(() => window.__diffpane?.stats().activeEditors > 0, undefined, { timeout: 15000 });
  return page;
}

function currentCard(page, file) {
  return page.locator(`#feed .file-card[data-path="${file}"]`);
}

async function waitForCode(page, file, snippet) {
  await page.waitForFunction(({ file, snippet }) => {
    const card = [...document.querySelectorAll('#feed .file-card')].find(element => element.dataset.path === file);
    return card?.querySelector('.view-lines')?.textContent.includes(snippet);
  }, { file, snippet }, { timeout: 5000 });
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
  await page.waitForFunction(() => window.__diffpane.stats().view === 'changes' && window.__diffpane.stats().files === 2);
  await page.locator('#navigator').waitFor({ state: 'visible' });
  assert.equal(await page.locator('aside#navigator').count(), 1, 'the explorer should stay visible while viewing full files');
  assert.equal(await page.getByText('ORIGINAL · HEAD').count(), 0, 'the original pane must stay absent');

  await page.locator('#view-files').click();
  await page.locator('#file-picker').waitFor({ state: 'visible' });
  await page.locator('#file-list button[data-path="src/unchanged.ts"]').waitFor();
  const catalog = await page.locator('#file-list button[data-path]').evaluateAll(buttons => buttons.map(button => button.dataset.path));
  assert.ok(catalog.includes('src/changed.ts'), 'modified files should remain available');
  assert.ok(catalog.includes('src/new.ts'), 'untracked files should remain available');
  assert.ok(catalog.includes('docs/notes.md'), 'unchanged nested files should be discoverable');
  assert.equal(catalog.some(file => file.startsWith('ignored/')), false, 'Git-ignored files should stay out of the picker');

  await page.locator('#file-search').fill('unchanged');
  await page.waitForFunction(() => {
    const files = [...document.querySelectorAll('#file-list button[data-path]')].filter(button => !button.hidden && button.getClientRects().length);
    return files.length === 1 && files[0].dataset.path === 'src/unchanged.ts';
  });
  await page.locator('#file-list button[data-path="src/unchanged.ts"]').click();
  await page.locator('#file-picker').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.__diffpane.stats().view === 'files' && window.__diffpane.stats().openedPath === 'src/unchanged.ts');
  await waitForCode(page, 'src/unchanged.ts', 'UNCHANGED_FILE_START');
  await waitForCode(page, 'src/unchanged.ts', 'untouchedMiddle');
  await waitForCode(page, 'src/unchanged.ts', 'UNCHANGED_FILE_END');
  assert.equal(await page.locator('#feed .file-card').count(), 1, 'file view should show one complete current document');
  assert.equal(await currentCard(page, 'src/unchanged.ts').locator('.diff-line-added').count(), 0, 'unchanged code must not be marked as added');

  const saveStart = performance.now();
  await writeFile(path.join(root, 'src/unchanged.ts'), initialCode.replace('firstValue = 1', 'firstValue = 333') + '// LIVE_UNCHANGED_SAVE\n');
  await waitForCode(page, 'src/unchanged.ts', 'LIVE_UNCHANGED_SAVE');
  metrics.liveSaveMs = performance.now() - saveStart;
  await page.waitForFunction(() => document.querySelector('#feed [data-path="src/unchanged.ts"] .diff-line-added'));
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 1, 'opening a file should only retain its current Monaco model');

  git('add', '.');
  commit('save changes');
  await page.waitForFunction(() => {
    const card = document.querySelector('#feed [data-path="src/unchanged.ts"]');
    return card?.querySelector('.view-lines')?.textContent.includes('LIVE_UNCHANGED_SAVE') && !card.querySelector('.diff-line-added');
  }, undefined, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__diffpane.stats().openedPath), 'src/unchanged.ts', 'committing must keep the open document');

  await page.locator('#view-changes').click();
  await page.waitForFunction(() => window.__diffpane.stats().view === 'changes' && window.__diffpane.stats().files === 0);
  await page.locator('#empty-state').waitFor({ state: 'visible' });
  await writeFile(path.join(root, 'src/changed.ts'), 'export const changedValue = 444;\n');
  await waitForCode(page, 'src/changed.ts', '444');
  assert.equal(await page.locator('#feed .file-card').count(), 1, 'the changes feed must only contain dirty files');
  await page.locator('#filter').fill('unchanged');
  await page.locator('#empty-state').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#feed .file-card:not([hidden])').count(), 0, 'the existing changed-file filter should still work');
  await page.locator('#filter').fill('');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await page.locator('#file-picker').waitFor({ state: 'visible' });
  await page.locator('#file-search').fill('notes.md');
  await page.locator('#file-list button[data-path="docs/notes.md"]').click();
  await waitForCode(page, 'docs/notes.md', 'nested');
  await page.locator('#open-file').click();
  await page.locator('#file-picker').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#file-picker').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__diffpane.stats().openedPath), 'docs/notes.md', 'dismissing the picker must retain the open file');
  assert.deepEqual(failures, [], 'the renderer should not throw while browsing, saving, committing, or switching views');
  metrics.browsing = await page.evaluate(() => window.__diffpane.stats());
  await application.close();
  application = null;

  page = await launch(path.join(root, 'src/unchanged.ts'));
  await page.waitForFunction(() => window.__diffpane.stats().view === 'files' && window.__diffpane.stats().openedPath === 'src/unchanged.ts');
  await waitForCode(page, 'src/unchanged.ts', 'UNCHANGED_FILE_START');
  await waitForCode(page, 'src/unchanged.ts', 'LIVE_UNCHANGED_SAVE');
  assert.equal(await page.locator('#feed .file-card').count(), 1, 'a file path from the terminal must directly open that file');
  assert.equal(await page.locator('#file-picker').isVisible(), false, 'direct file launch should not require the picker');
  assert.deepEqual(failures, [], 'direct file launch should not throw in the renderer');
  metrics.directFile = await page.evaluate(() => window.__diffpane.stats());
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

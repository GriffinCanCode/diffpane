import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-actions-'));
let application;
const errors = [];
try {
  execFileSync('git', ['init', '-q', root]);
  await mkdir(path.join(root, 'src/deep'), { recursive: true });
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'src/deep/main.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'src/deep/helper.py'), 'value = 1\n');
  await writeFile(path.join(root, 'docs/readme.md'), '# Notes\n');
  application = await electron.launch({ executablePath, args: ['.', root] });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const explorer = page.locator('#navigator');
  const search = explorer.locator('.navigator-search input');
  await explorer.locator('.navigator-row[data-path="src"]').waitFor();
  await search.fill('deep');
  await explorer.locator('.navigator-row[data-kind="directory"][data-path="src/deep"]').waitFor();
  await explorer.locator('.search-filter-toggle').click();
  await explorer.getByLabel('Show', { exact: true }).selectOption('folders');
  assert.equal(await explorer.locator('.navigator-row').count(), 1);
  await explorer.locator('.navigator-row[data-path="src/deep"]').click();
  await explorer.locator('.navigator-row[data-path="src/deep/main.ts"]').waitFor();
  assert.equal(await search.inputValue(), '');
  await explorer.getByLabel('Language', { exact: true }).selectOption({ label: 'TypeScript' });
  assert.equal(await explorer.locator('.navigator-row').count(), 1);
  await explorer.getByLabel('File type', { exact: true }).selectOption('.py');
  assert.equal(await explorer.locator('.navigator-row').count(), 0);
  await explorer.getByRole('button', { name: 'Reset filters' }).click();
  await search.fill('src/deep/main.ts');
  await explorer.locator('.navigator-row[data-path="src/deep/main.ts"]').click();
  await page.waitForFunction(() => window.__diffpane?.stats().activeEditors === 1);
  const editor = page.locator('#feed .monaco-editor .view-lines').last();
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText('export const value = 42;\n');
  const row = explorer.locator('.navigator-row[data-path="src/deep/main.ts"]');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy relative path', exact: true }).click();
  assert.equal(
    await application.evaluate(async ({ clipboard }) => clipboard.readText()),
    'src/deep/main.ts',
  );
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByRole('textbox', { name: 'New name' }).fill('helper.py');
  await page.locator('.rename-dialog button[type="submit"]').click();
  await page.locator('.rename-error').filter({ hasText: 'already exists' }).waitFor();
  await page.getByRole('textbox', { name: 'New name' }).fill('renamed.ts');
  await page.locator('.rename-dialog button[type="submit"]').click();
  await page.locator('.rename-dialog').waitFor({ state: 'hidden' });
  await page.locator('#feed .file-card[data-path="src/deep/renamed.ts"]').waitFor();
  assert.equal(
    await readFile(path.join(root, 'src/deep/renamed.ts'), 'utf8'),
    'export const value = 42;\n',
  );
  await search.fill('src/deep');
  const directory = explorer.locator('.navigator-row[data-kind="directory"][data-path="src/deep"]');
  await directory.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByRole('textbox', { name: 'New name' }).fill('nested');
  await page.locator('.rename-dialog button[type="submit"]').click();
  await page.locator('.rename-dialog').waitFor({ state: 'hidden' });
  await page.locator('#feed .file-card[data-path="src/nested/renamed.ts"]').waitFor();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  const picker = page.locator('#file-picker');
  await picker.locator('#file-search').fill('nested');
  await picker.locator('.search-filter-toggle').click();
  await picker.getByLabel('Show', { exact: true }).selectOption('folders');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(650, 420),
  );
  assert.equal(
    await picker.evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }),
    true,
  );
  await picker.locator('.picker-file[data-path="src/nested"]').click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1400, 960),
  );
  await picker.waitFor({ state: 'hidden' });
  await explorer.locator('.navigator-row[data-path="src/nested/renamed.ts"]').waitFor();
  await search.fill('src/nested/renamed.ts');
  await explorer
    .locator('.navigator-row[data-path="src/nested/renamed.ts"]')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await page.locator('#empty-state').waitFor({ state: 'visible' });
  await assert.rejects(stat(path.join(root, 'src/nested/renamed.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'src/nested/helper.py'), 'utf8'), 'value = 1\n');
  await search.fill('src/nested');
  await explorer
    .locator('.navigator-row[data-kind="directory"][data-path="src/nested"]')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await page.waitForFunction(
    () => !document.querySelector('.navigator-row[data-path="src/nested"]'),
  );
  await assert.rejects(stat(path.join(root, 'src/nested')), { code: 'ENOENT' });
  await search.fill('docs');
  await explorer.getByLabel('Show', { exact: true }).selectOption('folders');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/explorer-actions.png' });
  assert.deepEqual(errors, []);
  console.log('Explorer actions and filters passed');
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
}

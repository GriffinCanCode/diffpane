import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-autosave-'));
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const failures = [];
let application;

async function waitForDisk(name, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await readFile(path.join(root, name), 'utf8')) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await readFile(path.join(root, name), 'utf8'), expected);
}

async function replace(page, text) {
  const editor = page.locator('#feed .monaco-editor .view-lines').last();
  await editor.click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(text);
}

try {
  await writeFile(path.join(root, 'a.txt'), 'baseline\n');
  await writeFile(path.join(root, 'b.md'), '# Original\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'baseline',
  ]);
  application = await electron.launch({ executablePath, args: ['.', path.join(root, 'a.txt')] });
  const page = await application.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  await page.waitForFunction(() => window.__diffpane?.stats().activeEditors === 1);
  await replace(page, 'autosaved');
  await waitForDisk('a.txt', 'autosaved');
  await page.waitForFunction(() => document.querySelector('.diff-gutter-modified'));
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');

  await page.keyboard.press(`${modifier}+z`);
  await waitForDisk('a.txt', 'baseline\n');

  await page.locator('.diff-toggle').click();
  await page.waitForFunction(() => window.__diffpane.stats().diffMode);
  await replace(page, 'edited in comparison\n');
  await waitForDisk('a.txt', 'edited in comparison\n');
  assert.ok((await page.locator('.monaco-diff-editor').textContent()).includes('baseline'));

  await writeFile(path.join(root, 'a.txt'), 'external edit\n');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.view-lines')].some(lines =>
      lines.textContent.replaceAll('\u00a0', ' ').includes('external edit'),
    ),
  );
  await replace(page, 'edit after external sync\n');
  await waitForDisk('a.txt', 'edit after external sync\n');

  await chmod(path.join(root, 'a.txt'), 0o444);
  await replace(page, 'retained after save failure\n');
  await page.waitForFunction(() =>
    document.getElementById('save-state').textContent.startsWith('Save failed'),
  );
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'edit after external sync\n');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForFunction(() =>
    document.getElementById('save-state').textContent.startsWith('Save failed'),
  );
  assert.equal(application.windows().length, 1, 'a failed save must keep the window open');
  await chmod(path.join(root, 'a.txt'), 0o644);
  await page.keyboard.press(`${modifier}+s`);
  await waitForDisk('a.txt', 'retained after save failure\n');

  await replace(page, 'saved before switching\n');
  await page.keyboard.press(`${modifier}+p`);
  await page.locator('#file-list button[data-path="b.md"]').click();
  await page.waitForFunction(() => window.__diffpane.stats().openedPath === 'b.md');
  await waitForDisk('a.txt', 'saved before switching\n');
  await page.locator('.markdown-preview').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.waitForFunction(() => window.__diffpane.stats().activeEditors === 1);
  await replace(page, '# Saved markdown\n');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await waitForDisk('b.md', '# Saved markdown\n');
  await page.waitForFunction(() =>
    document.querySelector('.markdown-preview')?.textContent.includes('Saved markdown'),
  );

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.waitForFunction(() => window.__diffpane.stats().activeEditors === 1);
  await replace(page, '# Saved before close\n');
  const closed = page.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await waitForDisk('b.md', '# Saved before close\n');
  assert.deepEqual(failures, []);
  console.log(
    'Autosave Electron checks passed: typing, undo, comparison, external sync, failure recovery, navigation, Markdown and close.',
  );
} catch (error) {
  const page = application?.windows()[0];
  if (page && !page.isClosed())
    console.error(
      await page.evaluate(async () => ({
        stats: window.__diffpane?.stats(),
        status: document.getElementById('save-state')?.textContent,
        message: document.getElementById('message')?.textContent,
        contents: [...document.querySelectorAll('.view-lines')].map(lines => lines.textContent),
        input: document.querySelector('textarea')?.outerHTML,
        file: await window.diffpane.document('a.txt', 'head'),
      })),
      failures,
    );
  throw error;
} finally {
  await chmod(path.join(root, 'a.txt'), 0o644).catch(() => {});
  await application?.close();
  await rm(root, { recursive: true, force: true });
}

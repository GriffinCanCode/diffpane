import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-live-loading-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-live-loading-profile-'));
let application;
let page;
const errors = [];

async function waitForRequests(count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await application.evaluate(() => globalThis.documentProbe.length)) >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${count} document requests`);
}

async function open(filename) {
  await page.locator('.navigator-search input').fill(filename);
  await page.locator(`.navigator-row[data-path="${filename}"]`).click();
}

async function resolveDocument(index, text, revision) {
  await application.evaluate(
    (_electron, { index, text, revision }) => {
      const work = globalThis.documentProbe[index];
      work.resolve({
        path: work.filename,
        before: '',
        after: text,
        decorations: [],
        editable: true,
        lineCount: 2,
        revision,
      });
    },
    { index, text, revision },
  );
}

try {
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'first.txt'), 'FIRST FILE\n');
  await writeFile(path.join(root, 'second.txt'), 'SECOND FILE\n');
  await writeFile(path.join(root, 'README.md'), '# Reading while edits arrive\n');
  application = await electron.launch({
    executablePath,
    args: ['.', path.join(root, 'first.txt'), `--user-data-dir=${profile}`],
    env: { ...process.env, DIFFPANE_HOWMANY_BINARY: path.join(root, 'missing-howmany') },
  });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.view-lines').waitFor();
  await page.waitForFunction(() => !window.__diffpane.stats().navigator.loading);
  const snapshot = await page.evaluate(() => window.diffpane.snapshot());
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.documentProbe = [];
    ipcMain.removeHandler('document');
    ipcMain.handle(
      'document',
      (_event, filename) =>
        new Promise(resolve => globalThis.documentProbe.push({ filename, resolve })),
    );
    BrowserWindow.getAllWindows()[0].webContents.send('paths', ['first.txt']);
  });
  await waitForRequests(1);
  await open('second.txt');
  await waitForRequests(2);
  await resolveDocument(1, 'SECOND FILE\n', snapshot.revision);
  await page.waitForFunction(
    () =>
      document.querySelector('.view-lines')?.textContent.includes('SECOND') &&
      !window.__diffpane.stats().documentLoading,
  );
  await resolveDocument(0, 'STALE FIRST FILE\n', snapshot.revision);
  assert.equal(await page.evaluate(() => window.__diffpane.stats().openedPath), 'second.txt');
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 1);
  assert.equal(await page.getByText('STALE FIRST FILE', { exact: true }).count(), 0);

  await open('README.md');
  await waitForRequests(3);
  // A later status snapshot must not keep the first successful read behind a placeholder.
  await application.evaluate(({ BrowserWindow }, snapshot) => {
    BrowserWindow.getAllWindows()[0].webContents.send('change', {
      ...snapshot,
      revision: snapshot.revision + 1,
      changedPaths: ['README.md'],
    });
  }, snapshot);
  await page.waitForFunction(
    revision => window.__diffpane.stats().snapshotRevision > revision,
    snapshot.revision,
  );
  await resolveDocument(2, '# Reading while edits arrive\n', snapshot.revision);
  await page
    .getByRole('heading', { name: 'Reading while edits arrive' })
    .waitFor({ timeout: 5000 });
  await waitForRequests(4);
  await resolveDocument(3, '# Latest saved contents\n', snapshot.revision + 1);
  await page.getByRole('heading', { name: 'Latest saved contents' }).waitFor();
  await page.waitForFunction(() => !window.__diffpane.stats().documentLoading);
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 0);

  await page.locator('.navigator-search input').fill('');
  await application.evaluate(({ ipcMain, BrowserWindow }, snapshot) => {
    globalThis.catalogProbe = [];
    ipcMain.removeHandler('files-delta');
    ipcMain.handle(
      'files-delta',
      () => new Promise(resolve => globalThis.catalogProbe.push(resolve)),
    );
    BrowserWindow.getAllWindows()[0].webContents.send('change', {
      ...snapshot,
      revision: snapshot.revision + 2,
      inventoryRevision: snapshot.inventoryRevision + 1,
      changedPaths: [],
    });
  }, snapshot);
  await page.waitForFunction(() => window.__diffpane.stats().navigator.loading);
  await application.evaluate(({ BrowserWindow }, snapshot) => {
    BrowserWindow.getAllWindows()[0].webContents.send('change', {
      ...snapshot,
      revision: snapshot.revision + 3,
      inventoryRevision: snapshot.inventoryRevision + 2,
      changedPaths: [],
    });
  }, snapshot);
  await page.waitForFunction(
    revision => window.__diffpane.stats().snapshotRevision === revision + 3,
    snapshot.revision,
  );
  await application.evaluate((_electron, revision) => {
    globalThis.catalogProbe[0]({
      reset: true,
      revision: revision + 1,
      files: [{ path: 'arriving.txt' }, { path: 'README.md' }],
      removed: [],
    });
  }, snapshot.inventoryRevision);
  // The first inventory must paint while its follow-up scan is still held.
  await page.locator('.navigator-row[data-path="arriving.txt"]').waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__diffpane.stats().navigator.loading), true);
  await application.evaluate((_electron, revision) => {
    globalThis.catalogProbe[1]({ reset: false, revision: revision + 2, files: [], removed: [] });
  }, snapshot.inventoryRevision);
  await page.waitForFunction(() => !window.__diffpane.stats().navigator.loading);
  assert.deepEqual(errors, []);
  console.log('Live loading: navigation, previews and inventory scans make progress during edits.');
} finally {
  // Release probes so normal close can finish even after an assertion failure.
  await application
    ?.evaluate(() => {
      for (const work of globalThis.documentProbe ?? [])
        work.resolve({ after: '', before: '', decorations: [], editable: false });
      for (const resolve of globalThis.catalogProbe ?? [])
        resolve({ reset: true, revision: 0, files: [], removed: [] });
    })
    .catch(() => {});
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

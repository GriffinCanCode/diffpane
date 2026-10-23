import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-startup-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-startup-profile-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
let application;
async function waitForRequests(count, releaseBackground = false) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (releaseBackground) {
      const page = await application.firstWindow();
      await page.evaluate(() => window.releaseBackgroundWork());
    }
    if ((await application.evaluate(() => globalThis.howmanyProbe.requests.length)) === count)
      return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${count} background requests`);
}
try {
  git('init', '-q');
  await writeFile(path.join(root, 'first.txt'), 'FIRST FILE\n');
  await writeFile(path.join(root, 'second.txt'), 'SECOND FILE\n');
  application = await electron.launch({
    executablePath,
    args: ['.', root, `--user-data-dir=${profile}`],
    env: { ...process.env, DIFFPANE_HOWMANY_BINARY: path.join(root, 'missing-howmany') },
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.view-lines').waitFor();
  await page.locator('.howmany-body').filter({ hasText: 'HowMany is unavailable' }).waitFor();
  // Hold both analysis responses indefinitely to prove file loading is independent.
  await application.evaluate(({ ipcMain }) => {
    globalThis.howmanyProbe = { requests: [], pending: [] };
    for (const channel of ['howmany-analyze', 'howmany-file']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, filename) => {
        globalThis.howmanyProbe.requests.push({ channel, filename });
        return new Promise(resolve => {
          globalThis.howmanyProbe.pending.push({ channel, filename, resolve });
        });
      });
    }
  });
  await page.context().addInitScript(() => {
    let sequence = 0;
    const callbacks = new Map();
    window.requestIdleCallback = callback => {
      callbacks.set(++sequence, callback);
      return sequence;
    };
    window.cancelIdleCallback = id => callbacks.delete(id);
    window.releaseBackgroundWork = () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback({ didTimeout: false, timeRemaining: () => 50 });
    };
    window.pendingBackgroundWork = () => callbacks.size;
  });
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.view-lines')
        ?.textContent.replaceAll('\u00a0', ' ')
        .includes('FIRST FILE') &&
      !window.__diffpane.stats().navigator.loading &&
      !window.__diffpane.stats().documentLoading &&
      window.pendingBackgroundWork() >= 2,
  );
  assert.equal(
    await application.evaluate(() => globalThis.howmanyProbe.requests.length),
    0,
    'workspace analysis and per-file counts must wait until files have rendered',
  );
  await page.evaluate(() => window.releaseBackgroundWork());
  await waitForRequests(2);
  assert.equal(await page.locator('.view-lines').isVisible(), true);
  // Navigation must work while both the workspace scan and first file count are stalled.
  await page.locator('.navigator-search input').fill('second.txt');
  await page.locator('.navigator-row[data-path="second.txt"]').click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.view-lines')
        ?.textContent.replaceAll('\u00a0', ' ')
        .includes('SECOND FILE') && window.pendingBackgroundWork() > 0,
  );
  // The editor paints before its counting callback is queued. Other idle work
  // can already be pending, so keep releasing idle turns until that request starts.
  await waitForRequests(3, true);
  await application.evaluate(() => {
    const basic = {
      total_files: 2,
      total_lines: 2,
      code_lines: 2,
      doc_lines: 0,
      comment_lines: 0,
      blank_lines: 0,
      total_size: 25,
    };
    for (const work of globalThis.howmanyProbe.pending) {
      work.resolve(
        work.channel === 'howmany-analyze'
          ? { status: 'ready', report: { basic }, message: '' }
          : { title: work.filename === 'second.txt' ? 'SECOND COUNTS' : 'STALE FIRST COUNTS' },
      );
    }
    globalThis.howmanyProbe.pending = [];
  });
  await page.locator('.howmany-counts').filter({ hasText: 'SECOND COUNTS' }).waitFor();
  assert.equal(await page.getByText('STALE FIRST COUNTS', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 1);
  assert.deepEqual(errors, []);
  console.log(
    'HowMany startup checks passed: files paint first, stalled analysis allows navigation, stale counts are discarded.',
  );
} catch (error) {
  if (application) {
    const page = await application.firstWindow();
    console.error(
      'Startup state',
      await page.evaluate(() => ({
        stats: window.__diffpane?.stats(),
        background: window.pendingBackgroundWork?.(),
        text: document.body.innerText,
      })),
    );
    console.error(
      'Analysis requests',
      await application.evaluate(() => globalThis.howmanyProbe?.requests),
    );
  }
  throw error;
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

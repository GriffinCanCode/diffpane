import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-idle-resume-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-idle-resume-profile-'));
const harness = await mkdtemp(path.join(os.tmpdir(), 'diffpane-idle-resume-app-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
let application;
let page;
const errors = [];

try {
  git('init', '-q');
  await mkdir(path.join(root, 'src'));
  await Promise.all(
    Array.from({ length: 500 }, (_, index) =>
      writeFile(path.join(root, `src/file${index}.txt`), `baseline ${index}\n`),
    ),
  );
  await writeFile(path.join(root, 'README.md'), '# Original document\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture');
  await writeFile(path.join(root, 'README.md'), '# Open document\n');

  // Force the actual session worker into fallback without a production test hook.
  const session = new URL('../electron/session.mjs', import.meta.url).href;
  const workerSource = `
    import watcher from ${JSON.stringify(import.meta.resolve('@parcel/watcher'))};
    watcher.subscribe = async () => { throw new Error('Forced watcher failure for idle-resume test'); };
    await import(${JSON.stringify(session)});
  `;
  await writeFile(
    path.join(harness, 'package.json'),
    JSON.stringify({ type: 'module', main: 'main.mjs' }),
  );
  await writeFile(
    path.join(harness, 'main.mjs'),
    `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const threads = createRequire(import.meta.url)('node:worker_threads');
    const NativeWorker = threads.Worker;
    threads.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(String(url) === ${JSON.stringify(session)}
          ? new URL(${JSON.stringify(`data:text/javascript,${encodeURIComponent(workerSource)}`)})
          : url, options);
      }
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(new URL('../electron/main.mjs', import.meta.url).href)});
  `,
  );
  application = await electron.launch({
    executablePath,
    args: [harness, root, `--user-data-dir=${profile}`],
    env: { ...process.env, DIFFPANE_HOWMANY_BINARY: path.join(profile, 'missing-howmany') },
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  application.process().stderr.on('data', value => {
    if (/FATAL|Uncaught|terminate called|libc\+\+abi/.test(String(value)))
      process.stderr.write(value);
  });
  await page.getByRole('heading', { name: 'Open document' }).waitFor();
  await page.locator('#message').filter({ hasText: 'Forced watcher failure' }).waitFor();
  await page.waitForFunction(
    () =>
      !window.__diffpane.stats().navigator.loading && !window.__diffpane.stats().documentLoading,
  );
  // Let the first polling baseline settle, then span several real fallback polls.
  await page.waitForTimeout(2500);
  const baseline = await page.evaluate(() => window.__diffpane.stats());
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await page.waitForTimeout(6500);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].show();
    BrowserWindow.getAllWindows()[0].focus();
  });
  await page.waitForFunction(() => document.visibilityState === 'visible');
  await page.waitForTimeout(300);
  const idle = await page.evaluate(() => window.__diffpane.stats());
  assert.equal(
    idle.snapshotRevision,
    baseline.snapshotRevision,
    'quiet fallback polls must not publish refreshes',
  );
  assert.equal(
    idle.navigator.catalogRequests,
    baseline.navigator.catalogRequests,
    'idle time must not rebuild the explorer',
  );
  await page.getByRole('heading', { name: 'Open document' }).waitFor();

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await writeFile(path.join(root, 'README.md'), '# Updated while away\n');
  await writeFile(path.join(root, 'new-file.txt'), 'NEW FILE AFTER IDLE\n');
  await page.waitForTimeout(4500);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].show();
    BrowserWindow.getAllWindows()[0].focus();
  });
  await page.getByRole('heading', { name: 'Updated while away' }).waitFor();
  await page.locator('.navigator-search input').fill('new-file.txt');
  await page.locator('.navigator-row[data-path="new-file.txt"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('NEW FILE AFTER IDLE'),
  );
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await page.locator('#file-search').fill('src/file49.txt');
  await page.locator('#file-list button[data-path="src/file49.txt"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('baseline 49'),
  );
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 1);
  assert.deepEqual(errors, []);
  console.log(
    'Idle resume: quiet fallback stays idle; background edits, new files, navigation and search recover on return.',
  );
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      await page.evaluate(() => ({
        stats: window.__diffpane?.stats(),
        text: document.body.innerText,
      })),
    );
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/idle-resume-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  await rm(harness, { recursive: true, force: true });
}

import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const count = Number(process.env.DIFFPANE_PERF_FILES || 50000);
const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-performance-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-performance-profile-'));
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const filename = index =>
  `src/package${String(Math.floor(index / 500)).padStart(3, '0')}/file${String(index).padStart(5, '0')}.txt`;
const bigDocument = marker =>
  `${marker}\n` +
  Array.from({ length: 29999 }, (_, index) => `line ${index}: unchanged code stays visible`).join(
    '\n',
  );
async function batch(size, action) {
  let next = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (next < size) await action(next++);
    }),
  );
}
let application;
let page;
const errors = [];
const metrics = { inventoryFiles: count };
try {
  git('init', '-q');
  for (let index = 0; index < Math.ceil(count / 500); index++)
    await mkdir(path.join(root, path.dirname(filename(index * 500))), { recursive: true });
  await batch(count, index =>
    writeFile(
      path.join(root, filename(index)),
      index === 0 ? bigDocument('INITIAL') : 'baseline\n',
    ),
  );
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
    'baseline',
  );
  // Ignored dependencies are as large as the tracked tree, but stay unindexed.
  await writeFile(path.join(root, '.git/info/exclude'), 'dependencies/\n');
  for (let index = 0; index < Math.ceil(count / 500); index++)
    await mkdir(path.join(root, 'dependencies', `package${index}`), { recursive: true });
  await batch(count, index =>
    writeFile(
      path.join(root, 'dependencies', `package${Math.floor(index / 500)}`, `ignored${index}.txt`),
      'ignored dependency\n',
    ),
  );
  metrics.ignoredFiles = count;
  const changedCount = Math.min(4000, count);
  await batch(changedCount, index =>
    writeFile(
      path.join(root, filename(index)),
      index === 0 ? bigDocument('OPENED') : `changed ${index}\n`,
    ),
  );
  const launchStart = performance.now();
  application = await electron.launch({
    executablePath,
    args: ['.', root, `--user-data-dir=${profile}`],
  });
  application.process().stderr.on('data', data => process.stderr.write(data));
  application
    .process()
    .on('exit', (code, signal) => console.error('Electron exit', { code, signal }));
  page = await application.firstWindow();
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) console.error(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(
    count =>
      window.__diffpane?.stats().navigator.inventoryFiles === count &&
      window.__diffpane.stats().models === 1 &&
      !window.__diffpane.stats().documentLoading,
    count,
    { timeout: 30000 },
  );
  metrics.readyMs = performance.now() - launchStart;
  assert.equal(await page.locator('.diff-word-added').count(), 0);
  assert.equal(await page.locator('#feed .file-card').count(), 1);
  assert.ok((await page.locator('.navigator-row').count()) < 60);
  const cold = await page.evaluate(() => window.__diffpane.stats());
  const ignoredStart = performance.now();
  await page.locator('.navigator-row[data-path="dependencies"]').click();
  await page.locator('.navigator-row[data-path="dependencies/package0"]').waitFor();
  assert.equal(
    (await page.evaluate(() => window.__diffpane.stats())).navigator.inventoryFiles,
    count,
  );
  await page.locator('.navigator-row[data-path="dependencies/package0"]').click();
  await page.waitForFunction(
    count =>
      window.__diffpane.stats().navigator.inventoryFiles === count + Math.min(500, count) &&
      !window.__diffpane.stats().navigator.loading,
    count,
  );
  metrics.ignoredExpansionMs = performance.now() - ignoredStart;
  await page.locator('.navigator-row[data-path="dependencies"]').click();
  await page.waitForFunction(
    count =>
      window.__diffpane.stats().navigator.inventoryFiles === count &&
      !window.__diffpane.stats().navigator.loading,
    count,
  );
  assert.equal(
    (await page.evaluate(() => window.__diffpane.stats())).navigator.treeNodes,
    cold.navigator.treeNodes,
  );
  assert.ok((await page.locator('.navigator-row').count()) < 60);
  const inventoryRequests = await page.evaluate(
    () => window.__diffpane.stats().navigator.catalogRequests,
  );
  await page.evaluate(() => {
    window.performanceFrames = [];
    let last;
    const frame = now => {
      if (last) window.performanceFrames.push(now - last);
      last = now;
      window.performanceFrame = requestAnimationFrame(frame);
    };
    window.performanceFrame = requestAnimationFrame(frame);
  });
  const start = performance.now();
  // Parallel writers change 128 paths while the open 30,000-line document receives successive saves.
  for (let round = 0; round < 4; round++) {
    await Promise.all([
      batch(128, index =>
        writeFile(path.join(root, filename(index + 1)), `round ${round}, writer ${index}\n`),
      ),
      writeFile(path.join(root, filename(0)), bigDocument(`LIVE_ROUND_${round}`)),
    ]);
  }
  await page.waitForFunction(
    () => document.querySelector('.view-lines')?.textContent.includes('LIVE_ROUND_3'),
    undefined,
    { timeout: 10000 },
  );
  metrics.burstMs = performance.now() - start;
  await page.waitForTimeout(350);
  const current = await page.evaluate(() => window.__diffpane.stats());
  assert.equal(current.models, 1);
  assert.equal(
    current.navigator.catalogRequests,
    inventoryRequests,
    'content saves must not rebuild the 50k-file explorer',
  );
  assert.ok(current.navigator.mountedRows < 60);

  await page
    .locator('.navigator-action[data-action="open-file"]')
    .evaluate(button => button.click());
  await page.waitForFunction(
    count =>
      document.querySelector('.picker-summary')?.textContent.startsWith(count.toLocaleString()),
    count,
  );
  const searchStart = performance.now();
  // Only the newest query may publish results, even when queries overlap the worker's execution.
  await page.locator('#file-search').fill('file1');
  await page.locator('#file-search').fill('file2');
  await page.locator('#file-search').fill('file00042.txt');
  await page.waitForFunction(
    () => document.querySelector('.picker-summary')?.textContent.startsWith('1 file found'),
    undefined,
    { timeout: 10000 },
  );
  metrics.searchMs = performance.now() - searchStart;
  assert.equal(await page.locator('#file-list button').count(), 1);
  assert.equal(await page.locator('#file-list button').getAttribute('data-path'), filename(42));
  await page.locator('#file-list button').evaluate(button => button.click());
  await page.waitForFunction(
    path =>
      window.__diffpane.stats().openedPath === path &&
      window.__diffpane.stats().models === 1 &&
      !window.__diffpane.stats().documentLoading,
    filename(42),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('round 3, writer 41'),
  );
  // Revisit the large document through cached contents and retained view state.
  await page
    .locator('.navigator-action[data-action="open-file"]')
    .evaluate(button => button.click());
  await page.locator('#file-search').fill('file00000.txt');
  await page.waitForFunction(() =>
    document.querySelector('.picker-summary')?.textContent.startsWith('1 file found'),
  );
  await page.locator('#file-list button').evaluate(button => button.click());
  await page.waitForFunction(() =>
    document.querySelector('.view-lines')?.textContent.includes('LIVE_ROUND_3'),
  );
  metrics.frames = await page.evaluate(() => {
    cancelAnimationFrame(window.performanceFrame);
    const values = window.performanceFrames.sort((a, b) => a - b);
    return {
      count: values.length,
      p95Ms: values[Math.floor(values.length * 0.95)],
      maxMs: Math.max(...values),
      over100Ms: values.filter(value => value > 100).length,
    };
  });
  metrics.stats = await page.evaluate(() => window.__diffpane.stats());
  assert.equal(metrics.stats.models, 1);
  assert.ok(
    metrics.frames.p95Ms < 100,
    `UI stalls during background work: ${JSON.stringify(metrics.frames)}`,
  );
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/performance.json',
    JSON.stringify({ ...metrics, rendererErrors: errors }, null, 2),
  );
  await page.screenshot({ path: 'test-results/performance.png' });
  console.log(JSON.stringify({ ...metrics, rendererErrors: errors }, null, 2));
} catch (error) {
  console.error('Performance metrics before failure', metrics);
  if (page && !page.isClosed()) {
    console.error('App state', await page.evaluate(() => window.__diffpane?.stats()));
    console.error((await page.locator('body').innerText()).slice(-3000));
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/performance-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

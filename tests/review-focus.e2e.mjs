import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-review-focus-'));
const root = path.join(directory, 'workspace');
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const file = 'file-watcher.ts';
const baseline = [
  'export function fileEvent() {',
  "  return 'FILE_SAVED';",
  '}',
  '',
  ...Array.from({ length: 184 }, (_, index) => {
    const channel = index + 1;
    return `export const channel${channel} = 'channel-${channel}';`;
  }),
  '',
  'export function pollState() {',
  "  return 'POLL_ACTIVE';",
  '}',
  '',
].join('\n');
const changed = baseline.replace('FILE_SAVED', 'FILE_UPDATED').replace('POLL_ACTIVE', 'POLL_IDLE');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const errors = [];
let application;

try {
  await mkdir(root);
  await Promise.all([
    writeFile(path.join(root, file), baseline),
    writeFile(path.join(root, 'notes.txt'), 'Watcher notes\n'),
  ]);
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
    'baseline',
  );
  await writeFile(path.join(root, file), changed);

  const args = process.env.DIFFPANE_EXECUTABLE ? [] : [process.env.DIFFPANE_TEST_APP || '.'];
  args.push(root, `--user-data-dir=${path.join(directory, 'profile')}`);
  application = await electron.launch({
    executablePath: process.env.DIFFPANE_EXECUTABLE || executablePath,
    args,
    env: { ...process.env, DIFFPANE_DEV_SERVER_URL: '' },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1400, height: 900 });

  const reviewToggle = page.getByRole('button', { name: 'Review changes', exact: true });
  const review = page.locator('#change-review');
  const position = page.locator('.review-hunk-position');
  const focusChanges = page.getByRole('button', { name: 'Focus changes', exact: true });
  const fullFile = page.getByRole('button', { name: 'Full file', exact: true });
  const previous = page.getByRole('button', { name: 'Previous change in file', exact: true });
  const next = page.getByRole('button', { name: 'Next change in file', exact: true });
  const diff = page.locator('#feed .monaco-diff-editor');
  const original = diff.locator('.original .view-line');
  const working = diff.locator('.modified .view-line');
  const foldedContext = diff.getByText(/\d+ hidden lines/u);

  async function waitForComparison() {
    await page.waitForFunction(name => {
      const state = window.__diffpane?.stats();
      return state?.openedPath === name && state.diffMode && !state.documentLoading;
    }, file);
  }

  await reviewToggle.waitFor();
  await page.keyboard.press(`${modifier}+Shift+g`);
  await review.getByRole('listbox', { name: 'Changed files' }).waitFor();
  await review.locator(`.change-review-row[data-path="${file}"]`).click();
  await waitForComparison();
  await position.filter({ hasText: /^1 of 2$/u }).waitFor();
  assert.equal(await focusChanges.getAttribute('aria-pressed'), 'true');
  assert.equal(await fullFile.getAttribute('aria-pressed'), 'false');
  await original.filter({ hasText: 'FILE_SAVED' }).waitFor();
  await working.filter({ hasText: 'FILE_UPDATED' }).waitFor();
  await foldedContext.first().waitFor();
  assert.equal(await working.filter({ hasText: 'channel176' }).count(), 0);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/review-focus.png' });

  await next.click();
  await position.filter({ hasText: /^2 of 2$/u }).waitFor();
  await original.filter({ hasText: 'POLL_ACTIVE' }).waitFor();
  await working.filter({ hasText: 'POLL_IDLE' }).waitFor();
  await previous.click();
  await position.filter({ hasText: /^1 of 2$/u }).waitFor();
  await working.filter({ hasText: 'FILE_UPDATED' }).waitFor();
  await next.click();
  await position.filter({ hasText: /^2 of 2$/u }).waitFor();

  await fullFile.click();
  assert.equal(await focusChanges.getAttribute('aria-pressed'), 'false');
  assert.equal(await fullFile.getAttribute('aria-pressed'), 'true');
  await foldedContext.first().waitFor({ state: 'hidden' });
  await position.filter({ hasText: /^2 of 2$/u }).waitFor();
  await working.filter({ hasText: 'channel176' }).waitFor();
  await working.filter({ hasText: 'POLL_IDLE' }).waitFor();

  await page.setViewportSize({ width: 650, height: 700 });
  await focusChanges.click();
  await diff.locator('.line-delete-selectable').first().waitFor();
  await foldedContext.first().waitFor();
  await position.filter({ hasText: /^2 of 2$/u }).waitFor();
  assert.equal(await focusChanges.getAttribute('aria-pressed'), 'true');
  for (const control of [previous, next, focusChanges, fullFile]) {
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 650, 'Review controls fit');
  }
  await previous.click();
  await position.filter({ hasText: /^1 of 2$/u }).waitFor();
  await working.filter({ hasText: 'FILE_UPDATED' }).waitFor();
  await working.filter({ hasText: 'FILE_SAVED' }).waitFor();
  await page.screenshot({ path: 'test-results/review-focus-narrow.png' });

  await reviewToggle.click();
  await review.waitFor({ state: 'hidden' });
  const explorer = page.locator('#navigator');
  await explorer.locator('.navigator-row[data-path="notes.txt"]').click();
  await page.locator('#feed [data-path="notes.txt"] .view-lines').waitFor();
  await explorer.locator(`.navigator-row[data-path="${file}"]`).click();
  await page.getByRole('button', { name: 'Compare whole file', exact: true }).click();
  await waitForComparison();
  await position.waitFor({ state: 'hidden' });
  await focusChanges.waitFor({ state: 'hidden' });
  await foldedContext.first().waitFor({ state: 'hidden' });
  await original.filter({ hasText: 'channel10' }).first().waitFor();
  await working.filter({ hasText: 'channel10' }).first().waitFor();

  assert.deepEqual(errors, []);
  console.log('Verified focused review, hunk navigation, full file context, and narrow controls.');
} catch (error) {
  const page = application?.windows()[0];
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(() => window.__diffpane?.stats()), errors);
    console.error((await page.locator('body').innerText()).slice(0, 4000));
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/review-focus-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true });
}

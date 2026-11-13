import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-review-'));
const root = path.join(directory, 'workspace');
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const write = (file, text) => writeFile(path.join(root, file), text);
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const baseline = [
  'FIRST_ORIGINAL',
  ...Array.from({ length: 150 }, (_, index) => `unchanged line ${index + 1}`),
  'LAST_ORIGINAL',
  '',
].join('\n');
const changed = baseline
  .replace('FIRST_ORIGINAL', 'FIRST_EDIT')
  .replace('LAST_ORIGINAL', 'LAST_EDIT');
let application;
const errors = [];

try {
  await mkdir(root);
  await Promise.all([
    write('a-modified.txt', baseline),
    write('b-deleted.txt', 'DELETED_TEXT\n'),
    write('c-original.txt', 'RENAME_ORIGINAL\nretained\n'),
    write('d-unrelated.txt', 'UNRELATED_ORIGINAL\n'),
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
  git('mv', 'c-original.txt', 'c-renamed.txt');
  await Promise.all([
    write('a-modified.txt', changed),
    rm(path.join(root, 'b-deleted.txt')),
    write('c-renamed.txt', 'RENAME_EDIT\nretained\n'),
  ]);

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
  const explorer = page.locator('#navigator');
  const panel = page.locator('#change-review');
  const list = panel.getByRole('listbox', { name: 'Changed files' });
  const row = file => panel.locator(`.change-review-row[data-path="${file}"]`);
  const count = text => panel.locator('.change-review-count').filter({ hasText: text });
  const toggle = page.getByRole('button', { name: 'Review changes', exact: true });
  const badge = toggle.locator('.review-count');
  const back = panel.getByRole('button', { name: 'Back to files' });
  const pending = panel.getByRole('button', { name: 'Pending', exact: true });
  const reviewed = panel.getByRole('button', { name: 'Reviewed', exact: true });
  const progress = panel.getByRole('progressbar');
  const mark = panel.getByRole('button', { name: 'Mark reviewed & next' });
  const original = page.locator('#feed .monaco-diff-editor .original .view-lines');
  const working = page.locator('#feed .monaco-diff-editor .modified .view-lines');

  async function waitForComparison(file) {
    await page.waitForFunction(name => {
      const state = window.__diffpane?.stats();
      return state?.openedPath === name && state.diffMode && !state.documentLoading;
    }, file);
  }

  await explorer.locator('.navigator-row[data-path="d-unrelated.txt"]').waitFor();
  assert.equal(await explorer.locator('.navigator-row[data-path="b-deleted.txt"]').count(), 0);
  await page.keyboard.press(`${modifier}+Shift+g`);
  await list.waitFor();
  await panel.getByRole('heading', { name: 'Review queue' }).waitFor();
  await count('0 of 3 reviewed').waitFor();
  assert.equal(await list.evaluate(element => element === document.activeElement), true);
  assert.equal(await progress.evaluate(element => element.position), 0);
  assert.equal(await badge.textContent(), '3');
  assert.equal(await toggle.getAttribute('aria-description'), '3 files pending');
  await panel.getByRole('button', { name: 'Open comparison' }).waitFor();
  await reviewed.click();
  await panel.getByRole('heading', { name: 'No files reviewed yet' }).waitFor();
  await panel.getByRole('button', { name: 'Show pending files' }).click();
  assert.equal(await list.evaluate(element => element === document.activeElement), true);
  await list.press('ArrowDown');
  assert.equal(
    await list.getAttribute('aria-activedescendant'),
    await row('b-deleted.txt').getAttribute('id'),
  );
  await list.press('Home');
  await list.press('Enter');
  await waitForComparison('a-modified.txt');
  assert.equal(await row('a-modified.txt').getAttribute('aria-selected'), 'true');
  await original.getByText('FIRST_ORIGINAL', { exact: true }).waitFor();
  await working.getByText('FIRST_EDIT', { exact: true }).waitFor();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/change-review.png' });

  const separator = page.getByRole('separator', { name: 'Sidebar width' });
  const normalWidth = await panel.evaluate(element => element.clientWidth);
  for (let step = 0; step < 8; step++) await separator.press('ArrowLeft');
  assert.equal(await separator.getAttribute('aria-valuenow'), '180');
  await list.focus();
  assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  const queueBounds = await panel.boundingBox();
  const markBounds = await mark.boundingBox();
  assert.ok(markBounds.x >= queueBounds.x);
  assert.ok(markBounds.x + markBounds.width <= queueBounds.x + queueBounds.width);
  await page.screenshot({ path: 'test-results/change-review-narrow.png' });
  for (let width = 180; width < normalWidth; width += 16) await separator.press('ArrowRight');

  await page.getByRole('button', { name: 'Next change in file' }).click();
  await working.getByText('LAST_EDIT', { exact: true }).waitFor();

  await mark.click();
  await count('1 of 3 reviewed').waitFor();
  assert.equal(await progress.evaluate(element => element.position), 1 / 3);
  assert.equal(await badge.textContent(), '2');
  await row('a-modified.txt').waitFor({ state: 'hidden' });
  await waitForComparison('b-deleted.txt');
  await original.getByText('DELETED_TEXT', { exact: true }).waitFor();
  assert.equal(await working.getByText('DELETED_TEXT', { exact: true }).count(), 0);
  assert.equal(await page.locator('#save-state').textContent(), 'Read only');

  await panel.getByRole('button', { name: 'Next changed file' }).click();
  await waitForComparison('c-renamed.txt');
  await original.getByText('RENAME_ORIGINAL', { exact: true }).waitFor();
  await working.getByText('RENAME_EDIT', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Previous changed file' }).click();
  await waitForComparison('b-deleted.txt');

  await write('d-unrelated.txt', 'UNRELATED_EDIT\n');
  await row('d-unrelated.txt').waitFor();
  await count('1 of 4 reviewed').waitFor();
  await reviewed.click();
  await row('a-modified.txt').waitFor();
  await row('d-unrelated.txt').waitFor({ state: 'hidden' });
  await toggle.click();
  await panel.waitFor({ state: 'hidden' });
  await toggle.click();
  await count('1 of 4 reviewed').waitFor();
  await reviewed.click();
  await row('a-modified.txt').waitFor();

  await write('a-modified.txt', changed.replace('FIRST_EDIT', 'FIRST_EXTERNAL_EDIT'));
  await count('0 of 4 reviewed').waitFor();
  await row('a-modified.txt').waitFor({ state: 'hidden' });
  await pending.click();
  await row('a-modified.txt').click();
  await waitForComparison('a-modified.txt');
  await working.getByText('FIRST_EXTERNAL_EDIT', { exact: true }).waitFor();

  await working.getByText('FIRST_EXTERNAL_EDIT', { exact: true }).click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText('AUTOSAVED_IN_REVIEW\n');
  await page
    .locator('#save-state')
    .filter({ hasText: /^Saved$/u })
    .waitFor();
  assert.equal(await readFile(path.join(root, 'a-modified.txt'), 'utf8'), 'AUTOSAVED_IN_REVIEW\n');
  await original.getByText('FIRST_ORIGINAL', { exact: true }).waitFor();
  await working.getByText('AUTOSAVED_IN_REVIEW', { exact: true }).waitFor();
  assert.equal(
    git('diff', '--cached', '--name-status').toString().trim(),
    'R100\tc-original.txt\tc-renamed.txt',
  );

  await write('a-modified.txt', 'EXTERNAL_WHILE_COMPARING\n');
  await working.getByText('EXTERNAL_WHILE_COMPARING', { exact: true }).waitFor();
  await original.getByText('FIRST_ORIGINAL', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 2);

  await write('e-new.md', '# New review document\n');
  await row('e-new.md').click();
  await waitForComparison('e-new.md');
  await working.getByText('New review document', { exact: false }).waitFor();
  assert.equal(await original.getByText('New review document', { exact: false }).count(), 0);

  await row('a-modified.txt').click();
  await waitForComparison('a-modified.txt');
  for (const [reviewedCount, file] of [
    [1, 'b-deleted.txt'],
    [2, 'c-renamed.txt'],
    [3, 'd-unrelated.txt'],
    [4, 'e-new.md'],
  ]) {
    await mark.click();
    await count(`${reviewedCount} of 5 reviewed`).waitFor();
    await waitForComparison(file);
  }
  const markLast = panel.getByRole('button', { name: 'Mark reviewed', exact: true });
  await markLast.click();
  await panel.getByRole('heading', { name: 'Review complete' }).waitFor();
  await count('5 of 5 reviewed').waitFor();
  assert.equal(await progress.evaluate(element => element.position), 1);
  assert.equal(await badge.textContent(), '✓');
  assert.equal(await toggle.getAttribute('aria-description'), 'All changes reviewed');
  await page.screenshot({ path: 'test-results/change-review-complete.png' });

  await panel.getByRole('button', { name: 'View reviewed files' }).click();
  assert.equal(await list.evaluate(element => element === document.activeElement), true);
  await row('a-modified.txt').click();
  await waitForComparison('a-modified.txt');
  await working.getByText('EXTERNAL_WHILE_COMPARING', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Return to pending' }).click();
  await count('4 of 5 reviewed').waitFor();
  assert.equal(await pending.getAttribute('aria-pressed'), 'true');
  await row('a-modified.txt').waitFor();
  await markLast.click();
  await panel.getByRole('heading', { name: 'Review complete' }).waitFor();

  git('add', '-A');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'finish review',
  );
  const clean = panel.getByRole('heading', { name: 'Working tree is clean' });
  await clean.waitFor();
  await badge.waitFor({ state: 'hidden' });

  await back.click();
  await panel.waitFor({ state: 'hidden' });
  await page.keyboard.press(`${modifier}+Shift+g`);
  assert.equal(await clean.evaluate(element => element === document.activeElement), true);
  await back.click();
  await explorer.locator('.navigator-row[data-path="d-unrelated.txt"]').waitFor();
  await explorer.locator('.navigator-row[data-path="d-unrelated.txt"]').click();
  await page.waitForFunction(() => {
    const state = window.__diffpane.stats();
    return state.openedPath === 'd-unrelated.txt' && !state.diffMode && state.models === 1;
  });

  await write('a-modified.txt', 'RETRY_COMPARISON_EDIT\n');
  await toggle.click();
  await count('0 of 1 reviewed').waitFor();
  const retryDocument = await page.evaluate(() => window.diffpane.document('a-modified.txt'));
  await application.evaluate(({ ipcMain }, result) => {
    let requests = 0;
    const failure = new Promise(resolve => {
      globalThis.failReviewRead = () => resolve({ error: 'Could not read this comparison' });
    });
    ipcMain.removeHandler('document');
    ipcMain.handle('document', () => (++requests === 1 ? failure : result));
  }, retryDocument);
  await panel.getByRole('button', { name: 'Open comparison' }).click();
  const loading = panel.getByRole('button', { name: 'Loading comparison…' });
  await loading.waitFor();
  assert.equal(await loading.isDisabled(), true);
  const failure = page.getByText('Could not read this comparison', { exact: true });
  await application.evaluate(() => globalThis.failReviewRead());
  await failure.waitFor();
  await panel.getByRole('button', { name: 'Retry comparison' }).click();
  await working.getByText('RETRY_COMPARISON_EDIT', { exact: true }).waitFor();
  await failure.waitFor({ state: 'hidden' });
  await markLast.click();
  await panel.getByRole('heading', { name: 'Review complete' }).waitFor();

  assert.deepEqual(errors, []);
  console.log('Verified live review, progress, completion, narrow layout, autosave, and retry.');
} catch (error) {
  const page = application?.windows()[0];
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(() => window.__diffpane?.stats()), errors);
    console.error((await page.locator('body').innerText()).slice(0, 4000));
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/change-review-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true });
}

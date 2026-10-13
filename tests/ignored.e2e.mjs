import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-ignored-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-ignored-profile-'));
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
let application;
const errors = [];
try {
  git('init', '-q');
  await mkdir(path.join(root, 'src/cache/deep'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'src/cache/\n*.log\n');
  await writeFile(path.join(root, 'src/main.txt'), 'regular document\n');
  await writeFile(path.join(root, 'src/cache/direct.txt'), 'ignored document\n');
  await writeFile(path.join(root, 'src/cache/deep/child.txt'), 'deep ignored document\n');
  await writeFile(path.join(root, 'debug.log'), 'ignored log\n');
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
  application = await electron.launch({
    executablePath,
    args: ['.', root, `--user-data-dir=${profile}`],
  });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const row = name => page.locator(`.navigator-row[data-path="${name}"]`);
  const waitFiles = count =>
    page.waitForFunction(count => {
      const stats = window.__diffpane?.stats();
      return stats?.navigator.inventoryFiles === count && !stats.navigator.loading;
    }, count);
  await waitFiles(3);
  const cold = await page.evaluate(() => window.__diffpane.stats());
  assert.equal(cold.models, 0);
  assert.equal(await row('debug.log').getAttribute('data-ignored'), 'true');
  assert.equal(
    await row('debug.log')
      .locator('.navigator-name')
      .evaluate(element => getComputedStyle(element).color),
    'rgb(150, 150, 150)',
  );
  assert.equal(
    await row('debug.log')
      .locator('.navigator-icon')
      .evaluate(element => getComputedStyle(element).opacity),
    '0.65',
  );
  assert.equal(await row('src/cache/direct.txt').count(), 0);
  await row('src').click();
  assert.equal(await row('src/cache').getAttribute('data-ignored'), 'true');
  assert.equal(await row('src/cache').getAttribute('aria-expanded'), 'false');
  await row('src/cache').click();
  await waitFiles(4);
  assert.equal(await row('src/cache/direct.txt').getAttribute('data-ignored'), 'true');
  assert.equal(await row('src/cache/deep/child.txt').count(), 0);
  assert.equal((await page.evaluate(() => window.__diffpane.stats())).models, 0);
  await row('src/cache/deep').click();
  await waitFiles(5);
  await row('src/cache/direct.txt').click();
  await page.waitForFunction(
    () =>
      window.__diffpane.stats().openedPath === 'src/cache/direct.txt' &&
      !window.__diffpane.stats().documentLoading,
  );
  await row('src').click();
  await waitFiles(3);
  assert.equal(
    (await page.evaluate(() => window.__diffpane.stats())).navigator.treeNodes,
    cold.navigator.treeNodes,
  );
  assert.equal(await row('src/cache/direct.txt').count(), 0);
  // A selected ignored file remains available when its tree branch is released.
  await page.evaluate(() =>
    window.diffpane.save('src/cache/direct.txt', 'saved_after_collapse\n', 'ignored document\n'),
  );
  await page.waitForFunction(() =>
    document.querySelector('.view-lines')?.textContent.includes('saved_after_collapse'),
  );
  await row('src').click();
  await row('src/cache').click();
  await waitFiles(4);
  assert.equal(await row('src/cache/deep').getAttribute('aria-expanded'), 'false');
  assert.equal(await row('src/cache/deep/child.txt').count(), 0);
  await writeFile(path.join(root, 'src/cache/new.txt'), 'new ignored file\n');
  await waitFiles(5);
  await row('src/cache/new.txt').waitFor();
  await page.locator('[data-action="collapse"]').click();
  await waitFiles(3);
  await row('src').click();
  await row('src/cache').click();
  await waitFiles(5);
  await page.keyboard.press('ArrowLeft');
  await waitFiles(3);
  await writeFile(path.join(root, 'src/cache/collapsed.txt'), 'created while collapsed\n');
  await page.keyboard.press('ArrowRight');
  await waitFiles(6);
  // Changing ignore rules updates both directory and file metadata in place.
  await writeFile(path.join(root, '.gitignore'), '');
  await waitFiles(7);
  assert.equal(await row('debug.log').getAttribute('data-ignored'), 'false');
  assert.equal(await row('src/cache').getAttribute('data-ignored'), 'false');
  assert.equal(await row('src/cache/direct.txt').getAttribute('data-ignored'), 'false');
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/ignored.png' });
  console.log(
    'Ignored explorer checks passed: muted styling, shallow loads, collapse cleanup, saves, live creation and ignore-rule changes.',
  );
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

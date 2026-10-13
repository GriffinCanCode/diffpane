import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-app-'));
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const source = (file, edited = false) =>
  Array.from(
    { length: file ? 24 : 4000 },
    (_, i) => `export const value${i} = ${edited && i === 30 ? 99999 : i};`,
  ).join('\n') + '\n';
git('init', '-q');
for (let file = 0; file < 80; file++)
  await writeFile(path.join(root, `${String(file).padStart(3, '0')}-sample.ts`), source(file));
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
  'initial',
);
for (let file = 0; file < 80; file++)
  await writeFile(
    path.join(root, `${String(file).padStart(3, '0')}-sample.ts`),
    source(file, true) + '// updated\n',
  );
const packaged = process.env.DIFFPANE_EXECUTABLE;
const application = await electron.launch({
  executablePath: packaged || executablePath,
  args: packaged ? [root] : [process.env.DIFFPANE_TEST_APP || '.', root],
});
const page = await application.firstWindow();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function open(file) {
  await page.locator('.navigator-search input').fill(file);
  await page.locator(`.navigator-row[data-path="${file}"]`).click();
  await page.locator(`#feed [data-path="${file}"] .view-lines`).waitFor();
}
try {
  await page.waitForFunction(
    () =>
      window.__diffpane?.stats().navigator.inventoryFiles === 80 &&
      window.__diffpane.stats().activeEditors === 1,
    undefined,
    { timeout: 15000 },
  );
  assert.equal(
    await page.locator('.toolbar, .view-switch').count(),
    0,
    'the duplicate banner and modes must be removed',
  );
  assert.equal(
    await page.locator('#feed .file-card').count(),
    1,
    'many changed files still open only one editor',
  );
  await open('000-sample.ts');
  await page.locator('#feed .monaco-editor').hover();
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(350);
  const before = await page.locator('.view-line').first().innerText();
  assert.ok(!before.includes('value0 ='), 'the complete document scrolls beyond the first line');
  const start = performance.now();
  await writeFile(
    path.join(root, '000-sample.ts'),
    source(0, true).replace('value30 = 99999', 'value30 = 88888') + '// changed again\n',
  );
  await page.waitForFunction(
    () => document.querySelector('.view-lines')?.textContent.includes('88888'),
    undefined,
    { timeout: 5000 },
  );
  const liveSaveMs = performance.now() - start;
  assert.equal(
    await page.locator('.view-line').first().innerText(),
    before,
    'live saves retain the visible code',
  );
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 1);
  await page.evaluate(
    () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const overview = await page.locator('#feed .decorationsOverviewRuler').evaluate(canvas => {
    const { data, width, height } = canvas
      .getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height);
    const colors = new Set(['71,125,146', '82,120,91', '172,98,102']);
    let widest = 0;
    for (let row = 0; row < height; row++) {
      let pixels = 0;
      for (let column = 0; column < width; column++) {
        const offset = (row * width + column) * 4;
        if (
          data[offset + 3] &&
          colors.has(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`)
        )
          pixels++;
      }
      widest = Math.max(widest, pixels);
    }
    return { widest, width };
  });
  assert.ok(
    overview.widest > 0 && overview.widest <= overview.width / 3 + 1,
    JSON.stringify(overview),
  );

  await open('079-sample.ts');
  assert.equal(
    await page.evaluate(() => window.__diffpane.stats().models),
    1,
    'switching files disposes the previous model',
  );
  await page.setViewportSize({ width: 800, height: 700 });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await open('000-sample.ts');
  await page.locator('.navigator-search input').fill('');
  await page.locator('.navigator-tree').focus();
  await page.setViewportSize({ width: 1400, height: 960 });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/app.png' });
  const stats = await page.evaluate(() => window.__diffpane.stats());
  assert.deepEqual(errors, [], 'renderer must not throw during browsing, editing or resizing');
  console.log(
    JSON.stringify({ changedFiles: 80, stats, liveSaveMs, rendererErrors: errors }, null, 2),
  );
} catch (error) {
  console.error('renderer errors', errors);
  console.error(await page.locator('body').innerText());
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/failure.png' });
  throw error;
} finally {
  await application.close();
  await rm(root, { recursive: true, force: true });
}

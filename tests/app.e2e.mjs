import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-app-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q');
for (let file = 0; file < 80; file++) {
  const lines = file ? 24 : 4000;
  await writeFile(path.join(root, `${String(file).padStart(3, '0')}-sample.ts`), Array.from({ length: lines }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n');
}
git('add', '.');
git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial');
for (let file = 0; file < 80; file++) {
  const lines = file ? 24 : 4000;
  await writeFile(path.join(root, `${String(file).padStart(3, '0')}-sample.ts`), Array.from({ length: lines }, (_, i) => `export const value${i} = ${i === 30 ? 99999 : i};`).join('\n') + '\n// updated\n');
}
const application = await electron.launch({ executablePath, args: ['.', root], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
const page = await application.firstWindow();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.waitForFunction(() => window.__diffpane?.stats().files === 80 && window.__diffpane.stats().activeEditors > 0, undefined, { timeout: 15000 });
  await page.locator('#navigator').waitFor({ state: 'visible' });
  assert.equal(await page.locator('aside#navigator').count(), 1, 'the project explorer should be visible beside changes');
  assert.equal(await page.getByText('ORIGINAL · HEAD').count(), 0);
  await page.locator('#filter').fill('000-sample');
  await page.waitForFunction(() => document.querySelector('.file-card:not([hidden]) .monaco-editor'));
  await page.locator('.file-card:not([hidden]) .monaco-editor').hover();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => document.querySelector('.file-card:not([hidden]) .view-lines').textContent);
  const start = performance.now();
  await writeFile(path.join(root, '000-sample.ts'), Array.from({ length: 4000 }, (_, i) => `export const value${i} = ${i === 50 ? 88888 : i === 30 ? 99999 : i};`).join('\n') + '\n// changed again\n');
  await page.waitForFunction(() => document.querySelector('.file-card:not([hidden]) .view-lines').textContent.includes('88888'), undefined, { timeout: 5000 });
  const liveSaveMs = performance.now() - start;
  const after = await page.evaluate(() => document.querySelector('.file-card:not([hidden]) .view-lines').textContent);
  assert.ok(before.includes('value') && after.includes('value'), 'real code should remain painted during an edit');
  const modelCount = await page.evaluate(() => window.__diffpane.stats().models);
  assert.equal(modelCount, 1);
  await page.locator('#filter').fill('');
  await page.locator('#feed-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('[data-path="079-sample.ts"] .monaco-editor'));
  const stats = await page.evaluate(() => window.__diffpane.stats());
  assert.ok(stats.models <= 6, JSON.stringify(stats));
  await page.locator('#feed-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('[data-path="000-sample.ts"] .monaco-editor'));
  await page.setViewportSize({ width: 800, height: 700 });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1400, height: 960 });
  await page.locator('#filter').fill('000-sample');
  await page.waitForFunction(() => document.querySelector('.file-card:not([hidden]) .monaco-editor'));
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/app.png' });
  assert.deepEqual(errors, [], 'renderer must not throw during scrolling, editing or resizing');
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics().map(({type, memory, cpu}) => ({type, memory, cpu})));
  console.log(JSON.stringify({ files: 80, stats, liveSaveMs, metrics, rendererErrors: errors }, null, 2));
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

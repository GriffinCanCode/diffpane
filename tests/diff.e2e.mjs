import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-diff-'));
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const before =
  'export function changed() {\n  return "BEFORE_VALUE";\n}\n\nexport function untouched() {\n  return "UNCHANGED_FUNCTION";\n}\n';
const after = before.replace('BEFORE_VALUE', 'AFTER_VALUE');
let application;
const errors = [];
try {
  git('init', '-q');
  await writeFile(path.join(root, 'functions.ts'), before);
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
  await writeFile(path.join(root, 'functions.ts'), after);
  application = await electron.launch({ executablePath, args: ['.', root] });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(
    () => window.__diffpane?.stats().models === 1 && !window.__diffpane.stats().documentLoading,
  );
  const toggle = page.getByRole('button', { name: 'Compare whole file', exact: true });
  assert.equal(
    (await toggle.innerText()).trim(),
    '',
    'the mode control is a glyph, not a word label',
  );
  assert.equal(await page.locator('.diff-word-added').count(), 0);
  await toggle.click();
  await page.waitForFunction(
    () => window.__diffpane.stats().diffMode && window.__diffpane.stats().models === 2,
  );
  const original = page.locator('.monaco-diff-editor .original .view-lines');
  const modified = page.locator('.monaco-diff-editor .modified .view-lines');
  await original.getByText('"BEFORE_VALUE"', { exact: false }).first().waitFor();
  assert.ok(
    (await original.innerText()).includes('UNCHANGED_FUNCTION'),
    'the whole original file stays visible',
  );
  assert.ok((await modified.innerText()).includes('AFTER_VALUE'));
  assert.ok(
    (await modified.innerText()).includes('UNCHANGED_FUNCTION'),
    'the whole current file stays visible',
  );
  await page.locator('.diff-function-before').first().waitFor();
  await page.locator('.diff-function-after').first().waitFor();
  assert.equal(await page.evaluate(() => window.__diffpane.stats().changedFunctions), 1);
  assert.equal(await page.locator('.diff-word-added').count(), 0);
  await writeFile(path.join(root, 'functions.ts'), after.replace('AFTER_VALUE', 'LATEST_VALUE'));
  await page.waitForFunction(() =>
    document
      .querySelector('.monaco-diff-editor .modified .view-lines')
      ?.textContent.includes('LATEST_VALUE'),
  );
  assert.ok(
    (await original.innerText()).includes('BEFORE_VALUE'),
    'live saves keep the original comparison',
  );
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 2);
  await page.getByRole('button', { name: 'Show current file', exact: true }).click();
  await page.waitForFunction(
    () => !window.__diffpane.stats().diffMode && window.__diffpane.stats().models === 1,
  );
  assert.ok((await page.locator('#feed .view-lines').innerText()).includes('LATEST_VALUE'));
  await page.getByRole('button', { name: 'Compare whole file', exact: true }).click();
  await page.waitForFunction(
    () => window.__diffpane.stats().diffMode && window.__diffpane.stats().models === 2,
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/diff-mode.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Verified glyph toggle, whole-file comparison, changed functions, live saves, and model cleanup.',
  );
} catch (error) {
  console.error(errors);
  if (application) {
    const page = application.windows()[0];
    console.error((await page.locator('body').innerText()).slice(-4000));
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/diff-mode-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
}

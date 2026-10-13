import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { catalog } from '../syntax.mjs';

const root = path.resolve(process.argv[2] || process.env.BILLY_ROOT || '../billy');
const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 32 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
const names = new Set(catalog.flatMap(entry => entry.filenames));
const groups = new Map();
for (const file of files) {
  const name = path.basename(file);
  const extension = path.extname(file);
  const type = extension || (names.has(name) || file === name ? name : '[extensionless]');
  if (!groups.has(type)) groups.set(type, []);
  groups.get(type).push(file);
}
const examples = [];
const skipped = [];
const decoder = new TextDecoder('utf-8', { fatal: true });
for (const [type, candidates] of groups) {
  let example;
  for (const file of candidates.slice(0, 12)) {
    try {
      const size = (await stat(path.join(root, file))).size;
      if (size > 2 * 1024 * 1024) continue;
      const bytes = await readFile(path.join(root, file));
      if (bytes.includes(0)) continue;
      decoder.decode(bytes);
      example = { type, file, bytes: size };
      break;
    } catch { /* Missing working files and binary fixtures have no text preview. */ }
  }
  if (example) examples.push(example);
  else skipped.push(type);
}
let application;
const errors = [];
const results = [];
try {
  const packaged = process.env.DIFFPANE_EXECUTABLE;
  application = await electron.launch({ executablePath: packaged || executablePath, args: packaged ? [root] : ['.', root] });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => window.__diffpane?.stats().navigator.inventoryFiles > 0 && !window.__diffpane.stats().navigator.loading);
  const inventory = await page.evaluate(() => window.diffpane.files());
  const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  for (const example of examples) {
    await page.locator('.navigator-search input').fill(example.file);
    const row = page.locator(`.navigator-row[data-path=${JSON.stringify(example.file)}]`);
    if (!await row.count()) {
      const matches = inventory.filter(file => file.path.toLocaleLowerCase().includes(example.file.toLocaleLowerCase())).sort((a, b) => compare(a.path, b.path));
      const index = matches.findIndex(file => file.path === example.file);
      assert.ok(index >= 0, `tracked text must be discoverable: ${example.file}`);
      await page.locator('.navigator-tree').evaluate((element, index) => {
        const height = parseFloat(getComputedStyle(element.closest('.navigator')).getPropertyValue('--navigator-row-height'));
        element.scrollTop = index * height;
      }, index);
      await row.waitFor();
    }
    await row.click();
    await page.waitForFunction(file => window.__diffpane.stats().openedPath === file && window.__diffpane.stats().openedLanguage, example.file);
    await page.waitForFunction(() => window.__diffpane.stats().syntax.pending.length === 0);
    await page.locator('#feed .view-lines').waitFor();
    await page.waitForTimeout(100);
    const stats = await page.evaluate(() => window.__diffpane.stats());
    assert.deepEqual(stats.syntax.errors, {}, `grammar loading for ${example.file}`);
    assert.equal(stats.models, 1, `one model while viewing ${example.file}`);
    const note = await page.locator('#feed .file-note').innerText();
    const spans = await page.locator('#feed .view-line span').evaluateAll(elements => elements.filter(element => element.textContent.trim()).map(element => getComputedStyle(element).color));
    results.push({ ...example, language: stats.openedLanguage, colors: new Set(spans).size, note });
    if (results.length % 25 === 0) console.log(`Checked ${results.length}/${examples.length} Billy text types`);
  }
  assert.deepEqual(errors, [], 'opening Billy files must not produce renderer or grammar errors');
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/billy-filetypes.json', JSON.stringify({ trackedFiles: files.length, testedTypes: results.length, skipped, results }, null, 2) + '\n');
  console.log(JSON.stringify({ trackedFiles: files.length, testedTypes: results.length, coloredTypes: results.filter(result => result.colors > 1).length, plaintext: results.filter(result => result.language === 'plaintext').map(result => result.type), errors }, null, 2));
} catch (error) {
  console.error(errors);
  console.error(results.slice(-3));
  if (application) console.error(await (await application.firstWindow()).evaluate(() => window.__diffpane?.stats()));
  throw error;
} finally {
  if (application) await application.close();
}

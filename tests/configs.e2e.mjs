import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-configs-'));
const fixtures = [
  {
    file: 'package.json',
    language: 'JSON',
    text: '{\n  "name": "viewer",\n  "private": true,\n  "version": 42\n}\n',
  },
  {
    file: 'settings.jsonc',
    language: 'JSON',
    text: '{\n  // Comments and trailing commas belong here.\n  "enabled": true,\n}\n',
  },
  {
    file: 'project.toml',
    language: 'TOML',
    text: '[project]\nname = "viewer"\nenabled = true\ncount = 42\n"dotted.key" = "literal"\nmessage = """first line\nsecond line"""\n',
  },
  {
    file: 'build.yaml',
    language: 'YAML',
    text: 'name: viewer\nenabled: true\nsteps:\n  - run: "npm test"\n',
  },
  {
    file: '.editorconfig',
    language: 'Ini',
    text: '# Indentation\nroot = true\n[*]\nindent_size = 2\n',
  },
  {
    file: '.env.production',
    language: 'Dotenv',
    text: '# Deployment\nAPP_NAME="viewer"\nPORT=3000\n',
  },
  {
    file: 'Makefile',
    language: 'Makefile',
    text: '# Build\nTARGET := viewer\n.PHONY: build\nbuild:\n\t@echo $(TARGET)\n',
  },
];
let application;
const errors = [];

try {
  execFileSync('git', ['init', '-q', root]);
  for (const fixture of fixtures) await writeFile(path.join(root, fixture.file), fixture.text);
  const packaged = process.env.DIFFPANE_EXECUTABLE;
  application = await electron.launch({
    executablePath: packaged || executablePath,
    args: packaged ? [root] : [process.env.DIFFPANE_TEST_APP || '.', root],
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.waitForFunction(() => window.__diffpane?.stats().navigator.inventoryFiles === 7);
  const searchBar = page.locator('.navigator-search');
  assert.ok(
    (await searchBar.boundingBox()).height >= 24,
    'explorer search must be visible before focus',
  );
  for (const fixture of fixtures) {
    console.log(`Checking ${fixture.file}`);
    await page.locator('.navigator-search input').fill(fixture.file);
    await page.locator(`.navigator-row[data-path="${fixture.file}"]`).click();
    const card = page.locator(`#feed .file-card[data-path="${fixture.file}"]`);
    await card.locator('.file-language').getByText(fixture.language, { exact: true }).waitFor();
    await page.waitForFunction(
      file => {
        const spans = document.querySelectorAll(
          `#feed .file-card[data-path="${file}"] .view-line span`,
        );
        return (
          new Set(
            [...spans]
              .filter(span => span.textContent.trim())
              .map(span => getComputedStyle(span).color),
          ).size >= 3
        );
      },
      fixture.file,
      { timeout: 10_000 },
    );
    assert.equal(
      await readFile(path.join(root, fixture.file), 'utf8'),
      fixture.text,
      'viewing configs preserves every source byte',
    );
    assert.equal(
      await card.locator('.squiggly-error').count(),
      0,
      'valid configs should not receive unrelated diagnostics',
    );
    assert.equal(
      await page.locator('.navigator-row[aria-selected="true"]').getAttribute('data-path'),
      fixture.file,
    );
  }
  assert.ok(
    (await page.evaluate(() => window.diffpane.language.status())).every(
      server => server.pid === null,
    ),
    'configs must not start code language servers',
  );
  await page.locator('.navigator-search input').fill('');
  await page.locator('.navigator-tree').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__diffpane.stats().openedPath === '.editorconfig');
  await page.locator('.navigator-search input').fill('settings.jsonc');
  await page.locator('.navigator-row[data-path="settings.jsonc"]').click();
  await page.locator('#feed .file-card[data-path="settings.jsonc"] .view-lines').waitFor();
  await writeFile(
    path.join(root, 'settings.jsonc'),
    '{\n    // Live update\n    "enabled": false,\n}\n',
  );
  await page.waitForFunction(() =>
    document
      .querySelector('.view-lines')
      ?.textContent.replaceAll('\u00a0', ' ')
      .includes('Live update'),
  );
  await page.locator('.navigator-search input').fill('');
  await page.locator('.navigator-tree').focus();
  await page.setViewportSize({ width: 650, height: 420 });
  assert.ok(
    (await searchBar.boundingBox()).height >= 24,
    'search must stay visible after clearing, blurring, and resizing',
  );
  const fixedSearch = await searchBar.boundingBox();
  assert.ok(
    fixedSearch.width >= 140 && fixedSearch.x + fixedSearch.width <= 650,
    'explorer search must remain on screen in a narrow window',
  );
  await page.setViewportSize({ width: 900, height: 720 });
  assert.ok(await page.locator('#navigator').isVisible());
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/configs.png' });
  assert.deepEqual(errors, [], 'config grammars and worker loading must not throw');
  console.log(
    `Verified syntax, source preservation, navigation, and live updates for ${fixtures.length} config formats.`,
  );
} catch (error) {
  if (application) {
    const page = await application.firstWindow();
    console.error(await page.locator('body').innerText());
    console.error(await page.evaluate(() => window.__diffpane?.stats()));
    console.error(errors);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/configs-failure.png' });
  }
  throw error;
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true });
}

import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-ui-')));
const root = path.join(temporary, 'project');
const home = path.join(temporary, 'home');
await mkdir(root);
const config = path.join(
  home,
  process.platform === 'darwin'
    ? 'Library/Application Support/howmany/config.toml'
    : '.config/howmany/config.toml',
);
await mkdir(path.dirname(config), { recursive: true });
await writeFile(config, '[lsp]\nmax_file_lines = 2\nmin_doc_ratio = 0\n');
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const filename = 'sample.py';
let application;
try {
  git('init', '-q');
  await writeFile(path.join(root, filename), '# A comment\nx = 1\n\nprint(x)\n');
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
  await writeFile(path.join(root, filename), '# A comment\nx = 2\n\nprint(x)\n');
  const packaged = process.env.DIFFPANE_EXECUTABLE;
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.DIFFPANE_HOWMANY_BINARY;
  application = await electron.launch({
    executablePath: packaged || executablePath,
    args: packaged ? [root] : ['.', root],
    env,
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.howmany-counts').filter({ hasText: '4 Python' }).waitFor();
  await page.locator('.howmany-warnings').filter({ hasText: '4 lines, over the 2' }).waitFor();
  await page.locator('.squiggly-warning').first().waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('#howmany-panel')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('.howmany-body')?.textContent.includes('Quality'),
  );
  assert.match(await page.locator('.howmany-body').innerText(), /Code\s+2/);
  await page.locator('.howmany-report-button').click();
  await page.locator('#howmany-report[open]').waitFor();
  assert.match(await page.locator('.howmany-report-content').innerText(), /Python/);
  assert.equal(
    await page.locator('.howmany-section').count(),
    3,
    'zeroed structural metrics stay hidden',
  );
  const exportPath = path.join(root, 'export.json');
  await application.evaluate(({ dialog }, exportPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
  }, exportPath);
  await page.locator('.howmany-export').click();
  await page.getByText('Report exported', { exact: true }).waitFor();
  const report = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(report.basic.total_files, 1);
  assert.equal(report.basic.total_lines, 4);
  assert.equal(report.metadata.version, '3.1.0');
  await rm(exportPath);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/howmany${packaged ? '-packaged' : ''}.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#howmany-report').evaluate(dialog => dialog.open), false);
  await writeFile(path.join(root, filename), '# A comment\nx = 3\n');
  await page.locator('.howmany-counts').filter({ hasText: '2 Python' }).waitFor();
  assert.equal(await page.locator('.howmany-warnings').isHidden(), true);
  await page.waitForFunction(
    () =>
      document.querySelector('.howmany-body')?.textContent.includes('1 code') ||
      [...document.querySelectorAll('.howmany-row')].some(row => row.textContent === 'Code1'),
  );
  await page.locator('#howmany-panel summary').click();
  assert.equal(await page.locator('#howmany-panel').evaluate(panel => panel.open), false);
  await page.locator('.howmany-status').click();
  await page.locator('#howmany-report[open]').waitFor();
  assert.deepEqual(errors, []);
  await application.close();
  application = await electron.launch({
    executablePath: packaged || executablePath,
    args: packaged ? [root] : ['.', root],
    env: { ...env, DIFFPANE_HOWMANY_BINARY: path.join(temporary, 'missing-howmany') },
  });
  const unavailable = await application.firstWindow();
  await unavailable
    .locator('.howmany-body')
    .filter({ hasText: 'HowMany is unavailable' })
    .waitFor();
  await unavailable.locator('.view-lines').first().waitFor();
  assert.equal(
    await unavailable.locator('#message').isHidden(),
    true,
    'an unavailable analyzer does not mark Git as failed',
  );
  console.log(
    `HowMany ${packaged ? 'packaged' : 'source'} desktop checks passed: counts, report, export, save refresh, keyboard dismissal.`,
  );
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}

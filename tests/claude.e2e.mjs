import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'diffpane-claude-'));
const root = path.join(fixture, 'workspace');
const profile = path.join(fixture, 'profile');
const filename = 'greeting.js';
const source = path.join(root, filename);
const keyFile = path.join(profile, 'claude-key');
const key = `sk-ant-api03-${'A'.repeat(96)}`;
const ciphertext = 'encrypted-key-fixture';
const original = "export const greeting = 'original';\n";
const updated = "export const greeting = 'updated';\n";
const external = "export const greeting = 'external';\n";
const ignoredValue = 'IGNORED_FIXTURE_VALUE';
const errors = [];
let application;
let page;

function git(...args) {
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function reply(text) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

function tool(name, id, input) {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, id, input }] };
}

async function launch(responses) {
  const args = process.env.DIFFPANE_EXECUTABLE ? [] : [process.env.DIFFPANE_TEST_APP || '.'];
  args.push(source, `--user-data-dir=${profile}`);
  application = await electron.launch({
    executablePath: process.env.DIFFPANE_EXECUTABLE || executablePath,
    args,
    env: { ...process.env, DIFFPANE_DEV_SERVER_URL: '' },
  });
  await application.evaluate(
    ({ safeStorage }, { key, ciphertext, responses }) => {
      globalThis.claudeRequests = [];
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.encryptStringAsync = async value => {
        if (value !== key) throw new Error('Expected the API key from settings');
        return Buffer.from(ciphertext);
      };
      safeStorage.decryptStringAsync = async value => {
        if (value.toString() !== ciphertext) throw new Error('Expected the encrypted credential');
        return { result: key, shouldReEncrypt: false };
      };
      globalThis.fetch = async (url, init) => {
        const endpoint = new URL(url);
        const headers = new Headers(init.headers);
        const authenticated =
          headers.get('authorization') === `Bearer ${key}` || headers.get('x-api-key') === key;
        globalThis.claudeRequests.push({
          url: endpoint.href,
          method: init.method,
          authenticated,
          redirect: init.redirect,
          body: init.body && JSON.parse(init.body),
        });
        if (!authenticated) return new Response(null, { status: 401 });
        if (endpoint.origin !== 'https://api.anthropic.com') {
          return new Response(null, { status: 403 });
        }
        if (init.method === 'GET' && endpoint.pathname.startsWith('/v1/models/')) {
          return Response.json({ type: 'model', id: endpoint.pathname.split('/').at(-1) });
        }
        const response = responses.shift();
        if (!response || endpoint.pathname !== '/v1/messages' || init.method !== 'POST') {
          return new Response(null, { status: 500 });
        }
        return Response.json(response);
      };
    },
    { key, ciphertext, responses },
  );
  page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(name => {
    const state = window.__diffpane?.stats();
    return state?.openedPath === name && state.activeEditors === 1;
  }, filename);
}

async function openSettings() {
  await page.getByRole('button', { name: 'Claude settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Claude settings', exact: true });
  await settings.waitFor();
  return settings;
}

async function send(panel, text) {
  await panel.getByRole('textbox', { name: 'Message Claude' }).fill(text);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
}

try {
  await mkdir(root);
  await Promise.all([
    writeFile(source, original),
    writeFile(path.join(root, '.gitignore'), '.env\n'),
    writeFile(path.join(root, '.env'), `TOKEN=${ignoredValue}\n`),
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

  await launch([
    {
      stop_reason: 'tool_use',
      content: [
        ...tool('read_file', 'read-ask', { path: filename }).content,
        ...tool('read_file', 'read-ignored', { path: '.env' }).content,
      ],
    },
    reply('The exported greeting is original.'),
    tool('read_file', 'read-edit', { path: filename }),
    tool('propose_edit', 'edit', { path: filename, before: "'original'", after: "'updated'" }),
    reply('I proposed updating the greeting.'),
    tool('read_file', 'read-stale', { path: filename }),
    tool('propose_edit', 'stale', { path: filename, before: "'updated'", after: "'stale'" }),
    reply('I proposed a second change.'),
  ]);
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  let settings = await openSettings();
  const input = settings.getByLabel('API key', { exact: true });
  assert.equal(await input.getAttribute('type'), 'password');
  await input.fill(key);
  await settings.getByRole('button', { name: 'Save API key', exact: true }).click();
  await settings.getByText('API key saved.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await readFile(keyFile, 'utf8'), ciphertext);
  if (process.platform !== 'win32') assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });

  const panel = page.locator('#claude-panel');
  await send(panel, 'What greeting is exported?');
  await panel.getByText('The exported greeting is original.', { exact: true }).waitFor();
  const requests = await application.evaluate(() => globalThis.claudeRequests);
  assert.deepEqual(
    requests.map(request => request.method),
    ['GET', 'POST', 'POST'],
  );
  assert.ok(requests.every(request => request.authenticated && request.redirect === 'error'));
  assert.ok(requests[1].body.tools.some(tool => tool.name === 'read_file'));
  assert.ok(requests[1].body.tools.every(tool => tool.name !== 'propose_edit'));
  const results = requests[2].body.messages.at(-1).content;
  const result = results.find(result => result.tool_use_id === 'read-ask');
  const read = JSON.parse(result.content);
  assert.equal(read.path, filename);
  assert.ok(read.text.includes(original.trimEnd()));
  assert.equal(results.find(result => result.tool_use_id === 'read-ignored').is_error, true);
  assert.ok(!JSON.stringify(requests).includes(ignoredValue));

  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await send(panel, 'Update the greeting.');
  await panel.getByText('I proposed updating the greeting.', { exact: true }).waitFor();
  const apply = panel.getByRole('button', { name: 'Apply edit', exact: true });
  await apply.waitFor();
  assert.equal(await readFile(source, 'utf8'), original);
  await apply.click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#feed .view-lines')].some(lines =>
      lines.textContent.includes("'updated'"),
    ),
  );
  assert.equal(await readFile(source, 'utf8'), updated);

  await send(panel, 'Make another change to the greeting.');
  await panel.getByText('I proposed a second change.', { exact: true }).waitFor();
  await apply.waitFor();
  await writeFile(source, external);
  await apply.click();
  await panel.getByText(/changed on disk/iu).waitFor();
  assert.equal(await readFile(source, 'utf8'), external);

  await application.close();
  application = undefined;
  await launch([reply('The saved credential worked after restart.')]);
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  await send(page.locator('#claude-panel'), 'Can you still respond?');
  await page.getByText('The saved credential worked after restart.', { exact: true }).waitFor();
  const newWindow = application.waitForEvent('window');
  await application.evaluate(({ app }, filename) => {
    app.emit('open-file', { preventDefault() {} }, filename);
  }, source);
  const otherPage = await newWindow;
  otherPage.setDefaultTimeout(10000);
  otherPage.on('pageerror', error => errors.push(error.message));
  await otherPage.getByRole('button', { name: 'Claude', exact: true }).click();
  await otherPage.getByRole('button', { name: 'Claude settings', exact: true }).click();
  const otherSettings = otherPage.getByRole('dialog', { name: 'Claude settings', exact: true });
  await otherSettings.getByRole('button', { name: 'Remove key', exact: true }).click();
  await otherSettings.getByText('API key removed.', { exact: true }).waitFor();
  await page.getByText('The saved credential worked after restart.', { exact: true }).waitFor({
    state: 'detached',
  });
  assert.equal(await page.getByRole('textbox', { name: 'Message Claude' }).isDisabled(), true);
  await assert.rejects(readFile(keyFile), { code: 'ENOENT' });
  assert.deepEqual(errors, []);
  console.log('Claude Electron checks passed for credentials, scoped reads, and edit review.');
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      await page.evaluate(() => ({
        stats: window.__diffpane?.stats(),
        message: document.getElementById('message')?.textContent,
        panel: document.getElementById('claude-panel')?.textContent,
        settings: document.getElementById('claude-settings')?.textContent,
      })),
      errors,
    );
    const requests = await application.evaluate(() => globalThis.claudeRequests);
    console.error(
      requests?.map(({ method, url, body }) => ({ method, url, messages: body?.messages.length })),
    );
  }
  throw error;
} finally {
  await application?.close();
  await rm(fixture, { recursive: true, force: true });
}

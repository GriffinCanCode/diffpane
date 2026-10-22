import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'diffpane-startup-'));
const repository = path.join(fixture, 'repository');
const emptyDirectory = path.join(fixture, 'not-a-repository');
const appPath = path.resolve(process.env.DIFFPANE_TEST_APP || '.');
const rendererErrors = [];
let application;
let launchCount = 0;
let startupStderr = '';
let startupAction = '';

async function launch(target, cwd = emptyDirectory, profileName = `profile-${++launchCount}`) {
  startupAction = `launch ${target || 'welcome'} with ${profileName}`;
  const profile = path.join(fixture, profileName);
  const args = process.env.DIFFPANE_EXECUTABLE ? [] : [appPath];
  if (target) args.push(target);
  args.push(`--user-data-dir=${profile}`);
  application = await electron.launch({
    executablePath: process.env.DIFFPANE_EXECUTABLE || executablePath,
    args,
    cwd,
    env: { ...process.env, DIFFPANE_DEV_SERVER_URL: '' },
  });
  startupStderr = '';
  application.process().stderr?.on('data', chunk => {
    startupStderr = `${startupStderr}${chunk}`.slice(-16000);
  });
  application.on('window', page => {
    page.on('pageerror', error => rendererErrors.push(error.message));
  });
  const page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  return page;
}

async function expectWelcome(page) {
  await page.getByRole('heading', { name: 'Welcome to Diffpane', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !document.getElementById('open-file').disabled &&
      !document.getElementById('open-folder').disabled,
  );
  assert.equal(await page.locator('#start-screen').isVisible(), true);
  assert.equal(
    await page.getByRole('button', { name: 'Open File…', exact: true }).isEnabled(),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Open Folder…', exact: true }).isEnabled(),
    true,
  );
  assert.equal(await page.evaluate(() => window.diffpane.snapshot()), null);
  assert.equal(
    await page.locator('#navigator:visible, .branch:visible, #save-state:visible').count(),
    0,
  );
  assert.equal(await page.locator('#message').isVisible(), false);
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    /Opening project|Connecting to Git|Git worker exited|Error invoking remote method|HOWMANY|HowMany is unavailable/,
    'an empty launch must not pretend to open a project or run workspace analysis',
  );
}

async function installDialogProbe(results) {
  await application.evaluate(({ dialog }, responses) => {
    globalThis.startupDialogs = { requests: [], responses };
    dialog.showOpenDialog = async (window, options) => {
      globalThis.startupDialogs.requests.push({
        parent: window?.id,
        properties: options.properties,
      });
      const response = globalThis.startupDialogs.responses.shift();
      if (!response) throw new Error('Unexpected native open dialog');
      return response;
    };
  }, results);
}

async function expectDialogs(properties) {
  const deadline = Date.now() + 5000;
  let requests;
  do {
    requests = await application.evaluate(() => globalThis.startupDialogs.requests);
    if (requests.length === properties.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.deepEqual(
    requests.map(request => request.properties),
    properties,
  );
  assert.ok(
    requests.every(request => Number.isInteger(request.parent)),
    'dialogs need a parent window',
  );
}

async function expectRecents(page, targets) {
  await page.getByRole('heading', { name: 'Recently opened', exact: true }).waitFor();
  await page.waitForFunction(
    expected => {
      const paths = [...document.querySelectorAll('.recent-target')].map(
        button => button.dataset.path,
      );
      return JSON.stringify(paths) === JSON.stringify(expected);
    },
    targets.map(target => target.path),
  );
  assert.deepEqual(
    await page.locator('.recent-target').evaluateAll(buttons =>
      buttons.map(button => ({
        path: button.dataset.path,
        kind: button.dataset.kind,
        name: button.querySelector('strong').textContent,
      })),
    ),
    targets,
    'recent files and folders should persist in opening order without duplicates',
  );
}

async function chooseTarget(page, name, recent = false) {
  const opened = application.waitForEvent('window', { timeout: 10000 });
  const closed = page.waitForEvent('close', { timeout: 10000 });
  const button = recent
    ? page.locator(`.recent-target[data-path=${JSON.stringify(name)}]`)
    : page.getByRole('button', { name, exact: true });
  await button.click();
  const workspace = await opened;
  await closed;
  await workspace.waitForFunction(() => window.__diffpane?.stats().activeEditors === 1);
  assert.equal(application.windows().length, 1, 'opening a target should replace the empty window');
  return workspace;
}

function waitForApplicationExit() {
  const child = application.process();
  const status =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise((resolve, reject) => {
          const exited = (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          };
          const timer = setTimeout(() => {
            child.off('exit', exited);
            reject(new Error('Electron process did not exit within 8 seconds'));
          }, 8000);
          child.once('exit', exited);
        });
  const exited = status.then(result => {
    assert.equal(result.code, 0, `Electron must exit normally, received ${JSON.stringify(result)}`);
  });
  // A native crash can precede the pending page-close await; retain its failure for diagnostics.
  void exited.catch(() => {});
  return exited;
}

async function closeWindow(page) {
  startupAction = `native Close (${startupAction})`;
  const closed = page.waitForEvent('close', { timeout: 5000 });
  const exited = waitForApplicationExit();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  // Playwright retains a Node inspector; detach it after native Close succeeds.
  await application.close();
  await exited;
  application = null;
}

async function quitApplication() {
  startupAction = `native Quit (${startupAction})`;
  const closed = Promise.all(
    application.windows().map(page => page.waitForEvent('close', { timeout: 5000 })),
  );
  const exited = waitForApplicationExit();
  await application.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await closed;
  await application.close();
  await exited;
  application = null;
}

async function quitWithCleanEditor(page) {
  startupAction = `native Quit with final-close blocker (${startupAction})`;
  const filename = path.join(repository, 'second.txt');
  const original = await readFile(filename, 'utf8');
  await page.locator('.view-lines').click();
  await application.evaluate(({ app }) => {
    globalThis.shutdownReady = false;
    globalThis.startupQuitBlocker = event => {
      // Product code prevents the first quit while flushing and cleaning up.
      // Hold only its subsequent allowed quit, after all background work finishes.
      if (event.defaultPrevented) return;
      event.preventDefault();
      globalThis.shutdownReady = true;
    };
    app.on('before-quit', globalThis.startupQuitBlocker);
  });
  await application.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  assert.equal(
    await application.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!globalThis.shutdownReady && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      return globalThis.shutdownReady;
    }),
    true,
    'finish save flushing and background cleanup before holding final Quit',
  );
  await page.keyboard.insertText('MUST NOT BE ACCEPTED DURING QUIT');
  assert.equal(
    (await page.locator('.view-lines').innerText({ timeout: 1000 })).replaceAll('\u00a0', ' '),
    original.trimEnd(),
    'the clean editor must reject typing until final Quit completes',
  );
  const closed = page.waitForEvent('close', { timeout: 5000 });
  const exited = waitForApplicationExit();
  await application.evaluate(({ app }) => {
    app.removeListener('before-quit', globalThis.startupQuitBlocker);
    globalThis.startupQuitBlocker = null;
    setImmediate(() => app.quit());
  });
  await closed;
  await application.close();
  await exited;
  application = null;
  assert.equal(
    await readFile(filename, 'utf8'),
    original,
    'Quit must not accept edits after flushing',
  );
}

async function cleanupApplication() {
  if (!application) return;
  const running = application;
  application = null;
  let timeout;
  try {
    await Promise.race([
      (async () => {
        await running
          .evaluate(({ app }) => {
            if (globalThis.startupQuitBlocker) {
              app.removeListener('before-quit', globalThis.startupQuitBlocker);
              globalThis.startupQuitBlocker = null;
            }
          })
          .catch(() => {});
        await running.close();
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('App cleanup timed out')), 5000);
      }),
    ]);
  } catch {
    running.process().kill('SIGKILL');
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await mkdir(repository);
  await mkdir(emptyDirectory);
  execFileSync('git', ['init', '-q', repository]);
  await writeFile(path.join(repository, 'first.txt'), 'FIRST STARTUP FILE\n');
  await writeFile(path.join(repository, 'second.txt'), 'SECOND STARTUP FILE\n');

  const folderRecent = { path: repository, kind: 'folder', name: 'repository' };
  const fileRecent = {
    path: path.join(repository, 'second.txt'),
    kind: 'file',
    name: 'second.txt',
  };
  let page = await launch(undefined, emptyDirectory, 'history-profile');
  await expectWelcome(page);
  assert.deepEqual(await page.evaluate(() => window.diffpane.recentTargets()), []);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/startup-welcome.png' });
  await installDialogProbe([
    { canceled: true, filePaths: [] },
    { canceled: true, filePaths: [] },
    { canceled: false, filePaths: [repository] },
  ]);
  await page.getByRole('button', { name: 'Open File…', exact: true }).click();
  await expectDialogs([['openFile']]);
  await expectWelcome(page);
  await page.getByRole('button', { name: 'Open Folder…', exact: true }).click();
  await expectDialogs([['openFile'], ['openDirectory']]);
  await expectWelcome(page);
  assert.equal(application.windows().length, 1, 'canceling a picker must keep one welcome window');
  page = await chooseTarget(page, 'Open Folder…');
  await expectDialogs([['openFile'], ['openDirectory'], ['openDirectory']]);
  await page.locator('.navigator-row[data-path="first.txt"]').waitFor();
  const cleanCloseMarker = path.join(fixture, 'clean-close-flushed');
  await application.evaluate(({ ipcMain }, marker) => {
    const { writeFileSync } = process.getBuiltinModule('fs');
    ipcMain.on('saves-flushed', (_event, success) => writeFileSync(marker, String(success)));
  }, cleanCloseMarker);
  await closeWindow(page);
  assert.equal(
    await readFile(cleanCloseMarker, 'utf8').catch(() => null),
    'true',
    'a clean project still acknowledges save flushing before native Close',
  );

  // Launching from a Git working directory must still be empty without an explicit target.
  page = await launch(undefined, repository, 'history-profile');
  await expectWelcome(page);
  await expectRecents(page, [folderRecent]);
  await installDialogProbe([{ canceled: false, filePaths: [path.join(repository, 'second.txt')] }]);
  page = await chooseTarget(page, 'Open File…');
  await expectDialogs([['openFile']]);
  await page.waitForFunction(() => window.__diffpane.stats().openedPath === 'second.txt');
  assert.match(
    (await page.locator('.view-lines').innerText()).replaceAll('\u00a0', ' '),
    /SECOND STARTUP FILE/,
  );
  await quitWithCleanEditor(page);

  page = await launch(undefined, emptyDirectory, 'history-profile');
  await expectWelcome(page);
  await expectRecents(page, [fileRecent, folderRecent]);
  await page.screenshot({ path: 'test-results/startup-recents.png' });
  await page.setViewportSize({ width: 650, height: 420 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'test-results/startup-recents-narrow.png' });
  await page.setViewportSize({ width: 1400, height: 960 });
  await page.locator('.recent-target').first().focus();
  assert.equal(
    await page.evaluate(async () => {
      const focused = document.activeElement;
      window.dispatchEvent(new Event('focus'));
      await window.diffpane.recentTargets();
      await new Promise(requestAnimationFrame);
      return focused.isConnected && focused === document.activeElement;
    }),
    true,
    'refreshing unchanged history must retain the focused recent button',
  );
  page = await chooseTarget(page, repository, true);
  await closeWindow(page);

  page = await launch(undefined, emptyDirectory, 'history-profile');
  await expectWelcome(page);
  await expectRecents(page, [folderRecent, fileRecent]);
  page = await chooseTarget(page, fileRecent.path, true);
  await page.waitForFunction(() => window.__diffpane.stats().openedPath === 'second.txt');
  await quitApplication();

  page = await launch(undefined, emptyDirectory, 'history-profile');
  await expectWelcome(page);
  await expectRecents(page, [fileRecent, folderRecent]);
  await closeWindow(page);
  page = await launch();
  await expectWelcome(page);
  await quitApplication();

  // A requested non-Git directory should remain an actionable error, and must not trap Close or Quit.
  for (const action of ['close', 'quit']) {
    page = await launch(emptyDirectory, emptyDirectory, 'history-profile');
    await page.getByRole('heading', { name: 'Couldn’t open this project', exact: true }).waitFor();
    await page.locator('#message').waitFor({ state: 'visible' });
    assert.equal(
      await page.getByRole('button', { name: 'Open Folder…', exact: true }).isEnabled(),
      true,
    );
    assert.equal(await page.locator('#navigator:visible, #save-state:visible').count(), 0);
    if (action === 'close') await closeWindow(page);
    else await quitApplication();
  }

  page = await launch(undefined, emptyDirectory, 'history-profile');
  await expectWelcome(page);
  await expectRecents(page, [fileRecent, folderRecent]);
  await closeWindow(page);

  // Abort the entry script on reload so native Close is exercised after loading finishes,
  // while the renderer has no save-flush handler or readiness handshake.
  page = await launch(repository);
  await page.waitForFunction(() => window.__diffpane?.stats().activeEditors === 1);
  await page.route('**/*.js', route => route.abort());
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.evaluate(() => typeof window.__diffpane), 'undefined');
  await closeWindow(page);

  assert.deepEqual(
    rendererErrors,
    [],
    'startup, native selection and recoverable errors must not throw',
  );
  console.log(
    'Startup Electron checks passed: empty launches, native picker cancellation and selection, persisted recent files and folders, Close, Quit, save-flush safety, backend failure and unready renderer cleanup.',
  );
} catch (error) {
  console.error('Startup check failed', startupAction, error);
  console.error('Electron stderr', startupStderr);
  if (application) {
    console.error('Electron exit code', application.process().exitCode);
    let timeout;
    try {
      console.error(
        'Startup main state',
        await Promise.race([
          application.evaluate(({ app, BrowserWindow }) => ({
            ready: app.isReady(),
            appPath: app.getAppPath(),
            arguments: process.argv,
            activateListeners: app.listenerCount('activate'),
            windows: BrowserWindow.getAllWindows().map(window => ({
              destroyed: window.isDestroyed(),
              loading: window.webContents.isLoadingMainFrame(),
              url: window.webContents.getURL(),
            })),
            resources: process.getActiveResourcesInfo(),
          })),
          new Promise(resolve => {
            timeout = setTimeout(() => resolve('Main process no longer responds'), 1000);
          }),
        ]),
      );
    } catch {
      // Electron may already have disconnected its debugger during shutdown.
    } finally {
      clearTimeout(timeout);
    }
  }
  const page = application?.windows()[0];
  if (page && !page.isClosed()) {
    try {
      console.error(
        'Startup renderer state',
        await page.locator('body').innerText({ timeout: 1000 }),
      );
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/startup-failure.png', timeout: 1000 });
    } catch {
      // A window can disappear while a failed native Close or Quit check is being diagnosed.
    }
  }
  throw error;
} finally {
  await cleanupApplication();
  await rm(fixture, { recursive: true, force: true });
}

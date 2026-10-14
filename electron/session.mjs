import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import watcher from '@parcel/watcher';
import { DocumentCache } from './document-cache.ts';
import { InventoryDelta } from './inventory-delta.ts';
import { DiffRuntime } from './diff-runtime.ts';
import { Repository } from './repository.mjs';
import { LanguageRuntime } from './language.mjs';
import { HowManyRuntime } from './howmany.mjs';
import { operationPath, renameEntry } from './file-operations.ts';
import { mediaType } from '../media-types.ts';
import { countLines } from '../text-lines.ts';

const repository = await Repository.open(workerData.directory);
const launchPath = await realpath(workerData.directory);
const initialPath = (await lstat(launchPath)).isFile()
  ? path.relative(repository.root, launchPath)
  : null;
const languages = new LanguageRuntime(repository.root, value =>
  parentPort.postMessage({ event: 'language-event', value }),
);
const howmany = new HowManyRuntime(repository.root, repository.scope, value =>
  parentPort.postMessage({ event: 'howmany-event', value }),
);
let snapshot;
let catalog;
let catalogRevision = 0;
let catalogIndex = new Map();
let snapshotIndex = new Map();
let inventoryDirty = false;
let broadChanges = false;
let revision = 0;
let timer;
let refreshing = false;
let currentRefresh;
let pending = false;
let force = false;
let watchError;
let fallbackTimer;
let shuttingDown = false;
let directoryChanges = Promise.resolve();
const changes = new Set();
const languageChanges = new Map();
const subscriptions = [];
const diffs = new DiffRuntime();
const documents = new DocumentCache(async (filePath, comparison) => {
  const file = await findFile(filePath);
  if (!file) throw new Error('This file is no longer available in this directory.');
  const start = performance.now();
  const contents = await repository.contents(file, comparison);
  const changes = await diffs.calculate(contents.before, contents.after);
  return {
    path: filePath,
    before: contents.before,
    after: contents.after,
    note: contents.note,
    editable: !contents.preview && !file.submodule && (await repository.editable(filePath)),
    ...(contents.preview ? { preview: contents.preview } : {}),
    ...changes,
    lineCount: countLines(contents.after),
    elapsedMs: performance.now() - start,
  };
});
const inventoryDelta = new InventoryDelta();

function gitMetadata(file) {
  for (const base of [repository.gitDir, repository.commonDir]) {
    const relative = path.relative(base, file);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return (
        !relative ||
        ['HEAD', 'index', 'packed-refs', 'config', `info${path.sep}exclude`].includes(relative) ||
        relative.startsWith(`refs${path.sep}`)
      );
    }
  }
  return null;
}

function collapsedIgnoredParent(filename) {
  let parent = path.posix.dirname(filename);
  while (parent !== '.') {
    if (
      repository.inventoryMetadata.get(parent)?.directory &&
      !repository.expandedIgnored.has(parent)
    )
      return true;
    parent = path.posix.dirname(parent);
  }
  return false;
}

function schedule(all = false) {
  if (shuttingDown) return;
  force ||= all;
  pending = true;
  if (!timer && !refreshing)
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch(() => {});
    }, 0);
}

function watchFailed(message) {
  watchError = `${message}; using a 2s refresh.`;
  // Healthy native subscriptions need no polling or periodic wakeups.
  fallbackTimer ??= setInterval(() => schedule(true), 2000).unref();
  schedule(true);
}

function refresh() {
  if (refreshing) return currentRefresh;
  clearTimeout(timer);
  timer = undefined;
  currentRefresh = performRefresh();
  return currentRefresh;
}

async function performRefresh() {
  refreshing = true;
  pending = false;
  const paths = [...changes];
  changes.clear();
  const languageEvents = [...languageChanges.values()];
  languageChanges.clear();
  const all = force || broadChanges;
  const refreshInventory = inventoryDirty || force;
  broadChanges = false;
  inventoryDirty = false;
  force = false;
  try {
    if (!all && paths.length && !(await repository.hasRelevantPaths(paths))) return snapshot;
    languages.changed(languageEvents);
    const start = performance.now();
    const result = await repository.snapshot();
    revision++;
    const changedPaths = all ? ['*'] : paths.map(file => path.relative(repository.root, file));
    howmany.changed(changedPaths);
    snapshotIndex = new Map(result.files.map(file => [file.path, file]));
    // Watch events invalidate paths before the editor's fast notification is sent.
    if (all) documents.invalidate();
    if (refreshInventory) {
      catalog = undefined;
      catalogIndex = new Map();
      catalogRevision++;
    }
    snapshot = {
      ...result,
      root: repository.root,
      scope: repository.scope,
      initialPath,
      revision,
      changedPaths,
      inventoryRevision: catalogRevision,
      watchError,
      gitMs: performance.now() - start,
    };
    parentPort.postMessage({ event: 'change', value: snapshot });
    return snapshot;
  } catch (error) {
    parentPort.postMessage({ event: 'error', value: error.message });
    throw error;
  } finally {
    refreshing = false;
    if (pending) schedule();
  }
}

async function files() {
  for (;;) {
    const requestedRevision = catalogRevision;
    if (!catalog) {
      const result = repository.files();
      catalog = result;
      result.catch(() => {
        if (catalog === result) catalog = undefined;
      });
    }
    const inventory = await catalog;
    if (requestedRevision !== catalogRevision) continue;
    if (!catalogIndex.size && inventory.length)
      catalogIndex = new Map(inventory.map(file => [file.path, file]));
    return inventory;
  }
}

async function findFile(filePath) {
  if (snapshotIndex.has(filePath)) return snapshotIndex.get(filePath);
  await files();
  const file = snapshotIndex.get(filePath) ?? catalogIndex.get(filePath);
  return file?.directory ? undefined : (file ?? (await repository.ignoredFile(filePath)));
}

async function document(filePath, comparison) {
  if (typeof filePath !== 'string' || !['head', 'unstaged', 'staged'].includes(comparison))
    throw new Error('Invalid document request');
  const result = await documents.get(filePath, comparison);
  return { ...result, revision };
}

parentPort.on('message', async ({ id, method, args = [] }) => {
  try {
    let value;
    if (method === 'snapshot') value = snapshot ?? (await refresh());
    else if (method === 'operation-path' || method === 'rename') {
      await files();
      if (catalogIndex.get(args[0])?.submodule)
        throw new Error('Open the submodule to change its files.');
      if (method === 'operation-path') value = await operationPath(repository, args[0]);
      else {
        value = await renameEntry(repository, ...args);
        documents.invalidate([args[0], value]);
        force = true;
        if (refreshing) await currentRefresh;
        await refresh();
      }
    } else if (method === 'files') value = (await files()).filter(file => !file.ignored);
    else if (method === 'directory-expanded') {
      const change = directoryChanges.then(async () => {
        await files();
        const base = catalogRevision;
        if (await repository.setDirectoryExpanded(...args)) {
          if (!args[1]) documents.invalidate([args[0] || '*']);
          // Expansions touch only one directory; keep the regular inventory cached.
          if (base === catalogRevision) {
            catalogIndex = repository.inventoryMetadata;
            catalog = Promise.resolve([...catalogIndex.values()]);
          } else {
            catalog = undefined;
            catalogIndex = new Map();
          }
          catalogRevision++;
          snapshot = { ...snapshot, changedPaths: [], inventoryRevision: catalogRevision };
          parentPort.postMessage({ event: 'change', value: snapshot });
        }
      });
      directoryChanges = change.catch(() => {});
      await change;
      value = null;
    } else if (method === 'files-delta') {
      const base = args[0];
      if (base !== null && (!Number.isSafeInteger(base) || base < 0))
        throw new Error('Invalid inventory revision');
      await files();
      value = inventoryDelta.update(base, catalogRevision, catalogIndex);
    } else if (method === 'document') value = await document(...args);
    else if (method === 'save') {
      const [filePath, text, expected] = args;
      const file = await findFile(filePath);
      if (!file || file.submodule)
        throw new Error('This file is no longer available in this directory.');
      await repository.save(filePath, text, expected);
      documents.invalidate([filePath]);
      const absolute = path.join(repository.root, filePath);
      changes.add(absolute);
      languageChanges.set(absolute, { path: absolute, type: 'update' });
      parentPort.postMessage({ event: 'paths', value: [filePath] });
      schedule();
      value = null;
    } else if (method === 'media') {
      const file = await findFile(args[0]);
      if (!file || file.submodule || !mediaType(file.path))
        throw new Error('This media file is no longer available in this directory.');
      value = { root: repository.root, path: file.path, type: mediaType(file.path) };
    } else if (method === 'howmany-analyze') value = await howmany.analyze(args[0] === true);
    else if (method === 'howmany-file') {
      const contents = await document(args[0], 'head');
      value = contents.note ? null : await howmany.file(args[0], contents.after);
    } else if (method === 'howmany-close') {
      howmany.closeFile(args[0]);
      value = null;
    } else if (method === 'language-open') {
      const input = args[0];
      const file = await findFile(input?.path);
      if (!file) throw new Error('Language document is not in this directory.');
      value = await languages.open(input);
    } else if (method === 'language-request') value = await languages.request(args[0]);
    else if (method === 'language-cancel') {
      languages.cancel(args[0]);
      value = null;
    } else if (method === 'language-close') {
      languages.close(args[0]);
      value = null;
    } else if (method === 'language-status') value = languages.status();
    else if (method === 'language-dispose') {
      shuttingDown = true;
      clearTimeout(timer);
      clearInterval(fallbackTimer);
      documents.dispose();
      await Promise.all(subscriptions.map(subscription => subscription.unsubscribe()));
      await currentRefresh?.catch(() => {});
      await Promise.all([languages.dispose(), diffs.dispose(), howmany.dispose()]);
      value = null;
    } else if (method === 'refresh') {
      force = true;
      if (refreshing) await currentRefresh;
      value = await refresh();
    } else if (method === 'performance')
      value = { documents: documents.stats(), inventoryRevision: catalogRevision, revision };
    else throw new Error('Unknown request');
    parentPort.postMessage({ id, value });
    if (shuttingDown) parentPort.close();
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});

for (const directory of new Set([repository.scope, repository.gitDir, repository.commonDir])) {
  try {
    const subscription = await watcher.subscribe(directory, (error, events) => {
      if (shuttingDown) return;
      if (error) {
        watchFailed(`Live watcher failed: ${error.message}`);
        return;
      }
      const livePaths = new Set();
      for (const event of events) {
        const metadata = gitMetadata(event.path);
        if (metadata === true || event.path === repository.scope) {
          force = true;
          documents.invalidate();
        } else if (metadata === null && event.path.startsWith(repository.scope + path.sep)) {
          const relative = path.relative(repository.root, event.path);
          documents.invalidate([relative]);
          if (!livePaths.has('*')) {
            if (livePaths.size < 256) livePaths.add(relative);
            else {
              livePaths.clear();
              livePaths.add('*');
            }
          }
          // FSEvents can retain FileCreated on existing paths; atomic saves also reuse paths.
          const known = catalogIndex.has(relative);
          if (
            (!known && !snapshotIndex.has(relative) && collapsedIgnoredParent(relative)) ||
            (event.type === 'update' &&
              repository.inventoryMetadata.get(relative)?.directory &&
              !repository.expandedIgnored.has(relative))
          )
            continue;
          if (
            path.basename(event.path) === '.gitignore' ||
            (event.type === 'create' && !known) ||
            event.type === 'delete'
          )
            inventoryDirty = true;
          if (languageChanges.size < 4096) languageChanges.set(event.path, event);
          if (changes.size < 4096) changes.add(event.path);
          else broadChanges = true;
        }
      }
      // Editor reads can proceed while status and inventory subprocesses run.
      if (force || livePaths.size)
        parentPort.postMessage({ event: 'paths', value: force ? ['*'] : [...livePaths] });
      if (force || changes.size) schedule();
    });
    subscriptions.push(subscription);
  } catch (error) {
    watchFailed(`Live watcher unavailable: ${error.message}`);
  }
}
force = true;
await refresh();

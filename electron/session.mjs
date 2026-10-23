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
let catalogLoading;
let catalogRevision = 0;
let catalogIndex = new Map();
let snapshotIndex = new Map();
let requestedDocumentPath;
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
let fallbackActive = false;
let polling = false;
let fallbackState;
let shuttingDown = false;
let directoryChanges = Promise.resolve();
const changes = new Set();
const languageChanges = new Map();
const documentStamps = new Map();
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

function affectsRequestedDocument(filename) {
  return requestedDocumentPath === filename || requestedDocumentPath?.startsWith(`${filename}/`);
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
  if (fallbackActive) return;
  fallbackActive = true;
  queueFallback();
  schedule(true);
}

function queueFallback() {
  fallbackTimer = setTimeout(async () => {
    try {
      // A large inventory may take longer than the polling interval. Let its
      // callers receive that scan before invalidating it for the next poll.
      await currentRefresh?.catch(() => {});
      await catalogLoading?.catch(() => {});
      if (shuttingDown) return;
      polling = true;
      await refresh().catch(() => {});
    } finally {
      if (!shuttingDown) queueFallback();
    }
  }, 2000).unref();
}

async function pollState(result) {
  const filePaths = new Set(result.files.map(file => file.path));
  for (const entry of documents.entries.values()) filePaths.add(entry.path);
  for (const work of documents.pending.values()) filePaths.add(work.path);
  if (requestedDocumentPath) filePaths.add(requestedDocumentPath);
  for (const [filename, entry] of documentStamps) {
    if (entry.readers || filePaths.has(filename)) filePaths.add(filename);
    else documentStamps.delete(filename);
  }
  const directoryPaths = new Set([
    path.relative(repository.root, repository.scope),
    ...(repository.inventoryDirectories ?? []),
    ...repository.expandedIgnored,
  ]);
  const metadataPaths = new Set(
    [repository.gitDir, repository.commonDir].flatMap(directory =>
      ['config', 'info/exclude'].map(filename =>
        path.relative(repository.root, path.join(directory, filename)),
      ),
    ),
  );
  const entries = [
    ...[...filePaths].map(file => [file, 'file']),
    ...[...directoryPaths].map(directory => [directory, 'directory']),
    ...[...metadataPaths].map(filename => [filename, 'metadata']),
  ];
  const files = new Map();
  const directories = new Map();
  const metadata = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (next < entries.length) {
        const [filename, kind] = entries[next++];
        const stamp = await pollStamp(filename);
        (kind === 'metadata' ? metadata : kind === 'directory' ? directories : files).set(
          filename,
          stamp,
        );
      }
    }),
  );
  return { status: repository.statusFingerprint, files, directories, metadata };
}

async function pollStamp(filename) {
  try {
    const metadata = await lstat(path.join(repository.root, filename), { bigint: true });
    return `${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.mode}`;
  } catch (error) {
    return error.code;
  }
}

function polledPaths(before, after) {
  // A newly selected document or expanded directory is observed for the first
  // time here; adding it to the polling baseline is not a filesystem change.
  return [...after]
    .filter(([name, stamp]) => before.has(name) && before.get(name) !== stamp)
    .map(([name]) => name);
}

async function polledDocuments(observed) {
  const changes = [];
  // Read-start stamps live independently of a polling snapshot. A document can
  // open while that snapshot is collecting paths, or before the first fallback
  // baseline exists, and must not lose the metadata that predates its text.
  const reads = [...documentStamps];
  for (const [filename, entry] of reads) {
    const baseline = entry.stamp;
    if (!observed.files.has(filename)) observed.files.set(filename, await pollStamp(filename));
    const stamp = observed.files.get(filename);
    if ((await baseline) !== stamp) changes.push(filename);
    if (entry.stamp === baseline) entry.stamp = Promise.resolve(stamp);
  }
  return changes;
}

function invalidateCatalog() {
  // Never start overlapping inventories or discard an in-flight result. It is
  // a useful filesystem snapshot even when more edits arrive while it loads.
  if (!catalogLoading) catalog = undefined;
  catalogRevision++;
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
  let all = force || broadChanges;
  let refreshInventory = inventoryDirty || force;
  const poll = polling;
  polling = false;
  broadChanges = false;
  inventoryDirty = false;
  force = false;
  try {
    // Invalidate before starting slow Git work, so a document read completed
    // during the refresh can still be delivered to the editor.
    if (all) documents.invalidate();
    if (
      !all &&
      paths.length &&
      !paths.some(file => affectsRequestedDocument(path.relative(repository.root, file))) &&
      !(await repository.hasRelevantPaths(paths))
    )
      return snapshot;
    languages.changed(languageEvents);
    const start = performance.now();
    const result = await repository.snapshot();
    let changedPaths = paths.map(file => path.relative(repository.root, file));
    if (fallbackActive && (poll || !fallbackState)) {
      const observed = await pollState(result);
      const documentChanges = await polledDocuments(observed);
      if (documentChanges.length) documents.invalidate(documentChanges);
      changedPaths.push(...documentChanges);
      if (poll && fallbackState) {
        const statusChanged = observed.status !== fallbackState.status;
        const metadataChanged = polledPaths(fallbackState.metadata, observed.metadata).length > 0;
        const fileChanges = polledPaths(fallbackState.files, observed.files);
        const directoryChanges = polledPaths(fallbackState.directories, observed.directories);
        const newDirectories = [...observed.directories.keys()].some(
          name => !fallbackState.directories.has(name),
        );
        // Lost native events require polling, but a quiet poll must not reload
        // the editor, rebuild a large explorer or restart repository analysis.
        if (
          !all &&
          !refreshInventory &&
          !changedPaths.length &&
          !statusChanged &&
          !metadataChanged &&
          !fileChanges.length &&
          !directoryChanges.length &&
          !newDirectories &&
          watchError === snapshot?.watchError
        ) {
          fallbackState = observed;
          return snapshot;
        }
        if ((statusChanged || metadataChanged) && !all) {
          all = true;
          documents.invalidate();
        } else if (fileChanges.length) documents.invalidate(fileChanges);
        // Newly cataloged or expanded directories need one reconciliation: a
        // create may have happened after their entries were read but before
        // their first polling stamp was available.
        refreshInventory ||=
          statusChanged ||
          metadataChanged ||
          directoryChanges.length > 0 ||
          newDirectories ||
          fileChanges.some(filename => path.basename(filename) === '.gitignore');
        changedPaths = [...new Set([...changedPaths, ...fileChanges, ...directoryChanges])];
      }
      fallbackState = observed;
    }
    revision++;
    if (all) changedPaths = ['*'];
    howmany.changed(changedPaths);
    snapshotIndex = new Map(result.files.map(file => [file.path, file]));
    if (refreshInventory) invalidateCatalog();
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
  if (!catalog) {
    const requestedRevision = catalogRevision;
    const result = repository.files();
    catalog = catalogLoading = result;
    result.then(
      inventory => {
        catalogIndex = new Map(inventory.map(file => [file.path, file]));
        catalogLoading = undefined;
        // A later request reconciles changes observed during this scan. Waiting
        // for a completely quiet filesystem here starves reads during edits.
        if (requestedRevision !== catalogRevision) {
          catalog = undefined;
          // A final create/delete may have arrived after Git read the catalog.
          // Wake consumers once more even if no further native event follows.
          catalogRevision++;
          if (snapshot && !shuttingDown) {
            snapshot = { ...snapshot, changedPaths: [], inventoryRevision: catalogRevision };
            parentPort.postMessage({ event: 'change', value: snapshot });
          }
        }
      },
      () => {
        catalogLoading = undefined;
        if (catalog === result) catalog = undefined;
      },
    );
  }
  return catalog;
}

async function findFile(filePath) {
  if (snapshotIndex.has(filePath)) return snapshotIndex.get(filePath);
  // An existing catalog remains useful while its replacement scans. Known
  // clean files must not queue behind a full inventory of a large repository.
  const known = catalogIndex.get(filePath);
  if (known && !known.ignored) {
    try {
      const metadata = await lstat(path.join(repository.root, filePath));
      if (!metadata.isDirectory() || known.submodule) return known;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  await files();
  const file = snapshotIndex.get(filePath) ?? catalogIndex.get(filePath);
  return file?.directory ? undefined : (file ?? (await repository.ignoredFile(filePath)));
}

async function document(filePath, comparison, priority = false) {
  if (typeof filePath !== 'string' || !['head', 'unstaged', 'staged'].includes(comparison))
    throw new Error('Invalid document request');
  if (priority) requestedDocumentPath = filePath;
  let observed = documentStamps.get(filePath);
  if (!observed) {
    // Reads can begin before the watcher fails. Retain their initial metadata
    // too, while bounding stamps to cached, requested and in-flight documents.
    for (const [filename, entry] of documentStamps)
      if (!entry.readers && !documents.hasPath(filename) && filename !== requestedDocumentPath)
        documentStamps.delete(filename);
    observed = { stamp: pollStamp(filePath), readers: 0 };
    documentStamps.set(filePath, observed);
  }
  observed.readers++;
  try {
    await observed.stamp;
    const result = await documents.get(filePath, comparison, { priority });
    return { ...result, revision };
  } finally {
    observed.readers--;
  }
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
          if (base === catalogRevision && !catalogLoading) {
            catalogIndex = repository.inventoryMetadata;
            catalog = Promise.resolve([...catalogIndex.values()]);
          } else if (!catalogLoading) catalog = undefined;
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
    } else if (method === 'document') value = await document(args[0], args[1], true);
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
      clearTimeout(fallbackTimer);
      documents.dispose();
      // A renderer can request its first snapshot while native subscriptions
      // are still starting. Let that work finish before tearing down its isolate.
      await watchSetup;
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
    if (method === 'language-dispose') parentPort.close();
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});

const watchSetup = (async () => {
  for (const directory of new Set([repository.scope, repository.gitDir, repository.commonDir])) {
    if (shuttingDown) break;
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
            // Build and dependency churn below a closed ignored folder is not a
            // repository change. Filter it before it can become a wildcard batch;
            // explicitly opened ignored documents must still receive updates.
            const known = catalogIndex.has(relative);
            if (
              !documents.hasPath(relative) &&
              !affectsRequestedDocument(relative) &&
              ((!known && !snapshotIndex.has(relative) && collapsedIgnoredParent(relative)) ||
                (event.type === 'update' &&
                  repository.inventoryMetadata.get(relative)?.directory &&
                  !repository.expandedIgnored.has(relative)))
            )
              continue;
            documents.invalidate([relative]);
            if (!livePaths.has('*')) {
              if (livePaths.size < 256) livePaths.add(relative);
              else {
                livePaths.clear();
                livePaths.add('*');
              }
            }
            // FSEvents can retain FileCreated on existing paths; atomic saves also reuse paths.
            if (
              path.basename(event.path) === '.gitignore' ||
              (event.type === 'create' && (!known || !catalog || catalogLoading)) ||
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
      if (shuttingDown) {
        await subscription.unsubscribe();
        break;
      }
      subscriptions.push(subscription);
    } catch (error) {
      if (!shuttingDown) watchFailed(`Live watcher unavailable: ${error.message}`);
    }
  }
})();
await watchSetup;
if (!shuttingDown) {
  force = true;
  await refresh();
}

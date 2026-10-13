import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import watcher from '@parcel/watcher';
import { decorations } from './changes.mjs';
import { Repository } from './repository.mjs';
import { LanguageRuntime } from './language.mjs';

const repository = await Repository.open(workerData.directory);
const launchPath = await realpath(workerData.directory);
const initialPath = (await lstat(launchPath)).isFile() ? path.relative(repository.root, launchPath) : null;
const languages = new LanguageRuntime(repository.root, value => parentPort.postMessage({ event: 'language-event', value }));
let snapshot;
let catalog;
let catalogRevision = 0;
let revision = 0;
let timer;
let refreshing = false;
let currentRefresh;
let pending = false;
let force = false;
let watchError;
const changes = new Set();
const languageChanges = new Map();
const subscriptions = [];
const documents = new Map();

function gitMetadata(file) {
  for (const base of [repository.gitDir, repository.commonDir]) {
    const relative = path.relative(base, file);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return !relative || ['HEAD', 'index', 'packed-refs', 'config'].includes(relative) || relative.startsWith(`refs${path.sep}`);
    }
  }
  return null;
}

function schedule(all = false) {
  force ||= all;
  pending = true;
  if (!timer && !refreshing) timer = setTimeout(() => { timer = undefined; void refresh().catch(() => {}); }, 40);
}

function refresh() {
  if (refreshing) return currentRefresh;
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
  const all = force;
  force = false;
  try {
    if (!all && paths.length && !(await repository.hasRelevantPaths(paths))) return snapshot;
    languages.changed(languageEvents);
    const start = performance.now();
    const result = await repository.snapshot();
    revision++;
    const changedPaths = all ? ['*'] : paths.map(file => path.relative(repository.root, file));
    documents.clear();
    catalog = undefined;
    catalogRevision++;
    snapshot = { ...result, root: repository.root, scope: repository.scope, initialPath, revision, changedPaths, watchError, gitMs: performance.now() - start };
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
    catalog = result;
    result.catch(() => { if (catalog === result) catalog = undefined; });
    const inventory = await result;
    if (requestedRevision !== catalogRevision) return files();
    return inventory;
  }
  return catalog;
}

async function document(filePath, comparison) {
  if (typeof filePath !== 'string' || !['head', 'unstaged', 'staged'].includes(comparison)) throw new Error('Invalid document request');
  const key = `${comparison}\0${filePath}`;
  const file = snapshot?.files.find(file => file.path === filePath) ?? (await files()).find(file => file.path === filePath);
  if (!file) throw new Error('This file is no longer available in this directory.');
  const cached = documents.get(key);
  if (cached) { documents.delete(key); documents.set(key, cached); return cached; }
  const documentRevision = revision;
  const start = performance.now();
  const contents = await repository.contents(file, comparison);
  const result = { path: filePath, after: contents.after, note: contents.note, ...decorations(contents.before, contents.after), revision: documentRevision, elapsedMs: performance.now() - start };
  if (documentRevision === revision) documents.set(key, result);
  while (documents.size > 4) documents.delete(documents.keys().next().value);
  return result;
}

parentPort.on('message', async ({ id, method, args = [] }) => {
  try {
    let value;
    if (method === 'snapshot') value = snapshot ?? await refresh();
    else if (method === 'files') value = await files();
    else if (method === 'document') value = await document(...args);
    else if (method === 'language-open') {
      const input = args[0];
      const file = snapshot?.files.find(file => file.path === input?.path) ?? (await files()).find(file => file.path === input?.path);
      if (!file) throw new Error('Language document is not in this directory.');
      value = await languages.open(input);
    }
    else if (method === 'language-request') value = await languages.request(args[0]);
    else if (method === 'language-cancel') { languages.cancel(args[0]); value = null; }
    else if (method === 'language-close') { languages.close(args[0]); value = null; }
    else if (method === 'language-status') value = languages.status();
    else if (method === 'language-dispose') { await languages.dispose(); value = null; }
    else if (method === 'refresh') { force = true; if (refreshing) { schedule(true); value = snapshot; } else value = await refresh(); }
    else throw new Error('Unknown request');
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});

for (const directory of new Set([repository.scope, repository.gitDir, repository.commonDir])) {
  try {
    const subscription = await watcher.subscribe(directory, (error, events) => {
      if (error) { watchError = `Live watcher failed: ${error.message}; using a 2s refresh.`; schedule(true); return; }
      for (const event of events) {
        const metadata = gitMetadata(event.path);
        if (metadata === true || event.path === repository.scope) force = true;
        else if (metadata === null && event.path.startsWith(repository.scope + path.sep)) {
          if (languageChanges.size < 4096) languageChanges.set(event.path, event);
          if (changes.size < 256) changes.add(event.path); else force = true;
        }
      }
      if (force || changes.size) schedule();
    });
    subscriptions.push(subscription);
  } catch (error) { watchError = `Live watcher unavailable: ${error.message}; using a 2s refresh.`; }
}
setInterval(() => { if (watchError) schedule(true); }, 2000).unref();
force = true;
await refresh();

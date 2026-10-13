// Keep the native watcher library loaded while worker teardown joins its native threads.
import '@parcel/watcher';
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-session-'));
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  const write = (name, value) => writeFile(path.join(root, name), value);
  git('init', '-q');
  await mkdir(path.join(root, 'src'));
  await Promise.all(
    Array.from({ length: 1000 }, (_, index) =>
      write(`src/file${index}.txt`, `baseline ${index}\n`),
    ),
  );
  git('add', '.');
  const commit = () =>
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
  commit();
  const worker = new Worker(new URL('../electron/session.mjs', import.meta.url), {
    workerData: { directory: root },
  });
  const pending = new Map();
  const snapshots = [];
  let nextId = 0;
  let failure;
  worker.on('message', message => {
    if (message.event === 'change') snapshots.push(message.value);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
  });
  worker.on('error', error => {
    failure = error;
  });
  t.onTestFinished(async () => {
    try {
      await call('language-dispose');
    } finally {
      await worker.terminate();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(failure ?? new Error(`Timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, args });
    });
  const waitFor = async predicate => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const snapshot = snapshots.findLast(predicate);
      if (snapshot) return snapshot;
      await delay(20);
    }
    throw new Error('Timed out waiting for filesystem snapshot');
  };
  await waitFor(snapshot => snapshot.revision > 0);
  return { root, write, git, commit, call, waitFor };
}

test('editor saves invalidate cached text and sync Git status without waiting for the watcher', async t => {
  const repo = await fixture(t);
  const initial = await repo.call('document', 'src/file0.txt', 'head');
  assert.equal(initial.editable, true);
  await repo.call('save', 'src/file0.txt', 'saved in editor\n', initial.after);
  const saved = await repo.call('document', 'src/file0.txt', 'head');
  assert.equal(saved.after, 'saved in editor\n');
  assert.ok(saved.decorations.length);
  await repo.waitFor(snapshot => snapshot.files.some(file => file.path === 'src/file0.txt'));
  await assert.rejects(
    repo.call('save', 'not-in-inventory.txt', 'edit', ''),
    /no longer available/,
  );
});

test('concurrent saves retain the inventory and unrelated cached documents; new files and commits invalidate correctly', async t => {
  const repo = await fixture(t);
  assert.equal((await repo.call('files')).length, 1000);
  const baseline = await repo.call('performance');
  const document = await repo.call('document', 'src/file0.txt', 'head');
  assert.equal(document.after, 'baseline 0\n');
  const before = await repo.call('performance');
  const start = (await repo.call('snapshot')).revision;
  await Promise.all(
    Array.from({ length: 512 }, (_, index) =>
      repo.write(`src/file${index + 1}.txt`, `concurrent ${index}\n`),
    ),
  );
  await repo.waitFor(snapshot => snapshot.revision > start && snapshot.files.length === 512);
  assert.equal((await repo.call('files')).length, 1000);
  const cached = await repo.call('document', 'src/file0.txt', 'head');
  const after = await repo.call('performance');
  assert.equal(cached.after, 'baseline 0\n');
  assert.equal(
    after.inventoryRevision,
    baseline.inventoryRevision,
    'content-only saves keep the inventory',
  );
  assert.equal(
    after.documents.loads,
    before.documents.loads,
    'unrelated saves retain the document cache',
  );
  assert.ok(after.documents.hits > before.documents.hits);
  await repo.write('src/file0.txt', 'latest visible contents\n');
  await repo.waitFor(
    snapshot =>
      snapshot.revision > cached.revision && snapshot.changedPaths.includes('src/file0.txt'),
  );
  const latest = await repo.call('document', 'src/file0.txt', 'head');
  assert.equal(latest.after, 'latest visible contents\n');
  assert.ok(latest.decorations.length);
  const revision = (await repo.call('snapshot')).revision;
  await repo.write('src/new.txt', 'new file\n');
  await repo.waitFor(
    snapshot =>
      snapshot.revision > revision && snapshot.files.some(file => file.path === 'src/new.txt'),
  );
  assert.equal((await repo.call('files')).length, 1001);
  assert.ok((await repo.call('performance')).inventoryRevision > after.inventoryRevision);
  repo.git('add', '.');
  repo.commit();
  await repo.waitFor(
    snapshot => snapshot.files.length === 0 && snapshot.revision > latest.revision,
  );
  const committed = await repo.call('document', 'src/file0.txt', 'head');
  assert.equal(committed.after, latest.after);
  assert.deepEqual(committed.decorations, []);
});

test('ignored folders load only explicit expansions and release catalog and document cache entries on collapse', async t => {
  const repo = await fixture(t);
  await repo.write('.gitignore', 'cache/\n');
  await mkdir(path.join(repo.root, 'cache/deep'), { recursive: true });
  await repo.write('cache/a.txt', 'ignored document\n');
  await repo.write('cache/deep/b.txt', 'nested ignored document\n');
  await repo.call('refresh');
  const cold = await repo.call('files-delta', null);
  assert.ok(cold.files.some(file => file.path === 'cache' && file.ignored && file.directory));
  assert.ok(!cold.files.some(file => file.path.startsWith('cache/')));
  const loads = (await repo.call('performance')).documents.loads;
  await repo.call('directory-expanded', 'cache', true);
  const opened = await repo.call('files-delta', cold.revision);
  assert.deepEqual(
    opened.files.map(file => file.path),
    ['cache/a.txt', 'cache/deep'],
  );
  assert.equal((await repo.call('performance')).documents.loads, loads);
  assert.ok(!(await repo.call('files')).some(file => file.ignored));
  await repo.call('document', 'cache/a.txt', 'head');
  await repo.call('directory-expanded', 'cache/deep', true);
  const nested = await repo.call('files-delta', opened.revision);
  assert.deepEqual(
    nested.files.map(file => file.path),
    ['cache/deep/b.txt'],
  );
  await repo.call('directory-expanded', 'cache', false);
  const collapsed = await repo.call('files-delta', nested.revision);
  assert.deepEqual(collapsed.removed, ['cache/a.txt', 'cache/deep', 'cache/deep/b.txt']);
  assert.equal((await repo.call('performance')).documents.entries, 0);
  // The visible editor can still save after its explorer folder was collapsed.
  await repo.call('save', 'cache/a.txt', 'saved while collapsed\n', 'ignored document\n');
  assert.equal(
    (await repo.call('document', 'cache/a.txt', 'head')).after,
    'saved while collapsed\n',
  );
  await repo.write('cache/hidden.txt', 'created while closed\n');
  await repo.call('directory-expanded', 'cache', true);
  const reopened = await repo.call('files-delta', collapsed.revision);
  assert.ok(reopened.files.some(file => file.path === 'cache/deep'));
  assert.ok(reopened.files.some(file => file.path === 'cache/hidden.txt'));
  assert.ok(!reopened.files.some(file => file.path === 'cache/deep/b.txt'));
  const revision = (await repo.call('snapshot')).revision;
  await repo.write('cache/new.txt', 'new ignored document\n');
  await repo.waitFor(
    snapshot => snapshot.revision > revision && snapshot.changedPaths.includes('cache/new.txt'),
  );
  const added = await repo.call('files-delta', reopened.revision);
  assert.ok(added.files.some(file => file.path === 'cache/new.txt'));
});

// Keep the native watcher loaded until the session worker has shut down.
import '@parcel/watcher';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { test } from 'vite-plus/test';
import { Repository } from '../electron/repository.mjs';

/** @typedef {Awaited<ReturnType<Repository['captureCheckpoint']>>} Checkpoint */
/** @typedef {Awaited<ReturnType<Repository['checkpointFiles']>>[number]} CheckpointFile */
/** @typedef {{ path: string, reviewVersion: number }} ReviewRow */
/** @typedef {{ id: number, files: ReviewRow[] }} SessionCheckpoint */
/** @typedef {{ checkpoint: SessionCheckpoint, files: ReviewRow[] }} SessionSnapshot */
/** @typedef {{ before: string, after: string, reviewVersion: number }} SessionDocument */
/** @typedef {{ preview?: { before: { size: number, hex?: string }, after: { size: number, hex?: string } } }} PreviewDocument */

/** @param {string} first @param {string} second */
const comparePaths = (first, second) => first.localeCompare(second);

/**
 * @param {{ onTestFinished(callback: () => void | Promise<void>): void }} t
 * @param {Record<string, string | Buffer>} initial
 */
async function fixture(t, initial, { scope = '', committed = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-checkpoint-')));
  /** @param {...string} args */
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  /** @param {string} filename @param {string | Buffer} contents */
  const write = async (filename, contents) => {
    const absolute = path.join(root, filename);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  };
  /** @param {string} filename */
  const remove = filename => rm(path.join(root, filename));
  const commit = () => {
    git('add', '-A');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Fixture',
    );
  };
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  git('init', '-q');
  await Promise.all(
    Object.entries(initial).map(([filename, contents]) => write(filename, contents)),
  );
  if (committed) commit();
  const repository = await Repository.open(path.join(root, scope));
  return { root, git, write, remove, commit, repository };
}

/** @param {Repository} repository @param {Checkpoint} checkpoint */
async function checkpointChanges(repository, checkpoint) {
  const files = await repository.checkpointFiles(checkpoint, await repository.snapshot());
  return new Map(files.map(file => [file.path, file]));
}

/**
 * @param {Repository} repository
 * @param {Checkpoint} checkpoint
 * @param {CheckpointFile | undefined} file
 * @param {string} before
 * @param {string} after
 */
async function assertContents(repository, checkpoint, file, before, after) {
  assert.ok(file, 'Expected a file in the checkpoint review');
  const result = await repository.checkpointContents(checkpoint, file);
  assert.equal(result.before, before);
  assert.equal(result.after, after);
}

test('captures the working bytes of staged, unstaged and untracked files without changing Git', async t => {
  const { root, git, write, repository } = await fixture(t, {
    'staged.txt': 'committed staged\n',
    'unstaged.txt': 'committed unstaged\n',
    'clean.txt': 'committed clean\n',
  });
  await write('staged.txt', 'staged before capture\n');
  git('add', 'staged.txt');
  await Promise.all([
    write('staged.txt', 'working before capture\n'),
    write('unstaged.txt', 'unstaged before capture\n'),
    write('untracked.txt', 'untracked before capture\n'),
  ]);
  const indexPath = path.join(root, '.git', 'index');
  const originalIndex = await readFile(indexPath);
  const originalHead = git('rev-parse', 'HEAD');
  const checkpoint = await repository.captureCheckpoint();
  assert.ok(Number.isFinite(checkpoint.capturedAt));
  assert.deepEqual(await readFile(indexPath), originalIndex);
  assert.deepEqual(git('rev-parse', 'HEAD'), originalHead);
  assert.deepEqual([...(await checkpointChanges(repository, checkpoint)).keys()], []);

  await Promise.all([
    write('staged.txt', 'after capture\n'),
    write('unstaged.txt', 'committed unstaged\n'),
    write('clean.txt', 'modified clean file\n'),
    write('untracked.txt', 'updated untracked file\n'),
  ]);
  const changes = await checkpointChanges(repository, checkpoint);
  assert.deepEqual([...changes.keys()].sort(comparePaths), [
    'clean.txt',
    'staged.txt',
    'unstaged.txt',
    'untracked.txt',
  ]);
  for (const [filename, before, after] of /** @type {const} */ ([
    ['staged.txt', 'working before capture\n', 'after capture\n'],
    ['unstaged.txt', 'unstaged before capture\n', 'committed unstaged\n'],
    ['clean.txt', 'committed clean\n', 'modified clean file\n'],
    ['untracked.txt', 'untracked before capture\n', 'updated untracked file\n'],
  ]))
    await assertContents(repository, checkpoint, changes.get(filename), before, after);

  git('add', 'staged.txt');
  const afterStaging = await checkpointChanges(repository, checkpoint);
  assert.ok(afterStaging.has('staged.txt'));
  assert.equal(afterStaging.get('staged.txt')?.statusKey, changes.get('staged.txt')?.statusKey);
  git('add', 'unstaged.txt');
  await write('unstaged.txt', 'unstaged before capture\n');
  assert.equal((await checkpointChanges(repository, checkpoint)).has('unstaged.txt'), false);
});

test('checkpoint tracks file existence, renames and changes that have moved into HEAD', async t => {
  const { git, write, remove, commit, repository } = await fixture(t, {
    'remove-empty.txt': '',
    'renamed-before.txt': 'rename me\n',
    'tracked.txt': 'original\n',
  });
  await write('remove-untracked.txt', 'untracked before capture\n');
  const checkpoint = await repository.captureCheckpoint();

  git('mv', 'renamed-before.txt', 'renamed-after.txt');
  await Promise.all([
    remove('remove-empty.txt'),
    remove('remove-untracked.txt'),
    write('add-empty.txt', ''),
    write('tracked.txt', 'new HEAD\n'),
  ]);
  commit();
  assert.deepEqual((await repository.snapshot()).files, []);

  const changes = await checkpointChanges(repository, checkpoint);
  const rename = changes.get('renamed-after.txt');
  assert.ok(rename);
  if (rename.originalPath === 'renamed-before.txt') {
    await assertContents(repository, checkpoint, rename, 'rename me\n', 'rename me\n');
  } else {
    await assertContents(repository, checkpoint, rename, '', 'rename me\n');
    await assertContents(
      repository,
      checkpoint,
      changes.get('renamed-before.txt'),
      'rename me\n',
      '',
    );
  }
  for (const [filename, before, after] of /** @type {const} */ ([
    ['remove-untracked.txt', 'untracked before capture\n', ''],
    ['tracked.txt', 'original\n', 'new HEAD\n'],
  ]))
    await assertContents(repository, checkpoint, changes.get(filename), before, after);
  for (const [filename, note] of Object.entries({
    'remove-empty.txt': /empty file was deleted/,
    'add-empty.txt': /empty file was added/,
  })) {
    const file = changes.get(filename);
    assert.ok(file, `Expected ${filename} in the checkpoint review`);
    assert.match((await repository.checkpointContents(checkpoint, file)).note ?? '', note);
  }
  await write('tracked.txt', 'original\n');
  assert.equal((await checkpointChanges(repository, checkpoint)).has('tracked.txt'), false);
});

test('checkpoint compares paths that switch between files and directories', async t => {
  const { root, write, remove, repository } = await fixture(t, {
    'old-directory/child.txt': 'old child\n',
    'old-file': 'old file\n',
  });
  const checkpoint = await repository.captureCheckpoint();
  await rm(path.join(root, 'old-directory'), { recursive: true });
  await remove('old-file');
  await Promise.all([
    write('old-directory', 'new file\n'),
    write('old-file/child.txt', 'new child\n'),
  ]);

  const changes = await checkpointChanges(repository, checkpoint);
  for (const [filename, before, after] of /** @type {const} */ ([
    ['old-directory', '', 'new file\n'],
    ['old-directory/child.txt', 'old child\n', ''],
    ['old-file', 'old file\n', ''],
    ['old-file/child.txt', '', 'new child\n'],
  ]))
    await assertContents(repository, checkpoint, changes.get(filename), before, after);
});

test('checkpoint remains scoped when paths move in or out of the open directory', async t => {
  const { git, write, commit, repository } = await fixture(
    t,
    {
      '.gitignore': '*.scratch\n',
      '[feature]/keep.txt': 'inside\n',
      '[feature]/move-out.txt': 'moving out\n',
      '[feature]-neighbor/move-in.txt': 'moving in\n',
      '[feature]-neighbor/keep.txt': 'outside\n',
    },
    { scope: '[feature]' },
  );
  const checkpoint = await repository.captureCheckpoint();
  git('mv', '[feature]/move-out.txt', '[feature]-neighbor/move-out.txt');
  git('mv', '[feature]-neighbor/move-in.txt', '[feature]/move-in.txt');
  await Promise.all([
    write('[feature]/keep.txt', 'inside change\n'),
    write('[feature]-neighbor/keep.txt', 'outside change\n'),
    write('[feature]/ignored.scratch', 'ignored content\n'),
  ]);

  const verifyScope = async () => {
    const changes = await checkpointChanges(repository, checkpoint);
    assert.deepEqual([...changes.keys()].sort(comparePaths), [
      '[feature]/keep.txt',
      '[feature]/move-in.txt',
      '[feature]/move-out.txt',
    ]);
    for (const [filename, before, after] of /** @type {const} */ ([
      ['[feature]/move-out.txt', 'moving out\n', ''],
      ['[feature]/move-in.txt', '', 'moving in\n'],
    ]))
      await assertContents(repository, checkpoint, changes.get(filename), before, after);
  };
  await verifyScope();
  commit();
  await verifyScope();
});

test('checkpoint works before a repository has its first commit', async t => {
  const { git, write, commit, repository } = await fixture(
    t,
    { 'existing.txt': 'before the first commit\n' },
    { committed: false },
  );
  git('add', 'existing.txt');
  const checkpoint = await repository.captureCheckpoint();
  assert.equal((await checkpointChanges(repository, checkpoint)).size, 0);
  await write('new.txt', 'added later\n');
  commit();

  const changes = await checkpointChanges(repository, checkpoint);
  assert.deepEqual([...changes.keys()], ['new.txt']);
  await assertContents(repository, checkpoint, changes.get('new.txt'), '', 'added later\n');
});

test('checkpoint detects equal-length binary edits beyond the preview', async t => {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 32);
  const { write, repository } = await fixture(t, { 'asset.bin': bytes });
  bytes[bytes.length - 1] = 1;
  await write('asset.bin', bytes);
  const checkpoint = await repository.captureCheckpoint();
  assert.equal((await checkpointChanges(repository, checkpoint)).size, 0);

  bytes[bytes.length - 1] = 2;
  await write('asset.bin', bytes);
  const file = (await checkpointChanges(repository, checkpoint)).get('asset.bin');
  assert.ok(file);
  const { preview } = /** @type {PreviewDocument} */ (
    await repository.checkpointContents(checkpoint, file)
  );
  assert.ok(preview);
  assert.equal(preview.before.size, bytes.length);
  assert.equal(preview.after.size, bytes.length);
  assert.ok('hex' in preview.before && 'hex' in preview.after);
  assert.equal(preview.before.hex, preview.after.hex);
});

/** @param {string} directory */
function sessionWorker(directory) {
  const source = `
    import watcher from ${JSON.stringify(import.meta.resolve('@parcel/watcher'))};
    import { parentPort } from 'node:worker_threads';
    let workspaceWatcher;
    watcher.subscribe = async (_directory, callback) => {
      workspaceWatcher ??= callback;
      return { unsubscribe: async () => {} };
    };
    parentPort.on('message', ({ testPath }) => {
      if (testPath) workspaceWatcher(null, [{ path: testPath, type: 'update' }]);
    });
    await import(${JSON.stringify(new URL('../electron/session.mjs', import.meta.url).href)});
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { directory },
  });
  let nextId = 0;
  /** @type {Error | undefined} */
  let failure;
  /** @type {((snapshot: SessionSnapshot) => void) | undefined} */
  let watchUpdate;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void }>} */
  const pending = new Map();
  /** @type {() => void} */
  let markReady = () => {};
  /** @type {(reason: Error) => void} */
  let failStartup = () => {};
  const ready = new Promise((resolve, reject) => {
    markReady = () => resolve(undefined);
    failStartup = reject;
  });
  worker.on('message', message => {
    if (message.event === 'change') {
      markReady();
      watchUpdate?.(message.value);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  });
  worker.on('error', error => {
    failure = error;
    failStartup(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  /** @param {string} method @param {...unknown} args */
  const call = async (method, ...args) => {
    await ready;
    if (failure) throw failure;
    const id = ++nextId;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;
    return new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 4000);
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    }).finally(() => {
      pending.delete(id);
      clearTimeout(timeout);
    });
  };
  const dispose = async () => {
    try {
      await call('language-dispose');
    } finally {
      await worker.terminate();
    }
  };
  /** @param {string} filename @param {(snapshot: SessionSnapshot) => boolean} predicate */
  const change = async (filename, predicate) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;
    /** @type {Promise<SessionSnapshot>} */
    const changed = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out watching ${filename}`)), 4000);
      watchUpdate = snapshot => {
        if (predicate(snapshot)) resolve(snapshot);
      };
      worker.postMessage({ testPath: path.join(directory, filename) });
    });
    return changed.finally(() => {
      clearTimeout(timeout);
      watchUpdate = undefined;
    });
  };
  return { call, dispose, change };
}

test('session separates checkpoint comparisons and review versions from HEAD', async t => {
  const { root, git, write } = await fixture(t, { 'file.txt': 'HEAD\n' });
  await write('file.txt', 'first pass\n');
  const { call, dispose, change } = sessionWorker(root);
  t.onTestFinished(dispose);
  const first = /** @type {SessionSnapshot} */ (await call('capture-checkpoint'));
  const mode = `checkpoint:${first.checkpoint.id}`;
  assert.deepEqual(first.checkpoint.files, []);
  assert.deepEqual(
    first.files.map(file => file.path),
    ['file.txt'],
  );

  await write('file.txt', 'second pass\n');
  const edited = await change('file.txt', next => next.checkpoint?.files.length === 1);
  const [row] = edited.checkpoint.files;
  assert.ok(row);
  assert.equal(row.path, 'file.txt');
  assert.ok(Number.isSafeInteger(row.reviewVersion));
  const head = /** @type {SessionDocument} */ (await call('document', row.path, 'head'));
  const checkpoint = /** @type {SessionDocument} */ (await call('document', row.path, mode));
  assert.equal(head.before, 'HEAD\n');
  assert.equal(checkpoint.before, 'first pass\n');
  assert.equal(checkpoint.after, 'second pass\n');
  assert.equal(checkpoint.reviewVersion, row.reviewVersion);

  git('add', 'file.txt');
  const staged = /** @type {SessionSnapshot} */ (await call('refresh'));
  assert.equal(staged.checkpoint.files[0]?.reviewVersion, row.reviewVersion);
  assert.ok(staged.files[0] && edited.files[0]);
  assert.notEqual(staged.files[0].reviewVersion, edited.files[0].reviewVersion);

  const replacement = /** @type {SessionSnapshot} */ (await call('capture-checkpoint'));
  assert.notEqual(replacement.checkpoint.id, first.checkpoint.id);
  assert.deepEqual(replacement.checkpoint.files, []);
  await assert.rejects(call('document', row.path, mode), /Invalid document request|replaced/);
  await write('file.txt', 'third pass\n');
  await call('refresh');
  const next = /** @type {SessionDocument} */ (
    await call('document', row.path, `checkpoint:${replacement.checkpoint.id}`)
  );
  assert.equal(next.before, 'second pass\n');
  assert.equal(next.after, 'third pass\n');
});

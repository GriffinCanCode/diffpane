import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentCache } from '../electron/document-cache.ts';
import { DiffRuntime } from '../electron/diff-runtime.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test('duplicate requests share work and bounded reads leave other paths queued', async () => {
  const reads = [];
  const cache = new DocumentCache((path, comparison) => {
    const result = deferred();
    reads.push({ path, comparison, ...result });
    return result.promise;
  });
  const first = cache.get('first', 'head');
  assert.equal(cache.get('first', 'head'), first);
  const second = cache.get('second', 'head');
  const third = cache.get('third', 'staged');
  assert.equal(reads.length, 2);
  assert.equal(cache.stats().queued, 1);
  reads[0].resolve({ after: 'first' });
  await first;
  assert.equal(reads.length, 3);
  assert.equal(reads[2].comparison, 'staged');
  reads[1].resolve({ after: 'second' });
  reads[2].resolve({ after: 'third' });
  await Promise.all([second, third]);
  assert.equal((await cache.get('first', 'head')).after, 'first');
  assert.equal(cache.stats().loads, 3);
  assert.equal(cache.stats().hits, 1);
});

test('newest visible requests overtake queued reads while ordinary requests retain FIFO order', async () => {
  const reads = [];
  const cache = new DocumentCache(
    path => {
      const result = deferred();
      reads.push({ path, ...result });
      return result.promise;
    },
    { concurrency: 1 },
  );
  const requests = new Map([
    ['running', cache.get('running', 'head')],
    ['first queued', cache.get('first queued', 'head')],
    ['second queued', cache.get('second queued', 'head', { priority: false })],
    ['older visible', cache.get('older visible', 'head', { priority: true })],
    ['newest visible', cache.get('newest visible', 'head', { priority: true })],
  ]);
  assert.equal(reads.length, 1);
  const order = ['running', 'newest visible', 'older visible', 'first queued', 'second queued'];
  for (const [index, path] of order.entries()) {
    assert.equal(reads[index].path, path);
    assert.equal(cache.stats().running, 1);
    reads[index].resolve({ after: path });
    await requests.get(path);
  }
  assert.equal(cache.stats().loads, order.length);
  assert.equal(cache.stats().queued, 0);
});

test('a duplicate visible request promotes queued work without duplicating queued or active reads', async () => {
  const reads = [];
  const cache = new DocumentCache(
    path => {
      const result = deferred();
      reads.push({ path, ...result });
      return result.promise;
    },
    { concurrency: 1 },
  );
  const running = cache.get('running', 'head');
  const queued = cache.get('queued', 'head');
  const promoted = cache.get('promoted', 'head');
  assert.equal(cache.get('promoted', 'head', { priority: true }), promoted);
  assert.equal(cache.get('promoted', 'head', { priority: true }), promoted);
  assert.equal(cache.get('running', 'head', { priority: true }), running);
  assert.equal(cache.stats().queued, 2);
  assert.equal(reads.length, 1);
  reads[0].resolve({ after: 'running' });
  await running;
  assert.equal(reads[1].path, 'promoted');
  reads[1].resolve({ after: 'promoted' });
  await promoted;
  assert.equal(reads[2].path, 'queued');
  reads[2].resolve({ after: 'queued' });
  await queued;
  assert.equal(cache.stats().loads, 3);
  assert.equal(cache.stats().queued, 0);
});

test('an invalidated visible read retries behind newer visible requests', async () => {
  const reads = [];
  const cache = new DocumentCache(
    path => {
      const result = deferred();
      reads.push({ path, ...result });
      return result.promise;
    },
    { concurrency: 1 },
  );
  const previous = cache.get('previous', 'head', { priority: true });
  const current = cache.get('current', 'head', { priority: true });
  cache.invalidate(['previous']);
  reads[0].resolve({ after: 'obsolete' });
  await setImmediate();
  assert.equal(reads[1].path, 'current');
  reads[1].resolve({ after: 'current' });
  await current;
  assert.equal(reads[2].path, 'previous');
  reads[2].resolve({ after: 'updated previous' });
  assert.equal((await previous).after, 'updated previous');
  assert.equal(cache.stats().retries, 1);
});

test('a save during an in-flight read retries without publishing obsolete contents', async () => {
  const reads = [];
  const cache = new DocumentCache(() => {
    const result = deferred();
    reads.push(result);
    return result.promise;
  });
  const result = cache.get('src/file.ts', 'head');
  cache.invalidate(['src/file.ts']);
  reads[0].resolve({ after: 'obsolete' });
  await setImmediate();
  assert.equal(reads.length, 2);
  reads[1].resolve({ after: 'latest' });
  assert.equal((await result).after, 'latest');
  assert.equal((await cache.get('src/file.ts', 'head')).after, 'latest');
  assert.equal(cache.stats().retries, 1);
});

test('continuous edits finish a shared read after one retry without caching its invalidated snapshot', async t => {
  const reads = [];
  const cache = new DocumentCache(() => {
    const result = deferred();
    reads.push(result);
    return result.promise;
  });
  t.onTestFinished(() => cache.dispose());
  const result = cache.get('src/file.ts', 'head');
  assert.equal(cache.get('src/file.ts', 'head'), result);
  // Attach a rejection handler so disposal also settles this test on regression.
  const settled = result.catch(error => error);
  cache.invalidate(['src']);
  reads[0].resolve({ after: 'first snapshot' });
  await setImmediate();
  assert.equal(reads.length, 2);
  cache.invalidate();
  reads[1].resolve({ after: 'second snapshot' });
  await setImmediate();
  assert.equal(reads.length, 2);
  assert.equal((await settled).after, 'second snapshot');
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
  assert.equal(cache.stats().retries, 1);

  const next = cache.get('src/file.ts', 'head');
  assert.equal(reads.length, 3);
  reads[2].resolve({ after: 'settled contents' });
  assert.equal((await next).after, 'settled contents');
  assert.equal((await cache.get('src/file.ts', 'head')).after, 'settled contents');
  assert.equal(cache.stats().loads, 3);
});

test('continuous edits cannot keep failed reads pending forever', async t => {
  const reads = [];
  const cache = new DocumentCache(() => {
    const result = deferred();
    reads.push(result);
    return result.promise;
  });
  t.onTestFinished(() => cache.dispose());
  const result = cache.get('file', 'head').catch(error => error);
  cache.invalidate();
  reads[0].reject(new Error('first failure'));
  await setImmediate();
  assert.equal(reads.length, 2);
  cache.invalidate();
  reads[1].reject(new Error('latest failure'));
  await setImmediate();
  assert.equal(reads.length, 2);
  assert.match((await result).message, /latest failure/);
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.stats().running, 0);
  assert.equal(cache.stats().queued, 0);
  assert.equal(cache.stats().entries, 0);
});

test('an invalidated retry failure can display the last successful snapshot without caching it', async t => {
  const reads = [];
  const cache = new DocumentCache(() => {
    const result = deferred();
    reads.push(result);
    return result.promise;
  });
  t.onTestFinished(() => cache.dispose());
  const result = cache.get('file', 'head').catch(error => error);
  cache.invalidate();
  reads[0].resolve({ after: 'readable snapshot' });
  await setImmediate();
  cache.invalidate();
  reads[1].reject(new Error('file replaced while reading'));
  await setImmediate();
  assert.equal(reads.length, 2);
  assert.equal((await result).after, 'readable snapshot');
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.stats().entries, 0);
});

test('a failed retry without another edit still reports the current file error', async () => {
  const reads = [];
  const cache = new DocumentCache(() => {
    const result = deferred();
    reads.push(result);
    return result.promise;
  });
  const result = assert.rejects(cache.get('file', 'head'), /file was deleted/);
  cache.invalidate();
  reads[0].resolve({ after: 'obsolete snapshot' });
  await setImmediate();
  reads[1].reject(new Error('file was deleted'));
  await result;
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.stats().entries, 0);
});

test('document tracking includes cached, running and queued descendants without matching sibling names', async () => {
  const read = deferred();
  const cache = new DocumentCache(
    path => (path === 'ignored/cached' ? Promise.resolve({ after: path }) : read.promise),
    { concurrency: 1, maxEntries: 1 },
  );
  await cache.get('ignored/cached', 'head');
  assert.equal(cache.hasPath('ignored/cached'), true);
  assert.equal(cache.hasPath('ignored'), true);
  assert.equal(cache.hasPath('ignore'), false);
  const running = cache.get('ignored/running', 'head');
  const queued = cache.get('ignored/queued', 'head');
  assert.equal(cache.hasPath('ignored/running'), true);
  assert.equal(cache.hasPath('ignored/queued'), true);
  cache.invalidate(['ignored/cached']);
  assert.equal(cache.hasPath('ignored/cached'), false);
  assert.equal(cache.hasPath('ignored'), true);
  read.resolve({ after: 'ready' });
  await Promise.all([running, queued]);
  assert.equal(cache.hasPath('ignored/running'), false);
  assert.equal(cache.hasPath('ignored/queued'), true);
  cache.dispose();
  assert.equal(cache.hasPath('ignored'), false);
});

test('unrelated saves retain cached documents, directory removal invalidates descendants and metadata invalidates all', async () => {
  const cache = new DocumentCache(async path => ({ after: path }));
  await Promise.all(['src/a', 'src/deep/b', 'src-other/c'].map(path => cache.get(path, 'head')));
  cache.invalidate(['unrelated']);
  assert.equal(cache.stats().entries, 3);
  cache.invalidate(['src']);
  assert.equal(cache.stats().entries, 1);
  assert.equal((await cache.get('src-other/c', 'head')).after, 'src-other/c');
  cache.invalidate();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
});

test('memory and entry budgets evict least-recently-used documents without caching oversized values', async () => {
  const cache = new DocumentCache(async path => ({ after: path }), { maxEntries: 2, maxBytes: 20 });
  await cache.get('a', 'head');
  await cache.get('b', 'head');
  await cache.get('a', 'head');
  await cache.get('c', 'head');
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().bytes, 4);
  await cache.get('b', 'head');
  assert.equal(cache.stats().loads, 4);
  await cache.get('oversized'.repeat(20), 'head');
  assert.equal(cache.stats().entries, 2);
  assert.ok(cache.stats().bytes <= 20);
});

test('failed reads do not poison retries', async () => {
  let reads = 0;
  const cache = new DocumentCache(async () => {
    if (++reads === 1) throw new Error('temporary');
    return { after: 'ready' };
  });
  await assert.rejects(cache.get('file', 'head'), /temporary/);
  assert.equal((await cache.get('file', 'head')).after, 'ready');
});

test('media and binary preview payloads count toward the document cache budget', async () => {
  const cache = new DocumentCache(
    async () => ({
      preview: { after: { data: 'x'.repeat(100), hex: 'x'.repeat(100) } },
    }),
    { maxBytes: 300 },
  );
  await cache.get('image.png', 'head');
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
});

test('diff computation runs in its own worker and preserves current-line highlights', async t => {
  const runtime = new DiffRuntime();
  t.onTestFinished(() => runtime.dispose());
  assert.deepEqual(await runtime.calculate('same', 'same'), {
    decorations: [],
    beforeDecorations: [],
    additions: 0,
    deletions: 0,
  });
  assert.equal(Boolean(runtime.worker), false);
  const results = await Promise.all([
    runtime.calculate('before\n', 'after\n'),
    runtime.calculate('unchanged\nremoved\n', 'unchanged\n'),
  ]);
  assert.equal(results[0].additions, 1);
  assert.equal(results[1].deletions, 1);
  assert.ok(results[0].decorations.some(change => change.kind === 'modified'));
  assert.equal(runtime.pending.size, 0);
});

test('idle diff workers are released and subsequent edits recreate them without stale exit failures', async t => {
  const runtime = new DiffRuntime({ idleMs: 40 });
  t.onTestFinished(() => runtime.dispose());
  await runtime.calculate('before\n', 'after\n');
  const first = runtime.worker;
  assert.ok(first);
  const deadline = Date.now() + 5000;
  while (runtime.worker && Date.now() < deadline) await delay(10);
  assert.equal(runtime.worker, null);
  assert.equal(runtime.pending.size, 0);
  assert.equal((await runtime.calculate('one\n', 'two\n')).additions, 1);
  assert.notEqual(runtime.worker, first);
  await runtime.dispose();
  assert.equal(runtime.stopping.size, 0);
  await assert.rejects(runtime.calculate('a', 'b'), /closed/);
});

test('closing a document cache rejects queued reads and never retains a late result', async () => {
  const read = deferred();
  const cache = new DocumentCache(() => read.promise, { concurrency: 1 });
  const running = assert.rejects(cache.get('a', 'head'), /closed/);
  const queued = assert.rejects(cache.get('b', 'head'), /closed/);
  cache.dispose();
  read.resolve({ after: 'late result' });
  await Promise.all([running, queued]);
  await setImmediate();
  assert.equal(cache.stats().queued, 0);
  assert.equal(cache.stats().running, 0);
  assert.equal(cache.stats().bytes, 0);
  assert.equal(cache.stats().entries, 0);
});

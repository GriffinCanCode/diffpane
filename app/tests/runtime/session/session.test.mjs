// Keep the native watcher library loaded while worker teardown joins its native threads.
import '@parcel/watcher'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { test } from 'vite-plus/test'

import {
  isWorkspaceSnapshot,
  postWorkerMessage,
  sessionResponse,
  workerFailure,
  workerMessage,
} from './session-fixture.ts'

/** @import { TestContext } from 'vite-plus/test' */
/** @import { ErrorDetails } from '../../../shared/recovery/app-errors.ts' */
/** @import { SessionVersions } from '../../../electron/runtime/session/session-protocol.ts' */
/** @import { WorkspaceSnapshot } from '../../../electron/runtime/session/workspace-types.ts' */
/** @import { TestedMethod, SessionResponse } from './session-fixture.ts' */

/** @param {TestContext} t @param {{fileCount?: number, setup?: string, scope?: string, versions?: SessionVersions}} [options] */
async function fixture(t, { fileCount = 1000, setup = '', scope = '', versions } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-session-'))
  /** @param {...string} args */
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  /** @param {string} name @param {string | Buffer} value */
  const write = (name, value) => writeFile(path.join(root, name), value)
  git('init', '-q')
  await mkdir(path.join(root, 'src'))
  await Promise.all(
    Array.from({ length: fileCount }, (_, index) => write(`src/file${index}.txt`, `baseline ${index}\n`)),
  )
  git('add', '.')
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
    )
  commit()
  const sessionUrl = new URL('../../../electron/runtime/session/session.mjs', import.meta.url)
  // An alternative native backend makes integration checks possible when the
  // host's shared FSEvents stream is dropping events during unrelated builds.
  const backend = process.env.DIFFPANE_TEST_WATCH_BACKEND
  const watcherSetup = backend
    ? `const subscribe = watcher.subscribe;
       watcher.subscribe = (directory, callback) => subscribe(directory, callback, { backend: ${JSON.stringify(backend)} });`
    : ''
  const workerUrl =
    setup || watcherSetup
      ? new URL(
          `data:text/javascript,${encodeURIComponent(`
          import watcher from ${JSON.stringify(import.meta.resolve('@parcel/watcher'))};
          import { Repository } from ${JSON.stringify(new URL('../../../electron/workspace/repository/repository.mjs', import.meta.url).href)};
          import { parentPort as testPort } from 'node:worker_threads';
          ${watcherSetup}
          ${setup}
          await import(${JSON.stringify(sessionUrl.href)});
        `)}`,
        )
      : sessionUrl
  const worker = new Worker(workerUrl, {
    workerData: { directory: path.join(root, scope), versions },
  })
  /** @type {Map<number, {resolve: (value: unknown) => void, reject: (reason: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map()
  /** @type {WorkspaceSnapshot[]} */
  const snapshots = []
  /** @type {ErrorDetails[]} */
  const updateFailures = []
  /** @type {string[]} */
  const pathEvents = []
  /** @type {Set<string>} */
  const notices = new Set()
  let nextId = 0
  /** @type {Error | undefined} */
  let failure
  worker.on('message', (/** @type {unknown} */ input) => {
    const message = workerMessage(input)
    if (message.event === 'change') {
      assert.ok(isWorkspaceSnapshot(message.value))
      snapshots.push(message.value)
    }
    if (message.event === 'error') {
      assert.ok(message.failure)
      updateFailures.push(message.failure)
    }
    if (message.event === 'paths') {
      assert.ok(
        Array.isArray(message.value) &&
          message.value.every((/** @type {unknown} */ value) => typeof value === 'string'),
      )
      pathEvents.push(...message.value)
    }
    if (message.event?.startsWith('test-')) notices.add(message.event)
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.error) request.reject(workerFailure(message))
    else request.resolve(message.value)
  })
  worker.on('error', (/** @type {unknown} */ error) => {
    failure = error instanceof Error ? error : new Error('Unexpected workspace worker error', { cause: error })
  })
  t.onTestFinished(async () => {
    try {
      await call('language-dispose')
    } finally {
      await worker.terminate()
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
  /**
   * @template {TestedMethod} Method
   * @param {Method} method
   * @param {...unknown} args
   * @returns {Promise<SessionResponse<Method>>}
   */
  async function call(method, ...args) {
    /** @type {unknown} */
    const value = await new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(failure ?? new Error(`Timed out: ${method}`))
      }, 10000)
      pending.set(id, { resolve, reject, timer })
      postWorkerMessage(worker, { id, method, args })
    })
    return sessionResponse(method, value)
  }
  /** @param {(snapshot: WorkspaceSnapshot) => unknown} predicate */
  const waitFor = async predicate => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (failure) throw failure
      const snapshot = snapshots.findLast(predicate)
      if (snapshot) return snapshot
      // oxlint-disable-next-line eslint/no-await-in-loop -- Poll until the watcher has delivered the expected snapshot.
      await delay(20)
    }
    throw new Error('Timed out waiting for filesystem snapshot')
  }
  await waitFor(snapshot => snapshot.revision > 0)
  const canonicalRoot = await realpath(root)
  /** @param {import('@parcel/watcher').Event[]} events */
  const emit = events =>
    postWorkerMessage(worker, {
      testEvents: events.map(event => ({ ...event, path: path.join(canonicalRoot, event.path) })),
    })
  /** @param {string} event */
  const waitNotice = async event => {
    const deadline = Date.now() + 10000
    while (!notices.has(event)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${event}`)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Poll until the worker reports its current phase.
      await delay(10)
    }
    return event
  }
  const signal = (/** @type {unknown} */ message) => postWorkerMessage(worker, message)
  return { root, write, git, commit, call, waitFor, pathEvents, updateFailures, emit, waitNotice, signal }
}

const injectedWatchSetup = `
      const callbacks = [];
      watcher.subscribe = async (_directory, callback) => {
        callbacks.push(callback);
        return { unsubscribe: async () => {} };
      };
      testPort.on('message', message => {
        if (message.testEvents) callbacks[0](null, message.testEvents);
      });
    `

test('review versions follow individual working contents and staged blobs', async t => {
  const repo = await fixture(t, { fileCount: 2, setup: injectedWatchSetup })
  const selected = 'src/file0.txt'
  const other = 'src/file1.txt'
  const entry = (/** @type {WorkspaceSnapshot} */ snapshot, filename = selected) => {
    const row = snapshot.files.find(file => file.path === filename)
    assert.ok(row?.reviewVersion !== undefined)
    return { ...row, reviewVersion: row.reviewVersion }
  }
  await repo.write(selected, 'staged baseline\n')
  repo.git('add', selected)
  await repo.write(selected, 'working revision\n')
  await repo.write(other, 'unrelated revision\n')
  const first = await repo.call('refresh')
  const initial = entry(first)
  assert.ok(Number.isSafeInteger(initial.reviewVersion))
  const cached = await repo.call('document', selected, 'staged')
  assert.equal(cached.reviewVersion, initial.reviewVersion)
  assert.equal(cached.after, 'staged baseline\n')

  await repo.write(other, 'another unrelated revision\n')
  repo.emit([{ path: other, type: 'update' }])
  const unrelated = await repo.waitFor(snapshot => snapshot.revision > first.revision)
  assert.equal(entry(unrelated).reviewVersion, initial.reviewVersion)
  assert.notEqual(entry(unrelated, other).reviewVersion, entry(first, other).reviewVersion)
  assert.equal(entry(await repo.call('refresh')).reviewVersion, initial.reviewVersion)

  const blob = repo.git('hash-object', '-w', other).toString('ascii').trim()
  repo.git('update-index', '--cacheinfo', `100644,${blob},${selected}`)
  repo.emit([{ path: '.git/index', type: 'update' }])
  const staged = await repo.waitFor(
    snapshot =>
      snapshot.revision > unrelated.revision &&
      snapshot.files.some(
        file =>
          file.path === selected && file.reviewVersion !== undefined && file.reviewVersion > initial.reviewVersion,
      ),
  )
  assert.equal(entry(staged).index, initial.index)
  assert.equal(entry(staged).worktree, initial.worktree)
  assert.equal(entry(staged, other).reviewVersion, entry(unrelated, other).reviewVersion)
  const latest = await repo.call('document', selected, 'staged')
  assert.equal(latest.reviewVersion, entry(staged).reviewVersion)
  assert.equal(latest.after, 'another unrelated revision\n')
})

test('editor saves invalidate cached text and sync Git status without waiting for the watcher', async t => {
  const repo = await fixture(t, { fileCount: 1, setup: injectedWatchSetup })
  const initial = await repo.call('document', 'src/file0.txt', 'head')
  assert.equal(initial.editable, true)
  await repo.call('save', 'src/file0.txt', 'saved in editor\n', initial.after)
  const saved = await repo.call('document', 'src/file0.txt', 'head')
  assert.equal(saved.after, 'saved in editor\n')
  assert.ok(saved.decorations.length)
  await repo.waitFor(snapshot => snapshot.files.some(file => file.path === 'src/file0.txt'))
  await assert.rejects(repo.call('save', 'not-in-inventory.txt', 'edit', ''), /no longer available/)
})

test('a committed rename returns its destination even if the following refresh fails', async t => {
  const repo = await fixture(t, {
    fileCount: 1,
    setup: `${injectedWatchSetup}
      const snapshot = Repository.prototype.snapshot;
      let fail = false;
      testPort.on('message', message => {
        if (message.testFailSnapshot) fail = true;
      });
      Repository.prototype.snapshot = async function () {
        if (fail) {
          fail = false;
          throw new Error('temporary Git failure');
        }
        return snapshot.call(this);
      };
    `,
  })
  repo.signal({ testFailSnapshot: true })
  assert.equal(await repo.call('rename', 'src/file0.txt', 'renamed.txt'), 'src/renamed.txt')
  assert.deepEqual(repo.updateFailures, [
    {
      message: 'temporary Git failure',
      code: 'BACKEND_UPDATE_FAILED',
      operation: 'refresh',
      recoverable: true,
    },
  ])
  repo.signal({ testFailSnapshot: true })
  await assert.rejects(repo.call('refresh'), {
    message: 'temporary Git failure',
    code: 'BACKEND_UPDATE_FAILED',
    operation: 'refresh',
    recoverable: true,
  })
  await repo.call('refresh')
  assert.deepEqual(
    (await repo.call('files')).map(file => file.path),
    ['src/renamed.txt'],
  )
})

test('a replacement workspace advances previously published revisions', async t => {
  const repo = await fixture(t, {
    fileCount: 1,
    setup: injectedWatchSetup,
    versions: { revision: 6, catalogRevision: 8, reviewVersion: 10, checkpointId: 12 },
  })
  const first = await repo.call('snapshot')
  assert.ok(first.revision > 6)
  assert.ok(first.inventoryRevision > 8)
  assert.deepEqual(first.changedPaths, ['*'])
  await repo.write('src/file0.txt', 'edited')
  const refreshed = await repo.call('refresh')
  assert.ok((refreshed.files[0]?.reviewVersion ?? 0) > 10)
  const captured = await repo.call('capture-checkpoint')
  assert.ok(captured.checkpoint && captured.checkpoint.id > 12)
})

test('manual refresh retries after the already running watcher refresh fails', async t => {
  const repo = await fixture(t, {
    fileCount: 1,
    setup: `${injectedWatchSetup}
      const snapshot = Repository.prototype.snapshot;
      let fail = false;
      let release;
      testPort.on('message', message => {
        if (message.testFailSnapshot) fail = true;
        if (message.testReleaseSnapshot) release?.();
      });
      Repository.prototype.snapshot = async function () {
        if (fail) {
          fail = false;
          const pending = new Promise(resolve => { release = resolve; });
          testPort.postMessage({ event: 'test-refresh-started' });
          await pending;
          throw new Error('temporary Git failure');
        }
        return snapshot.call(this);
      };
    `,
  })
  const filename = 'src/file0.txt'
  await repo.write(filename, 'manual refresh fixture\n')
  repo.signal({ testFailSnapshot: true })
  repo.emit([{ path: filename, type: 'update' }])
  await repo.waitNotice('test-refresh-started')
  const manual = repo.call('refresh')
  repo.signal({ testReleaseSnapshot: true })
  assert.deepEqual((await manual).changedPaths, ['*'])
  assert.equal(repo.updateFailures.length, 1)
})

test('concurrent saves retain the inventory and unrelated cached documents; new files and commits invalidate correctly', async t => {
  const repo = await fixture(t)
  assert.equal((await repo.call('files')).length, 1000)
  const baseline = await repo.call('performance')
  const document = await repo.call('document', 'src/file0.txt', 'head')
  assert.equal(document.after, 'baseline 0\n')
  const before = await repo.call('performance')
  const start = (await repo.call('snapshot')).revision
  await Promise.all(
    Array.from({ length: 512 }, (_, index) => repo.write(`src/file${index + 1}.txt`, `concurrent ${index}\n`)),
  )
  await repo.waitFor(snapshot => snapshot.revision > start && snapshot.files.length === 512)
  assert.equal((await repo.call('files')).length, 1000)
  const cached = await repo.call('document', 'src/file0.txt', 'head')
  const after = await repo.call('performance')
  assert.equal(cached.after, 'baseline 0\n')
  assert.equal(after.inventoryRevision, baseline.inventoryRevision, 'content-only saves keep the inventory')
  assert.equal(after.documents.loads, before.documents.loads, 'unrelated saves retain the document cache')
  assert.ok(after.documents.hits > before.documents.hits)
  await repo.write('src/file0.txt', 'latest visible contents\n')
  await repo.waitFor(snapshot => snapshot.revision > cached.revision && snapshot.changedPaths.includes('src/file0.txt'))
  const latest = await repo.call('document', 'src/file0.txt', 'head')
  assert.equal(latest.after, 'latest visible contents\n')
  assert.ok(latest.decorations.length)
  const revision = (await repo.call('snapshot')).revision
  await repo.write('src/new.txt', 'new file\n')
  await repo.waitFor(
    snapshot => snapshot.revision > revision && snapshot.files.some(file => file.path === 'src/new.txt'),
  )
  assert.equal((await repo.call('files')).length, 1001)
  assert.ok((await repo.call('performance')).inventoryRevision > after.inventoryRevision)
  repo.git('add', '.')
  repo.commit()
  await repo.waitFor(snapshot => snapshot.files.length === 0 && snapshot.revision > latest.revision)
  const committed = await repo.call('document', 'src/file0.txt', 'head')
  assert.equal(committed.after, latest.after)
  assert.deepEqual(committed.decorations, [])
}, 20_000)

test('ignored folders load only explicit expansions and release catalog and document cache entries on collapse', async t => {
  const repo = await fixture(t)
  await repo.write('.gitignore', 'cache/\n')
  await mkdir(path.join(repo.root, 'cache/deep'), { recursive: true })
  await repo.write('cache/a.txt', 'ignored document\n')
  await repo.write('cache/deep/b.txt', 'nested ignored document\n')
  await repo.call('refresh')
  const cold = await repo.call('files-delta', null)
  assert.ok(cold.files.some(file => file.path === 'cache' && file.ignored && file.directory))
  assert.ok(!cold.files.some(file => file.path.startsWith('cache/')))
  const loads = (await repo.call('performance')).documents.loads
  await repo.call('directory-expanded', 'cache', true)
  const opened = await repo.call('files-delta', cold.revision)
  assert.deepEqual(
    opened.files.map(file => file.path),
    ['cache/a.txt', 'cache/deep'],
  )
  assert.equal((await repo.call('performance')).documents.loads, loads)
  assert.ok(!(await repo.call('files')).some(file => file.ignored))
  await repo.call('document', 'cache/a.txt', 'head')
  await repo.call('directory-expanded', 'cache/deep', true)
  const nested = await repo.call('files-delta', opened.revision)
  assert.deepEqual(
    nested.files.map(file => file.path),
    ['cache/deep/b.txt'],
  )
  await repo.call('directory-expanded', 'cache', false)
  const collapsed = await repo.call('files-delta', nested.revision)
  assert.deepEqual(collapsed.removed, ['cache/a.txt', 'cache/deep', 'cache/deep/b.txt'])
  assert.equal((await repo.call('performance')).documents.entries, 0)
  // The visible editor can still save after its explorer folder was collapsed.
  await repo.call('save', 'cache/a.txt', 'saved while collapsed\n', 'ignored document\n')
  assert.equal((await repo.call('document', 'cache/a.txt', 'head')).after, 'saved while collapsed\n')
  await repo.write('cache/hidden.txt', 'created while closed\n')
  await repo.call('directory-expanded', 'cache', true)
  const reopened = await repo.call('files-delta', collapsed.revision)
  assert.ok(reopened.files.some(file => file.path === 'cache/deep'))
  assert.ok(reopened.files.some(file => file.path === 'cache/hidden.txt'))
  assert.ok(!reopened.files.some(file => file.path === 'cache/deep/b.txt'))
  const revision = (await repo.call('snapshot')).revision
  await repo.write('cache/new.txt', 'new ignored document\n')
  await repo.waitFor(snapshot => snapshot.revision > revision && snapshot.changedPaths.includes('cache/new.txt'))
  const added = await repo.call('files-delta', reopened.revision)
  assert.ok(added.files.some(file => file.path === 'cache/new.txt'))
}, 20_000)

test('tracked deletions leave the inventory, retain Git status, and reappear after restoration', async t => {
  const repo = await fixture(t, { fileCount: 1 })
  const before = await repo.call('files-delta', null)
  await rm(path.join(repo.root, 'src/file0.txt'))
  const deleted = await repo.waitFor(snapshot =>
    snapshot.files.some(file => file.path === 'src/file0.txt' && file.worktree === 'D'),
  )
  assert.ok(deleted.inventoryRevision > before.revision)
  assert.ok(!(await repo.call('files')).some(file => file.path === 'src/file0.txt'))
  const delta = await repo.call('files-delta', before.revision)
  assert.ok(delta.removed.includes('src/file0.txt'))
  await repo.write('src/file0.txt', 'restored\n')
  await repo.waitFor(
    snapshot => snapshot.revision > deleted.revision && snapshot.changedPaths.includes('src/file0.txt'),
  )
  assert.ok((await repo.call('files')).some(file => file.path === 'src/file0.txt'))
})

test('a watcher update restores a deleted tracked file to the inventory', async t => {
  const repo = await fixture(t, { fileCount: 1, setup: injectedWatchSetup })
  const tracked = 'src/file0.txt'
  await repo.call('files')
  await rm(path.join(repo.root, tracked))
  repo.emit([{ path: tracked, type: 'delete' }])
  const deleted = await repo.waitFor(snapshot =>
    snapshot.files.some(file => file.path === tracked && file.worktree === 'D'),
  )
  assert.deepEqual(await repo.call('files'), [])

  await repo.write(tracked, 'baseline 0\n')
  repo.emit([{ path: tracked, type: 'update' }])
  const restored = await repo.waitFor(
    snapshot =>
      snapshot.revision > deleted.revision && snapshot.changedPaths.includes(tracked) && snapshot.files.length === 0,
  )
  assert.ok(restored.inventoryRevision > deleted.inventoryRevision)
  assert.deepEqual(
    (await repo.call('files')).map(file => file.path),
    [tracked],
  )
})

test('watcher fallback delivers inventories slower than its polling interval and keeps detecting edits', async t => {
  const repo = await fixture(t, {
    fileCount: 10,
    setup: `
      watcher.subscribe = async (_directory, callback) => {
        setTimeout(() => callback(new Error('dropped filesystem events'), []), 20).unref();
        return { unsubscribe: async () => {} };
      };
      const files = Repository.prototype.files;
      Repository.prototype.files = async function () {
        const result = await files.call(this);
        await new Promise(resolve => setTimeout(resolve, 2400));
        return result;
      };
    `,
  })
  await repo.waitFor(snapshot => snapshot.watchError?.includes('dropped filesystem events'))
  assert.equal((await repo.call('files')).length, 10)
  await repo.write('src/new.txt', 'discovered by fallback\n')
  await repo.waitFor(snapshot => snapshot.files.some(file => file.path === 'src/new.txt'))
  assert.equal((await repo.call('files')).length, 11)
  assert.equal((await repo.call('document', 'src/new.txt', 'head')).after, 'discovered by fallback\n')
}, 20000)

const controlledFallbackSetup = `
      const watchCallbacks = [];
      watcher.subscribe = async (_directory, callback) => {
        watchCallbacks.push(callback);
        return { unsubscribe: async () => {} };
      };
      const timeout = globalThis.setTimeout;
      let nextPoll;
      let pollCount = 0;
      globalThis.setTimeout = (callback, milliseconds, ...args) => {
        if (milliseconds !== 2000) return timeout(callback, milliseconds, ...args);
        const timer = timeout(() => {}, 60000);
        nextPoll = async () => {
          clearTimeout(timer);
          await callback(...args);
          testPort.postMessage({ event: 'test-poll-finished-' + ++pollCount });
        };
        testPort.postMessage({ event: 'test-poll-ready' });
        return timer;
      };
      testPort.on('message', message => {
        if (message.testFailWatcher)
          watchCallbacks[0](new Error('dropped filesystem events'), []);
        if (message.testPoll) void nextPoll();
      });
      const waitForRelease = (notice, key) => new Promise(resolve => {
        const release = message => {
          if (!message[key]) return;
          testPort.off('message', release);
          resolve();
        };
        testPort.on('message', release);
        testPort.postMessage({ event: notice });
      });
`

test('watcher fallback forwards created, updated and removed files to language servers', async t => {
  const repo = await fixture(t, {
    fileCount: 2,
    setup: `${controlledFallbackSetup}
      const { LanguageRuntime } = await import(${JSON.stringify(new URL('../../../electron/tools/languages/language.mjs', import.meta.url).href)});
      LanguageRuntime.prototype.changed = function (events) {
        for (const event of events)
          testPort.postMessage({ event: 'test-language-' + event.type + '-' + event.path.split('/').at(-1) });
      };
    `,
  })
  repo.signal({ testFailWatcher: true })
  await repo.waitFor(snapshot => snapshot.watchError?.includes('dropped filesystem events'))
  await repo.waitNotice('test-poll-ready')

  await repo.write('src/imported.py', 'answer = 42\n')
  repo.signal({ testPoll: true })
  await repo.waitNotice('test-poll-finished-1')
  assert.equal(await repo.waitNotice('test-language-create-imported.py'), 'test-language-create-imported.py')

  await repo.write('src/imported.py', 'answer = 43\n')
  repo.signal({ testPoll: true })
  await repo.waitNotice('test-poll-finished-2')
  assert.equal(await repo.waitNotice('test-language-update-imported.py'), 'test-language-update-imported.py')

  await rm(path.join(repo.root, 'src/imported.py'))
  repo.signal({ testPoll: true })
  await repo.waitNotice('test-poll-finished-3')
  assert.equal(await repo.waitNotice('test-language-delete-imported.py'), 'test-language-delete-imported.py')
})

test('an outbound rename keeps its live comparison without watching outside the opened folder', async t => {
  const repo = await fixture(t, {
    fileCount: 2,
    scope: 'src',
    setup: `
      const { workerData } = await import('node:worker_threads');
      watcher.subscribe = async directory => {
        const parent = workerData.directory.slice(0, workerData.directory.lastIndexOf('/'));
        if (directory === parent) throw new Error('Test must not watch the repository root');
        return { unsubscribe: async () => {} };
      };
      const timeout = globalThis.setTimeout;
      let poll;
      globalThis.setTimeout = (callback, milliseconds, ...args) => {
        if (milliseconds !== 2000) return timeout(callback, milliseconds, ...args);
        const timer = timeout(() => {}, 60000);
        poll = () => { clearTimeout(timer); void callback(...args); };
        return timer;
      };
      testPort.on('message', message => {
        if (message.testPoll) poll();
      });
    `,
  })
  repo.git('mv', 'src/file0.txt', 'outside.txt')
  const snapshot = await repo.call('refresh')
  const outbound = snapshot.files.find(file => file.path === 'outside.txt')
  assert.ok(outbound?.reviewVersion !== undefined)
  const outboundVersion = outbound.reviewVersion
  assert.equal(outbound.originalPath, 'src/file0.txt')
  assert.equal(snapshot.watchError, undefined)
  const before = await repo.call('document', 'outside.txt', 'head')
  assert.equal(before.after, 'baseline 0\n')
  assert.equal(before.editable, false)
  await repo.write('outside.txt', 'edited after the move\n')
  repo.signal({ testPoll: true })
  await repo.waitFor(next =>
    next.files.some(
      file => file.path === outbound.path && file.reviewVersion !== undefined && file.reviewVersion > outboundVersion,
    ),
  )
  assert.ok(repo.pathEvents.includes('outside.txt'))
  assert.equal((await repo.call('document', 'outside.txt', 'head')).after, 'edited after the move\n')
})

test('quiet fallback polls retain caches while content, ignored files and inventory changes stay live', async t => {
  const repo = await fixture(t, {
    fileCount: 10,
    setup: controlledFallbackSetup,
  })
  let pollCount = 0
  const poll = async () => {
    repo.signal({ testPoll: true })
    await repo.waitNotice(`test-poll-finished-${++pollCount}`)
  }
  repo.signal({ testFailWatcher: true })
  await repo.waitFor(snapshot => snapshot.watchError?.includes('dropped filesystem events'))
  await repo.waitNotice('test-poll-ready')
  await repo.write('.gitignore', 'cache/\n')
  await mkdir(path.join(repo.root, 'cache'))
  await repo.write('cache/open.txt', 'opened ignored file\n')
  await repo.write('src/file0.txt', 'first dirty contents\n')
  await poll()
  await repo.call('files')
  await repo.call('directory-expanded', 'cache', true)
  await repo.call('document', 'cache/open.txt', 'head')
  const firstDirty = await repo.call('document', 'src/file0.txt', 'head')
  await repo.write('cache/before-first-poll.txt', 'created before the first directory stamp\n')
  await poll()
  assert.ok((await repo.call('files-delta', null)).files.some(file => file.path === 'cache/before-first-poll.txt'))
  const baseline = await repo.call('performance')
  for (let index = 0; index < 5; index++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A poll installs the next controlled timer when it finishes.
    await poll()
  }
  await repo.call('document', 'src/file0.txt', 'head')
  await repo.call('document', 'cache/open.txt', 'head')
  const quiet = await repo.call('performance')
  assert.equal(quiet.revision, baseline.revision, 'quiet polls do not publish new snapshots')
  assert.equal(quiet.inventoryRevision, baseline.inventoryRevision)
  assert.equal(quiet.documents.loads, baseline.documents.loads, 'quiet polls retain document caches')
  await repo.write('src/file0.txt', 'second dirty contents\n')
  await poll()
  const secondDirty = await repo.call('snapshot')
  assert.deepEqual(secondDirty.changedPaths, ['src/file0.txt'])
  const refreshedFile = secondDirty.files.find(file => file.path === 'src/file0.txt')
  const refreshedDocument = await repo.call('document', 'src/file0.txt', 'head')
  assert.ok(refreshedFile?.reviewVersion !== undefined && firstDirty.reviewVersion !== undefined)
  assert.ok(refreshedFile.reviewVersion > firstDirty.reviewVersion)
  assert.equal(refreshedDocument.reviewVersion, refreshedFile.reviewVersion)
  assert.equal(refreshedDocument.after, 'second dirty contents\n')
  assert.equal((await repo.call('performance')).inventoryRevision, quiet.inventoryRevision)
  await repo.write('cache/open.txt', 'updated ignored contents\n')
  await poll()
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'updated ignored contents\n')
  await repo.write('cache/new.txt', 'new ignored file\n')
  await poll()
  const ignored = await repo.call('files-delta', null)
  assert.ok(ignored.files.some(file => file.path === 'cache/new.txt'))
  await repo.write('src/new.txt', 'new regular file\n')
  await poll()
  assert.ok((await repo.call('files')).some(file => file.path === 'src/new.txt'))
  repo.git('add', '.')
  repo.commit()
  await poll()
  assert.deepEqual((await repo.call('document', 'src/file0.txt', 'head')).decorations, [])
  await mkdir(path.join(repo.root, 'empty'))
  await repo.write('.gitignore', 'cache/\n# first dirty version\n')
  await poll()
  await repo.call('files')
  await repo.write('.gitignore', 'cache/\nempty/\n')
  await poll()
  assert.ok(
    (await repo.call('files-delta', null)).files.some(file => file.path === 'empty' && file.ignored && file.directory),
    'same-status gitignore edits refresh ignored directory inventory',
  )
  await mkdir(path.join(repo.root, 'local-cache'))
  await repo.write('local-cache/open.txt', 'ignored contents\n')
  await repo.write('.git/info/exclude', 'local-cache/*\n')
  await poll()
  assert.ok(
    (await repo.call('files-delta', null)).files.some(file => file.path === 'local-cache/open.txt' && file.ignored),
  )
  await repo.write('.git/info/exclude', 'local-cache/\n')
  await poll()
  assert.ok(
    (await repo.call('files-delta', null)).files.some(
      file => file.path === 'local-cache' && file.ignored && file.directory,
    ),
    'local Git exclude edits refresh inventory when porcelain status is unchanged',
  )
})

/** @param {TestContext} t @param {string} setup */
async function fallbackIgnoredFixture(t, setup) {
  const repo = await fixture(t, { fileCount: 2, setup: controlledFallbackSetup + setup })
  await repo.write('.gitignore', 'cache/\n')
  await mkdir(path.join(repo.root, 'cache'))
  await repo.write('cache/open.txt', 'before edit\n')
  await repo.call('refresh')
  await repo.call('files')
  return repo
}

test('a document read during the first fallback refresh retains its pre-read metadata', async t => {
  const repo = await fallbackIgnoredFixture(
    t,
    `
    const snapshot = Repository.prototype.snapshot;
    let pauseSnapshot = false;
    testPort.on('message', message => {
      if (message.testPauseSnapshot) pauseSnapshot = true;
    });
    Repository.prototype.snapshot = async function () {
      const result = await snapshot.call(this);
      if (pauseSnapshot) {
        pauseSnapshot = false;
        await waitForRelease('test-snapshot-paused', 'testReleaseSnapshot');
      }
      return result;
    };
  `,
  )
  repo.signal({ testPauseSnapshot: true, testFailWatcher: true })
  await repo.waitNotice('test-snapshot-paused')
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'before edit\n')
  await repo.write('cache/open.txt', 'after edit\n')
  repo.signal({ testReleaseSnapshot: true })
  await repo.waitFor(snapshot => snapshot.watchError?.includes('dropped filesystem events'))
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'after edit\n')
  repo.signal({ testPoll: true })
  await repo.waitNotice('test-poll-finished-1')
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'after edit\n')
})

test('a document opened after a poll captures paths keeps its independent read baseline', async t => {
  const repo = await fallbackIgnoredFixture(
    t,
    `
    import fsPromises from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const lstat = fsPromises.lstat;
    let pausePoll = false;
    testPort.on('message', message => {
      if (message.testPausePoll) pausePoll = true;
    });
    fsPromises.lstat = async (...args) => {
      const result = await lstat(...args);
      if (pausePoll && args[1]?.bigint) {
        pausePoll = false;
        await waitForRelease('test-poll-paused', 'testReleasePoll');
      }
      return result;
    };
    syncBuiltinESMExports();
  `,
  )
  repo.signal({ testFailWatcher: true })
  await repo.waitFor(snapshot => snapshot.watchError?.includes('dropped filesystem events'))
  repo.signal({ testPausePoll: true, testPoll: true })
  await repo.waitNotice('test-poll-paused')
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'before edit\n')
  await repo.write('cache/open.txt', 'after edit\n')
  repo.signal({ testReleasePoll: true })
  await repo.waitNotice('test-poll-finished-1')
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'after edit\n')
  repo.signal({ testPoll: true })
  await repo.waitNotice('test-poll-finished-2')
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'after edit\n')
})

test('an in-flight read begun before watcher failure keeps its baseline through the first fallback', async t => {
  const repo = await fallbackIgnoredFixture(
    t,
    `
    const snapshot = Repository.prototype.snapshot;
    const contents = Repository.prototype.contents;
    let pauseSnapshot = false;
    let pauseContents = true;
    testPort.on('message', message => {
      if (message.testPauseSnapshot) pauseSnapshot = true;
    });
    Repository.prototype.snapshot = async function () {
      const result = await snapshot.call(this);
      if (pauseSnapshot) {
        pauseSnapshot = false;
        await waitForRelease('test-snapshot-paused', 'testReleaseSnapshot');
      }
      return result;
    };
    Repository.prototype.contents = async function (...args) {
      const result = await contents.apply(this, args);
      if (pauseContents && args[0].path === 'cache/open.txt') {
        pauseContents = false;
        await waitForRelease('test-contents-paused', 'testReleaseContents');
      }
      return result;
    };
  `,
  )
  const document = repo.call('document', 'cache/open.txt', 'head')
  await repo.waitNotice('test-contents-paused')
  repo.signal({ testPauseSnapshot: true, testFailWatcher: true })
  await repo.waitNotice('test-snapshot-paused')
  repo.signal({ testReleaseContents: true })
  assert.equal((await document).after, 'before edit\n')
  assert.equal((await repo.call('performance')).documents.retries, 1)
  await repo.write('cache/open.txt', 'after edit\n')
  repo.signal({ testReleaseSnapshot: true })
  await repo.waitFor(snapshot => snapshot.watchError?.includes('dropped filesystem events'))
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'after edit\n')
  repo.signal({ testPoll: true })
  await repo.waitNotice('test-poll-finished-1')
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'after edit\n')
})

test('inventories settle and share one scan while refreshes continue', async t => {
  const repo = await fixture(t, {
    fileCount: 10,
    setup: `
      const files = Repository.prototype.files;
      let scanning = false;
      Repository.prototype.files = async function () {
        if (scanning) throw new Error('overlapping inventory scans');
        scanning = true;
        try {
          const result = await files.call(this);
          await new Promise(resolve => setTimeout(resolve, 300));
          return result;
        } finally { scanning = false; }
      };
    `,
  })
  const inventories = [repo.call('files')]
  for (let index = 0; index < 4; index++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Interleave refreshes with an already running inventory.
    await delay(35)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Request each inventory after the preceding refresh.
    await repo.call('refresh')
    inventories.push(repo.call('files'))
  }
  assert.ok((await Promise.all(inventories)).every(inventory => inventory.length === 10))
})

test('known clean documents load without waiting for an inventory replacement', async t => {
  const repo = await fixture(t, {
    fileCount: 2,
    setup: `
      watcher.subscribe = async () => ({ unsubscribe: async () => {} });
      const files = Repository.prototype.files;
      let holdInventory = false;
      testPort.on('message', message => {
        if (message.testHoldInventory) holdInventory = true;
      });
      Repository.prototype.files = async function () {
        const result = await files.call(this);
        if (holdInventory) {
          holdInventory = false;
          testPort.postMessage({ event: 'test-inventory-held' });
          await new Promise(resolve => {
            const release = message => {
              if (!message.testReleaseInventory) return;
              testPort.off('message', release);
              resolve();
            };
            testPort.on('message', release);
          });
        }
        return result;
      };
    `,
  })
  await repo.call('files')
  await repo.call('refresh')
  repo.signal({ testHoldInventory: true })
  const inventory = repo.call('files')
  await repo.waitNotice('test-inventory-held')
  try {
    const document = await Promise.race([
      repo.call('document', 'src/file0.txt', 'head'),
      delay(1500).then(() => {
        throw new Error('Known document waited for the held inventory')
      }),
    ])
    assert.equal(document.after, 'baseline 0\n')
    assert.equal((await repo.call('performance')).documents.loads, 1)
  } finally {
    repo.signal({ testReleaseInventory: true })
    await inventory
  }
})

test('an edit during a catalog scan queues reconciliation after the first useful inventory', async t => {
  const repo = await fixture(t, {
    fileCount: 10,
    setup: `
      watcher.subscribe = async () => ({ unsubscribe: async () => {} });
      const files = Repository.prototype.files;
      let first = true;
      Repository.prototype.files = async function () {
        const result = await files.call(this);
        if (first) {
          first = false;
          testPort.postMessage({ event: 'test-inventory-read' });
          await new Promise(resolve => {
            const release = message => {
              if (!message.testReleaseInventory) return;
              testPort.off('message', release);
              resolve();
            };
            testPort.on('message', release);
          });
        }
        return result;
      };
    `,
  })
  const first = repo.call('files-delta', null)
  await repo.waitNotice('test-inventory-read')
  await repo.write('src/created-during-scan.txt', 'created after the scan started\n')
  const refreshed = await repo.call('refresh')
  repo.signal({ testReleaseInventory: true })
  const inventory = await first
  assert.ok(!inventory.files.some(file => file.path === 'src/created-during-scan.txt'))
  assert.ok(inventory.revision < refreshed.inventoryRevision)
  await repo.waitFor(snapshot => snapshot.inventoryRevision > refreshed.inventoryRevision)
  const reconciled = await repo.call('files-delta', inventory.revision)
  assert.ok(reconciled.revision > inventory.revision)
  assert.ok(reconciled.files.some(file => file.path === 'src/created-during-scan.txt'))
})

test('collapsed ignored churn cannot invalidate unrelated documents while opened ignored files stay live', async t => {
  const repo = await fixture(t, { fileCount: 10, setup: injectedWatchSetup })
  await repo.write('.gitignore', 'cache/\n')
  await mkdir(path.join(repo.root, 'cache'))
  await repo.write('cache/open.txt', 'opened ignored file\n')
  await repo.call('refresh')
  await repo.call('files')
  await repo.call('document', 'src/file0.txt', 'head')
  await repo.call('document', 'cache/open.txt', 'head')
  const before = await repo.call('performance')
  repo.pathEvents.length = 0
  repo.emit(
    Array.from({ length: 512 }, (_, index) => ({
      path: `cache/noise${index}.txt`,
      type: 'create',
    })),
  )
  await repo.call('performance')
  assert.ok(!repo.pathEvents.includes('*'), 'ignored churn must not become a wildcard invalidation')
  assert.ok(!repo.pathEvents.some(file => file.startsWith('cache/noise')))
  await repo.call('document', 'src/file0.txt', 'head')
  assert.equal((await repo.call('performance')).documents.loads, before.documents.loads)
  await repo.call('document', 'cache/open.txt', 'head')
  await repo.write('cache/open.txt', 'updated ignored file\n')
  repo.emit([{ path: 'cache/open.txt', type: 'update' }])
  const updated = await repo.waitFor(snapshot => snapshot.changedPaths.includes('cache/open.txt'))
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'updated ignored file\n')
  await rm(path.join(repo.root, 'cache/open.txt'))
  repo.emit([{ path: 'cache/open.txt', type: 'delete' }])
  const deleted = await repo.waitFor(
    snapshot => snapshot.revision > updated.revision && snapshot.changedPaths.includes('cache/open.txt'),
  )
  await assert.rejects(repo.call('document', 'cache/open.txt', 'head'), /no longer available/)
  await repo.write('cache/open.txt', 'restored ignored file\n')
  repo.emit([{ path: 'cache/open.txt', type: 'create' }])
  await repo.waitFor(
    snapshot => snapshot.revision > deleted.revision && snapshot.changedPaths.includes('cache/open.txt'),
  )
  assert.equal((await repo.call('document', 'cache/open.txt', 'head')).after, 'restored ignored file\n')
})

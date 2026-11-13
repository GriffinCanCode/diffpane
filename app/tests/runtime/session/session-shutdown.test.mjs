// Keep the native watcher library loaded while the session worker exits naturally.
import '@parcel/watcher'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MessageChannel, Worker } from 'node:worker_threads'
import { test } from 'vite-plus/test'

import { postWorkerMessage, sessionResponse, workerFailure, workerMessage } from './session-fixture.ts'

/** @import { TestContext } from 'vite-plus/test' */
/** @import { WorkerMessage, TestedMethod, SessionResponse } from './session-fixture.ts' */

/** @param {TestContext} t */
async function fixture(t, { holdSnapshot = false, failUnsubscribe = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-session-shutdown-'))
  execFileSync('git', ['init', '-q', root], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  await writeFile(path.join(root, 'example.txt'), 'shutdown fixture\n')
  const { port1: control, port2: workerControl } = new MessageChannel()
  const worker = new Worker(
    new URL(
      `data:text/javascript,${encodeURIComponent(`
        import watcher from ${JSON.stringify(import.meta.resolve('@parcel/watcher'))};
        import { Repository } from ${JSON.stringify(new URL('../../../electron/workspace/repository/repository.mjs', import.meta.url).href)};
        import { DiffRuntime } from ${JSON.stringify(new URL('../../../electron/workspace/comparison/diff-runtime.ts', import.meta.url).href)};
        import { parentPort, workerData } from 'node:worker_threads';
        const gates = new Map();
        const pause = name => new Promise(resolve => gates.set(name, resolve));
        const notice = (event, value) => parentPort.postMessage({ event: 'test-' + event, value });
        workerData.control.on('message', name => {
          if (name === 'barrier') notice('barrier');
          else gates.get(name)?.();
        });
        workerData.control.unref();
        parentPort.on('message', ({ method }) => {
          if (method === 'language-dispose') notice('dispose-requested');
        });
        let subscriptions = 0;
        const dispose = DiffRuntime.prototype.dispose;
        DiffRuntime.prototype.dispose = async function () {
          await dispose.call(this);
          notice('diff-disposed');
        };
        watcher.subscribe = async () => {
          const pending = pause('subscribe');
          notice('subscribe-started', ++subscriptions);
          await pending;
          notice('subscribe-resolved');
          return {
            unsubscribe: async () => {
              const pending = pause('unsubscribe');
              notice('unsubscribe-started');
              await pending;
              notice('unsubscribe-finished');
              if (${JSON.stringify(failUnsubscribe)}) throw new Error('unsubscribe failed');
            },
          };
        };
        const snapshot = Repository.prototype.snapshot;
        let snapshots = 0;
        Repository.prototype.snapshot = async function () {
          notice('snapshot-call', ++snapshots);
          if (${JSON.stringify(holdSnapshot)} && snapshots === 1) {
            const pending = pause('snapshot');
            notice('snapshot-started');
            await pending;
          }
          return snapshot.call(this);
        };
        await import(${JSON.stringify(new URL('../../../electron/runtime/session/session.mjs', import.meta.url).href)});
      `)}`,
    ),
    { workerData: { directory: root, control: workerControl }, transferList: [workerControl] },
  )
  /** @type {WorkerMessage[]} */
  const messages = []
  /** @type {Set<() => void>} */
  const waiting = new Set()
  let nextId = 0
  /** @type {number | undefined} */
  let exitCode
  /** @type {Error | undefined} */
  let failure
  /** @type {PromiseWithResolvers<number>} */
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers()
  worker.on('message', (/** @type {unknown} */ message) => {
    messages.push(workerMessage(message))
    for (const update of waiting) update()
  })
  worker.on('error', (/** @type {unknown} */ error) => {
    failure = error instanceof Error ? error : new Error('Unexpected workspace worker error', { cause: error })
    for (const update of waiting) update()
  })
  worker.on('exit', code => {
    exitCode = code
    resolveExit(code)
    for (const update of waiting) update()
  })
  /** @param {(message: WorkerMessage) => boolean} predicate @param {string} description @returns {Promise<WorkerMessage>} */
  const waitFor = (predicate, description) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out: ${description}`)), 10000)
      /** @param {Error | null} error @param {WorkerMessage} [value] */
      const finish = (error, value) => {
        clearTimeout(timer)
        waiting.delete(update)
        if (error) reject(error)
        else if (value) resolve(value)
        else reject(new Error('Missing worker message'))
      }
      const update = () => {
        const found = messages.find(predicate)
        if (found) finish(null, found)
        else if (failure) finish(failure)
        else if (exitCode !== undefined) finish(new Error(`Worker exited (${exitCode}) before ${description}`))
      }
      waiting.add(update)
      update()
    })
  /** @template {TestedMethod} Method @param {Method} method */
  function request(method) {
    const id = ++nextId
    /** @type {Promise<SessionResponse<Method>>} */
    const response = waitFor(message => message.id === id, `${method} response`).then(message => {
      if (message.error) throw workerFailure(message)
      return sessionResponse(method, message.value)
    })
    // A later assertion may fail before the already-sent request is awaited.
    response.catch(() => {})
    postWorkerMessage(worker, { id, method })
    return { id, response }
  }
  /** @param {string} name */
  const notice = name => waitFor(message => message.event === `test-${name}`, name)
  /** @param {string} name */
  const signal = name => postWorkerMessage(control, name)
  const waitForExit = async () => {
    let timer
    try {
      /** @type {Promise<never>} */
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker did not exit after disposal')), 5000)
      })
      return await Promise.race([exited, deadline])
    } finally {
      clearTimeout(timer)
    }
  }
  t.onTestFinished(async () => {
    try {
      if (exitCode === undefined) await worker.terminate()
    } finally {
      control.close()
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
  await notice('subscribe-started')
  return { root: await realpath(root), messages, request, notice, signal, waitForExit }
}

test.for([
  ['disposal waits for pending watcher startup and unsubscription before natural worker exit', false],
  ['an in-flight snapshot during disposal keeps the port open until pending watcher startup is cleaned up', true],
])('%s', async ([, holdSnapshot], t) => {
  const session = await fixture(t, { holdSnapshot: holdSnapshot === true })
  const snapshot = session.request('snapshot')
  if (holdSnapshot) await session.notice('snapshot-started')
  else assert.equal((await snapshot.response).root, session.root)

  const disposal = session.request('language-dispose')
  await session.notice('dispose-requested')
  if (holdSnapshot) {
    session.signal('snapshot')
    assert.equal((await snapshot.response).root, session.root)
  }
  assert.equal(
    session.messages.some(message => message.id === disposal.id),
    false,
    'a successful snapshot cannot acknowledge disposal while watcher startup is pending',
  )

  session.signal('subscribe')
  await session.notice('subscribe-resolved')
  await session.notice('unsubscribe-started')
  session.signal('barrier')
  await session.notice('barrier')
  assert.equal(
    session.messages.some(message => message.id === disposal.id),
    false,
    'disposal must await the subscription returned during shutdown',
  )
  session.signal('unsubscribe')
  await session.notice('unsubscribe-finished')
  assert.equal(await disposal.response, null)
  assert.equal(await session.waitForExit(), 0, 'the worker must exit without Worker.terminate()')
  assert.equal(
    session.messages.filter(message => message.event === 'test-subscribe-started').length,
    1,
    'shutdown must not start another subscription',
  )
  assert.equal(
    session.messages.filter(message => message.event === 'test-snapshot-call').length,
    1,
    'finishing watcher setup during disposal must not start a final refresh',
  )
  assert.ok(
    session.messages.findIndex(message => message.event === 'test-unsubscribe-finished') <
      session.messages.findIndex(message => message.id === disposal.id),
    'the disposal acknowledgement follows completed watcher cleanup',
  )
})

test('disposal rejects new requests, releases tools and exits after a watcher cleanup failure', async t => {
  const session = await fixture(t, { failUnsubscribe: true })
  const disposal = session.request('language-dispose')
  await session.notice('dispose-requested')
  await assert.rejects(session.request('snapshot').response, { code: 'WINDOW_UNAVAILABLE' })
  session.signal('subscribe')
  await session.notice('unsubscribe-started')
  session.signal('unsubscribe')
  await session.notice('diff-disposed')
  await assert.rejects(disposal.response, /unsubscribe failed/u)
  assert.equal(await session.waitForExit(), 0)
  assert.equal(
    session.messages.some(message => message.event === 'test-snapshot-call'),
    false,
  )
})

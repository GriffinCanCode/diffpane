// Keep the native watcher library loaded while the session worker exits naturally.
import '@parcel/watcher';
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { MessageChannel, Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function fixture(t, { holdSnapshot = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-session-shutdown-'));
  execFileSync('git', ['init', '-q', root], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  await writeFile(path.join(root, 'example.txt'), 'shutdown fixture\n');
  const { port1: control, port2: workerControl } = new MessageChannel();
  const worker = new Worker(
    new URL(
      `data:text/javascript,${encodeURIComponent(`
        import watcher from ${JSON.stringify(import.meta.resolve('@parcel/watcher'))};
        import { Repository } from ${JSON.stringify(new URL('../electron/repository.mjs', import.meta.url).href)};
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
        await import(${JSON.stringify(new URL('../electron/session.mjs', import.meta.url).href)});
      `)}`,
    ),
    { workerData: { directory: root, control: workerControl }, transferList: [workerControl] },
  );
  const messages = [];
  const waiting = new Set();
  let nextId = 0;
  let exitCode;
  let failure;
  let resolveExit;
  const exited = new Promise(resolve => {
    resolveExit = resolve;
  });
  worker.on('message', message => {
    messages.push(message);
    for (const update of waiting) update();
  });
  worker.on('error', error => {
    failure = error;
    for (const update of waiting) update();
  });
  worker.on('exit', code => {
    exitCode = code;
    resolveExit(code);
    for (const update of waiting) update();
  });
  const waitFor = (predicate, description) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out: ${description}`)), 10000);
      const finish = (error, value) => {
        clearTimeout(timer);
        waiting.delete(update);
        if (error) reject(error);
        else resolve(value);
      };
      const update = () => {
        const found = messages.find(predicate);
        if (found) finish(null, found);
        else if (failure) finish(failure);
        else if (exitCode !== undefined)
          finish(new Error(`Worker exited (${exitCode}) before ${description}`));
      };
      waiting.add(update);
      update();
    });
  const request = method => {
    const id = ++nextId;
    const response = waitFor(message => message.id === id, `${method} response`).then(message => {
      if (message.error) throw new Error(message.error);
      return message.value;
    });
    // A later assertion may fail before the already-sent request is awaited.
    void response.catch(() => {});
    worker.postMessage({ id, method });
    return { id, response };
  };
  const notice = name => waitFor(message => message.event === `test-${name}`, name);
  const signal = name => control.postMessage(name);
  const waitForExit = async () => {
    let timer;
    try {
      return await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Worker did not exit after disposal')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  t.onTestFinished(async () => {
    try {
      if (exitCode === undefined) await worker.terminate();
    } finally {
      control.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  await notice('subscribe-started');
  return { root: await realpath(root), messages, request, notice, signal, waitForExit };
}

for (const holdSnapshot of [false, true]) {
  test(
    holdSnapshot
      ? 'an in-flight snapshot during disposal keeps the port open until pending watcher startup is cleaned up'
      : 'disposal waits for pending watcher startup and unsubscription before natural worker exit',
    async t => {
      const session = await fixture(t, { holdSnapshot });
      const snapshot = session.request('snapshot');
      if (holdSnapshot) await session.notice('snapshot-started');
      else assert.equal((await snapshot.response).root, session.root);

      const disposal = session.request('language-dispose');
      await session.notice('dispose-requested');
      if (holdSnapshot) {
        session.signal('snapshot');
        assert.equal((await snapshot.response).root, session.root);
      }
      assert.equal(
        session.messages.some(message => message.id === disposal.id),
        false,
        'a successful snapshot cannot acknowledge disposal while watcher startup is pending',
      );

      session.signal('subscribe');
      await session.notice('subscribe-resolved');
      await session.notice('unsubscribe-started');
      session.signal('barrier');
      await session.notice('barrier');
      assert.equal(
        session.messages.some(message => message.id === disposal.id),
        false,
        'disposal must await the subscription returned during shutdown',
      );
      session.signal('unsubscribe');
      await session.notice('unsubscribe-finished');
      assert.equal(await disposal.response, null);
      assert.equal(
        await session.waitForExit(),
        0,
        'the worker must exit without Worker.terminate()',
      );
      assert.equal(
        session.messages.filter(message => message.event === 'test-subscribe-started').length,
        1,
        'shutdown must not start another subscription',
      );
      assert.equal(
        session.messages.filter(message => message.event === 'test-snapshot-call').length,
        1,
        'finishing watcher setup during disposal must not start a final refresh',
      );
      assert.ok(
        session.messages.findIndex(message => message.event === 'test-unsubscribe-finished') <
          session.messages.findIndex(message => message.id === disposal.id),
        'the disposal acknowledgement follows completed watcher cleanup',
      );
    },
  );
}

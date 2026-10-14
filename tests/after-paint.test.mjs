import { test, vi } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { afterPaint } from '../renderer/after-paint.ts';

function scheduler(t) {
  const frames = new Map();
  const idle = new Map();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', callback => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
  vi.stubGlobal('requestIdleCallback', callback => {
    idle.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelIdleCallback', id => idle.delete(id));
  t.onTestFinished(() => vi.unstubAllGlobals());
  const flush = queue => {
    const callbacks = [...queue.values()];
    queue.clear();
    for (const callback of callbacks) callback();
  };
  return { frames, idle, frame: () => flush(frames), background: () => flush(idle) };
}

test('background work waits for a paint opportunity and an idle turn', t => {
  const tasks = scheduler(t);
  let calls = 0;
  afterPaint(() => calls++);
  assert.equal(calls, 0);
  tasks.frame();
  assert.equal(calls, 0);
  assert.equal(tasks.idle.size, 0);
  tasks.frame();
  assert.equal(calls, 0);
  tasks.background();
  assert.equal(calls, 1);
});

test('cancellation releases pending work before either frame or the idle callback', t => {
  const tasks = scheduler(t);
  let calls = 0;
  for (let stage = 0; stage < 3; stage++) {
    const cancel = afterPaint(() => calls++);
    for (let frame = 0; frame < stage; frame++) tasks.frame();
    cancel();
    tasks.frame();
    tasks.background();
    assert.equal(tasks.frames.size, 0);
    assert.equal(tasks.idle.size, 0);
  }
  assert.equal(calls, 0);
});

test('the timer fallback still yields past the first paint and supports cancellation', t => {
  const tasks = scheduler(t);
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.onTestFinished(() => vi.useRealTimers());
  let calls = 0;
  const cancel = afterPaint(() => calls++);
  tasks.frame();
  vi.runAllTimers();
  assert.equal(calls, 0);
  tasks.frame();
  cancel();
  vi.runAllTimers();
  assert.equal(calls, 0);
  afterPaint(() => calls++);
  tasks.frame();
  tasks.frame();
  vi.runAllTimers();
  assert.equal(calls, 1);
});

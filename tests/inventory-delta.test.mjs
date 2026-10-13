import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { InventoryDelta } from '../electron/inventory-delta.ts';

const index = paths => new Map(paths.map(path => [path, { path, submodule: false }]));
test('explorer deltas send only additions, removals and submodule changes after the initial catalog', () => {
  const delta = new InventoryDelta();
  const initial = index(['stay', 'old/a', 'old/b']);
  assert.equal(delta.update(null, 1, initial).reset, true);
  const next = index(['stay', 'new/a', 'new/b']);
  const change = delta.update(1, 2, next);
  assert.equal(change.reset, false);
  assert.deepEqual(
    change.files.map(file => file.path),
    ['new/a', 'new/b'],
  );
  assert.deepEqual(change.removed, ['old/a', 'old/b']);
  assert.deepEqual(delta.update(2, 2, next).files, []);
  const submodule = new Map(next);
  submodule.set('stay', { path: 'stay', submodule: true });
  assert.deepEqual(delta.update(2, 3, submodule).files, [{ path: 'stay', submodule: true }]);
  const missed = delta.update(1, 3, submodule);
  assert.equal(missed.reset, true);
  assert.equal(missed.files.length, 3);
});

test('ignore-rule changes update metadata even when file paths stay the same', () => {
  const delta = new InventoryDelta();
  delta.update(null, 1, index(['debug.log']));
  const ignored = new Map([
    ['debug.log', { path: 'debug.log', submodule: false, ignored: true, directory: false }],
  ]);
  assert.deepEqual(delta.update(1, 2, ignored).files, [...ignored.values()]);
  assert.deepEqual(delta.update(2, 3, index(['debug.log'])).files, [
    ...index(['debug.log']).values(),
  ]);
});

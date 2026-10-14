import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { LivePathBatch } from '../renderer/live-updates.ts';

test('overlapping native events retain all invalidations with a fixed path bound', () => {
  const batch = new LivePathBatch();
  batch.add(['a', 'b']);
  batch.add(['b', 'c']);
  assert.deepEqual(batch.take(), ['a', 'b', 'c']);
  assert.deepEqual(batch.take(), []);
  batch.add(Array.from({ length: 100000 }, (_, index) => `path${index}`));
  batch.add(['later']);
  assert.deepEqual(batch.take(), ['*']);
  batch.add(['fresh']);
  assert.deepEqual(batch.take(), ['fresh']);
});

test('separate bursts across a throttled frame stay bounded and wildcard invalidation dominates', () => {
  const batch = new LivePathBatch();
  for (let burst = 0; burst < 1000; burst++) batch.add([`save${burst}`]);
  assert.deepEqual(batch.take(), ['*']);
  batch.add(['first', '*', 'last']);
  batch.add(['later']);
  assert.deepEqual(batch.take(), ['*']);
  batch.add(['next-frame']);
  assert.deepEqual(batch.take(), ['next-frame']);
});

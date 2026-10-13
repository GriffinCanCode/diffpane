import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { Autosave } from '../renderer/autosave.ts';

test('autosave serializes writes and saves the newest edit made during a write', async () => {
  const writes = [];
  let complete;
  const save = new Autosave(
    'original',
    async (text, expected) => {
      writes.push({ text, expected });
      if (writes.length === 1)
        await new Promise(resolve => {
          complete = resolve;
        });
    },
    () => {},
  );
  save.edit('first');
  await Promise.resolve();
  save.edit('second');
  save.edit('latest');
  save.accept('stale disk refresh');
  complete();
  await save.flush();
  assert.deepEqual(writes, [
    { text: 'first', expected: 'original' },
    { text: 'latest', expected: 'first' },
  ]);
  assert.equal(save.pending, false);
});

test('failed saves retain edits and retry against the original disk contents', async () => {
  const writes = [];
  const states = [];
  let failing = true;
  const save = new Autosave(
    'original',
    async (text, expected) => {
      writes.push({ text, expected });
      if (failing) throw new Error('disk full');
    },
    state => states.push(state),
  );
  save.edit('first');
  await assert.rejects(save.flush(), /disk full/);
  assert.equal(save.pending, true);
  save.accept('incoming refresh');
  save.edit('latest');
  assert.equal(writes.length, 1);
  failing = false;
  await save.flush();
  assert.deepEqual(writes.at(-1), { text: 'latest', expected: 'original' });
  assert.deepEqual(states, ['saving', 'error', 'saving', 'saved']);
  assert.equal(save.pending, false);
});

test('undo during a write is also saved and clean refreshes update the save baseline', async () => {
  let complete;
  const writes = [];
  const save = new Autosave(
    'original',
    async (text, expected) => {
      writes.push({ text, expected });
      if (writes.length === 1)
        await new Promise(resolve => {
          complete = resolve;
        });
    },
    () => {},
  );
  save.edit('edit');
  await Promise.resolve();
  save.edit('original');
  complete();
  await save.flush();
  save.accept('external edit');
  save.edit('next');
  await save.flush();
  assert.deepEqual(writes, [
    { text: 'edit', expected: 'original' },
    { text: 'original', expected: 'edit' },
    { text: 'next', expected: 'external edit' },
  ]);
});

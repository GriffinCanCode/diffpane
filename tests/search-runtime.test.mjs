import { test, vi } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { createFileSearch } from '../renderer/search-runtime.ts';

function workers(t) {
  const created = [];
  vi.stubGlobal(
    'Worker',
    class {
      messages = [];
      terminated = false;
      constructor() {
        created.push(this);
      }
      postMessage(message) {
        this.messages.push(message);
      }
      terminate() {
        this.terminated = true;
      }
      answer(matches = []) {
        const { id } = this.messages.at(-1);
        this.onmessage?.({ data: { id, matches } });
      }
    },
  );
  t.onTestFinished(() => vi.unstubAllGlobals());
  return created;
}
const inventory = () => Array.from({ length: 5000 }, (_, index) => ({ path: `file${index}` }));

test('releasing search settles active and queued queries and drops the worker and inventory', async t => {
  const created = workers(t);
  const search = createFileSearch();
  search.setFiles(inventory());
  const active = search.search('first');
  const queued = search.search('second');
  search.dispose();
  assert.deepEqual(await Promise.all([active, queued]), [null, null]);
  assert.equal(created[0].terminated, true);
  assert.equal(created[0].onmessage, null);
  assert.deepEqual(search.search(''), []);
  // Reopening search creates a fresh worker that can publish its own results.
  const files = inventory();
  search.setFiles(files);
  const result = search.search('file42');
  created[1].answer([{ index: 42, positions: [0, 1] }]);
  assert.deepEqual(await result, [{ file: files[42], positions: [0, 1] }]);
  search.dispose();
});

test('shrinking an inventory releases the obsolete worker without hanging a running query', async t => {
  const created = workers(t);
  const search = createFileSearch();
  search.setFiles(inventory());
  const pending = search.search('file');
  const small = [{ path: 'small.txt' }];
  search.setFiles(small);
  assert.equal(await pending, null);
  assert.equal(created[0].terminated, true);
  assert.deepEqual(
    search.search('small').map(hit => hit.file),
    small,
  );
  search.dispose();
});

test('overlapping worker queries publish only the latest request', async t => {
  const created = workers(t);
  const search = createFileSearch();
  const files = inventory();
  search.setFiles(files);
  const first = search.search('file1');
  const second = search.search('file2');
  const third = search.search('file3');
  assert.equal(await second, null);
  created[0].answer([{ index: 1, positions: [] }]);
  assert.equal(await first, null);
  created[0].answer([{ index: 3, positions: [] }]);
  assert.deepEqual(await third, [{ file: files[3], positions: [] }]);
  search.dispose();
});

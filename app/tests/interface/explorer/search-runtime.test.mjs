import assert from 'node:assert/strict'
import { test, vi } from 'vite-plus/test'
import { createFileSearch } from '../../../renderer/explorer/file-picker/search-runtime.ts'

/** @param {import("vite-plus/test").TestContext} t */
function workers(t) {
  /** @type {TestWorker[]} */
  const created = []
  class TestWorker extends EventTarget {
    /** @type {Array<{ id: number; query: string } | { paths: string[] } | { cancel: number }>} */
    messages = []
    terminated = false
    constructor() {
      super()
      created.push(this)
    }
    /** @param {TestWorker["messages"][number]} message */
    postMessage(message) {
      this.messages.push(message)
    }
    terminate() {
      this.terminated = true
    }
    /** @param {unknown} matches */
    answer(matches = new Uint32Array()) {
      const query = this.messages.findLast(message => 'id' in message)
      assert.ok(query && 'id' in query)
      const { id } = query
      this.dispatchEvent(new MessageEvent('message', { data: { id, matches } }))
    }
    fail() {
      this.dispatchEvent(new Event('error', { cancelable: true }))
    }
  }
  vi.stubGlobal('Worker', TestWorker)
  t.onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  return (/** @type {number} */ index) => {
    const worker = created[index]
    assert.ok(worker, `Expected worker ${index}`)
    return worker
  }
}
const inventory = () => Array.from({ length: 5000 }, (_, index) => ({ path: `file${index}` }))

test('releasing search settles active and queued queries and drops the worker and inventory', async t => {
  const created = workers(t)
  const search = createFileSearch()
  search.setFiles(inventory())
  const active = search.search('first')
  const queued = search.search('second')
  search.dispose()
  assert.deepEqual(await Promise.all([active, queued]), [null, null])
  assert.equal(created(0).terminated, true)
  const cleared = search.search('')
  assert.ok(!(cleared instanceof Promise))
  assert.equal(cleared.length, 0)
  assert.equal(cleared.fileAt(0), undefined)
  // Reopening search creates a fresh worker that can publish its own results.
  const files = inventory()
  search.setFiles(files)
  const result = search.search('file42')
  assert.deepEqual(created(1).messages[0], { paths: files.map(file => file.path) })
  created(1).answer(Uint32Array.of(42))
  const reopened = await result
  assert.ok(reopened)
  assert.equal(reopened.length, 1)
  const file = reopened.fileAt(0)
  assert.ok(file)
  assert.equal(file, files[42])
  assert.deepEqual(reopened.positions(file), [0, 1, 2, 3, 4, 5])
  search.dispose()
})

test('shrinking an inventory releases the obsolete worker without hanging a running query', async t => {
  const created = workers(t)
  const search = createFileSearch()
  search.setFiles(inventory())
  const pending = search.search('file')
  const small = [{ path: 'small.txt' }]
  search.setFiles(small)
  assert.equal(await pending, null)
  assert.equal(created(0).terminated, true)
  const matches = search.search('small')
  assert.ok(!(matches instanceof Promise))
  assert.equal(matches.length, 1)
  assert.equal(matches.fileAt(0), small[0])
  search.dispose()
})

test('overlapping worker queries publish only the latest request', async t => {
  const created = workers(t)
  const search = createFileSearch()
  const files = inventory()
  search.setFiles(files)
  const first = search.search('file1')
  const second = search.search('file2')
  const third = search.search('file3')
  assert.deepEqual(await Promise.all([first, second]), [null, null])
  assert.deepEqual(created(0).messages.slice(1), [{ id: 1, query: 'file1' }, { cancel: 1 }])
  created(0).answer()
  assert.deepEqual(created(0).messages.at(-1), { id: 3, query: 'file3' })
  created(0).answer(Uint32Array.of(3))
  const latest = await third
  assert.ok(latest)
  assert.equal(latest.length, 1)
  const file = latest.fileAt(0)
  assert.ok(file)
  assert.equal(file, files[3])
  assert.deepEqual(latest.positions(file), [0, 1, 2, 3, 4])
  search.dispose()
})

test('worker failure rejects the newest query and retry recreates the worker', async t => {
  const created = workers(t)
  const search = createFileSearch()
  const files = inventory()
  search.setFiles(files)
  const first = search.search('first')
  const latest = search.search('latest')
  created(0).fail()
  assert.ok(latest instanceof Promise)
  await assert.rejects(latest, /File search failed/)
  assert.equal(await first, null)
  assert.equal(created(0).terminated, true)
  const result = search.search('file5')
  created(0).fail()
  created(1).answer(Uint32Array.of(5))
  const retried = await result
  assert.ok(retried)
  assert.equal(retried.length, 1)
  const file = retried.fileAt(0)
  assert.ok(file)
  assert.equal(file, files[5])
  assert.deepEqual(retried.positions(file), [0, 1, 2, 3, 4])
  search.dispose()
})

test('malformed worker matches reject the search and release the failed worker', async t => {
  const created = workers(t)
  const search = createFileSearch()
  search.setFiles(inventory())
  const pending = search.search('bad index')
  assert.ok(pending instanceof Promise)
  const rejection = assert.rejects(pending, /Invalid file search worker matches/)
  created(0).answer(Uint32Array.of(5000))
  await rejection
  assert.equal(created(0).terminated, true)
  search.dispose()
})

test('inventory replacement cancels stale work before resolving indexes against the new inventory', async t => {
  const created = workers(t)
  const search = createFileSearch()
  search.setFiles(inventory())
  const stale = search.search('file1')
  const files = inventory().toReversed()
  search.setFiles(files)
  const pending = search.search('file4999')
  assert.equal(await stale, null)
  const worker = created(0)
  assert.deepEqual(worker.messages.slice(-2), [{ cancel: 1 }, { paths: files.map(file => file.path) }])
  worker.answer()
  worker.answer(Uint32Array.of(0))
  assert.equal((await pending)?.fileAt(0), files[0])
  search.dispose()
})

import assert from 'node:assert/strict'
import { test, vi } from 'vite-plus/test'
import { createFileSearch } from '../renderer/search-runtime.ts'

/** @param {import("vite-plus/test").TestContext} t */
function workers(t) {
  /** @type {TestWorker[]} */
  const created = []
  class TestWorker extends EventTarget {
    /** @type {Array<{ id: number; query: string } | { files: Array<{ path: string; index: number }> }>} */
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
    answer(matches = []) {
      const query = this.messages.at(-1)
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
  assert.deepEqual(search.search(''), [])
  // Reopening search creates a fresh worker that can publish its own results.
  const files = inventory()
  search.setFiles(files)
  const result = search.search('file42')
  created(1).answer([{ index: 42, positions: [0, 1] }])
  assert.deepEqual(await result, [{ file: files[42], positions: [0, 1] }])
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
  assert.ok(Array.isArray(matches))
  assert.deepEqual(
    matches.map(hit => hit.file),
    small,
  )
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
  assert.equal(await second, null)
  created(0).answer([{ index: 1, positions: [] }])
  assert.equal(await first, null)
  created(0).answer([{ index: 3, positions: [] }])
  assert.deepEqual(await third, [{ file: files[3], positions: [] }])
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
  created(1).answer([{ index: 5, positions: [0] }])
  assert.deepEqual(await result, [{ file: files[5], positions: [0] }])
  search.dispose()
})

test('malformed worker matches reject the search and release the failed worker', async t => {
  const created = workers(t)
  const search = createFileSearch()
  search.setFiles(inventory())
  const pending = search.search('bad index')
  assert.ok(pending instanceof Promise)
  const rejection = assert.rejects(pending, /Invalid file search worker matches/)
  created(0).answer([{ index: 5000, positions: [0] }])
  await rejection
  assert.equal(created(0).terminated, true)
  search.dispose()
})

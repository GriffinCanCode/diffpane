import assert from 'node:assert/strict'
import { test, vi } from 'vite-plus/test'
import { createDocumentProcessor } from '../../../renderer/editor/documents/document-runtime.ts'

test('switching files releases a running document worker and lets the next preview start', async t => {
  const workers: TestWorker[] = []
  class TestWorker extends EventTarget {
    terminated = false
    messages = 0
    constructor() {
      super()
      workers.push(this)
    }
    postMessage() {
      this.messages++
    }
    terminate() {
      this.terminated = true
    }
  }
  vi.stubGlobal('Worker', TestWorker)
  const processor = createDocumentProcessor()
  t.onTestFinished(() => {
    processor.dispose()
    vi.unstubAllGlobals()
  })
  const first = new AbortController()
  const second = new AbortController()
  const source = '# Heading\n\n'.repeat(4_000)
  const initial = processor.run({ kind: 'markdown', source }, first.signal)
  const next = processor.run({ kind: 'markdown', source }, second.signal)
  const original = workers[0]
  assert.ok(original)
  assert.equal(original.messages, 1)
  first.abort()
  assert.equal(await initial, undefined)
  assert.equal(original.terminated, true)
  const replacement = workers[1]
  assert.ok(replacement)
  assert.equal(replacement.messages, 1)
  const response = { kind: 'markdown', markdown: { html: '<h1>Heading</h1>', metadata: undefined, words: 1 } }
  original.dispatchEvent(new MessageEvent('message', { data: { ...response, kind: 'obsolete' } }))
  replacement.dispatchEvent(new MessageEvent('message', { data: response }))
  assert.deepEqual(await next, response)
})

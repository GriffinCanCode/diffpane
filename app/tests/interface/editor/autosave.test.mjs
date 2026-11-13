import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { Autosave } from '../../../renderer/editor/updates/autosave.ts'

test('autosave serializes writes and saves the newest edit made during a write', async () => {
  /** @type {Array<{ text: string; expected: string }>} */
  const writes = []
  /** @type {(() => void) | undefined} */
  let complete
  const save = new Autosave(
    'original',
    async (text, expected) => {
      writes.push({ text, expected })
      if (writes.length === 1)
        await new Promise(resolve => {
          complete = () => resolve(undefined)
        })
    },
    () => {},
  )
  save.edit('first')
  await Promise.resolve()
  save.edit('second')
  save.edit('latest')
  save.accept('stale disk refresh')
  assert.ok(complete)
  complete()
  await save.flush()
  assert.deepEqual(writes, [
    { text: 'first', expected: 'original' },
    { text: 'latest', expected: 'first' },
  ])
  assert.equal(save.pending, false)
})

test('failed saves retain edits and retry against the original disk contents', async () => {
  /** @type {Array<{ text: string; expected: string }>} */
  const writes = []
  /** @type {Array<Parameters<ConstructorParameters<typeof Autosave>[2]>[0]>} */
  const states = []
  let failing = true
  const save = new Autosave(
    'original',
    async (text, expected) => {
      writes.push({ text, expected })
      if (failing) throw new Error('disk full')
    },
    state => states.push(state),
  )
  save.edit('first')
  await assert.rejects(save.flush(), /disk full/)
  assert.equal(save.pending, true)
  save.accept('incoming refresh')
  save.edit('latest')
  assert.equal(writes.length, 1)
  failing = false
  await save.flush()
  assert.deepEqual(writes.at(-1), { text: 'latest', expected: 'original' })
  assert.deepEqual(states, ['saving', 'error', 'saving', 'saved'])
  assert.equal(save.pending, false)
})

test('undo during a write is also saved and clean refreshes update the save baseline', async () => {
  /** @type {(() => void) | undefined} */
  let complete
  /** @type {Array<{ text: string; expected: string }>} */
  const writes = []
  const save = new Autosave(
    'original',
    async (text, expected) => {
      writes.push({ text, expected })
      if (writes.length === 1)
        await new Promise(resolve => {
          complete = () => resolve(undefined)
        })
    },
    () => {},
  )
  save.edit('edit')
  await Promise.resolve()
  save.edit('original')
  assert.ok(complete)
  complete()
  await save.flush()
  save.accept('external edit')
  save.edit('next')
  await save.flush()
  assert.deepEqual(writes, [
    { text: 'edit', expected: 'original' },
    { text: 'original', expected: 'edit' },
    { text: 'next', expected: 'external edit' },
  ])
})

test('undoing a failed save clears the retry latch and future edits autosave', async () => {
  /** @type {Array<{ text: string; expected: string }>} */
  const writes = []
  /** @type {Array<Parameters<ConstructorParameters<typeof Autosave>[2]>[0]>} */
  const states = []
  const save = new Autosave(
    'original',
    async (text, expected) => {
      writes.push({ text, expected })
      if (text === 'failed edit') throw new Error('disk full')
    },
    state => states.push(state),
  )
  save.edit('failed edit')
  await assert.rejects(save.flush(), /disk full/)
  save.edit('original')
  assert.equal(save.pending, false)
  assert.equal(states.at(-1), 'saved')
  save.edit('fresh edit')
  await Promise.resolve()
  assert.deepEqual(writes.at(-1), { text: 'fresh edit', expected: 'original' })
  await save.flush()
  assert.equal(save.pending, false)
})

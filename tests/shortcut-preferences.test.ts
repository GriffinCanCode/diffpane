import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'vite-plus/test'
import { LocalState } from '../electron/local-state.ts'
import { ShortcutPreferences } from '../electron/shortcut-preferences.ts'

async function fixture(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-shortcuts-'))
  const filename = path.join(directory, 'shortcuts.sqlite')
  const stateFilename = path.join(directory, 'storage', 'state.sqlite')
  const states = new Set<LocalState>()
  t.onTestFinished(async () => {
    for (const state of states) state.close()
    await rm(directory, { recursive: true, force: true })
  })
  function open() {
    const state = new LocalState(stateFilename, {
      wrap: async key => Buffer.from(key, 'base64'),
      unwrap: async blob => blob.toString('base64'),
    })
    states.add(state)
    return new ShortcutPreferences(state, filename, 'darwin')
  }
  return { filename, open }
}

test('shortcut edits merge across stores, reject conflicts, and restore defaults', async t => {
  const { open } = await fixture(t)
  const first = open()
  const second = open()
  assert.deepEqual(await first.get(), {})

  await Promise.all([first.set('newWindow', 'Primary+Alt+T'), second.set('openFile', 'Primary+Alt+K')])
  assert.deepEqual(await first.get(), { newWindow: 'Primary+Alt+T', openFile: 'Primary+Alt+K' })
  await assert.rejects(first.set('openFolder', 'Primary+C'), /already used by Copy/)
  await assert.rejects(first.set('openFolder', 'Primary+Alt+K'), /already used by Open file/)

  await second.set('openFolder', 'Primary+Shift+O')
  await assert.rejects(first.reset('openFile'), /already used by Open folder/)
  assert.deepEqual(await first.reset('newWindow'), {
    openFile: 'Primary+Alt+K',
    openFolder: 'Primary+Shift+O',
  })
  assert.deepEqual(await second.reset(), {})
  assert.deepEqual(await open().get(), {})
})

test('legacy shortcuts migrate once and reset bindings remain reset on reopen', async t => {
  const { filename, open } = await fixture(t)
  {
    using database = new DatabaseSync(filename)
    database.exec('CREATE TABLE shortcuts (action TEXT PRIMARY KEY, binding TEXT NOT NULL) STRICT')
    const put = database.prepare('INSERT INTO shortcuts (action, binding) VALUES (?, ?)')
    put.run('newWindow', 'Primary+Alt+T')
    put.run('openFile', 'Primary+Alt+K')
    put.run('openFolder', 'unsupported binding')
    put.run('obsoleteAction', 'Primary+Alt+Z')
  }

  const shortcuts = open()
  assert.deepEqual(await shortcuts.get(), { newWindow: 'Primary+Alt+T', openFile: 'Primary+Alt+K' })
  await assert.rejects(stat(filename), { code: 'ENOENT' })
  assert.deepEqual(await shortcuts.reset('openFile'), { newWindow: 'Primary+Alt+T' })
  assert.deepEqual(await open().get(), { newWindow: 'Primary+Alt+T' })
})

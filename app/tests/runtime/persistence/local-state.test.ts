import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'vite-plus/test'
import { LocalState } from '../../../electron/persistence/database/local-state.ts'

const runNode = promisify(execFile)
const modulePath = fileURLToPath(new URL('../../../electron/persistence/database/local-state.ts', import.meta.url))
const keyring = {
  // The production adapter wraps this key using the OS credential store.
  async wrap(key: string) {
    return Buffer.from(Buffer.from(key, 'base64').map(byte => byte ^ 0xff))
  },
  async unwrap(blob: Buffer) {
    return Buffer.from(blob.map(byte => byte ^ 0xff)).toString('base64')
  },
}

async function fixture(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-local-state-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return { directory, filename: path.join(directory, 'state.sqlite') }
}

test('records reopen intact and keep collections and workspace scopes independent', async t => {
  const { filename } = await fixture(t)
  const scope = '/private/project scope'
  const original = { title: 'Confidential idea title', body: 'Repeated Markdown 📌\n'.repeat(5_000) }
  const id = 'private-note-identifier'
  let unwrappedKey = ''
  const first = new LocalState(filename, {
    ...keyring,
    async wrap(key) {
      unwrappedKey = key
      return keyring.wrap(key)
    },
  })
  try {
    await first.write(tx => {
      tx.put('ideas', scope, id, original)
      tx.put('ideas', `${scope}/worktree`, id, { title: 'Other worktree' })
      tx.put('review', scope, id, { title: 'Other collection' })
    })
    using database = new DatabaseSync(filename, { readOnly: true })
    const rows = database.prepare('SELECT scope, id, length(payload) AS bytes FROM records').all()
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.notEqual(row.scope, scope)
      assert.notEqual(row.id, id)
      assert.ok(typeof row.bytes === 'number' && row.bytes < 1024)
    }

    const dataFiles = (await readdir(path.dirname(filename))).filter(name => name.startsWith('state.sqlite'))
    assert.ok(dataFiles.includes('state.sqlite'))
    assert.equal(Buffer.from(unwrappedKey, 'base64').length, 32)
    const files = await Promise.all(
      dataFiles.map(async name => ({
        name,
        disk: await readFile(path.join(path.dirname(filename), name)),
      })),
    )
    for (const { name, disk } of files) {
      for (const marker of [scope, id, original.title, original.body.slice(0, 50), unwrappedKey]) {
        assert.equal(disk.includes(marker), false, name)
      }
      assert.equal(disk.includes(Buffer.from(unwrappedKey, 'base64')), false, name)
    }
  } finally {
    first.close()
  }

  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o077, 0)
  const second = new LocalState(filename, keyring)
  try {
    await second.read(tx => {
      assert.deepEqual(tx.list('ideas', scope), [original])
      assert.deepEqual(tx.get('ideas', `${scope}/worktree`, id), { title: 'Other worktree' })
      assert.deepEqual(tx.get('review', scope, id), { title: 'Other collection' })
      assert.equal(tx.get('ideas', '/different-worktree', id), undefined)
    })
    await second.write(tx => {
      assert.equal(tx.delete('ideas', scope, id), true)
      assert.equal(tx.delete('ideas', scope, id), false)
      assert.deepEqual(tx.list('ideas', scope), [])
      assert.deepEqual(tx.list('ideas', `${scope}/worktree`), [{ title: 'Other worktree' }])
    })
  } finally {
    second.close()
  }
})

test('a tampered record and an incorrect key fail without discarding saved data', async t => {
  const { filename } = await fixture(t)
  const value = { body: 'An idea worth keeping' }
  const scope = '/project'
  const first = new LocalState(filename, keyring)
  try {
    await first.write(tx => tx.put('ideas', scope, 'saved', value))
  } finally {
    first.close()
  }

  using database = new DatabaseSync(filename)
  const stored = database.prepare('SELECT payload FROM records').get()?.payload
  assert.ok(stored instanceof Uint8Array && stored.length > 0)
  const corrupted = Buffer.from(stored)
  const offset = corrupted.length - 1
  corrupted.writeUInt8(corrupted.readUInt8(offset) ^ 1, offset)
  const replace = database.prepare('UPDATE records SET payload = ?')
  replace.run(corrupted)

  const tampered = new LocalState(filename, keyring)
  try {
    await assert.rejects(tampered.read(tx => tx.get('ideas', scope, 'saved')))
    assert.deepEqual(database.prepare('SELECT payload FROM records').get()?.payload, Uint8Array.from(corrupted))
  } finally {
    tampered.close()
  }
  replace.run(stored)

  const wrongKey = new LocalState(filename, {
    ...keyring,
    async unwrap() {
      return Buffer.alloc(32).toString('base64')
    },
  })
  try {
    await assert.rejects(wrongKey.read(tx => tx.get('ideas', scope, 'saved')))
    await assert.rejects(wrongKey.write(tx => tx.put('ideas', scope, 'saved', 'overwrite')))
  } finally {
    wrongKey.close()
  }

  const reopened = new LocalState(filename, keyring)
  try {
    assert.deepEqual(await reopened.read(tx => tx.get('ideas', scope, 'saved')), value)
  } finally {
    reopened.close()
  }
})

test('ciphertext copied between records cannot authenticate under a different identity', async t => {
  const { filename } = await fixture(t)
  const state = new LocalState(filename, keyring)
  const scope = '/project'
  try {
    await state.write(tx => {
      tx.put('ideas', scope, 'source', 'source')
      tx.put('ideas', scope, 'target', 'target')
    })
    using database = new DatabaseSync(filename)
    const rows = database.prepare('SELECT id, payload FROM records ORDER BY id').all()
    const [source, target] = rows
    assert.ok(source?.payload instanceof Uint8Array)
    assert.ok(typeof target?.id === 'string' || target?.id instanceof Uint8Array)
    database.prepare('UPDATE records SET payload = ? WHERE id = ?').run(source.payload, target.id)
    await assert.rejects(state.read(tx => tx.list('ideas', scope)))
  } finally {
    state.close()
  }
})

test('key storage failures can be retried without making records unreadable', async t => {
  const { filename } = await fixture(t)
  let unlocked = false
  const state = new LocalState(filename, {
    ...keyring,
    async wrap(key) {
      if (!unlocked) throw new Error('Test keyring locked')
      return keyring.wrap(key)
    },
  })
  try {
    await assert.rejects(state.write(tx => tx.put('ideas', '/project', 'first', 'first')))
    unlocked = true
    await state.write(tx => tx.put('ideas', '/project', 'second', 'second'))
    assert.deepEqual(await state.read(tx => tx.list('ideas', '/project')), ['second'])
  } finally {
    state.close()
  }
})

test('legacy data is retained until an encrypted import commits and retry imports it once', async t => {
  const { directory, filename } = await fixture(t)
  const legacyFilename = path.join(directory, 'legacy.json')
  const marker = 'Private legacy content'
  await writeFile(legacyFilename, marker)
  let unlocked = false
  const state = new LocalState(filename, {
    ...keyring,
    async wrap(key) {
      if (!unlocked) throw new Error('Test keyring locked')
      return keyring.wrap(key)
    },
  })
  let valid = false
  let attempts = 0
  const importLegacy = () =>
    state.migrate('legacy', legacyFilename, (tx, source) => {
      attempts++
      tx.put('legacy', '/project', 'first', readFileSync(source, 'utf8'))
      if (!valid) throw new Error('Invalid legacy data')
      tx.put('legacy', '/project', 'second', 'Another saved value')
    })

  try {
    await assert.rejects(importLegacy())
    assert.equal(attempts, 0)
    assert.equal(await readFile(legacyFilename, 'utf8'), marker)

    unlocked = true
    await assert.rejects(importLegacy(), /Invalid legacy data/u)
    assert.equal(await readFile(legacyFilename, 'utf8'), marker)
    assert.deepEqual(await state.read(tx => tx.list('legacy', '/project')), [])

    valid = true
    await importLegacy()
    await assert.rejects(stat(legacyFilename), { code: 'ENOENT' })
    await state.write(tx => tx.put('legacy', '/project', 'first', 'An update after migration'))
    await importLegacy()
    assert.equal(attempts, 2)
    assert.equal(await state.read(tx => tx.get('legacy', '/project', 'first')), 'An update after migration')
    assert.equal(await state.read(tx => tx.get('legacy', '/project', 'second')), 'Another saved value')
  } finally {
    state.close()
  }
})

test('failed transactions roll back inserts and deletes and keep later writes usable', async t => {
  const { filename } = await fixture(t)
  const state = new LocalState(filename, keyring)
  const scope = '/project'
  try {
    await state.write(tx => tx.put('ideas', scope, 'existing', 'before'))
    await assert.rejects(
      state.write(tx => {
        tx.delete('ideas', scope, 'existing')
        tx.put('ideas', scope, 'uncommitted', 'unfinished')
        throw new Error('Simulated transaction failure')
      }),
      /Simulated transaction failure/u,
    )
    assert.deepEqual(await state.read(tx => tx.list('ideas', scope)), ['before'])
    await state.write(tx => tx.put('ideas', scope, 'existing', 'after'))
    assert.deepEqual(await state.read(tx => tx.list('ideas', scope)), ['after'])
  } finally {
    state.close()
  }
})

const worker = `
  const { randomBytes } = await import('node:crypto')
  const [modulePath, filename, label] = process.argv.slice(1)
  const { LocalState } = await import(modulePath)
  const state = new LocalState(filename, {
    async wrap(key) {
      await new Promise(resolve => setTimeout(resolve, 30))
      return Buffer.from(key, 'base64').map(byte => byte ^ 0xff)
    },
    async unwrap(blob) { return Buffer.from(blob).map(byte => byte ^ 0xff).toString('base64') },
  })
  if (label === 'interrupt') {
    await state.write(tx => tx.put('ideas', '/project', 'committed', 'committed'))
    await state.write(tx => {
      tx.delete('ideas', '/project', 'committed')
      tx.put('ideas', '/project', 'partial', 'partial')
      // Spill dirty pages before interruption so recovery also exercises SQLite's journal.
      for (let i = 0; i < 64; i++) {
        tx.put('ideas', '/project', 'partial-' + i, randomBytes(64 * 1024).toString('base64'))
      }
      process.kill(process.pid, 'SIGKILL')
    })
  } else {
    for (let i = 0; i < 12; i++) {
      const id = label + i
      await state.write(tx => tx.put('ideas', '/project', id, id))
    }
    state.close()
  }
`

test('independent app processes can initialize and commit against the same database', async t => {
  const { filename } = await fixture(t)
  const labels = ['first-', 'second-']
  await Promise.all(
    labels.map(label =>
      runNode(process.execPath, ['--input-type=module', '-e', worker, modulePath, filename, label], { timeout: 3000 }),
    ),
  )
  const state = new LocalState(filename, keyring)
  try {
    const expected = labels.flatMap(label => Array.from({ length: 12 }, (_, i) => `${label}${i}`))
    const values = await state.read(tx => tx.list('ideas', '/project'))
    assert.equal(values.length, expected.length)
    assert.deepEqual(new Set(values), new Set(expected))
  } finally {
    state.close()
  }
})

test('an abrupt process exit preserves committed records and rolls back a partial transaction', async t => {
  const { filename } = await fixture(t)
  await assert.rejects(
    runNode(process.execPath, ['--input-type=module', '-e', worker, modulePath, filename, 'interrupt'], {
      timeout: 3000,
    }),
    {
      signal: 'SIGKILL',
    },
  )
  assert.ok((await stat(`${filename}-wal`)).size > 1024 * 1024, 'the interrupted write reached the journal')
  const state = new LocalState(filename, keyring)
  try {
    assert.deepEqual(await state.read(tx => tx.list('ideas', '/project')), ['committed'])
    await state.write(tx => tx.put('ideas', '/project', 'next', 'next'))
    assert.equal(await state.read(tx => tx.get('ideas', '/project', 'next')), 'next')
  } finally {
    state.close()
  }
})

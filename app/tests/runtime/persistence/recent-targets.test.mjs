import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'vite-plus/test'
import { LocalState } from '../../../electron/persistence/database/local-state.ts'
import { RecentTargets } from '../../../electron/persistence/preferences/recent-targets.ts'

/** @param {{ onTestFinished(callback: () => Promise<void>): void }} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-recents-'))
  const filename = path.join(root, 'recent-targets.json')
  const stateFilename = path.join(root, 'storage', 'state.sqlite')
  /** @type {Set<LocalState>} */
  const states = new Set()
  t.onTestFinished(async () => {
    for (const state of states) state.close()
    await rm(root, { recursive: true, force: true })
  })
  function open(database = stateFilename) {
    const state = new LocalState(database, {
      wrap: async key => Buffer.from(key, 'base64'),
      unwrap: async blob => blob.toString('base64'),
    })
    states.add(state)
    return new RecentTargets(state, filename)
  }
  return { root, filename, stateFilename, open }
}

test('recent targets tolerate missing and corrupt history and reject invalid records', async t => {
  const { root, filename, open } = await fixture(t)
  assert.deepEqual(await open().list(), [])
  await writeFile(filename, '{unfinished')
  assert.deepEqual(await open().list(), [])
  assert.equal(await readFile(filename, 'utf8'), '{unfinished')
  const first = path.join(root, 'first')
  const second = path.join(root, 'second.txt')
  await writeFile(
    filename,
    JSON.stringify([
      { path: first, kind: 'folder', openedAt: 10 },
      { path: second, kind: 'file', openedAt: 30 },
      { path: first, kind: 'folder', openedAt: 20 },
      { path: 'relative-path', kind: 'folder', openedAt: 40 },
      { path: path.join(root, 'bad-kind'), kind: 'device', openedAt: 50 },
      { path: path.join(root, 'bad-time'), kind: 'folder', openedAt: 'today' },
      null,
    ]),
  )
  const history = open()
  const expected = [
    { path: second, name: 'second.txt', kind: 'file', openedAt: 30 },
    { path: first, name: 'first', kind: 'folder', openedAt: 20 },
  ]
  assert.deepEqual(await history.list(), expected)
  await assert.rejects(stat(filename), { code: 'ENOENT' })
  assert.deepEqual(await open().list(), expected)
})

test('recent targets persist an ordered bounded history with files and folders', async t => {
  const { root, filename, open } = await fixture(t)
  const history = open()
  const folders = Array.from({ length: 9 }, (_, index) => path.join(root, `folder-${index}`))
  const firstFolder = path.join(root, 'folder-0')
  const reopenedFolder = path.join(root, 'folder-4')
  const file = path.join(firstFolder, 'example.txt')
  await Promise.all(folders.map(folder => mkdir(folder)))
  await writeFile(file, 'example')
  await Promise.all(folders.map(folder => history.record(folder)))
  assert.deepEqual(
    (await history.list()).map(entry => entry.path),
    folders.slice(1).toReversed(),
  )
  await history.record(file)
  await history.record(reopenedFolder)
  await history.record(path.join(root, 'missing'))
  const expected = await history.list()
  assert.equal(expected.length, 8)
  assert.equal(expected[0]?.path, reopenedFolder, 'reopening moves an entry to the front')
  assert.equal(expected.filter(entry => entry.path === reopenedFolder).length, 1)
  const [, recentFile] = expected
  assert.ok(recentFile)
  const { path: location, name, kind } = recentFile
  assert.deepEqual({ path: location, name, kind }, { path: file, name: 'example.txt', kind: 'file' })
  assert.ok(expected.every(entry => entry.openedAt > 0))
  assert.deepEqual(await open().list(), expected)
  await assert.rejects(stat(filename), { code: 'ENOENT' })
  await history.remove(file)
  assert.equal(
    (await open().list()).some(entry => entry.path === file),
    false,
  )
  const copy = await history.list()
  const [first] = copy
  assert.ok(first)
  first.name = 'changed outside the store'
  assert.notEqual((await history.list())[0]?.name, first.name)
})

test('recent target writes recover when persistence is unavailable', async t => {
  const { root, open } = await fixture(t)
  const target = path.join(root, 'target')
  await mkdir(target)
  const blocked = path.join(root, 'blocked')
  await writeFile(blocked, 'not a directory')
  const database = path.join(blocked, 'state.sqlite')
  const history = open(database)
  await history.record(target)
  assert.equal((await history.list())[0]?.path, target)
  await rm(blocked)
  await mkdir(blocked)
  await history.record(target)
  assert.deepEqual(
    (await open(database).list()).map(entry => entry.path),
    [target],
  )
})

test('concurrent recent records leave one complete latest history on disk', async t => {
  const { root, open } = await fixture(t)
  const history = open()
  const targets = Array.from({ length: 12 }, (_, index) => path.join(root, `target-${index}`))
  await Promise.all(targets.map(target => mkdir(target)))
  await Promise.all(targets.map(target => history.record(target)))
  const entries = await history.list()
  assert.equal(entries.length, 8)
  assert.equal(new Set(entries.map(entry => entry.path)).size, 8)
  assert.deepEqual(await open().list(), entries)
})

test('a list and removal queued during a recent record see the operations in call order', async t => {
  const { root, open } = await fixture(t)
  const target = path.join(root, 'target')
  await mkdir(target)
  const history = open()
  const record = history.record(target)
  const list = history.list()
  const remove = history.remove(target)
  await Promise.all([record, remove])
  assert.deepEqual(
    (await list).map(entry => entry.path),
    [target],
  )
  assert.deepEqual(await history.list(), [])
})

test('independent app histories refresh and merge interleaved records and removals', async t => {
  const { root, open } = await fixture(t)
  const first = open()
  const second = open()
  const targets = ['alpha', 'beta', 'gamma', 'delta'].map(name => path.join(root, name))
  const [alpha, beta, gamma, delta] = targets
  assert.ok(alpha && beta && gamma && delta)
  await Promise.all(targets.map(target => mkdir(target)))
  await first.record(alpha)
  assert.deepEqual(
    (await second.list()).map(entry => entry.path),
    [alpha],
  )
  await second.record(beta)
  assert.deepEqual(
    (await first.list()).map(entry => entry.path),
    [beta, alpha],
  )
  await first.record(gamma)
  await second.remove(alpha)
  await first.record(delta)
  const expected = [delta, gamma, beta]
  assert.deepEqual(
    (await first.list()).map(entry => entry.path),
    expected,
  )
  assert.deepEqual(
    (await second.list()).map(entry => entry.path),
    expected,
  )
  assert.deepEqual(
    (await open().list()).map(entry => entry.path),
    expected,
  )
})

test('independent app histories commit simultaneous mutations without dropping targets', async t => {
  const { root, open } = await fixture(t)
  const first = open()
  const second = open()
  const targets = Array.from({ length: 6 }, (_, index) => path.join(root, `target-${index}`))
  await Promise.all(targets.map(target => mkdir(target)))
  await Promise.all(targets.map((target, index) => (index % 2 ? first : second).record(target)))
  const histories = await Promise.all([first.list(), second.list()])
  for (const history of histories) assert.deepEqual(history.map(entry => entry.path).toSorted(), targets.toSorted())
})

test('uncommitted in-memory records survive refresh and merge after write contention', async t => {
  const { root, stateFilename, open } = await fixture(t)
  const first = open()
  const second = open()
  const targets = ['alpha', 'beta', 'gamma', 'delta'].map(name => path.join(root, name))
  const [alpha, beta, gamma, delta] = targets
  assert.ok(alpha && beta && gamma && delta)
  await Promise.all(targets.map(target => mkdir(target)))
  await first.record(alpha)
  await second.list()
  using database = new DatabaseSync(stateFilename)
  database.exec('BEGIN IMMEDIATE')
  try {
    await first.record(beta)
    assert.equal(
      (await first.list()).some(entry => entry.path === beta),
      true,
    )
  } finally {
    database.exec('ROLLBACK')
  }
  assert.equal(
    (await second.list()).some(entry => entry.path === beta),
    false,
  )
  await second.record(gamma)
  assert.deepEqual(
    (await first.list()).map(entry => entry.path),
    [gamma, beta, alpha],
  )
  await first.record(delta)
  assert.deepEqual(
    (await second.list()).map(entry => entry.path),
    [delta, gamma, beta, alpha],
  )
}, 10_000)

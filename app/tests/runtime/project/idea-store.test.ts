import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'vite-plus/test'
import { LocalState } from '../../../electron/persistence/database/local-state.ts'
import { IdeaStore } from '../../../electron/persistence/project/idea-store.ts'
import { MAX_IDEA_BODY_LENGTH } from '../../../shared/ideas/ideas.ts'
import type { Idea } from '../../../shared/ideas/ideas.ts'

function idea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: 'a-note',
    title: 'A Markdown idea',
    body: '# Queue\n\n- [x] First item\n  - Follow-up 📌\n\nA short note.\n',
    links: [
      { path: 'src/read me.md' },
      {
        path: 'src/core.ts',
        side: 'head',
        line: 4,
        endLine: 7,
        excerpt: 'return 42;',
        truncated: true,
      },
    ],
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }
}

async function fixture(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-ideas-'))
  const filename = path.join(directory, 'storage', 'state.sqlite')
  const legacyFilename = path.join(directory, 'ideas.sqlite')
  const connections = new Set<LocalState>()
  t.onTestFinished(async () => {
    for (const state of connections) state.close()
    await rm(directory, { recursive: true, force: true })
  })
  function open() {
    const state = new LocalState(filename, {
      wrap: async key => Buffer.from(key, 'base64'),
      unwrap: async blob => blob.toString('base64'),
    })
    connections.add(state)
    return {
      store: new IdeaStore(state, legacyFilename),
      close() {
        connections.delete(state)
        state.close()
      },
    }
  }
  return { filename, legacyFilename, open }
}

test('Markdown and line anchors persist across connections and stay scoped to a worktree', async t => {
  const { filename, open } = await fixture(t)
  const original = idea()
  const latest = idea({ id: 'another-note', updatedAt: 40 })
  const other = idea({ title: 'Independent worktree' })
  const first = open()
  assert.deepEqual(await first.store.list('/project'), [])
  assert.deepEqual(await first.store.upsert('/project', original), original)
  await first.store.upsert('/project', latest)
  await first.store.upsert('/project/worktree', other)
  first.close()
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o077, 0)

  const second = open()
  assert.deepEqual(await second.store.list('/project'), [latest, original])
  assert.deepEqual(await second.store.list('/project/worktree'), [other])
  assert.deepEqual(await second.store.list('/another-project'), [])
  const updated = idea({ createdAt: 30, updatedAt: 50, body: '- A revised idea' })
  const saved = { ...updated, createdAt: original.createdAt }
  assert.deepEqual(await second.store.upsert('/project', updated), saved)
  assert.deepEqual(await second.store.list('/project'), [saved, latest])
  assert.equal(await second.store.delete('/project', original.id), true)
  assert.equal(await second.store.delete('/project', original.id), false)
  assert.deepEqual(await second.store.list('/project'), [latest])
  assert.deepEqual(await second.store.list('/project/worktree'), [other])
  second.close()
  assert.deepEqual(await open().store.list('/project'), [latest])
})

test('invalid links and oversized Markdown leave a previously saved idea intact', async t => {
  const { open } = await fixture(t)
  const { store } = open()
  const original = idea()
  await store.upsert('/project', original)
  await assert.rejects(store.upsert('/project', idea({ links: [{ path: '../outside' }] })), /inside this repository/u)
  await assert.rejects(
    store.upsert('/project', idea({ links: [{ path: 'src/core.ts', line: 5, endLine: 4 }] })),
    /invalid line range/u,
  )
  await assert.rejects(store.upsert('/project', idea({ body: 'x'.repeat(MAX_IDEA_BODY_LENGTH + 1) })), /Idea notes/u)
  assert.deepEqual(await store.list('/project'), [original])
})

test('interleaved connections preserve independent writes to the same workspace', async t => {
  const { open } = await fixture(t)
  const { store: first } = open()
  const { store: second } = open()
  const original = idea()
  const other = idea({ id: 'second', updatedAt: 21 })
  await Promise.all([first.upsert('/project', original), second.upsert('/project', other)])
  const changed = { ...original, body: 'Edited', updatedAt: 30 }
  await first.upsert('/project', changed)
  assert.deepEqual(await second.list('/project'), [changed, other])
})

test('legacy Idea Builder records migrate once with title, Markdown, and links intact', async t => {
  const { legacyFilename, open } = await fixture(t)
  const original = idea()
  {
    using database = new DatabaseSync(legacyFilename)
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE ideas (workspace TEXT, id TEXT, title TEXT, body TEXT, links TEXT, created_at INTEGER, updated_at INTEGER);
    `)
    database
      .prepare('INSERT INTO ideas VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        '/project',
        original.id,
        original.title,
        original.body,
        JSON.stringify(original.links),
        original.createdAt,
        original.updatedAt,
      )
  }
  const first = open()
  assert.deepEqual(await first.store.list('/project'), [original])
  assert.deepEqual(await first.store.list('/other-project'), [])
  await assert.rejects(stat(legacyFilename), { code: 'ENOENT' })
  assert.equal(await first.store.delete('/project', original.id), true)
  first.close()
  assert.deepEqual(await open().store.list('/project'), [])
})

test('The Creature’s proposals preserve links and reject stale updates and duplicate drafts', async t => {
  const { open } = await fixture(t)
  const { store: first } = open()
  const { store: second } = open()
  const original = idea()
  await first.applyDraft('/project', original)
  assert.deepEqual(await second.get('/project', original.id), original)
  assert.deepEqual(await second.summaries('/project', 'follow-UP'), {
    ideas: [{ id: original.id, title: original.title }],
    truncated: false,
  })
  const proposal = { ...original, body: 'Draft proposal', links: [], updatedAt: 30 }
  await assert.rejects(second.applyDraft('/project', proposal), /changed after The Creature read it/u)
  const saved = { ...proposal, links: original.links }
  assert.deepEqual(await second.applyDraft('/project', proposal, original), saved)
  await assert.rejects(first.applyDraft('/project', proposal, original), /changed after The Creature read it/u)
  assert.deepEqual(await first.get('/project', original.id), saved)
})

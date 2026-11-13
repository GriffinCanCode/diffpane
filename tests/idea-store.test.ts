import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IdeaStore } from '../electron/idea-store.ts';
import { MAX_IDEA_BODY_LENGTH, type Idea } from '../ideas.ts';

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
  };
}

async function fixture(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-ideas-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'settings', 'ideas.sqlite');
}

test('Markdown and line anchors persist across connections and stay scoped to a worktree', async t => {
  const filename = await fixture(t);
  const original = idea();
  const latest = idea({ id: 'another-note', updatedAt: 40 });
  const other = idea({ title: 'Independent worktree' });
  const first = new IdeaStore(filename);
  try {
    assert.deepEqual(first.list('/project'), []);
    assert.deepEqual(first.upsert('/project', original), original);
    first.upsert('/project', latest);
    first.upsert('/project/worktree', other);
  } finally {
    first.close();
  }
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o077, 0);

  const second = new IdeaStore(filename);
  try {
    assert.deepEqual(second.list('/project'), [latest, original]);
    assert.deepEqual(second.list('/project/worktree'), [other]);
    assert.deepEqual(second.list('/another-project'), []);
    const updated = idea({ createdAt: 30, updatedAt: 50, body: '- A revised idea' });
    const saved = { ...updated, createdAt: original.createdAt };
    assert.deepEqual(second.upsert('/project', updated), saved);
    assert.deepEqual(second.list('/project'), [saved, latest]);
    assert.equal(second.delete('/project', original.id), true);
    assert.equal(second.delete('/project', original.id), false);
    assert.deepEqual(second.list('/project'), [latest]);
    assert.deepEqual(second.list('/project/worktree'), [other]);
  } finally {
    second.close();
  }
  const third = new IdeaStore(filename);
  try {
    assert.deepEqual(third.list('/project'), [latest]);
  } finally {
    third.close();
  }
});

test('invalid links and oversized Markdown leave a previously saved idea intact', async t => {
  const store = new IdeaStore(await fixture(t));
  try {
    const original = idea();
    store.upsert('/project', original);
    assert.throws(
      () => store.upsert('/project', idea({ links: [{ path: '../outside' }] })),
      /inside this repository/u,
    );
    assert.throws(
      () =>
        store.upsert('/project', idea({ links: [{ path: 'src/core.ts', line: 5, endLine: 4 }] })),
      /invalid line range/u,
    );
    assert.throws(
      () => store.upsert('/project', idea({ body: 'x'.repeat(MAX_IDEA_BODY_LENGTH + 1) })),
      /Idea notes/u,
    );
    assert.deepEqual(store.list('/project'), [original]);
  } finally {
    store.close();
  }
});

test('interleaved connections preserve independent writes to the same workspace', async t => {
  const filename = await fixture(t);
  const first = new IdeaStore(filename);
  const second = new IdeaStore(filename);
  try {
    const original = idea();
    const other = idea({ id: 'second', updatedAt: 21 });
    first.upsert('/project', original);
    second.upsert('/project', other);
    const changed = { ...original, body: 'Edited', updatedAt: 30 };
    first.upsert('/project', changed);
    assert.deepEqual(second.list('/project'), [changed, other]);
  } finally {
    second.close();
    first.close();
  }
});

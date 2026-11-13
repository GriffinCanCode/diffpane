import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vite-plus/test';
import { LocalState } from '../electron/local-state.ts';
import { ReviewNotesStore } from '../electron/review-notes.ts';
import { MAX_REVIEW_NOTE_LENGTH } from '../review-notes.ts';
import type { ReviewAnchor } from '../review-notes.ts';

const runNode = promisify(execFile);
const storeModule = new URL('../electron/review-notes.ts', import.meta.url);
const stateModule = new URL('../electron/local-state.ts', import.meta.url);

const keys = {
  wrap: async (key: string) => Buffer.from(key, 'base64'),
  unwrap: async (blob: Buffer) => blob.toString('base64'),
};

async function fixture(t: { onTestFinished(cleanup: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-review-'));
  const data = path.join(directory, 'user-data', 'storage');
  const filename = path.join(data, 'state.sqlite');
  const legacyFilename = path.join(directory, 'user-data', 'review-notes', 'notes.sqlite');
  const states: LocalState[] = [];
  t.onTestFinished(async () => {
    for (const state of states) state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = () => {
    const state = new LocalState(filename, keys);
    states.push(state);
    return new ReviewNotesStore(state, legacyFilename);
  };
  return {
    data,
    filename,
    legacyFilename,
    root: path.join(directory, 'worktree'),
    store: open(),
    open,
  };
}

function anchor(filename: string): ReviewAnchor {
  return {
    path: filename,
    side: 'working',
    line: 2,
    endLine: 3,
    excerpt: 'const value = 1;\nreturn value;',
    truncated: false,
  };
}

test('review notes persist with their captured source while editing and resolving', async t => {
  const { store, data, filename, root, open } = await fixture(t);
  const source: ReviewAnchor = {
    ...anchor('src/with tab\tand newline\n.ts'),
    side: 'head',
    originalPath: 'old/file.ts',
  };
  assert.deepEqual(await store.list(root, root), []);
  const [first] = await store.change(root, root, {
    type: 'add',
    anchor: source,
    text: ' Look here ',
  });
  const [second] = await store.change(root, root, {
    type: 'add',
    anchor: null,
    text: 'Check docs',
  });
  const reopened = open();
  assert.deepEqual(await reopened.list(root, root), [second, first]);
  assert.ok(first);
  assert.equal(first.text, 'Look here');
  const id = first.id;
  await reopened.change(root, root, {
    type: 'edit',
    id,
    text: 'Handle missing data.',
    expectedText: first.text,
  });
  await reopened.change(root, root, { type: 'resolve', id, resolved: true });
  assert.deepEqual(await store.list(root, root), [
    second,
    { id, anchor: source, text: 'Handle missing data.', resolved: true },
  ]);
  await store.change(root, root, { type: 'resolve', id, resolved: false });
  assert.equal((await reopened.list(root, root))[1]?.resolved, false);
  await reopened.change(root, root, { type: 'delete', id });
  assert.deepEqual(await store.list(root, root), [second]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(data)).mode & 0o777, 0o700);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }
});

test('file notes follow folder boundaries and project notes stay in their open folder', async t => {
  const { store, root } = await fixture(t);
  const src = path.join(root, 'src');
  const deeper = path.join(src, 'view');
  const sibling = path.join(root, 'src-other');
  const [rootNote] = await store.change(root, root, { type: 'add', anchor: null, text: 'Root' });
  const [scopedNote] = await store.change(root, src, { type: 'add', anchor: null, text: 'Scoped' });
  const [fileNote] = await store.change(root, deeper, {
    type: 'add',
    anchor: anchor('src/view/deep/file.ts'),
    text: 'File',
  });
  assert.deepEqual(await store.list(root, root), [fileNote, rootNote]);
  assert.deepEqual(await store.list(root, src), [fileNote, scopedNote]);
  assert.deepEqual(await store.list(root, deeper), [fileNote]);
  assert.deepEqual(await store.list(root, sibling), []);
  assert.deepEqual(await store.list(src, src), []);
  assert.ok(fileNote);
  const outsideChanges = [
    { type: 'edit', text: 'New', expectedText: fileNote.text },
    { type: 'resolve', resolved: true },
    { type: 'delete' },
  ];
  await Promise.all(
    outsideChanges.map(change =>
      assert.rejects(
        store.change(root, sibling, { ...change, id: fileNote.id }),
        /no longer available/u,
      ),
    ),
  );
  await assert.rejects(
    store.change(root, src, { type: 'add', anchor: anchor('src-other/file.ts'), text: 'Outside' }),
    /outside the open folder/u,
  );
  await assert.rejects(store.list(src, root), /outside the Git working tree/u);
  assert.deepEqual(await store.list(root, src), [fileNote, scopedNote]);
});

test('the store rejects malformed renderer changes and line anchors', async t => {
  const { store, root } = await fixture(t);
  const source = anchor('file.ts');
  const add = { type: 'add', anchor: source, text: 'A note' };
  const invalidChanges = [
    null,
    {},
    { ...add, anchor: undefined },
    { ...add, anchor: { ...source, path: '/outside.ts' } },
    { ...add, anchor: { ...source, path: '../outside.ts' } },
    { ...add, anchor: { ...source, path: 'folder/.git/config' } },
    { ...add, anchor: { ...source, line: 4 } },
    { ...add, anchor: { ...source, line: null, endLine: null } },
    { ...add, anchor: { ...source, endLine: 2 } },
    { ...add, anchor: { ...source, originalPath: 'before.ts' } },
    { ...add, text: '  ' },
    { ...add, text: 'a'.repeat(MAX_REVIEW_NOTE_LENGTH + 1) },
    { type: 'delete', id: 'invalid' },
  ];
  await Promise.all(
    invalidChanges.map(change =>
      assert.rejects(store.change(root, root, change), /review note|Enter a note/u),
    ),
  );
  assert.deepEqual(await store.list(root, root), []);
});

test('independent Diffpane processes persist concurrent additions without losing notes', async t => {
  const { store, filename, legacyFilename, root } = await fixture(t);
  const worker = `
    const [modulePath, statePath, filename, legacyFilename, root, label] = process.argv.slice(1);
    const { ReviewNotesStore } = await import(modulePath);
    const { LocalState } = await import(statePath);
    const state = new LocalState(filename, {
      wrap: async key => Buffer.from(key, 'base64'),
      unwrap: async blob => blob.toString('base64'),
    });
    try {
      const store = new ReviewNotesStore(state, legacyFilename);
      for (let index = 0; index < 15; index++)
        await store.change(root, root, { type: 'add', anchor: null, text: label + index });
    } finally {
      state.close();
    }
  `;
  await Promise.all(
    ['alpha-', 'beta-'].map(label =>
      runNode(process.execPath, [
        '--input-type=module',
        '-e',
        worker,
        fileURLToPath(storeModule),
        fileURLToPath(stateModule),
        filename,
        legacyFilename,
        root,
        label,
      ]),
    ),
  );
  const notes = await store.list(root, root);
  assert.equal(notes.length, 30);
  assert.equal(new Set(notes.map(note => note.id)).size, 30);
  assert.equal(new Set(notes.map(note => note.text)).size, 30);
});

test('an edit based on stale text preserves the newer review note', async t => {
  const { store, root, open } = await fixture(t);
  const [original] = await store.change(root, root, {
    type: 'add',
    anchor: null,
    text: 'Original note',
  });
  assert.ok(original);
  const second = open();
  const edits = await Promise.allSettled(
    [store, second].map((writer, index) =>
      writer.change(root, root, {
        type: 'edit',
        id: original.id,
        text: `Updated from window ${index + 1}`,
        expectedText: original.text,
      }),
    ),
  );
  const successful = edits.find(edit => edit.status === 'fulfilled');
  const conflicted = edits.find(edit => edit.status === 'rejected');
  assert.ok(successful);
  assert.ok(conflicted);
  const reason: unknown = conflicted.reason;
  assert.ok(reason instanceof Error);
  assert.match(reason.message, /changed in another window/u);
  assert.deepEqual(await store.list(root, root), successful.value);
});

test('legacy review notes in an interrupted writer’s WAL keep their order and folder visibility', async t => {
  const { legacyFilename, root, store, open } = await fixture(t);
  const src = path.join(root, 'src');
  const rootNote = {
    id: '40000000-0000-0000-0000-000000000001',
    anchor: null,
    text: 'Root note',
    resolved: false,
  };
  const scopedNote = {
    id: '40000000-0000-0000-0000-000000000002',
    anchor: null,
    text: 'Folder note',
    resolved: true,
  };
  const source = anchor('src/file.ts');
  const fileNote = {
    id: '40000000-0000-0000-0000-000000000003',
    anchor: source,
    text: 'File note',
    resolved: true,
  };
  await mkdir(path.dirname(legacyFilename), { recursive: true });
  const writer = `
    import { DatabaseSync } from 'node:sqlite';
    const [filename, root, encoded] = process.argv.slice(1);
    const [rootNote, scopedNote, fileNote] = JSON.parse(encoded);
    const database = new DatabaseSync(filename);
    database.exec(\`
      PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE review_notes (
        sequence INTEGER PRIMARY KEY, id TEXT, worktree TEXT, project_scope TEXT, anchor_path TEXT,
        anchor TEXT, text TEXT, resolved INTEGER
      );
    \`);
    const insert = database.prepare('INSERT INTO review_notes VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(2, rootNote.id, root, '', null, null, rootNote.text, 0);
    insert.run(5, scopedNote.id, root, 'src', null, null, scopedNote.text, 1);
    insert.run(8, fileNote.id, root, null, fileNote.anchor.path, JSON.stringify(fileNote.anchor), fileNote.text, 1);
    process.exit(0);
  `;
  await runNode(process.execPath, [
    '--input-type=module',
    '-e',
    writer,
    legacyFilename,
    root,
    JSON.stringify([rootNote, scopedNote, fileNote]),
  ]);
  assert.ok((await stat(`${legacyFilename}-wal`)).size > 0);
  assert.deepEqual(await store.list(root, root), [fileNote, rootNote]);
  assert.deepEqual(await store.list(root, src), [fileNote, scopedNote]);
  await assert.rejects(stat(legacyFilename), { code: 'ENOENT' });
  await assert.rejects(stat(`${legacyFilename}-wal`), { code: 'ENOENT' });
  const [newNote] = await store.change(root, src, { type: 'add', anchor: null, text: 'Newer' });
  assert.deepEqual(await open().list(root, src), [newNote, fileNote, scopedNote]);
});

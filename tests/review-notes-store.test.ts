import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ReviewNotesStore } from '../electron/review-notes.ts';
import { MAX_REVIEW_NOTE_LENGTH, type ReviewAnchor } from '../review-notes.ts';

const runNode = promisify(execFile);
const storeModule = new URL('../electron/review-notes.ts', import.meta.url);

async function fixture(t: { onTestFinished(cleanup: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diffpane-review-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'user-data', 'review-notes');
  return { data, root: path.join(directory, 'worktree'), store: new ReviewNotesStore(data) };
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
  const { store, data, root } = await fixture(t);
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
  const reopened = new ReviewNotesStore(data);
  assert.deepEqual(await reopened.list(root, root), [second, first]);
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
  assert.equal((await reopened.list(root, root))[1].resolved, false);
  await reopened.change(root, root, { type: 'delete', id });
  assert.deepEqual(await store.list(root, root), [second]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(data)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(data, 'notes.sqlite'))).mode & 0o777, 0o600);
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
  for (const change of [
    { type: 'edit', text: 'New', expectedText: fileNote.text },
    { type: 'resolve', resolved: true },
    { type: 'delete' },
  ]) {
    await assert.rejects(
      store.change(root, sibling, { ...change, id: fileNote.id }),
      /no longer available/u,
    );
  }
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
  for (const change of [
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
  ]) {
    await assert.rejects(store.change(root, root, change), /review note|Enter a note/u);
  }
  assert.deepEqual(await store.list(root, root), []);
});

test('independent Diffpane processes persist concurrent additions without losing notes', async t => {
  const { store, data, root } = await fixture(t);
  const worker = `
    const [modulePath, data, root, label] = process.argv.slice(1);
    const { ReviewNotesStore } = await import(modulePath);
    const store = new ReviewNotesStore(data);
    for (let index = 0; index < 15; index++)
      await store.change(root, root, { type: 'add', anchor: null, text: label + index });
  `;
  await Promise.all(
    ['alpha-', 'beta-'].map(label =>
      runNode(process.execPath, [
        '--input-type=module',
        '-e',
        worker,
        fileURLToPath(storeModule),
        data,
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
  const { store, data, root } = await fixture(t);
  const [original] = await store.change(root, root, {
    type: 'add',
    anchor: null,
    text: 'Original note',
  });
  const second = new ReviewNotesStore(data);
  const [firstEdit, secondEdit] = await Promise.allSettled(
    [store, second].map((writer, index) =>
      writer.change(root, root, {
        type: 'edit',
        id: original.id,
        text: `Updated from window ${index + 1}`,
        expectedText: original.text,
      }),
    ),
  );
  const edits = [firstEdit, secondEdit];
  const successful = edits.find(edit => edit.status === 'fulfilled');
  const conflicted = edits.find(edit => edit.status === 'rejected');
  assert.ok(successful);
  assert.ok(conflicted);
  assert.match(conflicted.reason.message, /changed in another window/u);
  assert.deepEqual(await store.list(root, root), successful.value);
});

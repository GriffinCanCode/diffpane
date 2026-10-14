import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { operationPath, renameEntry } from '../electron/file-operations.ts';

test('rename preserves files and folder descendants and rejects collisions and unsafe paths', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-rename-')));
  const workspace = {
    root,
    scope: root,
    gitDir: path.join(root, '.git'),
    commonDir: path.join(root, '.git'),
  };
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'old.ts'), 'saved contents');
  assert.equal(await renameEntry(workspace, 'src/old.ts', 'new.ts'), 'src/new.ts');
  assert.equal(await readFile(path.join(root, 'src', 'new.ts'), 'utf8'), 'saved contents');
  await writeFile(path.join(root, 'src', 'existing.ts'), 'keep me');
  await assert.rejects(renameEntry(workspace, 'src/new.ts', 'existing.ts'), /already exists/u);
  assert.equal(await readFile(path.join(root, 'src', 'existing.ts'), 'utf8'), 'keep me');
  assert.equal(await renameEntry(workspace, 'src', 'lib'), 'lib');
  assert.equal(await readFile(path.join(root, 'lib', 'new.ts'), 'utf8'), 'saved contents');
  for (const filename of [
    '',
    '..',
    '../outside',
    '.git',
    '.git/config',
    'lib/../.git',
    '/tmp',
    'lib//new.ts',
  ])
    await assert.rejects(operationPath(workspace, filename));
  for (const name of ['', ' ', '.', '..', '.git', '../escape', 'nested/file', 'nested\\file'])
    await assert.rejects(renameEntry(workspace, 'lib/new.ts', name));
  await assert.rejects(operationPath({ ...workspace, scope: path.join(root, 'lib') }, 'lib'));
  await assert.rejects(operationPath({ ...workspace, scope: path.join(root, 'lib') }, 'src'));
});

test('operations reject external symlink parents but can rename a symlink itself', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-symlink-')));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'diffpane-outside-'));
  t.onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const workspace = {
    root,
    scope: root,
    gitDir: path.join(root, '.git'),
    commonDir: path.join(root, '.git'),
  };
  await writeFile(path.join(outside, 'keep.txt'), 'outside');
  await symlink(outside, path.join(root, 'link'));
  await assert.rejects(operationPath(workspace, 'link/keep.txt'));
  await renameEntry(workspace, 'link', 'renamed-link');
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
});

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'
import { operationPath, renameEntry } from '../electron/file-operations.ts'

test('rename preserves files and folder descendants and rejects collisions and unsafe paths', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-rename-')))
  const workspace = {
    root,
    scope: root,
    gitDir: path.join(root, '.git'),
    commonDir: path.join(root, '.git'),
  }
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.git'))
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'old.ts'), 'saved contents')
  assert.equal(await renameEntry(workspace, 'src/old.ts', 'new.ts'), 'src/new.ts')
  assert.equal(await readFile(path.join(root, 'src', 'new.ts'), 'utf8'), 'saved contents')
  await writeFile(path.join(root, 'src', 'existing.ts'), 'keep me')
  await assert.rejects(renameEntry(workspace, 'src/new.ts', 'existing.ts'), /already exists/u)
  assert.equal(await readFile(path.join(root, 'src', 'existing.ts'), 'utf8'), 'keep me')
  assert.equal(await renameEntry(workspace, 'src', 'lib'), 'lib')
  assert.equal(await readFile(path.join(root, 'lib', 'new.ts'), 'utf8'), 'saved contents')
  const invalidPaths = ['', '..', '../outside', '.git', '.git/config', 'lib/../.git', '/tmp', 'lib//new.ts']
  await Promise.all(invalidPaths.map(filename => assert.rejects(operationPath(workspace, filename))))
  const invalidNames = ['', ' ', '.', '..', '.git', '../escape', 'nested/file', 'nested\\file']
  await Promise.all(invalidNames.map(name => assert.rejects(renameEntry(workspace, 'lib/new.ts', name))))
  await assert.rejects(operationPath({ ...workspace, scope: path.join(root, 'lib') }, 'lib'))
  await assert.rejects(operationPath({ ...workspace, scope: path.join(root, 'lib') }, 'src'))
})

test('operations reject external symlink parents but can rename a symlink itself', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-symlink-')))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'diffpane-outside-'))
  t.onTestFinished(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const workspace = {
    root,
    scope: root,
    gitDir: path.join(root, '.git'),
    commonDir: path.join(root, '.git'),
  }
  await writeFile(path.join(outside, 'keep.txt'), 'outside')
  await symlink(outside, path.join(root, 'link'))
  await assert.rejects(operationPath(workspace, 'link/keep.txt'))
  await renameEntry(workspace, 'link', 'renamed-link')
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside')
})

test('simultaneous renames to the same destination preserve both source contents', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-rename-')))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const workspace = {
    root,
    scope: root,
    gitDir: path.join(root, '.git'),
    commonDir: path.join(root, '.git'),
  }
  await writeFile(path.join(root, 'first.txt'), 'first')
  await writeFile(path.join(root, 'second.txt'), 'second')
  const results = await Promise.allSettled([
    renameEntry(workspace, 'first.txt', 'destination.txt'),
    renameEntry(workspace, 'second.txt', 'destination.txt'),
  ])
  const firstWon = results[0].status === 'fulfilled'
  const other = results[firstWon ? 1 : 0]
  assert.equal(other.status, 'rejected')
  const reason: unknown = other.reason
  assert.ok(reason instanceof Error)
  assert.match(reason.message, /already exists/u)
  assert.equal(await readFile(path.join(root, 'destination.txt'), 'utf8'), firstWon ? 'first' : 'second')
  assert.equal(
    await readFile(path.join(root, firstWon ? 'second.txt' : 'first.txt'), 'utf8'),
    firstWon ? 'second' : 'first',
  )
})

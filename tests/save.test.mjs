import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../electron/repository.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-save-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  return { root, repository: await Repository.open(root) };
}

test('saves preserve encodings, BOMs, line endings and permissions', async t => {
  const { root, repository } = await fixture(t);
  for (const [name, initial, expected, text, saved] of [
    ['utf8.txt', Buffer.from('before\r\n'), 'before\r\n', '雪\r\n', Buffer.from('雪\r\n')],
    [
      'bom.txt',
      Buffer.from('\uFEFFbefore'),
      '\uFEFFbefore',
      '\uFEFFafter',
      Buffer.from('\uFEFFafter'),
    ],
    ['le.txt', Buffer.from([0xff, 0xfe, 0x61, 0]), 'a', 'b', Buffer.from([0xff, 0xfe, 0x62, 0])],
    ['be.txt', Buffer.from([0xfe, 0xff, 0, 0x61]), 'a', 'b', Buffer.from([0xfe, 0xff, 0, 0x62])],
    [
      'legacy.txt',
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      'café',
      'été',
      Buffer.from([0xe9, 0x74, 0xe9]),
    ],
  ]) {
    const file = path.join(root, name);
    await writeFile(file, initial, { mode: 0o755 });
    await repository.save(name, text, expected);
    assert.deepEqual(await readFile(file), saved, name);
    assert.equal((await stat(file)).mode & 0o777, 0o755);
  }
  await repository.save('utf8.txt', '', '雪\r\n');
  assert.equal((await readFile(path.join(root, 'utf8.txt'))).length, 0);
});

test('stale saves and unrepresentable legacy text do not overwrite disk contents', async t => {
  const { root, repository } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'external change');
  await assert.rejects(repository.save('file.txt', 'my edit', 'old version'), /changed on disk/);
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'external change');
  const legacy = Buffer.from([0xe9]);
  await writeFile(path.join(root, 'legacy.txt'), legacy);
  await assert.rejects(repository.save('legacy.txt', '雪', 'é'), /Windows-1252/);
  assert.deepEqual(await readFile(path.join(root, 'legacy.txt')), legacy);
});

test('saves reject symlinks, Git metadata, out-of-scope files and incomplete previews', async t => {
  const { root, repository } = await fixture(t);
  await mkdir(path.join(root, 'inside'));
  await writeFile(path.join(root, 'file.txt'), 'original');
  await symlink('file.txt', path.join(root, 'link.txt'));
  assert.equal(await repository.editable('link.txt'), false);
  await assert.rejects(repository.save('link.txt', 'edit', 'original'), /regular text/);
  await assert.rejects(repository.save('.git/config', 'edit', ''), /regular text/);
  await assert.rejects(repository.save('../outside', 'edit', ''), /invalid repository-relative/);
  const scoped = await Repository.open(path.join(root, 'inside'));
  await assert.rejects(scoped.save('file.txt', 'edit', 'original'), /regular text/);
  await writeFile(path.join(root, 'large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(repository.save('large.txt', 'edit', ''), /complete text/);
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await assert.rejects(repository.save('binary', 'edit', ''), /complete text/);
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'original');
});

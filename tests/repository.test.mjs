import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Repository } from '../electron/repository.mjs';

const execute = promisify(execFile);
const plain = (filename) => ({ path: filename, originalPath: null, index: ' ', worktree: ' ', conflicted: false, submodule: false });
const find = (snapshot, filename) => {
  const file = snapshot.files.find((entry) => entry.path === filename);
  assert.ok(file, `Missing changed file ${JSON.stringify(filename)}`);
  return file;
};

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-repository-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const git = async (args) => (await execute('git', ['-C', root, ...args], { env, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const write = async (filename, contents) => {
    const absolute = path.join(root, filename);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  };
  const commit = async () => {
    await git(['add', '--all']);
    await git(['-c', `core.hooksPath=${path.join(root, '.git', 'no-hooks')}`, 'commit', '-m', 'baseline']);
  };
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Diffpane tests']);
  await git(['config', 'user.email', 'diffpane@example.invalid']);
  await git(['config', 'commit.gpgsign', 'false']);
  return { root, git, write, commit, open: () => Repository.open(root) };
}

test('file inventory includes unchanged code and nonignored untracked files without opening contents', async (t) => {
  const repo = await fixture(t);
  await repo.write('unchanged.rs', 'fn main() {}\n');
  await repo.write('ignored/tracked.rs', 'tracked despite ignore rules\n');
  await repo.commit();
  await repo.write('.gitignore', 'ignored/\nnode_modules/\n');
  await repo.write('new.rs', 'not committed yet\n');
  await repo.write('ignored/noise.rs', 'ignore this\n');
  await repo.write('node_modules/dependency/index.js', 'ignore this too\n');
  const repository = await repo.open();
  const files = await repository.files();
  assert.deepEqual(files, ['.gitignore', 'ignored/tracked.rs', 'new.rs', 'unchanged.rs'].map(plain));
  assert.deepEqual(await repository.contents(files.find((file) => file.path === 'unchanged.rs')), {
    before: 'fn main() {}\n', after: 'fn main() {}\n', note: null,
  });
  assert.equal((await repository.snapshot()).files.some((file) => file.path === 'unchanged.rs'), false);
});

test('file inventory honors nested directory scope and retains missing tracked paths', async (t) => {
  const repo = await fixture(t);
  for (const name of ['inside/a.rs', 'inside/deep/b.rs', 'inside-other/c.rs', 'outside/d.rs']) {
    await repo.write(name, `${name}\n`);
  }
  await repo.commit();
  await repo.write('inside/new.rs', 'new\n');
  await repo.write('outside/new.rs', 'outside\n');
  await rm(path.join(repo.root, 'inside/a.rs'));
  const repository = await Repository.open(path.join(repo.root, 'inside'));
  assert.deepEqual(await repository.files(), ['inside/a.rs', 'inside/deep/b.rs', 'inside/new.rs'].map(plain));
});

test('file inventory preserves unusual names and distinguishes untracked names resembling stage metadata', async (t) => {
  const repo = await fixture(t);
  const tracked = ['space name.rs', '雪☃.rs', 'a\nline.rs', 'tab\tname.rs', ':(glob)*.rs', '-dash.rs'];
  for (const name of tracked) await repo.write(name, 'unchanged\n');
  await repo.commit();
  const untracked = [`100644 ${'a'.repeat(40)} 0\tlooks-tracked.rs`, '? prefixed.rs', 'new\n雪.rs'];
  for (const name of untracked) await repo.write(name, 'untracked\n');
  const repository = await repo.open();
  const expected = [...tracked, ...untracked].sort().map(plain);
  assert.deepEqual(await repository.files(), expected);
});

test('file inventory identifies Git index links without descending into submodules', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'baseline\n');
  await repo.commit();
  const oid = (await repo.git(['rev-parse', 'HEAD'])).trim();
  await repo.git(['update-index', '--add', '--cacheinfo', `160000,${oid},modules/child`]);
  await repo.write('modules/child/inside.rs', 'submodule contents\n');
  const repository = await repo.open();
  assert.deepEqual(await repository.files(), [plain('a.rs'), { ...plain('modules/child'), submodule: true }]);
});

test('partial staging preserves all three comparisons', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'first\nold\n');
  await repo.commit();
  await repo.write('a.rs', 'first\nstaged\n');
  await repo.git(['add', 'a.rs']);
  await repo.write('a.rs', 'first\nworking\n');
  const repository = await repo.open();
  const file = find(await repository.snapshot(), 'a.rs');
  assert.equal(file.index, 'M');
  assert.equal(file.worktree, 'M');
  for (const [comparison, before, after] of [
    ['head', 'first\nold\n', 'first\nworking\n'],
    ['staged', 'first\nold\n', 'first\nstaged\n'],
    ['unstaged', 'first\nstaged\n', 'first\nworking\n'],
  ]) assert.deepEqual(await repository.contents(file, comparison), { before, after, note: null });
});

test('unborn HEAD supports both untracked and staged additions', async (t) => {
  const repo = await fixture(t);
  await repo.write('new.rs', 'hello');
  const repository = await repo.open();
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.branch, 'main (unborn)');
  const file = snapshot.files[0];
  assert.deepEqual(await repository.contents(file), { before: '', after: 'hello', note: null });
  assert.deepEqual(await repository.contents(file, 'staged'), { before: '', after: '', note: null });
  await repo.git(['add', 'new.rs']);
  assert.deepEqual(await repository.contents((await repository.snapshot()).files[0], 'staged'), { before: '', after: 'hello', note: null });
});

test('filenames preserve spaces, Unicode, newlines and pathspec metacharacters', async (t) => {
  const repo = await fixture(t);
  const names = ['space name.rs', '雪☃.rs', 'a\nline.rs', ':(glob)*.rs', '-dash.rs'];
  for (const name of names) await repo.write(name, 'old\n');
  await repo.commit();
  for (const name of names) await repo.write(name, 'new\n');
  const repository = await repo.open();
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.files.length, names.length);
  for (const name of names) assert.deepEqual(await repository.contents(find(snapshot, name)), { before: 'old\n', after: 'new\n', note: null });
});

test('staged rename uses original HEAD and the new index path', async (t) => {
  const repo = await fixture(t);
  await repo.write('before name.rs', 'before\n');
  await repo.commit();
  await repo.git(['mv', 'before name.rs', 'after name.rs']);
  await repo.write('after name.rs', 'after\n');
  const repository = await repo.open();
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.files.length, 1);
  const file = snapshot.files[0];
  assert.equal(file.originalPath, 'before name.rs');
  assert.deepEqual(await repository.contents(file), { before: 'before\n', after: 'after\n', note: null });
  assert.deepEqual(await repository.contents(file, 'staged'), { before: 'before\n', after: 'before\n', note: null });
  assert.deepEqual(await repository.contents(file, 'unstaged'), { before: 'before\n', after: 'after\n', note: null });
});

test('staged deletion and recreation keep index and worktree distinct', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'baseline\n');
  await repo.commit();
  await repo.git(['rm', 'a.rs']);
  await repo.write('a.rs', 'recreated\n');
  const repository = await repo.open();
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.files.length, 1);
  const file = snapshot.files[0];
  assert.deepEqual(await repository.contents(file), { before: 'baseline\n', after: 'recreated\n', note: null });
  assert.deepEqual(await repository.contents(file, 'staged'), { before: 'baseline\n', after: '', note: null });
  assert.deepEqual(await repository.contents(file, 'unstaged'), { before: '', after: 'recreated\n', note: null });
  await rm(path.join(repo.root, 'a.rs'));
  assert.equal((await repository.contents((await repository.snapshot()).files[0])).after, '');
});

test('file and directory replacements show old files as deletions', async (t) => {
  const repo = await fixture(t);
  await repo.write('file', 'old file\n');
  await repo.write('directory/nested', 'old nested\n');
  await repo.commit();
  await rm(path.join(repo.root, 'file'));
  await repo.write('file/nested', 'new nested\n');
  await rm(path.join(repo.root, 'directory'), { recursive: true });
  await repo.write('directory', 'new file\n');
  const repository = await repo.open();
  const snapshot = await repository.snapshot();
  for (const [name, before] of [['file', 'old file\n'], ['directory/nested', 'old nested\n']]) {
    assert.deepEqual(await repository.contents(find(snapshot, name)), { before, after: '', note: null });
  }
});

test('nested directory scope excludes sibling edits and includes cross-scope renames', async (t) => {
  const repo = await fixture(t);
  await repo.write('inside/a.rs', 'a\n');
  await repo.write('outside/b.rs', 'b\n');
  await repo.commit();
  await repo.write('inside/a.rs', 'A\n');
  await repo.write('outside/b.rs', 'B\n');
  const repository = await Repository.open(path.join(repo.root, 'inside'));
  assert.deepEqual((await repository.snapshot()).files.map((file) => file.path), ['inside/a.rs']);
  await repo.git(['mv', 'outside/b.rs', 'inside/b.rs']);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.files.length, 2);
  assert.equal(find(snapshot, 'inside/b.rs').originalPath, 'outside/b.rs');
});

test('linked worktrees resolve both real metadata directories', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'a\n');
  await repo.commit();
  const worktree = await mkdtemp(path.join(tmpdir(), 'diffpane-worktree-'));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  const linked = path.join(worktree, 'linked');
  await repo.git(['worktree', 'add', '-b', 'linked', linked]);
  await writeFile(path.join(linked, 'a.rs'), 'changed\n');
  const repository = await Repository.open(linked);
  assert.notEqual(repository.gitDir, repository.commonDir);
  assert.equal(repository.commonDir, path.join(repo.root, '.git'));
  assert.equal((await repository.snapshot()).files.length, 1);
});

test('ignored events skip refresh while tracked descendants remain relevant', async (t) => {
  const repo = await fixture(t);
  await repo.write('ignored/tracked.rs', 'baseline\n');
  await repo.commit();
  await repo.write('.gitignore', 'ignored/\ncache/\n');
  await repo.write('ignored/noise', 'noise\n');
  await repo.write('cache/noise', 'noise\n');
  await repo.write('cache/a\n:(glob)*', 'noise\n');
  await repo.write('ignored/tracked.rs', 'changed\n');
  const repository = await repo.open();
  for (const [name, expected] of [['ignored/noise', false], ['cache', false], ['cache/a\n:(glob)*', false], ['ignored/tracked.rs', true], ['ignored', true], ['.gitignore', true]]) {
    assert.equal(await repository.hasRelevantPaths([path.join(repo.root, name)]), expected, name);
  }
  assert.equal(await repository.hasRelevantPaths([]), true);
});

test('binary, oversized, many-line and minified files show explicit preview notes', async (t) => {
  const repo = await fixture(t);
  await repo.write('binary', Buffer.from([0, 1, 2]));
  await repo.write('large', Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));
  await repo.write('lines', 'x\n'.repeat(50_001));
  await repo.write('minified', 'x'.repeat(16 * 1024 + 1));
  const repository = await repo.open();
  for (const file of (await repository.snapshot()).files) {
    const contents = await repository.contents(file);
    assert.ok(contents.note, file.path);
    assert.equal(contents.before, '');
    assert.equal(contents.after, '');
  }
  await repo.commit();
  await repo.write('large', 'small now\n');
  assert.match((await repository.contents(find(await repository.snapshot(), 'large'))).note, /MiB/);
});

test('unresolved conflicts expose working markers and explain index modes', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'base\n');
  await repo.commit();
  await repo.git(['switch', '-c', 'other']);
  await repo.write('a.rs', 'other\n');
  await repo.commit();
  await repo.git(['switch', 'main']);
  await repo.write('a.rs', 'main\n');
  await repo.commit();
  await assert.rejects(repo.git(['merge', 'other']));
  const repository = await repo.open();
  const file = find(await repository.snapshot(), 'a.rs');
  assert.equal(file.conflicted, true);
  assert.deepEqual(await repository.files(), [plain('a.rs')]);
  const contents = await repository.contents(file);
  assert.match(contents.after, /<<<<<<< /);
  assert.match(contents.note, /conflict/);
  assert.match((await repository.contents(file, 'staged')).note, /unresolved/);
});

test('symlink preview reads the link without reading its external target', { skip: process.platform === 'win32' }, async (t) => {
  const repo = await fixture(t);
  const external = await mkdtemp(path.join(tmpdir(), 'diffpane-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const target = path.join(external, 'target');
  await writeFile(target, 'external secret');
  await symlink(target, path.join(repo.root, 'link'));
  const repository = await repo.open();
  assert.equal((await repository.contents(find(await repository.snapshot(), 'link'))).after, target);
});

test('symlinked parent directories cannot expose external contents', { skip: process.platform === 'win32' }, async (t) => {
  const repo = await fixture(t);
  await repo.write('folder/a.rs', 'baseline\n');
  await repo.commit();
  const external = await mkdtemp(path.join(tmpdir(), 'diffpane-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'a.rs'), 'external secret');
  await rm(path.join(repo.root, 'folder'), { recursive: true });
  await symlink(external, path.join(repo.root, 'folder'));
  const repository = await repo.open();
  const contents = await repository.contents(plain('folder/a.rs'));
  assert.match(contents.note, /outside this repository/);
  assert.equal(contents.after, '');
});

test('CRLF and terminal newlines are preserved for Monaco text models', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'hello\r\nlast\r\n');
  await repo.commit();
  await repo.write('a.rs', 'hello\nlast');
  const repository = await repo.open();
  assert.deepEqual(await repository.contents(plain('a.rs')), { before: 'hello\r\nlast\r\n', after: 'hello\nlast', note: null });
  await repo.write('a.rs', 'hello\nlast\n');
  assert.match((await repository.contents(plain('a.rs'))).note, /line endings/);
});

test('contents use the current HEAD after a commit without retaining old blobs', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'before\n');
  await repo.commit();
  await repo.write('a.rs', 'after\n');
  const repository = await repo.open();
  const selected = find(await repository.snapshot(), 'a.rs');
  await repo.commit();
  assert.deepEqual(await repository.contents(selected), { before: 'after\n', after: 'after\n', note: null });
  assert.equal((await repository.snapshot()).files.length, 0);
});

test('detached HEAD identifies its commit', async (t) => {
  const repo = await fixture(t);
  await repo.write('a.rs', 'baseline\n');
  await repo.commit();
  const oid = (await repo.git(['rev-parse', 'HEAD'])).trim();
  await repo.git(['switch', '--detach', 'HEAD']);
  assert.equal((await (await repo.open()).snapshot()).branch, `detached ${oid.slice(0, 8)}`);
});

test('invalid paths and comparison modes fail explicitly', async (t) => {
  const repository = await (await fixture(t)).open();
  for (const filename of ['', '../outside', '/absolute', 'nested/../../outside', 'nul\0path']) {
    await assert.rejects(repository.contents(plain(filename)), /invalid repository-relative path/);
  }
  await assert.rejects(repository.contents(plain('a.rs'), 'unknown'), /Unknown comparison/);
});

test('non-UTF-8 file contents are identified and UTF-8 BOM bytes survive decoding', async (t) => {
  const repo = await fixture(t);
  await repo.write('invalid', Buffer.from([0xff, 0xfe]));
  await repo.write('bom', '\uFEFFhello\n');
  const repository = await repo.open();
  assert.match((await repository.contents(plain('invalid'))).note, /non-UTF-8/);
  assert.equal((await repository.contents(plain('bom'))).after, '\uFEFFhello\n');
});

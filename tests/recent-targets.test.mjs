import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecentTargets } from '../electron/recent-targets.ts';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-recents-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, filename: path.join(root, 'settings', 'recent-targets.json') };
}

test('recent targets tolerate missing and corrupt history and reject invalid records', async t => {
  const { root, filename } = await fixture(t);
  assert.deepEqual(await new RecentTargets(filename).list(), []);
  await mkdir(path.dirname(filename));
  await writeFile(filename, '{unfinished');
  assert.deepEqual(await new RecentTargets(filename).list(), []);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second.txt');
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
  );
  const history = await new RecentTargets(filename).list();
  assert.deepEqual(history, [
    { path: second, name: 'second.txt', kind: 'file', openedAt: 30 },
    { path: first, name: 'first', kind: 'folder', openedAt: 20 },
  ]);
});

test('recent targets persist an ordered bounded history with files and folders', async t => {
  const { root, filename } = await fixture(t);
  const history = new RecentTargets(filename);
  const folders = Array.from({ length: 9 }, (_, index) => path.join(root, `folder-${index}`));
  const file = path.join(folders[0], 'example.txt');
  await Promise.all(folders.map(folder => mkdir(folder)));
  await writeFile(file, 'example');
  for (const folder of folders) await history.record(folder);
  assert.deepEqual(
    (await history.list()).map(entry => entry.path),
    folders.slice(1).reverse(),
  );
  await history.record(file);
  await history.record(folders[4]);
  await history.record(path.join(root, 'missing'));
  const expected = await history.list();
  assert.equal(expected.length, 8);
  assert.equal(expected[0].path, folders[4], 'reopening moves an entry to the front');
  assert.equal(expected.filter(entry => entry.path === folders[4]).length, 1);
  assert.deepEqual(
    { path: expected[1].path, name: expected[1].name, kind: expected[1].kind },
    { path: file, name: 'example.txt', kind: 'file' },
  );
  assert.ok(expected.every(entry => entry.openedAt > 0));
  assert.deepEqual(await new RecentTargets(filename).list(), expected);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), expected);
  assert.deepEqual(await readdir(path.dirname(filename)), ['recent-targets.json']);
  await history.remove(file);
  assert.equal(
    (await new RecentTargets(filename).list()).some(entry => entry.path === file),
    false,
  );
  const copy = await history.list();
  copy[0].name = 'changed outside the store';
  assert.notEqual((await history.list())[0].name, copy[0].name);
});

test('recent target writes recover when persistence is unavailable', async t => {
  const { root } = await fixture(t);
  const target = path.join(root, 'target');
  await mkdir(target);
  const blocked = path.join(root, 'blocked');
  await writeFile(blocked, 'not a directory');
  const history = new RecentTargets(path.join(blocked, 'recent-targets.json'));
  await history.record(target);
  assert.equal((await history.list())[0].path, target);
  await rm(blocked);
  await mkdir(blocked);
  await history.record(target);
  assert.equal(
    (await new RecentTargets(path.join(blocked, 'recent-targets.json')).list()).length,
    1,
  );
});

test('concurrent recent records leave one complete latest history on disk', async t => {
  const { root, filename } = await fixture(t);
  const history = new RecentTargets(filename);
  const targets = Array.from({ length: 12 }, (_, index) => path.join(root, `target-${index}`));
  await Promise.all(targets.map(target => mkdir(target)));
  await Promise.all(targets.map(target => history.record(target)));
  const entries = await history.list();
  assert.equal(entries.length, 8);
  assert.equal(new Set(entries.map(entry => entry.path)).size, 8);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), entries);
  assert.deepEqual(await readdir(path.dirname(filename)), ['recent-targets.json']);
});

test('independent app histories refresh and merge interleaved records and removals', async t => {
  const { root, filename } = await fixture(t);
  const first = new RecentTargets(filename);
  const second = new RecentTargets(filename);
  const targets = Array.from({ length: 4 }, (_, index) => path.join(root, `target-${index}`));
  await Promise.all(targets.map(target => mkdir(target)));
  await Promise.all([first.ready, second.ready]);
  await first.record(targets[0]);
  assert.deepEqual(
    (await second.list()).map(entry => entry.path),
    [targets[0]],
  );
  await second.record(targets[1]);
  assert.deepEqual(
    (await first.list()).map(entry => entry.path),
    [targets[1], targets[0]],
  );
  await first.record(targets[2]);
  await second.remove(targets[0]);
  await first.record(targets[3]);
  const expected = [targets[3], targets[2], targets[1]];
  assert.deepEqual(
    (await first.list()).map(entry => entry.path),
    expected,
  );
  assert.deepEqual(
    (await second.list()).map(entry => entry.path),
    expected,
  );
  assert.deepEqual(
    JSON.parse(await readFile(filename, 'utf8')).map(entry => entry.path),
    expected,
  );
});

test('independent app histories lock simultaneous mutations without dropping targets', async t => {
  const { root, filename } = await fixture(t);
  const histories = [new RecentTargets(filename), new RecentTargets(filename)];
  const targets = Array.from({ length: 6 }, (_, index) => path.join(root, `target-${index}`));
  await Promise.all(targets.map(target => mkdir(target)));
  await Promise.all(targets.map((target, index) => histories[index % 2].record(target)));
  for (const history of histories)
    assert.deepEqual(
      (await history.list())
        .map(entry => entry.path)
        .sort((left, right) => left.localeCompare(right)),
      [...targets].sort((left, right) => left.localeCompare(right)),
    );
  assert.deepEqual(await readdir(path.dirname(filename)), ['recent-targets.json']);
});

test('uncommitted in-memory records survive refresh and merge after lock contention', async t => {
  const { root, filename } = await fixture(t);
  const first = new RecentTargets(filename);
  const second = new RecentTargets(filename);
  const targets = Array.from({ length: 4 }, (_, index) => path.join(root, `target-${index}`));
  await Promise.all(targets.map(target => mkdir(target)));
  await first.record(targets[0]);
  await writeFile(`${filename}.lock`, 'another app owns this lock');
  await first.record(targets[1]);
  assert.equal(
    (await first.list()).some(entry => entry.path === targets[1]),
    true,
  );
  assert.equal(
    (await second.list()).some(entry => entry.path === targets[1]),
    false,
  );
  await rm(`${filename}.lock`);
  await second.record(targets[2]);
  assert.deepEqual(
    (await first.list()).map(entry => entry.path),
    [targets[2], targets[1], targets[0]],
  );
  await first.record(targets[3]);
  assert.deepEqual(
    (await second.list()).map(entry => entry.path),
    [targets[3], targets[2], targets[1], targets[0]],
  );
});

test('stale locks left by an interrupted app do not prevent later persistence', async t => {
  const { root, filename } = await fixture(t);
  const target = path.join(root, 'target');
  await mkdir(target);
  await mkdir(path.dirname(filename));
  await writeFile(`${filename}.lock`, 'interrupted writer');
  const old = new Date(Date.now() - 60_000);
  await utimes(`${filename}.lock`, old, old);
  await new RecentTargets(filename).record(target);
  assert.equal((await new RecentTargets(filename).list())[0].path, target);
  assert.deepEqual(await readdir(path.dirname(filename)), ['recent-targets.json']);
});

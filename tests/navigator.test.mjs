import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import {
  buildNavigationTree,
  flattenNavigationTree,
  navigationStatus,
} from '../renderer/navigator.js';

const file = (path, values = {}) => ({
  path,
  index: ' ',
  worktree: ' ',
  conflicted: false,
  submodule: false,
  ...values,
});
const paths = rows => rows.map(({ node }) => node.path);

test('explorer builds naturally sorted folders and exposes only expanded descendants', () => {
  const tree = buildNavigationTree([
    file('src/file10.rs'),
    file('README.md'),
    file('src/file2.rs'),
    file('src/deep/nested.rs'),
    file('docs/index.md'),
  ]);
  assert.equal(tree.files.size, 5);
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']))), [
    '',
    'docs',
    'src',
    'README.md',
  ]);
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['', 'src']))), [
    '',
    'docs',
    'src',
    'src/deep',
    'src/file2.rs',
    'src/file10.rs',
    'README.md',
  ]);
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set())), ['']);
});

test('scoped explorer retains repository-relative file paths and filters siblings', () => {
  const tree = buildNavigationTree(
    [
      file('src/view/app.ts'),
      file('src/view/deep/model.ts'),
      file('src/outside.ts'),
      file('src/viewer/wrong.ts'),
    ],
    'src/view',
  );
  assert.equal(tree.root.path, 'src/view');
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['src/view']))), [
    'src/view',
    'src/view/deep',
    'src/view/app.ts',
  ]);
  assert.equal(tree.files.size, 2);
  assert.equal(tree.files.get('src/view/app.ts').file.path, 'src/view/app.ts');
});

test('search reaches collapsed descendants without mounting or expanding their folders', () => {
  const tree = buildNavigationTree([
    file('src/deep/Hello.swift'),
    file('src/deep/world.swift'),
    file('docs/hello.md'),
  ]);
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']), 'HELLO')), [
    'docs/hello.md',
    'src/deep/Hello.swift',
  ]);
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']), 'src/deep')), [
    'src/deep/Hello.swift',
    'src/deep/world.swift',
    'src/deep',
  ]);
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']), 'missing')), []);
});

test('file-to-directory replacement preserves both the deleted index path and new descendants', () => {
  const tree = buildNavigationTree([
    file('pkg', { worktree: 'D' }),
    file('pkg/main.ex', { worktree: '?' }),
    file('pkg/main.ex'),
  ]);
  assert.equal(tree.files.size, 2);
  assert.equal(tree.nodes.get('dir:pkg').kind, 'directory');
  assert.equal(tree.nodes.get('file:pkg').file.worktree, 'D');
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['', 'pkg']))), [
    '',
    'pkg',
    'pkg/main.ex',
    'pkg',
  ]);
});

test('large collapsed inventories do not enter the visible projection', () => {
  const inventory = Array.from({ length: 50_000 }, (_, index) =>
    file(`src/package${index % 100}/file${index}.py`),
  );
  const tree = buildNavigationTree(inventory);
  assert.equal(tree.files.size, 50_000);
  assert.equal(flattenNavigationTree(tree, new Set([''])).length, 2);
  assert.equal(flattenNavigationTree(tree, new Set(['', 'src'])).length, 102);
});

test('Git badges prioritize conflicts, then working changes, then index changes', () => {
  assert.equal(navigationStatus(file('a')), '');
  assert.equal(navigationStatus(file('a', { index: '.', worktree: '.' })), '');
  assert.equal(navigationStatus(file('a', { index: 'M' })), 'M');
  assert.equal(navigationStatus(file('a', { index: 'A', worktree: 'D' })), 'D');
  assert.equal(navigationStatus(file('a', { worktree: '?' })), 'U');
  assert.equal(navigationStatus(file('a', { index: 'A', worktree: 'M', conflicted: true })), '!');
});

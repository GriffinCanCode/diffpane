import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { buildNavigationTree, flattenNavigationTree } from '../renderer/navigator.js';
import { applyNavigationDelta, reconcileNavigationTree } from '../renderer/navigation-reconcile.ts';

const inventory = paths => paths.map(path => ({ path, submodule: false }));
const projection = tree =>
  flattenNavigationTree(
    tree,
    new Set(
      [...tree.nodes.values()].filter(node => node.kind === 'directory').map(node => node.path),
    ),
  ).map(({ node, depth }) => ({ path: node.path, kind: node.kind, depth }));

test('reorganization retains unchanged nodes and matches a fresh naturally sorted tree', () => {
  const tree = buildNavigationTree(
    inventory(['src/file10.ts', 'src/file2.ts', 'old/deep/a.ts', 'old/deep/b.ts', 'stay.ts']),
  );
  const stable = tree.files.get('stay.ts');
  const folder = tree.nodes.get('dir:src');
  flattenNavigationTree(tree, new Set(), 'old');
  const next = inventory([
    'src/file2.ts',
    'src/file10.ts',
    'src/file1.ts',
    'new/deep/a.ts',
    'stay.ts',
    'src/file1.ts',
  ]);
  assert.equal(reconcileNavigationTree(tree, next), tree);
  assert.equal(tree.files.get('stay.ts'), stable);
  assert.equal(tree.nodes.get('dir:src'), folder);
  assert.equal(tree.searchFiles, undefined);
  assert.ok(!tree.nodes.has('dir:old'));
  assert.ok(!tree.nodes.has('dir:old/deep'));
  assert.deepEqual(projection(tree), projection(buildNavigationTree(next)));
  assert.deepEqual(
    flattenNavigationTree(tree, new Set(), 'new').map(row => row.node.path),
    ['new/deep/a.ts'],
  );
});

test('scopes, file/folder replacement, empty catalogs and submodule metadata reconcile correctly', () => {
  const tree = buildNavigationTree(inventory(['scope/item', 'scope/stay', 'outside.ts']), 'scope');
  for (const next of [
    [
      { path: 'scope/item/nested', submodule: false },
      { path: 'scope/stay', submodule: true },
      { path: 'outside.ts' },
    ],
    inventory(['scope/item', 'scope/stay', 'scope/stay']),
    [],
  ]) {
    reconcileNavigationTree(tree, next, 'scope');
    assert.deepEqual(projection(tree), projection(buildNavigationTree(next, 'scope')));
    for (const file of next.filter(file => file.path.startsWith('scope/')))
      assert.equal(tree.files.get(file.path).file.submodule, file.submodule);
  }
  assert.equal(tree.nodes.size, 1);
  assert.equal(reconcileNavigationTree(tree, [], 'different'), null);
});

test('incremental deltas preserve node identity across bulk folder moves and prune old parents', () => {
  const names = Array.from({ length: 5000 }, (_, index) => `old/deep/file${index}.txt`);
  const tree = buildNavigationTree(inventory(['stay.ts', ...names]));
  const stable = tree.files.get('stay.ts');
  const moved = inventory(names.map(name => name.replace('old/', 'new/')));
  applyNavigationDelta(tree, moved, names);
  assert.equal(tree.files.get('stay.ts'), stable);
  assert.ok(!tree.nodes.has('dir:old'));
  applyNavigationDelta(tree, [{ path: 'stay.ts', submodule: true }], ['stay.ts']);
  assert.deepEqual(
    projection(tree),
    projection(buildNavigationTree([{ path: 'stay.ts' }, ...moved])),
  );
  applyNavigationDelta(
    tree,
    [{ path: 'new', submodule: true }],
    moved.map(file => file.path),
  );
  assert.deepEqual(
    projection(tree),
    projection(buildNavigationTree([{ path: 'stay.ts' }, { path: 'new' }])),
  );
});

import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { searchFiles } from '../renderer/file-search.ts';

const files = [
  'docs/main.ts/guide.md',
  'src/domain.ts',
  'src/main.ts',
  'src/MainView.tsx',
  'lib/file-search.js',
  'src/😀Résumé.ts',
].map(path => ({ path }));

test('file search ranks names ahead of directories and exact names ahead of partial matches', () => {
  const matches = searchFiles(files, 'main.ts');
  assert.equal(matches[0].file.path, 'src/main.ts');
  assert.equal(matches.at(-1).file.path, 'docs/main.ts/guide.md');
  assert.equal(searchFiles(files, 'main')[0].file.path, 'src/main.ts');
});

test('file search supports abbreviations, multiple terms, case, and Unicode highlight positions', () => {
  assert.equal(searchFiles(files, 'fsejs')[0].file.path, 'lib/file-search.js');
  assert.equal(searchFiles(files, 'SRC MAIN.ts')[0].file.path, 'src/main.ts');
  const match = searchFiles(files, 'résumé')[0];
  assert.equal(match.file.path, 'src/😀Résumé.ts');
  assert.equal(match.positions.map(index => Array.from(match.file.path)[index]).join(''), 'Résumé');
});

test('empty and missing queries remain predictable and inventory is never mutated', () => {
  assert.deepEqual(
    searchFiles(files, '  ').map(result => result.file),
    files,
  );
  assert.deepEqual(searchFiles(files, 'not-present'), []);
  assert.equal(files[0].path, 'docs/main.ts/guide.md');
});

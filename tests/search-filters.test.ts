import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { emptyFilters, matchesFilters, searchableEntries } from '../renderer/search-filters.ts';
import { searchFiles } from '../renderer/file-search.ts';

test('folder search includes unique folders as selectable results', () => {
  const entries = searchableEntries([
    { path: 'src/deep/main.ts' },
    { path: 'src/deep/helper.py' },
    { path: 'docs/guide.md' },
    { path: 'empty', directory: true },
  ]);
  assert.deepEqual(
    entries
      .filter(entry => entry.directory)
      .map(entry => entry.path)
      .sort(),
    ['docs', 'empty', 'src', 'src/deep'],
  );
  assert.ok(
    searchFiles(entries, 'deep').some(hit => hit.file.path === 'src/deep' && hit.file.directory),
  );
});

test('kind, language, extension and folder filters combine at folder boundaries', () => {
  const entries = searchableEntries([
    { path: 'src/main.ts' },
    { path: 'src/deep/helper.py' },
    { path: 'src-other/other.ts' },
    { path: 'README' },
  ]);
  const languageFor = (path: string) => (path.endsWith('.ts') ? 'TypeScript' : 'Plain text');
  const filter = (values: Partial<ReturnType<typeof emptyFilters>>) =>
    entries
      .filter(entry => matchesFilters(entry, { ...emptyFilters(), ...values }, languageFor))
      .map(entry => entry.path);
  assert.deepEqual(filter({ kind: 'folders' }).sort(), ['src', 'src-other', 'src/deep']);
  assert.deepEqual(filter({ language: 'TypeScript', extension: '.ts', folder: 'src/' }), [
    'src/main.ts',
  ]);
  assert.deepEqual(filter({ kind: 'folders', language: 'TypeScript' }), []);
  assert.deepEqual(filter({ extension: '(no extension)' }), ['README']);
  assert.deepEqual(filter({ folder: './SRC/deep/' }).sort(), ['src/deep', 'src/deep/helper.py']);
});

test('scoped folder search excludes ancestors and siblings outside the open project', () => {
  const entries = searchableEntries(
    [{ path: 'src/view/deep/main.ts' }, { path: 'src/sibling.ts' }],
    'src/view',
  );
  assert.deepEqual(entries.map(entry => entry.path).sort(), [
    'src/view/deep',
    'src/view/deep/main.ts',
  ]);
});

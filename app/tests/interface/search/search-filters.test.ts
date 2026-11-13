import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { searchFiles } from '../../../renderer/explorer/file-picker/file-search.ts'
import {
  emptyFilters,
  matchesFilters,
  searchableEntries,
} from '../../../renderer/explorer/project-search/search-filters.ts'

test('folder search includes unique folders as selectable results', () => {
  const entries = searchableEntries([
    { path: 'src/deep/main.ts' },
    { path: 'src/deep/helper.py' },
    { path: 'docs/guide.md' },
    { path: 'empty', directory: true },
  ])
  assert.deepEqual(
    entries
      .filter(entry => entry.directory)
      .map(entry => entry.path)
      .toSorted(),
    ['docs', 'empty', 'src', 'src/deep'],
  )
  assert.ok(searchFiles(entries, 'deep').some(hit => hit.file.path === 'src/deep' && hit.file.directory))
})

function languageFor(path: string) {
  return path.endsWith('.ts') ? 'TypeScript' : 'Plain text'
}

test('kind, language, extension and folder filters combine at folder boundaries', () => {
  const entries = searchableEntries([
    { path: 'src/main.ts' },
    { path: 'src/deep/helper.py' },
    { path: 'src-other/other.ts' },
    { path: 'README' },
  ])
  const filter = (values: Partial<ReturnType<typeof emptyFilters>>) =>
    entries
      .filter(entry => matchesFilters(entry, { ...emptyFilters(), ...values }, languageFor))
      .map(entry => entry.path)
  assert.deepEqual(filter({ kind: 'folders' }).toSorted(), ['src', 'src-other', 'src/deep'])
  assert.deepEqual(filter({ language: 'TypeScript', extension: '.ts', folder: 'src/' }), ['src/main.ts'])
  assert.deepEqual(filter({ kind: 'folders', language: 'TypeScript' }), [])
  assert.deepEqual(filter({ extension: '(no extension)' }), ['README'])
  assert.deepEqual(filter({ folder: './SRC/deep/' }).toSorted(), ['src/deep', 'src/deep/helper.py'])
})

test('scoped folder search excludes ancestors and siblings outside the open project', () => {
  const entries = searchableEntries([{ path: 'src/view/deep/main.ts' }, { path: 'src/sibling.ts' }], 'src/view')
  assert.deepEqual(entries.map(entry => entry.path).toSorted(), ['src/view/deep', 'src/view/deep/main.ts'])
})

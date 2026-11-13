import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'
import { searchRepositoryContent } from '../../../electron/workspace/repository/content-search.mjs'
import { Repository } from '../../../electron/workspace/repository/repository.mjs'

test('searches scoped working text with literal queries and editor-compatible positions', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-content-search-')))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'repository')
  const scope = path.join(root, '[feature]')
  await mkdir(scope, { recursive: true })
  /** @param {...string} args */
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  /** @param {string} filename @param {string | Buffer} content */
  const write = (filename, content) => writeFile(path.join(scope, filename), content)
  const query = ' Écho[1] '
  const unusualPath = 'utf8\npath.txt'
  await mkdir(path.join(scope, 'redirected'))
  await Promise.all([
    write('.gitignore', 'ignored.txt\n'),
    write(unusualPath, `\uFEFF🙂 Écho[1] ${'a'.repeat(140)}\r\nplain\rlast Écho[1] end`),
    write('utf16.txt', Buffer.from(`\uFEFF🙂 écho[1] end`, 'utf16le')),
    write('binary.txt', Buffer.from(`\0${query}\0`)),
    write('image.svg', `<svg><title>${query}</title></svg>`),
    write('deleted.txt', query),
    write('tracked.txt', query),
    write('staged-delete.txt', query),
    write('redirected/child.txt', 'inside'),
    writeFile(path.join(root, 'outside-scope.txt'), query),
    writeFile(path.join(directory, 'outside-repository.txt'), query),
  ])
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline')
  git('rm', '--cached', '[feature]/staged-delete.txt')
  await rm(path.join(scope, 'redirected'), { recursive: true })
  await mkdir(path.join(directory, 'redirected'))
  await writeFile(path.join(directory, 'redirected', 'child.txt'), query)
  await Promise.all([
    write('tracked.txt', 'changed without a match'),
    write('.gitignore', 'ignored.txt\nstaged-delete.txt\n'),
    write('windows.txt', Buffer.from('x Écho[1] end', 'latin1')),
    write('ignored.txt', query),
    rm(path.join(scope, 'deleted.txt')),
    symlink(path.join(directory, 'outside-repository.txt'), path.join(scope, 'file-link.txt')),
    symlink(path.dirname(scope), path.join(scope, 'directory-link'), 'dir'),
    symlink(path.join(directory, 'redirected'), path.join(scope, 'redirected'), 'dir'),
  ])
  const repository = await Repository.open(scope)
  /** @param {'workspace' | 'changed'} searchScope */
  const search = async (searchScope, matchCase = false) => {
    const result = await searchRepositoryContent(
      repository,
      { query, scope: searchScope, matchCase },
      new AbortController().signal,
    )
    assert.ok(result, 'Uncancelled search should produce a result')
    return result
  }
  const workspace = await search('workspace')
  assert.equal(workspace.truncated, false)
  assert.deepEqual(
    workspace.matches.map(({ path: filename, line, column, match, length }) => [filename, line, column, match, length]),
    [
      ['[feature]/utf16.txt', 1, 3, ' écho[1] ', 9],
      [`[feature]/${unusualPath}`, 1, 3, query, 9],
      [`[feature]/${unusualPath}`, 3, 5, query, 9],
      ['[feature]/windows.txt', 1, 2, query, 9],
    ],
  )
  const firstUtf8 = workspace.matches.find(hit => hit.path.endsWith(unusualPath))
  assert.ok(firstUtf8)
  assert.equal(firstUtf8.before, '🙂')
  assert.equal(firstUtf8.after, `${'a'.repeat(119)}…`)
  assert.equal((await search('workspace', true)).matches.length, 3)
  assert.deepEqual(
    (await search('changed')).matches.map(hit => hit.path),
    ['[feature]/windows.txt'],
  )
})

test('bounds matching lines and cancels an in-flight scan', async () => {
  const request = { query: 'a', scope: 'workspace', matchCase: true }
  const repository = {
    contentSearchPaths: async () => ({ paths: ['one.txt'], truncated: false }),
    contentSearchFile: async () => ({ text: 'a a\n'.repeat(251), bytes: 1004 }),
  }
  const signal = new AbortController().signal
  const result = await searchRepositoryContent(repository, request, signal)
  assert.ok(result)
  assert.equal(result.matches.length, 250)
  assert.equal(result.matches.at(-1)?.line, 250)
  assert.equal(result.truncated, true)

  const cancellation = new AbortController()
  const pending = searchRepositoryContent(
    {
      contentSearchPaths: (_changed, active) =>
        new Promise((_resolve, reject) => {
          active.addEventListener('abort', () => reject(new Error('Search aborted')), { once: true })
        }),
      contentSearchFile: async () => {
        throw new Error('A cancelled inventory should never start a file read')
      },
    },
    request,
    cancellation.signal,
  )
  cancellation.abort()
  assert.equal(await pending, null)
})

test('counts mixed line endings and uses only the first Unicode match per line', async () => {
  const result = await searchRepositoryContent(
    {
      contentSearchPaths: async () => ({ paths: ['miss.txt', 'hits.txt'], truncated: false }),
      contentSearchFile: async filename => ({
        text: filename === 'miss.txt' ? '\uFEFFplain\r\n' : '\uFEFF\r\n\r\n🙂K k\rk\n\nmiss\r\nlast K',
        bytes: 64,
      }),
    },
    { query: 'k', scope: 'workspace', matchCase: false },
    new AbortController().signal,
  )
  assert.ok(result)
  assert.deepEqual(
    result.matches.map(({ line, column, match }) => [line, column, match]),
    [
      [3, 3, 'K'],
      [4, 1, 'k'],
      [7, 6, 'K'],
    ],
  )
})

test('a cancelled search cannot complete successfully with an empty inventory', async () => {
  const cancellation = new AbortController()
  /** @type {PromiseWithResolvers<{ paths: string[]; truncated: boolean }>} */
  const inventory = Promise.withResolvers()
  const repository = {
    contentSearchPaths: () => inventory.promise,
    contentSearchFile: async () => {
      throw new Error('An empty inventory should never start a file read')
    },
  }
  const request = { query: 'a', scope: 'workspace', matchCase: true }
  const pending = searchRepositoryContent(repository, request, cancellation.signal)
  cancellation.abort()
  inventory.resolve({ paths: [], truncated: false })
  assert.equal(await pending, null)
})

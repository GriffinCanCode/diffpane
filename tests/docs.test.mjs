import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vite-plus/test'
import { parse } from 'yaml'

/** @returns {Promise<string[]>} */
async function documents(directory = '.') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name.startsWith('.') ||
      ['node_modules', 'dist', 'release', 'target', 'test-results'].includes(entry.name)
    )
      continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Traverse directories serially to bound concurrent filesystem operations.
      result.push(...(await documents(file)))
    } else if (entry.name.endsWith('.md')) result.push(file)
  }
  return result
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} file */
async function checkDocument(file) {
  const text = await readFile(file, 'utf8')
  assert.ok(text.startsWith('---\n'), `${file}: missing doc radar frontmatter`)
  const end = text.indexOf('\n---', 4)
  assert.ok(end > 0, `${file}: invalid frontmatter`)
  /** @type {unknown} */
  const metadata = parse(text.slice(4, end))
  assert.ok(isRecord(metadata) && isRecord(metadata.doc_radar), `${file}: missing doc radar metadata`)
  const { sentinels } = metadata.doc_radar
  assert.ok(Array.isArray(sentinels), `${file}: invalid doc radar sentinels`)
  for (const sentinel of sentinels) {
    assert.ok(isRecord(sentinel) && typeof sentinel.file === 'string', `${file}: invalid doc radar sentinel`)
    const { file: sourceFile, contains } = sentinel
    assert.ok(
      Array.isArray(contains) && contains.every((/** @type {unknown} */ claim) => typeof claim === 'string'),
      `${file}: invalid claims for ${sourceFile}`,
    )
    // oxlint-disable-next-line eslint/no-await-in-loop -- Read one sentinel source at a time.
    const source = await readFile(sourceFile, 'utf8')
    for (const claim of contains)
      assert.ok(source.includes(claim), `${file}: ${sourceFile} no longer contains ${claim}`)
  }
}

test('documentation source assertions remain true', async () => {
  const files = await documents()
  assert.ok(files.length > 0, 'Expected to find repository documentation')
  for (const file of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Keep document validation and its file handles serial.
    await checkDocument(file)
  }
})

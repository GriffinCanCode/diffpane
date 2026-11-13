import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { decorations } from '../../../electron/workspace/comparison/changes.ts'

test('decorations address changed lines without character-level differences', () => {
  const result = decorations('const value = "😀 before";\nold();\n', 'const value = "😀 after";\nnew();\nadded();\n')
  assert.equal(result.additions, 3)
  assert.equal(result.deletions, 2)
  assert.ok(result.decorations.some(decoration => decoration.kind === 'modified'))
  for (const decoration of result.decorations) {
    assert.ok(decoration.startLine >= 1 && decoration.endLine <= 3)
    assert.notEqual(decoration.kind, 'word')
  }
})
test('pure removals use a current-line marker without original content', () => {
  const result = decorations('one\nremoved\nthree\n', 'one\nthree\n')
  assert.deepEqual(result.decorations, [{ startLine: 2, endLine: 2, kind: 'deleted' }])
  assert.equal(result.deletions, 1)
})
test('CRLF alone does not repaint lines', () => {
  assert.deepEqual(decorations('one\r\ntwo\r\n', 'one\ntwo\n').decorations, [])
})

test('one-sided changes mark every actual line and anchor the empty side', () => {
  const text = '\r\nlast line\r\n'
  assert.deepEqual(decorations('', text), {
    decorations: [{ startLine: 1, endLine: 2, kind: 'added' }],
    beforeDecorations: [{ startLine: 1, endLine: 1, kind: 'added' }],
    additions: 2,
    deletions: 0,
  })
  assert.deepEqual(decorations(text, ''), {
    decorations: [{ startLine: 1, endLine: 1, kind: 'deleted' }],
    beforeDecorations: [{ startLine: 1, endLine: 2, kind: 'deleted' }],
    additions: 0,
    deletions: 2,
  })
})

test('a skipped common prefix preserves the EOF insertion anchors on both versions', () => {
  const before = 'one\ntwo\r\n'.repeat(1_000)
  const result = decorations(before, `${before}extra\n`)
  assert.deepEqual(result.decorations, [{ startLine: 2_001, endLine: 2_001, kind: 'added' }])
  assert.deepEqual(result.beforeDecorations, [{ startLine: 2_001, endLine: 2_001, kind: 'added' }])
})

test('unequal replacements distinguish edited, inserted, and deleted lines', () => {
  const more = decorations('old\nanchor\n', 'new\nextra\nanchor\n').decorations
  assert.deepEqual(more, [
    { startLine: 1, endLine: 1, kind: 'modified' },
    { startLine: 2, endLine: 2, kind: 'added' },
  ])
  const fewer = decorations('old\nextra\nanchor\n', 'new\nanchor\n').decorations
  assert.deepEqual(fewer, [
    { startLine: 1, endLine: 1, kind: 'modified' },
    { startLine: 2, endLine: 2, kind: 'deleted' },
  ])
})

test('both sides retain line markers for replacements, insertions and deletions', () => {
  const result = decorations(
    'function changed() {\n  old();\n}\n',
    'function changed() {\n  current();\n  extra();\n}\n',
  )
  assert.deepEqual(result.beforeDecorations, [
    { startLine: 2, endLine: 2, kind: 'modified' },
    { startLine: 3, endLine: 3, kind: 'added' },
  ])
  assert.deepEqual(result.decorations, [
    { startLine: 2, endLine: 2, kind: 'modified' },
    { startLine: 3, endLine: 3, kind: 'added' },
  ])
})

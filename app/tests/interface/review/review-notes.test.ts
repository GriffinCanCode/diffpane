import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import {
  captureReviewLines,
  formatReviewHandoff,
  locateReviewLines,
  MAX_REVIEW_EXCERPT_LENGTH,
  MAX_REVIEW_EXCERPT_LINES,
} from '../../../shared/review/review-notes.ts'
import type { ReviewAnchor } from '../../../shared/review/review-notes.ts'

function source(lines: string[]) {
  return {
    getLineCount: () => lines.length,
    getLineContent: (line: number) => {
      const content = lines[line - 1]
      assert.notEqual(content, undefined)
      assert.ok(content !== undefined)
      return content
    },
  }
}

const anchor: ReviewAnchor = {
  path: 'src/file.js',
  side: 'working',
  line: 2,
  endLine: 3,
  excerpt: 'const x = 1;\nreturn x;',
  truncated: false,
}

test('notes relocate only when captured lines match a unique new location', () => {
  const first = 'const x = 1;'
  const second = 'return x;'
  assert.deepEqual(locateReviewLines(source(['header', first, second]), anchor), {
    line: 2,
    endLine: 3,
    state: 'original',
  })
  assert.deepEqual(locateReviewLines(source(['new', 'header', first, second]), anchor), {
    line: 3,
    endLine: 4,
    state: 'moved',
  })
  assert.deepEqual(locateReviewLines(source([first, second, first, second]), anchor), {
    line: 2,
    endLine: 2,
    state: 'stale',
  })
  assert.deepEqual(locateReviewLines(source(['shortened']), anchor), {
    line: 1,
    endLine: 1,
    state: 'stale',
  })
})

test('captured excerpts respect line and character bounds', () => {
  const lines = Array.from({ length: MAX_REVIEW_EXCERPT_LINES + 1 }, () => 'line')
  const capture = captureReviewLines(source(lines), 1, lines.length)
  assert.equal(capture.excerpt.split('\n').length, MAX_REVIEW_EXCERPT_LINES)
  assert.equal(capture.truncated, true)
  const prefix = 'x'.repeat(MAX_REVIEW_EXCERPT_LENGTH - 1)
  assert.deepEqual(captureReviewLines(source([`${prefix}🐾`]), 1, 1), {
    excerpt: prefix,
    truncated: true,
  })
})

test('handoff copies open notes with safe Markdown and captured source references', () => {
  const handoff = formatReviewHandoff([
    {
      id: 'a',
      anchor: null,
      text: 'Check the API.\n\nKeep this as part of the note.',
      resolved: false,
    },
    {
      id: 'b',
      anchor: {
        ...anchor,
        originalPath: 'old/`file\n.js',
        side: 'head',
        excerpt: '```js\ncode',
        truncated: true,
      },
      text: 'Restore this behavior.',
      resolved: false,
    },
    { id: 'c', anchor, text: 'Resolved text', resolved: true },
  ])
  assert.equal(handoff.count, 2)
  assert.equal(
    handoff.text,
    '# Review handoff\n\n## Project\n\n> Check the API.\n> \n> Keep this as part of the note.\n\n' +
      '## ``old/`file\\n.js:2-3`` · HEAD → `src/file.js`\n\n> Restore this behavior.\n\n' +
      'Captured excerpt (truncated)\n\n````\n```js\ncode\n````\n',
  )
  assert.deepEqual(formatReviewHandoff([]), { count: 0, text: '' })
})

import Diff from 'diff/lib/diff/base.js'
import { countLines } from '../../../shared/documents/text-lines.ts'

export interface LineDecoration {
  startLine: number
  endLine: number
  kind: 'added' | 'modified' | 'deleted'
}

/** Line markers on both versions. Character-level diffs are deliberately never computed. */
export interface DiffDecorations {
  decorations: LineDecoration[]
  beforeDecorations: LineDecoration[]
  additions: number | null
  deletions: number | null
  diffNote?: string
}

const DIFF_TIMEOUT_MS = 150
const MAX_DECORATIONS = 10_000
const MAX_INLINE_LENGTH = 8_192
const MAX_INLINE_EDITS = 32
const INLINE_TIMEOUT_MS = 4
const PREFIX_BLOCK_LENGTH = 4_096

/** Reuse the Myers alignment while keeping only the line counts in each change. */
class LineCountsDiff extends Diff<string, string[]> {
  override tokenize(lines: string[]): string[] {
    return lines
  }

  override removeEmpty(lines: string[]): string[] {
    return lines
  }

  override join(): string[] {
    return []
  }
}

const lineCountsDiff = new LineCountsDiff()

function lineTokens(text: string, start: number): string[] {
  const lines: string[] = []
  for (let end = text.indexOf('\n', start); end !== -1; end = text.indexOf('\n', start)) {
    lines.push(text.charCodeAt(end - 1) === 13 ? `${text.slice(start, end - 1)}\n` : text.slice(start, end + 1))
    start = end + 1
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

export function unchangedDecorations(): DiffDecorations {
  return { decorations: [], beforeDecorations: [], additions: 0, deletions: 0 }
}

function emptySide(before: string, after: string): DiffDecorations | undefined {
  if (!before) {
    const additions = countLines(after) - Number(after.endsWith('\n'))
    return {
      decorations: [{ startLine: 1, endLine: additions, kind: 'added' }],
      beforeDecorations: [{ startLine: 1, endLine: 1, kind: 'added' }],
      additions,
      deletions: 0,
    }
  }
  if (!after) {
    const deletions = countLines(before) - Number(before.endsWith('\n'))
    return {
      decorations: [{ startLine: 1, endLine: 1, kind: 'deleted' }],
      beforeDecorations: [{ startLine: 1, endLine: deletions, kind: 'deleted' }],
      additions: 0,
      deletions,
    }
  }
  return undefined
}

function coarse(maxLine: number, beforeMaxLine: number, note: string): DiffDecorations {
  return {
    decorations: [{ startLine: 1, endLine: maxLine, kind: 'modified' }],
    beforeDecorations: [{ startLine: 1, endLine: beforeMaxLine, kind: 'modified' }],
    additions: null,
    deletions: null,
    diffNote: note,
  }
}

function commonPrefixEnd(before: string, after: string) {
  const length = Math.min(before.length, after.length)
  let offset = 0
  // Myers always starts with the common prefix. Skip complete identical lines without tokenizing them.
  for (let end = PREFIX_BLOCK_LENGTH; end <= length; end += PREFIX_BLOCK_LENGTH) {
    if (before.slice(offset, end) !== after.slice(offset, end)) break
    offset = end
  }
  return offset ? before.lastIndexOf('\n', offset - 1) + 1 : 0
}

function compare(before: string, after: string, maxEditLength?: number): DiffDecorations | undefined {
  const offset = commonPrefixEnd(before, after)
  const firstLine = offset ? countLines(before.slice(0, offset)) : 1
  const beforeLines = lineTokens(before, offset)
  const afterLines = lineTokens(after, offset)
  const segments = lineCountsDiff.diff(beforeLines, afterLines, {
    timeout: maxEditLength === undefined ? DIFF_TIMEOUT_MS : INLINE_TIMEOUT_MS,
    maxEditLength,
  })
  if (!segments) return undefined

  const maxLine = firstLine + afterLines.length - Number(!after.endsWith('\n'))
  const beforeMaxLine = firstLine + beforeLines.length - Number(!before.endsWith('\n'))
  let line = firstLine
  let originalLine = firstLine
  let removed = 0
  let additions = 0
  let deletions = 0
  const output: LineDecoration[] = []
  const original: LineDecoration[] = []
  const range = (list: LineDecoration[], startLine: number, count: number, kind: LineDecoration['kind']) => {
    if (count) list.push({ startLine, endLine: startLine + count - 1, kind })
  }
  const deletion = () => range(output, Math.min(line, maxLine), 1, 'deleted')
  for (const [index, segment] of segments.entries()) {
    if (output.length + original.length > MAX_DECORATIONS)
      return coarse(maxLine, beforeMaxLine, 'Detailed change highlighting exceeded its decoration budget.')
    if (segment.removed) {
      deletions += segment.count
      removed = segment.count
      const next = segments[index + 1]
      const replaced = Math.min(removed, next?.added ? next.count : 0)
      range(original, originalLine, replaced, 'modified')
      range(original, originalLine + replaced, removed - replaced, 'deleted')
      originalLine += removed
    } else if (segment.added) {
      additions += segment.count
      const replaced = Math.min(removed, segment.count)
      range(output, line, replaced, 'modified')
      range(output, line + replaced, segment.count - replaced, 'added')
      if (segment.count > replaced) range(original, Math.min(originalLine, beforeMaxLine), 1, 'added')
      line += segment.count
      if (removed > replaced) deletion()
      removed = 0
    } else {
      if (removed) deletion()
      removed = 0
      line += segment.count
      originalLine += segment.count
    }
  }
  if (removed) deletion()
  return { decorations: output, beforeDecorations: original, additions, deletions }
}

export function decorations(before: string, after: string): DiffDecorations {
  if (before === after) return unchangedDecorations()
  return (
    emptySide(before, after) ??
    compare(before, after) ??
    coarse(countLines(after), countLines(before), 'Detailed change highlighting exceeded its time budget.')
  )
}

/** Tiny edits fit within both bounds and can stay in the workspace worker. */
export function smallDecorations(before: string, after: string): DiffDecorations | undefined {
  if (before.length + after.length > MAX_INLINE_LENGTH) return undefined
  return emptySide(before, after) ?? compare(before, after, MAX_INLINE_EDITS)
}

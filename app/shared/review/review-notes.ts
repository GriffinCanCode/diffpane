export interface ReviewAnchor {
  path: string
  originalPath?: string
  side: 'working' | 'head'
  line: number | null
  endLine: number | null
  excerpt: string
  truncated: boolean
}

export interface ReviewNote {
  id: string
  anchor: ReviewAnchor | null
  text: string
  resolved: boolean
}

export type ReviewNoteChange =
  | { type: 'add'; anchor: ReviewAnchor | null; text: string }
  | { type: 'edit'; id: string; text: string; expectedText: string }
  | { type: 'resolve'; id: string; resolved: boolean }
  | { type: 'delete'; id: string }

export const MAX_REVIEW_NOTE_LENGTH = 4000
export const MAX_REVIEW_EXCERPT_LENGTH = 2400
export const MAX_REVIEW_EXCERPT_LINES = 24

interface ReviewSource {
  getLineCount(): number
  getLineContent(line: number): string
}

export function captureReviewLines(source: ReviewSource, line: number, endLine: number) {
  let excerpt = ''
  for (let current = line; current <= endLine; current++) {
    if (current - line >= MAX_REVIEW_EXCERPT_LINES) return { excerpt, truncated: true }
    const text = `${current === line ? '' : '\n'}${source.getLineContent(current)}`
    const remaining = MAX_REVIEW_EXCERPT_LENGTH - excerpt.length
    if (text.length > remaining) {
      // Keep a surrogate pair intact if the excerpt boundary falls inside it.
      const next = text.charCodeAt(remaining)
      const end = next >= 0xdc00 && next <= 0xdfff ? Math.max(0, remaining - 1) : remaining
      return { excerpt: `${excerpt}${text.slice(0, end)}`, truncated: true }
    }
    excerpt += text
  }
  return { excerpt, truncated: false }
}

export function locateReviewLines(source: ReviewSource, anchor: ReviewAnchor) {
  if (anchor.line === null || anchor.endLine === null) return null
  const count = source.getLineCount()
  const length = anchor.endLine - anchor.line
  const lastStart = count - length
  const lines = anchor.excerpt.split('\n')
  const matchesAt = (line: number) => lines.every((text, offset) => source.getLineContent(line + offset) === text)
  if (anchor.line <= lastStart) {
    const captured = anchor.truncated ? captureReviewLines(source, anchor.line, anchor.endLine) : null
    const current = captured ? captured.truncated && captured.excerpt === anchor.excerpt : matchesAt(anchor.line)
    if (current) return { line: anchor.line, endLine: anchor.endLine, state: 'original' as const }
  }
  if (!anchor.truncated && anchor.excerpt.trim()) {
    let match = 0
    for (let line = 1; line <= lastStart; line++) {
      if (!matchesAt(line)) continue
      if (match) {
        match = 0
        break
      }
      match = line
    }
    if (match) return { line: match, endLine: match + length, state: 'moved' as const }
  }
  const line = Math.min(anchor.line, count)
  return { line, endLine: line, state: 'stale' as const }
}

function markdownCode(value: string, minimum: number) {
  let longest = 0
  for (const [run] of value.matchAll(/`+/gu)) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(minimum, longest + 1))
}

function inlinePath(filename: string, lines = '') {
  const escaped = filename.replace(/\p{Cc}/gu, character => {
    const code = character.charCodeAt(0)
    if (code < 32) return JSON.stringify(character).slice(1, -1)
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
  const location = `${escaped}${lines}`
  const delimiter = markdownCode(location, 1)
  const code = /^[` ]|[` ]$/u.test(location) ? ` ${location} ` : location
  return `${delimiter}${code}${delimiter}`
}

function handoffLocation(anchor: ReviewAnchor) {
  const start = anchor.line === null ? '' : `:${anchor.line}`
  const end = anchor.endLine === anchor.line ? '' : `-${anchor.endLine}`
  const location = inlinePath(anchor.originalPath ?? anchor.path, `${start}${end}`)
  if (anchor.side === 'working') return `${location} · Working file`
  const renamed = anchor.originalPath ? ` → ${inlinePath(anchor.path)}` : ''
  return `${location} · HEAD${renamed}`
}

export function formatReviewHandoff(notes: readonly ReviewNote[]) {
  const open = notes.filter(note => !note.resolved)
  if (!open.length) return { text: '', count: 0 }
  const sections = open.map(({ anchor, text }) => {
    const heading = anchor ? handoffLocation(anchor) : 'Project'
    const body = text
      .split(/\r\n|\r|\n/u)
      .map(line => `> ${line}`)
      .join('\n')
    if (!anchor?.excerpt) return `## ${heading}\n\n${body}`
    const fence = markdownCode(anchor.excerpt, 3)
    const excerptLabel = anchor.truncated ? 'Captured excerpt (truncated)' : 'Captured excerpt'
    return `## ${heading}\n\n${body}\n\n${excerptLabel}\n\n${fence}\n${anchor.excerpt}\n${fence}`
  })
  return { text: `# Review handoff\n\n${sections.join('\n\n')}\n`, count: open.length }
}

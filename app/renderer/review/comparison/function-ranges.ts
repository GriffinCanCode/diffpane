const CALLABLE_KINDS = new Set([5, 8, 11]) // Monaco Method, Constructor, Function.
const CONTROLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'match'])
const DECLARATION = /\b(?:function\s*\*?\s*|defp?\s+|defmacro\s+|fn\s+|func\s+|fun\s+)([\w$!?]+)/
const ASSIGNMENT = /\b(?:const|let|var)\s+([\w$]+)\s*=/
const MULTILINE_ARROW = /\b(?:const|let|var)\s+([\w$]+)\s*=.*=>/
const METHOD =
  /^\s*(?:(?:public|private|protected|static|async|override|export)\s+)*([\w$]+)\s*\([^;]*\)\s*(?::[^=]+)?\s*\{/

export interface FunctionRange {
  startLine: number
  endLine: number
  name: string
}
interface LineChange {
  startLine: number
  endLine?: number
}
interface OutlineSymbol {
  kind: number
  name: string
  range?: { startLineNumber: number; endLineNumber: number }
  children?: OutlineSymbol[]
}

function arrowName(line: string) {
  const arrow = line.lastIndexOf('=>')
  if (arrow < 0) return undefined
  const prefix = line.slice(0, arrow)
  // The scanner splits on LF. Preserve matching across files with other line separators.
  return /[\r\u2028\u2029]/.test(prefix) ? MULTILINE_ARROW.exec(line)?.[1] : ASSIGNMENT.exec(prefix)?.[1]
}

/** Prefer language-server ranges; a bounded lexical fallback also works before a server starts. */
export function changedFunctionRanges(
  text: string,
  changes: readonly LineChange[],
  symbols: readonly OutlineSymbol[] = [],
) {
  if (!changes.length) return []
  return changedSymbolRanges(changes, symbols) ?? intersectChanges(lexicalFunctions(text), changes)
}

export function changedSymbolRanges(changes: readonly LineChange[], symbols: readonly OutlineSymbol[]) {
  if (!changes.length) return []
  const functions: FunctionRange[] = []
  const visit = (items: readonly OutlineSymbol[]) => {
    for (const symbol of items) {
      if (CALLABLE_KINDS.has(symbol.kind) && symbol.range)
        functions.push({
          startLine: symbol.range.startLineNumber,
          endLine: symbol.range.endLineNumber,
          name: symbol.name,
        })
      if (symbol.children?.length) visit(symbol.children)
    }
  }
  visit(symbols)
  return functions.length ? intersectChanges(functions, changes) : undefined
}

function intersectChanges(functions: FunctionRange[], changes: readonly LineChange[]) {
  if (!functions.length) return functions
  const intervals = changes
    .map(change => ({ start: change.startLine, end: change.endLine ?? change.startLine }))
    .toSorted((a, b) => a.start - b.start)
  return functions.filter(fn => {
    // Changes are non-overlapping line ranges from the diff worker.
    let low = 0
    let high = intervals.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const interval = intervals[middle]
      if (!interval) return false
      if (interval.end < fn.startLine) low = middle + 1
      else high = middle
    }
    const interval = intervals[low]
    return interval !== undefined && interval.start <= fn.endLine
  })
}

function lexicalFunctions(text: string) {
  const lines = text.split('\n')
  const clean: Array<{ text: string; indent: number; before: number; after: number }> = []
  let depth = 0
  let quote = ''
  let block = false
  for (const line of lines) {
    let value = ''
    const before = depth
    for (let index = 0; index < line.length; index++) {
      const char = line.charAt(index)
      const next = line.charAt(index + 1)
      if (block) {
        if (char === '*' && next === '/') {
          block = false
          index++
        }
        continue
      }
      if (quote) {
        if (char === '\\') index++
        else if (line.startsWith(quote, index)) {
          index += quote.length - 1
          quote = ''
        }
        continue
      }
      if (char === '/' && next === '/') break
      if (char === '#') break
      if (char === '/' && next === '*') {
        block = true
        index++
        continue
      }
      if (['"', "'", '`'].includes(char)) {
        quote = char !== '`' && line.startsWith(char.repeat(3), index) ? char.repeat(3) : char
        index += quote.length - 1
        continue
      }
      value += char
      if (char === '{') depth++
      if (char === '}') depth--
    }
    // Ordinary quoted strings cannot continue across a physical line without an escape.
    if (quote.length === 1 && quote !== '`' && !line.endsWith('\\')) quote = ''
    clean.push({ text: value, indent: line.length - line.trimStart().length, before, after: depth })
  }
  const functions: FunctionRange[] = []
  for (const [index, { text: line, indent }] of clean.entries()) {
    const name = DECLARATION.exec(line)?.[1] ?? arrowName(line) ?? METHOD.exec(line)?.[1]
    if (!name || CONTROLS.has(name)) continue
    let end = index
    if (/\bdef\s/.test(line) && /:\s*$/.test(line)) {
      for (let next = clean[end + 1]; next && (!next.text.trim() || next.indent > indent); next = clean[end + 1]) {
        end++
      }
    } else if (/\bdef(?:p|macro)?\s/.test(line) && /\bdo\s*$/.test(line)) {
      let balance = 1
      for (let next = clean[end + 1]; next && balance > 0; next = clean[end + 1]) {
        end++
        balance += (next.text.match(/\bdo\b(?!:)/g) ?? []).length - (next.text.match(/\bend\b/g) ?? []).length
      }
    } else {
      for (let body = index; body < Math.min(lines.length, index + 12); body++) {
        const candidate = clean[body]
        if (!candidate || (body > index && (DECLARATION.test(candidate.text) || arrowName(candidate.text)))) break
        if (candidate.text.includes('{')) {
          end = body
          let current = candidate
          while (current.after > candidate.before) {
            const next = clean[end + 1]
            if (!next) break
            current = next
            end++
          }
          break
        }
        if (candidate.text.includes(';')) break
      }
    }
    functions.push({ startLine: index + 1, endLine: end + 1, name })
  }
  return functions
}

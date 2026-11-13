/** @typedef {{ line: number, character: number }} ProtocolPosition */
/** @typedef {{ start: ProtocolPosition, end: ProtocolPosition }} ProtocolRange */
/** @typedef {{ message: string, range: ProtocolRange, source?: string, severity?: number, code?: string | number, tags?: number[], relatedInformation?: unknown[] }} ProtocolDiagnostic */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
export function isArray(value) {
  return Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isCoordinate(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * @param {unknown} value
 * @returns {value is ProtocolPosition}
 */
export function isPosition(value) {
  return isRecord(value) && isCoordinate(value.line) && isCoordinate(value.character)
}

/**
 * @param {unknown} value
 * @returns {value is ProtocolRange}
 */
function isRange(value) {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end)
}

/** @param {ProtocolPosition} position */
export function toPosition(position) {
  return { lineNumber: position.line + 1, column: position.character + 1 }
}

/** @param {import('monaco-editor').IPosition} position */
export function fromPosition(position) {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

/** @param {unknown} range @param {{ validateRange: (range: import('monaco-editor').IRange) => import('monaco-editor').IRange }} [model] */
export function toRange(range, model) {
  if (!isRange(range)) return undefined
  const result = {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
  return model ? model.validateRange(result) : result
}

/** @param {import('monaco-editor').IRange} range */
export function fromRange(range) {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  }
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return isArray(value) && value.every(item => typeof item === 'string')
}

/** @param {unknown} value */
export function tokenLegend(value) {
  if (!isRecord(value) || !isStringArray(value.tokenTypes)) return undefined
  return {
    tokenTypes: value.tokenTypes,
    tokenModifiers: isStringArray(value.tokenModifiers) ? value.tokenModifiers : [],
  }
}

/** @param {unknown} content */
export function markdown(content) {
  if (typeof content === 'string') return { value: content, isTrusted: false, supportHtml: false }
  if (!isRecord(content) || typeof content.value !== 'string') return undefined
  const value = content.value
  if (typeof content.language === 'string' && /^[\w+.-]+$/u.test(content.language)) {
    // Choose a fence longer than any run in the source, so docs stay code.
    let fenceLength = 3
    for (const match of value.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1)
    const fence = '`'.repeat(fenceLength)
    return { value: `${fence}${content.language}\n${value}\n${fence}`, isTrusted: false, supportHtml: false }
  }
  return {
    value: content.kind === 'plaintext' ? value.replace(/[\\`*_{}[\]()<>#+\-.!|]/gu, '\\$&') : value,
    isTrusted: false,
    supportHtml: false,
  }
}

/**
 * @param {unknown} result
 * @param {{ validateRange: (range: import('monaco-editor').IRange) => import('monaco-editor').IRange }} model
 * @param {number} depth
 * @returns {import('monaco-editor').languages.DocumentSymbol[]}
 */
export function documentSymbols(result, model, depth = 0) {
  if (!isArray(result) || depth >= 128) return []
  return result.flatMap(symbol => {
    if (!isRecord(symbol) || typeof symbol.name !== 'string') return []
    const range = toRange(symbol.range ?? (isRecord(symbol.location) ? symbol.location.range : undefined), model)
    if (!range) return []
    return [
      {
        name: symbol.name,
        detail: typeof symbol.detail === 'string' ? symbol.detail : '',
        kind: isCoordinate(symbol.kind) ? Math.max(0, Math.min(25, symbol.kind - 1)) : 0,
        tags: isArray(symbol.tags) ? symbol.tags.filter(tag => tag === 1) : symbol.deprecated === true ? [1] : [],
        containerName: typeof symbol.containerName === 'string' ? symbol.containerName : undefined,
        range,
        selectionRange: toRange(symbol.selectionRange, model) ?? range,
        children: documentSymbols(symbol.children, model, depth + 1),
      },
    ]
  })
}

/** @param {unknown} value @returns {value is ProtocolDiagnostic} */
export function isDiagnostic(value) {
  return (
    isRecord(value) &&
    isRange(value.range) &&
    typeof value.message === 'string' &&
    (value.source === undefined || typeof value.source === 'string') &&
    (value.severity === undefined || isCoordinate(value.severity)) &&
    (value.code === undefined || typeof value.code === 'string' || typeof value.code === 'number') &&
    (value.tags === undefined || (isArray(value.tags) && value.tags.every(isCoordinate))) &&
    (value.relatedInformation === undefined || isArray(value.relatedInformation))
  )
}

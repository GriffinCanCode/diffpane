const MAX_QUERY_LENGTH = 256
const MAX_MATCHES = 250
const MAX_SCAN_BYTES = 256 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 6000
const READ_CONCURRENCY = 8

/** @typedef {{ query: string, scope: 'workspace' | 'changed', matchCase: boolean }} ContentSearchRequest */
/** @typedef {{ path: string, line: number, column: number, length: number, before: string, match: string, after: string }} ContentMatch */
/** @typedef {{ matches: ContentMatch[], truncated: boolean }} ContentSearchResult */
/**
 * @typedef {object} SearchRepository
 * @property {(changed: boolean, signal: AbortSignal) => Promise<{ paths: readonly string[], truncated: boolean }>} contentSearchPaths
 * @property {(filename: string, signal: AbortSignal) => Promise<{ bytes: number, text: string | null } | null>} contentSearchFile
 */

/**
 * @param {SearchRepository} repository
 * @param {unknown} request
 * @param {AbortSignal} cancellation
 * @returns {Promise<ContentSearchResult | null>}
 */
export async function searchRepositoryContent(repository, request, cancellation) {
  if (
    !request ||
    typeof request !== 'object' ||
    !('query' in request) ||
    !('scope' in request) ||
    !('matchCase' in request)
  )
    throw new Error('Invalid project search request.')
  const { query, scope, matchCase } = request
  if (
    typeof query !== 'string' ||
    query.length > MAX_QUERY_LENGTH ||
    /[\r\n]/u.test(query) ||
    query.includes('\0') ||
    (scope !== 'workspace' && scope !== 'changed') ||
    typeof matchCase !== 'boolean'
  )
    throw new Error('Invalid project search request.')
  if (!query) return { matches: [], truncated: false }

  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const signal = AbortSignal.any([cancellation, timeout])
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), matchCase ? 'u' : 'iu')
  /** @type {ContentMatch[]} */
  const matches = []
  let scannedBytes = 0
  try {
    const { paths, truncated } = await repository.contentSearchPaths(scope === 'changed', signal)
    for (let start = 0; start < paths.length; start += READ_CONCURRENCY) {
      signal.throwIfAborted()
      const batch = paths.slice(start, start + READ_CONCURRENCY)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Finish each bounded batch before opening another group of files.
      const files = await Promise.all(
        batch.map(async filename => ({ filename, file: await repository.contentSearchFile(filename, signal) })),
      )
      signal.throwIfAborted()
      for (const { filename, file } of files) {
        if (!file) continue
        scannedBytes += file.bytes
        if (scannedBytes > MAX_SCAN_BYTES) return { matches, truncated: true }
        if (file.text && appendMatchingLines(matches, filename, file.text, pattern)) return { matches, truncated: true }
      }
    }
    return { matches, truncated }
  } catch (error) {
    if (cancellation.aborted) return null
    if (timeout.aborted) return { matches, truncated: true }
    throw error
  }
}

/** @param {ContentMatch[]} matches @param {string} filename @param {string} text @param {RegExp} pattern */
function appendMatchingLines(matches, filename, text, pattern) {
  // Monaco strips an initial UTF-8 BOM and treats CR, LF and CRLF as line endings.
  const newline = /\r\n?|\n/gu
  let start = text.startsWith('\uFEFF') ? 1 : 0
  let number = 1
  while (start < text.length) {
    newline.lastIndex = start
    const separator = newline.exec(text)
    const end = separator?.index ?? text.length
    const line = text.slice(start, end)
    const found = pattern.exec(line)
    if (found) {
      if (matches.length === MAX_MATCHES) return true
      const column = found.index
      const length = found[0].length
      const matchEnd = column + length
      const contextStart = Math.max(0, column - 31)
      const contextEnd = Math.min(line.length, matchEnd + 119)
      const before = line.slice(contextStart, column).replace(/^[\uDC00-\uDFFF]/u, '')
      const after = line.slice(matchEnd, contextEnd).replace(/[\uD800-\uDBFF]$/u, '')
      matches.push({
        path: filename,
        line: number,
        column: column + 1,
        length,
        // Copy snippets so short results cannot retain the full file string.
        before: copyText(contextStart ? `…${before}` : before),
        match: copyText(found[0]),
        after: copyText(contextEnd < line.length ? `${after}…` : after),
      })
    }
    start = separator ? newline.lastIndex : end
    number++
  }
  return false
}

/** @param {string} value */
function copyText(value) {
  return Buffer.from(value, 'utf16le').toString('utf16le')
}

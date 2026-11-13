export interface SearchableFile {
  path: string
}

interface IndexedPath {
  folded: string | string[]
  basename: number
}
interface Match {
  score: number
  positions: number[]
}

const INDEXED_PATHS = new WeakMap<SearchableFile, IndexedPath>()

/** Rank filename matches before directory matches; retain exact Unicode offsets for highlights. */
export function searchFiles<T extends SearchableFile>(
  files: readonly T[],
  query: string,
): Array<{ file: T; score?: number; positions: number[] }> {
  const words = query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(word => Array.from(word, char => char.toLocaleLowerCase()))
  const results: Array<{ file: T; score: number; positions: number[] }> = []
  if (!words.length) return files.map(file => ({ file, positions: [] }))
  for (const file of files) {
    let indexed = INDEXED_PATHS.get(file)
    if (!indexed) {
      const lower = file.path.toLocaleLowerCase()
      // ASCII paths can use string offsets; Unicode paths need code-point offsets.
      // oxlint-disable-next-line eslint/no-control-regex -- ASCII includes control characters.
      const folded = /^[\x00-\x7f]*$/.test(`${file.path}${lower}`)
        ? lower
        : Array.from(file.path, char => char.toLocaleLowerCase())
      indexed = { folded, basename: folded.lastIndexOf('/') + 1 }
      INDEXED_PATHS.set(file, indexed)
    }
    const { folded, basename } = indexed
    const positions = new Set<number>()
    let score = 0
    for (const word of words) {
      const name = match(folded, word, basename)
      const found = name ?? match(folded, word, 0)
      if (!found) {
        score = Infinity
        break
      }
      score += (name ? 0 : 1000) + found.score
      for (const index of found.positions) positions.add(index)
    }
    if (Number.isFinite(score)) results.push({ file, score, positions: [...positions].toSorted((a, b) => a - b) })
  }
  return results.toSorted(
    (a, b) => a.score - b.score || a.file.path.length - b.file.path.length || a.file.path.localeCompare(b.file.path),
  )
}

function match(characters: string | readonly string[], query: readonly string[], start: number): Match | null {
  // Prefer a contiguous occurrence before falling back to an abbreviated path.
  if (typeof characters === 'string') {
    const index = characters.indexOf(query.join(''), start)
    if (index >= 0)
      return {
        score: index - start + (characters.length - start === query.length ? 0 : 1),
        positions: query.map((_, offset) => index + offset),
      }
  } else
    for (let index = start; index <= characters.length - query.length; index++) {
      if (query.every((char, offset) => characters[index + offset] === char)) {
        return {
          score: index - start + (characters.length - start === query.length ? 0 : 1),
          positions: query.map((_, offset) => index + offset),
        }
      }
    }
  const positions: number[] = []
  let cursor = start
  for (const char of query) {
    const index = characters.indexOf(char, cursor)
    if (index < 0) return null
    positions.push(index)
    cursor = index + 1
  }
  return {
    score: 100 + cursor - start - query.length,
    positions,
  }
}

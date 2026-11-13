export interface SearchableFile {
  path: string
}

interface IndexedPath {
  folded: string | string[]
  basename: number
}
interface QueryWord {
  characters: string[]
  text: string
}
interface RankedFile<T> {
  index: number
  file: T
  score: number
}

const INDEXED_PATHS = new WeakMap<SearchableFile, IndexedPath>()
const ASCII_CASE_FOLDING = 'I'.toLocaleLowerCase() === 'i'
// oxlint-disable-next-line eslint/no-control-regex -- ASCII includes control characters.
const ASCII = /^[\x00-\x7f]*$/u

function indexPath(file: SearchableFile): IndexedPath {
  const cached = INDEXED_PATHS.get(file)
  if (cached) return cached
  // ASCII paths use string offsets. Fold Unicode one code point at a time to preserve highlight offsets.
  let folded: string | string[]
  if (ASCII.test(file.path)) {
    const lower = ASCII_CASE_FOLDING ? file.path.toLowerCase() : file.path.toLocaleLowerCase()
    folded = ASCII_CASE_FOLDING || ASCII.test(lower) ? lower : foldCharacters(file.path)
  } else folded = foldCharacters(file.path)
  const indexed = { folded, basename: folded.lastIndexOf('/') + 1 }
  INDEXED_PATHS.set(file, indexed)
  return indexed
}

function foldCharacters(text: string) {
  return Array.from(text, char => char.toLocaleLowerCase())
}

export function compileFileQuery(query: string) {
  const trimmed = query.trim()
  const words = trimmed
    ? trimmed.split(/\s+/u).map(word => {
        const characters = foldCharacters(word)
        return { characters, text: characters.join('') }
      })
    : []
  return {
    empty: words.length === 0,
    words,
    score(file: SearchableFile) {
      return scorePath(indexPath(file), words)
    },
    positions(this: void, file: SearchableFile) {
      if (!words.length) return []
      const positions: number[] = []
      if (scorePath(indexPath(file), words, positions) < 0) return []
      if (words.length === 1) return positions
      const unique = [...new Set(positions)]
      // oxlint-disable-next-line unicorn/no-array-sort -- This fresh array has no other readers.
      return unique.sort((a, b) => a - b)
    },
  }
}

export type FileQuery = ReturnType<typeof compileFileQuery>

/** Rank filenames before directory matches. Highlight offsets are computed only when requested. */
export function createFileRanking<T extends SearchableFile>(query: FileQuery) {
  const results: RankedFile<T>[] = []
  return {
    add(file: T, index: number) {
      const score = query.score(file)
      if (score >= 0) results.push({ index, file, score })
    },
    finish() {
      // oxlint-disable-next-line unicorn/no-array-sort -- This fresh array has no other readers.
      return results.sort(
        (a, b) =>
          a.score - b.score ||
          a.file.path.length - b.file.path.length ||
          a.file.path.localeCompare(b.file.path) ||
          a.index - b.index,
      )
    },
  }
}

export function rankFiles<T extends SearchableFile>(files: readonly T[], query: FileQuery) {
  const ranking = createFileRanking<T>(query)
  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    if (file) ranking.add(file, index)
  }
  return ranking.finish()
}

export function isQueryRefinement(query: FileQuery, previous: FileQuery) {
  // Extending a term's subsequence or adding another term can only narrow the candidates.
  return previous.words.every(({ characters }, index) => {
    const word = query.words[index]
    return word && characters.every((char, offset) => word.characters[offset] === char)
  })
}

export function searchFiles<T extends SearchableFile>(files: readonly T[], query: string) {
  const compiled = compileFileQuery(query)
  if (compiled.empty) return files.map(file => ({ file, positions: [] }))
  return rankFiles(files, compiled).map(({ file, score }) => ({ file, score, positions: compiled.positions(file) }))
}

function scorePath({ folded, basename }: IndexedPath, words: QueryWord[], positions?: number[]): number {
  let score = 0
  for (const word of words) {
    const name = match(folded, word, basename, positions)
    if (name >= 0) score += name
    else {
      if (!basename) return -1
      const path = match(folded, word, 0, positions)
      if (path < 0) return -1
      score += 1000 + path
    }
  }
  return score
}

function match(path: string | string[], word: QueryWord, start: number, positions?: number[]): number {
  const { characters, text } = word
  if (characters.length > path.length - start) return -1
  const contiguous = typeof path === 'string' ? path.indexOf(text, start) : findContiguous(path, characters, start)
  if (contiguous >= 0) {
    if (positions) for (let offset = 0; offset < characters.length; offset++) positions.push(contiguous + offset)
    return contiguous - start + (path.length - start === characters.length ? 0 : 1)
  }
  if (characters.length === 1) return -1
  const previousLength = positions?.length ?? 0
  let cursor = start
  for (const char of characters) {
    const index = path.indexOf(char, cursor)
    if (index < 0) {
      if (positions) positions.length = previousLength
      return -1
    }
    positions?.push(index)
    cursor = index + 1
  }
  return 100 + cursor - start - characters.length
}

function findContiguous(path: string[], word: string[], start: number) {
  const last = path.length - word.length
  for (
    let index = path.indexOf(word[0] ?? '', start);
    index >= 0 && index <= last;
    index = path.indexOf(word[0] ?? '', index + 1)
  ) {
    let length = 1
    while (length < word.length && path[index + length] === word[length]) length++
    if (length === word.length) return index
  }
  return -1
}

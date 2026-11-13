/// <reference lib="webworker" />

import { searchFiles } from './file-search.ts'
import type { SearchableFile } from './file-search.ts'

interface IndexedFile extends SearchableFile {
  index: number
}

function isIndexedFile(value: unknown, index: number): value is IndexedFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'index' in value &&
    value.index === index &&
    'path' in value &&
    typeof value.path === 'string'
  )
}

let files: IndexedFile[] = []
declare const self: DedicatedWorkerGlobalScope

self.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid file search message')
  if ('files' in data) {
    if (!Array.isArray(data.files) || !data.files.every(isIndexedFile)) {
      throw new Error('Invalid file search inventory')
    }
    files = data.files
    return
  }
  if (
    !('query' in data) ||
    typeof data.query !== 'string' ||
    !('id' in data) ||
    typeof data.id !== 'number' ||
    !Number.isSafeInteger(data.id) ||
    data.id < 1
  ) {
    throw new Error('Invalid file search query')
  }
  const matches = searchFiles(files, data.query)
  const response = {
    id: data.id,
    matches: matches.map(({ file, positions }) => ({ index: file.index, positions })),
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This worker replies on its dedicated port.
  self.postMessage(response)
})

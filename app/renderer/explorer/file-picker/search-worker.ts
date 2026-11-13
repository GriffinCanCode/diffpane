/// <reference lib="webworker" />

import { compileFileQuery, createFileRanking, isQueryRefinement } from './file-search.ts'
import type { FileQuery, SearchableFile } from './file-search.ts'

interface Job {
  id: number
  query: FileQuery
  ranking: ReturnType<typeof createFileRanking<SearchableFile>>
  candidates?: Uint32Array
  cursor: number
}

function isPath(value: unknown): value is string {
  return typeof value === 'string'
}

const CHUNK_SIZE = 8_192
let files: SearchableFile[] = []
let active: Job | undefined
let previous: { query: FileQuery; indexes: Uint32Array } | undefined
const continuation = new MessageChannel()
declare const self: DedicatedWorkerGlobalScope

function respond(id: number, matches: Uint32Array<ArrayBuffer>) {
  self.postMessage({ id, matches }, [matches.buffer])
}

function cancel() {
  if (!active) return
  respond(active.id, new Uint32Array())
  active = undefined
}

function processChunk(job: Job) {
  const { candidates, ranking } = job
  const length = candidates?.length ?? files.length
  const end = Math.min(length, job.cursor + CHUNK_SIZE)
  for (; job.cursor < end; job.cursor++) {
    const index = candidates?.[job.cursor] ?? job.cursor
    const file = files[index]
    if (file) ranking.add(file, index)
  }
  if (end < length) {
    continuation.port2.postMessage(job.id)
    return
  }
  const indexes = Uint32Array.from(ranking.finish(), match => match.index)
  previous = { query: job.query, indexes }
  active = undefined
  respond(job.id, indexes.slice())
}

continuation.port1.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
  if (active && active.id === data) processChunk(active)
})
continuation.port1.start()

self.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid file search message')
  if ('paths' in data) {
    if (!Array.isArray(data.paths) || !data.paths.every(isPath)) {
      throw new Error('Invalid file search inventory')
    }
    cancel()
    previous = undefined
    files = data.paths.map(path => ({ path }))
    return
  }
  if ('cancel' in data) {
    if (active?.id === data.cancel) cancel()
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
  const query = compileFileQuery(data.query)
  if (query.empty) {
    respond(
      data.id,
      Uint32Array.from(files, (_, index) => index),
    )
    return
  }
  active = {
    id: data.id,
    query,
    ranking: createFileRanking(query),
    candidates: previous && isQueryRefinement(query, previous.query) ? previous.indexes : undefined,
    cursor: 0,
  }
  processChunk(active)
})

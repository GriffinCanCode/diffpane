import { appError } from '../../../shared/recovery/app-errors.ts'
import { searchFiles } from './file-search.ts'
import type { SearchableFile } from './file-search.ts'

interface Hit<T> {
  file: T
  positions: number[]
  score?: number
}
interface Query<T> {
  id: number
  query: string
  resolve: (value: Hit<T>[] | null) => void
  reject: (reason: Error) => void
  generation: number
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function workerHits<T extends SearchableFile>(matches: unknown, files: readonly T[]): Hit<T>[] | null {
  if (!Array.isArray(matches) || matches.length > files.length) return null
  const hits: Hit<T>[] = []
  for (const match of matches as readonly unknown[]) {
    if (
      typeof match !== 'object' ||
      match === null ||
      !('index' in match) ||
      !isOffset(match.index) ||
      !('positions' in match) ||
      !Array.isArray(match.positions) ||
      !match.positions.every(isOffset)
    )
      return null
    const file = files[match.index]
    if (!file) return null
    hits.push({ file, positions: match.positions })
  }
  return hits
}

const WORKER_THRESHOLD = 5000

/** Small projects stay synchronous; large searches never block input or editor painting. */
export function createFileSearch<T extends SearchableFile>() {
  let files: readonly T[] = []
  let worker: Worker | undefined
  let workerEvents: AbortController | undefined
  let running: Query<T> | undefined
  let queued: Query<T> | undefined
  let sequence = 0
  let generation = 0

  function dispatch() {
    if (running || !queued || !worker) return
    running = queued
    queued = undefined
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages have a dedicated port and no targetOrigin.
      worker.postMessage({ id: running.id, query: running.query })
    } catch (cause) {
      workerFailed(cause)
    }
  }

  function cancelQueued() {
    if (queued) {
      queued.resolve(null)
      queued = undefined
    }
  }

  function releaseWorker() {
    const previous = worker
    worker = undefined
    workerEvents?.abort()
    workerEvents = undefined
    previous?.terminate()
    running?.resolve(null)
    running = undefined
  }

  function workerFailed(cause: unknown) {
    const error = appError(cause, {
      operation: 'Search files',
      message: 'File search failed. Try again.',
    })
    if (running?.generation === generation && !queued) running.reject(error)
    queued?.reject(error)
    queued = undefined
    releaseWorker()
  }

  function prepareWorker() {
    if (!worker) {
      const current = new Worker(new URL('./search-worker.ts', import.meta.url), {
        type: 'module',
      })
      worker = current
      workerEvents = new AbortController()
      const options = { signal: workerEvents.signal }
      current.addEventListener(
        'message',
        ({ data }: MessageEvent<unknown>) => {
          const work = running
          if (worker !== current || !work) return
          if (typeof data !== 'object' || data === null || !('id' in data) || !isOffset(data.id)) {
            workerFailed(new Error('Invalid file search worker response'))
            return
          }
          if (data.id !== work.id) return
          const publish = work.generation === generation && !queued
          const hits = publish && 'matches' in data ? workerHits(data.matches, files) : null
          if (publish && !hits) {
            workerFailed(new Error('Invalid file search worker matches'))
            return
          }
          running = undefined
          work.resolve(hits)
          dispatch()
        },
        options,
      )
      const onWorkerError = (event: Event) => {
        event.preventDefault()
        const cause: unknown = 'error' in event ? event.error : event
        if (worker === current) workerFailed(cause)
      }
      current.addEventListener('error', onWorkerError, options)
      current.addEventListener('messageerror', onWorkerError, options)
    }
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages have a dedicated port and no targetOrigin.
    worker.postMessage({ files: files.map((file, index) => ({ path: file.path, index })) })
  }

  return {
    setFiles(next: readonly T[]) {
      files = next
      generation++
      cancelQueued()
      if (files.length >= WORKER_THRESHOLD) {
        try {
          prepareWorker()
        } catch (cause) {
          workerFailed(cause)
        }
      } else releaseWorker()
    },
    search(query: string): Hit<T>[] | Promise<Hit<T>[] | null> {
      if (files.length < WORKER_THRESHOLD || !query.trim()) {
        cancelQueued()
        generation++
        return searchFiles(files, query)
      }
      cancelQueued()
      return new Promise((resolve, reject) => {
        queued = { id: ++sequence, query, resolve, reject, generation }
        if (!worker) {
          try {
            prepareWorker()
          } catch (cause) {
            workerFailed(cause)
            return
          }
        }
        dispatch()
      })
    },
    cancel() {
      generation++
      cancelQueued()
    },
    dispose() {
      generation++
      cancelQueued()
      releaseWorker()
      files = []
    },
  }
}

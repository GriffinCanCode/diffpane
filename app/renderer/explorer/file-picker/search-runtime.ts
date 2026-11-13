import { appError } from '../../../shared/recovery/app-errors.ts'
import { compileFileQuery, rankFiles } from './file-search.ts'
import type { FileQuery, SearchableFile } from './file-search.ts'

export interface FileSearchResults<T> {
  length: number
  fileAt: (index: number) => T | undefined
  positions: (file: T) => number[]
}
interface Query<T> {
  id: number
  query: string
  resolve: (value: FileSearchResults<T> | null) => void
  reject: (reason: Error) => void
  canceled?: boolean
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function results<T extends SearchableFile>(
  files: readonly T[],
  query: FileQuery,
  indexes?: Uint32Array,
): FileSearchResults<T> {
  return {
    length: indexes?.length ?? files.length,
    fileAt: indexes ? index => files[indexes[index] ?? -1] : index => files[index],
    positions: query.positions,
  }
}

function workerIndexes(matches: unknown, fileCount: number): matches is Uint32Array {
  if (!(matches instanceof Uint32Array) || matches.length > fileCount) return false
  return matches.every(index => index < fileCount)
}

const WORKER_THRESHOLD = 5000
const EMPTY_QUERY = compileFileQuery('')

/** Small projects stay synchronous; large searches never block input or editor painting. */
export function createFileSearch<T extends SearchableFile>() {
  let files: readonly T[] = []
  let worker: Worker | undefined
  let workerEvents: AbortController | undefined
  let running: Query<T> | undefined
  let queued: Query<T> | undefined
  let sequence = 0

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

  function cancelRunning() {
    if (!worker || !running || running.canceled) return
    running.canceled = true
    running.resolve(null)
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages have a dedicated port and no targetOrigin.
      worker.postMessage({ cancel: running.id })
    } catch (cause) {
      workerFailed(cause)
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
    const active = queued ?? (running?.canceled ? undefined : running)
    active?.reject(error)
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
          const publish = !work.canceled && !queued
          let hits = null
          if (publish) {
            if (!('matches' in data) || !workerIndexes(data.matches, files.length)) {
              workerFailed(new Error('Invalid file search worker matches'))
              return
            }
            hits = results(files, compileFileQuery(work.query), data.matches)
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
    const current = worker
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages have a dedicated port and no targetOrigin.
    current.postMessage({ paths: files.map(file => file.path) })
  }

  return {
    setFiles(next: readonly T[]) {
      if (next === files) return
      files = next
      cancelQueued()
      if (files.length >= WORKER_THRESHOLD) {
        cancelRunning()
        try {
          prepareWorker()
        } catch (cause) {
          workerFailed(cause)
        }
      } else releaseWorker()
    },
    search(query: string): FileSearchResults<T> | Promise<FileSearchResults<T> | null> {
      const hasQuery = Boolean(query.trim())
      if (files.length < WORKER_THRESHOLD || !hasQuery) {
        cancelQueued()
        cancelRunning()
        if (!hasQuery) return results(files, EMPTY_QUERY)
        const compiled = compileFileQuery(query)
        const indexes = Uint32Array.from(rankFiles(files, compiled), match => match.index)
        return results(files, compiled, indexes)
      }
      cancelQueued()
      return new Promise((resolve, reject) => {
        queued = { id: ++sequence, query, resolve, reject }
        if (running) {
          cancelRunning()
          return
        }
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
    dispose() {
      cancelQueued()
      releaseWorker()
      files = []
    },
  }
}

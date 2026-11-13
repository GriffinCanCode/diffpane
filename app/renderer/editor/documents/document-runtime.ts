import type { DocumentTask, processDocument } from './document-processing.ts'

type DocumentResult = ReturnType<typeof processDocument>
type WorkResult = DocumentResult | Error | 'unavailable' | null
interface Work {
  task: DocumentTask
  complete: (result: WorkResult) => void
}

const WORKER_THRESHOLD = 32_768
const FUNCTION_WORKER_THRESHOLD = 8_192
const WORKER_IDLE_MS = 30_000

/** Keep large document analysis off the renderer, sharing one worker across active views. */
export function createDocumentProcessor() {
  let worker: Worker | undefined
  let running: Work | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const queue = new Set<Work>()

  function release(result: Error | 'unavailable' | null = null) {
    clearTimeout(idle)
    worker?.terminate()
    worker = undefined
    running?.complete(result)
    running = undefined
  }

  function dispatch() {
    if (running) return
    running = queue.values().next().value
    if (!running) {
      if (worker) idle = setTimeout(release, WORKER_IDLE_MS)
      return
    }
    queue.delete(running)
    clearTimeout(idle)
    try {
      if (!worker) {
        const current = new Worker(new URL('./document-worker.ts', import.meta.url), { type: 'module' })
        worker = current
        current.addEventListener('message', ({ data }: MessageEvent<DocumentResult | Error>) => {
          if (worker !== current) return
          running?.complete(data)
          running = undefined
          dispatch()
        })
        const failed = (event: Event) => {
          event.preventDefault()
          if (worker !== current) return
          release('unavailable')
          dispatch()
        }
        current.addEventListener('error', failed)
        current.addEventListener('messageerror', failed)
      }
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The document worker has a dedicated port.
      worker.postMessage(running.task)
    } catch {
      release('unavailable')
      queueMicrotask(dispatch)
    }
  }

  function submit(task: DocumentTask, signal: AbortSignal) {
    return new Promise<WorkResult>(resolve => {
      const work: Work = {
        task,
        complete(result) {
          signal.removeEventListener('abort', abort)
          resolve(result)
        },
      }
      function abort() {
        if (running === work) {
          release()
          dispatch()
          return
        }
        queue.delete(work)
        work.complete(null)
      }
      signal.addEventListener('abort', abort, { once: true })
      queue.add(work)
      dispatch()
    })
  }

  return {
    async run(task: DocumentTask, signal: AbortSignal) {
      if (signal.aborted) return undefined
      const size =
        task.kind === 'markdown'
          ? task.source.length
          : (task.original.length ? task.before.length : 0) + (task.modified.length ? task.after.length : 0)
      const threshold = task.kind === 'markdown' ? WORKER_THRESHOLD : FUNCTION_WORKER_THRESHOLD
      const result = size >= threshold ? await submit(task, signal) : 'unavailable'
      if (signal.aborted || result === null) return undefined
      if (result instanceof Error) throw result
      if (result !== 'unavailable') return result
      const fallback = await import('./document-processing.ts')
      return signal.aborted ? undefined : fallback.processDocument(task)
    },
    dispose() {
      for (const work of queue) work.complete(null)
      queue.clear()
      release()
    },
  }
}

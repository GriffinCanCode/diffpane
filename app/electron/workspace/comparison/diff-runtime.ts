import { Worker } from 'node:worker_threads'
import type { createDiagnostics } from '../../../shared/diagnostics/diagnostics.ts'
import type { DiffDecorations, LineDecoration } from './changes.ts'
import type { DiffReply, DiffRequest } from './diff-worker.ts'

interface Pending {
  resolve: (value: DiffDecorations) => void
  reject: (reason: Error) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDecoration(value: unknown): value is LineDecoration {
  return (
    isRecord(value) &&
    isCount(value.startLine) &&
    value.startLine > 0 &&
    isCount(value.endLine) &&
    value.endLine >= value.startLine &&
    (value.kind === 'added' || value.kind === 'modified' || value.kind === 'deleted')
  )
}

function isDiffReply(value: unknown): value is DiffReply {
  if (!isRecord(value) || !isCount(value.id) || value.id === 0) return false
  if (value.ok === false) return typeof value.error === 'string'
  const diff = value.value
  return (
    value.ok === true &&
    isRecord(diff) &&
    Array.isArray(diff.decorations) &&
    diff.decorations.every(isDecoration) &&
    Array.isArray(diff.beforeDecorations) &&
    diff.beforeDecorations.every(isDecoration) &&
    (diff.additions === null || isCount(diff.additions)) &&
    (diff.deletions === null || isCount(diff.deletions)) &&
    (diff.diffNote === undefined || typeof diff.diffNote === 'string')
  )
}

/** Keep CPU-heavy diffing off the Git/watch/language event loop. Callers bound the queue. */
export class DiffRuntime {
  pending = new Map<number, Pending>()
  sequence = 0
  worker?: Worker | null
  disposed?: boolean
  timer?: ReturnType<typeof setTimeout>
  stopping = new Set<Promise<number>>()

  private readonly options: { idleMs?: number; diagnostics?: ReturnType<typeof createDiagnostics> }

  constructor(options: { idleMs?: number; diagnostics?: ReturnType<typeof createDiagnostics> } = {}) {
    this.options = options
  }

  calculate(before: string, after: string): Promise<DiffDecorations> {
    if (this.disposed) return Promise.reject(new Error('Diff worker closed'))
    if (before === after)
      return Promise.resolve({
        decorations: [],
        beforeDecorations: [],
        additions: 0,
        deletions: 0,
      })
    clearTimeout(this.timer)
    let worker = this.worker
    if (!worker) {
      try {
        worker = new Worker(new URL('./diff-worker.ts', import.meta.url))
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error('Could not start diff worker.', { cause: error }),
        )
      }
      this.worker = worker
      const activeWorker = worker
      const fail = (error: Error) => {
        if (this.worker !== activeWorker) return
        this.worker = null
        clearTimeout(this.timer)
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
        this.terminate(activeWorker)
      }
      worker.on('message', (reply: unknown) => {
        if (!isDiffReply(reply)) {
          fail(new Error('Invalid diff worker response.'))
          return
        }
        const request = this.pending.get(reply.id)
        if (!request) return
        this.pending.delete(reply.id)
        this.scheduleIdle()
        if (reply.ok) request.resolve(reply.value)
        else request.reject(new Error(reply.error))
      })
      worker.on('error', fail)
      worker.on('exit', code => fail(new Error(`Diff worker exited (${code})`)))
    }
    const activeWorker = worker
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve, reject })
      try {
        const request: DiffRequest = { id, before, after }
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node Worker messages have no target origin.
        activeWorker.postMessage(request)
      } catch (error) {
        this.pending.delete(id)
        this.scheduleIdle()
        reject(error instanceof Error ? error : new Error('Could not queue diff calculation.', { cause: error }))
      }
    })
  }

  private scheduleIdle() {
    if (this.pending.size || !this.worker || this.disposed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const worker = this.worker
      this.worker = null
      if (worker) this.terminate(worker)
    }, this.options.idleMs ?? 30_000)
    this.timer.unref()
  }

  private terminate(worker: Worker) {
    const stopping = worker.terminate()
    this.stopping.add(stopping)
    void stopping.then(
      () => this.stopping.delete(stopping),
      (error: unknown) => {
        this.stopping.delete(stopping)
        this.options.diagnostics?.error('workspace.diff.stop', error)
      },
    )
  }

  async dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    const worker = this.worker
    this.worker = null
    for (const request of this.pending.values()) request.reject(new Error('Diff worker closed'))
    this.pending.clear()
    if (worker) this.terminate(worker)
    await Promise.allSettled(this.stopping)
  }
}

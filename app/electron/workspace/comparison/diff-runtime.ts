import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { createDiagnostics } from '../../../shared/diagnostics/diagnostics.ts'
import { smallDecorations, unchangedDecorations } from './changes.ts'
import type { DiffDecorations, LineDecoration } from './changes.ts'
import type { DiffReply, DiffRequest } from './diff-worker.ts'

interface Pending {
  resolve: (value: DiffDecorations) => void
  reject: (reason: Error) => void
}

interface DiffLane {
  worker: Worker
  pending: Map<number, Pending>
  timer?: ReturnType<typeof setTimeout>
}

interface DiffRuntimeOptions {
  idleMs?: number
  concurrency?: number
  diagnostics?: ReturnType<typeof createDiagnostics>
}

const MAX_WORKERS = Math.min(availableParallelism(), 2)

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

/** Isolate large diffs while letting overlapping document reads use separate workers. */
export class DiffRuntime {
  readonly lanes = new Set<DiffLane>()
  readonly stopping = new Set<Promise<number>>()
  private sequence = 0
  private disposed = false

  private readonly options: DiffRuntimeOptions

  constructor(options: DiffRuntimeOptions = {}) {
    this.options = options
  }

  calculate(before: string, after: string): Promise<DiffDecorations> {
    if (this.disposed) return Promise.reject(new Error('Diff worker closed'))
    if (before === after) return Promise.resolve(unchangedDecorations())
    let lane: DiffLane
    try {
      const small = smallDecorations(before, after)
      if (small) return Promise.resolve(small)
      lane = this.acquireLane()
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Could not start diff calculation.', { cause: error }),
      )
    }

    clearTimeout(lane.timer)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      lane.pending.set(id, { resolve, reject })
      try {
        const request: DiffRequest = { id, before, after }
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node Worker messages have no target origin.
        lane.worker.postMessage(request)
      } catch (error) {
        lane.pending.delete(id)
        this.scheduleIdle(lane)
        reject(error instanceof Error ? error : new Error('Could not queue diff calculation.', { cause: error }))
      }
    })
  }

  private acquireLane(): DiffLane {
    let leastBusy: DiffLane | undefined
    for (const lane of this.lanes) {
      if (!lane.pending.size) return lane
      if (!leastBusy || lane.pending.size < leastBusy.pending.size) leastBusy = lane
    }
    if (leastBusy && this.lanes.size >= (this.options.concurrency ?? MAX_WORKERS)) return leastBusy

    let worker: Worker
    try {
      worker = new Worker(new URL('./diff-worker.ts', import.meta.url))
    } catch (error) {
      if (leastBusy) return leastBusy
      throw error
    }
    const lane: DiffLane = { worker, pending: new Map() }
    this.lanes.add(lane)
    worker.on('message', (reply: unknown) => {
      if (!isDiffReply(reply)) {
        this.release(lane, new Error('Invalid diff worker response.'))
        return
      }
      const request = lane.pending.get(reply.id)
      if (!request) return
      lane.pending.delete(reply.id)
      this.scheduleIdle(lane)
      if (reply.ok) request.resolve(reply.value)
      else request.reject(new Error(reply.error))
    })
    worker.on('error', (error: unknown) =>
      this.release(lane, error instanceof Error ? error : new Error('Diff worker failed.', { cause: error })),
    )
    worker.on('exit', code => this.release(lane, new Error(`Diff worker exited (${code})`)))
    return lane
  }

  private scheduleIdle(lane: DiffLane) {
    if (lane.pending.size) return
    clearTimeout(lane.timer)
    lane.timer = setTimeout(() => this.release(lane), this.options.idleMs ?? 30_000)
    lane.timer.unref()
  }

  private release(lane: DiffLane, failure?: Error) {
    if (!this.lanes.delete(lane)) return
    clearTimeout(lane.timer)
    if (failure) {
      for (const request of lane.pending.values()) request.reject(failure)
      lane.pending.clear()
    }
    const stopping = lane.worker.terminate()
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
    const failure = new Error('Diff worker closed')
    for (const lane of this.lanes) this.release(lane, failure)
    await Promise.allSettled(this.stopping)
  }
}

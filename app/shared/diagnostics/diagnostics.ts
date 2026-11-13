import { serializeAppError } from '../recovery/app-errors.ts'

export type DiagnosticSource = 'main' | 'preload' | 'renderer' | 'workspace'
export type DiagnosticLevel = 'info' | 'warn' | 'error'
export type DiagnosticUnit = 'ms' | 'count' | 'bytes' | 'percent'

interface DiagnosticFailure {
  code: string
  recoverable: boolean
}

interface DiagnosticContext {
  requestId?: number
}

interface DiagnosticBase extends DiagnosticContext {
  source: DiagnosticSource
  operation: string
  level: DiagnosticLevel
}

export type DiagnosticEvent = DiagnosticBase &
  (
    | { kind: 'event'; failure?: DiagnosticFailure }
    | { kind: 'duration'; durationMs: number; outcome: 'success' | 'failure' | 'canceled'; failure?: DiagnosticFailure }
    | { kind: 'metric'; value: number; unit: DiagnosticUnit }
  )

type DiagnosticResult = { ok: true } | { ok: false; error: unknown }
type DiagnosticSink = (event: DiagnosticEvent) => void

const OPERATION = /^[a-z][a-z0-9.:-]{0,95}$/
const KNOWN_CODES = new Set([
  'ABORT_ERR',
  'BACKEND_UNAVAILABLE',
  'BACKEND_UPDATE_FAILED',
  'CHECKPOINT_EXPIRED',
  'CHECKPOINT_READ_CHANGED',
  'DESKTOP_BRIDGE_UNAVAILABLE',
  'DOCUMENT_UNAVAILABLE',
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EIO',
  'EMFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EPIPE',
  'ERR_ABORTED',
  'ERR_ACCESS_DENIED',
  'ERR_CONNECTION_REFUSED',
  'ERR_FAILED',
  'ERR_FILE_NOT_FOUND',
  'ERR_NETWORK_CHANGED',
  'ERR_SQLITE_ERROR',
  'ETIMEDOUT',
  'INVALID_FILE_ACTION',
  'INVALID_IPC_RESPONSE',
  'INVALID_LINK',
  'IPC_UNAVAILABLE',
  'LANGUAGE_SERVER_UNAVAILABLE',
  'OUTPUT_LIMIT',
  'RENDERER_UNAVAILABLE',
  'REPORT_REQUIRED',
  'SAVE_CONFLICT',
  'SAVE_FLUSH_FAILED',
  'SAVE_RECOVERY_FAILED',
  'UNEXPECTED',
  'WATCHER_FAILED',
  'WATCHER_FALLBACK',
  'WATCHER_UNAVAILABLE',
  'WINDOW_UNAVAILABLE',
  'WORKSPACE_REQUIRED',
])
const CANCELLATIONS = new Set(['ABORT_ERR', 'ERR_ABORTED'])
const EXPECTED_FAILURES = new Set([
  'CHECKPOINT_EXPIRED',
  'DOCUMENT_UNAVAILABLE',
  'SAVE_CONFLICT',
  'WATCHER_FALLBACK',
  'WINDOW_UNAVAILABLE',
])

function failure(cause: unknown): DiagnosticFailure {
  const { code, recoverable } = serializeAppError(cause)
  if (code === 'UNEXPECTED') {
    try {
      if (typeof cause === 'object' && cause !== null && Reflect.get(cause, 'name') === 'AbortError')
        return { code: 'ABORT_ERR', recoverable }
    } catch {
      // A thrown value can be a proxy with throwing property access.
    }
  }
  return { code: KNOWN_CODES.has(code) ? code : 'UNEXPECTED', recoverable }
}

function severity(details: DiagnosticFailure): DiagnosticLevel {
  if (CANCELLATIONS.has(details.code)) return 'info'
  return EXPECTED_FAILURES.has(details.code) ? 'warn' : 'error'
}

export function createDiagnostics(source: DiagnosticSource, sink: DiagnosticSink) {
  function emit(event: DiagnosticEvent): void {
    try {
      sink(event)
    } catch {
      // A diagnostic transport can disappear while the app is recovering or closing.
    }
  }

  function measure(
    operation: string,
    startedAt: number,
    result: DiagnosticResult = { ok: true },
    context?: DiagnosticContext,
  ): void {
    const durationMs = Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
    if (result.ok) {
      emit({ ...context, source, operation, kind: 'duration', level: 'info', durationMs, outcome: 'success' })
    } else {
      const details = failure(result.error)
      const outcome = CANCELLATIONS.has(details.code) ? 'canceled' : 'failure'
      emit({
        ...context,
        source,
        operation,
        kind: 'duration',
        level: severity(details),
        durationMs,
        outcome,
        failure: details,
      })
    }
  }

  function run<T>(operation: string, callback: () => T): T
  function run(operation: string, callback: () => unknown): unknown {
    const startedAt = performance.now()
    try {
      const value = callback()
      if (value instanceof Promise) {
        return value.then(
          (result: unknown) => {
            measure(operation, startedAt)
            return result
          },
          (error: unknown) => {
            measure(operation, startedAt, { ok: false, error })
            throw error
          },
        )
      }
      measure(operation, startedAt)
      return value
    } catch (error) {
      measure(operation, startedAt, { ok: false, error })
      throw error
    }
  }

  return {
    run,
    measure,
    error(operation: string, cause: unknown): void {
      const details = failure(cause)
      emit({ source, operation, kind: 'event', level: severity(details), failure: details })
    },
    event(operation: string, level: DiagnosticLevel = 'info'): void {
      emit({ source, operation, kind: 'event', level })
    },
    metric(operation: string, value: number, unit: DiagnosticUnit): void {
      if (Number.isFinite(value) && value >= 0)
        emit({ source, operation, kind: 'metric', level: 'info', value: Math.round(value * 100) / 100, unit })
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

/** Project IPC input onto the diagnostic schema. Only the caller can assign provenance. */
export function parseDiagnostic(input: unknown, source: DiagnosticSource): DiagnosticEvent | undefined {
  if (
    !isRecord(input) ||
    input.source !== source ||
    typeof input.operation !== 'string' ||
    !OPERATION.test(input.operation)
  )
    return undefined
  const { kind, operation, level } = input
  if (level !== 'info' && level !== 'warn' && level !== 'error') return undefined
  const base: DiagnosticBase = { source, operation, level }
  if (source === 'workspace' && nonnegative(input.requestId) && Number.isSafeInteger(input.requestId))
    base.requestId = input.requestId

  if (kind === 'metric') {
    const { value, unit } = input
    if (
      level === 'info' &&
      nonnegative(value) &&
      (unit === 'ms' || unit === 'count' || unit === 'bytes' || unit === 'percent')
    )
      return { ...base, kind, value, unit }
    return undefined
  }

  let details: DiagnosticFailure | undefined
  if (input.failure !== undefined) {
    if (!isRecord(input.failure)) return undefined
    const { code, recoverable } = input.failure
    if (typeof code !== 'string' || !KNOWN_CODES.has(code) || typeof recoverable !== 'boolean') return undefined
    details = { code, recoverable }
  }
  if (kind === 'event')
    return details ? { ...base, kind, level: severity(details), failure: details } : { ...base, kind }
  if (kind === 'duration') {
    const { durationMs, outcome } = input
    if (!nonnegative(durationMs)) return undefined
    if (outcome === 'success' && !details && level === 'info') return { ...base, kind, durationMs, outcome }
    if ((outcome === 'failure' || outcome === 'canceled') && details)
      return {
        ...base,
        kind,
        level: severity(details),
        durationMs,
        outcome: CANCELLATIONS.has(details.code) ? 'canceled' : 'failure',
        failure: details,
      }
  }
  return undefined
}

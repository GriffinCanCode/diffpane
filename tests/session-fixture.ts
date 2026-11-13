import assert from 'node:assert/strict'
import type { MessagePort, Worker } from 'node:worker_threads'
import { appError } from '../app-errors.ts'
import type { ErrorDetails } from '../app-errors.ts'
import type { InventoryUpdate } from '../electron/inventory-delta.ts'
import { isSessionRecord, isSessionRevision } from '../electron/session-protocol.ts'
import type { WorkspaceDocument, WorkspaceFile, WorkspaceSnapshot } from '../electron/workspace-types.ts'

interface PerformanceStats {
  documents: { hits: number; loads: number; retries: number; entries: number; bytes: number }
  inventoryRevision: number
  revision: number
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  return (
    isSessionRecord(value) &&
    isString(value.path) &&
    (value.directory === undefined || typeof value.directory === 'boolean') &&
    (value.ignored === undefined || typeof value.ignored === 'boolean') &&
    (value.submodule === undefined || typeof value.submodule === 'boolean') &&
    (value.index === undefined || isString(value.index)) &&
    (value.worktree === undefined || isString(value.worktree)) &&
    (value.conflicted === undefined || typeof value.conflicted === 'boolean') &&
    (value.originalPath === undefined || value.originalPath === null || isString(value.originalPath)) &&
    (value.reviewVersion === undefined || isSessionRevision(value.reviewVersion))
  )
}

export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return (
    isSessionRecord(value) &&
    isString(value.root) &&
    isString(value.scope) &&
    (value.initialPath === null || isString(value.initialPath)) &&
    isString(value.branch) &&
    (value.head === null || isString(value.head)) &&
    Array.isArray(value.files) &&
    value.files.every(isWorkspaceFile) &&
    isSessionRevision(value.revision) &&
    isSessionRevision(value.inventoryRevision) &&
    Array.isArray(value.changedPaths) &&
    value.changedPaths.every(isString) &&
    typeof value.gitMs === 'number' &&
    Number.isFinite(value.gitMs) &&
    (value.watchError === undefined || isString(value.watchError)) &&
    (value.checkpoint === null ||
      (isSessionRecord(value.checkpoint) &&
        isSessionRevision(value.checkpoint.id) &&
        isSessionRevision(value.checkpoint.capturedAt) &&
        Array.isArray(value.checkpoint.files) &&
        value.checkpoint.files.every(isWorkspaceFile) &&
        (value.checkpoint.error === undefined || isString(value.checkpoint.error))))
  )
}

type TestedDocument = Pick<
  WorkspaceDocument,
  'path' | 'before' | 'after' | 'reviewVersion' | 'revision' | 'editable' | 'decorations'
>

function isTestedDocument(value: unknown): value is TestedDocument {
  return (
    isSessionRecord(value) &&
    isString(value.path) &&
    isString(value.before) &&
    isString(value.after) &&
    isSessionRevision(value.revision) &&
    (value.reviewVersion === undefined || isSessionRevision(value.reviewVersion)) &&
    typeof value.editable === 'boolean' &&
    Array.isArray(value.decorations) &&
    value.decorations.every(
      (item: unknown) =>
        isSessionRecord(item) &&
        isSessionRevision(item.startLine) &&
        isSessionRevision(item.endLine) &&
        (item.kind === 'added' || item.kind === 'modified' || item.kind === 'deleted'),
    )
  )
}

function isInventory(value: unknown): value is InventoryUpdate['files'] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => isWorkspaceFile(entry) && typeof entry.submodule === 'boolean')
  )
}

function isInventoryUpdate(value: unknown): value is InventoryUpdate {
  return (
    isSessionRecord(value) &&
    isSessionRevision(value.revision) &&
    typeof value.reset === 'boolean' &&
    isInventory(value.files) &&
    Array.isArray(value.removed) &&
    value.removed.every(isString)
  )
}

function isPerformance(value: unknown): value is PerformanceStats {
  return (
    isSessionRecord(value) &&
    isSessionRevision(value.revision) &&
    isSessionRevision(value.inventoryRevision) &&
    isSessionRecord(value.documents) &&
    isSessionRevision(value.documents.hits) &&
    isSessionRevision(value.documents.loads) &&
    isSessionRevision(value.documents.retries) &&
    isSessionRevision(value.documents.entries) &&
    isSessionRevision(value.documents.bytes)
  )
}

function isNull(value: unknown): value is null {
  return value === null
}

const RESPONSE_VALIDATORS = {
  snapshot: isWorkspaceSnapshot,
  refresh: isWorkspaceSnapshot,
  'capture-checkpoint': isWorkspaceSnapshot,
  document: isTestedDocument,
  files: isInventory,
  'files-delta': isInventoryUpdate,
  performance: isPerformance,
  rename: isString,
  save: isNull,
  'directory-expanded': isNull,
  'language-dispose': isNull,
}

export type TestedMethod = keyof typeof RESPONSE_VALIDATORS
export type SessionResponse<Method extends TestedMethod> = (typeof RESPONSE_VALIDATORS)[Method] extends ((
  value: unknown,
) => value is infer T)
  ? T
  : never

function isSessionResponse<Method extends TestedMethod>(
  method: Method,
  value: unknown,
): value is SessionResponse<Method> {
  return RESPONSE_VALIDATORS[method](value)
}

export function sessionResponse<Method extends TestedMethod>(method: Method, value: unknown): SessionResponse<Method> {
  assert.ok(isSessionResponse(method, value), `Malformed response for ${method}`)
  return value
}

export interface WorkerMessage {
  id?: number
  event?: string
  error?: string
  failure?: ErrorDetails
  value?: unknown
}

function isFailure(value: unknown): value is ErrorDetails {
  return (
    isSessionRecord(value) &&
    isString(value.code) &&
    isString(value.message) &&
    (value.operation === undefined || isString(value.operation)) &&
    typeof value.recoverable === 'boolean'
  )
}

export function workerMessage(value: unknown): WorkerMessage {
  assert.ok(isSessionRecord(value), 'Malformed worker message')
  assert.ok(value.id === undefined || isSessionRevision(value.id), 'Malformed worker message ID')
  assert.ok(value.event === undefined || isString(value.event), 'Malformed worker event')
  assert.ok(value.error === undefined || isString(value.error), 'Malformed worker error')
  assert.ok(value.failure === undefined || isFailure(value.failure), 'Malformed worker failure')
  return { id: value.id, event: value.event, error: value.error, failure: value.failure, value: value.value }
}

export function workerFailure(message: WorkerMessage): Error {
  return appError(message.failure ?? message.error)
}

export function postWorkerMessage(worker: Worker | MessagePort, message: unknown) {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker and message ports have no targetOrigin.
  worker.postMessage(message)
}

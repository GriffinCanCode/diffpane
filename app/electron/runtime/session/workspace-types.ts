import type { DiffDecorations } from '../../workspace/comparison/changes.ts'
import type { FileContent } from '../../workspace/documents/file-content.ts'

export type WorkspaceComparison = 'head' | 'unstaged' | 'staged' | `checkpoint:${number}`

export interface WorkspaceFile {
  path: string
  directory?: boolean
  index?: string
  worktree?: string
  conflicted?: boolean
  submodule?: boolean
  ignored?: boolean
  originalPath?: string | null
  reviewVersion?: number
}

export interface WorkspaceCheckpoint {
  id: number
  capturedAt: number
  files: WorkspaceFile[]
  error?: string
}

export interface WorkspaceSnapshot {
  root: string
  scope: string
  initialPath: string | null
  branch: string
  head: string | null
  files: WorkspaceFile[]
  revision: number
  changedPaths: string[]
  inventoryRevision: number
  checkpoint: WorkspaceCheckpoint | null
  watchError?: string
  gitMs: number
}

export interface WorkspaceDocument extends DiffDecorations {
  path: string
  revision: number
  reviewVersion?: number
  before: string
  after: string
  note?: string | null
  preview?: { before: FileContent; after: FileContent }
  workingMissing?: boolean
  editable: boolean
  lineCount: number
  elapsedMs: number
}

import { changedFunctionRanges } from '../../review/comparison/function-ranges.ts'
import { parseMarkdown } from '../markdown/markdown-document.ts'

type Changes = Parameters<typeof changedFunctionRanges>[1]

export type DocumentTask =
  | { kind: 'markdown'; source: string }
  | { kind: 'functions'; before: string; after: string; original: Changes; modified: Changes }

export function processDocument(task: DocumentTask) {
  if (task.kind === 'markdown') return { kind: task.kind, markdown: parseMarkdown(task.source) }
  return {
    kind: task.kind,
    before: changedFunctionRanges(task.before, task.original),
    after: changedFunctionRanges(task.after, task.modified),
  }
}

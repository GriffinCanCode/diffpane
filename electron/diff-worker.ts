import { parentPort } from 'node:worker_threads'
import { decorations } from './changes.ts'
import type { DiffDecorations } from './changes.ts'

export interface DiffRequest {
  id: number
  before: string
  after: string
}

export type DiffReply = { id: number; ok: true; value: DiffDecorations } | { id: number; ok: false; error: string }

const port = parentPort
if (!port) throw new Error('Diff worker requires a parent port')

port.on('message', (input: unknown) => {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'number' ||
    !Number.isSafeInteger(input.id) ||
    input.id <= 0 ||
    !('before' in input) ||
    typeof input.before !== 'string' ||
    !('after' in input) ||
    typeof input.after !== 'string'
  )
    throw new Error('Invalid diff worker request.')
  const { id, before, after } = input
  let reply: DiffReply
  try {
    reply = { id, ok: true, value: decorations(before, after) }
  } catch (error) {
    reply = { id, ok: false, error: error instanceof Error ? error.message : 'Diff calculation failed.' }
  }
  port.postMessage(reply)
})

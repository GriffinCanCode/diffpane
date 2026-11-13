import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MAX_REVIEW_EXCERPT_LENGTH, MAX_REVIEW_EXCERPT_LINES, MAX_REVIEW_NOTE_LENGTH } from '../review-notes.ts'
import type { ReviewAnchor, ReviewNote, ReviewNoteChange } from '../review-notes.ts'
import type { LocalState, StateRecords } from './local-state.ts'

const MAX_NOTES = 250
const COLLECTION = 'review-notes'
const NOTE_ID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u

interface StoredNote extends ReviewNote {
  sequence: number
  scope: string | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function repositoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !value.includes('\0') &&
    !path.isAbsolute(value) &&
    !(path.sep === '\\' && /[\\:]/u.test(value)) &&
    value.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase()))
  )
}

function relativeScope(root: string, scope: string) {
  const relative = path.relative(root, scope).split(path.sep).join('/')
  if (!path.isAbsolute(root) || !path.isAbsolute(scope) || (relative && !repositoryPath(relative)))
    throw new Error('The open folder is outside the Git working tree.')
  return relative
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parseAnchor(value: unknown): ReviewAnchor | null {
  if (value === null) return null
  if (!record(value)) throw new Error('Invalid review note location.')
  const { path: filename, originalPath, side, line, endLine, excerpt, truncated } = value
  if (
    !repositoryPath(filename) ||
    (side !== 'working' && side !== 'head') ||
    (originalPath !== undefined && (side !== 'head' || !repositoryPath(originalPath))) ||
    typeof excerpt !== 'string' ||
    excerpt.length > MAX_REVIEW_EXCERPT_LENGTH ||
    typeof truncated !== 'boolean'
  )
    throw new Error('Invalid review note location.')
  const source: Omit<ReviewAnchor, 'line' | 'endLine'> = {
    path: filename,
    ...(originalPath === undefined ? {} : { originalPath }),
    side,
    excerpt,
    truncated,
  }
  if (line === null && endLine === null && excerpt === '' && !truncated) return { ...source, line, endLine }
  if (positiveInteger(line) && positiveInteger(endLine) && endLine >= line) {
    const excerptLines = excerpt.split('\n').length
    const selectedLines = endLine - line + 1
    if (
      excerptLines <= Math.min(selectedLines, MAX_REVIEW_EXCERPT_LINES) &&
      (truncated || excerptLines === selectedLines)
    )
      return { ...source, line, endLine }
  }
  throw new Error('Invalid review note location.')
}

function noteText(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > MAX_REVIEW_NOTE_LENGTH)
    throw new Error(`Enter a note up to ${MAX_REVIEW_NOTE_LENGTH.toLocaleString()} characters.`)
  return value.trim()
}

function storedNote(value: unknown): StoredNote {
  if (!record(value)) throw new Error('The saved review note is invalid.')
  const { id, sequence, scope, text, resolved } = value
  const anchor = parseAnchor(value.anchor)
  if (
    typeof id !== 'string' ||
    !NOTE_ID.test(id) ||
    !positiveInteger(sequence) ||
    typeof resolved !== 'boolean' ||
    (anchor ? scope !== null : scope !== '' && !repositoryPath(scope))
  )
    throw new Error('The saved review note is invalid.')
  return {
    id,
    anchor,
    sequence,
    scope: scope === null || typeof scope === 'string' ? scope : null,
    text: noteText(text),
    resolved,
  }
}

function parseChange(input: unknown): ReviewNoteChange {
  if (record(input)) {
    if (input.type === 'add') return { type: 'add', anchor: parseAnchor(input.anchor), text: noteText(input.text) }
    const { id } = input
    if (typeof id === 'string' && NOTE_ID.test(id)) {
      if (input.type === 'edit') {
        const expectedText = noteText(input.expectedText)
        if (expectedText === input.expectedText) return { type: 'edit', id, text: noteText(input.text), expectedText }
      }
      if (input.type === 'resolve' && typeof input.resolved === 'boolean')
        return { type: 'resolve', id, resolved: input.resolved }
      if (input.type === 'delete') return { type: 'delete', id }
    }
  }
  throw new Error('Invalid review note change.')
}

function importNotes(records: StateRecords, filename: string) {
  using database = new DatabaseSync(filename, { readOnly: true })
  const rows = database.prepare(
    'SELECT sequence, id, worktree, project_scope, anchor_path, anchor, text, resolved FROM review_notes',
  )
  for (const row of rows.iterate()) {
    const {
      sequence,
      id,
      worktree,
      project_scope: scope,
      anchor_path: anchorPath,
      anchor: encoded,
      text,
      resolved,
    } = row
    if (
      typeof sequence !== 'number' ||
      !positiveInteger(sequence) ||
      typeof id !== 'string' ||
      !NOTE_ID.test(id) ||
      typeof worktree !== 'string' ||
      (scope !== null && scope !== '' && !repositoryPath(scope)) ||
      (encoded !== null && typeof encoded !== 'string') ||
      (resolved !== 0 && resolved !== 1)
    )
      throw new Error('The saved review note is invalid.')
    const location: unknown = encoded === null ? null : JSON.parse(encoded)
    const anchor = parseAnchor(location)
    if (anchor ? anchorPath !== anchor.path || scope !== null : anchorPath !== null || scope === null)
      throw new Error('The saved review note has an invalid scope.')
    const note: StoredNote = { id, anchor, text: noteText(text), resolved: resolved === 1, sequence, scope }
    records.put(COLLECTION, worktree, id, note)
  }
}

function visible(note: StoredNote, scope: string) {
  if (!note.anchor) return note.scope === scope
  return scope === '' || note.anchor.path.startsWith(`${scope}/`)
}

function visibleNotes(notes: StoredNote[], scope: string): ReviewNote[] {
  return notes
    .filter(note => visible(note, scope))
    .toSorted((left, right) => right.sequence - left.sequence)
    .map(({ id, anchor, text, resolved }) => ({ id, anchor, text, resolved }))
}

export class ReviewNotesStore {
  private readonly state: LocalState
  private readonly legacyFilename: string
  private migration?: Promise<void>

  constructor(state: LocalState, legacyFilename: string) {
    this.state = state
    this.legacyFilename = legacyFilename
  }

  initialize() {
    this.migration ??= this.state
      .migrate(COLLECTION, this.legacyFilename, importNotes, { sqlite: true })
      .catch((error: unknown) => {
        this.migration = undefined
        throw error
      })
    return this.migration
  }

  async list(root: string, scope: string): Promise<ReviewNote[]> {
    const relative = relativeScope(root, scope)
    await this.initialize()
    return this.state.read(records => visibleNotes(records.list(COLLECTION, root).map(storedNote), relative))
  }

  async change(root: string, scope: string, input: unknown): Promise<ReviewNote[]> {
    const relative = relativeScope(root, scope)
    const change = parseChange(input)
    if (change.type === 'add' && change.anchor && relative && !change.anchor.path.startsWith(`${relative}/`))
      throw new Error('The review note location is outside the open folder.')
    await this.initialize()
    return this.state.write(records => {
      const notes = records.list(COLLECTION, root).map(storedNote)
      if (change.type === 'add') {
        if (notes.length >= MAX_NOTES)
          throw new Error(`This worktree has ${MAX_NOTES} review notes. Delete one to add another.`)
        const sequence = Math.max(0, ...notes.map(note => note.sequence)) + 1
        const note: StoredNote = {
          id: randomUUID(),
          anchor: change.anchor,
          text: change.text,
          resolved: false,
          sequence,
          scope: change.anchor ? null : relative,
        }
        records.put(COLLECTION, root, note.id, note)
        notes.push(note)
      } else {
        // A renderer that already knows an ID must still be in the note's scope.
        const index = notes.findIndex(note => note.id === change.id && visible(note, relative))
        const note = notes[index]
        if (!note) throw new Error('This review note is no longer available here.')
        if (change.type === 'delete') {
          records.delete(COLLECTION, root, note.id)
          notes.splice(index, 1)
        } else {
          if (change.type === 'edit') {
            if (note.text !== change.expectedText) throw new Error('This review note changed in another window.')
            note.text = change.text
          } else {
            note.resolved = change.resolved
          }
          records.put(COLLECTION, root, note.id, note)
        }
      }
      return visibleNotes(notes, relative)
    })
  }
}

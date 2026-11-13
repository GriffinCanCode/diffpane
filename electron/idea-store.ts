import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLOutputValue } from 'node:sqlite'
import { MAX_IDEA_BODY_LENGTH, MAX_IDEA_EXCERPT_LENGTH, MAX_IDEA_LINKS, MAX_IDEA_TITLE_LENGTH } from '../ideas.ts'
import type { Idea, IdeaLink } from '../ideas.ts'
import type { LocalState, StateRecords } from './local-state.ts'

const COLLECTION = 'ideas'
const SUMMARY_LIMIT = 25

function ideaId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))
    throw new Error('The idea has an invalid ID.')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15
}

function readLink(value: unknown): IdeaLink {
  if (!isRecord(value)) throw new Error('The idea has an invalid file link.')
  const { path: filename, line, endLine, side, excerpt, truncated } = value
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.length > 4096 ||
    filename.includes('\0') ||
    path.isAbsolute(filename) ||
    (path.sep === '\\' && /[\\:]/u.test(filename)) ||
    filename.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Choose a file inside this repository to link to an idea.')
  }
  if (
    (line !== undefined && !isLine(line)) ||
    (endLine !== undefined && (!isLine(endLine) || !isLine(line) || endLine < line))
  )
    throw new Error('The idea has an invalid line range.')
  if (side !== undefined && side !== 'head' && side !== 'working') throw new Error('The idea has an invalid file side.')
  if (excerpt !== undefined && (typeof excerpt !== 'string' || excerpt.length > MAX_IDEA_EXCERPT_LENGTH))
    throw new Error('The idea has an invalid code excerpt.')
  if (truncated !== undefined && typeof truncated !== 'boolean')
    throw new Error('The idea has an invalid code excerpt.')
  return {
    path: filename,
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(side === undefined ? {} : { side }),
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(truncated === undefined ? {} : { truncated }),
  }
}

function readIdea(value: unknown): Idea {
  if (!isRecord(value)) throw new Error('The idea could not be saved.')
  const { id, title, body, links, createdAt, updatedAt } = value
  if (typeof title !== 'string' || title.length > MAX_IDEA_TITLE_LENGTH)
    throw new Error(`Idea titles can be up to ${MAX_IDEA_TITLE_LENGTH} characters.`)
  if (typeof body !== 'string' || body.length > MAX_IDEA_BODY_LENGTH)
    throw new Error(`Idea notes can be up to ${MAX_IDEA_BODY_LENGTH} characters.`)
  if (!Array.isArray(links) || links.length > MAX_IDEA_LINKS)
    throw new Error(`An idea can have up to ${MAX_IDEA_LINKS} links.`)
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt) || updatedAt < createdAt)
    throw new Error('The idea has an invalid timestamp.')
  return { id: ideaId(id), title, body, links: Array.from(links, readLink), createdAt, updatedAt }
}

function storedIdea(records: StateRecords, workspace: string, id: string) {
  const value = records.get(COLLECTION, workspace, id)
  if (value === undefined) return undefined
  const idea = readIdea(value)
  if (idea.id !== id) throw new Error('The saved idea has an invalid ID.')
  return idea
}

function ideaFromRow(row: Record<string, SQLOutputValue>): Idea {
  const { id, title, body, links: encodedLinks, created_at: createdAt, updated_at: updatedAt } = row
  if (typeof encodedLinks !== 'string') throw new Error('The saved idea has invalid links.')
  const links: unknown = JSON.parse(encodedLinks)
  return readIdea({ id, title, body, links, createdAt, updatedAt })
}

function importIdeas(records: StateRecords, filename: string) {
  using database = new DatabaseSync(filename, { readOnly: true })
  const rows = database.prepare('SELECT workspace, id, title, body, links, created_at, updated_at FROM ideas')
  for (const row of rows.iterate()) {
    if (typeof row.workspace !== 'string') throw new Error('The saved idea has an invalid workspace.')
    const idea = ideaFromRow(row)
    records.put(COLLECTION, row.workspace, idea.id, idea)
  }
}

function compareIdeas(left: Idea, right: Idea) {
  const time = right.updatedAt - left.updatedAt
  if (time || left.id === right.id) return time
  return left.id < right.id ? -1 : 1
}

// Match the case folding SQLite used for idea searches.
function foldSearchText(value: string) {
  return value.replace(/[A-Z]/gu, character => character.toLowerCase())
}

export class IdeaStore {
  private readonly state: LocalState
  private readonly legacyFilename: string
  private migration?: Promise<void>

  constructor(state: LocalState, legacyFilename: string) {
    this.state = state
    this.legacyFilename = legacyFilename
  }

  initialize() {
    this.migration ??= this.state
      .migrate(COLLECTION, this.legacyFilename, importIdeas, { sqlite: true })
      .catch((error: unknown) => {
        this.migration = undefined
        throw error
      })
    return this.migration
  }

  async list(workspace: string) {
    await this.initialize()
    return this.state.read(records => records.list(COLLECTION, workspace).map(readIdea).toSorted(compareIdeas))
  }

  async summaries(workspace: string, query: string) {
    const term = foldSearchText(query)
    const matches = (await this.list(workspace)).filter(
      ({ title, body }) => !term || foldSearchText(title).includes(term) || foldSearchText(body).includes(term),
    )
    return {
      ideas: matches.slice(0, SUMMARY_LIMIT).map(({ id, title }) => ({ id, title })),
      truncated: matches.length > SUMMARY_LIMIT,
    }
  }

  async get(workspace: string, id: unknown) {
    const key = ideaId(id)
    await this.initialize()
    return this.state.read(records => storedIdea(records, workspace, key))
  }

  async applyDraft(workspace: string, value: Idea, expected?: Idea) {
    const idea = readIdea(value)
    await this.initialize()
    return this.state.write(records => {
      const previous = storedIdea(records, workspace, idea.id)
      const matches =
        expected &&
        previous &&
        previous.createdAt === expected.createdAt &&
        previous.updatedAt === expected.updatedAt &&
        previous.title === expected.title &&
        previous.body === expected.body
      if (expected ? !matches : previous !== undefined) {
        throw new Error('This idea changed after Claude read it. Discard the proposal and request a new one.')
      }
      const saved = previous
        ? readIdea({ ...previous, title: idea.title, body: idea.body, updatedAt: idea.updatedAt })
        : idea
      records.put(COLLECTION, workspace, saved.id, saved)
      return saved
    })
  }

  async upsert(workspace: string, value: unknown) {
    const idea = readIdea(value)
    await this.initialize()
    return this.state.write(records => {
      const previous = storedIdea(records, workspace, idea.id)
      if (previous) {
        idea.createdAt = previous.createdAt
        idea.updatedAt = Math.max(idea.createdAt, idea.updatedAt)
      }
      records.put(COLLECTION, workspace, idea.id, idea)
      return idea
    })
  }

  async delete(workspace: string, id: unknown) {
    const key = ideaId(id)
    await this.initialize()
    return this.state.write(records => records.delete(COLLECTION, workspace, key))
  }
}

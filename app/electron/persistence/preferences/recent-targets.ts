import { openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { LocalState } from '../database/local-state.ts'

export interface RecentTarget {
  path: string
  name: string
  kind: 'folder' | 'file'
  openedAt: number
}

const LIMIT = 8
const MAX_PENDING = 64
const MAX_LEGACY_SIZE = 1024 * 1024
const COLLECTION = 'recents'
type Mutation = { entry: RecentTarget } | { remove: string }

function recentTargets(input: unknown): RecentTarget[] {
  if (!Array.isArray(input)) throw new Error('Invalid recent targets.')
  const seen = new Set<string>()
  return input
    .flatMap((entry: unknown): RecentTarget[] => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('path' in entry) ||
        !('kind' in entry) ||
        !('openedAt' in entry) ||
        typeof entry.path !== 'string' ||
        !path.isAbsolute(entry.path) ||
        entry.path.includes('\0') ||
        (entry.kind !== 'folder' && entry.kind !== 'file') ||
        typeof entry.openedAt !== 'number' ||
        !Number.isFinite(entry.openedAt) ||
        entry.openedAt <= 0
      )
        return []
      const filename = path.resolve(entry.path)
      return [{ path: filename, name: path.basename(filename) || filename, kind: entry.kind, openedAt: entry.openedAt }]
    })
    .toSorted((left, right) => right.openedAt - left.openedAt)
    .filter(entry => {
      if (seen.has(entry.path)) return false
      seen.add(entry.path)
      return true
    })
    .slice(0, LIMIT)
}

function apply(entries: RecentTarget[], mutations: Mutation[]) {
  for (const mutation of mutations) {
    if ('remove' in mutation) entries = entries.filter(entry => entry.path !== mutation.remove)
    else {
      const previous = entries.find(entry => entry.path === mutation.entry.path)
      if (!previous || previous.openedAt <= mutation.entry.openedAt)
        entries = [mutation.entry, ...entries.filter(entry => entry.path !== mutation.entry.path)].toSorted(
          (left, right) => right.openedAt - left.openedAt,
        )
    }
    entries = entries.slice(0, LIMIT)
  }
  return entries
}

class InvalidLegacyHistory extends Error {}

function readLegacy(filename: string) {
  const file = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    if (fstatSync(file).size > MAX_LEGACY_SIZE)
      throw new InvalidLegacyHistory('Previous recent history is too large to import.')
    const data = readFileSync(file, 'utf8')
    try {
      return recentTargets(JSON.parse(data))
    } catch (error) {
      throw new InvalidLegacyHistory('Previous recent history is unreadable and was kept for recovery.', {
        cause: error,
      })
    }
  } finally {
    closeSync(file)
  }
}

/** History remains usable in memory while its optional disk store is unavailable. */
export class RecentTargets {
  private readonly state: LocalState
  private readonly legacyFilename: string
  private readonly onError?: (error: unknown) => void
  private entries: RecentTarget[] = []
  private pending: Mutation[] = []
  private operations = Promise.resolve<unknown>(undefined)
  private initialized?: Promise<void>
  private reportedFailure = false

  constructor(state: LocalState, legacyFilename: string, onError?: (error: unknown) => void) {
    this.state = state
    this.legacyFilename = legacyFilename
    this.onError = onError
  }

  initialize() {
    this.initialized ??= this.state
      .migrate(COLLECTION, this.legacyFilename, (records, filename) => {
        const history = readLegacy(filename)
        if (records.get(COLLECTION, '', 'history') === undefined) records.put(COLLECTION, '', 'history', history)
      })
      .catch((error: unknown) => {
        if (error instanceof InvalidLegacyHistory) {
          this.onError?.(error)
          return
        }
        this.initialized = undefined
        throw error
      })
    return this.initialized
  }

  list() {
    return this.serialize(async () => {
      await this.refresh()
      return this.entries.map(entry => ({ ...entry }))
    })
  }

  record(target: string) {
    const filename = path.resolve(target)
    return this.serialize(async () => {
      const info = await stat(filename).catch(() => null)
      if (!info?.isFile() && !info?.isDirectory()) return
      await this.refresh({
        entry: {
          path: filename,
          name: path.basename(filename) || filename,
          kind: info.isFile() ? 'file' : 'folder',
          openedAt: Date.now(),
        },
      })
    })
  }

  remove(target: string) {
    return this.serialize(() => this.refresh({ remove: path.resolve(target) }))
  }

  private serialize<T>(run: () => Promise<T>) {
    const result = this.operations.then(run)
    this.operations = result.catch(() => {})
    return result
  }

  private async refresh(mutation?: Mutation) {
    if (mutation) this.pending = [...this.pending, mutation].slice(-MAX_PENDING)
    try {
      await this.initialize()
      const access = this.pending.length ? this.state.write.bind(this.state) : this.state.read.bind(this.state)
      this.entries = await access(records => {
        const saved = recentTargets(records.get(COLLECTION, '', 'history') ?? [])
        if (!this.pending.length) return saved
        const next = apply(saved, this.pending)
        if (JSON.stringify(saved) !== JSON.stringify(next)) records.put(COLLECTION, '', 'history', next)
        return next
      })
      this.pending = []
      this.reportedFailure = false
    } catch (error) {
      this.entries = apply(this.entries, this.pending)
      if (!this.reportedFailure) this.onError?.(error)
      this.reportedFailure = true
    }
  }
}

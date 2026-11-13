// MONOLITHIC: Git inventory, content, checkpoint and save paths share repository confinement and byte limits. Extract checkpoint storage once its captured-identity and read-budget contract is independent.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { mediaType } from '../../../shared/documents/media-types.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import {
  checkClaudeFile,
  claudeFilePath,
  claudeVisiblePath,
  MAX_CLAUDE_FILE_BYTES,
} from '../../tools/assistant/claude-workspace.mjs'
import {
  encodeText,
  fileByteView,
  fileContent,
  MAX_FILE_BYTES,
  readLimit,
  searchableText,
} from '../documents/file-content.ts'

/** @import { BigIntStats } from 'node:fs' */
/** @import { FileHandle } from 'node:fs/promises' */
/** @import { FileContent } from '../documents/file-content.ts' */
/** @import { WorkspaceFile } from '../../runtime/session/workspace-types.ts' */
/** @typedef {Parameters<typeof fileContent>[0]} ContentBytes */
/** @typedef {{bytes: Buffer, size: number}} BlobContents */
/** @typedef {{value: Promise<BlobContents>, bytes: number}} CachedBlob */
/** @typedef {WorkspaceFile & {originalPath: string | null, index: string, worktree: string, conflicted: boolean, submodule: boolean}} InventoryEntry */
/** @typedef {InventoryEntry & {statusKey: string}} StatusFile */
/** @typedef {{branch: string, head: string | null, files: StatusFile[]}} RepositoryStatus */
/** @typedef {{mode: string, oid: string}} TreeEntry */
/** @typedef {{mode: string, stamp: string, oid?: string, content?: ContentBytes}} CheckpointFile */
/** @typedef {{capturedAt: number, head: string | null, algorithm: string, paths: Map<string, CheckpointFile | null>, current: Map<string, CheckpointFile | null>, baseline: Map<string, TreeEntry | null>, committed: {head: string | null, paths: Set<string>} | null}} Checkpoint */
/** @typedef {{bytes: number, previews?: number}} CheckpointBudget */
/** @typedef {{algorithm?: string, budget?: CheckpointBudget, cached?: CheckpointFile | null, capture?: boolean}} CheckpointRead */
/** @typedef {{before: string, after: string, note: string | null, preview?: {before: FileContent, after: FileContent}, workingMissing?: boolean}} RepositoryContents */
/** @typedef {{code: number | null, signal: NodeJS.Signals | null, limited: boolean, stdout: Buffer, stderr: Buffer}} CommandOutput */

const MAX_STATUS_BYTES = 16 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const MAX_CONTENT_SEARCH_PATHS = 50_000
const MAX_CHECKPOINT_PATHS = 2_000
const MAX_CHECKPOINT_PREVIEWS = 32 * 1024 * 1024
const MAX_CHECKPOINT_FILE = 512 * 1024 * 1024
const MAX_CHECKPOINT_SCAN = 1024 * 1024 * 1024
const statusArguments = [
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--renames',
]
const workingReadFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function empty() {
  return Buffer.alloc(0)
}
/** @param {string | null} note @returns {RepositoryContents} */
function unavailable(note) {
  return { before: '', after: '', note }
}
/** @param {string} left @param {string} right */
function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** @param {Set<string>} paths */
function checkCheckpointPathCount(paths) {
  if (paths.size > MAX_CHECKPOINT_PATHS) throw new Error('The checkpoint needs to compare more than 2,000 paths.')
}

/** @param {BigIntStats} metadata */
function checkpointStamp({ dev, ino, mode, size, mtimeNs, ctimeNs }) {
  return `${dev}:${ino}:${mode}:${size}:${mtimeNs}:${ctimeNs}`
}

/** @param {string} filename */
function checkpointReadChanged(filename) {
  return Object.assign(new Error(`${filename} changed while reading the checkpoint. Try again.`), {
    code: 'CHECKPOINT_READ_CHANGED',
  })
}

function saveConflict() {
  return appError('The file changed on disk. Your edits are still open and have not overwritten it.', {
    code: 'SAVE_CONFLICT',
  })
}

/** @param {FileHandle} handle @param {number} size */
async function readSaveBytes(handle, size) {
  const bytes = Buffer.allocUnsafe(size + 1)
  let offset = 0
  while (offset < bytes.length) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Read by position so retries can inspect the same descriptor.
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  return bytes.subarray(0, offset)
}

/** @param {FileHandle} handle @param {Buffer} bytes @param {(offset: number) => void} [progress] */
async function writeSaveBytes(handle, bytes, progress) {
  let offset = 0
  while (offset < bytes.length) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The next write starts after the actual bytes written by this write.
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    if (!bytesWritten) throw new Error('The file write did not complete.')
    offset += bytesWritten
    progress?.(offset)
  }
  await handle.truncate(bytes.length)
  await handle.sync()
}

/** @param {FileHandle} handle @param {Buffer} original @param {Buffer} bytes @param {number} written @param {() => Promise<string | undefined>} currentStamp */
async function restoreSave(handle, original, bytes, written, currentStamp) {
  const latest = await handle.stat({ bigint: true })
  if (latest.size > MAX_FILE_BYTES) return false
  const actual = await readSaveBytes(handle, Number(latest.size))
  if (checkpointStamp(latest) !== (await currentStamp())) return false
  if (actual.equals(original)) return true
  // Restore the prior bytes only if the file still matches a state our
  // completed writes produced. A replacement or external edit wins.
  const partial = Buffer.concat([bytes.subarray(0, written), original.subarray(written)])
  if (!actual.equals(partial) && !(written === bytes.length && actual.equals(bytes))) return false
  await writeSaveBytes(handle, original)
  return true
}

export class Repository {
  /** @type {Map<string, Promise<void>>} */
  #saves = new Map()
  /** @type {Set<string> | undefined} */
  inventoryDirectories
  /** @type {string | undefined} */
  statusFingerprint

  /** @param {string} root @param {string} scope @param {string} gitDir @param {string} commonDir */
  constructor(root, scope, gitDir, commonDir) {
    this.root = root
    this.scope = scope
    this.gitDir = gitDir
    this.commonDir = commonDir
    /** @type {Map<string, CachedBlob>} */
    this.blobs = new Map()
    this.blobBytes = 0
    /** @type {Map<string, InventoryEntry>} */
    this.inventoryMetadata = new Map()
    /** @type {Set<string>} */
    this.expandedIgnored = new Set()
  }

  /** @param {string} directory */
  static async open(directory) {
    let scope = await realpath(directory)
    if ((await lstat(scope)).isFile()) scope = path.dirname(scope)
    const root = await realpath(await gitPath(scope, ['rev-parse', '--show-toplevel']))
    const [gitDir, commonDir] = await Promise.all([
      gitPath(root, ['rev-parse', '--absolute-git-dir']),
      gitPath(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    if (!within(root, scope)) throw new Error('The selected directory is outside the Git working tree.')
    return new Repository(root, scope, gitDir, commonDir)
  }

  /** @param {boolean} trackFingerprint */
  async #status(trackFingerprint) {
    const bytes = await git(this.root, statusArguments, MAX_STATUS_BYTES)
    const snapshot = parseStatus(bytes)
    // Polling also needs HEAD and staged blob changes that keep the same status
    // letters. Keep this internal instead of resending Git records to the UI.
    if (trackFingerprint) this.statusFingerprint = bytes.toString('utf8')
    const scope = path.relative(this.root, this.scope).split(path.sep).join('/')
    /** @param {string} name */
    const scoped = name => !scope || name === scope || name.startsWith(`${scope}/`)
    snapshot.files = snapshot.files.filter(
      file => scoped(file.path) || (file.originalPath !== null && scoped(file.originalPath)),
    )
    return snapshot
  }

  snapshot() {
    return this.#status(true)
  }

  /** @param {string} filename */
  #checkpointIncludes(filename) {
    validatePath(filename)
    const absolute = path.join(this.root, filename)
    return (
      absolute !== this.scope &&
      !filename.split('/').some(part => part.toLowerCase() === '.git') &&
      within(this.scope, absolute) &&
      ![this.gitDir, this.commonDir].some(directory => within(directory, absolute))
    )
  }

  /** @param {RepositoryStatus} status */
  #checkpointStatusPaths(status) {
    /** @type {Set<string>} */
    const paths = new Set()
    for (const file of status.files) {
      if (file.submodule) continue
      if (this.#checkpointIncludes(file.path)) paths.add(file.path)
      if (file.originalPath && this.#checkpointIncludes(file.originalPath)) paths.add(file.originalPath)
      checkCheckpointPathCount(paths)
    }
    return paths
  }

  /** @returns {Promise<Checkpoint>} */
  async captureCheckpoint() {
    const status = await this.#status(false)
    const candidates = this.#checkpointStatusPaths(status)
    const algorithm = status.head
      ? status.head.length === 64
        ? 'sha256'
        : 'sha1'
      : await gitPath(this.root, ['rev-parse', '--show-object-format'])
    const budget = { bytes: 0, previews: 0 }
    /** @type {Map<string, CheckpointFile | null>} */
    const paths = new Map()
    // Git already retains clean paths in HEAD. Copy only paths whose working version may differ.
    for (const filename of candidates)
      // oxlint-disable-next-line eslint/no-await-in-loop -- The shared checkpoint byte and preview budgets are consumed in sequence.
      paths.set(filename, await this.#readCheckpointFile(filename, { algorithm, budget, capture: true }))

    const latest = await this.#status(false)
    const latestPaths = this.#checkpointStatusPaths(latest)
    if (
      latest.head !== status.head ||
      latestPaths.size !== paths.size ||
      [...paths.keys()].some(filename => !latestPaths.has(filename))
    )
      throw new Error('The working tree changed while capturing the checkpoint. Try again.')
    for (const [filename, captured] of paths) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Keep checkpoint validation bounded to one file descriptor at a time.
      const entry = await this.#checkpointEntry(filename)
      if (entry?.stamp !== captured?.stamp)
        throw new Error('The working tree changed while capturing the checkpoint. Try again.')
    }
    return {
      capturedAt: Date.now(),
      head: status.head,
      algorithm,
      paths,
      current: new Map(paths),
      baseline: new Map(),
      committed: null,
    }
  }

  /** @param {Checkpoint} checkpoint @param {RepositoryStatus} status @returns {Promise<StatusFile[]>} */
  async checkpointFiles(checkpoint, status) {
    const candidates = this.#checkpointStatusPaths(status)
    const byPath = new Map(status.files.map(file => [file.path, file]))
    for (const filename of checkpoint.paths.keys()) candidates.add(filename)
    if (checkpoint.head !== status.head) {
      if (checkpoint.committed?.head !== status.head) {
        checkpoint.committed = {
          head: status.head,
          paths: await this.#checkpointCommitPaths(checkpoint.head, status.head),
        }
      }
      for (const filename of checkpoint.committed.paths) candidates.add(filename)
    }
    checkCheckpointPathCount(candidates)
    const unresolved = [...candidates].filter(
      filename => !checkpoint.paths.has(filename) && !checkpoint.baseline.has(filename),
    )
    const entries = await this.#checkpointTreeEntries(checkpoint.head, unresolved)
    /** @type {Map<string, TreeEntry | null>} */
    const baseline = new Map()
    /** @type {Map<string, CheckpointFile>} */
    const current = new Map()
    /** @type {StatusFile[]} */
    const files = []
    const budget = { bytes: 0 }
    for (const filename of [...candidates].toSorted(comparePaths)) {
      const captured = checkpoint.paths.has(filename)
      const before = captured
        ? (checkpoint.paths.get(filename) ?? null)
        : (checkpoint.baseline.get(filename) ?? entries.get(filename) ?? null)
      if (!captured) baseline.set(filename, checkpoint.baseline.get(filename) ?? entries.get(filename) ?? null)
      const workingStatus = byPath.get(filename)
      if (before?.mode === '160000' || workingStatus?.submodule) continue
      const options = { algorithm: checkpoint.algorithm, budget, cached: checkpoint.current.get(filename) }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Scan paths in order against a shared byte budget.
      const after = await this.#readCheckpointFile(filename, options).catch((/** @type {unknown} */ error) => {
        if (errorCode(error) !== 'CHECKPOINT_READ_CHANGED') throw error
        // An atomic editor save can replace the path between stat and open.
        return this.#readCheckpointFile(filename, options)
      })
      if (after) current.set(filename, after)
      if (before?.oid === after?.oid && before?.mode === after?.mode) continue
      const worktree = !before ? 'A' : !after ? 'D' : before.mode.slice(0, 2) !== after.mode.slice(0, 2) ? 'T' : 'M'
      files.push({
        path: filename,
        originalPath: null,
        index: ' ',
        worktree,
        conflicted: Boolean(workingStatus?.conflicted),
        submodule: false,
        statusKey: `${workingStatus?.conflicted ? 'conflict:' : ''}${after ? `${after.mode}:${after.oid}` : 'absent'}`,
      })
    }
    checkpoint.baseline = baseline
    checkpoint.current = current
    return files
  }

  /** @param {Checkpoint} checkpoint @param {WorkspaceFile} file @returns {Promise<RepositoryContents>} */
  async checkpointContents(checkpoint, file) {
    const filename = file.path
    if (!this.#checkpointIncludes(filename)) throw new Error('This path is outside the checkpoint workspace.')
    const captured = checkpoint.paths.has(filename)
    const capturedFile = checkpoint.paths.get(filename)
    const baseline = captured
      ? undefined
      : checkpoint.baseline.has(filename)
        ? checkpoint.baseline.get(filename)
        : (await this.#checkpointTreeEntries(checkpoint.head, [filename])).get(filename)
    const beforeFile = capturedFile ?? baseline
    if (file.submodule || beforeFile?.mode === '160000')
      return unavailable('Git submodule. Open the submodule directory to inspect its files.')
    const [before, after] = await Promise.all([
      captured ? capturedFile?.content : baseline ? this.#blobContents(baseline.oid, filename) : undefined,
      this.#readCheckpointFile(filename),
    ])
    const contents = comparedContents(before ?? empty(), after?.content ?? empty(), filename, filename, file.conflicted)
    if (!contents.note && !contents.preview) {
      if (!beforeFile && after && !contents.after) contents.note = 'An empty file was added.'
      else if (beforeFile && !after && !contents.before) contents.note = 'An empty file was deleted.'
      else if (beforeFile && after && beforeFile.mode !== after.mode) {
        if (beforeFile.mode === '120000' || after.mode === '120000')
          contents.note = after.mode === '120000' ? 'Changed to a symbolic link.' : 'Changed to a regular file.'
        else contents.note = after.mode === '100755' ? 'Executable permission added.' : 'Executable permission removed.'
      }
    }
    return { ...contents, workingMissing: !after }
  }

  /** @param {string | null} before @param {string | null} after */
  async #checkpointCommitPaths(before, after) {
    const relative = path.relative(this.root, this.scope).split(path.sep).join('/')
    if (!before && !after) return new Set(/** @type {string[]} */ ([]))
    const args =
      before && after
        ? ['diff-tree', '-r', '--name-only', '--no-renames', '--no-commit-id', '-z', before, after]
        : ['ls-tree', '-r', '--name-only', '--full-tree', '-z', before ?? after ?? '']
    const bytes = await git(this.root, [...args, '--', ...(relative ? [relative] : [])], MAX_STATUS_BYTES)
    /** @type {Set<string>} */
    const paths = new Set()
    for (const filename of decoder.decode(bytes).split('\0')) {
      if (filename && this.#checkpointIncludes(filename)) paths.add(filename)
      checkCheckpointPathCount(paths)
    }
    return paths
  }

  /** @param {string | null} head @param {readonly string[]} paths */
  async #checkpointTreeEntries(head, paths) {
    /** @type {Map<string, TreeEntry>} */
    const entries = new Map()
    if (!head) return entries
    const wanted = new Set(paths)
    // Bound argument sizes even when the repository has long path names.
    /** @type {string[]} */
    let batch = []
    let batchBytes = 0
    const read = async () => {
      const bytes = await git(this.root, ['ls-tree', '--full-tree', '-z', head, '--', ...batch], MAX_STATUS_BYTES)
      for (const record of decoder.decode(bytes).split('\0')) {
        if (!record) continue
        const separator = record.indexOf('\t')
        const filename = record.slice(separator + 1)
        if (!wanted.has(filename)) continue
        const [mode, type, oid] = record.slice(0, separator).split(' ')
        if (!mode || !type || !oid) throw new Error('Invalid Git tree entry.')
        if (type !== 'tree') entries.set(filename, { mode, oid })
      }
      batch = []
      batchBytes = 0
    }
    for (const filename of paths) {
      const length = Buffer.byteLength(filename) + 1
      // oxlint-disable-next-line eslint/no-await-in-loop -- Flush each bounded Git argument batch before reusing it.
      if (batchBytes + length > 32 * 1024 && batch.length) await read()
      batch.push(filename)
      batchBytes += length
    }
    if (batch.length) await read()
    return entries
  }

  /** @param {string} filename */
  async #checkpointEntry(filename) {
    const absolute = path.join(this.root, filename)
    const parent = path.dirname(absolute)
    try {
      const resolvedParent = await realpath(parent)
      if (
        !within(this.scope, resolvedParent) ||
        resolvedParent.split(path.sep).some(part => part.toLowerCase() === '.git') ||
        [this.gitDir, this.commonDir].some(directory => within(directory, resolvedParent)) ||
        (parent !== resolvedParent && !(await realDirectories(this.scope, parent)))
      )
        return null
      const metadata = await lstat(absolute, { bigint: true })
      if (metadata.isDirectory()) return null
      if (!metadata.isFile() && !metadata.isSymbolicLink())
        throw new Error(`Cannot include ${filename} because it is not a regular file or symbolic link.`)
      const mode = metadata.isSymbolicLink() ? '120000' : metadata.mode & 0o100n ? '100755' : '100644'
      return { absolute, metadata, mode, stamp: checkpointStamp(metadata) }
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  /** @param {string} filename @param {CheckpointRead} [options] @returns {Promise<CheckpointFile | null>} */
  async #readCheckpointFile(filename, { algorithm, budget, cached, capture = false } = {}) {
    const entry = await this.#checkpointEntry(filename)
    if (!entry) return null
    const { absolute, metadata, mode, stamp } = entry
    if (cached?.stamp === stamp) return cached
    const size = Number(metadata.size)
    if (budget && (size > MAX_CHECKPOINT_FILE || budget.bytes + size > MAX_CHECKPOINT_SCAN))
      throw new Error(`Checkpoint scan exceeds its file or total read limit at ${filename}.`)
    if (budget) budget.bytes += size
    const hash = algorithm ? createHash(algorithm).update(`blob ${size}\0`) : undefined
    const streamed = !budget && Boolean(mediaType(filename))
    const limit = capture || !budget ? Math.min(size, streamed ? 64 * 1024 : readLimit(filename)) : 0
    if (capture) {
      if (!budget) throw new Error('Checkpoint capture requires a preview budget.')
      budget.previews = (budget.previews ?? 0) + limit
      if (budget.previews > MAX_CHECKPOINT_PREVIEWS)
        throw new Error('The checkpoint needs more than 32 MiB of preview data.')
    }
    if (mode === '120000') {
      const bytes = await readlink(absolute, { encoding: 'buffer' })
      if ((await this.#checkpointEntry(filename))?.stamp !== stamp || bytes.length !== size)
        throw checkpointReadChanged(filename)
      return {
        stamp,
        mode,
        oid: hash?.update(bytes).digest('hex'),
        ...(capture || !budget ? { content: bytes } : {}),
      }
    }
    const handle = await open(absolute, workingReadFlags).catch((/** @type {unknown} */ error) => {
      if (missing(error) || errorCode(error) === 'ELOOP') throw checkpointReadChanged(filename)
      throw error
    })
    try {
      if (
        checkpointStamp(await handle.stat({ bigint: true })) !== stamp ||
        (await this.#checkpointEntry(filename))?.stamp !== stamp
      )
        throw checkpointReadChanged(filename)
      const bytes = limit ? Buffer.allocUnsafe(limit) : empty()
      let offset = 0
      const length = hash ? size : limit
      if (length) {
        for await (const raw of handle.createReadStream({
          autoClose: false,
          start: 0,
          end: length - 1,
        })) {
          const chunk = /** @type {unknown} */ (raw)
          if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected checkpoint stream data.')
          hash?.update(chunk)
          if (offset < limit) chunk.copy(bytes, offset, 0, Math.min(chunk.length, limit - offset))
          offset += chunk.length
        }
      }
      if (offset !== length || checkpointStamp(await handle.stat({ bigint: true })) !== stamp)
        throw checkpointReadChanged(filename)
      return {
        stamp,
        mode,
        oid: hash?.digest('hex'),
        ...(capture || !budget ? { content: { bytes, size, streamed } } : {}),
      }
    } finally {
      await handle.close()
    }
  }

  /** @param {boolean} changed @param {AbortSignal} signal */
  async contentSearchPaths(changed, signal) {
    const relative = path.relative(this.root, this.scope)
    const scope = relative ? [relative] : []
    const args = changed ? statusArguments : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']
    const output = await command(this.root, [...args, '--', ...scope], MAX_STATUS_BYTES, undefined, {
      signal,
      truncate: !changed,
    }).catch((/** @type {unknown} */ error) => {
      if (errorCode(error) === 'OUTPUT_LIMIT') return null
      throw error
    })
    if (!output) return { paths: [], truncated: true }
    const bytes = successful(output)
    if (changed) {
      const { files } = parseStatus(bytes)
      const paths = files
        .filter(file => !file.submodule && (file.index !== 'D' || file.worktree === '?'))
        .map(file => file.path)
      return {
        paths: paths.slice(0, MAX_CONTENT_SEARCH_PATHS),
        truncated: paths.length > MAX_CONTENT_SEARCH_PATHS,
      }
    }
    /** @type {Set<string>} */
    const paths = new Set()
    let start = 0
    for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
      paths.add(decoder.decode(bytes.subarray(start, end)))
      if (paths.size > MAX_CONTENT_SEARCH_PATHS) {
        return {
          paths: [...paths].slice(0, MAX_CONTENT_SEARCH_PATHS).toSorted(comparePaths),
          truncated: true,
        }
      }
      start = end + 1
    }
    return { paths: [...paths].toSorted(comparePaths), truncated: output.limited }
  }

  /** @param {string} filename @param {AbortSignal} signal */
  async contentSearchFile(filename, signal) {
    validatePath(filename)
    const absolute = path.join(this.root, filename)
    if (
      filename.split('/').includes('.git') ||
      !within(this.scope, absolute) ||
      [this.gitDir, this.commonDir].some(directory => within(directory, absolute)) ||
      readLimit(filename) > MAX_FILE_BYTES
    )
      return null
    let handle
    try {
      signal.throwIfAborted()
      handle = await open(absolute, workingReadFlags)
      const metadata = await handle.stat()
      if (!metadata.isFile() || !metadata.size || metadata.size > MAX_FILE_BYTES) return null
      const parent = path.dirname(absolute)
      const [current, resolvedParent] = await Promise.all([lstat(absolute), realpath(parent)])
      // Check the open descriptor against the current confined path before reading any bytes.
      if (
        !current.isFile() ||
        current.dev !== metadata.dev ||
        current.ino !== metadata.ino ||
        !within(this.scope, resolvedParent) ||
        [this.gitDir, this.commonDir].some(directory => within(directory, resolvedParent)) ||
        (resolvedParent !== parent && !(await realDirectories(this.scope, parent)))
      )
        return null
      const bytes = Buffer.allocUnsafe(metadata.size + 1)
      let length = 0
      while (length < metadata.size) {
        signal.throwIfAborted()
        // oxlint-disable-next-line eslint/no-await-in-loop -- The next read starts at the actual byte count returned by this read.
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      signal.throwIfAborted()
      if (length !== metadata.size) return { text: null, bytes: length }
      return {
        text: searchableText(bytes.subarray(0, length), filename),
        bytes: length,
      }
    } catch (error) {
      if (missing(error) || /^(?:ELOOP|EACCES|EPERM)$/u.test(errorCode(error) ?? '')) return null
      throw error
    } finally {
      await handle?.close()
    }
  }

  /** @returns {Promise<InventoryEntry[]>} */
  async files() {
    const scope = path.relative(this.root, this.scope).split(path.sep).join('/')
    const bytes = await git(
      this.root,
      [
        'ls-files',
        '--stage',
        '--cached',
        '--deleted',
        '--others',
        '--exclude-standard',
        '-t',
        '-z',
        '--',
        ...(scope ? [scope] : []),
      ],
      MAX_STATUS_BYTES,
    )
    let source
    try {
      source = decoder.decode(bytes)
    } catch {
      throw new Error('Git returned a filename that is not valid UTF-8.')
    }
    const scopePrefix = `${scope}/`
    /** @type {Map<string, InventoryEntry>} */
    const files = new Map()
    /** @type {Set<string>} */
    const deleted = new Set()
    for (const record of source.split('\0')) {
      if (!record) continue
      // Tags distinguish untracked names from the fixed index metadata, even when a name resembles that metadata.
      const untracked = record.startsWith('? ')
      const separator = untracked ? 1 : record.indexOf('\t')
      if (record[1] !== ' ' || separator < 0) throw new Error('Invalid Git file inventory record.')
      const filename = record.slice(separator + 1)
      if (record.startsWith('R ')) {
        deleted.add(filename)
        continue
      }
      const prior = this.inventoryMetadata.get(filename)
      // A retained path was validated when it first entered this repository's inventory.
      if (!prior) validatePath(filename)
      if (scope && filename !== scope && !filename.startsWith(scopePrefix)) continue
      const submodule = !untracked && record.slice(2, 8) === '160000'
      const existing = files.get(filename)
      if (existing) {
        if (submodule && !existing.submodule) files.set(filename, { ...existing, submodule: true })
      } else
        files.set(
          filename,
          prior && !prior.ignored && prior.submodule === submodule
            ? prior
            : {
                path: filename,
                originalPath: null,
                index: ' ',
                worktree: ' ',
                conflicted: false,
                submodule,
              },
        )
    }
    // --cached retains missing tracked paths; --deleted marks those entries separately.
    // Keep deletions in Git status, but remove them from the filesystem explorer and picker.
    for (const filename of deleted) files.delete(filename)
    /** @param {string} filename @param {boolean} directory */
    const addIgnored = (filename, directory) => {
      if (files.has(filename)) return
      validatePath(filename)
      if (scope && filename !== scope && !filename.startsWith(scopePrefix)) return
      const prior = this.inventoryMetadata.get(filename)
      files.set(
        filename,
        prior?.ignored && prior.directory === directory
          ? prior
          : {
              path: filename,
              originalPath: null,
              index: ' ',
              worktree: ' ',
              conflicted: false,
              submodule: false,
              ignored: true,
              directory,
            },
      )
    }
    // Inspect only known, nonignored parents. Git's recursive ignored listing can
    // walk an entire dependency tree when it contains even one tracked exception.
    const directories = new Set([scope])
    for (const filename of files.keys()) {
      let directory = path.posix.dirname(filename)
      while (directory !== '.' && !directories.has(directory)) {
        directories.add(directory)
        directory = path.posix.dirname(directory)
      }
    }
    const ignoredDirectories = await this.#ignored([...directories].filter(Boolean))
    for (const directory of ignoredDirectories) {
      if (!ignoredDirectories.has(path.posix.dirname(directory))) addIgnored(directory, true)
    }
    /** @param {readonly string[]} parents */
    const discover = async parents => {
      /** @type {Map<string, boolean>} */
      const candidates = new Map()
      let nextParent = 0
      await Promise.all(
        Array.from({ length: Math.min(8, parents.length) }, async () => {
          while (nextParent < parents.length) {
            const directory = parents[nextParent++]
            if (directory === undefined) break
            // oxlint-disable-next-line eslint/no-await-in-loop -- This loop is one worker in the bounded inventory pool.
            for (const entry of await this.#directoryEntries(directory)) {
              if (entry.name === '.git') continue
              const filename = directory ? `${directory}/${entry.name}` : entry.name
              if (!files.has(filename) && !directories.has(filename)) candidates.set(filename, entry.isDirectory())
            }
          }
        }),
      )
      return candidates
    }
    let candidates = await discover([...directories].filter(directory => !ignoredDirectories.has(directory)))
    while (candidates.size) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Ignore status determines which directories the next level may visit.
      const ignored = await this.#ignored([...candidates.keys()])
      const parents = []
      for (const [filename, directory] of candidates) {
        if (ignored.has(filename)) addIgnored(filename, directory)
        else if (directory) {
          // A nonignored parent may contain only ignored files, so Git's normal
          // catalog has no record of it. Stop as soon as an ignored folder appears.
          directories.add(filename)
          parents.push(filename)
        }
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Advance one directory level after the prior level settles.
      candidates = await discover(parents)
    }
    this.inventoryDirectories = new Set([...directories].filter(directory => !ignoredDirectories.has(directory)))
    // Only explicit expansions read directory entries. Never walk dependency trees.
    if (scope && files.get(scope)?.directory && !this.inventoryMetadata.has(scope)) this.expandedIgnored.add(scope)
    for (const directory of [...this.expandedIgnored].toSorted((a, b) => a.length - b.length)) {
      if (!files.get(directory)?.directory) {
        this.expandedIgnored.delete(directory)
        continue
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Parent expansions populate entries required by their child expansions.
      for (const entry of await this.#directoryEntries(directory)) {
        if (entry.name !== '.git') addIgnored(`${directory}/${entry.name}`, entry.isDirectory())
      }
    }
    // Replace the previous map; collapsed ignored descendants are released too.
    this.inventoryMetadata = files
    return [...files.values()].toSorted((a, b) => comparePaths(a.path, b.path))
  }

  /** @param {readonly string[]} names @returns {Promise<Set<string>>} */
  async #ignored(names) {
    if (!names.length) return new Set()
    const result = await command(
      this.root,
      ['check-ignore', '--no-index', '-z', '--stdin'],
      MAX_STATUS_BYTES,
      Buffer.from(`${names.join('\0')}\0`),
    )
    if (result.code === 1) return new Set()
    return new Set(decoder.decode(successful(result)).split('\0').filter(Boolean))
  }

  /** @param {string} directory */
  async #directoryEntries(directory) {
    const absolute = path.join(this.root, directory)
    try {
      if (!within(this.scope, await realpath(absolute)) || !(await lstat(absolute)).isDirectory()) return []
      return await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
  }

  /** @param {string} filename @param {boolean} expanded */
  async setDirectoryExpanded(filename, expanded) {
    if (filename !== '') validatePath(filename)
    if (typeof expanded !== 'boolean' || (expanded && !this.inventoryMetadata.get(filename)?.directory))
      throw new Error('Unknown ignored directory.')
    if (expanded) {
      if (this.expandedIgnored.has(filename)) return false
      const entries = await this.#directoryEntries(filename)
      const inventory = new Map(this.inventoryMetadata)
      for (const entry of entries) {
        const pathname = `${filename}/${entry.name}`
        if (entry.name === '.git' || inventory.has(pathname)) continue
        validatePath(pathname)
        inventory.set(pathname, {
          path: pathname,
          originalPath: null,
          index: ' ',
          worktree: ' ',
          conflicted: false,
          submodule: false,
          ignored: true,
          directory: entry.isDirectory(),
        })
      }
      this.inventoryMetadata = inventory
      this.expandedIgnored.add(filename)
    } else {
      const collapsed = new Set()
      for (const directory of this.expandedIgnored) {
        if (!filename || directory === filename || directory.startsWith(`${filename}/`)) {
          this.expandedIgnored.delete(directory)
          collapsed.add(directory)
        }
      }
      if (collapsed.size) {
        const inventory = new Map(this.inventoryMetadata)
        for (const [pathname, file] of inventory) {
          if (!file.ignored) continue
          let parent = path.posix.dirname(pathname)
          while (parent !== '.') {
            if (collapsed.has(parent)) {
              inventory.delete(pathname)
              break
            }
            parent = path.posix.dirname(parent)
          }
        }
        this.inventoryMetadata = inventory
      }
      return collapsed.size > 0
    }
    return true
  }

  // An explicitly opened document remains usable after its folder is collapsed.
  /** @param {string} filename @returns {Promise<InventoryEntry | undefined>} */
  async ignoredFile(filename) {
    validatePath(filename)
    const absolute = path.join(this.root, filename)
    if (!within(this.scope, absolute) || !(await this.#ignored([filename])).has(filename)) return undefined
    try {
      if (!(await lstat(absolute)).isFile()) return undefined
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
    return {
      path: filename,
      originalPath: null,
      index: ' ',
      worktree: ' ',
      conflicted: false,
      submodule: false,
      ignored: true,
      directory: false,
    }
  }

  /** @param {readonly string[]} paths */
  async hasRelevantPaths(paths) {
    paths = [...new Set(paths)]
    if (!paths.length || paths.some(name => name === this.root || !within(this.root, name))) {
      return true
    }
    if (
      paths.some(name => {
        const relative = path.relative(this.root, name).split(path.sep).join('/')
        const parent = path.posix.dirname(relative)
        return (
          (this.inventoryMetadata.get(relative)?.ignored ?? false) ||
          (this.inventoryDirectories?.has(parent === '.' ? '' : parent) ?? false) ||
          this.expandedIgnored.has(parent)
        )
      })
    )
      return true
    const input = Buffer.from(`${paths.join('\0')}\0`)
    const output = await command(this.root, ['check-ignore', '-z', '--stdin'], MAX_STATUS_BYTES, input)
    if (output.code === 1) return true
    const ignored = successful(output)
    let count = 0
    for (const byte of ignored) if (byte === 0) count += 1
    if (count < paths.length) return true
    // Directory notifications can contain tracked descendants of an ignored directory.
    return (await git(this.root, ['ls-files', '-z', '--', ...paths], MAX_STATUS_BYTES)).length > 0
  }

  /** @param {WorkspaceFile} file @param {string} [comparison] @returns {Promise<RepositoryContents>} */
  async contents(file, comparison = 'head') {
    validatePath(file.path)
    if (file.originalPath) validatePath(file.originalPath)
    if (!['head', 'unstaged', 'staged'].includes(comparison)) throw new Error('Unknown comparison mode.')
    if (file.submodule) {
      return unavailable('Git submodule. Open the submodule directory to inspect its files.')
    }
    if (file.conflicted && comparison !== 'head') {
      return unavailable(
        'The index contains unresolved merge stages. Use All changes to inspect the working file and conflict markers.',
      )
    }
    const headPath = file.originalPath ?? file.path
    const indexPath = file.index === 'R' || file.index === 'C' ? file.path : headPath
    const [beforeBytes, afterBytes] = await Promise.all([
      file.ignored
        ? empty()
        : this.#blob(comparison === 'unstaged' ? ':' : 'HEAD:', comparison === 'unstaged' ? indexPath : headPath),
      comparison === 'staged' ? (file.ignored ? empty() : this.#blob(':', indexPath)) : this.#workingFile(file.path),
    ])
    return comparedContents(beforeBytes, afterBytes, headPath, file.path, file.conflicted)
  }

  /** @param {string} filename */
  async editable(filename) {
    try {
      await this.#editPath(filename)
      return true
    } catch {
      return false
    }
  }

  /** @param {WorkspaceFile} file */
  async readClaudeHead(file) {
    const filename = file.originalPath ?? file.path
    if (!claudeVisiblePath(filename) || !within(this.scope, path.join(this.root, filename)))
      throw new Error('No regular HEAD text file is available at this path.')
    const output = await git(this.root, ['ls-tree', '-z', 'HEAD', '--', filename], MAX_STATUS_BYTES)
    const entry = /^100(?:644|755) blob ([a-f0-9]{40,64})\t[^\0]+\0$/u.exec(output.toString('utf8'))
    const oid = entry?.[1]
    if (!oid) throw new Error('No regular HEAD text file is available at this path.')
    const bytes = await this.#blobContents(oid, filename, MAX_CLAUDE_FILE_BYTES)
    if (bytes.size > MAX_CLAUDE_FILE_BYTES) throw new Error('No regular HEAD text file is available at this path.')
    const contents = fileContent(bytes, filename)
    if (contents.kind !== 'text' || contents.limited)
      throw new Error('No regular HEAD text file is available at this path.')
    return contents.value
  }

  /** @param {string} filename */
  async #editPath(filename) {
    validatePath(filename)
    const absolute = path.join(this.root, filename)
    const parent = await realpath(path.dirname(absolute))
    const resolved = path.join(parent, path.basename(absolute))
    if (
      !within(this.scope, absolute) ||
      !within(this.scope, resolved) ||
      filename.split('/').includes('.git') ||
      [this.gitDir, this.commonDir].some(directory => within(directory, resolved)) ||
      !(await lstat(absolute)).isFile()
    )
      throw new Error('Only regular text files in this directory can be edited.')
    return resolved
  }

  /** @param {unknown} filename @param {unknown} text @param {unknown} expected */
  async save(filename, text, expected, claude = false) {
    if (typeof text !== 'string' || typeof expected !== 'string' || text.length > MAX_FILE_BYTES)
      throw new Error('Invalid file save request.')
    validatePath(filename)
    const key = path.resolve(this.root, filename)
    const previous = this.#saves.get(key)
    const saving = (async () => {
      await previous?.catch(() => {})
      await this.#save(filename, text, expected, claude)
    })()
    this.#saves.set(key, saving)
    try {
      await saving
    } finally {
      if (this.#saves.get(key) === saving) this.#saves.delete(key)
    }
  }

  /** @param {string} filename @param {string} text @param {string} expected @param {boolean} claude */
  async #save(filename, text, expected, claude) {
    const resolve = () => (claude ? claudeFilePath(this, filename) : this.#editPath(filename))
    const absolute = await resolve()
    const handle = await open(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const currentStamp = async () => {
      if ((await resolve().catch(() => undefined)) !== absolute) return undefined
      const metadata = await lstat(absolute, { bigint: true }).catch(() => undefined)
      if (!metadata?.isFile() || (claude && metadata.nlink !== 1n)) return undefined
      return checkpointStamp(metadata)
    }
    try {
      if (claude) await checkClaudeFile(handle, absolute)
      const metadata = await handle.stat({ bigint: true })
      if (!metadata.isFile() || metadata.size > (claude ? MAX_CLAUDE_FILE_BYTES : MAX_FILE_BYTES))
        throw new Error('This file cannot be edited as a complete text document.')
      const original = await readSaveBytes(handle, Number(metadata.size))
      if (BigInt(original.length) !== metadata.size) throw saveConflict()
      const current = fileContent(original, filename)
      if (current.kind !== 'text' || current.limited)
        throw new Error('This file cannot be edited as a complete text document.')
      if (current.value !== expected) throw saveConflict()
      const bytes = encodeText(text, original)
      if (bytes.length > MAX_FILE_BYTES) throw new Error('The edited file exceeds the 2 MiB text limit.')
      if (checkpointStamp(metadata) !== (await currentStamp())) throw saveConflict()
      let written = 0
      try {
        await writeSaveBytes(handle, bytes, offset => (written = offset))
      } catch (error) {
        if (await restoreSave(handle, original, bytes, written, currentStamp).catch(() => false)) throw error
        throw appError(
          'The save failed, and Diffpane could not restore the original file. Your edits are still open.',
          {
            code: 'SAVE_RECOVERY_FAILED',
          },
        )
      }
    } finally {
      await handle.close()
    }
  }

  /** @param {string} prefix @param {string} filename */
  async #blob(prefix, filename) {
    const output = await command(this.root, ['rev-parse', '--verify', '--quiet', `${prefix}${filename}`], 4096)
    // Quiet verification exits 1 for missing paths and unborn HEAD.
    if (output.code === 1) return empty()
    return this.#blobContents(successful(output).toString('ascii').trim(), filename)
  }

  /** @param {string} oid @param {string} filename @returns {Promise<BlobContents>} */
  async #blobContents(oid, filename, limit = readLimit(filename)) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) throw new Error('Git returned an invalid blob ID.')
    const key = `${oid}:${limit}`
    let cached = this.blobs.get(key)
    if (cached) {
      this.blobs.delete(key)
      this.blobs.set(key, cached)
      return cached.value
    }
    const pending = (async () => {
      // One Git process returns both the size and bytes. Allow room for the
      // batch header and final LF while keeping oversized objects bounded.
      const output = successful(
        await command(
          this.root,
          ['cat-file', '--batch=%(objecttype) %(objectsize)'],
          limit + 64,
          Buffer.from(`${oid}\n`),
          {
            truncate: true,
          },
        ),
      )
      const headerEnd = output.indexOf(10)
      const header = headerEnd < 0 ? '' : output.toString('ascii', 0, headerEnd)
      const size = Number(/^blob (\d+)$/u.exec(header)?.[1])
      const start = headerEnd + 1
      const end = start + Math.min(size, limit)
      if (
        !Number.isSafeInteger(size) ||
        end > output.length ||
        (size <= limit && (output.length !== end + 1 || output[end] !== 10))
      )
        throw new Error('Git returned an invalid blob response.')
      return { bytes: output.subarray(start, end), size }
    })()
    cached = { bytes: 0, value: pending }
    this.blobs.set(key, cached)
    try {
      const value = await pending
      // Object IDs are immutable, so HEAD/index changes need no blob invalidation.
      if (this.blobs.get(key) === cached) {
        cached.bytes = value.bytes?.length ?? 0
        this.blobBytes += cached.bytes
        while (this.blobs.size > 32 || this.blobBytes > 8 * 1024 * 1024) {
          const first = this.blobs.entries().next()
          if (first.done) break
          const [oldest, entry] = first.value
          this.blobBytes -= entry.bytes
          this.blobs.delete(oldest)
        }
      }
      return value
    } catch (error) {
      if (this.blobs.get(key) === cached) this.blobs.delete(key)
      throw error
    }
  }

  /** @param {string} filename @returns {Promise<ContentBytes>} */
  async #workingFile(filename) {
    const absolute = path.join(this.root, filename)
    let metadata
    try {
      metadata = await lstat(absolute)
    } catch (error) {
      if (missing(error)) return empty()
      throw error
    }
    let parent
    try {
      parent = await realpath(path.dirname(absolute))
    } catch (error) {
      if (missing(error)) return empty()
      throw error
    }
    if (!within(this.root, parent)) {
      return { note: 'The parent directory resolves outside this repository; preview skipped.' }
    }
    // Git stores a symlink's target, never the contents reached through that link.
    if (metadata.isSymbolicLink()) return readlink(absolute, { encoding: 'buffer' })
    if (metadata.isDirectory()) return empty()
    if (!metadata.isFile()) return { note: 'This path is not a regular file.' }
    let handle
    try {
      handle = await open(absolute, workingReadFlags)
      const current = await handle.stat()
      if (!current.isFile()) return { note: 'This path is not a regular file.' }
      const streamed = Boolean(mediaType(filename))
      const limit = streamed ? 64 * 1024 : readLimit(filename)
      // Read one extra byte to notice growth and distinguish a full preview from a complete file.
      let bytes = Buffer.allocUnsafe(Math.min(current.size, limit) + 1)
      let length = 0
      while (length < bytes.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Continue positional reads after a short read.
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
        if (length === current.size) break
        if (length < bytes.length || bytes.length === limit + 1) continue
        const grown = Buffer.allocUnsafe(limit + 1)
        bytes.copy(grown, 0, 0, length)
        bytes = grown
      }
      return { bytes: bytes.subarray(0, Math.min(length, limit)), size: Math.max(current.size, length), streamed }
    } catch (error) {
      if (missing(error)) return empty()
      throw error
    } finally {
      await handle?.close()
    }
  }
}

/** @param {ContentBytes} beforeBytes @param {ContentBytes} afterBytes @param {string} beforePath @param {string} afterPath @param {boolean} [conflicted] @returns {RepositoryContents} */
function comparedContents(beforeBytes, afterBytes, beforePath, afterPath, conflicted) {
  const before = fileContent(beforeBytes, beforePath)
  const after = fileContent(afterBytes, afterPath)
  if (before.kind === 'unavailable' || after.kind === 'unavailable') return unavailable(before.note ?? after.note)
  if (before.kind !== 'text' || after.kind !== 'text' || before.limited || after.limited) {
    return {
      before: '',
      after: '',
      note: null,
      preview: {
        before:
          before.kind === 'text' && before.size && !before.hex ? { ...before, ...fileByteView(beforeBytes) } : before,
        after: after.kind === 'text' && after.size && !after.hex ? { ...after, ...fileByteView(afterBytes) } : after,
      },
    }
  }
  let note = after.note ?? before.note
  if (conflicted) note = 'Unresolved merge conflict. The working file includes the current conflict markers.'
  else if (
    before.value !== after.value &&
    before.value.replaceAll('\r\n', '\n') === after.value.replaceAll('\r\n', '\n')
  ) {
    note = 'Only line endings changed (LF / CRLF).'
  }
  return { before: before.value, after: after.value, note }
}

/** @param {unknown} filename @returns {asserts filename is string} */
function validatePath(filename) {
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.includes('\0') ||
    path.isAbsolute(filename) ||
    filename.split('/').some(part => part === '..' || part === '.') ||
    !within(path.resolve('.'), path.resolve('.', filename))
  ) {
    throw new Error('Git returned an invalid repository-relative path.')
  }
}

/** @param {string} root @param {string} candidate */
function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** @param {string} root @param {string} directory */
async function realDirectories(root, directory) {
  if (!within(root, directory)) return false
  // Case and Unicode normalization may change realpath spelling without a symlink.
  for (let current = directory; current !== root; current = path.dirname(current)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Stop at the first non-directory without starting unbounded filesystem work.
    if (!(await lstat(current)).isDirectory()) return false
  }
  return true
}

/** @param {unknown} error */
function missing(error) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** @param {unknown} error */
function errorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** @param {Buffer} bytes @returns {RepositoryStatus} */
function parseStatus(bytes) {
  let source
  try {
    source = decoder.decode(bytes)
  } catch {
    throw new Error('Git returned a filename that is not valid UTF-8.')
  }
  const records = source.split('\0')
  /** @type {Map<string, StatusFile>} */
  const files = new Map()
  let branch = 'HEAD'
  let oid = ''
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record) continue
    if (record.startsWith('# branch.head ')) {
      branch = record.slice(14)
      continue
    }
    if (record.startsWith('# branch.oid ')) {
      oid = record.slice(13)
      continue
    }
    if (record.startsWith('#')) continue
    /** @type {StatusFile} */
    let file
    if (record.startsWith('? ')) {
      file = {
        path: record.slice(2),
        originalPath: null,
        index: '?',
        worktree: '?',
        conflicted: false,
        submodule: false,
        statusKey: '?',
      }
    } else if (/^[12u] /u.test(record)) {
      const count = record[0] === '1' ? 9 : record[0] === '2' ? 10 : 11
      const fields = splitFields(record, count)
      const status = fields[1]
      const submodule = fields[2]
      const filename = fields[count - 1]
      if (status?.length !== 2 || !submodule || !filename) throw new Error('Invalid porcelain v2 Git status record.')
      const originalPath = record[0] === '2' ? records[++i] : null
      if (record[0] === '2' && !originalPath) throw new Error('Git rename has no original path.')
      file = {
        path: filename,
        originalPath: originalPath ?? null,
        index: status.charAt(0) === '.' ? ' ' : status.charAt(0),
        worktree: status.charAt(1) === '.' ? ' ' : status.charAt(1),
        conflicted: record[0] === 'u',
        submodule: submodule.startsWith('S'),
        // Modes and blob IDs change even when the displayed status letters stay the same.
        statusKey: `${fields.slice(0, -1).join(' ')}\0${originalPath ?? ''}`,
      }
    } else throw new Error('Unknown porcelain v2 Git status record.')
    validatePath(file.path)
    const existing = files.get(file.path)
    // A staged deletion recreated in the worktree appears again as untracked.
    if (existing && file.index === '?') {
      existing.worktree = '?'
      existing.statusKey += '\0?'
    } else {
      if (existing) {
        file.worktree = '?'
        file.statusKey += '\0?'
      }
      files.set(file.path, file)
    }
  }
  if (branch === '(detached)') branch = `detached ${oid.slice(0, 8)}`
  else if (oid === '(initial)') branch += ' (unborn)'
  return {
    branch,
    head: oid && oid !== '(initial)' ? oid : null,
    files: [...files.values()].toSorted((a, b) => comparePaths(a.path, b.path)),
  }
}

/** @param {string} record @param {number} count */
function splitFields(record, count) {
  const fields = []
  let start = 0
  while (fields.length < count - 1) {
    const end = record.indexOf(' ', start)
    if (end < 0) throw new Error('Invalid porcelain v2 Git status record.')
    fields.push(record.slice(start, end))
    start = end + 1
  }
  fields.push(record.slice(start))
  return fields
}

/** @param {string} directory @param {readonly string[]} args */
async function gitPath(directory, args) {
  const bytes = await git(directory, args, MAX_STATUS_BYTES)
  return decoder.decode(bytes.at(-1) === 10 ? bytes.subarray(0, -1) : bytes)
}

/** @param {string} directory @param {readonly string[]} args @param {number} limit */
async function git(directory, args, limit) {
  return successful(await command(directory, args, limit))
}

/** @param {CommandOutput} output */
function successful(output) {
  if (output.code === 0) return output.stdout
  throw new Error(output.stderr.toString('utf8').trim() || `Git exited with ${output.code ?? output.signal}.`)
}

/** @param {string} directory @param {readonly string[]} args @param {number} limit @param {Buffer} [input] @param {{truncate?: boolean, signal?: AbortSignal}} [options] @returns {Promise<CommandOutput>} */
function command(directory, args, limit, input, { truncate = false, signal } = {}) {
  signal?.throwIfAborted()
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
  // Shells launched from Git hooks can redirect the repository, index and pathspec semantics.
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ])
    delete env[key]
  const gitArgs = ['--no-optional-locks']
  // check-ignore rejects pathspec magic; its absolute stdin paths are already literal.
  if (args[0] !== 'check-ignore') gitArgs.push('--literal-pathspecs')
  gitArgs.push('-C', directory, ...args)
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    /** @type {Buffer[]} */
    const stdout = []
    /** @type {Buffer[]} */
    const stderr = []
    let stdoutLength = 0
    let stderrLength = 0
    let settled = false
    let limited = false
    const finish = () => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    /** @param {unknown} error */
    const fail = error => {
      if (settled) return
      finish()
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* A process that already exited needs no termination. */
      }
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      reject(error)
    }
    const abort = () => fail(signal?.reason)
    const timer = setTimeout(
      () => fail(new Error('Git did not finish within 10 seconds; try refreshing.')),
      GIT_TIMEOUT_MS,
    )
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => fail(new Error(`Cannot run Git: ${error.message}`)))
    child.stdin.on('error', error => {
      if (errorCode(error) !== 'EPIPE') fail(error)
    })
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      if (limited) return
      if (truncate && stdoutLength + chunk.length > limit) {
        stdout.push(chunk.subarray(0, limit - stdoutLength))
        stdoutLength = limit
        limited = true
        child.kill('SIGKILL')
        return
      }
      stdoutLength += chunk.length
      if (stdoutLength > limit)
        fail(
          Object.assign(new Error('Git output exceeds the preview limit.'), {
            code: 'OUTPUT_LIMIT',
          }),
        )
      else stdout.push(chunk)
    })
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      stderrLength += chunk.length
      if (stderrLength > 64 * 1024) fail(new Error('Git error output exceeds the preview limit.'))
      else stderr.push(chunk)
    })
    child.once('close', (code, terminationSignal) => {
      if (settled) return
      finish()
      resolve({
        code: limited ? 0 : code,
        signal: terminationSignal,
        limited,
        stdout: Buffer.concat(stdout, stdoutLength),
        stderr: Buffer.concat(stderr, stderrLength),
      })
    })
    child.stdin.end(input)
  })
}

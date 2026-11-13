// MONOLITHIC: The worker owns a single repository session with shared revision, watcher and document-cache lifetimes. Extract polling when its state and native shutdown join have an independent contract.
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parentPort, workerData } from 'node:worker_threads'
import watcher from '@parcel/watcher'
import { mediaType } from '../../../shared/documents/media-types.ts'
import { countLines } from '../../../shared/documents/text-lines.ts'
import { appError, attemptAsync, serializeAppError } from '../../../shared/recovery/app-errors.ts'
import { HowManyRuntime } from '../../tools/analysis/howmany.mjs'
import { claudeVisiblePath, readClaudeFile } from '../../tools/assistant/claude-workspace.mjs'
import { LanguageRuntime } from '../../tools/languages/language.mjs'
import { DiffRuntime } from '../../workspace/comparison/diff-runtime.ts'
import { DocumentCache } from '../../workspace/documents/document-cache.ts'
import { searchRepositoryContent } from '../../workspace/repository/content-search.mjs'
import { operationPath, renameEntry } from '../../workspace/repository/file-operations.ts'
import { Repository } from '../../workspace/repository/repository.mjs'
import { InventoryDelta } from './inventory-delta.ts'

import {
  isLanguageRequestId,
  isSessionRevision,
  parseLanguageOpen,
  parseLanguageRequest,
  parseSessionLaunch,
  parseSessionRequest,
  sessionBoolean,
  sessionString,
} from './session-protocol.ts'

/** @import { WorkspaceDocument, WorkspaceFile, WorkspaceSnapshot, WorkspaceCheckpoint } from './workspace-types.ts' */
/** @import { RepositoryStatus, StatusFile, Checkpoint, InventoryEntry } from '../../workspace/repository/repository.mjs' */
/** @typedef {import('@parcel/watcher').Event} WatchEvent */
/** @typedef {{ statusKey: string, stamp: string | undefined, version: number }} ReviewState */
/** @typedef {Map<string, string | undefined>} Stamps */
/** @typedef {{status: string | undefined, statusPaths: Set<string>, files: Stamps, directories: Stamps, metadata: Stamps}} PollState */
/** @typedef {{stamp: Promise<string | undefined>, readers: number}} DocumentStamp */

if (!parentPort) throw new Error('Workspace session requires a worker port')
const port = parentPort
const { directory: requestedDirectory, versions } = parseSessionLaunch(workerData)

const repository = await Repository.open(requestedDirectory)
const launchPath = await realpath(requestedDirectory)
const initialPath = (await lstat(launchPath)).isFile() ? path.relative(repository.root, launchPath) : null
const languages = new LanguageRuntime(repository.root, value => port.postMessage({ event: 'language-event', value }))
const howmany = new HowManyRuntime(repository.root, repository.scope, value =>
  port.postMessage({ event: 'howmany-event', value }),
)
/** @type {WorkspaceSnapshot | undefined} */
let snapshot
/** @type {Promise<InventoryEntry[]> | undefined} */
let catalog
/** @type {Promise<InventoryEntry[]> | undefined} */
let catalogLoading
let catalogRevision = versions?.catalogRevision ?? 0
let catalogIndexRevision = 0
/** @type {Map<string, InventoryEntry>} */
let catalogIndex = new Map()
/** @type {Map<string, WorkspaceFile>} */
let snapshotIndex = new Map()
/** @type {Map<string, ReviewState>} */
let reviewStates = new Map()
let reviewVersion = versions?.reviewVersion ?? 0
/** @type {(Checkpoint & { id: number }) | undefined} */
let checkpoint
/** @type {Map<string, StatusFile & { reviewVersion: number }>} */
let checkpointIndex = new Map()
/** @type {Promise<WorkspaceSnapshot> | undefined} */
let checkpointCapture
let checkpointId = versions?.checkpointId ?? 0
/** @type {string | undefined} */
let requestedDocumentPath
let inventoryDirty = false
let broadChanges = false
let revision = versions?.revision ?? 0
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer
let refreshing = false
/** @type {Promise<WorkspaceSnapshot> | undefined} */
let currentRefresh
let pending = false
// A snapshot requested while watchers initialize must advance inventory after a restart.
let force = Boolean(versions?.revision)
/** @type {string | undefined} */
let watchError
/** @type {ReturnType<typeof setTimeout> | undefined} */
let fallbackTimer
let fallbackActive = false
let polling = false
/** @type {PollState | undefined} */
let fallbackState
/** @type {ReturnType<typeof setTimeout> | undefined} */
let externalReviewTimer
/** @type {Stamps} */
let externalReviewPaths = new Map()
let shuttingDown = false
/** @type {Set<Promise<void>>} */
const activeRequests = new Set()
/** @type {AbortController | undefined} */
let contentSearchController
/** @type {Promise<unknown>} */
let directoryChanges = Promise.resolve()
/** @type {Set<string>} */
const changes = new Set()
/** @type {Map<string, WatchEvent>} */
const languageChanges = new Map()
/** @type {Map<string, DocumentStamp>} */
const documentStamps = new Map()
/** @type {import('@parcel/watcher').AsyncSubscription[]} */
const subscriptions = []
const diffs = new DiffRuntime()
const documents = new DocumentCache(loadDocument)

/** @param {string} filePath @param {string} comparison @returns {Promise<Omit<WorkspaceDocument, 'revision'>>} */
async function loadDocument(filePath, comparison) {
  const isCheckpoint = comparison.startsWith('checkpoint:')
  const baseline = isCheckpoint ? checkpoint : undefined
  if (isCheckpoint && (!baseline || comparison !== `checkpoint:${baseline.id}`))
    throw appError('This review checkpoint has been replaced.', { code: 'CHECKPOINT_EXPIRED' })
  const checkpointFile = baseline && checkpointIndex.get(filePath)
  const file = baseline ? (checkpointFile ?? { path: filePath }) : await findFile(filePath)
  if (!file) throw appError('This file is no longer available in this directory.', { code: 'DOCUMENT_UNAVAILABLE' })
  const start = performance.now()
  const contents = baseline
    ? await repository.checkpointContents(baseline, file)
    : await repository.contents(file, comparison)
  const decorations = await diffs.calculate(contents.before, contents.after)
  return {
    path: filePath,
    reviewVersion: baseline ? checkpointFile?.reviewVersion : file.reviewVersion,
    before: contents.before,
    after: contents.after,
    note: contents.note,
    ...(contents.workingMissing ? { workingMissing: true } : {}),
    editable: !contents.preview && !file.submodule && (await repository.editable(filePath)),
    ...(contents.preview ? { preview: contents.preview } : {}),
    ...decorations,
    lineCount: countLines(contents.after),
    elapsedMs: performance.now() - start,
  }
}
const inventoryDelta = new InventoryDelta()

function publishSnapshot() {
  port.postMessage({
    event: 'change',
    value: snapshot,
    versions: { revision, catalogRevision, reviewVersion, checkpointId },
  })
}

/** @param {unknown} cause @param {string} operation */
function reportUpdateError(cause, operation) {
  const failure = serializeAppError(cause, {
    code: 'BACKEND_UPDATE_FAILED',
    operation,
    recoverable: true,
  })
  if (!shuttingDown) port.postMessage({ event: 'error', value: failure.message, failure })
  return failure
}

/** @param {string} file */
function gitMetadata(file) {
  let inside = false
  for (const base of [repository.gitDir, repository.commonDir]) {
    const relative = path.relative(base, file)
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      inside = true
      if (
        !relative ||
        ['HEAD', 'index', 'packed-refs', 'config', `info${path.sep}exclude`].includes(relative) ||
        relative.startsWith(`refs${path.sep}`)
      )
        return true
    }
  }
  return inside ? false : null
}

/** @param {string} filename */
function collapsedIgnoredParent(filename) {
  let parent = path.posix.dirname(filename)
  while (parent !== '.' && parent !== '/') {
    if (repository.inventoryMetadata.get(parent)?.directory && !repository.expandedIgnored.has(parent)) return true
    parent = path.posix.dirname(parent)
  }
  return false
}

/** @param {string} filename */
function affectsRequestedDocument(filename) {
  return requestedDocumentPath === filename || requestedDocumentPath?.startsWith(`${filename}/`)
}

function schedule(all = false) {
  if (shuttingDown) return
  force ||= all
  pending = true
  if (!timer && !refreshing)
    timer = setTimeout(() => {
      timer = undefined
      refresh().catch(() => {})
    }, 0)
}

/** @param {string} message */
function watchFailed(message) {
  watchError = `${message}; using a 2s refresh.`
  // Healthy native subscriptions need no polling or periodic wakeups.
  if (fallbackActive) return
  fallbackActive = true
  queueFallback()
  schedule(true)
}

function queueFallback() {
  async function pollFallback() {
    try {
      // A large inventory may take longer than the polling interval. Let its
      // callers receive that scan before invalidating it for the next poll.
      await currentRefresh?.catch(() => {})
      await catalogLoading?.catch(() => {})
      if (shuttingDown) return
      polling = true
      await refresh().catch(() => {})
    } finally {
      if (!shuttingDown) queueFallback()
    }
  }
  fallbackTimer = setTimeout(
    // oxlint-disable-next-line typescript/no-misused-promises -- The worker owns rejection reporting, and the test scheduler joins this completion.
    () => pollFallback().catch((/** @type {unknown} */ cause) => reportUpdateError(cause, 'poll-workspace')),
    2000,
  ).unref()
}

/** @param {RepositoryStatus} result @returns {Promise<PollState>} */
async function pollState(result) {
  const filePaths = new Set(result.files.map(file => file.path))
  if (checkpoint) {
    for (const filename of checkpoint.paths.keys()) filePaths.add(filename)
    for (const filename of checkpointIndex.keys()) filePaths.add(filename)
  }
  for (const entry of documents.entries.values()) filePaths.add(entry.path)
  for (const work of documents.pending.values()) filePaths.add(work.path)
  if (requestedDocumentPath) filePaths.add(requestedDocumentPath)
  for (const [filename, entry] of documentStamps) {
    if (entry.readers || filePaths.has(filename)) filePaths.add(filename)
    else documentStamps.delete(filename)
  }
  const directoryPaths = new Set([
    path.relative(repository.root, repository.scope),
    ...(repository.inventoryDirectories ?? []),
    ...repository.expandedIgnored,
  ])
  const metadataPaths = new Set(
    [repository.gitDir, repository.commonDir].flatMap(directory =>
      ['config', 'info/exclude'].map(filename => path.relative(repository.root, path.join(directory, filename))),
    ),
  )
  /** @type {[string, 'file' | 'directory' | 'metadata'][]} */
  const entries = []
  for (const file of filePaths) entries.push([file, 'file'])
  for (const directory of directoryPaths) entries.push([directory, 'directory'])
  for (const filename of metadataPaths) entries.push([filename, 'metadata'])
  /** @type {Stamps} */
  const fileStamps = new Map()
  /** @type {Stamps} */
  const directories = new Map()
  /** @type {Stamps} */
  const metadata = new Map()
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      for (let entry = entries[next++]; entry; entry = entries[next++]) {
        const [filename, kind] = entry
        // oxlint-disable-next-line eslint/no-await-in-loop -- Limit filesystem stamp reads to the eight active slots.
        const stamp = await pollStamp(filename)
        ;(kind === 'metadata' ? metadata : kind === 'directory' ? directories : fileStamps).set(filename, stamp)
      }
    }),
  )
  return {
    status: repository.statusFingerprint,
    statusPaths: new Set(result.files.map(file => file.path)),
    files: fileStamps,
    directories,
    metadata,
  }
}

/** @param {string} filename */
async function pollStamp(filename) {
  try {
    const metadata = await lstat(path.join(repository.root, filename), { bigint: true })
    return `${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.mode}`
  } catch (error) {
    return errorCode(error)
  }
}

/** @param {unknown} cause */
function errorCode(cause) {
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
}

/** @param {string | undefined} stamp */
function missingStamp(stamp) {
  return stamp === 'ENOENT' || stamp === 'ENOTDIR'
}

/** @param {Map<string, ReviewState>} states */
function syncExternalReviewPaths(states) {
  externalReviewPaths = new Map(
    [...states]
      .filter(([filename]) => {
        const relative = path.relative(repository.scope, path.join(repository.root, filename))
        return relative === '..' || relative.startsWith(`..${path.sep}`)
      })
      .map(([filename, { stamp }]) => [filename, stamp]),
  )
  if (!externalReviewPaths.size || fallbackActive || shuttingDown) {
    clearTimeout(externalReviewTimer)
    externalReviewTimer = undefined
  } else if (!externalReviewTimer) queueExternalReviewPoll()
}

function queueExternalReviewPoll() {
  async function pollExternalReview() {
    try {
      const livePaths = []
      for (const [filename, stamp] of externalReviewPaths) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Keep background review polling at one filesystem operation at a time.
        const current = await pollStamp(filename)
        if (shuttingDown || fallbackActive) break
        if (externalReviewPaths.get(filename) !== stamp || current === stamp) continue
        externalReviewPaths.set(filename, current)
        documents.invalidate([filename])
        const absolute = path.join(repository.root, filename)
        if (changes.size < 4096) changes.add(absolute)
        else broadChanges = true
        if (livePaths.length <= 256) livePaths.push(filename)
      }
      if (livePaths.length && !shuttingDown) {
        port.postMessage({
          event: 'paths',
          value: livePaths.length > 256 ? ['*'] : livePaths,
        })
        schedule()
      }
    } catch (error) {
      reportUpdateError(error, 'poll-review-files')
    } finally {
      externalReviewTimer = undefined
      if (externalReviewPaths.size && !fallbackActive && !shuttingDown) queueExternalReviewPoll()
    }
  }
  externalReviewTimer = setTimeout(
    // oxlint-disable-next-line typescript/no-misused-promises -- The worker owns rejection reporting, and the test scheduler joins this completion.
    () => pollExternalReview().catch((/** @type {unknown} */ cause) => reportUpdateError(cause, 'poll-review-files')),
    2000,
  ).unref()
}

/** @param {StatusFile[]} statusFiles @param {readonly string[]} changedPaths @param {boolean} scanAll @param {Stamps} [stamps] */
async function versionReviewFiles(statusFiles, changedPaths, scanAll, stamps = new Map()) {
  const changed = new Set(changedPaths)
  const affected = (/** @type {string} */ filename) => {
    if (changed.has(filename)) return true
    let slash = filename.lastIndexOf('/')
    while (slash > 0) {
      if (changed.has(filename.slice(0, slash))) return true
      slash = filename.lastIndexOf('/', slash - 1)
    }
    return false
  }
  /** @type {string[]} */
  const checks = []
  for (const { path: filename, statusKey } of statusFiles) {
    if (stamps.has(filename)) continue
    const prior = reviewStates.get(filename)
    // A worktree edit can leave the Git status record identical.
    if (scanAll || !prior || prior.statusKey !== statusKey || affected(filename)) checks.push(filename)
  }
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(8, checks.length) }, async () => {
      for (let filename = checks[next++]; filename !== undefined; filename = checks[next++]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Limit filesystem stamp reads to the eight active slots.
        stamps.set(filename, await pollStamp(filename))
      }
    }),
  )
  /** @type {Map<string, ReviewState>} */
  const states = new Map()
  /** @type {Map<string, WorkspaceFile>} */
  const index = new Map()
  const changedVersions = []
  for (const { statusKey, ...file } of statusFiles) {
    const prior = reviewStates.get(file.path)
    const stamp = stamps.get(file.path) ?? prior?.stamp
    const state =
      prior?.statusKey === statusKey && prior.stamp === stamp ? prior : { statusKey, stamp, version: ++reviewVersion }
    if (state !== prior) changedVersions.push(file.path)
    states.set(file.path, state)
    index.set(file.path, { ...file, reviewVersion: state.version })
  }
  for (const filename of reviewStates.keys()) if (!states.has(filename)) changedVersions.push(filename)
  return { states, index, changedVersions }
}

/** @param {RepositoryStatus} result @returns {Promise<{ value: WorkspaceCheckpoint | null, index: typeof checkpointIndex, changedPaths: string[] }>} */
async function scanCheckpoint(result) {
  if (!checkpoint) return { value: null, index: checkpointIndex, changedPaths: [] }
  const { id, capturedAt } = checkpoint
  try {
    const checkpointFiles = await repository.checkpointFiles(checkpoint, result)
    const sameCheckpoint = id === snapshot?.checkpoint?.id
    /** @type {typeof checkpointIndex} */
    const index = new Map()
    const changedPaths = []
    for (const { statusKey, ...file } of checkpointFiles) {
      const previous = sameCheckpoint ? checkpointIndex.get(file.path) : undefined
      if (previous?.statusKey === statusKey) index.set(file.path, previous)
      else {
        index.set(file.path, { ...file, statusKey, reviewVersion: ++reviewVersion })
        changedPaths.push(file.path)
      }
    }
    for (const filename of checkpointIndex.keys()) if (!index.has(filename)) changedPaths.push(filename)
    return {
      value: { id, capturedAt, files: [...index.values()] },
      index,
      changedPaths,
    }
  } catch (error) {
    /** @type {typeof checkpointIndex} */
    const empty = new Map()
    const index = id === snapshot?.checkpoint?.id ? checkpointIndex : empty
    return {
      value: { id, capturedAt, files: [...index.values()], error: appError(error).message },
      index,
      changedPaths: [],
    }
  }
}

function captureCheckpoint() {
  checkpointCapture ??= (async () => {
    const baseline = await repository.captureCheckpoint()
    await currentRefresh?.catch(() => {})
    if (shuttingDown) throw new Error('The workspace is closing.')
    const previous = checkpoint
    checkpoint = Object.assign(baseline, { id: ++checkpointId })
    try {
      return await refresh()
    } catch (error) {
      checkpoint = previous
      throw appError(error)
    }
  })().finally(() => {
    checkpointCapture = undefined
  })
  return checkpointCapture
}

/** @param {Stamps} before @param {Stamps} after */
function polledPaths(before, after) {
  // A newly selected document or expanded directory is observed for the first
  // time here; adding it to the polling baseline is not a filesystem change.
  return [...after].filter(([name, stamp]) => before.has(name) && before.get(name) !== stamp).map(([name]) => name)
}

/** @param {PollState} observed */
async function polledDocuments(observed) {
  const changedDocuments = []
  // Read-start stamps live independently of a polling snapshot. A document can
  // open while that snapshot is collecting paths, or before the first fallback
  // baseline exists, and must not lose the metadata that predates its text.
  const reads = [...documentStamps]
  for (const [filename, entry] of reads) {
    const baseline = entry.stamp
    // oxlint-disable-next-line eslint/no-await-in-loop -- Compare each owned read stamp before advancing its baseline.
    if (!observed.files.has(filename)) observed.files.set(filename, await pollStamp(filename))
    const stamp = observed.files.get(filename)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Compare each owned read stamp before advancing its baseline.
    if ((await baseline) !== stamp) changedDocuments.push(filename)
    if (entry.stamp === baseline) entry.stamp = Promise.resolve(stamp)
  }
  return changedDocuments
}

function invalidateCatalog() {
  // Never start overlapping inventories or discard an in-flight result. It is
  // a useful filesystem snapshot even when more edits arrive while it loads.
  if (!catalogLoading) catalog = undefined
  catalogRevision++
}

function refresh() {
  if (refreshing && currentRefresh) return currentRefresh
  clearTimeout(timer)
  timer = undefined
  currentRefresh = performRefresh()
  return currentRefresh
}

/** @returns {Promise<WorkspaceSnapshot>} */
async function performRefresh() {
  refreshing = true
  pending = false
  const paths = [...changes]
  changes.clear()
  const languageEvents = new Map(languageChanges)
  languageChanges.clear()
  let all = force || broadChanges
  let refreshInventory = inventoryDirty || force
  const poll = polling
  polling = false
  broadChanges = false
  inventoryDirty = false
  force = false
  try {
    // Invalidate before starting slow Git work, so a document read completed
    // during the refresh can still be delivered to the editor.
    if (all) documents.invalidate()
    if (
      snapshot &&
      !all &&
      paths.length &&
      checkpoint?.id === snapshot?.checkpoint?.id &&
      !paths.some(file => {
        const relative = path.relative(repository.root, file)
        return (
          affectsRequestedDocument(relative) === true ||
          checkpoint?.paths.has(relative) === true ||
          checkpointIndex.has(relative)
        )
      }) &&
      !(await repository.hasRelevantPaths(paths))
    )
      return snapshot
    languages.changed([...languageEvents.values()])
    const start = performance.now()
    const result = await repository.snapshot()
    let changedPaths = paths.map(file => path.relative(repository.root, file))
    const observed = fallbackActive && (poll || !fallbackState) ? await pollState(result) : null
    const review = await versionReviewFiles(result.files, changedPaths, all, observed?.files)
    const checkpointReview = await scanCheckpoint(result)
    if (observed) {
      const documentChanges = await polledDocuments(observed)
      if (documentChanges.length) documents.invalidate(documentChanges)
      changedPaths.push(...documentChanges)
      if (poll && fallbackState && snapshot) {
        const previousPoll = fallbackState
        const statusChanged = observed.status !== previousPoll.status
        const metadataChanged = polledPaths(previousPoll.metadata, observed.metadata).length > 0
        const fileChanges = polledPaths(previousPoll.files, observed.files)
        const changedDirectories = polledPaths(previousPoll.directories, observed.directories)
        const newDirectories = [...observed.directories.keys()].some(name => !previousPoll.directories.has(name))
        // Lost native events require polling, but a quiet poll must not reload
        // the editor, rebuild a large explorer or restart repository analysis.
        if (
          !all &&
          !refreshInventory &&
          !changedPaths.length &&
          !review.changedVersions.length &&
          !checkpointReview.changedPaths.length &&
          checkpointReview.value?.id === snapshot?.checkpoint?.id &&
          checkpointReview.value?.error === snapshot?.checkpoint?.error &&
          !statusChanged &&
          !metadataChanged &&
          !fileChanges.length &&
          !changedDirectories.length &&
          !newDirectories &&
          watchError === snapshot?.watchError
        ) {
          fallbackState = observed
          return snapshot
        }
        if ((statusChanged || metadataChanged) && !all) {
          all = true
          documents.invalidate()
        } else if (fileChanges.length) documents.invalidate(fileChanges)
        // Newly cataloged or expanded directories need one reconciliation: a
        // create may have happened after their entries were read but before
        // their first polling stamp was available.
        refreshInventory ||=
          statusChanged ||
          metadataChanged ||
          changedDirectories.length > 0 ||
          newDirectories ||
          fileChanges.some(filename => path.basename(filename) === '.gitignore')
        const watchedFiles = new Set([...fileChanges, ...documentChanges])
        if (statusChanged) {
          for (const filename of observed.statusPaths)
            if (!previousPoll.statusPaths.has(filename)) watchedFiles.add(filename)
          for (const filename of previousPoll.statusPaths)
            if (!observed.statusPaths.has(filename)) watchedFiles.add(filename)
        }
        /** @type {WatchEvent[]} */
        const watchedEvents = []
        const watchPaths = [...watchedFiles]
          .filter(filename => !languageEvents.has(path.join(repository.root, filename)))
          .slice(0, 4096)
        let nextWatchPath = 0
        await Promise.all(
          Array.from({ length: Math.min(8, watchPaths.length) }, async () => {
            for (
              let filename = watchPaths[nextWatchPath++];
              filename !== undefined;
              filename = watchPaths[nextWatchPath++]
            ) {
              const absolute = path.join(repository.root, filename)
              const before = previousPoll.files.get(filename)
              // oxlint-disable-next-line eslint/no-await-in-loop -- Limit filesystem stamp reads to the eight active slots.
              const after = observed.files.get(filename) ?? (await pollStamp(filename))
              watchedEvents.push({
                path: absolute,
                type: missingStamp(after)
                  ? 'delete'
                  : before === undefined || missingStamp(before)
                    ? 'create'
                    : 'update',
              })
            }
          }),
        )
        languages.changed(watchedEvents)
        changedPaths = [...new Set([...changedPaths, ...fileChanges, ...changedDirectories])]
      }
      fallbackState = observed
    }
    revision++
    if (all) changedPaths = ['*']
    else changedPaths = [...new Set([...changedPaths, ...review.changedVersions, ...checkpointReview.changedPaths])]
    howmany.changed(changedPaths)
    // Reads that raced the Git status scan may still carry the previous comparison version.
    const changedVersions = [...review.changedVersions, ...checkpointReview.changedPaths]
    if (changedVersions.length) documents.invalidate(changedVersions)
    reviewStates = review.states
    snapshotIndex = review.index
    checkpointIndex = checkpointReview.index
    syncExternalReviewPaths(reviewStates)
    if (refreshInventory) invalidateCatalog()
    snapshot = {
      ...result,
      files: [...snapshotIndex.values()],
      checkpoint: checkpointReview.value,
      root: repository.root,
      scope: repository.scope,
      initialPath,
      revision,
      changedPaths,
      inventoryRevision: catalogRevision,
      watchError,
      gitMs: performance.now() - start,
    }
    publishSnapshot()
    return snapshot
  } catch (error) {
    // Reconcile all paths when Git is available again after a failed refresh.
    force = true
    throw appError(reportUpdateError(error, 'refresh'))
  } finally {
    refreshing = false
    if (pending) schedule()
  }
}

async function files() {
  if (!catalog) {
    const requestedRevision = catalogRevision
    async function scan() {
      try {
        const inventory = await repository.files()
        catalogIndex = new Map(inventory.map(file => [file.path, file]))
        catalogIndexRevision = requestedRevision
        // A later request reconciles changes observed during this scan. Waiting
        // for a completely quiet filesystem here starves reads during edits.
        if (requestedRevision !== catalogRevision) {
          catalog = undefined
          // A final create/delete may have arrived after Git read the catalog.
          // Wake consumers once more even if no further native event follows.
          catalogRevision++
          if (snapshot && !shuttingDown) {
            snapshot = { ...snapshot, changedPaths: [], inventoryRevision: catalogRevision }
            publishSnapshot()
          }
        }
        return inventory
      } catch (cause) {
        catalog = undefined
        throw appError(cause)
      } finally {
        catalogLoading = undefined
      }
    }
    catalog = catalogLoading = scan()
  }
  return catalog
}

/** @param {string} filePath @returns {Promise<WorkspaceFile | undefined>} */
async function findFile(filePath) {
  if (snapshotIndex.has(filePath)) return snapshotIndex.get(filePath)
  // An existing catalog remains useful while its replacement scans. Known
  // clean files must not queue behind a full inventory of a large repository.
  const known = catalogIndex.get(filePath)
  if (known && !known.ignored) {
    try {
      const metadata = await lstat(path.join(repository.root, filePath))
      if (!metadata.isDirectory() || known.submodule) return known
    } catch (error) {
      if (!missingStamp(errorCode(error))) throw appError(error)
    }
  }
  await files()
  const file = snapshotIndex.get(filePath) ?? catalogIndex.get(filePath)
  return file?.directory ? undefined : (file ?? (await repository.ignoredFile(filePath)))
}

/** @template T @param {() => Promise<T>} run */
function changeDirectory(run) {
  const change = directoryChanges.then(run)
  directoryChanges = change.catch(() => {})
  return change
}

/** @param {string} filePath */
async function claudeFile(filePath) {
  if (!claudeVisiblePath(filePath)) throw new Error('Choose an available, nonignored project text file.')
  const file = await findFile(filePath)
  if (!file || file.ignored || file.submodule || file.directory)
    throw new Error('Choose an available, nonignored project text file.')
  return file
}

/** @param {string} filePath @param {string} comparison @returns {Promise<WorkspaceDocument>} */
async function document(filePath, comparison, priority = false) {
  if (
    typeof filePath !== 'string' ||
    !(
      ['head', 'unstaged', 'staged'].includes(comparison) ||
      (checkpoint &&
        comparison === `checkpoint:${checkpoint.id}` &&
        filePath &&
        !path.isAbsolute(filePath) &&
        !filePath.split('/').some(part => ['.', '..', '.git', ''].includes(part)))
    )
  )
    throw new Error('Invalid document request')
  if (priority) requestedDocumentPath = filePath
  let observed = documentStamps.get(filePath)
  if (!observed) {
    // Reads can begin before the watcher fails. Retain their initial metadata
    // too, while bounding stamps to cached, requested and in-flight documents.
    for (const [filename, entry] of documentStamps)
      if (!entry.readers && !documents.hasPath(filename) && filename !== requestedDocumentPath)
        documentStamps.delete(filename)
    observed = { stamp: pollStamp(filePath), readers: 0 }
    documentStamps.set(filePath, observed)
  }
  observed.readers++
  try {
    await observed.stamp
    const result = await documents.get(filePath, comparison, { priority })
    return { ...result, revision }
  } finally {
    observed.readers--
  }
}

port.on('message', (/** @type {unknown} */ message) => {
  const request = parseSessionRequest(message)
  if (!request) return
  if ('failure' in request) {
    respondError(request.id, request.failure, 'workspace-message')
    return
  }
  if (shuttingDown) {
    respondError(request.id, appError('The workspace is closing.', { code: 'WINDOW_UNAVAILABLE' }), request.method)
    return
  }
  const pendingRequest = receive(request)
  if (request.method !== 'language-dispose') activeRequests.add(pendingRequest)
  pendingRequest
    .finally(() => activeRequests.delete(pendingRequest))
    .catch((/** @type {unknown} */ cause) => reportUpdateError(cause, 'workspace-message'))
})

/** @param {number} id @param {unknown} cause @param {string} operation */
function respondError(id, cause, operation) {
  const failure = serializeAppError(cause, { operation })
  port.postMessage({ id, error: failure.message, failure })
}

async function dispose() {
  shuttingDown = true
  contentSearchController?.abort()
  clearTimeout(timer)
  clearTimeout(fallbackTimer)
  clearTimeout(externalReviewTimer)
  documents.dispose()
  await watchSetup
  // A renderer can request its first snapshot while native subscriptions are
  // still starting. Join it before releasing the tools that consume snapshots.
  const [unsubscribed] = await Promise.all([
    Promise.allSettled(subscriptions.map(async subscription => subscription.unsubscribe())),
    Promise.allSettled([checkpointCapture, currentRefresh]),
  ])
  const stopped = await Promise.allSettled([languages.dispose(), diffs.dispose(), howmany.dispose()])
  await Promise.allSettled(activeRequests)
  const failure = [...unsubscribed, ...stopped].find(result => result.status === 'rejected')
  if (failure) throw appError(failure.reason)
}

/** @param {import('./session-protocol.ts').SessionRequest} request */
async function receive({ id, method, args }) {
  try {
    /** @type {unknown} */
    let value
    if (method === 'snapshot') value = snapshot ?? (await refresh())
    else if (method === 'capture-checkpoint') value = await captureCheckpoint()
    else if (method === 'operation-path') {
      await files()
      const filename = sessionString(args[0], 'file path')
      if (catalogIndex.get(filename)?.submodule) throw new Error('Open the submodule to change its files.')
      value = await operationPath(repository, filename)
    } else if (method === 'rename') {
      const filename = sessionString(args[0], 'file path')
      value = await changeDirectory(async () => {
        await files()
        if (catalogIndex.get(filename)?.submodule) throw new Error('Open the submodule to change its files.')
        const expanded = [...repository.expandedIgnored].filter(
          directory => directory === filename || directory.startsWith(`${filename}/`),
        )
        const renamed = await renameEntry(repository, filename, args[1])
        if (filename === renamed) return renamed
        // Move expansion state after any older inventory scan that still has the source.
        await catalogLoading?.catch(() => {})
        for (const directory of expanded) {
          repository.expandedIgnored.delete(directory)
          repository.expandedIgnored.add(renamed + directory.slice(filename.length))
        }
        invalidateCatalog()
        documents.invalidate([filename, renamed])
        await currentRefresh?.catch(() => {})
        // The rename has committed; refresh reports its own failures separately.
        if (!shuttingDown) {
          force = true
          await refresh().catch(() => {})
        }
        return renamed
      })
    } else if (method === 'files') value = (await files()).filter(file => !file.ignored)
    else if (method === 'content-search') {
      contentSearchController?.abort()
      const controller = new AbortController()
      contentSearchController = controller
      try {
        value = await searchRepositoryContent(repository, args[0], controller.signal)
      } finally {
        if (contentSearchController === controller) contentSearchController = undefined
      }
    } else if (method === 'content-search-cancel') contentSearchController?.abort()
    else if (method === 'claude-list') {
      const query = sessionString(args[0], 'Claude file search query')
      const paths = []
      let length = 0
      let truncated = false
      for (const file of await files()) {
        if (
          file.ignored ||
          file.submodule ||
          file.directory ||
          !claudeVisiblePath(file.path) ||
          !file.path.toLowerCase().includes(query)
        )
          continue
        length += file.path.length
        if (length > 12_000 || paths.length === 150) {
          truncated = true
          break
        }
        paths.push(file.path)
      }
      value = { paths, truncated }
    } else if (method === 'claude-read') {
      const filename = sessionString(args[0], 'file path')
      const side = args[1]
      if (side !== 'head' && side !== 'working') throw new Error('Invalid file side')
      const file = await claudeFile(filename)
      value = side === 'head' ? await repository.readClaudeHead(file) : await readClaudeFile(repository, filename)
    } else if (method === 'directory-expanded') {
      const filename = sessionString(args[0], 'directory path')
      const expanded = sessionBoolean(args[1], 'directory expansion state')
      async function updateExpansion() {
        await files()
        const base = catalogRevision
        if (await repository.setDirectoryExpanded(filename, expanded)) {
          if (!expanded) documents.invalidate([filename || '*'])
          // Expansions touch only one directory; keep the regular inventory cached.
          if (base === catalogRevision && !catalogLoading && catalog) {
            catalogIndex = repository.inventoryMetadata
            catalog = Promise.resolve([...catalogIndex.values()])
            catalogIndexRevision = base + 1
          } else if (!catalogLoading) catalog = undefined
          catalogRevision++
          if (snapshot) {
            snapshot = { ...snapshot, changedPaths: [], inventoryRevision: catalogRevision }
            publishSnapshot()
          }
        }
      }
      await changeDirectory(updateExpansion)
      value = null
    } else if (method === 'files-delta') {
      const base = args[0]
      if (base !== null && !isSessionRevision(base)) throw new Error('Invalid inventory revision')
      await files()
      value = inventoryDelta.update(base, catalogIndexRevision, catalogIndex)
    } else if (method === 'document')
      value = await document(sessionString(args[0], 'file path'), sessionString(args[1], 'comparison'), true)
    else if (method === 'save' || method === 'claude-save') {
      const filePath = sessionString(args[0], 'file path')
      const text = sessionString(args[1], 'file text')
      const expected = sessionString(args[2], 'expected file text')
      const claude = method === 'claude-save'
      const file = await (claude ? claudeFile(filePath) : findFile(filePath))
      if (!file || file.submodule)
        throw appError('This file is no longer available in this directory.', { code: 'DOCUMENT_UNAVAILABLE' })
      await repository.save(filePath, text, expected, claude)
      documents.invalidate([filePath])
      const absolute = path.join(repository.root, filePath)
      changes.add(absolute)
      languageChanges.set(absolute, { path: absolute, type: 'update' })
      port.postMessage({ event: 'paths', value: [filePath] })
      schedule()
      value = null
    } else if (method === 'media') {
      const file = await findFile(sessionString(args[0], 'file path'))
      const type = file ? mediaType(file.path) : null
      if (!file || file.submodule || !type) throw new Error('This media file is no longer available in this directory.')
      value = { root: repository.root, path: file.path, type }
    } else if (method === 'howmany-analyze') value = await howmany.analyze(args[0] === true)
    else if (method === 'howmany-file') {
      const filename = sessionString(args[0], 'file path')
      value = await howmany.file(
        filename,
        async () => {
          const contents = await document(filename, 'head')
          return contents.note || contents.preview ? null : contents.after
        },
        sessionString(args[1], 'HowMany request'),
      )
    } else if (method === 'howmany-close') {
      howmany.closeFile(sessionString(args[0], 'file path'))
      value = null
    } else if (method === 'language-open') {
      const input = parseLanguageOpen(args[0])
      value = await languages.open(input, async () => {
        if (!(await findFile(input.path))) throw new Error('Language document is not in this directory.')
      })
    } else if (method === 'language-request') value = await languages.request(parseLanguageRequest(args[0]))
    else if (method === 'language-cancel') {
      if (!isLanguageRequestId(args[0])) throw new Error('Invalid language request ID')
      languages.cancel(args[0])
      value = null
    } else if (method === 'language-close') {
      languages.close(sessionString(args[0], 'file path'))
      value = null
    } else if (method === 'language-status') value = languages.status()
    else if (method === 'language-dispose') {
      await dispose()
      value = null
    } else if (method === 'refresh') {
      if (refreshing) await currentRefresh?.catch(() => {})
      if (shuttingDown) throw appError('The workspace is closing.', { code: 'WINDOW_UNAVAILABLE' })
      force = true
      value = await refresh()
    } else if (method === 'performance')
      value = { documents: documents.stats(), inventoryRevision: catalogRevision, revision }
    else throw new Error('Unknown request')
    port.postMessage({ id, value })
  } catch (error) {
    respondError(id, error, method)
  } finally {
    if (method === 'language-dispose') port.close()
  }
}

const watchSetup = (async () => {
  for (const watchPath of new Set([repository.scope, repository.gitDir, repository.commonDir])) {
    if (shuttingDown) break
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A shutdown may interrupt setup after any individual subscription.
      const subscription = await watcher.subscribe(watchPath, (error, events) => {
        if (shuttingDown) return
        if (error) {
          watchFailed(`Live watcher failed: ${error.message}`)
          return
        }
        const livePaths = new Set()
        for (const event of events) {
          const metadata = gitMetadata(event.path)
          if (metadata === true || event.path === repository.scope) {
            force = true
            documents.invalidate()
          } else if (metadata === null && event.path.startsWith(repository.scope + path.sep)) {
            const relative = path.relative(repository.root, event.path)
            // Build and dependency churn below a closed ignored folder is not a
            // repository change. Filter it before it can become a wildcard batch;
            // explicitly opened ignored documents must still receive updates.
            const known = catalogIndex.has(relative)
            if (
              !documents.hasPath(relative) &&
              !affectsRequestedDocument(relative) &&
              !checkpoint?.paths.has(relative) &&
              !checkpointIndex.has(relative) &&
              ((!known && !snapshotIndex.has(relative) && collapsedIgnoredParent(relative)) ||
                (event.type === 'update' &&
                  repository.inventoryMetadata.get(relative)?.directory &&
                  !repository.expandedIgnored.has(relative)))
            )
              continue
            documents.invalidate([relative])
            if (!livePaths.has('*')) {
              if (livePaths.size < 256) livePaths.add(relative)
              else {
                livePaths.clear()
                livePaths.add('*')
              }
            }
            // FSEvents can retain FileCreated on existing paths; atomic saves also reuse paths.
            // A coalesced delete and restore can arrive as an update after Git saw the deletion.
            if (
              path.basename(event.path) === '.gitignore' ||
              (event.type === 'create' && (!known || !catalog || catalogLoading)) ||
              (event.type === 'update' && snapshotIndex.get(relative)?.worktree === 'D') ||
              event.type === 'delete'
            )
              inventoryDirty = true
            if (languageChanges.size < 4096) languageChanges.set(event.path, event)
            if (changes.size < 4096) changes.add(event.path)
            else broadChanges = true
          }
        }
        // Editor reads can proceed while status and inventory subprocesses run.
        if (force || livePaths.size) port.postMessage({ event: 'paths', value: force ? ['*'] : [...livePaths] })
        if (force || changes.size) schedule()
      })
      // Disposal joins setup before unsubscribing, including a subscription
      // returned after shutdown began.
      subscriptions.push(subscription)
    } catch (error) {
      if (!shuttingDown) watchFailed(`Live watcher unavailable: ${appError(error).message}`)
    }
  }
})()
await watchSetup
if (!shuttingDown) {
  force = true
  await attemptAsync(refresh)
}

// MONOLITHIC: Queue order, focus, baseline selection and reviewed revisions update together. Extract the review model once keyboard selection and checkpoint replacement have independent coverage.
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { projectIcon } from '../../shell/layout/icons.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'

import './change-review.css'

/**
 * @typedef {{
 *   path: string,
 *   worktree?: string,
 *   index?: string,
 *   originalPath?: string | null,
 *   conflicted?: boolean,
 *   reviewVersion?: number,
 * }} ReviewFile
 */
/** @typedef {{ id: number, capturedAt: number | string, error?: string }} ReviewCheckpoint */
/** @typedef {'head' | 'checkpoint'} ReviewBaseline */
/** @typedef {'pending' | 'reviewed'} ReviewFilter */
/** @typedef {'loading' | 'saving' | 'save-failed' | 'closing' | 'ready' | 'failed'} ReviewState */
/**
 * @typedef {{
 *   onOpen: (file: ReviewFile) => unknown,
 *   onBack: () => void,
 *   onProgress: (progress: { pending: number, total: number }) => void,
 *   onCapture: () => Promise<void>,
 *   onBaseline: (baseline: ReviewBaseline) => void,
 * }} ChangeReviewOptions
 */

const ROW_HEIGHT = 48
const OVERSCAN = 4
const CHECKPOINT_TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})
let instance = 0

/** @param {string} path */
function icon(path, className = '') {
  return `<svg class="${className}" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

const GLYPHS = {
  back: 'M13 8H3m4-4L3 8l4 4',
  previous: 'm10 4-4 4 4 4',
  next: 'm6 4 4 4-4 4',
  check: 'm3.5 8 3 3 6-6',
  undo: 'M6 4 3 7l3 3M3 7h6.5a3 3 0 0 1 0 6H8',
  compare: 'M2 3h12v10H2zM8 3v10M4 6h2m4 4h2',
  checkpoint: 'M3.5 13.5v-11m0 1h8l-2 3 2 3h-8',
  clean: 'M2.5 9 5 4.5h6L13.5 9v3.5h-11zM2.5 9h3l1 1.5h3l1-1.5h3',
  reviewed: 'M6 2.5h4l3 3v8H3v-11h3m4 0v3h3M6 8h4m-4 3h3',
  complete: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0zM5 8l2 2 4-4',
}

/** @type {Readonly<Record<string, string>>} */
const STATUS_LABELS = {
  '!': 'Merge conflict',
  A: 'Added',
  C: 'Copied',
  D: 'Deleted',
  M: 'Modified',
  R: 'Renamed',
  T: 'Type changed',
  U: 'Untracked',
}

/** @param {ReviewFile} file */
function changeStatus(file) {
  if (file.conflicted) return '!'
  if (file.worktree === 'D') return 'D'
  if (file.index === 'R' || file.index === 'C') return file.index
  if (file.worktree === '?') return 'U'
  return file.worktree && Object.hasOwn(STATUS_LABELS, file.worktree) ? file.worktree : (file.index ?? '').trim() || 'M'
}

/** @param {HTMLElement} container @param {ChangeReviewOptions} options */
export function createChangeReview(container, { onOpen, onBack, onProgress, onCapture, onBaseline }) {
  const id = `change-review-${++instance}`
  container.classList.add('change-review')
  container.setAttribute('aria-labelledby', `${id}-title`)
  container.hidden = true
  container.style.setProperty('--change-review-row-height', `${ROW_HEIGHT}px`)
  container.innerHTML = `
    <header class="change-review-heading">
      <h2 id="${id}-title">Review queue</h2>
      <button type="button" class="change-review-back" aria-label="Back to files" title="Back to files">${icon(GLYPHS.back)} Files</button>
    </header>
    <div class="change-review-baseline">
      <div class="change-review-baseline-actions">
        <select class="change-review-baseline-select" aria-label="Compare against" aria-describedby="${id}-checkpoint-time" hidden>
          <option value="head">Git HEAD</option>
          <option value="checkpoint">Checkpoint</option>
        </select>
        <button type="button" class="change-review-capture">${icon(GLYPHS.checkpoint)}<span></span></button>
      </div>
      <time class="change-review-checkpoint-time" id="${id}-checkpoint-time" aria-live="polite" hidden></time>
      <p class="change-review-error change-review-checkpoint-error" role="status" hidden></p>
    </div>
    <div class="change-review-progress" hidden>
      <span class="change-review-count" role="status"></span>
      <progress aria-label="Review progress" max="1" value="0"></progress>
    </div>
    <div class="change-review-filters" role="group" aria-label="Review filter" hidden>
      <button type="button" data-filter="pending" aria-label="Pending" aria-describedby="${id}-pending" aria-pressed="true">Pending <span id="${id}-pending"></span></button>
      <button type="button" data-filter="reviewed" aria-label="Reviewed" aria-describedby="${id}-reviewed" aria-pressed="false">Reviewed <span id="${id}-reviewed"></span></button>
    </div>
    <div class="change-review-body">
      <div class="change-review-list" role="listbox" aria-label="Changed files" tabindex="0">
        <div class="change-review-rows" role="presentation"></div>
      </div>
      <div class="change-review-empty" hidden>
        <span class="change-review-empty-icon"></span>
        <h3 tabindex="-1"></h3>
        <p></p>
        <button type="button" class="change-review-empty-action"></button>
      </div>
    </div>
    <footer class="change-review-footer" hidden>
      <p class="change-review-error" role="status" hidden></p>
      <div class="change-review-footer-top">
        <p class="change-review-position" aria-live="polite"></p>
        <div class="change-review-nav" role="group" aria-label="Navigate changed files">
          <button type="button" data-direction="previous" aria-label="Previous changed file" title="Previous changed file">${icon(GLYPHS.previous)}</button>
          <button type="button" data-direction="next" aria-label="Next changed file" title="Next changed file">${icon(GLYPHS.next)}</button>
        </div>
      </div>
      <button class="change-review-mark" type="button">
        <span class="change-review-mark-icon"></span>
        <span class="change-review-mark-label"></span>
        ${icon(GLYPHS.next, 'change-review-mark-next')}
      </button>
    </footer>`

  const baselineSelect = requireElement(container, '.change-review-baseline-select', HTMLSelectElement)
  const captureButton = requireElement(container, '.change-review-capture', HTMLButtonElement)
  const captureLabel = requireElement(captureButton, 'span', HTMLSpanElement)
  const capturedTime = requireElement(container, 'time', HTMLTimeElement)
  const checkpointError = requireElement(container, '.change-review-checkpoint-error', HTMLParagraphElement)
  const count = requireElement(container, '.change-review-count', HTMLSpanElement)
  const progress = requireElement(container, 'progress', HTMLProgressElement)
  const progressGroup = requireElement(container, '.change-review-progress', HTMLDivElement)
  const filterGroup = requireElement(container, '.change-review-filters', HTMLDivElement)
  const filters = [...container.querySelectorAll('button')].filter(button => button.dataset.filter)
  const list = requireElement(container, '.change-review-list', HTMLDivElement)
  const rows = requireElement(container, '.change-review-rows', HTMLDivElement)
  const empty = requireElement(container, '.change-review-empty', HTMLDivElement)
  const emptyIcon = requireElement(empty, '.change-review-empty-icon', HTMLSpanElement)
  const emptyTitle = requireElement(empty, 'h3', HTMLHeadingElement)
  const emptyDescription = requireElement(empty, 'p', HTMLParagraphElement)
  const emptyAction = requireElement(empty, 'button', HTMLButtonElement)
  const footer = requireElement(container, '.change-review-footer', HTMLElement)
  const position = requireElement(container, '.change-review-position', HTMLParagraphElement)
  const error = requireElement(footer, '.change-review-error', HTMLParagraphElement)
  const previous = requireElement(container, '[data-direction="previous"]', HTMLButtonElement)
  const next = requireElement(container, '[data-direction="next"]', HTMLButtonElement)
  const mark = requireElement(container, '.change-review-mark', HTMLButtonElement)
  const markIcon = requireElement(mark, '.change-review-mark-icon', HTMLSpanElement)
  const markLabel = requireElement(mark, '.change-review-mark-label', HTMLSpanElement)
  const markNext = requireElement(mark, '.change-review-mark-next', SVGElement)
  /** @type {Map<string, number>} */
  const headReviewed = new Map()
  /** @type {Map<string, number>} */
  const checkpointReviewed = new Map()
  /** @type {Map<string, HTMLDivElement>} */
  const mounted = new Map()
  let reviewed = headReviewed
  /** @type {ReviewBaseline} */
  let baseline = 'head'
  /** @type {ReviewCheckpoint | null | undefined} */
  let checkpoint = null
  let capturing = false
  let captureError = ''
  let resetScrollOnUpdate = false
  /** @type {Map<string, ReviewFile>} */
  let changes = new Map()
  /** @type {ReviewFile[]} */
  let entries = []
  /** @type {Map<string, number>} */
  let entryIndex = new Map()
  /** @type {ReviewFilter} */
  let filter = 'pending'
  /** @type {string | null} */
  let currentPath = null
  /** @type {number | null} */
  let currentVersion = null
  /** @type {ReviewState | null} */
  let currentState = null
  /** @type {string | null} */
  let activePath = null
  /** @type {string | null} */
  let openingPath = null
  let request = 0
  /** @type {number | null} */
  let frame = null
  let disposed = false

  function renderBaseline() {
    baselineSelect.hidden = !checkpoint
    baselineSelect.disabled = capturing
    if (baselineSelect.value !== baseline) baselineSelect.value = baseline
    captureButton.setAttribute('aria-disabled', String(capturing))
    captureButton.title = checkpoint
      ? 'Replace the checkpoint and start a new review'
      : 'Capture the current working tree for review'
    captureButton.setAttribute(
      'aria-label',
      capturing ? 'Capturing checkpoint' : checkpoint ? 'Replace checkpoint' : 'Capture checkpoint',
    )
    const action = capturing ? 'Capturing…' : checkpoint ? 'Replace checkpoint' : 'Capture checkpoint'
    if (captureLabel.textContent !== action) captureLabel.textContent = action
    captureButton.toggleAttribute('data-loading-status', capturing)
    capturedTime.hidden = !checkpoint
    const timestamp = checkpoint ? new Date(checkpoint.capturedAt) : null
    if (timestamp && Number.isFinite(timestamp.getTime())) {
      const label = `Captured ${CHECKPOINT_TIME.format(timestamp)}`
      capturedTime.dateTime = timestamp.toISOString()
      if (capturedTime.textContent !== label) capturedTime.textContent = label
    } else {
      capturedTime.removeAttribute('datetime')
      capturedTime.textContent = ''
    }
    const message = captureError || (baseline === 'checkpoint' ? (checkpoint?.error ?? '') : '')
    checkpointError.hidden = !message
    if (checkpointError.textContent !== message) checkpointError.textContent = message
  }

  async function capture() {
    if (capturing || disposed) return
    capturing = true
    captureError = ''
    renderBaseline()
    try {
      const result = await attemptAsync(onCapture, { operation: 'Capture review checkpoint' })
      if (!result.ok && !disposed) {
        reportError(result.error, { silent: true })
        captureError = result.error.message
      }
    } finally {
      capturing = false
      if (!disposed) renderBaseline()
    }
  }

  function focusQueue() {
    const target = !list.hidden ? list : !emptyAction.hidden ? emptyAction : checkpoint ? emptyTitle : captureButton
    target.focus({ preventScroll: true })
  }

  function renderRows() {
    if (container.hidden || disposed) return
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(entries.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT) + OVERSCAN)
    const indexes = Array.from({ length: end - start }, (_, offset) => start + offset)
    const activeIndex = activePath === null ? undefined : entryIndex.get(activePath)
    // Keep the keyboard cursor accessible when scrolling takes it out of the window.
    if (activeIndex !== undefined) {
      if (activeIndex < start) indexes.unshift(activeIndex)
      else if (activeIndex >= end) indexes.push(activeIndex)
    }
    const retained = new Set()
    let activeId = ''
    let cursor = rows.firstElementChild
    for (const index of indexes) {
      const file = entries[index]
      if (!file) continue
      const slash = file.path.lastIndexOf('/')
      const name = file.path.slice(slash + 1)
      retained.add(file.path)
      let row = mounted.get(file.path)
      if (!row) {
        row = document.createElement('div')
        row.className = 'change-review-row'
        row.dataset.path = file.path
        row.setAttribute('role', 'option')
        row.innerHTML = `<img class="change-review-file-icon" alt=""><div class="change-review-label"><span class="change-review-name"></span><span class="change-review-location"></span></div><span class="change-review-status" aria-hidden="true"><span class="change-review-status-symbol"></span><span class="change-review-status-label"></span></span>`
        const image = requireElement(row, 'img', HTMLImageElement)
        const source = projectIcon({ kind: 'file', name })
        if (source) image.src = source
        requireElement(row, '.change-review-name', HTMLSpanElement).textContent = name
        mounted.set(file.path, row)
      }
      if (row !== cursor) rows.insertBefore(row, cursor)
      cursor = row.nextElementSibling
      row.id = `${id}-row-${index}`
      row.style.top = `${index * ROW_HEIGHT}px`
      row.dataset.active = String(file.path === activePath)
      const loading = file.path === (openingPath ?? (currentState === 'loading' && currentPath))
      row.dataset.loading = String(loading)
      row.setAttribute('aria-selected', String(file.path === currentPath && currentState !== null))
      row.setAttribute('aria-posinset', String(index + 1))
      row.setAttribute('aria-setsize', String(entries.length))
      const status = changeStatus(file)
      const label = STATUS_LABELS[status] ?? 'Changed'
      const oldPath = file.originalPath
      const directory = file.path.slice(0, Math.max(0, slash))
      row.dataset.status = status
      row.title = oldPath ? `${label} · ${oldPath} → ${file.path}` : `${label} · ${file.path}`
      row.setAttribute(
        'aria-label',
        `${label}, ${file.path}${oldPath ? `, from ${oldPath}` : ''}${loading ? ', loading comparison' : ''}`,
      )
      requireElement(row, '.change-review-location', HTMLSpanElement).textContent = oldPath
        ? `${directory ? `${directory} · ` : ''}From ${oldPath}`
        : directory
      const statusElement = requireElement(row, '.change-review-status', HTMLSpanElement)
      statusElement.toggleAttribute('data-loading-status', loading)
      requireElement(statusElement, '.change-review-status-symbol', HTMLSpanElement).textContent = status
      requireElement(statusElement, '.change-review-status-label', HTMLSpanElement).textContent = label
      if (file.path === activePath) activeId = row.id
    }
    for (const [path, row] of mounted) {
      if (retained.has(path)) continue
      row.remove()
      mounted.delete(path)
    }
    if (activeId) list.setAttribute('aria-activedescendant', activeId)
    else list.removeAttribute('aria-activedescendant')
  }

  function scheduleRows() {
    if (frame !== null || container.hidden || disposed) return
    frame = requestAnimationFrame(() => {
      frame = null
      renderRows()
    })
  }

  function revealActive() {
    const index = activePath === null ? undefined : entryIndex.get(activePath)
    if (index === undefined || container.hidden) return
    const top = index * ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight
  }

  function canMark() {
    return (
      !(baseline === 'checkpoint' && checkpoint?.error) &&
      !openingPath &&
      currentState === 'ready' &&
      currentPath !== null &&
      entryIndex.has(currentPath) &&
      Number.isSafeInteger(currentVersion) &&
      changes.get(currentPath)?.reviewVersion === currentVersion
    )
  }

  function comparisonIndex() {
    const path = openingPath ?? (currentState === null ? null : currentPath)
    return path === null ? undefined : entryIndex.get(path)
  }

  function renderControls() {
    const index = comparisonIndex()
    const canNavigate = entries.length > 1 || (entries.length === 1 && index === undefined)
    previous.disabled = !canNavigate
    next.disabled = !canNavigate
    const state = openingPath ? 'loading' : index === undefined ? null : currentState
    const positionText =
      index === undefined
        ? `${entries.length.toLocaleString()} ${entries.length === 1 ? 'file' : 'files'}`
        : `File ${(index + 1).toLocaleString()} of ${entries.length.toLocaleString()}`
    if (position.textContent !== positionText) position.textContent = positionText

    const reviewable = canMark()
    const advance = reviewable && filter === 'pending' && entries.length > 1
    let action = 'Open comparison'
    /** @type {keyof typeof GLYPHS} */
    let symbol = 'compare'
    let disabled = !entries.length
    if (baseline === 'checkpoint' && checkpoint?.error) {
      action = 'Checkpoint unavailable'
      disabled = true
    } else if (reviewable) {
      action = filter === 'reviewed' ? 'Return to pending' : advance ? 'Mark reviewed & next' : 'Mark reviewed'
      symbol = filter === 'reviewed' ? 'undo' : 'check'
    } else if (state === 'failed') {
      action = 'Retry comparison'
      symbol = 'undo'
    } else if (state) {
      action = {
        loading: 'Loading comparison…',
        saving: 'Saving changes…',
        'save-failed': 'Save required to continue',
        closing: 'Closing…',
        ready: 'Updating comparison…',
      }[state]
      disabled = true
    }
    mark.setAttribute('aria-disabled', String(disabled))
    if (markLabel.textContent !== action) markLabel.textContent = action
    markIcon.toggleAttribute('data-loading-status', state === 'saving')
    if (markIcon.dataset.icon !== symbol) {
      markIcon.dataset.icon = symbol
      markIcon.innerHTML = icon(GLYPHS[symbol])
    }
    markNext.toggleAttribute('hidden', !advance)
  }

  function updateProgress() {
    const total = changes.size
    const done = reviewed.size
    const summary = `${done.toLocaleString()} of ${total.toLocaleString()} reviewed`
    if (count.textContent === summary) return
    count.textContent = summary
    progress.max = total || 1
    progress.value = done
    progress.setAttribute('aria-valuetext', summary)
    container.dataset.complete = String(total > 0 && done === total)
    onProgress({ pending: total - done, total })
  }

  function renderEmpty() {
    const state = !changes.size ? 'clean' : filter === 'reviewed' ? 'reviewed' : 'complete'
    const cleanState = baseline === 'head' ? 'head' : checkpoint?.error ? 'error' : 'checkpoint'
    const key = state === 'clean' ? cleanState : state
    if (empty.dataset.state === key) return
    empty.dataset.state = key
    emptyIcon.innerHTML = icon(GLYPHS[state])
    const [title, description, action] = {
      head: ['Working tree is clean', 'New changes will appear here as they happen.'],
      checkpoint: ['No changes since checkpoint', 'New changes will appear here as they happen.'],
      error: ['Checkpoint comparison unavailable'],
      reviewed: ['No files reviewed yet', 'Mark a file reviewed to find it here.', 'Show pending files'],
      complete: ['Review complete', 'New edits move files back to Pending.', 'View reviewed files'],
    }[key]
    emptyTitle.textContent = title ?? ''
    emptyDescription.textContent = description ?? ''
    emptyDescription.hidden = !description
    emptyAction.hidden = !action
    emptyAction.textContent = action ?? ''
  }

  function project({ resetScroll = false } = {}) {
    const anchor = entries[Math.floor(list.scrollTop / ROW_HEIGHT)]?.path
    const offset = list.scrollTop % ROW_HEIGHT
    entries = []
    entryIndex = new Map()
    for (const file of changes.values()) {
      if (reviewed.has(file.path) !== (filter === 'reviewed')) continue
      entryIndex.set(file.path, entries.length)
      entries.push(file)
    }
    const activeRemoved = activePath !== null && !entryIndex.has(activePath)
    if (activePath === null || activeRemoved)
      activePath = currentPath !== null && entryIndex.has(currentPath) ? currentPath : (entries[0]?.path ?? null)
    rows.style.height = `${entries.length * ROW_HEIGHT}px`
    if (resetScroll) list.scrollTop = 0
    else if (anchor !== undefined) {
      const index = entryIndex.get(anchor)
      if (index !== undefined) list.scrollTop = index * ROW_HEIGHT + offset
    }
    for (const button of filters) {
      const showReviewed = button.dataset.filter === 'reviewed'
      const total = showReviewed ? reviewed.size : changes.size - reviewed.size
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter))
      requireElement(button, 'span', HTMLSpanElement).textContent = total.toLocaleString()
    }
    const focused = document.activeElement
    const isEmpty = entries.length === 0
    if (isEmpty) renderEmpty()
    progressGroup.hidden = filterGroup.hidden = changes.size === 0
    empty.hidden = !isEmpty
    list.hidden = footer.hidden = isEmpty
    if (activeRemoved && focused === list) revealActive()
    renderControls()
    renderRows()
    const focusHidden =
      (filterGroup.hidden && filterGroup.contains(focused)) ||
      (isEmpty && (focused === list || footer.contains(focused))) ||
      (focused === emptyAction && emptyAction.hidden) ||
      (!isEmpty && empty.contains(focused))
    if (focusHidden) focusQueue()
  }

  /** @param {ReviewFile | undefined} file */
  async function choose(file) {
    if (!file || disposed) return
    const generation = ++request
    openingPath = file.path
    activePath = file.path
    error.hidden = true
    revealActive()
    renderControls()
    renderRows()
    try {
      const result = await attemptAsync(() => onOpen(file), { operation: 'Open review comparison' })
      if (generation !== request || disposed) return
      if (!result.ok) {
        reportError(result.error, { silent: true })
        error.textContent = result.error.message
        error.hidden = false
      } else if (result.value === false && currentPath !== null && entryIndex.has(currentPath)) activePath = currentPath
    } finally {
      if (generation === request && !disposed) {
        openingPath = null
        revealActive()
        renderControls()
        renderRows()
      }
    }
  }

  /** @param {ReviewFile | undefined} file */
  function openComparison(file) {
    runTask('Open review comparison', () => choose(file))
  }

  /** @param {-1 | 1} direction */
  function adjacent(direction) {
    const current = comparisonIndex()
    if (current === undefined) return direction > 0 ? entries[0] : entries.at(-1)
    return entries[(current + direction + entries.length) % entries.length]
  }

  function markCurrent() {
    if (!canMark() || currentPath === null || currentVersion === null) return
    if (filter === 'reviewed') {
      reviewed.delete(currentPath)
      updateProgress()
      selectFilter('pending')
      return
    }
    const following = adjacent(1)
    reviewed.set(currentPath, currentVersion)
    updateProgress()
    project()
    if (following && following.path !== currentPath) openComparison(following)
  }

  /** @param {KeyboardEvent} event */
  function navigateList(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || entries.length === 0) return
    const index = (activePath === null ? undefined : entryIndex.get(activePath)) ?? 0
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT))
    /** @type {Record<string, number>} */
    const movement = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      PageDown: index + page,
      PageUp: index - page,
      Home: 0,
      End: entries.length - 1,
    }
    const destination = Object.hasOwn(movement, event.key) ? movement[event.key] : undefined
    if (destination !== undefined) {
      event.preventDefault()
      activePath = entries[Math.min(entries.length - 1, Math.max(0, destination))]?.path ?? activePath
      revealActive()
      renderRows()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openComparison(entries[index])
    }
  }

  /** @param {ReviewFilter} nextFilter */
  function selectFilter(nextFilter) {
    if (nextFilter === filter) return
    filter = nextFilter
    activePath = currentPath
    error.hidden = true
    project({ resetScroll: true })
    revealActive()
    renderRows()
  }

  for (const button of filters)
    button.addEventListener('click', () => {
      const selected = button.dataset.filter
      if (selected === 'pending' || selected === 'reviewed') selectFilter(selected)
    })
  captureButton.addEventListener('click', () => runTask('Capture review checkpoint', capture))
  baselineSelect.addEventListener('change', () => {
    const value = baselineSelect.value
    if (value === 'head' || value === 'checkpoint') onBaseline(value)
  })
  requireElement(container, '.change-review-back', HTMLButtonElement).addEventListener('click', onBack)
  emptyAction.addEventListener('click', () => {
    selectFilter(filter === 'pending' ? 'reviewed' : 'pending')
    focusQueue()
  })
  list.addEventListener('scroll', scheduleRows, { passive: true })
  list.addEventListener('focus', () => {
    if (!list.matches(':focus-visible')) return
    revealActive()
    renderRows()
  })
  list.addEventListener('keydown', navigateList)
  list.addEventListener('click', event => {
    const row = event.target instanceof Element ? event.target.closest('.change-review-row') : null
    if (!(row instanceof HTMLDivElement) || !row.dataset.path) return
    focusQueue()
    openComparison(changes.get(row.dataset.path))
  })
  previous.addEventListener('click', () => openComparison(adjacent(-1)))
  next.addEventListener('click', () => openComparison(adjacent(1)))
  mark.addEventListener('click', () => {
    if (mark.getAttribute('aria-disabled') === 'true') return
    if (canMark()) markCurrent()
    else {
      const path = comparisonIndex() === undefined ? activePath : currentPath
      if (path !== null) openComparison(changes.get(path))
    }
  })
  const resize = new ResizeObserver(scheduleRows)
  resize.observe(list)
  renderBaseline()

  return {
    /** @param {ReviewBaseline} mode @param {ReviewCheckpoint | null} [nextCheckpoint] */
    setBaseline(mode, nextCheckpoint) {
      const replaced = checkpoint?.id !== nextCheckpoint?.id
      const switched = mode !== baseline || (mode === 'checkpoint' && replaced)
      checkpoint = nextCheckpoint
      if (replaced) checkpointReviewed.clear()
      if (switched) {
        baseline = mode
        reviewed = mode === 'head' ? headReviewed : checkpointReviewed
        request++
        openingPath = null
        currentState = null
        currentVersion = null
        activePath = currentPath
        filter = 'pending'
        error.hidden = true
        resetScrollOnUpdate = true
      }
      renderBaseline()
    },
    /** @param {ReviewFile[]} files */
    update(files) {
      changes = new Map(files.map(file => [file.path, file]))
      for (const [path, version] of reviewed) {
        if (changes.get(path)?.reviewVersion !== version) reviewed.delete(path)
      }
      updateProgress()
      if (!container.hidden) {
        project({ resetScroll: resetScrollOnUpdate })
        resetScrollOnUpdate = false
      }
    },
    /** @param {string | null} path @param {ReviewState | null} state @param {number | null} version */
    setCurrent(path, state, version) {
      if (path === currentPath && state === currentState && version === currentVersion) return
      const moved = path !== currentPath
      currentPath = path
      currentState = state
      currentVersion = version
      if (moved && (container.hidden || (path !== null && entryIndex.has(path)))) {
        activePath = path
        revealActive()
      }
      if (!container.hidden) {
        renderControls()
        renderRows()
      }
    },
    /** @param {boolean} visible */
    setVisible(visible) {
      if (visible === !container.hidden) return
      container.hidden = !visible
      if (visible) {
        project({ resetScroll: resetScrollOnUpdate })
        resetScrollOnUpdate = false
        revealActive()
        renderRows()
      } else {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        entries = []
        entryIndex.clear()
        mounted.clear()
        rows.replaceChildren()
        list.removeAttribute('aria-activedescendant')
      }
    },
    focus: focusQueue,
    dispose() {
      disposed = true
      resize.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      container.replaceChildren()
      mounted.clear()
    },
  }
}

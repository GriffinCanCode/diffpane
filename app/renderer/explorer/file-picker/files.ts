import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { projectIcon } from '../../shell/layout/icons.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createSearchFilters, searchableEntries } from '../project-search/search-filters.ts'
import type { LanguageFor, SearchEntry } from '../project-search/search-filters.ts'
import '../search-dialog.css'
import '../search-illustration.css'
import './file-picker.css'
import { createFileSearch } from './search-runtime.ts'
import type { FileSearchResults } from './search-runtime.ts'

type PickerFile = SearchEntry
interface PickerApi {
  files: () => Promise<PickerFile[]>
  onChange?: (callback: (snapshot: { inventoryRevision?: number }) => void) => () => void
}

const ROW_HEIGHT = 54
const NO_RESULTS: FileSearchResults<PickerFile> = {
  length: 0,
  fileAt: () => undefined,
  positions: () => [],
}

function highlight(element: HTMLElement, text: string, offset: number, positions: Set<number>) {
  if (!positions.size) {
    element.textContent = text
    return
  }
  let start = 0
  let cursor = 0
  let index = offset
  let marked = positions.has(index)
  const appendRun = () => {
    const run = text.slice(start, cursor)
    if (marked) {
      const mark = document.createElement('mark')
      mark.textContent = run
      element.append(mark)
    } else element.append(run)
  }
  for (const char of text) {
    const active = positions.has(index++)
    if (active !== marked) {
      appendRun()
      start = cursor
      marked = active
    }
    cursor += char.length
  }
  if (cursor > start) appendRun()
}

/** A searchable file inventory with a bounded number of mounted rows. */
export function createFilePicker(
  api: PickerApi,
  onSelect: (file: PickerFile) => unknown,
  context: () => string = () => '',
  languageFor?: LanguageFor,
  basePath: () => string = () => '',
) {
  const dialog = document.createElement('dialog')
  dialog.id = 'file-picker'
  dialog.className = 'file-picker search-dialog'
  dialog.setAttribute('aria-labelledby', 'picker-title')
  dialog.innerHTML = `
    <header class="picker-heading search-dialog-heading">
      <div><h2 id="picker-title">Search files</h2><p class="picker-context search-dialog-context"></p></div>
      <button type="button" class="picker-close search-dialog-close" aria-label="Close file search" title="Close · Escape">×</button>
    </header>
    <div class="picker-search search-dialog-field">
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="7.8" cy="7.8" r="4.6" stroke="currentColor" stroke-width="1.4"/><path d="m11.3 11.3 3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      <input id="file-search" placeholder="Search files, folders, or paths…" aria-label="Search files" role="combobox" aria-autocomplete="list" aria-controls="file-list" aria-expanded="false" autocomplete="off" spellcheck="false">
      <button type="button" class="picker-clear search-dialog-clear" aria-label="Clear file search" hidden>Clear</button>
    </div>
    <div class="picker-filter-host"></div>
    <div class="picker-summary search-dialog-summary" role="status" aria-live="polite">Reading files…</div>
    <div class="picker-results search-dialog-results">
      <div id="file-list" class="picker-list search-dialog-list" role="listbox" aria-label="Project files" hidden><div class="picker-rows"></div></div>
      <div class="picker-empty search-dialog-empty" hidden>
        <span class="search-illustration" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 19.5v-13a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1V10M3.5 19.5l2.3-7.6a1 1 0 0 1 1-.7h13.6a1 1 0 0 1 .9 1.3l-2.2 6.3a1 1 0 0 1-1 .7H3.5Z"/></svg>
        </span>
        <strong></strong><p></p>
        <button type="button" class="open-button picker-retry" hidden>Try again</button>
      </div>
    </div>
    <footer class="picker-footer search-dialog-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>`
  document.body.appendChild(dialog)
  const input = requireElement(dialog, 'input', HTMLInputElement)
  const list = requireElement(dialog, '.picker-list', HTMLElement)
  const rows = requireElement(dialog, '.picker-rows', HTMLElement)
  const footer = requireElement(dialog, 'footer', HTMLElement)
  const summary = requireElement(dialog, '.picker-summary', HTMLElement)
  const empty = requireElement(dialog, '.picker-empty', HTMLElement)
  const clear = requireElement(dialog, '.picker-clear', HTMLButtonElement)
  const retry = requireElement(dialog, '.picker-retry', HTMLButtonElement)
  const closeButton = requireElement(dialog, '.picker-close', HTMLButtonElement)
  const contextLabel = requireElement(dialog, '.picker-context', HTMLParagraphElement)
  const emptyTitle = requireElement(empty, 'strong', HTMLElement)
  const emptyText = requireElement(empty, 'p', HTMLParagraphElement)
  const search = createFileSearch<PickerFile>()
  const filters = createSearchFilters(
    requireElement(dialog, '.picker-filter-host', HTMLElement),
    'picker-search-filters',
    () => {
      setSearchFiles()
      filter()
    },
    languageFor,
  )
  let filterGeneration = 0
  let inventory: PickerFile[] = []
  let matches = NO_RESULTS
  let renderedMatches = NO_RESULTS
  let renderedSelection = -1
  const mountedRows = new Map<number, HTMLButtonElement>()
  let selected = 0
  let request = 0
  let loading = false
  let failure = ''
  let frame: number | undefined
  let inventoryRevision: number | undefined
  const unsubscribe = api.onChange?.(snapshot => {
    if (snapshot.inventoryRevision === inventoryRevision) return
    inventoryRevision = snapshot.inventoryRevision
    if (dialog.open) runTask('Read project files', () => load(true))
  })

  function showLoadingStatus(active: boolean) {
    summary.toggleAttribute('data-loading-status', active)
    list.setAttribute('aria-busy', String(active))
  }

  function syncResults() {
    list.hidden = !matches.length
    input.setAttribute('aria-expanded', String(!list.hidden))
    footer.dataset.results = String(!list.hidden)
  }

  function setSearchFiles() {
    const predicate = filters.predicate()
    search.setFiles(predicate ? inventory.filter(file => predicate(file)) : inventory)
  }

  function filter(keepSelection: boolean | undefined = false) {
    const previous = keepSelection ? matches.fileAt(selected) : undefined
    const generation = ++filterGeneration
    clear.hidden = !input.value
    const results = search.search(input.value)
    if (results instanceof Promise) {
      summary.textContent = 'Searching project files…'
      summary.dataset.state = 'loading'
      showLoadingStatus(true)
      if (!previous) {
        matches = NO_RESULTS
        rows.style.height = '0px'
      }
      syncResults()
      empty.hidden = matches.length > 0
      empty.dataset.state = 'loading'
      emptyTitle.textContent = 'Finding files and folders'
      emptyText.textContent = ''
      retry.hidden = true
      render()
      runTask('Search files', async () => {
        const result = await attemptAsync(() => results, { operation: 'Search files' })
        if (generation !== filterGeneration || !dialog.open) return
        if (!result.ok) {
          reportError(result.error, { silent: true })
          applyResults(NO_RESULTS, undefined, result.error.message)
        } else if (result.value) applyResults(result.value, previous)
      })
    } else applyResults(results, previous)
  }

  function applyResults(results: FileSearchResults<PickerFile>, previous?: PickerFile, searchError = '') {
    const problem = searchError || failure
    matches = results
    syncResults()
    let index = -1
    if (previous)
      for (let candidate = 0; candidate < matches.length; candidate++) {
        const file = matches.fileAt(candidate)
        if (file?.path !== previous.path || Boolean(file.directory) !== Boolean(previous.directory)) continue
        index = candidate
        break
      }
    selected = Math.max(0, index)
    rows.style.height = `${matches.length * ROW_HEIGHT}px`
    if (index < 0) list.scrollTop = 0
    else scrollToSelection()
    summary.dataset.state = loading ? 'loading' : problem ? 'error' : 'ready'
    const filtered = Boolean(input.value.trim()) || filters.active()
    summary.textContent = loading
      ? 'Reading project files…'
      : problem
        ? 'File search unavailable'
        : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'item' : 'items'}${filtered ? ` found · ${inventory.length.toLocaleString()} in project` : ' in project'}`
    empty.hidden = matches.length > 0
    empty.dataset.state = summary.dataset.state
    emptyTitle.textContent = loading
      ? 'Reading your project'
      : problem
        ? 'Couldn’t load files'
        : filtered
          ? 'No files or folders found'
          : 'No files to show'
    emptyText.textContent = loading
      ? 'Your files will appear here in a moment.'
      : problem ||
        (filtered
          ? 'Try a shorter name, a path, or reset the filters.'
          : 'Tracked and nonignored files will appear here.')
    retry.hidden = !problem
    showLoadingStatus(loading)
    render()
  }

  function render() {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    const height = list.clientHeight || 380
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - 3)
    const end = Math.min(matches.length, start + Math.ceil(height / ROW_HEIGHT) + 6)
    if (renderedMatches !== matches) {
      rows.replaceChildren()
      mountedRows.clear()
      renderedMatches = matches
    }
    if (renderedSelection !== selected) mountedRows.get(renderedSelection)?.setAttribute('aria-selected', 'false')
    for (const [index, button] of mountedRows) {
      if (index >= start && index < end) continue
      button.remove()
      mountedRows.delete(index)
    }
    let next: HTMLButtonElement | null = null
    for (let index = end - 1; index >= start; index--) {
      let button = mountedRows.get(index)
      if (!button) {
        const file = matches.fileAt(index)
        if (!file) continue
        button = createRow(file, index)
        mountedRows.set(index, button)
        rows.insertBefore(button, next)
      }
      next = button
    }
    renderedSelection = selected
    const active = mountedRows.get(selected)
    if (active) {
      active.setAttribute('aria-selected', 'true')
      input.setAttribute('aria-activedescendant', active.id)
    } else input.removeAttribute('aria-activedescendant')
  }

  function createRow(file: PickerFile, index: number) {
    const button = document.createElement('button')
    button.className = 'picker-file search-dialog-option'
    button.id = `picker-file-${index}`
    button.type = 'button'
    button.tabIndex = -1
    button.dataset.path = file.path
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(index === selected))
    button.setAttribute('aria-posinset', String(index + 1))
    button.setAttribute('aria-setsize', String(matches.length))
    button.style.top = `${index * ROW_HEIGHT}px`
    button.title = file.path
    const slash = file.path.lastIndexOf('/')
    const filename = file.path.slice(slash + 1)
    const parentPath = file.path.slice(0, slash + 1)
    const icon = document.createElement('img')
    const source = projectIcon({
      kind: file.directory ? 'directory' : 'file',
      name: filename,
    })
    if (source) icon.src = source
    icon.alt = ''
    const label = document.createElement('div')
    label.className = 'picker-file-label'
    const name = document.createElement('strong')
    const directory = document.createElement('small')
    const highlights = new Set(matches.positions(file))
    highlight(name, filename, highlights.size ? Array.from(parentPath).length : 0, highlights)
    if (parentPath) highlight(directory, parentPath, 0, highlights)
    else directory.textContent = './'
    if (file.directory) directory.append(' · Folder')
    label.append(name, directory)
    const enter = document.createElement('span')
    enter.className = 'picker-enter'
    enter.textContent = '↵'
    enter.setAttribute('aria-hidden', 'true')
    button.append(icon, label, enter)
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', () => choose(index))
    return button
  }

  function choose(index: number) {
    const file = matches.fileAt(index)
    if (!file) return
    dialog.close()
    runTask('Open file search result', () => onSelect(file))
  }

  function scrollToSelection() {
    const top = selected * ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight
  }

  function move(index: number) {
    selected = Math.max(0, Math.min(matches.length - 1, index))
    scrollToSelection()
    render()
  }

  input.addEventListener('input', () => filter())
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !matches.length) return
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT))
    const destinations: Record<string, number> = {
      ArrowDown: selected + 1,
      ArrowUp: selected - 1,
      PageDown: selected + page,
      PageUp: selected - page,
    }
    const destination = Object.hasOwn(destinations, event.key) ? destinations[event.key] : undefined
    if (destination !== undefined) {
      event.preventDefault()
      move(destination)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(selected)
    }
  })
  clear.addEventListener('click', () => {
    input.value = ''
    filter()
    input.focus()
  })
  closeButton.addEventListener('click', () => dialog.close())
  retry.addEventListener('click', () => {
    if (failure) runTask('Read project files', load)
    else filter()
    input.focus()
  })
  list.addEventListener(
    'scroll',
    () => {
      if (dialog.open && frame === undefined) frame = requestAnimationFrame(render)
    },
    { passive: true },
  )
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect()
    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      dialog.close()
  })
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    request++
    filterGeneration++
    loading = false
    showLoadingStatus(false)
    search.dispose()
    inventory = []
    matches = NO_RESULTS
    renderedMatches = NO_RESULTS
    mountedRows.clear()
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    rows.replaceChildren()
    rows.style.height = '0px'
    syncResults()
    input.removeAttribute('aria-activedescendant')
  })
  const resize = new ResizeObserver(() => {
    if (dialog.open) move(selected)
  })
  resize.observe(list)
  window.addEventListener(
    'beforeunload',
    () => {
      request++
      filterGeneration++
      unsubscribe?.()
      search.dispose()
      resize.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    },
    { once: true },
  )

  async function load(refresh = false) {
    const generation = ++request
    if (!refresh) {
      inventory = []
      search.setFiles(inventory)
    }
    loading = true
    showLoadingStatus(true)
    failure = ''
    if (refresh) {
      summary.dataset.state = 'loading'
      summary.textContent = 'Refreshing project files…'
    } else filter()
    const result = await attemptAsync(() => api.files(), { operation: 'Read project files' })
    if (!dialog.open || generation !== request) return
    loading = false
    if (result.ok) {
      inventory = searchableEntries(result.value, basePath())
      filters.update(() => inventory)
      setSearchFiles()
    } else {
      reportError(result.error, { silent: true })
      failure = result.error.message
      inventory = []
      search.setFiles(inventory)
    }
    filter(refresh)
  }

  return async function open() {
    if (dialog.open) {
      input.focus()
      input.select()
      return
    }
    input.value = ''
    contextLabel.textContent = context()
    contextLabel.title = contextLabel.textContent
    dialog.showModal()
    input.focus()
    await load()
  }
}

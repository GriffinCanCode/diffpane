import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { projectIcon } from '../../shell/layout/icons.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createSearchFilters, searchableEntries } from '../project-search/search-filters.ts'
import type { LanguageFor, SearchEntry } from '../project-search/search-filters.ts'
import { createFileSearch } from './search-runtime.ts'

type PickerFile = SearchEntry
interface PickerMatch {
  file: PickerFile
  positions: number[]
}
interface PickerApi {
  files: () => Promise<PickerFile[]>
  onChange?: (callback: (snapshot: { inventoryRevision?: number }) => void) => () => void
}

const ROW_HEIGHT = 54

function highlight(element: HTMLElement, text: string, offset: number, positions: Set<number>) {
  let span: HTMLElement | undefined
  let marked: boolean | undefined
  Array.from(text).forEach((char, index) => {
    const active = positions.has(index + offset)
    if (active !== marked || !span) {
      span = document.createElement(active ? 'mark' : 'span')
      element.append(span)
    }
    span.append(char)
    marked = active
  })
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
  dialog.className = 'file-picker'
  dialog.setAttribute('aria-labelledby', 'picker-title')
  dialog.innerHTML = `<header class="picker-heading"><div><h2 id="picker-title">Search files</h2><p class="picker-context"></p></div><button type="button" class="picker-close" aria-label="Close file search" title="Close · Escape">×</button></header><div class="picker-search"><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="7.8" cy="7.8" r="4.6" stroke="currentColor" stroke-width="1.4"/><path d="m11.3 11.3 3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input id="file-search" placeholder="Search files, folders, or paths…" aria-label="Search files" role="combobox" aria-autocomplete="list" aria-controls="file-list" aria-expanded="true" autocomplete="off" spellcheck="false"><button type="button" class="picker-clear" aria-label="Clear file search" hidden>Clear</button><kbd>esc</kbd></div><div class="picker-filter-host"></div><div class="picker-summary" role="status" aria-live="polite">Reading files…</div><div class="picker-results"><div id="file-list" class="picker-list" role="listbox" aria-label="Project files"><div class="picker-rows"></div></div><div class="picker-empty" hidden><strong></strong><p></p><button type="button" class="open-button picker-retry" hidden>Try again</button></div></div><footer class="picker-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>↵</kbd> Open</span><span>Tracked + untracked</span></footer>`
  document.body.appendChild(dialog)
  const input = requireElement(dialog, 'input', HTMLInputElement)
  const list = requireElement(dialog, '.picker-list', HTMLElement)
  const rows = requireElement(dialog, '.picker-rows', HTMLElement)
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
    () => {
      search.setFiles(inventory.filter(filters.matches))
      filter()
    },
    languageFor,
  )
  let filterGeneration = 0
  let inventory: PickerFile[] = []
  let matches: PickerMatch[] = []
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

  function filter(keepSelection: boolean | undefined = false) {
    const selectedPath = keepSelection ? matches[selected]?.file.path : null
    const generation = ++filterGeneration
    const results = search.search(input.value)
    if (results instanceof Promise) {
      summary.textContent = 'Searching project files…'
      showLoadingStatus(true)
      if (!selectedPath) matches = []
      render()
      runTask('Search files', async () => {
        const result = await attemptAsync(() => results, { operation: 'Search files' })
        if (generation !== filterGeneration || !dialog.open) return
        if (!result.ok) {
          reportError(result.error, { silent: true })
          applyResults([], null, result.error.message)
        } else if (result.value) applyResults(result.value, selectedPath)
      })
    } else applyResults(results, selectedPath)
  }

  function applyResults(results: PickerMatch[], selectedPath?: string | null, searchError = '') {
    const problem = searchError || failure
    matches = results
    const previous = selectedPath ? matches.findIndex(match => match.file.path === selectedPath) : -1
    selected = Math.max(0, previous)
    if (previous < 0) list.scrollTop = 0
    clear.hidden = !input.value
    summary.textContent = loading
      ? 'Reading project files…'
      : problem
        ? 'File search unavailable'
        : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'item' : 'items'}${input.value.trim() ? ` found · ${inventory.length.toLocaleString()} in project` : ' in project'}`
    empty.hidden = matches.length > 0
    emptyTitle.textContent = loading
      ? 'Reading your project'
      : problem
        ? 'Couldn’t load files'
        : input.value.trim()
          ? 'No files or folders found'
          : 'No files to show'
    emptyText.textContent = loading
      ? 'Your files will appear here in a moment.'
      : problem ||
        (input.value.trim()
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
    rows.style.height = `${matches.length * ROW_HEIGHT}px`
    const fragment = document.createDocumentFragment()
    for (let index = start; index < end; index++) {
      const match = matches[index]
      if (!match) continue
      const { file, positions } = match
      const button = document.createElement('button')
      button.className = 'picker-file'
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
      const highlights = new Set(positions)
      highlight(name, filename, Array.from(file.path.slice(0, slash + 1)).length, highlights)
      highlight(directory, (file.path.slice(0, slash + 1) || './') + (file.directory ? ' · Folder' : ''), 0, highlights)
      label.append(name, directory)
      const enter = document.createElement('span')
      enter.className = 'picker-enter'
      enter.textContent = '↵'
      enter.setAttribute('aria-hidden', 'true')
      button.append(icon, label, enter)
      button.addEventListener('mousedown', event => event.preventDefault())
      button.addEventListener('click', () => choose(index))
      fragment.appendChild(button)
    }
    rows.replaceChildren(fragment)
    if (document.getElementById(`picker-file-${selected}`))
      input.setAttribute('aria-activedescendant', `picker-file-${selected}`)
    else input.removeAttribute('aria-activedescendant')
  }

  function choose(index: number) {
    const result = matches[index]
    if (!result) return
    dialog.close()
    runTask('Open file search result', () => onSelect(result.file))
  }

  function move(index: number) {
    selected = Math.max(0, Math.min(matches.length - 1, index))
    const top = selected * ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight
    render()
  }

  input.addEventListener('input', () => filter())
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
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
    matches = []
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    rows.replaceChildren()
    rows.style.height = '0px'
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
    if (refresh) summary.textContent = 'Refreshing project files…'
    else filter()
    const result = await attemptAsync(() => api.files(), { operation: 'Read project files' })
    if (!dialog.open || generation !== request) return
    loading = false
    if (result.ok) {
      inventory = searchableEntries(result.value, basePath())
      filters.update(inventory)
      search.setFiles(inventory.filter(filters.matches))
    } else {
      reportError(result.error, { silent: true })
      failure = result.error.message
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
    dialog.showModal()
    input.focus()
    await load()
  }
}

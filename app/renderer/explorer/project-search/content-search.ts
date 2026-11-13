import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { rendererDiagnostics } from '../../shell/diagnostics/diagnostics.ts'
import { showErrorBoundary } from '../../shell/recovery/error-boundary.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import '../search-dialog.css'
import '../search-illustration.css'
import './content-search.css'

export interface ContentMatch {
  path: string
  line: number
  column: number
  length: number
  before: string
  match: string
  after: string
}

type Scope = 'workspace' | 'changed'
interface SearchApi {
  contentSearch: (options: { query: string; scope: Scope; matchCase: boolean }) => Promise<{
    matches: ContentMatch[]
    truncated: boolean
  } | null>
  cancelContentSearch: () => Promise<void>
}

const SEARCH_DELAY = 150
const LIVE_DELAY = 350
const MAX_QUERY_LENGTH = 256

function node(tag: string, className: string, text = '') {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

export function createContentSearch(api: SearchApi, onSelect: (match: ContentMatch) => unknown) {
  const dialog = document.createElement('dialog')
  dialog.id = 'content-search'
  dialog.className = 'content-search search-dialog'
  dialog.setAttribute('aria-labelledby', 'content-search-title')
  dialog.innerHTML = `
    <header class="content-search-heading search-dialog-heading">
      <div><h2 id="content-search-title">Search in project</h2><p class="content-search-context search-dialog-context"></p></div>
      <button type="button" class="content-search-close search-dialog-close" aria-label="Close project search" title="Close · Escape">×</button>
    </header>
    <div class="content-search-field search-dialog-field">
      <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="7.8" cy="7.8" r="4.6" stroke="currentColor" stroke-width="1.4"/><path d="m11.3 11.3 3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      <input aria-label="Search file contents" placeholder="Find text in files…" role="combobox" aria-controls="content-search-results" aria-expanded="false" aria-autocomplete="list" autocomplete="off" spellcheck="false" maxlength="${MAX_QUERY_LENGTH}" autofocus>
      <button type="button" class="content-search-clear search-dialog-clear" aria-label="Clear search" hidden>Clear</button>
    </div>
    <div class="content-search-toolbar">
      <div class="content-search-scopes" role="group" aria-label="Search scope">
        <button type="button" data-scope="workspace" aria-pressed="true">All files</button>
        <button type="button" data-scope="changed" aria-pressed="false">Changed files</button>
      </div>
      <button type="button" class="content-search-case" aria-pressed="false">Match case</button>
    </div>
    <p class="content-search-summary search-dialog-summary" role="status"></p>
    <div class="content-search-body search-dialog-results">
      <div class="content-search-results search-dialog-list" id="content-search-results" role="listbox" aria-label="Matching lines" hidden></div>
      <div class="content-search-empty search-dialog-empty" hidden>
        <span class="search-illustration" aria-hidden="true">
          <svg viewBox="0 0 96 60" fill="none" stroke-linecap="round">
            <path class="search-art-context" d="M13 14h27M13 24h45M13 34h31M13 44h35"/>
            <path d="m67 39 13 13" stroke="currentColor" stroke-width="6"/>
            <path d="m70 42 9 9" stroke="var(--illustration-light)" stroke-width="1.2"/>
            <circle cx="56" cy="28" r="16" fill="var(--illustration-fill)" stroke="currentColor" stroke-width="2.6"/>
            <path d="M46 25a11 11 0 0 1 8-7" stroke="var(--illustration-light)" stroke-width="1.4"/>
            <path d="M46 29h20m-18 6h12" stroke="var(--illustration-light)" stroke-width="1.5"/>
            <path d="M52 29h11" stroke="currentColor" stroke-width="3.2"/>
          </svg>
        </span>
        <p></p>
      </div>
      <div class="content-search-error" hidden></div>
    </div>
    <footer class="content-search-footer search-dialog-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open match</span><span><kbd>Esc</kbd> Close</span></footer>`
  document.body.append(dialog)

  const input = requireElement(dialog, 'input', HTMLInputElement)
  const results = requireElement(dialog, '.content-search-results', HTMLElement)
  const footer = requireElement(dialog, 'footer', HTMLElement)
  const summary = requireElement(dialog, '.content-search-summary', HTMLElement)
  const empty = requireElement(dialog, '.content-search-empty', HTMLElement)
  const emptyMessage = requireElement(empty, 'p', HTMLParagraphElement)
  const context = requireElement(dialog, '.content-search-context', HTMLElement)
  const clear = requireElement(dialog, '.content-search-clear', HTMLButtonElement)
  const matchCaseButton = requireElement(dialog, '.content-search-case', HTMLButtonElement)
  const failure = requireElement(dialog, '.content-search-error', HTMLElement)
  const scopes = dialog.querySelectorAll<HTMLButtonElement>('[data-scope]')
  let scope: Scope = 'workspace'
  let matchCase = false
  let matches: ContentMatch[] = []
  let options: HTMLElement[] = []
  let selected = -1
  let generation = 0
  let timer: number | undefined
  let inFlight = false
  let refreshPending = false

  function select(index: number, reveal = false) {
    options[selected]?.setAttribute('aria-selected', 'false')
    selected = options.length ? Math.max(0, Math.min(index, options.length - 1)) : -1
    const active = options[selected]
    if (active) {
      active.setAttribute('aria-selected', 'true')
      input.setAttribute('aria-activedescendant', active.id)
      if (reveal) active.scrollIntoView({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
  }

  function render(next: ContentMatch[], status: string, detail = '', preserve = false) {
    const previous = preserve ? matches[selected] : undefined
    const scrollTop = preserve ? results.scrollTop : 0
    matches = next
    options = []
    const list = document.createDocumentFragment()
    let file: HTMLElement | undefined
    let lastPath: string | undefined
    for (const [index, hit] of matches.entries()) {
      if (!file || hit.path !== lastPath) {
        const label = node('p', 'content-search-path', hit.path)
        label.setAttribute('aria-hidden', 'true')
        label.title = hit.path
        file = node('div', 'content-search-file')
        file.setAttribute('role', 'group')
        file.setAttribute('aria-label', hit.path)
        file.append(label)
        list.append(file)
        lastPath = hit.path
      }
      const row = node('div', 'content-search-hit search-dialog-option')
      row.id = `content-search-hit-${index}`
      row.dataset.index = String(index)
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.setAttribute('aria-label', `${hit.path}:${hit.line} ${hit.before}${hit.match}${hit.after}`)
      const snippet = node('code', 'content-search-snippet')
      if (hit.before) snippet.append(node('span', 'content-search-before', hit.before))
      snippet.append(node('mark', '', hit.match))
      if (hit.after) snippet.append(node('span', '', hit.after))
      row.append(node('span', 'content-search-line', String(hit.line)), snippet)
      file.append(row)
      options.push(row)
    }
    results.replaceChildren(list)
    results.hidden = !matches.length
    input.setAttribute('aria-expanded', String(!results.hidden))
    footer.dataset.results = String(!results.hidden)
    empty.hidden = !detail
    emptyMessage.textContent = detail
    summary.textContent = status
    const same = previous ? matches.findIndex(hit => hit.path === previous.path && hit.line === previous.line) : -1
    results.scrollTop = same >= 0 ? scrollTop : 0
    select(same, same >= 0)
  }

  async function search(preserve: boolean) {
    const startedAt = performance.now()
    const request = generation
    inFlight = true
    if (!preserve) {
      summary.setAttribute('data-loading-status', '')
      results.setAttribute('aria-busy', 'true')
    }
    try {
      const result = await attemptAsync(() => api.contentSearch({ query: input.value, scope, matchCase }), {
        operation: 'Search project contents',
      })
      rendererDiagnostics.measure('renderer.project-search-query', startedAt, result)
      if (request !== generation || !dialog.open) return
      if (!result.ok) {
        reportError(result.error, { silent: true })
        summary.dataset.state = 'error'
        render([], 'Search failed')
        failure.hidden = false
        showErrorBoundary(failure, {
          title: 'Couldn’t search the project',
          message: 'Try the search again.',
          detail: result.error.message,
          retry: () => {
            start()
            input.focus()
          },
          focus: false,
        })
        return
      }
      if (!result.value) return
      clearFailure()
      delete summary.dataset.state
      const { matches: found, truncated } = result.value
      const lines = found.length
      const files = new Set(found.map(hit => hit.path)).size
      const status = lines
        ? `${lines.toLocaleString()} matching ${lines === 1 ? 'line' : 'lines'} in ${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}`
        : 'No matches found'
      render(
        found,
        truncated ? (lines ? `${status} · Search limit reached` : 'Search limit reached') : status,
        lines
          ? ''
          : truncated
            ? 'No matches in the files checked. Try searching changed files.'
            : 'Try a different search term or scope.',
        preserve,
      )
    } finally {
      if (request === generation) {
        inFlight = false
        summary.removeAttribute('data-loading-status')
        results.removeAttribute('aria-busy')
        if (refreshPending) refresh()
      }
    }
  }

  function stop() {
    generation++
    window.clearTimeout(timer)
    timer = undefined
    refreshPending = false
    summary.removeAttribute('data-loading-status')
    results.removeAttribute('aria-busy')
    if (inFlight) runTask('Cancel project search', () => api.cancelContentSearch(), { silent: true })
    inFlight = false
  }

  function queue(delay: number, preserve: boolean) {
    timer = window.setTimeout(() => {
      timer = undefined
      runTask('Search project contents', () => search(preserve))
    }, delay)
  }

  function clearFailure() {
    failure.hidden = true
    failure.replaceChildren()
  }

  function start() {
    stop()
    clear.hidden = !input.value
    clearFailure()
    delete summary.dataset.state
    if (input.value) {
      render([], 'Searching…')
      queue(SEARCH_DELAY, false)
    } else render([], '', 'Enter text to search.')
  }

  function refresh() {
    if (!dialog.open || !input.value || timer !== undefined) return
    refreshPending = inFlight
    if (!inFlight) queue(LIVE_DELAY, true)
  }

  function close() {
    stop()
    if (dialog.open) dialog.close()
  }

  function choose(index: number) {
    const hit = matches[index]
    if (!hit) return
    close()
    runTask('Open project search result', () => onSelect(hit))
  }

  input.addEventListener('input', start)
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !options.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      select(selected + (event.key === 'ArrowDown' ? 1 : -1), true)
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      const rowHeight = options[selected]?.offsetHeight
      if (!rowHeight) return
      event.preventDefault()
      const page = Math.max(1, Math.floor(results.clientHeight / rowHeight))
      select(selected + (event.key === 'PageDown' ? page : -page), true)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(selected)
    }
  })
  results.addEventListener('mousedown', event => {
    if (event.target instanceof Element && event.target.closest('[data-index]')) event.preventDefault()
  })
  results.addEventListener('click', event => {
    const row = event.target instanceof Element ? event.target.closest('[data-index]') : null
    if (!(row instanceof HTMLElement) || row.dataset.index === undefined) return
    const index = Number(row.dataset.index)
    if (Number.isSafeInteger(index) && index >= 0) choose(index)
  })
  for (const button of scopes)
    button.addEventListener('click', () => {
      const next = button.dataset.scope
      if (next !== 'workspace' && next !== 'changed') return
      if (scope !== next) {
        scope = next
        for (const item of scopes) item.setAttribute('aria-pressed', String(item === button))
        start()
      }
    })
  matchCaseButton.addEventListener('click', () => {
    matchCase = !matchCase
    matchCaseButton.setAttribute('aria-pressed', String(matchCase))
    start()
  })
  clear.addEventListener('click', () => {
    input.value = ''
    start()
    input.focus()
  })
  requireElement(dialog, '.content-search-close', HTMLButtonElement).addEventListener('click', close)
  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    close()
  })
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect()
    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      close()
  })

  return {
    get isOpen() {
      return dialog.open
    },
    open(project: string, selection = '') {
      if (!dialog.open) {
        context.textContent = project
        context.title = project
        if (selection && selection.length <= MAX_QUERY_LENGTH && !/[\r\n]/u.test(selection)) input.value = selection
        dialog.showModal()
        start()
      }
      input.focus()
      input.select()
    },
    refresh,
    dispose() {
      close()
      dialog.remove()
    },
  }
}

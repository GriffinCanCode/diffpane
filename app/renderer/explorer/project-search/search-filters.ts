export interface SearchEntry {
  path: string
  directory?: boolean
}
export interface SearchFilters {
  kind: string
  language: string
  extension: string
  folder: string
}
export type LanguageFor = (path: string) => string
export function emptyFilters(): SearchFilters {
  return { kind: 'all', language: '', extension: '', folder: '' }
}
export function hasFilters(filters: SearchFilters) {
  return filters.kind !== 'all' || Boolean(filters.language || filters.extension || filters.folder)
}
export function fileExtension(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLocaleLowerCase() : '(no extension)'
}
export function matchesFilters(entry: SearchEntry, filters: SearchFilters, languageFor?: LanguageFor) {
  return filterPredicate(filters, languageFor)?.(entry) ?? true
}

export function filterPredicate(
  { kind, language, extension, folder }: SearchFilters,
  languageFor: LanguageFor = () => 'Plain text',
) {
  if (kind === 'all' && !language && !extension && !folder) return undefined
  const normalizedFolder = folder
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/\/+$/u, '')
    .toLocaleLowerCase()
  const prefix = `${normalizedFolder}/`
  return (entry: SearchEntry, foldedPath?: string) => {
    if (kind === 'files' && entry.directory) return false
    if (kind === 'folders' && !entry.directory) return false
    if (language && (entry.directory || languageFor(entry.path) !== language)) return false
    if (extension && (entry.directory || fileExtension(entry.path) !== extension)) return false
    if (!normalizedFolder) return true
    const path = foldedPath ?? entry.path.toLocaleLowerCase()
    return path.startsWith(prefix) || (entry.directory === true && path === normalizedFolder)
  }
}

/** Include each known folder once without scanning ignored directories on disk. */
export function searchableEntries<T extends SearchEntry>(files: readonly T[], basePath = ''): (T | SearchEntry)[] {
  const entries = new Map<string, T | SearchEntry>()
  for (const file of files) {
    if (basePath && !file.path.startsWith(`${basePath}/`)) continue
    if (!file.directory) entries.set(`file:${file.path}`, file)
    else entries.set(`dir:${file.path}`, file)
    let slash = file.path.lastIndexOf('/')
    while (slash > 0) {
      const path = file.path.slice(0, slash)
      if (basePath && (path === basePath || !path.startsWith(`${basePath}/`))) break
      if (!entries.has(`dir:${path}`)) entries.set(`dir:${path}`, { path, directory: true })
      slash = path.lastIndexOf('/')
    }
  }
  return [...entries.values()]
}

export function createSearchFilters(
  host: HTMLElement,
  panelId: string,
  onChange: () => void,
  languageFor: LanguageFor = () => 'Plain text',
) {
  const bar = document.createElement('div')
  bar.className = 'search-filter-bar'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'search-filter-toggle'
  toggle.textContent = 'Filters'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-controls', panelId)
  const panel = document.createElement('div')
  panel.className = 'search-filter-panel'
  panel.id = panelId
  panel.hidden = true
  const controls = {
    kind: document.createElement('select'),
    language: document.createElement('select'),
    extension: document.createElement('select'),
    folder: document.createElement('input'),
  }
  controls.folder.placeholder = 'Folder path…'
  controls.folder.type = 'search'
  for (const [key, title] of [
    ['kind', 'Show'],
    ['language', 'Language'],
    ['extension', 'File type'],
    ['folder', 'Folder'],
  ] as const) {
    const label = document.createElement('label')
    label.append(document.createTextNode(title))
    const control = controls[key]
    control.dataset.filter = key
    label.append(control)
    panel.append(label)
    control.addEventListener(key === 'folder' ? 'input' : 'change', () => {
      updateLabel()
      onChange()
    })
  }
  for (const [optionValue, label] of [
    ['all', 'Files and folders'],
    ['files', 'Files only'],
    ['folders', 'Folders only'],
  ] as const)
    controls.kind.add(new Option(label, optionValue))
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'search-filter-reset'
  reset.textContent = 'Reset filters'
  reset.disabled = true
  panel.append(reset)
  bar.append(toggle, panel)
  host.append(bar)
  let pendingEntries: (() => Iterable<SearchEntry>) | undefined
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    toggle.setAttribute('aria-expanded', String(!panel.hidden))
    if (!panel.hidden && pendingEntries) updateOptions(pendingEntries())
  })
  function value(): SearchFilters {
    return {
      kind: controls.kind.value,
      language: controls.language.value,
      extension: controls.extension.value,
      folder: controls.folder.value,
    }
  }
  function updateLabel() {
    const filters = value()
    const count =
      Number(filters.kind !== 'all') +
      Number(Boolean(filters.language)) +
      Number(Boolean(filters.extension)) +
      Number(Boolean(filters.folder))
    toggle.textContent = count ? `Filters · ${count}` : 'Filters'
    toggle.setAttribute('aria-label', count ? `Search filters, ${count} active` : 'Search filters')
    toggle.dataset.active = String(count > 0)
    reset.disabled = count === 0
  }
  function resetControls() {
    for (const [key, control] of Object.entries(controls)) control.value = key === 'kind' ? 'all' : ''
    updateLabel()
  }
  reset.addEventListener('click', () => {
    resetControls()
    toggle.focus()
    onChange()
  })
  function updateOptions(entries: Iterable<SearchEntry>) {
    pendingEntries = undefined
    const languages = new Set<string>()
    const extensions = new Set<string>()
    for (const entry of entries)
      if (!entry.directory) {
        languages.add(languageFor(entry.path))
        extensions.add(fileExtension(entry.path))
      }
    for (const [key, options, label] of [
      ['language', languages, 'All languages'],
      ['extension', extensions, 'All file types'],
    ] as const) {
      const select = controls[key]
      const selected = select.value
      select.replaceChildren(new Option(label, ''))
      for (const option of [...options].toSorted((a, b) => a.localeCompare(b))) select.add(new Option(option, option))
      if (options.has(selected)) select.value = selected
    }
    updateLabel()
  }
  return {
    value,
    reset: resetControls,
    active: () => hasFilters(value()),
    predicate: () => filterPredicate(value(), languageFor),
    matches: (entry: SearchEntry) => matchesFilters(entry, value(), languageFor),
    update(entries: Iterable<SearchEntry> | (() => Iterable<SearchEntry>)) {
      if (typeof entries !== 'function') updateOptions(entries)
      else if (!panel.hidden || controls.language.value || controls.extension.value) updateOptions(entries())
      else pendingEntries = entries
    },
  }
}

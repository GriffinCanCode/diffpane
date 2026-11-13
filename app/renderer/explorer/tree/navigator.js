import { IDEA_FILE_DRAG_TYPE } from '../../../shared/ideas/ideas.ts'
// MONOLITHIC: Incremental tree reconciliation, virtualized rows and keyboard focus share one navigation state. Extract the viewport once focus restoration and expansion can be verified at its boundary.
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createSearchFilters, hasFilters, matchesFilters } from '../project-search/search-filters.ts'
import { createFileActions } from './file-actions.ts'
import { applyNavigationDelta, reconcileNavigationTree } from './navigation-reconcile.ts'

/**
 * @import { NavigationFile, NavigationNode, NavigationTree } from './navigation-reconcile.ts'
 * @import { SearchFilters, LanguageFor } from '../project-search/search-filters.ts'
 * @import { InventoryUpdate } from '../../../electron/runtime/session/inventory-delta.ts'
 * @import { ShortcutAction } from '../../../shared/preferences/shortcuts.ts'
 */
/** @typedef {{ node: NavigationNode, depth: number }} NavigationRow */
/**
 * @typedef {{
 *   root: string,
 *   scope?: string | null,
 *   files: NavigationFile[],
 *   initialPath?: string | null,
 *   revision?: number,
 *   inventoryRevision?: number,
 *   changedPaths?: string[],
 *   error?: undefined,
 * }} NavigatorSnapshot
 */
/**
 * @typedef {{
 *   files: () => Promise<NavigationFile[]>,
 *   filesDelta?: (revision: number | null) => Promise<InventoryUpdate>,
 *   directoryExpanded?: (path: string, expanded: boolean) => Promise<unknown>,
 *   fileAction: Parameters<typeof createFileActions>[0]['fileAction'],
 * }} NavigatorApi
 */
/**
 * @typedef {{
 *   iconFor?: (node: NavigationNode, expanded: boolean) => string | undefined,
 *   onPick?: () => unknown,
 *   onFolder?: () => unknown,
 *   onOutline?: (element: HTMLElement) => unknown,
 *   onMutate?: (action: string, path: string, name?: string) => Promise<unknown>,
 *   onAttach?: Parameters<typeof createFileActions>[3],
 *   languageFor?: LanguageFor,
 *   onReady?: () => unknown,
 *   matchesShortcut?: (event: KeyboardEvent, action: ShortcutAction) => boolean,
 * }} NavigatorOptions
 */

const ROW_HEIGHT = 22
const OVERSCAN = 4
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
let instance = 0

const ICONS = {
  openFile:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8.5 1.5H2v13h5m1.5-13L12 5H8.5V1.5ZM12 8v7m-3.5-3.5h7" stroke="currentColor" stroke-linejoin="round"/></svg>',
  openFolder:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7 13.5H1.5v-11h4L7 4h7.5v3M1.5 6.5h13M12 9v6m-3-3h6" stroke="currentColor" stroke-linejoin="round"/></svg>',
  collapse:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3H3v8h2m1-6h7v8H6V5Zm2 4h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.8 6.3A5 5 0 1 0 12.4 11m.4-4.7V3.4m0 2.9H9.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.9" cy="6.9" r="4" stroke="currentColor" stroke-width="1.2"/><path d="m10 10 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
}

/**
 * Build metadata for the explorer.
 * @param {NavigationFile[]} inventory
 * @param {string} [basePath]
 * @returns {NavigationTree}
 */
export function buildNavigationTree(inventory, basePath = '') {
  /** @type {NavigationNode} */
  const root = {
    key: `dir:${basePath}`,
    path: basePath,
    name: '',
    kind: 'directory',
    parentKey: null,
    children: [],
    changedCount: 0,
  }
  /** @type {NavigationTree} */
  const tree = { root, nodes: new Map([[root.key, root]]), files: new Map(), directories: new Map() }
  return reconcileNavigationTree(tree, inventory, basePath) ?? tree
}

/**
 * @param {NavigationTree} tree
 * @param {ReadonlySet<string>} expanded
 * @param {string} [query]
 * @param {SearchFilters} [filters]
 * @param {LanguageFor} [languageFor]
 * @returns {NavigationRow[]}
 */
export function flattenNavigationTree(tree, expanded, query = '', filters, languageFor) {
  if (query || (filters && hasFilters(filters))) {
    const needle = query.toLocaleLowerCase()
    tree.searchFiles ??= [...tree.files.values()].toSorted((a, b) => COLLATOR.compare(a.path, b.path))
    return tree.searchFiles
      .concat([...tree.nodes.values()].filter(node => node.kind === 'directory' && node !== tree.root))
      .filter(
        node =>
          (!needle || (node.searchPath ??= node.path.toLocaleLowerCase()).includes(needle)) &&
          (!filters || matchesFilters({ path: node.path, directory: node.kind === 'directory' }, filters, languageFor)),
      )
      .map(node => ({ node, depth: 1 }))
  }
  /** @type {NavigationRow[]} */
  const visible = []
  const stack = [{ node: tree.root, depth: 0 }]
  for (let row = stack.pop(); row; row = stack.pop()) {
    visible.push(row)
    const children = row.node.children
    if (children && expanded.has(row.node.path)) {
      for (let index = children.length - 1; index >= 0; index--) {
        const node = children[index]
        if (node) stack.push({ node, depth: row.depth + 1 })
      }
    }
  }
  return visible
}

/** @param {NavigationFile | null | undefined} file */
export function navigationStatus(file) {
  if (file?.conflicted) return '!'
  const status = file?.worktree && ![' ', '.'].includes(file.worktree) ? file.worktree : file?.index
  return !status || [' ', '.'].includes(status) ? '' : status === '?' ? 'U' : status
}

/** @param {string | null | undefined} path */
function lastPathSegment(path) {
  return path?.split(/[\\/]/).findLast(segment => segment.length > 0) ?? ''
}

/** @param {NavigatorSnapshot} snapshot */
function scopePrefix(snapshot) {
  const root = snapshot.root?.replaceAll('\\', '/').replace(/\/$/, '') ?? ''
  const scope = snapshot.scope?.replaceAll('\\', '/').replace(/\/$/, '') ?? root
  return scope.startsWith(`${root}/`) ? scope.slice(root.length + 1) : ''
}

/**
 * @param {HTMLElement} container
 * @param {NavigatorApi} api
 * @param {(file: NavigationFile) => unknown} onOpen
 * @param {NavigatorOptions} [options]
 */
export function createNavigator(
  container,
  api,
  onOpen,
  { iconFor, onPick, onFolder, onOutline, onMutate, onAttach, languageFor, onReady, matchesShortcut } = {},
) {
  const id = ++instance
  container.classList.add('navigator')
  container.style.setProperty('--navigator-row-height', `${ROW_HEIGHT}px`)
  container.setAttribute('aria-label', 'Project explorer')
  container.dataset.searching = 'false'
  container.innerHTML = `<div class="navigator-heading"><button type="button" class="navigator-root" data-action="root" aria-expanded="true"><span class="navigator-chevron" aria-hidden="true"></span><span class="navigator-project">Project</span></button><div class="navigator-actions"><button type="button" class="navigator-action" data-action="open-file" aria-label="Search files" title="Search files">${ICONS.openFile}</button><button type="button" class="navigator-action" data-action="open-folder" aria-label="Open folder" title="Open folder">${ICONS.openFolder}</button><button type="button" class="navigator-action" data-action="refresh" aria-label="Refresh explorer" title="Refresh explorer">${ICONS.refresh}</button><button type="button" class="navigator-action" data-action="collapse" aria-label="Collapse folders" title="Collapse folders">${ICONS.collapse}</button></div></div><div class="navigator-search">${ICONS.search}<input type="search" placeholder="Find files or folders…" aria-label="Find files or folders in explorer" spellcheck="false" autocomplete="off"></div><div class="navigator-filter-host"></div><div class="navigator-summary" role="status">Reading files…</div><div class="navigator-tree" role="tree" aria-label="Project files" tabindex="0"><div class="navigator-rows"></div></div><details class="navigator-outline"><summary>Outline</summary><div class="symbol-list navigator-symbols"></div></details><div class="navigator-footer"><span>Project files</span><span class="navigator-total"></span></div>`
  const list = requireElement(container, '.navigator-tree', HTMLDivElement)
  const rows = requireElement(container, '.navigator-rows', HTMLDivElement)
  const input = requireElement(container, 'input', HTMLInputElement)
  const summary = requireElement(container, '.navigator-summary', HTMLDivElement)
  const total = requireElement(container, '.navigator-total', HTMLSpanElement)
  const refreshButton = requireElement(container, '[data-action="refresh"]', HTMLButtonElement)
  const rootButton = requireElement(container, '[data-action="root"]', HTMLButtonElement)
  const outline = requireElement(container, '.navigator-outline', HTMLDetailsElement)
  const heading = requireElement(container, '.navigator-heading', HTMLDivElement)
  const project = requireElement(container, '.navigator-project', HTMLSpanElement)
  const symbols = requireElement(outline, '.symbol-list', HTMLDivElement)
  function onOutlineToggle() {
    if (outline.open) runTask('Show navigator outline', () => onOutline?.(symbols))
  }
  outline.addEventListener('toggle', onOutlineToggle)
  let tree = buildNavigationTree([])
  let expanded = new Set([''])
  /** @type {NavigationRow[]} */
  let visible = []
  /** @type {Map<string, number>} */
  let visibleIndex = new Map()
  /** @type {NavigatorSnapshot | null} */
  let snapshot = null
  /** @type {string | null} */
  let key = null
  /** @type {Set<string> | null} */
  let signature = null
  /** @type {number | undefined} */
  let inventoryRevision
  /** @type {number | null} */
  let appliedInventoryRevision = null
  /** @type {string | null} */
  let activeKey = tree.root.key
  /** @type {string | null} */
  let selectedPath = null
  /** @type {string | null} */
  let revealPath = null
  /** @type {Set<NavigationNode>} */
  let statusNodes = new Set()
  /** @type {Map<string, NavigationFile>} */
  let changes = new Map()
  let loading = false
  let wanted = 0
  let disposed = false
  /** @type {number | null} */
  let frame = null
  let query = ''
  let catalogRequests = 0
  /** @type {Map<string, HTMLDivElement>} */
  const mounted = new Map()
  const filters = createSearchFilters(
    requireElement(container, '.navigator-filter-host', HTMLDivElement),
    onSearch,
    languageFor,
  )
  const actions = createFileActions(
    api,
    async (action, pathname, name) => {
      if (action === 'open') {
        const node = tree.files.get(pathname) ?? tree.nodes.get(`dir:${pathname}`)
        if (node) choose(node)
      } else await onMutate?.(action, pathname, name)
    },
    message => {
      summary.textContent = message
      container.dataset.searching = 'true'
    },
    onAttach,
  )
  function searching() {
    return Boolean(query) || filters.active()
  }

  function schedule() {
    if (frame !== null || disposed) return
    frame = requestAnimationFrame(() => {
      frame = null
      render()
    })
  }

  function refreshProjection(preserve = true) {
    const index = Math.floor(list.scrollTop / ROW_HEIGHT)
    const anchor = preserve ? visible[index]?.node.key : null
    const offset = list.scrollTop % ROW_HEIGHT
    visible = flattenNavigationTree(tree, expanded, query, filters.value(), languageFor)
    if (!searching()) visible.shift()
    container.dataset.searching = String(searching() || document.activeElement === input)
    visibleIndex = new Map(visible.map((row, position) => [row.node.key, position]))
    rootButton.setAttribute('aria-expanded', String(expanded.has(tree.root.path)))
    if (activeKey === null || !visibleIndex.has(activeKey)) activeKey = visible[0]?.node.key ?? null
    if (anchor) {
      const next = visibleIndex.get(anchor)
      if (next !== undefined) list.scrollTop = next * ROW_HEIGHT + offset
    }
    if (searching())
      summary.textContent = `${visible.length.toLocaleString()} matching ${visible.length === 1 ? 'item' : 'items'}`
    else
      summary.textContent = loading
        ? 'Reading files…'
        : `${changes.size.toLocaleString()} changed ${changes.size === 1 ? 'file' : 'files'}`
    total.textContent = tree.files.size.toLocaleString()
    rows.style.height = `${visible.length * ROW_HEIGHT}px`
    render()
  }

  function render() {
    if (disposed || container.hidden) return
    const height = list.clientHeight || 400
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(visible.length, Math.ceil((list.scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
    const retained = new Set()
    let activeId = null
    for (let index = start; index < end; index++) {
      const item = visible[index]
      if (!item) continue
      const { node, depth } = item
      retained.add(node.key)
      let row = mounted.get(node.key)
      if (!row) {
        row = document.createElement('div')
        row.className = 'navigator-row'
        row.setAttribute('role', 'treeitem')
        row.innerHTML =
          '<span class="navigator-chevron" aria-hidden="true"></span><span class="navigator-icon"></span><span class="navigator-name"></span><span class="navigator-directory"></span><span class="navigator-badge"></span>'
        mounted.set(node.key, row)
        rows.appendChild(row)
      }
      row.id = `navigator-${id}-row-${index}`
      row.dataset.key = node.key
      row.dataset.path = node.path
      row.dataset.kind = node.kind
      row.draggable = Boolean(onAttach && node.kind === 'file')
      row.dataset.active = String(node.key === activeKey)
      row.style.top = `${index * ROW_HEIGHT}px`
      row.style.paddingLeft = `${8 + depth * 12}px`
      row.setAttribute('aria-level', String(depth + 1))
      row.setAttribute('aria-selected', String(node.kind === 'file' && node.path === selectedPath))
      if (node.kind === 'directory') row.setAttribute('aria-expanded', String(expanded.has(node.path)))
      else row.removeAttribute('aria-expanded')
      const file = changes.get(node.path) ?? node.file
      const status = node.kind === 'file' ? navigationStatus(file) : ''
      row.dataset.status = status
      row.dataset.changed = String(node.changedCount > 0)
      row.dataset.ignored = String(node.file?.ignored === true)
      row.title = node.path || (snapshot?.scope ?? snapshot?.root ?? '')
      const glyph = iconFor?.(node, expanded.has(node.path))
      const icon = requireElement(row, '.navigator-icon', HTMLSpanElement)
      if (glyph && icon.dataset.glyph !== glyph) {
        const image = document.createElement('img')
        image.src = glyph
        image.alt = ''
        image.draggable = false
        icon.replaceChildren(image)
        icon.dataset.glyph = glyph
      }
      requireElement(row, '.navigator-name', HTMLSpanElement).textContent =
        node.name || lastPathSegment(snapshot?.scope) || lastPathSegment(snapshot?.root) || 'Project'
      requireElement(row, '.navigator-directory', HTMLSpanElement).textContent = searching()
        ? node.path.slice(0, node.path.lastIndexOf('/') + 1)
        : ''
      const badge = requireElement(row, '.navigator-badge', HTMLSpanElement)
      badge.textContent = node.kind === 'directory' ? (node.changedCount ? '●' : '') : status
      badge.title =
        node.kind === 'directory' && node.changedCount
          ? `${node.changedCount} changed ${node.changedCount === 1 ? 'file' : 'files'}`
          : file?.conflicted
            ? 'Merge conflict'
            : status
              ? `Git status: ${status}`
              : ''
      if (node.key === activeKey) activeId = row.id
    }
    for (const [pathname, row] of mounted) {
      if (!retained.has(pathname)) {
        row.remove()
        mounted.delete(pathname)
      }
    }
    if (activeId) list.setAttribute('aria-activedescendant', activeId)
    else list.removeAttribute('aria-activedescendant')
  }

  function markChanges() {
    for (const node of statusNodes) node.changedCount = 0
    statusNodes = new Set()
    for (const file of snapshot?.files ?? []) {
      let node = tree.files.get(file.path)
      while (node) {
        node.changedCount++
        statusNodes.add(node)
        node = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
      }
    }
  }

  /** @param {string} pathname */
  function ensureVisible(pathname, focus = false) {
    const node = tree.files.get(pathname) ?? tree.nodes.get(`dir:${pathname}`)
    if (!node) return false
    let parent = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
    while (parent) {
      expanded.add(parent.path)
      parent = parent.parentKey === null ? undefined : tree.nodes.get(parent.parentKey)
    }
    if (!filters.matches({ path: node.path, directory: node.kind === 'directory' })) filters.reset()
    if (query && !pathname.toLocaleLowerCase().includes(query)) {
      input.value = ''
      query = ''
    }
    activeKey = node.key
    refreshProjection()
    scrollToActive()
    if (focus) list.focus()
    return true
  }

  function scrollToActive() {
    const index = activeKey === null ? undefined : visibleIndex.get(activeKey)
    if (index === undefined) return
    const top = index * ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight
    render()
  }

  // Only one scan can update the delta baseline at a time. Changes during the
  // scan queue another pass using the revision from the previous result.
  async function fetchCatalog() {
    if (loading || disposed || !snapshot) return
    loading = true
    refreshButton.setAttribute('data-loading-status', '')
    refreshButton.setAttribute('aria-busy', 'true')
    if (!searching()) summary.textContent = 'Reading files…'

    async function scan() {
      if (disposed || !snapshot) return
      const prior = tree
      const rootKey = key
      const generation = wanted
      const base = scopePrefix(snapshot)
      catalogRequests++
      const result = await attemptAsync(
        async () => {
          if (api.filesDelta) return { delta: await api.filesDelta(appliedInventoryRevision) }
          return { inventory: await api.files() }
        },
        { operation: 'Read navigator files' },
      )
      if (disposed) return
      if (key === rootKey) {
        if (result.ok) {
          if (result.value.delta) {
            const { delta } = result.value
            tree = delta.reset
              ? buildNavigationTree(delta.files, base)
              : applyNavigationDelta(tree, delta.files, delta.removed)
            appliedInventoryRevision = delta.revision
          } else {
            const { inventory } = result.value
            tree = reconcileNavigationTree(tree, inventory, base) ?? buildNavigationTree(inventory, base)
          }
          // Publish each completed scan even when edits have already queued another one.
          if (prior.root.path !== tree.root.path) expanded = new Set([tree.root.path])
          filters.update([...tree.files.values()].flatMap(node => (node.file ? [node.file] : [])))
          markChanges()
          if (generation === wanted) loading = false
          refreshProjection()
          if (revealPath && ensureVisible(revealPath)) revealPath = null
        } else {
          reportError(result.error, { silent: true })
          if (generation === wanted) summary.textContent = result.error.message
        }
      }
      if (generation !== wanted) await scan()
    }

    try {
      await scan()
    } finally {
      loading = false
      refreshButton.removeAttribute('data-loading-status')
      refreshButton.removeAttribute('aria-busy')
      if (!disposed) runTask('Complete navigator scan', () => onReady?.())
    }
  }

  /** @param {NavigatorSnapshot | { error: unknown } | null | undefined} next */
  function update(next) {
    if (disposed || !next || !('root' in next)) return
    const nextKey = `${next.root}\0${next.scope ?? next.root}`
    const nextSignature = new Set(next.files.map(file => file.path))
    const previousSignature = signature
    const different =
      !previousSignature ||
      previousSignature.size !== nextSignature.size ||
      [...nextSignature].some(pathname => !previousSignature.has(pathname))
    const changedRoot = key !== nextKey
    const fresh = next.revision !== snapshot?.revision
    const refresh =
      changedRoot ||
      (Number.isFinite(next.inventoryRevision)
        ? next.inventoryRevision !== inventoryRevision
        : different ||
          (fresh &&
            next.changedPaths?.some(
              pathname => pathname === '*' || (!tree.files.has(pathname) && !tree.nodes.has(`dir:${pathname}`)),
            ) === true))
    snapshot = next
    const titlePath = next.scope?.length ? next.scope : next.root
    project.textContent = lastPathSegment(titlePath) || 'Project'
    rootButton.title = titlePath
    changes = new Map(next.files.map(file => [file.path, file]))
    signature = nextSignature
    inventoryRevision = next.inventoryRevision
    key = nextKey
    if (changedRoot) {
      appliedInventoryRevision = null
      expanded = new Set([scopePrefix(next)])
      tree = buildNavigationTree([], scopePrefix(next))
      activeKey = tree.root.key
      selectedPath = next.initialPath?.length ? next.initialPath : null
      revealPath = selectedPath
      list.scrollTop = 0
      input.value = ''
      query = ''
      filters.reset()
      refreshProjection(false)
    }
    if (different || changedRoot) markChanges()
    if (!searching())
      summary.textContent = loading
        ? 'Reading files…'
        : `${changes.size.toLocaleString()} changed ${changes.size === 1 ? 'file' : 'files'}`
    schedule()
    if (refresh) {
      wanted++
      runTask('Read navigator files', fetchCatalog)
    }
  }

  /** @param {NavigationNode} node @param {boolean} value */
  function setExpanded(node, value) {
    if (value) expanded.add(node.path)
    else {
      expanded.delete(node.path)
      for (const pathname of expanded) {
        if ((!node.path || pathname.startsWith(`${node.path}/`)) && tree.nodes.get(`dir:${pathname}`)?.file?.ignored)
          expanded.delete(pathname)
      }
    }
    if ((node.file?.ignored || !value) && api.directoryExpanded) {
      const root = key
      const operation = value ? 'Expand folder' : 'Collapse folder'
      runTask(operation, async () => {
        const result = await attemptAsync(() => api.directoryExpanded?.(node.path, value), { operation })
        if (!result.ok && !disposed && key === root) {
          reportError(result.error, { silent: true })
          summary.textContent = result.error.message
        }
      })
    }
  }

  /** @param {NavigationNode} node */
  function choose(node) {
    if (node.kind === 'directory' && searching()) {
      input.value = ''
      query = ''
      filters.reset()
      ensureVisible(node.path, true)
      setExpanded(node, true)
      refreshProjection()
    } else if (node.kind === 'directory') {
      setExpanded(node, !expanded.has(node.path))
      activeKey = node.key
      refreshProjection()
      scrollToActive()
    } else {
      selectedPath = node.path
      activeKey = node.key
      render()
      runTask('Open navigator file', () => onOpen({ path: node.path, ...node.file, ...changes.get(node.path) }))
    }
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    const row = event.target instanceof Element ? event.target.closest('.navigator-row') : null
    if (!(row instanceof HTMLDivElement) || !row.dataset.key || !rows.contains(row)) return
    const node = tree.nodes.get(row.dataset.key)
    if (!node) return
    choose(node)
    list.focus()
  }

  function focusSearch() {
    container.dataset.searching = 'true'
    input.focus()
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.defaultPrevented || event.isComposing) return
    const active = activeKey === null ? undefined : tree.nodes.get(activeKey)
    if (matchesShortcut?.(event, 'renameExplorerItem') && active && active !== tree.root && !active.file?.submodule) {
      event.preventDefault()
      if (!event.repeat) actions.rename(active)
      return
    }
    if (
      (matchesShortcut?.(event, 'explorerContextMenu') || matchesShortcut?.(event, 'explorerContextMenuKey')) &&
      active &&
      active !== tree.root
    ) {
      event.preventDefault()
      const bounds = mounted.get(active.key)?.getBoundingClientRect() ?? list.getBoundingClientRect()
      if (!event.repeat) actions.show(active, bounds.left + 20, bounds.top + ROW_HEIGHT, list)
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== ' ') {
      event.preventDefault()
      focusSearch()
      input.value += event.key
      onSearch()
      return
    }
    const index = (activeKey === null ? undefined : visibleIndex.get(activeKey)) ?? 0
    const node = visible[index]?.node
    if (!node) return
    let target = index
    if (event.key === 'ArrowDown') target = Math.min(visible.length - 1, index + 1)
    else if (event.key === 'ArrowUp') target = Math.max(0, index - 1)
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = visible.length - 1
    else if (event.key === 'PageDown')
      target = Math.min(visible.length - 1, index + Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT)))
    else if (event.key === 'PageUp')
      target = Math.max(0, index - Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT)))
    else if (event.key === 'ArrowRight' && !searching()) {
      if (node.kind === 'directory' && !expanded.has(node.path)) {
        setExpanded(node, true)
        refreshProjection()
      } else if (node.kind === 'directory' && node.children?.length) target = index + 1
    } else if (event.key === 'ArrowLeft' && !searching()) {
      if (node.kind === 'directory' && expanded.has(node.path)) {
        setExpanded(node, false)
        refreshProjection()
      } else {
        const parent = node.parentKey === null ? undefined : visibleIndex.get(node.parentKey)
        if (parent !== undefined) target = parent
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(node)
      return
    } else return
    event.preventDefault()
    activeKey = visible[target]?.node.key ?? activeKey
    scrollToActive()
  }

  function onSearch() {
    query = input.value.toLocaleLowerCase()
    list.scrollTop = 0
    refreshProjection(false)
  }

  function onSearchBlur() {
    if (!searching()) container.dataset.searching = 'false'
  }

  /** @param {KeyboardEvent} event */
  function onSearchKey(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeKey = visible[0]?.node.key ?? null
      scrollToActive()
      list.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      input.value = ''
      onSearch()
      list.focus()
    } else if (event.key === 'Enter') {
      const node = activeKey === null ? undefined : tree.nodes.get(activeKey)
      if (node) {
        event.preventDefault()
        choose(node)
        list.focus()
      }
    }
  }

  /** @param {MouseEvent} event */
  function onAction(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null
    const action = button instanceof HTMLButtonElement ? button.dataset.action : undefined
    if (action === 'collapse') {
      setExpanded(tree.root, false)
      expanded = new Set([tree.root.path])
      activeKey = tree.root.key
      list.scrollTop = 0
      refreshProjection(false)
    } else if (action === 'refresh') {
      wanted++
      runTask('Read navigator files', fetchCatalog)
    } else if (action === 'root') {
      choose(tree.root)
    } else if (action === 'open-file') {
      runTask('Open file picker', () => onPick?.())
    } else if (action === 'open-folder') {
      runTask('Open folder picker', () => onFolder?.())
    }
  }

  /** @param {MouseEvent} event */
  function onContextMenu(event) {
    const row = event.target instanceof Element ? event.target.closest('.navigator-row') : null
    const node = row instanceof HTMLDivElement && row.dataset.key ? tree.nodes.get(row.dataset.key) : undefined
    if (!node || node === tree.root) return
    event.preventDefault()
    activeKey = node.key
    render()
    actions.show(node, event.clientX, event.clientY, list)
  }
  /** @param {DragEvent} event */
  function onDragStart(event) {
    const row = event.target instanceof Element ? event.target.closest('.navigator-row[draggable="true"]') : null
    if (!(row instanceof HTMLDivElement) || !row.dataset.path || !event.dataTransfer || !snapshot?.root) return
    event.dataTransfer.setData(
      IDEA_FILE_DRAG_TYPE,
      JSON.stringify({ path: row.dataset.path, workspace: snapshot.root }),
    )
    event.dataTransfer.effectAllowed = 'link'
  }
  list.addEventListener('dragstart', onDragStart)
  list.addEventListener('contextmenu', onContextMenu)
  list.addEventListener('scroll', schedule, { passive: true })
  list.addEventListener('click', onClick)
  list.addEventListener('keydown', onKey)
  list.addEventListener('focus', schedule)
  input.addEventListener('input', onSearch)
  input.addEventListener('blur', onSearchBlur)
  input.addEventListener('keydown', onSearchKey)
  heading.addEventListener('click', onAction)
  const resize = new ResizeObserver(schedule)
  resize.observe(list)

  return {
    update,
    focusSearch,
    /** @param {string} from @param {string} to */
    renamed(from, to) {
      expanded = new Set(
        [...expanded].map(pathname =>
          pathname === from || pathname.startsWith(`${from}/`) ? to + pathname.slice(from.length) : pathname,
        ),
      )
      refreshProjection()
    },
    /** @param {string} pathname */
    revealDirectory(pathname) {
      input.value = ''
      query = ''
      filters.reset()
      ensureVisible(pathname, true)
      const node = tree.nodes.get(`dir:${pathname}`)
      if (node) setExpanded(node, true)
      refreshProjection()
    },
    /** @param {string | null} pathname */
    select(pathname) {
      selectedPath = pathname
      revealPath = pathname
      if (pathname !== null && ensureVisible(pathname)) revealPath = null
    },
    toggle() {
      container.hidden = !container.hidden
      if (!container.hidden) schedule()
      return !container.hidden
    },
    dispose() {
      disposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      resize.disconnect()
      actions.dispose()
      list.removeEventListener('dragstart', onDragStart)
      list.removeEventListener('contextmenu', onContextMenu)
      outline.removeEventListener('toggle', onOutlineToggle)
      list.removeEventListener('scroll', schedule)
      list.removeEventListener('click', onClick)
      list.removeEventListener('keydown', onKey)
      list.removeEventListener('focus', schedule)
      input.removeEventListener('input', onSearch)
      input.removeEventListener('blur', onSearchBlur)
      input.removeEventListener('keydown', onSearchKey)
      heading.removeEventListener('click', onAction)
      mounted.clear()
      container.replaceChildren()
    },
    stats: () => ({
      inventoryFiles: tree.files.size,
      treeNodes: tree.nodes.size,
      visibleRows: visible.length,
      mountedRows: mounted.size,
      expandedFolders: expanded.size,
      catalogRequests,
      loading,
      selectedPath,
      hidden: container.hidden,
    }),
  }
}

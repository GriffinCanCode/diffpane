import { createFileActions } from './file-actions.ts';
import { createSearchFilters, hasFilters, matchesFilters } from './search-filters.ts';
import { applyNavigationDelta, reconcileNavigationTree } from './navigation-reconcile.ts';

const ROW_HEIGHT = 22;
const OVERSCAN = 4;
const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
let instance = 0;

const icons = {
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
};

/** Build metadata only; opening and tokenizing documents belongs to the editor. */
export function buildNavigationTree(inventory, basePath = '') {
  const root = {
    key: `dir:${basePath}`,
    path: basePath,
    name: '',
    kind: 'directory',
    parentKey: null,
    children: [],
    changedCount: 0,
  };
  return reconcileNavigationTree(
    { root, nodes: new Map([[root.key, root]]), files: new Map(), directories: new Map() },
    inventory,
    basePath,
  );
}

/** A flattened projection contains expanded folders only, or matching file paths. */
export function flattenNavigationTree(tree, expanded, query = '', filters, languageFor) {
  if (query || (filters && hasFilters(filters))) {
    const needle = query.toLocaleLowerCase();
    tree.searchFiles ??= [...tree.files.values()].sort((a, b) => compare(a.path, b.path));
    return tree.searchFiles
      .concat(
        [...tree.nodes.values()].filter(node => node.kind === 'directory' && node !== tree.root),
      )
      .filter(
        node =>
          (!needle || (node.searchPath ??= node.path.toLocaleLowerCase()).includes(needle)) &&
          (!filters ||
            matchesFilters(
              { path: node.path, directory: node.kind === 'directory' },
              filters,
              languageFor,
            )),
      )
      .map(node => ({ node, depth: 1 }));
  }
  const visible = [];
  const stack = [{ node: tree.root, depth: 0 }];
  while (stack.length) {
    const row = stack.pop();
    visible.push(row);
    if (row.node.kind === 'directory' && expanded.has(row.node.path)) {
      for (let index = row.node.children.length - 1; index >= 0; index--) {
        stack.push({ node: row.node.children[index], depth: row.depth + 1 });
      }
    }
  }
  return visible;
}

export function navigationStatus(file) {
  if (file?.conflicted) return '!';
  const status =
    file?.worktree && ![' ', '.'].includes(file.worktree) ? file.worktree : file?.index;
  return !status || [' ', '.'].includes(status) ? '' : status === '?' ? 'U' : status;
}

function scopePrefix(snapshot) {
  const root = snapshot.root?.replaceAll('\\', '/').replace(/\/$/, '') ?? '';
  const scope = snapshot.scope?.replaceAll('\\', '/').replace(/\/$/, '') ?? root;
  return scope.startsWith(`${root}/`) ? scope.slice(root.length + 1) : '';
}

/** A persistent, keyboard-accessible project tree with viewport-bounded DOM rows. */
export function createNavigator(
  container,
  api,
  onOpen,
  { iconFor, onPick, onFolder, onOutline, onMutate, languageFor, onReady } = {},
) {
  const id = ++instance;
  container.classList.add('navigator');
  container.style.setProperty('--navigator-row-height', `${ROW_HEIGHT}px`);
  container.setAttribute('aria-label', 'Project explorer');
  container.dataset.searching = 'false';
  container.innerHTML = `<div class="navigator-heading"><button type="button" class="navigator-root" data-action="root" aria-expanded="true"><span class="navigator-chevron" aria-hidden="true"></span><span class="navigator-project">Project</span></button><div class="navigator-actions"><button type="button" class="navigator-action" data-action="open-file" aria-label="Search files" title="Search files · ⌘P">${icons.openFile}</button><button type="button" class="navigator-action" data-action="open-folder" aria-label="Open folder" title="Open folder">${icons.openFolder}</button><button type="button" class="navigator-action" data-action="refresh" aria-label="Refresh explorer" title="Refresh explorer">${icons.refresh}</button><button type="button" class="navigator-action" data-action="collapse" aria-label="Collapse folders" title="Collapse folders">${icons.collapse}</button></div></div><div class="navigator-search">${icons.search}<input type="search" placeholder="Find files or folders…" aria-label="Find files or folders in explorer" spellcheck="false" autocomplete="off"></div><div class="navigator-filter-host"></div><div class="navigator-summary" role="status">Reading files…</div><div class="navigator-tree" role="tree" aria-label="Project files" tabindex="0"><div class="navigator-rows"></div></div><details class="navigator-outline"><summary>Outline</summary><div class="symbol-list navigator-symbols"></div></details><div class="navigator-footer"><span>Project files</span><span class="navigator-total"></span></div>`;
  const list = container.querySelector('.navigator-tree');
  const rows = container.querySelector('.navigator-rows');
  const input = container.querySelector('input');
  const summary = container.querySelector('.navigator-summary');
  const total = container.querySelector('.navigator-total');
  const refreshButton = container.querySelector('[data-action="refresh"]');
  const rootButton = container.querySelector('[data-action="root"]');
  const outline = container.querySelector('.navigator-outline');
  const onOutlineToggle = () => {
    if (outline.open) onOutline?.(outline.querySelector('.symbol-list'));
  };
  outline.addEventListener('toggle', onOutlineToggle);
  let tree = buildNavigationTree([]);
  let expanded = new Set(['']);
  let visible = [];
  let visibleIndex = new Map();
  let snapshot = null;
  let key = null;
  let signature = null;
  let inventoryRevision = null;
  let appliedInventoryRevision = null;
  let activeKey = tree.root.key;
  let selectedPath = null;
  let revealPath = null;
  let statusNodes = new Set();
  let changes = new Map();
  let loading = false;
  let wanted = 0;
  let disposed = false;
  let frame = null;
  let query = '';
  let catalogRequests = 0;
  const mounted = new Map();
  const filters = createSearchFilters(
    container.querySelector('.navigator-filter-host'),
    onSearch,
    languageFor,
  );
  const actions = createFileActions(
    api,
    async (action, pathname, name) => {
      if (action === 'open') {
        const node = tree.files.get(pathname) ?? tree.nodes.get(`dir:${pathname}`);
        if (node) choose(node);
      } else await onMutate?.(action, pathname, name);
    },
    message => {
      summary.textContent = message;
      container.dataset.searching = 'true';
    },
  );
  const searching = () => Boolean(query) || filters.active();

  function schedule() {
    if (frame !== null || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      render();
    });
  }

  function refreshProjection(preserve = true) {
    const index = Math.floor(list.scrollTop / ROW_HEIGHT);
    const anchor = preserve ? visible[index]?.node.key : null;
    const offset = list.scrollTop % ROW_HEIGHT;
    visible = flattenNavigationTree(tree, expanded, query, filters.value(), languageFor);
    if (!searching()) visible.shift();
    visibleIndex = new Map(visible.map((row, index) => [row.node.key, index]));
    rootButton.setAttribute('aria-expanded', String(expanded.has(tree.root.path)));
    if (!visibleIndex.has(activeKey)) activeKey = visible[0]?.node.key ?? null;
    if (anchor) {
      const next = visibleIndex.get(anchor);
      if (next !== undefined) list.scrollTop = next * ROW_HEIGHT + offset;
    }
    if (searching())
      summary.textContent = `${visible.length.toLocaleString()} matching ${visible.length === 1 ? 'item' : 'items'}`;
    else
      summary.textContent = loading
        ? 'Reading files…'
        : `${changes.size.toLocaleString()} changed ${changes.size === 1 ? 'file' : 'files'}`;
    total.textContent = tree.files.size.toLocaleString();
    rows.style.height = `${visible.length * ROW_HEIGHT}px`;
    render();
  }

  function render() {
    if (disposed || container.hidden) return;
    const height = list.clientHeight || 400;
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      visible.length,
      Math.ceil((list.scrollTop + height) / ROW_HEIGHT) + OVERSCAN,
    );
    const retained = new Set();
    let activeId = null;
    for (let index = start; index < end; index++) {
      const { node, depth } = visible[index];
      retained.add(node.key);
      let row = mounted.get(node.key);
      if (!row) {
        row = document.createElement('div');
        row.className = 'navigator-row';
        row.setAttribute('role', 'treeitem');
        row.innerHTML =
          '<span class="navigator-chevron" aria-hidden="true"></span><span class="navigator-icon"></span><span class="navigator-name"></span><span class="navigator-directory"></span><span class="navigator-badge"></span>';
        mounted.set(node.key, row);
        rows.appendChild(row);
      }
      row.id = `navigator-${id}-row-${index}`;
      row.dataset.key = node.key;
      row.dataset.path = node.path;
      row.dataset.kind = node.kind;
      row.dataset.active = String(node.key === activeKey);
      row.style.top = `${index * ROW_HEIGHT}px`;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.setAttribute('aria-level', String(depth + 1));
      row.setAttribute('aria-selected', String(node.kind === 'file' && node.path === selectedPath));
      if (node.kind === 'directory')
        row.setAttribute('aria-expanded', String(expanded.has(node.path)));
      else row.removeAttribute('aria-expanded');
      const file = changes.get(node.path) ?? node.file;
      const status = node.kind === 'file' ? navigationStatus(file) : '';
      row.dataset.status = status;
      row.dataset.changed = String(node.changedCount > 0);
      row.dataset.ignored = String(node.file?.ignored === true);
      row.title = node.path || snapshot?.scope || snapshot?.root || '';
      const glyph = iconFor?.(node, expanded.has(node.path));
      const icon = row.querySelector('.navigator-icon');
      if (glyph && icon.dataset.glyph !== glyph) {
        const image = document.createElement('img');
        image.src = glyph;
        image.alt = '';
        icon.replaceChildren(image);
        icon.dataset.glyph = glyph;
      }
      row.querySelector('.navigator-name').textContent =
        node.name ||
        snapshot?.scope?.split(/[\\/]/).filter(Boolean).pop() ||
        snapshot?.root?.split(/[\\/]/).filter(Boolean).pop() ||
        'Project';
      row.querySelector('.navigator-directory').textContent = searching()
        ? node.path.slice(0, node.path.lastIndexOf('/') + 1)
        : '';
      const badge = row.querySelector('.navigator-badge');
      badge.textContent = node.kind === 'directory' ? (node.changedCount ? '●' : '') : status;
      badge.title =
        node.kind === 'directory' && node.changedCount
          ? `${node.changedCount} changed ${node.changedCount === 1 ? 'file' : 'files'}`
          : file?.conflicted
            ? 'Merge conflict'
            : status
              ? `Git status: ${status}`
              : '';
      if (node.key === activeKey) activeId = row.id;
    }
    for (const [pathname, row] of mounted) {
      if (!retained.has(pathname)) {
        row.remove();
        mounted.delete(pathname);
      }
    }
    if (activeId) list.setAttribute('aria-activedescendant', activeId);
    else list.removeAttribute('aria-activedescendant');
  }

  function markChanges() {
    for (const node of statusNodes) node.changedCount = 0;
    statusNodes = new Set();
    for (const file of snapshot?.files ?? []) {
      let node = tree.files.get(file.path);
      while (node) {
        node.changedCount++;
        statusNodes.add(node);
        node = tree.nodes.get(node.parentKey);
      }
    }
  }

  function ensureVisible(pathname, focus = false) {
    const node = tree.files.get(pathname) ?? tree.nodes.get(`dir:${pathname}`);
    if (!node) return false;
    let parent = tree.nodes.get(node.parentKey);
    while (parent) {
      expanded.add(parent.path);
      parent = tree.nodes.get(parent.parentKey);
    }
    if (!filters.matches({ path: node.path, directory: node.kind === 'directory' }))
      filters.reset();
    if (query && !pathname.toLocaleLowerCase().includes(query)) {
      input.value = '';
      query = '';
    }
    activeKey = node.key;
    refreshProjection();
    scrollToActive();
    if (focus) list.focus();
    return true;
  }

  function scrollToActive() {
    const index = visibleIndex.get(activeKey);
    if (index === undefined) return;
    const top = index * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
    render();
  }

  async function fetchCatalog() {
    if (loading || disposed || !snapshot) return;
    loading = true;
    refreshButton.classList.add('is-refreshing');
    refreshButton.setAttribute('aria-busy', 'true');
    if (!query) summary.textContent = 'Reading files…';
    try {
      let generation;
      do {
        const prior = tree;
        generation = wanted;
        catalogRequests++;
        if (api.filesDelta) {
          const delta = await api.filesDelta(appliedInventoryRevision);
          if (disposed) return;
          tree = delta.reset
            ? buildNavigationTree(delta.files, scopePrefix(snapshot))
            : applyNavigationDelta(tree, delta.files, delta.removed);
          appliedInventoryRevision = delta.revision;
        } else {
          const inventory = await api.files();
          if (disposed) return;
          tree =
            reconcileNavigationTree(tree, inventory, scopePrefix(snapshot)) ??
            buildNavigationTree(inventory, scopePrefix(snapshot));
        }
        // Publish each completed scan even when edits have already queued another one.
        if (prior.root.path !== tree.root.path) expanded = new Set([tree.root.path]);
        filters.update([...tree.files.values()].map(node => node.file));
        markChanges();
        if (generation === wanted) loading = false;
        refreshProjection();
        if (revealPath && ensureVisible(revealPath)) revealPath = null;
      } while (generation !== wanted);
    } catch (error) {
      if (!disposed) summary.textContent = error.message || String(error);
    } finally {
      loading = false;
      refreshButton.classList.remove('is-refreshing');
      refreshButton.removeAttribute('aria-busy');
      if (!disposed) onReady?.();
    }
  }

  function update(next) {
    if (disposed || !next || next.error) return;
    const nextKey = `${next.root}\0${next.scope ?? next.root}`;
    const nextSignature = new Set(next.files.map(file => file.path));
    const different =
      !signature ||
      signature.size !== nextSignature.size ||
      [...nextSignature].some(pathname => !signature.has(pathname));
    const changedRoot = key !== nextKey;
    const fresh = next.revision !== snapshot?.revision;
    const refresh =
      changedRoot ||
      (Number.isFinite(next.inventoryRevision)
        ? next.inventoryRevision !== inventoryRevision
        : different ||
          (fresh &&
            (next.changedPaths?.includes('*') ||
              next.changedPaths?.some(
                pathname => !tree.files.has(pathname) && !tree.nodes.has(`dir:${pathname}`),
              ))));
    snapshot = next;
    container.querySelector('.navigator-project').textContent = (next.scope || next.root)
      .split(/[\\/]/)
      .filter(Boolean)
      .pop();
    rootButton.title = next.scope || next.root;
    changes = new Map(next.files.map(file => [file.path, file]));
    signature = nextSignature;
    inventoryRevision = next.inventoryRevision;
    key = nextKey;
    if (changedRoot) {
      appliedInventoryRevision = null;
      expanded = new Set([scopePrefix(next)]);
      tree = buildNavigationTree([], scopePrefix(next));
      activeKey = tree.root.key;
      selectedPath = next.initialPath || null;
      revealPath = next.initialPath || null;
      list.scrollTop = 0;
      input.value = '';
      query = '';
      filters.reset();
      refreshProjection(false);
    }
    if (different || changedRoot) markChanges();
    if (!searching())
      summary.textContent = loading
        ? 'Reading files…'
        : `${changes.size.toLocaleString()} changed ${changes.size === 1 ? 'file' : 'files'}`;
    schedule();
    if (refresh) {
      wanted++;
      void fetchCatalog();
    }
  }

  function setExpanded(node, value) {
    if (value) expanded.add(node.path);
    else {
      expanded.delete(node.path);
      for (const pathname of expanded) {
        if (
          (!node.path || pathname.startsWith(`${node.path}/`)) &&
          tree.nodes.get(`dir:${pathname}`)?.file?.ignored
        )
          expanded.delete(pathname);
      }
    }
    if ((node.file?.ignored || !value) && api.directoryExpanded) {
      void api.directoryExpanded(node.path, value).catch(error => {
        if (!disposed) summary.textContent = error.message || String(error);
      });
    }
  }

  function choose(node) {
    if (node.kind === 'directory' && searching()) {
      input.value = '';
      query = '';
      filters.reset();
      ensureVisible(node.path, true);
      setExpanded(node, true);
      refreshProjection();
    } else if (node.kind === 'directory') {
      setExpanded(node, !expanded.has(node.path));
      activeKey = node.key;
      refreshProjection();
      scrollToActive();
    } else {
      selectedPath = node.path;
      activeKey = node.key;
      render();
      onOpen({ ...node.file, ...changes.get(node.path) });
    }
  }

  function onClick(event) {
    const row = event.target.closest('.navigator-row');
    if (!row || !rows.contains(row)) return;
    const node = tree.nodes.get(row.dataset.key);
    if (!node) return;
    choose(node);
    list.focus();
  }

  function onKey(event) {
    const active = tree.nodes.get(activeKey);
    if (event.key === 'F2' && active && active !== tree.root && !active.file?.submodule) {
      event.preventDefault();
      actions.rename(active);
      return;
    }
    if (
      (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) &&
      active &&
      active !== tree.root
    ) {
      event.preventDefault();
      const bounds =
        mounted.get(active.key)?.getBoundingClientRect() ?? list.getBoundingClientRect();
      actions.show(active, bounds.left + 20, bounds.top + ROW_HEIGHT, list);
      return;
    }
    if (
      (event.key.toLowerCase() === 'f' && (event.metaKey || event.ctrlKey)) ||
      (event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key !== ' ')
    ) {
      event.preventDefault();
      container.dataset.searching = 'true';
      input.focus();
      if (!event.metaKey && !event.ctrlKey) {
        input.value += event.key;
        onSearch();
      }
      return;
    }
    const index = visibleIndex.get(activeKey) ?? 0;
    const node = visible[index]?.node;
    if (!node) return;
    let target = index;
    if (event.key === 'ArrowDown') target = Math.min(visible.length - 1, index + 1);
    else if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = visible.length - 1;
    else if (event.key === 'PageDown')
      target = Math.min(
        visible.length - 1,
        index + Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT)),
      );
    else if (event.key === 'PageUp')
      target = Math.max(0, index - Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT)));
    else if (event.key === 'ArrowRight' && !query) {
      if (node.kind === 'directory' && !expanded.has(node.path)) {
        setExpanded(node, true);
        refreshProjection();
      } else if (node.kind === 'directory' && node.children.length) target = index + 1;
    } else if (event.key === 'ArrowLeft' && !query) {
      if (node.kind === 'directory' && expanded.has(node.path)) {
        setExpanded(node, false);
        refreshProjection();
      } else {
        const parent = visibleIndex.get(node.parentKey);
        if (parent !== undefined) target = parent;
      }
    } else if (event.key === 'Enter' || event.key === ' ') choose(node);
    else return;
    event.preventDefault();
    activeKey = visible[target]?.node.key ?? activeKey;
    scrollToActive();
  }

  function onSearch() {
    query = input.value.toLocaleLowerCase();
    container.dataset.searching = String(searching() || document.activeElement === input);
    list.scrollTop = 0;
    refreshProjection(false);
  }

  function onSearchBlur() {
    if (!searching()) container.dataset.searching = 'false';
  }

  function onSearchKey(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeKey = visible[0]?.node.key;
      scrollToActive();
      list.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.value = '';
      onSearch();
      container.dataset.searching = 'false';
      list.focus();
    } else if (event.key === 'Enter') {
      const node = tree.nodes.get(activeKey);
      if (node) {
        event.preventDefault();
        choose(node);
        list.focus();
      }
    }
  }

  function onAction(event) {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'collapse') {
      setExpanded(tree.root, false);
      expanded = new Set([tree.root.path]);
      activeKey = tree.root.key;
      list.scrollTop = 0;
      refreshProjection(false);
    } else if (action === 'refresh') {
      wanted++;
      void fetchCatalog();
    } else if (action === 'root') {
      choose(tree.root);
    } else if (action === 'open-file') {
      void onPick?.();
    } else if (action === 'open-folder') {
      void onFolder?.();
    }
  }

  function onContextMenu(event) {
    const row = event.target.closest('.navigator-row');
    const node = row && tree.nodes.get(row.dataset.key);
    if (!node || node === tree.root) return;
    event.preventDefault();
    activeKey = node.key;
    render();
    actions.show(node, event.clientX, event.clientY, list);
  }
  list.addEventListener('contextmenu', onContextMenu);
  list.addEventListener('scroll', schedule, { passive: true });
  list.addEventListener('click', onClick);
  list.addEventListener('keydown', onKey);
  list.addEventListener('focus', schedule);
  input.addEventListener('input', onSearch);
  input.addEventListener('blur', onSearchBlur);
  input.addEventListener('keydown', onSearchKey);
  container.querySelector('.navigator-heading').addEventListener('click', onAction);
  const resize = new ResizeObserver(schedule);
  resize.observe(list);

  return {
    update,
    renamed(from, to) {
      expanded = new Set(
        [...expanded].map(pathname =>
          pathname === from || pathname.startsWith(`${from}/`)
            ? to + pathname.slice(from.length)
            : pathname,
        ),
      );
      refreshProjection();
    },
    revealDirectory(pathname) {
      input.value = '';
      query = '';
      filters.reset();
      ensureVisible(pathname, true);
      const node = tree.nodes.get(`dir:${pathname}`);
      if (node) setExpanded(node, true);
      refreshProjection();
    },
    select(pathname) {
      selectedPath = pathname;
      revealPath = pathname;
      if (ensureVisible(pathname)) revealPath = null;
    },
    toggle() {
      container.hidden = !container.hidden;
      if (!container.hidden) schedule();
      return !container.hidden;
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      actions.dispose();
      list.removeEventListener('contextmenu', onContextMenu);
      outline.removeEventListener('toggle', onOutlineToggle);
      list.removeEventListener('scroll', schedule);
      list.removeEventListener('click', onClick);
      list.removeEventListener('keydown', onKey);
      list.removeEventListener('focus', schedule);
      input.removeEventListener('input', onSearch);
      input.removeEventListener('blur', onSearchBlur);
      input.removeEventListener('keydown', onSearchKey);
      container.querySelector('.navigator-heading').removeEventListener('click', onAction);
      mounted.clear();
      container.replaceChildren();
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
  };
}

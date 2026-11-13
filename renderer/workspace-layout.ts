import './workspace-layout.css';

const WIDTHS = {
  ideas: { initial: 282, min: 184, max: 560 },
  files: { initial: 270, min: 156, max: 480 },
  right: { initial: 368, min: 248, max: 680 },
};
const RIGHT_HEIGHT = { initial: 250, min: 172, max: 640 };
const CODE_WIDTH = 292;
const CODE_HEIGHT = 166;
const DIVIDER_SIZE = 5;
const STORAGE_KEY = 'diffpane.workspace-layout.v1';

type Column = keyof typeof WIDTHS;
type Pane = Column | 'code';
type Destination = Pane | 'end';
type Dimension = Column | 'rightHeight';
type Sizes = Record<Dimension, number>;

const COLUMNS: readonly Column[] = ['ideas', 'files', 'right'];
const DIMENSIONS: readonly Dimension[] = [...COLUMNS, 'rightHeight'];
const DEFAULT_ORDER: readonly Pane[] = ['ideas', 'files', 'code', 'right'];
const CONTROLS = 'button, a, input, textarea, select, summary, [contenteditable]';
const DEFAULTS: Sizes = {
  ideas: WIDTHS.ideas.initial,
  files: WIDTHS.files.initial,
  right: WIDTHS.right.initial,
  rightHeight: RIGHT_HEIGHT.initial,
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readPreferences() {
  const sizes = { ...DEFAULTS };
  let order = DEFAULT_ORDER;
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    // The layout also works with storage disabled.
    return { sizes, order };
  }
  if (!isPreferenceRecord(stored)) return { sizes, order };
  for (const key of DIMENSIONS) {
    const value = stored[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = key === 'rightHeight' ? RIGHT_HEIGHT : WIDTHS[key];
    sizes[key] = clamp(value, min, max);
  }
  if (
    Array.isArray(stored.order) &&
    stored.order.length === DEFAULT_ORDER.length &&
    stored.order.every(isPane) &&
    new Set(stored.order).size === DEFAULT_ORDER.length
  ) {
    order = stored.order;
  }
  return { sizes, order };
}

function isPreferenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPane(value: unknown): value is Pane {
  return DEFAULT_ORDER.some(pane => pane === value);
}

function measure(
  width: number,
  height: number,
  visible: Record<Column, boolean>,
  preferred: Sizes,
  order: readonly Pane[],
) {
  const stacked =
    visible.right &&
    width <
      CODE_WIDTH +
        COLUMNS.reduce((sum, key) => sum + (visible[key] ? WIDTHS[key].min + DIVIDER_SIZE : 0), 0);
  const activeColumns = COLUMNS.filter(key => visible[key] && !(key === 'right' && stacked));
  const activePanes = order.filter(key => key === 'code' || activeColumns.includes(key));
  const ideasIndex = activePanes.indexOf('ideas');
  const ideasTowardCode = ideasIndex < activePanes.indexOf('code') ? 1 : -1;
  const ideasShareWithFiles =
    ideasIndex >= 0 && activePanes[ideasIndex + ideasTowardCode] === 'files';
  const available = Math.max(0, width - activeColumns.length * DIVIDER_SIZE);
  const minimum = activeColumns.reduce((sum, key) => sum + WIDTHS[key].min, 0);
  // Preserve room for code at narrow widths, including embedded windows smaller than Electron's minimum.
  const budget = available - Math.min(CODE_WIDTH, available * 0.55);
  const minimumScale = minimum ? Math.min(1, budget / minimum) : 1;
  const min = { ideas: 0, files: 0, right: 0, rightHeight: 0 };
  for (const key of activeColumns) min[key] = Math.floor(WIDTHS[key].min * minimumScale);
  const floor = activeColumns.reduce((sum, key) => sum + min[key], 0);
  const extra = activeColumns.reduce((sum, key) => sum + preferred[key] - min[key], 0);
  const scale = extra ? Math.min(1, (budget - floor) / extra) : 1;
  const sizes = { ideas: 0, files: 0, right: 0, rightHeight: 0 };
  for (const key of activeColumns)
    sizes[key] = Math.floor(min[key] + (preferred[key] - min[key]) * scale);

  const rowBudget = Math.max(0, height - DIVIDER_SIZE);
  const maxHeight = Math.floor(
    Math.min(RIGHT_HEIGHT.max, rowBudget - Math.min(CODE_HEIGHT, rowBudget * 0.56)),
  );
  if (stacked) {
    min.rightHeight = Math.min(RIGHT_HEIGHT.min, maxHeight);
    sizes.rightHeight = clamp(preferred.rightHeight, min.rightHeight, maxHeight);
  }

  return {
    sizes,
    min,
    budget: Math.floor(budget),
    maxHeight,
    stacked,
    activeColumns,
    activePanes,
    ideasShareWithFiles,
  };
}

type Layout = ReturnType<typeof measure>;

function resizeBounds(layout: Layout, key: Dimension) {
  if (key === 'rightHeight') return { min: layout.min[key], max: layout.maxHeight };
  const reserved = layout.activeColumns.reduce(
    (sum, column) =>
      sum +
      (column === key
        ? 0
        : key === 'ideas' && column === 'files' && layout.ideasShareWithFiles
          ? layout.min.files
          : layout.sizes[column]),
    0,
  );
  return {
    min: layout.min[key],
    max: Math.max(layout.min[key], Math.min(WIDTHS[key].max, layout.budget - reserved)),
  };
}

function resize(layout: Layout, key: Dimension, target: number) {
  const { min, max } = resizeBounds(layout, key);
  const size = clamp(Math.round(target), min, max);
  const sizes = { ...layout.sizes, [key]: size };
  if (key === 'ideas' && layout.ideasShareWithFiles) {
    sizes.files = clamp(
      layout.sizes.files - (size - layout.sizes.ideas),
      layout.min.files,
      WIDTHS.files.max,
    );
  }
  return sizes;
}

export function createWorkspaceLayout(workspace: HTMLElement) {
  const panes = {
    ideas: workspace.querySelector<HTMLElement>(':scope > #ideas-panel'),
    files: workspace.querySelector<HTMLElement>(':scope > #sidebar'),
    code: workspace.querySelector<HTMLElement>(':scope > .workbench'),
  };
  const rightPanels = [
    ...workspace.querySelectorAll<HTMLElement>(':scope > :is(#claude-panel, #review-notes-panel)'),
  ];
  const rightPanel = () => rightPanels.find(panel => !panel.hidden);
  const panelFor = (pane: Pane) => (pane === 'right' ? rightPanel() : panes[pane]);
  const panelName = (column: Column) => {
    if (column === 'ideas') return 'Ideas';
    if (column === 'files')
      return panes.files?.querySelector('#change-review:not([hidden])')
        ? 'Review queue'
        : 'File Explorer';
    return rightPanel()?.id === 'review-notes-panel' ? 'Review Notes' : 'Claude';
  };
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const { sizes: preferred, order: savedOrder } = readPreferences();
  let order = savedOrder;
  let layout: Layout;
  let ideasNotebook = false;
  let ideasDocked = false;
  let drag: {
    key: Dimension;
    pointer: number;
    origin: number;
    initial: Layout;
    divider: HTMLDivElement;
  } | null = null;
  let dock: {
    column: Column;
    header: HTMLElement;
    pointer: number;
    x: number;
    y: number;
    started: boolean;
    destination: Destination | null;
  } | null = null;
  let suppressedPointer: number | null = null;

  const dropMarker = document.createElement('div');
  dropMarker.className = 'workspace-drop-marker';
  dropMarker.setAttribute('aria-hidden', 'true');
  dropMarker.hidden = true;
  const dragLabel = document.createElement('div');
  dragLabel.className = 'workspace-drag-label';
  dragLabel.setAttribute('aria-hidden', 'true');
  dragLabel.hidden = true;
  workspace.append(dropMarker, dragLabel);

  function createSplitter(column: Column) {
    const divider = document.createElement('div');
    divider.className = 'workspace-splitter';
    divider.dataset.column = column;
    divider.setAttribute('role', 'separator');
    divider.tabIndex = 0;
    divider.append(document.createElement('span'));
    workspace.insertBefore(divider, dropMarker);

    const dimension = () => (column === 'right' && layout.stacked ? 'rightHeight' : column);
    const coordinate = (event: PointerEvent, key: Dimension) =>
      key === 'rightHeight' ? event.clientY : event.clientX;
    const direction = () =>
      dimension() === 'rightHeight' ||
      layout.activePanes.indexOf(column) > layout.activePanes.indexOf('code')
        ? -1
        : 1;

    divider.addEventListener(
      'pointerdown',
      event => {
        if (event.button !== 0 || drag || dock) return;
        const key = dimension();
        drag = {
          key,
          pointer: event.pointerId,
          origin: coordinate(event, key),
          initial: layout,
          divider,
        };
        divider.setPointerCapture(event.pointerId);
        divider.focus({ preventScroll: true });
        divider.classList.add('is-dragging');
        document.body.dataset.workspaceResizing =
          layout.stacked && column === 'right' ? 'row' : 'column';
        event.preventDefault();
      },
      options,
    );

    divider.addEventListener(
      'pointermove',
      event => {
        if (drag?.divider !== divider || event.pointerId !== drag.pointer) return;
        const sign = direction();
        const target =
          drag.initial.sizes[drag.key] + sign * (coordinate(event, drag.key) - drag.origin);
        const sizes = resize(drag.initial, drag.key, target);
        const excess = (target - sizes[drag.key]) * sign;
        const pull = Math.sign(excess) * 12 * (1 - Math.exp(-Math.abs(excess) / 32));
        divider.style.setProperty('--splitter-pull', `${pull}px`);
        paint({ ...drag.initial, sizes });
      },
      options,
    );

    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      divider.addEventListener(
        eventName,
        event => {
          if (drag?.divider === divider && event.pointerId === drag.pointer)
            stopDrag(event.type === 'pointerup');
        },
        options,
      );
    }

    divider.addEventListener(
      'keydown',
      event => {
        if (drag) {
          if (event.key === 'Escape') {
            event.preventDefault();
            stopDrag(false);
          }
          return;
        }
        const key = dimension();
        const { min, max } = resizeBounds(layout, key);
        const vertical = key === 'rightHeight';
        const backward = vertical ? 'ArrowUp' : 'ArrowLeft';
        const forward = vertical ? 'ArrowDown' : 'ArrowRight';
        const step = (event.shiftKey ? 48 : 12) * direction();
        const current = layout.sizes[key];
        if (event.key === backward) updateSize(key, current - step);
        else if (event.key === forward) updateSize(key, current + step);
        else if (event.key === 'Home') updateSize(key, min);
        else if (event.key === 'End') updateSize(key, max);
        else return;
        event.preventDefault();
      },
      options,
    );

    divider.addEventListener(
      'dblclick',
      () => {
        const key = dimension();
        updateSize(key, DEFAULTS[key]);
      },
      options,
    );

    return divider;
  }

  const splitters = {
    ideas: createSplitter('ideas'),
    files: createSplitter('files'),
    right: createSplitter('right'),
  };

  function arrange(stacked: boolean) {
    const tracks: string[] = [];
    const elements: HTMLElement[] = [];
    let afterCode = false;
    for (const pane of order) {
      if (pane === 'code') {
        tracks.push('[code] minmax(0, 1fr)');
        if (panes.code) elements.push(panes.code);
        if (stacked) elements.push(splitters.right, ...rightPanels);
        afterCode = true;
        continue;
      }
      if (pane === 'right' && stacked) continue;
      const panelTrack = `[${pane}] var(--workspace-${pane})`;
      const dividerTrack = `[${pane}-split] var(--workspace-${pane}-divider)`;
      const panel = panelFor(pane);
      const elementsForPane = pane === 'right' ? rightPanels : panel ? [panel] : [];
      if (afterCode) {
        tracks.push(dividerTrack, panelTrack);
        elements.push(splitters[pane], ...elementsForPane);
      } else {
        tracks.push(panelTrack, dividerTrack);
        elements.push(...elementsForPane, splitters[pane]);
      }
    }
    workspace.style.setProperty('--workspace-columns', tracks.join(' '));
    // Keep the tab and reading order aligned with the grid without remounting focused editors.
    let next: HTMLElement = dropMarker;
    for (const element of elements.reverse()) {
      if (element.nextElementSibling !== next) workspace.moveBefore(element, next);
      next = element;
    }
  }

  function paint(next: Layout) {
    layout = next;
    const { stacked, sizes } = layout;
    workspace.classList.toggle('workspace-stacked', stacked);
    for (const key of DIMENSIONS) {
      workspace.style.setProperty(`--workspace-${key}`, `${sizes[key]}px`);
    }
    for (const column of COLUMNS) {
      const divider = splitters[column];
      const key = column === 'right' && stacked ? 'rightHeight' : column;
      const visible = key === 'rightHeight' || layout.activeColumns.includes(column);
      workspace.style.setProperty(
        `--workspace-${column}-divider`,
        visible ? `${DIVIDER_SIZE}px` : '0px',
      );
      divider.hidden = !visible;
      if (!visible) continue;
      const name = panelName(column);
      const axis = key === 'rightHeight' ? 'height' : 'width';
      const bounds = resizeBounds(layout, key);
      divider.title = `Resize ${name} · Double-click to reset`;
      divider.setAttribute('aria-label', `${name} ${axis}`);
      divider.setAttribute('aria-controls', panelFor(column)?.id ?? '');
      divider.setAttribute('aria-orientation', axis === 'width' ? 'vertical' : 'horizontal');
      divider.setAttribute('aria-valuemin', String(bounds.min));
      divider.setAttribute('aria-valuemax', String(bounds.max));
      divider.setAttribute('aria-valuenow', String(sizes[key]));
      divider.setAttribute('aria-valuetext', `${sizes[key]} pixels`);
    }
  }

  function refresh() {
    if (drag) stopDrag(false);
    stopDock();
    const next = measure(
      workspace.clientWidth,
      workspace.clientHeight,
      {
        ideas: ideasNotebook ? ideasDocked : Boolean(panes.ideas && !panes.ideas.hidden),
        files: Boolean(panes.files && !panes.files.hidden),
        right: Boolean(rightPanel()),
      },
      preferred,
      order,
    );
    arrange(next.stacked);
    for (const header of auxiliaryHeaders) {
      header.tabIndex = next.stacked ? -1 : 0;
      header.toggleAttribute('data-panel-drag-handle', !next.stacked);
    }
    paint(next);
  }

  function savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...preferred, order }));
    } catch {
      // Layout changes still apply for the current window.
    }
  }

  function store(before: Sizes) {
    const changed = DIMENSIONS.filter(key => before[key] !== layout.sizes[key]);
    if (!changed.length) return;
    for (const key of changed) {
      const min = key === 'rightHeight' ? RIGHT_HEIGHT.min : WIDTHS[key].min;
      preferred[key] = Math.max(min, layout.sizes[key]);
    }
    savePreferences();
  }

  function updateSize(key: Dimension, target: number) {
    const before = layout.sizes;
    paint({ ...layout, sizes: resize(layout, key, target) });
    store(before);
  }

  function stopDrag(keep: boolean) {
    if (!drag) return;
    const { divider, initial, pointer } = drag;
    drag = null;
    if (divider.hasPointerCapture(pointer)) divider.releasePointerCapture(pointer);
    divider.classList.remove('is-dragging');
    divider.style.removeProperty('--splitter-pull');
    delete document.body.dataset.workspaceResizing;
    if (keep) store(initial.sizes);
    else paint(initial);
  }

  function movePanel(column: Column, destination: Destination) {
    const next = order.filter(pane => pane !== column);
    const index = destination === 'end' ? next.length : next.indexOf(destination);
    if (index < 0) return;
    next.splice(index, 0, column);
    order = next;
    refresh();
    savePreferences();
  }

  function showDropTarget(event: PointerEvent) {
    if (!dock) return;
    const { column } = dock;
    const { clientX: x, clientY: y } = event;
    const bounds = workspace.getBoundingClientRect();
    const labelX = clamp(x - bounds.left + 14, 4, bounds.width - dragLabel.offsetWidth - 4);
    const labelY = clamp(y - bounds.top + 16, 4, bounds.height - dragLabel.offsetHeight - 4);
    dragLabel.style.transform = `translate(${labelX}px, ${labelY}px)`;
    if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) {
      dock.destination = null;
      dropMarker.hidden = true;
      return;
    }

    const candidates = layout.activePanes.filter(pane => pane !== column);
    const edges = candidates.map(pane => panelFor(pane)?.getBoundingClientRect());
    const index = edges.findIndex(rect => rect && x < rect.left + rect.width / 2);
    const insertion = index < 0 ? candidates.length : index;
    if (insertion === layout.activePanes.indexOf(column)) {
      dock.destination = null;
      dropMarker.hidden = true;
      return;
    }
    dock.destination = candidates[insertion] ?? 'end';
    const edge = edges[insertion]?.left ?? edges.at(-1)?.right ?? bounds.right;
    dropMarker.style.left = `${clamp(edge - bounds.left, 2, bounds.width - 2)}px`;
    dropMarker.hidden = false;
  }

  function stopDock() {
    if (!dock) return;
    const { header, pointer } = dock;
    dock = null;
    if (workspace.hasPointerCapture(pointer)) workspace.releasePointerCapture(pointer);
    header.removeAttribute('data-panel-dragging');
    workspace.removeAttribute('data-panel-dragging');
    dropMarker.hidden = true;
    dragLabel.hidden = true;
  }

  const handles = [
    { column: 'ideas', panel: panes.ideas, selector: '.idea-header' },
    { column: 'files', panel: panes.files, selector: '.navigator-heading, .change-review-heading' },
    ...rightPanels.map(panel => ({
      column: 'right' as const,
      panel,
      selector: '.claude-heading, .review-notes-heading',
    })),
  ] as const;
  const auxiliaryHeaders: HTMLElement[] = [];
  const ideasHeader = panes.ideas?.querySelector<HTMLElement>('.idea-header');
  const dragHint = 'Use the left or right arrow key to move this panel.';
  for (const { column, panel, selector } of handles) {
    for (const header of panel?.querySelectorAll<HTMLElement>(selector) ?? []) {
      if (column === 'right') auxiliaryHeaders.push(header);
      header.setAttribute('data-panel-drag-handle', '');
      header.tabIndex = 0;
      header.setAttribute('aria-description', dragHint);
      header.addEventListener(
        'pointerdown',
        event => {
          if (
            event.button !== 0 ||
            drag ||
            dock ||
            (ideasNotebook && column === 'ideas') ||
            !layout.activeColumns.includes(column) ||
            !(event.target instanceof Element)
          )
            return;
          const control = event.target.closest(CONTROLS);
          if (control && !control.matches('.navigator-root')) return;
          dock = {
            column,
            header,
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            started: false,
            destination: null,
          };
        },
        options,
      );
      header.addEventListener(
        'keydown',
        event => {
          if (
            event.target !== header ||
            (ideasNotebook && column === 'ideas') ||
            drag ||
            dock ||
            event.altKey ||
            event.metaKey ||
            event.ctrlKey
          )
            return;
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          const index = layout.activePanes.indexOf(column);
          if (index < 0) return;
          event.preventDefault();
          const previous = layout.activePanes[index - 1];
          if (event.key === 'ArrowLeft' && previous) {
            movePanel(column, previous);
          } else if (event.key === 'ArrowRight' && index < layout.activePanes.length - 1) {
            movePanel(column, layout.activePanes[index + 2] ?? 'end');
          }
        },
        options,
      );
    }
  }

  window.addEventListener(
    'pointerdown',
    event => {
      if (event.pointerId === suppressedPointer) suppressedPointer = null;
    },
    { ...options, capture: true },
  );
  workspace.addEventListener(
    'click',
    event => {
      if (event instanceof PointerEvent && event.pointerId === suppressedPointer) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { ...options, capture: true },
  );
  window.addEventListener(
    'pointermove',
    event => {
      if (event.pointerId !== dock?.pointer) return;
      if (!dock.started) {
        if (Math.hypot(event.clientX - dock.x, event.clientY - dock.y) < 5) return;
        dock.started = true;
        suppressedPointer = event.pointerId;
        workspace.setPointerCapture(event.pointerId);
        workspace.setAttribute('data-panel-dragging', '');
        dock.header.setAttribute('data-panel-dragging', '');
        dragLabel.textContent = panelName(dock.column);
        dragLabel.hidden = false;
      }
      showDropTarget(event);
    },
    options,
  );
  window.addEventListener(
    'pointerup',
    event => {
      if (event.pointerId !== dock?.pointer) return;
      if (dock.started) showDropTarget(event);
      const { column, destination } = dock;
      stopDock();
      if (destination !== null) movePanel(column, destination);
    },
    options,
  );
  window.addEventListener(
    'pointercancel',
    event => {
      if (event.pointerId === dock?.pointer) stopDock();
    },
    options,
  );
  workspace.addEventListener(
    'lostpointercapture',
    event => {
      if (event.target === workspace && event.pointerId === dock?.pointer) stopDock();
    },
    options,
  );
  window.addEventListener(
    'keydown',
    event => {
      if (!dock || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stopDock();
    },
    { ...options, capture: true },
  );
  window.addEventListener('blur', stopDock, options);

  refresh();
  let lastWidth = workspace.clientWidth;
  let lastHeight = workspace.clientHeight;
  const dimensions = new ResizeObserver(() => {
    const { clientWidth, clientHeight } = workspace;
    if (lastWidth === clientWidth && lastHeight === clientHeight) return;
    lastWidth = clientWidth;
    lastHeight = clientHeight;
    refresh();
  });
  dimensions.observe(workspace);
  const visibility = new MutationObserver(refresh);
  for (const panel of [
    panes.ideas,
    panes.files,
    ...(panes.files?.children ?? []),
    ...rightPanels,
  ]) {
    if (panel) visibility.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    setIdeasNotebook(notebook: boolean, docked: boolean) {
      ideasNotebook = notebook;
      ideasDocked = docked;
      workspace.toggleAttribute('data-ideas-notebook', notebook);
      for (const panel of [panes.files, panes.code, ...rightPanels, ...Object.values(splitters)]) {
        if (panel) panel.inert = notebook;
      }
      if (ideasHeader) {
        ideasHeader.tabIndex = notebook ? -1 : 0;
        ideasHeader.toggleAttribute('data-panel-drag-handle', !notebook);
        if (notebook) ideasHeader.removeAttribute('aria-description');
        else ideasHeader.setAttribute('aria-description', dragHint);
      }
      refresh();
    },
    dispose() {
      stopDrag(false);
      stopDock();
      abort.abort();
      dimensions.disconnect();
      visibility.disconnect();
    },
  };
}

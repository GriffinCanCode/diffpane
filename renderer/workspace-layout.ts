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
type Dimension = Column | 'rightHeight';
type Sizes = Record<Dimension, number>;

const columns = Object.keys(WIDTHS) as Column[];
const defaults = {
  ideas: WIDTHS.ideas.initial,
  files: WIDTHS.files.initial,
  right: WIDTHS.right.initial,
  rightHeight: RIGHT_HEIGHT.initial,
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readSizes(): Sizes {
  const sizes = { ...defaults };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    for (const key of Object.keys(sizes) as Dimension[]) {
      if (!Number.isFinite(stored?.[key])) continue;
      const { min, max } = key === 'rightHeight' ? RIGHT_HEIGHT : WIDTHS[key];
      sizes[key] = clamp(stored[key], min, max);
    }
  } catch {
    // The layout also works with storage disabled.
  }
  return sizes;
}

function measure(
  width: number,
  height: number,
  visible: Record<Column, boolean>,
  preferred: Sizes,
) {
  const stacked =
    visible.right &&
    width <
      CODE_WIDTH +
        columns.reduce((sum, key) => sum + (visible[key] ? WIDTHS[key].min + DIVIDER_SIZE : 0), 0);
  const activeColumns = columns.filter(key => visible[key] && !(key === 'right' && stacked));
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

  return { sizes, min, budget: Math.floor(budget), maxHeight, stacked, activeColumns };
}

type Layout = ReturnType<typeof measure>;

function resizeBounds(layout: Layout, key: Dimension) {
  if (key === 'rightHeight') return { min: layout.min[key], max: layout.maxHeight };
  const reserved = layout.activeColumns.reduce(
    (sum, column) =>
      sum +
      (column === key
        ? 0
        : key === 'ideas' && column === 'files'
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
  if (key === 'ideas' && layout.activeColumns.includes('files')) {
    sizes.files = clamp(
      layout.sizes.files - (size - layout.sizes.ideas),
      layout.min.files,
      WIDTHS.files.max,
    );
  }
  return sizes;
}

export function createWorkspaceLayout(workspace: HTMLElement) {
  const ideas = workspace.querySelector<HTMLElement>(':scope > #ideas-panel');
  const files = workspace.querySelector<HTMLElement>(':scope > #sidebar');
  const code = workspace.querySelector<HTMLElement>(':scope > .workbench');
  const rightPanels = [
    ...workspace.querySelectorAll<HTMLElement>(':scope > :is(#claude-panel, #review-notes-panel)'),
  ];
  const rightPanel = () => rightPanels.find(panel => !panel.hidden);
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const preferred = readSizes();
  let layout: Layout;
  let drag: {
    key: Dimension;
    pointer: number;
    origin: number;
    initial: Layout;
    divider: HTMLDivElement;
  } | null = null;

  const splitters = columns.map(column => {
    const divider = document.createElement('div');
    divider.className = 'workspace-splitter';
    divider.dataset.column = column;
    divider.setAttribute('role', 'separator');
    divider.tabIndex = 0;
    divider.append(document.createElement('span'));
    const pane = column === 'ideas' ? ideas : column === 'files' ? files : code;
    pane?.after(divider);

    const dimension = () => (column === 'right' && layout.stacked ? 'rightHeight' : column);
    const coordinate = (event: PointerEvent, key: Dimension) =>
      key === 'rightHeight' ? event.clientY : event.clientX;

    divider.addEventListener(
      'pointerdown',
      event => {
        if (event.button !== 0 || drag) return;
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
        const direction = column === 'right' ? -1 : 1;
        const target =
          drag.initial.sizes[drag.key] + direction * (coordinate(event, drag.key) - drag.origin);
        const sizes = resize(drag.initial, drag.key, target);
        const excess = (target - sizes[drag.key]) * direction;
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
        const direction = column === 'right' ? -1 : 1;
        const step = (event.shiftKey ? 48 : 12) * direction;
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
        updateSize(key, defaults[key]);
      },
      options,
    );

    return { column, divider };
  });

  function paint(next: Layout) {
    layout = next;
    const { stacked, sizes } = layout;
    const activeRight = rightPanel();
    workspace.classList.toggle('workspace-stacked', stacked);
    for (const key of Object.keys(sizes) as Dimension[]) {
      workspace.style.setProperty(`--workspace-${key}`, `${sizes[key]}px`);
    }
    for (const { column, divider } of splitters) {
      const key = column === 'right' && stacked ? 'rightHeight' : column;
      const visible = key === 'rightHeight' || layout.activeColumns.includes(column);
      workspace.style.setProperty(
        `--workspace-${column}-divider`,
        visible ? `${DIVIDER_SIZE}px` : '0px',
      );
      divider.hidden = !visible;
      if (!visible) continue;
      const name =
        column === 'ideas'
          ? 'Ideas'
          : column === 'files'
            ? 'File Explorer'
            : activeRight?.id === 'review-notes-panel'
              ? 'Review Notes'
              : 'Claude';
      const axis = key === 'rightHeight' ? 'height' : 'width';
      const controls = column === 'ideas' ? ideas : column === 'files' ? files : activeRight;
      const bounds = resizeBounds(layout, key);
      divider.title = `Resize ${name} · Double-click to reset`;
      divider.setAttribute('aria-label', `${name} ${axis}`);
      divider.setAttribute('aria-controls', controls?.id ?? '');
      divider.setAttribute('aria-orientation', axis === 'width' ? 'vertical' : 'horizontal');
      divider.setAttribute('aria-valuemin', String(bounds.min));
      divider.setAttribute('aria-valuemax', String(bounds.max));
      divider.setAttribute('aria-valuenow', String(sizes[key]));
      divider.setAttribute('aria-valuetext', `${sizes[key]} pixels`);
    }
  }

  function refresh() {
    if (drag) stopDrag(false);
    paint(
      measure(
        workspace.clientWidth,
        workspace.clientHeight,
        {
          ideas: Boolean(ideas && !ideas.hidden),
          files: Boolean(files && !files.hidden),
          right: Boolean(rightPanel()),
        },
        preferred,
      ),
    );
  }

  function store(before: Sizes) {
    const changed = (Object.keys(before) as Dimension[]).filter(
      key => before[key] !== layout.sizes[key],
    );
    if (!changed.length) return;
    for (const key of changed) {
      const min = key === 'rightHeight' ? RIGHT_HEIGHT.min : WIDTHS[key].min;
      preferred[key] = Math.max(min, layout.sizes[key]);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred));
    } catch {
      // Resizing still applies for the current window.
    }
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
  for (const panel of [ideas, files, ...rightPanels]) {
    if (panel) visibility.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    dispose() {
      stopDrag(false);
      abort.abort();
      dimensions.disconnect();
      visibility.disconnect();
    },
  };
}

import './change-review.css';
import { projectIcon } from './icons.ts';

const ROW_HEIGHT = 48;
const OVERSCAN = 4;
const checkpointTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});
let instance = 0;

function icon(path, className = '') {
  return `<svg class="${className}" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const glyphs = {
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
};

const statusLabels = {
  '!': 'Merge conflict',
  A: 'Added',
  C: 'Copied',
  D: 'Deleted',
  M: 'Modified',
  R: 'Renamed',
  T: 'Type changed',
  U: 'Untracked',
};

function changeStatus(file) {
  if (file.conflicted) return '!';
  if (file.worktree === 'D') return 'D';
  if (file.index === 'R' || file.index === 'C') return file.index;
  if (file.worktree === '?') return 'U';
  return statusLabels[file.worktree] ? file.worktree : (file.index || 'M').trim() || 'M';
}

export function createChangeReview(
  container,
  { onOpen, onBack, onProgress, onCapture, onBaseline },
) {
  const id = `change-review-${++instance}`;
  container.classList.add('change-review');
  container.setAttribute('aria-labelledby', `${id}-title`);
  container.hidden = true;
  container.style.setProperty('--change-review-row-height', `${ROW_HEIGHT}px`);
  container.innerHTML = `
    <header class="change-review-heading">
      <h2 id="${id}-title">Review queue</h2>
      <button type="button" class="change-review-back" aria-label="Back to files" title="Back to files">${icon(glyphs.back)} Files</button>
    </header>
    <div class="change-review-baseline">
      <div class="change-review-baseline-actions">
        <select class="change-review-baseline-select" aria-label="Compare against" aria-describedby="${id}-checkpoint-time" hidden>
          <option value="head">Git HEAD</option>
          <option value="checkpoint">Checkpoint</option>
        </select>
        <button type="button" class="change-review-capture">${icon(glyphs.checkpoint)}<span></span></button>
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
          <button type="button" data-direction="previous" aria-label="Previous changed file" title="Previous changed file">${icon(glyphs.previous)}</button>
          <button type="button" data-direction="next" aria-label="Next changed file" title="Next changed file">${icon(glyphs.next)}</button>
        </div>
      </div>
      <button class="change-review-mark" type="button">
        <span class="change-review-mark-icon"></span>
        <span class="change-review-mark-label"></span>
        ${icon(glyphs.next, 'change-review-mark-next')}
      </button>
    </footer>`;

  const baselineSelect = container.querySelector('.change-review-baseline-select');
  const captureButton = container.querySelector('.change-review-capture');
  const captureLabel = captureButton.querySelector('span');
  const capturedTime = container.querySelector('time');
  const checkpointError = container.querySelector('.change-review-checkpoint-error');
  const count = container.querySelector('.change-review-count');
  const progress = container.querySelector('progress');
  const progressGroup = container.querySelector('.change-review-progress');
  const filterGroup = container.querySelector('.change-review-filters');
  const filters = [...container.querySelectorAll('[data-filter]')];
  const list = container.querySelector('.change-review-list');
  const rows = container.querySelector('.change-review-rows');
  const empty = container.querySelector('.change-review-empty');
  const emptyIcon = empty.querySelector('.change-review-empty-icon');
  const emptyTitle = empty.querySelector('h3');
  const emptyDescription = empty.querySelector('p');
  const emptyAction = empty.querySelector('button');
  const footer = container.querySelector('.change-review-footer');
  const position = container.querySelector('.change-review-position');
  const error = footer.querySelector('.change-review-error');
  const previous = container.querySelector('[data-direction="previous"]');
  const next = container.querySelector('[data-direction="next"]');
  const mark = container.querySelector('.change-review-mark');
  const markIcon = mark.querySelector('.change-review-mark-icon');
  const markLabel = mark.querySelector('.change-review-mark-label');
  const markNext = mark.querySelector('.change-review-mark-next');
  const headReviewed = new Map();
  const checkpointReviewed = new Map();
  const mounted = new Map();
  let reviewed = headReviewed;
  let baseline = 'head';
  let checkpoint = null;
  let capturing = false;
  let captureError = '';
  let resetScrollOnUpdate = false;
  let changes = new Map();
  let entries = [];
  let entryIndex = new Map();
  let filter = 'pending';
  let currentPath = null;
  let currentVersion = null;
  let currentState = null;
  let activePath = null;
  let openingPath = null;
  let request = 0;
  let frame = null;
  let disposed = false;

  function renderBaseline() {
    baselineSelect.hidden = !checkpoint;
    baselineSelect.disabled = capturing;
    if (baselineSelect.value !== baseline) baselineSelect.value = baseline;
    captureButton.setAttribute('aria-disabled', String(capturing));
    captureButton.title = checkpoint
      ? 'Replace the checkpoint and start a new review'
      : 'Capture the current working tree for review';
    captureButton.setAttribute(
      'aria-label',
      capturing ? 'Capturing checkpoint' : checkpoint ? 'Replace checkpoint' : 'Capture checkpoint',
    );
    const action = capturing
      ? 'Capturing…'
      : checkpoint
        ? 'Replace checkpoint'
        : 'Capture checkpoint';
    if (captureLabel.textContent !== action) captureLabel.textContent = action;
    capturedTime.hidden = !checkpoint;
    const timestamp = checkpoint ? new Date(checkpoint.capturedAt) : null;
    if (timestamp && Number.isFinite(timestamp.getTime())) {
      const label = `Captured ${checkpointTime.format(timestamp)}`;
      capturedTime.dateTime = timestamp.toISOString();
      if (capturedTime.textContent !== label) capturedTime.textContent = label;
    } else {
      capturedTime.removeAttribute('datetime');
      capturedTime.textContent = '';
    }
    const message = captureError || (baseline === 'checkpoint' && checkpoint?.error) || '';
    checkpointError.hidden = !message;
    if (checkpointError.textContent !== message) checkpointError.textContent = message;
  }

  async function capture() {
    if (capturing || disposed) return;
    capturing = true;
    captureError = '';
    renderBaseline();
    try {
      await onCapture();
    } catch (error) {
      captureError = error?.message || String(error);
    } finally {
      capturing = false;
      if (!disposed) renderBaseline();
    }
  }

  function focusQueue() {
    const target = !list.hidden
      ? list
      : !emptyAction.hidden
        ? emptyAction
        : checkpoint
          ? emptyTitle
          : captureButton;
    target.focus({ preventScroll: true });
  }

  function renderRows() {
    if (container.hidden || disposed) return;
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      entries.length,
      Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT) + OVERSCAN,
    );
    const indexes = Array.from({ length: end - start }, (_, offset) => start + offset);
    const activeIndex = entryIndex.get(activePath);
    // Keep the keyboard cursor accessible when scrolling takes it out of the window.
    if (activeIndex < start) indexes.unshift(activeIndex);
    else if (activeIndex >= end) indexes.push(activeIndex);
    const retained = new Set();
    let activeId = '';
    let cursor = rows.firstElementChild;
    for (const index of indexes) {
      const file = entries[index];
      const slash = file.path.lastIndexOf('/');
      const name = file.path.slice(slash + 1);
      retained.add(file.path);
      let row = mounted.get(file.path);
      if (!row) {
        row = document.createElement('div');
        row.className = 'change-review-row';
        row.dataset.path = file.path;
        row.setAttribute('role', 'option');
        row.innerHTML = `<img class="change-review-file-icon" alt=""><div class="change-review-label"><span class="change-review-name"></span><span class="change-review-location"></span></div><span class="change-review-status" aria-hidden="true"><span class="change-review-status-symbol"></span><span class="change-review-status-label"></span></span>`;
        row.querySelector('img').src = projectIcon({ kind: 'file', name });
        row.querySelector('.change-review-name').textContent = name;
        mounted.set(file.path, row);
      }
      if (row !== cursor) rows.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
      row.id = `${id}-row-${index}`;
      row.style.top = `${index * ROW_HEIGHT}px`;
      row.dataset.active = String(file.path === activePath);
      const loading = file.path === (openingPath ?? (currentState === 'loading' && currentPath));
      row.dataset.loading = String(loading);
      row.setAttribute('aria-selected', String(file.path === currentPath && currentState !== null));
      row.setAttribute('aria-posinset', String(index + 1));
      row.setAttribute('aria-setsize', String(entries.length));
      const status = changeStatus(file);
      const label = statusLabels[status] ?? 'Changed';
      const oldPath = file.originalPath;
      const directory = file.path.slice(0, Math.max(0, slash));
      row.dataset.status = status;
      row.title = oldPath ? `${label} · ${oldPath} → ${file.path}` : `${label} · ${file.path}`;
      row.setAttribute(
        'aria-label',
        `${label}, ${file.path}${oldPath ? `, from ${oldPath}` : ''}${loading ? ', loading comparison' : ''}`,
      );
      row.querySelector('.change-review-location').textContent = oldPath
        ? `${directory ? `${directory} · ` : ''}From ${oldPath}`
        : directory;
      row.querySelector('.change-review-status-symbol').textContent = status;
      row.querySelector('.change-review-status-label').textContent = label;
      if (file.path === activePath) activeId = row.id;
    }
    for (const [path, row] of mounted) {
      if (retained.has(path)) continue;
      row.remove();
      mounted.delete(path);
    }
    if (activeId) list.setAttribute('aria-activedescendant', activeId);
    else list.removeAttribute('aria-activedescendant');
  }

  function scheduleRows() {
    if (frame !== null || container.hidden || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      renderRows();
    });
  }

  function revealActive() {
    const index = entryIndex.get(activePath);
    if (index === undefined || container.hidden) return;
    const top = index * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  }

  function canMark() {
    return (
      !(baseline === 'checkpoint' && checkpoint?.error) &&
      !openingPath &&
      currentState === 'ready' &&
      entryIndex.has(currentPath) &&
      Number.isSafeInteger(currentVersion) &&
      changes.get(currentPath)?.reviewVersion === currentVersion
    );
  }

  function comparisonIndex() {
    return entryIndex.get(openingPath ?? (currentState === null ? null : currentPath));
  }

  function renderControls() {
    const index = comparisonIndex();
    const canNavigate = entries.length > 1 || (entries.length === 1 && index === undefined);
    previous.disabled = !canNavigate;
    next.disabled = !canNavigate;
    const state = openingPath ? 'loading' : index === undefined ? null : currentState;
    const positionText =
      index === undefined
        ? `${entries.length.toLocaleString()} ${entries.length === 1 ? 'file' : 'files'}`
        : `File ${(index + 1).toLocaleString()} of ${entries.length.toLocaleString()}`;
    if (position.textContent !== positionText) position.textContent = positionText;

    const reviewable = canMark();
    const advance = reviewable && filter === 'pending' && entries.length > 1;
    let action = 'Open comparison';
    let symbol = 'compare';
    let disabled = !entries.length;
    if (baseline === 'checkpoint' && checkpoint?.error) {
      action = 'Checkpoint unavailable';
      disabled = true;
    } else if (reviewable) {
      action =
        filter === 'reviewed'
          ? 'Return to pending'
          : advance
            ? 'Mark reviewed & next'
            : 'Mark reviewed';
      symbol = filter === 'reviewed' ? 'undo' : 'check';
    } else if (state === 'failed') {
      action = 'Retry comparison';
      symbol = 'undo';
    } else if (state) {
      action = {
        loading: 'Loading comparison…',
        saving: 'Saving changes…',
        'save-failed': 'Save required to continue',
        closing: 'Closing…',
        ready: 'Updating comparison…',
      }[state];
      disabled = true;
    }
    mark.setAttribute('aria-disabled', String(disabled));
    if (markLabel.textContent !== action) markLabel.textContent = action;
    if (markIcon.dataset.icon !== symbol) {
      markIcon.dataset.icon = symbol;
      markIcon.innerHTML = icon(glyphs[symbol]);
    }
    markNext.toggleAttribute('hidden', !advance);
  }

  function updateProgress() {
    const total = changes.size;
    const done = reviewed.size;
    const summary = `${done.toLocaleString()} of ${total.toLocaleString()} reviewed`;
    if (count.textContent === summary) return;
    count.textContent = summary;
    progress.max = total || 1;
    progress.value = done;
    progress.setAttribute('aria-valuetext', summary);
    container.dataset.complete = String(total > 0 && done === total);
    onProgress({ pending: total - done, total });
  }

  function renderEmpty() {
    const state = !changes.size ? 'clean' : filter === 'reviewed' ? 'reviewed' : 'complete';
    const cleanState = baseline === 'head' ? 'head' : checkpoint?.error ? 'error' : 'checkpoint';
    const key = state === 'clean' ? cleanState : state;
    if (empty.dataset.state === key) return;
    empty.dataset.state = key;
    emptyIcon.innerHTML = icon(glyphs[state]);
    const [title, description, action] = {
      head: ['Working tree is clean', 'New changes will appear here as they happen.'],
      checkpoint: ['No changes since checkpoint', 'New changes will appear here as they happen.'],
      error: ['Checkpoint comparison unavailable'],
      reviewed: [
        'No files reviewed yet',
        'Mark a file reviewed to find it here.',
        'Show pending files',
      ],
      complete: ['Review complete', 'New edits move files back to Pending.', 'View reviewed files'],
    }[key];
    emptyTitle.textContent = title;
    emptyDescription.textContent = description ?? '';
    emptyDescription.hidden = !description;
    emptyAction.hidden = !action;
    emptyAction.textContent = action ?? '';
  }

  function project({ resetScroll = false } = {}) {
    const anchor = entries[Math.floor(list.scrollTop / ROW_HEIGHT)]?.path;
    const offset = list.scrollTop % ROW_HEIGHT;
    entries = [];
    entryIndex = new Map();
    for (const file of changes.values()) {
      if (reviewed.has(file.path) !== (filter === 'reviewed')) continue;
      entryIndex.set(file.path, entries.length);
      entries.push(file);
    }
    if (!entryIndex.has(activePath))
      activePath = entryIndex.has(currentPath) ? currentPath : (entries[0]?.path ?? null);
    rows.style.height = `${entries.length * ROW_HEIGHT}px`;
    if (resetScroll) list.scrollTop = 0;
    else if (entryIndex.has(anchor)) list.scrollTop = entryIndex.get(anchor) * ROW_HEIGHT + offset;
    for (const button of filters) {
      const showReviewed = button.dataset.filter === 'reviewed';
      const total = showReviewed ? reviewed.size : changes.size - reviewed.size;
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
      button.querySelector('span').textContent = total.toLocaleString();
    }
    const focused = document.activeElement;
    const isEmpty = entries.length === 0;
    if (isEmpty) renderEmpty();
    progressGroup.hidden = filterGroup.hidden = changes.size === 0;
    empty.hidden = !isEmpty;
    list.hidden = footer.hidden = isEmpty;
    renderControls();
    renderRows();
    const focusHidden =
      (filterGroup.hidden && filterGroup.contains(focused)) ||
      (isEmpty && (focused === list || footer.contains(focused))) ||
      (focused === emptyAction && emptyAction.hidden) ||
      (!isEmpty && empty.contains(focused));
    if (focusHidden) focusQueue();
  }

  async function choose(file) {
    if (!file || disposed) return;
    const generation = ++request;
    openingPath = file.path;
    activePath = file.path;
    error.hidden = true;
    revealActive();
    renderControls();
    renderRows();
    try {
      const opened = await onOpen(file);
      if (opened === false && generation === request && !disposed && entryIndex.has(currentPath))
        activePath = currentPath;
    } catch (failure) {
      if (generation === request && !disposed) {
        error.textContent = failure?.message || String(failure);
        error.hidden = false;
      }
    } finally {
      if (generation === request && !disposed) {
        openingPath = null;
        revealActive();
        renderControls();
        renderRows();
      }
    }
  }

  function adjacent(direction) {
    const current = comparisonIndex();
    if (current === undefined) return direction > 0 ? entries[0] : entries.at(-1);
    return entries[(current + direction + entries.length) % entries.length];
  }

  function markCurrent() {
    if (!canMark()) return;
    if (filter === 'reviewed') {
      reviewed.delete(currentPath);
      updateProgress();
      selectFilter('pending');
      return;
    }
    const following = adjacent(1);
    reviewed.set(currentPath, currentVersion);
    updateProgress();
    project();
    if (following && following.path !== currentPath) void choose(following);
  }

  function navigateList(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || entries.length === 0) return;
    const index = entryIndex.get(activePath) ?? 0;
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT));
    const movement = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      PageDown: index + page,
      PageUp: index - page,
      Home: 0,
      End: entries.length - 1,
    };
    if (Object.hasOwn(movement, event.key)) {
      event.preventDefault();
      activePath = entries[Math.min(entries.length - 1, Math.max(0, movement[event.key]))].path;
      revealActive();
      renderRows();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void choose(entries[index]);
    }
  }

  function selectFilter(nextFilter) {
    if (nextFilter === filter) return;
    filter = nextFilter;
    activePath = currentPath;
    error.hidden = true;
    project({ resetScroll: true });
    revealActive();
    renderRows();
  }

  for (const button of filters)
    button.addEventListener('click', () => selectFilter(button.dataset.filter));
  captureButton.addEventListener('click', () => void capture());
  baselineSelect.addEventListener('change', () => onBaseline(baselineSelect.value));
  container.querySelector('.change-review-back').addEventListener('click', onBack);
  emptyAction.addEventListener('click', () => {
    selectFilter(filter === 'pending' ? 'reviewed' : 'pending');
    focusQueue();
  });
  list.addEventListener('scroll', scheduleRows, { passive: true });
  list.addEventListener('focus', () => {
    if (!list.matches(':focus-visible')) return;
    revealActive();
    renderRows();
  });
  list.addEventListener('keydown', navigateList);
  list.addEventListener('click', event => {
    const row = event.target.closest('.change-review-row');
    if (!row) return;
    focusQueue();
    void choose(changes.get(row.dataset.path));
  });
  previous.addEventListener('click', () => void choose(adjacent(-1)));
  next.addEventListener('click', () => void choose(adjacent(1)));
  mark.addEventListener('click', () => {
    if (mark.getAttribute('aria-disabled') === 'true') return;
    if (canMark()) markCurrent();
    else void choose(changes.get(comparisonIndex() === undefined ? activePath : currentPath));
  });
  const resize = new ResizeObserver(scheduleRows);
  resize.observe(list);
  renderBaseline();

  return {
    setBaseline(mode, nextCheckpoint) {
      const replaced = checkpoint?.id !== nextCheckpoint?.id;
      const switched = mode !== baseline || (mode === 'checkpoint' && replaced);
      checkpoint = nextCheckpoint;
      if (replaced) checkpointReviewed.clear();
      if (switched) {
        baseline = mode;
        reviewed = mode === 'head' ? headReviewed : checkpointReviewed;
        request++;
        openingPath = null;
        currentState = null;
        currentVersion = null;
        activePath = currentPath;
        filter = 'pending';
        error.hidden = true;
        resetScrollOnUpdate = true;
      }
      renderBaseline();
    },
    update(files) {
      changes = new Map(files.map(file => [file.path, file]));
      for (const [path, version] of reviewed) {
        if (changes.get(path)?.reviewVersion !== version) reviewed.delete(path);
      }
      updateProgress();
      if (!container.hidden) {
        project({ resetScroll: resetScrollOnUpdate });
        resetScrollOnUpdate = false;
      }
    },
    setCurrent(path, state, version) {
      if (path === currentPath && state === currentState && version === currentVersion) return;
      const moved = path !== currentPath;
      currentPath = path;
      currentState = state;
      currentVersion = version;
      if (moved && (container.hidden || entryIndex.has(path))) {
        activePath = path;
        revealActive();
      }
      if (!container.hidden) {
        renderControls();
        renderRows();
      }
    },
    setVisible(visible) {
      if (visible === !container.hidden) return;
      container.hidden = !visible;
      if (visible) {
        project({ resetScroll: resetScrollOnUpdate });
        resetScrollOnUpdate = false;
        revealActive();
        renderRows();
      } else {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        entries = [];
        entryIndex.clear();
        mounted.clear();
        rows.replaceChildren();
        list.removeAttribute('aria-activedescendant');
      }
    },
    focus: focusQueue,
    dispose() {
      disposed = true;
      resize.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      container.replaceChildren();
      mounted.clear();
    },
  };
}

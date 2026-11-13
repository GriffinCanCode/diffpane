import {
  MAX_REVIEW_NOTE_LENGTH,
  type ReviewAnchor,
  type ReviewNote,
  type ReviewNoteChange,
} from '../review-notes.ts';
import './review-notes.css';

type ReviewNotesApi = {
  list: () => Promise<ReviewNote[]>;
  change: (change: ReviewNoteChange) => Promise<ReviewNote[]>;
  copy: () => Promise<number>;
  onChange: (callback: (notes: ReviewNote[]) => void) => () => void;
};

type Draft = {
  anchor: ReviewAnchor | null;
  project: boolean;
  note: ReviewNote | null;
  displayedText: string | null;
  needsRefresh: boolean;
};

const icons = {
  notes:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2.5h9A1.5 1.5 0 0 1 14 4v6a1.5 1.5 0 0 1-1.5 1.5H7l-3.5 2v-2A1.5 1.5 0 0 1 2 10V4a1.5 1.5 0 0 1 1.5-1.5ZM5 6h6M5 8.5h3.5"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>',
  add: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9m-4.5-4.5h9"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="5.5" y="5.5" width="7.75" height="7.75" rx="1.4"/><path d="M10.5 5.5V4.15a1.4 1.4 0 0 0-1.4-1.4H4.15a1.4 1.4 0 0 0-1.4 1.4V9.1a1.4 1.4 0 0 0 1.4 1.4H5.5"/></svg>',
};

function describeAnchor(anchor: ReviewAnchor | null) {
  if (!anchor) return 'Project note';
  const path = anchor.originalPath ?? anchor.path;
  const lines = anchor.line === null ? '' : `:${anchor.line}`;
  const end = anchor.endLine !== null && anchor.endLine !== anchor.line ? `–${anchor.endLine}` : '';
  const side = anchor.side === 'head' ? ' · HEAD' : '';
  return `${path}${lines}${end}${side}`;
}

function errorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/u,
    '',
  );
}

function node<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function button(label: string, action: string, className: string) {
  const element = node('button', className, label);
  element.type = 'button';
  element.dataset.reviewAction = action;
  return element;
}

export function createReviewNotes(
  container: HTMLElement,
  toggle: HTMLButtonElement,
  api: ReviewNotesApi,
  options: {
    matchesSaveShortcut: (event: KeyboardEvent) => boolean;
    capture: () => ReviewAnchor | null;
    onJump: (anchor: ReviewAnchor) => Promise<boolean>;
    onVisible: (visible: boolean) => void;
  },
) {
  container.classList.add('review-notes-panel');
  container.setAttribute('aria-labelledby', 'review-notes-title');
  container.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  container.innerHTML = `
    <header class="review-notes-heading">
      <h2 id="review-notes-title">Review notes</h2>
      <button type="button" class="review-notes-icon" data-review-action="close" aria-label="Close review notes" title="Close review notes">${icons.close}</button>
    </header>
    <div class="review-notes-toolbar">
      <div class="review-notes-filters" role="group" aria-label="Review note status">
        <button type="button" data-review-filter="open" aria-pressed="true">Open <span></span></button>
        <button type="button" data-review-filter="resolved" aria-pressed="false">Resolved <span></span></button>
      </div>
      <button type="button" class="review-notes-button review-notes-add" data-review-action="add">${icons.add}Add note</button>
    </div>
    <div class="review-notes-body">
      <form class="review-notes-composer" hidden>
        <label for="review-note-text"></label>
        <div class="review-notes-composer-location">
          <span class="review-notes-location" id="review-note-location"></span>
          <button type="button" class="review-notes-text-button" data-review-action="scope" hidden></button>
        </div>
        <textarea id="review-note-text" aria-describedby="review-note-location" placeholder="What should change?" rows="4" maxlength="${MAX_REVIEW_NOTE_LENGTH}"></textarea>
        <p class="review-notes-conflict" role="status" hidden></p>
        <pre class="review-notes-current-text" aria-label="Current saved note" tabindex="0" hidden></pre>
        <button type="button" class="review-notes-button review-notes-refresh" data-review-action="refresh" hidden>Refresh note</button>
        <div class="review-notes-composer-actions">
          <button type="button" class="review-notes-text-button review-notes-delete" data-review-action="delete" hidden>Delete note</button>
          <button type="button" class="review-notes-button review-notes-cancel" data-review-action="cancel">Cancel</button>
          <button type="submit" class="review-notes-button review-notes-primary" data-review-action="save">Save note</button>
        </div>
        <div class="review-notes-confirm" hidden>
          <p>Delete this note?</p>
          <button type="button" class="review-notes-button review-notes-cancel" data-review-action="keep">Keep note</button>
          <button type="button" class="review-notes-button review-notes-delete" data-review-action="confirm">Delete</button>
        </div>
      </form>
      <div class="review-notes-empty" hidden>
        <span class="review-notes-empty-icon">${icons.notes}</span>
        <h3></h3>
        <p></p>
        <button type="button" class="review-notes-button" data-review-action="retry" hidden>Retry</button>
      </div>
      <ul class="review-notes-list" aria-label="Open notes" hidden></ul>
    </div>
    <footer class="review-notes-footer">
      <p data-review-status role="status" aria-atomic="true"></p>
      <button type="button" class="review-notes-button review-notes-copy" data-review-action="copy" title="Copy open notes and their source context as Markdown">${icons.copy}Copy handoff</button>
    </footer>`;

  const action = (name: string) =>
    container.querySelector<HTMLButtonElement>(`[data-review-action="${name}"]`)!;
  const openFilter = container.querySelector<HTMLButtonElement>('[data-review-filter="open"]')!;
  const resolvedFilter = container.querySelector<HTMLButtonElement>(
    '[data-review-filter="resolved"]',
  )!;
  const badge = toggle.querySelector<HTMLElement>('.review-notes-count');
  const closeButton = action('close');
  const add = action('add');
  const copy = action('copy');
  const save = action('save');
  const remove = action('delete');
  const cancel = action('cancel');
  const scope = action('scope');
  const retry = action('retry');
  const refreshNote = action('refresh');
  const confirm = action('confirm');
  const keep = action('keep');
  const body = container.querySelector<HTMLElement>('.review-notes-body')!;
  const list = container.querySelector<HTMLUListElement>('.review-notes-list')!;
  const empty = container.querySelector<HTMLElement>('.review-notes-empty')!;
  const form = container.querySelector<HTMLFormElement>('.review-notes-composer')!;
  const formLabel = form.querySelector<HTMLLabelElement>('label')!;
  const location = form.querySelector<HTMLElement>('.review-notes-location')!;
  const input = form.querySelector<HTMLTextAreaElement>('textarea')!;
  const conflict = form.querySelector<HTMLElement>('.review-notes-conflict')!;
  const currentText = form.querySelector<HTMLElement>('.review-notes-current-text')!;
  const composerActions = form.querySelector<HTMLElement>('.review-notes-composer-actions')!;
  const confirmation = form.querySelector<HTMLElement>('.review-notes-confirm')!;
  const status = container.querySelector<HTMLElement>('[data-review-status]')!;

  let notes: ReviewNote[] = [];
  let draft: Draft | null = null;
  let ready = false;
  let loaded = false;
  let loading = false;
  let loadError = '';
  let resolved = false;
  let pending: ReviewNoteChange['type'] | null = null;
  let copying = false;
  let jumping = false;
  let confirming = false;
  let contextVersion = 0;
  let updateVersion = 0;
  let renderedNotes: ReviewNote[] | null = null;
  let renderedResolved = false;

  function notify(message: string, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  function renderComposer() {
    form.hidden = !draft;
    if (!draft) return;
    const latest = notes.find(note => note.id === draft?.note?.id);
    if (!pending && !draft.needsRefresh) draft.displayedText = latest?.text ?? null;
    const missing = Boolean(draft.note && !latest && !pending);
    const changed = Boolean(latest && latest.text !== draft.note?.text && !pending);
    if (missing) confirming = false;
    const description = describeAnchor(draft.project ? null : draft.anchor);
    location.textContent = location.title = description;
    formLabel.textContent = draft.note ? 'Edit note' : 'New note';
    conflict.textContent = draft.needsRefresh
      ? 'Refresh to see the current saved note. Your draft is still here.'
      : missing
        ? 'This note was deleted in another window.'
        : changed
          ? 'This note was edited in another window. Current saved text'
          : '';
    conflict.hidden = !conflict.textContent;
    currentText.hidden = !changed || draft.needsRefresh;
    currentText.textContent = currentText.hidden ? '' : latest!.text;
    refreshNote.hidden = !draft.needsRefresh || Boolean(pending);
    refreshNote.disabled = loading;
    scope.hidden = !draft.anchor || Boolean(draft.note);
    scope.textContent = draft.project ? 'Attach to file' : 'Make project note';
    remove.hidden = !draft.note || missing;
    composerActions.hidden = confirming;
    confirmation.hidden = !confirming;
    input.readOnly = Boolean(pending) || confirming;
    for (const control of [scope, remove, cancel, confirm, keep])
      control.disabled = Boolean(pending);
    save.disabled =
      !loaded || Boolean(pending) || draft.needsRefresh || confirming || !input.value.trim();
    save.textContent =
      pending === 'add' || pending === 'edit'
        ? 'Saving…'
        : missing
          ? 'Save as new note'
          : changed
            ? 'Overwrite note'
            : draft.note
              ? 'Save changes'
              : 'Save note';
  }

  function renderCard(note: ReviewNote, expanded: boolean) {
    const item = node('li', 'review-notes-card');
    item.dataset.noteId = note.id;
    const label = describeAnchor(note.anchor);
    if (note.anchor) {
      const anchor = note.anchor;
      const jump = button(label, 'jump', 'review-notes-location review-notes-jump');
      jump.title = `Open ${label}`;
      jump.setAttribute('aria-label', `Open ${label}`);
      jump.addEventListener('click', () => void jumpTo(anchor));
      item.append(jump);
    } else item.append(node('span', 'review-notes-location', label));
    item.append(node('p', 'review-notes-text', note.text));
    if (note.anchor?.excerpt) {
      const excerpt = node('details', 'review-notes-excerpt');
      excerpt.open = expanded;
      excerpt.append(
        node(
          'summary',
          '',
          note.anchor.truncated ? 'Captured excerpt (truncated)' : 'Captured excerpt',
        ),
        node('pre', '', note.anchor.excerpt),
      );
      item.append(excerpt);
    }
    const controls = node('div', 'review-notes-card-actions');
    const edit = button('Edit', 'edit', 'review-notes-text-button');
    const resolve = button(
      note.resolved ? 'Reopen' : 'Resolve',
      'resolve',
      'review-notes-text-button',
    );
    edit.setAttribute('aria-label', `Edit note for ${label}`);
    resolve.setAttribute('aria-label', `${resolve.textContent} note for ${label}`);
    edit.addEventListener('click', () => beginDraft(note.anchor, note));
    resolve.addEventListener('click', () => {
      void changeNote(
        { type: 'resolve', id: note.id, resolved: !note.resolved },
        note.resolved ? 'Note reopened.' : 'Note resolved.',
      );
    });
    controls.append(edit, resolve);
    item.append(controls);
    return item;
  }

  function focusCard(id: string, actionName: string, preventScroll = true) {
    const item = [...list.children].find(child => (child as HTMLElement).dataset.noteId === id);
    const control = item?.querySelector<HTMLElement>(
      actionName === 'summary' ? 'summary' : `[data-review-action="${actionName}"]`,
    );
    (control ?? (resolved ? resolvedFilter : openFilter)).focus({ preventScroll });
  }

  function renderList() {
    const openCount = notes.filter(note => !note.resolved).length;
    const resolvedCount = notes.length - openCount;
    const visibleCount = resolved ? resolvedCount : openCount;
    openFilter.setAttribute('aria-pressed', String(!resolved));
    resolvedFilter.setAttribute('aria-pressed', String(resolved));
    openFilter.querySelector('span')!.textContent = openCount.toLocaleString();
    resolvedFilter.querySelector('span')!.textContent = resolvedCount.toLocaleString();
    if (badge) {
      badge.hidden = !openCount;
      badge.textContent = openCount.toLocaleString();
    }
    toggle.setAttribute(
      'aria-description',
      `${openCount} open ${openCount === 1 ? 'note' : 'notes'}`,
    );
    copy.disabled = !loaded || !openCount || copying || Boolean(pending);
    add.disabled = Boolean(pending);
    empty.hidden = visibleCount > 0 || Boolean(draft && !loadError);
    empty.querySelector('h3')!.textContent =
      loading && !loaded
        ? 'Loading notes…'
        : loadError
          ? 'Couldn’t load notes'
          : resolved
            ? 'No resolved notes'
            : 'No open notes';
    empty.querySelector('p')!.textContent =
      loadError ||
      ((loading && !loaded) || resolved
        ? ''
        : 'Add a note for the project, or select code and add a note for those lines.');
    retry.hidden = !loadError;
    list.hidden = !visibleCount;
    list.setAttribute('aria-label', resolved ? 'Resolved notes' : 'Open notes');
    if (renderedNotes !== notes || renderedResolved !== resolved) {
      renderedNotes = notes;
      renderedResolved = resolved;
      const active = document.activeElement as HTMLElement | null;
      const activeId = active?.closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
      const activeAction = active?.dataset.reviewAction ?? 'summary';
      const expanded = new Set(
        [...list.querySelectorAll<HTMLElement>('details[open]')].map(
          details => details.closest<HTMLElement>('[data-note-id]')?.dataset.noteId,
        ),
      );
      const visibleNotes = notes.filter(note => note.resolved === resolved);
      list.replaceChildren(...visibleNotes.map(note => renderCard(note, expanded.has(note.id))));
      if (activeId && !pending) focusCard(activeId, activeAction);
    }
    for (const control of list.querySelectorAll<HTMLButtonElement>(
      '[data-review-action="resolve"], [data-review-action="edit"]',
    ))
      control.disabled = Boolean(pending);
  }

  function render() {
    renderComposer();
    renderList();
  }

  function receive(next: ReviewNote[]) {
    // The note location is fixed for its lifetime.
    if (
      notes.length !== next.length ||
      notes.some((note, index) => {
        const incoming = next[index];
        return (
          note.id !== incoming.id ||
          note.resolved !== incoming.resolved ||
          note.text !== incoming.text
        );
      })
    )
      notes = next;
    if (draft) draft.needsRefresh = false;
    loaded = true;
    loading = false;
    loadError = '';
    render();
  }

  async function load(force = false) {
    if (!ready || (!force && (loading || pending))) return;
    const context = contextVersion;
    const update = ++updateVersion;
    loading = true;
    loadError = '';
    render();
    try {
      const next = await api.list();
      if (context === contextVersion && update === updateVersion) receive(next);
    } catch (error) {
      if (context !== contextVersion || update !== updateVersion) return;
      loading = false;
      loadError = errorMessage(error);
      if (loaded) notify(`Couldn’t refresh notes. ${loadError}`, true);
      render();
      if (!container.hidden && document.activeElement === document.body) retry.focus();
    }
  }

  const unsubscribe = api.onChange(next => {
    if (!ready) return;
    updateVersion++;
    receive(next);
  });

  function show() {
    if (!container.hidden) return;
    container.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    options.onVisible(true);
    void load();
  }

  function close() {
    if (container.hidden) return;
    const restoreFocus = container.contains(document.activeElement);
    container.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    options.onVisible(false);
    if (restoreFocus && !toggle.hidden) toggle.focus();
  }

  function clearDraft() {
    draft = null;
    confirming = false;
    input.value = '';
  }

  function beginDraft(anchor: ReviewAnchor | null, note: ReviewNote | null = null) {
    if (!ready) return;
    show();
    if (pending || (draft && input.value.trim() !== (draft.note?.text ?? ''))) {
      if (!pending) notify('Save or cancel your current draft to start another note.');
      input.focus();
      return;
    }
    draft = {
      anchor,
      note,
      project: !anchor,
      displayedText: note?.text ?? null,
      needsRefresh: false,
    };
    input.value = note?.text ?? '';
    confirming = false;
    notify('');
    render();
    body.scrollTop = 0;
    input.focus();
  }

  async function changeNote(change: ReviewNoteChange, success: string) {
    if (!loaded || pending) return;
    const context = contextVersion;
    const update = updateVersion;
    const editing = change.type === 'add' || change.type === 'edit' || change.type === 'delete';
    pending = change.type;
    notify('');
    render();
    try {
      const next = await api.change(change);
      if (context !== contextVersion) return;
      if (editing) clearDraft();
      if (change.type === 'add') resolved = false;
      if (update === updateVersion) {
        updateVersion++;
        receive(next);
      }
      notify(success);
    } catch (error) {
      if (context === contextVersion) {
        notify(errorMessage(error), true);
        if (change.type === 'edit' && draft) {
          draft.needsRefresh = true;
          await load(true);
        }
      }
    } finally {
      if (context === contextVersion) {
        pending = null;
        render();
        if (!container.hidden && document.activeElement === document.body) {
          if (draft && editing) (confirming ? confirm : input).focus();
          else if (change.type === 'resolve') focusCard(change.id, 'resolve');
          else add.focus();
        }
      }
    }
  }

  async function jumpTo(anchor: ReviewAnchor) {
    if (jumping) return;
    const context = contextVersion;
    jumping = true;
    notify('');
    try {
      if (!(await options.onJump(anchor)) && context === contextVersion)
        notify('Couldn’t open the source for this note.', true);
    } catch (error) {
      if (context === contextVersion) notify(errorMessage(error), true);
    } finally {
      if (context === contextVersion) jumping = false;
    }
  }

  async function copyHandoff() {
    if (copy.disabled) return;
    const context = contextVersion;
    copying = true;
    copy.disabled = true;
    notify('');
    try {
      const count = await api.copy();
      if (context !== contextVersion) return;
      notify(
        count
          ? `Copied ${count} ${count === 1 ? 'note' : 'notes'} as Markdown.`
          : 'No open notes to copy.',
      );
    } catch (error) {
      if (context === contextVersion) notify(errorMessage(error), true);
    } finally {
      if (context === contextVersion) {
        copying = false;
        copy.disabled = !notes.some(note => !note.resolved) || Boolean(pending);
        if (!container.hidden && document.activeElement === document.body && !copy.disabled)
          copy.focus();
      }
    }
  }

  function togglePanel() {
    if (!ready) return;
    if (!container.hidden) close();
    else {
      show();
      (draft ? (confirming ? keep : input) : add.disabled ? closeButton : add).focus();
    }
  }

  toggle.addEventListener('click', togglePanel);
  const refreshOnFocus = () => void load();
  window.addEventListener('focus', refreshOnFocus);
  closeButton.addEventListener('click', close);
  add.addEventListener('click', () => {
    if (draft) input.focus();
    else beginDraft(options.capture());
  });
  retry.addEventListener('click', () => void load());
  refreshNote.addEventListener('click', () => void load());
  copy.addEventListener('click', () => void copyHandoff());
  openFilter.addEventListener('click', () => {
    resolved = false;
    renderList();
  });
  resolvedFilter.addEventListener('click', () => {
    resolved = true;
    renderList();
  });
  scope.addEventListener('click', () => {
    if (!draft || pending) return;
    draft.project = !draft.project;
    renderComposer();
  });
  cancel.addEventListener('click', () => {
    if (pending) return;
    const id = draft?.note?.id;
    clearDraft();
    notify('');
    render();
    if (id) focusCard(id, 'edit', false);
    else add.focus();
  });
  remove.addEventListener('click', () => {
    confirming = true;
    renderComposer();
    keep.focus();
  });
  keep.addEventListener('click', () => {
    confirming = false;
    renderComposer();
    remove.focus();
  });
  confirm.addEventListener('click', () => {
    if (draft?.note) void changeNote({ type: 'delete', id: draft.note.id }, 'Note deleted.');
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!draft || save.disabled) return;
    const text = input.value.trim();
    if (draft.note && draft.displayedText !== null)
      void changeNote(
        { type: 'edit', id: draft.note.id, text, expectedText: draft.displayedText },
        'Note updated.',
      );
    else
      void changeNote(
        { type: 'add', anchor: draft.project ? null : draft.anchor, text },
        'Note added.',
      );
  });
  input.addEventListener('input', () => renderComposer());
  container.addEventListener('keydown', event => {
    if (event.target === input && options.matchesSaveShortcut(event)) {
      event.preventDefault();
      if (!event.repeat && !save.disabled && currentText.hidden) form.requestSubmit();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });

  function setContext(next: boolean) {
    if (ready === next) return;
    ready = next;
    contextVersion++;
    toggle.hidden = !ready;
    if (ready) void load();
    else {
      close();
      clearDraft();
      notes = [];
      loaded = loading = copying = jumping = resolved = false;
      pending = null;
      loadError = '';
      notify('');
      render();
    }
  }

  return {
    setContext,
    openComposer: (anchor: ReviewAnchor | null) => beginDraft(anchor),
    close,
    notify,
    dispose: () => {
      setContext(false);
      unsubscribe();
      toggle.removeEventListener('click', togglePanel);
      window.removeEventListener('focus', refreshOnFocus);
    },
  };
}

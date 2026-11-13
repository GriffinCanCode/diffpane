import {
  IDEA_FILE_DRAG_TYPE,
  MAX_IDEA_BODY_LENGTH,
  MAX_IDEA_LINKS,
  MAX_IDEA_TITLE_LENGTH,
} from '../ideas.ts';
import type { Idea, IdeaChange, IdeaLink } from '../ideas.ts';
import { showMarkdownPreview } from './markdown-preview.ts';
import './ideas.css';

const glyphs = {
  idea: '<path d="M6 11a4.5 4.5 0 1 1 6 0c-.6.5-.9 1.1-.9 1.8v.7H6.9v-.7c0-.7-.3-1.3-.9-1.8ZM7.5 16h3"/>',
  plus: '<path d="M9 4v10M4 9h10"/>',
  close: '<path d="m5 5 8 8m0-8-8 8"/>',
  search: '<circle cx="7.5" cy="7.5" r="4.5"/><path d="m11 11 3.5 3.5"/>',
  file: '<path d="M5 2.5h5l3 3v10H5zM10 2.5v3h3M7 9h4m-4 3h4"/>',
  link: '<path d="m7 11 4-4M7.5 12l-1 1a2.5 2.5 0 1 1-3.5-3.5l2.5-2.5A2.5 2.5 0 0 1 9 7m0 4a2.5 2.5 0 0 0 3.5 0L15 8.5A2.5 2.5 0 1 0 11.5 5l-1 1"/>',
  chat: '<path d="M14.5 11.5H8l-3.5 2v-2H3.5V4h11zM6 7h6m-6 2h4"/>',
  trash: '<path d="M3.5 5h11m-10 0 .7 10h7.6l.7-10M7 5V3h4v2M7.5 8v4m3-4v4"/>',
  heading: '<path d="M5 4v10m8-10v10M5 9h8"/>',
  bold: '<path d="M5.5 9h4a2.5 2.5 0 1 1 0 5h-4V4h3.5a2.5 2.5 0 0 1 0 5" stroke-width="1.8"/>',
  italic: '<path d="M7.5 4h6m-9 10h6m.5-10-4 10"/>',
  code: '<path d="m6.5 5-4 4 4 4m5-8 4 4-4 4"/>',
  preview: '<path d="M2 9s2.5-4 7-4 7 4 7 4-2.5 4-7 4-7-4-7-4Z"/><circle cx="9" cy="9" r="1.8"/>',
  list: '<path d="M7 5h7m-7 4h7m-7 4h7M4 5h.1M4 9h.1M4 13h.1"/>',
  ordered:
    '<path d="M7.5 5h7m-7 4h7m-7 4h7M3 5.8h1.5m-.75 0V3.5l-.75.5M3 9a1 1 0 0 1 1.5.2c.3.7-1.3 1.6-1.5 2.3h1.6"/>',
  task: '<rect x="3" y="3" width="12" height="12" rx="2"/><path d="m6.2 9 2 2 3.6-4"/>',
};

type IdeaBuilderOptions = {
  load: () => Promise<Idea[]>;
  save: (idea: Idea) => Promise<Idea>;
  remove: (id: string) => Promise<void>;
  openLink: (link: IdeaLink) => void | Promise<void>;
  getWorkspace: () => string | undefined | null;
  getCurrentLink: () => IdeaLink | null | undefined;
  hasCurrentLink?: () => boolean;
  draftInChat?: (idea: Idea) => void | Promise<void>;
  onPendingChange?: () => void;
  onClose?: () => void;
  openMarkdownFile?: (target: { path: string; anchor: string }) => void;
  openExternal?: (href: string) => Promise<unknown>;
  media?: (path: string) => Promise<{ type: string; url: string }>;
  colorize?: (text: string, language: string) => Promise<string>;
};

function icon(name: keyof typeof glyphs) {
  return `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]}</svg>`;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, glyph?: keyof typeof glyphs, showText = false) {
  const control = node('button', 'idea-button');
  control.type = 'button';
  control.title = label;
  if (glyph) control.innerHTML = icon(glyph);
  if (!glyph || showText) control.append(node('span', '', label));
  else control.setAttribute('aria-label', label);
  return control;
}

function filename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function draggedFile(data: string, workspace: string) {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('workspace' in payload) ||
      payload.workspace !== workspace ||
      !('path' in payload) ||
      typeof payload.path !== 'string' ||
      !payload.path ||
      payload.path.length > 4096 ||
      payload.path.includes('\0') ||
      payload.path.split('/').some(part => !part || part === '.' || part === '..')
    )
      return null;
    return payload.path;
  } catch {
    return null;
  }
}

function linkLabel(link: IdeaLink, path = link.path) {
  const end = link.endLine ?? link.line;
  const range = link.line ? `:${link.line}${end !== link.line ? `–${end}` : ''}` : '';
  return `${path}${range}${link.side === 'head' ? ' · HEAD' : ''}`;
}

function matchesLink(left: IdeaLink, right: IdeaLink) {
  return (
    left.path === right.path &&
    left.line === right.line &&
    (left.endLine ?? left.line) === (right.endLine ?? right.line) &&
    (left.side ?? 'working') === (right.side ?? 'working')
  );
}

function bodySummary(body: string) {
  return body
    .trimStart()
    .slice(0, 160)
    .split('\n', 1)[0]
    .replace(/^([>#*_`-]+\s+)+/u, '');
}

function errorMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/u,
    '',
  );
}

type Replacement = { from: number; to: number; text: string; selection?: [number, number] };

const listPrefix = /^([\t ]*)([-+*]|\d{1,9}[.)])([\t ]+)(?:\[([ xX])\](?:([\t ]+)|$))?/u;

export function nextIdeaListItem(source: string, caret: number): Replacement | null {
  const from = caret > 0 ? source.lastIndexOf('\n', caret - 1) + 1 : 0;
  const nextLine = source.indexOf('\n', caret);
  const lineEnd = nextLine < 0 ? source.length : nextLine;
  const line = source.slice(from, lineEnd);
  const item = line.match(listPrefix);
  if (!item || caret < from + item[0].length) return null;

  let fence = '';
  for (const line of source.slice(0, from).matchAll(/^[\t ]*(`{3,}|~{3,})(.*)$/gmu)) {
    if (!fence) fence = line[1];
    else if (line[1].startsWith(fence) && !line[2].trim()) fence = '';
  }
  if (fence) return null;

  if (!line.slice(item[0].length).trim()) return { from, to: lineEnd, text: '' };
  const [, indent, marker, space, checked, taskSpace] = item;
  const number = Number.parseInt(marker, 10);
  const next =
    marker.length > 1 ? `${number < 999_999_999 ? number + 1 : 1}${marker.at(-1)}` : marker;
  const task = checked === undefined ? '' : `[ ]${taskSpace ?? ' '}`;
  return { from: caret, to: caret, text: `\n${indent}${next}${space}${task}` };
}

type Format = 'heading' | 'bold' | 'italic' | 'code' | 'list' | 'ordered' | 'task';
const formats: [Format, string][] = [
  ['heading', 'Heading'],
  ['bold', 'Bold'],
  ['italic', 'Italic'],
  ['code', 'Inline code'],
  ['list', 'Bulleted list'],
  ['ordered', 'Numbered list'],
  ['task', 'Checklist'],
];
const formattingShortcuts = { bold: 'b', italic: 'i' } as const;

export function formatIdeaSelection(
  source: string,
  start: number,
  end: number,
  format: Format,
): Replacement {
  if (format === 'bold' || format === 'italic' || format === 'code') {
    let selected = source.slice(start, end);
    if (selected.trim() && format !== 'code') {
      start += selected.length - selected.trimStart().length;
      end -= selected.length - selected.trimEnd().length;
      selected = source.slice(start, end);
    }
    let marker = format === 'bold' ? '**' : format === 'italic' ? '*' : '`';
    if (format === 'code') {
      for (const run of selected.matchAll(/`+/gu)) {
        if (run[0].length >= marker.length) marker = '`'.repeat(run[0].length + 1);
      }
    }
    const padding = format === 'code' && selected && /^[` ]|[` ]$/u.test(selected) ? ' ' : '';
    const edge = marker + padding;
    if (
      selected &&
      start >= edge.length &&
      source.slice(start - edge.length, start) === edge &&
      source.startsWith(padding + marker, end)
    ) {
      return {
        from: start - edge.length,
        to: end + edge.length,
        text: selected,
        selection: [0, selected.length],
      };
    }
    return {
      from: start,
      to: end,
      text: `${edge}${selected}${padding}${marker}`,
      selection: [edge.length, edge.length + selected.length],
    };
  }
  const from = start > 0 ? source.lastIndexOf('\n', start - 1) + 1 : 0;
  const endPosition = end > start && source[end - 1] === '\n' ? end - 1 : end;
  const nextLine = source.indexOf('\n', endPosition);
  const to = nextLine < 0 ? source.length : nextLine;
  const lines = source.slice(from, to).split('\n');
  const prefix = (index: number) =>
    format === 'heading'
      ? '## '
      : format === 'list'
        ? '- '
        : format === 'task'
          ? '- [ ] '
          : `${index + 1}. `;
  const current = (line: string) => {
    if (format === 'heading') return line.match(/^[\t ]*#{1,6}[\t ]+/u)?.[0] ?? '';
    const item = line.match(listPrefix);
    if (!item) return '';
    if (format === 'task') return item[4] === undefined ? '' : item[0];
    if (item[4] !== undefined) return '';
    const ordered = item[2].length > 1;
    return (format === 'ordered') === ordered ? item[0] : '';
  };
  const removing =
    lines.some(line => Boolean(current(line))) &&
    lines.every(line => !line.trim() || Boolean(current(line)));
  const transformed = lines.map((line, index) => {
    if (!line.trim() && lines.length > 1) return line;
    const indent = line.match(/^[\t ]*/u)![0];
    const existing = format === 'heading' ? current(line) : (line.match(listPrefix)?.[0] ?? '');
    return (
      indent +
      (removing ? '' : prefix(index)) +
      line.slice(Math.max(indent.length, existing.length))
    );
  });
  const text = transformed.join('\n');
  if (start !== end) return { from, to, text, selection: [0, text.length] };
  const caret = Math.max(0, Math.min(start - from + text.length - (to - from), text.length));
  return { from, to, text, selection: [caret, caret] };
}

export function mountIdeaBuilder(host: HTMLElement, options: IdeaBuilderOptions) {
  host.classList.add('idea-panel');
  host.setAttribute('aria-labelledby', 'idea-panel-title');
  host.innerHTML = `
    <header class="idea-header">
      <h2 id="idea-panel-title">${icon('idea')}<span>Ideas</span></h2>
      <div class="idea-header-actions"></div>
    </header>
    <label class="idea-search">${icon('search')}<input type="search" placeholder="Find an idea…" aria-label="Find an idea" autocomplete="off"></label>
    <div class="idea-list" role="group" aria-label="Saved ideas" hidden></div>
    <div class="idea-empty" hidden>
      <span class="idea-empty-icon">${icon('idea')}</span>
      <h3></h3>
      <p></p>
    </div>
    <section class="idea-detail" aria-label="Selected idea" hidden>
      <input class="idea-title-input" type="text" placeholder="Untitled idea" aria-label="Idea title" autocomplete="off" maxlength="${MAX_IDEA_TITLE_LENGTH}">
      <div class="idea-writing">
        <div class="idea-writing-tools">
          <div class="idea-formats" role="group" aria-label="Markdown formatting"></div>
        <button class="idea-button idea-preview-toggle" type="button" aria-pressed="false">${icon('preview')}<span>Preview</span></button>
        </div>
        <textarea class="idea-body-input" placeholder="Write a note in Markdown…" aria-label="Idea Markdown" maxlength="${MAX_IDEA_BODY_LENGTH}"></textarea>
        <div class="idea-preview" hidden></div>
      </div>
      <div class="idea-attachments" role="group" aria-label="Attached files" hidden></div>
      <div class="idea-detail-actions"></div>
      <div class="idea-delete-confirm" hidden>
        <span>Delete this idea?</span>
      </div>
    </section>
    <footer class="idea-footer" hidden><span role="status"></span></footer>`;

  const select = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const headerActions = select('.idea-header-actions');
  const search = select<HTMLInputElement>('.idea-search input');
  const list = select('.idea-list');
  const empty = select('.idea-empty');
  const emptyTitle = select('.idea-empty h3');
  const emptyDetail = select('.idea-empty p');
  const detail = select('.idea-detail');
  const title = select<HTMLInputElement>('.idea-title-input');
  const body = select<HTMLTextAreaElement>('.idea-body-input');
  const toolbar = select('.idea-formats');
  const previewToggle = select<HTMLButtonElement>('.idea-preview-toggle');
  const previewLabel = select('.idea-preview-toggle span');
  const preview = select('.idea-preview');
  const attachments = select('.idea-attachments');
  const detailActions = select('.idea-detail-actions');
  const confirmation = select('.idea-delete-confirm');
  const footer = select('.idea-footer');
  const status = select('.idea-footer span');

  const add = button('New idea', 'plus');
  const addFirst = button('New idea', 'plus', true);
  const close = button('Close ideas', 'close');
  const attachCurrent = button('Link current', 'link', true);
  const chat = button('Add to Claude', 'chat', true);
  const remove = button('Delete idea', 'trash');
  const cancelDelete = button('Cancel');
  const confirmDelete = button('Delete');
  const retryLoad = button('Retry');
  const retrySave = button('Retry');
  addFirst.classList.add('idea-primary');
  chat.classList.add('idea-primary');
  confirmDelete.classList.add('idea-destructive');
  remove.classList.add('idea-delete');
  previewToggle.title = 'Preview Markdown';
  attachCurrent.title = 'Link the current selection, visible code, or file';
  headerActions.append(add);
  if (options.onClose) headerActions.append(close);
  empty.append(addFirst, retryLoad);
  detailActions.append(attachCurrent);
  if (options.draftInChat) detailActions.append(chat);
  detailActions.append(remove);
  confirmation.append(cancelDelete, confirmDelete);
  footer.append(retrySave);

  const ideas = new Map<string, Idea>();
  const changes = new Map<string, Idea | null>();
  const pendingRemote = new Set<string>();
  let selected: string | null = null;
  let loading: Promise<void> | null = null;
  let ready = false;
  let loadError = '';
  let saveError = '';
  let notice = '';
  let bufferedChanges: IdeaChange[] = [];
  let deferredLinks: IdeaLink[] = [];
  let generation = 0;
  let readOnly = false;
  let previewing = false;
  let cleanupPreview: (() => void) | undefined;
  let confirming = false;
  let dropRow: HTMLElement | null = null;
  let firstListed: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | null = null;
  let lastPending = false;

  const current = () => (selected ? ideas.get(selected) : undefined);
  const isPending = () => Boolean(writing || changes.size || deferredLinks.length);

  function reportPending() {
    const pending = isPending();
    if (pending === lastPending) return;
    lastPending = pending;
    options.onPendingChange?.();
  }

  function renderStatus() {
    const label =
      saveError || notice || (isPending() ? 'Saving…' : current() ? 'Saved locally' : '');
    footer.hidden = !label;
    status.classList.toggle('idea-error', Boolean(saveError));
    if (status.textContent !== label) status.textContent = label;
    retrySave.hidden = !saveError;
    retrySave.disabled = readOnly;
  }

  function renderList() {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const matching = [...ideas.values()]
      .filter(idea => {
        if (!terms.length) return true;
        const text =
          `${idea.title}\n${idea.body}\n${idea.links.map(link => link.path).join('\n')}`.toLocaleLowerCase();
        return terms.every(term => text.includes(term));
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
    firstListed = matching[0]?.id;
    const rows = document.createDocumentFragment();
    for (const idea of matching) {
      const row = node('button', 'idea-row');
      row.type = 'button';
      row.dataset.ideaId = idea.id;
      row.setAttribute('aria-pressed', String(idea.id === selected));
      const summary = bodySummary(idea.body);
      const label = idea.title.trim() || summary || 'Untitled idea';
      const description = summary || (idea.links[0] && filename(idea.links[0].path));
      row.append(node('span', 'idea-row-title', label));
      if (description && description !== label)
        row.append(node('span', 'idea-row-summary', description));
      if (idea.links.length) {
        const count = node('span', 'idea-row-count');
        count.innerHTML = icon('link');
        count.append(String(idea.links.length));
        count.setAttribute(
          'aria-label',
          `${idea.links.length} attached ${idea.links.length === 1 ? 'file' : 'files'}`,
        );
        row.append(count);
      }
      rows.append(row);
    }
    if (!matching.length && terms.length)
      rows.append(node('p', 'idea-no-results', 'No matching ideas'));
    list.hidden = !ready || (!matching.length && !terms.length);
    const focus = list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.ideaId
      : null;
    list.replaceChildren(rows);
    if (focus) {
      const row = [...list.querySelectorAll('button')].find(row => row.dataset.ideaId === focus);
      row?.focus({ preventScroll: true });
    }

    const idea = current();
    empty.hidden = Boolean(idea);
    emptyTitle.toggleAttribute('data-loading-status', Boolean(loading) && !ready);
    if (!ready) {
      emptyTitle.textContent = loadError ? 'Ideas unavailable' : 'Loading ideas…';
      emptyDetail.textContent = loadError;
    } else {
      emptyTitle.textContent = ideas.size ? 'Select an idea' : 'Capture an idea';
      emptyDetail.textContent = 'Drop a file here to link it to an idea.';
    }
    retryLoad.hidden = !loadError;
    addFirst.hidden = !ready || Boolean(ideas.size);
    add.disabled = addFirst.disabled = !ready || readOnly;
    search.disabled = !ready;
  }

  function refreshContext() {
    const idea = current();
    attachCurrent.disabled =
      readOnly ||
      !idea ||
      idea.links.length >= MAX_IDEA_LINKS ||
      !(options.hasCurrentLink ? options.hasCurrentLink() : options.getCurrentLink());
  }

  function renderLinks(idea: Idea) {
    const rows = document.createDocumentFragment();
    for (const [index, link] of idea.links.entries()) {
      const chip = node('div', 'idea-attachment');
      const label = linkLabel(link, filename(link.path));
      const open = button(label, 'file', true);
      open.title = linkLabel(link);
      open.addEventListener(
        'click',
        () =>
          void Promise.resolve()
            .then(() => options.openLink(link))
            .catch(showActionError),
      );
      const unlink = button(`Remove ${label}`, 'close');
      unlink.disabled = readOnly;
      unlink.addEventListener('click', () => {
        if (readOnly || current()?.id !== idea.id) return;
        const next = current()!.links.filter((_, offset) => offset !== index);
        edit({ links: next });
        renderLinks(current()!);
        (
          attachments.querySelectorAll<HTMLButtonElement>('button[aria-label]')[
            Math.min(index, next.length - 1)
          ] ?? attachCurrent
        ).focus();
      });
      chip.append(open, unlink);
      rows.append(chip);
    }
    attachments.replaceChildren(rows);
    attachments.hidden = !idea.links.length;
    refreshContext();
  }

  function renderPreview() {
    cleanupPreview?.();
    cleanupPreview = undefined;
    preview.hidden = !previewing;
    body.hidden = previewing;
    toolbar.hidden = previewing;
    previewLabel.textContent = previewing ? 'Edit Markdown' : 'Preview';
    previewToggle.setAttribute('aria-label', previewLabel.textContent);
    previewToggle.title = previewing ? 'Edit Markdown' : 'Preview Markdown';
    previewToggle.setAttribute('aria-pressed', String(previewing));
    if (!previewing) return;
    if (!body.value.trim()) {
      preview.replaceChildren(node('p', 'idea-preview-empty', 'Markdown preview is empty.'));
      return;
    }
    cleanupPreview = showMarkdownPreview(preview, body.value, {
      filename: '',
      onOpenFile: target => {
        if (options.openMarkdownFile) options.openMarkdownFile(target);
        else
          void Promise.resolve()
            .then(() => options.openLink({ path: target.path }))
            .catch(showActionError);
      },
      openExternal: options.openExternal,
      media: options.media ?? (() => Promise.reject(new Error('Image unavailable'))),
      colorize: options.colorize ?? (() => Promise.reject(new Error('Highlighting unavailable'))),
    });
  }

  function renderDetail() {
    const idea = current();
    detail.hidden = !idea;
    host.dataset.ideaSelected = String(Boolean(idea));
    confirmation.hidden = !confirming;
    detailActions.hidden = confirming;
    if (!idea) {
      cleanupPreview?.();
      cleanupPreview = undefined;
      return;
    }
    if (title.value !== idea.title) title.value = idea.title;
    if (body.value !== idea.body) body.value = idea.body;
    title.readOnly = body.readOnly = readOnly;
    for (const control of toolbar.querySelectorAll('button')) control.disabled = readOnly;
    remove.disabled = confirmDelete.disabled = chat.disabled = readOnly;
    renderLinks(idea);
    renderPreview();
  }

  function selectIdea(id: string | null) {
    if (selected !== id) {
      if (changes.size && !saveError) void flush().catch(() => {});
      previewing = false;
      body.scrollTop = 0;
    }
    selected = id;
    confirming = false;
    notice = '';
    renderList();
    renderDetail();
    renderStatus();
  }

  function update(idea: Idea, refreshList = true) {
    ideas.set(idea.id, idea);
    queueChange(idea.id, idea);
    if (refreshList) renderList();
  }

  function edit(patch: Partial<Pick<Idea, 'title' | 'body' | 'links'>>) {
    const idea = current();
    if (!idea || readOnly) return;
    updateIdea(idea, patch);
  }

  function updateIdea(idea: Idea, patch: Partial<Pick<Idea, 'title' | 'body' | 'links'>>) {
    notice = '';
    const refreshList =
      idea.id !== firstListed ||
      Boolean(search.value.trim()) ||
      patch.title !== undefined ||
      patch.links !== undefined ||
      (patch.body !== undefined && bodySummary(patch.body) !== bodySummary(idea.body));
    update({ ...idea, ...patch, updatedAt: Math.max(Date.now(), idea.updatedAt + 1) }, refreshList);
  }

  function newIdea(link?: IdeaLink) {
    if (!ready) return;
    const now = Date.now();
    const id = crypto.randomUUID();
    const idea = {
      id,
      title: link ? filename(link.path).slice(0, MAX_IDEA_TITLE_LENGTH) : '',
      body: '',
      links: link ? [link] : [],
      createdAt: now,
      updatedAt: now,
    };
    search.value = '';
    if (changes.size && !saveError) void flush().catch(() => {});
    selected = id;
    confirming = previewing = false;
    notice = '';
    update(idea);
    renderDetail();
    body.scrollTop = 0;
    title.focus();
    if (link) title.select();
  }

  function attach(link: IdeaLink) {
    if (!link.path || readOnly) return;
    if (!ready) {
      deferredLinks.push(link);
      reportPending();
      void load();
      return;
    }
    applyLink(link);
  }

  function applyLink(link: IdeaLink) {
    const idea = current();
    if (!idea) {
      newIdea(link);
      return;
    }
    const existing = idea.links.findIndex(candidate => matchesLink(candidate, link));
    if (existing >= 0) {
      if (
        idea.links[existing].excerpt !== link.excerpt ||
        idea.links[existing].truncated !== link.truncated
      ) {
        const links = idea.links.slice();
        links[existing] = link;
        updateIdea(idea, { links });
      }
    } else if (idea.links.length >= MAX_IDEA_LINKS) {
      notice = `This idea already has ${MAX_IDEA_LINKS} links.`;
      renderStatus();
      return;
    } else updateIdea(idea, { links: [...idea.links, link] });
    renderLinks(current()!);
  }

  function queueChange(id: string, idea: Idea | null) {
    changes.set(id, idea);
    if (!saveError && !writing) {
      clearTimeout(timer);
      timer = setTimeout(() => void flush().catch(() => {}), 250);
    }
    renderStatus();
    reportPending();
  }

  async function flush() {
    clearTimeout(timer);
    if (deferredLinks.length) {
      await load();
      if (!ready) throw new Error(loadError || 'Couldn’t load ideas.');
    }
    if (writing) return writing;
    if (!changes.size) return;
    const version = generation;
    saveError = '';
    writing = Promise.resolve().then(async () => {
      try {
        while (generation === version && changes.size) {
          const [id, change] = changes.entries().next().value!;
          if (change) await options.save(change);
          else await options.remove(id);
          if (generation === version && changes.get(id) === change) changes.delete(id);
        }
      } catch (error) {
        if (generation === version) {
          saveError = `Couldn’t save ideas. ${errorMessage(error)}`;
          throw error;
        }
      } finally {
        if (generation === version) {
          writing = null;
          renderStatus();
          reportPending();
          if (pendingRemote.size && !changes.size) void reconcileRemote(version);
        }
      }
    });
    renderStatus();
    reportPending();
    return writing;
  }

  function applyChange(change: IdeaChange) {
    if (!ready) {
      bufferedChanges.push(change);
      return;
    }
    const id = change.type === 'upsert' ? change.idea.id : change.id;
    if (changes.has(id)) {
      pendingRemote.add(id);
      return;
    }
    // A later event supersedes any re-read in flight for the same idea.
    pendingRemote.delete(id);
    if (change.type === 'upsert') ideas.set(id, change.idea);
    else ideas.delete(id);
    if (id === selected && change.type === 'delete') selectIdea(null);
    else {
      renderList();
      if (id === selected) renderDetail();
    }
  }

  async function reconcileRemote(version: number) {
    try {
      const stored = await options.load();
      if (generation !== version || changes.size) return;
      const byId = new Map(stored.map(idea => [idea.id, idea]));
      for (const id of pendingRemote) {
        const idea = byId.get(id);
        const existing = ideas.get(id);
        if (JSON.stringify(idea) === JSON.stringify(existing)) pendingRemote.delete(id);
        else applyChange(idea ? { type: 'upsert', idea } : { type: 'delete', id });
      }
    } catch {
      // The database retains the authoritative version and a later sync can re-read it.
    }
  }

  async function load() {
    if (ready) return;
    if (loading) return loading;
    const version = generation;
    loadError = '';
    loading = Promise.resolve().then(async () => {
      try {
        const stored = await options.load();
        if (generation !== version) return;
        for (const idea of stored) ideas.set(idea.id, idea);
        ready = true;
        for (const change of bufferedChanges.splice(0)) applyChange(change);
        for (const link of deferredLinks.splice(0)) applyLink(link);
      } catch (error) {
        if (generation === version) loadError = errorMessage(error);
      } finally {
        if (generation === version) {
          loading = null;
          renderList();
          renderDetail();
          renderStatus();
          reportPending();
        }
      }
    });
    renderList();
    return loading;
  }

  function reset() {
    generation++;
    clearTimeout(timer);
    ideas.clear();
    changes.clear();
    pendingRemote.clear();
    bufferedChanges = [];
    deferredLinks = [];
    loading = writing = null;
    loadError = saveError = '';
    ready = previewing = false;
    search.value = title.value = body.value = '';
    selectIdea(null);
    reportPending();
  }

  function showActionError(error: unknown) {
    notify(errorMessage(error));
  }

  function notify(message: string) {
    notice = message;
    renderStatus();
  }

  function replaceMarkdown({ from, to, text, selection }: Replacement) {
    if (from === to && !text) return;
    if (body.value.length - (to - from) + text.length > MAX_IDEA_BODY_LENGTH) {
      notify('This idea has reached the Markdown length limit.');
      return;
    }
    body.focus();
    body.setSelectionRange(from, to);
    // Chromium records insertText in the textarea's native undo history.
    const applied = text
      ? document.execCommand('insertText', false, text)
      : document.execCommand('delete');
    if (!applied) {
      body.setRangeText(text, from, to, 'end');
      edit({ body: body.value });
    }
    if (selection) body.setSelectionRange(from + selection[0], from + selection[1]);
  }

  function applyFormat(format: Format) {
    if (readOnly) return;
    replaceMarkdown(
      formatIdeaSelection(body.value, body.selectionStart, body.selectionEnd, format),
    );
  }

  const isMac = navigator.platform.startsWith('Mac');
  for (const [format, label] of formats) {
    const control = button(label, format);
    if (format === 'bold' || format === 'italic') {
      const key = formattingShortcuts[format].toUpperCase();
      control.setAttribute('aria-keyshortcuts', `Meta+${key} Control+${key}`);
      control.title = `${label} · ${isMac ? '⌘' : 'Ctrl+'}${key}`;
    }
    control.addEventListener('mousedown', event => event.preventDefault());
    control.addEventListener('click', () => applyFormat(format));
    toolbar.append(control);
  }

  add.addEventListener('click', () => newIdea());
  addFirst.addEventListener('click', () => newIdea());
  close.addEventListener('click', () => options.onClose?.());
  retryLoad.addEventListener('click', () => void load());
  retrySave.addEventListener('click', () => void flush().catch(() => {}));
  search.addEventListener('input', renderList);
  list.addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-idea-id]');
    if (row?.dataset.ideaId) selectIdea(row.dataset.ideaId);
  });
  title.addEventListener('input', () => edit({ title: title.value }));
  title.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (previewing) previewToggle.click();
      body.focus();
    }
  });
  body.addEventListener('input', () => edit({ body: body.value }));
  body.addEventListener('keydown', event => {
    if (event.isComposing || readOnly) return;
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      const format =
        key === formattingShortcuts.bold
          ? 'bold'
          : key === formattingShortcuts.italic
            ? 'italic'
            : null;
      if (format) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) applyFormat(format);
        return;
      }
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      body.selectionStart === body.selectionEnd
    ) {
      const item = nextIdeaListItem(body.value, body.selectionStart);
      if (item) {
        event.preventDefault();
        replaceMarkdown(item);
      }
    }
  });
  previewToggle.addEventListener('click', () => {
    previewing = !previewing;
    renderPreview();
    if (!previewing) body.focus();
  });
  attachCurrent.addEventListener('click', () => {
    const link = options.getCurrentLink();
    if (link) attach(link);
  });
  chat.addEventListener('click', () => {
    const idea = current();
    if (idea)
      void Promise.resolve()
        .then(() => options.draftInChat?.(idea))
        .catch(showActionError);
  });
  remove.addEventListener('click', () => {
    confirming = true;
    confirmation.hidden = false;
    detailActions.hidden = true;
    cancelDelete.focus();
  });
  cancelDelete.addEventListener('click', () => {
    confirming = false;
    confirmation.hidden = true;
    detailActions.hidden = false;
    remove.focus();
  });
  confirmDelete.addEventListener('click', () => {
    const idea = current();
    if (!idea || readOnly) return;
    ideas.delete(idea.id);
    queueChange(idea.id, null);
    selectIdea(null);
    (list.querySelector('button') ?? add).focus();
  });

  function clearDrop() {
    delete host.dataset.fileDrop;
    dropRow?.removeAttribute('data-file-drop');
    dropRow = null;
  }

  host.addEventListener('dragover', event => {
    if (readOnly || !event.dataTransfer?.types.includes(IDEA_FILE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'link';
    host.dataset.fileDrop = 'true';
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-idea-id]');
    if (row !== dropRow) {
      dropRow?.removeAttribute('data-file-drop');
      dropRow = row;
      if (row) row.dataset.fileDrop = 'true';
    }
  });
  host.addEventListener('dragleave', event => {
    if (!host.contains(event.relatedTarget as Node | null)) clearDrop();
  });
  host.addEventListener('drop', event => {
    clearDrop();
    const payload = event.dataTransfer?.getData(IDEA_FILE_DRAG_TYPE);
    if (!payload) return;
    event.preventDefault();
    const workspace = options.getWorkspace();
    if (!workspace || readOnly) return;
    const path = draggedFile(payload, workspace);
    if (!path) {
      notify('Drop a file from this workspace.');
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-idea-id]');
    if (row?.dataset.ideaId) selectIdea(row.dataset.ideaId);
    attach({ path });
  });

  renderList();
  return {
    load,
    reset,
    attach,
    refreshContext,
    notify,
    applyChange,
    flush,
    focus: () => (current() ? title : ready ? search : close).focus(),
    setReadOnly(value: boolean) {
      readOnly = value;
      renderList();
      renderDetail();
      renderStatus();
    },
    get pending() {
      return isPending();
    },
  };
}

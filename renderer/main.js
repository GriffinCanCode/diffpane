import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import { configureSyntax } from './syntax.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import './style.css';
import { createFilePicker } from './files.js';
import { projectIcon } from './icons.js';
import { createNavigator } from './navigator.js';
import { createLanguageFeatures } from './languages.js';
import './navigator.css';

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const theme = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '808080', fontStyle: 'italic' },
    { token: 'keyword', foreground: '80CBC4' },
    { token: 'string', foreground: 'D994D3' },
    { token: 'string.key.json', foreground: 'CCCCCC' },
    { token: 'number', foreground: 'C4A7E7' },
    { token: 'type.identifier', foreground: 'EFAB74' },
    ...['class', 'struct', 'interface', 'type', 'typeParameter'].map(token => ({ token, foreground: 'EFAB74' })),
    ...['function', 'method', 'macro', 'member'].map(token => ({ token, foreground: 'EFAB74' })),
    ...['variable', 'parameter', 'property'].map(token => ({ token, foreground: 'CCCCCC' })),
    ...['enumMember', 'variable.readonly', 'property.readonly'].map(token => ({ token, foreground: 'C4A7E7' })),
  ],
  colors: {
    'editor.background': '#181818',
    'editor.foreground': '#d4d4d4',
    'editorLineNumber.foreground': '#5c6068',
    'editorLineNumber.activeForeground': '#c6c9d0',
    'editorGutter.background': '#181818',
    'editor.selectionBackground': '#35415c',
    'editor.inactiveSelectionBackground': '#303844',
    'editor.lineHighlightBackground': '#ffffff04',
    'editorCursor.foreground': '#b8c3d7',
    'editorIndentGuide.background1': '#ffffff0c',
    'editorIndentGuide.activeBackground1': '#ffffff20',
    'editorOverviewRuler.border': '#00000000',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff24',
    'scrollbarSlider.activeBackground': '#ffffff30',
    'editorWidget.background': '#22242a',
    'editorWidget.border': '#383b43',
    'editor.findMatchBackground': '#7e622b',
    'editor.findMatchHighlightBackground': '#7e622b70',
    'focusBorder': '#748aaf',
  },
};
monaco.editor.defineTheme('diffpane', theme);
const syntax = configureSyntax(monaco, theme);

const icons = {
  mark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5h6v14H5z" fill="currentColor" opacity=".45"/><path d="M13 5h6v14h-6z" fill="currentColor"/><path d="M7 9h2m-1-1v2m7 5h2" stroke="#111512" stroke-width="1.4" stroke-linecap="round"/></svg>',
  branch: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3" r="1.7" stroke="currentColor"/><circle cx="4" cy="13" r="1.7" stroke="currentColor"/><circle cx="12" cy="3" r="1.7" stroke="currentColor"/><path d="M4 5v6m8-6v1a4 4 0 0 1-4 4H4" stroke="currentColor" stroke-width="1.2"/></svg>',
  search: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="7.8" cy="7.8" r="4.6" stroke="currentColor" stroke-width="1.4"/><path d="m11.3 11.3 3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M14.6 7a5.6 5.6 0 1 0-.5 5.1M14.6 7V3.7M14.6 7h-3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2.5 5a1 1 0 0 1 1-1h3.2l1.6 1.7h6.2a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5Z" stroke="currentColor" stroke-width="1.3"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10m-4-4 4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.3l-3.5-3.5Z" stroke="currentColor" stroke-width="1.15"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.15"/></svg>',
};

const app = document.querySelector('#app') ?? document.body.appendChild(document.createElement('div'));
app.innerHTML = `
  <header class="titlebar">
    <div class="brand"><span class="brand-mark">${icons.mark}</span><span>diffpane</span></div>
    <span class="title-divider"></span>
    <div class="project"><span id="project-name">Opening project</span><span id="project-path"></span></div>
    <div class="titlebar-end"><span class="branch">${icons.branch}<span id="branch-name">…</span></span><span class="live-status" id="live-status"><i></i>Live</span></div>
  </header>
  <div class="workspace" id="workspace">
    <aside id="navigator"></aside>
    <div id="navigator-resize" role="separator" aria-label="Explorer width" aria-orientation="vertical" tabindex="0"></div>
    <section class="workbench">
  <div class="toolbar">
    <div class="review-title"><button class="icon-button" id="toggle-navigator" title="Toggle explorer · ⌘B" aria-label="Toggle explorer" aria-expanded="true"><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M7 3v12" stroke="currentColor" stroke-width="1.2"/></svg></button><h1 id="review-heading">Working changes</h1><div class="view-switch" role="tablist" aria-label="View"><button id="view-changes" role="tab" aria-selected="true">Changes</button><button id="view-files" role="tab" aria-selected="false">Files</button></div><span class="file-count" id="file-count">…</span></div>
    <div class="toolbar-actions">
      <label class="filter">${icons.search}<input id="filter" type="search" placeholder="Filter files…" aria-label="Filter changed files" autocomplete="off" spellcheck="false"><kbd>⌘ K</kbd></label>
      <select id="comparison" aria-label="Compare changes"><option value="head">All changes</option><option value="unstaged">Unstaged</option><option value="staged">Staged</option></select>
      <button class="icon-button" id="refresh" title="Refresh · ⌘R" aria-label="Refresh changes">${icons.refresh}</button>
      <button class="open-button" id="open-file" title="Open file · ⌘P">${icons.file}<span>Open file</span></button>
      <button class="open-button" id="open-folder">${icons.folder}<span>Open folder</span></button>
    </div>
  </div>
  <div class="message" id="message" role="status" hidden></div>
  <main class="feed-scroll" id="feed-scroll"><div class="feed" id="feed"></div><div class="empty-state" id="empty-state"><span class="empty-symbol">${icons.mark}</span><h2>Reading your working tree</h2><p>Your changes will appear here.</p></div></main>
  </section></div>
  <footer class="statusbar"><span id="status-text">Connecting to Git…</span><span class="statusbar-end"><span class="current-only">Current file contents</span><span class="status-dot"></span><span>Read only</span></span></footer>
`;

const ui = Object.fromEntries(['workspace', 'navigator', 'navigator-resize', 'toggle-navigator', 'review-heading', 'view-changes', 'view-files', 'open-file', 'project-name', 'project-path', 'branch-name', 'live-status', 'file-count', 'filter', 'comparison', 'refresh', 'open-folder', 'message', 'feed-scroll', 'feed', 'empty-state', 'status-text'].map(id => [id.replaceAll('-', '_'), document.getElementById(id)]));
const api = window.diffpane;
const cards = new Map();
const nearby = new Set();
const MAX_EDITORS = 3;
const LINE_HEIGHT = 22;
const MAX_EDITOR_HEIGHT = 650;
let snapshot = null;
let comparison = 'head';
let view = 'changes';
let openedFile = null;
let filter = '';
let scheduled = false;
let applying = false;
let closed = false;
app.dataset.view = view;
const navigator = createNavigator(ui.navigator, api, openFile, { iconFor: projectIcon, onPick: () => openFilePicker(), onFolder: () => api.openFolder(), onOutline: list => { const card = cards.get(openedFile?.path); if (card?.editor) void showSymbols(card, list); else list.textContent = 'Open a file to see its outline'; } });
const languageFeatures = createLanguageFeatures(monaco, api, { onState: updateLanguageState });
const languageWidgets = document.createElement('div');
languageWidgets.className = 'monaco-editor language-widgets';
document.body.append(languageWidgets);
const openFilePicker = createFilePicker(api, openFile);

function openFile(file) {
  if (view === 'files' && openedFile?.path === file.path) { navigator.select(file.path); return; }
  openedFile = file;
  setView('files');
  navigator.select(file.path);
}

function updateLanguageState(state) {
  const card = cards.get(state.path);
  if (!card) return;
  card.languageState = state;
  card.language.textContent = monaco.languages.getLanguages().find(language => language.id === card.model?.getLanguageId())?.aliases?.[0] ?? state.language;
  const ready = state.status === 'ready';
  const badge = card.element.querySelector('.language-state');
  badge.textContent = ready ? 'Language ready' : state.status === 'starting' ? 'Loading language…' : 'Syntax';
  badge.dataset.status = state.status;
  badge.title = state.message || (ready ? 'Semantic features available for this language server' : 'Language services load when this file is used');
  if (state.diagnostics != null) badge.textContent += state.diagnostics ? ` · ${state.diagnostics} ${state.diagnostics === 1 ? 'issue' : 'issues'}` : '';
}

async function showSymbols(card, list = card.element.querySelector('.symbol-list')) {
  const generation = card.generation;
  list.replaceChildren(documentNode('span', 'symbol-empty', 'Loading symbols…'));
  try {
    const symbols = await languageFeatures.symbols(card.file.path);
    if (!card.editor || generation !== card.generation) return;
    const nodes = [];
    const append = (items, depth = 0) => {
      for (const symbol of items) {
        const button = documentNode('button', 'symbol-item', symbol.name);
        button.type = 'button';
        button.style.paddingLeft = `${12 + depth * 12}px`;
        button.title = symbol.detail || symbol.name;
        button.addEventListener('click', () => {
          card.editor.revealLineInCenter(symbol.selectionRange.startLineNumber);
          card.editor.setPosition({ lineNumber: symbol.selectionRange.startLineNumber, column: symbol.selectionRange.startColumn });
          card.editor.focus();
          card.element.querySelector('.symbol-outline').open = false;
        });
        nodes.push(button);
        append(symbol.children ?? [], depth + 1);
      }
    };
    append(symbols);
    list.replaceChildren(...(nodes.length ? nodes : [documentNode('span', 'symbol-empty', 'No symbols available')]));
  } catch (error) { list.replaceChildren(documentNode('span', 'symbol-empty', error.message || 'Symbols unavailable')); }
}

function toggleNavigator() {
  navigator.toggle();
  ui.workspace.classList.toggle('navigator-hidden', ui.navigator.hidden);
  ui.toggle_navigator.setAttribute('aria-expanded', String(!ui.navigator.hidden));
}
ui.toggle_navigator.addEventListener('click', toggleNavigator);
let resizing = false;
const resizeNavigator = width => {
  const limit = Math.min(440, ui.workspace.clientWidth - 360);
  const next = Math.max(180, Math.min(limit, width));
  ui.workspace.style.setProperty('--navigator-width', `${next}px`);
  ui.navigator_resize.setAttribute('aria-valuenow', String(Math.round(next)));
};
ui.navigator_resize.addEventListener('pointerdown', event => {
  resizing = true;
  ui.navigator_resize.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-navigator');
});
ui.navigator_resize.addEventListener('pointermove', event => {
  if (resizing) resizeNavigator(event.clientX - ui.workspace.getBoundingClientRect().left);
});
const stopResizing = () => { resizing = false; document.body.classList.remove('resizing-navigator'); };
ui.navigator_resize.addEventListener('pointerup', stopResizing);
ui.navigator_resize.addEventListener('lostpointercapture', stopResizing);
ui.navigator_resize.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  resizeNavigator(ui.navigator.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -16 : 16));
});

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const card = cards.get(entry.target.dataset.path);
    if (!card) continue;
    if (entry.isIntersecting) nearby.add(card);
    else nearby.delete(card);
  }
  scheduleEditors();
}, { root: ui.feed_scroll, rootMargin: '450px 0px', threshold: 0 });

function scheduleEditors() {
  if (scheduled || closed) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const viewport = ui.feed_scroll.getBoundingClientRect();
    const center = (viewport.top + viewport.bottom) / 2;
    const closest = [...nearby].filter(card => !card.element.hidden && card.element.isConnected)
      .map(card => {
        const rect = card.element.getBoundingClientRect();
        const visible = rect.bottom > viewport.top && rect.top < viewport.bottom;
        return { card, visible, distance: visible ? Math.abs((rect.top + rect.bottom) / 2 - center) : Math.abs((rect.top + rect.bottom) / 2 - center) + viewport.height };
      }).sort((a, b) => a.distance - b.distance).filter((value, index) => value.visible || index < MAX_EDITORS).map(value => value.card);
    const wanted = new Set(closest);
    for (const card of cards.values()) if (card.active && !wanted.has(card)) deactivate(card);
    for (const card of closest) {
      card.active = true;
      if (!card.editor || card.dirty) loadDocument(card);
    }
  });
}

function createCard(file) {
  const element = document.createElement('section');
  element.className = 'file-card';
  element.dataset.path = file.path;
  element.innerHTML = `<div class="file-header"><span class="file-icon">${icons.file}</span><div class="file-path"><span class="file-directory"></span><strong class="file-name"></strong></div><span class="file-status"></span><span class="file-stats"></span><details class="symbol-outline"><summary title="Document symbols">Symbols</summary><div class="symbol-list"></div></details><button class="change-button" title="Next change" aria-label="Next change in file">${icons.down}</button></div><div class="file-note" hidden></div><div class="editor-host"><div class="editor-placeholder"><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span></div></div><div class="file-footer"><span class="line-count">Loads as you scroll</span><span class="language-meta"><span class="language-state">Syntax</span><span class="file-language"></span></span></div>`;
  const card = {
    file, element, host: element.querySelector('.editor-host'), status: element.querySelector('.file-status'),
    stats: element.querySelector('.file-stats'), note: element.querySelector('.file-note'),
    lines: element.querySelector('.line-count'), language: element.querySelector('.file-language'),
    languageCleanup: null, languageState: null, editor: null, model: null, decorationCollection: null, viewState: null,
    dirty: true, active: false, loading: false, generation: 0, changes: [], changeIndex: -1, textBytes: 0,
  };
  const slash = file.path.lastIndexOf('/');
  element.querySelector('.file-directory').textContent = file.path.slice(0, slash + 1);
  element.querySelector('.file-name').textContent = file.path.slice(slash + 1);
  element.querySelector('.file-path').title = file.path;
  element.querySelector('.change-button').addEventListener('click', () => {
    if (!card.editor || card.changes.length === 0) return;
    card.changeIndex = (card.changeIndex + 1) % card.changes.length;
    card.editor.revealLineInCenter(card.changes[card.changeIndex], monaco.editor.ScrollType.Smooth);
  });
  element.querySelector('.symbol-outline').addEventListener('toggle', event => { if (event.currentTarget.open) void showSymbols(card); });
  const fileIcon = document.createElement('img');
  fileIcon.src = projectIcon({ kind: 'file', name: file.path.slice(slash + 1) });
  fileIcon.alt = '';
  element.querySelector('.file-icon').replaceChildren(fileIcon);
  updateHeader(card);
  observer.observe(element);
  return card;
}

function updateHeader(card) {
  const { file } = card;
  const status = view === 'changes' && comparison === 'staged' ? file.index : file.worktree === ' ' || file.worktree === '.' ? file.index : file.worktree;
  const label = file.conflicted ? 'Conflict' : ({ '?': 'New', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', M: 'Modified' })[status] ?? 'Unchanged';
  card.status.textContent = label;
  card.status.dataset.kind = file.conflicted ? 'conflict' : label.toLowerCase();
  card.element.dataset.status = label.toLowerCase();
}

function matchesComparison(file) {
  if (view === 'files') return true;
  if (comparison === 'staged') return file.index && ![' ', '.', '?'].includes(file.index);
  if (comparison === 'unstaged') return file.worktree && ![' ', '.'].includes(file.worktree);
  return true;
}

function preserveAnchor(action) {
  const top = ui.feed_scroll.getBoundingClientRect().top;
  const anchor = [...cards.values()].find(card => !card.element.hidden && card.element.getBoundingClientRect().bottom > top + 4);
  const offset = anchor?.element.getBoundingClientRect().top;
  action();
  if (anchor?.element.isConnected && !anchor.element.hidden) {
    ui.feed_scroll.scrollTop += anchor.element.getBoundingClientRect().top - offset;
  }
}

function applySnapshot(next) {
  if (closed || !next) return;
  if (next.error) { showError(next.error); return; }
  if (snapshot && Number.isFinite(next.revision) && next.revision < snapshot.revision) return;
  const changed = next.changedPaths ? new Set(next.changedPaths) : null;
  const allDirty = !changed || changed.has('*') || next.root !== snapshot?.root;
  if (!snapshot && next.initialPath) {
    openedFile = { path: next.initialPath, submodule: false };
    view = 'files';
  }
  snapshot = next;
  navigator.update(next);
  if (openedFile && view === 'files' && navigator.stats().selectedPath !== openedFile.path) navigator.select(openedFile.path);
  app.dataset.view = view;
  ui.review_heading.textContent = view === 'files' ? 'File viewer' : 'Working changes';
  ui.view_changes.setAttribute('aria-selected', String(view === 'changes'));
  ui.view_files.setAttribute('aria-selected', String(view === 'files'));
  const source = view === 'files' && openedFile ? [next.files.find(file => file.path === openedFile.path) ?? { path: openedFile.path, originalPath: null, index: ' ', worktree: ' ', conflicted: false, submodule: openedFile.submodule }] : next.files;
  ui.project_name.textContent = next.scope?.split('/').filter(Boolean).pop() || next.root?.split('/').filter(Boolean).pop() || 'Working tree';
  ui.project_path.textContent = next.scope || next.root || '';
  ui.project_path.title = next.scope || next.root || '';
  ui.branch_name.textContent = next.branch || 'HEAD';
  document.title = `${ui.project_name.textContent} · diffpane`;
  if (next.watchError) showError(next.watchError);
  else clearError();
  applying = true;
  preserveAnchor(() => {
    const paths = new Set(source.map(file => file.path));
    for (const [path, card] of cards) {
      if (!paths.has(path)) {
        deactivate(card);
        observer.unobserve(card.element);
        nearby.delete(card);
        card.element.remove();
        cards.delete(path);
      }
    }
    let previous = null;
    for (const file of source) {
      let card = cards.get(file.path);
      if (!card) {
        card = createCard(file);
        cards.set(file.path, card);
      } else {
        card.file = file;
        updateHeader(card);
        if (allDirty || changed.has(file.path)) card.dirty = true;
      }
      const expected = previous ? previous.nextElementSibling : ui.feed.firstElementChild;
      if (expected !== card.element) ui.feed.insertBefore(card.element, expected);
      previous = card.element;
    }
    applyFilter();
  });
  applying = false;
  ui.status_text.textContent = `${next.files.length.toLocaleString()} changed ${next.files.length === 1 ? 'file' : 'files'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  scheduleEditors();
}

function applyFilter() {
  let visible = 0;
  for (const card of cards.values()) {
    const show = view === 'files' || (matchesComparison(card.file) && card.file.path.toLocaleLowerCase().includes(filter));
    card.element.hidden = !show;
    if (show) visible++;
    else if (card.active) deactivate(card);
  }
  const total = view === 'files' ? cards.size : snapshot?.files.filter(matchesComparison).length ?? 0;
  ui.file_count.textContent = view === 'changes' && filter ? `${visible} / ${total}` : String(total);
  ui.empty_state.hidden = visible > 0;
  if (visible === 0) {
    ui.empty_state.querySelector('h2').textContent = filter ? 'No matching files' : total === 0 && comparison === 'head' ? 'Your working tree is clear' : 'No changes in this view';
    ui.empty_state.querySelector('p').textContent = filter ? 'Try a different filename or path.' : 'New changes appear automatically as you work.';
  }
  if (!applying) scheduleEditors();
}

async function loadDocument(card) {
  if (card.loading || !card.active || closed) return;
  card.loading = true;
  card.dirty = false;
  const generation = card.generation;
  const requestedView = view;
  const requestedComparison = view === 'files' ? 'head' : comparison;
  card.element.classList.add('is-loading');
  try {
    const document = await api.document(card.file.path, requestedComparison);
    if (!card.active || generation !== card.generation || requestedView !== view || requestedComparison !== (view === 'files' ? 'head' : comparison) || !cards.has(card.file.path)) return;
    if (document.error) throw new Error(document.error);
    if (document.revision < (snapshot?.revision ?? 0) && card.dirty) return;
    renderDocument(card, document);
  } catch (error) {
    if (card.active && generation === card.generation) {
      card.note.textContent = error.message || String(error);
      card.note.hidden = false;
      card.note.classList.add('is-error');
      card.host.classList.add('has-error');
    }
  } finally {
    card.loading = false;
    card.element.classList.remove('is-loading');
    if (card.active && card.dirty) queueMicrotask(() => loadDocument(card));
  }
}

function renderDocument(card, document) {
  const text = document.after ?? '';
  const state = card.editor?.saveViewState();
  const lineCount = Math.max(1, text.split('\n').length);
  const height = Math.min(MAX_EDITOR_HEIGHT, Math.max(128, lineCount * LINE_HEIGHT + 28));
  preserveAnchor(() => { card.host.style.height = `${height}px`; });
  card.note.textContent = document.note || document.diffNote || (!text && card.element.dataset.status === 'deleted' ? 'This file was deleted. There are no current contents.' : '');
  card.note.hidden = !card.note.textContent;
  card.note.classList.remove('is-error');
  card.host.classList.remove('has-error');
  if (!card.editor) {
    card.host.replaceChildren();
    const root = snapshot.root.replaceAll('\\', '/').replace(/\/$/, '');
    const uri = monaco.Uri.file(`${root}/${card.file.path}`);
    card.model = monaco.editor.createModel(text, undefined, uri);
    monaco.editor.setModelLanguage(card.model, syntax.resolve(card.model, text));
    card.model.detectIndentation(true, 2);
    card.editor = monaco.editor.create(card.host, {
      model: card.model, theme: 'diffpane', readOnly: true, domReadOnly: true,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 14, lineHeight: LINE_HEIGHT, fontLigatures: false,
      lineNumbers: 'on', lineNumbersMinChars: 4, glyphMargin: true, lineDecorationsWidth: 10,
      minimap: { enabled: false }, overviewRulerLanes: 1, overviewRulerBorder: false,
      scrollBeyondLastLine: false, smoothScrolling: true,
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, alwaysConsumeMouseWheel: false, useShadows: false },
      wordWrap: 'off', renderLineHighlight: 'none', renderWhitespace: 'selection',
      renderValidationDecorations: 'on', folding: true, stickyScroll: { enabled: false },
      guides: { indentation: true, bracketPairs: false }, bracketPairColorization: { enabled: false },
      matchBrackets: 'never', links: false, occurrencesHighlight: 'off', selectionHighlight: false,
      contextmenu: true, automaticLayout: true, padding: { top: 14, bottom: 14 },
      fixedOverflowWidgets: true, overflowWidgetsDomNode: languageWidgets,
      mouseWheelScrollSensitivity: 1, fastScrollSensitivity: 3,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      accessibilitySupport: 'auto', ariaLabel: `Current contents of ${card.file.path}`,
    });
    card.decorationCollection = card.editor.createDecorationsCollection();
    card.languageCleanup = languageFeatures.attach(card.editor, card.model, card.file.path, { active: view === 'files' });
    if (card.viewState) card.editor.restoreViewState(card.viewState);
  } else if (card.model.getValue() !== text) {
    const change = minimalChange(card.model.getValue(), text);
    const start = card.model.getPositionAt(change.start);
    const end = card.model.getPositionAt(change.end);
    card.model.applyEdits([{ range: monaco.Range.fromPositions(start, end), text: change.text }]);
    if (state) card.editor.restoreViewState(state);
  }
  card.textBytes = text.length * 2;
  const decorations = [];
  const changeLines = new Set();
  for (const change of document.decorations ?? []) {
    const start = Math.max(1, Math.min(card.model.getLineCount(), change.startLine));
    const end = Math.max(start, Math.min(card.model.getLineCount(), change.endLine ?? change.startLine));
    if (change.kind === 'word') {
      decorations.push({ range: new monaco.Range(start, change.startColumn, end, change.endColumn), options: { inlineClassName: 'diff-word-added', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } });
      continue;
    }
    changeLines.add(start);
    const deleted = change.kind === 'deleted';
    decorations.push({
      range: new monaco.Range(start, 1, end, card.model.getLineMaxColumn(end)),
      options: {
        isWholeLine: !deleted,
        className: deleted ? undefined : 'diff-line-added',
        linesDecorationsClassName: deleted ? 'diff-gutter-deleted' : 'diff-gutter-added',
        glyphMarginClassName: deleted ? 'diff-glyph-deleted' : undefined,
        glyphMarginHoverMessage: deleted ? { value: 'Lines deleted here' } : undefined,
        overviewRuler: { color: deleted ? '#e16b75' : '#66a77a', position: monaco.editor.OverviewRulerLane.Left },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
    for (const columns of change.columns ?? []) {
      const line = Math.max(start, Math.min(end, columns.line ?? columns.lineNumber ?? start));
      if (!Number.isFinite(columns.startColumn) || !Number.isFinite(columns.endColumn)) continue;
      decorations.push({
        range: new monaco.Range(line, columns.startColumn, line, columns.endColumn),
        options: { inlineClassName: 'diff-word-added', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      });
    }
  }
  card.decorationCollection.set(decorations);
  card.changes = [...changeLines].sort((a, b) => a - b);
  card.element.querySelector('.change-button').disabled = card.changes.length === 0;
  if (view === 'changes' && !card.viewState && !state && card.changes.length > 0) {
    card.editor.revealLineNearTop(Math.max(1, card.changes[0] - 3), monaco.editor.ScrollType.Immediate);
  }
  card.stats.replaceChildren();
  for (const [kind, value, sign] of [['added', document.additions, '+'], ['deleted', document.deletions, '−']]) {
    const span = documentNode('span', `stat-${kind}`, `${sign}${Number(value ?? 0).toLocaleString()}`);
    card.stats.appendChild(span);
  }
  card.lines.textContent = `${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'}`;
  const language = card.model.getLanguageId();
  card.language.textContent = monaco.languages.getLanguages().find(value => value.id === language)?.aliases?.[0] ?? language;
  card.editor.layout();
  if (card.element.querySelector('.symbol-outline').open) void showSymbols(card);
  const outline = ui.navigator.querySelector('.navigator-outline[open] .symbol-list');
  if (outline && view === 'files') void showSymbols(card, outline);
}

// A single replacement keeps Monaco's existing model, token state, and selection markers.
export function minimalChange(before, after) {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isLowSurrogate(before.charCodeAt(start))) start--;
  let end = before.length;
  let afterEnd = after.length;
  while (end > start && afterEnd > start && before.charCodeAt(end - 1) === after.charCodeAt(afterEnd - 1)) { end--; afterEnd--; }
  if (end < before.length && isLowSurrogate(before.charCodeAt(end))) { end++; afterEnd++; }
  return { start, end, text: after.slice(start, afterEnd) };
}

function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff; }

function documentNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function deactivate(card) {
  card.active = false;
  card.generation++;
  card.dirty = true;
  if (!card.editor) return;
  card.viewState = card.editor.saveViewState();
  card.languageCleanup?.();
  card.languageCleanup = null;
  card.element.querySelector('.symbol-outline').open = false;
  card.editor.dispose();
  card.model.dispose();
  card.editor = null;
  card.model = null;
  card.decorationCollection = null;
  card.textBytes = 0;
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''));
}

function showError(error) {
  ui.message.textContent = String(error);
  ui.message.hidden = false;
  ui.live_status.classList.add('is-degraded');
  ui.live_status.lastChild.textContent = 'Attention';
}

function clearError() {
  ui.message.hidden = true;
  ui.live_status.classList.remove('is-degraded');
  ui.live_status.lastChild.textContent = 'Live';
}

function setView(next) {
  const previous = view;
  view = next;
  for (const card of cards.values()) {
    deactivate(card);
    if (previous !== next) card.viewState = null;
  }
  ui.feed_scroll.scrollTop = 0;
  if (snapshot) applySnapshot({ ...snapshot, changedPaths: ['*'] });
}

ui.view_changes.addEventListener('click', () => setView('changes'));
ui.view_files.addEventListener('click', () => { if (openedFile) setView('files'); else void openFilePicker(); });
ui.open_file.addEventListener('click', () => { void openFilePicker(); });

ui.filter.addEventListener('input', () => {
  filter = ui.filter.value.toLocaleLowerCase();
  applyFilter();
});
ui.comparison.addEventListener('change', () => {
  comparison = ui.comparison.value;
  preserveAnchor(() => {
    for (const card of cards.values()) {
      card.generation++;
      card.dirty = true;
      card.viewState = null;
      updateHeader(card);
      card.stats.replaceChildren();
    }
    applyFilter();
  });
});
ui.feed_scroll.addEventListener('scroll', scheduleEditors, { passive: true });
ui.refresh.addEventListener('click', async () => {
  if (ui.refresh.disabled) return;
  ui.refresh.disabled = true;
  ui.refresh.classList.add('is-refreshing');
  try {
    const result = await api.refresh();
    if (result?.files) applySnapshot(result);
  } catch (error) { showError(error.message || error); }
  finally { ui.refresh.disabled = false; ui.refresh.classList.remove('is-refreshing'); }
});
ui.open_folder.addEventListener('click', async () => {
  try { await api.openFolder(); } catch (error) { showError(error.message || error); }
});
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === 'b') { event.preventDefault(); toggleNavigator(); }
  if (event.key.toLowerCase() === 'p') { event.preventDefault(); void openFilePicker(); }
  if (event.key.toLowerCase() === 'k' && view === 'files') { event.preventDefault(); void openFilePicker(); return; }
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); ui.filter.focus(); ui.filter.select(); }
  if (event.key.toLowerCase() === 'o') { event.preventDefault(); ui.open_folder.click(); }
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); ui.refresh.click(); }
});

window.__diffpane = {
  stats: () => ({ files: cards.size, activeEditors: [...cards.values()].filter(card => card.editor).length, models: monaco.editor.getModels().length, loadedTextBytes: [...cards.values()].reduce((total, card) => total + card.textBytes, 0), comparison, view, openedPath: openedFile?.path ?? null, openedLanguage: cards.get(openedFile?.path)?.model?.getLanguageId() ?? null, syntax: syntax.stats(), navigator: navigator.stats(), languages: languageFeatures.stats() }),
};

if (!api) showError('The desktop connection is unavailable. Reopen diffpane from your terminal.');
else {
  const unsubscribe = api.onChange(applySnapshot);
  const unsubscribeErrors = api.onError(showError);
  api.snapshot().then(applySnapshot).catch(error => showError(error.message || error));
  window.addEventListener('beforeunload', () => {
    closed = true;
    observer.disconnect();
    navigator.dispose();
    languageFeatures.dispose();
    if (typeof unsubscribe === 'function') unsubscribe();
    if (typeof unsubscribeErrors === 'function') unsubscribeErrors();
    for (const card of cards.values()) deactivate(card);
    languageWidgets.remove();
  }, { once: true });
}

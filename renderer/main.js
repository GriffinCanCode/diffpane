import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import { configureSyntax } from './syntax.ts';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import './style.css';
import { createFilePicker } from './files.ts';
import { projectIcon } from './icons.ts';
import { createNavigator } from './navigator.js';
import { createLanguageFeatures } from './languages.js';
import { createHowMany } from './howmany.js';
import { changedFunctionRanges } from './function-ranges.ts';
import { mediaType } from '../media-types.ts';
import { showDocumentPreview } from './document-preview.ts';
import { isMarkdown } from './markdown-paths.ts';
import { showMarkdownPreview } from './markdown-preview.ts';
import './document-preview.css';
import './navigator.css';
import { LivePathBatch, subscribeLivePaths } from './live-updates.ts';
import { Autosave } from './autosave.ts';
import { countLines } from '../text-lines.ts';

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
    ...['class', 'struct', 'interface', 'type', 'typeParameter'].map(token => ({
      token,
      foreground: 'EFAB74',
    })),
    ...['function', 'method', 'macro', 'member'].map(token => ({ token, foreground: 'EFAB74' })),
    ...['variable', 'parameter', 'property'].map(token => ({ token, foreground: 'CCCCCC' })),
    ...['enumMember', 'variable.readonly', 'property.readonly'].map(token => ({
      token,
      foreground: 'C4A7E7',
    })),
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
    'diffEditor.insertedTextBackground': '#00000000',
    'diffEditor.removedTextBackground': '#00000000',
    'diffEditor.insertedLineBackground': '#00000000',
    'diffEditor.removedLineBackground': '#00000000',
    'diffEditor.diagonalFill': '#00000000',
    'editorWidget.background': '#22242a',
    'editorWidget.border': '#383b43',
    'editor.findMatchBackground': '#7e622b',
    'editor.findMatchHighlightBackground': '#7e622b70',
    focusBorder: '#748aaf',
  },
};
monaco.editor.defineTheme('diffpane', theme);
const syntax = configureSyntax(monaco, theme);

const icons = {
  mark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3.5" fill="currentColor" opacity=".06"/><path d="M12 4v16" stroke="currentColor" opacity=".2"/><rect x="3" y="4" width="18" height="16" rx="3.5" stroke="currentColor" stroke-width="1.2" opacity=".5"/><path d="M6 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".55"/><path d="M15 15h3m-1.5-1.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  branch:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3" r="1.7" stroke="currentColor"/><circle cx="4" cy="13" r="1.7" stroke="currentColor"/><circle cx="12" cy="3" r="1.7" stroke="currentColor"/><path d="M4 5v6m8-6v1a4 4 0 0 1-4 4H4" stroke="currentColor" stroke-width="1.2"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10m-4-4 4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.3l-3.5-3.5Z" stroke="currentColor" stroke-width="1.15"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.15"/></svg>',
};

const app =
  document.querySelector('#app') ?? document.body.appendChild(document.createElement('div'));
app.innerHTML = `
  <header class="titlebar">
    <div class="brand" role="img" aria-label="diffpane"><span class="brand-mark">${icons.mark}</span></div>
    <span class="title-divider"></span>
    <div class="project"><span id="project-name">Opening project</span><span id="project-path"></span></div>
    <span class="branch">${icons.branch}<span id="branch-name">…</span></span>
  </header>
  <div class="workspace" id="workspace">
    <aside id="navigator"></aside>
    <div id="navigator-resize" role="separator" aria-label="Explorer width" aria-orientation="vertical" tabindex="0"></div>
    <section class="workbench">
  <div class="message" id="message" role="status" hidden></div>
  <main class="feed-scroll" id="feed-scroll"><div class="feed" id="feed"></div><div class="empty-state" id="empty-state"><span class="empty-symbol">${icons.mark}</span><h2>Open a file</h2><p>Select a file in the explorer, or press ⌘P.</p></div></main>
  </section></div>
  <footer class="statusbar"><span id="status-text">Connecting to Git…</span><span class="statusbar-end"><span class="current-only">Current file contents</span><span class="status-dot"></span><span id="save-state" role="status">Autosave on</span></span></footer>
`;

const ui = Object.fromEntries(
  [
    'workspace',
    'navigator',
    'navigator-resize',
    'project-name',
    'project-path',
    'branch-name',
    'message',
    'feed-scroll',
    'feed',
    'empty-state',
    'status-text',
  ].map(id => [id.replaceAll('-', '_'), document.getElementById(id)]),
);
const api = window.diffpane;
const cards = new Map();
const LINE_HEIGHT = 22;
let snapshot = null;
let openedFile = null;
let closed = false;
let closingRequested = false;
let documentFrame = null;
let navigationVersion = 0;
const savedViews = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Coalesce saves per card; a previous file's slow read must not block navigation.
function scheduleDocument() {
  if (documentFrame !== null || closed) return;
  documentFrame = requestAnimationFrame(() => {
    documentFrame = null;
    const card = cards.get(openedFile?.path);
    if (card?.active && !card.loading && card.dirty && !card.autosave?.pending)
      void loadDocument(card);
  });
}
const languageAssociations = monaco.languages.getLanguages();
const searchLanguages = new Map();
function languageForPath(pathname) {
  if (searchLanguages.has(pathname)) return searchLanguages.get(pathname);
  const name = pathname.slice(pathname.lastIndexOf('/') + 1).toLocaleLowerCase();
  let best;
  let length = 0;
  for (const language of languageAssociations) {
    if (language.filenames?.some(filename => filename.toLocaleLowerCase() === name)) {
      best = language;
      break;
    }
    for (const extension of language.extensions ?? [])
      if (name.endsWith(extension.toLocaleLowerCase()) && extension.length > length) {
        best = language;
        length = extension.length;
      }
  }
  const label = best?.aliases?.[0] ?? best?.id ?? 'Plain text';
  searchLanguages.set(pathname, label);
  return label;
}
async function mutateFile(action, pathname, name) {
  const current = cards.get(openedFile?.path);
  const affected =
    openedFile && (openedFile.path === pathname || openedFile.path.startsWith(`${pathname}/`));
  const editor = affected && (current?.diffEditor?.getModifiedEditor() ?? current?.editor);
  if (editor) editor.updateOptions({ readOnly: true });
  try {
    if (affected) await current?.autosave?.flush();
    const destination =
      action === 'rename'
        ? await api.rename(pathname, name)
        : await api.fileAction(action, pathname);
    if (action === 'rename') navigator.renamed(pathname, destination);
    if (affected && openedFile?.path === current?.file.path) {
      const previous = openedFile.path;
      navigationVersion++;
      for (const card of cards.values()) {
        deactivate(card);
        card.element.remove();
      }
      cards.clear();
      openedFile = null;
      if (action === 'rename')
        await openFile({ path: destination + previous.slice(pathname.length) });
      else {
        ui.feed.replaceChildren();
        ui.empty_state.hidden = false;
        navigator.select(null);
        document.getElementById('save-state').textContent = 'Autosave on';
        const outline = ui.navigator.querySelector('.navigator-outline .symbol-list');
        if (outline) outline.textContent = 'Open a file to see its outline';
      }
    }
    if (action === 'rename' && !affected) navigator.select(destination);
  } finally {
    if (current?.active && editor) editor.updateOptions({ readOnly: !current.document?.editable });
  }
}
const navigator = createNavigator(ui.navigator, api, openFile, {
  onReady: startBackgroundAnalysis,
  iconFor: projectIcon,
  onMutate: mutateFile,
  languageFor: languageForPath,
  onPick: () => openFilePicker(),
  onFolder: () => api.openFolder(),
  onOutline: list => {
    const card = cards.get(openedFile?.path);
    if (card?.markdownCleanup) showMarkdownOutline(card, list);
    else if (card?.editor) void showSymbols(card, list);
    else list.textContent = 'Open a file to see its outline';
  },
});
const languageFeatures = createLanguageFeatures(monaco, api, { onState: updateLanguageState });
const howmany = createHowMany(monaco, api, ui.navigator, document.querySelector('.statusbar-end'));
function startBackgroundAnalysis() {
  if (closed || !snapshot || navigator.stats().loading) return;
  const card = cards.get(openedFile?.path);
  if (card?.dirty || card?.loading) return;
  howmany.start();
}
const languageWidgets = document.createElement('div');
languageWidgets.className = 'monaco-editor language-widgets';
document.body.append(languageWidgets);
const openFilePicker = createFilePicker(
  api,
  file => (file.directory ? navigator.revealDirectory(file.path) : openFile(file)),
  () => snapshot?.scope || snapshot?.root || ui.project_path.textContent,
  languageForPath,
  () => {
    const root = snapshot?.root?.replaceAll('\\', '/').replace(/\/$/u, '') ?? '';
    const scope = snapshot?.scope?.replaceAll('\\', '/').replace(/\/$/u, '') ?? root;
    return scope.startsWith(`${root}/`) ? scope.slice(root.length + 1) : '';
  },
);

async function openFile(file) {
  const version = ++navigationVersion;
  const current = cards.get(openedFile?.path);
  if (current?.autosave?.pending) {
    try {
      await current.autosave.flush();
    } catch {
      return;
    }
    if (version !== navigationVersion || closed) return;
  }
  if (openedFile?.path === file.path && cards.has(file.path)) {
    navigator.select(file.path);
    return;
  }
  for (const card of cards.values()) {
    deactivate(card);
    if (card.viewState) {
      savedViews.delete(card.file.path);
      savedViews.set(card.file.path, card.viewState);
      while (savedViews.size > 64) savedViews.delete(savedViews.keys().next().value);
    }
    card.element.remove();
  }
  cards.clear();
  openedFile = file;
  const card = createCard(snapshot?.files.find(value => value.path === file.path) ?? file);
  card.viewState = savedViews.get(file.path) ?? null;
  cards.set(file.path, card);
  card.active = true;
  ui.feed.replaceChildren(card.element);
  ui.empty_state.hidden = true;
  document.getElementById('save-state').textContent = 'Autosave on';
  navigator.select(file.path);
  const outline = ui.navigator.querySelector('.navigator-outline .symbol-list');
  if (outline)
    outline.textContent = mediaType(file.path) ? 'No outline for media files' : 'Loading symbols…';
  scheduleDocument();
}

function updateLanguageState(state) {
  const card = cards.get(state.path);
  if (!card) return;
  card.languageState = state;
  card.language.textContent =
    monaco.languages.getLanguages().find(language => language.id === card.model?.getLanguageId())
      ?.aliases?.[0] ?? state.language;
  const ready = state.status === 'ready';
  const badge = card.element.querySelector('.language-state');
  badge.textContent = ready
    ? 'Language ready'
    : state.status === 'starting'
      ? 'Loading language…'
      : 'Syntax';
  badge.dataset.status = state.status;
  badge.title =
    state.message ||
    (ready
      ? 'Semantic features available for this language server'
      : 'Language services load when this file is used');
  if (state.diagnostics != null)
    badge.textContent += state.diagnostics
      ? ` · ${state.diagnostics} ${state.diagnostics === 1 ? 'issue' : 'issues'}`
      : '';
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
          card.editor.setPosition({
            lineNumber: symbol.selectionRange.startLineNumber,
            column: symbol.selectionRange.startColumn,
          });
          card.editor.focus();
          card.element.querySelector('.symbol-outline').open = false;
        });
        nodes.push(button);
        append(symbol.children ?? [], depth + 1);
      }
    };
    append(symbols);
    list.replaceChildren(
      ...(nodes.length ? nodes : [documentNode('span', 'symbol-empty', 'No symbols available')]),
    );
  } catch (error) {
    list.replaceChildren(
      documentNode('span', 'symbol-empty', error.message || 'Symbols unavailable'),
    );
  }
}

function showMarkdownOutline(card, list) {
  const headings = [
    ...card.host.querySelectorAll(
      '.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6',
    ),
  ];
  const buttons = headings.map(heading => {
    const button = documentNode('button', 'symbol-item', heading.textContent.replace(/#$/, ''));
    button.type = 'button';
    button.style.paddingLeft = `${12 + (Number(heading.tagName.slice(1)) - 1) * 12}px`;
    button.addEventListener('click', () => heading.scrollIntoView({ block: 'start' }));
    return button;
  });
  list.replaceChildren(
    ...(buttons.length
      ? buttons
      : [documentNode('span', 'symbol-empty', 'No headings in this document')]),
  );
}

function toggleNavigator() {
  navigator.toggle();
  ui.workspace.classList.toggle('navigator-hidden', ui.navigator.hidden);
}
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
const stopResizing = () => {
  resizing = false;
  document.body.classList.remove('resizing-navigator');
};
ui.navigator_resize.addEventListener('pointerup', stopResizing);
ui.navigator_resize.addEventListener('lostpointercapture', stopResizing);
ui.navigator_resize.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  resizeNavigator(
    ui.navigator.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -16 : 16),
  );
});

function createCard(file) {
  const element = document.createElement('section');
  element.className = 'file-card';
  element.dataset.path = file.path;
  element.innerHTML = `<div class="file-header"><span class="file-icon">${icons.file}</span><div class="file-path"><span class="file-directory"></span><strong class="file-name"></strong></div><button class="diff-toggle change-button" type="button" aria-label="Compare whole file" aria-pressed="false" title="Compare whole file · changed functions" disabled><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9 3v12M4.5 7h2M5.5 6v2M11.5 10h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button><details class="symbol-outline"><summary title="Document symbols">Symbols</summary><div class="symbol-list"></div></details><button class="change-button" title="Next change" aria-label="Next change in file">${icons.down}</button></div><div class="file-note" hidden></div><div class="editor-host"><div class="editor-placeholder"><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span></div></div><div class="file-footer"><span class="line-count">Loading file…</span><span class="language-meta"><span class="language-state">Syntax</span><span class="file-language"></span></span></div>`;
  const card = {
    file,
    element,
    host: element.querySelector('.editor-host'),
    note: element.querySelector('.file-note'),
    lines: element.querySelector('.line-count'),
    language: element.querySelector('.file-language'),
    languageCleanup: null,
    languageState: null,
    editor: null,
    model: null,
    decorationCollection: null,
    viewState: null,
    dirty: true,
    active: false,
    loading: false,
    generation: 0,
    changes: [],
    changeIndex: -1,
    textBytes: 0,
  };
  const slash = file.path.lastIndexOf('/');
  element.querySelector('.file-directory').textContent = file.path.slice(0, slash + 1);
  element.querySelector('.file-name').textContent = file.path.slice(slash + 1);
  element.querySelector('.file-path').title = file.path;
  element.querySelector('.change-button:not(.diff-toggle)').addEventListener('click', () => {
    if (!card.editor || card.changes.length === 0) return;
    card.changeIndex = (card.changeIndex + 1) % card.changes.length;
    card.editor.revealLineInCenter(
      card.changes[card.changeIndex],
      reducedMotion.matches ? monaco.editor.ScrollType.Immediate : monaco.editor.ScrollType.Smooth,
    );
  });
  element.querySelector('.diff-toggle').addEventListener('click', () => toggleDiff(card));
  if (isMarkdown(file.path)) {
    const modes = documentNode('div', 'markdown-toggle', '');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Markdown view');
    for (const [label, source] of [
      ['Preview', false],
      ['Source', true],
    ]) {
      const button = documentNode('button', '', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(!source));
      button.addEventListener('click', async () => {
        if (Boolean(card.markdownSource) === source || !card.document) return;
        try {
          await card.autosave?.flush();
        } catch {
          return;
        }
        if (!card.active) return;
        card.markdownSource = source;
        renderDocument(card, card.document);
      });
      modes.append(button);
    }
    element.querySelector('.diff-toggle').before(modes);
  }
  element.querySelector('.symbol-outline').addEventListener('toggle', event => {
    if (event.currentTarget.open) void showSymbols(card);
  });
  const fileIcon = document.createElement('img');
  fileIcon.src = projectIcon({ kind: 'file', name: file.path.slice(slash + 1) });
  fileIcon.alt = '';
  element.querySelector('.file-icon').replaceChildren(fileIcon);
  return card;
}

function applySnapshot(next) {
  if (closed || !next) return;
  if (next.error) {
    showError(next.error);
    return;
  }
  if (snapshot && Number.isFinite(next.revision) && next.revision < snapshot.revision) return;
  const first = !snapshot;
  const allDirty =
    !next.changedPaths || next.changedPaths.includes('*') || next.root !== snapshot?.root;
  snapshot = next;
  navigator.update(next);
  ui.project_name.textContent =
    next.scope?.split('/').filter(Boolean).pop() ||
    next.root?.split('/').filter(Boolean).pop() ||
    'Working tree';
  ui.project_path.textContent = next.scope || next.root || '';
  ui.project_path.title = next.scope || next.root || '';
  ui.branch_name.textContent = next.branch || 'HEAD';
  document.title = `${ui.project_name.textContent} · diffpane`;
  if (next.watchError) showError(next.watchError);
  else if (cards.get(openedFile?.path)?.saveError) showError(cards.get(openedFile.path).saveError);
  else clearError();
  if (first && (next.initialPath || next.files.length))
    void openFile({ path: next.initialPath || next.files[0].path, submodule: false });
  else {
    const card = cards.get(openedFile?.path);
    if (
      card &&
      (allDirty ||
        next.changedPaths.some(
          path => card.file.path === path || card.file.path.startsWith(`${path}/`),
        ))
    ) {
      card.file = next.files.find(file => file.path === card.file.path) ?? { path: card.file.path };
      card.dirty = true;
      scheduleDocument();
    }
  }
  ui.status_text.textContent = `${next.files.length.toLocaleString()} changed ${next.files.length === 1 ? 'file' : 'files'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function loadDocument(card) {
  if (card.loading || !card.active || closed || card.autosave?.pending) return;
  card.loading = true;
  card.dirty = false;
  const generation = card.generation;
  const editVersion = card.editVersion ?? 0;
  card.element.classList.add('is-loading');
  try {
    const [document, media] = await Promise.all([
      api.document(card.file.path, 'head'),
      mediaType(card.file.path) ? api.media(card.file.path).catch(() => null) : null,
    ]);
    if (!card.active || generation !== card.generation || !cards.has(card.file.path)) return;
    if (card.autosave?.pending || editVersion !== (card.editVersion ?? 0)) {
      card.dirty = true;
      return;
    }
    if (document.error) throw new Error(document.error);
    // Paint completed reads during edit storms, then reconcile any newer invalidation.
    card.currentMedia = media;
    renderDocument(card, document);
  } catch (error) {
    if (card.active && generation === card.generation) {
      if (mediaType(card.file.path)) {
        card.mediaCleanup?.();
        card.mediaCleanup = null;
        card.host.replaceChildren();
        card.lines.textContent = 'Preview unavailable';
      }
      card.note.textContent = error.message || String(error);
      card.note.hidden = false;
      card.note.classList.add('is-error');
      card.host.classList.add('has-error');
    }
  } finally {
    card.loading = false;
    card.element.classList.remove('is-loading');
    scheduleDocument();
    startBackgroundAnalysis();
  }
}

function editorOptions(card) {
  return {
    model: card.model,
    theme: 'diffpane',
    readOnly: closingRequested || !card.document?.editable,
    domReadOnly: closingRequested || !card.document?.editable,
    fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    lineHeight: LINE_HEIGHT,
    fontLigatures: false,
    lineNumbers: 'on',
    lineNumbersMinChars: 4,
    glyphMargin: false,
    lineDecorationsWidth: 10,
    minimap: { enabled: false },
    overviewRulerLanes: 3,
    overviewRulerBorder: false,
    scrollBeyondLastLine: false,
    smoothScrolling: !reducedMotion.matches,
    scrollbar: {
      verticalScrollbarSize: 9,
      horizontalScrollbarSize: 9,
      alwaysConsumeMouseWheel: false,
      useShadows: false,
    },
    wordWrap: 'off',
    renderLineHighlight: 'none',
    renderWhitespace: 'selection',
    renderValidationDecorations: 'on',
    folding: true,
    stickyScroll: { enabled: false },
    guides: { indentation: true, bracketPairs: false },
    bracketPairColorization: { enabled: false },
    matchBrackets: 'never',
    links: false,
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    contextmenu: true,
    automaticLayout: true,
    padding: { top: 14, bottom: 14 },
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode: languageWidgets,
    mouseWheelScrollSensitivity: 1,
    fastScrollSensitivity: 3,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    accessibilitySupport: 'auto',
    ariaLabel: `Current contents of ${card.file.path}`,
  };
}

function renderDocument(card, document) {
  if (
    card.markdownCleanup &&
    !card.markdownSource &&
    !document.preview &&
    document.after === card.markdownText
  ) {
    card.document = document;
    return;
  }
  card.document = document;
  card.functionEpoch = (card.functionEpoch ?? 0) + 1;
  card.mediaCleanup?.();
  card.mediaCleanup = null;
  card.markdownCleanup?.();
  card.markdownCleanup = null;
  const preview = document.preview;
  const reading = !preview && isMarkdown(card.file.path) && !card.markdownSource;
  const modes = card.element.querySelector('.markdown-toggle');
  if (modes) {
    modes.hidden = Boolean(preview);
    for (const button of modes.querySelectorAll('button'))
      button.setAttribute('aria-pressed', String((button.textContent === 'Preview') === reading));
  }
  for (const control of card.element.querySelectorAll('.symbol-outline, .language-state'))
    control.hidden = Boolean(preview) || reading;
  card.element.querySelector('.change-button:not(.diff-toggle)').hidden =
    Boolean(preview) || reading;
  if (preview) {
    globalThis.document.getElementById('save-state').textContent = 'Read only';
    releaseEditor(card);
    howmany.clearFile(card);
    card.note.hidden = true;
    card.note.classList.remove('is-error');
    card.host.classList.remove('has-error');
    card.lines.textContent = `${preview.after.size.toLocaleString()} bytes`;
    card.language.textContent =
      preview.after.kind === 'binary' ? 'Binary' : preview.after.kind.toUpperCase();
    const button = card.element.querySelector('.diff-toggle');
    button.disabled = false;
    button.hidden = false;
    button.setAttribute('aria-pressed', String(Boolean(card.previewCompared)));
    button.setAttribute(
      'aria-label',
      card.previewCompared ? 'Show current file' : 'Compare whole file',
    );
    card.element.dataset.diff = String(Boolean(card.previewCompared));
    card.mediaCleanup = showDocumentPreview(
      card.host,
      preview,
      card.file.path,
      card.previewCompared,
      card.currentMedia,
      {
        raw: card.previewRaw,
        onRawChange: raw => {
          card.previewRaw = raw;
        },
      },
    );
    card.textBytes = Object.values(preview).reduce(
      (sum, side) =>
        sum + ((side.data?.length ?? 0) + (side.hex?.length ?? 0) + (side.value?.length ?? 0)) * 2,
      0,
    );
    return;
  }
  card.previewCompared = false;
  const text = document.after ?? '';
  const state = card.editor?.saveViewState();
  const lineCount = document.lineCount ?? countLines(text);
  card.note.textContent =
    document.note ||
    document.diffNote ||
    (!text && (card.file.worktree === 'D' || card.file.index === 'D')
      ? 'This file was deleted. There are no current contents.'
      : '');
  card.note.hidden = !card.note.textContent;
  card.note.classList.remove('is-error');
  card.host.classList.remove('has-error');
  if (reading) {
    releaseEditor(card);
    howmany.clearFile(card);
    const button = card.element.querySelector('.diff-toggle');
    button.disabled = false;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Compare whole file');
    card.element.dataset.diff = 'false';
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    card.lines.textContent = `${words.toLocaleString()} words · ${Math.max(1, Math.ceil(words / 220))} min read`;
    card.language.textContent = 'Markdown';
    card.textBytes = text.length * 2;
    card.markdownCleanup = showMarkdownPreview(card.host, text, {
      filename: card.file.path,
      scrollTop: card.markdownScroll,
      diagramHeights: (card.markdownDiagramHeights ??= []),
      anchor: card.markdownAnchor,
      onScroll: top => {
        card.markdownScroll = top;
      },
      media: api.media,
      openExternal: api.openExternal,
      onOpenFile: async target => {
        await openFile({ path: target.path });
        const next = cards.get(target.path);
        if (next) next.markdownAnchor = target.anchor;
      },
      colorize: (code, language) => {
        const aliases = {
          js: 'javascript',
          ts: 'typescript',
          sh: 'shell',
          bash: 'shell',
          yml: 'yaml',
          py: 'python',
        };
        return monaco.editor.colorize(code, aliases[language] ?? language, { theme: 'diffpane' });
      },
    });
    card.markdownAnchor = null;
    card.markdownText = text;
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list');
    if (outline) showMarkdownOutline(card, outline);
    return;
  }
  if (!card.element.querySelector('.howmany-counts')) {
    const counts = documentNode('div', 'howmany-counts', '');
    const warnings = documentNode('div', 'howmany-warnings', '');
    counts.hidden = true;
    warnings.hidden = true;
    warnings.setAttribute('role', 'status');
    card.host.before(counts, warnings);
  }
  if (!card.editor) {
    card.host.replaceChildren();
    const root = snapshot.root.replaceAll('\\', '/').replace(/\/$/, '');
    const uri = monaco.Uri.file(`${root}/${card.file.path}`);
    card.model = monaco.editor.createModel(text, undefined, uri);
    monaco.editor.setModelLanguage(card.model, syntax.resolve(card.model, text));
    card.model.detectIndentation(true, 2);
    card.editor = monaco.editor.create(card.host, editorOptions(card));
    card.autosave = new Autosave(
      text,
      (value, expected) => api.save(card.file.path, value, expected),
      (state, error) => {
        if (!card.active) return;
        card.saveError = state === 'error' ? error?.message || String(error) : null;
        globalThis.document.getElementById('save-state').textContent =
          state === 'saving'
            ? 'Saving…'
            : state === 'error'
              ? 'Save failed · ⌘S to retry'
              : 'Saved';
        if (state === 'error') showError(error?.message || error);
        if (state === 'saved') {
          if (!snapshot?.watchError) clearError();
          card.dirty = true;
          scheduleDocument();
        }
      },
    );
    card.contentCleanup = card.model.onDidChangeContent(() => {
      if (card.applyingDocument || !card.document.editable) return;
      card.editVersion = (card.editVersion ?? 0) + 1;
      card.text = card.model.getValue(undefined, true);
      card.document = { ...card.document, after: card.text };
      card.autosave.edit(card.text);
    });
    card.decorationCollection = card.editor.createDecorationsCollection();
    card.languageCleanup = languageFeatures.attach(card.editor, card.model, card.file.path, {
      active: true,
    });
    if (card.viewState) card.editor.restoreViewState(card.viewState);
  } else if (card.text !== text) {
    const change = minimalChange(card.model.getValue(undefined, true), text);
    const start = card.model.getPositionAt(change.start);
    const end = card.model.getPositionAt(change.end);
    card.applyingDocument = true;
    try {
      card.model.applyEdits([{ range: monaco.Range.fromPositions(start, end), text: change.text }]);
    } finally {
      card.applyingDocument = false;
    }
    if (state) card.editor.restoreViewState(state);
  }
  card.text = text;
  card.autosave.accept(text);
  card.editor.updateOptions({
    readOnly: closingRequested || !document.editable,
    domReadOnly: closingRequested || !document.editable,
  });
  if (!document.editable)
    globalThis.document.getElementById('save-state').textContent = 'Read only';
  card.textBytes = text.length * 2 + (card.originalModel ? (document.before?.length ?? 0) * 2 : 0);
  if (card.originalModel && card.originalText !== document.before) {
    const originalState = card.diffEditor.getOriginalEditor().saveViewState();
    card.originalModel.setValue(document.before ?? '');
    card.originalText = document.before;
    if (originalState) card.diffEditor.getOriginalEditor().restoreViewState(originalState);
  }
  const decorations = [];
  const changeLines = new Set();
  for (const change of document.decorations ?? []) {
    const start = Math.max(1, Math.min(card.model.getLineCount(), change.startLine));
    const end = Math.max(
      start,
      Math.min(card.model.getLineCount(), change.endLine ?? change.startLine),
    );
    changeLines.add(start);
    const deleted = change.kind === 'deleted';
    const kind = deleted ? 'deleted' : change.kind === 'modified' ? 'modified' : 'added';
    decorations.push({
      range: new monaco.Range(start, 1, end, card.model.getLineMaxColumn(end)),
      options: {
        isWholeLine: !deleted,
        linesDecorationsClassName: `diff-gutter-${kind}`,
        linesDecorationsTooltip: `${kind === 'deleted' ? 'Lines deleted' : kind === 'modified' ? 'Lines modified' : 'Lines added'} compared with HEAD`,
        overviewRuler: {
          color: { deleted: '#ac6266', modified: '#477d92', added: '#52785b' }[kind],
          position: monaco.editor.OverviewRulerLane.Left,
        },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
  }
  card.decorationCollection.set(decorations);
  card.changes = [...changeLines].sort((a, b) => a - b);
  card.element.querySelector('.change-button:not(.diff-toggle)').disabled =
    card.changes.length === 0;
  card.element.querySelector('.diff-toggle').disabled = false;
  card.lines.textContent = `${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'}`;
  const language = card.model.getLanguageId();
  card.language.textContent =
    monaco.languages.getLanguages().find(value => value.id === language)?.aliases?.[0] ?? language;
  (card.diffEditor ?? card.editor).layout();
  card.editor.render(true);
  howmany.updateFile(card, document);
  if (card.diffEditor) void highlightFunctions(card);
  if (card.element.querySelector('.symbol-outline').open) void showSymbols(card);
  const outline = ui.navigator.querySelector('.navigator-outline[open] .symbol-list');
  if (outline) void showSymbols(card, outline);
}

async function toggleDiff(card) {
  try {
    await card.autosave?.flush();
  } catch {
    return;
  }
  if (!card.active) return;
  if (card.markdownCleanup) {
    card.markdownSource = true;
    renderDocument(card, card.document);
  }
  if (card.document?.preview) {
    card.previewCompared = !card.previewCompared;
    renderDocument(card, card.document);
    return;
  }
  if (!card.model || !card.document) return;
  const state = card.editor.saveViewState();
  card.languageCleanup?.();
  card.languageCleanup = null;
  if (card.diffEditor) {
    card.diffEditor.setModel(null);
    card.diffEditor.dispose();
    card.diffEditor = null;
    card.originalModel.dispose();
    card.originalModel = null;
    card.originalDecorations = null;
    card.functionDecorations = null;
    card.host.replaceChildren();
    card.editor = monaco.editor.create(card.host, editorOptions(card));
  } else {
    card.editor.setModel(null);
    card.editor.dispose();
    card.host.replaceChildren();
    card.originalText = card.document.before ?? '';
    card.originalModel = monaco.editor.createModel(
      card.originalText,
      card.model.getLanguageId(),
      card.model.uri.with({ query: 'diffpane-original' }),
    );
    card.diffEditor = monaco.editor.createDiffEditor(card.host, {
      ...editorOptions(card),
      model: undefined,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      renderIndicators: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      hideUnchangedRegions: { enabled: false },
      maxComputationTime: 150,
      maxFileSize: 2,
      diffWordWrap: 'off',
      enableSplitViewResizing: true,
    });
    card.diffEditor.setModel({ original: card.originalModel, modified: card.model });
    card.editor = card.diffEditor.getModifiedEditor();
    card.originalDecorations = card.diffEditor.getOriginalEditor().createDecorationsCollection();
    card.functionDecorations = card.editor.createDecorationsCollection();
  }
  card.decorationCollection = card.editor.createDecorationsCollection();
  card.languageCleanup = languageFeatures.attach(card.editor, card.model, card.file.path, {
    active: true,
  });
  if (state) card.editor.restoreViewState(state);
  const button = card.element.querySelector('.diff-toggle');
  button.setAttribute('aria-pressed', String(Boolean(card.diffEditor)));
  button.setAttribute('aria-label', card.diffEditor ? 'Show current file' : 'Compare whole file');
  button.title = card.diffEditor ? 'Show current file' : 'Compare whole file · changed functions';
  card.element.dataset.diff = String(Boolean(card.diffEditor));
  renderDocument(card, card.document);
}

async function highlightFunctions(card) {
  const epoch = card.functionEpoch;
  const document = card.document;
  const paint = (symbols = []) => {
    if (!card.diffEditor || epoch !== card.functionEpoch || !card.active) return;
    const modified = changedFunctionRanges(
      document.after ?? '',
      document.decorations ?? [],
      symbols,
    );
    const original = changedFunctionRanges(document.before ?? '', document.beforeDecorations ?? []);
    const ranges = (functions, kind) =>
      functions.map(fn => ({
        range: new monaco.Range(fn.startLine, 1, fn.endLine, 1),
        options: {
          isWholeLine: true,
          className: `diff-function-${kind}`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }));
    card.functionDecorations.set(ranges(modified, 'after'));
    const markers = (document.beforeDecorations ?? []).map(change => ({
      range: new monaco.Range(change.startLine, 1, change.endLine ?? change.startLine, 1),
      options: {
        linesDecorationsClassName: `diff-gutter-${change.kind}`,
        overviewRuler: { color: '#ac6266', position: monaco.editor.OverviewRulerLane.Left },
      },
    }));
    card.originalDecorations.set([...ranges(original, 'before'), ...markers]);
    card.changedFunctions = modified.length;
  };
  paint();
  try {
    paint(await languageFeatures.symbols(card.file.path));
  } catch {
    /* Lexical ranges stay visible when a server is unavailable. */
  }
}

// A single replacement keeps Monaco's existing model, token state, and selection markers.
export function minimalChange(before, after) {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isLowSurrogate(before.charCodeAt(start))) start--;
  let end = before.length;
  let afterEnd = after.length;
  while (
    end > start &&
    afterEnd > start &&
    before.charCodeAt(end - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    end--;
    afterEnd--;
  }
  if (end < before.length && isLowSurrogate(before.charCodeAt(end))) {
    end++;
    afterEnd++;
  }
  return { start, end, text: after.slice(start, afterEnd) };
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function documentNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function deactivate(card) {
  howmany.clearFile(card);
  card.active = false;
  card.generation++;
  card.dirty = true;
  card.mediaCleanup?.();
  card.mediaCleanup = null;
  card.markdownCleanup?.();
  card.markdownCleanup = null;
  releaseEditor(card);
  card.document = null;
  card.currentMedia = null;
  card.textBytes = 0;
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''));
}

function releaseEditor(card) {
  if (!card.editor) return;
  card.contentCleanup?.dispose();
  card.contentCleanup = null;
  card.autosave = null;
  card.viewState = card.editor.saveViewState();
  card.languageCleanup?.();
  card.languageCleanup = null;
  card.element.querySelector('.symbol-outline').open = false;
  if (card.diffEditor) card.diffEditor.dispose();
  else card.editor.dispose();
  card.originalModel?.dispose();
  card.originalModel = null;
  card.diffEditor = null;
  card.functionEpoch = (card.functionEpoch ?? 0) + 1;
  card.model.dispose();
  card.editor = null;
  card.model = null;
  card.decorationCollection = null;
  card.textBytes = 0;
  card.text = null;
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''));
}

function showError(error) {
  ui.message.textContent = String(error);
  ui.message.hidden = false;
}

function clearError() {
  ui.message.hidden = true;
}

async function refresh() {
  try {
    const result = await api.refresh();
    if (result?.files) applySnapshot(result);
  } catch (error) {
    showError(error.message || error);
  }
}

document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (document.querySelector('#file-picker')?.open) {
    if (event.key.toLowerCase() === 'p') {
      event.preventDefault();
      void openFilePicker();
    }
    return;
  }
  if (event.key.toLowerCase() === 'b') {
    event.preventDefault();
    toggleNavigator();
  }
  if (event.key.toLowerCase() === 'p') {
    event.preventDefault();
    void openFilePicker();
  }
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault();
    void openFilePicker();
  }
  if (event.key.toLowerCase() === 'o') {
    event.preventDefault();
    void api.openFolder().catch(error => showError(error.message || error));
  }
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    void refresh();
  }
  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    void cards
      .get(openedFile?.path)
      ?.autosave?.flush()
      .catch(() => {});
  }
});

window.__diffpane = {
  stats: () => ({
    files: cards.size,
    documentLoading: Boolean(cards.get(openedFile?.path)?.loading),
    snapshotRevision: snapshot?.revision ?? 0,
    activeEditors: [...cards.values()].filter(card => card.editor).length,
    models: monaco.editor.getModels().length,
    loadedTextBytes: [...cards.values()].reduce((total, card) => total + card.textBytes, 0),
    diffMode: Boolean(cards.get(openedFile?.path)?.diffEditor),
    changedFunctions: cards.get(openedFile?.path)?.changedFunctions ?? 0,
    openedPath: openedFile?.path ?? null,
    openedLanguage: cards.get(openedFile?.path)?.model?.getLanguageId() ?? null,
    syntax: syntax.stats(),
    navigator: navigator.stats(),
    languages: languageFeatures.stats(),
  }),
};

if (!api) showError('The desktop connection is unavailable. Reopen diffpane from your terminal.');
else {
  const resumeEditing = () => {
    closingRequested = false;
    for (const card of cards.values())
      card.editor?.updateOptions({
        readOnly: !card.document?.editable,
        domReadOnly: !card.document?.editable,
      });
  };
  const unsubscribeResume = api.onResumeEditing(resumeEditing);
  const unsubscribeFlush = api.onFlushSaves(async () => {
    closingRequested = true;
    for (const card of cards.values())
      card.editor?.updateOptions({ readOnly: true, domReadOnly: true });
    try {
      await Promise.all([...cards.values()].map(card => card.autosave?.flush()));
      api.savesFlushed(true);
    } catch {
      resumeEditing();
      api.savesFlushed(false);
    }
  });
  const unsubscribePaths = subscribeLivePaths(api, paths => {
    const card = cards.get(openedFile?.path);
    if (
      card &&
      paths.some(
        path => path === '*' || card.file.path === path || card.file.path.startsWith(`${path}/`),
      )
    ) {
      card.dirty = true;
      scheduleDocument();
    }
  });
  let pendingSnapshot;
  const snapshotPaths = new LivePathBatch();
  let snapshotFrame = null;
  const unsubscribe = api.onChange(next => {
    if (!pendingSnapshot || next.revision >= pendingSnapshot.revision) {
      pendingSnapshot = next;
      snapshotPaths.add(next.changedPaths ?? ['*']);
    }
    if (snapshotFrame === null)
      snapshotFrame = requestAnimationFrame(() => {
        const next = { ...pendingSnapshot, changedPaths: snapshotPaths.take() };
        pendingSnapshot = null;
        snapshotFrame = null;
        applySnapshot(next);
      });
  });
  const unsubscribeErrors = api.onError(showError);
  api
    .snapshot()
    .then(applySnapshot)
    .catch(error => showError(error.message || error));
  window.addEventListener(
    'beforeunload',
    () => {
      closed = true;
      howmany.dispose();
      if (snapshotFrame !== null) cancelAnimationFrame(snapshotFrame);
      if (documentFrame !== null) cancelAnimationFrame(documentFrame);
      navigator.dispose();
      unsubscribePaths();
      unsubscribeFlush();
      unsubscribeResume();
      languageFeatures.dispose();
      if (typeof unsubscribe === 'function') unsubscribe();
      if (typeof unsubscribeErrors === 'function') unsubscribeErrors();
      for (const card of cards.values()) deactivate(card);
      languageWidgets.remove();
    },
    { once: true },
  );
}

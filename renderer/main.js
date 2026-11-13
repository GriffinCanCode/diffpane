import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import { configureSyntax } from './syntax.ts';
import { editorThemeName } from './editor-themes.ts';
import { codeAppearance, createAppearanceSettings, diffAppearance } from './appearance.ts';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import './style.css';
import { createFilePicker } from './files.ts';
import { createReviewNotes } from './review-notes.ts';
import { mountIdeaBuilder } from './ideas.ts';
import { createWorkspaceLayout } from './workspace-layout.ts';
import { captureReviewLines, locateReviewLines } from '../review-notes.ts';
import { projectIcon } from './icons.ts';
import { createNavigator } from './navigator.js';
import { createChangeReview } from './change-review.js';
import { createReviewFocus } from './review-focus.js';
import { createAssistant } from './assistant.js';
import { createLanguageFeatures } from './languages.js';
import { createHowMany } from './howmany.js';
import { changedFunctionRanges } from './function-ranges.ts';
import { mediaType } from '../media-types.ts';
import { showDocumentPreview } from './document-preview.ts';
import { isMarkdown } from './markdown-paths.ts';
import { recolorMarkdownPreviews, showMarkdownPreview } from './markdown-preview.ts';
import './document-preview.css';
import './navigator.css';
import { LivePathBatch, subscribeLivePaths } from './live-updates.ts';
import { Autosave } from './autosave.ts';
import { countLines } from '../text-lines.ts';
import { createSettings } from './settings.js';

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const syntax = configureSyntax(monaco);

const icons = {
  mark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3.5" fill="currentColor" opacity=".06"/><path d="M12 4v16" stroke="currentColor" opacity=".2"/><rect x="3" y="4" width="18" height="16" rx="3.5" stroke="currentColor" stroke-width="1.2" opacity=".5"/><path d="M6 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".55"/><path d="M15 15h3m-1.5-1.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  branch:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3" r="1.7" stroke="currentColor"/><circle cx="4" cy="13" r="1.7" stroke="currentColor"/><circle cx="12" cy="3" r="1.7" stroke="currentColor"/><path d="M4 5v6m8-6v1a4 4 0 0 1-4 4H4" stroke="currentColor" stroke-width="1.2"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10m-4-4 4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  review:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m2.5 5 1 1 2-2m-3 6 1 1 2-2M8 5h5.5M8 10h5.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  note: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 2.5h9a1 1 0 0 1 1 1v6L9.5 13.5h-6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.5 13.5v-3a1 1 0 0 1 1-1h3M5 5.5h6M5 8h3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  idea: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.6 10.4c0-1.4-1.7-1.9-1.7-4a4.1 4.1 0 0 1 8.2 0c0 2.1-1.7 2.6-1.7 4m-4.8 0h4.8m-4 2.1h3.2m-2.5 1.8h1.8"/></svg>',
  settings:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 1.5-.3 1.7-1.1.6-1.6-.6-1.5 2.6 1.3 1.1v1.2L2 9.2l1.5 2.6 1.6-.6 1.1.6.3 1.7h3l.3-1.7 1.1-.6 1.6.6L14 9.2l-1.3-1.1V6.9L14 5.8l-1.5-2.6-1.6.6-1.1-.6-.3-1.7z"/><circle cx="8" cy="7.5" r="2"/></svg>',
  claude:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3.2h6A2.8 2.8 0 0 1 13.8 6v2.6A2.8 2.8 0 0 1 11 11.4H7l-3.2 2v-2.3a2.8 2.8 0 0 1-1.6-2.5V6A2.8 2.8 0 0 1 5 3.2Z" stroke="currentColor" stroke-linejoin="round"/><path d="M5.5 7.3h5" stroke="currentColor" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.3l-3.5-3.5Z" stroke="currentColor" stroke-width="1.15"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.15"/></svg>',
  folder:
    '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5 12a4 4 0 0 1 4-4h10l5 5h15a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V12Z" fill="currentColor" opacity=".22"/><path d="M5 19a4 4 0 0 1 4-4h30a4 4 0 0 1 4 4v17a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V19Z" fill="currentColor" opacity=".72"/><path d="M9 15h30a4 4 0 0 1 4 4v1H5v-1a4 4 0 0 1 4-4Z" fill="white" opacity=".12"/><path d="M10 33h12" stroke="white" stroke-opacity=".3" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

const app =
  document.querySelector('#app') ?? document.body.appendChild(document.createElement('div'));
app.innerHTML = `
  <header class="titlebar">
    <div class="brand" role="img" aria-label="diffpane"><span class="brand-mark">${icons.mark}</span></div>
    <span class="title-divider"></span>
    <div class="project"><span id="project-name">Diffpane</span><span id="project-path"></span></div>
    <span class="branch" hidden>${icons.branch}<span id="branch-name"></span></span>
    <div class="titlebar-actions">
      <button type="button" id="ideas-toggle" class="titlebar-button" aria-label="Idea Builder" aria-controls="ideas-panel" aria-expanded="false" aria-keyshortcuts="Meta+Shift+I Control+Shift+I" title="Idea Builder · ⌘⇧I" hidden>${icons.idea}<span>Ideas</span></button>
      <button type="button" id="review-toggle" class="titlebar-button review-toggle" aria-label="Review changes" aria-controls="change-review" aria-pressed="false" aria-keyshortcuts="Meta+Shift+G Control+Shift+G" title="Review changes · ⌘⇧G" hidden>${icons.review}<span>Changes</span><span class="review-count" aria-hidden="true"></span></button>
      <button type="button" id="review-notes-toggle" class="titlebar-button" aria-label="Review notes" aria-controls="review-notes-panel" aria-expanded="false" aria-keyshortcuts="Meta+Shift+J Control+Shift+J" title="Review notes · ⌘⇧J" hidden>${icons.note}<span>Notes</span><span class="review-notes-count" aria-hidden="true" hidden></span></button>
      <button type="button" id="claude-toggle" aria-label="Claude" aria-controls="claude-panel" aria-expanded="false" aria-keyshortcuts="Meta+Shift+L Control+Shift+L" title="Claude · ⌘⇧L" hidden>${icons.claude}<span>Claude</span></button>
      <button type="button" id="settings-toggle" class="titlebar-button" aria-label="Settings" aria-haspopup="dialog" aria-controls="app-settings" title="Settings · ⌘," aria-keyshortcuts="Meta+, Control+,">${icons.settings}</button>
    </div>
  </header>
  <div class="workspace" id="workspace">
    <aside id="ideas-panel" hidden></aside>
    <div id="sidebar" hidden>
      <aside id="navigator" hidden></aside>
      <aside id="change-review" hidden></aside>
    </div>
    <section class="workbench">
  <div class="message" id="message" role="status" hidden></div>
  <main class="start-screen" id="start-screen" aria-labelledby="start-title" aria-busy="true">
    <div class="start-content"><span class="start-mark">${icons.mark}</span><h1 id="start-title">Opening workspace…</h1><p id="start-description" role="status">Your files will appear here in a moment.</p><div class="start-actions" id="start-actions" hidden><button type="button" id="open-folder">Open Folder…</button><button type="button" id="open-file">Open File…</button></div><section class="recent-targets" id="recent-targets" aria-labelledby="recent-title" hidden><h2 id="recent-title">Recently opened</h2><ul class="recent-list" id="recent-list"></ul><p id="recent-status" role="status" hidden></p></section></div>
  </main>
  <main class="feed-scroll" id="feed-scroll" hidden><div class="feed" id="feed"></div><div class="empty-state" id="empty-state"><span class="empty-symbol">${icons.mark}</span><h2>Open a file</h2><p>Select a file in the explorer, or press ⌘P.</p></div></main>
  </section>
    <aside id="claude-panel" hidden></aside>
    <aside id="review-notes-panel" hidden></aside>
  </div>
  <footer class="statusbar"><span id="status-text">Opening workspace…</span><span class="statusbar-end" hidden><span class="current-only">Current file contents</span><span class="status-dot"></span><span id="save-state" role="status">Autosave on</span></span></footer>
`;

const ui = Object.fromEntries(
  [
    'workspace',
    'ideas-panel',
    'ideas-toggle',
    'sidebar',
    'change-review',
    'review-toggle',
    'review-notes-toggle',
    'review-notes-panel',
    'navigator',
    'claude-panel',
    'claude-toggle',
    'settings-toggle',
    'project-name',
    'project-path',
    'branch-name',
    'message',
    'feed-scroll',
    'feed',
    'empty-state',
    'start-screen',
    'start-title',
    'start-description',
    'start-actions',
    'open-file',
    'open-folder',
    'recent-targets',
    'recent-list',
    'recent-status',
    'status-text',
  ].map(id => [id.replaceAll('-', '_'), document.getElementById(id)]),
);
const api = window.diffpane;
const cards = new Map();
let snapshot = null;
let openedFile = null;
let closed = false;
let closingRequested = false;
let documentFrame = null;
let navigationVersion = 0;
let reviewVisible = false;
let reviewScope = 'focus';
const savedViews = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let recentVersion = 0;
let recentSignature = '';
let applyingAssistantPath = null;
let applyingAssistantEdit = null;
const ideaVisibilityKey = 'diffpane.ideas.visible';

let activeScheme;
const appearance = createAppearanceSettings((preferences, scheme) => {
  const themeChanged = activeScheme !== scheme;
  if (themeChanged) {
    activeScheme = scheme;
    syntax.setTheme(editorThemeName(scheme));
    recolorMarkdownPreviews();
  }
  for (const card of cards.values()) {
    if (card.diffEditor)
      card.diffEditor.updateOptions({
        ...diffAppearance(preferences, Boolean(card.reviewComparison)),
        ...comparisonAriaLabels(card),
      });
    else card.editor?.updateOptions(codeAppearance(preferences));
  }
});

const settings = createSettings(appearance);
const openSettings = () => {
  if (!closingRequested) settings.open();
};
ui.settings_toggle.addEventListener('click', openSettings);

const assistant =
  api?.claude &&
  createAssistant(ui.claude_panel, ui.claude_toggle, api, {
    onOpen: () => reviewNotes?.close(),
    prepareSend: async pathname => {
      if (closingRequested || closed) throw new Error('This window is closing.');
      await cards.get(pathname)?.autosave?.flush();
    },
    applyEdit: async ({ id, path }) => {
      if (closingRequested || closed) throw new Error('This window is closing.');
      applyingAssistantPath = path;
      const card = cards.get(path);
      const apply = async () => {
        if (card) applyEditorReadOnly(card);
        await card?.autosave?.flush();
        await api.claude.apply(id);
      };
      applyingAssistantEdit = apply();
      try {
        syncSaveState();
        await applyingAssistantEdit;
        const current = cards.get(path);
        if (current) {
          current.dirty = true;
          syncReviewState();
          scheduleDocument();
        }
      } finally {
        applyingAssistantEdit = null;
        applyingAssistantPath = null;
        const current = cards.get(path);
        if (current) applyEditorReadOnly(current);
        syncSaveState();
      }
    },
  });

function showStartScreen(failed = false) {
  ui.start_screen.hidden = false;
  ui.start_screen.setAttribute('aria-busy', 'false');
  ui.start_title.textContent = failed ? 'Couldn’t open this project' : 'Welcome to Diffpane';
  ui.start_description.textContent = 'Open a file or folder in a Git working tree to get started.';
  ui.start_actions.hidden = false;
  ui.status_text.textContent = failed ? 'Choose another file or folder' : 'No project open';
  document.title = 'Diffpane';
  void loadRecentTargets();
}

async function loadRecentTargets() {
  const version = ++recentVersion;
  try {
    const targets = await api.recentTargets();
    if (version !== recentVersion || closed || snapshot) return;
    const signature = JSON.stringify(
      targets.map(target => [target.path, target.name, target.kind]),
    );
    if (signature === recentSignature) return;
    recentSignature = signature;
    const focusedPath = ui.recent_list.contains(document.activeElement)
      ? document.activeElement.dataset.path
      : null;
    const items = targets.map(target => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-target';
      button.dataset.kind = target.kind;
      button.dataset.path = target.path;
      button.title = target.path;
      button.setAttribute('aria-label', `Open ${target.name}, ${target.path}`);
      button.innerHTML = `<span class="recent-glyph">${target.kind === 'folder' ? icons.folder : icons.file}</span><span class="recent-label"><strong></strong><span class="recent-location"></span></span><span class="recent-arrow" aria-hidden="true">↗</span>`;
      button.querySelector('strong').textContent = target.name;
      button.querySelector('.recent-location').textContent = target.path;
      button.addEventListener('click', () => void openRecentTarget(button, target.path));
      item.append(button);
      return item;
    });
    ui.recent_list.replaceChildren(...items);
    ui.recent_targets.hidden = !items.length && ui.recent_status.hidden;
    ui.start_screen.classList.toggle('has-recents', items.length > 0);
    if (focusedPath)
      [...ui.recent_list.querySelectorAll('button')]
        .find(button => button.dataset.path === focusedPath)
        ?.focus({ preventScroll: true });
  } catch {
    // History is optional; native pickers remain available if it cannot be read.
  }
}

async function openRecentTarget(button, pathname) {
  button.disabled = true;
  ui.recent_status.hidden = true;
  try {
    if (!(await api.openRecent(pathname))) {
      ui.recent_status.textContent =
        'This item is no longer available. Open a file or folder to locate it.';
      ui.recent_status.hidden = false;
      await loadRecentTargets();
    }
  } catch (error) {
    ui.recent_status.textContent = error.message || String(error);
    ui.recent_status.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function chooseTarget(kind) {
  ui.open_file.disabled = ui.open_folder.disabled = true;
  try {
    await (kind === 'file' ? api.openFile() : api.openFolder());
  } catch (error) {
    showError(error.message || error);
  } finally {
    ui.open_file.disabled = ui.open_folder.disabled = false;
  }
}
ui.open_file.addEventListener('click', () => void chooseTarget('file'));
ui.open_folder.addEventListener('click', () => void chooseTarget('folder'));
window.addEventListener('focus', () => {
  if (!snapshot && ui.start_screen.getAttribute('aria-busy') === 'false') void loadRecentTargets();
});

function syncSaveState() {
  api.setSaveState(
    Boolean(applyingAssistantEdit || ideas?.pending) ||
      [...cards.values()].some(card => card.autosave?.pending),
  );
  syncReviewState();
}

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
function editorReadOnly(card) {
  return closingRequested || !card.document?.editable || applyingAssistantPath === card.file.path;
}

function applyEditorReadOnly(card) {
  const readOnly = editorReadOnly(card);
  card.editor?.updateOptions({ readOnly, domReadOnly: readOnly });
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
      assistant?.setContext(Boolean(snapshot), null);
      ideas?.refreshContext();
      if (action === 'rename')
        await openFile({ path: destination + previous.slice(pathname.length) });
      else {
        ui.feed.replaceChildren();
        ui.empty_state.hidden = false;
        navigator.select(null);
        syncReviewState();
        document.getElementById('save-state').textContent = 'Autosave on';
        const outline = ui.navigator.querySelector('.navigator-outline .symbol-list');
        if (outline) outline.textContent = 'Open a file to see its outline';
      }
    }
    if (action === 'rename' && !affected) navigator.select(destination);
  } finally {
    if (current?.active && editor) applyEditorReadOnly(current);
  }
}
const navigator = createNavigator(ui.navigator, api, openFile, {
  onReady: startBackgroundAnalysis,
  iconFor: projectIcon,
  onMutate: mutateFile,
  onAttach: api.ideas ? path => attachIdeaLink({ path }) : undefined,
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
const reviewBadge = ui.review_toggle.querySelector('.review-count');
const review = createChangeReview(ui.change_review, {
  onOpen: file => openFile(file, { compare: true }),
  onBack: toggleReview,
  onProgress: ({ pending, total }) => {
    const complete = total > 0 && pending === 0;
    reviewBadge.hidden = total === 0;
    reviewBadge.textContent = complete ? '✓' : pending.toLocaleString();
    ui.review_toggle.dataset.complete = String(complete);
    ui.review_toggle.setAttribute(
      'aria-description',
      pending
        ? `${pending.toLocaleString()} ${pending === 1 ? 'file' : 'files'} pending`
        : complete
          ? 'All changes reviewed'
          : 'No changed files',
    );
  },
});
ui.review_toggle.addEventListener('click', toggleReview);

function syncReviewState() {
  const card = cards.get(openedFile?.path);
  const version = card?.document?.reviewVersion ?? null;
  let state = null;
  if (card?.comparing) {
    if (closingRequested) state = 'closing';
    else if (card.autosave?.pending) state = card.saveError ? 'save-failed' : 'saving';
    else if (card.loading || card.dirty) state = 'loading';
    else if (card.documentFailed) state = 'failed';
    else state = 'ready';
  }
  review.setCurrent(card?.file.path ?? null, state, version);
}

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

const reviewNotes =
  api?.reviewNotes &&
  createReviewNotes(ui.review_notes_panel, ui.review_notes_toggle, api.reviewNotes, {
    matchesSaveShortcut: event =>
      event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey,
    capture: () => {
      const card = cards.get(openedFile?.path);
      return card ? captureReviewAnchor(card, card.noteSide ?? 'working') : null;
    },
    onJump: anchor => {
      const rename = snapshot?.files.find(
        file => (file.index === 'R' || file.worktree === 'R') && file.originalPath === anchor.path,
      );
      const path = rename?.path ?? anchor.path;
      return openFile({ path }, { anchor });
    },
    onVisible: visible => {
      if (visible && !ui.claude_panel.hidden) assistant?.toggle(false, false);
    },
  });

ui.review_notes_panel
  .querySelector('[data-review-action="save"]')
  ?.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');

const ideas =
  api?.ideas &&
  mountIdeaBuilder(ui.ideas_panel, {
    getWorkspace: () => snapshot?.root,
    load: api.ideas.list,
    save: api.ideas.upsert,
    remove: api.ideas.delete,
    onPendingChange: syncSaveState,
    onClose: () => setIdeasVisible(false, true),
    hasCurrentLink: () => Boolean(openedFile),
    getCurrentLink: () => {
      const card = cards.get(openedFile?.path);
      return card ? captureIdeaLink(card) : null;
    },
    openLink: async link => {
      const renamed = snapshot?.files.find(
        file => (file.index === 'R' || file.worktree === 'R') && file.originalPath === link.path,
      );
      const anchor = {
        ...link,
        line: link.line ?? null,
        endLine: link.endLine ?? link.line ?? null,
        excerpt: link.excerpt ?? '',
      };
      const path = renamed?.path ?? link.path;
      const root = snapshot.root.replaceAll('\\', '/').replace(/\/$/u, '');
      const scope = (snapshot.scope ?? snapshot.root).replaceAll('\\', '/').replace(/\/$/u, '');
      if (root !== scope && !`${root}/${path}`.startsWith(`${scope}/`))
        throw new Error('Open the repository root to view this linked file.');
      if (!(await openFile({ path }, { anchor, ideaLink: true })))
        throw new Error('The linked file could not be opened.');
    },
    draftInChat: assistant ? idea => assistant.attachIdea(idea) : undefined,
    openMarkdownFile: target => void openMarkdownTarget(target),
    openExternal: api.openExternal,
    media: api.media,
    colorize: colorizeMarkdown,
  });
const workspaceLayout = createWorkspaceLayout(ui.workspace);
ui.ideas_toggle.addEventListener('click', () => setIdeasVisible(ui.ideas_panel.hidden, true));

function setIdeasVisible(visible, focus = false, remember = true) {
  if (!ideas || !snapshot || closingRequested) return;
  ui.ideas_panel.hidden = !visible;
  ui.ideas_toggle.setAttribute('aria-expanded', String(visible));
  if (remember) localStorage.setItem(ideaVisibilityKey, String(visible));
  if (focus) {
    if (visible) ideas.focus();
    else ui.ideas_toggle.focus();
  }
}

function attachIdeaLink(link) {
  if (!ideas || !snapshot || closingRequested) return;
  setIdeasVisible(true);
  ideas.attach(link);
}

async function openFile(file, { compare = false, anchor = null, ideaLink = false } = {}) {
  if (closingRequested || closed) return false;
  const version = ++navigationVersion;
  const current = cards.get(openedFile?.path);
  if (current?.autosave?.pending) {
    try {
      await current.autosave.flush();
    } catch {
      if (version === navigationVersion && !closed) navigator.select(current.file.path);
      return false;
    }
  }
  if (version !== navigationVersion || closingRequested || closed) return false;
  if (openedFile?.path === file.path && current) {
    navigator.select(file.path);
    current.pendingReviewAnchor = anchor;
    current.anchorFromIdea = ideaLink;
    current.reviewNotice.hidden = true;
    if (anchor) {
      current.modeVersion = (current.modeVersion ?? 0) + 1;
      const comparing = anchor.side === 'head';
      const markdownSource = comparing || anchor.line !== null;
      const modeChanged =
        current.comparing !== comparing ||
        current.reviewComparison ||
        (isMarkdown(file.path) && Boolean(current.markdownSource) !== markdownSource);
      current.markdownSource = markdownSource;
      current.comparing = comparing;
      if (current.reviewComparison && comparing && current.diffEditor) {
        current.reviewFocus.detach();
        current.diffEditor.updateOptions({
          ...diffAppearance(appearance.value, false),
          ...comparisonAriaLabels(current),
          hideUnchangedRegions: { enabled: false },
        });
      }
      current.reviewComparison = false;
      if (current.documentFailed) {
        current.dirty = true;
        scheduleDocument();
      } else if (modeChanged && current.document) renderDocument(current, current.document);
      else if (!current.loading) revealReviewAnchor(current);
      syncReviewState();
    } else if (compare) openComparison(current);
    return true;
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
  assistant?.setContext(Boolean(snapshot), file.path);
  const card = createCard(snapshot?.files.find(value => value.path === file.path) ?? file);
  card.pendingReviewAnchor = anchor;
  card.anchorFromIdea = ideaLink;
  if (anchor) {
    card.comparing = anchor.side === 'head';
    card.markdownSource = card.comparing || anchor.line !== null;
  }
  card.viewState = savedViews.get(file.path) ?? null;
  cards.set(file.path, card);
  card.active = true;
  ui.feed.replaceChildren(card.element);
  ideas?.refreshContext();
  ui.empty_state.hidden = true;
  document.getElementById('save-state').textContent = 'Autosave on';
  navigator.select(file.path);
  if (compare) openComparison(card);
  else syncReviewState();
  const outline = ui.navigator.querySelector('.navigator-outline .symbol-list');
  if (outline)
    outline.textContent = mediaType(file.path) ? 'No outline for media files' : 'Loading symbols…';
  scheduleDocument();
  return true;
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

function colorizeMarkdown(code, language) {
  const aliases = {
    js: 'javascript',
    ts: 'typescript',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    py: 'python',
  };
  return monaco.editor.colorize(code, aliases[language] ?? language, {});
}

async function openMarkdownTarget(target) {
  await openFile({ path: target.path });
  const next = cards.get(target.path);
  if (next) next.markdownAnchor = target.anchor;
}

function toggleNavigator() {
  if (!snapshot) return;
  setSidebarVisible(ui.sidebar.hidden);
}

function toggleReview() {
  if (!snapshot) return;
  reviewVisible = ui.sidebar.hidden || !reviewVisible;
  setSidebarVisible(true);
  if (reviewVisible) review.focus();
  else ui.navigator.querySelector('.navigator-tree').focus();
}

function setSidebarVisible(visible) {
  ui.sidebar.hidden = !visible;
  const showFiles = visible && !reviewVisible;
  if (showFiles !== !ui.navigator.hidden) navigator.toggle();
  const showReview = visible && reviewVisible;
  review.setVisible(showReview);
  ui.review_toggle.setAttribute('aria-pressed', String(showReview));
  ui.empty_state.querySelector('h2').textContent = showReview ? 'Open a comparison' : 'Open a file';
  ui.empty_state.querySelector('p').textContent = showReview
    ? 'Select a changed file from the review queue.'
    : 'Select a file in the explorer, or press ⌘P.';
}

function createCard(file) {
  const element = document.createElement('section');
  element.className = 'file-card';
  element.dataset.path = file.path;
  element.innerHTML = `<div class="file-header"><span class="file-icon">${icons.file}</span><div class="file-path"><span class="file-directory"></span><strong class="file-name"></strong></div><button class="diff-toggle change-button" type="button" aria-label="Compare whole file" aria-pressed="false" title="Compare whole file · changed functions" disabled><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9 3v12M4.5 7h2M5.5 6v2M11.5 10h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button><details class="symbol-outline"><summary title="Document symbols">Symbols</summary><div class="symbol-list"></div></details><button class="change-button" title="Next change" aria-label="Next change in file">${icons.down}</button></div><div class="file-note" hidden></div><div class="editor-host"><div class="editor-placeholder"><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span></div></div><div class="file-footer"><span class="line-count">Loading file…</span><span class="language-meta"><span class="language-state">Syntax</span><span class="file-language"></span></span></div>`;
  const labels = documentNode('div', 'comparison-labels', '');
  labels.hidden = true;
  labels.append(
    documentNode('span', 'comparison-original', 'HEAD'),
    documentNode('span', 'comparison-working', 'Working file'),
    documentNode('span', 'comparison-inline', 'HEAD → Working file · Inline'),
  );
  const reviewFocus = createReviewFocus({
    onScope: scope => {
      reviewScope = scope;
      element.dataset.reviewScope = scope;
    },
  });
  element.querySelector('.editor-host').before(labels);
  labels.before(reviewFocus.bar);
  const reviewNotice = documentNode('div', 'file-note', '');
  reviewNotice.hidden = true;
  reviewNotice.setAttribute('role', 'status');
  element.querySelector('.file-note').after(reviewNotice);
  const card = {
    file,
    element,
    reviewFocus,
    reviewNotice,
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
    comparing: false,
    textBytes: 0,
  };
  const slash = file.path.lastIndexOf('/');
  element.querySelector('.file-directory').textContent = file.path.slice(0, slash + 1);
  element.querySelector('.file-name').textContent = file.path.slice(slash + 1);
  element.querySelector('.file-path').title = file.path;
  if (ideas) {
    const ideaButton = documentNode('button', 'change-button file-idea-link', '');
    ideaButton.type = 'button';
    ideaButton.title = 'Attach selection or visible lines to an idea';
    ideaButton.setAttribute('aria-label', 'Attach current view to an idea');
    ideaButton.innerHTML = icons.idea;
    ideaButton.addEventListener('click', () => attachIdeaLink(captureIdeaLink(card)));
    element.querySelector('.diff-toggle').after(ideaButton);
  }
  element.querySelector('[aria-label="Next change in file"]').addEventListener('click', () => {
    if (!card.editor || card.changes.length === 0) return;
    card.changeIndex = (card.changeIndex + 1) % card.changes.length;
    card.editor.revealLineInCenter(
      card.changes[card.changeIndex],
      reducedMotion.matches ? monaco.editor.ScrollType.Immediate : monaco.editor.ScrollType.Smooth,
    );
  });
  if (reviewNotes) {
    const noteButton = documentNode('button', 'change-button file-review-note', '');
    noteButton.type = 'button';
    noteButton.title = 'Add file review note';
    noteButton.setAttribute('aria-label', 'Add review note for this file');
    noteButton.innerHTML = icons.note;
    noteButton.addEventListener('click', () => {
      if (!closingRequested) reviewNotes.openComposer(captureReviewAnchor(card, 'working', false));
    });
    element.querySelector('.diff-toggle').after(noteButton);
  }
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
        await changeDocumentMode(card, () => {
          if (Boolean(card.markdownSource) === source) return false;
          card.markdownSource = source;
          card.pendingReviewAnchor = null;
          if (!source) {
            card.comparing = false;
            card.reviewComparison = false;
          }
          return true;
        });
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
  if (closed) return;
  if (!next) {
    if (!snapshot) showStartScreen();
    return;
  }
  if (next.error) {
    showError(next.error);
    return;
  }
  if (snapshot && Number.isFinite(next.revision) && next.revision < snapshot.revision) return;
  const first = !snapshot;
  const allDirty =
    !next.changedPaths || next.changedPaths.includes('*') || next.root !== snapshot?.root;
  snapshot = next;
  assistant?.setContext(true, openedFile?.path ?? null);
  ui.start_screen.hidden = true;
  ui.feed_scroll.hidden = false;
  if (first) {
    setSidebarVisible(true);
    ui.review_toggle.hidden = false;
    reviewNotes?.setContext(true);
    if (ideas) {
      ui.ideas_toggle.hidden = false;
      setIdeasVisible(localStorage.getItem(ideaVisibilityKey) !== 'false', false, false);
      void ideas.load();
    }
    document.querySelector('.branch').hidden = false;
    document.querySelector('.statusbar-end').hidden = false;
  }
  navigator.update(next);
  review.update(next.files);
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
    const file = card && next.files.find(file => file.path === card.file.path);
    if (
      card &&
      (allDirty ||
        file?.reviewVersion !== card.file.reviewVersion ||
        next.changedPaths.some(
          path => card.file.path === path || card.file.path.startsWith(`${path}/`),
        ))
    ) {
      card.file = file ?? { path: card.file.path };
      card.dirty = true;
      scheduleDocument();
    }
  }
  syncReviewState();
  ui.status_text.textContent = `${next.files.length.toLocaleString()} changed ${next.files.length === 1 ? 'file' : 'files'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function loadDocument(card) {
  if (card.loading || !card.active || closed || card.autosave?.pending) return;
  card.loading = true;
  card.dirty = false;
  card.documentFailed = false;
  syncReviewState();
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
      card.documentFailed = true;
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
      if (card.pendingReviewAnchor) {
        card.pendingReviewAnchor = null;
        if (card.anchorFromIdea) ideas?.notify('The linked file could not be opened.');
        else reviewNotes?.notify('The saved note’s file could not be opened.');
      }
    }
  } finally {
    card.loading = false;
    card.element.classList.remove('is-loading');
    if (card.active) syncReviewState();
    scheduleDocument();
    startBackgroundAnalysis();
  }
}

function editorOptions(card) {
  const readOnly = editorReadOnly(card);
  return {
    model: card.model,
    ...codeAppearance(appearance.value),
    readOnly,
    domReadOnly: readOnly,
    fontLigatures: false,
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
  card.document = document;
  const preview = document.preview;
  const reading = !preview && isMarkdown(card.file.path) && !card.markdownSource;
  const text = document.after ?? '';
  const reusableMarkdown = reading && card.markdownCleanup && text === card.markdownText;
  card.note.textContent =
    (!preview &&
      (document.note ||
        document.diffNote ||
        (!text && (card.file.worktree === 'D' || card.file.index === 'D')
          ? 'This file was deleted. There are no current contents.'
          : ''))) ||
    '';
  card.note.hidden = !card.note.textContent;
  card.note.classList.remove('is-error');
  card.host.classList.remove('has-error');
  if (reusableMarkdown) {
    revealReviewAnchor(card);
    return;
  }
  card.functionEpoch = (card.functionEpoch ?? 0) + 1;
  card.mediaCleanup?.();
  card.mediaCleanup = null;
  card.markdownCleanup?.();
  card.markdownCleanup = null;
  const modes = card.element.querySelector('.markdown-toggle');
  if (modes) {
    modes.hidden = Boolean(preview);
    for (const button of modes.querySelectorAll('button'))
      button.setAttribute('aria-pressed', String((button.textContent === 'Preview') === reading));
  }
  for (const control of card.element.querySelectorAll('.symbol-outline, .language-state'))
    control.hidden = Boolean(preview) || reading;
  card.element.querySelector('[aria-label="Next change in file"]').hidden =
    Boolean(preview) || reading || Boolean(card.reviewComparison);
  const button = card.element.querySelector('.diff-toggle');
  button.disabled = false;
  button.hidden = false;
  button.setAttribute('aria-pressed', String(card.comparing));
  button.setAttribute('aria-label', card.comparing ? 'Show current file' : 'Compare whole file');
  button.title = card.comparing ? 'Show current file' : 'Compare whole file · changed functions';
  card.element.dataset.diff = String(card.comparing);
  card.element.querySelector('.comparison-labels').hidden = !card.comparing || Boolean(preview);
  if (preview) {
    globalThis.document.getElementById('save-state').textContent = 'Read only';
    releaseEditor(card);
    howmany.clearFile(card);
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list');
    if (outline) outline.textContent = 'No outline for this file';
    card.lines.textContent = `${preview.after.size.toLocaleString()} bytes`;
    card.language.textContent =
      preview.after.kind === 'binary' ? 'Binary' : preview.after.kind.toUpperCase();
    card.mediaCleanup = showDocumentPreview(
      card.host,
      preview,
      card.file.path,
      card.comparing,
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
    revealReviewAnchor(card);
    return;
  }
  const state = card.editor?.saveViewState();
  const lineCount = document.lineCount ?? countLines(text);
  if (reading) {
    releaseEditor(card);
    howmany.clearFile(card);
    globalThis.document.getElementById('save-state').textContent = 'Read only';
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
      onOpenFile: openMarkdownTarget,
      colorize: colorizeMarkdown,
    });
    card.markdownAnchor = null;
    card.markdownText = text;
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list');
    if (outline) showMarkdownOutline(card, outline);
    revealReviewAnchor(card);
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
  if (!card.model) {
    const root = snapshot.root.replaceAll('\\', '/').replace(/\/$/, '');
    const uri = monaco.Uri.file(`${root}/${card.file.path}`);
    card.model = monaco.editor.createModel(text, undefined, uri);
    monaco.editor.setModelLanguage(card.model, syntax.resolve(card.model, text));
    card.model.detectIndentation(true, 2);
    card.autosave = new Autosave(
      text,
      (value, expected) => api.save(card.file.path, value, expected),
      (state, error) => {
        if (!card.active) return;
        card.saveStatus = state;
        card.saveError = state === 'error' ? error?.message || String(error) : null;
        updateSaveLabel(card);
        if (state === 'error') showError(error?.message || error);
        if (state === 'saved') {
          if (!snapshot?.watchError) clearError();
          card.dirty = true;
          scheduleDocument();
        }
        syncSaveState();
      },
    );
    card.contentCleanup = card.model.onDidChangeContent(() => {
      if (card.applyingDocument || !card.document.editable) return;
      card.editVersion = (card.editVersion ?? 0) + 1;
      card.text = card.model.getValue(undefined, true);
      card.document = { ...card.document, after: card.text };
      card.autosave.edit(card.text);
      syncSaveState();
    });
    setCardEditor(card, card.viewState);
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
  if (Boolean(card.diffEditor) !== card.comparing) setCardEditor(card, card.editor.saveViewState());
  card.text = text;
  card.autosave.accept(text);
  applyEditorReadOnly(card);
  updateSaveLabel(card);
  card.textBytes = text.length * 2 + (card.originalModel ? (document.before?.length ?? 0) * 2 : 0);
  if (card.originalModel && card.originalText !== document.before) {
    const originalState = card.diffEditor.getOriginalEditor().saveViewState();
    card.originalModel.setValue(document.before ?? '');
    card.originalText = document.before;
    if (originalState) card.diffEditor.getOriginalEditor().restoreViewState(originalState);
  }
  if (card.reviewComparison && card.diffEditor) {
    if (!card.dirty && card.file.reviewVersion === document.reviewVersion) {
      card.element.dataset.reviewScope = reviewScope;
      card.reviewFocus.attach(card.diffEditor, reviewScope, comparisonAriaLabels(card));
    }
  } else delete card.element.dataset.reviewScope;
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
  card.element.querySelector('[aria-label="Next change in file"]').disabled =
    card.changes.length === 0;
  card.lines.textContent = `${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'}`;
  const language = card.model.getLanguageId();
  card.language.textContent =
    monaco.languages.getLanguages().find(value => value.id === language)?.aliases?.[0] ?? language;
  (card.diffEditor ?? card.editor).layout();
  card.editor.render(true);
  revealReviewAnchor(card);
  howmany.updateFile(card, document);
  if (card.diffEditor) void highlightFunctions(card);
  else card.changedFunctions = 0;
  if (card.element.querySelector('.symbol-outline').open) void showSymbols(card);
  const outline = ui.navigator.querySelector('.navigator-outline[open] .symbol-list');
  if (outline) void showSymbols(card, outline);
}

function selectionLines(selection) {
  const line = selection.startLineNumber;
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > line
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  return { line, endLine };
}

function captureIdeaLink(card, side = card.ideaSide ?? 'working') {
  const editor = side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor;
  const model = editor?.getModel();
  const path = card.file.path;
  if (!model) return { path };
  const selection = editor.getSelection();
  let lines;
  if (selection && !selection.isEmpty()) lines = selectionLines(selection);
  else {
    // In a focused diff, a viewport can contain several noncontiguous ranges.
    const [visible] = editor.getVisibleRanges();
    if (!visible) return { path, side };
    const line = visible.startLineNumber;
    lines = { line, endLine: Math.min(visible.endLineNumber, line + 23) };
  }
  const { line, endLine } = lines;
  return { path, side, ...lines, ...captureReviewLines(model, line, endLine) };
}

function captureReviewAnchor(card, side, includeLines = true) {
  const original = side === 'head';
  const editor = original ? card.diffEditor?.getOriginalEditor() : card.editor;
  const model = includeLines ? editor?.getModel() : null;
  const selection = model ? editor.getSelection() : null;
  const root = snapshot.root.replace(/\/$/u, '');
  const scope = snapshot.scope ?? snapshot.root;
  const inScope = path => `${root}/${path}`.startsWith(`${scope.replace(/\/$/u, '')}/`);
  let pathname = card.file.path;
  const originalPath = original ? card.file.originalPath : null;
  if (!inScope(pathname)) {
    if (!originalPath || !inScope(originalPath)) return null;
    pathname = originalPath;
  }
  const anchor = {
    path: pathname,
    ...(originalPath && originalPath !== pathname ? { originalPath } : {}),
    side,
    line: null,
    endLine: null,
    excerpt: '',
    truncated: false,
  };
  if (!selection) return anchor;
  const { line, endLine } = selectionLines(selection);
  return { ...anchor, line, endLine, ...captureReviewLines(model, line, endLine) };
}

function revealReviewAnchor(card) {
  const anchor = card.pendingReviewAnchor;
  if (!anchor || !card.document || card.dirty) return;
  card.pendingReviewAnchor = null;
  if (anchor.line === null) return;
  const editor = anchor.side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor;
  const model = editor?.getModel();
  if (!model) {
    showReviewLocation(card, 'The saved lines are unavailable in the current file view.');
    return;
  }
  const location = locateReviewLines(model, anchor);
  if (location.state === 'stale') {
    editor.setPosition({ lineNumber: location.line, column: 1 });
    showReviewLocation(card, 'The captured lines changed. Showing the nearest saved line.');
  } else {
    const range = new monaco.Range(
      location.line,
      1,
      location.endLine,
      model.getLineMaxColumn(location.endLine),
    );
    editor.setSelection(range);
    if (location.state === 'moved') {
      const message = `The captured lines moved to line ${location.line.toLocaleString()}.`;
      showReviewLocation(card, message);
    }
  }
  editor.revealLineInCenter(location.line, monaco.editor.ScrollType.Immediate);
}

function showReviewLocation(card, message) {
  if (card.anchorFromIdea && !ui.ideas_panel.hidden) ideas?.notify(message);
  else if (card.anchorFromIdea || ui.review_notes_panel.hidden) {
    card.reviewNotice.hidden = false;
    card.reviewNotice.textContent = message;
  } else reviewNotes?.notify(message);
}

function updateSaveLabel(card) {
  const labels = { saving: 'Saving…', error: 'Save failed · ⌘S to retry', saved: 'Saved' };
  document.getElementById('save-state').textContent =
    labels[card.saveStatus] && card.autosave?.pending
      ? labels[card.saveStatus]
      : !card.document.editable
        ? 'Read only'
        : labels[card.saveStatus] || 'Autosave on';
}

async function changeDocumentMode(card, change) {
  const intent = (card.modeVersion ?? 0) + 1;
  card.modeVersion = intent;
  if (closingRequested || !card.document) return;
  try {
    if (card.autosave?.pending) await card.autosave.flush();
  } catch {
    return;
  }
  if (!card.active || closingRequested || intent !== card.modeVersion || !change()) return;
  renderDocument(card, card.document);
  syncReviewState();
}

function toggleDiff(card) {
  const comparing = !card.comparing;
  return changeDocumentMode(card, () => {
    card.pendingReviewAnchor = null;
    card.comparing = comparing;
    if (comparing) card.markdownSource = true;
    else card.reviewComparison = false;
    return true;
  });
}

function openComparison(card) {
  card.modeVersion = (card.modeVersion ?? 0) + 1;
  if (!card.reviewComparison || !card.comparing) {
    card.reviewComparison = true;
    card.diffEditor?.updateOptions({
      ...diffAppearance(appearance.value, true),
      ...comparisonAriaLabels(card),
    });
    card.comparing = true;
    card.markdownSource = true;
    if (card.document && !card.documentFailed) {
      renderDocument(card, card.document);
    }
  }
  if (card.documentFailed) {
    card.dirty = true;
    scheduleDocument();
  }
  syncReviewState();
}

function comparisonAriaLabels(card) {
  return {
    originalAriaLabel: `HEAD contents of ${card.file.originalPath || card.file.path}`,
    modifiedAriaLabel: `Working contents of ${card.file.path}`,
  };
}

function setCardEditor(card, state) {
  for (const action of card.contextActions ?? []) action.dispose();
  card.languageCleanup?.();
  card.languageCleanup = null;
  if (card.diffEditor) {
    card.reviewFocus.detach();
    card.diffEditor.setModel(null);
    card.diffEditor.dispose();
    card.diffEditor = null;
    card.originalModel.dispose();
    card.originalModel = null;
    card.originalDecorations = null;
    card.functionDecorations = null;
  } else if (card.editor) {
    card.editor.setModel(null);
    card.editor.dispose();
  }
  card.host.replaceChildren();
  if (card.comparing) {
    card.originalText = card.document.before ?? '';
    card.originalModel = monaco.editor.createModel(
      card.originalText,
      card.model.getLanguageId(),
      card.model.uri.with({ query: 'diffpane-original' }),
    );
    card.diffEditor = monaco.editor.createDiffEditor(card.host, {
      ...editorOptions(card),
      ...diffAppearance(appearance.value, Boolean(card.reviewComparison)),
      ...comparisonAriaLabels(card),
      model: undefined,
      originalEditable: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      hideUnchangedRegions: { enabled: false },
      maxComputationTime: 150,
      maxFileSize: 2,
      enableSplitViewResizing: true,
    });
    card.diffEditor.setModel({ original: card.originalModel, modified: card.model });
    card.editor = card.diffEditor.getModifiedEditor();
    const originalEditor = card.diffEditor.getOriginalEditor();
    card.diffEditor.updateOptions(comparisonAriaLabels(card));
    const labels = card.element.querySelector('.comparison-labels');
    const syncLabelWidth = ({ width }) =>
      labels.style.setProperty('--original-width', `${width}px`);
    syncLabelWidth(originalEditor.getLayoutInfo());
    originalEditor.onDidLayoutChange(syncLabelWidth);
    card.originalDecorations = originalEditor.createDecorationsCollection();
    card.functionDecorations = card.editor.createDecorationsCollection();
  } else card.editor = monaco.editor.create(card.host, editorOptions(card));
  card.noteSide = 'working';
  card.ideaSide = 'working';
  if (reviewNotes || ideas) {
    card.contextActions = [];
    const bindContext = (editor, side) => {
      card.contextActions.push(
        editor.onDidFocusEditorText(() => {
          card.noteSide = side;
          card.ideaSide = side;
        }),
      );
      if (reviewNotes)
        card.contextActions.push(
          editor.addAction({
            id: `diffpane-add-review-note-${side}`,
            label: 'Add review note',
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 20,
            run: () => {
              if (!closingRequested) reviewNotes.openComposer(captureReviewAnchor(card, side));
            },
          }),
        );
      if (ideas) {
        const surface = editor.getDomNode();
        const selectSide = () => {
          card.ideaSide = side;
        };
        surface?.addEventListener('wheel', selectSide, { passive: true });
        card.contextActions.push(
          { dispose: () => surface?.removeEventListener('wheel', selectSide) },
          editor.onMouseDown(selectSide),
          editor.addAction({
            id: `diffpane-attach-idea-${side}`,
            label: 'Attach selection or view to an idea',
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 21,
            run: () => attachIdeaLink(captureIdeaLink(card, side)),
          }),
        );
      }
    };
    bindContext(card.editor, 'working');
    if (card.diffEditor) bindContext(card.diffEditor.getOriginalEditor(), 'head');
  }
  card.decorationCollection = card.editor.createDecorationsCollection();
  card.languageCleanup = languageFeatures.attach(card.editor, card.model, card.file.path, {
    active: true,
  });
  if (state) card.editor.restoreViewState(state);
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
  for (const action of card.contextActions ?? []) action.dispose();
  card.contextActions = [];
  card.noteSide = 'working';
  card.ideaSide = 'working';
  card.contentCleanup?.dispose();
  card.contentCleanup = null;
  card.autosave = null;
  card.viewState = card.editor.saveViewState();
  card.languageCleanup?.();
  card.languageCleanup = null;
  card.element.querySelector('.symbol-outline').open = false;
  card.reviewFocus.detach();
  delete card.element.dataset.reviewScope;
  if (card.diffEditor) card.diffEditor.dispose();
  else card.editor.dispose();
  card.originalModel?.dispose();
  card.originalModel = null;
  card.originalText = null;
  card.originalDecorations = null;
  card.functionDecorations = null;
  card.changedFunctions = 0;
  card.diffEditor = null;
  card.functionEpoch = (card.functionEpoch ?? 0) + 1;
  card.model.dispose();
  card.editor = null;
  card.model = null;
  card.decorationCollection = null;
  card.textBytes = 0;
  card.text = null;
  card.saveStatus = null;
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''));
}

function showError(error) {
  if (!snapshot) showStartScreen(true);
  ui.message.textContent = String(error);
  ui.message.hidden = false;
}

function clearError() {
  ui.message.hidden = true;
}

async function refresh() {
  if (!snapshot) return;
  try {
    const result = await api.refresh();
    if (result?.files) applySnapshot(result);
  } catch (error) {
    showError(error.message || error);
  }
}

document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (settings.isOpen || document.querySelector('#claude-settings')?.open) return;
  if (document.querySelector('#file-picker')?.open) {
    if (event.key.toLowerCase() === 'p') {
      event.preventDefault();
      void openFilePicker();
    }
    return;
  }
  if (
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'j' &&
    reviewNotes &&
    snapshot
  ) {
    event.preventDefault();
    if (!event.repeat) ui.review_notes_toggle.click();
    return;
  }
  if (event.shiftKey && !event.altKey && event.key.toLowerCase() === 'g' && snapshot) {
    event.preventDefault();
    if (!event.repeat) toggleReview();
    return;
  }
  if (event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l' && assistant) {
    event.preventDefault();
    if (!event.repeat) assistant.toggle();
    return;
  }
  if (event.shiftKey && !event.altKey && event.key.toLowerCase() === 'i' && ideas && snapshot) {
    event.preventDefault();
    if (!event.repeat) ui.ideas_toggle.click();
    return;
  }
  if (event.key.toLowerCase() === 'b') {
    event.preventDefault();
    toggleNavigator();
  }
  if (event.key.toLowerCase() === 'p') {
    event.preventDefault();
    if (snapshot) void openFilePicker();
    else void chooseTarget('file');
  }
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (snapshot) void openFilePicker();
    else void chooseTarget('file');
  }
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    void refresh();
  }
  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (ideas && ui.ideas_panel.contains(event.target)) {
      void ideas.flush().catch(() => {});
      return;
    }
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

const unsubscribeSettings = api?.onOpenSettings(openSettings);

if (!api) showError('The desktop connection is unavailable. Reopen diffpane from your terminal.');
else {
  const resumeEditing = () => {
    closingRequested = false;
    ideas?.setReadOnly(false);
    for (const card of cards.values()) applyEditorReadOnly(card);
    syncReviewState();
  };
  const unsubscribeResume = api.onResumeEditing(resumeEditing);
  const unsubscribeFlush = api.onFlushSaves(async () => {
    closingRequested = true;
    ideas?.setReadOnly(true);
    for (const card of cards.values()) applyEditorReadOnly(card);
    syncReviewState();
    try {
      await Promise.all([
        ...[...cards.values()].map(card => card.autosave?.flush()),
        applyingAssistantEdit?.catch(() => {}),
        ideas?.flush(),
      ]);
      syncSaveState();
      api.savesFlushed(true);
    } catch {
      resumeEditing();
      api.savesFlushed(false);
    }
  });
  const unsubscribeIdeas = api.ideas?.onChange(change => ideas?.applyChange(change));
  api.rendererReady();
  const unsubscribePaths = subscribeLivePaths(api, paths => {
    const card = cards.get(openedFile?.path);
    if (
      card &&
      paths.some(
        path => path === '*' || card.file.path === path || card.file.path.startsWith(`${path}/`),
      )
    ) {
      card.dirty = true;
      syncReviewState();
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
      assistant?.dispose();
      reviewNotes?.dispose();
      workspaceLayout.dispose();
      unsubscribeIdeas?.();
      ideas?.reset();
      if (snapshotFrame !== null) cancelAnimationFrame(snapshotFrame);
      if (documentFrame !== null) cancelAnimationFrame(documentFrame);
      navigator.dispose();
      review.dispose();
      unsubscribePaths();
      appearance.dispose();
      unsubscribeSettings?.();
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

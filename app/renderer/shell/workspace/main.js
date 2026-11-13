// MONOLITHIC: The renderer composition root coordinates card selection, editor lifetime, save flushing and workspace updates. Extract the card controller once it owns these transitions through a verified interface.
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/basic-languages/monaco.contribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
// oxlint-disable-next-line import/default -- Vite generates the worker constructor for ?worker imports.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { colorHex } from '../../../shared/appearance/palette.ts'
import { mediaType } from '../../../shared/documents/media-types.ts'
import {
  ariaBinding,
  bindingFromEvent,
  bindingKeys,
  defaultBinding,
  effectiveBinding,
  isShortcutAction,
  matchesBinding,
} from '../../../shared/preferences/shortcuts.ts'
import { appError, attempt, attemptAsync } from '../../../shared/recovery/app-errors.ts'
import './style.css'
import '../recovery/loading.css'
import { captureReviewLines, locateReviewLines } from '../../../shared/review/review-notes.ts'
import { showDocumentPreview } from '../../editor/documents/document-preview.ts'
import { editorThemeName } from '../../editor/highlighting/editor-themes.ts'
import { configureSyntax } from '../../editor/highlighting/syntax.ts'
import { createLanguageFeatures } from '../../editor/languages/languages.js'
import { isMarkdown } from '../../editor/markdown/markdown-paths.ts'
import { recolorMarkdownPreviews, showMarkdownPreview } from '../../editor/markdown/markdown-preview.ts'
import { Autosave } from '../../editor/updates/autosave.ts'
import { LivePathBatch, subscribeLivePaths } from '../../editor/updates/live-updates.ts'
import { createFilePicker } from '../../explorer/file-picker/files.ts'
import { createContentSearch } from '../../explorer/project-search/content-search.ts'
import { createNavigator } from '../../explorer/tree/navigator.js'
import { createHowMany } from '../../panels/analysis/howmany.js'
import { codeAppearance, createAppearanceSettings, diffAppearance } from '../../panels/appearance/appearance.ts'
import { createAssistant } from '../../panels/assistant/assistant.js'
import { creatureGlyph } from '../../panels/assistant/creature-glyph.ts'
import { mountIdeaBuilder } from '../../panels/ideas/ideas.ts'
import { createSettings } from '../../panels/settings/settings.js'
import '../../editor/documents/document-preview.css'
import '../../explorer/tree/navigator.css'
import { changedFunctionRanges } from '../../review/comparison/function-ranges.ts'
import { createReviewFocus } from '../../review/comparison/review-focus.js'
import { createReviewNotes } from '../../review/notes/review-notes.ts'
import { createChangeReview } from '../../review/queue/change-review.js'
import { rendererDiagnostics } from '../diagnostics/diagnostics.ts'
import { projectIcon } from '../layout/icons.ts'
import { createWorkspaceLayout } from '../layout/workspace-layout.ts'
import { clearErrorNotice, guard, renderFailure, reportError, runTask, setErrorNoticeHost } from '../recovery/errors.ts'
import { waitForWorkspaceOpeningPeeks } from '../recovery/workspace-opening.ts'
import { requireElement } from './dom.js'
import { getWorkspacePreferences } from './preferences.ts'

/** @import { WorkspaceComparison, WorkspaceDocument, WorkspaceFile, WorkspaceSnapshot } from '../../../electron/runtime/session/workspace-types.ts' */
/** @import { IdeaLink } from '../../../shared/ideas/ideas.ts' */
/** @import { ReviewAnchor } from '../../../shared/review/review-notes.ts' */
/** @import { ShortcutAction, ShortcutOverrides } from '../../../shared/preferences/shortcuts.ts' */
/** @import { ContentMatch } from '../../explorer/project-search/content-search.ts' */
/** @import { ReviewScope } from '../../review/comparison/review-focus.js' */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.IStandaloneCodeEditor} CodeEditor */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.ITextModel} TextModel */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.ICodeEditorViewState} ViewState */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.IEditorDecorationsCollection} EditorDecorations */
/** @typedef {import('monaco-editor/editor/editor.api.js').IDisposable} Disposable */
/** @typedef {'head' | 'working'} EditorSide */
/** @typedef {WorkspaceFile & {anchor?: string}} OpenFile */
/** @typedef {Omit<ReviewAnchor, 'side' | 'truncated'> & {side?: EditorSide, truncated?: boolean, direct?: boolean}} FileAnchor */
/** @typedef {{compare?: boolean, comparison?: WorkspaceComparison, review?: boolean, source?: boolean, match?: ContentMatch | null, anchor?: FileAnchor | null, ideaLink?: boolean}} OpenOptions */
/**
 * @typedef {object} Card
 * @property {OpenFile} file
 * @property {HTMLElement} element
 * @property {ReturnType<typeof createReviewFocus>} reviewFocus
 * @property {HTMLElement} reviewNotice
 * @property {HTMLElement} host
 * @property {HTMLElement} note
 * @property {HTMLElement} errors
 * @property {HTMLButtonElement} nextChange
 * @property {HTMLElement} lines
 * @property {HTMLElement} language
 * @property {(() => void) | null} languageCleanup
 * @property {Parameters<typeof updateLanguageState>[0] | null} languageState
 * @property {CodeEditor | null} editor
 * @property {TextModel | null} model
 * @property {EditorDecorations | null} decorationCollection
 * @property {ViewState | null} viewState
 * @property {boolean} dirty
 * @property {boolean} active
 * @property {boolean} loading
 * @property {number} openedAt
 * @property {number} generation
 * @property {number[]} changes
 * @property {number} changeIndex
 * @property {boolean} comparing
 * @property {WorkspaceComparison} comparison
 * @property {number} textBytes
 * @property {WorkspaceDocument | null} [document]
 * @property {WorkspaceComparison} [renderedComparison]
 * @property {boolean} [reviewComparison]
 * @property {boolean} [documentFailed]
 * @property {boolean} [anchorFromIdea]
 * @property {FileAnchor | null} [pendingReviewAnchor]
 * @property {ContentMatch | null} [pendingMatch]
 * @property {{type: string, url: string} | null} [currentMedia]
 * @property {boolean} [previewRaw]
 * @property {(() => void) | null} [mediaCleanup]
 * @property {(() => void) | null} [markdownCleanup]
 * @property {string | null} [markdownAnchor]
 * @property {string} [markdownText]
 * @property {number} [markdownScroll]
 * @property {number[]} [markdownDiagramHeights]
 * @property {boolean} [markdownSource]
 * @property {boolean} [applyingDocument]
 * @property {boolean} [restoreErrorFocus]
 * @property {HTMLElement | null} [errorBoundary]
 * @property {number} [functionEpoch]
 * @property {number} [changedFunctions]
 * @property {number} [modeVersion]
 * @property {number} [editVersion]
 * @property {string | null} [text]
 * @property {TextModel | null} [originalModel]
 * @property {string | null} [originalText]
 * @property {EditorDecorations | null} [originalDecorations]
 * @property {EditorDecorations | null} [functionDecorations]
 * @property {import('monaco-editor/editor/editor.api.js').editor.IStandaloneDiffEditor | null} [diffEditor]
 * @property {import('monaco-editor/editor/editor.api.js').editor.IContextKey<boolean> | null} [headContext]
 * @property {EditorSide} [ideaSide]
 * @property {EditorSide} [noteSide]
 * @property {Disposable[]} [contextActions]
 * @property {Disposable | null} [contentCleanup]
 * @property {Autosave | null} [autosave]
 * @property {string | null} [saveStatus]
 * @property {import('../../../shared/recovery/app-errors.ts').AppError | null} [saveError]
 */

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() }

const syntax = configureSyntax(monaco)

const icons = {
  mark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3.5" fill="currentColor" opacity=".06"/><path d="M12 4v16" stroke="currentColor" opacity=".2"/><rect x="3" y="4" width="18" height="16" rx="3.5" stroke="currentColor" stroke-width="1.2" opacity=".5"/><path d="M6 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".55"/><path d="M15 15h3m-1.5-1.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  branch:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3" r="1.7" stroke="currentColor"/><circle cx="4" cy="13" r="1.7" stroke="currentColor"/><circle cx="12" cy="3" r="1.7" stroke="currentColor"/><path d="M4 5v6m8-6v1a4 4 0 0 1-4 4H4" stroke="currentColor" stroke-width="1.2"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10m-4-4 4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.35"/><path d="m10 10 3.5 3.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  review:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5h5.5M8 10h5.5"/><path class="review-idle-mark" d="m2 5 1.25 1.25L5.5 4M2 10l1.25 1.25L5.5 9"/><path class="review-pending-mark" d="M2 5h3.5M2 10h3.5M3.75 8.25v3.5"/></svg>',
  note: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 2.5h9a1 1 0 0 1 1 1v6L9.5 13.5h-6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.5 13.5v-3a1 1 0 0 1 1-1h3M5 5.5h6M5 8h3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  settings:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 1.5-.3 1.7-1.1.6-1.6-.6-1.5 2.6 1.3 1.1v1.2L2 9.2l1.5 2.6 1.6-.6 1.1.6.3 1.7h3l.3-1.7 1.1-.6 1.6.6L14 9.2l-1.3-1.1V6.9L14 5.8l-1.5-2.6-1.6.6-1.1-.6-.3-1.7z"/><circle cx="8" cy="7.5" r="2"/></svg>',
  idea: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="2.5" width="11.5" height="13" rx="2"/><path d="M7 2.5v13M2 6h3m-3 6h3m4.5-5h3m-3 3h2"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.3l-3.5-3.5Z" stroke="currentColor" stroke-width="1.15"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.15"/></svg>',
  folder:
    '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5 12a4 4 0 0 1 4-4h10l5 5h15a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V12Z" fill="currentColor" opacity=".22"/><path d="M5 19a4 4 0 0 1 4-4h30a4 4 0 0 1 4 4v17a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V19Z" fill="currentColor" opacity=".72"/><path d="M9 15h30a4 4 0 0 1 4 4v1H5v-1a4 4 0 0 1 4-4Z" fill="white" opacity=".12"/><path d="M10 33h12" stroke="white" stroke-opacity=".3" stroke-width="1.5" stroke-linecap="round"/></svg>',
}

const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'))
const workspaceOpening = document.getElementById('workspace-opening')
app.innerHTML = `
  <header class="titlebar">
    <div class="brand" role="img" aria-label="diffpane"><span class="brand-mark">${icons.mark}</span></div>
    <span class="title-divider"></span>
    <div class="project"><span id="project-name">Diffpane</span><span id="project-path"></span></div>
    <span class="branch" hidden>${icons.branch}<span id="branch-name"></span></span>
    <div class="titlebar-actions">
      <button type="button" id="ideas-toggle" class="titlebar-button" aria-controls="ideas-panel" aria-expanded="false" hidden>${icons.idea}<span>Ideas</span></button>
      <button type="button" id="content-search-toggle" class="titlebar-button" aria-label="Search in project" aria-haspopup="dialog" aria-controls="content-search" hidden>${icons.search}<span>Search</span></button>
      <button type="button" id="review-toggle" class="titlebar-button" aria-label="Review changes" aria-controls="change-review" aria-pressed="false" data-pending="false" hidden>${icons.review}<span>Changes</span></button>
      <button type="button" id="review-notes-toggle" class="titlebar-button" aria-label="Review notes" aria-controls="review-notes-panel" aria-expanded="false" hidden>${icons.note}<span>Notes</span><span class="review-notes-count" aria-hidden="true" hidden></span></button>
      <button type="button" id="claude-toggle" class="titlebar-button" aria-label="The Creature" aria-controls="claude-panel" aria-expanded="false" hidden>${creatureGlyph}<span>The Creature</span></button>
      <button type="button" id="settings-toggle" class="titlebar-button" aria-label="Settings" aria-haspopup="dialog" aria-controls="app-settings" hidden>${icons.settings}</button>
    </div>
  </header>
  <div class="workspace-notices" id="workspace-notices"></div>
  <div class="workspace" id="workspace">
    <aside id="ideas-panel" hidden></aside>
    <div id="sidebar" hidden>
      <aside id="navigator" hidden></aside>
      <aside id="change-review" hidden></aside>
    </div>
    <section class="workbench" tabindex="-1" aria-label="Code workspace">
  <main class="start-screen" id="start-screen" aria-labelledby="start-title" aria-busy="true">
    <div class="start-content">
      <span class="workspace-art start-mark" aria-hidden="true">
        <span class="workspace-art__tile workspace-art__tile--left">${icons.folder}</span>
        <span class="workspace-art__tile workspace-art__tile--right">${icons.file}</span>
        <span class="workspace-art__tile workspace-art__tile--main">${icons.mark}</span>
      </span>
      <h1 id="start-title">Welcome to Diffpane</h1>
      <p id="start-description">Open a file or folder in a Git working tree to get started.</p>
      <div id="start-error" hidden></div>
      <div class="start-actions" id="start-actions" hidden>
        <button type="button" id="open-folder">Open Folder…</button>
        <button type="button" id="open-file">Open File…</button>
      </div>
      <section class="recent-targets" id="recent-targets" aria-labelledby="recent-title" hidden>
        <h2 id="recent-title">Recently opened</h2>
        <ul class="recent-list" id="recent-list"></ul>
        <p id="recent-status" role="status" hidden></p>
      </section>
    </div>
  </main>
  <main class="feed-scroll" id="feed-scroll" hidden>
    <div class="feed" id="feed"></div>
    <div class="empty-state" id="empty-state">
      <span class="workspace-art empty-symbol" aria-hidden="true">
        <span class="workspace-art__tile workspace-art__tile--right">${icons.mark}</span>
        <span class="workspace-art__tile workspace-art__tile--main">${icons.file}</span>
      </span>
      <h2>Open a file</h2>
      <p>Select a file in the explorer.</p>
    </div>
  </main>
  </section>
    <aside id="claude-panel" hidden></aside>
    <aside id="review-notes-panel" hidden></aside>
  </div>
  <footer class="statusbar"><span id="status-text">Opening workspace…</span><span class="statusbar-end" hidden><span class="current-only">Current file contents</span><span class="status-dot"></span><span id="save-state" role="status">Autosave on</span></span></footer>
`

const ui = {
  workspace: requireElement(app, '#workspace', HTMLElement),
  ideasPanel: requireElement(app, '#ideas-panel', HTMLElement),
  ideasToggle: requireElement(app, '#ideas-toggle', HTMLButtonElement),
  sidebar: requireElement(app, '#sidebar', HTMLElement),
  navigator: requireElement(app, '#navigator', HTMLElement),
  contentSearchToggle: requireElement(app, '#content-search-toggle', HTMLButtonElement),
  changeReview: requireElement(app, '#change-review', HTMLElement),
  reviewToggle: requireElement(app, '#review-toggle', HTMLButtonElement),
  reviewNotesToggle: requireElement(app, '#review-notes-toggle', HTMLButtonElement),
  reviewNotesPanel: requireElement(app, '#review-notes-panel', HTMLElement),
  claudePanel: requireElement(app, '#claude-panel', HTMLElement),
  claudeToggle: requireElement(app, '#claude-toggle', HTMLButtonElement),
  settingsToggle: requireElement(app, '#settings-toggle', HTMLButtonElement),
  projectName: requireElement(app, '#project-name', HTMLElement),
  projectPath: requireElement(app, '#project-path', HTMLElement),
  branchName: requireElement(app, '#branch-name', HTMLElement),
  workspaceNotices: requireElement(app, '#workspace-notices', HTMLElement),
  feedScroll: requireElement(app, '#feed-scroll', HTMLElement),
  feed: requireElement(app, '#feed', HTMLElement),
  emptyState: requireElement(app, '#empty-state', HTMLElement),
  startScreen: requireElement(app, '#start-screen', HTMLElement),
  startTitle: requireElement(app, '#start-title', HTMLElement),
  startDescription: requireElement(app, '#start-description', HTMLElement),
  startError: requireElement(app, '#start-error', HTMLElement),
  startActions: requireElement(app, '#start-actions', HTMLElement),
  openFile: requireElement(app, '#open-file', HTMLButtonElement),
  openFolder: requireElement(app, '#open-folder', HTMLButtonElement),
  recentTargets: requireElement(app, '#recent-targets', HTMLElement),
  recentList: requireElement(app, '#recent-list', HTMLElement),
  recentStatus: requireElement(app, '#recent-status', HTMLElement),
  statusText: requireElement(app, '#status-text', HTMLElement),
}
setErrorNoticeHost(ui.workspaceNotices)
const bridge = window.diffpane
if (!bridge) {
  throw appError('The desktop connection is unavailable. Reopen the desktop app to continue.', {
    code: 'DESKTOP_BRIDGE_UNAVAILABLE',
  })
}
const api = bridge
const uiPreferences = getWorkspacePreferences()
const shortcutApi = api?.shortcuts
const platform = shortcutApi?.platform ?? (globalThis.navigator.platform.startsWith('Mac') ? 'darwin' : 'linux')
const isMac = platform === 'darwin'
/** @type {ShortcutOverrides} */
let shortcutOverrides = {}
let shortcutVersion = 0
/** @type {Disposable | undefined} */
let removedEditorFind
/** @type {Map<string, Card>} */
const cards = new Map()
/** @type {WorkspaceSnapshot | null} */
let snapshot = null
/** @type {OpenFile | null} */
let openedFile = null
let closed = false
let closingRequested = false
/** @type {import('../../../shared/recovery/app-errors.ts').AppError | null} */
let workspaceFailure = null
/** @type {number | null} */
let documentFrame = null
let firstDocumentRendered = false
let welcomeRendered = false
let navigationVersion = 0
/** @type {Set<{path: string}>} */
const mutations = new Set()
let reviewVisible = false
/** @type {ReviewScope} */
let reviewScope = 'focus'
/** @type {WorkspaceComparison} */
let reviewComparison = 'head'
/** @type {Map<string, ViewState>} */
const savedViews = new Map()
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const minimumOpeningMs = 3300
let initialInventoryReady = false
let initialDocumentReady = false
/** @type {number | undefined} */
let workspaceOpeningTimer
let recentVersion = 0
let recentSignature = ''
let targetOpening = false
/** @type {string | null} */
let applyingAssistantPath = null
/** @type {Promise<void> | null} */
let applyingAssistantEdit = null
/** @type {'closed' | 'dock' | 'notebook'} */
let ideaMode = 'closed'
let ideaDocked = false
/** @type {HTMLElement | null} */
let focusBeforeIdeas = null

/** @type {'light' | 'dark' | undefined} */
let activeScheme
const appearance = createAppearanceSettings(uiPreferences, (preferences, scheme) => {
  const themeChanged = activeScheme !== scheme
  if (themeChanged) {
    activeScheme = scheme
    syntax.setTheme(editorThemeName(scheme))
    recolorMarkdownPreviews(scheme)
  }
  for (const card of cards.values()) {
    if (card.diffEditor) {
      card.diffEditor.updateOptions(diffAppearance(preferences, Boolean(card.reviewComparison)))
      updateComparisonAriaLabels(card)
    } else card.editor?.updateOptions(codeAppearance(preferences))
  }
})

const overviewRulerColors = {
  added: { color: colorHex('light', 'addedEdge'), darkColor: colorHex('dark', 'addedEdge') },
  modified: {
    color: colorHex('light', 'modifiedEdge'),
    darkColor: colorHex('dark', 'modifiedEdge'),
  },
  deleted: { color: colorHex('light', 'removedEdge'), darkColor: colorHex('dark', 'removedEdge') },
}

const settings =
  shortcutApi &&
  createSettings({
    appearance,
    platform,
    getBindings: () => shortcutOverrides,
    setBinding: (action, binding) => (binding === null ? shortcutApi.reset(action) : shortcutApi.set(action, binding)),
    resetBindings: () => shortcutApi.reset(),
    setCapturing: active => shortcutApi.setCapturing(active),
  })
const openSettings = () => {
  if (!closingRequested) runTask('Open settings', () => settings?.open())
}
ui.settingsToggle.hidden = !settings
ui.settingsToggle.addEventListener('click', openSettings)

/** @param {ShortcutAction} action */
function shortcutBinding(action) {
  return effectiveBinding(action, shortcutOverrides, isMac)
}

/** @param {ShortcutAction} action */
function shortcutLabel(action) {
  return bindingKeys(shortcutBinding(action), isMac).join(isMac ? '' : '+')
}

/** @param {KeyboardEvent} event @param {ShortcutAction} action */
function matchesShortcut(event, action) {
  return matchesBinding(event, shortcutBinding(action), isMac)
}

const assistant =
  api?.claude &&
  createAssistant(ui.claudePanel, ui.claudeToggle, api, {
    onOpen: () => {
      returnFromIdeas({ dock: true })
      reviewNotes?.close()
    },
    getFileContext: assistantFileContext,
    openFile: async ({ path, anchor, startLine, endLine, side }) => {
      const location = startLine
        ? { path, side, line: startLine, endLine: endLine ?? startLine, excerpt: '', direct: true }
        : null
      if (!(await openFile({ path, anchor }, { anchor: location, ideaLink: Boolean(anchor) })))
        throw new Error('The linked file could not be opened.')
    },
    openIdea: async id => {
      if (!ideas || !setIdeasMode('dock') || !(await ideas.open(id))) throw new Error('This idea is unavailable.')
    },
    colorize: colorizeMarkdown,
    prepareSend: async ({ fileContext, ideaId }) => {
      if (closingRequested || closed) throw new Error('This window is closing.')
      const path = fileContext?.path
      await Promise.all([path ? cards.get(path)?.autosave?.flush() : undefined, ideaId ? ideas?.flush() : undefined])
    },
    applyEdit: async proposal => {
      if (closingRequested || closed) throw new Error('This window is closing.')
      const path = proposal.kind === 'idea' ? null : proposal.path
      applyingAssistantPath = path
      const card = path ? cards.get(path) : undefined
      const apply = async () => {
        if (card) applyEditorReadOnly(card)
        await card?.autosave?.flush()
        if (proposal.kind === 'idea') await ideas?.flush()
        await api.claude.apply(proposal.id)
      }
      applyingAssistantEdit = apply()
      try {
        syncSaveState()
        await applyingAssistantEdit
        const current = path ? cards.get(path) : undefined
        if (current) {
          current.dirty = true
          syncReviewState()
          scheduleDocument()
        }
      } finally {
        applyingAssistantEdit = null
        applyingAssistantPath = null
        const current = path ? cards.get(path) : undefined
        if (current) applyEditorReadOnly(current)
        syncSaveState()
      }
    },
  })

function finishWorkspaceOpening() {
  window.clearTimeout(workspaceOpeningTimer)
  workspaceOpeningTimer = undefined
  if (workspaceOpening?.hidden !== false) return
  workspaceOpening.hidden = true
  app.inert = false
}

function revealWorkspace() {
  runTask('Reveal workspace', async () => {
    await waitForWorkspaceOpeningPeeks(workspaceOpening)
    if (closed || workspaceOpening?.hidden !== false) return
    finishWorkspaceOpening()
    rendererDiagnostics.measure('renderer.workspace-first-render', 0)
  })
}

function revealWorkspaceWhenReady() {
  if (closed || workspaceOpening?.hidden !== false || !initialInventoryReady || !initialDocumentReady) return
  const firstPaint = performance.getEntriesByName('first-contentful-paint', 'paint')[0]
  const openingStart = firstPaint ?? performance.getEntriesByName('workspace-opening', 'mark')[0]
  const elapsed = performance.now() - (openingStart?.startTime ?? 0)
  const remaining = reducedMotion.matches ? 0 : minimumOpeningMs - elapsed
  if (remaining <= 0) revealWorkspace()
  else {
    workspaceOpeningTimer ??= window.setTimeout(() => {
      workspaceOpeningTimer = undefined
      revealWorkspaceWhenReady()
    }, remaining)
  }
}

function showStartScreen(failed = false) {
  ui.startScreen.hidden = false
  ui.startScreen.setAttribute('aria-busy', 'false')
  ui.startTitle.textContent = 'Welcome to Diffpane'
  ui.startTitle.hidden = ui.startDescription.hidden = failed
  ui.startError.hidden = !failed
  requireElement(ui.startScreen, '.start-mark', HTMLElement).hidden = failed
  if (!failed) ui.startScreen.setAttribute('aria-labelledby', 'start-title')
  ui.startDescription.textContent = 'Open a file or folder in a Git working tree to get started.'
  ui.startActions.hidden = !api
  ui.statusText.textContent = !api
    ? 'Desktop connection unavailable'
    : failed
      ? 'Choose another file or folder'
      : 'No project open'
  document.title = 'Diffpane'
  if (failed) finishWorkspaceOpening()
  else
    runTask('Reveal welcome screen', async () => {
      await waitForWorkspaceOpeningPeeks(workspaceOpening)
      if (closed || snapshot || workspaceOpening?.hidden !== false) return
      finishWorkspaceOpening()
      if (!welcomeRendered) {
        welcomeRendered = true
        rendererDiagnostics.measure('renderer.welcome-first-render', 0)
      }
    })
  runTask('Load recent projects', loadRecentTargets)
}

async function loadRecentTargets() {
  if (!api) return
  const version = ++recentVersion
  try {
    const targets = await api.recentTargets()
    if (version !== recentVersion || closed || snapshot) return
    const signature = JSON.stringify(targets.map(target => [target.path, target.name, target.kind]))
    if (signature === recentSignature) return
    recentSignature = signature
    const focused = document.activeElement
    const focusedPath =
      focused instanceof HTMLElement && ui.recentList.contains(focused) ? focused.dataset.path : undefined
    const items = targets.map(target => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.disabled = targetOpening
      button.className = 'recent-target'
      button.dataset.kind = target.kind
      button.dataset.path = target.path
      button.title = target.path
      button.setAttribute('aria-label', `Open ${target.name}, ${target.path}`)
      button.innerHTML = `<span class="recent-glyph">${target.kind === 'folder' ? icons.folder : icons.file}</span><span class="recent-label"><strong></strong><span class="recent-location"></span></span><span class="recent-arrow" aria-hidden="true">↗</span>`
      requireElement(button, 'strong', HTMLElement).textContent = target.name
      requireElement(button, '.recent-location', HTMLElement).textContent = target.path
      const open = () => openRecentTarget(target.path)
      button.addEventListener('click', () =>
        runTask('Open recent project', open, { title: 'Couldn’t open this project', retry: open }),
      )
      item.append(button)
      return item
    })
    ui.recentList.replaceChildren(...items)
    ui.recentTargets.hidden = !items.length && ui.recentStatus.hidden
    ui.startScreen.classList.toggle('has-recents', items.length > 0)
    if (focusedPath)
      [...ui.recentList.querySelectorAll('button')]
        .find(button => button.dataset.path === focusedPath)
        ?.focus({ preventScroll: true })
  } catch (cause) {
    if (version === recentVersion && !closed && !snapshot)
      reportError(cause, { operation: 'Load recent projects', silent: true })
  }
}

/** @param {boolean} opening */
function setTargetOpening(opening) {
  targetOpening = opening
  ui.openFile.disabled = ui.openFolder.disabled = opening
  for (const button of ui.recentList.querySelectorAll('button')) button.disabled = opening
}

/** @param {string} pathname */
async function openRecentTarget(pathname) {
  if (targetOpening || closingRequested || closed) return
  setTargetOpening(true)
  ui.recentStatus.hidden = true
  try {
    if (!(await api.openRecent(pathname))) {
      ui.recentStatus.textContent = 'This item is no longer available. Open a file or folder to locate it.'
      ui.recentStatus.hidden = false
      await loadRecentTargets()
    }
  } finally {
    setTargetOpening(false)
  }
}

/** @param {'file' | 'folder'} kind */
async function chooseTarget(kind) {
  if (targetOpening || closingRequested || closed) return
  setTargetOpening(true)
  try {
    await (kind === 'file' ? api.openFile() : api.openFolder())
  } finally {
    setTargetOpening(false)
  }
}
/** @param {'file' | 'folder'} kind */
function openTarget(kind) {
  const operation = kind === 'file' ? 'Open file' : 'Open folder'
  runTask(operation, () => chooseTarget(kind), {
    title: kind === 'file' ? 'Couldn’t open the file picker' : 'Couldn’t open the folder picker',
    retry: () => chooseTarget(kind),
  })
}
ui.openFile.addEventListener('click', () => openTarget('file'))
ui.openFolder.addEventListener('click', () => openTarget('folder'))
window.addEventListener('focus', () => {
  if (!snapshot && ui.startScreen.getAttribute('aria-busy') === 'false')
    runTask('Load recent projects', loadRecentTargets)
})

function syncSaveState() {
  api.setSaveState(
    applyingAssistantEdit !== null ||
      (ideas?.pending ?? false) ||
      [...cards.values()].some(card => card.autosave?.pending),
  )
  syncReviewState()
}

// Coalesce saves per card; a previous file's slow read must not block navigation.
function scheduleDocument() {
  if (documentFrame !== null || closed) return
  documentFrame = requestAnimationFrame(
    guard('Schedule file update', () => {
      documentFrame = null
      const card = openedFile ? cards.get(openedFile.path) : undefined
      if (card?.active && !card.loading && card.dirty && !card.autosave?.pending)
        runTask('Load file', () => loadDocument(card))
    }),
  )
}
/** @type {Map<string, string>} */
const filenameLanguages = new Map()
/** @type {Map<string, string>} */
const extensionLanguages = new Map()
for (const language of monaco.languages.getLanguages()) {
  const label = language.aliases?.[0] ?? language.id
  /** @type {[string[] | undefined, Map<string, string>][]} */
  const associations = [
    [language.filenames, filenameLanguages],
    [language.extensions, extensionLanguages],
  ]
  for (const [patterns, labels] of associations) {
    for (const pattern of patterns ?? []) {
      const key = pattern.toLocaleLowerCase()
      if (key && !labels.has(key)) labels.set(key, label)
    }
  }
}
const extensionLengths = [...new Set([...extensionLanguages.keys()].map(key => key.length))].toSorted((a, b) => b - a)
/** @param {string} pathname */
function languageForPath(pathname) {
  const name = pathname.slice(pathname.lastIndexOf('/') + 1).toLocaleLowerCase()
  const exact = filenameLanguages.get(name)
  if (exact) return exact
  for (const length of extensionLengths) {
    if (length > name.length) continue
    const label = extensionLanguages.get(name.slice(-length))
    if (label) return label
  }
  return 'Plain text'
}

/** @param {string} pathname @param {string | undefined} file */
function pathAffects(pathname, file) {
  return file === pathname || file?.startsWith(`${pathname}/`)
}

/** @param {Card} card */
function editorReadOnly(card) {
  return (
    closingRequested ||
    !card.document?.editable ||
    applyingAssistantPath === card.file.path ||
    [...mutations].some(mutation => pathAffects(mutation.path, card.file.path))
  )
}

/** @param {Card} card */
function applyEditorReadOnly(card) {
  const readOnly = editorReadOnly(card)
  card.editor?.updateOptions({ readOnly, domReadOnly: readOnly })
}

function closeCurrentFile() {
  navigationVersion++
  for (const card of cards.values()) deactivate(card)
  cards.clear()
  openedFile = null
  assistant?.refreshContext()
  ideas?.refreshContext()
  ui.feed.replaceChildren()
  ui.emptyState.hidden = false
  navigator.select(null)
  syncReviewState()
  setSaveLabel('Autosave on')
  const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
  if (outline) outline.textContent = 'Open a file to see its outline'
}

/** @param {'rename' | 'trash'} action @param {string} pathname @param {string} [name] */
async function mutateFile(action, pathname, name) {
  if (closingRequested || closed) throw new Error('This window is closing.')
  const mutation = { path: pathname }
  mutations.add(mutation)
  try {
    const current = openedFile ? cards.get(openedFile.path) : undefined
    if (current && pathAffects(pathname, current.file.path)) {
      applyEditorReadOnly(current)
      await current.autosave?.flush()
    }
    let destination
    if (action === 'rename') {
      if (name === undefined) throw new Error('Enter a name for this file.')
      destination = await api.rename(pathname, name)
    } else await api.fileAction(action, pathname)
    if (closed) return
    if (destination === pathname) return
    if (destination) navigator.renamed(pathname, destination)
    if (openedFile && pathAffects(pathname, openedFile.path)) {
      const previous = openedFile.path
      const affected = cards.get(previous)
      closeCurrentFile()
      if (destination && !closingRequested) {
        const path = `${destination}${previous.slice(pathname.length)}`
        rememberView(path, affected?.viewState)
        await openFile(
          { path },
          {
            compare: affected?.comparing,
            comparison: affected?.comparison,
            review: affected?.reviewComparison ?? false,
            source: affected?.markdownSource,
          },
        )
        return
      }
    }
  } finally {
    mutations.delete(mutation)
    const current = openedFile ? cards.get(openedFile.path) : undefined
    if (current) applyEditorReadOnly(current)
  }
}
const navigator = createNavigator(ui.navigator, api, openFile, {
  onInitialScan: ready => {
    if (ready) {
      initialInventoryReady = true
      revealWorkspaceWhenReady()
    } else finishWorkspaceOpening()
  },
  onReady: startBackgroundAnalysis,
  iconFor: projectIcon,
  onMutate: (action, path, name) => {
    if (action === 'rename' || action === 'trash') return mutateFile(action, path, name)
    throw new Error('Unknown file action.')
  },
  onAttach: api.ideas ? path => attachIdeaLink({ path }) : undefined,
  languageFor: languageForPath,
  onPick: () => openFilePicker(),
  matchesShortcut,
  onFolder: () => openTarget('folder'),
  onOutline: list => {
    const card = openedFile ? cards.get(openedFile.path) : undefined
    if (card?.markdownCleanup) showMarkdownOutline(card, list)
    else if (card?.editor) runTask('Load file outline', () => showSymbols(card, list))
    else if (card?.documentFailed) list.textContent = 'Symbols unavailable'
    else if (!card) list.textContent = 'Open a file to see its outline'
  },
})
const review = createChangeReview(ui.changeReview, {
  onOpen: file => openFile(file, { compare: true, comparison: reviewComparison }),
  onBack: toggleReview,
  onBaseline: updateReviewBaseline,
  onCapture: async () => {
    await (openedFile ? cards.get(openedFile.path) : undefined)?.autosave?.flush()
    if (closingRequested || closed) throw new Error('This window is closing.')
    const next = await api.captureCheckpoint()
    applySnapshot(next)
    if (!closed) updateReviewBaseline('checkpoint')
  },
  onProgress: ({ pending, total }) => {
    ui.reviewToggle.dataset.pending = String(pending > 0)
    ui.reviewToggle.setAttribute(
      'aria-description',
      pending > 0 ? 'Unreviewed changes' : total > 0 ? 'All changes reviewed' : 'No changed files',
    )
  },
})
ui.reviewToggle.addEventListener('click', toggleReview)

/** @param {WorkspaceComparison} [comparison] */
function reviewFiles(comparison = reviewComparison) {
  return (comparison === 'head' ? snapshot?.files : snapshot?.checkpoint?.files) ?? []
}

/** @param {'head' | 'checkpoint'} [mode] */
function updateReviewBaseline(mode = reviewComparison === 'head' ? 'head' : 'checkpoint') {
  const checkpoint = snapshot?.checkpoint
  /** @type {WorkspaceComparison} */
  const next = mode === 'checkpoint' && checkpoint ? `checkpoint:${checkpoint.id}` : 'head'
  const changed = next !== reviewComparison
  reviewComparison = next
  review.setBaseline(next === 'head' ? 'head' : 'checkpoint', checkpoint)
  const files = reviewFiles()
  if (changed) {
    navigationVersion++
    const card = openedFile ? cards.get(openedFile.path) : undefined
    if (card?.reviewComparison) {
      const file = files.find(entry => entry.path === card.file.path)
      if (file) openComparison(card, next, file)
      else if (isCheckpointOnlyDeletion(card)) closeCurrentFile()
      else {
        card.modeVersion = (card.modeVersion ?? 0) + 1
        card.comparing = false
        card.reviewComparison = false
        setDocumentComparison(card, 'head')
        if (card.document && !card.autosave?.pending) renderCurrentDocument(card)
      }
    }
  }
  review.update(files)
  syncReviewState()
}

/** @param {Card} card */
function isCheckpointOnlyDeletion(card) {
  return card.document?.workingMissing && !reviewFiles('head').some(file => file.path === card.file.path)
}

function syncReviewState() {
  const card = openedFile ? cards.get(openedFile.path) : undefined
  const version = card?.document?.reviewVersion ?? null
  /** @type {import('../../review/queue/change-review.js').ReviewState | null} */
  let state = null
  if (card?.comparing && card.comparison === reviewComparison) {
    if (closingRequested) state = 'closing'
    else if (applyingAssistantPath === card.file.path) state = 'saving'
    else if (card.autosave?.pending) state = card.saveError ? 'save-failed' : 'saving'
    else if (card.loading || card.dirty) state = 'loading'
    else if (card.documentFailed) state = 'failed'
    else state = 'ready'
  }
  review.setCurrent(card?.file.path ?? null, state, version)
}

const languageFeatures = createLanguageFeatures(monaco, api, { onState: updateLanguageState })
const howmany = createHowMany(monaco, api, ui.navigator, requireElement(app, '.statusbar-end', HTMLElement))
function startBackgroundAnalysis() {
  if (closed || !snapshot || navigator.stats().loading) return
  const card = openedFile ? cards.get(openedFile.path) : undefined
  if (card?.dirty || card?.loading) return
  howmany?.start()
}
const languageWidgets = document.createElement('div')
languageWidgets.className = 'monaco-editor language-widgets'
document.body.append(languageWidgets)
const openFilePicker = createFilePicker(
  api,
  file => {
    if (!file.directory) return openFile(file)
    if (returnFromIdeas()) showFileExplorer()
    navigator.revealDirectory(file.path)
    return undefined
  },
  () => snapshot?.scope ?? snapshot?.root ?? ui.projectPath.textContent,
  languageForPath,
  () => {
    const root = snapshot?.root?.replaceAll('\\', '/').replace(/\/$/u, '') ?? ''
    const scope = snapshot?.scope?.replaceAll('\\', '/').replace(/\/$/u, '') ?? root
    return scope.startsWith(`${root}/`) ? scope.slice(root.length + 1) : ''
  },
)
const contentSearch = createContentSearch(api, match => openFile({ path: match.path }, { match }))
const reviewNotes =
  api?.reviewNotes &&
  createReviewNotes(ui.reviewNotesPanel, ui.reviewNotesToggle, api.reviewNotes, {
    matchesSaveShortcut: event => matchesShortcut(event, 'saveReviewNote'),
    capture: () => {
      const card = openedFile ? cards.get(openedFile.path) : undefined
      return card ? captureReviewAnchor(card, card.noteSide ?? 'working') : null
    },
    onJump: anchor => {
      const rename = snapshot?.files.find(
        file => (file.index === 'R' || file.worktree === 'R') && file.originalPath === anchor.path,
      )
      const path = rename?.path ?? anchor.path
      return openFile({ path }, { anchor })
    },
    onVisible: visible => {
      if (visible && !ui.claudePanel.hidden) assistant?.toggle(false, false)
    },
  })

const ideas =
  api?.ideas &&
  mountIdeaBuilder(ui.ideasPanel, {
    getWorkspace: () => snapshot?.root,
    getShortcut: shortcutBinding,
    isMac,
    load: api.ideas.list,
    save: api.ideas.upsert,
    remove: api.ideas.delete,
    onPendingChange: syncSaveState,
    onClose: () => {
      if (!returnFromIdeas({ restoreFocus: true })) {
        if (setIdeasMode('closed', { remember: true })) ui.ideasToggle.focus()
      }
    },
    onDock: () => {
      if (setIdeasMode('dock', { remember: true })) {
        focusBeforeIdeas = null
        ideas.focus()
      }
    },
    onExpand: showIdeasNotebook,
    hasCurrentLink: () => Boolean(openedFile),
    getCurrentLink: () => {
      const card = openedFile ? cards.get(openedFile.path) : undefined
      return card ? captureIdeaLink(card) : null
    },
    openLink: async link => {
      const workspace = snapshot
      if (!workspace) throw new Error('Open the repository to view this linked file.')
      const renamed = workspace.files.find(
        file => (file.index === 'R' || file.worktree === 'R') && file.originalPath === link.path,
      )
      const anchor = {
        ...link,
        line: link.line ?? null,
        endLine: link.endLine ?? link.line ?? null,
        excerpt: link.excerpt ?? '',
      }
      const path = renamed?.path ?? link.path
      const root = workspace.root.replaceAll('\\', '/').replace(/\/$/u, '')
      const scope = workspace.scope.replaceAll('\\', '/').replace(/\/$/u, '')
      if (root !== scope && !`${root}/${path}`.startsWith(`${scope}/`))
        throw new Error('Open the repository root to view this linked file.')
      if (!(await openFile({ path }, { anchor, ideaLink: true })))
        throw new Error('The linked file could not be opened.')
    },
    draftInChat: assistant ? idea => assistant.attachIdea(idea) : undefined,
    openMarkdownFile: async target => {
      if (!(await openFile(target, { ideaLink: true }))) throw new Error('The linked file could not be opened.')
    },
    openExternal: api.openExternal,
    media: api.media,
  })
const workspaceLayout = createWorkspaceLayout(ui.workspace, uiPreferences)
const unsubscribeIdeaVisibility = uiPreferences.onChange('ideasVisible', syncIdeasVisibility)
ui.ideasToggle.addEventListener('click', () => {
  if (!returnFromIdeas({ restoreFocus: true })) showIdeasNotebook()
})
ui.claudeToggle.addEventListener(
  'click',
  event => {
    if (!returnFromIdeas()) return
    event.stopImmediatePropagation()
    assistant?.toggle(true)
  },
  { capture: true },
)
ui.reviewNotesToggle.addEventListener(
  'click',
  () => {
    if (returnFromIdeas()) reviewNotes?.close()
  },
  { capture: true },
)

/** @param {'closed' | 'dock' | 'notebook'} mode */
function setIdeasMode(mode, { remember = false } = {}) {
  if (!ideas || !snapshot || closingRequested || closed) return false
  const notebook = mode === 'notebook'
  ideaMode = mode
  if (!notebook) ideaDocked = mode === 'dock'
  ui.ideasPanel.hidden = mode === 'closed'
  ideas.setMode(notebook ? 'notebook' : 'dock')
  workspaceLayout.setIdeasNotebook(notebook, ideaDocked)
  languageWidgets.hidden = notebook
  ui.ideasToggle.setAttribute('aria-expanded', String(notebook))
  if (remember) uiPreferences.set('ideasVisible', ideaDocked)
  return true
}

/** @param {boolean} docked */
function syncIdeasVisibility(docked) {
  if (!ideas || !snapshot || closingRequested || closed || docked === ideaDocked) return
  if (ideaMode === 'notebook') {
    ideaDocked = docked
    workspaceLayout.setIdeasNotebook(true, docked)
  } else setIdeasMode(docked ? 'dock' : 'closed')
}

function showIdeasNotebook() {
  if (ideaMode === 'notebook') return
  const previous = document.activeElement
  if (!setIdeasMode('notebook')) return
  focusBeforeIdeas = previous instanceof HTMLElement ? previous : null
  ideas?.focus()
}

function returnFromIdeas({ dock = ideaDocked, restoreFocus = false } = {}) {
  if (ideaMode !== 'notebook' || !setIdeasMode(dock ? 'dock' : 'closed')) return false
  if (restoreFocus) {
    const previous = focusBeforeIdeas
    if (previous?.isConnected && previous !== document.body && !previous.closest('[hidden], [inert]'))
      previous.focus({ preventScroll: true })
    if (document.activeElement === document.body || document.activeElement !== previous) ui.ideasToggle.focus()
  }
  focusBeforeIdeas = null
  return true
}

/** @param {IdeaLink} link */
function attachIdeaLink(link) {
  if (!ideas || !snapshot || closingRequested) return
  if (ideaMode === 'closed') setIdeasMode('dock')
  ideas.attach(link)
}

function openContentSearch() {
  if (!contentSearch || !snapshot || closingRequested) return
  const card = openedFile ? cards.get(openedFile.path) : undefined
  const editor = card?.diffEditor?.getOriginalEditor().hasTextFocus()
    ? card.diffEditor.getOriginalEditor()
    : card?.editor
  const range = editor?.getSelection()
  const selection =
    range && range.startLineNumber === range.endLineNumber && !range.isEmpty()
      ? (editor?.getModel()?.getValueInRange(range) ?? '')
      : ''
  contentSearch.open(snapshot.scope || snapshot.root, selection)
}
ui.contentSearchToggle.addEventListener('click', openContentSearch)

/** @param {string} pathname @param {ViewState | null | undefined} state */
function rememberView(pathname, state) {
  if (!state) return
  savedViews.delete(pathname)
  savedViews.set(pathname, state)
  if (savedViews.size > 64) {
    const oldest = savedViews.keys().next()
    if (!oldest.done) savedViews.delete(oldest.value)
  }
}

/** @param {OpenFile} file @param {OpenOptions} [options] */
async function openFile(
  file,
  {
    compare = false,
    comparison = 'head',
    review: focusReview = compare,
    source = false,
    match = null,
    anchor = null,
    ideaLink = false,
  } = {},
) {
  if (closingRequested || closed) return false
  const openedAt = performance.now()
  const version = ++navigationVersion
  const current = openedFile ? cards.get(openedFile.path) : undefined
  if (current?.autosave?.pending) {
    try {
      await current.autosave.flush()
    } catch {
      if (version === navigationVersion && !closed) navigator.select(current.file.path)
      return false
    }
  }
  if (version !== navigationVersion || closingRequested || closed) return false
  if (ideaMode === 'notebook') {
    try {
      await api.document(file.path, compare ? comparison : 'head')
    } catch (error) {
      if (version !== navigationVersion || closingRequested || closed) return false
      if (ideaLink) throw error
      if (ideaMode === 'notebook') ideas.notify(appError(error, { operation: 'Open file' }).message)
      return false
    }
    if (version !== navigationVersion || closingRequested || closed) return false
    if (returnFromIdeas({ dock: ideaLink || ideaDocked }))
      requireElement(ui.workspace, '.workbench', HTMLElement).focus({ preventScroll: true })
  }
  if (openedFile?.path === file.path && current) {
    navigator.select(file.path)
    current.pendingReviewAnchor = anchor
    current.anchorFromIdea = ideaLink
    current.reviewNotice.hidden = true
    if (anchor) {
      current.pendingMatch = null
      current.modeVersion = (current.modeVersion ?? 0) + 1
      const comparing = anchor.side === 'head'
      const markdownSource = comparing || anchor.line !== null
      const modeChanged =
        current.comparing !== comparing ||
        current.reviewComparison === true ||
        (isMarkdown(file.path) && Boolean(current.markdownSource) !== markdownSource)
      current.markdownSource = markdownSource
      current.comparing = comparing
      if (current.reviewComparison && comparing && current.diffEditor) {
        current.reviewFocus.detach()
        current.diffEditor.updateOptions({
          ...diffAppearance(appearance.value, false),
          hideUnchangedRegions: { enabled: false },
        })
      }
      current.reviewComparison = false
      const reloading = setDocumentComparison(current, 'head')
      if (current.documentFailed) {
        current.dirty = true
        scheduleDocument()
      } else if (modeChanged && current.document && (!reloading || !comparing)) {
        renderCurrentDocument(current)
      } else if (!reloading && !current.loading) revealReviewAnchor(current)
      syncReviewState()
    } else if (compare) openComparison(current, comparison, file)
    else if (match) {
      current.pendingMatch = match
      current.modeVersion = (current.modeVersion ?? 0) + 1
      const modeChanged = current.comparing || (isMarkdown(file.path) && !current.markdownSource)
      current.markdownSource = true
      current.comparing = false
      current.reviewComparison = false
      setDocumentComparison(current, 'head')
      if ((modeChanged || current.document?.preview) && current.document && !current.documentFailed)
        renderCurrentDocument(current)
      else if (!current.dirty && !current.loading) revealContentMatch(current)
      if (current.documentFailed) {
        current.dirty = true
        scheduleDocument()
      }
      syncReviewState()
    } else if (ideaLink && file.anchor && current.document && current.markdownCleanup) {
      current.markdownAnchor = file.anchor
      renderCurrentDocument(current)
    }
    return true
  }
  for (const card of cards.values()) {
    deactivate(card)
    rememberView(card.file.path, card.viewState)
    card.element.remove()
  }
  cards.clear()
  openedFile = file
  assistant?.refreshContext()
  const card = createCard(reviewFiles(comparison).find(value => value.path === file.path) ?? file, openedAt)
  card.markdownAnchor = file.anchor ?? null
  const anchorLine = anchor?.line
  card.markdownSource = source || compare || Boolean(match) || (anchorLine !== null && anchorLine !== undefined)
  card.pendingMatch = match
  card.pendingReviewAnchor = anchor
  card.anchorFromIdea = ideaLink
  if (anchor?.side === 'head') {
    card.comparing = true
    card.markdownSource = true
  }
  card.viewState = savedViews.get(file.path) ?? null
  cards.set(file.path, card)
  card.active = true
  ui.feed.replaceChildren(card.element)
  ideas?.refreshContext()
  ui.emptyState.hidden = true
  setSaveLabel('Autosave on')
  navigator.select(file.path)
  if (focusReview) openComparison(card, comparison)
  else {
    if (compare) {
      card.comparing = true
      setDocumentComparison(card, comparison)
    }
    syncReviewState()
  }
  const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
  if (outline) {
    if (mediaType(file.path)) outline.textContent = 'No outline for media files'
    else outline.replaceChildren(symbolsPlaceholder())
  }
  scheduleDocument()
  return true
}

/** @param {{path: string, language: string, status: string, message?: string, diagnostics?: number}} state */
function updateLanguageState(state) {
  const card = cards.get(state.path)
  if (!card) return
  card.languageState = state
  card.language.textContent =
    monaco.languages.getLanguages().find(language => language.id === card.model?.getLanguageId())?.aliases?.[0] ??
    state.language
  const ready = state.status === 'ready'
  const badge = requireElement(card.element, '.language-state', HTMLElement)
  badge.textContent = ready ? 'Language ready' : state.status === 'starting' ? 'Loading language…' : 'Syntax'
  badge.dataset.status = state.status
  badge.toggleAttribute('data-loading-status', state.status === 'starting')
  badge.title =
    state.message ??
    (ready ? 'Semantic features available for this language server' : 'Language services load when this file is used')
  if (state.diagnostics !== undefined)
    badge.textContent += state.diagnostics
      ? ` · ${state.diagnostics} ${state.diagnostics === 1 ? 'issue' : 'issues'}`
      : ''
}

function symbolsPlaceholder() {
  const placeholder = documentNode('span', 'symbol-empty', 'Loading symbols…')
  placeholder.setAttribute('data-loading-status', '')
  return placeholder
}

/** @param {Card} card @param {Element | null} [list] */
async function showSymbols(card, list = card.element.querySelector('.symbol-list')) {
  const { editor, model } = card
  if (!editor || !model || !list) return
  const version = model.getVersionId()
  const placeholder = symbolsPlaceholder()
  const isCurrent = () => card.editor === editor && model.getVersionId() === version && list.firstChild === placeholder
  list.replaceChildren(placeholder)
  try {
    const symbols = await languageFeatures.symbols(card.file.path)
    if (!isCurrent()) return
    /** @type {HTMLButtonElement[]} */
    const nodes = []
    /** @param {Awaited<ReturnType<typeof languageFeatures.symbols>>} items */
    const append = (items, depth = 0) => {
      for (const symbol of items) {
        const button = documentNode('button', 'symbol-item', symbol.name)
        button.type = 'button'
        button.style.paddingLeft = `${12 + depth * 12}px`
        button.title = symbol.detail ? symbol.detail : symbol.name
        button.addEventListener('click', () => {
          if (card.editor !== editor) return
          editor.revealLineInCenter(symbol.selectionRange.startLineNumber)
          editor.setPosition({
            lineNumber: symbol.selectionRange.startLineNumber,
            column: symbol.selectionRange.startColumn,
          })
          editor.focus()
          requireElement(card.element, '.symbol-outline', HTMLDetailsElement).open = false
        })
        nodes.push(button)
        append(symbol.children ?? [], depth + 1)
      }
    }
    append(symbols)
    list.replaceChildren(...(nodes.length ? nodes : [documentNode('span', 'symbol-empty', 'No symbols available')]))
  } catch (error) {
    if (!isCurrent()) return
    const failure = reportError(error, { operation: 'Load file outline', silent: true })
    list.replaceChildren(documentNode('span', 'symbol-empty', failure.message))
  } finally {
    placeholder.removeAttribute('data-loading-status')
  }
}

/** @param {Card} card @param {Element} list */
function showMarkdownOutline(card, list) {
  const headings = [
    ...card.host.querySelectorAll(
      '.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6',
    ),
  ]
  const buttons = headings.map(heading => {
    const button = documentNode('button', 'symbol-item', heading.textContent.replace(/#$/, ''))
    button.type = 'button'
    button.style.paddingLeft = `${12 + (Number(heading.tagName.slice(1)) - 1) * 12}px`
    button.addEventListener('click', () => heading.scrollIntoView({ block: 'start' }))
    return button
  })
  list.replaceChildren(
    ...(buttons.length ? buttons : [documentNode('span', 'symbol-empty', 'No headings in this document')]),
  )
}

/** @param {string} code @param {string} language */
async function colorizeMarkdown(code, language) {
  /** @type {Record<string, string>} */
  const aliases = {
    js: 'javascript',
    ts: 'typescript',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    py: 'python',
  }
  const id = aliases[language] ?? language
  await syntax.ensureLanguage(id)
  return monaco.editor.colorize(code, id, {})
}

function toggleNavigator() {
  if (!snapshot) return
  if (returnFromIdeas()) showFileExplorer()
  else setSidebarVisible(Boolean(ui.sidebar.hidden))
}

function showFileExplorer() {
  reviewVisible = false
  setSidebarVisible(true)
  requireElement(ui.navigator, '.navigator-tree', HTMLElement).focus()
}

function toggleReview() {
  if (!snapshot) return
  reviewVisible = returnFromIdeas() || ui.sidebar.hidden === true || !reviewVisible
  setSidebarVisible(true)
  if (reviewVisible) review.focus()
  else requireElement(ui.navigator, '.navigator-tree', HTMLElement).focus()
}

/** @param {boolean} visible */
function setSidebarVisible(visible) {
  ui.sidebar.hidden = !visible
  const showFiles = visible && !reviewVisible
  if (showFiles !== !ui.navigator.hidden) navigator.toggle()
  const showReview = visible && reviewVisible
  review.setVisible(showReview)
  ui.reviewToggle.setAttribute('aria-pressed', String(showReview))
  requireElement(ui.emptyState, 'h2', HTMLElement).textContent = showReview ? 'Open a comparison' : 'Open a file'
  updateEmptyStateHint()
}

function updateEmptyStateHint() {
  const showReview = ui.reviewToggle.getAttribute('aria-pressed') === 'true'
  requireElement(ui.emptyState, 'p', HTMLElement).textContent = showReview
    ? 'Select a changed file from the review queue.'
    : `Select a file in the explorer, or press ${shortcutLabel('searchFiles')}.`
}

/** @param {OpenFile} file @param {number} openedAt */
function createCard(file, openedAt) {
  const element = document.createElement('section')
  element.className = 'file-card'
  element.dataset.path = file.path
  element.innerHTML = `
    <div class="file-header">
      <span class="file-icon">${icons.file}</span>
      <div class="file-path"><span class="file-directory"></span><strong class="file-name"></strong></div>
      <div class="file-actions">
        <button class="diff-toggle change-button" type="button" aria-label="Compare whole file" aria-pressed="false" title="Compare whole file" disabled>
          <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="1.75" y="3" width="14.5" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M9 3v12m-5.5-6H7m4 0h3.5m-1.75-1.75v3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          <span>Compare</span>
        </button>
        <details class="symbol-outline"><summary title="Document symbols">Symbols</summary><div class="symbol-list"></div></details>
        <button class="change-button" type="button" title="Next change" aria-label="Next change in file">${icons.down}</button>
      </div>
    </div>
    <div class="file-note" hidden></div>
    <div class="file-errors"></div>
    <div class="comparison-labels" hidden>
      <div class="comparison-original"><span class="comparison-version is-original">HEAD</span></div>
      <div class="comparison-working"><span class="comparison-version is-working">Working file</span></div>
      <div class="comparison-inline">
        <span class="comparison-version is-original">HEAD</span><span class="comparison-arrow">→</span><span class="comparison-version is-working">Working file</span>
        <span class="comparison-layout">Inline</span>
      </div>
    </div>
    <div class="editor-host"><div class="editor-placeholder" aria-hidden="true"><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span></div></div>
    <div class="file-footer"><span class="line-count">Loading file…</span><span class="language-meta"><span class="language-state">Syntax</span><span class="file-language"></span></span></div>`
  const reviewFocus = createReviewFocus({
    onScope: scope => {
      reviewScope = scope
      element.dataset.reviewScope = scope
    },
  })
  requireElement(element, '.comparison-labels', HTMLElement).before(reviewFocus.bar)
  const reviewNotice = documentNode('div', 'file-note', '')
  reviewNotice.hidden = true
  reviewNotice.setAttribute('role', 'status')
  requireElement(element, '.file-note', HTMLElement).after(reviewNotice)
  /** @type {Card} */
  const card = {
    file,
    openedAt,
    element,
    reviewFocus,
    reviewNotice,
    host: requireElement(element, '.editor-host', HTMLElement),
    note: requireElement(element, '.file-note', HTMLElement),
    errors: requireElement(element, '.file-errors', HTMLElement),
    nextChange: requireElement(element, '[aria-label="Next change in file"]', HTMLButtonElement),
    lines: requireElement(element, '.line-count', HTMLElement),
    language: requireElement(element, '.file-language', HTMLElement),
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
    comparison: 'head',
    textBytes: 0,
  }
  const slash = file.path.lastIndexOf('/')
  requireElement(element, '.file-directory', HTMLElement).textContent = file.path.slice(0, slash + 1)
  requireElement(element, '.file-name', HTMLElement).textContent = file.path.slice(slash + 1)
  requireElement(element, '.file-path', HTMLElement).title = file.path
  if (ideas) {
    const ideaButton = documentNode('button', 'change-button file-idea-link', '')
    ideaButton.type = 'button'
    ideaButton.title = 'Attach selection or visible lines to an idea'
    ideaButton.setAttribute('aria-label', 'Attach current view to an idea')
    ideaButton.innerHTML = icons.idea
    ideaButton.addEventListener('click', () => attachIdeaLink(captureIdeaLink(card)))
    requireElement(element, '.diff-toggle', HTMLButtonElement).after(ideaButton)
  }
  if (reviewNotes) {
    const noteButton = documentNode('button', 'change-button file-review-note', '')
    noteButton.type = 'button'
    noteButton.title = 'Add file review note'
    noteButton.setAttribute('aria-label', 'Add review note for this file')
    noteButton.innerHTML = icons.note
    noteButton.addEventListener('click', () => {
      if (!closingRequested) reviewNotes.openComposer(captureReviewAnchor(card, 'working', false))
    })
    requireElement(element, '.diff-toggle', HTMLButtonElement).after(noteButton)
  }
  card.nextChange.addEventListener('click', () => {
    if (!card.editor || card.changes.length === 0) return
    card.changeIndex = (card.changeIndex + 1) % card.changes.length
    const line = card.changes[card.changeIndex]
    if (line === undefined) return
    card.editor.revealLineInCenter(
      line,
      reducedMotion.matches ? monaco.editor.ScrollType.Immediate : monaco.editor.ScrollType.Smooth,
    )
  })
  requireElement(element, '.diff-toggle', HTMLButtonElement).addEventListener('click', () =>
    runTask('Switch file comparison', () => toggleDiff(card)),
  )
  if (isMarkdown(file.path)) {
    const modes = documentNode('div', 'markdown-toggle', '')
    modes.setAttribute('role', 'group')
    modes.setAttribute('aria-label', 'Markdown view')
    /** @type {[string, boolean][]} */
    const markdownModes = [
      ['Preview', false],
      ['Source', true],
    ]
    for (const [label, source] of markdownModes) {
      const button = documentNode('button', '', label)
      button.type = 'button'
      button.setAttribute('aria-pressed', String(!source))
      button.addEventListener('click', () => {
        runTask('Switch Markdown view', () =>
          changeDocumentMode(card, () => {
            if (Boolean(card.markdownSource) === source) return false
            card.markdownSource = source
            card.pendingMatch = null
            card.pendingReviewAnchor = null
            if (!source) {
              card.comparing = false
              card.reviewComparison = false
              setDocumentComparison(card, 'head')
            }
            return true
          }),
        )
      })
      modes.append(button)
    }
    requireElement(element, '.diff-toggle', HTMLButtonElement).before(modes)
  }
  requireElement(element, '.symbol-outline', HTMLDetailsElement).addEventListener('toggle', event => {
    if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open)
      runTask('Load file outline', () => showSymbols(card))
  })
  const fileIcon = document.createElement('img')
  const icon = projectIcon({ kind: 'file', name: file.path.slice(slash + 1) })
  if (icon) fileIcon.src = icon
  fileIcon.alt = ''
  requireElement(element, '.file-icon', HTMLElement).replaceChildren(fileIcon)
  return card
}

/** @param {WorkspaceSnapshot | null} next */
function applySnapshot(next) {
  rendererDiagnostics.run('renderer.snapshot-apply', () => renderSnapshot(next))
}

/** @param {WorkspaceSnapshot | null} next */
function renderSnapshot(next) {
  if (closed) return
  if (!next) {
    if (!snapshot) showStartScreen()
    return
  }
  if (snapshot && Number.isFinite(next.revision) && next.revision < snapshot.revision) return
  if (snapshot && next.revision === snapshot.revision && next.inventoryRevision < snapshot.inventoryRevision) return
  const first = !snapshot
  const allDirty = !next.changedPaths || next.changedPaths.includes('*') || next.root !== snapshot?.root
  const watchChanged = next.watchError !== snapshot?.watchError
  const searchChanged = next.revision !== snapshot?.revision || next.inventoryRevision !== snapshot?.inventoryRevision
  snapshot = next
  ui.startError.replaceChildren()
  if (!workspaceFailure) clearErrorNotice('workspace')
  if (searchChanged) contentSearch?.refresh()
  assistant?.setContext(true, next.root)
  ui.startScreen.setAttribute('aria-busy', 'false')
  ui.startScreen.hidden = true
  ui.feedScroll.hidden = false
  if (first) {
    setSidebarVisible(true)
    requireElement(document, '.branch', HTMLElement).hidden = false
    requireElement(document, '.statusbar-end', HTMLElement).hidden = false
    ui.contentSearchToggle.hidden = !contentSearch
    ui.reviewToggle.hidden = false
    reviewNotes?.setContext(true)
    if (ideas) {
      ui.ideasToggle.hidden = false
      syncIdeasVisibility(uiPreferences.get('ideasVisible'))
      runTask('Load ideas', () => ideas.load())
    }
  }
  navigator.update(next)
  updateReviewBaseline()
  ui.projectName.textContent =
    next.scope.split('/').findLast(segment => segment !== '') ??
    next.root.split('/').findLast(segment => segment !== '') ??
    'Working tree'
  ui.projectPath.textContent = next.scope
  ui.projectPath.title = next.scope
  ui.branchName.textContent = next.branch || 'HEAD'
  document.title = `${ui.projectName.textContent} · diffpane`
  if (next.watchError && watchChanged) {
    reportError(next.watchError, {
      key: 'watcher',
      code: 'WATCHER_FALLBACK',
      operation: 'Watch workspace files',
      diagnostic: 'renderer.workspace-watch-fallback',
      title: 'Live updates are using polling',
    })
  } else if (!next.watchError) clearErrorNotice('watcher')
  if (first) {
    const path = next.initialPath?.length ? next.initialPath : next.files[0]?.path
    if (path) {
      const open = async () => {
        const result = await attemptAsync(() => openFile({ path, submodule: false }))
        if (!result.ok || !result.value) finishWorkspaceOpening()
        if (!result.ok) throw result.error
      }
      runTask('Open initial file', open, { retry: open })
    } else initialDocumentReady = true
  } else {
    const card = openedFile ? cards.get(openedFile.path) : undefined
    const file = card && reviewFiles(card.comparison).find(entry => entry.path === card.file.path)
    if (
      card &&
      (allDirty ||
        file?.reviewVersion !== card.file.reviewVersion ||
        next.changedPaths.some(path => card.file.path === path || card.file.path.startsWith(`${path}/`)))
    ) {
      card.file = file ?? { path: card.file.path }
      card.dirty = true
      scheduleDocument()
    }
  }
  syncReviewState()
  ui.statusText.textContent = `${next.files.length.toLocaleString()} changed ${next.files.length === 1 ? 'file' : 'files'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
  revealWorkspaceWhenReady()
}

/** @param {Card} card */
async function loadDocument(card, retry = false) {
  if (!card.active || closed) return
  if (card.loading || card.autosave?.pending) {
    if (retry) throw new Error('Wait for the current file operation to finish, then try again.')
    return
  }
  card.loading = true
  card.dirty = false
  const startedAt = performance.now()
  const generation = card.generation
  const comparison = card.comparison
  const editVersion = card.editVersion ?? 0
  try {
    syncReviewState()
    card.element.classList.add('is-loading')
    const [document, media] = await Promise.all([
      api.document(card.file.path, comparison),
      mediaType(card.file.path) && card.file.worktree !== 'D' ? attemptAsync(() => api.media(card.file.path)) : null,
    ])
    if (!card.active || generation !== card.generation || !cards.has(card.file.path)) {
      rendererDiagnostics.measure('renderer.document-load-discarded', startedAt)
      return
    }
    if (card.autosave?.pending || editVersion !== (card.editVersion ?? 0)) {
      card.dirty = true
      rendererDiagnostics.measure('renderer.document-load-discarded', startedAt)
      return
    }
    // Paint completed reads during edit storms, then reconcile any newer invalidation.
    if (media && !media.ok) reportError(media.error, { operation: 'Load media stream', silent: true })
    card.currentMedia = media?.ok ? media.value : null
    if (card.renderedComparison !== comparison) {
      card.renderedComparison = comparison
      card.noteSide = card.ideaSide = 'working'
    }
    renderDocument(card, document)
    clearDocumentFailure(card)
    initialDocumentReady = true
    rendererDiagnostics.measure('renderer.document-load', startedAt)
    if (!firstDocumentRendered) {
      firstDocumentRendered = true
      rendererDiagnostics.measure('renderer.document-first-render', card.openedAt)
    }
  } catch (cause) {
    rendererDiagnostics.measure('renderer.document-load', startedAt, { ok: false, error: cause })
    if (card.active && generation === card.generation) {
      if (retry && card.errorBoundary?.isConnected) throw appError(cause, { operation: 'Load file' })
      finishWorkspaceOpening()
      showDocumentFailure(card, cause)
    }
  } finally {
    card.loading = false
    card.element.classList.remove('is-loading')
    if (card.active) syncReviewState()
    scheduleDocument()
    revealWorkspaceWhenReady()
    runTask('Start background analysis', startBackgroundAnalysis, { silent: true })
  }
}

/** @param {Card} card */
function clearDocumentFailure(card) {
  const shouldRestoreFocus =
    card.errorBoundary?.contains(document.activeElement) === true || card.restoreErrorFocus === true
  card.restoreErrorFocus = false
  card.documentFailed = false
  card.errorBoundary?.remove()
  card.errorBoundary = null
  card.host.classList.remove('has-error')
  if (shouldRestoreFocus) {
    if (card.editor) card.editor.focus()
    else requireElement(card.element, '.diff-toggle', HTMLButtonElement).focus()
  }
}

/** @param {Card} card @param {unknown} cause */
function showDocumentFailure(card, cause) {
  card.documentFailed = true
  const hasView = Boolean(card.editor ?? card.mediaCleanup ?? card.markdownCleanup)
  const error = reportError(cause, { operation: 'Load file', silent: true })
  if (!hasView) {
    if (!card.errorBoundary?.isConnected) card.host.replaceChildren()
    card.lines.textContent = 'File unavailable'
    card.host.classList.add('has-error')
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
    if (outline) outline.textContent = 'Symbols unavailable'
  }
  const host = hasView ? card.errors : card.host
  if (card.errorBoundary?.parentElement !== host) card.errorBoundary?.remove()
  card.errorBoundary = renderFailure(host, error, {
    scope: hasView ? 'notice' : 'panel',
    title: hasView ? 'Couldn’t update this file' : 'Couldn’t open this file',
    retry: () => loadDocument(card, true),
  })
  if (card.pendingReviewAnchor) {
    if (card.anchorFromIdea) ideas?.notify('The linked file could not be opened.')
    else reviewNotes?.notify('The saved note’s file could not be opened.')
  }
}

/** @param {Card} card @returns {monaco.editor.IStandaloneEditorConstructionOptions} */
function editorOptions(card) {
  const readOnly = editorReadOnly(card)
  return {
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
  }
}

/** @param {Card} card @param {WorkspaceDocument} document */
function renderDocument(card, document) {
  card.restoreErrorFocus = Boolean(card.errorBoundary?.contains(globalThis.document.activeElement))
  card.document = document
  const baseline = comparisonLabel(card)
  const preview = document.preview
  const reading = !preview && isMarkdown(card.file.path) && !card.markdownSource
  const text = document.after
  const reusableMarkdown = reading && card.markdownCleanup && text === card.markdownText && !card.markdownAnchor
  card.note.textContent = preview
    ? ''
    : document.note?.length
      ? document.note
      : document.diffNote?.length
        ? document.diffNote
        : !text && (document.workingMissing || card.file.worktree === 'D' || card.file.index === 'D')
          ? 'This file was deleted. There are no current contents.'
          : ''
  card.note.hidden = !card.note.textContent
  if (reusableMarkdown) {
    revealReviewAnchor(card)
    return
  }
  card.functionEpoch = (card.functionEpoch ?? 0) + 1
  card.mediaCleanup?.()
  card.mediaCleanup = null
  card.markdownCleanup?.()
  card.markdownCleanup = null
  const modes = card.element.querySelector('.markdown-toggle')
  if (modes instanceof HTMLElement) {
    modes.hidden = Boolean(preview)
    for (const button of modes.querySelectorAll('button'))
      button.setAttribute('aria-pressed', String((button.textContent === 'Preview') === reading))
  }
  for (const control of card.element.querySelectorAll('.symbol-outline, .language-state')) {
    if (control instanceof HTMLElement) control.hidden = Boolean(preview) || reading
  }
  card.nextChange.hidden = Boolean(preview) || reading || Boolean(card.reviewComparison)
  const button = requireElement(card.element, '.diff-toggle', HTMLButtonElement)
  button.disabled = false
  button.hidden = false
  button.setAttribute('aria-pressed', String(card.comparing))
  button.title = card.comparing ? 'Show current file' : 'Compare whole file'
  button.setAttribute('aria-label', button.title)
  card.element.dataset.diff = String(card.comparing)
  card.element.dataset.view = preview ? 'document' : reading ? 'markdown' : 'source'
  const labels = requireElement(card.element, '.comparison-labels', HTMLElement)
  labels.hidden = !card.comparing || Boolean(preview)
  for (const label of labels.querySelectorAll('.is-original')) label.textContent = baseline
  if (preview) {
    const match = card.dirty ? undefined : (card.pendingMatch ?? undefined)
    if (match) {
      card.pendingMatch = null
      card.previewRaw = false
    }
    setSaveLabel('Read only')
    releaseEditor(card)
    howmany?.clearFile(card)
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
    if (outline) outline.textContent = 'No outline for this file'
    card.lines.textContent = `${preview.after.size.toLocaleString()} bytes`
    card.language.textContent = preview.after.kind === 'binary' ? 'Binary' : preview.after.kind.toUpperCase()
    card.mediaCleanup = showDocumentPreview(
      card.host,
      preview,
      card.file.path,
      card.comparing,
      card.currentMedia ?? null,
      {
        baseline,
        raw: card.previewRaw,
        match,
        onRawChange: raw => {
          card.previewRaw = raw
        },
      },
    )
    card.textBytes = Object.values(preview).reduce((sum, side) => {
      const data = 'data' in side ? (side.data?.length ?? 0) : 0
      const value = side.kind === 'text' ? side.value.length : 0
      return sum + (data + (side.hex?.length ?? 0) + value) * 2
    }, 0)
    revealReviewAnchor(card)
    return
  }
  const viewState = card.editor?.saveViewState()
  if (reading) {
    releaseEditor(card)
    howmany?.clearFile(card)
    setSaveLabel('Read only')
    const words = text.trim().split(/\s+/).filter(Boolean).length
    card.lines.textContent = `${words.toLocaleString()} words · ${Math.max(1, Math.ceil(words / 220))} min read`
    card.language.textContent = 'Markdown'
    card.textBytes = text.length * 2
    card.markdownCleanup = showMarkdownPreview(card.host, text, {
      filename: card.file.path,
      scrollTop: card.markdownScroll,
      diagramHeights: (card.markdownDiagramHeights ??= []),
      anchor: card.markdownAnchor ?? undefined,
      onScroll: top => {
        card.markdownScroll = top
      },
      media: api.media,
      openExternal: api.openExternal,
      onOpenFile: openFile,
      colorize: colorizeMarkdown,
    })
    card.markdownAnchor = null
    card.markdownText = text
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
    if (outline) showMarkdownOutline(card, outline)
    revealReviewAnchor(card)
    return
  }
  if (!card.element.querySelector('.howmany-counts')) {
    const counts = documentNode('div', 'howmany-counts', '')
    const warnings = documentNode('div', 'howmany-warnings', '')
    counts.hidden = true
    warnings.hidden = true
    warnings.setAttribute('role', 'status')
    card.reviewFocus.bar.before(counts, warnings)
  }
  if (!card.model) {
    if (!snapshot) throw new Error('The workspace closed before its file could be rendered.')
    const root = snapshot.root.replaceAll('\\', '/').replace(/\/$/, '')
    const uri = monaco.Uri.file(`${root}/${card.file.path}`)
    const model = monaco.editor.createModel(text, undefined, uri)
    try {
      monaco.editor.setModelLanguage(model, syntax.resolve(model, text))
      model.detectIndentation(true, 2)
    } catch (cause) {
      model.dispose()
      throw cause
    }
    card.model = model
    const autosave = new Autosave(
      text,
      (value, expected) => api.save(card.file.path, value, expected),
      (state, error) => {
        if (!card.active) return
        card.saveStatus = state
        card.saveError = state === 'error' ? appError(error) : null
        updateSaveLabel(card)
        if (state === 'error') {
          reportError(card.saveError, {
            key: 'save',
            operation: 'Save file',
            title: 'Couldn’t save your changes',
            retry: () => card.autosave?.flush(),
            retryLabel: 'Retry save',
            copy: async () => {
              if (card.active && card.model)
                await globalThis.navigator.clipboard.writeText(card.model.getValue(undefined, true))
            },
          })
        }
        if (state === 'saved') {
          clearErrorNotice('save')
          card.dirty = true
          scheduleDocument()
        }
        syncSaveState()
      },
    )
    card.autosave = autosave
    card.contentCleanup = model.onDidChangeContent(() => {
      const displayed = card.document
      if (card.applyingDocument || !displayed?.editable || card.model !== model) return
      card.editVersion = (card.editVersion ?? 0) + 1
      card.text = model.getValue(undefined, true)
      card.document = { ...displayed, after: card.text }
      autosave.edit(card.text)
      syncSaveState()
    })
  } else if (card.editor && card.text !== text) {
    applyDiskText(card, text)
    if (viewState) card.editor.restoreViewState(viewState)
  }
  if (!card.editor || Boolean(card.diffEditor) !== card.comparing)
    setCardEditor(card, card.editor?.saveViewState() ?? card.viewState)
  const { editor, diffEditor, decorationCollection, model, autosave } = card
  if (!editor || !model || !decorationCollection || !autosave)
    throw new Error('The editor could not be prepared for this file.')
  if (diffEditor) {
    updateComparisonAriaLabels(card)
    card.headContext?.set(baseline === 'HEAD')
  }
  card.text = text
  autosave.accept(text)
  syncLanguageAttachment(card)
  applyEditorReadOnly(card)
  updateSaveLabel(card)
  card.textBytes = text.length * 2 + (card.originalModel ? document.before.length * 2 : 0)
  if (diffEditor && card.originalModel && card.originalText !== document.before) {
    const originalEditor = diffEditor.getOriginalEditor()
    const originalState = originalEditor.saveViewState()
    card.originalModel.setValue(document.before)
    card.originalText = document.before
    if (originalState) originalEditor.restoreViewState(originalState)
  }
  if (card.reviewComparison && diffEditor) {
    if (!card.dirty && card.file.reviewVersion === document.reviewVersion) {
      card.element.dataset.reviewScope = reviewScope
      card.reviewFocus.attach(diffEditor, reviewScope, comparisonAriaLabels(card))
    }
  } else delete card.element.dataset.reviewScope
  /** @type {monaco.editor.IModelDeltaDecoration[]} */
  const decorations = []
  /** @type {Set<number>} */
  const changeLines = new Set()
  for (const change of document.decorations) {
    const start = Math.max(1, Math.min(model.getLineCount(), change.startLine))
    const end = Math.max(start, Math.min(model.getLineCount(), change.endLine))
    changeLines.add(start)
    const deleted = change.kind === 'deleted'
    const kind = deleted ? 'deleted' : change.kind === 'modified' ? 'modified' : 'added'
    decorations.push({
      range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
      options: {
        isWholeLine: !deleted,
        linesDecorationsClassName: `diff-gutter-${kind}`,
        linesDecorationsTooltip: `${kind === 'deleted' ? 'Lines deleted' : kind === 'modified' ? 'Lines modified' : 'Lines added'} compared with ${baseline}`,
        overviewRuler: {
          ...overviewRulerColors[kind],
          position: monaco.editor.OverviewRulerLane.Left,
        },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })
  }
  decorationCollection.set(decorations)
  card.changes = Array.from(changeLines).toSorted((a, b) => a - b)
  card.nextChange.disabled = card.changes.length === 0
  card.lines.textContent = `${document.lineCount.toLocaleString()} ${document.lineCount === 1 ? 'line' : 'lines'}`
  const language = model.getLanguageId()
  card.language.textContent =
    monaco.languages.getLanguages().find(value => value.id === language)?.aliases?.[0] ?? language
  if (diffEditor) diffEditor.layout()
  else editor.layout()
  editor.render(true)
  revealContentMatch(card)
  revealReviewAnchor(card)
  if (document.workingMissing) howmany?.clearFile(card)
  else howmany?.updateFile(card, document)
  if (diffEditor) runTask('Highlight changed functions', () => highlightFunctions(card))
  else card.changedFunctions = 0
  if (requireElement(card.element, '.symbol-outline', HTMLDetailsElement).open)
    runTask('Load file outline', () => showSymbols(card))
  const outline = ui.navigator.querySelector('.navigator-outline[open] .symbol-list')
  if (outline) runTask('Load file outline', () => showSymbols(card, outline))
}

/** @param {monaco.Selection} selection */
function selectionLines(selection) {
  const line = selection.startLineNumber
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > line ? selection.endLineNumber - 1 : selection.endLineNumber
  return { line, endLine }
}

/** @returns {import('../../../electron/tools/assistant/claude-session.mjs').FileReference | null} */
function assistantFileContext() {
  if (!openedFile) return null
  const path = openedFile.path
  const card = cards.get(path)
  if (!card) return { path, side: 'working' }
  /** @type {EditorSide} */
  const side = card.diffEditor && card.noteSide === 'head' && comparisonLabel(card) === 'HEAD' ? 'head' : 'working'
  const editor = side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor
  const selection = editor?.getSelection()
  if (selection && !selection.isEmpty()) {
    const { line, endLine } = selectionLines(selection)
    return { path, side, startLine: line, endLine }
  }
  const visible = editor?.getVisibleRanges()[0]
  if (!visible) return { path, side }
  const startLine = visible.startLineNumber
  return { path, side, startLine, endLine: Math.min(visible.endLineNumber, startLine + 39) }
}

/** @param {Card} card @param {EditorSide} [side] */
function captureIdeaLink(card, side = card.ideaSide ?? 'working') {
  if (side === 'head' && comparisonLabel(card) === 'Checkpoint') side = 'working'
  const editor = side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor
  const model = editor?.getModel()
  const path = card.file.path
  if (!editor || !model) return { path }
  const selection = editor.getSelection()
  let lines
  if (selection && !selection.isEmpty()) lines = selectionLines(selection)
  else {
    // In a focused diff, a viewport can contain several noncontiguous ranges.
    const [visible] = editor.getVisibleRanges()
    if (!visible) return { path, side }
    const line = visible.startLineNumber
    lines = { line, endLine: Math.min(visible.endLineNumber, line + 23) }
  }
  const { line, endLine } = lines
  return { path, side, ...lines, ...captureReviewLines(model, line, endLine) }
}

/** @param {Card} card @param {EditorSide} side */
function captureReviewAnchor(card, side, includeLines = true) {
  if (side === 'head' && comparisonLabel(card) === 'Checkpoint') side = 'working'
  const original = side === 'head'
  const editor = original ? card.diffEditor?.getOriginalEditor() : card.editor
  const model = includeLines ? editor?.getModel() : null
  const selection = model ? editor?.getSelection() : null
  if (!snapshot) return null
  const root = snapshot.root.replace(/\/$/u, '')
  const scope = snapshot.scope ?? snapshot.root
  /** @param {string} path */
  const inScope = path => `${root}/${path}`.startsWith(`${scope.replace(/\/$/u, '')}/`)
  let pathname = card.file.path
  const originalPath = original ? card.file.originalPath : null
  if (!inScope(pathname)) {
    if (!originalPath || !inScope(originalPath)) return null
    pathname = originalPath
  }
  const anchor = {
    path: pathname,
    ...(originalPath && originalPath !== pathname ? { originalPath } : {}),
    side,
    line: null,
    endLine: null,
    excerpt: '',
    truncated: false,
  }
  if (!selection || !model) return anchor
  const { line, endLine } = selectionLines(selection)
  return { ...anchor, line, endLine, ...captureReviewLines(model, line, endLine) }
}

/** @param {Card} card */
function revealReviewAnchor(card) {
  const anchor = card.pendingReviewAnchor
  if (!anchor || !card.document || card.dirty) return
  card.pendingReviewAnchor = null
  if (anchor.line === null) return
  const editor = anchor.side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor
  const model = editor?.getModel()
  if (!editor || !model) {
    showReviewLocation(card, 'The saved lines are unavailable in the current file view.')
    return
  }
  if (anchor.direct) {
    card.noteSide = anchor.side ?? 'working'
    const start = Math.min(anchor.line, model.getLineCount())
    const end = Math.min(anchor.endLine ?? start, model.getLineCount())
    editor.setSelection(new monaco.Range(start, 1, end, model.getLineMaxColumn(end)))
    editor.revealLineInCenter(start, monaco.editor.ScrollType.Immediate)
    return
  }
  const location = locateReviewLines(model, {
    ...anchor,
    side: anchor.side ?? 'working',
    truncated: anchor.truncated ?? false,
  })
  if (!location) return
  if (location.state === 'stale') {
    editor.setPosition({ lineNumber: location.line, column: 1 })
    showReviewLocation(card, 'The captured lines changed. Showing the nearest saved line.')
  } else {
    const range = new monaco.Range(location.line, 1, location.endLine, model.getLineMaxColumn(location.endLine))
    editor.setSelection(range)
    if (location.state === 'moved') {
      const message = `The captured lines moved to line ${location.line.toLocaleString()}.`
      showReviewLocation(card, message)
    }
  }
  editor.revealLineInCenter(location.line, monaco.editor.ScrollType.Immediate)
}

/** @param {Card} card @param {string} message */
function showReviewLocation(card, message) {
  if (card.anchorFromIdea && !ui.ideasPanel.hidden) ideas?.notify(message)
  else if (card.anchorFromIdea || ui.reviewNotesPanel.hidden) {
    card.reviewNotice.hidden = false
    card.reviewNotice.textContent = message
  } else reviewNotes?.notify(message)
}

/** @param {Card} card */
function revealContentMatch(card) {
  const hit = card.pendingMatch
  if (!hit || !card.editor || !card.model || card.dirty) return
  card.pendingMatch = null
  const position = card.model.validatePosition({ lineNumber: hit.line, column: hit.column })
  const range = new monaco.Range(hit.line, hit.column, hit.line, hit.column + hit.length)
  // The file can change between finding a result and loading its editor.
  if (card.model.getValueInRange(range) === hit.match) card.editor.setSelection(range)
  else card.editor.setPosition(position)
  card.editor.revealPositionInCenter(position, monaco.editor.ScrollType.Immediate)
  if (!globalThis.document.querySelector('dialog[open]')) card.editor.focus()
}

/** @param {string} label @param {string} [state] */
function setSaveLabel(label, state = '') {
  const indicator = requireElement(app, '#save-state', HTMLElement)
  indicator.textContent = label
  indicator.dataset.state = state
}

/** @param {Card} card */
function updateSaveLabel(card) {
  /** @type {Record<string, string>} */
  const labels = {
    saving: 'Saving…',
    error: `Save failed · ${shortcutLabel('save')} to retry`,
    saved: 'Saved',
  }
  const state = card.saveStatus ?? ''
  const label = labels[state]
  if (label && (card.autosave?.pending || card.document?.editable)) setSaveLabel(label, state)
  else setSaveLabel(card.document?.editable ? 'Autosave on' : 'Read only')
}

/** @param {Card} card @param {string} text */
function applyDiskText(card, text) {
  const { model } = card
  if (!model) return
  const before = model.getValue()
  const modelHasBOM = model.getValueLength(undefined, true) > before.length
  const hasBOM = text.startsWith('\uFEFF')
  const after = hasBOM ? text.slice(1) : text
  const eol = /\r\n|\r|\n/.exec(after)?.[0]
  card.applyingDocument = true
  try {
    // Monaco stores the BOM separately and uses a single line ending for its buffer.
    // Rebuild the buffer when either changes so existing undo offsets cannot alter them.
    if (modelHasBOM !== hasBOM || (eol && eol !== model.getEOL())) model.setValue(text)
    else if (before !== after) {
      const change = minimalChange(before, after)
      const start = model.getPositionAt(change.start)
      const end = model.getPositionAt(change.end)
      model.applyEdits([{ range: monaco.Range.fromPositions(start, end), text: change.text }])
    }
  } finally {
    card.applyingDocument = false
  }
}

/** @param {Card} card @param {() => boolean} change */
async function changeDocumentMode(card, change) {
  const intent = (card.modeVersion ?? 0) + 1
  card.modeVersion = intent
  if (closingRequested || !card.document) return
  try {
    if (card.autosave?.pending) await card.autosave.flush()
  } catch {
    return
  }
  if (!card.active || closingRequested || intent !== card.modeVersion || !change()) return
  if (!card.comparing || card.comparison === card.renderedComparison) renderCurrentDocument(card)
  syncReviewState()
}

/** @param {Card} card */
function renderCurrentDocument(card) {
  const document = card.document
  if (!document) return
  const result = attempt(() => renderDocument(card, document))
  if (!result.ok) showDocumentFailure(card, result.error)
}

/** @param {Card} card */
function toggleDiff(card) {
  const comparing = !card.comparing
  if (!comparing && isCheckpointOnlyDeletion(card)) return closeCurrentFile()
  return changeDocumentMode(card, () => {
    card.pendingMatch = null
    card.pendingReviewAnchor = null
    card.comparing = comparing
    if (comparing) card.markdownSource = true
    else {
      card.reviewComparison = false
      setDocumentComparison(card, 'head')
    }
    return true
  })
}

/** @param {Card} card @param {WorkspaceComparison} comparison */
function setDocumentComparison(card, comparison) {
  if (card.comparison === comparison) return false
  card.comparison = comparison
  card.generation++
  card.dirty = true
  card.reviewFocus.detach()
  card.diffEditor?.updateOptions({ hideUnchangedRegions: { enabled: false } })
  updateComparisonAriaLabels(card)
  const file = reviewFiles(comparison).find(entry => entry.path === card.file.path)
  card.file = file ?? { path: card.file.path }
  scheduleDocument()
  return true
}

/** @param {Card} card @param {WorkspaceComparison} comparison @param {WorkspaceFile} [file] */
function openComparison(card, comparison, file) {
  card.modeVersion = (card.modeVersion ?? 0) + 1
  card.pendingMatch = null
  const reloading = setDocumentComparison(card, comparison)
  if (file) card.file = file
  if (!card.reviewComparison || !card.comparing || reloading) {
    card.reviewComparison = true
    card.diffEditor?.updateOptions({
      ...diffAppearance(appearance.value, true),
      ...comparisonAriaLabels(card),
    })
    card.comparing = true
    card.markdownSource = true
    if (card.document && !card.documentFailed && !reloading) {
      renderCurrentDocument(card)
    }
  }
  if (card.documentFailed) {
    card.dirty = true
    scheduleDocument()
  }
  syncReviewState()
}

/** @param {Card} card */
function comparisonLabel(card) {
  return card.renderedComparison?.startsWith('checkpoint:') ? 'Checkpoint' : 'HEAD'
}

/** @param {Card} card */
function comparisonAriaLabels(card) {
  return {
    originalAriaLabel: `${comparisonLabel(card)} contents of ${card.file.originalPath ?? card.file.path}`,
    modifiedAriaLabel: `Working contents of ${card.file.path}`,
  }
}

/** @param {Card} card */
function updateComparisonAriaLabels(card) {
  const { diffEditor } = card
  if (!diffEditor) return
  const { originalAriaLabel, modifiedAriaLabel } = comparisonAriaLabels(card)
  diffEditor.getOriginalEditor().updateOptions({ ariaLabel: originalAriaLabel })
  diffEditor.getModifiedEditor().updateOptions({ ariaLabel: modifiedAriaLabel })
}

/** @param {Card} card @param {ViewState | null | undefined} state */
function setCardEditor(card, state) {
  const { model, document } = card
  if (!model || !document) throw new Error('File text must load before opening an editor.')
  for (const action of card.contextActions ?? []) action.dispose()
  card.contextActions = []
  card.headContext = null
  card.languageCleanup?.()
  card.languageCleanup = null
  if (card.diffEditor) {
    card.reviewFocus.detach()
    // Dispose the view model before releasing either text model so pending diffs cancel.
    card.diffEditor.dispose()
    card.diffEditor = null
  } else if (card.editor) {
    card.editor.setModel(null)
    card.editor.dispose()
  }
  card.editor = null
  card.originalModel?.dispose()
  card.originalModel = null
  card.originalDecorations = null
  card.functionDecorations = null
  card.host.replaceChildren()
  if (card.comparing) {
    card.originalText = document.before
    card.originalModel = monaco.editor.createModel(
      card.originalText,
      model.getLanguageId(),
      model.uri.with({ query: 'diffpane-original' }),
    )
    card.diffEditor = monaco.editor.createDiffEditor(card.host, {
      ...editorOptions(card),
      ...diffAppearance(appearance.value, Boolean(card.reviewComparison)),
      ...comparisonAriaLabels(card),
      originalEditable: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      hideUnchangedRegions: { enabled: false },
      maxComputationTime: 150,
      maxFileSize: 2,
      enableSplitViewResizing: true,
    })
    card.diffEditor.setModel({ original: card.originalModel, modified: model })
    card.editor = card.diffEditor.getModifiedEditor()
    const originalEditor = card.diffEditor.getOriginalEditor()
    card.headContext = originalEditor.createContextKey('diffpaneHeadBaseline', comparisonLabel(card) === 'HEAD')
    updateComparisonAriaLabels(card)
    const labels = requireElement(card.element, '.comparison-labels', HTMLElement)
    /** @param {{width: number}} layout */
    const syncLabelWidth = ({ width }) => labels.style.setProperty('--original-width', `${width}px`)
    syncLabelWidth(originalEditor.getLayoutInfo())
    originalEditor.onDidLayoutChange(syncLabelWidth)
    card.originalDecorations = originalEditor.createDecorationsCollection()
    card.functionDecorations = card.editor.createDecorationsCollection()
  } else card.editor = monaco.editor.create(card.host, { ...editorOptions(card), model })
  card.noteSide = 'working'
  card.ideaSide = 'working'
  if (reviewNotes || ideas || assistant) {
    const contextActions = card.contextActions
    let contextFrame = 0
    const refreshAssistantContext = () => {
      if (ui.claudePanel.hidden || contextFrame) return
      contextFrame = requestAnimationFrame(() => {
        contextFrame = 0
        assistant?.refreshContext()
      })
    }
    contextActions.push({ dispose: () => cancelAnimationFrame(contextFrame) })
    /** @param {CodeEditor} editor @param {EditorSide} side */
    const bindContext = (editor, side) => {
      contextActions.push(
        editor.onDidFocusEditorText(() => {
          card.noteSide = side
          card.ideaSide = side
          refreshAssistantContext()
        }),
        editor.onDidChangeCursorSelection(refreshAssistantContext),
        editor.onDidScrollChange(refreshAssistantContext),
      )
      if (reviewNotes)
        contextActions.push(
          editor.addAction({
            id: `diffpane-add-review-note-${side}`,
            label: 'Add review note',
            precondition: side === 'head' ? 'diffpaneHeadBaseline' : undefined,
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 20,
            run: () => {
              if (!closingRequested) reviewNotes.openComposer(captureReviewAnchor(card, side))
            },
          }),
        )
      if (ideas) {
        const surface = editor.getDomNode()
        const selectSide = () => {
          card.ideaSide = side
        }
        surface?.addEventListener('wheel', selectSide, { passive: true })
        contextActions.push(
          { dispose: () => surface?.removeEventListener('wheel', selectSide) },
          editor.onMouseDown(selectSide),
          editor.addAction({
            id: `diffpane-attach-idea-${side}`,
            label: 'Attach selection or view to an idea',
            precondition: side === 'head' ? 'diffpaneHeadBaseline' : undefined,
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 21,
            run: () => attachIdeaLink(captureIdeaLink(card, side)),
          }),
        )
      }
    }
    bindContext(card.editor, 'working')
    if (card.diffEditor) bindContext(card.diffEditor.getOriginalEditor(), 'head')
    refreshAssistantContext()
  }
  card.decorationCollection = card.editor.createDecorationsCollection()
  if (state) card.editor.restoreViewState(state)
}

/** @param {Card} card */
function syncLanguageAttachment(card) {
  const { document, editor, model } = card
  if (!document || !editor || !model) return
  if (document.workingMissing) {
    card.languageCleanup?.()
    card.languageCleanup = null
  } else
    card.languageCleanup ??= languageFeatures.attach(editor, model, card.file.path, {
      active: true,
    })
}

/** @param {ReturnType<typeof changedFunctionRanges>} functions @param {'before' | 'after'} kind */
function functionDecorations(functions, kind) {
  return functions.map(fn => ({
    range: new monaco.Range(fn.startLine, 1, fn.endLine, 1),
    options: {
      isWholeLine: true,
      className: `diff-function-${kind}`,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }))
}

/** @param {Card} card */
async function highlightFunctions(card) {
  const epoch = card.functionEpoch
  const document = card.document
  if (!document) return
  /** @param {Awaited<ReturnType<typeof languageFeatures.symbols>>} [symbols] */
  const paint = (symbols = []) => {
    if (
      !card.diffEditor ||
      !card.functionDecorations ||
      !card.originalDecorations ||
      epoch !== card.functionEpoch ||
      !card.active
    )
      return
    const modified = changedFunctionRanges(document.after ?? '', document.decorations ?? [], symbols)
    const original = changedFunctionRanges(document.before ?? '', document.beforeDecorations ?? [])
    card.functionDecorations.set(functionDecorations(modified, 'after'))
    const markers = (document.beforeDecorations ?? []).map(change => ({
      range: new monaco.Range(change.startLine, 1, change.endLine ?? change.startLine, 1),
      options: {
        linesDecorationsClassName: `diff-gutter-${change.kind}`,
        overviewRuler: {
          ...overviewRulerColors.deleted,
          position: monaco.editor.OverviewRulerLane.Left,
        },
      },
    }))
    card.originalDecorations.set([...functionDecorations(original, 'before'), ...markers])
    card.changedFunctions = modified.length
  }
  paint()
  try {
    paint(await languageFeatures.symbols(card.file.path))
  } catch {
    /* Lexical ranges stay visible when a server is unavailable. */
  }
}

// A single replacement keeps Monaco's existing model, token state, and selection markers.
/** @param {string} before @param {string} after */
export function minimalChange(before, after) {
  let start = 0
  const shortest = Math.min(before.length, after.length)
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++
  if (start > 0 && isLowSurrogate(before.charCodeAt(start))) start--
  let end = before.length
  let afterEnd = after.length
  while (end > start && afterEnd > start && before.charCodeAt(end - 1) === after.charCodeAt(afterEnd - 1)) {
    end--
    afterEnd--
  }
  if (end < before.length && isLowSurrogate(before.charCodeAt(end))) {
    end++
    afterEnd++
  }
  return { start, end, text: after.slice(start, afterEnd) }
}

/** @param {number} code */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} className @param {string} text */
function documentNode(tag, className, text) {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

/** @param {Card} card */
function deactivate(card) {
  howmany?.clearFile(card)
  card.active = false
  card.generation++
  card.dirty = true
  card.mediaCleanup?.()
  card.mediaCleanup = null
  card.markdownCleanup?.()
  card.markdownCleanup = null
  releaseEditor(card)
  card.document = null
  card.currentMedia = null
  card.textBytes = 0
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''))
}

/** @param {Card} card */
function releaseEditor(card) {
  if (!card.model && !card.editor && !card.diffEditor) return
  for (const action of card.contextActions ?? []) action.dispose()
  card.contextActions = []
  card.headContext = null
  card.noteSide = 'working'
  card.ideaSide = 'working'
  card.contentCleanup?.dispose()
  card.contentCleanup = null
  card.autosave = null
  if (card.editor) card.viewState = card.editor.saveViewState()
  card.languageCleanup?.()
  card.languageCleanup = null
  requireElement(card.element, '.symbol-outline', HTMLDetailsElement).open = false
  card.reviewFocus.detach()
  delete card.element.dataset.reviewScope
  if (card.diffEditor) card.diffEditor.dispose()
  else card.editor?.dispose()
  card.originalModel?.dispose()
  card.originalModel = null
  card.originalText = null
  card.originalDecorations = null
  card.functionDecorations = null
  card.changedFunctions = 0
  card.diffEditor = null
  card.functionEpoch = (card.functionEpoch ?? 0) + 1
  card.model?.dispose()
  card.editor = null
  card.model = null
  card.decorationCollection = null
  card.textBytes = 0
  card.text = null
  card.saveStatus = null
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''))
}

async function recoverWorkspace() {
  const initialFailure = workspaceFailure
  const next = initialFailure ? await api.restartWorkspace() : await api.refresh()
  if (workspaceFailure && workspaceFailure !== initialFailure) throw workspaceFailure
  workspaceFailure = null
  applySnapshot(next)
  if (initialFailure) {
    for (const card of cards.values()) {
      if (!card.active || !card.editor || !card.model) continue
      card.languageCleanup?.()
      card.languageCleanup = null
      syncLanguageAttachment(card)
    }
  }
  if (next?.files) clearErrorNotice('workspace')
}

/** @param {unknown} cause */
function showWorkspaceFailure(cause) {
  if (closed) return
  const error = appError(cause, { operation: 'Read workspace' })
  if (error.code === 'BACKEND_UNAVAILABLE') workspaceFailure = error
  else if (workspaceFailure) return
  const retryLabel = workspaceFailure ? 'Reconnect workspace' : 'Try again'
  const title = snapshot ? 'Workspace connection interrupted' : 'Couldn’t open this project'
  if (snapshot) {
    finishWorkspaceOpening()
    reportError(error, {
      key: 'workspace',
      title,
      retry: recoverWorkspace,
      retryLabel,
      diagnostic: 'renderer.workspace-error',
    })
    return
  }
  showStartScreen(true)
  reportError(error, { silent: true, diagnostic: 'renderer.workspace-error' })
  const boundary = renderFailure(ui.startError, error, {
    scope: 'panel',
    title,
    retry: recoverWorkspace,
    retryLabel,
  })
  const label = boundary.getAttribute('aria-labelledby')
  if (label) ui.startScreen.setAttribute('aria-labelledby', label)
}

function refresh() {
  if (!snapshot) return
  runTask('Refresh workspace', async () => {
    const result = await attemptAsync(recoverWorkspace)
    if (!result.ok) showWorkspaceFailure(result.error)
  })
}

/** @param {ShortcutOverrides} overrides */
function applyShortcutOverrides(overrides) {
  shortcutOverrides = overrides
  /** @type {[HTMLElement | null, import('../../../shared/preferences/shortcuts.ts').ShortcutAction, string][]} */
  const controls = [
    [ui.settingsToggle, 'openSettings', 'Settings'],
    [ui.contentSearchToggle, 'searchProject', 'Search in project'],
    [ui.reviewToggle, 'reviewChanges', 'Review changes'],
    [ui.reviewNotesToggle, 'reviewNotes', 'Review notes'],
    [ui.claudeToggle, 'toggleClaude', 'The Creature'],
    [ui.ideasToggle, 'toggleIdeas', 'Ideas'],
    [ui.navigator.querySelector('button[data-action="open-file"]'), 'searchFiles', 'Search files'],
    [ui.reviewNotesPanel.querySelector('button[data-review-action="save"]'), 'saveReviewNote', 'Save note'],
  ]
  for (const [control, action, label] of controls) {
    if (!control) continue
    control.title = `${label} · ${shortcutLabel(action)}`
    control.setAttribute('aria-keyshortcuts', ariaBinding(shortcutBinding(action), isMac))
  }
  updateEmptyStateHint()
  const card = openedFile ? cards.get(openedFile.path) : undefined
  if (card?.document) updateSaveLabel(card)
  if (shortcutBinding('find') === defaultBinding('find', isMac)) {
    removedEditorFind?.dispose()
    removedEditorFind = undefined
  } else {
    removedEditorFind ??= monaco.editor.addKeybindingRule({
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
      command: '-actions.find',
    })
  }
  ideas?.refreshShortcuts()
  settings?.refresh()
}

function searchFiles() {
  if (snapshot) runTask('Search files', openFilePicker)
  else openTarget('file')
}

/** @param {KeyboardEvent} event */
function findAction(event) {
  if (event.target === ui.navigator.querySelector('.navigator-tree')) return navigator.focusSearch
  const card = openedFile ? cards.get(openedFile.path) : undefined
  const original = card?.diffEditor?.getOriginalEditor()
  const editor = original?.hasWidgetFocus() ? original : card?.editor
  if (editor?.hasWidgetFocus()) {
    const action = editor.getAction('actions.find')
    if (action) return () => action.run()
  }
  return undefined
}

const workspaceShortcuts = {
  searchFiles: () => searchFiles,
  quickOpen: () => searchFiles,
  searchProject: () => contentSearch && snapshot && openContentSearch,
  reviewNotes: () => reviewNotes && snapshot && (() => ui.reviewNotesToggle.click()),
  reviewChanges: () => snapshot && toggleReview,
  toggleClaude: () => assistant && (() => ui.claudeToggle.click()),
  toggleIdeas: () => ideas && snapshot && (() => ui.ideasToggle.click()),
  toggleExplorer: () => snapshot && toggleNavigator,
  refresh: () => snapshot && refresh,
  save: (/** @type {KeyboardEvent} */ event) => {
    if (ideas && event.target instanceof Node && ui.ideasPanel.contains(event.target)) return () => ideas.flush()
    const autosave = (openedFile ? cards.get(openedFile.path) : undefined)?.autosave
    return autosave && (() => autosave.flush())
  },
  find: findAction,
}

document.addEventListener(
  'keydown',
  event => {
    if (!api || app.inert || closingRequested || settings?.isOpen || event.defaultPrevented) return
    if (document.querySelector('dialog#claude-settings')?.matches('[open]')) return
    const binding = bindingFromEvent(event, isMac)
    if (!binding) return
    if (ideas?.handleShortcut(event, binding)) return
    const pickerOpen = document.querySelector('dialog#file-picker')?.matches('[open]')
    for (const [action, resolve] of Object.entries(workspaceShortcuts)) {
      if (!isShortcutAction(action) || binding !== shortcutBinding(action)) continue
      if (pickerOpen && action !== 'searchFiles' && action !== 'quickOpen') return
      if (contentSearch?.isOpen && action !== 'searchProject') return
      const run = resolve(event)
      if (run) {
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) runTask('Run keyboard shortcut', run, { silent: action === 'save' })
      }
      return
    }
  },
  { capture: true },
)
applyShortcutOverrides(shortcutOverrides)

const unsubscribeSettings = shortcutApi?.onOpenSettings(openSettings)
const unsubscribeShortcuts = shortcutApi?.onChange(overrides => {
  shortcutVersion++
  applyShortcutOverrides(overrides)
})
if (shortcutApi) {
  const initialVersion = shortcutVersion
  const loadShortcuts = async () => {
    if (closed || shortcutVersion !== initialVersion) return
    const overrides = await shortcutApi.get()
    if (!closed && shortcutVersion === initialVersion) applyShortcutOverrides(overrides)
  }
  runTask('Load keyboard shortcuts', loadShortcuts, {
    title: 'Couldn’t load your shortcuts',
    retry: loadShortcuts,
  })
}

Object.assign(window, {
  __diffpane: {
    stats: () => ({
      files: cards.size,
      documentLoading: Boolean((openedFile ? cards.get(openedFile.path) : undefined)?.loading),
      snapshotRevision: snapshot?.revision ?? 0,
      activeEditors: [...cards.values()].filter(card => card.editor).length,
      models: monaco.editor.getModels().length,
      loadedTextBytes: [...cards.values()].reduce((total, card) => total + card.textBytes, 0),
      diffMode: Boolean((openedFile ? cards.get(openedFile.path) : undefined)?.diffEditor),
      changedFunctions: (openedFile ? cards.get(openedFile.path) : undefined)?.changedFunctions ?? 0,
      openedPath: openedFile?.path ?? null,
      openedLanguage: (openedFile ? cards.get(openedFile.path) : undefined)?.model?.getLanguageId() ?? null,
      syntax: syntax.stats(),
      navigator: navigator?.stats(),
      languages: languageFeatures?.stats(),
    }),
  },
})

{
  const resumeEditing = () => {
    closingRequested = false
    syncIdeasVisibility(uiPreferences.get('ideasVisible'))
    ideas?.setReadOnly(false)
    for (const card of cards.values()) applyEditorReadOnly(card)
    syncReviewState()
  }
  const unsubscribeResume = api.onResumeEditing(resumeEditing)
  const flushSaves = () =>
    rendererDiagnostics.run('renderer.workspace-flush-saves', async () => {
      const results = await Promise.allSettled([
        ...[...cards.values()].map(card => card.autosave?.flush()),
        applyingAssistantEdit,
        ideas?.flush(),
        uiPreferences.settled(),
      ])
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw appError(failed.reason, { operation: 'Save before closing' })
      syncSaveState()
      clearErrorNotice('close')
    })
  const unsubscribeFlush = api.onFlushSaves(id =>
    runTask('Flush file saves', async () => {
      closingRequested = true
      try {
        ideas?.setReadOnly(true)
        for (const card of cards.values()) applyEditorReadOnly(card)
        syncReviewState()
        await flushSaves()
        api.savesFlushed(true, id)
      } catch (cause) {
        api.savesFlushed(false, id)
        reportError(cause, {
          key: 'close',
          operation: 'Save before closing',
          title: 'This window stayed open to keep your changes',
          retry: flushSaves,
          retryLabel: 'Retry save',
        })
      }
    }),
  )
  const unsubscribeIdeas = api.ideas?.onChange(change => ideas?.applyChange(change))
  api.rendererReady()
  const unsubscribePaths = subscribeLivePaths(
    api,
    guard('Apply file updates', paths => {
      const card = openedFile ? cards.get(openedFile.path) : undefined
      if (
        card &&
        paths.some(path => path === '*' || card.file.path === path || card.file.path.startsWith(`${path}/`))
      ) {
        card.dirty = true
        syncReviewState()
        scheduleDocument()
      }
    }),
  )
  /** @type {WorkspaceSnapshot | null} */
  let pendingSnapshot = null
  const snapshotPaths = new LivePathBatch()
  /** @type {number | null} */
  let snapshotFrame = null
  const unsubscribe = api.onChange(next => {
    if (closed) return
    if (!next) return
    if (
      !pendingSnapshot ||
      next.revision > pendingSnapshot.revision ||
      (next.revision === pendingSnapshot.revision && next.inventoryRevision >= pendingSnapshot.inventoryRevision)
    ) {
      pendingSnapshot = next
    }
    // Even an older snapshot can carry a path change missing from the newest snapshot.
    snapshotPaths.add(next.changedPaths ?? ['*'])
    snapshotFrame ??= requestAnimationFrame(() => {
      const pending = pendingSnapshot
      pendingSnapshot = null
      snapshotFrame = null
      if (!pending) return
      const result = attempt(() => applySnapshot({ ...pending, changedPaths: snapshotPaths.take() }))
      if (!result.ok) showWorkspaceFailure(result.error)
    })
  })
  const unsubscribeErrors = api.onError(showWorkspaceFailure)
  reducedMotion.addEventListener('change', revealWorkspaceWhenReady)
  runTask('Load workspace', async () => {
    const result = await attemptAsync(async () => applySnapshot(await api.snapshot()))
    if (!result.ok) showWorkspaceFailure(result.error)
  })
  window.addEventListener(
    'pagehide',
    () => {
      closed = true
      window.clearTimeout(workspaceOpeningTimer)
      reducedMotion.removeEventListener('change', revealWorkspaceWhenReady)
      howmany?.dispose()
      assistant?.dispose()
      reviewNotes?.dispose()
      workspaceLayout.dispose()
      unsubscribeIdeas?.()
      ideas?.dispose()
      contentSearch?.dispose()
      if (snapshotFrame !== null) cancelAnimationFrame(snapshotFrame)
      if (documentFrame !== null) cancelAnimationFrame(documentFrame)
      navigator.dispose()
      review.dispose()
      unsubscribePaths()
      appearance.dispose()
      unsubscribeIdeaVisibility()
      uiPreferences.dispose()
      unsubscribeSettings?.()
      unsubscribeShortcuts?.()
      removedEditorFind?.dispose()
      unsubscribeFlush()
      unsubscribeResume()
      languageFeatures.dispose()
      if (typeof unsubscribe === 'function') unsubscribe()
      if (typeof unsubscribeErrors === 'function') unsubscribeErrors()
      for (const card of cards.values()) deactivate(card)
      languageWidgets.remove()
    },
    { once: true },
  )
}

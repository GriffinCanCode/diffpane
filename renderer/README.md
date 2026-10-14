---
doc_radar:
  sentinels:
    - file: renderer/main.js
      contains: ['createDecorationsCollection', 'restoreViewState', 'model.applyEdits']
    - file: renderer/navigator.js
      contains: ['flattenNavigationTree', 'OVERSCAN', 'requestAnimationFrame']
    - file: renderer/languages.js
      contains: ['createLanguageFeatures', 'semanticChanged', 'inlayHints']
    - file: renderer/grammars.ts
      contains: ['createOnigurumaEngine', 'shikiToMonaco']
    - file: renderer/files.ts
      contains: ['aria-activedescendant', 'picker-retry', 'ROW_HEIGHT']
    - file: renderer/file-search.ts
      contains: ['searchFiles', 'toLocaleLowerCase']
    - file: renderer/icons.ts
      contains: ['material-icon-theme']
---

# Viewer

Markdown opens in a reading view with balanced typography, highlighted code and copy buttons, scrollable GFM tables, task lists, callouts, local images, and heading links. The explorer outline lists document headings. Frontmatter stays available under Document metadata. Preview and Source switch between the rendered document and Monaco; Compare opens the full source diff. Saves refresh the reading view while keeping its scroll position.

Mermaid fences render on demand with a dark theme. Each diagram can show its source, copy its definition, or expand into a zoomable viewer. Wide diagrams fit the reading column. Invalid diagrams retain their source and a useful error. Markdown HTML is sanitized, Mermaid uses strict security, and local links/images resolve inside the project. External web links open in the system browser.

The explorer projects metadata into a virtualized folder tree. Git-ignored files and folders have muted gray labels and subdued icons. Ignored folders start unloaded, read only immediate children on expansion, and release descendant tree nodes and search indexes on collapse. The file picker searches tracked and nonignored files and their folders. Both search surfaces have a Filters button with file/folder, language, extension, and folder-path controls. Choosing a folder reveals and expands it in the explorer. Its flat chrome and Material icons follow the supplied editor reference; search stays visible above the scrolling tree, including after clearing or losing focus. Clicking a file opens its contents in the main pane. Images fit the available space and toggle to actual size on click; videos have native playback, seeking, volume, and fullscreen controls. Media refreshes on saves, and switching files releases playback and its source. Git markers sit beside the line numbers and in the right overview ruler; code keeps its normal syntax colors. The editor keeps its neutral background.

Right-click a file or folder to open, rename, reveal it in Finder, copy its absolute or relative path, or move it to Trash. F2 renames the focused entry; Shift+F10 opens its menu. Renames reject existing names and keep an open descendant selected under its new path. File operations flush pending edits before changing the disk.

⌘P or the explorer’s Search files action opens a dedicated search window for the current project. We rank filenames before directories, accept path abbreviations and multiple terms, and highlight each match. Arrow keys and Page Up/Down move through virtualized results; Enter opens the selected file or reveals the selected folder. Clear, Close, Escape, and retry controls keep search usable without a mouse or after a failed inventory read.

The TypeScript document-preview module renders images, audio, video, PDF documents, bounded large text, and hexadecimal inspection. Comparison mode shows original and current previews; Hex selection persists across updates. Unsupported media falls back to bytes. Switching files or views releases Blob URLs, playback, and editor models.

Language providers attach to visible models. Syntax grammars load on demand; real language servers supply only the features they advertise. Requests cancel when models change or close, and stale results never replace newer content.

HowMany adds a collapsible explorer summary, a status-bar report action, and a per-file breakdown above the editor. Its report uses the app's native typography, composition bars, quality scores, language rows, and structural metrics only when the analyzer actually returned structural data. A native save dialog exports JSON. HowMany owns separate Monaco diagnostic markers, and file switches cancel its pending counts.

Files load before automatic HowMany workspace analysis starts. The explorer and initial document finish loading, then analysis yields through a paint opportunity and runs during an idle turn. Per-file counts also wait for a paint opportunity; switching files cancels queued counts, and delayed results cannot replace counts for a newer selection. A slow or unavailable analyzer leaves browsing and editing usable.

Live updates edit the existing model and restore its view state. Switching files disposes the previous model and its requests. The title bar keeps a muted monochrome mark, project context, and branch; search stays in the explorer and live updates run without a title bar indicator. The chrome uses OKLCH colors and adapts to narrower windows.

Large file-picker searches run in a Web Worker with a reusable path index and coalesced queries; only the newest query can publish results. Status-only snapshots update explorer badges without rebuilding the inventory or visible projection. File navigation keeps one document read in flight, skips superseded selections, and remembers up to 64 file view positions without retaining their Monaco models. Live saves preserve the current model and batch snapshot updates per animation frame.

Closing the file picker releases its duplicate inventory, result rows, scheduled frame, and search worker. Reopening rebuilds the search index on demand. Repeated renders of an unchanged editor version reuse its HowMany counts; explicit refresh still requests fresh counts. Text bounds and line counts scan newline offsets without allocating arrays of every line, and bounded previews own their strings so small cached previews cannot retain a large source string.

The split-pane glyph in the file header toggles a whole-file comparison: read-only HEAD on the left and the editable working file on the right. Only changed functions receive a subtle block tint; unchanged functions stay neutral, and neither version uses inline character differences. Current language-server symbols supply function boundaries when available, with lexical boundaries before a server responds. Leaving comparison mode releases the original model.

Text edits save immediately through a serialized queue that coalesces changes during each write. Incoming document reads cannot replace pending edits or a newer model version. File switches, source/preview changes, and window close flush pending saves; failures retain the editable buffer and ⌘S retries. Programmatic disk updates do not trigger another save.

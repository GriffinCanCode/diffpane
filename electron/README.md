---
doc_radar:
  sentinels:
    - file: electron/repository.mjs
      contains: ['--porcelain=v2', '--no-optional-locks', 'readLimit', 'async files()']
    - file: electron/main.mjs
      contains: ['new Worker', 'languageProcesses', 'before-quit']
    - file: electron/language.mjs
      contains: ['LanguageRuntime', 'textDocument/didOpen', 'textDocument/didClose']
---

# Desktop, Git, and languages

Window management stays in the main process; Git and language-server work runs in a worker. The preload exposes document reads, status, refresh, native file and folder pickers, and a bounded language-service API. Launching without a target, or choosing New Window, opens a welcome window without starting a worker. Opening a target replaces that welcome window; an existing workspace stays open in its own window. The terminal launcher still supplies the current directory explicitly, and Finder file opens use the selected path.

The welcome screen's Recently opened list remembers up to eight successful file or folder targets in the app's user-data directory. Initial Git snapshots confirm a target before it enters history. Reopening moves it to the front, missing targets are removed when selected, and atomic serialized writes finish before quit. Separate app instances reload committed history and coordinate modifications with a bounded lockfile. Missing, corrupt, or unwritable history never blocks startup or opening a project; uncommitted changes stay available in memory until a later successful write.

File and folder operations validate scope, resolved parent directories, and Git metadata boundaries. Renames accept one basename and reject name collisions; deleting moves the entry to the system Trash. Changes refresh the inventory and invalidate cached documents.

Text saves use a scoped IPC call and validate regular files, parent confinement, payload limits, and the expected disk contents before writing. Saves retain source encoding and permissions, flush the file descriptor, invalidate the document cache, and notify watchers and language services directly. The renderer reports pending edits and readiness so clean windows can close or quit even when startup or the backend fails. Pending edits require a successful save flush before closing or quitting; failed saves and unavailable renderers retain the window. Flush requests time out after five seconds and resume editing instead of leaving a close request pending forever.

Working images, audio, and videos use a private `diffpane-media` protocol scoped to each window's file inventory. Responses stream from regular file descriptors and support byte ranges for video seeking, independently of the text preview size limit. Requests reject external symlinks and paths outside the repository; closing the window revokes its media URLs.

The repository module uses NUL-delimited Git output and bounded reads. Its inventory includes existing tracked files, nonignored untracked files, and ignored directory placeholders. Missing tracked paths remain in Git status but leave the explorer and file picker; restoring them refreshes the inventory. Ignore discovery checks paths in batches and inspects only nonignored parents, without walking ignored dependency trees. Expanding an ignored folder reads only its immediate children and sends an inventory delta without rescanning Git. Collapsing it or an ancestor releases ignored descendant metadata and cached documents; an already open file remains usable. Contents load on demand. The session coalesces native watcher events, indexes file metadata by path, and retains the inventory across content-only saves. It shares duplicate document reads, runs at most two reads concurrently, and limits the document cache to 24 entries and 16 MiB of estimated payload. Changed paths invalidate their own documents, including descendants of changed directories; Git metadata changes invalidate all comparisons. Immutable Git blobs have a separate 8 MiB cache.

The TypeScript file-content reader recognizes media signatures, decodes Unicode and legacy text, and supplies bounded text and hexadecimal previews for every regular file. Working media reads only a 64 KiB sample for inspection and streams playback separately. Historical media and PDFs use inline data capped at 16 MiB. Preview strings count toward the document cache budget.

Continuous edits cannot hold a document read open indefinitely: invalidated reads retry once, then return the latest successful result without caching stale contents. Explicitly requested documents move ahead of older queued reads. Inventory requests also return completed scans while later changes queue reconciliation. Fallback polling waits for active status and inventory work before beginning its next scan. Events inside collapsed ignored directories are filtered before batching unless they affect a loaded document.

Diff calculation runs in a separate lazy worker so it cannot block watcher or language messages. Time and decoration budgets bound pathological diffs. The worker releases its isolate after 30 seconds without diff work and restarts on demand. Healthy native watchers need no polling timer; a two-second fallback starts only after a subscription fails. Closing a window waits for any starting watcher subscription before releasing watchers, caches, and both workers. Successful disposal lets the session worker exit naturally so native completion callbacks can drain; failed or stalled workers retain a bounded termination fallback. Only the disposal response closes the worker's message port.

The language runtime discovers tools without launching them, selects the nearest project manifest, and starts servers only for opened documents. It owns framing, configuration, cancellation, diagnostics, idle eviction, and process-group shutdown. The main process tracks owned PIDs so closing a window also cleans up a stalled worker's servers.

HowMany runs in the session worker with a separate language runtime, so its all-language counts and diagnostics do not displace either language server. Workspace analyses coalesce, run without a shell or disk cache, cap output at 16 MiB, time out after 30 seconds, and use two threads. The main process tracks both analysis and LSP processes for window cleanup. The binary bundled by `setup-howmany.ts` takes precedence over PATH and is unpacked from ASAR so the installed app can execute it without shell setup.

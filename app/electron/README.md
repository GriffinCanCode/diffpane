---
doc_radar:
  sentinels:
    - file: app/electron/workspace/repository/repository.mjs
      contains: ['--porcelain=v2', '--no-optional-locks', 'readLimit', 'async files()']
    - file: app/electron/runtime/window/main.mjs
      contains: ['new Worker', 'languageProcesses', 'before-quit']
    - file: app/electron/tools/languages/language.mjs
      contains: ['LanguageRuntime', 'textDocument/didOpen', 'textDocument/didClose']
    - file: app/electron/tools/analysis/howmany.mjs
      contains: ['validCounts', 'hasSourceReport', 'breakdown.rows']
---

# Electron backend

- [Runtime](runtime/README.md) owns Electron windows, the preload API, and the workspace session worker.
- [Workspace](workspace/README.md) owns Git operations, document and media reads, and diff calculation.
- [Persistence](persistence/README.md) owns the encrypted database, application preferences, and project records.
- [Tools](tools/README.md) owns language servers, HowMany analysis, and Claude integration.

Run `npm run dev -- .` from the repository root to open this checkout in Diffpane. Each module README lists the tests that exercise its boundary.

## Desktop behavior

Window management stays in the main process; Git and language-server work runs in a worker. The preload exposes document reads, status, refresh, native file and folder pickers, and a bounded language-service API. Launching without a target, or choosing New Window, opens a welcome window without starting a worker. Opening a target replaces that welcome window; an existing workspace stays open in its own window. The terminal launcher still supplies the current directory explicitly, and Finder file opens use the selected path.

Ideas, review notes, recent paths, shortcuts, appearance, pane layout, and Ideas docking are stored in `state/local.sqlite` under the app's user-data directory. SQLite commits are transactional across app instances and use write-ahead logging with full synchronization. Records are compressed with Zstandard when that reduces their size, then encrypted with AES-256-GCM. Keyed indexes keep workspace paths and record IDs out of plaintext. The database holds the data key wrapped by Electron's OS-backed secure storage. Claude credentials use the OS-backed credential store separately.

Legacy database and JSON records are imported in a transaction before their source files are removed. Old renderer preferences are imported when their original renderer storage is available. Unreadable source data is retained for recovery. Review checkpoints, Claude conversations, and caches stay in memory. Project file edits continue to save directly to the working tree.

The welcome screen remembers up to eight successful file or folder targets. An initial Git snapshot confirms a target before it enters history. Reopening moves it to the front, and missing targets are removed when selected. If local storage is temporarily unavailable, recent changes remain in bounded memory and merge with committed history when storage recovers.

File and folder operations validate scope, resolved parent directories, and Git metadata boundaries. Renames accept one basename and reject name collisions; deleting moves the entry to the system Trash. Changes refresh the inventory and invalidate cached documents.

Text saves use a scoped IPC call and validate regular files, parent confinement, payload limits, and the expected disk contents before writing. Saves retain source encoding and permissions, flush the file descriptor, invalidate the document cache, and notify watchers and language services directly. The renderer reports pending edits and readiness so clean windows can close or quit even when startup or the backend fails. Pending edits require a successful save flush before closing or quitting; failed saves and unavailable renderers retain the window. Flush requests time out after five seconds and resume editing instead of leaving a close request pending forever.

IPC failures carry a message, code, operation, and recoverability flag through the preload. Reconnecting restarts the workspace worker in the same window and keeps snapshot revisions moving forward. A crashed renderer offers native reload and close actions, with a warning when the window had unsaved changes.

Working images, audio, and videos use a private `diffpane-media` protocol scoped to each window's file inventory. Responses stream from regular file descriptors and support byte ranges for video seeking, independently of the text preview size limit. Requests reject external symlinks and paths outside the repository; closing the window revokes its media URLs.

The repository module uses NUL-delimited Git output and bounded reads. Its inventory includes existing tracked files, nonignored untracked files, and ignored directory placeholders. Missing tracked paths remain in Git status but leave the explorer and file picker; restoring them refreshes the inventory. Ignore discovery checks paths in batches and inspects only nonignored parents, without walking ignored dependency trees. Expanding an ignored folder reads only its immediate children and sends an inventory delta without rescanning Git. Collapsing it or an ancestor releases ignored descendant metadata and cached documents; an already open file remains usable. Contents load on demand. The session coalesces native watcher events, indexes file metadata by path, and retains the inventory across content-only saves. It shares duplicate document reads, runs at most two reads concurrently, and limits the document cache to 24 entries and 16 MiB of estimated payload. Changed paths invalidate their own documents, including descendants of changed directories; Git metadata changes invalidate all comparisons. Immutable Git blobs have a separate 8 MiB cache.

The TypeScript file-content reader recognizes media signatures, decodes Unicode and legacy text, and supplies bounded text and hexadecimal previews for every regular file. Working media reads only a 64 KiB sample for inspection and streams playback separately. Historical media and PDFs use inline data capped at 16 MiB. Preview strings count toward the document cache budget.

Each workspace window can hold one review checkpoint in memory. It retains working previews for paths already changed at capture and uses capture-time Git blobs for paths Git considered clean. Git checkout conversions can affect the comparison for those clean paths. The session reviews the union of captured paths, current Git status paths, and paths changed in later commits. It hashes file contents so staging alone does not change a checkpoint review version. Checkpoint scans cover up to 2,000 paths and 1 GiB of reads, with up to 512 MiB per file and 32 MiB of retained previews. Submodules have their own working trees and can be opened in separate windows.

Continuous edits cannot hold a document read open indefinitely: invalidated reads retry once, then return the latest successful result without caching stale contents. Explicitly requested documents move ahead of older queued reads. Inventory requests also return completed scans while later changes queue reconciliation. Fallback polling waits for active status and inventory work before beginning its next scan. Events inside collapsed ignored directories are filtered before batching unless they affect a loaded document.

Quiet fallback polls compare Git records and filesystem metadata without publishing new snapshots, clearing caches, rebuilding the explorer, or restarting analysis. Repeated content saves and changes to open ignored files still invalidate their own documents; directory changes refresh the inventory. Known files can open from the last inventory while a replacement scan runs. Automatic HowMany scans wait between runs according to the previous scan's duration, capped at one minute, while explicit Refresh stays immediate.

Diff calculation runs in a separate lazy worker so it cannot block watcher or language messages. Time and decoration budgets bound pathological diffs. The worker releases its isolate after 30 seconds without diff work and restarts on demand. Healthy native watchers need no polling timer; a two-second fallback starts only after a subscription fails. Closing a window waits for any starting watcher subscription before releasing watchers, caches, and both workers. Successful disposal lets the session worker exit naturally so native completion callbacks can drain; failed or stalled workers retain a bounded termination fallback. Only the disposal response closes the worker's message port.

The language runtime discovers tools without launching them, selects the nearest project manifest, and starts servers only for opened documents. It owns framing, configuration, cancellation, diagnostics, idle eviction, and process-group shutdown. The main process tracks owned PIDs so closing a window also cleans up a stalled worker's servers.

HowMany runs in the session worker with a separate language runtime, so its all-language counts and diagnostics do not displace either language server. Workspace analyses coalesce, run without a shell or disk cache, cap output at 16 MiB, time out after 30 seconds, and use two threads. The main process tracks both analysis and LSP processes for window cleanup. The binary bundled by `app/tooling/dependencies/setup-howmany.ts` takes precedence over PATH and is unpacked from ASAR so the installed app can execute it without shell setup.

We bundle the released HowMany counter by revision and source checksum. Workspace reports must include consistent source totals and category rows before they reach the renderer; older reports cannot silently supply the code headline. Normal ignore rules apply, and new untracked source files remain part of the analysis.

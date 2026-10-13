---
doc_radar:
  sentinels:
    - file: electron/repository.mjs
      contains: ['--porcelain=v2', '--no-optional-locks', 'MAX_FILE_BYTES', 'async files()']
    - file: electron/main.mjs
      contains: ['new Worker', 'languageProcesses', 'before-quit']
    - file: electron/language.mjs
      contains: ['LanguageRuntime', 'textDocument/didOpen', 'textDocument/didClose']
---

# Desktop, Git, and languages

Window management stays in the main process; Git and language-server work runs in a worker. The preload exposes document reads, status, refresh, the native folder picker, and a bounded language-service API.

The repository module uses NUL-delimited Git output and bounded reads. Its inventory includes unchanged tracked files and nonignored untracked files, with contents loaded on demand. The session coalesces native watcher events and keeps a small document cache.

The language runtime discovers tools without launching them, selects the nearest project manifest, and starts servers only for opened documents. It owns framing, configuration, cancellation, diagnostics, idle eviction, and process-group shutdown. The main process tracks owned PIDs so closing a window also cleans up a stalled worker's servers.

HowMany runs in the session worker with a separate language runtime, so its all-language counts and diagnostics do not displace either language server. Workspace analyses coalesce, run without a shell or disk cache, cap output at 16 MiB, time out after 30 seconds, and use two threads. The main process tracks both analysis and LSP processes for window cleanup. The binary bundled by `setup-howmany.ts` takes precedence over PATH and is unpacked from ASAR so the installed app can execute it without shell setup.

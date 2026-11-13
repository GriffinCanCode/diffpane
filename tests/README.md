---
doc_radar:
  sentinels:
    - file: tests/languages.integration.mjs
      contains: ['LanguageRuntime', 'swift', 'elixir']
    - file: tests/repository.test.mjs
      contains: ['Repository.open', 'vite-plus/test']
---

# Checks

Run `npm test` for the Node suite through Vite+'s bundled Vitest. The runner includes `tests/*.test.mjs` and `tests/*.test.ts`. Tests use `vite-plus/test` and `onTestFinished` to clean up repositories, workers, and language servers. `npm run test:watch` reruns tests while editing. `npm run test:docs` runs the documentation assertions.

Run `npm run verify` for formatting, lint, type-aware checks, tests, and the cached renderer build.

`npm run test:languages` runs the language matrix serially against nested projects and checks advertised capabilities, real responses, and process cleanup.

We test actual Git repositories, including partial staging, unusual paths, renames, worktrees, conflicts, binary previews, and ignore behavior. Session tests verify cache retention across unrelated writes and invalidation after file creation and commits. Shutdown checks hold watcher startup and unsubscribe independently, complete snapshots on either side of disposal, and require the worker to acknowledge cleanup before exiting naturally. Recents checks cover corrupt history, storage failures, ordering and limits, and concurrent app instances sharing one history file.

Session fixtures can select the alternate native backend with `DIFFPANE_TEST_WATCH_BACKEND=kqueue` on macOS when FSEvents is degraded. Forced-failure and event-storm regressions inject deterministic watcher events independently of the host event service.

Resource regressions cover idle diff-worker eviction and restart, cancellation during search teardown, and the release of picker rows and its search worker after closing. An isolated GC-enabled Node check caches bounded previews of 24 large files and checks external string storage, which JavaScript heap measurements alone miss. This guards against previews pinning their full decoded input despite a small cache estimate.

Autosave checks cover write coalescing, failures and retries, conflict detection, cache invalidation, source encodings, and path confinement. Reader tests cover native format recognition, malformed encodings, and bounded payloads. Media protocol tests cover full streams, byte ranges, missing files, and path confinement. Markdown path tests cover encoded links, anchors, and project traversal boundaries. Search and file operation tests cover filter boundaries and filesystem confinement.

HowMany tests cover request coalescing, cancellation, timeouts, invalid reports, path confinement, source checksum rejection, automatic scan cooldown, and manual refresh. `npm run setup:howmany` prepares the binary for tests of real LSP diagnostics and config reloads. CI prepares the binary before running the suite. Scheduler checks cover paint ordering and cancellation, including the timer fallback.

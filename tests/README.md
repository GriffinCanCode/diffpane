---
doc_radar:
  sentinels:
    - file: tests/app.e2e.mjs
      contains: ['4000', '80', 'rendererErrors']
    - file: tests/files.e2e.mjs
      contains: ['file-picker', 'diff-gutter-modified', 'node:assert/strict']
    - file: tests/languages.integration.mjs
      contains: ['LanguageRuntime', 'swift', 'elixir']
    - file: tests/configs.e2e.mjs
      contains: ['settings.jsonc', 'source byte']
    - file: tests/billy.integration.mjs
      contains: ['ls-files', 'billy-filetypes.json']
    - file: tests/repository.test.mjs
      contains: ['Repository.open', 'vite-plus/test']
---

# Checks

`npm run test:markdown` builds and drives the real Electron Markdown view through Mermaid flowcharts and sequence diagrams, malformed input, code highlighting, copy, expansion and zoom, source/diff transitions, local links and images, live saves, narrow panes, HTML sanitization, and cleanup. Screenshots are saved as `test-results/markdown.png` and `test-results/markdown-narrow.png`. Markdown path tests cover encoded links, anchors, and project traversal boundaries.

We test actual Git repositories, including partial staging, unusual paths, renames, worktrees, conflicts, binary previews, and ignore behavior. The Electron check drives the real app through edits and scrolling, then verifies switching files retains one model. Gutter checks distinguish additions, modifications, and deletions without whole-line fills. The file-viewer check reads unchanged code, saves and commits it, searches the picker, and launches a file directly.

The config check exercises syntax colors, source preservation, live updates, and keyboard navigation in Electron. The optional Billy check reads the tracked inventory, opens text representatives, and records actual language IDs and preview limits without changing the checkout.

The language matrix runs actual servers serially against nested projects and checks advertised capabilities, real responses, and process cleanup.

Run `npm test` for the backend and documentation through Vite+'s bundled Vitest. Tests use `vite-plus/test` and `onTestFinished` to clean up repositories, workers and language servers. `npm run test:watch` reruns tests while editing; `npm run test:docs` runs only the documentation assertions. The runner includes only `tests/*.test.mjs`; the standalone Electron and language integration scripts remain explicit commands.

Run `npm run verify` for formatting, lint, type-aware checks, tests and the cached renderer build. Run `npm run test:app` for the desktop check; it builds the renderer first. App screenshots land in the ignored `test-results` directory.

`npm run test:performance` opens an actual 50,000-file Git repository with 4,000 changed files and a 30,000-line document. It checks concurrent save bursts, worker search with overlapping queries, a bounded explorer DOM, one editor model, and frame timing. Results and a screenshot are saved in `test-results/performance.json` and `test-results/performance.png`. Set `DIFFPANE_PERF_FILES` to change the inventory size. Session tests verify cache retention across unrelated writes and invalidation after file creation and commits.

The diff-mode check exercises the glyph button, both complete file versions, changed-function emphasis, live saves during comparison, and disposal of the original model when returning to the current file.

The autosave check (`node tests/autosave.e2e.mjs`, included in `test:app`) types into the real editor, undoes an edit, edits the working side of a comparison, syncs an external save, switches files, edits Markdown source, and closes with a pending save. Unit checks cover write coalescing, failures and retries, conflict detection, cache invalidation, source encodings, and path confinement.

The media check opens real PNG and SVG images and a Chromium-encoded WebM video in Electron. It checks image zoom, files above the text limit, live saves, playback, seeking, invalid media, and playback cleanup when returning to code. Protocol unit tests cover full streams, byte ranges, missing files, and path confinement. Run `node tests/media.e2e.mjs` after a renderer build; it also runs with `npm run test:app`. Preview screenshots are saved as `test-results/media-image.png` and `test-results/media-video.png`.

`npm run setup:howmany && npm run test:howmany` checks real HowMany counts, report rendering, JSON export, save updates, and keyboard dismissal in Electron. The unit suite also checks request coalescing, cancellation, timeouts, invalid reports, path confinement, and source checksum rejection; when the bundled binary exists it verifies real LSP diagnostics and config reloads. Set `DIFFPANE_EXECUTABLE` to a packaged executable and run `node tests/howmany.e2e.mjs` to verify the app's bundled binary without a PATH override. CI prepares HowMany before running these checks.

The file-types check (`node tests/filetypes.e2e.mjs`, included in `test:app`) exercises arbitrary extensions, UTF-16, Windows-1252, binary comparisons, real audio decoding, the embedded PDF viewer, live text/binary transitions, and resource disposal. Reader tests cover native format recognition, malformed encodings, bounded payloads, and preview cache accounting.

The TypeScript k6 suite drives ten concurrent virtual agents against an isolated repository and the actual desktop app. `npm run test:k6:smoke` runs a short check; `npm run test:k6` uses 50,000 files; `npm run test:k6:soak` runs ten minutes; `npm run test:k6:languages` includes a real TypeScript server. `npm run check:k6` checks the harness and workload types. See [the k6 guide](k6/README.md) for measured rendering latency, fixed budgets, whole-process RSS accounting, limitations, and CI. The 100 MB budget remains a failing gate on the current Electron architecture; correctness results do not waive it.

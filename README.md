---
doc_radar:
  sentinels:
    - file: electron/main.mjs
      contains: ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']
    - file: renderer/main.js
      contains:
        [
          'createNavigator',
          'createLanguageFeatures',
          'saveViewState',
          'readOnly: closingRequested || !card.document?.editable',
          'diff-gutter-${kind}',
        ]
    - file: renderer/navigator.js
      contains: ['ROW_HEIGHT', 'buildNavigationTree', 'navigator-root']
    - file: renderer/syntax.ts
      contains: ['configureSyntax', 'parseDocument']
    - file: renderer/icons.ts
      contains: ['material-icon-theme', 'projectIcon']
    - file: electron/language.mjs
      contains: ['LanguageRuntime', 'textDocument/didOpen']
    - file: electron/servers.ts
      contains:
        [
          'basedpyright',
          'rust-analyzer',
          'ElixirLS',
          'gopls',
          'SourceKit-LSP',
          'typescript-language-server',
        ]
---

# diffpane

Run `diffpane` in a Git directory. We show the project explorer, full current files, and live Git highlights in a quiet desktop window.

```sh
npm ci
npm run install:app

diffpane                 # current directory
diffpane ~/Projects/app  # another directory, another window
diffpane src/main.js     # open a file directly
```

The installer puts Diffpane in `~/Applications` and the command in `~/.local/bin`. It currently targets macOS; `npm run build && npm start -- /path/to/repo` runs the source app on other Electron platforms.

Building the macOS app from source also requires Rust 1.88+ and the Xcode command-line tools. The installer builds a pinned, checksum-verified HowMany 3.1 and includes its binary and license inside the app. People receiving the built app do not need to install HowMany, Rust, or Homebrew. Reinstalling reuses the verified build for the same revision and architecture.

The app bundle and browser favicon use the mint split-pane artwork in `assets/diffpane.png`. On macOS, `npm run build:icons` regenerates `assets/diffpane.icns` and the web images in `public/img` from that master; the installer includes the native icon automatically.

## Browse and review

Click a file in the explorer to read its full contents, including unchanged code. Expand folders, use the persistent explorer search to filter paths, drag its divider, or use ⌘B to hide it. The project header holds file and folder pickers, refresh, and collapse; Outline shows the current file’s symbols. ⌘P opens the searchable file picker.

Text files open in one full-height editor. Images, audio, video, and PDFs open in a dedicated preview; other binary formats open as hexadecimal bytes and ASCII. The Hex button inspects raw bytes, and the split-pane glyph compares both versions against HEAD. Git changes against HEAD appear beside the line numbers: green for additions, blue for modifications, and red for deletions. The down arrow jumps between edits. The split-pane glyph opens the full before/after file comparison, with changed functions emphasized. ⌘F searches inside a file; ⌘O opens another folder; ⌘R refreshes.

We use Monaco for text layout, selection, syntax colors, zoom, and scrolling. The explorer and picker render nearby rows; we keep one current editor. Live saves update existing models and preserve their view positions.

Edit text directly in the current-file editor or the working side of a comparison. Every change saves automatically to disk and syncs the Git highlights, explorer, previews, and language services. Switching files and closing the window finish pending saves first. The status bar shows saving, saved, or a save failure; ⌘S retries a failed save. If another program changes the file before a save, Diffpane keeps your edits open and reports the conflict. Original versions, symlinks, binary files, and bounded previews stay read-only. Saves preserve the file’s text encoding and line endings.

## Language features

We load syntax from Monaco and a pinned TextMate catalog when a file is used. Source languages, JSON/JSONC/JSON5, TOML/ZON, YAML, INI, Makefiles, Dockerfiles, ignore files, dotenv, JSX/TSX, Astro, Jinja, Cedar, and Billy’s custom formats keep their source text and indentation. Prose and raw records stay readable as plain text.

Python, Rust, Elixir, Go, Swift, and TypeScript have language-server connections; JavaScript and JSX/TSX share the TypeScript server. Opening a file loads its server; unused languages stay asleep. Symbols opens the document outline, and supported servers supply semantic colors, type hints, hover documentation, folding, and diagnostics.

Features follow each server's capabilities. ElixirLS currently supplies hover, symbols, folding, and diagnostics with syntax colors; it does not advertise semantic tokens or inlay hints. Python uses Monaco's indentation folding. Diffpane keeps at most two servers running per window and stops idle servers after their documents close.

Python and TypeScript servers are bundled. For the other languages on macOS, install Rust through rustup, Go through mise, Elixir through Homebrew, and Apple's Swift toolchain, then run:

```sh
npm run setup:languages
```

Setup pins gopls and ElixirLS, verifies the ElixirLS archive, and stores tools in `~/Library/Application Support/Diffpane/languages`. Existing servers on PATH also work. Language services follow the nearest project manifest inside the opened repository; unavailable tools leave readable syntax-highlighted code and an explanatory status.

## HowMany

The explorer's HowMany section shows workspace lines, code, documentation, comments, blank lines, and quality. Click **Full report** or the status-bar count for language and complexity details, refresh, and JSON export. The report refreshes after saved changes; analysis runs outside the renderer with two worker threads and coalesces save bursts.

Each opened file shows HowMany's line breakdown above the editor. Its language server supplies threshold warnings independently of the file's language server. HowMany 3.1 reads thresholds from its user config: `~/Library/Application Support/howmany/config.toml` on macOS (`$XDG_CONFIG_HOME/howmany/config.toml` or `~/.config/howmany/config.toml` on Linux). Add an `[lsp]` section with `max_file_lines`, `min_doc_ratio`, `documented_from_lines`, or `code_lens`; zero disables a warning. Refresh HowMany after changing these settings.

For source development, `npm run setup:howmany` prepares the bundled binary. An existing `howmany` on PATH also works; versions before 3.1 supply saved-file counts and reports without threshold warnings. `DIFFPANE_HOWMANY_BINARY` selects an explicit executable. Missing tools leave files readable and show an explanation in the HowMany section.

## Live updates

Native filesystem events trigger background Git reads. Git owns status, renames, staging, ignores, conflicts, and worktree resolution. Text loading accepts any extension, UTF-8, and BOM-marked UTF-16. Unmarked non-Unicode text uses an explicitly labeled Windows-1252 fallback. Large text files retain a bounded beginning with a preview note. Hex inspection shows the first 64 KiB, with total size and byte offsets. Working images, audio, and video stream independently of text limits; PDF previews and inline historical media are limited to 16 MiB. Unsupported codecs and formats remain inspectable as bytes.

## Check it

The development toolchain is [Vite+](https://viteplus.dev/guide/), pinned in the lockfile. Use the Node.js version in `.node-version` and npm version in `package.json`, then run `npm ci`. No global Vite+ installation is required; npm scripts use the local `vp` binary.

```sh
npm run dev -- .    # Electron with Vite renderer hot updates
npm run check       # Oxfmt formatting, Oxlint linting and type-aware checks
npm run check:fix   # apply formatting and safe lint fixes
npm test            # Vitest: Git, navigator, language runtime and documentation checks
npm run test:watch  # rerun affected tests while editing
npm run build       # production renderer build with Vite Task caching
npm run verify      # check, test and build
```

Configuration lives in `vite.config.ts`. Repeated builds reuse tracked inputs and restore `dist` from the task cache; source, public asset and relevant environment changes invalidate it. Tests and desktop installation always execute. `npm ci` installs the pre-commit hook, which formats and checks staged files. VS Code recommendations enable Oxc formatting and lint fixes on save. The vendored syntax grammar JSON retains its upstream formatting.

`npm run test:app` builds and drives the real Electron app through large projects, gutter markers, scrolling, resizing, unchanged files, explorer navigation, and language features. `npm run test:billy -- /path/to/billy` opens representatives of the checkout’s text-file categories and records coverage in `test-results`. `npm run test:languages` checks all six installed servers against real nested projects and verifies process cleanup. `make lint-doc-radar` checks the documentation assertions. GitHub Actions runs the static checks, tests, build and desktop checks on macOS.

## Built on

[Monaco](https://github.com/microsoft/monaco-editor) supplies the editor. [Electron](https://www.electronjs.org/) supplies the desktop shell. [Parcel Watcher](https://github.com/parcel-bundler/watcher) supplies native filesystem events, and [jsdiff](https://github.com/kpdecker/jsdiff) computes bounded change highlights in the worker.

Language intelligence uses [basedpyright](https://github.com/DetachHead/basedpyright), [rust-analyzer](https://rust-analyzer.github.io/), [ElixirLS](https://github.com/elixir-lsp/elixir-ls), [gopls](https://go.dev/gopls/), [SourceKit-LSP](https://github.com/swiftlang/sourcekit-lsp), and [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) through the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/).

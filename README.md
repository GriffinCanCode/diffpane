---
doc_radar:
  sentinels:
    - file: electron/main.mjs
      contains: ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']
    - file: renderer/main.js
      contains: ['createNavigator', 'createLanguageFeatures', 'saveViewState', 'readOnly: true']
    - file: renderer/navigator.js
      contains: ['ROW_HEIGHT', 'buildNavigationTree', 'navigator-root']
    - file: renderer/syntax.js
      contains: ['configureSyntax', 'parseDocument']
    - file: renderer/icons.js
      contains: ['material-icon-theme', 'projectIcon']
    - file: electron/language.mjs
      contains: ['LanguageRuntime', 'textDocument/didOpen']
    - file: electron/servers.mjs
      contains: ['basedpyright', 'rust-analyzer', 'ElixirLS', 'gopls', 'SourceKit-LSP', 'typescript-language-server']
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

## Browse and review

Click a file in the explorer to read its full contents, including unchanged code. Expand folders, type in the explorer to filter paths, drag its divider, or use ⌘B to hide it. The project header holds file and folder pickers, refresh, and collapse; Outline shows the current file’s symbols. ⌘P opens the searchable file picker.

Changes shows current files with Git edits highlighted. Filter with ⌘K, choose all, staged, or unstaged changes, and use the down arrow to jump between edits. ⌘F searches inside a file; ⌘O opens another folder; ⌘R refreshes.

We use Monaco for text layout, selection, syntax colors, zoom, and scrolling. The explorer and picker render nearby rows; Changes mounts editors around the viewport. Live saves update existing models and preserve their view positions.

## Language features

We load syntax from Monaco and a pinned TextMate catalog when a file is used. Source languages, JSON/JSONC/JSON5, TOML/ZON, YAML, INI, Makefiles, Dockerfiles, ignore files, dotenv, JSX/TSX, Astro, Jinja, Cedar, and Billy’s custom formats keep their source text and indentation. Prose and raw records stay readable as plain text.

Python, Rust, Elixir, Go, Swift, and TypeScript have language-server connections; JavaScript and JSX/TSX share the TypeScript server. Opening a file loads its server when the editor becomes visible; scrolling through Changes keeps servers asleep until a file is used. Symbols opens the document outline, and supported servers supply semantic colors, type hints, hover documentation, folding, and diagnostics.

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

Native filesystem events trigger background Git reads. Git owns status, renames, staging, ignores, conflicts, and worktree resolution. Binary files, files over 2 MiB, files over 50,000 lines, and lines over 16 KiB get an explicit preview note.

## Check it

Run `npm test` for Git, navigator, language runtime, and documentation checks. `npm run test:app` drives the real Electron app through large change feeds, scrolling, resizing, unchanged files, explorer navigation, and language features. `npm run test:billy -- /path/to/billy` opens representatives of the checkout’s text-file categories and records coverage in `test-results`. `npm run test:languages` checks all six installed servers against real nested projects and verifies process cleanup. `make lint-doc-radar` checks the documentation assertions.

## Built on

[Monaco](https://github.com/microsoft/monaco-editor) supplies the editor. [Electron](https://www.electronjs.org/) supplies the desktop shell. [Parcel Watcher](https://github.com/parcel-bundler/watcher) supplies native filesystem events, and [jsdiff](https://github.com/kpdecker/jsdiff) computes bounded change highlights in the worker.

Language intelligence uses [basedpyright](https://github.com/DetachHead/basedpyright), [rust-analyzer](https://rust-analyzer.github.io/), [ElixirLS](https://github.com/elixir-lsp/elixir-ls), [gopls](https://go.dev/gopls/), [SourceKit-LSP](https://github.com/swiftlang/sourcekit-lsp), and [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) through the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/).

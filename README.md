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

Diffpane is a desktop file browser and editor for reading code while an agent works on it.

An agent's chat window doesn't always give you a way to browse the project. Opening another IDE just to read files adds another app, more memory use, and sometimes another subscription. This is a separate window for that part of the work.

Run your agent as usual, then run `diffpane` in your project folder. The file explorer shows the project, and the editor shows the full file. Files update when the agent saves changes, so you can follow along without reopening them.

Git changes are marked beside the line numbers. You can open a side-by-side comparison against HEAD. Edit files yourself; edits save automatically.

It includes search, a file picker, language tools, line counts, and previews for images, audio, video, and PDFs. Your agent runs separately. Diffpane reads and edits the files on disk.

## Setup

Use the Node.js version in `.node-version`. Building the macOS app also requires Rust 1.88+ and the Xcode command-line tools.

```sh
make setup
make install
```

Then, from any project folder:

```sh
diffpane
```

The app goes in `~/Applications`. The command goes in `~/.local/bin`, which needs to be on your PATH. A path is optional: `diffpane ~/Projects/your-project` opens another folder.

⌘P finds files, ⌘F searches a file, and ⌘B shows or hides the explorer.

## Development

```sh
make dev     # run from source
make test    # run tests
make build   # build the app
make verify  # formatting, lint, tests, and build
```

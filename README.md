---
doc_radar:
  sentinels:
    - file: app/electron/runtime/window/main.mjs
      contains: ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']
    - file: app/renderer/shell/workspace/main.js
      contains: ['createNavigator', 'createLanguageFeatures', 'saveViewState', 'editorReadOnly', 'diff-gutter-${kind}']
    - file: app/renderer/explorer/tree/navigator.js
      contains: ['ROW_HEIGHT', 'buildNavigationTree', 'navigator-root']
    - file: app/renderer/editor/highlighting/syntax.ts
      contains: ['configureSyntax', 'parseDocument']
    - file: app/renderer/shell/layout/icons.ts
      contains: ['material-icon-theme', 'projectIcon']
    - file: app/electron/tools/languages/language.mjs
      contains: ['LanguageRuntime', 'textDocument/didOpen']
    - file: app/electron/tools/languages/servers.ts
      contains: ['basedpyright', 'rust-analyzer', 'ElixirLS', 'gopls', 'SourceKit-LSP', 'typescript-language-server']
---

# diffpane

Diffpane is a desktop file browser and editor for reading code while an agent works on it.

An agent's chat window doesn't always give you a way to browse the project. Opening another IDE just to read files adds another app, more memory use, and sometimes another subscription. This is a separate window for that part of the work.

Run your agent as usual, then run `dp` in your project folder. The file explorer shows the project, and the editor shows the full file. Files update when the agent saves changes, so you can follow along without reopening them.

Git changes are marked beside the line numbers. You can compare files against HEAD. Edit files yourself; edits save automatically.

Open **Changes** with ⌘⇧G to see the review queue and its progress. Select a file to jump to its first edit. Long stretches of unchanged code are collapsed, and you can move between edits or choose **Full file** to restore context. Use **Mark reviewed & next** to advance and **Mark reviewed** to finish the last file. Progress lasts for the window session. From **Reviewed**, you can return a file to **Pending**. New edits also return the file to **Pending**.

Choose **Capture checkpoint** in Changes before starting an agent pass or making your own edits. The queue compares tracked files and untracked files covered by Git status against that checkpoint, including edits that get committed during the review. Existing staged, unstaged, and untracked edits are part of the starting point. Use **Compare against** to switch between Git HEAD and the checkpoint. Each keeps its own review progress. **Replace checkpoint** starts a fresh review from the current working tree. A checkpoint lasts until you close the window and leaves your Git index and history untouched.

Open **Search** with ⌘⇧F to find text across the project. Choose **Changed files** to search the working contents of files Git reports as changed, including new files. Results refresh as files change. Use ↑ and ↓ to move through matching lines, then press Enter to jump to the selected text. Selecting text in the editor first fills in the query.

Open **Notes** from the title bar or press ⌘⇧J by default. Right-click in the editor and choose **Add review note** to capture the current line or selection, including on the HEAD side of a comparison. Use the file header’s note button for a whole file, or choose **Make project note** for feedback without a file. Notes stay on this Mac across restarts. Select a note’s location to return to the captured lines. If they moved, Diffpane looks for a unique match and tells you when the original lines can’t be located. Choose **Copy handoff** to paste your open notes, file references, and captured excerpts into any agent chat.

Open **Ideas** with ⌘⇧I to see a searchable project notebook. Markdown formats as you type, and lists continue when you press Enter. Use **Format text** to apply common styles, or ⌘-click a link in the note to open it. Choose **Dock beside code** to keep an idea visible while you work. Drop a project file onto an idea or choose **Link current file or selection** to attach code. Choose **Give to the Creature** to attach the idea to your next message. Ideas autosave locally and are shared by windows on the same Git worktree.

Drag the dividers to resize Ideas, File Explorer, code, and the Creature or Review Notes. With a divider focused, use the arrow keys to resize. Double-click a divider to reset its size. Diffpane remembers your layout.

Ideas, review notes, recent paths, keyboard shortcuts, and appearance and layout settings are saved locally in an encrypted database. On macOS, Keychain protects the encryption key. Existing settings and notes are imported automatically on upgrade.

It also includes a file picker, language tools, line counts, and previews for images, audio, video, and PDFs.

## The Creature

The Creature lives in your code and helps you figure things out. Open **The Creature** and select **Creature settings**. Paste a workspace-scoped Claude API key and save it. Diffpane verifies the key before saving it and uses macOS Keychain-backed encryption for the local copy. You can remove the key from the same settings. [Create a Claude API key](https://platform.claude.com/settings/keys)

Use **Ask** to talk through code or find and read ideas. The composer shows the open file and the selected or visible lines the Creature can read. Click the file chip to remove that context from your message. Expand an activity row to see what the Creature inspected, or follow a file reference to jump to the relevant lines.

In **Edit** mode, the Creature can propose a small file edit, create an idea, or revise an existing idea. Preview the change in the conversation and choose whether to apply or discard it. If the source changed after the Creature read it, request a fresh proposal.

Diffpane calls Claude Haiku directly. Your prompts, context references, and the file or idea excerpts Claude requests go to Anthropic and use your API workspace. Chat history lasts for the window session.

## Build from source

Use the Node.js version in `.github/config/node-version`. Building the macOS app also requires Rust 1.88+ and the Xcode command-line tools.

```sh
npm ci
npm run install:app
```

Then, from any project folder:

```sh
dp
```

The app goes in `~/Applications`. The `dp` and `diffpane` commands go in `~/.local/bin`, which needs to be on your PATH. Use `dp ~/Projects/your-project` to open another folder.

The terminal command opens the current directory when it belongs to a Git working tree. Running it outside Git or opening Diffpane from Finder or the Dock shows the welcome screen. Choose Open Folder or Open File to browse a Git working tree, or reopen a recent file or folder.

Open **Settings → Appearance** from the title-bar gear or press ⌘, to choose the theme, text diff layout, and editor typography. Changes apply immediately and are saved for future windows.

Open **Settings → Keyboard shortcuts** from the title-bar gear or the Diffpane menu to see the current and default bindings. Select a binding to change it, or restore the defaults at any time. By default, ⌘N opens a new window, ⌘O opens the folder picker, and ⌘P finds files in the project.

## Development

```sh
npm run dev -- .  # open this repo from source
npm test          # run tests
npm run build     # build the renderer
npm run verify    # check formatting, lint, types, tests, and build
```

Run `make <target>` from the repository root to use the Make targets.

## Repository layout

- [Application](app/README.md) indexes the Electron runtime, renderer, shared contracts, tooling, and tests.
- [Branding](branding/README.md) contains the icon source and generated assets for Electron and the renderer.
- [Changelog](changelog/README.md) records shipped changes by feature.
- [Legal](legal/README.md) holds the third-party notices included in the macOS bundle.

Source directories contain at most five files, including the README. Keep code in leaf directories and use lowercase kebab-case for authored file and folder names. Standard entry points and metadata keep their tool-required names, including `README.md`, `Makefile`, and `vite.config.ts`. The file limit applies to the checked-in tree. Git metadata, installed dependencies, and generated build outputs are outside that tree.

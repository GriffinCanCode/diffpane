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
          'editorReadOnly',
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

Run your agent as usual, then run `dp` in your project folder. The file explorer shows the project, and the editor shows the full file. Files update when the agent saves changes, so you can follow along without reopening them.

Git changes are marked beside the line numbers. You can compare files against HEAD. Edit files yourself; edits save automatically.

Open **Changes** with ⌘⇧G to see the review queue and its progress. Select a file to jump to its first edit. Long stretches of unchanged code are collapsed, and you can move between edits or choose **Full file** to restore context. Use **Mark reviewed & next** to advance and **Mark reviewed** to finish the last file. Progress lasts for the window session. From **Reviewed**, you can return a file to **Pending**. New edits also return the file to **Pending**.

Choose **Capture checkpoint** in Changes before starting an agent pass or making your own edits. The queue compares tracked files and untracked files covered by Git status against that checkpoint, including edits that get committed during the review. Existing staged, unstaged, and untracked edits are part of the starting point. Use **Compare against** to switch between Git HEAD and the checkpoint. Each keeps its own review progress. **Replace checkpoint** starts a fresh review from the current working tree. A checkpoint lasts until you close the window and leaves your Git index and history untouched.

Open **Notes** from the title bar or press ⌘⇧J by default. Right-click in the editor and choose **Add review note** to capture the current line or selection, including on the HEAD side of a comparison. Use the file header’s note button for a whole file, or choose **Make project note** for feedback without a file. Notes stay on this Mac across restarts. Select a note’s location to return to the captured lines. If they moved, Diffpane looks for a unique match and tells you when the original lines can’t be located. Choose **Copy handoff** to paste your open notes, file references, and captured excerpts into any agent chat.

Open **Ideas** with ⌘⇧I to see a searchable project notebook. Markdown formats as you type, and lists continue when you press Enter. Use **Format text** to apply common styles, or ⌘-click a link in the note to open it. Choose **Dock beside code** to keep an idea visible while you work. Drop a project file onto an idea or choose **Link current file or selection** to attach code. **Add to Claude** makes the idea available on your next message. Ideas autosave locally and are shared by windows on the same Git worktree.

Drag the dividers to resize Ideas, File Explorer, code, and Claude or Review Notes. With a divider focused, use the arrow keys to resize. Double-click a divider to reset its size. Diffpane remembers your layout.

Ideas, review notes, recent paths, appearance, pane layout, and Ideas docking are saved in an encrypted local database. On macOS, Keychain protects the encryption key. Existing records are imported automatically on upgrade.

It includes search, a file picker, language tools, line counts, and previews for images, audio, video, and PDFs.

## Claude in Diffpane

Open **Claude** and select **Claude settings**. Paste a workspace-scoped Claude API key and save it. Diffpane verifies the key before saving it and uses macOS Keychain-backed encryption for the local copy. You can remove the key from the same settings. [Create a Claude API key](https://platform.claude.com/settings/keys)

Use **Ask** to ask about the open project. Claude uses the current editor path as a starting point and can look up other project files. In **Edit** mode, Claude can propose a small replacement in an existing file. Review the proposed text and select **Apply edit** or **Discard**. If the file has changed on disk since the proposal, request a fresh edit.

Diffpane calls Claude Haiku directly. Prompts and any project paths or file excerpts Claude requests go to Anthropic and use your API workspace. Chat history lasts for the window session.

## Build from source

Use the Node.js version in `.node-version`. Building the macOS app also requires Rust 1.88+ and the Xcode command-line tools.

```sh
make setup
make install
```

Then, from any project folder:

```sh
dp
```

The app goes in `~/Applications`. The `dp` and `diffpane` commands go in `~/.local/bin`, which needs to be on your PATH. Use `dp ~/Projects/your-project` to open another folder.

The terminal command opens the current directory when it belongs to a Git working tree. Running it outside Git or opening Diffpane from Finder or the Dock shows the welcome screen. Choose Open Folder or Open File to browse a Git working tree, or reopen a recent file or folder.

⌘N opens a new welcome window and ⌘O opens the folder picker. ⌘P finds files, ⌘F searches a file, and ⌘B shows or hides the explorer.

Open **Settings → Appearance** from the title-bar gear or press ⌘, to choose the theme, text diff layout, and editor typography. Changes apply immediately and are saved for future windows.

## Development

```sh
make dev     # run from source
make test    # run tests
make build   # build the app
make verify  # formatting, lint, tests, and build
```

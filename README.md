---
doc_radar:
  sentinels:
    - file: Boxfile
      contains: ['id = "diffpane"', 'platforms = ["macos-aarch64"]']
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

Run your agent as usual, then run `diffpane` in your project folder. The file explorer shows the project, and the editor shows the full file. Files update when the agent saves changes, so you can follow along without reopening them.

Git changes are marked beside the line numbers. You can open a side-by-side comparison against HEAD. Edit files yourself; edits save automatically.

Open **Changes** with ⌘⇧G to see the review queue and its progress. Select a file to jump to its first edit. Long stretches of unchanged code are collapsed, and you can move between edits or choose **Full file** to restore context. Use **Mark reviewed & next** to advance and **Mark reviewed** to finish the last file. Progress lasts for the window session. From **Reviewed**, you can return a file to **Pending**. New edits also return the file to **Pending**.

It includes search, a file picker, language tools, line counts, and previews for images, audio, video, and PDFs.

## Claude in Diffpane

Open **Claude** and select **Claude settings**. Paste a workspace-scoped Claude API key and save it. Diffpane verifies the key before saving it and uses macOS Keychain-backed encryption for the local copy. You can remove the key from the same settings. [Create a Claude API key](https://platform.claude.com/settings/keys)

Use **Ask** to ask about the open project. Claude uses the current editor path as a starting point and can look up other project files. In **Edit** mode, Claude can propose a small replacement in an existing file. Review the proposed text and select **Apply edit** or **Discard**. If the file has changed on disk since the proposal, request a fresh edit.

Diffpane calls Claude Haiku directly. Prompts and any project paths or file excerpts Claude requests go to Anthropic and use your API workspace. Chat history lasts for the window session.

## Install from Box

On an Apple Silicon Mac with macOS 13 or later, install Git and connect Box to The Billy Company's registry. Then run:

```sh
box unpack diffpane
export PATH="$(box env):$PATH"
cd /path/to/your/project
diffpane
```

The first launch unpacks the signed app. Electron and HowMany come bundled. To make `diffpane` available in new terminals, add the Box directory to your shell's PATH.

## Build from source

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

Opening Diffpane from Finder or the Dock shows a welcome screen. Choose Open Folder or Open File to browse a Git working tree, or reopen a recent file or folder. The terminal command opens the current directory by default.

⌘N opens a new welcome window and ⌘O opens the folder picker. ⌘P finds files, ⌘F searches a file, and ⌘B shows or hides the explorer.

## Development

```sh
make dev     # run from source
make test    # run tests
make build   # build the app
make verify  # formatting, lint, tests, and build
```

To prepare a Box release, set `DIFFPANE_SIGN_IDENTITY` to a Developer ID Application identity. Supply the App Store Connect key path, key ID, and issuer through `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Keep the Boxfile and package.json versions in sync.

```sh
npm run package:box
box pack --dry-run
box pack
```

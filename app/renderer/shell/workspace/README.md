---
doc_radar:
  sentinels:
    - file: app/renderer/shell/workspace/bootstrap.ts
      contains: ['installErrorHandlers']
---

# Workspace

The renderer entry point composes the file explorer, Monaco, review controls, and optional panels. It keeps the active file, editor model, and view state in sync with the Electron session.

- [`bootstrap.ts`](bootstrap.ts) — Installs error handlers before loading the workspace.
- [`main.js`](main.js) — Composes the window, controls file selection and editor lifetime, and flushes saves.
- [`dom.js`](dom.js) — Checks that required elements match the expected DOM types.
- [`style.css`](style.css) — Styles the shared window, welcome screen, and editor chrome.

Run `npm run dev -- .` and open, edit, and switch between files in the workspace.

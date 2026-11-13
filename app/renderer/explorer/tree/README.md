---
doc_radar:
  sentinels:
    - file: app/renderer/explorer/tree/navigator.js
      contains: ['flattenNavigationTree']
---

# Explorer tree

The workspace turns Electron inventory and status updates into a virtualized tree. Opening, renaming, or trashing an entry goes through callbacks owned by the workspace.

- [`navigator.js`](navigator.js) — Projects the inventory into visible rows and manages expansion, scrolling, and focus.
- [`navigation-reconcile.ts`](navigation-reconcile.ts) — Reconciles snapshots and incremental inventory changes.
- [`file-actions.ts`](file-actions.ts) — Provides the contextual menu and actions for files and directories.
- [`navigator.css`](navigator.css) — Styles tree rows, search, and Git status badges.

Run `npm test -- app/tests/interface/explorer/navigator.test.mjs app/tests/interface/explorer/navigation-reconcile.test.mjs`.

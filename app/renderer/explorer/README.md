---
doc_radar:
  sentinels:
    - file: app/renderer/explorer/tree/navigator.js
      contains: ['flattenNavigationTree']
---

# Explorer and search

These views navigate the project inventory or open text results in the editor. The workspace supplies selection handlers and connects them to Electron.

- [Tree](tree/README.md) — Virtualized file tree and contextual actions.
- [File picker](file-picker/README.md) — Ranked path search and worker lifecycle.
- [Project search](project-search/README.md) — Project-wide text results and shared search filters.

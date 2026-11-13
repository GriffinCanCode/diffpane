---
doc_radar:
  sentinels:
    - file: app/renderer/explorer/project-search/content-search.ts
      contains: ['createContentSearch']
---

# Project search

This view searches file contents through the Electron bridge. It returns a selected match to the workspace so the editor can reveal it. The explorer and picker also use the shared filter controls.

- [`content-search.ts`](content-search.ts) — Runs searches, groups result rows, and routes selection and retry.
- [`search-filters.ts`](search-filters.ts) — Defines filter controls and matching for kind, language, extension, and path.
- [`content-search.css`](content-search.css) — Styles the project search view and its results.

Run `npm test -- app/tests/interface/search` for content search and shared filters.

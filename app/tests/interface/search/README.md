---
doc_radar:
  sentinels:
    - file: app/tests/interface/search/content-search.test.mjs
      contains: ['editor-compatible positions']
---

# Search tests

These suites cover project text matching and the filters used by the workspace's search surfaces.

- [Content search](content-search.test.mjs). Check literal matching, result coordinates, path scope, bounds and cancellation.
- [Search filters](search-filters.test.ts). Combine entry kind, language, extension and folder constraints.

Run `npm test -- app/tests/interface/search` from the repository root.

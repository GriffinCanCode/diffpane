---
doc_radar:
  sentinels:
    - file: app/tests/interface/explorer/search-runtime.test.mjs
      contains: ['drops the worker and inventory']
---

# Explorer tests

These suites cover projecting the file inventory into a tree and searching it without expanding hidden descendants.

- [File search](file-search.test.mjs). Check ranking, multi-term queries and Unicode highlight positions.
- [Tree reconciliation](navigation-reconcile.test.mjs). Preserve tree identity across inventory deltas and folder moves.
- [Navigator](navigator.test.mjs). Project visible rows and badges for sorted, scoped and collapsed inventories.
- [Search runtime](search-runtime.test.mjs). Settle stale and queued queries, restart failed workers and release inventory on close.

Run `npm test -- app/tests/interface/explorer` from the repository root.

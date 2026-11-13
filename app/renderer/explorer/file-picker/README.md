---
doc_radar:
  sentinels:
    - file: app/renderer/explorer/file-picker/files.ts
      contains: ['createFilePicker']
---

# File picker

The workspace opens this picker to navigate by file or folder name. It shares filtering rules with the explorer and uses a worker for large path inventories.

- [`files.ts`](files.ts) — Owns the picker dialog, reuses mounted rows, and manages focus and selection.
- [`file-search.ts`](file-search.ts) — Ranks matching paths and computes highlight positions for visible rows.
- [`search-runtime.ts`](search-runtime.ts) — Coordinates query cancellation, coalescing, and worker lifetime.
- [`search-worker.ts`](search-worker.ts) — Cancels superseded scans, reuses candidates for narrower queries, and transfers ranked file indexes.

Run `npm test -- app/tests/interface/explorer/file-search.test.mjs app/tests/interface/explorer/search-runtime.test.mjs`.

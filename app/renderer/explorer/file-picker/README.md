---
doc_radar:
  sentinels:
    - file: app/renderer/explorer/file-picker/files.ts
      contains: ['createFilePicker']
---

# File picker

The workspace opens this picker to navigate by file or folder name. It shares filtering rules with the explorer and uses a worker for large path inventories.

- [`files.ts`](files.ts) — Owns the picker dialog, row rendering, focus, and selection.
- [`file-search.ts`](file-search.ts) — Ranks matching paths and records the positions to highlight.
- [`search-runtime.ts`](search-runtime.ts) — Coordinates query cancellation, coalescing, and worker lifetime.
- [`search-worker.ts`](search-worker.ts) — Validates incoming inventory and query messages and returns indexed matches.

Run `npm test -- app/tests/interface/explorer/file-search.test.mjs app/tests/interface/explorer/search-runtime.test.mjs`.

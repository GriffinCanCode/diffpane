---
doc_radar:
  sentinels:
    - file: app/tests/runtime/documents/preview-memory.test.mjs
      contains: ['large decoded source buffers']
---

# Document runtime tests

These suites cover the runtime path from bounded file decoding to cached documents, diff computation and streamed media.

- [Document cache](document-cache.test.mjs). Exercise shared reads, eviction, invalidation, retries and diff-worker lifetime.
- [File content](file-content.test.mjs). Check encodings, media recognition and bounded text and byte previews.
- [Media protocol](media.test.mjs). Check byte ranges, streaming, content types and filesystem confinement.
- [Preview memory](preview-memory.test.mjs). Use a GC-enabled Node process to check that bounded previews release their large source strings.

Run `npm test -- app/tests/runtime/documents` from the repository root.

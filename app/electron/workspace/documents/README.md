---
doc_radar:
  sentinels:
    - file: app/electron/workspace/documents/file-content.ts
      contains: ['MAX_MEDIA_BYTES', 'searchableText', 'encodeText']
    - file: app/electron/workspace/documents/document-cache.ts
      contains: ['class DocumentCache']
    - file: app/electron/workspace/documents/media.ts
      contains: ['mediaResponse']
---

# Documents and media

- [`file-content.ts`](file-content.ts) recognizes file types, decodes text, and constructs bounded document previews. It also preserves source encoding for saves.
- [`document-cache.ts`](document-cache.ts) coalesces document reads and bounds retained preview payloads.
- [`media.ts`](media.ts) streams working-tree media through a scoped Electron protocol and supports byte ranges.

The [repository](../repository/README.md) uses the content reader. The [session](../../runtime/session/README.md) owns the cache. Run `npm test -- app/tests/runtime/documents` from the repository root.

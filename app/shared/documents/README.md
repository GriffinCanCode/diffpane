---
doc_radar:
  sentinels:
    - file: app/shared/documents/text-lines.ts
      contains: ['export function']
---

# Document primitives

`media-types.ts` defines the supported preview media. `text-lines.ts` implements bounded line and preview operations used by the Electron reader and renderer editor.

Run `npm test -- app/tests/runtime/documents` from the repository root.

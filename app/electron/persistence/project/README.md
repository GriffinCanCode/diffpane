---
doc_radar:
  sentinels:
    - file: app/electron/persistence/project/idea-store.ts
      contains: ['class IdeaStore', "const COLLECTION = 'ideas'"]
    - file: app/electron/persistence/project/review-notes.ts
      contains: ['class ReviewNotesStore', "const COLLECTION = 'review-notes'"]
---

# Project records

- [`idea-store.ts`](idea-store.ts) stores notebook entries and their revisioned edits by workspace.
- [`review-notes.ts`](review-notes.ts) stores project and file notes, including their source anchors and status.

Both use the [local database](../database/README.md) for durable records. Run `npm test -- app/tests/runtime/project` from the repository root.

---
doc_radar:
  sentinels:
    - file: app/tests/runtime/project/idea-store.test.ts
      contains: ['stay scoped to a worktree']
---

# Project store tests

These suites cover persistent workspace content and preserve its scope when several windows or processes edit it.

- [Idea store](idea-store.test.ts). Check Markdown, anchors, migrations and concurrency, including Claude proposal conflicts.
- [Review note store](review-notes-store.test.ts). Check source anchors, folder scope, concurrent edits and legacy notes.

Run `npm test -- app/tests/runtime/project` from the repository root.

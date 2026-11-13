---
doc_radar:
  sentinels:
    - file: app/shared/review/review-notes.ts
      contains: ['formatReviewHandoff']
---

# Review note contracts

`review-notes.ts` defines review notes and their captured locations, resolves anchors against edited text, and formats the handoff copied from the workspace.

Run `npm test -- app/tests/interface/review/review-notes.test.ts` from the repository root.

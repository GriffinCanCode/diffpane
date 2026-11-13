---
doc_radar:
  sentinels:
    - file: app/tests/interface/review/review-checkpoint.test.mjs
      contains: ['checkpoint comparisons and review versions from HEAD']
---

# Review tests

These suites cover the comparison and notes workflow from line decorations to working-tree checkpoint baselines.

- [Change markers](changes.test.mjs). Distinguish edits, insertions and deletions on both sides of a comparison.
- [Function ranges](function-ranges.test.mjs). Find changed function context from language-server and lexical boundaries.
- [Review checkpoints](review-checkpoint.test.mjs). Capture staged, unstaged and untracked bytes and exercise comparison, scope and version behavior.
- [Review notes](review-notes.test.ts). Relocate unambiguous anchors and format bounded excerpts for handoff.

Run `npm test -- app/tests/interface/review` from the repository root.

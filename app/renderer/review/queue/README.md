---
doc_radar:
  sentinels:
    - file: app/renderer/review/queue/change-review.js
      contains: ['createChangeReview']
---

# Review queue

The workspace supplies changed-file data and opens the file selected in the queue. The queue tracks reviewed revisions separately for each comparison baseline.

- [`change-review.js`](change-review.js) — Owns the changed-file list, progress, baseline selection, and review actions.
- [`change-review.css`](change-review.css) — Styles the list, progress indicator, and review controls.

Run `npm run dev -- .` and open Changes in a Git workspace with edits. Compare against HEAD and a checkpoint.

---
doc_radar:
  sentinels:
    - file: app/tests/interface/editor/autosave.test.mjs
      contains: ['undoing a failed save']
---

# Editor tests

These suites verify the interaction between editor updates, background work and reading or saving a file.

- [Paint scheduling](after-paint.test.mjs). Check frame and idle scheduling, cancellation and the timer fallback.
- [Autosave](autosave.test.mjs). Check write serialization, refresh baselines, retry and undo.
- [Live updates](live-updates.test.mjs). Check bounded invalidation during overlapping native events and throttled frames.
- [Markdown links](markdown.test.mjs). Resolve local paths and Unicode anchors while confining links to the project.

Run `npm test -- app/tests/interface/editor` from the repository root.

---
doc_radar:
  sentinels:
    - file: app/renderer/editor/updates/autosave.ts
      contains: ['class Autosave']
---

# Saves and live updates

The workspace uses these modules to serialize edits and batch filesystem notifications while keeping the active editor usable.

- [`autosave.ts`](autosave.ts) — Coalesces writes, flushes pending edits, and surfaces failures for retry.
- [`live-updates.ts`](live-updates.ts) — Subscribes to changed paths and batches notifications for the renderer.

Run `npm test -- app/tests/interface/editor/autosave.test.mjs app/tests/interface/editor/live-updates.test.mjs`.

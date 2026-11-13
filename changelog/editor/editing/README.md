---
doc_radar:
  sentinels:
    - file: changelog/editor/editing/live-editor-flicker.fixed
      contains: ['until refreshed results arrive']
---

# Live editing

These fragments record save behavior and how the editor presents results while an open file refreshes.

- [Text autosave](11-text-autosave.added). Save text edits and retain failed buffers for retry.
- [Live editor flicker](live-editor-flicker.fixed). Keep counts and warnings visible while results refresh.

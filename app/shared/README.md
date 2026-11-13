---
doc_radar:
  sentinels:
    - file: app/electron/runtime/window/preload.ts
      contains: ['shared/recovery/app-errors.ts']
---

# Shared contracts

Electron and the renderer share these contracts and pure operations. The preload uses their types at the IPC boundary, and Node tests exercise the same implementations as the app.

- [Documents](documents/README.md) defines media types and bounded text operations.
- [Ideas](ideas/README.md) defines notebook records and edits.
- [Preferences](preferences/README.md) defines keyboard shortcut bindings.
- [Recovery](recovery/README.md) defines structured errors and result handling.
- [Review](review/README.md) defines note anchors, records, and handoff text.

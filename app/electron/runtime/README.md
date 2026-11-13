---
doc_radar:
  sentinels:
    - file: app/electron/runtime/window/main.mjs
      contains: ['new Worker', 'before-quit']
    - file: app/electron/runtime/session/session.mjs
      contains: ['watcher.subscribe', 'port.close()']
---

# Desktop runtime

- [Diagnostics](diagnostics/README.md) owns the local log and Electron performance sampling.

- [Window](window/README.md) owns Electron startup, native menus and dialogs, renderer IPC, and shutdown coordination.
- [Session](session/README.md) owns a workspace worker's lifetime, watches, inventory snapshots, and request dispatch.

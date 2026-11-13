---
doc_radar:
  sentinels:
    - file: app/renderer/shell/workspace/bootstrap.ts
      contains: ['installErrorHandlers']
---

# Window shell

The shell starts the renderer and coordinates the lifetime of the desktop workspace. Feature directories provide the controls it mounts.

- [Workspace](workspace/README.md) — Boot, editor lifetime, and window composition.
- [Layout](layout/README.md) — Panel geometry, explorer icons, and paint scheduling.
- [Recovery](recovery/README.md) — Loading indicators, failure views, and error handling.

---
doc_radar:
  sentinels:
    - file: app/electron/runtime/window/main.mjs
      contains: ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'before-quit']
    - file: app/electron/runtime/window/preload.ts
      contains: ['contextBridge.exposeInMainWorld', 'export type DiffpaneApi']
---

# Window and preload

- [`main.mjs`](main.mjs) starts Electron, creates windows, handles native UI and IPC, and manages [workspace worker](../session/README.md) startup, reconnect, and shutdown.
- [`preload.ts`](preload.ts) validates and exposes the renderer's IPC API. [`preload.cjs`](preload.cjs) is the generated script loaded by sandboxed windows.

From the repository root, run `npm run prepare` to regenerate the preload and `npm run dev -- .` to start the desktop app. Run `npm test -- app/tests/runtime/session/session-shutdown.test.mjs` for the worker shutdown contract.

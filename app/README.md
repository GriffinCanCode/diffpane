---
doc_radar:
  sentinels:
    - file: app/tsconfig.json
      contains: ['"checkJs": true']
---

# Application

The application tree contains the code that ships and the tooling and tests that build it. `index.html` is the renderer's HTML entry point. `tsconfig.json` sets the shared TypeScript and checked JavaScript rules.

- [Electron](electron/README.md) owns windows, IPC, repository sessions, and persistent state.
- [Renderer](renderer/README.md) owns the workspace interface and editor.
- [Shared contracts](shared/README.md) owns the types and small operations used on both sides of IPC.
- [Tooling](tooling/README.md) owns development, builds, packaging, and dependency pins.
- [Tests](tests/README.md) indexes the automated checks by concern.

Run `npm run dev -- .` from the repository root to open this working tree, or `npm run verify` to run the full verification suite.

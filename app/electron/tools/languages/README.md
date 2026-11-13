---
doc_radar:
  sentinels:
    - file: app/electron/tools/languages/language.mjs
      contains: ['class FrameDecoder', 'class LanguageRuntime', 'textDocument/didOpen']
    - file: app/electron/tools/languages/servers.ts
      contains: ['discoverServers', 'SERVER_SPECS']
---

# Language servers

- [`servers.ts`](servers.ts) discovers supported language servers and builds their launch specifications.
- [`language.mjs`](language.mjs) owns Language Server Protocol framing, open document versions, request cancellation, diagnostics, and process cleanup.

The [workspace session](../../runtime/session/README.md) starts the servers for open files. Run `npm test -- app/tests/tooling/languages` from the repository root. `npm run test:languages` also exercises installed servers against real projects.

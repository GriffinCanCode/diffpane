---
doc_radar:
  sentinels:
    - file: app/renderer/editor/languages/languages.js
      contains: ['createLanguageFeatures']
---

# Language features

The workspace attaches these Monaco providers to visible models. They use the preload API to talk to the Electron language runtime and discard results from stale requests.

- [`languages.js`](languages.js) — Manages provider registration, capabilities, diagnostics, and cancellation.
- [`language-protocol.js`](language-protocol.js) — Validates and translates language server positions, symbols, and diagnostics.

Run `npm test -- app/tests/tooling/languages/language-renderer.test.mjs` to check the renderer provider lifecycle.

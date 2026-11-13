---
doc_radar:
  sentinels:
    - file: app/tests/tooling/languages/language.test.mjs
      contains: ['preserve UTF-8 across every split']
---

# Language service tests

These suites exercise renderer attachment, language-server discovery and the real-server matrix. Run `npm run test:languages` separately to exercise real servers in nested projects and confirm they shut down cleanly.

- [Response fixtures](language-fixture.ts). Validate language protocol results and inspect server process IDs.
- [Renderer integration](language-renderer.test.mjs). Check model language IDs, failure recovery, in-flight requests and diagnostics.
- [Language runtime](language.test.mjs). Exercise protocol framing, manifest discovery, server selection and subprocess lifetime.
- [Real-server matrix](languages.integration.mjs). Check actual responses, advertised capabilities and cleanup across supported languages.

Run `npm test -- app/tests/tooling/languages` from the repository root.

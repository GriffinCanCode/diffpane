---
doc_radar:
  sentinels:
    - file: app/tests/tooling/languages/languages.integration.mjs
      contains: ['LanguageRuntime']
---

# Tooling tests

These suites cover external integrations and the verification tools used during development.

- [Analysis](analysis/README.md). HowMany report, process and scheduling behavior.
- [Assistant](assistant/README.md). Claude session streaming and workspace tool calls.
- [Languages](languages/README.md). Renderer integration, language protocol and real servers.
- [Quality](quality/README.md). Error outcomes and documentation assertions.
- [Syntax](syntax/README.md). Grammar catalog and token rendering.

Run `npm test -- app/tests/tooling` from the repository root.

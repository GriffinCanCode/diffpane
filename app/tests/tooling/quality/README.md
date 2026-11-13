---
doc_radar:
  sentinels:
    - file: app/tests/tooling/quality/docs.test.mjs
      contains: ['documentation source assertions remain true']
---

# Quality tests

These suites verify error boundaries and repository documentation. `npm run test:docs` runs the doc-radar assertions on their own.

- [App errors](app-errors.test.ts). Check explicit outcomes and the shape of failures carried over IPC.
- [Diagnostics](diagnostics.test.ts). Check redaction, local log rotation, and generated preload behavior.
- [Documentation](docs.test.mjs). Validate Markdown frontmatter and check that source sentinel claims remain true.

Run `npm test -- app/tests/tooling/quality` from the repository root.

---
doc_radar:
  sentinels:
    - file: app/tests/interface/explorer/navigator.test.mjs
      contains: ['naturally sorted folders']
---

# Interface tests

These suites exercise the workspace behaviors users encounter while reading, finding and reviewing files. Several tests pair renderer logic with temporary Git repositories to exercise the complete behavior.

- [Editor](editor/README.md). Paint scheduling, autosave, live updates and Markdown links.
- [Explorer](explorer/README.md). Tree projection, incremental reconciliation and file picking.
- [Ideas](ideas/README.md). Notebook Markdown serialization.
- [Review](review/README.md). Line decorations, function context, checkpoints and notes.
- [Search](search/README.md). Project text queries and file search filters.

Run `npm test -- app/tests/interface` from the repository root.

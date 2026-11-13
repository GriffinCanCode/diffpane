---
doc_radar:
  sentinels:
    - file: app/tooling/grammars/catalog/syntax-catalog.ts
      contains: ['formats/directives.json']
---

# Format grammars

`directives.json` highlights directive configuration, including `.acl` and `.swiftformat` files. `metrics.json` highlights Prometheus text exposition. The [catalog](../../catalog/README.md) assigns their file associations.

Run `npm test -- app/tests/tooling/syntax/syntax.test.mjs` from the repository root when changing either grammar.

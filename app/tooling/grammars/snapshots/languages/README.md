---
doc_radar:
  sentinels:
    - file: app/tooling/grammars/catalog/syntax-catalog.ts
      contains: ['languages/designcraft-script.json']
---

# Application language grammars

`amadeus.json` follows the Amadeus lexer expression. `designcraft-script.json` highlights Designcraft Script commands and their embedded JSON. The [catalog](../../catalog/README.md) registers both languages.

Run `npm test -- app/tests/tooling/syntax/syntax.test.mjs` from the repository root when updating either snapshot.

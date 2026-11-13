---
doc_radar:
  sentinels:
    - file: app/tooling/grammars/catalog/syntax-catalog.ts
      contains: ['export function syntaxCatalog']
---

# Syntax catalog

`syntax-catalog.ts` combines upstream grammar metadata with pinned local snapshots. Vite emits lazy browser imports from the catalog, and the Node grammar suite reads the same snapshots through `grammarBytes`.

Run `npm test -- app/tests/tooling/syntax/syntax.test.mjs` and `npm run build` from the repository root when changing the catalog.

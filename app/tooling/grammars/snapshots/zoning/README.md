---
doc_radar:
  sentinels:
    - file: app/tooling/grammars/snapshots/origins.json
      contains: ['The-Billy-Company/zoning']
---

# Zoning grammar

`zoning.json` contains the pinned Zoning editor grammar and `LICENSE` contains its upstream license. The source revision is recorded in [origins.json](../origins.json).

Run `npm test -- app/tests/tooling/syntax/syntax.test.mjs` from the repository root when refreshing the snapshot.

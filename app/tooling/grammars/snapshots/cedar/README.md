---
doc_radar:
  sentinels:
    - file: app/tooling/grammars/snapshots/origins.json
      contains: ['cedar-policy/vscode-cedar']
---

# Cedar grammars

`cedar.json` and `cedarschema.json` contain the upstream Cedar policy and schema grammars. `LICENSE` and `NOTICE` are their upstream legal files. The source revision for both is pinned in [origins.json](../origins.json).

Run `npm test -- app/tests/tooling/syntax/syntax.test.mjs` from the repository root when refreshing the snapshots.

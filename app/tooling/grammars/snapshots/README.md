---
doc_radar:
  sentinels:
    - file: app/tooling/grammars/snapshots/origins.json
      contains: ['token_sha256']
---

# Pinned grammar snapshots

`origins.json` records sources, pinned revisions, and the Amadeus lexer hash. The [syntax catalog](../catalog/README.md) maps grammar IDs to the snapshots here.

- [Cedar](cedar/README.md) contains the policy and schema grammars.
- [Zoning](zoning/README.md) contains the Zoning editor grammar.
- [Languages](languages/README.md) contains Amadeus and Designcraft Script.
- [Formats](formats/README.md) contains directive configuration and metric exposition grammars.

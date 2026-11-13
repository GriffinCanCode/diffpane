---
doc_radar:
  sentinels:
    - file: app/tests/tooling/syntax/syntax.test.mjs
      contains: ['every grammar dependency exists']
---

# Syntax tests

This suite exercises the pinned grammar catalog and its renderer consumers to keep language detection and token rendering consistent.

- [Syntax catalog](syntax.test.mjs). Check dependency closure, format detection, source-preserving tokens and late grammar theme changes.

Run `npm test -- app/tests/tooling/syntax` from the repository root.

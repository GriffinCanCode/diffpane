---
doc_radar:
  sentinels:
    - file: app/tests/tooling/analysis/howmany.test.mjs
      contains: ['automatic']
---

# HowMany tests

This suite covers the workspace source counter, including cancellation, timeouts, invalid reports, source checksum validation and real LSP diagnostics. Run `npm run setup:howmany` first to enable the bundled binary cases.

- [HowMany](howmany.test.mjs). Check report handling, request coalescing, manual refresh and subprocess disposal.

Run `npm test -- app/tests/tooling/analysis` from the repository root.

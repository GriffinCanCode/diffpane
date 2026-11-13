---
doc_radar:
  sentinels:
    - file: app/electron/tools/analysis/howmany.mjs
      contains: ['discoverHowMany', 'validateReport', 'class HowManyRuntime']
---

# HowMany analysis

[`howmany.mjs`](howmany.mjs) discovers the bundled or PATH executable, starts workspace and file analysis, and validates report totals and breakdowns. It manages process limits, cancellation, and automatic refresh cooldown for the [workspace session](../../runtime/session/README.md).

Run `npm run setup:howmany` to prepare the bundled binary, then `npm test -- app/tests/tooling/analysis` from the repository root.

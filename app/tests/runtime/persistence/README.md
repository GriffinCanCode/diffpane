---
doc_radar:
  sentinels:
    - file: app/tests/runtime/persistence/local-state.test.ts
      contains: ['partial transaction']
---

# Persistence tests

These suites cover durable state and the contracts used to share it between windows and app instances.

- [Local state](local-state.test.ts). Check encrypted record authentication, retries, migration, rollback and concurrent writers.
- [Recent targets](recent-targets.test.mjs). Check ordering, limits, corruption, retries and interleaved app updates.
- [Shortcut preferences](shortcut-preferences.test.ts). Check conflicts, legacy migration, defaults and cross-store merges.
- [UI preferences](ui-preferences.test.ts). Check normalization and updates when newer edits arrive during hydration.

Run `npm test -- app/tests/runtime/persistence` from the repository root.

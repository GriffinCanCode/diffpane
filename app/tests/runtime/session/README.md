---
doc_radar:
  sentinels:
    - file: app/tests/runtime/session/session-shutdown.test.mjs
      contains: ['shutdown']
---

# Workspace session tests

These suites check watcher-driven refreshes and the workspace worker lifecycle. Set `DIFFPANE_TEST_WATCH_BACKEND=kqueue` on macOS to exercise the alternate native watcher when FSEvents is degraded.

- [Inventory deltas](inventory-delta.test.mjs). Check incremental changes and metadata updates without path changes.
- [Session fixtures](session-fixture.ts). Validate worker messages and method-specific responses for the session suites.
- [Shutdown](session-shutdown.test.mjs). Hold watcher startup and unsubscribe separately and require natural worker exit.
- [Session](session.test.mjs). Exercise save refreshes, cache lifetimes, inventory reconciliation and watcher fallbacks.

Run `npm test -- app/tests/runtime/session` from the repository root.

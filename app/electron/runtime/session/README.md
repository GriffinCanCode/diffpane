---
doc_radar:
  sentinels:
    - file: app/electron/runtime/session/session.mjs
      contains: ['watcher.subscribe', 'subscription.unsubscribe()', 'port.close()']
    - file: app/electron/runtime/session/session-protocol.ts
      contains: ['parseSessionLaunch', 'parseSessionRequest']
    - file: app/electron/runtime/session/inventory-delta.ts
      contains: ['class InventoryDelta']
---

# Workspace session

- [`session.mjs`](session.mjs) coordinates the repository, document cache, and workspace tools. It publishes snapshots and releases watcher and child-process resources during shutdown.
- [`session-protocol.ts`](session-protocol.ts) validates worker startup and request messages.
- [`workspace-types.ts`](workspace-types.ts) defines the shared file, document, comparison, and snapshot payloads.
- [`inventory-delta.ts`](inventory-delta.ts) records incremental inventory updates for the renderer.

The [main process](../window/README.md) launches a worker for each open workspace. Run `npm test -- app/tests/runtime/session` from the repository root.

The worker reports repository readiness, refresh and catalog timings, document reads and diffs, request durations, and watcher fallback through the main process's local diagnostics. Main-process and worker timings for the same request share a request ID. A one-minute sample tracks event-loop utilization, V8 memory and document cache usage for each open workspace.

---
doc_radar:
  sentinels:
    - file: app/tests/runtime/session/session.test.mjs
      contains: ['concurrent saves retain the inventory']
---

# Runtime tests

These suites exercise Electron's workspace services and persistence, often through real repositories, workers and local databases.

- [Documents](documents/README.md). Caching, comparison workers, file readers and media.
- [Persistence](persistence/README.md). Encrypted local state, recents and settings.
- [Project](project/README.md). Workspace-scoped ideas and review notes.
- [Repository](repository/README.md). Git inventory, file operations and saves.
- [Session](session/README.md). Watcher reconciliation, worker protocol and shutdown.

Run `npm test -- app/tests/runtime` from the repository root.

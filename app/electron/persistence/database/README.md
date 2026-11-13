---
doc_radar:
  sentinels:
    - file: app/electron/persistence/database/local-state.ts
      contains: ['aes-256-gcm', 'PRAGMA journal_mode = WAL', 'class LocalState']
    - file: app/electron/persistence/database/secure-storage.mjs
      contains: ['safeStorage.encryptStringAsync', 'localStateKeys']
---

# Local database

- [`local-state.ts`](local-state.ts) opens the SQLite database and owns encrypted record transactions and legacy migrations.
- [`secure-storage.mjs`](secure-storage.mjs) wraps the database keys with Electron's OS-backed storage.

[Preferences](../preferences/README.md) and [project records](../project/README.md) use the database. Run `npm test -- app/tests/runtime/persistence/local-state.test.ts` from the repository root.

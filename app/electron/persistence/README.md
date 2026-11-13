---
doc_radar:
  sentinels:
    - file: app/electron/persistence/database/local-state.ts
      contains: ['class LocalState', 'PRAGMA journal_mode = WAL']
    - file: app/electron/persistence/project/idea-store.ts
      contains: ['class IdeaStore']
---

# Persistence

- [Database](database/README.md) implements transactions, encryption, and OS key wrapping for local state.
- [Preferences](preferences/README.md) owns recent targets, keyboard shortcuts, and appearance and layout settings.
- [Project records](project/README.md) owns the Ideas notebook and review notes keyed by workspace.

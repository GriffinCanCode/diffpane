---
doc_radar:
  sentinels:
    - file: changelog/platform/persistence/encrypted-local-state.changed
      contains: ['encrypted SQLite database']
---

# Desktop persistence

These fragments cover configurable bindings and the shared storage for preferences and workspace data.

- [Encrypted local state](encrypted-local-state.changed). Share an encrypted database and migrate existing data.
- [Shortcut settings](shortcut-settings.added). View, change and restore bindings.

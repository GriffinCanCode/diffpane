---
doc_radar:
  sentinels:
    - file: app/renderer/editor/updates/autosave.ts
      contains: ['class Autosave']
---

# Editor

The workspace connects Monaco and the reading views to content and events from the Electron session.

- [Updates](updates/README.md) — Save queuing and live path notifications.
- [Highlighting](highlighting/README.md) — Grammar loading, file associations, and editor themes.
- [Languages](languages/README.md) — Language server features exposed through Monaco.
- [Documents](documents/README.md) — Native media, bounded text, and hexadecimal previews.
- [Markdown](markdown/README.md) — Markdown reading view, project links, and diagrams.

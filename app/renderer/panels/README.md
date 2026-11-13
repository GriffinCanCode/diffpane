---
doc_radar:
  sentinels:
    - file: app/renderer/panels/assistant/assistant.js
      contains: ['createAssistant']
---

# Workspace panels

The workspace mounts these optional panels and supplies their Electron bridge, selection, and layout callbacks.

- [Assistant](assistant/README.md) — Claude conversations, tool activity, and proposals.
- [Ideas](ideas/README.md) — Project notebook and Markdown editing.
- [Analysis](analysis/README.md) — HowMany reports and diagnostics.
- [Settings](settings/README.md) — Settings sections and shortcut capture.
- [Appearance](appearance/README.md) — Appearance controls and persisted UI preferences.

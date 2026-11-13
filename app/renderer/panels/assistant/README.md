---
doc_radar:
  sentinels:
    - file: app/renderer/panels/assistant/assistant.js
      contains: ['createAssistant']
---

# The Creature

The workspace supplies selected project context and routes links opened from the conversation. The panel talks to the Electron Claude session through the preload API.

- [`assistant.js`](assistant.js) — Owns the conversation, streaming request lifecycle, settings, and selected context.
- [`assistant-content.js`](assistant-content.js) — Renders sanitized messages, tool activity, and edit proposals.
- [`assistant.css`](assistant.css) — Styles the conversation, composer, and activity cards.
- [`creature-glyph.ts`](creature-glyph.ts) — Defines the Creature glyph used in the panel and its entry points.

Run `npm run dev -- .` and open The Creature from the workspace title bar to inspect the panel.

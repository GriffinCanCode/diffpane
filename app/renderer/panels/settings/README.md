---
doc_radar:
  sentinels:
    - file: app/renderer/panels/settings/settings.js
      contains: ['createSettings']
---

# Settings panel

The workspace mounts this panel with the appearance view and shortcut callbacks. Shortcut parsing and default bindings live in the shared preferences module.

- [`settings.js`](settings.js) — Composes settings sections and captures, resets, and displays keyboard bindings.
- [`settings.css`](settings.css) — Styles the settings panel and its shortcut controls.

Run `npm run dev -- .`, then open Settings and change or reset a shortcut.

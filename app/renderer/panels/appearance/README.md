---
doc_radar:
  sentinels:
    - file: app/renderer/panels/appearance/appearance.ts
      contains: ['createAppearanceSettings']
---

# Appearance and workspace preferences

The settings panel mounts these appearance controls. The preference controller shares current values with the shell layout, editor, and theme, and persists edits through the preload bridge.

- [`appearance.ts`](appearance.ts) — Renders appearance controls and derives code and diff options.
- [`ui-preferences.ts`](ui-preferences.ts) — Merges preference updates and coordinates persistence and theme changes.
- [`appearance.css`](appearance.css) — Styles appearance controls and preference groups.

Run `npm test -- app/tests/runtime/persistence/ui-preferences.test.ts` for the preference contract. Open Settings with `npm run dev -- .` to check the controls.

---
doc_radar:
  sentinels:
    - file: app/shared/preferences/shortcuts.ts
      contains: ['electronAccelerator']
---

# Shortcut contracts

`shortcuts.ts` defines shortcut actions, defaults, parsing, and Electron accelerator formatting. Electron uses the effective bindings for menus, and the renderer uses the same bindings for workspace shortcuts.

Run `npm test -- app/tests/runtime/persistence/shortcut-preferences.test.ts` from the repository root.

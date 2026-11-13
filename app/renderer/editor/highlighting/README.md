---
doc_radar:
  sentinels:
    - file: app/renderer/editor/highlighting/syntax.ts
      contains: ['configureSyntax']
---

# Syntax highlighting

The editor uses Vite’s lazy grammar catalog and the active appearance preference to configure Monaco. Highlighting can run before a language server starts.

- [`syntax.ts`](syntax.ts) — Registers file associations and selects syntax for unfamiliar text formats.
- [`grammars.ts`](grammars.ts) — Loads grammar dependencies and attaches TextMate tokenization.
- [`editor-themes.ts`](editor-themes.ts) — Defines the light and dark editor palettes.

Run `npm test -- app/tests/tooling/syntax` to check grammar dependencies, tokenization, and theme switching.

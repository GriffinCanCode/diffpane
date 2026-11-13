---
doc_radar:
  sentinels:
    - file: app/renderer/types/shims.d.ts
      contains: ['virtual:syntax-catalog']
---

# Renderer types

These declarations make the preload API and generated or untyped renderer imports available to TypeScript.

- [`shims.d.ts`](shims.d.ts) — Declares the preload bridge on Window, the Vite grammar catalog, and the Monaco JSON tokenizer.

Run `npm run check` to type-check callers against these declarations.

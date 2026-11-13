---
doc_radar:
  sentinels:
    - file: app/renderer/review/comparison/function-ranges.ts
      contains: ['changedFunctionRanges']
---

# Focused comparison

The workspace uses these modules to highlight changed functions and focus a comparison on nearby lines. Function ranges can come from the language provider or a lexical fallback.

- [`function-ranges.ts`](function-ranges.ts) — Finds the functions that overlap changed lines.
- [`review-focus.js`](review-focus.js) — Owns comparison scope, navigation controls, and the full-file toggle.
- [`review-focus.css`](review-focus.css) — Styles comparison scope and navigation controls.

Run `npm test -- app/tests/interface/review/function-ranges.test.mjs` for function boundaries. Use `npm run dev -- .` to switch between focused and full-file views.

---
doc_radar:
  sentinels:
    - file: app/renderer/editor/markdown/markdown-preview.ts
      contains: ['showMarkdownPreview']
---

# Markdown reading view

The workspace swaps the Monaco editor for this preview when it opens Markdown in reading mode. Project-relative links and assets resolve through the workspace and Electron bridge.
Syntax highlights and Mermaid diagrams use the selected appearance palette and update when it changes.

- [`markdown-preview.ts`](markdown-preview.ts) — Renders sanitized Markdown, code blocks, metadata, and lazy Mermaid diagrams.
- [`markdown-document.ts`](markdown-document.ts) — Parses source, extracts frontmatter, and counts words before the preview builds its DOM.
- [`markdown-paths.ts`](markdown-paths.ts) — Resolves relative project paths and heading anchors.
- [`markdown-preview.css`](markdown-preview.css) — Styles the reading view and its code, tables, and diagrams.

Run `npm test -- app/tests/interface/editor/markdown.test.mjs` for path handling. Open a Markdown file with `npm run dev -- .` to exercise the preview.

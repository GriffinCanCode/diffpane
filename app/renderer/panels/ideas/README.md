---
doc_radar:
  sentinels:
    - file: app/renderer/panels/ideas/ideas.ts
      contains: ['mountIdeaBuilder']
---

# Ideas notebook

The workspace mounts this notebook and handles project links and Claude attachments. The panel maintains the active idea and saves notebook edits through the preload bridge.

- [`ideas.ts`](ideas.ts) — Owns idea selection, search, drafts, autosave, and attachments.
- [`idea-editor.ts`](idea-editor.ts) — Mounts CodeMirror and wires notebook editing actions.
- [`idea-editor-markdown.ts`](idea-editor-markdown.ts) — Displays Markdown while editing and handles syntax-aware decorations and actions.
- [`ideas.css`](ideas.css) — Styles the notebook, editor toolbar, and docking controls.

Run `npm test -- app/tests/interface/ideas` for editing commands. Use `npm run dev -- .` to exercise the notebook and docking.

The dock and full notebook share the workspace appearance tokens. Search highlights matching titles, note excerpts, or linked paths. Markdown headings use the shared type scale, and code blocks use the editor font and size from Appearance.

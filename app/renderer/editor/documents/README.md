---
doc_radar:
  sentinels:
    - file: app/renderer/editor/documents/document-preview.ts
      contains: ['URL.revokeObjectURL']
---

# Document previews

The workspace uses this view for native media, bounded text, and hexadecimal inspection. It consumes the Electron file-content contract and releases preview resources when the active file changes.

- [`document-preview.ts`](document-preview.ts) — Builds the preview and comparison panes and owns Blob URLs.
- [`media.ts`](media.ts) — Mounts image and video previews and releases playback when detached.
- [`document-preview.css`](document-preview.css) — Styles preview panes, metadata, and the Hex toggle.

Run `npm run dev -- .` and open an image, a PDF, and a binary file to exercise rendering and the byte fallback.

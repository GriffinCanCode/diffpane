---
doc_radar:
  sentinels:
    - file: app/renderer/panels/analysis/howmany.js
      contains: ['createHowMany']
---

# HowMany analysis

The workspace starts analysis through the Electron bridge. This panel turns workspace and file results into summary rows, reports, and editor diagnostics.

- [`howmany.js`](howmany.js) — Renders project and per-file reports and manages diagnostic markers.
- [`howmany.css`](howmany.css) — Styles analysis summaries and the report view.

Run `npm run setup:howmany`, then `npm run dev -- .` to inspect the workspace summary and file report.

---
doc_radar:
  sentinels:
    - file: app/renderer/shell/layout/workspace-layout.ts
      contains: ['createWorkspaceLayout']
---

# Layout and scheduling

These modules size and arrange the workspace panels, supply explorer icons, and let background work yield to the browser before starting.

- [`workspace-layout.ts`](workspace-layout.ts) — Controls pane placement, drag, resize, and saved layout.
- [`workspace-layout.css`](workspace-layout.css) — Styles pane geometry and resize affordances.
- [`after-paint.ts`](after-paint.ts) — Schedules cancellable work after a paint opportunity.
- [`icons.ts`](icons.ts) — Resolves file and folder icons using Material theme associations.

Run `npm test -- app/tests/interface/editor/after-paint.test.mjs` for scheduling. Use `npm run dev -- .` to exercise panel docking and resizing.

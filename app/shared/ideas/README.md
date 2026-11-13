---
doc_radar:
  sentinels:
    - file: app/shared/ideas/ideas.ts
      contains: ['interface Idea']
---

# Idea contracts

`ideas.ts` defines notebook records, links, changes, and the constraints shared by the Electron idea store and the renderer notebook.

Run `npm test -- app/tests/runtime/project/idea-store.test.ts` from the repository root.

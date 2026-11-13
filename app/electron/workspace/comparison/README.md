---
doc_radar:
  sentinels:
    - file: app/electron/workspace/comparison/changes.ts
      contains: ['DIFF_TIMEOUT_MS', 'MAX_DECORATIONS', 'export function decorations']
    - file: app/electron/workspace/comparison/diff-runtime.ts
      contains: ['class DiffRuntime', 'new Worker']
---

# Diff calculation

- [`changes.ts`](changes.ts) computes bounded line decorations without reconstructing the text of the change segments.
- [`diff-runtime.ts`](diff-runtime.ts) handles small edits in the workspace worker and runs overlapping larger diffs in up to two dedicated workers. Each dedicated worker is started on demand and released when idle.
- [`diff-worker.ts`](diff-worker.ts) receives requests and returns results using the worker's message protocol.

The [workspace session](../../runtime/session/README.md) owns the runtime and supplies the document versions. Run `npm test -- app/tests/interface/review/changes.test.mjs app/tests/runtime/documents/document-cache.test.mjs` from the repository root.

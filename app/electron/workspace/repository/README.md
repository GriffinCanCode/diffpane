---
doc_radar:
  sentinels:
    - file: app/electron/workspace/repository/repository.mjs
      contains: ['class Repository', '--porcelain=v2', 'MAX_CHECKPOINT_PATHS']
    - file: app/electron/workspace/repository/content-search.mjs
      contains: ['searchRepositoryContent', 'MAX_MATCHES']
    - file: app/electron/workspace/repository/file-operations.ts
      contains: ['operationPath', 'renameEntry']
---

# Repository and file operations

- [`repository.mjs`](repository.mjs) reads Git state and confined file contents, captures checkpoints, and saves working files with disk conflict checks.
- [`content-search.mjs`](content-search.mjs) scans eligible working files and returns bounded, cancellable results.
- [`file-operations.ts`](file-operations.ts) validates file operation targets and coordinates renames.

The [workspace session](../../runtime/session/README.md) uses these operations to update its inventory and document snapshots. Run `npm test -- app/tests/runtime/repository app/tests/interface/search/content-search.test.mjs` from the repository root.

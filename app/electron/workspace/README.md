---
doc_radar:
  sentinels:
    - file: app/electron/workspace/repository/repository.mjs
      contains: ['class Repository']
    - file: app/electron/workspace/documents/file-content.ts
      contains: ['export function fileContent']
    - file: app/electron/workspace/comparison/diff-runtime.ts
      contains: ['class DiffRuntime']
---

# Workspace data

- [Repository](repository/README.md) owns Git state, inventory, content search, and file operations.
- [Documents](documents/README.md) owns content decoding, preview and media responses, and the document cache.
- [Comparison](comparison/README.md) owns bounded diff calculation and its worker.

---
doc_radar:
  sentinels:
    - file: changelog/development/07-vite-plus-toolchain.changed
      contains: ['cached renderer builds']
---

# Development tooling

These fragments record the build toolchain and the load-test work used to exercise desktop responsiveness.

- [Vite+ toolchain](07-vite-plus-toolchain.changed). Unify builds, tests and static checks.
- [Load tests and inventory deltas](08-load-tests-and-inventory-deltas.performance). Exercise concurrent writes and send smaller explorer updates across IPC.

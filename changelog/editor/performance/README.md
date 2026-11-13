---
doc_radar:
  sentinels:
    - file: changelog/editor/performance/14-idle-work-and-memory.performance
      contains: ['retire idle diff workers']
---

# Editor performance

These fragments track work and memory used to keep file reads and editing responsive as repositories grow.

- [Large-repository responsiveness](07-large-repository-responsiveness.performance). Bound reads, invalidate selectively and move diff and search work off the foreground.
- [Idle work and memory](14-idle-work-and-memory.performance). Release workers and search inventory and keep bounded previews from pinning larger strings.

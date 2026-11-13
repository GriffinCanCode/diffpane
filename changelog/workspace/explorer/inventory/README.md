---
doc_radar:
  sentinels:
    - file: changelog/workspace/explorer/inventory/12-ignored-file-browsing.added
      contains: ['one level at a time']
---

# Explorer inventory

These fragments record which files appear in the explorer and how the tree reacts to changes on disk.

- [Ignored file browsing](12-ignored-file-browsing.added). Load and release ignored descendants on expansion and collapse.
- [Deleted tracked files](16-deleted-tracked-files.fixed). Drop missing files from browsing while retaining Git deletion status.
- [Restored tracked files](tracked-restore.fixed). Show tracked files restored by an update event.

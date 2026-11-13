---
doc_radar:
  sentinels:
    - file: changelog/platform/lifecycle/error-recovery.added
      contains: ['Reconnect to a failed workspace worker']
---

# Desktop lifecycle

These fragments cover opening and closing windows, recovering from errors and refreshing the workspace after watcher failures.

- [Welcome screen and shutdown](19-welcome-screen-and-shutdown.fixed). Open untargeted windows and let workers drain during shutdown.
- [Error recovery](error-recovery.added). Retry failures and preserve unsaved edits.
- [Idle resume](idle-resume.fixed). Limit fallback polling and automatic work after failures.
- [Live refresh](live-refresh.fixed). Keep file and inventory loading during continuous edits.

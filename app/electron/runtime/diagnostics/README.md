---
doc_radar:
  sentinels:
    - file: app/electron/runtime/diagnostics/diagnostic-log.ts
      contains: ['createDiagnosticLog', 'MAX_ARCHIVED_FILES', 'MAX_AGE_MS']
    - file: app/electron/runtime/diagnostics/desktop-metrics.ts
      contains: ['getAppMetrics', 'monitorEventLoopDelay']
---

# Desktop diagnostics

Diffpane keeps structured diagnostic logs on the device. Choose **View → Open Diagnostics Folder** to find them. On macOS, the folder is `~/Library/Logs/Diffpane/diagnostics`. On Linux and Windows, it is `logs/diagnostics` in Diffpane’s Electron user-data directory.

Each launch writes a JSON Lines file and rotates it at approximately 2 MiB, retaining one previous segment. At launch, Diffpane prunes files from exited instances that are over seven days old and keeps up to eight recent files from those instances. It buffers writes, bounds the queue, and gives warnings and errors priority over routine telemetry when the queue fills. Normal quit drains the queue. Fatal main-process exceptions also write a small separate record. No diagnostic records are uploaded.

Search the `operation` field for an area such as `ipc.document`, `workspace.git.status`, or `renderer.workspace-first-render`. Match `requestId` on `worker-roundtrip.*` and `workspace-request.*` to compare a worker round trip with time spent handling the request. The renderer records the ready shell and initial editor or preview separately from the workspace reveal. CPU, process working sets, main and workspace event-loop metrics, document-cache counters, and renderer long tasks provide additional context. Chromium process totals group workers with their host processes. Workspace isolate metrics show the worker’s own heap and external allocation.

Desktop metrics report every 30 seconds and workspace metrics every minute. The main event-loop delay histogram samples at 50 ms resolution. Use the maximum alongside p95 to spot isolated stalls.

Choose **View → Toggle Developer Tools** and use the Performance panel for an interactive recording when duration and responsiveness metrics point to renderer stalls. Use the Memory panel for renderer heap snapshots. Traces and snapshots can contain project content, so review them before sharing.

---
doc_radar:
  sentinels:
    - file: app/shared/diagnostics/diagnostics.ts
      contains: ['createDiagnostics', 'parseDiagnostic', 'serializeAppError']
---

# Diagnostic events

The shared helpers record events, operation durations, and metrics across the renderer, main process, and workspace worker. Failures reuse the existing AppError classification and keep only a recognized code and the recovery flag. Durations preserve the operation result or thrown value and distinguish cancellation from failure.

Use fixed operation names. Keep function arguments, exception messages, stacks, and other free text in their existing application boundaries. Main validates the renderer and worker record shapes and assigns the window identifier. The renderer may send only registered operation names.

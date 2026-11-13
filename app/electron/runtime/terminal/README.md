---
doc_radar:
  sentinels:
    - file: app/electron/runtime/terminal/dock.ts
      contains: ['WebContentsView', 'showMessageBox', 'setPermissionCheckHandler']
    - file: app/electron/runtime/terminal/pty.ts
      contains: ['TerminalProcess', 'outputHighWater', 'shellSettings']
---

# Workspace terminal

The workspace renderer can show and position the dock. A separate sandboxed view loads the bundled terminal from its own in-memory Electron session and local protocol. Only that view’s trusted top-level document has terminal IPC. Main owns the workspace path, confirms each shell start in a native dialog, and limits input to the visible, focused terminal. A shell uses a minimal launch environment and can load the user’s login configuration with the user’s normal permissions.

The PTY pauses when outgoing data backs up and resumes when the terminal consumes it. Hiding the view preserves the active session. Closing or reloading the workspace or losing either renderer closes the PTY. Diffpane excludes commands and output from its diagnostics and stores scrollback only in the view. The shell can save command history according to the user’s shell configuration.

Clipboard paste follows a user gesture and multiline paste requires confirmation. Terminal output cannot open links, write the clipboard, or send automatic responses to the shell. Terminal applications that depend on automatic device or cursor reports may have reduced functionality.

export const terminalMinimumColumns = 2
export const terminalMaximumColumns = 500
export const terminalMinimumRows = 1
export const terminalMaximumRows = 300
export const terminalMaximumInputBytes = 64 * 1024

export type TerminalStartResult = { ok: true } | { ok: false; message: string }

export interface TerminalBridge {
  start: (cols: number, rows: number) => Promise<TerminalStartResult>
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  acknowledge: (bytes: number) => void
  stop: () => Promise<void>
  hide: () => void
  onData: (listener: (data: string, bytes: number) => void) => () => void
  onExit: (listener: (exitCode: number | null, reason?: string) => void) => () => void
  onTheme?: (listener: (theme: 'light' | 'dark') => void) => () => void
}

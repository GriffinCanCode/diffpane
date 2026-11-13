import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { TerminalBridge, TerminalStartResult } from '../../../shared/terminal/protocol.ts'

const bridge: TerminalBridge = {
  async start(cols, rows) {
    const value: unknown = await ipcRenderer.invoke('terminal-start', cols, rows)
    if (typeof value === 'object' && value !== null && 'ok' in value) {
      if (value.ok === true) return { ok: true }
      if (value.ok === false && 'message' in value && typeof value.message === 'string')
        return { ok: false, message: value.message }
    }
    return { ok: false, message: 'The terminal did not respond.' } satisfies TerminalStartResult
  },
  write: data => ipcRenderer.send('terminal-input', data),
  resize: (cols, rows) => ipcRenderer.send('terminal-resize', cols, rows),
  acknowledge: bytes => ipcRenderer.send('terminal-ack', bytes),
  async stop() {
    await ipcRenderer.invoke('terminal-stop')
  },
  hide: () => ipcRenderer.send('terminal-hide'),
  onData(listener) {
    const receive = (_event: IpcRendererEvent, data: unknown, bytes: unknown) => {
      if (typeof data === 'string' && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0)
        listener(data, bytes)
    }
    ipcRenderer.on('terminal-data', receive)
    return () => ipcRenderer.removeListener('terminal-data', receive)
  },
  onExit(listener) {
    const receive = (_event: IpcRendererEvent, code: unknown, reason: unknown) => {
      if (code === null || (typeof code === 'number' && Number.isSafeInteger(code)))
        listener(code, typeof reason === 'string' ? reason : undefined)
    }
    ipcRenderer.on('terminal-exit', receive)
    return () => ipcRenderer.removeListener('terminal-exit', receive)
  },
  onTheme(listener) {
    const receive = (_event: IpcRendererEvent, theme: unknown) => {
      if (theme === 'light' || theme === 'dark') listener(theme)
    }
    ipcRenderer.on('terminal-theme', receive)
    return () => ipcRenderer.removeListener('terminal-theme', receive)
  },
}
contextBridge.exposeInMainWorld('diffpaneTerminal', bridge)

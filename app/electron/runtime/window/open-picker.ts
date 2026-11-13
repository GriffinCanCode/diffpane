import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { OpenDialogOptions } from 'electron'
import { app, dialog } from 'electron'
import { appError } from '../../../shared/recovery/app-errors.ts'

const execute = promisify(execFile)
export const openPickerFlag = '--diffpane-open-picker'
export type OpenKind = 'file' | 'folder'

export function openPickerOptions(kind: OpenKind): OpenDialogOptions {
  return {
    properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    title: kind === 'file' ? 'Open a file' : 'Open a folder',
  }
}

export async function runOpenPicker(kind: string | undefined) {
  if (kind !== 'file' && kind !== 'folder') throw new Error('Invalid picker type.')
  await app.whenReady()
  app.setActivationPolicy('accessory')
  const selection = dialog.showOpenDialog(openPickerOptions(kind))
  app.focus({ steal: true })
  const result = await selection
  const selected = result.canceled ? null : (result.filePaths[0] ?? null)
  process.stdout.write(JSON.stringify(selected), error => app.exit(error ? 1 : 0))
}

export async function pickMacTarget(kind: OpenKind, signal: AbortSignal): Promise<string | null> {
  const profile = await mkdtemp(path.join(tmpdir(), 'diffpane-picker-'))
  try {
    if (signal.aborted) return null
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), openPickerFlag, kind, `--user-data-dir=${profile}`]
    // AppKit can block synchronously while it connects to the open panel service.
    // A separate process keeps Diffpane responsive and can be stopped during that wait.
    const execution = execute(process.execPath, args, { signal, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 })
    const closed = new Promise<void>(resolve => {
      execution.child.once('close', () => resolve())
    })
    const [result] = await Promise.allSettled([execution, closed])
    if (signal.aborted) return null
    if (result.status === 'rejected') throw new Error('The picker process failed.', { cause: result.reason })
    const selected: unknown = JSON.parse(result.value.stdout)
    if (selected === null || (typeof selected === 'string' && path.isAbsolute(selected))) return selected
    throw new Error('Invalid picker response.')
  } catch {
    if (signal.aborted) return null
    throw appError('macOS could not open the picker. Try again.', {
      code: 'PICKER_UNAVAILABLE',
      operation: `open-${kind}`,
    })
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

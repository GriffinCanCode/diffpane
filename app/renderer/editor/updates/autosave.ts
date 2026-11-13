import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import type { AppError, Result } from '../../../shared/recovery/app-errors.ts'
import { rendererDiagnostics } from '../../shell/diagnostics/diagnostics.ts'
import { reportError } from '../../shell/recovery/errors.ts'

/** Serialize writes and coalesce typing while a write is in flight. */
export class Autosave {
  private saved: string
  private latest: string | (() => string)
  private running: Promise<Result<void>> | null = null
  private failed = false
  private readonly write: (text: string, expected: string) => Promise<unknown>
  private readonly changed: (state: 'saving' | 'saved' | 'error', error?: AppError) => void

  constructor(
    initial: string,
    write: (text: string, expected: string) => Promise<unknown>,
    changed: (state: 'saving' | 'saved' | 'error', error?: AppError) => void,
  ) {
    this.saved = this.latest = initial
    this.write = write
    this.changed = changed
  }

  get pending() {
    return this.running !== null || this.latest !== this.saved
  }

  accept(text: string) {
    if (!this.pending) this.saved = this.latest = text
  }

  edit(text: string | (() => string)) {
    this.latest = text
    // A failed save retains the buffer until an explicit retry.
    if (!this.failed) {
      this.start()?.catch((cause: unknown) => reportError(cause, { operation: 'Save file' }))
    } else if (this.readLatest() === this.saved) {
      this.failed = false
      this.changed('saved')
    }
  }

  async flush(): Promise<void> {
    const result = await this.start()
    if (result && !result.ok) throw result.error
  }

  private start() {
    if (this.running) return this.running
    if (this.latest === this.saved) return null
    this.failed = false
    const running = Promise.resolve().then(() => this.persist())
    this.running = running
    this.changed('saving')
    return running
  }

  private readLatest() {
    // Read the editor buffer only when a write can use it.
    return (this.latest = typeof this.latest === 'function' ? this.latest() : this.latest)
  }

  private async persist(): Promise<Result<void>> {
    try {
      for (let text = this.readLatest(); text !== this.saved; text = this.readLatest()) {
        const startedAt = performance.now()
        // oxlint-disable-next-line eslint/no-await-in-loop -- The next save uses this write's text as its precondition.
        const result = await attemptAsync(() => this.write(text, this.saved), {
          operation: 'Save file',
        })
        rendererDiagnostics.measure('renderer.autosave-write', startedAt, result)
        if (!result.ok) {
          this.failed = this.readLatest() !== this.saved
          if (!this.failed) break
          this.changed('error', result.error)
          return result
        }
        this.saved = text
      }
      return { ok: true, value: undefined }
    } finally {
      this.running = null
      if (!this.failed) this.changed('saved')
    }
  }
}

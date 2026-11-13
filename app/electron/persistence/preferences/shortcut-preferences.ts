import { DatabaseSync } from 'node:sqlite'
import {
  defaultBinding,
  electronAccelerator,
  isShortcutAction,
  normalizeBinding,
  shortcutConflict,
  shortcuts,
} from '../../../shared/preferences/shortcuts.ts'
import type { ShortcutAction, ShortcutOverrides } from '../../../shared/preferences/shortcuts.ts'
import type { LocalState, StateRecords } from '../database/local-state.ts'

const COLLECTION = 'shortcuts'

export class ShortcutPreferences {
  private readonly state: LocalState
  private readonly legacyFilename: string
  private readonly platform: string
  private initialized?: Promise<void>

  constructor(state: LocalState, legacyFilename: string, platform = process.platform) {
    this.state = state
    this.legacyFilename = legacyFilename
    this.platform = platform
  }

  async get(): Promise<ShortcutOverrides> {
    await this.initialize()
    return this.state.read(records => this.read(records))
  }

  async set(action: unknown, input: unknown): Promise<ShortcutOverrides> {
    if (!isShortcutAction(action)) throw new Error('Unknown shortcut.')
    const binding = this.validateBinding(action, input)
    if (!binding) throw new Error('Choose a supported key combination.')
    if (binding === defaultBinding(action)) return this.reset(action)
    return this.change(records => {
      this.checkConflict(action, binding, records)
      records.put(COLLECTION, '', action, binding)
    })
  }

  async reset(action?: unknown): Promise<ShortcutOverrides> {
    if (action !== undefined && !isShortcutAction(action)) throw new Error('Unknown shortcut.')
    return this.change(records => {
      if (action === undefined) {
        for (const key of Object.keys(shortcuts)) records.delete(COLLECTION, '', key)
      } else {
        this.checkConflict(action, defaultBinding(action), records)
        records.delete(COLLECTION, '', action)
      }
    })
  }

  private validateBinding(action: ShortcutAction, value: unknown) {
    const isMac = this.platform === 'darwin'
    const binding = normalizeBinding(value, isMac)
    if (!binding || (shortcuts[action].scope === 'native' && !electronAccelerator(binding, isMac))) return null
    return binding
  }

  private checkConflict(action: ShortcutAction, binding: string, records: StateRecords) {
    const conflict = shortcutConflict(action, binding, this.read(records), this.platform)
    if (conflict) throw new Error(`This shortcut is already used by ${conflict}.`)
  }

  private read(records: StateRecords): ShortcutOverrides {
    const overrides: ShortcutOverrides = {}
    for (const action of Object.keys(shortcuts).toSorted()) {
      if (!isShortcutAction(action)) continue
      const value = records.get(COLLECTION, '', action)
      const binding = this.validateBinding(action, value)
      if (binding && binding !== defaultBinding(action)) overrides[action] = binding
    }
    // A saved binding can conflict with a default introduced by a newer release.
    for (;;) {
      const conflict = Object.entries(overrides)
        .map(([action, binding]) =>
          isShortcutAction(action) && shortcutConflict(action, binding, overrides, this.platform) ? action : undefined,
        )
        .find(action => action !== undefined)
      if (!conflict) return overrides
      delete overrides[conflict]
    }
  }

  private async change(update: (records: StateRecords) => void) {
    await this.initialize()
    return this.state.write(records => {
      update(records)
      return this.read(records)
    })
  }

  private initialize() {
    this.initialized ??= this.state
      .migrate(
        COLLECTION,
        this.legacyFilename,
        (records, filename) => {
          using legacy = new DatabaseSync(filename, { readOnly: true })
          const table = legacy.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'shortcuts'").get()
          if (!table) return
          for (const { action, binding: value } of legacy.prepare('SELECT action, binding FROM shortcuts').iterate()) {
            if (!isShortcutAction(action)) continue
            const binding = this.validateBinding(action, value)
            if (binding && binding !== defaultBinding(action)) records.put(COLLECTION, '', action, binding)
          }
        },
        { sqlite: true },
      )
      .catch((error: unknown) => {
        this.initialized = undefined
        throw error
      })
    return this.initialized
  }
}

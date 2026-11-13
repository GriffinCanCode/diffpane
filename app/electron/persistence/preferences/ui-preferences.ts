import { editorDefaultSize } from '../../../shared/appearance/typography.ts'

const themes = ['dark', 'light', 'system'] as const
const diffLayouts = ['automatic', 'split', 'inline'] as const
const wrapModes = ['automatic', 'on', 'off'] as const
const fonts = ['system', 'menlo', 'monaco', 'courier'] as const

export interface Appearance {
  theme: (typeof themes)[number]
  layout: (typeof diffLayouts)[number]
  font: (typeof fonts)[number]
  fontSize: number
  wordWrap: (typeof wrapModes)[number]
  lineNumbers: boolean
}

export const minFontSize = 10
export const maxFontSize = 28
export const defaultAppearance: Appearance = {
  theme: 'dark',
  layout: 'automatic',
  font: 'system',
  fontSize: editorDefaultSize,
  wordWrap: 'automatic',
  lineNumbers: true,
}

export const paneWidths = {
  ideas: { initial: 282, min: 184, max: 560 },
  files: { initial: 270, min: 156, max: 480 },
  right: { initial: 368, min: 248, max: 680 },
}
export const rightPaneHeight = { initial: 250, min: 172, max: 640 }
export type PaneColumn = keyof typeof paneWidths
export type WorkspacePane = PaneColumn | 'code'
export type PaneDimension = PaneColumn | 'rightHeight'
export type PaneSizes = Record<PaneDimension, number>
export type WorkspaceLayout = PaneSizes & { order: readonly WorkspacePane[] }
export const paneColumns: readonly PaneColumn[] = ['ideas', 'files', 'right']
export const paneDimensions: readonly PaneDimension[] = [...paneColumns, 'rightHeight']
const defaultOrder: readonly WorkspacePane[] = ['ideas', 'files', 'code', 'right']
export const defaultPaneSizes: PaneSizes = {
  ideas: paneWidths.ideas.initial,
  files: paneWidths.files.initial,
  right: paneWidths.right.initial,
  rightHeight: rightPaneHeight.initial,
}

export interface UiPreferences {
  appearance: Appearance
  layout: WorkspaceLayout
  ideasVisible: boolean
}
export const defaultUiPreferences: UiPreferences = {
  appearance: defaultAppearance,
  layout: { ...defaultPaneSizes, order: defaultOrder },
  ideasVisible: false,
}
export const uiPreferenceKeys = ['appearance', 'layout', 'ideasVisible'] as const
export type UiPreferenceKey = (typeof uiPreferenceKeys)[number]
type KeyedPreference<Values> = { [Key in keyof Values]: { key: Key; value: Values[Key] } }[keyof Values]
export type UiPreferenceUpdate = KeyedPreference<UiPreferences> & { revision?: number }
export interface UiPreferencePatches {
  appearance: Partial<Appearance>
  layout: Partial<WorkspaceLayout>
  ideasVisible: boolean
}
export type UiPreferencePatch = KeyedPreference<UiPreferencePatches>
export interface UiPreferencesBridge {
  get: (legacy: Partial<UiPreferences>) => Promise<Partial<UiPreferences>>
  set: <Key extends UiPreferenceKey>(key: Key, value: UiPreferencePatches[Key]) => Promise<UiPreferenceUpdate>
  onChange: (listener: (update: UiPreferenceUpdate) => void) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function appearanceFields(input: Record<string, unknown>) {
  const patch: Partial<Appearance> = {}
  const theme = themes.find(option => option === input.theme)
  const layout = diffLayouts.find(option => option === input.layout)
  const font = fonts.find(option => option === input.font)
  const wordWrap = wrapModes.find(mode => mode === input.wordWrap)
  if (theme) patch.theme = theme
  if (layout) patch.layout = layout
  if (font) patch.font = font
  if (wordWrap) patch.wordWrap = wordWrap
  if (typeof input.fontSize === 'number' && Number.isFinite(input.fontSize))
    patch.fontSize = Math.max(minFontSize, Math.min(maxFontSize, Math.round(input.fontSize)))
  if (typeof input.lineNumbers === 'boolean') patch.lineNumbers = input.lineNumbers
  return patch
}

function isPane(value: unknown): value is WorkspacePane {
  return defaultOrder.some(pane => pane === value)
}

function layoutFields(input: Record<string, unknown>) {
  const patch: Partial<WorkspaceLayout> = {}
  for (const key of paneDimensions) {
    const value = input[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const { min, max } = key === 'rightHeight' ? rightPaneHeight : paneWidths[key]
    patch[key] = Math.max(min, Math.min(max, value))
  }
  const order: unknown = input.order
  if (
    Array.isArray(order) &&
    order.length === defaultOrder.length &&
    order.every(isPane) &&
    new Set(order).size === defaultOrder.length
  )
    patch.order = [...order]
  return patch
}

export function parseUiPreferencePatch(key: unknown, input: unknown): UiPreferencePatch {
  if (key === 'ideasVisible' && typeof input === 'boolean') return { key, value: input }
  if (isRecord(input)) {
    if (key === 'appearance') {
      const value = appearanceFields(input)
      if (Object.keys(value).length) return { key, value }
    }
    if (key === 'layout') {
      const value = layoutFields(input)
      if (Object.keys(value).length) return { key, value }
    }
  }
  throw new Error('Invalid Diffpane preference.')
}

export function applyUiPreferencePatch(patch: UiPreferencePatch, current?: unknown): UiPreferenceUpdate {
  if (patch.key === 'appearance') {
    return {
      key: patch.key,
      value: { ...defaultAppearance, ...(isRecord(current) && appearanceFields(current)), ...patch.value },
    }
  }
  if (patch.key === 'layout') {
    return {
      key: patch.key,
      value: { ...defaultUiPreferences.layout, ...(isRecord(current) && layoutFields(current)), ...patch.value },
    }
  }
  return patch
}

export function parseUiPreference(key: unknown, input: unknown): UiPreferenceUpdate {
  return applyUiPreferencePatch(parseUiPreferencePatch(key, input))
}

export function parseUiPreferences(input: unknown): Partial<UiPreferences> {
  if (!isRecord(input)) return {}
  const preferences: Partial<UiPreferences> = {}
  for (const key of uiPreferenceKeys) {
    if (!Object.hasOwn(input, key)) continue
    try {
      const update = parseUiPreference(key, input[key])
      Object.assign(preferences, { [update.key]: update.value })
    } catch {
      // A malformed legacy value must not prevent importing other settings.
    }
  }
  return preferences
}

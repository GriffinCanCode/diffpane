interface ShortcutDefinition {
  label: string
  group: string
  defaultBinding: ShortcutBinding
  scope: 'native' | 'window' | 'explorer' | 'reviewNotes' | 'ideas'
}

export const shortcuts = {
  newWindow: {
    label: 'New window',
    group: 'Window',
    defaultBinding: 'Primary+N',
    scope: 'native',
  },
  openFolder: {
    label: 'Open folder',
    group: 'Window',
    defaultBinding: 'Primary+O',
    scope: 'native',
  },
  openFile: {
    label: 'Open file',
    group: 'Window',
    defaultBinding: 'Primary+Shift+O',
    scope: 'native',
  },
  closeWindow: {
    label: 'Close window',
    group: 'Window',
    defaultBinding: 'Primary+W',
    scope: 'native',
  },
  openSettings: {
    label: 'Open settings',
    group: 'Window',
    defaultBinding: 'Primary+,',
    scope: 'native',
  },
  toggleClaude: {
    label: 'Toggle Claude panel',
    group: 'Window',
    defaultBinding: 'Primary+Shift+L',
    scope: 'window',
  },
  toggleIdeas: {
    label: 'Toggle Ideas notebook',
    group: 'Window',
    defaultBinding: 'Primary+Shift+I',
    scope: 'window',
  },
  searchFiles: {
    label: 'Search files',
    group: 'Search and navigation',
    defaultBinding: 'Primary+P',
    scope: 'window',
  },
  quickOpen: {
    label: 'Search files (alternate)',
    group: 'Search and navigation',
    defaultBinding: 'Primary+K',
    scope: 'window',
  },
  searchProject: {
    label: 'Search in project',
    group: 'Search and navigation',
    defaultBinding: 'Primary+Shift+F',
    scope: 'window',
  },
  find: {
    label: 'Find in file or explorer',
    group: 'Search and navigation',
    defaultBinding: 'Primary+F',
    scope: 'window',
  },
  toggleExplorer: {
    label: 'Toggle explorer',
    group: 'Search and navigation',
    defaultBinding: 'Primary+B',
    scope: 'window',
  },
  refresh: {
    label: 'Refresh workspace',
    group: 'Search and navigation',
    defaultBinding: 'Primary+R',
    scope: 'window',
  },
  save: {
    label: 'Save file or idea',
    group: 'Editing',
    defaultBinding: 'Primary+S',
    scope: 'window',
  },
  reviewChanges: {
    label: 'Review changes',
    group: 'Review',
    defaultBinding: 'Primary+Shift+G',
    scope: 'window',
  },
  reviewNotes: {
    label: 'Review notes',
    group: 'Review',
    defaultBinding: 'Primary+Shift+J',
    scope: 'window',
  },
  saveReviewNote: {
    label: 'Save review note',
    group: 'Review',
    defaultBinding: 'Primary+Enter',
    scope: 'reviewNotes',
  },
  renameExplorerItem: {
    label: 'Rename explorer item',
    group: 'Explorer',
    defaultBinding: 'F2',
    scope: 'explorer',
  },
  explorerContextMenu: {
    label: 'Open explorer item menu',
    group: 'Explorer',
    defaultBinding: 'Shift+F10',
    scope: 'explorer',
  },
  explorerContextMenuKey: {
    label: 'Open explorer item menu (alternate)',
    group: 'Explorer',
    defaultBinding: 'ContextMenu',
    scope: 'explorer',
  },
  formatIdeaBold: {
    label: 'Bold in idea editor',
    group: 'Ideas',
    defaultBinding: 'Primary+B',
    scope: 'ideas',
  },
  formatIdeaItalic: {
    label: 'Italic in idea editor',
    group: 'Ideas',
    defaultBinding: 'Primary+I',
    scope: 'ideas',
  },
} as const satisfies Record<string, ShortcutDefinition>

export type ShortcutAction = keyof typeof shortcuts
export type ShortcutBinding = string
export type ShortcutOverrides = Partial<Record<ShortcutAction, ShortcutBinding>>

const ACTIONS = Object.keys(shortcuts).filter(isShortcutAction)

export function isShortcutAction(value: unknown): value is ShortcutAction {
  return typeof value === 'string' && Object.hasOwn(shortcuts, value)
}

export function defaultBinding(action: ShortcutAction, _isMac?: boolean): ShortcutBinding {
  return shortcuts[action].defaultBinding
}

export function effectiveBinding(
  action: ShortcutAction,
  overrides: ShortcutOverrides,
  isMac?: boolean,
): ShortcutBinding {
  return overrides[action] ?? defaultBinding(action, isMac)
}

interface BuiltInShortcut {
  label: string
  group: string
  binding: ShortcutBinding
}

// These shortcuts follow Electron's native menu roles and the standard editing commands.
export function builtInShortcuts(platform: string): BuiltInShortcut[] {
  const isMac = platform === 'darwin'
  return [
    { label: 'Minimize window', group: 'Window', binding: 'Primary+M' },
    ...(isMac
      ? [
          { label: 'Hide Diffpane', group: 'Window', binding: 'Primary+H' },
          { label: 'Hide other apps', group: 'Window', binding: 'Primary+Alt+H' },
        ]
      : []),
    ...(platform === 'win32' ? [] : [{ label: 'Quit Diffpane', group: 'Window', binding: 'Primary+Q' }]),
    { label: 'Undo', group: 'Editing', binding: 'Primary+Z' },
    {
      label: 'Redo',
      group: 'Editing',
      binding: platform === 'win32' ? 'Primary+Y' : 'Primary+Shift+Z',
    },
    { label: 'Cut', group: 'Editing', binding: 'Primary+X' },
    { label: 'Copy', group: 'Editing', binding: 'Primary+C' },
    { label: 'Paste', group: 'Editing', binding: 'Primary+V' },
    { label: 'Select all', group: 'Editing', binding: 'Primary+A' },
    { label: 'Zoom in', group: 'View', binding: 'Primary+Plus' },
    { label: 'Zoom out', group: 'View', binding: 'Primary+-' },
    { label: 'Actual size', group: 'View', binding: 'Primary+0' },
    { label: 'Toggle full screen', group: 'View', binding: isMac ? 'Primary+Control+F' : 'F11' },
  ]
}

export function shortcutConflict(
  action: ShortcutAction,
  binding: ShortcutBinding,
  overrides: ShortcutOverrides,
  platform: string,
): string | null {
  const isMac = platform === 'darwin'
  const normalized = normalizeBinding(binding, isMac)
  if (!normalized) return null
  // When both commands use their shared default, the idea editor takes precedence.
  const sharedDefault = normalized === 'Primary+B' ? sharedExplorerDefault[action] : undefined
  const conflict = ACTIONS.find(
    other =>
      other !== action &&
      other !== sharedDefault &&
      normalizeBinding(effectiveBinding(other, overrides), isMac) === normalized,
  )
  if (conflict) return shortcuts[conflict].label
  return builtInShortcuts(platform).find(other => other.binding === normalized)?.label ?? null
}

const sharedExplorerDefault: Partial<Record<ShortcutAction, ShortcutAction>> = {
  formatIdeaBold: 'toggleExplorer',
  toggleExplorer: 'formatIdeaBold',
}

const modifiers = ['Primary', 'Control', 'Meta', 'Alt', 'Shift'] as const
type Modifier = (typeof modifiers)[number]

const modifierNames = new Map(modifiers.map(modifier => [modifier.toLowerCase(), modifier]))
const namedKeys = [
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'ContextMenu',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'Insert',
  'PageDown',
  'PageUp',
  'Plus',
  'Space',
  'Tab',
]
const keyNames = new Map(namedKeys.map(key => [key.toLowerCase(), key]))
const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/
const punctuationByCode = new Map([
  ['Backquote', '`'],
  ['Backslash', '\\'],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Comma', ','],
  ['Equal', '='],
  ['Minus', '-'],
  ['Period', '.'],
  ['Quote', "'"],
  ['Semicolon', ';'],
  ['Slash', '/'],
])
const punctuation = new Set(punctuationByCode.values())

export function normalizeBinding(value: unknown, isMac: boolean): ShortcutBinding | null {
  if (typeof value !== 'string' || value.length > 80) return null
  const tokens = value.split('+')
  const rawKey = tokens.pop()?.trim() ?? ''
  const upper = rawKey.toUpperCase()
  const key =
    /^[A-Z0-9]$/.test(upper) || functionKey.test(upper)
      ? upper
      : (keyNames.get(rawKey.toLowerCase()) ?? (punctuation.has(rawKey) ? rawKey : undefined))
  if (!key) return null

  const pressed = new Set<Modifier>()
  for (const token of tokens) {
    let modifier = modifierNames.get(token.trim().toLowerCase())
    if (modifier === (isMac ? 'Meta' : 'Control')) modifier = 'Primary'
    if (!modifier || pressed.has(modifier)) return null
    pressed.add(modifier)
  }
  // Avoid taking over ordinary typing and keyboard navigation.
  if (!functionKey.test(key) && key !== 'ContextMenu' && ![...pressed].some(modifier => modifier !== 'Shift'))
    return null

  // Electron's Plus accelerator includes Shift on the Equals key.
  const plus = key === 'Plus' || (key === '=' && pressed.has('Shift'))
  if (plus) pressed.delete('Shift')
  return [...modifiers.filter(modifier => pressed.has(modifier)), plus ? 'Plus' : key].join('+')
}

type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
  Partial<Pick<KeyboardEvent, 'code' | 'isComposing' | 'getModifierState'>>

export function bindingFromEvent(event: ShortcutKeyEvent, isMac: boolean): ShortcutBinding | null {
  if (event.isComposing || event.getModifierState?.('AltGraph')) return null
  let key = event.key
  if (key === ' ') key = 'Space'
  else if (key === '+') key = 'Plus'
  else if (event.code && !/^[a-z]$/i.test(key)) {
    // Use the base key when Shift or Option changes the produced character.
    if (event.shiftKey || event.altKey) {
      if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3)
      else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5)
      else key = punctuationByCode.get(event.code) ?? key
    }
  }
  const tokens = []
  if (event.metaKey) tokens.push('Meta')
  if (event.ctrlKey) tokens.push('Control')
  if (event.altKey) tokens.push('Alt')
  if (event.shiftKey) tokens.push('Shift')
  return normalizeBinding([...tokens, key].join('+'), isMac)
}

export function matchesBinding(event: ShortcutKeyEvent, binding: ShortcutBinding, isMac: boolean) {
  return bindingFromEvent(event, isMac) === binding
}

const keyLabels = new Map([
  ['ArrowDown', '↓'],
  ['ArrowLeft', '←'],
  ['ArrowRight', '→'],
  ['ArrowUp', '↑'],
  ['ContextMenu', 'Menu'],
  ['Escape', 'Esc'],
  ['PageDown', 'Page Down'],
  ['PageUp', 'Page Up'],
  ['Plus', '+'],
])

export function bindingKeys(binding: ShortcutBinding, isMac: boolean): string[] {
  const labels = new Map([
    ['Primary', isMac ? '⌘' : 'Ctrl'],
    ['Control', isMac ? '⌃' : 'Ctrl'],
    ['Meta', isMac ? '⌘' : 'Super'],
    ['Alt', isMac ? '⌥' : 'Alt'],
    ['Shift', isMac ? '⇧' : 'Shift'],
  ])
  return binding.split('+').map(key => labels.get(key) ?? keyLabels.get(key) ?? key)
}

export function ariaBinding(binding: ShortcutBinding, isMac: boolean): string {
  return binding
    .split('+')
    .map(key => (key === 'Primary' ? (isMac ? 'Meta' : 'Control') : key))
    .join('+')
}

const electronKeys = new Map([
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['ArrowUp', 'Up'],
  ['Primary', 'CmdOrCtrl'],
])

export function electronAccelerator(binding: ShortcutBinding, isMac: boolean): string | null {
  const normalized = normalizeBinding(binding, isMac)
  if (!normalized || normalized.endsWith('ContextMenu')) return null
  return normalized
    .split('+')
    .map(key => electronKeys.get(key) ?? key)
    .join('+')
}

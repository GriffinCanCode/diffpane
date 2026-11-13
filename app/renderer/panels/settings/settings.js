import {
  ariaBinding,
  bindingFromEvent,
  bindingKeys,
  builtInShortcuts,
  defaultBinding,
  effectiveBinding,
  electronAccelerator,
  isShortcutAction,
  shortcutConflict,
  shortcuts,
} from '../../../shared/preferences/shortcuts.ts'
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'

import './settings.css'

/** @typedef {import('../../../shared/preferences/shortcuts.ts').ShortcutAction} ShortcutAction */
/** @typedef {import('../../../shared/preferences/shortcuts.ts').ShortcutBinding} ShortcutBinding */
/** @typedef {import('../../../shared/preferences/shortcuts.ts').ShortcutOverrides} ShortcutOverrides */
/**
 * @typedef {{
 *   appearance: ReturnType<typeof import('../appearance/appearance.ts').createAppearanceSettings>,
 *   platform: string,
 *   getBindings: () => ShortcutOverrides,
 *   setBinding: (action: ShortcutAction, binding: ShortcutBinding | null) => Promise<ShortcutOverrides>,
 *   resetBindings: () => Promise<ShortcutOverrides>,
 *   setCapturing: (active: boolean) => Promise<void>,
 * }} SettingsOptions
 */
/**
 * @typedef {{
 *   current: HTMLTableCellElement,
 *   change: HTMLButtonElement,
 *   reset: HTMLButtonElement,
 *   binding: ShortcutBinding,
 * }} ShortcutRow
 */

const KEY_NAMES = new Map([
  ['ArrowDown', 'Down Arrow'],
  ['ArrowLeft', 'Left Arrow'],
  ['ArrowRight', 'Right Arrow'],
  ['ArrowUp', 'Up Arrow'],
  ['ContextMenu', 'Menu'],
  ['PageDown', 'Page Down'],
  ['PageUp', 'Page Up'],
  [',', 'Comma'],
  ['-', 'Minus'],
  ['.', 'Period'],
  ['/', 'Slash'],
  ['=', 'Equals'],
])

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {string} className
 * @param {string} [text]
 */
function node(tag, className, text = '') {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

/**
 * @param {string} className
 * @param {string} text
 * @param {string} label
 */
function createButton(className, text, label) {
  const element = node('button', className, text)
  element.type = 'button'
  if (label) element.setAttribute('aria-label', label)
  return element
}

/** @param {SettingsOptions} options */
export function createSettings({ appearance, platform, getBindings, setBinding, resetBindings, setCapturing }) {
  const isMac = platform === 'darwin'
  const dialog = node('dialog', 'appearance-dialog')
  dialog.id = 'app-settings'
  dialog.setAttribute('aria-labelledby', 'app-settings-title')
  dialog.innerHTML = `
    <div class="appearance-shell">
      <aside class="appearance-sidebar">
        <span id="app-settings-title" class="appearance-sidebar-heading">Settings</span>
        <nav aria-label="Settings">
          <button type="button" data-page="appearance" aria-controls="settings-appearance" aria-current="page">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="6.6"/><path d="M10 3.4a6.6 6.6 0 0 1 0 13.2Z" fill="currentColor" stroke="none"/></svg>
            Appearance
          </button>
          <button type="button" data-page="shortcuts" aria-controls="settings-shortcuts">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M6 8h.1m3.9 0h.1m3.9 0h.1M6 11h.1m2.9 0h5"/></svg>
            Keyboard shortcuts
          </button>
        </nav>
      </aside>
      <button type="button" class="settings-close" aria-label="Close Settings" autofocus>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
      <section class="settings-page" id="settings-shortcuts" aria-labelledby="settings-shortcuts-title" hidden>
        <header class="appearance-header">
          <div>
            <h2 id="settings-shortcuts-title">Keyboard shortcuts</h2>
            <p>Choose Change, then press a new key combination.</p>
          </div>
        </header>
        <div class="settings-list" role="region" aria-label="Shortcut list" tabindex="0">
          <table aria-labelledby="settings-shortcuts-title">
            <colgroup><col><col class="settings-binding-column"><col class="settings-binding-column"><col class="settings-actions-column"></colgroup>
            <thead><tr><th scope="col">Command</th><th scope="col">Current</th><th scope="col">Default</th><th scope="col"><span class="settings-visually-hidden">Actions</span></th></tr></thead>
          </table>
        </div>
        <footer class="settings-footer">
          <p id="settings-status" class="settings-status" role="status" aria-atomic="true"></p>
          <button type="button" class="settings-button settings-cancel" hidden>Cancel</button>
          <button type="button" class="settings-button settings-reset-all">Reset all</button>
        </footer>
      </section>
    </div>`

  const shortcutsPage = requireElement(dialog, '#settings-shortcuts', HTMLElement)
  const pageButtons = [...dialog.querySelectorAll('button')].filter(button => button.dataset.page)
  shortcutsPage.before(appearance.page)
  const table = requireElement(dialog, 'table', HTMLTableElement)
  const list = requireElement(dialog, '.settings-list', HTMLDivElement)
  const status = requireElement(dialog, '.settings-status', HTMLParagraphElement)
  const closeButton = requireElement(dialog, '.settings-close', HTMLButtonElement)
  const cancelButton = requireElement(dialog, '.settings-cancel', HTMLButtonElement)
  const resetAllButton = requireElement(dialog, '.settings-reset-all', HTMLButtonElement)
  /** @type {Map<string, HTMLTableSectionElement>} */
  const groups = new Map()
  /** @type {Map<ShortcutAction, ShortcutRow>} */
  const rows = new Map()
  /** @type {ShortcutAction | null} */
  let recording = null
  let pending = false
  let captureReady = false
  /** @type {Promise<unknown>} */
  let captureUpdate = Promise.resolve()
  let openVersion = 0

  /** @param {ShortcutBinding} binding */
  function keyNamesFor(binding) {
    return ariaBinding(binding, isMac)
      .split('+')
      .map(key => {
        if (key === 'Meta') return isMac ? 'Command' : 'Super'
        if (key === 'Alt' && isMac) return 'Option'
        return KEY_NAMES.get(key) ?? key
      })
  }

  /**
   * @param {HTMLTableCellElement} cell
   * @param {ShortcutBinding} binding
   */
  function showBinding(cell, binding) {
    if (cell.dataset.binding === binding) return
    cell.dataset.binding = binding
    const keys = node('span', 'settings-keys')
    const labels = bindingKeys(binding, isMac)
    const spoken = keyNamesFor(binding)
    keys.setAttribute('aria-hidden', 'true')
    for (const [index, label] of labels.entries()) {
      const key = node('kbd', '', label)
      key.title = spoken[index] ?? label
      keys.append(key)
    }
    cell.replaceChildren(keys, node('span', 'settings-visually-hidden', spoken.join(' plus ')))
  }

  /** @param {{ action?: ShortcutAction, label: string, group: string, binding: ShortcutBinding }} definition */
  function addRow({ action, label, group, binding }) {
    let section = groups.get(group)
    if (!section) {
      section = table.createTBody()
      const heading = node('th', 'settings-group', group)
      heading.scope = 'rowgroup'
      heading.colSpan = 4
      section.insertRow().append(heading)
      groups.set(group, section)
    }

    const row = section.insertRow()
    const command = node('th', 'settings-command', label)
    command.scope = 'row'
    const current = node('td', 'settings-current')
    const defaults = node('td', 'settings-default')
    const actions = node('td', 'settings-actions')
    row.append(command, current, defaults, actions)
    showBinding(current, binding)
    showBinding(defaults, binding)

    if (!action) {
      actions.textContent = 'Built-in'
      return
    }

    const change = createButton('settings-button settings-change', 'Change', `Change ${label} shortcut`)
    const reset = createButton('settings-button settings-reset', 'Reset', `Reset ${label} shortcut`)
    change.addEventListener('click', () => record(action))
    reset.addEventListener('click', () => {
      if (pending) return
      stopRecording()
      runTask('Reset shortcut', () => update(() => setBinding(action, null), `${label} shortcut reset.`))
    })
    actions.append(reset, change)
    rows.set(action, { current, change, reset, binding })
  }

  for (const [action, definition] of Object.entries(shortcuts)) {
    if (!isShortcutAction(action)) continue
    addRow({ action, ...definition, binding: defaultBinding(action, isMac) })
  }
  for (const definition of builtInShortcuts(platform)) addRow(definition)
  document.body.append(dialog)

  function refresh() {
    const bindings = getBindings()
    let modified = false
    for (const [action, row] of rows) {
      const current = effectiveBinding(action, bindings, isMac)
      const customized = current !== row.binding
      const active = action === recording
      modified ||= customized
      showBinding(row.current, current)
      row.current.classList.toggle('settings-customized', customized)
      const label = active ? 'Recording…' : 'Change'
      if (row.change.textContent !== label) row.change.textContent = label
      row.change.setAttribute('aria-pressed', String(active))
      row.change.setAttribute('aria-disabled', String(!captureReady || pending))
      if (active) row.change.setAttribute('aria-describedby', status.id)
      else row.change.removeAttribute('aria-describedby')
      row.reset.setAttribute('aria-disabled', String(pending))
      if (!customized && document.activeElement === row.reset) row.change.focus()
      row.reset.hidden = !customized
    }
    cancelButton.hidden = !recording
    cancelButton.setAttribute('aria-disabled', String(pending))
    resetAllButton.setAttribute('aria-disabled', String(pending || !modified))
    resetAllButton.hidden = Boolean(recording)
  }

  /** @param {string} [message] @param {'info' | 'success' | 'error'} [tone] */
  function showStatus(message = '', tone = 'info') {
    status.dataset.tone = tone
    status.textContent = message
  }

  /** @param {ShortcutAction} action */
  function record(action) {
    if (!captureReady || pending) return
    const row = rows.get(action)
    if (!row) return
    if (recording === action) {
      stopRecording(true)
      showStatus()
      return
    }
    recording = action
    row.change.focus()
    showStatus(`Press a new shortcut for ${shortcuts[action].label}. Esc cancels.`)
    refresh()
  }

  function stopRecording(restoreFocus = false) {
    if (!recording) return
    if (restoreFocus) rows.get(recording)?.change.focus()
    recording = null
    refresh()
  }

  /**
   * @param {() => Promise<ShortcutOverrides>} apply
   * @param {string} message
   */
  async function update(apply, message) {
    if (pending) return
    const version = openVersion
    pending = true
    refresh()
    try {
      const result = await attemptAsync(apply, { operation: 'Save shortcut settings' })
      if (!result.ok) {
        reportError(result.error, { silent: true })
        if (version === openVersion) showStatus(result.error.message, 'error')
      } else if (version === openVersion) {
        stopRecording()
        showStatus(message, 'success')
      }
    } finally {
      pending = false
      refresh()
    }
  }

  /** @param {boolean} active */
  function changeCapture(active) {
    const nextCapture = captureUpdate.then(() =>
      attemptAsync(() => setCapturing(active), {
        operation: active ? 'Enable shortcut recording' : 'Disable shortcut recording',
      }),
    )
    captureUpdate = nextCapture
    return nextCapture
  }

  /** @param {boolean} active */
  async function syncCapture(active) {
    const version = ++openVersion
    captureReady = false
    refresh()
    const result = await changeCapture(active)
    if (!result.ok) {
      const current = version === openVersion
      reportError(result.error, {
        silent: !current || active,
        retry: async () => {
          if (dialog.open && !shortcutsPage.hidden) return
          const retried = await changeCapture(false)
          if (!retried.ok) throw retried.error
        },
      })
      if (current && active) showStatus(result.error.message, 'error')
    } else if (version === openVersion && active) {
      captureReady = true
      refresh()
    }
  }

  /** @param {'appearance' | 'shortcuts'} page */
  function showPage(page) {
    const showShortcuts = page === 'shortcuts'
    if (showShortcuts === !shortcutsPage.hidden) return
    stopRecording()
    showStatus()
    shortcutsPage.hidden = !showShortcuts
    appearance.page.hidden = showShortcuts
    for (const button of pageButtons) {
      if (button.dataset.page === page) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
    if (showShortcuts) list.scrollTop = 0
    runTask('Change shortcut capture', () => syncCapture(showShortcuts))
  }

  function open() {
    if (dialog.open || document.querySelector('dialog[open]')) return
    showStatus()
    refresh()
    dialog.showModal()
    list.scrollTop = 0
    if (!shortcutsPage.hidden) runTask('Start shortcut capture', () => syncCapture(true))
  }

  function close() {
    if (!dialog.open) return
    stopRecording()
    dialog.close()
    runTask('Stop shortcut capture', () => syncCapture(false))
  }

  function cancelRecording() {
    if (pending) return
    stopRecording(true)
    showStatus()
  }

  closeButton.addEventListener('click', close)
  appearance.done.addEventListener('click', close)
  for (const button of pageButtons)
    button.addEventListener('click', () => {
      const page = button.dataset.page
      if (page === 'appearance' || page === 'shortcuts') showPage(page)
    })
  cancelButton.addEventListener('click', cancelRecording)
  resetAllButton.addEventListener('click', () => {
    if (resetAllButton.getAttribute('aria-disabled') === 'false')
      runTask('Reset all shortcuts', () => update(resetBindings, 'Default shortcuts restored.'))
  })
  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    if (recording) cancelRecording()
    else close()
  })
  dialog.addEventListener('focusin', event => {
    if (recording && event.target !== rows.get(recording)?.change && event.target !== cancelButton) {
      stopRecording()
      showStatus()
    }
  })
  dialog.addEventListener('keydown', event => {
    if (!recording || event.target !== rows.get(recording)?.change || event.isComposing) return
    const modified = event.metaKey || event.ctrlKey || event.altKey
    if (!modified && event.key === 'Tab') return
    event.preventDefault()
    event.stopPropagation()
    if (!modified && !event.shiftKey && event.key === 'Escape') {
      cancelRecording()
      return
    }
    if (pending || event.repeat || ['Meta', 'Control', 'Alt', 'AltGraph', 'Shift'].includes(event.key)) return
    const binding = bindingFromEvent(event, isMac)
    if (!binding) {
      showStatus('Use Command, Control, or Alt with a key, or press a function key.', 'error')
      return
    }
    const action = recording
    if (shortcuts[action].scope === 'native' && !electronAccelerator(binding, isMac)) {
      showStatus('Choose a different key combination for this menu command.', 'error')
      return
    }
    const conflict = shortcutConflict(action, binding, getBindings(), platform)
    if (conflict) {
      showStatus(`${keyNamesFor(binding).join(' + ')} is already used by ${conflict}.`, 'error')
      return
    }
    runTask('Save shortcut', () =>
      update(() => setBinding(action, binding), `${shortcuts[action].label} shortcut saved.`),
    )
  })

  return {
    open,
    refresh,
    get isOpen() {
      return dialog.open
    },
  }
}

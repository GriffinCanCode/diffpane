import { FitAddon } from '@xterm/addon-fit'
import type { ITheme } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ColorScheme } from '../../../shared/appearance/palette.ts'
import { colorHex } from '../../../shared/appearance/palette.ts'
import type { TerminalBridge } from '../../../shared/terminal/protocol.ts'
import {
  terminalMaximumColumns,
  terminalMaximumInputBytes,
  terminalMaximumRows,
  terminalMinimumColumns,
  terminalMinimumRows,
} from '../../../shared/terminal/protocol.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { terminalPasteText } from './clipboard.ts'
import './terminal.css'

declare global {
  interface Window {
    diffpaneTerminal?: TerminalBridge
  }
}

const viewport = requireElement(document, '#terminal-viewport', HTMLElement)
const status = requireElement(document, '#terminal-status', HTMLElement)
const startButton = requireElement(document, '#terminal-start', HTMLButtonElement)
const stopButton = requireElement(document, '#terminal-stop', HTMLButtonElement)
const hideButton = requireElement(document, '#terminal-hide', HTMLButtonElement)
const pasteDialog = requireElement(document, '#terminal-paste-dialog', HTMLDialogElement)
const cancelPaste = requireElement(document, '#terminal-paste-cancel', HTMLButtonElement)
const confirmPaste = requireElement(document, '#terminal-paste-confirm', HTMLButtonElement)
const trustedInputEvents = new Set([
  'keydown',
  'keypress',
  'keyup',
  'input',
  'mousedown',
  'mouseup',
  'mousemove',
  'wheel',
])
const maximumPasteLength = 256 * 1024
const inputChunkLength = terminalMaximumInputBytes / 4
const themePreference = matchMedia('(prefers-color-scheme: light)')

function xtermTheme(scheme: ColorScheme): ITheme {
  return {
    background: colorHex(scheme, 'surfaceInset'),
    foreground: colorHex(scheme, 'text'),
    cursor: colorHex(scheme, 'text'),
    cursorAccent: colorHex(scheme, 'surfaceInset'),
    selectionBackground: colorHex(scheme, 'selection'),
    selectionInactiveBackground: colorHex(scheme, 'selectionInactive'),
  }
}

function setStatus(message: string) {
  status.textContent = message
  status.title = message
}

function mount(bridge: TerminalBridge) {
  let scheme: ColorScheme = themePreference.matches ? 'light' : 'dark'
  let explicitTheme = false
  let active = false
  let transitioning = false
  let receivedExit = false
  let pendingWrites = 0
  let resizeFrame: number | undefined
  let pendingPaste = ''
  let sendingPaste = false
  let compositionInput = false
  let compositionTimer: number | undefined
  let view = createTerminal()

  function syncControls() {
    startButton.hidden = active
    startButton.disabled = active || transitioning || pendingWrites > 0
    stopButton.hidden = !active
    stopButton.disabled = transitioning
  }

  function applyTheme(nextTheme: ColorScheme) {
    scheme = nextTheme
    document.documentElement.dataset.theme = scheme
    view.terminal.options.theme = xtermTheme(scheme)
  }

  function writeInput(input: string) {
    // xterm also emits automatic responses to shell output on its input event.
    // Only forward user input. Chromium provides the current DOM event during dispatch.
    const event = window.event
    const trustedInput = event?.isTrusted && trustedInputEvents.has(event.type)
    // IME commits sometimes arrive after the composition event returns.
    const compositionText =
      compositionInput &&
      Array.from(input).every(character => {
        const code = character.charCodeAt(0)
        return code >= 32 && (code < 127 || code >= 160)
      })
    if (!active || transitioning || !(trustedInput || sendingPaste || compositionText)) return
    for (let offset = 0; offset < input.length;) {
      let end = Math.min(offset + inputChunkLength, input.length)
      const next = input.charCodeAt(end)
      if (next >= 0xdc00 && next <= 0xdfff) end--
      bridge.write(input.slice(offset, end))
      offset = end
    }
  }

  function createTerminal() {
    const terminal = new Terminal({
      cols: 80,
      rows: 12,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 13,
      scrollback: 3000,
      minimumContrastRatio: 4.5,
      disableStdin: true,
      cursorBlink: true,
      logLevel: 'off',
      theme: xtermTheme(scheme),
      windowOptions: {},
      linkHandler: { activate: () => {} },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(viewport)
    terminal.onData(writeInput)
    terminal.attachCustomKeyEventHandler(event => {
      if (!event.isTrusted) return false
      if (event.type === 'keydown' && event.shiftKey && event.key === 'F6') {
        event.preventDefault()
        if (active) stopButton.focus()
        else startButton.focus()
        return false
      }
      return true
    })
    if (terminal.textarea) terminal.textarea.setAttribute('aria-keyshortcuts', 'Shift+F6')
    return { terminal, fit }
  }

  function fitTerminal() {
    if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return
    const size = view.fit.proposeDimensions()
    if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return
    const cols = Math.min(terminalMaximumColumns, Math.max(terminalMinimumColumns, size.cols))
    const rows = Math.min(terminalMaximumRows, Math.max(terminalMinimumRows, size.rows))
    if (cols === view.terminal.cols && rows === view.terminal.rows) return
    view.terminal.resize(cols, rows)
    if (active && !transitioning) bridge.resize(cols, rows)
  }

  function closePasteDialog() {
    pendingPaste = ''
    if (pasteDialog.open) pasteDialog.close()
  }

  function sendPaste(text: string) {
    if (!active || transitioning || !text) return
    sendingPaste = true
    try {
      view.terminal.paste(text)
    } finally {
      sendingPaste = false
    }
  }

  async function start() {
    if (active || transitioning || pendingWrites > 0) return
    transitioning = true
    receivedExit = false
    syncControls()
    setStatus('Starting shell…')
    try {
      view.terminal.dispose()
      view = createTerminal()
      fitTerminal()
      const { cols, rows } = view.terminal
      const result = await bridge.start(cols, rows)
      if (receivedExit) return
      if (result.ok) {
        active = true
        view.terminal.options.disableStdin = false
        setStatus('Shell running')
        view.terminal.focus()
        if (cols !== view.terminal.cols || rows !== view.terminal.rows)
          bridge.resize(view.terminal.cols, view.terminal.rows)
      } else setStatus(result.message)
    } catch {
      if (!receivedExit) setStatus('Couldn’t start the shell.')
    } finally {
      transitioning = false
      syncControls()
      if (!active) startButton.focus()
    }
  }

  function finish(message: string) {
    const focused = document.activeElement
    const shouldMoveFocus =
      document.hasFocus() &&
      (focused === stopButton || focused === view.terminal.textarea || pasteDialog.contains(focused))
    active = false
    closePasteDialog()
    view.terminal.options.disableStdin = true
    setStatus(message)
    syncControls()
    if (shouldMoveFocus) (startButton.disabled ? hideButton : startButton).focus()
  }

  async function stop() {
    if (!active || transitioning) return
    transitioning = true
    syncControls()
    setStatus('Stopping shell…')
    try {
      await bridge.stop()
      if (active) finish('Shell stopped')
    } catch {
      if (active) setStatus('Couldn’t stop the shell.')
    } finally {
      transitioning = false
      syncControls()
      if (!active) startButton.focus()
    }
  }

  const observer = new ResizeObserver(() => {
    if (resizeFrame !== undefined) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = undefined
      fitTerminal()
    })
  })
  observer.observe(viewport)
  applyTheme(scheme)
  themePreference.addEventListener('change', ({ matches }) => {
    if (!explicitTheme) applyTheme(matches ? 'light' : 'dark')
  })
  bridge.onTheme?.(theme => {
    explicitTheme = true
    applyTheme(theme)
  })
  bridge.onData((data, bytes) => {
    pendingWrites++
    view.terminal.write(data, () => {
      bridge.acknowledge(bytes)
      pendingWrites--
      if (!active && pendingWrites === 0) syncControls()
    })
  })
  bridge.onExit((code, reason) => {
    receivedExit = true
    finish(reason ?? (code === null ? 'Shell stopped' : `Shell exited (${code})`))
  })
  startButton.addEventListener('click', event => {
    if (event.isTrusted) start().catch(() => setStatus('Couldn’t start the shell.'))
  })
  stopButton.addEventListener('click', event => {
    if (event.isTrusted) stop().catch(() => setStatus('Couldn’t stop the shell.'))
  })
  hideButton.addEventListener('click', event => {
    if (event.isTrusted) bridge.hide()
  })
  window.addEventListener('focus', () => {
    if (pasteDialog.open || !(document.activeElement === hideButton || document.activeElement === document.body)) return
    if (active) view.terminal.focus()
    else startButton.focus()
  })
  for (const type of ['compositionend', 'keydown']) {
    viewport.addEventListener(type, event => {
      if (!event.isTrusted || (event instanceof KeyboardEvent && event.keyCode !== 229)) return
      compositionInput = true
      // Queue after xterm's deferred composition commit, which is scheduled during the event.
      queueMicrotask(() => {
        clearTimeout(compositionTimer)
        compositionTimer = window.setTimeout(() => {
          compositionInput = false
        })
      })
    })
  }
  viewport.addEventListener(
    'paste',
    event => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.isTrusted || !active || transitioning || pasteDialog.open) return
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length > maximumPasteLength) {
        setStatus('Clipboard text is too large to paste.')
        return
      }
      const sanitized = terminalPasteText(text)
      if (sanitized.includes('\n') || sanitized.includes('\r')) {
        pendingPaste = sanitized
        pasteDialog.showModal()
      } else sendPaste(sanitized)
    },
    { capture: true },
  )
  for (const type of ['dragover', 'drop']) viewport.addEventListener(type, event => event.preventDefault())
  cancelPaste.addEventListener('click', event => {
    if (event.isTrusted) closePasteDialog()
  })
  confirmPaste.addEventListener('click', event => {
    if (!event.isTrusted) return
    const text = pendingPaste
    closePasteDialog()
    view.terminal.focus()
    sendPaste(text)
  })
  pasteDialog.addEventListener('cancel', event => {
    event.preventDefault()
    closePasteDialog()
  })
  hideButton.disabled = false
  setStatus('Open a shell in this workspace.')
  syncControls()
}

if (window.diffpaneTerminal) mount(window.diffpaneTerminal)
else status.textContent = 'Diffpane terminal connection unavailable.'

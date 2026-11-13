import { attemptAsync } from '../app-errors.ts'
import { requireElement } from './dom.js'
import { reportError, runTask } from './errors.ts'

interface Entry {
  path: string
  kind: string
  name: string
  file?: { submodule?: boolean } | null
}
type Action = 'open' | 'attach' | 'rename' | 'reveal' | 'copy-path' | 'copy-relative-path' | 'trash'
interface Api {
  fileAction: (action: 'reveal' | 'copy-path' | 'copy-relative-path', path: string) => Promise<void>
}
type Mutate = (action: string, path: string, name?: string) => Promise<void>

export function createFileActions(
  api: Api,
  mutate: Mutate,
  onError: (message: string) => void,
  onAttach?: (path: string) => void | Promise<void>,
) {
  const menu = document.createElement('div')
  menu.className = 'file-context-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'File actions')
  menu.hidden = true
  document.body.append(menu)
  const dialog = document.createElement('dialog')
  dialog.className = 'rename-dialog'
  dialog.setAttribute('aria-labelledby', 'rename-title')
  dialog.innerHTML =
    '<form><h2 id="rename-title">Rename</h2><label>New name<input name="name" aria-label="New name" autocomplete="off" spellcheck="false" required></label><p class="rename-error" role="alert"></p><div><button type="button" data-action="cancel">Cancel</button><button type="submit">Rename</button></div></form>'
  document.body.append(dialog)
  const input = requireElement(dialog, 'input', HTMLInputElement)
  const error = requireElement(dialog, '.rename-error', HTMLParagraphElement)
  const heading = requireElement(dialog, 'h2', HTMLHeadingElement)
  const form = requireElement(dialog, 'form', HTMLFormElement)
  const cancel = requireElement(dialog, '[data-action="cancel"]', HTMLButtonElement)
  const lifetime = new AbortController()
  let entry: Entry | undefined
  let returnFocus: HTMLElement | undefined
  let busy = false
  function close(focus = false) {
    menu.hidden = true
    if (focus) returnFocus?.focus()
  }
  function rename(node: Entry) {
    entry = node
    close()
    error.textContent = ''
    input.value = node.name
    heading.textContent = node.kind === 'directory' ? 'Rename folder' : 'Rename file'
    dialog.showModal()
    input.focus()
    const dot = node.kind === 'file' ? node.name.lastIndexOf('.') : -1
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length)
  }
  async function submitRename(path: string) {
    busy = true
    error.textContent = ''
    for (const button of dialog.querySelectorAll('button')) button.disabled = true
    input.disabled = true
    try {
      const result = await attemptAsync(() => mutate('rename', path, input.value), {
        operation: 'Rename file or folder',
      })
      if (lifetime.signal.aborted) return
      if (result.ok) dialog.close()
      else {
        reportError(result.error, { silent: true })
        error.textContent = result.error.message
      }
    } finally {
      busy = false
      input.disabled = false
      for (const button of dialog.querySelectorAll('button')) button.disabled = false
      if (dialog.open && !lifetime.signal.aborted) {
        input.focus()
        input.select()
      }
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (busy || !entry) return
    const { path } = entry
    runTask('Rename file or folder', () => submitRename(path))
  })
  cancel.addEventListener('click', () => dialog.close())
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault()
  })
  dialog.addEventListener('close', () => returnFocus?.focus())
  const pointer = (event: PointerEvent) => {
    if (!(event.target instanceof Node) || !menu.contains(event.target)) close()
  }
  document.addEventListener('pointerdown', pointer, { signal: lifetime.signal })
  const blur = () => close()
  window.addEventListener('blur', blur, { signal: lifetime.signal })
  menu.addEventListener('keydown', event => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.findIndex(button => button === document.activeElement)
    if (event.key === 'Escape' || event.key === 'Tab') {
      close(true)
      if (event.key === 'Escape') event.preventDefault()
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  })
  return {
    rename,
    show(node: Entry, x: number, y: number, focus: HTMLElement) {
      returnFocus = focus
      menu.replaceChildren()
      const actions: [Action, string][] = [
        ['open', node.kind === 'directory' ? 'Expand folder' : 'Open file'],
        ['rename', 'Rename…'],
        ['reveal', 'Reveal in Finder'],
        ['copy-path', 'Copy path'],
        ['copy-relative-path', 'Copy relative path'],
        ['trash', 'Move to Trash'],
      ]
      if (onAttach && node.kind === 'file') actions.splice(1, 0, ['attach', 'Attach to an idea'])
      for (const [action, label] of actions) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        button.setAttribute('role', 'menuitem')
        button.dataset.action = action
        button.disabled = Boolean(node.file?.submodule && ['rename', 'trash'].includes(action))
        button.addEventListener('click', () =>
          runTask(label, async () => {
            close(true)
            const result = await attemptAsync(
              () => {
                if (action === 'rename') return rename(node)
                if (action === 'attach') return onAttach?.(node.path)
                if (action === 'trash' || action === 'open') return mutate(action, node.path)
                return api.fileAction(action, node.path)
              },
              { operation: label },
            )
            if (!result.ok && !lifetime.signal.aborted) {
              reportError(result.error, { silent: true })
              onError(result.error.message)
            }
          }),
        )
        menu.append(button)
      }
      menu.hidden = false
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`
      menu.querySelector('button')?.focus()
    },
    dispose() {
      lifetime.abort()
      dialog.close()
      menu.remove()
      dialog.remove()
    },
  }
}

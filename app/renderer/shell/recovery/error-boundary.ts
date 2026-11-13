import { appError } from '../../../shared/recovery/app-errors.ts'
import { rendererDiagnostics } from '../diagnostics/diagnostics.ts'
import './error-boundary.css'

type RecoveryAction = () => void | Promise<void>
type Scope = 'app' | 'panel' | 'notice'

export interface ErrorBoundaryOptions {
  scope?: Scope
  title?: string
  message: string
  detail?: string
  operation?: string
  retry?: RecoveryAction
  retryLabel?: string
  copy?: RecoveryAction
  reload?: RecoveryAction
  reloadLabel?: string
  dismiss?: boolean
  focus?: boolean
  onRemove?: () => void
}

const DEFAULT_TITLE: Record<Scope, string> = {
  app: 'Diffpane hit a snag',
  panel: 'This view couldn’t load',
  notice: 'Something went wrong',
}

let nextId = 0

function element<K extends keyof HTMLElementTagNameMap>(owner: Document, tag: K, className: string, value?: string) {
  const node = owner.createElement(tag)
  node.className = className
  if (value !== undefined) node.textContent = value
  return node
}

export function showErrorBoundary(container: HTMLElement, options: ErrorBoundaryOptions) {
  const { ownerDocument: owner } = container
  const scope = options.scope ?? 'panel'
  const modal = scope === 'app' ? owner.createElement('dialog') : null
  const boundary = modal ?? owner.createElement('section')
  const previous = container.querySelector(':scope > .error-boundary')
  const previousFocus = owner.activeElement
  const id = `error-boundary-${++nextId}`
  const moveFocus = options.focus ?? (scope === 'app' || Boolean(previous?.contains(previousFocus)))

  boundary.className = `error-boundary error-boundary--${scope}`
  boundary.setAttribute('aria-labelledby', `${id}-title`)
  boundary.setAttribute('aria-describedby', `${id}-message`)

  const card = element(owner, 'div', 'error-boundary__card')
  const illustration = element(owner, 'div', 'error-boundary__illustration')
  illustration.setAttribute('aria-hidden', 'true')
  const sprite = element(owner, 'span', 'window-mascot error-boundary__sprite')
  sprite.append(element(owner, 'span', 'window-mascot__face'))
  illustration.append(sprite)

  const content = element(owner, 'div', 'error-boundary__content')
  const summary = element(owner, 'div', 'error-boundary__summary')
  if (!modal && !moveFocus) summary.setAttribute('role', 'alert')
  const heading = element(
    owner,
    scope === 'app' ? 'h1' : 'h2',
    'error-boundary__title',
    options.title ?? DEFAULT_TITLE[scope],
  )
  heading.id = `${id}-title`
  heading.tabIndex = -1
  if (moveFocus) heading.setAttribute('aria-describedby', `${id}-message`)
  if (modal && moveFocus) heading.setAttribute('autofocus', '')
  const message = element(owner, 'p', 'error-boundary__message', options.message)
  message.id = `${id}-message`
  summary.append(heading, message)
  content.append(summary)

  const actions = element(owner, 'div', 'error-boundary__actions')
  const feedback = element(owner, 'p', 'error-boundary__feedback')
  feedback.setAttribute('role', 'alert')
  const buttons: HTMLButtonElement[] = []
  let running = false

  function remove() {
    const restoreFocus = !modal && boundary.contains(owner.activeElement)
    modal?.close()
    boundary.remove()
    if (restoreFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true })
    options.onRemove?.()
  }

  function addAction(
    operation: string,
    label: string,
    pending: string,
    action: RecoveryAction,
    removeOnSuccess: boolean,
    success = '',
  ) {
    const button = element(owner, 'button', 'error-boundary__action', label)
    button.type = 'button'
    async function recover() {
      if (running) return
      running = true
      feedback.textContent = ''
      button.textContent = pending
      for (const control of buttons) control.setAttribute('aria-disabled', 'true')
      try {
        await rendererDiagnostics.run(operation, action)
        if (boundary.parentElement === container) {
          if (removeOnSuccess) remove()
          else feedback.textContent = success
        }
      } catch (cause) {
        if (boundary.parentElement === container) {
          feedback.textContent = appError(cause, {
            message: 'This recovery action couldn’t finish. Try again.',
          }).message
        }
      } finally {
        running = false
        button.textContent = label
        for (const control of buttons) control.removeAttribute('aria-disabled')
      }
    }
    button.addEventListener('click', () => {
      recover().catch((cause: unknown) => rendererDiagnostics.error('renderer.recovery-action-failure', cause))
    })
    buttons.push(button)
    actions.append(button)
  }

  if (options.retry)
    addAction('renderer.recovery-retry', options.retryLabel ?? 'Try again', 'Retrying…', options.retry, true)
  if (options.copy)
    addAction('renderer.recovery-copy', 'Copy unsaved text', 'Copying…', options.copy, false, 'Unsaved text copied.')
  if (options.reload)
    addAction('renderer.recovery-reload', options.reloadLabel ?? 'Reload Diffpane', 'Reloading…', options.reload, false)
  if (options.dismiss) {
    const dismiss = element(owner, 'button', 'error-boundary__action', 'Dismiss')
    dismiss.type = 'button'
    dismiss.addEventListener('click', () => {
      if (!running) remove()
    })
    buttons.push(dismiss)
    actions.append(dismiss)
  }
  if (options.retry || options.reload) buttons[0]?.classList.add('error-boundary__action--primary')
  if (buttons.length) content.append(actions, feedback)

  if (options.detail || options.operation) {
    const details = element(owner, 'details', 'error-boundary__details')
    details.append(element(owner, 'summary', 'error-boundary__details-toggle', 'Technical details'))
    if (options.operation) details.append(element(owner, 'p', 'error-boundary__operation', options.operation))
    if (options.detail) details.append(element(owner, 'pre', 'error-boundary__detail', options.detail))
    content.append(details)
  }

  card.append(illustration, content)
  if (modal) {
    const dragRegion = element(owner, 'div', 'error-boundary__drag-region')
    dragRegion.setAttribute('aria-hidden', 'true')
    modal.append(dragRegion)
    modal.addEventListener('cancel', event => {
      event.preventDefault()
    })
  }
  boundary.append(card)
  previous?.remove()
  container.append(boundary)
  if (modal) {
    if (modal.isConnected) modal.showModal()
    else modal.open = true
  }
  if (moveFocus) heading.focus({ preventScroll: true })
  return boundary
}

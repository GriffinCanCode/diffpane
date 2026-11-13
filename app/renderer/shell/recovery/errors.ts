import { appError, attempt, attemptAsync } from '../../../shared/recovery/app-errors.ts'
import type { AppError, ErrorContext } from '../../../shared/recovery/app-errors.ts'
import { showErrorBoundary } from './error-boundary.ts'
import type { ErrorBoundaryOptions } from './error-boundary.ts'

interface ReportOptions extends ErrorContext {
  key?: string
  title?: string
  silent?: boolean
  retry?: ErrorBoundaryOptions['retry']
  retryLabel?: string
  copy?: ErrorBoundaryOptions['copy']
}

type BoundaryOptions = Omit<ErrorBoundaryOptions, 'operation' | 'onActionError' | 'message'> & { message?: string }

const NOTICES = new Map<
  string,
  { host: HTMLElement; boundary: HTMLElement; error: AppError; focusBefore: Element | null }
>()
let noticeHost: HTMLElement | undefined
let startupBoundary: HTMLElement | undefined

export function setErrorNoticeHost(host: HTMLElement): void {
  const previous = noticeHost
  noticeHost = host
  for (const notice of NOTICES.values()) host.append(notice.host)
  if (previous?.classList.contains('error-notice-overlay')) previous.remove()
}

export function clearErrorNotice(key: string): void {
  const notice = NOTICES.get(key)
  if (!notice) return
  const active = notice.host.ownerDocument.activeElement
  const restore = notice.host.contains(active)
  notice.host.remove()
  NOTICES.delete(key)
  const target = notice.focusBefore
  if (restore && target instanceof HTMLElement && target.isConnected && !target.closest('[hidden], [inert]'))
    target.focus({ preventScroll: true })
}

export function reportError(cause: unknown, options: ReportOptions = {}): AppError {
  const error = appError(cause, options)
  if (options.silent || typeof document === 'undefined') {
    console.error(error)
    return error
  }

  const key = options.key ?? error.operation ?? error.code
  const previous = NOTICES.get(key)
  if (previous?.boundary.isConnected && previous.error.code === error.code && previous.error.message === error.message)
    return error

  console.error(error)
  if (!noticeHost?.isConnected) {
    noticeHost = document.createElement('div')
    noticeHost.className = 'error-notice-overlay'
    document.body.append(noticeHost)
  }
  const host = previous?.host ?? noticeHost.appendChild(document.createElement('div'))
  const focusBefore = previous?.focusBefore ?? document.activeElement
  const clear = () => {
    if (NOTICES.get(key)?.boundary === boundary) clearErrorNotice(key)
  }
  const boundary = renderFailure(host, error, {
    scope: 'notice',
    title: options.title ?? 'Something went wrong',
    retryLabel: options.retryLabel,
    copy: options.copy,
    retry: options.retry,
    dismiss: true,
    onRemove: clear,
  })
  NOTICES.set(key, { host, boundary, error, focusBefore })
  return error
}

export function renderFailure(host: HTMLElement, error: AppError, options: BoundaryOptions): HTMLElement {
  return showErrorBoundary(host, {
    ...options,
    message: options.message ?? error.message,
    detail: options.detail ?? `Error code ${error.code}`,
    operation: error.operation,
    onActionError: cause => reportError(cause, { operation: error.operation, silent: true }),
  })
}

export function showStartupFailure(cause: unknown): void {
  if (startupBoundary?.isConnected) return
  const error = reportError(cause, {
    operation: 'Start Diffpane',
    message: 'Diffpane could not finish starting.',
    recoverable: false,
    silent: true,
  })
  const app = document.getElementById('app')
  if (app) app.inert = true
  const opener = document.getElementById('workspace-opening')
  if (opener) opener.hidden = true
  startupBoundary = renderFailure(document.body, error, {
    scope: 'app',
    title: 'Diffpane couldn’t start',
    reload: () => window.location.reload(),
    reloadLabel: 'Reload Diffpane',
    ...(error.code === 'DESKTOP_BRIDGE_UNAVAILABLE'
      ? {}
      : {
          detail: `${error.code}\n${error.message}`,
          message: 'Reload Diffpane to try opening this window again.',
        }),
  })
}

export function installErrorHandlers(): void {
  window.addEventListener('error', event => {
    if (!(event instanceof ErrorEvent)) return
    reportError(event.error ?? event.message, { key: 'uncaught', operation: 'Run Diffpane' })
  })
  window.addEventListener('unhandledrejection', event => {
    event.preventDefault()
    reportError(event.reason, { key: 'uncaught', operation: 'Run Diffpane' })
  })
}

export function guard<T extends unknown[]>(
  operation: string,
  run: (...args: T) => void,
  options: ReportOptions = {},
): (...args: T) => void {
  return (...args) => {
    const result = attempt(() => run(...args), { operation, ...options })
    if (!result.ok) reportError(result.error, options)
  }
}

export function runTask(operation: string, run: () => unknown, options: ReportOptions = {}): void {
  async function observe() {
    const result = await attemptAsync(run, { operation, ...options })
    if (!result.ok) reportError(result.error, options)
  }
  observe().catch((cause: unknown) => console.error('Could not report task failure', cause))
}

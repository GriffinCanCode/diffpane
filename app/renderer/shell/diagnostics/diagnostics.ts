import { createDiagnostics } from '../../../shared/diagnostics/diagnostics.ts'

export const rendererDiagnostics = createDiagnostics('renderer', event => {
  if (typeof window === 'undefined') return
  const bridge = window.diffpane
  if (bridge?.reportDiagnostic) bridge.reportDiagnostic(event)
  else if (event.level === 'error' || event.level === 'warn') console.error(event)
})

export function observeRendererResponsiveness() {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask'))
    return

  let count = 0
  let longest = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    clearTimeout(timer)
    timer = undefined
    if (!count) return
    rendererDiagnostics.metric('renderer.long-task-count', count, 'count')
    rendererDiagnostics.metric('renderer.long-task-max', longest, 'ms')
    count = longest = 0
  }

  function collect(entries: readonly PerformanceEntry[]) {
    for (const entry of entries) {
      count++
      longest = Math.max(longest, entry.duration)
    }
  }

  const observer = new PerformanceObserver(list => {
    collect(list.getEntries())
    if (count) timer ??= setTimeout(flush, 30_000)
  })
  try {
    observer.observe({ type: 'longtask', buffered: true })
  } catch (cause) {
    rendererDiagnostics.error('renderer.long-task-observer', cause)
    return
  }
  window.addEventListener(
    'pagehide',
    () => {
      collect(observer.takeRecords())
      observer.disconnect()
      flush()
    },
    { once: true },
  )
}

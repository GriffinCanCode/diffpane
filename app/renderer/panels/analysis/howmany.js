import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { isArray, isDiagnostic, isRecord } from '../../editor/languages/language-protocol.js'
import { afterPaint } from '../../shell/layout/after-paint.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'

import './howmany.css'

/**
 * @import { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
 * @import { AnalysisState, SourceCounts, HowManyEvent, HowManyFile } from '../../../electron/tools/analysis/howmany.mjs'
 */
/**
 * @typedef {{
 *   model: import('monaco-editor').editor.ITextModel | null,
 *   element: HTMLElement,
 *   file: { path: string },
 *   active?: boolean,
 *   howmanyVersion?: number | null,
 * }} HowManyCard
 */

/**
 * @param {unknown} report
 * @returns {Record<string, unknown>}
 */
function asReportData(report) {
  return isRecord(report) ? report : {}
}

/** @param {number} value */
function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'
}
/** @param {number} value @param {string} noun */
function count(value, noun) {
  return `${formatNumber(value)} ${noun}${value === 1 ? '' : 's'}`
}
/** @param {number} value */
function bytes(value) {
  return value < 1024
    ? `${formatNumber(value)} B`
    : value < 1024 * 1024
      ? `${formatNumber(value / 1024)} KB`
      : `${formatNumber(value / (1024 * 1024))} MB`
}
const CATEGORIES = /** @type {const} */ ([
  ['code_lines', 'Code'],
  ['doc_lines', 'Source documentation'],
  ['comment_lines', 'Comments'],
  ['blank_lines', 'Blank'],
])
const SCORES = /** @type {const} */ ([
  ['maintainability_score', 'Maintainability'],
  ['documentation_score', 'Documentation'],
  ['readability_score', 'Readability'],
  ['consistency_score', 'Consistency'],
])
/** @param {number} value */
function band(value) {
  return value >= 85 ? 'high' : value >= 70 ? 'good' : value >= 55 ? 'fair' : 'low'
}

/** @template {keyof HTMLElementTagNameMap} Tag @param {Tag} tag @param {string} className @param {string} [text] */
function node(tag, className, text) {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}
/** @param {string} label @param {string} value */
function row(label, value, className = '') {
  const element = node('div', `howmany-row ${className}`)
  element.append(node('span', '', label), node('span', 'howmany-value', value))
  return element
}
/** @param {string} title */
function section(title) {
  const element = node('section', 'howmany-section')
  element.append(node('h3', '', title))
  return element
}
/** @param {SourceCounts} basic */
function composition(basic) {
  const bar = node('div', 'howmany-composition')
  bar.setAttribute('aria-label', 'Line composition')
  for (const [key, label] of CATEGORIES) {
    const part = node('span', `howmany-${key}`)
    part.style.width = `${basic.total_lines ? (basic[key] / basic.total_lines) * 100 : 0}%`
    part.title = `${formatNumber(basic[key])} ${label.toLowerCase()} lines`
    bar.append(part)
  }
  return bar
}

/** @param {(typeof CATEGORIES)[number][0]} key @param {string} label @param {string} value */
function seriesRow(key, label, value) {
  const item = row(label, value)
  const name = requireElement(item, 'span', HTMLSpanElement)
  const marker = node('span', `howmany-series-key howmany-${key}`)
  marker.setAttribute('aria-hidden', 'true')
  name.classList.add('howmany-series-label')
  name.prepend(marker)
  return item
}

/**
 * @param {Pick<typeof import('monaco-editor'), 'editor' | 'MarkerSeverity'>} monaco
 * @param {Pick<DiffpaneApi, 'howmany'>} api
 * @param {HTMLElement} navigator
 * @param {HTMLElement} statusbar
 */
export function createHowMany(monaco, api, navigator, statusbar) {
  const runtime = api.howmany
  const panel = node('details', 'howmany-panel')
  panel.id = 'howmany-panel'
  panel.open = true
  panel.innerHTML =
    '<summary><span>HowMany</span><span class="howmany-summary"></span></summary><div class="howmany-body"></div><div class="howmany-actions"><button type="button" class="howmany-report-button">Full report</button><button type="button" class="howmany-refresh" aria-label="Refresh HowMany analysis" title="Refresh analysis">↻</button></div>'
  requireElement(navigator, '.navigator-footer', HTMLDivElement).before(panel)
  const summary = requireElement(panel, '.howmany-summary', HTMLSpanElement)
  const body = requireElement(panel, '.howmany-body', HTMLDivElement)
  const refresh = requireElement(panel, '.howmany-refresh', HTMLButtonElement)
  const status = node('button', 'howmany-status', 'HowMany')
  status.type = 'button'
  status.title = 'Open HowMany analysis'
  statusbar.prepend(status)
  const dialog = node('dialog', 'howmany-dialog')
  dialog.id = 'howmany-report'
  dialog.setAttribute('aria-labelledby', 'howmany-title')
  dialog.innerHTML = `
    <header>
      <div class="howmany-heading">
        <span class="howmany-chart-glyph" aria-hidden="true"><i></i><i></i><i></i></span>
        <div><h2 id="howmany-title">HowMany</h2><p>Workspace analysis</p></div>
      </div>
      <button type="button" class="howmany-close" aria-label="Close HowMany report">×</button>
    </header>
    <div class="howmany-report-content"></div>
    <footer>
      <span class="howmany-report-state" role="status"></span>
      <button type="button" class="howmany-export">Export JSON</button>
      <button type="button" class="howmany-report-refresh">Refresh</button>
    </footer>`
  document.body.append(dialog)
  const content = requireElement(dialog, '.howmany-report-content', HTMLDivElement)
  const reportState = requireElement(dialog, '.howmany-report-state', HTMLSpanElement)
  /** @type {AnalysisState} */
  let state = { status: 'idle', report: null, message: '', updatedAt: null }
  /** @type {HowManyCard | null} */
  let active = null
  /** @type {{ note?: string | null } | null} */
  let activeDocument = null
  let analysisEvents = 0
  /** @type {string | null} */
  let fileRequest = null
  let disposed = false
  let started = false
  /** @type {(() => void) | null} */
  let cancelAnalysis = null
  /** @type {(() => void) | null} */
  let cancelFile = null

  function renderReport() {
    const running = state.status === 'analyzing'
    dialog.toggleAttribute('data-analyzing', running)
    const report = state.report
    const reportData = asReportData(report)
    const source = report?.source
    const breakdown = report?.breakdown
    const metadata = reportData.metadata
    const version = isRecord(metadata) && typeof metadata.version === 'string' ? metadata.version : ''
    content.replaceChildren()
    requireElement(dialog, '.howmany-export', HTMLButtonElement).disabled = !(source && breakdown)
    requireElement(dialog, '.howmany-report-refresh', HTMLButtonElement).disabled = running
    reportState.toggleAttribute('data-loading-status', running)
    reportState.dataset.state = state.status
    reportState.textContent = running
      ? 'Analyzing…'
      : state.message ||
        (state.updatedAt
          ? `Updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · HowMany ${version}`
          : '')
    if (!source || !breakdown) {
      const message = node('p', 'howmany-empty', state.message || 'Counting files and analyzing code…')
      message.dataset.state = state.status
      content.append(message)
      return
    }
    const { ratios, complexity } = reportData
    const overview = section(count(source.code_lines, 'source code line'))
    overview.append(
      node(
        'p',
        'howmany-muted',
        `${count(source.file_count, 'source file')} · ${count(source.total_lines, 'physical line')} · ${bytes(source.total_size)} · ${formatNumber(source.file_count ? source.total_lines / source.file_count : 0)} lines per file`,
      ),
      composition(source),
    )
    for (const [key, label] of CATEGORIES)
      overview.append(
        seriesRow(
          key,
          label,
          `${formatNumber(source[key])} · ${source.total_lines ? ((source[key] / source.total_lines) * 100).toFixed(1) : '0'}%`,
        ),
      )
    content.append(overview)
    const quality = isRecord(ratios) && isRecord(ratios.quality_metrics) ? ratios.quality_metrics : undefined
    const overall = quality?.overall_quality_score
    if (quality && typeof overall === 'number' && Number.isFinite(overall) && source.file_count > 0) {
      const group = section(`Quality ${Math.round(overall)} / 100`)
      group.dataset.band = band(overall)
      for (const [key, label] of SCORES) {
        const score = quality[key]
        if (typeof score === 'number' && Number.isFinite(score)) group.append(row(label, `${Math.round(score)} / 100`))
      }
      content.append(group)
    }
    for (const [category, label] of /** @type {const} */ ([
      ['code', 'Languages'],
      ['config', 'Configuration'],
      ['data', 'Data'],
      ['docs', 'Standalone documentation'],
    ])) {
      const rows = breakdown.rows
        .filter(stats => stats.category === category)
        .toSorted((a, b) =>
          category === 'code'
            ? b.code_lines - a.code_lines || a.language.localeCompare(b.language)
            : b.total_lines - a.total_lines || a.language.localeCompare(b.language),
        )
      if (!rows.length) continue
      const group = section(label)
      for (const stats of rows) {
        const line = row(
          stats.language,
          `${category === 'code' ? `${formatNumber(stats.code_lines)} code` : count(stats.total_lines, 'line')} · ${count(stats.file_count, 'file')}`,
        )
        if (category === 'code')
          line.title = `${source.code_lines ? ((stats.code_lines / source.code_lines) * 100).toFixed(1) : 0}% of source code lines · ${count(stats.total_lines, 'physical line')}`
        group.append(line)
      }
      content.append(group)
    }
    // The CLI can return an entirely zeroed block when no structural parser ran.
    if (
      isRecord(complexity) &&
      ((typeof complexity.function_count === 'number' && complexity.function_count > 0) ||
        (typeof complexity.total_structures === 'number' && complexity.total_structures > 0))
    ) {
      const group = section('Structure & complexity')
      for (const [key, label] of /** @type {const} */ ([
        ['function_count', 'Functions'],
        ['total_structures', 'Structures'],
        ['cyclomatic_complexity', 'Average cyclomatic complexity'],
        ['cognitive_complexity', 'Average cognitive complexity'],
        ['average_function_length', 'Average function length'],
        ['max_nesting_depth', 'Maximum nesting depth'],
      ])) {
        const metric = complexity[key]
        if (typeof metric === 'number' && Number.isFinite(metric)) group.append(row(label, formatNumber(metric)))
      }
      content.append(group)
    }
  }

  /** @param {AnalysisState} next */
  function render(next) {
    if (disposed) return
    state = next
    body.replaceChildren()
    const { report, message } = state
    const source = report?.source
    const running = state.status === 'analyzing'
    const failed = state.status === 'error'
    panel.dataset.state = state.status
    status.dataset.state = state.status
    refresh.disabled = running
    panel.setAttribute('aria-busy', String(running))
    summary.toggleAttribute('data-loading-status', running)
    const countLabel = source ? `${formatNumber(source.code_lines)} code` : ''
    summary.textContent = running ? 'Analyzing…' : failed ? 'Analysis failed' : countLabel
    status.textContent = running ? 'HowMany…' : failed ? 'Analysis failed' : countLabel || 'HowMany'
    status.title = message || 'Open HowMany workspace analysis'
    if (source) {
      body.append(row(count(source.file_count, 'source file'), count(source.total_lines, 'line')), composition(source))
      for (const [key, label] of CATEGORIES)
        if (source[key]) body.append(seriesRow(key, label, formatNumber(source[key])))
      const ratios = asReportData(report).ratios
      const quality =
        isRecord(ratios) && isRecord(ratios.quality_metrics) ? ratios.quality_metrics.overall_quality_score : undefined
      if (typeof quality === 'number' && Number.isFinite(quality) && source.file_count > 0) {
        const score = row('Quality', `${Math.round(quality)} / 100`, 'howmany-quality')
        score.dataset.band = band(quality)
        body.append(score)
      }
    }
    if (message || !report) {
      const description = node('p', 'howmany-empty', message || 'Counting files…')
      description.dataset.state = state.status
      body.append(description)
    }
    if (dialog.open) renderReport()
  }

  async function analyze(force = false) {
    started = true
    cancelAnalysis?.()
    cancelAnalysis = null
    if (disposed) return
    const events = analysisEvents
    const result = await attemptAsync(() => runtime.analyze(force), { operation: 'Analyze workspace with HowMany' })
    if (disposed || events !== analysisEvents) return
    if (result.ok) render(result.value)
    else {
      reportError(result.error, { silent: true })
      render({ ...state, status: 'error', message: result.error.message })
    }
  }
  function showReport() {
    renderReport()
    if (!dialog.open) dialog.showModal()
  }
  async function refreshAnalysis() {
    await analyze(true)
    if (active && activeDocument) updateFile(active, activeDocument, true)
  }
  requireElement(panel, '.howmany-report-button', HTMLButtonElement).addEventListener('click', showReport)
  status.addEventListener('click', showReport)
  refresh.addEventListener('click', () => runTask('Refresh HowMany analysis', refreshAnalysis))
  requireElement(dialog, '.howmany-report-refresh', HTMLButtonElement).addEventListener('click', () =>
    runTask('Refresh HowMany analysis', refreshAnalysis),
  )
  requireElement(dialog, '.howmany-close', HTMLButtonElement).addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect()
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close()
    }
  })
  requireElement(dialog, '.howmany-export', HTMLButtonElement).addEventListener('click', () => {
    runTask('Export HowMany report', async () => {
      const result = await attemptAsync(() => runtime.export(), { operation: 'Export HowMany report' })
      if (disposed) return
      if (result.ok) {
        if (result.value) {
          reportState.dataset.state = 'exported'
          reportState.textContent = 'Report exported'
        }
      } else {
        reportError(result.error, { silent: true })
        reportState.dataset.state = 'error'
        reportState.textContent = result.error.message
      }
    })
  })
  const unsubscribe = runtime.onEvent((/** @type {HowManyEvent} */ event) => {
    if (disposed) return
    if (event.type === 'analysis') {
      analysisEvents++
      render(event)
    }
    if (
      event.type === 'file' &&
      event.request === fileRequest &&
      active &&
      active.file.path === event.path &&
      active.model?.getVersionId() === active.howmanyVersion
    )
      showWarnings(active, isArray(event.diagnostics) ? event.diagnostics.filter(isDiagnostic) : [])
  })

  /**
   * @param {HowManyCard} card
   * @param {import('../../editor/languages/language-protocol.js').ProtocolDiagnostic[]} diagnostics
   */
  function showWarnings(card, diagnostics) {
    if (card.model) {
      // HowMany owns separate markers so language-server diagnostics remain visible.
      monaco.editor.setModelMarkers(
        card.model,
        'howmany',
        diagnostics.map(diagnostic => ({
          startLineNumber: diagnostic.range.start.line + 1,
          startColumn: diagnostic.range.start.character + 1,
          endLineNumber: diagnostic.range.end.line + 1,
          endColumn: diagnostic.range.end.character + 1,
          message: diagnostic.message,
          severity: monaco.MarkerSeverity.Warning,
          source: 'HowMany',
          code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        })),
      )
    }
    const warnings = requireElement(card.element, '.howmany-warnings', HTMLElement)
    const text = diagnostics.map(value => value.message).join(' · ')
    if (warnings.textContent !== text) warnings.textContent = text
    warnings.hidden = !text
  }

  /** @param {HowManyCard | null} [card] */
  function clearFile(card = active) {
    if (!card || card !== active) return
    cancelFile?.()
    cancelFile = null
    fileRequest = null
    active = null
    activeDocument = null
    card.howmanyVersion = null
    const counts = requireElement(card.element, '.howmany-counts', HTMLElement)
    counts.textContent = ''
    counts.hidden = true
    showWarnings(card, [])
    runTask('Release HowMany file', () => runtime.close(card.file.path), { silent: true })
  }
  /**
   * @param {HowManyCard} card
   * @param {{ note?: string | null }} document
   */
  function updateFile(card, document, force = false) {
    if (disposed) return
    if (document.note) {
      clearFile(card)
      return
    }
    const version = card.model?.getVersionId()
    if (version === undefined) return
    if (!force && active === card && card.howmanyVersion === version) return
    active = card
    activeDocument = document
    cancelFile?.()
    card.howmanyVersion = version
    const request = (fileRequest = crypto.randomUUID())
    const counts = requireElement(card.element, '.howmany-counts', HTMLElement)
    // Keep the editor positioned while replacement counts and diagnostics arrive.
    cancelFile = afterPaint(() => {
      cancelFile = null
      if (disposed || request !== fileRequest || !card.active || card.model?.getVersionId() !== version) return
      runTask('Analyze file with HowMany', () => loadFile(card, version, request, counts))
    })
  }

  /** @param {HowManyCard} card @param {number} version @param {string} request @param {HTMLElement} counts */
  async function loadFile(card, version, request, counts) {
    const analysis = await attemptAsync(() => runtime.file(card.file.path, request), {
      operation: 'Analyze file with HowMany',
    })
    if (disposed || request !== fileRequest || !card.active || card.model?.getVersionId() !== version) return
    if (!analysis.ok) reportError(analysis.error, { silent: true })
    /** @type {HowManyFile | null} */
    const result = analysis.ok ? analysis.value : null
    if (!result || result.message) card.howmanyVersion = null
    if (!result || result.message || result.live === false) showWarnings(card, [])
    const text = result?.title ?? ''
    if (counts.textContent !== text) counts.textContent = text
    counts.hidden = !text
    counts.title = result?.live
      ? 'Counted by HowMany from the displayed file'
      : 'Counted by HowMany from the saved file'
  }
  return {
    start() {
      if (started || disposed) return
      started = true
      cancelAnalysis = afterPaint(() => {
        cancelAnalysis = null
        runTask('Analyze workspace with HowMany', analyze)
      })
    },
    analyze,
    updateFile,
    clearFile,
    dispose() {
      disposed = true
      cancelAnalysis?.()
      cancelAnalysis = null
      clearFile()
      unsubscribe()
      dialog.remove()
      panel.remove()
      status.remove()
    },
  }
}

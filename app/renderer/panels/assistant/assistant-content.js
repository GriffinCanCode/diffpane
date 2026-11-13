import { diffLines } from 'diff'
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { markdownTarget } from '../../editor/markdown/markdown-paths.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'

/** @typedef {{path: string, anchor: string, startLine?: number, endLine?: number, side?: 'head' | 'working'}} FileTarget */
/** @typedef {(target: FileTarget) => unknown} OpenFile */
/** @typedef {'running' | 'done' | 'error' | 'stopped'} ToolStatus */
/** @typedef {{id: string, name: string, label: string, detail?: string, status: ToolStatus, path?: string, startLine?: number, endLine?: number, side?: 'head' | 'working'}} ToolActivity */
/** @typedef {NonNullable<Awaited<ReturnType<import('../../../electron/runtime/window/preload.ts').DiffpaneApi['claude']['send']>>['proposal']>} Proposal */

const MARKDOWN = new Marked({
  gfm: true,
  renderer: {
    html: () => '',
    image: ({ text }) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  },
})

const CHEVRON = '<path d="m6 4 4 4-4 4"/>'
const CLIPBOARD =
  '<rect x="6" y="5.5" width="7" height="8" rx="1.5"/><path d="M10 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-4A1.5 1.5 0 0 0 3 4v5A1.5 1.5 0 0 0 4.5 10.5H6"/>'
const ACTIVITY_GLYPH = {
  running: '<path d="M13 8a5 5 0 1 1-5-5"/>',
  done: '<path d="m4 8 2.5 2.5L12 5"/>',
  error: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v2.75m0 2h.01"/>',
  stopped: '<path d="M6 5v6m4-6v6"/>',
}
const DIFF_MARKER = { add: '+', remove: '−', context: ' ', omit: '…' }
const INSPECTED_ITEMS = new Map([
  ['read_file', 'files'],
  ['read_idea', 'ideas'],
])

/** @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {string} className
 * @param {string} [text]
 */
function node(tag, className, text) {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

/** @param {string} className @param {string} glyph */
function icon(className, glyph) {
  const element = node('span', className)
  element.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`
  element.setAttribute('aria-hidden', 'true')
  return element
}

/** @param {string} label @param {string} className @param {() => void} onClick */
function button(label, className, onClick) {
  const element = node('button', className, label)
  element.type = 'button'
  element.addEventListener('click', onClick)
  return element
}

/** @param {string} text */
function copyCode(text) {
  const control = button('', 'claude-copy-code', () => {
    runTask('Copy assistant code', async () => {
      const result = await attemptAsync(() => navigator.clipboard.writeText(text), { operation: 'Copy code' })
      if (!result.ok) reportError(result.error, { silent: true })
      control.dataset.state = result.ok ? 'copied' : 'error'
      control.title = result.ok ? 'Copied' : 'Copy unavailable'
      control.setAttribute('aria-label', control.title)
      window.clearTimeout(timeout)
      timeout = window.setTimeout(reset, 2000)
    })
  })
  let timeout = 0
  function reset() {
    delete control.dataset.state
    control.title = 'Copy code'
    control.setAttribute('aria-label', control.title)
  }
  reset()
  control.append(icon('claude-copy-glyph', CLIPBOARD), icon('claude-copy-done', ACTIVITY_GLYPH.done))
  return control
}

/** @param {string} href @returns {FileTarget | null} */
function projectLink(href) {
  const target = markdownTarget('', href)
  if (!target?.path) return null
  const lines = /^L([1-9]\d*)(?:-L?([1-9]\d*))?$/i.exec(target.anchor)
  if (!lines) return target
  const startLine = Number(lines[1])
  const endLine = Number(lines[2] ?? lines[1])
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || endLine < startLine) return null
  const [location = ''] = href.split('#', 1)
  const query = location.indexOf('?')
  const side = query >= 0 && new URLSearchParams(location.slice(query + 1)).get('side') === 'head' ? 'head' : 'working'
  return { ...target, anchor: '', startLine, endLine, side }
}

/** @param {HTMLElement} host
 * @param {string} text
 * @param {{openExternal?: (href: string) => unknown, openFile?: OpenFile, colorize?: (text: string, language: string) => string | PromiseLike<string>, onLayout?: () => void, streaming?: boolean}} [options]
 */
export function renderAssistantMarkdown(host, text, { openExternal, openFile, colorize, onLayout, streaming } = {}) {
  const parsed = MARKDOWN.parse(text, { async: false })
  host.replaceChildren(
    DOMPurify.sanitize(parsed, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: [
        'a',
        'p',
        'br',
        'strong',
        'em',
        'del',
        's',
        'code',
        'pre',
        'ul',
        'ol',
        'li',
        'input',
        'blockquote',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ],
      ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'type', 'checked', 'disabled', 'align'],
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
    }),
  )
  for (const link of host.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    const target = projectLink(href)
    if (target && openFile) {
      link.dataset.link = 'file'
      link.addEventListener('click', event => {
        event.preventDefault()
        runTask('Open assistant file link', () => openFile(target))
      })
    } else if (openExternal && /^(https?:|mailto:)/i.test(href)) {
      link.dataset.link = 'external'
      link.addEventListener('click', event => {
        event.preventDefault()
        runTask('Open assistant link', () => openExternal(href))
      })
    } else link.replaceWith(...link.childNodes)
    link.addEventListener('auxclick', event => event.preventDefault())
  }
  for (const table of host.querySelectorAll('table')) {
    const wrapper = node('div', 'claude-table-scroll')
    wrapper.tabIndex = 0
    wrapper.setAttribute('role', 'region')
    wrapper.setAttribute('aria-label', 'Scrollable table')
    table.replaceWith(wrapper)
    wrapper.append(table)
  }
  for (const input of host.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove()
    else {
      input.disabled = true
      input.closest('li')?.classList.add('claude-task')
    }
  }
  for (const pre of host.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    if (!code) continue
    const source = code.textContent.replace(/\n$/, '')
    const language = Array.from(code.classList)
      .find(name => /^language-[\w+.-]{1,32}$/.test(name))
      ?.slice(9)
    const block = node('section', 'claude-code-block')
    const toolbar = node('div', 'claude-code-toolbar')
    toolbar.append(node('span', 'claude-code-language', language ?? 'Plain text'), copyCode(source))
    pre.tabIndex = 0
    pre.setAttribute('aria-label', language ? `${language} code` : 'Code')
    pre.replaceWith(block)
    block.append(toolbar, pre)
    if (colorize && language && !streaming && source.length < 20_000) {
      runTask(
        'Highlight assistant code',
        async () => {
          const highlighted = await colorize(source, language)
          if (!host.contains(code)) return
          code.innerHTML = DOMPurify.sanitize(highlighted.replace(/<br\s*\/?\s*>$/i, ''), {
            ALLOWED_TAGS: ['span', 'br'],
            ALLOWED_ATTR: ['class'],
            ALLOW_ARIA_ATTR: false,
            ALLOW_DATA_ATTR: false,
          })
          onLayout?.()
        },
        { silent: true },
      )
    }
  }
}

/** @param {string} className */
function activityLine(className) {
  const element = node('span', className)
  const symbol = icon('claude-activity-icon', ACTIVITY_GLYPH.running)
  const label = node('span', 'claude-activity-label')
  const detail = node('span', 'claude-activity-detail')
  element.append(symbol, label, detail)
  return { element, symbol, label, detail }
}

/** @param {ReturnType<typeof activityLine>} line @param {ToolStatus} status @param {string} label @param {string} [detail] */
function updateActivityLine(line, status, label, detail) {
  if (line.element.dataset.status !== status) {
    line.element.dataset.status = status
    const svg = line.symbol.querySelector('svg')
    if (svg) svg.innerHTML = ACTIVITY_GLYPH[status]
  }
  line.label.textContent = label
  line.detail.hidden = !detail
  line.detail.textContent = detail ?? ''
  line.detail.title = detail ?? ''
}

/** @param {{openFile?: OpenFile}} [options] */
export function createToolActivity({ openFile } = {}) {
  const element = node('details', 'claude-activity')
  const summary = node('summary', 'claude-activity-summary')
  const summaryLine = activityLine('claude-activity-summary-line')
  const list = node('ul', 'claude-activity-list')
  summary.append(summaryLine.element, icon('claude-chevron', CHEVRON))
  element.append(summary, list)

  /** @type {Map<string, {event: ToolActivity, line: ReturnType<typeof activityLine>, target: HTMLButtonElement}>} */
  const entries = new Map()

  /** @param {ToolActivity} event */
  function update(event) {
    let entry = entries.get(event.id)
    if (!entry) {
      const row = node('li', 'claude-activity-row')
      const line = activityLine('claude-activity-row-line')
      const target = button('', 'claude-activity-target', () => {
        const current = entries.get(event.id)?.event
        if (!openFile || !current?.path) return
        const { path, startLine, endLine, side } = current
        runTask('Open assistant activity file', () => openFile({ path, anchor: '', startLine, endLine, side }))
      })
      line.element.append(target)
      row.append(line.element)
      list.append(row)
      entry = { event, line, target }
      entries.set(event.id, entry)
    }
    entry.event = event
    const linked = Boolean(event.status === 'done' && event.path && openFile)
    updateActivityLine(entry.line, event.status, event.label, linked ? undefined : event.detail)
    if (entry.line.element.parentElement) entry.line.element.parentElement.dataset.status = event.status
    entry.target.hidden = !linked
    if (linked) {
      const reference = event.detail ?? event.path ?? ''
      const start = event.startLine
      const end = event.endLine
      const lines = start && (end && end > start ? `${start}–${end}` : String(start))
      const detail = lines ? `${reference}:${lines}` : reference
      entry.target.textContent = detail
      entry.target.title = detail
      entry.target.setAttribute('aria-label', `Open ${detail}${event.side === 'head' ? ' at HEAD' : ''}`)
    }
    const events = Array.from(entries.values(), item => item.event)
    const running = events.findLast(item => item.status === 'running')
    const failed = events.filter(item => item.status === 'error').length
    const stopped = events.filter(item => item.status === 'stopped').length
    const status = running ? 'running' : failed ? 'error' : stopped ? 'stopped' : 'done'
    element.dataset.status = status
    if (events.length === 1 || running) {
      const current = running ?? event
      updateActivityLine(
        summaryLine,
        status,
        current.label,
        current === event && linked ? entry.target.textContent : current.detail,
      )
    } else {
      const details = [failed && `${failed} failed`, stopped && `${stopped} interrupted`].filter(Boolean).join(' · ')
      const noun = INSPECTED_ITEMS.get(event.name)
      const matchedRead = noun && status === 'done' && events.every(item => item.name === event.name)
      updateActivityLine(
        summaryLine,
        status,
        matchedRead ? `Read ${events.length} ${noun}` : `${events.length} actions`,
        details,
      )
    }
  }

  function finish() {
    for (const { event } of entries.values()) {
      if (event.status === 'running') update({ ...event, label: 'Interrupted', status: 'stopped' })
    }
  }

  return { element, update, finish }
}

/** @param {HTMLElement} diff @param {'add'|'remove'|'context'|'omit'} change @param {string[]} lines */
function appendDiffLines(diff, change, lines) {
  if (!lines.length) return
  const row = node('span', 'claude-diff-line')
  row.dataset.change = change
  const marker = node('span', 'claude-diff-marker', lines.map(() => DIFF_MARKER[change]).join('\n'))
  marker.setAttribute('aria-hidden', 'true')
  // A blank token still occupies a line and has a visible change marker.
  row.append(marker, node('code', 'claude-diff-text', lines.map(line => line || ' ').join('\n')))
  if (change === 'add' || change === 'remove') {
    const label = node('span', 'claude-diff-accessible', change === 'add' ? 'Added lines' : 'Removed lines')
    row.prepend(label)
  }
  diff.append(row)
}

/** @param {Proposal} proposal
 * @param {{onApply?: () => void, onDiscard?: () => void, onOpenFile?: OpenFile, openExternal?: (href: string) => unknown, colorize?: (text: string, language: string) => string | PromiseLike<string>}} [options]
 */
export function createEditProposal(proposal, { onApply, onDiscard, onOpenFile, openExternal, colorize } = {}) {
  const idea = proposal.kind === 'idea'
  const create = idea && proposal.action === 'create'
  const label = idea ? (create ? 'New idea' : 'Idea update') : 'File edit'
  const card = node('section', 'claude-proposal')
  card.dataset.kind = idea ? 'idea' : 'file'
  card.setAttribute('aria-label', label)
  const heading = node('header', 'claude-proposal-heading')
  const path = idea ? proposal.title : proposal.path
  const title =
    onOpenFile && !idea
      ? button(path, 'claude-proposal-path claude-proposal-target', () => {
          runTask('Open proposed edit file', () => onOpenFile({ path, anchor: '', startLine: proposal.startLine }))
        })
      : node('p', 'claude-proposal-path', path)
  title.title = path
  heading.append(node('h3', 'claude-proposal-title', label), title)
  card.append(heading)
  if (idea && proposal.beforeTitle !== undefined && proposal.beforeTitle !== proposal.title) {
    card.append(node('p', 'claude-proposal-previous', `Current title is “${proposal.beforeTitle}”`))
  }

  const { before, after } = proposal
  if (create && after.trim()) {
    const preview = node('details', 'claude-proposal-preview')
    preview.open = true
    const summary = node('summary', 'claude-proposal-summary')
    summary.append(node('span', '', 'Preview idea'), icon('claude-chevron', CHEVRON))
    const content = node('div', 'claude-idea-preview claude-turn-content')
    renderAssistantMarkdown(content, after, { openFile: onOpenFile, openExternal, colorize })
    preview.append(summary, content)
    card.append(preview)
  } else if (before !== after) {
    const changes = diffLines(before, after, { timeout: 50 }) ?? [
      { value: before, count: before ? before.split('\n').length : 0, removed: true },
      { value: after, count: after ? after.split('\n').length : 0, added: true },
    ]
    const added = changes.reduce(
      (count, segment) => count + ('added' in segment && segment.added ? segment.count : 0),
      0,
    )
    const removed = changes.reduce(
      (count, segment) => count + ('removed' in segment && segment.removed ? segment.count : 0),
      0,
    )
    const preview = node('details', 'claude-proposal-preview')
    preview.open = added + removed <= 12
    const summary = node('summary', 'claude-proposal-summary')
    const stats = node('span', 'claude-proposal-stats')
    const add = node('span', 'claude-proposal-added', `+${added}`)
    const remove = node('span', 'claude-proposal-removed', `−${removed}`)
    add.setAttribute('aria-label', `${added} lines added`)
    remove.setAttribute('aria-label', `${removed} lines removed`)
    if (added) stats.append(add)
    if (removed) stats.append(remove)
    summary.append(node('span', '', 'Review changes'), stats, icon('claude-chevron', CHEVRON))
    const diff = node('div', 'claude-diff')
    diff.tabIndex = 0
    diff.setAttribute('role', 'region')
    diff.setAttribute('aria-label', 'Proposed changes')
    const changedFinalNewline = before && after && before.endsWith('\n') !== after.endsWith('\n')
    for (const [index, segment] of changes.entries()) {
      if (!segment.count) continue
      const lines = segment.value.replace(/\r?\n$/, '').split(/\r?\n/)
      const type =
        'added' in segment && segment.added ? 'add' : 'removed' in segment && segment.removed ? 'remove' : 'context'
      if (type === 'context' && lines.length > 6) {
        if (index > 0) appendDiffLines(diff, type, lines.slice(0, 2))
        const end = index > 0 ? 2 : 0
        const start = index < changes.length - 1 ? 2 : 0
        appendDiffLines(diff, 'omit', [`${lines.length - end - start} unchanged lines`])
        if (start) appendDiffLines(diff, type, lines.slice(-start))
      } else {
        appendDiffLines(diff, type, lines)
        if (changedFinalNewline && type !== 'context' && !segment.value.endsWith('\n')) {
          appendDiffLines(diff, 'omit', ['No newline at end of text'])
        }
      }
    }
    if (before.replaceAll('\r\n', '\n') === after.replaceAll('\r\n', '\n')) {
      appendDiffLines(diff, 'omit', ['Line endings changed'])
    }
    preview.append(summary, diff)
    card.append(preview)
  }

  const controls = node('div', 'claude-proposal-controls')
  const applyLabel = create ? 'Create idea' : idea ? 'Update idea' : 'Apply edit'
  if (onApply) controls.append(button(applyLabel, 'claude-button claude-primary', onApply))
  if (onDiscard) controls.append(button('Discard', 'claude-button', onDiscard))
  if (controls.childElementCount) card.append(controls)
  return { card, controls }
}

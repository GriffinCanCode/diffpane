// MONOLITHIC: Idea selection, drafts, saves and incoming cross-window edits share one controller. Extract persistence transitions once they expose the same conflict and close behavior independently.
import { marked } from 'marked'
import { appError, attemptAsync } from '../app-errors.ts'
import type { Result } from '../app-errors.ts'
import { IDEA_FILE_DRAG_TYPE, MAX_IDEA_BODY_LENGTH, MAX_IDEA_LINKS, MAX_IDEA_TITLE_LENGTH } from '../ideas.ts'
import type { Idea, IdeaChange, IdeaLink } from '../ideas.ts'
import { ariaBinding, bindingKeys } from '../shortcuts.ts'
import type { ShortcutBinding } from '../shortcuts.ts'
import { requireElement } from './dom.js'
import { reportError, runTask } from './errors.ts'
import { mountIdeaEditor } from './idea-editor.ts'
import type { MarkdownReplacement } from './idea-editor.ts'
import { markdownTarget } from './markdown-paths.ts'
import './ideas.css'

const GLYPHS = {
  notebook: '<rect x="3.5" y="2.5" width="11.5" height="13" rx="2"/><path d="M7 2.5v13M2 6h3m-3 6h3m4.5-5h3m-3 3h2"/>',
  plus: '<path d="M9 4v10M4 9h10"/>',
  close: '<path d="m5 5 8 8m0-8-8 8"/>',
  dock: '<rect x="2.5" y="3.5" width="13" height="11" rx="1.5"/><path d="M7 3.5v11"/>',
  expand: '<path d="M10.5 3.5h4v4m0-4-5 5m-2 6h-4v-4m0 4 5-5"/>',
  index: '<path d="M6.5 5h7m-7 4h7m-7 4h7M3.5 5h.1M3.5 9h.1m-.1 4h.1"/>',
  format:
    '<path d="M2.5 13.5 6 4.5l3.5 9M4 10.5h4m7.5 3v-3a2 2 0 0 0-3.5-1.3m3.5 1.8h-1.8a1.3 1.3 0 1 0 0 2.6c1 0 1.8-.6 1.8-1.3"/>',
  search: '<circle cx="7.5" cy="7.5" r="4.5"/><path d="m11 11 3.5 3.5"/>',
  file: '<path d="M5 2.5h5l3 3v10H5zM10 2.5v3h3M7 9h4m-4 3h4"/>',
  link: '<path d="m7 11 4-4M7.5 12l-1 1a2.5 2.5 0 1 1-3.5-3.5l2.5-2.5A2.5 2.5 0 0 1 9 7m0 4a2.5 2.5 0 0 0 3.5 0L15 8.5A2.5 2.5 0 1 0 11.5 5l-1 1"/>',
  chat: '<path d="M9 2.5v13m-6.5-6.5h13M4.4 4.4l9.2 9.2m0-9.2-9.2 9.2"/>',
  trash: '<path d="M3.5 5h11m-10 0 .7 10h7.6l.7-10M7 5V3h4v2M7.5 8v4m3-4v4"/>',
  heading: '<path d="M5 4v10m8-10v10M5 9h8"/>',
  bold: '<path d="M5.5 9h4a2.5 2.5 0 1 1 0 5h-4V4h3.5a2.5 2.5 0 0 1 0 5" stroke-width="1.8"/>',
  italic: '<path d="M7.5 4h6m-9 10h6m.5-10-4 10"/>',
  code: '<path d="m6.5 5-4 4 4 4m5-8 4 4-4 4"/>',
  list: '<path d="M7 5h7m-7 4h7m-7 4h7M4 5h.1M4 9h.1M4 13h.1"/>',
  ordered:
    '<path d="M7.5 5h7m-7 4h7m-7 4h7M3 5.8h1.5m-.75 0V3.5l-.75.5M3 9a1 1 0 0 1 1.5.2c.3.7-1.3 1.6-1.5 2.3h1.6"/>',
  task: '<rect x="3" y="3" width="12" height="12" rx="2"/><path d="m6.2 9 2 2 3.6-4"/>',
}

interface IdeaBuilderOptions {
  isMac: boolean
  getShortcut: (action: 'formatIdeaBold' | 'formatIdeaItalic') => ShortcutBinding
  load: () => Promise<Idea[]>
  save: (idea: Idea) => Promise<Idea>
  remove: (id: string) => Promise<void>
  openLink: (link: IdeaLink) => void | Promise<void>
  getWorkspace: () => string | undefined | null
  getCurrentLink: () => IdeaLink | null | undefined
  hasCurrentLink?: () => boolean
  draftInChat?: (idea: Idea) => void | Promise<void>
  onPendingChange?: () => void
  onClose?: () => void
  onDock?: () => void
  onExpand?: () => void
  openMarkdownFile?: (target: { path: string; anchor: string }) => void | Promise<void>
  openExternal?: (href: string) => Promise<unknown>
  media?: (path: string) => Promise<{ type: string; url: string }>
}

function icon(name: keyof typeof GLYPHS) {
  return `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name]}</svg>`
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function button(label: string, glyph?: keyof typeof GLYPHS, showText = false) {
  const control = node('button', 'idea-button')
  control.type = 'button'
  control.title = label
  if (glyph) control.innerHTML = icon(glyph)
  if (!glyph || showText) control.append(node('span', '', label))
  else control.setAttribute('aria-label', label)
  return control
}

function ideaRow(target: EventTarget | null) {
  const row = target instanceof Element ? target.closest('[data-idea-id]') : null
  return row instanceof HTMLButtonElement ? row : null
}

function filename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function draggedFile(data: string, workspace: string) {
  try {
    const payload: unknown = JSON.parse(data)
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('workspace' in payload) ||
      payload.workspace !== workspace ||
      !('path' in payload) ||
      typeof payload.path !== 'string' ||
      !payload.path ||
      payload.path.length > 4096 ||
      payload.path.includes('\0') ||
      payload.path.split('/').some(part => !part || part === '.' || part === '..')
    )
      return null
    return payload.path
  } catch {
    return null
  }
}

function linkLabel(link: IdeaLink, path = link.path) {
  const end = link.endLine ?? link.line
  const range = link.line ? `:${link.line}${end !== link.line ? `–${end}` : ''}` : ''
  return `${path}${range}${link.side === 'head' ? ' · HEAD' : ''}`
}

function matchesLink(left: IdeaLink, right: IdeaLink) {
  return (
    left.path === right.path &&
    left.line === right.line &&
    (left.endLine ?? left.line) === (right.endLine ?? right.line) &&
    (left.side ?? 'working') === (right.side ?? 'working')
  )
}

function bodySummary(body: string) {
  const [line = ''] = body.trimStart().slice(0, 160).split('\n', 1)
  const prose = line.replace(/^(?:>\s*|#{1,6}\s+|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?)+/u, '')
  const tokens = marked.Lexer.lexInline(prose)
  return tokens.map(token => ('text' in token && typeof token.text === 'string' ? token.text : token.raw)).join('')
}

const NOTE_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const LIST_PREFIX = /^([\t ]*)([-+*]|\d{1,9}[.)])([\t ]+)(?:\[([ xX])\](?:([\t ]+)|$))?/u

export function nextIdeaListItem(source: string, caret: number): MarkdownReplacement | null {
  const from = caret > 0 ? source.lastIndexOf('\n', caret - 1) + 1 : 0
  const nextLine = source.indexOf('\n', caret)
  const lineEnd = nextLine < 0 ? source.length : nextLine
  const line = source.slice(from, lineEnd)
  const item = line.match(LIST_PREFIX)
  if (!item || caret < from + item[0].length) return null

  let fence = ''
  for (const match of source.slice(0, from).matchAll(/^[\t ]*(`{3,}|~{3,})(.*)$/gmu)) {
    const [, marker, rest] = match
    if (!marker) continue
    if (!fence) fence = marker
    else if (marker.startsWith(fence) && !rest?.trim()) fence = ''
  }
  if (fence) return null

  if (!line.slice(item[0].length).trim()) return { from, to: lineEnd, text: '' }
  const [, indent, marker, space, checked, taskSpace] = item
  if (indent === undefined || marker === undefined || space === undefined) return null
  const number = Number(marker.slice(0, -1))
  const next =
    marker.length > 1 && Number.isFinite(number)
      ? `${number < 999_999_999 ? number + 1 : 1}${marker.slice(-1)}`
      : marker
  const task = checked === undefined ? '' : `[ ]${taskSpace ?? ' '}`
  return { from: caret, to: caret, text: `\n${indent}${next}${space}${task}` }
}

type Format = 'heading' | 'bold' | 'italic' | 'code' | 'list' | 'ordered' | 'task'
const FORMATS: [Format, string][] = [
  ['heading', 'Heading'],
  ['bold', 'Bold'],
  ['italic', 'Italic'],
  ['code', 'Inline code'],
  ['list', 'Bulleted list'],
  ['ordered', 'Numbered list'],
  ['task', 'Checklist'],
]
const FORMATTING_SHORTCUTS = { bold: 'formatIdeaBold', italic: 'formatIdeaItalic' } as const

export function formatIdeaSelection(source: string, start: number, end: number, format: Format): MarkdownReplacement {
  if (format === 'bold' || format === 'italic' || format === 'code') {
    let selected = source.slice(start, end)
    if (selected.trim() && format !== 'code') {
      start += selected.length - selected.trimStart().length
      end -= selected.length - selected.trimEnd().length
      selected = source.slice(start, end)
    }
    let marker = format === 'bold' ? '**' : format === 'italic' ? '*' : '`'
    if (format === 'code') {
      for (const run of selected.matchAll(/`+/gu)) {
        if (run[0].length >= marker.length) marker = '`'.repeat(run[0].length + 1)
      }
    }
    const padding = format === 'code' && selected && /^[` ]|[` ]$/u.test(selected) ? ' ' : ''
    const edge = marker + padding
    if (
      selected &&
      start >= edge.length &&
      source.slice(start - edge.length, start) === edge &&
      source.startsWith(padding + marker, end)
    ) {
      return {
        from: start - edge.length,
        to: end + edge.length,
        text: selected,
        selection: [0, selected.length],
      }
    }
    return {
      from: start,
      to: end,
      text: `${edge}${selected}${padding}${marker}`,
      selection: [edge.length, edge.length + selected.length],
    }
  }
  const from = start > 0 ? source.lastIndexOf('\n', start - 1) + 1 : 0
  const endPosition = end > start && source[end - 1] === '\n' ? end - 1 : end
  const nextLine = source.indexOf('\n', endPosition)
  const to = nextLine < 0 ? source.length : nextLine
  const lines = source.slice(from, to).split('\n')
  const prefix = (index: number) =>
    format === 'heading' ? '## ' : format === 'list' ? '- ' : format === 'task' ? '- [ ] ' : `${index + 1}. `
  const current = (line: string) => {
    if (format === 'heading') return line.match(/^[\t ]*#{1,6}[\t ]+/u)?.[0] ?? ''
    const item = line.match(LIST_PREFIX)
    if (!item) return ''
    if (format === 'task') return item[4] === undefined ? '' : item[0]
    if (item[4] !== undefined) return ''
    const ordered = (item[2]?.length ?? 0) > 1
    return (format === 'ordered') === ordered ? item[0] : ''
  }
  const removing =
    lines.some(line => Boolean(current(line))) && lines.every(line => !line.trim() || Boolean(current(line)))
  const transformed = lines.map((line, index) => {
    if (!line.trim() && lines.length > 1) return line
    const indent = line.match(/^[\t ]*/u)?.[0] ?? ''
    const existing = format === 'heading' ? current(line) : (line.match(LIST_PREFIX)?.[0] ?? '')
    return indent + (removing ? '' : prefix(index)) + line.slice(Math.max(indent.length, existing.length))
  })
  const text = transformed.join('\n')
  if (start !== end) return { from, to, text, selection: [0, text.length] }
  const caret = Math.max(0, Math.min(start - from + text.length - (to - from), text.length))
  return { from, to, text, selection: [caret, caret] }
}

export function mountIdeaBuilder(host: HTMLElement, options: IdeaBuilderOptions) {
  const lifetime = new AbortController()
  const events = { signal: lifetime.signal }
  host.classList.add('idea-panel')
  host.dataset.ideaMode = 'dock'
  host.setAttribute('aria-labelledby', 'idea-panel-title')
  host.innerHTML = `
    <header class="idea-header">
      <div class="idea-heading">
        ${icon('notebook')}
        <h2 id="idea-panel-title">Ideas</h2>
      </div>
      <div class="idea-library-actions"></div>
      <div class="idea-detail-actions" role="group" aria-label="Note actions" hidden></div>
      <div class="idea-header-actions" role="group" aria-label="Notebook view"></div>
    </header>
    <div class="idea-feedback" hidden>
      <div class="idea-status" hidden><span role="status"></span></div>
      <div class="idea-delete-confirm" role="group" aria-label="Confirm deletion" hidden><span>Delete this idea?</span></div>
    </div>
    <div class="idea-workspace">
      <section class="idea-index" id="idea-index" aria-label="Idea index" hidden>
        <label class="idea-search">${icon('search')}<input type="search" placeholder="Find an idea…" aria-label="Find an idea" autocomplete="off"></label>
        <div class="idea-list" role="group" aria-label="Saved ideas"></div>
      </section>
      <div class="idea-stage">
        <div class="idea-empty" hidden>
          <h3 aria-live="polite"></h3>
          <p></p>
          <div class="idea-empty-actions"></div>
        </div>
        <section class="idea-detail" aria-label="Selected idea" hidden>
          <div class="idea-page-heading idea-column">
            <input class="idea-title-input" type="text" placeholder="Untitled idea" aria-label="Idea title" autocomplete="off" maxlength="${MAX_IDEA_TITLE_LENGTH}">
            <div class="idea-page-meta">
              <time class="idea-date"></time>
              <div class="idea-attachments" role="group" aria-label="Linked code" hidden></div>
            </div>
          </div>
          <div class="idea-editor idea-column"></div>
        </section>
      </div>
    </div>
    <div class="idea-formats" id="idea-formats" role="group" aria-label="Text formatting" popover></div>`

  const select = (selector: string) => requireElement(host, selector, HTMLElement)
  const headerActions = select('.idea-header-actions')
  const libraryActions = select('.idea-library-actions')
  const indexSection = select('.idea-index')
  const search = requireElement(host, '.idea-search input', HTMLInputElement)
  const list = select('.idea-list')
  const empty = select('.idea-empty')
  const emptyTitle = select('.idea-empty h3')
  const emptyDetail = select('.idea-empty p')
  const emptyActions = select('.idea-empty-actions')
  const detail = select('.idea-detail')
  const stage = select('.idea-stage')
  const date = requireElement(host, '.idea-date', HTMLTimeElement)
  const metadata = select('.idea-page-meta')
  const title = requireElement(host, '.idea-title-input', HTMLInputElement)
  const body = select('.idea-editor')
  const toolbar = select('.idea-formats')
  const attachments = select('.idea-attachments')
  const detailActions = select('.idea-detail-actions')
  const confirmation = select('.idea-delete-confirm')
  const feedback = select('.idea-feedback')
  const statusGroup = select('.idea-status')
  const status = select('.idea-status span')

  const add = button('New idea', 'plus')
  const addFirst = button('New idea', 'plus', true)
  const showIndex = button('Show idea index', 'index')
  const formatText = button('Format text', 'format')
  const close = button('Close ideas', 'close')
  const dock = button('Dock beside code', 'dock')
  const expand = button('Open Ideas notebook', 'expand')
  const attachCurrent = button('Link current file or selection', 'link')
  const chat = button('Add to Claude', 'chat')
  const remove = button('Delete idea', 'trash')
  const cancelDelete = button('Cancel')
  const confirmDelete = button('Delete')
  const retryLoad = button('Retry')
  const retrySave = button('Retry')
  addFirst.classList.add('idea-primary')
  confirmDelete.classList.add('idea-destructive')
  showIndex.classList.add('idea-index-toggle')
  showIndex.setAttribute('aria-controls', indexSection.id)
  formatText.classList.add('idea-format-toggle')
  formatText.popoverTargetElement = toolbar
  attachCurrent.classList.add('idea-link-current')
  remove.classList.add('idea-delete')
  dock.classList.add('idea-dock')
  expand.classList.add('idea-expand')
  close.classList.add('idea-close')
  libraryActions.append(showIndex, add)
  if (options.onDock) headerActions.append(dock)
  if (options.onExpand) headerActions.append(expand)
  if (options.onClose) headerActions.append(close)
  emptyActions.append(addFirst, retryLoad)
  detailActions.append(formatText)
  if (options.draftInChat) detailActions.append(chat)
  detailActions.append(remove)
  metadata.append(attachCurrent)
  confirmation.append(cancelDelete, confirmDelete)
  statusGroup.append(retrySave)

  const ideas = new Map<string, Idea>()
  const changes = new Map<string, Idea | null>()
  const pendingRemote = new Set<string>()
  let selected: string | null = null
  let loading: Promise<void> | null = null
  let ready = false
  let loadError = ''
  let saveError = ''
  let notice = ''
  let bufferedChanges: IdeaChange[] = []
  let deferredLinks: IdeaLink[] = []
  let generation = 0
  let readOnly = false
  let confirming = false
  let browsing = false
  let dropRow: HTMLElement | null = null
  let firstListed: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<Result<void>> | null = null
  let lastPending = false

  const current = () => (selected ? ideas.get(selected) : undefined)
  const isPending = () => writing !== null || changes.size > 0 || deferredLinks.length > 0
  const editor = mountIdeaEditor(body, {
    maxLength: MAX_IDEA_BODY_LENGTH,
    placeholder: 'Start writing…',
    onChange: source => edit({ body: source }),
    onEnter: nextIdeaListItem,
    onOpenLink: openEditorLink,
    onLimit: () => notify('This idea has reached the Markdown length limit.'),
    resolveImage: async href => {
      const target = markdownTarget('', href)
      if (!target?.path || !options.media) return null
      const image = await options.media(target.path)
      return image.type.startsWith('image/') ? image.url : null
    },
  })

  function reportPending() {
    const pending = isPending()
    if (pending === lastPending) return
    lastPending = pending
    options.onPendingChange?.()
  }

  function renderStatus() {
    const label = saveError || notice
    feedback.hidden = !label && !confirming
    confirmation.hidden = !confirming
    statusGroup.hidden = !label
    statusGroup.toggleAttribute('data-error', Boolean(saveError))
    if (status.textContent !== label) status.textContent = label
    retrySave.hidden = !saveError
    retrySave.disabled = readOnly
  }

  function renderIndex() {
    const docked = host.dataset.ideaMode === 'dock'
    const hasIdea = Boolean(current())
    const showLibrary = ready && ideas.size > 0 && (!docked || browsing || !hasIdea)
    indexSection.hidden = !showLibrary
    showIndex.hidden = !docked || !hasIdea
    showIndex.setAttribute('aria-expanded', String(showLibrary))
    showIndex.setAttribute('aria-label', showLibrary ? 'Back to idea' : 'Show idea index')
    showIndex.title = showLibrary ? 'Back to idea' : 'Show idea index'
    stage.hidden = docked && showLibrary
  }

  function renderList() {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    const matching = [...ideas.values()]
      .filter(idea => {
        if (!terms.length) return true
        const text = `${idea.title}\n${idea.body}\n${idea.links.map(link => link.path).join('\n')}`.toLocaleLowerCase()
        return terms.every(term => text.includes(term))
      })
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
    firstListed = matching[0]?.id
    const rows = document.createDocumentFragment()
    for (const idea of matching) {
      const row = node('button', 'idea-row')
      row.type = 'button'
      row.dataset.ideaId = idea.id
      row.setAttribute('aria-pressed', String(idea.id === selected))
      const summary = bodySummary(idea.body)
      const label = idea.title.trim() || summary || 'Untitled idea'
      const description = summary || (idea.links[0] && filename(idea.links[0].path))
      const content = node('span', 'idea-row-content')
      content.append(node('span', 'idea-row-title', label))
      if (description && description !== label) content.append(node('span', 'idea-row-summary', description))
      row.append(content)
      if (idea.links.length) {
        const count = node('span', 'idea-row-count')
        count.innerHTML = icon('link')
        count.setAttribute('aria-label', `${idea.links.length} attached ${idea.links.length === 1 ? 'file' : 'files'}`)
        row.append(count)
      }
      rows.append(row)
    }
    if (!matching.length && terms.length) rows.append(node('p', 'idea-no-results', 'No matching ideas'))
    const active = document.activeElement
    const focus = active instanceof HTMLButtonElement && list.contains(active) ? active.dataset.ideaId : undefined
    list.replaceChildren(rows)
    if (focus) {
      const row = [...list.querySelectorAll('button')].find(candidate => candidate.dataset.ideaId === focus)
      row?.focus({ preventScroll: true })
    }

    const idea = current()
    empty.hidden = Boolean(idea)
    empty.dataset.state = ready ? (ideas.size ? 'browse' : 'blank') : loadError ? 'error' : 'loading'
    emptyTitle.toggleAttribute('data-loading-status', Boolean(loading) && !ready)
    if (!ready) {
      emptyTitle.textContent = loadError ? 'Ideas unavailable' : 'Loading ideas…'
      emptyDetail.textContent = loadError
    } else {
      emptyTitle.textContent = ideas.size ? 'Choose an idea' : 'No ideas yet'
      emptyDetail.textContent = ''
    }
    emptyDetail.hidden = !emptyDetail.textContent
    retryLoad.hidden = !loadError
    addFirst.hidden = !ready || Boolean(ideas.size)
    add.hidden = !ready || !ideas.size
    emptyActions.hidden = addFirst.hidden && retryLoad.hidden
    add.disabled = addFirst.disabled = !ready || readOnly
    search.disabled = !ready
    renderIndex()
  }

  function refreshContext() {
    const idea = current()
    const hasCurrent = idea && (options.hasCurrentLink ? options.hasCurrentLink() : options.getCurrentLink())
    attachCurrent.hidden = !hasCurrent
    attachCurrent.disabled = readOnly || !idea || idea.links.length >= MAX_IDEA_LINKS || !hasCurrent
    attachCurrent.title =
      idea && idea.links.length >= MAX_IDEA_LINKS
        ? 'This idea has reached its link limit'
        : 'Link current file or selection'
  }

  function renderLinks(idea: Idea) {
    const rows = document.createDocumentFragment()
    for (const [index, link] of idea.links.entries()) {
      const chip = node('div', 'idea-attachment')
      const label = linkLabel(link, filename(link.path))
      const open = button(label, 'file', true)
      open.title = linkLabel(link)
      open.addEventListener('click', () => runAction('Open idea attachment', () => options.openLink(link)))
      const unlink = button(`Remove ${label}`, 'close')
      unlink.disabled = readOnly
      unlink.addEventListener('click', () => {
        const active = current()
        if (readOnly || active?.id !== idea.id) return
        const next = active.links.filter((_, offset) => offset !== index)
        updateIdea(active, { links: next })
        const updated = current()
        if (updated) renderLinks(updated)
        ;(
          attachments.querySelectorAll<HTMLButtonElement>('button[aria-label]')[Math.min(index, next.length - 1)] ??
          (attachCurrent.disabled ? title : attachCurrent)
        ).focus()
      })
      chip.append(open, unlink)
      rows.append(chip)
    }
    attachments.replaceChildren(rows)
    attachments.hidden = !idea.links.length
    refreshContext()
  }

  function openEditorLink(href: string) {
    const target = markdownTarget('', href)
    if (target?.path) {
      runAction('Open idea link', () =>
        options.openMarkdownFile ? options.openMarkdownFile(target) : options.openLink({ path: target.path }),
      )
    } else if (target?.anchor) {
      if (!editor.goToHeading(target.anchor)) notify('The linked heading could not be found.')
    } else if (/^(https?:|mailto:)/iu.test(href)) {
      runAction('Open external link', async () => {
        await options.openExternal?.(href)
      })
    }
  }

  function renderDetail() {
    const idea = current()
    detail.hidden = !idea
    detailActions.hidden = !idea || confirming || stage.hidden
    editor.setDocument(idea?.id ?? null, idea?.body ?? '')
    editor.setReadOnly(readOnly)
    if (!idea || stage.hidden) {
      toolbar.hidePopover()
      return
    }
    if (title.value !== idea.title) title.value = idea.title
    const created = new Date(idea.createdAt)
    date.dateTime = created.toISOString()
    date.textContent = NOTE_DATE.format(created)
    title.readOnly = readOnly
    for (const control of toolbar.querySelectorAll('button')) control.disabled = readOnly
    formatText.disabled = remove.disabled = confirmDelete.disabled = chat.disabled = readOnly
    renderLinks(idea)
  }

  function selectIdea(id: string | null) {
    if (selected !== id) {
      if (changes.size && !saveError) runTask('Save ideas', startFlush)
      stage.scrollTop = 0
    }
    selected = id
    browsing = confirming = false
    notice = ''
    renderList()
    renderDetail()
    renderStatus()
  }

  function setMode(mode: 'notebook' | 'dock') {
    if (host.dataset.ideaMode === mode) return
    host.dataset.ideaMode = mode
    browsing = false
    toolbar.hidePopover()
    if (mode === 'notebook' && !current() && firstListed) selectIdea(firstListed)
    else {
      renderIndex()
      renderDetail()
    }
  }

  function update(idea: Idea, refreshList = true) {
    ideas.set(idea.id, idea)
    queueChange(idea.id, idea)
    if (refreshList) renderList()
  }

  function edit(patch: Partial<Pick<Idea, 'title' | 'body' | 'links'>>) {
    const idea = current()
    if (!idea || readOnly) return
    updateIdea(idea, patch)
  }

  function updateIdea(idea: Idea, patch: Partial<Pick<Idea, 'title' | 'body' | 'links'>>) {
    notice = ''
    const refreshList =
      idea.id !== firstListed ||
      Boolean(search.value.trim()) ||
      patch.title !== undefined ||
      patch.links !== undefined ||
      (patch.body !== undefined && bodySummary(patch.body) !== bodySummary(idea.body))
    update({ ...idea, ...patch, updatedAt: Math.max(Date.now(), idea.updatedAt + 1) }, refreshList)
  }

  function newIdea(link?: IdeaLink) {
    if (!ready || readOnly) return
    const now = Date.now()
    const id = crypto.randomUUID()
    const idea = {
      id,
      title: link ? filename(link.path).slice(0, MAX_IDEA_TITLE_LENGTH) : '',
      body: '',
      links: link ? [link] : [],
      createdAt: now,
      updatedAt: now,
    }
    search.value = ''
    if (changes.size && !saveError) runTask('Save ideas', startFlush)
    selected = id
    confirming = browsing = false
    notice = ''
    update(idea)
    renderDetail()
    stage.scrollTop = 0
    title.focus()
    if (link) title.select()
  }

  function attach(link: IdeaLink) {
    if (!link.path || readOnly) return
    if (!ready) {
      deferredLinks.push(link)
      reportPending()
      runTask('Load ideas', load)
      return
    }
    applyLink(link)
  }

  function applyLink(link: IdeaLink) {
    const idea = current()
    if (!idea) {
      newIdea(link)
      return
    }
    const existing = idea.links.findIndex(candidate => matchesLink(candidate, link))
    const previous = idea.links[existing]
    if (previous) {
      if (previous.excerpt !== link.excerpt || previous.truncated !== link.truncated) {
        const links = idea.links.slice()
        links[existing] = link
        updateIdea(idea, { links })
      }
    } else if (idea.links.length >= MAX_IDEA_LINKS) {
      notice = `This idea already has ${MAX_IDEA_LINKS} links.`
      renderStatus()
      return
    } else updateIdea(idea, { links: [...idea.links, link] })
    const updated = current()
    if (updated) renderLinks(updated)
  }

  function queueChange(id: string, idea: Idea | null) {
    changes.set(id, idea)
    if (!saveError && !writing && timer === undefined) {
      timer = setTimeout(() => runTask('Save ideas', startFlush), 250)
    }
    renderStatus()
    reportPending()
  }

  async function flush() {
    const result = await startFlush()
    if (result && !result.ok) throw result.error
  }

  async function startFlush(): Promise<Result<void> | undefined> {
    clearTimeout(timer)
    timer = undefined
    if (deferredLinks.length) {
      await load()
      if (!ready)
        return {
          ok: false,
          error: appError(loadError || 'Couldn’t load ideas.', { operation: 'Load ideas' }),
        }
    }
    if (writing) return writing
    if (!changes.size) return undefined
    const version = generation
    saveError = ''
    writing = Promise.resolve().then(async (): Promise<Result<void>> => {
      try {
        while (changes.size) {
          if (generation !== version) break
          const next = changes.entries().next()
          if (next.done) break
          const [id, change] = next.value
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each write must finish before the next version can save.
          const result = await attemptAsync<void>(
            async () => {
              if (change) await options.save(change)
              else await options.remove(id)
            },
            { operation: change ? 'Save idea' : 'Delete idea' },
          )
          if (!result.ok) {
            if (generation !== version) break
            reportError(result.error, { silent: true })
            saveError = `Couldn’t save ideas. ${result.error.message}`
            return result
          }
          if (generation === version && changes.get(id) === change) changes.delete(id)
        }
        return { ok: true, value: undefined }
      } finally {
        if (generation === version) {
          writing = null
          renderStatus()
          reportPending()
          if (pendingRemote.size && !changes.size) runTask('Sync ideas', () => reconcileRemote(version))
        }
      }
    })
    renderStatus()
    reportPending()
    return writing
  }

  function applyChange(change: IdeaChange) {
    if (!ready) {
      bufferedChanges.push(change)
      return
    }
    const id = change.type === 'upsert' ? change.idea.id : change.id
    if (changes.has(id)) {
      pendingRemote.add(id)
      return
    }
    // A later event supersedes any re-read in flight for the same idea.
    pendingRemote.delete(id)
    if (change.type === 'upsert') ideas.set(id, change.idea)
    else ideas.delete(id)
    if (id === selected && change.type === 'delete') selectIdea(null)
    else {
      renderList()
      if (id === selected) renderDetail()
    }
  }

  async function reconcileRemote(version: number, retrying = false) {
    if (generation !== version || changes.size || !pendingRemote.size) return
    const result = await attemptAsync(options.load, { operation: 'Sync ideas' })
    if (generation !== version || changes.size) return
    if (!result.ok) {
      if (retrying) throw result.error
      reportError(result.error, { retry: () => reconcileRemote(version, true) })
      return
    }
    const byId = new Map(result.value.map(idea => [idea.id, idea]))
    for (const id of pendingRemote) {
      const idea = byId.get(id)
      const existing = ideas.get(id)
      if (JSON.stringify(idea) === JSON.stringify(existing)) pendingRemote.delete(id)
      else applyChange(idea ? { type: 'upsert', idea } : { type: 'delete', id })
    }
  }

  async function load() {
    if (ready) return
    if (loading) return loading
    const version = generation
    loadError = ''
    loading = Promise.resolve().then(async (): Promise<void> => {
      try {
        const result = await attemptAsync(options.load, { operation: 'Load ideas' })
        if (generation !== version) return undefined
        if (!result.ok) {
          reportError(result.error, { silent: true })
          loadError = result.error.message
          return undefined
        }
        for (const idea of result.value) ideas.set(idea.id, idea)
        ready = true
        for (const change of bufferedChanges.splice(0)) applyChange(change)
        for (const link of deferredLinks.splice(0)) applyLink(link)
        return undefined
      } finally {
        if (generation === version) {
          loading = null
          renderList()
          if (host.dataset.ideaMode === 'notebook' && !current() && firstListed) {
            selectIdea(firstListed)
          } else {
            renderDetail()
            renderStatus()
          }
          reportPending()
        }
      }
    })
    renderList()
    return loading
  }

  function reset() {
    generation++
    clearTimeout(timer)
    timer = undefined
    ideas.clear()
    changes.clear()
    pendingRemote.clear()
    bufferedChanges = []
    deferredLinks = []
    loading = writing = null
    loadError = saveError = ''
    ready = false
    search.value = title.value = ''
    selectIdea(null)
    reportPending()
  }

  function runAction(operation: string, run: () => void | Promise<void>) {
    const version = generation
    const idea = selected
    runTask(operation, async () => {
      const result = await attemptAsync(run, { operation })
      if (!result.ok) {
        reportError(result.error, { silent: true })
        if (generation === version && selected === idea) notify(result.error.message)
      }
    })
  }

  function notify(message: string) {
    notice = message
    renderStatus()
  }

  function applyFormat(format: Format) {
    if (readOnly) return
    const { from, to } = editor.getSelection()
    toolbar.hidePopover()
    if (!editor.replace(formatIdeaSelection(editor.getSource(), from, to, format))) editor.focus()
  }

  const shortcutControls: {
    control: HTMLButtonElement
    format: keyof typeof FORMATTING_SHORTCUTS
    label: string
  }[] = []
  for (const [format, label] of FORMATS) {
    const control = button(label, format)
    if (format === 'bold' || format === 'italic') {
      shortcutControls.push({ control, format, label })
    }
    control.addEventListener('mousedown', event => event.preventDefault(), events)
    control.addEventListener('click', () => applyFormat(format), events)
    toolbar.append(control)
  }

  function refreshShortcuts() {
    for (const { control, format, label } of shortcutControls) {
      const binding = options.getShortcut(FORMATTING_SHORTCUTS[format])
      control.setAttribute('aria-keyshortcuts', ariaBinding(binding, options.isMac))
      const keys = bindingKeys(binding, options.isMac).join(options.isMac ? '' : '+')
      control.title = `${label} · ${keys}`
    }
  }

  function handleShortcut(event: KeyboardEvent, binding: ShortcutBinding): boolean {
    if (readOnly || !editor.contains(event.target)) return false
    const match = shortcutControls.find(({ format }) => options.getShortcut(FORMATTING_SHORTCUTS[format]) === binding)
    if (!match) return false
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) applyFormat(match.format)
    return true
  }

  add.addEventListener('click', () => newIdea(), events)
  addFirst.addEventListener('click', () => newIdea(), events)
  showIndex.addEventListener(
    'click',
    () => {
      browsing = !browsing
      renderIndex()
      renderDetail()
      if (browsing) search.focus()
      else editor.focus()
    },
    events,
  )
  close.addEventListener('click', () => options.onClose?.(), events)
  dock.addEventListener('click', () => options.onDock?.(), events)
  expand.addEventListener('click', () => options.onExpand?.(), events)
  retryLoad.addEventListener('click', () => runTask('Load ideas', load), events)
  retrySave.addEventListener('click', () => runTask('Save ideas', startFlush), events)
  search.addEventListener('input', renderList, events)
  search.addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Enter' || event.isComposing || !firstListed) return
      event.preventDefault()
      selectIdea(firstListed)
      title.focus()
    },
    events,
  )
  list.addEventListener(
    'click',
    event => {
      const row = ideaRow(event.target)
      if (!row?.dataset.ideaId) return
      selectIdea(row.dataset.ideaId)
      if (indexSection.hidden) editor.focus()
    },
    events,
  )
  title.addEventListener('input', () => edit({ title: title.value }), events)
  title.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        editor.focus()
      }
    },
    events,
  )
  attachCurrent.addEventListener(
    'click',
    () => {
      const link = options.getCurrentLink()
      if (link) attach(link)
    },
    events,
  )
  chat.addEventListener(
    'click',
    () => {
      const idea = current()
      if (idea) runAction('Draft idea in Claude', () => options.draftInChat?.(idea))
    },
    events,
  )
  remove.addEventListener(
    'click',
    () => {
      confirming = true
      renderStatus()
      cancelDelete.focus()
    },
    events,
  )
  cancelDelete.addEventListener(
    'click',
    () => {
      confirming = false
      renderStatus()
      remove.focus()
    },
    events,
  )
  confirmDelete.addEventListener(
    'click',
    () => {
      const idea = current()
      if (!idea || readOnly) return
      ideas.delete(idea.id)
      queueChange(idea.id, null)
      selectIdea(null)
      const next = list.querySelector('button') ?? (indexSection.hidden ? addFirst : search)
      next.focus()
    },
    events,
  )

  host.addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || toolbar.matches(':popover-open'))
        return
      if (event.target === search && search.value) return
      if (confirming) {
        event.preventDefault()
        cancelDelete.click()
      } else if (browsing) {
        event.preventDefault()
        showIndex.click()
      } else if (host.dataset.ideaMode === 'notebook' && options.onClose) {
        event.preventDefault()
        close.click()
      }
    },
    events,
  )

  function clearDrop() {
    delete host.dataset.fileDrop
    dropRow?.removeAttribute('data-file-drop')
    dropRow = null
  }

  host.addEventListener(
    'dragover',
    event => {
      if (readOnly || !event.dataTransfer?.types.includes(IDEA_FILE_DRAG_TYPE)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'link'
      host.dataset.fileDrop = 'true'
      const row = ideaRow(event.target)
      if (row !== dropRow) {
        dropRow?.removeAttribute('data-file-drop')
        dropRow = row
        if (row) row.dataset.fileDrop = 'true'
      }
    },
    events,
  )
  host.addEventListener(
    'dragleave',
    event => {
      if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget)) clearDrop()
    },
    events,
  )
  host.addEventListener(
    'drop',
    event => {
      clearDrop()
      const payload = event.dataTransfer?.getData(IDEA_FILE_DRAG_TYPE)
      if (!payload) return
      event.preventDefault()
      event.stopPropagation()
      const workspace = options.getWorkspace()
      if (!workspace || readOnly) return
      const path = draggedFile(payload, workspace)
      if (!path) {
        notify('Drop a file from this workspace.')
        return
      }
      const row = ideaRow(event.target)
      if (row?.dataset.ideaId) selectIdea(row.dataset.ideaId)
      attach({ path })
    },
    { ...events, capture: true },
  )

  renderList()
  return {
    load,
    async open(id: string) {
      await load()
      if (!ideas.has(id)) return false
      browsing = false
      selectIdea(id)
      title.focus()
      return true
    },
    reset,
    dispose() {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      generation++
      clearTimeout(timer)
      toolbar.hidePopover()
      clearDrop()
      editor.dispose()
      host.replaceChildren()
    },
    attach,
    refreshContext,
    refreshShortcuts,
    handleShortcut,
    notify,
    applyChange,
    flush,
    setMode,
    focus: () => {
      if (current()) {
        if (browsing) search.focus()
        else editor.focus()
      } else if (ready) (indexSection.hidden ? addFirst : search).focus()
      else (loadError ? retryLoad : close).focus()
    },
    setReadOnly(value: boolean) {
      readOnly = value
      renderList()
      renderDetail()
      renderStatus()
    },
    get pending() {
      return isPending()
    },
  }
}

import { attempt } from '../app-errors.ts'
import type { ContentMatch } from './content-search.ts'
import { reportError } from './errors.ts'
import { showMedia } from './media.ts'

import type { FileContent } from '../electron/file-content.ts'

interface PreviewMedia {
  url: string
  type: string
}

/** Native previews with an always available byte fallback. Owns all URLs and playback. */
export function showDocumentPreview(
  host: ParentNode,
  preview: { before: FileContent; after: FileContent },
  filename: string,
  compare = false,
  currentMedia: PreviewMedia | null = null,
  options: {
    baseline?: string
    raw?: boolean
    onRawChange?: (raw: boolean) => void
    match?: ContentMatch
  } = {},
) {
  const root = document.createElement('div')
  root.className = 'document-preview'
  root.dataset.compare = String(compare)
  const toolbar = document.createElement('div')
  toolbar.className = 'preview-toolbar'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'preview-byte-toggle'
  toggle.textContent = 'Hex'
  toggle.setAttribute('aria-label', 'Inspect raw bytes')
  toggle.setAttribute('aria-pressed', 'false')
  const hint = document.createElement('span')
  hint.textContent = 'Preview'
  toolbar.append(hint, toggle)
  const panes = document.createElement('div')
  panes.className = 'preview-panes'
  root.append(toolbar, panes)
  host.replaceChildren(root)
  let raw = options.raw ?? false
  let match = options.match
  const cleanups: (() => void)[] = []

  function clear() {
    for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
      const result = attempt(cleanup, { operation: 'Release document preview' })
      if (!result.ok) reportError(result.error, { silent: true })
    }
    panes.replaceChildren()
  }

  function render() {
    clear()
    toggle.setAttribute('aria-pressed', String(raw))
    hint.textContent = raw ? 'Hexadecimal · ASCII' : 'Preview'
    for (const side of compare ? (['before', 'after'] as const) : (['after'] as const)) {
      const value = preview[side]
      const pane = document.createElement('section')
      pane.className = 'preview-pane'
      pane.dataset.side = side
      const heading = document.createElement('div')
      heading.className = 'preview-heading'
      const details = compare ? document.createElement('span') : heading
      const size = `${value.size.toLocaleString()} bytes`
      details.textContent = compare ? size : `Current · working file · ${size}`
      if (compare) {
        const label = document.createElement('strong')
        const original = side === 'before'
        label.className = `comparison-version ${original ? 'is-original' : 'is-working'}`
        const name = document.createElement('span')
        name.className = 'preview-heading-label'
        name.textContent = original ? (options.baseline ?? 'HEAD') : 'Working file'
        label.append(name)
        details.className = 'preview-heading-details'
        details.title = size
        heading.append(label, details)
      }
      pane.append(heading)
      const note = document.createElement('p')
      note.className = 'preview-note'
      note.textContent = value.note ?? ''
      note.hidden = !note.textContent
      pane.append(note)
      const body = document.createElement('div')
      body.className = 'preview-body'
      pane.append(body)
      panes.append(pane)
      const truncated =
        value.hexBytes !== undefined && value.hexBytes < value.size
          ? `Showing the first ${value.hexBytes.toLocaleString()} of ${value.size.toLocaleString()} bytes.`
          : ''
      const bytes = (reason = '') => {
        const pre = document.createElement('pre')
        pre.className = 'preview-text'
        pre.tabIndex = 0
        pre.setAttribute('aria-label', `Contents of ${filename}`)
        const text = value.kind === 'text' ? value.value : ''
        pre.textContent = (raw || value.kind !== 'text' ? value.hex : text) ?? text
        body.replaceChildren(pre)
        if (!compare && !raw && value.kind === 'text' && match) {
          revealTextMatch(pre, match)
          match = undefined
        }
        if (reason || (truncated && (raw || value.kind === 'binary'))) {
          note.textContent = reason ? `${reason} ${truncated || 'Showing raw bytes.'}` : truncated
          note.hidden = false
        }
      }
      if (!value.size) {
        body.textContent = 'Empty or absent file.'
      } else if (raw || value.kind === 'text' || (value.kind === 'binary' && !(side === 'after' && currentMedia))) {
        bytes()
      } else {
        const failed = () => bytes('This format or codec cannot be displayed.')
        let media = side === 'after' ? currentMedia : null
        if (!media && 'data' in value && value.data && value.mime) {
          const { data: encoded, mime: type } = value
          const result = attempt(
            () => {
              const data = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
              return URL.createObjectURL(new Blob([data], { type }))
            },
            { operation: 'Decode document preview' },
          )
          if (!result.ok) {
            reportError(result.error, { silent: true })
            bytes('This preview could not be decoded.')
            continue
          }
          const url = result.value
          cleanups.push(() => URL.revokeObjectURL(url))
          media = { url, type }
        }
        if (!media) {
          failed()
          continue
        }
        if (media.type.startsWith('image/') || media.type.startsWith('video/')) {
          cleanups.push(
            showMedia(body, media, filename, {
              onReady: description => {
                details.textContent += ` · ${description}`
                if (compare) details.title = details.textContent
              },
              onError: failed,
            }),
          )
        } else if (media.type.startsWith('audio/')) {
          const audio = document.createElement('audio')
          audio.controls = true
          audio.preload = 'metadata'
          audio.setAttribute('aria-label', filename)
          const stop = () => {
            audio.removeEventListener('error', onError)
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
          }
          const onError = () => {
            stop()
            failed()
          }
          audio.addEventListener('error', onError)
          audio.src = media.url
          body.append(audio)
          cleanups.push(stop)
        } else if (media.type === 'application/pdf') {
          const frame = document.createElement('iframe')
          frame.className = 'preview-pdf'
          frame.title = `PDF preview of ${filename}`
          frame.src = media.url
          body.append(frame)
          cleanups.push(() => frame.remove())
        } else failed()
      }
    }
  }
  const toggleRaw = () => {
    raw = !raw
    options.onRawChange?.(raw)
    render()
  }
  toggle.addEventListener('click', toggleRaw)
  render()
  return () => {
    toggle.removeEventListener('click', toggleRaw)
    clear()
    root.remove()
  }
}

function revealTextMatch(pre: HTMLPreElement, hit: ContentMatch) {
  const text = pre.textContent
  const endings = /\r\n?|\n/gu
  let start = text.startsWith('\uFEFF') ? 1 : 0
  endings.lastIndex = start
  for (let line = 1; line < hit.line; line++) {
    if (!endings.exec(text)) return
    start = endings.lastIndex
  }
  start += hit.column - 1
  const end = start + hit.length
  if (text.slice(start, end) !== hit.match) return
  const mark = document.createElement('mark')
  mark.textContent = hit.match
  pre.replaceChildren(text.slice(0, start), mark, text.slice(end))
  pre.focus({ preventScroll: true })
  mark.scrollIntoView({ block: 'center', inline: 'nearest' })
}

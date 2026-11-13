import { editor as monacoEditor } from 'monaco-editor/editor/editor.api.js'
import { requireElement } from './dom.js'

import './review-focus.css'

/** @typedef {'focus' | 'full'} ReviewScope */

/** @param {'up' | 'down'} direction */
function chevron(direction) {
  return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${direction === 'up' ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

/**
 * @param {import('monaco-editor').editor.IEditorDecorationsCollection | null} marker
 * @param {number | undefined} line
 * @param {number | undefined} end
 */
function markLine(marker, line, end) {
  marker?.set(
    end && line !== undefined
      ? [
          {
            range: { startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: 1 },
            options: { isWholeLine: true, className: 'review-hunk-active' },
          },
        ]
      : [],
  )
}

/** @param {{ onScope: (scope: ReviewScope) => void }} options */
export function createReviewFocus({ onScope }) {
  const bar = document.createElement('div')
  bar.className = 'review-hunk-bar'
  bar.hidden = true
  bar.innerHTML = `
    <div class="review-hunk-navigation" role="group" aria-label="Changes in this file">
      <button type="button" class="review-hunk-prev" aria-label="Previous change in file" title="Previous change in file">${chevron('up')}</button>
      <div class="review-hunk-summary" role="status"><span class="review-hunk-caption">Change</span> <span class="review-hunk-position"></span></div>
      <button type="button" class="review-hunk-next" aria-label="Next change in file" title="Next change in file">${chevron('down')}</button>
    </div>
    <div class="review-hunk-modes" role="group" aria-label="Comparison context">
      <button type="button" class="review-focus-mode" aria-pressed="true" title="Collapse long stretches of unchanged lines">Focus changes</button>
      <button type="button" class="review-full-mode" aria-pressed="false" title="Show the entire file">Full file</button>
    </div>`

  const position = requireElement(bar, '.review-hunk-position', HTMLSpanElement)
  const caption = requireElement(bar, '.review-hunk-caption', HTMLSpanElement)
  const previous = requireElement(bar, '.review-hunk-prev', HTMLButtonElement)
  const next = requireElement(bar, '.review-hunk-next', HTMLButtonElement)
  const focus = requireElement(bar, '.review-focus-mode', HTMLButtonElement)
  const full = requireElement(bar, '.review-full-mode', HTMLButtonElement)
  /** @type {import('monaco-editor').editor.IDiffEditor | null} */
  let editor = null
  /** @type {{ originalAriaLabel?: string, modifiedAriaLabel?: string }} */
  let labels = {}
  /** @type {import('monaco-editor').IDisposable | null} */
  let listener = null
  /** @type {import('monaco-editor').editor.IEditorDecorationsCollection | null} */
  let originalMarker = null
  /** @type {import('monaco-editor').editor.IEditorDecorationsCollection | null} */
  let workingMarker = null
  /** @type {ReviewScope} */
  let scope = 'focus'
  /** @type {readonly import('monaco-editor').editor.ILineChange[]} */
  let hunks = []
  let index = 0
  let collapsed = false
  /** @type {number | null} */
  let frame = null

  function paint(label = `${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`) {
    if (position.textContent !== label) position.textContent = label
    caption.hidden = hunks.length === 0
    previous.disabled = next.disabled = hunks.length < 2
    focus.disabled = full.disabled = hunks.length === 0
    focus.setAttribute('aria-pressed', String(scope === 'focus'))
    full.setAttribute('aria-pressed', String(scope === 'full'))
    const hunk = hunks[index]
    markLine(originalMarker, hunk?.originalStartLineNumber, hunk?.originalEndLineNumber)
    markLine(workingMarker, hunk?.modifiedStartLineNumber, hunk?.modifiedEndLineNumber)
  }

  /** @param {boolean} enabled */
  function setCollapsed(enabled) {
    if (!editor || enabled === collapsed) return
    collapsed = enabled
    editor.updateOptions({
      ...labels,
      hideUnchangedRegions: {
        enabled,
        contextLineCount: 4,
        minimumLineCount: 5,
        revealLineCount: 16,
      },
    })
  }

  function reveal() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      const hunk = hunks[index]
      if (!editor || !hunk) return
      const working = editor.getModifiedEditor()
      const model = working.getModel()
      if (!model) return
      // A deletion is reported at the preceding working line, which can be zero.
      const line = Math.max(1, Math.min(model.getLineCount(), hunk.modifiedStartLineNumber))
      working.revealLineInCenter(line, monacoEditor.ScrollType.Immediate)
    })
  }

  function sync() {
    const changes = editor?.getLineChanges()
    if (!changes) {
      paint('Finding changes…')
      return
    }
    const anchor = hunks[index]?.modifiedStartLineNumber
    hunks = changes
    index = 0
    if (anchor !== undefined) {
      let nearest = Infinity
      for (const [i, hunk] of hunks.entries()) {
        const distance = Math.abs(hunk.modifiedStartLineNumber - anchor)
        if (distance >= nearest) continue
        index = i
        nearest = distance
      }
    }
    setCollapsed(scope === 'focus' && hunks.length > 0)
    if (hunks.length) paint()
    else paint('No text changes')
    if (anchor === undefined && hunks.length) reveal()
  }

  /** @param {-1 | 1} direction */
  function step(direction) {
    if (hunks.length < 2) return
    index = (index + direction + hunks.length) % hunks.length
    paint()
    reveal()
  }

  /** @param {ReviewScope} value */
  function chooseScope(value) {
    if (!editor || scope === value) return
    scope = value
    onScope(value)
    setCollapsed(value === 'focus' && hunks.length > 0)
    paint()
    reveal()
  }

  previous.addEventListener('click', () => step(-1))
  next.addEventListener('click', () => step(1))
  focus.addEventListener('click', () => chooseScope('focus'))
  full.addEventListener('click', () => chooseScope('full'))

  function detach() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    listener?.dispose()
    listener = null
    originalMarker?.clear()
    workingMarker?.clear()
    originalMarker = workingMarker = null
    editor = null
    hunks = []
    index = 0
    collapsed = false
    bar.hidden = true
  }

  return {
    bar,
    /**
     * @param {import('monaco-editor').editor.IDiffEditor} diffEditor
     * @param {ReviewScope} initialScope
     * @param {typeof labels} ariaLabels
     */
    attach(diffEditor, initialScope, ariaLabels) {
      if (editor === diffEditor) return
      detach()
      editor = diffEditor
      labels = ariaLabels
      scope = initialScope
      bar.hidden = false
      originalMarker = editor.getOriginalEditor().createDecorationsCollection()
      workingMarker = editor.getModifiedEditor().createDecorationsCollection()
      listener = editor.onDidUpdateDiff(sync)
      sync()
    },
    detach,
  }
}

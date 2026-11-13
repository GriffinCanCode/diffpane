import { editor as monacoEditor } from 'monaco-editor/editor/editor.api.js'
import { requireElement } from '../../shell/workspace/dom.js'

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
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', 'Changes in this file')
  bar.hidden = true
  bar.innerHTML = `
    <button type="button" class="review-hunk-prev" aria-label="Previous change in file" title="Previous change in file">${chevron('up')}</button>
    <span class="review-hunk-position" aria-hidden="true"></span>
    <span class="review-hunk-announcement" role="status"></span>
    <button type="button" class="review-hunk-next" aria-label="Next change in file" title="Next change in file">${chevron('down')}</button>`

  const position = requireElement(bar, '.review-hunk-position', HTMLSpanElement)
  const announcement = requireElement(bar, '.review-hunk-announcement', HTMLSpanElement)
  const previous = requireElement(bar, '.review-hunk-prev', HTMLButtonElement)
  const next = requireElement(bar, '.review-hunk-next', HTMLButtonElement)
  const scopeControl = document.createElement('button')
  scopeControl.type = 'button'
  scopeControl.hidden = true
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
  let revealOnFirstDiff = false
  /** @type {number | null} */
  let frame = null

  function paint(message = '') {
    const current = (index + 1).toLocaleString()
    const total = hunks.length.toLocaleString()
    const label = message || `${current}/${total}`
    const spoken = message || `Change ${current} of ${total}`
    if (position.textContent !== label) position.textContent = label
    if (announcement.textContent !== spoken) announcement.textContent = spoken
    previous.hidden = next.hidden = hunks.length === 0
    previous.disabled = next.disabled = hunks.length < 2
    scopeControl.hidden = hunks.length === 0
    scopeControl.textContent = scope === 'focus' ? 'Show unchanged lines' : 'Hide unchanged lines'
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
    if (hunks.length && revealOnFirstDiff) {
      revealOnFirstDiff = false
      reveal()
    }
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
  scopeControl.addEventListener('click', () => chooseScope(scope === 'focus' ? 'full' : 'focus'))

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
    revealOnFirstDiff = false
    bar.hidden = true
    scopeControl.hidden = true
  }

  return {
    bar,
    scopeControl,
    /**
     * @param {import('monaco-editor').editor.IDiffEditor} diffEditor
     * @param {ReviewScope} initialScope
     * @param {typeof labels} ariaLabels
     * @param {boolean} [revealInitial]
     */
    attach(diffEditor, initialScope, ariaLabels, revealInitial = true) {
      if (editor === diffEditor) return
      detach()
      editor = diffEditor
      labels = ariaLabels
      scope = initialScope
      revealOnFirstDiff = revealInitial
      bar.hidden = false
      originalMarker = editor.getOriginalEditor().createDecorationsCollection()
      workingMarker = editor.getModifiedEditor().createDecorationsCollection()
      listener = editor.onDidUpdateDiff(sync)
      sync()
    },
    detach,
  }
}

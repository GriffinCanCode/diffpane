import { editor as monacoEditor } from 'monaco-editor/editor/editor.api.js';
import './review-focus.css';

const chevron = direction =>
  `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${direction === 'up' ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function createReviewFocus({ onScope }) {
  const bar = document.createElement('div');
  bar.className = 'review-hunk-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="review-hunk-summary" role="status">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h4m-2 5h7m-2 4h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      <span class="review-hunk-caption">Change</span><span class="review-hunk-position"></span>
    </div>
    <div class="review-hunk-navigation" role="group" aria-label="Changes in this file">
      <button type="button" class="review-hunk-prev" aria-label="Previous change in file" title="Previous change in file">${chevron('up')}</button>
      <button type="button" class="review-hunk-next" aria-label="Next change in file" title="Next change in file">${chevron('down')}</button>
    </div>
    <div class="review-hunk-modes" role="group" aria-label="Comparison context">
      <button type="button" class="review-focus-mode" aria-pressed="true" title="Collapse long stretches of unchanged lines">Focus changes</button>
      <button type="button" class="review-full-mode" aria-pressed="false" title="Show the entire file">Full file</button>
    </div>`;

  const position = bar.querySelector('.review-hunk-position');
  const caption = bar.querySelector('.review-hunk-caption');
  const previous = bar.querySelector('.review-hunk-prev');
  const next = bar.querySelector('.review-hunk-next');
  const focus = bar.querySelector('.review-focus-mode');
  const full = bar.querySelector('.review-full-mode');
  let editor;
  let labels;
  let listener;
  let originalMarker;
  let workingMarker;
  let scope = 'focus';
  let hunks = [];
  let index = 0;
  let collapsed = false;
  let frame = null;

  function paint(label = `${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`) {
    if (position.textContent !== label) position.textContent = label;
    caption.hidden = hunks.length === 0;
    previous.disabled = next.disabled = hunks.length < 2;
    focus.disabled = full.disabled = hunks.length === 0;
    focus.setAttribute('aria-pressed', String(scope === 'focus'));
    full.setAttribute('aria-pressed', String(scope === 'full'));
    const hunk = hunks[index];
    markLine(originalMarker, hunk?.originalStartLineNumber, hunk?.originalEndLineNumber);
    markLine(workingMarker, hunk?.modifiedStartLineNumber, hunk?.modifiedEndLineNumber);
  }

  function markLine(marker, line, end) {
    marker.set(
      end
        ? [
            {
              range: { startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: 1 },
              options: { isWholeLine: true, className: 'review-hunk-active' },
            },
          ]
        : [],
    );
  }

  function setCollapsed(enabled) {
    if (enabled === collapsed) return;
    collapsed = enabled;
    editor.updateOptions({
      ...labels,
      hideUnchangedRegions: {
        enabled,
        contextLineCount: 4,
        minimumLineCount: 5,
        revealLineCount: 16,
      },
    });
  }

  function reveal() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!editor || !hunks[index]) return;
      const working = editor.getModifiedEditor();
      // A deletion is reported at the preceding working line, which can be zero.
      const line = Math.max(
        1,
        Math.min(working.getModel().getLineCount(), hunks[index].modifiedStartLineNumber),
      );
      working.revealLineInCenter(line, monacoEditor.ScrollType.Immediate);
    });
  }

  function sync() {
    const changes = editor.getLineChanges();
    if (!changes) {
      paint('Finding changes…');
      return;
    }
    const anchor = hunks[index]?.modifiedStartLineNumber;
    hunks = changes;
    index = 0;
    for (let i = 1; anchor !== undefined && i < hunks.length; i++) {
      if (
        Math.abs(hunks[i].modifiedStartLineNumber - anchor) <
        Math.abs(hunks[index].modifiedStartLineNumber - anchor)
      )
        index = i;
    }
    setCollapsed(scope === 'focus' && hunks.length > 0);
    if (hunks.length) paint();
    else paint('No text changes');
    if (anchor === undefined && hunks.length) reveal();
  }

  function step(direction) {
    if (hunks.length < 2) return;
    index = (index + direction + hunks.length) % hunks.length;
    paint();
    reveal();
  }

  function chooseScope(value) {
    if (!editor || scope === value) return;
    scope = value;
    onScope(value);
    setCollapsed(value === 'focus' && hunks.length > 0);
    paint();
    reveal();
  }

  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  focus.addEventListener('click', () => chooseScope('focus'));
  full.addEventListener('click', () => chooseScope('full'));

  function detach() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    listener?.dispose();
    listener = null;
    originalMarker?.clear();
    workingMarker?.clear();
    originalMarker = workingMarker = null;
    editor = null;
    hunks = [];
    index = 0;
    collapsed = false;
    bar.hidden = true;
  }

  return {
    bar,
    attach(diffEditor, initialScope, ariaLabels) {
      if (editor === diffEditor) return;
      detach();
      editor = diffEditor;
      labels = ariaLabels;
      scope = initialScope;
      bar.hidden = false;
      originalMarker = editor.getOriginalEditor().createDecorationsCollection();
      workingMarker = editor.getModifiedEditor().createDecorationsCollection();
      listener = editor.onDidUpdateDiff(sync);
      sync();
    },
    detach,
  };
}

import { history, historyKeymap, isolateHistory, standardKeymap } from '@codemirror/commands'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { Annotation, Compartment, EditorState, Transaction, findClusterBreak } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import {
  adjacentSyntax,
  exitList,
  headingAnchor,
  ideaMarkdownExtension,
  linkInfo,
  toggleTask,
} from './idea-editor-markdown.ts'
import type { MarkdownNode, ResolveIdeaImage } from './idea-editor-markdown.ts'

export interface MarkdownReplacement {
  from: number
  to: number
  text: string
  selection?: [number, number]
}

interface IdeaEditorOptions {
  onChange: (source: string) => void
  onOpenLink: (href: string) => void
  onEnter?: (source: string, caret: number) => MarkdownReplacement | null
  onLimit?: () => void
  resolveImage?: ResolveIdeaImage
  maxLength: number
  placeholder: string
}

const EXTERNAL_CHANGE = Annotation.define<boolean>()

function deleteAtSyntax(view: EditorView, forward: boolean) {
  const { state } = view
  const caret = state.selection.main
  if (!caret.empty || state.readOnly || view.composing) return false
  const syntax = adjacentSyntax(view, caret.head, forward ? 1 : -1, true)
  if (!syntax) return false
  if (!syntax.formatting) {
    view.dispatch({
      changes: { from: syntax.from, to: syntax.to },
      userEvent: forward ? 'delete.forward' : 'delete.backward',
    })
    return true
  }

  // A formatting delimiter is invisible here. Delete the nearest visible grapheme
  // inside the formatted text rather than breaking the delimiters or deleting whitespace.
  const content = syntax.onContentSide ? caret.head : forward ? syntax.to : syntax.from
  const line = state.doc.lineAt(content)
  let from = forward ? content : findClusterBreak(line.text, content - line.from, false) + line.from
  let to = forward ? findClusterBreak(line.text, content - line.from) + line.from : content
  if (from === to) return false
  const formatting = syntax.formatting
  if (from === formatting.contentFrom && to === formatting.contentTo) {
    from = formatting.from
    to = formatting.to
  }
  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
    userEvent: forward ? 'delete.forward' : 'delete.backward',
    scrollIntoView: true,
  })
  return true
}

function moveIntoSyntax(view: EditorView, direction: -1 | 1) {
  const caret = view.state.selection.main
  if (!caret.empty || view.composing || getComputedStyle(view.contentDOM).direction === 'rtl') return false
  const syntax = adjacentSyntax(view, caret.head, direction)
  if (!syntax || syntax.onContentSide || syntax.to - syntax.from < 2) return false
  view.dispatch({ selection: { anchor: caret.head + direction }, scrollIntoView: true, userEvent: 'select' })
  return true
}

export function mountIdeaEditor(host: HTMLElement, options: IdeaEditorOptions) {
  const readOnly = new Compartment()
  let locked = false
  let selectedId: string | null = null

  function edit(view: EditorView, { from, to, text, selection }: MarkdownReplacement, userEvent: string) {
    if (view.state.readOnly || view.composing) return false
    const insert = view.state.toText(text)
    if (view.state.doc.length + insert.length - (to - from) > options.maxLength) {
      options.onLimit?.()
      return false
    }
    view.dispatch({
      changes: { from, to, insert },
      selection: selection
        ? { anchor: from + selection[0], head: from + selection[1] }
        : { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent,
      annotations: isolateHistory.of('full'),
    })
    return true
  }

  const extensions = [
    markdownLanguage.extension,
    ideaMarkdownExtension(options.resolveImage),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Idea text', spellcheck: 'true' }),
    placeholder(options.placeholder),
    history(),
    keymap.of([
      {
        key: 'Enter',
        run(view) {
          const caret = view.state.selection.main
          if (view.composing || view.state.readOnly || !caret.empty || !options.onEnter) return false
          const replacement = options.onEnter(view.state.doc.toString(), caret.head)
          if (!replacement) return false
          const text = replacement.text || exitList(view.state, replacement.from, replacement.to)
          edit(view, { ...replacement, text }, 'input.type')
          return true
        },
      },
      {
        key: 'Mod-Enter',
        run(view) {
          const caret = view.state.selection.main.head
          for (
            let node: MarkdownNode | null = syntaxTree(view.state).resolveInner(caret, -1);
            node;
            node = node.parent
          ) {
            const link = linkInfo(view.state, node)
            if (link && node.name !== 'Image') {
              options.onOpenLink(link.href)
              return true
            }
          }
          return toggleTask(view, caret)
        },
      },
      { key: 'Backspace', run: view => deleteAtSyntax(view, false) },
      { key: 'Delete', run: view => deleteAtSyntax(view, true) },
      { key: 'ArrowLeft', run: view => moveIntoSyntax(view, -1) },
      { key: 'ArrowRight', run: view => moveIntoSyntax(view, 1) },
      ...historyKeymap,
      ...standardKeymap,
    ]),
    EditorView.domEventHandlers({
      mousedown(event) {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.target instanceof Element &&
          event.target.closest('[data-idea-href]')
        ) {
          event.preventDefault()
          return true
        }
        return false
      },
      click(event) {
        if (!(event.metaKey || event.ctrlKey) || !(event.target instanceof Element)) return false
        const href = event.target.closest('[data-idea-href]')?.getAttribute('data-idea-href')
        if (!href) return false
        event.preventDefault()
        options.onOpenLink(href)
        return true
      },
    }),
    EditorState.changeFilter.of(transaction => {
      if (transaction.newDoc.length <= options.maxLength) return true
      options.onLimit?.()
      return false
    }),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(EXTERNAL_CHANGE)))
        options.onChange(update.state.doc.toString())
    }),
  ]

  function createState(source: string) {
    return EditorState.create({ doc: source, extensions: [...extensions, readOnly.of(readOnlyExtensions(locked))] })
  }

  const view = new EditorView({ state: createState(''), parent: host })

  return {
    setDocument(id: string | null, source: string) {
      if (selectedId !== id) {
        selectedId = id
        view.setState(createState(source))
        return
      }
      const insert = view.state.toText(source)
      if (view.state.doc.eq(insert)) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert },
        annotations: [Transaction.addToHistory.of(false), EXTERNAL_CHANGE.of(true)],
      })
    },
    setReadOnly(value: boolean) {
      if (value === locked) return
      locked = value
      view.dispatch({ effects: readOnly.reconfigure(readOnlyExtensions(locked)) })
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    contains: (target: EventTarget | null) => target instanceof Node && view.dom.contains(target),
    getSource: () => view.state.doc.toString(),
    getSelection: () => {
      const { from, to } = view.state.selection.main
      return { from, to }
    },
    replace(replacement: MarkdownReplacement) {
      if (!edit(view, replacement, 'input.format')) return false
      view.focus()
      return true
    },
    goToHeading(anchor: string) {
      const position = anchor ? headingAnchor(view.state, anchor) : 0
      if (position === undefined) return false
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start' }) })
      view.focus()
      return true
    },
    dispose() {
      view.destroy()
    },
  }
}

function readOnlyExtensions(value: boolean) {
  return [EditorState.readOnly.of(value), EditorView.editable.of(!value)]
}

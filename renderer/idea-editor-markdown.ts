import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';

const HIDDEN_SYNTAX = Decoration.replace({});
const MUTED_SYNTAX = Decoration.mark({ class: 'idea-editor-syntax' });
const INLINE_STYLES: ReadonlyMap<string, Decoration> = new Map([
  ['StrongEmphasis', Decoration.mark({ tagName: 'strong', class: 'idea-editor-strong' })],
  ['Emphasis', Decoration.mark({ tagName: 'em', class: 'idea-editor-emphasis' })],
  ['Strikethrough', Decoration.mark({ tagName: 's', class: 'idea-editor-strike' })],
  ['InlineCode', Decoration.mark({ tagName: 'code', class: 'idea-editor-inline-code' })],
]);
const INLINE_DELIMITERS = new Set(['EmphasisMark', 'StrikethroughMark']);
const QUOTE_LINE = Decoration.line({ class: 'idea-editor-quote' });
const CODE_LINE = Decoration.line({ class: 'idea-editor-code' });
const TABLE_LINE = Decoration.line({ class: 'idea-editor-table' });
const TABLE_HEADER = Decoration.line({ class: 'idea-editor-table-header' });
const TABLE_RULE = Decoration.line({ class: 'idea-editor-table-rule' });
const HEADING_NAME = /^(?:ATX|Setext)Heading([1-6])$/;
const HEADING_LINES = Array.from({ length: 6 }, (_, index) => {
  const level = String(index + 1);
  return Decoration.line({
    attributes: { class: `idea-editor-heading-${level}`, role: 'heading', 'aria-level': level },
  });
});

export type MarkdownNode = ReturnType<typeof syntaxTree>['topNode'];
export type ResolveIdeaImage = (href: string) => Promise<string | null>;

interface FormattingRange {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}

const FORMATTING_RANGES = new WeakMap<Decoration, FormattingRange>();

function formattingSyntax(
  node: { from: number; to: number },
  contentFrom: number,
  contentTo: number,
) {
  const decoration = Decoration.replace({});
  FORMATTING_RANGES.set(decoration, { from: node.from, to: node.to, contentFrom, contentTo });
  return decoration;
}

function sourceText(state: EditorState, { from, to }: { from: number; to: number }) {
  return state.doc.sliceString(from, to);
}

function urlValue(state: EditorState, url: MarkdownNode) {
  return sourceText(state, url)
    .replace(/^<|>$/g, '')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

function normalizedLabel(label: string) {
  return label.slice(1, -1).trim().replace(/\s+/g, ' ').toLowerCase();
}

const REFERENCES_BY_TREE = new WeakMap<ReturnType<typeof syntaxTree>, Map<string, string>>();

function getReferences(state: EditorState) {
  const tree = syntaxTree(state);
  const cached = REFERENCES_BY_TREE.get(tree);
  if (cached) return cached;
  const references = new Map<string, string>();
  tree.iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return;
      const label = node.node.getChild('LinkLabel');
      const url = node.node.getChild('URL');
      if (!label || !url) return;
      const key = normalizedLabel(sourceText(state, label));
      if (!references.has(key)) references.set(key, urlValue(state, url));
    },
  });
  REFERENCES_BY_TREE.set(tree, references);
  return references;
}

export function linkInfo(state: EditorState, node: MarkdownNode) {
  if (node.name === 'Link' || node.name === 'Image') {
    const [open, close] = node.getChildren('LinkMark');
    if (!open || !close || (node.name === 'Link' && open.to >= close.from)) return null;
    const url = node.getChild('URL');
    const reference = node.getChild('LinkLabel');
    const label =
      reference && reference.to - reference.from > 2
        ? reference
        : { from: open.from, to: close.to };
    const href = url
      ? urlValue(state, url)
      : getReferences(state).get(normalizedLabel(sourceText(state, label)));
    return href ? { href, from: open.to, to: close.from } : null;
  }

  if (node.name === 'Autolink') {
    const url = node.getChild('URL');
    if (!url) return null;
    const href = urlValue(state, url);
    return {
      href: href.includes('@') && !href.includes(':') ? `mailto:${href}` : href,
      from: url.from,
      to: url.to,
    };
  }

  if (
    node.name === 'URL' &&
    !['Link', 'LinkReference', 'Image', 'Autolink'].includes(node.parent?.name ?? '')
  ) {
    const url = urlValue(state, node);
    const href = url.startsWith('www.')
      ? `https://${url}`
      : /^[^:/]+@[^:/]+$/.test(url)
        ? `mailto:${url}`
        : url;
    return { href, from: node.from, to: node.to };
  }

  return null;
}

class ImageMarker extends WidgetType {
  readonly href: string;
  readonly label: string;
  readonly load: () => Promise<string | null>;

  constructor(href: string, label: string, load: () => Promise<string | null>) {
    super();
    this.href = href;
    this.label = label;
    this.load = load;
  }

  override eq(other: WidgetType) {
    return other instanceof ImageMarker && this.href === other.href && this.label === other.label;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement('span');
    wrapper.className = 'idea-editor-image';
    const fallback = document.createElement('span');
    fallback.className = 'idea-editor-image-placeholder';
    fallback.textContent = this.label;
    wrapper.append(fallback);
    const display = async () => {
      const url = await this.load();
      if (!url?.startsWith('diffpane-media://') || !wrapper.isConnected) return;
      const image = document.createElement('img');
      image.alt = this.label;
      image.draggable = false;
      image.loading = 'lazy';
      image.addEventListener(
        'load',
        () => {
          fallback.hidden = true;
          view.requestMeasure();
        },
        { once: true },
      );
      image.addEventListener('error', () => image.remove(), { once: true });
      wrapper.append(image);
      image.src = url;
    };
    void display().catch(() => {});
    return wrapper;
  }
}

class ListMarker extends WidgetType {
  readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  override eq(other: WidgetType) {
    return other instanceof ListMarker && this.text === other.text;
  }

  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'idea-editor-marker';
    marker.textContent = this.text;
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }
}

class RuleMarker extends WidgetType {
  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'idea-editor-rule';
    marker.setAttribute('role', 'separator');
    return marker;
  }
}

class TaskMarker extends WidgetType {
  readonly checked: boolean;
  readonly readOnly: boolean;

  constructor(checked: boolean, readOnly: boolean) {
    super();
    this.checked = checked;
    this.readOnly = readOnly;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof TaskMarker &&
      this.checked === other.checked &&
      this.readOnly === other.readOnly
    );
  }

  toDOM(view: EditorView) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'idea-editor-task';
    marker.tabIndex = -1;
    marker.disabled = this.readOnly;
    marker.setAttribute('role', 'checkbox');
    marker.setAttribute('aria-checked', String(this.checked));
    marker.setAttribute('aria-label', 'Checklist item');
    marker.title = this.checked ? 'Mark incomplete' : 'Mark complete';
    marker.addEventListener('mousedown', event => event.preventDefault());
    marker.addEventListener('click', () => toggleTask(view, view.posAtDOM(marker)));
    return marker;
  }
}

export function toggleTask(view: EditorView, position: number) {
  if (view.state.readOnly) return false;
  const line = view.state.doc.lineAt(position);
  let marker: { from: number; to: number } | undefined;
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name === 'TaskMarker' && node.from >= line.from && node.to <= line.to) {
        marker = { from: node.from + 1, to: node.to - 1 };
      }
    },
  });
  if (!marker) return false;
  view.dispatch({
    changes: { ...marker, insert: sourceText(view.state, marker) === ' ' ? 'x' : ' ' },
    userEvent: 'input.format',
    annotations: isolateHistory.of('full'),
  });
  return true;
}

function headingSlug(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-') || 'section'
  );
}

export function headingAnchor(state: EditorState, anchor: string) {
  const tree = ensureSyntaxTree(state, state.doc.length, 40) ?? syntaxTree(state);
  const existing = new Set<string>();
  let position: number | undefined;
  tree.iterate({
    enter(node) {
      if (position !== undefined || !HEADING_NAME.test(node.name)) return;
      const text = sourceText(state, node)
        .replace(/^#{1,6}(?:[\t ]+|$)/, '')
        .replace(/[\t ]+#+[\t ]*$/, '')
        .replace(/\n[\t ]*[-=]+[\t ]*$/, '')
        .replace(/!?\[([^\]]+)\](?:\([^)]+\)|\[[^\]]*\])/g, '$1');
      const base = headingSlug(text);
      let slug = base;
      for (let suffix = 1; existing.has(slug); suffix++) slug = `${base}-${suffix}`;
      existing.add(slug);
      if (slug === anchor) position = node.from;
    },
  });
  return position;
}

function makeDecorations(view: EditorView, resolveImage?: ResolveIdeaImage) {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const syntax: Range<Decoration>[] = [];
  const lineMarks = new Map<Decoration, Set<number>>();
  const selection = view.hasFocus ? state.selection.ranges : [];
  const { doc } = state;
  const intersects = (from: number, to: number) =>
    selection.some(range => range.from < to && range.to > from);

  function styleLine(decoration: Decoration, position: number) {
    const line = doc.lineAt(position).from;
    let marks = lineMarks.get(decoration);
    if (!marks) {
      marks = new Set();
      lineMarks.set(decoration, marks);
    }
    if (marks.has(line)) return;
    marks.add(line);
    decorations.push(decoration.range(line));
  }

  function styleLines(decoration: Decoration, from: number, to: number) {
    const first = doc.lineAt(from);
    const end = doc.lineAt(Math.max(from, to - 1)).number;
    for (let number = first.number; number <= end; number++)
      styleLine(decoration, doc.line(number).from);
  }

  function markSyntax(from: number, to: number, reveal: boolean, replacement = HIDDEN_SYNTAX) {
    if (from >= to) return;
    if (reveal) decorations.push(MUTED_SYNTAX.range(from, to));
    if (to > doc.lineAt(from).to) return;
    const range = replacement.range(from, to);
    syntax.push(range);
    if (!reveal) {
      atomic.push(range);
      decorations.push(range);
    }
  }

  function inlineSyntax(node: MarkdownNode, from: number, to: number) {
    const first = node.firstChild;
    const last = node.lastChild;
    const replacement =
      first && last && first.to < last.from
        ? formattingSyntax(node, first.to, last.from)
        : undefined;
    markSyntax(from, to, intersects(from, to), replacement);
  }

  const { from: viewportStart, to: viewportEnd } = view.viewport;
  syntaxTree(state).iterate({
    from: viewportStart,
    to: viewportEnd,
    enter(node) {
      const { name, from, to } = node;
      const parent = node.node.parent;
      const level = HEADING_NAME.exec(name)?.[1];
      if (level) {
        const decoration = HEADING_LINES[Number(level) - 1];
        if (decoration) styleLine(decoration, from);
      }

      const style = INLINE_STYLES.get(name);
      if (style && from < to) decorations.push(style.range(from, to));

      if (
        parent &&
        (INLINE_DELIMITERS.has(name) || (name === 'CodeMark' && parent.name === 'InlineCode'))
      ) {
        inlineSyntax(parent, from, to);
      } else if (name === 'HeaderMark') {
        if (parent?.name.startsWith('Setext')) markSyntax(from, to, intersects(from, to));
        else {
          const line = doc.lineAt(from);
          const opening = parent?.from === from;
          const paddedTo = opening
            ? to + (line.text.slice(to - line.from).match(/^[\t ]+/)?.[0].length ?? 0)
            : to;
          const paddedFrom = opening
            ? from
            : from - (line.text.slice(0, from - line.from).match(/[\t ]+$/)?.[0].length ?? 0);
          markSyntax(
            paddedFrom,
            paddedTo,
            intersects(paddedFrom, paddedTo) || (paddedTo === line.to && opening),
          );
        }
      } else if (name === 'Blockquote') {
        styleLines(QUOTE_LINE, Math.max(from, viewportStart), Math.min(to, viewportEnd));
      } else if (name === 'QuoteMark') {
        const end = sourceText(state, { from: to, to: Math.min(doc.length, to + 1) }).match(
          /^[\t ]/,
        )
          ? to + 1
          : to;
        markSyntax(from, end, intersects(from, end) || end === doc.lineAt(from).to);
      } else if (name === 'ListMark') {
        const isTask = parent?.getChild('Task');
        const label = sourceText(state, node);
        const listMarker = isTask
          ? HIDDEN_SYNTAX
          : Decoration.replace({ widget: new ListMarker(label.length === 1 ? '•' : label) });
        const end =
          isTask && doc.lineAt(from).to > to && /^[\t ]/.test(doc.sliceString(to, to + 1))
            ? to + 1
            : to;
        markSyntax(from, end, intersects(from, end) || end === doc.lineAt(from).to, listMarker);
      } else if (name === 'TaskMarker') {
        const checkbox = new TaskMarker(
          sourceText(state, node).toLowerCase() === '[x]',
          state.readOnly,
        );
        markSyntax(from, to, intersects(from, to), Decoration.replace({ widget: checkbox }));
      } else if (name === 'HorizontalRule') {
        markSyntax(
          from,
          to,
          intersects(from, to + 1),
          Decoration.replace({ widget: new RuleMarker() }),
        );
      } else if (name === 'FencedCode' || name === 'CodeBlock') {
        styleLines(CODE_LINE, Math.max(from, viewportStart), Math.min(to, viewportEnd));
      } else if (name === 'CodeMark' || name === 'CodeInfo' || name === 'TableDelimiter') {
        if (from < to) decorations.push(MUTED_SYNTAX.range(from, to));
        if (name === 'TableDelimiter' && parent?.name === 'Table') styleLine(TABLE_RULE, from);
      } else if (name === 'Table') {
        styleLines(TABLE_LINE, Math.max(from, viewportStart), Math.min(to, viewportEnd));
      } else if (name === 'TableHeader') {
        styleLine(TABLE_HEADER, from);
      } else if (name === 'Image' && resolveImage && !intersects(from, to)) {
        if (doc.lineAt(from).to < to) return;
        const image = linkInfo(state, node.node);
        if (!image || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(image.href)) return;
        const label = sourceText(state, image) || 'Image';
        const widget = new ImageMarker(image.href, label, () => resolveImage(image.href));
        markSyntax(from, to, false, Decoration.replace({ widget }));
      } else if (name === 'Link' || name === 'Autolink' || name === 'URL') {
        const link = linkInfo(state, node.node);
        if (!link) return;
        decorations.push(
          Decoration.mark({
            class: 'idea-editor-link',
            attributes: { 'data-idea-href': link.href, title: '⌘ or Ctrl-click to open' },
          }).range(link.from, link.to),
        );
        const replacement = formattingSyntax(node, link.from, link.to);
        markSyntax(from, link.from, intersects(from, link.from), replacement);
        markSyntax(link.to, to, intersects(link.to, to), replacement);
      }
    },
  });

  return {
    display: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
    syntax: Decoration.set(syntax, true),
  };
}

const IDEA_MARKDOWN = ViewPlugin.fromClass(
  class {
    decorations: ReturnType<typeof makeDecorations>;
    readonly resolveImage?: ResolveIdeaImage;

    constructor(view: EditorView, resolveImage?: ResolveIdeaImage) {
      if (resolveImage) {
        const resolved = new Map<string, Promise<string | null>>();
        this.resolveImage = href => {
          const cached = resolved.get(href);
          if (cached) return cached;
          const pending = Promise.resolve()
            .then(() => resolveImage(href))
            .catch(() => null);
          resolved.set(href, pending);
          return pending;
        };
      }
      this.decorations = makeDecorations(view, this.resolveImage);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.viewportChanged ||
        update.state.readOnly !== update.startState.readOnly ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = makeDecorations(update.view, this.resolveImage);
    }
  },
  {
    decorations: plugin => plugin.decorations.display,
    provide: plugin =>
      EditorView.atomicRanges.of(
        view => view.plugin(plugin)?.decorations.atomic ?? Decoration.none,
      ),
  },
);

export function ideaMarkdownExtension(resolveImage?: ResolveIdeaImage) {
  return IDEA_MARKDOWN.of(resolveImage);
}

export function adjacentSyntax(
  view: EditorView,
  position: number,
  side: -1 | 1,
  forDeletion = false,
) {
  let adjacent:
    | { from: number; to: number; formatting: FormattingRange | undefined; onContentSide: boolean }
    | undefined;
  const decorations = view.plugin(IDEA_MARKDOWN)?.decorations;
  const ranges = forDeletion ? decorations?.syntax : decorations?.atomic;
  ranges?.between(position, position, (from, to, decoration) => {
    if ((side === 1 ? from : to) === position) {
      adjacent = { from, to, formatting: FORMATTING_RANGES.get(decoration), onContentSide: false };
      return false;
    }
    const formatting = FORMATTING_RANGES.get(decoration);
    if (formatting && (side === 1 ? formatting.contentFrom : formatting.contentTo) === position) {
      adjacent = { from, to, formatting, onContentSide: true };
    }
    return undefined;
  });
  return adjacent;
}

export function exitList(state: EditorState, from: number, to: number) {
  if (!from || from === to || !state.doc.lineAt(from - 1).text.trim()) return '';
  let item: MarkdownNode | null = syntaxTree(state).resolveInner(Math.min(from + 1, to), -1);
  while (item && item.name !== 'ListItem') item = item.parent;
  if (item?.parent?.parent?.name !== 'Document' || !item.prevSibling) return '';
  return '\n';
}

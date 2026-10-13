import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { markdownTarget } from './markdown-paths.ts';
import './markdown-preview.css';

type MarkdownOptions = {
  filename: string;
  anchor?: string;
  scrollTop?: number;
  diagramHeights?: number[];
  onScroll?: (top: number) => void;
  onOpenFile: (target: { path: string; anchor: string }) => void;
  openExternal?: (href: string) => Promise<unknown>;
  media: (path: string) => Promise<{ type: string; url: string }>;
  colorize: (text: string, language: string) => Promise<string>;
};

let diagramId = 0;
let mermaidRuntime:
  | Promise<{
      render: (id: string, text: string, container: HTMLElement) => Promise<{ svg: string }>;
    }>
  | undefined;
function loadMermaid() {
  return (mermaidRuntime ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'dompurifyConfig',
        'themeCSS',
      ],
      suppressErrorRendering: true,
      theme: 'base',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 14,
      flowchart: { htmlLabels: false, curve: 'basis', padding: 18 },
      sequence: { useMaxWidth: true, actorMargin: 48, messageMargin: 36 },
      themeVariables: {
        darkMode: true,
        background: '#1c1e21',
        primaryColor: '#283c3c',
        primaryTextColor: '#e2e8e8',
        primaryBorderColor: '#517673',
        secondaryColor: '#303047',
        tertiaryColor: '#24272c',
        lineColor: '#86aaa7',
        textColor: '#d5dadd',
        mainBkg: '#283c3c',
        nodeBorder: '#517673',
        clusterBkg: '#202629',
        clusterBorder: '#414b50',
        edgeLabelBackground: '#1c1e21',
        actorBkg: '#283c3c',
        actorBorder: '#517673',
        actorTextColor: '#e2e8e8',
        actorLineColor: '#4f5c63',
        signalColor: '#a8c5c2',
        signalTextColor: '#d5dadd',
        labelBoxBkgColor: '#24272c',
        labelBoxBorderColor: '#414b50',
        labelTextColor: '#d5dadd',
        loopTextColor: '#d5dadd',
        noteBkgColor: '#33312b',
        noteBorderColor: '#726849',
        noteTextColor: '#e1d9bd',
      },
    });
    return mermaid;
  }));
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string | null,
) {
  const element = document.createElement(tag);
  element.className = className;
  if (text != null) element.textContent = text;
  return element;
}
const glyphs = {
  copy: '<rect x="6" y="6" width="10" height="11" rx="2"/><path d="M12 3H4a1 1 0 0 0-1 1v9"/>',
  expand: '<path d="M12 3h5v5M17 3l-6 6M8 17H3v-5M3 17l6-6"/>',
};
function button(label: string, icon: keyof typeof glyphs | null, action: () => void) {
  const control = node('button', 'md-action', icon ? null : label);
  control.type = 'button';
  control.title = label;
  control.setAttribute('aria-label', label);
  if (icon)
    control.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[icon]}</svg>`;
  control.addEventListener('click', action);
  return control;
}
function copyButton(source: string) {
  const control = button('Copy code', 'copy', async () => {
    try {
      await navigator.clipboard.writeText(source);
      control.dataset.copied = 'true';
      control.title = 'Copied';
      control.setAttribute('aria-label', 'Copied');
    } catch {
      control.title = 'Copy unavailable';
      control.setAttribute('aria-label', 'Copy unavailable');
    }
  });
  return control;
}

/** Owns the rendered document and all asynchronous diagram work for one file. */
export function showMarkdownPreview(host: ParentNode, source: string, options: MarkdownOptions) {
  let disposed = false;
  let expanded: (() => void) | null = null;
  const diagrams: HTMLElement[] = [];
  const root = node('div', 'markdown-preview');
  root.tabIndex = 0;
  root.setAttribute('aria-label', 'Markdown preview');
  const article = node('article', 'markdown-body');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  article.innerHTML = DOMPurify.sanitize(marked.parse(body, { gfm: true }) as string, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'video', 'audio'],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'autofocus'],
  });
  if (frontmatter) {
    const metadata = node('details', 'md-frontmatter');
    const pre = node('pre', '');
    pre.append(node('code', 'language-yaml', frontmatter[1]));
    metadata.append(node('summary', '', 'Document metadata'), pre);
    article.append(metadata);
  }
  root.append(article);
  host.replaceChildren(root);

  const scrollToAnchor = (anchor: string) => {
    const target = [...article.querySelectorAll('[id]')].find(element => element.id === anchor);
    target?.scrollIntoView({ block: 'start' });
  };
  const slugs = new Map<string, number>();
  for (const heading of article.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base =
      heading
        .textContent!.toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/\s/g, '-') || 'section';
    const count = slugs.get(base) ?? 0;
    slugs.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
    const anchor = node('a', 'md-heading-anchor', '#');
    anchor.href = `#${heading.id}`;
    anchor.setAttribute('aria-label', `Link to ${heading.textContent}`);
    heading.append(anchor);
  }
  for (const table of article.querySelectorAll('table')) {
    const wrapper = node('div', 'md-table-scroll');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Scrollable table');
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  for (const input of article.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove();
    else {
      input.disabled = true;
      input.closest('li')?.classList.add('md-task');
    }
  }
  for (const quote of article.querySelectorAll('blockquote')) {
    const first = quote.querySelector('p');
    const match = first?.textContent?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
    if (!first || !match) continue;
    quote.classList.add('md-callout');
    quote.dataset.tone = match[1]!.toLowerCase();
    // Keep inline formatting after the marker.
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (text) text.textContent = text.textContent!.replace(/^\[!\w+\]\s*/, '');
    quote.prepend(node('div', 'md-callout-label', match[1]!.toLowerCase()));
  }
  for (const link of article.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    link.addEventListener('click', event => {
      event.preventDefault();
      const target = markdownTarget(options.filename, href);
      if (target?.path === options.filename) scrollToAnchor(target.anchor);
      else if (target) options.onOpenFile(target);
      else if (/^(https?:|mailto:)/i.test(href ?? ''))
        void options.openExternal?.(href!).catch(() => {});
    });
  }
  for (const image of article.querySelectorAll('img')) {
    const target = markdownTarget(options.filename, image.getAttribute('src'));
    image.removeAttribute('src');
    image.loading = 'lazy';
    image.addEventListener('error', () => image.classList.add('md-image-missing'), { once: true });
    if (target) {
      void options
        .media(target.path)
        .then(media => {
          if (!disposed && media.type.startsWith('image/')) image.src = media.url;
        })
        .catch(() => image.classList.add('md-image-missing'));
    } else image.classList.add('md-image-missing');
  }

  for (const pre of article.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const language =
      [...code.classList].find(name => name.startsWith('language-'))?.slice(9) ?? 'text';
    const text = code.textContent!.replace(/\n$/, '');
    const diagram = language.toLowerCase() === 'mermaid';
    const block = node('section', diagram ? 'md-block md-diagram' : 'md-block');
    const toolbar = node('div', 'md-block-toolbar');
    toolbar.append(node('span', 'md-block-label', diagram ? 'Mermaid' : language));
    const actions = node('div', 'md-block-actions');
    toolbar.append(actions);
    actions.append(copyButton(text));
    pre.replaceWith(block);
    block.append(toolbar, pre);
    if (!diagram) {
      if (language !== 'text') {
        void options
          .colorize(text, language)
          .then(html => {
            if (!disposed) code.innerHTML = DOMPurify.sanitize(html);
          })
          .catch(() => {});
      }
      continue;
    }
    pre.hidden = true;
    const canvas = node('div', 'md-diagram-canvas');
    const reservedHeight = options.diagramHeights?.[diagrams.length];
    if (reservedHeight) canvas.style.minHeight = `${reservedHeight}px`;
    diagrams.push(canvas);
    const status = node('span', 'md-diagram-status', 'Rendering diagram…');
    canvas.append(status);
    block.append(canvas);
    const sourceToggle = button('Source', null, () => {
      pre.hidden = !pre.hidden;
      canvas.hidden = !pre.hidden;
      sourceToggle.textContent = pre.hidden ? 'Source' : 'Diagram';
      sourceToggle.setAttribute('aria-label', sourceToggle.textContent);
      sourceToggle.title = sourceToggle.textContent;
      sourceToggle.setAttribute('aria-pressed', String(!pre.hidden));
    });
    sourceToggle.setAttribute('aria-pressed', 'false');
    actions.prepend(sourceToggle);
    void (async () => {
      const scratch = node('div', 'md-render-scratch');
      try {
        const mermaid = await loadMermaid();
        if (disposed) return;
        document.body.append(scratch);
        const { svg } = await mermaid.render(`md-diagram-${++diagramId}`, text, scratch);
        if (disposed) return;
        canvas.innerHTML = svg;
        const graphic = canvas.querySelector('svg')!;
        graphic.setAttribute('role', 'img');
        if (!graphic.querySelector('title')) graphic.setAttribute('aria-label', 'Mermaid diagram');
        // Fit wide diagrams in the reading column. Expansion restores their natural dimensions.
        graphic.removeAttribute('height');
        graphic.removeAttribute('width');
        canvas.style.minHeight = '';
        actions.insertBefore(
          button('Expand diagram', 'expand', () => {
            expanded?.();
            expanded = expandDiagram(graphic);
          }),
          actions.lastChild,
        );
        if (options.anchor) scrollToAnchor(options.anchor);
      } catch (error) {
        if (!disposed) {
          status.textContent = 'This diagram could not be rendered. Check its Mermaid syntax.';
          status.title = error instanceof Error ? error.message : String(error);
          block.classList.add('md-diagram-error');
          pre.hidden = false;
          sourceToggle.hidden = true;
        }
      } finally {
        scratch.remove();
      }
    })();
  }
  root.scrollTop = options.scrollTop ?? 0;
  if (options.anchor) scrollToAnchor(options.anchor);
  return () => {
    disposed = true;
    options.onScroll?.(root.scrollTop);
    if (options.diagramHeights)
      options.diagramHeights.splice(
        0,
        options.diagramHeights.length,
        ...diagrams.map(canvas => canvas.getBoundingClientRect().height),
      );
    expanded?.();
    root.remove();
  };
}

function expandDiagram(graphic: SVGSVGElement) {
  const previous = document.activeElement;
  const dialog = node('dialog', 'md-diagram-dialog');
  dialog.setAttribute('aria-label', 'Expanded Mermaid diagram');
  const toolbar = node('div', 'md-block-toolbar');
  toolbar.append(node('span', 'md-block-label', 'Mermaid diagram'));
  const actions = node('div', 'md-block-actions');
  toolbar.append(actions);
  const viewport = node('div', 'md-diagram-viewport');
  const image = node('img', 'md-expanded-image');
  image.alt = 'Expanded Mermaid diagram';
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(graphic)], { type: 'image/svg+xml' }),
  );
  image.src = url;
  viewport.append(image);
  dialog.append(toolbar, viewport);
  document.body.append(dialog);
  const bounds = graphic.viewBox.baseVal;
  let zoom = 1;
  const setZoom = (value: number) => {
    zoom = Math.max(0.1, Math.min(4, value));
    image.style.width = `${bounds.width * zoom}px`;
    image.style.height = `${bounds.height * zoom}px`;
  };
  const fit = () =>
    setZoom(
      Math.min(
        1,
        (viewport.clientWidth - 64) / bounds.width,
        (viewport.clientHeight - 64) / bounds.height,
      ),
    );
  const close = () => {
    dialog.close();
    dialog.remove();
    URL.revokeObjectURL(url);
    if (previous?.isConnected) (previous as HTMLElement).focus();
  };
  actions.append(
    button('Zoom out', null, () => setZoom(zoom / 1.25)),
    button('Fit', null, fit),
    button('Zoom in', null, () => setZoom(zoom * 1.25)),
    button('Close', null, close),
  );
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });
  dialog.showModal();
  fit();
  return close;
}

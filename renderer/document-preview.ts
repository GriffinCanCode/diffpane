import { showMedia } from './media.ts';

type PreviewSide = {
  size: number;
  note?: string | null;
  kind?: string;
  hex?: string;
  hexBytes?: number;
  value?: string;
  data?: string;
  mime?: string;
};

type PreviewMedia = { url: string; type: string };

/** Native previews with an always available byte fallback. Owns all URLs and playback. */
export function showDocumentPreview(
  host: ParentNode,
  preview: { before?: PreviewSide; after?: PreviewSide },
  filename: string,
  compare = false,
  currentMedia: PreviewMedia | null = null,
  options: { raw?: boolean; onRawChange?: (raw: boolean) => void } = {},
) {
  const root = document.createElement('div');
  root.className = 'document-preview';
  const toolbar = document.createElement('div');
  toolbar.className = 'preview-toolbar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'preview-byte-toggle';
  toggle.textContent = 'Hex';
  toggle.setAttribute('aria-label', 'Inspect raw bytes');
  toggle.setAttribute('aria-pressed', 'false');
  const hint = document.createElement('span');
  hint.textContent = 'Preview';
  toolbar.append(hint, toggle);
  const panes = document.createElement('div');
  panes.className = 'preview-panes';
  panes.dataset.compare = String(compare);
  root.append(toolbar, panes);
  host.replaceChildren(root);
  let raw = options.raw ?? false;
  let cleanups: (() => void)[] = [];

  function clear() {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    panes.replaceChildren();
  }

  function render() {
    clear();
    toggle.setAttribute('aria-pressed', String(raw));
    hint.textContent = raw ? 'Hexadecimal · ASCII' : 'Preview';
    for (const side of compare ? (['before', 'after'] as const) : (['after'] as const)) {
      const value = preview[side]!;
      const pane = document.createElement('section');
      pane.className = 'preview-pane';
      pane.dataset.side = side;
      const heading = document.createElement('div');
      heading.className = 'preview-heading';
      heading.textContent = `${side === 'before' ? 'Original · HEAD' : 'Current · working file'} · ${value.size.toLocaleString()} bytes`;
      pane.append(heading);
      const note = document.createElement('p');
      note.className = 'preview-note';
      note.textContent = value.note ?? '';
      note.hidden = !note.textContent;
      pane.append(note);
      const body = document.createElement('div');
      body.className = 'preview-body';
      pane.append(body);
      panes.append(pane);
      const bytes = () => {
        const pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.tabIndex = 0;
        pre.setAttribute('aria-label', `Contents of ${filename}`);
        pre.textContent =
          (raw || value.kind !== 'text' ? value.hex : value.value) ?? value.value ?? '';
        body.replaceChildren(pre);
        if (value.hexBytes! < value.size && (raw || value.kind === 'binary')) {
          note.textContent = `Showing the first ${value.hexBytes!.toLocaleString()} of ${value.size.toLocaleString()} bytes.`;
          note.hidden = false;
        }
      };
      if (!value.size) {
        body.textContent = 'Empty or absent file.';
      } else if (
        raw ||
        value.kind === 'text' ||
        (value.kind === 'binary' && !(side === 'after' && currentMedia))
      ) {
        bytes();
      } else {
        let media = side === 'after' ? currentMedia : null;
        if (!media && value.data) {
          const data = Uint8Array.from(atob(value.data), character => character.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([data], { type: value.mime }));
          cleanups.push(() => URL.revokeObjectURL(url));
          media = { url, type: value.mime! };
        }
        const failed = () => {
          note.hidden = false;
          note.textContent = 'This format or codec cannot be displayed. Showing raw bytes.';
          bytes();
        };
        if (!media) {
          failed();
          continue;
        }
        if (media.type.startsWith('image/') || media.type.startsWith('video/')) {
          cleanups.push(
            showMedia(body, media, filename, {
              onReady: description => {
                heading.textContent += ` · ${description}`;
              },
              onError: failed,
            }),
          );
        } else if (media.type.startsWith('audio/')) {
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.preload = 'metadata';
          audio.setAttribute('aria-label', filename);
          audio.addEventListener('error', failed, { once: true });
          audio.src = media.url;
          body.append(audio);
          cleanups.push(() => {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
          });
        } else if (media.type === 'application/pdf') {
          const frame = document.createElement('iframe');
          frame.className = 'preview-pdf';
          frame.title = `PDF preview of ${filename}`;
          frame.src = media.url;
          body.append(frame);
          cleanups.push(() => frame.remove());
        } else failed();
      }
    }
  }
  toggle.addEventListener('click', () => {
    raw = !raw;
    options.onRawChange?.(raw);
    render();
  });
  render();
  return () => {
    clear();
    root.remove();
  };
}

import { createSearchFilters, searchableEntries, type LanguageFor } from './search-filters.ts';
import { createFileSearch } from './search-runtime.ts';
import { projectIcon } from './icons.ts';

type PickerFile = { path: string; directory?: boolean };
type PickerMatch = { file: PickerFile; positions: number[] };
type PickerApi = {
  files: () => Promise<PickerFile[]>;
  onChange?: (callback: (snapshot: { inventoryRevision?: number }) => void) => () => void;
};

const ROW_HEIGHT = 54;

/** A searchable file inventory with a bounded number of mounted rows. */
export function createFilePicker(
  api: PickerApi,
  onSelect: (file: PickerFile) => void,
  context: () => string = () => '',
  languageFor?: LanguageFor,
  basePath: () => string = () => '',
) {
  const dialog = document.createElement('dialog');
  dialog.id = 'file-picker';
  dialog.className = 'file-picker';
  dialog.setAttribute('aria-labelledby', 'picker-title');
  dialog.innerHTML = `<header class="picker-heading"><div><h2 id="picker-title">Search files</h2><p class="picker-context"></p></div><button type="button" class="picker-close" aria-label="Close file search" title="Close · Escape">×</button></header><div class="picker-search"><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="7.8" cy="7.8" r="4.6" stroke="currentColor" stroke-width="1.4"/><path d="m11.3 11.3 3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input id="file-search" placeholder="Search files, folders, or paths…" aria-label="Search files" role="combobox" aria-autocomplete="list" aria-controls="file-list" aria-expanded="true" autocomplete="off" spellcheck="false"><button type="button" class="picker-clear" aria-label="Clear file search" hidden>Clear</button><kbd>esc</kbd></div><div class="picker-filter-host"></div><div class="picker-summary" role="status" aria-live="polite">Reading files…</div><div class="picker-results"><div id="file-list" class="picker-list" role="listbox" aria-label="Project files"><div class="picker-rows"></div></div><div class="picker-empty" hidden><strong></strong><p></p><button type="button" class="open-button picker-retry" hidden>Try again</button></div></div><footer class="picker-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>↵</kbd> Open</span><span>Tracked + untracked</span></footer>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector('input') as HTMLInputElement;
  const list = dialog.querySelector('.picker-list') as HTMLElement;
  const rows = dialog.querySelector('.picker-rows') as HTMLElement;
  const summary = dialog.querySelector('.picker-summary') as HTMLElement;
  const empty = dialog.querySelector('.picker-empty') as HTMLElement;
  const clear = dialog.querySelector('.picker-clear') as HTMLButtonElement;
  const retry = dialog.querySelector('.picker-retry') as HTMLButtonElement;
  const search = createFileSearch<PickerFile>();
  const filters = createSearchFilters(
    dialog.querySelector('.picker-filter-host') as HTMLElement,
    () => {
      search.setFiles(inventory.filter(filters.matches));
      filter();
    },
    languageFor,
  );
  let filterGeneration = 0;
  let inventory: PickerFile[] = [];
  let matches: PickerMatch[] = [];
  let selected = 0;
  let request = 0;
  let loading = false;
  let failure = '';
  let frame: number | undefined;
  let inventoryRevision: number | undefined;
  const unsubscribe = api.onChange?.(snapshot => {
    if (snapshot.inventoryRevision === inventoryRevision) return;
    inventoryRevision = snapshot.inventoryRevision;
    if (dialog.open) void load(true);
  });
  window.addEventListener('beforeunload', () => unsubscribe?.(), { once: true });

  function filter(keepSelection: boolean | undefined = false) {
    const selectedPath = keepSelection === true ? matches[selected]?.file.path : null;
    const generation = ++filterGeneration;
    const results = search.search(input.value);
    if (results instanceof Promise) {
      summary.textContent = 'Searching project files…';
      list.setAttribute('aria-busy', 'true');
      if (!selectedPath) matches = [];
      render();
      results
        .then(results => {
          if (!results || generation !== filterGeneration || !dialog.open) return;
          applyResults(results, selectedPath);
        })
        .catch((error: { message?: string }) => {
          if (generation !== filterGeneration || !dialog.open) return;
          failure = error.message ?? '';
          applyResults([]);
        });
    } else applyResults(results, selectedPath);
  }

  function applyResults(results: PickerMatch[], selectedPath?: string | null) {
    matches = results;
    const previous = selectedPath
      ? matches.findIndex(match => match.file.path === selectedPath)
      : -1;
    selected = Math.max(0, previous);
    if (previous < 0) list.scrollTop = 0;
    clear.hidden = !input.value;
    summary.textContent = loading
      ? 'Reading project files…'
      : failure
        ? 'File search unavailable'
        : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'item' : 'items'}${input.value.trim() ? ` found · ${inventory.length.toLocaleString()} in project` : ' in project'}`;
    empty.hidden = matches.length > 0;
    empty.querySelector('strong')!.textContent = loading
      ? 'Reading your project'
      : failure
        ? 'Couldn’t load files'
        : input.value.trim()
          ? 'No files or folders found'
          : 'No files to show';
    empty.querySelector('p')!.textContent = loading
      ? 'Your files will appear here in a moment.'
      : failure ||
        (input.value.trim()
          ? 'Try a shorter name, a path, or reset the filters.'
          : 'Tracked and nonignored files will appear here.');
    retry.hidden = !failure;
    list.setAttribute('aria-busy', String(loading));
    render();
  }

  function highlight(element: HTMLElement, text: string, offset: number, positions: Set<number>) {
    let marked: boolean | undefined;
    Array.from(text).forEach((char, index) => {
      const active = positions.has(index + offset);
      if (active !== marked || !element.lastChild)
        element.appendChild(document.createElement(active ? 'mark' : 'span'));
      element.lastChild!.appendChild(document.createTextNode(char));
      marked = active;
    });
  }

  function render() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    const height = list.clientHeight || 380;
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - 3);
    const end = Math.min(matches.length, start + Math.ceil(height / ROW_HEIGHT) + 6);
    rows.style.height = `${matches.length * ROW_HEIGHT}px`;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index++) {
      const { file, positions } = matches[index]!;
      const button = document.createElement('button');
      button.className = 'picker-file';
      button.id = `picker-file-${index}`;
      button.type = 'button';
      button.tabIndex = -1;
      button.dataset.path = file.path;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === selected));
      button.setAttribute('aria-posinset', String(index + 1));
      button.setAttribute('aria-setsize', String(matches.length));
      button.style.top = `${index * ROW_HEIGHT}px`;
      button.title = file.path;
      const slash = file.path.lastIndexOf('/');
      const filename = file.path.slice(slash + 1);
      const icon = document.createElement('img');
      icon.src = projectIcon({
        kind: file.directory ? 'directory' : 'file',
        name: filename,
      }) as string;
      icon.alt = '';
      const label = document.createElement('div');
      label.className = 'picker-file-label';
      const name = document.createElement('strong');
      const directory = document.createElement('small');
      const highlights = new Set(positions);
      highlight(name, filename, Array.from(file.path.slice(0, slash + 1)).length, highlights);
      highlight(
        directory,
        (file.path.slice(0, slash + 1) || './') + (file.directory ? ' · Folder' : ''),
        0,
        highlights,
      );
      label.append(name, directory);
      const enter = document.createElement('span');
      enter.className = 'picker-enter';
      enter.textContent = '↵';
      enter.setAttribute('aria-hidden', 'true');
      button.append(icon, label, enter);
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => choose(index));
      fragment.appendChild(button);
    }
    rows.replaceChildren(fragment);
    if (document.getElementById(`picker-file-${selected}`))
      input.setAttribute('aria-activedescendant', `picker-file-${selected}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function choose(index: number) {
    const result = matches[index];
    if (!result) return;
    dialog.close();
    onSelect(result.file);
  }

  function move(index: number) {
    selected = Math.max(0, Math.min(matches.length - 1, index));
    const top = selected * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
    render();
  }

  input.addEventListener('input', () => filter());
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT));
    const destinations: Record<string, number> = {
      ArrowDown: selected + 1,
      ArrowUp: selected - 1,
      PageDown: selected + page,
      PageUp: selected - page,
    };
    if (event.key in destinations) {
      event.preventDefault();
      move(destinations[event.key]);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(selected);
    }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    filter();
    input.focus();
  });
  (dialog.querySelector('.picker-close') as HTMLButtonElement).addEventListener('click', () =>
    dialog.close(),
  );
  retry.addEventListener('click', () => {
    void load();
    input.focus();
  });
  list.addEventListener(
    'scroll',
    () => {
      if (dialog.open && frame === undefined) frame = requestAnimationFrame(render);
    },
    { passive: true },
  );
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      dialog.close();
  });
  dialog.addEventListener('close', () => {
    request++;
    filterGeneration++;
    search.dispose();
    inventory = [];
    matches = [];
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    rows.replaceChildren();
    rows.style.height = '0px';
    input.removeAttribute('aria-activedescendant');
  });
  window.addEventListener('beforeunload', () => search.dispose(), { once: true });
  new ResizeObserver(() => {
    if (dialog.open) move(selected);
  }).observe(list);

  async function load(refresh = false) {
    const generation = ++request;
    if (!refresh) {
      inventory = [];
      search.setFiles(inventory);
    }
    loading = true;
    failure = '';
    if (refresh) summary.textContent = 'Refreshing project files…';
    else filter();
    try {
      const files = await api.files();
      if (!dialog.open || generation !== request) return;
      inventory = searchableEntries(files, basePath());
      filters.update(inventory);
      search.setFiles(inventory.filter(filters.matches));
      loading = false;
      filter(refresh);
    } catch (error) {
      if (dialog.open && generation === request) {
        loading = false;
        failure = (error as { message?: string }).message || String(error);
        filter(refresh);
      }
    }
  }

  return async function open() {
    if (dialog.open) {
      input.focus();
      input.select();
      return;
    }
    input.value = '';
    (dialog.querySelector('.picker-context') as HTMLElement).textContent = context();
    dialog.showModal();
    input.focus();
    await load();
  };
}

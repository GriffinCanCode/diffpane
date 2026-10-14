export type SearchEntry = { path: string; directory?: boolean };
export type SearchFilters = { kind: string; language: string; extension: string; folder: string };
export type LanguageFor = (path: string) => string;
export const emptyFilters = (): SearchFilters => ({
  kind: 'all',
  language: '',
  extension: '',
  folder: '',
});
export const hasFilters = (filters: SearchFilters) =>
  filters.kind !== 'all' || Boolean(filters.language || filters.extension || filters.folder);
export function fileExtension(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLocaleLowerCase() : '(no extension)';
}
export function matchesFilters(
  entry: SearchEntry,
  filters: SearchFilters,
  languageFor: LanguageFor = () => 'Plain text',
) {
  if (filters.kind === 'files' && entry.directory) return false;
  if (filters.kind === 'folders' && !entry.directory) return false;
  if (filters.language && (entry.directory || languageFor(entry.path) !== filters.language))
    return false;
  if (filters.extension && (entry.directory || fileExtension(entry.path) !== filters.extension))
    return false;
  const folder = filters.folder
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/\/+$/u, '')
    .toLocaleLowerCase();
  return (
    !folder ||
    entry.path.toLocaleLowerCase().startsWith(`${folder}/`) ||
    (entry.directory === true && entry.path.toLocaleLowerCase() === folder)
  );
}

/** Include each known folder once without scanning ignored directories on disk. */
export function searchableEntries<T extends SearchEntry>(
  files: readonly T[],
  basePath = '',
): (T | SearchEntry)[] {
  const entries = new Map<string, T | SearchEntry>();
  for (const file of files) {
    if (basePath && !file.path.startsWith(`${basePath}/`)) continue;
    if (!file.directory) entries.set(`file:${file.path}`, file);
    else entries.set(`dir:${file.path}`, file);
    let slash = file.path.lastIndexOf('/');
    while (slash > 0) {
      const path = file.path.slice(0, slash);
      if (basePath && (path === basePath || !path.startsWith(`${basePath}/`))) break;
      if (!entries.has(`dir:${path}`)) entries.set(`dir:${path}`, { path, directory: true });
      slash = path.lastIndexOf('/');
    }
  }
  return [...entries.values()];
}

export function createSearchFilters(
  host: HTMLElement,
  onChange: () => void,
  languageFor: LanguageFor = () => 'Plain text',
) {
  const bar = document.createElement('div');
  bar.className = 'search-filter-bar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'search-filter-toggle';
  toggle.textContent = 'Filters';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Search filters');
  const panel = document.createElement('div');
  panel.className = 'search-filter-panel';
  panel.hidden = true;
  const controls = new Map<string, HTMLSelectElement | HTMLInputElement>();
  for (const [key, title] of [
    ['kind', 'Show'],
    ['language', 'Language'],
    ['extension', 'File type'],
    ['folder', 'Folder'],
  ]) {
    const label = document.createElement('label');
    label.append(document.createTextNode(title));
    const control =
      key === 'folder' ? document.createElement('input') : document.createElement('select');
    control.setAttribute('aria-label', title);
    control.dataset.filter = key;
    if (control instanceof HTMLInputElement) {
      control.placeholder = 'Folder path…';
      control.type = 'search';
    }
    controls.set(key, control);
    label.append(control);
    panel.append(label);
    control.addEventListener(key === 'folder' ? 'input' : 'change', () => {
      updateLabel();
      onChange();
    });
  }
  const kind = controls.get('kind') as HTMLSelectElement;
  for (const [value, label] of [
    ['all', 'Files and folders'],
    ['files', 'Files only'],
    ['folders', 'Folders only'],
  ])
    kind.add(new Option(label, value));
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'search-filter-reset';
  reset.textContent = 'Reset filters';
  panel.append(reset);
  bar.append(toggle, panel);
  host.append(bar);
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  const value = () =>
    Object.fromEntries(
      [...controls].map(([key, control]) => [key, control.value]),
    ) as SearchFilters;
  function updateLabel() {
    const filters = value();
    const count =
      Number(filters.kind !== 'all') +
      Number(Boolean(filters.language)) +
      Number(Boolean(filters.extension)) +
      Number(Boolean(filters.folder));
    toggle.textContent = count ? `Filters · ${count}` : 'Filters';
    toggle.dataset.active = String(count > 0);
  }
  reset.addEventListener('click', () => {
    for (const [key, control] of controls) control.value = key === 'kind' ? 'all' : '';
    updateLabel();
    onChange();
  });
  return {
    value,
    reset() {
      for (const [key, control] of controls) control.value = key === 'kind' ? 'all' : '';
      updateLabel();
    },
    active: () => hasFilters(value()),
    matches: (entry: SearchEntry) => matchesFilters(entry, value(), languageFor),
    update(entries: readonly SearchEntry[]) {
      const languages = new Set<string>();
      const extensions = new Set<string>();
      for (const entry of entries)
        if (!entry.directory) {
          languages.add(languageFor(entry.path));
          extensions.add(fileExtension(entry.path));
        }
      for (const [key, options, label] of [
        ['language', languages, 'All languages'],
        ['extension', extensions, 'All file types'],
      ] as const) {
        const select = controls.get(key) as HTMLSelectElement;
        const selected = select.value;
        select.replaceChildren(new Option(label, ''));
        for (const option of [...options].sort((a, b) => a.localeCompare(b)))
          select.add(new Option(option, option));
        if (options.has(selected)) select.value = selected;
      }
      updateLabel();
    },
  };
}

const ROW_HEIGHT = 38;

/** A searchable file inventory with a bounded number of mounted rows. */
export function createFilePicker(api, onSelect) {
  const dialog = document.createElement('dialog');
  dialog.id = 'file-picker';
  dialog.className = 'file-picker';
  dialog.setAttribute('aria-label', 'Open a file');
  dialog.innerHTML = `<div class="picker-search"><svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="7.8" cy="7.8" r="4.6" stroke="currentColor" stroke-width="1.4"/><path d="m11.3 11.3 3.3 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input id="file-search" placeholder="Search files by name or path…" aria-label="Search files" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div><div class="picker-summary" role="status">Reading files…</div><div id="file-list" class="picker-list" role="listbox" aria-label="Project files"><div class="picker-rows"></div></div><div class="picker-footer"><span>↑ ↓ to navigate · ↵ to open</span><span>Tracked and untracked files</span></div>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector('input');
  const list = dialog.querySelector('.picker-list');
  const rows = dialog.querySelector('.picker-rows');
  const summary = dialog.querySelector('.picker-summary');
  let inventory = [];
  let matches = [];
  let selected = 0;
  let request = 0;
  let loading = false;
  let scheduled = false;

  function filter() {
    const query = input.value.toLocaleLowerCase();
    matches = inventory.filter(file => file.path.toLocaleLowerCase().includes(query));
    selected = 0;
    list.scrollTop = 0;
    summary.textContent = loading ? 'Reading files…' : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'file' : 'files'}${query ? ` matching “${input.value}”` : ' in this directory'}`;
    render();
  }

  function render() {
    scheduled = false;
    const height = list.clientHeight || 380;
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - 3);
    const end = Math.min(matches.length, start + Math.ceil(height / ROW_HEIGHT) + 6);
    rows.style.height = `${matches.length * ROW_HEIGHT}px`;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index++) {
      const file = matches[index];
      const button = document.createElement('button');
      button.className = 'picker-file';
      button.type = 'button';
      button.dataset.path = file.path;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === selected));
      button.style.top = `${index * ROW_HEIGHT}px`;
      button.title = file.path;
      const slash = file.path.lastIndexOf('/');
      const name = document.createElement('strong');
      name.textContent = file.path.slice(slash + 1);
      const directory = document.createElement('span');
      directory.textContent = file.path.slice(0, slash + 1);
      button.append(name, directory);
      button.addEventListener('click', () => choose(index));
      fragment.appendChild(button);
    }
    rows.replaceChildren(fragment);
    if (!loading && !matches.length) summary.textContent = input.value ? 'No matching files' : 'This directory has no visible files';
  }

  function choose(index) {
    const file = matches[index];
    if (!file) return;
    dialog.close();
    request++;
    onSelect(file);
  }

  function move(delta) {
    selected = Math.max(0, Math.min(matches.length - 1, selected + delta));
    const top = selected * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
    render();
  }

  input.addEventListener('input', filter);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(selected); }
  });
  list.addEventListener('scroll', () => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(render); }
  }, { passive: true });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { request++; });

  return async function open() {
    const generation = ++request;
    input.value = '';
    inventory = [];
    loading = true;
    filter();
    if (!dialog.open) dialog.showModal();
    input.focus();
    try {
      const files = await api.files();
      if (!dialog.open || generation !== request) return;
      inventory = files;
      loading = false;
      filter();
    } catch (error) {
      if (dialog.open && generation === request) { loading = false; summary.textContent = error.message; }
    }
  };
}

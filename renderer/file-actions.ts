type Entry = { path: string; kind: string; name: string; file?: { submodule?: boolean } };
type Api = { fileAction: (action: string, path: string) => Promise<void> };
type Mutate = (action: string, path: string, name?: string) => Promise<void>;

export function createFileActions(api: Api, mutate: Mutate, onError: (message: string) => void) {
  const menu = document.createElement('div');
  menu.className = 'file-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'File actions');
  menu.hidden = true;
  document.body.append(menu);
  const dialog = document.createElement('dialog');
  dialog.className = 'rename-dialog';
  dialog.setAttribute('aria-labelledby', 'rename-title');
  dialog.innerHTML =
    '<form><h2 id="rename-title">Rename</h2><label>New name<input name="name" aria-label="New name" autocomplete="off" spellcheck="false" required></label><p class="rename-error" role="alert"></p><div><button type="button" data-action="cancel">Cancel</button><button type="submit">Rename</button></div></form>';
  document.body.append(dialog);
  const input = dialog.querySelector('input')!;
  const error = dialog.querySelector('.rename-error')!;
  let entry: Entry | undefined;
  let returnFocus: HTMLElement | undefined;
  let busy = false;
  function close(focus = false) {
    menu.hidden = true;
    if (focus) returnFocus?.focus();
  }
  function rename(node: Entry) {
    entry = node;
    close();
    error.textContent = '';
    input.value = node.name;
    dialog.querySelector('h2')!.textContent =
      node.kind === 'directory' ? 'Rename folder' : 'Rename file';
    dialog.showModal();
    input.focus();
    const dot = node.kind === 'file' ? node.name.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }
  dialog.querySelector('form')!.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !entry) return;
    busy = true;
    error.textContent = '';
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    input.disabled = true;
    try {
      await mutate('rename', entry.path, input.value);
      dialog.close();
    } catch (failure) {
      error.textContent = (failure as Error).message;
    } finally {
      busy = false;
      input.disabled = false;
      for (const button of dialog.querySelectorAll('button')) button.disabled = false;
      if (dialog.open) {
        input.focus();
        input.select();
      }
    }
  });
  dialog.querySelector('[data-action="cancel"]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => returnFocus?.focus());
  const pointer = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) close();
  };
  document.addEventListener('pointerdown', pointer);
  const blur = () => close();
  window.addEventListener('blur', blur);
  menu.addEventListener('keydown', event => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      close(true);
      if (event.key === 'Escape') event.preventDefault();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  return {
    rename,
    show(node: Entry, x: number, y: number, focus: HTMLElement) {
      returnFocus = focus;
      menu.replaceChildren();
      for (const [action, label] of [
        ['open', node.kind === 'directory' ? 'Expand folder' : 'Open file'],
        ['rename', 'Rename…'],
        ['reveal', 'Reveal in Finder'],
        ['copy-path', 'Copy path'],
        ['copy-relative-path', 'Copy relative path'],
        ['trash', 'Move to Trash'],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('role', 'menuitem');
        button.dataset.action = action;
        button.disabled = Boolean(node.file?.submodule && ['rename', 'trash'].includes(action));
        button.addEventListener('click', () => {
          close(true);
          if (action === 'rename') rename(node);
          else
            void (
              action === 'trash' || action === 'open'
                ? mutate(action, node.path)
                : api.fileAction(action, node.path)
            ).catch(failure => onError((failure as Error).message));
        });
        menu.append(button);
      }
      menu.hidden = false;
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
      menu.querySelector('button')?.focus();
    },
    dispose() {
      document.removeEventListener('pointerdown', pointer);
      window.removeEventListener('blur', blur);
      menu.remove();
      dialog.remove();
    },
  };
}

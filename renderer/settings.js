import './settings.css';

export function createSettings(appearance) {
  const dialog = document.createElement('dialog');
  dialog.className = 'appearance-dialog';
  dialog.id = 'app-settings';
  dialog.setAttribute('aria-labelledby', 'app-settings-title');
  dialog.innerHTML = `
    <div class="appearance-shell">
      <aside class="appearance-sidebar">
        <span id="app-settings-title" class="appearance-sidebar-heading">Settings</span>
        <nav aria-label="Settings">
          <span class="settings-current" aria-current="page">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="6.6"/><path d="M10 3.4a6.6 6.6 0 0 1 0 13.2Z" fill="currentColor" stroke="none"/></svg>
            Appearance
          </span>
        </nav>
      </aside>
      <button type="button" class="settings-close" aria-label="Close Settings" autofocus>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  dialog.querySelector('.appearance-shell').append(appearance.page);
  document.body.append(dialog);

  const close = () => dialog.close();
  dialog.querySelector('.settings-close').addEventListener('click', close);
  appearance.done.addEventListener('click', close);
  return {
    open() {
      if (!dialog.open && !document.querySelector('dialog[open]')) dialog.showModal();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}

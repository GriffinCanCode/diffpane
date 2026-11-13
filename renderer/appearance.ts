import './appearance.css';

const themes = ['dark', 'light', 'system'] as const;
const layouts = ['automatic', 'split', 'inline'] as const;
const wrapModes = ['automatic', 'on', 'off'] as const;
const fonts = {
  system: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  menlo: 'Menlo, Consolas, monospace',
  monaco: 'Monaco, "Lucida Console", monospace',
  courier: '"Courier New", Courier, monospace',
};

export type Appearance = {
  theme: (typeof themes)[number];
  layout: (typeof layouts)[number];
  font: keyof typeof fonts;
  fontSize: number;
  wordWrap: (typeof wrapModes)[number];
  lineNumbers: boolean;
};
type ColorScheme = 'light' | 'dark';

const defaults: Appearance = {
  theme: 'dark',
  layout: 'automatic',
  font: 'system',
  fontSize: 14,
  wordWrap: 'automatic',
  lineNumbers: true,
};
const storageKey = 'diffpane.appearance';
const minFontSize = 10;
const maxFontSize = 28;

function choice<T>(options: readonly T[], value: unknown, fallback: T) {
  return options.find(option => option === value) ?? fallback;
}

function normalize(value: Partial<Appearance> | null): Appearance {
  const size = value?.fontSize;
  return {
    theme: choice(themes, value?.theme, defaults.theme),
    layout: choice(layouts, value?.layout, defaults.layout),
    font: choice(Object.keys(fonts) as Appearance['font'][], value?.font, defaults.font),
    fontSize:
      typeof size === 'number' && Number.isFinite(size)
        ? Math.min(maxFontSize, Math.max(minFontSize, Math.round(size)))
        : defaults.fontSize,
    wordWrap: choice(wrapModes, value?.wordWrap, defaults.wordWrap),
    lineNumbers: typeof value?.lineNumbers === 'boolean' ? value.lineNumbers : defaults.lineNumbers,
  };
}

function loadAppearance() {
  try {
    return normalize(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
  } catch {
    return defaults;
  }
}

export function codeAppearance(settings: Appearance, review = false) {
  return {
    fontFamily: fonts[settings.font],
    fontSize: settings.fontSize,
    lineHeight: Math.round((settings.fontSize * 22) / 14),
    wordWrap:
      settings.wordWrap === 'on' || (settings.wordWrap === 'automatic' && review)
        ? ('on' as const)
        : ('off' as const),
    lineNumbers: settings.lineNumbers ? ('on' as const) : ('off' as const),
  };
}

export function diffAppearance(settings: Appearance, review: boolean) {
  return {
    ...codeAppearance(settings, review),
    renderSideBySide: settings.layout !== 'inline',
    useInlineViewWhenSpaceIsLimited: settings.layout === 'automatic',
    renderSideBySideInlineBreakpoint: 560,
    diffWordWrap: 'inherit' as const,
    renderIndicators: true,
  };
}

const svg = (path: string) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

const minusIcon = svg('<path d="M5.5 10h9"/>');
const plusIcon = svg('<path d="M5.5 10h9M10 5.5v9"/>');
const layoutChoices = [
  [
    'automatic',
    'Automatic',
    svg('<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M10 7v1m0 1.5v1m0 1.5v1"/>'),
  ],
  [
    'split',
    'Side by side',
    svg('<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M10 4v12"/>'),
  ],
  [
    'inline',
    'Inline',
    svg('<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M5.5 8h6m-6 4h9"/>'),
  ],
];

const themeArtwork = (scheme: string) => `
      <span class="appearance-theme-artwork" data-scheme="${scheme}">
        <span class="appearance-mini-window">
          <span class="appearance-mini-title"><i></i><i></i><i></i></span>
          <span class="appearance-mini-sidebar"><i></i><i></i><i></i></span>
          <span class="appearance-mini-editor"><i></i><i></i><i></i><i></i></span>
        </span>
      </span>
`;

const themeCard = (value: string, label: string) => `
  <label class="appearance-theme-choice">
    <input type="radio" name="theme" value="${value}">
    <span class="appearance-theme-card">
      <span class="appearance-theme-art" aria-hidden="true">
        ${value === 'system' ? themeArtwork('light') + themeArtwork('dark') : themeArtwork(value)}
      </span>
      <span class="appearance-theme-caption">${label}<span class="appearance-radio-indicator" aria-hidden="true"></span></span>
    </span>
  </label>`;

export function createAppearanceSettings(
  onApply: (value: Appearance, scheme: ColorScheme) => void,
) {
  const system = matchMedia('(prefers-color-scheme: dark)');
  let value = loadAppearance();
  const page = document.createElement('section');
  page.className = 'appearance-main';
  page.id = 'settings-appearance';
  page.setAttribute('aria-labelledby', 'appearance-heading');
  page.innerHTML = `
        <header class="appearance-header">
          <div>
            <h2 id="appearance-heading">Appearance</h2>
            <p>Customize how Diffpane looks and how you read changes.</p>
          </div>
        </header>
        <form class="appearance-content" aria-label="Appearance preferences">
          <fieldset class="appearance-theme">
            <legend>Theme</legend>
            <div class="appearance-theme-grid">
              ${themeCard('dark', 'Dark')}${themeCard('light', 'Light')}${themeCard('system', 'System')}
            </div>
          </fieldset>
          <fieldset class="appearance-layout" aria-describedby="appearance-layout-help">
            <legend>Diff layout</legend>
            <p id="appearance-layout-help">Automatic switches text comparisons to inline in narrow panes.</p>
            <div class="appearance-layout-options">
              ${layoutChoices
                .map(
                  ([name, label, icon]) => `
                <label><input type="radio" name="layout" value="${name}"><span>${icon}${label}</span></label>
              `,
                )
                .join('')}
            </div>
          </fieldset>
          <section class="appearance-editor" aria-labelledby="appearance-editor-title">
            <h2 id="appearance-editor-title">Editor</h2>
            <div class="appearance-editor-grid">
              <div class="appearance-editor-options">
                <label for="appearance-font">Font family</label>
                <select name="font" id="appearance-font">
                  <option value="system">System mono</option>
                  <option value="menlo">Menlo</option>
                  <option value="monaco">Monaco</option>
                  <option value="courier">Courier New</option>
                </select>
                <label for="appearance-font-size">Font size</label>
                <div class="appearance-stepper">
                  <button type="button" data-step="-1" aria-label="Decrease font size">${minusIcon}</button>
                  <input type="number" id="appearance-font-size" name="fontSize" min="${minFontSize}" max="${maxFontSize}" step="1">
                  <button type="button" data-step="1" aria-label="Increase font size">${plusIcon}</button>
                </div>
                <label for="appearance-word-wrap">Word wrap</label>
                <select name="wordWrap" id="appearance-word-wrap" aria-describedby="appearance-wrap-help">
                  <option value="automatic">Automatic</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
                <span id="appearance-wrap-help" class="appearance-visually-hidden">Automatic wraps in change review.</span>
                <label for="appearance-line-numbers">Line numbers</label>
                <input class="appearance-switch" type="checkbox" role="switch" name="lineNumbers" id="appearance-line-numbers">
              </div>
              <figure class="appearance-preview">
                <figcaption><span>Editor preview</span><span>example.ts</span></figcaption>
                <div class="appearance-preview-code">
                  <div class="appearance-preview-row"><span class="appearance-preview-number" aria-hidden="true">1</span><code><b>const</b> title = <em>'Diffpane'</em>;</code></div>
                  <div class="appearance-preview-row"><span class="appearance-preview-number" aria-hidden="true">2</span><code></code></div>
                  <div class="appearance-preview-row"><span class="appearance-preview-number" aria-hidden="true">3</span><code><i>// A quiet view of your changes</i></code></div>
                  <div class="appearance-preview-row"><span class="appearance-preview-number" aria-hidden="true">4</span><code><b>export</b> { title };</code></div>
                </div>
              </figure>
            </div>
          </section>
        </form>
        <footer class="appearance-footer">
          <button type="button" class="appearance-reset">Reset to defaults</button>
          <button type="button" class="appearance-done">Done</button>
        </footer>`;
  const form = page.querySelector('form')!;
  const reset = page.querySelector<HTMLButtonElement>('.appearance-reset')!;
  const done = page.querySelector<HTMLButtonElement>('.appearance-done')!;
  const size = form.querySelector<HTMLInputElement>('[name="fontSize"]')!;
  const decrease = form.querySelector<HTMLButtonElement>('[data-step="-1"]')!;
  const increase = form.querySelector<HTMLButtonElement>('[data-step="1"]')!;
  const preview = form.querySelector<HTMLElement>('.appearance-preview')!;

  function paint() {
    for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input, select',
    )) {
      const setting = value[input.name as keyof Appearance];
      if (input instanceof HTMLInputElement && input.type === 'radio') {
        input.checked = input.value === setting;
      } else if (input instanceof HTMLInputElement && input.type === 'checkbox') {
        input.checked = setting === true;
      } else {
        input.value = String(setting);
      }
    }
    decrease.disabled = value.fontSize <= minFontSize;
    increase.disabled = value.fontSize >= maxFontSize;
    reset.disabled = Object.keys(defaults).every(key => {
      const field = key as keyof Appearance;
      return value[field] === defaults[field];
    });
    preview.dataset.wrap = value.wordWrap;
    preview.dataset.lineNumbers = String(value.lineNumbers);
  }

  function apply() {
    const scheme = value.theme === 'system' ? (system.matches ? 'dark' : 'light') : value.theme;
    const root = document.documentElement;
    const code = codeAppearance(value);
    root.dataset.theme = scheme;
    root.style.setProperty('--editor-font', code.fontFamily);
    root.style.setProperty('--editor-font-size', `${code.fontSize}px`);
    root.style.setProperty('--editor-line-height', `${code.lineHeight}px`);
    onApply(value, scheme);
  }

  function update(next: Appearance) {
    value = normalize(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Settings still apply for this window if storage is unavailable.
    }
    paint();
    apply();
  }

  function syncStorage(event: StorageEvent) {
    if (event.key !== storageKey && event.key !== null) return;
    value = loadAppearance();
    paint();
    apply();
  }

  function syncSystem() {
    if (value.theme === 'system') apply();
  }

  system.addEventListener('change', syncSystem);
  window.addEventListener('storage', syncStorage);
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('change', event => {
    const field = event.target;
    if (field === size) {
      update({
        ...value,
        fontSize: Number.isFinite(size.valueAsNumber) ? size.valueAsNumber : value.fontSize,
      });
    } else if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
      update({
        ...value,
        [field.name]:
          field instanceof HTMLInputElement && field.type === 'checkbox'
            ? field.checked
            : field.value,
      });
    }
  });
  decrease.addEventListener('click', () => update({ ...value, fontSize: value.fontSize - 1 }));
  increase.addEventListener('click', () => update({ ...value, fontSize: value.fontSize + 1 }));
  reset.addEventListener('click', () => {
    update(defaults);
    done.focus();
  });
  paint();
  apply();
  return {
    page,
    done,
    get value() {
      return value;
    },
    dispose() {
      system.removeEventListener('change', syncSystem);
      window.removeEventListener('storage', syncStorage);
    },
  };
}

import {
  defaultAppearance as DEFAULTS,
  maxFontSize as MAX_FONT_SIZE,
  minFontSize as MIN_FONT_SIZE,
} from '../../../electron/persistence/preferences/ui-preferences.ts'
import type { Appearance } from '../../../electron/persistence/preferences/ui-preferences.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import type { UiPreferenceController } from './ui-preferences.ts'
import './appearance.css'

const FONTS = {
  system: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  menlo: 'Menlo, Consolas, monospace',
  monaco: 'Monaco, "Lucida Console", monospace',
  courier: '"Courier New", Courier, monospace',
}

type ColorScheme = 'light' | 'dark'

function isAppearanceField(value: string): value is keyof Appearance {
  return (
    value === 'theme' ||
    value === 'layout' ||
    value === 'font' ||
    value === 'fontSize' ||
    value === 'wordWrap' ||
    value === 'lineNumbers'
  )
}

export function codeAppearance(settings: Appearance, review = false) {
  return {
    fontFamily: FONTS[settings.font],
    fontSize: settings.fontSize,
    lineHeight: Math.round((settings.fontSize * 22) / 14),
    wordWrap:
      settings.wordWrap === 'on' || (settings.wordWrap === 'automatic' && review) ? ('on' as const) : ('off' as const),
    lineNumbers: settings.lineNumbers ? ('on' as const) : ('off' as const),
  }
}

export function diffAppearance(settings: Appearance, review: boolean) {
  return {
    ...codeAppearance(settings, review),
    renderSideBySide: settings.layout !== 'inline',
    useInlineViewWhenSpaceIsLimited: settings.layout === 'automatic',
    renderSideBySideInlineBreakpoint: 560,
    diffWordWrap: 'inherit' as const,
    renderIndicators: true,
  }
}

function svg(path: string) {
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

const MINUS_ICON = svg('<path d="M5.5 10h9"/>')
const PLUS_ICON = svg('<path d="M5.5 10h9M10 5.5v9"/>')
const LAYOUT_CHOICES = [
  [
    'automatic',
    'Automatic',
    svg('<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M10 7v1m0 1.5v1m0 1.5v1"/>'),
  ],
  ['split', 'Side by side', svg('<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M10 4v12"/>')],
  ['inline', 'Inline', svg('<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M5.5 8h6m-6 4h9"/>')],
]

function themeArtwork(scheme: string) {
  return `
      <span class="appearance-theme-artwork" data-scheme="${scheme}">
        <span class="appearance-mini-window">
          <span class="appearance-mini-title"><i></i><i></i><i></i></span>
          <span class="appearance-mini-sidebar"><i></i><i></i><i></i></span>
          <span class="appearance-mini-editor"><i></i><i></i><i></i><i></i></span>
        </span>
      </span>
`
}

function themeCard(value: string, label: string) {
  return `
  <label class="appearance-theme-choice">
    <input type="radio" name="theme" value="${value}">
    <span class="appearance-theme-card">
      <span class="appearance-theme-art" aria-hidden="true">
        ${value === 'system' ? `${themeArtwork('light')}${themeArtwork('dark')}` : themeArtwork(value)}
      </span>
      <span class="appearance-theme-caption">${label}<span class="appearance-radio-indicator" aria-hidden="true"></span></span>
    </span>
  </label>`
}

export function createAppearanceSettings(
  preferences: UiPreferenceController,
  onApply: (value: Appearance, scheme: ColorScheme) => void,
) {
  const system = matchMedia('(prefers-color-scheme: dark)')
  let value = preferences.get('appearance')
  const page = document.createElement('section')
  page.className = 'appearance-main'
  page.id = 'settings-appearance'
  page.setAttribute('aria-labelledby', 'appearance-heading')
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
              ${LAYOUT_CHOICES.map(
                ([name, label, icon]) => `
                <label><input type="radio" name="layout" value="${name}"><span>${icon}${label}</span></label>
              `,
              ).join('')}
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
                  <button type="button" data-step="-1" aria-label="Decrease font size">${MINUS_ICON}</button>
                  <input type="number" id="appearance-font-size" name="fontSize" min="${MIN_FONT_SIZE}" max="${MAX_FONT_SIZE}" step="1">
                  <button type="button" data-step="1" aria-label="Increase font size">${PLUS_ICON}</button>
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
          <p class="appearance-save-error" role="status" hidden></p>
          <button type="button" class="appearance-done">Done</button>
        </footer>`
  const form = requireElement(page, 'form', HTMLFormElement)
  const reset = requireElement(page, '.appearance-reset', HTMLButtonElement)
  const done = requireElement(page, '.appearance-done', HTMLButtonElement)
  const size = requireElement(form, '[name="fontSize"]', HTMLInputElement)
  const decrease = requireElement(form, '[data-step="-1"]', HTMLButtonElement)
  const increase = requireElement(form, '[data-step="1"]', HTMLButtonElement)
  const preview = requireElement(form, '.appearance-preview', HTMLElement)
  const saveError = requireElement(page, '.appearance-save-error', HTMLElement)

  function paint() {
    for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
      if (!isAppearanceField(input.name)) continue
      const setting = value[input.name]
      if (input instanceof HTMLInputElement && input.type === 'radio') {
        input.checked = input.value === setting
      } else if (input instanceof HTMLInputElement && input.type === 'checkbox') {
        input.checked = setting === true
      } else {
        input.value = String(setting)
      }
    }
    decrease.disabled = value.fontSize <= MIN_FONT_SIZE
    increase.disabled = value.fontSize >= MAX_FONT_SIZE
    reset.disabled = Object.keys(DEFAULTS).every(field => isAppearanceField(field) && value[field] === DEFAULTS[field])
    preview.dataset.wrap = value.wordWrap
    preview.dataset.lineNumbers = String(value.lineNumbers)
  }

  function apply() {
    const scheme = value.theme === 'system' ? (system.matches ? 'dark' : 'light') : value.theme
    const root = document.documentElement
    const code = codeAppearance(value)
    root.dataset.theme = scheme
    root.style.setProperty('--editor-font', code.fontFamily)
    root.style.setProperty('--editor-font-size', `${code.fontSize}px`)
    root.style.setProperty('--editor-line-height', `${code.lineHeight}px`)
    onApply(value, scheme)
  }

  const update = (patch: Partial<Appearance>) => preferences.set('appearance', patch)
  const unsubscribe = preferences.onChange('appearance', next => {
    saveError.hidden = !preferences.hasSaveError('appearance')
    saveError.textContent = 'Appearance changes couldn’t be saved.'
    if (Object.keys(DEFAULTS).every(key => isAppearanceField(key) && value[key] === next[key])) return
    value = next
    paint()
    apply()
  })

  function syncSystem() {
    if (value.theme === 'system') apply()
  }

  system.addEventListener('change', syncSystem)
  form.addEventListener('submit', event => event.preventDefault())
  form.addEventListener('change', event => {
    const field = event.target
    if (field === size) {
      const fontSize = Number.isFinite(size.valueAsNumber)
        ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size.valueAsNumber)))
        : value.fontSize
      size.value = String(fontSize)
      if (fontSize !== value.fontSize) update({ fontSize })
    } else if (
      (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) &&
      isAppearanceField(field.name)
    ) {
      update({
        [field.name]: field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value,
      })
    }
  })
  decrease.addEventListener('click', () => update({ fontSize: value.fontSize - 1 }))
  increase.addEventListener('click', () => update({ fontSize: value.fontSize + 1 }))
  reset.addEventListener('click', () => {
    update(DEFAULTS)
    done.focus()
  })
  paint()
  apply()
  return {
    page,
    done,
    get value() {
      return value
    },
    dispose() {
      system.removeEventListener('change', syncSystem)
      unsubscribe()
    },
  }
}

import { createUiPreferences } from '../../panels/appearance/ui-preferences.ts'
import type { UiPreferenceController } from '../../panels/appearance/ui-preferences.ts'

let workspacePreferences: UiPreferenceController | undefined

export function getWorkspacePreferences() {
  return (workspacePreferences ??= createUiPreferences(window.diffpane?.preferences))
}

export function applyOpeningTheme() {
  const preferences = getWorkspacePreferences()
  const system = matchMedia('(prefers-color-scheme: dark)')
  function sync() {
    const { theme } = preferences.get('appearance')
    document.documentElement.dataset.theme = theme === 'system' ? (system.matches ? 'dark' : 'light') : theme
  }

  sync()
  const unsubscribe = preferences.onChange('appearance', sync)
  system.addEventListener('change', sync)
  return () => {
    unsubscribe()
    system.removeEventListener('change', sync)
  }
}

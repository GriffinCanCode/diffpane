import { createHighlighterCore } from '@shikijs/core'
import type { LanguageRegistration, ThemeRegistration } from '@shikijs/core'
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma'
import { shikiToMonaco } from '@shikijs/monaco'
import dark from '@shikijs/themes/dark-plus'
import light from '@shikijs/themes/light-plus'
import type { editor, languages } from 'monaco-editor'
import type { SyntaxCatalogEntry, SyntaxGrammar } from 'virtual:syntax-catalog'
import { editorThemeName, EDITOR_THEMES, SYNTAX_COLORS } from './editor-themes.ts'
import type { EditorThemeName } from './editor-themes.ts'

interface MonacoHost {
  languages: Pick<typeof languages, 'getLanguages' | 'setTokensProvider'>
  editor: Pick<typeof editor, 'defineTheme'>
}

export interface SyntaxRuntime {
  load: (scope: string) => Promise<string[]>
  setTheme: (name: EditorThemeName) => void
}

function syntaxTheme(base: ThemeRegistration, name: EditorThemeName) {
  const { comment, keyword, string, number, symbol, variable } = SYNTAX_COLORS[name]
  return {
    ...base,
    name,
    tokenColors: [
      ...(base.tokenColors ?? []),
      { scope: 'comment', settings: { foreground: `#${comment}`, fontStyle: 'italic' } },
      {
        scope: ['keyword', 'storage.type', 'storage.modifier'],
        settings: { foreground: `#${keyword}` },
      },
      { scope: 'string', settings: { foreground: `#${string}` } },
      { scope: 'constant.numeric', settings: { foreground: `#${number}` } },
      {
        scope: ['entity.name.type', 'support.type', 'entity.name.function', 'support.function', 'constant.language'],
        settings: { foreground: `#${symbol}` },
      },
      { scope: ['variable', 'variable.parameter'], settings: { foreground: `#${variable}` } },
    ],
  }
}

/** Mature TextMate grammars fill Monaco's config gaps without a language server. */
export async function createSyntaxRuntime(
  monaco: MonacoHost,
  catalog: readonly SyntaxCatalogEntry[],
  currentTheme: () => EditorThemeName,
): Promise<SyntaxRuntime> {
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
    themes: [syntaxTheme(dark, editorThemeName('dark')), syntaxTheme(light, editorThemeName('light'))],
    langs: [],
  })
  const scopes = new Map(catalog.map(entry => [entry.scope, entry]))
  const loaded = new Set<string>()
  const themeSetters: Array<(name: EditorThemeName) => void> = []
  let themesDefined = false
  let queue: Promise<unknown> = Promise.resolve()
  function findScope(scope: string) {
    const entry = scopes.get(scope)
    if (!entry) throw new Error(`Missing grammar dependency: ${scope}`)
    return entry
  }
  async function loadRegistration(entry: SyntaxCatalogEntry): Promise<LanguageRegistration> {
    const grammar = await entry.load()
    return {
      ...grammar,
      name: entry.id,
      aliases: [],
      embeddedLangs: entry.dependencies.map(name => findScope(name).id),
    }
  }
  function load(scope: string) {
    const loading = queue.then(async () => {
      if (loaded.has(scope)) return highlighter.getLoadedLanguages()
      const entries = new Map<string, SyntaxCatalogEntry>()
      const collect = (name: string) => {
        if (loaded.has(name) || entries.has(name)) return
        const entry = findScope(name)
        entries.set(name, entry)
        for (const dependency of entry.dependencies) collect(dependency)
      }
      collect(scope)
      const grammars = await Promise.all([...entries.values()].map(entry => loadRegistration(entry)))
      await highlighter.loadLanguage(...grammars)
      for (const name of entries.keys()) loaded.add(name)
      const adapterEditor: Pick<typeof editor, 'defineTheme' | 'setTheme'> = {
        defineTheme(name, syntax) {
          if (themesDefined) return
          if (name !== 'diffpane' && name !== 'diffpane-light') throw new Error(`Unknown editor theme: ${name}`)
          const theme = EDITOR_THEMES[name]
          monaco.editor.defineTheme(name, { ...theme, rules: [...syntax.rules, ...theme.rules] })
        },
        setTheme() {},
      }
      const active = currentTheme()
      // The adapter starts with the first theme and mutates its editor facade. Keep
      // those mutations local and install only the token providers added by this load.
      const newLanguages = new Set([...entries.values()].map(entry => entry.id))
      shikiToMonaco(
        {
          ...highlighter,
          getLoadedThemes: () => [active, ...highlighter.getLoadedThemes().filter(name => name !== active)],
        },
        {
          languages: {
            setTokensProvider: (id: string, provider: Parameters<typeof languages.setTokensProvider>[1]) =>
              monaco.languages.setTokensProvider(id, provider),
            getLanguages: () => monaco.languages.getLanguages().filter(({ id }) => newLanguages.has(id)),
          },
          editor: adapterEditor,
        },
      )
      themesDefined = true
      themeSetters.push(name => adapterEditor.setTheme(name))
      return highlighter.getLoadedLanguages()
    })
    queue = loading.catch(() => undefined)
    return loading
  }
  return {
    load,
    setTheme(name) {
      for (const setTheme of themeSetters) setTheme(name)
    },
  }
}

export type { SyntaxGrammar }

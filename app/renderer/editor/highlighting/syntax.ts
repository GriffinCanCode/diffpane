import type { editor, languages } from 'monaco-editor'
import sourceCatalog from 'virtual:syntax-catalog'
import type { SyntaxCatalogEntry } from 'virtual:syntax-catalog'
import { parseDocument, isMap, isSeq } from 'yaml'
import { appError } from '../../../shared/recovery/app-errors.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { EDITOR_THEMES } from './editor-themes.ts'
import type { EditorThemeName } from './editor-themes.ts'
import type { SyntaxRuntime } from './grammars.ts'

interface MonacoModel {
  uri: { path: string }
  getLanguageId: () => string
}

interface MonacoApi {
  languages: Pick<
    typeof languages,
    'getLanguages' | 'register' | 'onLanguage' | 'setTokensProvider' | 'registerTokensProviderFactory'
  >
  editor: Pick<typeof editor, 'defineTheme' | 'setTheme'>
}

const MAX_FORMAT_LENGTH = 65_536
const CONFIG_KEY = String.raw`[\w-]+(?:\s*\.\s*[\w-]+)*`
const CONFIG_TABLE = new RegExp(String.raw`^(?:\[\s*${CONFIG_KEY}\s*\]|\[\[\s*${CONFIG_KEY}\s*\]\])\s*(?:#.*)?$`)
const CONFIG_ASSIGNMENT = new RegExp(String.raw`^${CONFIG_KEY}\s*=\s*(.+)$`)
const CONFIG_COLLECTION = /^(?:\[.*\]|\{.*\})\s*(?:#.*)?$/
const CONFIG_SCALAR =
  /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|true|false|[+-]?(?:\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?|inf|nan))\s*(?:#.*)?$/

function looksLikeToml(text: string) {
  let assignments = 0
  let table = false
  let collection = false
  let typedValue = false
  let arrayOpen = false
  for (const source of text.split(/\r\n|\r|\n/)) {
    const line = source.trim()
    if (!line || line.startsWith('#')) continue
    if (arrayOpen) {
      if (!/^\]\s*(?:#.*)?$/.test(line)) continue
      arrayOpen = false
      collection = typedValue = true
    } else if (CONFIG_TABLE.test(line)) {
      table = true
    } else {
      const value = CONFIG_ASSIGNMENT.exec(line)?.[1]
      if (!value) return false
      assignments++
      if (/^\[\s*(?:#.*)?$/.test(value)) {
        arrayOpen = true
        continue
      }
      const structured = CONFIG_COLLECTION.test(value)
      if (!structured && !CONFIG_SCALAR.test(value)) return false
      collection ||= structured
      typedValue ||= structured || /^(?:["']|true\b|false\b)/.test(value)
    }
    if ((table && typedValue) || (assignments >= 2 && collection)) return true
  }
  return false
}

function resolve(model: MonacoModel, text: string) {
  let language = model.getLanguageId()
  if (!['plaintext', 'ini', 'xml', 'openstep-property-list', 'haproxy'].includes(language) || !text.trim())
    return language
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object') return 'json'
  } catch {
    /* Another structured format or ordinary text. */
  }
  if (text.trimStart().startsWith('<')) {
    const document = new DOMParser().parseFromString(text, 'application/xml')
    if (!document.querySelector('parsererror')) return 'xml'
  }
  if (text.length <= MAX_FORMAT_LENGTH) {
    const filename = model.uri.path.slice(model.uri.path.lastIndexOf('/') + 1)
    if (language === 'plaintext' && filename && !filename.includes('.') && looksLikeToml(text)) return 'toml'
    try {
      const document = parseDocument(text, { uniqueKeys: false })
      if (!document.errors.length && (isMap(document.contents) || isSeq(document.contents))) language = 'yaml'
    } catch {
      /* Optional format inference must never prevent reading the source. */
    }
  }
  return language
}

/** Supplement Monaco from upstream associations without stealing existing language IDs. */
export function configureSyntax(monaco: MonacoApi) {
  for (const [name, theme] of Object.entries(EDITOR_THEMES)) monaco.editor.defineTheme(name, theme)
  let themeName: EditorThemeName = 'diffpane'
  const native = monaco.languages.getLanguages()
  const claimed = new Set(native.flatMap(language => [...(language.extensions ?? []), ...(language.filenames ?? [])]))
  const ids = new Set([...native.map(language => language.id), 'json'])
  const catalog: SyntaxCatalogEntry[] = []
  for (const entry of sourceCatalog) {
    catalog.push({ ...entry, id: entry.aliases.find(alias => ids.has(alias)) ?? entry.id })
  }
  const react = new Set(['tsx', 'jsx'])
  const loaded = new Set<string>()
  const pending = new Map<string, Promise<void>>()
  const errors = new Map<string, string>()
  const lazyLanguages = new Map(catalog.filter(entry => !ids.has(entry.id)).map(entry => [entry.id, entry]))
  let runtime: SyntaxRuntime | undefined
  let loadingRuntime: Promise<SyntaxRuntime> | undefined

  function ensureLanguage(id: string): Promise<void> | undefined {
    const entry = lazyLanguages.get(id)
    if (!entry || loaded.has(id)) return undefined
    const existing = pending.get(id)
    if (existing) return existing
    loadingRuntime ??= import('./grammars.ts')
      .then(module => module.createSyntaxRuntime(monaco, catalog, () => themeName, ids))
      .then(highlighter => (runtime = highlighter))
      .catch((cause: unknown) => {
        loadingRuntime = undefined
        throw appError(cause, { operation: 'Load syntax highlighter' })
      })
    const operation = `Load syntax for ${entry.displayName}`
    const work = loadingRuntime
      .then(current => current.load(entry.scope))
      .then(languages => {
        for (const language of languages) {
          loaded.add(language)
          errors.delete(language)
        }
        return undefined
      })
      .catch((cause: unknown) => {
        const error = appError(cause, { operation })
        errors.set(id, error.message)
        throw error
      })
      .finally(() => pending.delete(id))
    pending.set(id, work)
    return work
  }

  for (const entry of catalog) {
    const extensions = entry.extensions.filter(
      extension => entry.priority === true || !claimed.has(extension) || react.has(entry.id),
    )
    const filenames = entry.filenames.filter(filename => !claimed.has(filename))
    if (extensions.length || filenames.length || entry.firstLine) {
      monaco.languages.register({
        id: entry.id,
        extensions,
        filenames,
        firstLine: entry.firstLine,
        aliases: [entry.displayName, ...entry.aliases],
      })
      for (const value of [...extensions, ...filenames]) claimed.add(value)
    }
  }
  monaco.languages.register({
    id: 'json',
    extensions: ['.jsonc', '.ndjson', '.hujson', '.ipynb', '.xctestplan', '.vectorcraft', '.map'],
    aliases: ['JSON'],
  })
  monaco.languages.register({ id: 'markdown', extensions: ['.mdc'], aliases: ['Markdown'] })
  monaco.languages.register({ id: 'sql', extensions: ['.logsql'], aliases: ['SQL'] })
  monaco.languages.register({ id: 'css', extensions: ['.tcss'], aliases: ['CSS'] })
  monaco.languages.register({
    id: 'ini',
    extensions: ['.cfg'],
    filenames: ['.npmrc', '.yarnrc', '.pypirc', '.codespellrc', '.sqlfluff', '.importlinter'],
    aliases: ['INI'],
  })
  monaco.languages.register({ id: 'dotenv', filenamePatterns: ['.env.*'], aliases: ['Dotenv'] })
  monaco.languages.register({
    id: 'dockerfile',
    filenamePatterns: ['*.Dockerfile', 'Dockerfile.*', '*.Containerfile'],
    aliases: ['Dockerfile'],
  })
  monaco.languages.register({
    id: 'ignore-list',
    filenamePatterns: ['*.dockerignore', '*ignore'],
    aliases: ['Ignore List'],
  })
  monaco.languages.register({
    id: 'caddyfile',
    filenamePatterns: ['Caddyfile.*'],
    aliases: ['Caddyfile'],
  })
  monaco.languages.register({
    id: 'xml',
    extensions: ['.plist', '.entitlements', '.xcprivacy', '.vot'],
    aliases: ['XML'],
  })
  monaco.languages.register({ id: 'pascal', extensions: ['.lfm'], aliases: ['Pascal'] })
  monaco.languages.register({ id: 'dm', extensions: ['.dmf', '.dmm'], aliases: ['DM'] })
  monaco.languages.register({ id: 'cpp', extensions: ['.modulemap'], aliases: ['C++'] })
  monaco.languages.register({
    id: 'yaml',
    firstLine: '^#\\s*yaml-language-server:\\s*\\$schema=',
    aliases: ['YAML'],
  })
  monaco.languages.registerTokensProviderFactory('json', {
    async create() {
      const { createTokenizationSupport } = await import('monaco-editor/languages/features/json/tokenization.js')
      return createTokenizationSupport(true)
    },
  })

  const registered = new Set(monaco.languages.getLanguages().map(language => language.id))
  for (const [id, entry] of lazyLanguages) {
    if (!registered.has(id)) continue
    monaco.languages.onLanguage(id, () => {
      runTask(`Load syntax for ${entry.displayName}`, () => ensureLanguage(id), { silent: true })
    })
  }

  return {
    resolve(model: MonacoModel, text: string) {
      const id = resolve(model, text)
      if (errors.has(id) && !pending.has(id)) {
        runTask('Retry syntax highlighting', () => ensureLanguage(id), { silent: true })
      }
      return id
    },
    ensureLanguage,
    setTheme(name: EditorThemeName) {
      themeName = name
      runtime?.setTheme(name)
      monaco.editor.setTheme(name)
    },
    stats: () => ({
      loaded: [...loaded],
      pending: [...pending.keys()],
      errors: Object.fromEntries(errors),
    }),
  }
}

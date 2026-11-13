import type { editor, languages } from 'monaco-editor'
import sourceCatalog from 'virtual:syntax-catalog'
import type { SyntaxCatalogEntry } from 'virtual:syntax-catalog'
import { parseDocument, isMap, isSeq } from 'yaml'
import { appError, attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
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
  const pending = new Set<string>()
  const errors = new Map<string, string>()
  let runtime: SyntaxRuntime | undefined
  let loadingRuntime: Promise<SyntaxRuntime> | undefined
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
    if (ids.has(entry.id)) continue
    monaco.languages.onLanguage(entry.id, () => {
      pending.add(entry.id)
      loadingRuntime ??= import('./grammars.ts')
        .then(module => module.createSyntaxRuntime(monaco, catalog, () => themeName))
        .then(highlighter => (runtime = highlighter))
        .catch((cause: unknown) => {
          loadingRuntime = undefined
          throw appError(cause, { operation: 'Load syntax highlighter' })
        })
      const current = loadingRuntime
      const operation = `Load syntax for ${entry.displayName}`
      runTask(operation, async () => {
        try {
          const result = await attemptAsync(async () => (await current).load(entry.scope), { operation })
          if (result.ok) {
            errors.delete(entry.id)
            for (const language of result.value) loaded.add(language)
          } else {
            errors.set(entry.id, result.error.message)
            reportError(result.error, { silent: true })
          }
        } finally {
          pending.delete(entry.id)
        }
      })
    })
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

  // Unknown suffixes often contain an ordinary serialization format. Parse it first.

  return {
    resolve,
    setTheme(name: EditorThemeName) {
      themeName = name
      runtime?.setTheme(name)
      monaco.editor.setTheme(name)
    },
    stats: () => ({
      loaded: [...loaded],
      pending: [...pending],
      errors: Object.fromEntries(errors),
    }),
  }
}

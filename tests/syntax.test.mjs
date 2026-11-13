import assert from 'node:assert/strict'
import { createHighlighterCore } from '@shikijs/core'
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma'
import dark from '@shikijs/themes/dark-plus'
import { test } from 'vite-plus/test'
import { createSyntaxRuntime } from '../renderer/grammars.ts'
import { configureSyntax } from '../renderer/syntax.ts'
import { catalog, grammarBytes } from '../syntax.ts'

test('every grammar dependency exists in the pinned lazy catalog', () => {
  const scopes = new Set(catalog.map(entry => entry.scope))
  assert.equal(scopes.size, catalog.length, 'each scope has one grammar')
  for (const entry of catalog)
    for (const dependency of entry.dependencies) assert.ok(scopes.has(dependency), `${entry.id} needs ${dependency}`)
})

test('unknown extensionless files use local TOML syntax when their contents are recognizable', () => {
  const registered = new Set()
  const { resolve } = configureSyntax({
    languages: {
      getLanguages: () => [],
      register: language => void registered.add(language.id),
      onLanguage: () => ({ dispose() {} }),
      setTokensProvider: () => ({ dispose() {} }),
      registerTokensProviderFactory: () => ({ dispose() {} }),
    },
    editor: { defineTheme() {}, setTheme() {} },
  })
  /** @param {string} text */
  const languageFor = (text, filename = 'ProjectSettings', language = 'plaintext') =>
    resolve({ uri: { path: `/project/${filename}` }, getLanguageId: () => language }, text)
  const project = '# Project configuration\r\nversion = 1\r\n[build.tools]\r\ncommand = "build"\r\n'
  assert.ok(registered.has('toml'))
  assert.equal(languageFor(project), 'toml')
  assert.equal(languageFor('version = 1\nfeatures = ["release", "debug"] # targets'), 'toml')
  assert.equal(languageFor('version = 1\nfeatures = [\n  "release",\n  "debug",\n] # targets\n'), 'toml')
  assert.equal(languageFor(`${project}notes = """\nMultiple lines\n"""\n`), 'toml')
  assert.notEqual(languageFor('version = 1\nfeatures = [\n  "release",\n'), 'toml')
  assert.equal(languageFor('NAME="example"\nPORT=8080'), 'plaintext')
  assert.notEqual(languageFor('[app]\nNAME=example\nPORT=8080'), 'toml')
  assert.notEqual(languageFor(project, 'example.txt'), 'toml')
  assert.equal(languageFor(project, 'example.ini', 'ini'), 'ini')
  assert.equal(languageFor('{"name":"example"}'), 'json')
  assert.equal(languageFor('name: example\nversion: 1'), 'yaml')
})

test('real grammars color custom formats and preserve source characters exactly', async () => {
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
    themes: [dark],
    langs: [],
  })
  const loaded = new Set()
  /** @param {(typeof catalog)[number]} entry */
  async function load(entry) {
    if (loaded.has(entry.scope)) return
    loaded.add(entry.scope)
    for (const scope of entry.dependencies) {
      const dependency = catalog.find(value => value.scope === scope)
      assert.ok(dependency, `Missing grammar dependency ${scope}`)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Register each dependency before loading its consumer.
      await load(dependency)
    }
    await highlighter.loadLanguage({ ...(await grammarBytes(entry)), name: entry.id, aliases: [] })
  }
  try {
    /** @type {[string, string][]} */
    const cases = [
      ['directives', '# Config\nLocalSocket "/tmp/service.sock"\nMaxThreads 2\n'],
      ['metrics', '# HELP count Sample\ncount{kind="ready"} 42\n'],
      ['cedar', '// Policy\npermit(principal == User::"u", action, resource) when { resource.owner == principal };\n'],
      ['cedarschema', '// Schema\nnamespace Demo { entity User { name: String }; }\n'],
      ['zoning', '// Topology\npackage demo { root src }\nzones { core core.rs }\nlimit reach to 0 hops\n'],
      ['amadeus', '# Score\ntempo 104;\ntrack "Keys" channel 1 { play theme at 1; }\n'],
      ['designcraft-script', 'file.new {"width": 432, "title": "Night Shift"}\n'],
      ['toml', '# Configuration\n[build]\ncommand = "build"\nretries = 2\n'],
      ['json5', '// Config\n{unquoted: "value", enabled: true,}\n'],
      ['jsx', '// View\nexport const view = <div title="hi">{42}</div>;\n'],
      ['jinja', 'Hello {{ person.name }}\n{% if ready %}Yes{% endif %}\n'],
    ]
    for (const [id, source] of cases) {
      const entry = catalog.find(item => item.id === id)
      assert.ok(entry, `Missing grammar ${id}`)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Keep each fixture's registration and assertions isolated.
      await load(entry)
      const { tokens } = highlighter.codeToTokens(source, { lang: id, theme: 'dark-plus' })
      assert.equal(
        tokens.map(line => line.map(token => token.content).join('')).join('\n'),
        source,
        `${id} must preserve source text`,
      )
      assert.ok(
        new Set(
          tokens
            .flat()
            .filter(token => token.content.trim())
            .map(token => token.color),
        ).size >= 3,
        `${id} must supply actual syntax colors`,
      )
    }
  } finally {
    highlighter.dispose()
  }
})

test('late TextMate grammars use the active editor theme and respond to changes', async () => {
  /** @type {import('../renderer/editor-themes.ts').EditorThemeName} */
  let themeName = 'diffpane'
  /** @type {Map<string, import('monaco-editor').editor.IStandaloneThemeData>} */
  const definitions = new Map()
  /** @type {Map<string, import('monaco-editor').languages.TokensProvider>} */
  const tokenizers = new Map()
  /** @type {import('virtual:syntax-catalog').SyntaxCatalogEntry[]} */
  const entries = []
  for (const entry of catalog) {
    if (entry.id === 'directives' || entry.id === 'metrics') {
      entries.push({ ...entry, load: () => grammarBytes(entry) })
    }
  }
  const runtime = await createSyntaxRuntime(
    {
      languages: {
        getLanguages: () => entries,
        setTokensProvider(id, tokenizer) {
          assert.ok(!('tokenizeEncoded' in tokenizer) && 'tokenize' in tokenizer)
          tokenizers.set(id, tokenizer)
          return {
            dispose: () => {
              tokenizers.delete(id)
            },
          }
        },
      },
      editor: {
        defineTheme: (name, theme) => definitions.set(name, theme),
      },
    },
    entries,
    () => themeName,
  )
  /**
   * @param {string} id
   * @param {string} source
   */
  function colors(id, source) {
    const tokenizer = tokenizers.get(id)
    const theme = definitions.get(themeName)
    assert.ok(tokenizer && theme)
    const { rules } = theme
    return tokenizer
      .tokenize(source, tokenizer.getInitialState())
      .tokens.map(({ scopes }) => rules.findLast(rule => rule.token === scopes)?.foreground?.toLowerCase())
  }

  const loading = runtime.load('source.directives')
  themeName = 'diffpane-light'
  runtime.setTheme(themeName)
  await loading
  assert.ok(colors('directives', '# Configuration').includes('59666c'))
  assert.equal(definitions.get('diffpane-light')?.base, 'vs')

  await runtime.load('source.metrics')
  assert.ok(colors('metrics', '# HELP requests Request count').includes('59666c'))
  themeName = 'diffpane'
  runtime.setTheme(themeName)
  assert.ok(colors('directives', '# Configuration').includes('808080'))
  assert.ok(colors('metrics', '# HELP requests Request count').includes('808080'))

  themeName = 'diffpane-light'
  runtime.setTheme(themeName)
  assert.ok(colors('directives', '# Configuration').includes('59666c'))
  assert.ok(colors('metrics', '# HELP requests Request count').includes('59666c'))
})

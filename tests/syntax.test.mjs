import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { createHighlighterCore } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
import dark from '@shikijs/themes/dark-plus';
import { createSyntaxRuntime } from '../renderer/grammars.ts';
import { catalog, grammarBytes } from '../syntax.ts';

test('every grammar dependency exists in the pinned lazy catalog', () => {
  const scopes = new Set(catalog.map(entry => entry.scope));
  assert.equal(scopes.size, catalog.length, 'each scope has one grammar');
  for (const entry of catalog)
    for (const dependency of entry.dependencies)
      assert.ok(scopes.has(dependency), `${entry.id} needs ${dependency}`);
});

test('real grammars color custom formats and preserve source characters exactly', async () => {
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
    themes: [dark],
    langs: [],
  });
  const loaded = new Set();
  async function load(entry) {
    if (loaded.has(entry.scope)) return;
    loaded.add(entry.scope);
    for (const scope of entry.dependencies)
      await load(catalog.find(value => value.scope === scope));
    await highlighter.loadLanguage({ ...(await grammarBytes(entry)), name: entry.id, aliases: [] });
  }
  try {
    for (const [id, source] of [
      ['directives', '# Config\nLocalSocket "/tmp/service.sock"\nMaxThreads 2\n'],
      ['metrics', '# HELP count Sample\ncount{kind="ready"} 42\n'],
      [
        'cedar',
        '// Policy\npermit(principal == User::"u", action, resource) when { resource.owner == principal };\n',
      ],
      ['cedarschema', '// Schema\nnamespace Demo { entity User { name: String }; }\n'],
      [
        'zoning',
        '// Topology\npackage demo { root src }\nzones { core core.rs }\nlimit reach to 0 hops\n',
      ],
      ['amadeus', '# Score\ntempo 104;\ntrack "Keys" channel 1 { play theme at 1; }\n'],
      ['designcraft-script', 'file.new {"width": 432, "title": "Night Shift"}\n'],
      ['json5', '// Config\n{unquoted: "value", enabled: true,}\n'],
      ['jsx', '// View\nexport const view = <div title="hi">{42}</div>;\n'],
      ['jinja', 'Hello {{ person.name }}\n{% if ready %}Yes{% endif %}\n'],
    ]) {
      await load(catalog.find(entry => entry.id === id));
      const { tokens } = highlighter.codeToTokens(source, { lang: id, theme: 'dark-plus' });
      assert.equal(
        tokens.map(line => line.map(token => token.content).join('')).join('\n'),
        source,
        `${id} must preserve source text`,
      );
      assert.ok(
        new Set(
          tokens
            .flat()
            .filter(token => token.content.trim())
            .map(token => token.color),
        ).size >= 3,
        `${id} must supply actual syntax colors`,
      );
    }
  } finally {
    highlighter.dispose();
  }
});

test('late TextMate grammars use the active editor theme and respond to changes', async () => {
  let themeName = 'diffpane';
  const definitions = new Map();
  const tokenizers = new Map();
  const entries = catalog
    .filter(entry => ['directives', 'metrics'].includes(entry.id))
    .map(entry => ({ ...entry, load: () => grammarBytes(entry) }));
  const runtime = await createSyntaxRuntime(
    {
      languages: {
        getLanguages: () => entries,
        setTokensProvider: (id, tokenizer) => tokenizers.set(id, tokenizer),
      },
      editor: {
        defineTheme: (name, theme) => definitions.set(name, theme),
        setTheme: name => assert.fail(`Grammar load changed the active editor to ${name}`),
      },
    },
    entries,
    () => themeName,
  );
  function colors(id, source) {
    const tokenizer = tokenizers.get(id);
    const rules = definitions.get(themeName).rules;
    return tokenizer
      .tokenize(source, tokenizer.getInitialState())
      .tokens.map(({ scopes }) =>
        rules.findLast(rule => rule.token === scopes)?.foreground?.toLowerCase(),
      );
  }

  const loading = runtime.load('source.directives');
  themeName = 'diffpane-light';
  runtime.setTheme(themeName);
  await loading;
  assert.ok(colors('directives', '# Configuration').includes('59666c'));
  assert.equal(definitions.get('diffpane-light').base, 'vs');

  await runtime.load('source.metrics');
  assert.ok(colors('metrics', '# HELP requests Request count').includes('59666c'));
  themeName = 'diffpane';
  runtime.setTheme(themeName);
  assert.ok(colors('directives', '# Configuration').includes('808080'));
  assert.ok(colors('metrics', '# HELP requests Request count').includes('808080'));

  themeName = 'diffpane-light';
  runtime.setTheme(themeName);
  assert.ok(colors('directives', '# Configuration').includes('59666c'));
  assert.ok(colors('metrics', '# HELP requests Request count').includes('59666c'));
});

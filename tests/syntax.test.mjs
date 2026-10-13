import test from 'node:test';
import assert from 'node:assert/strict';
import { createHighlighterCore } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
import dark from '@shikijs/themes/dark-plus';
import { catalog, grammarBytes } from '../syntax.mjs';

test('every grammar dependency exists in the pinned lazy catalog', () => {
  const scopes = new Set(catalog.map(entry => entry.scope));
  assert.equal(scopes.size, catalog.length, 'each scope has one grammar');
  for (const entry of catalog) for (const dependency of entry.dependencies) assert.ok(scopes.has(dependency), `${entry.id} needs ${dependency}`);
});

test('real grammars color custom formats and preserve source characters exactly', async () => {
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
    themes: [dark], langs: [],
  });
  const loaded = new Set();
  async function load(entry) {
    if (loaded.has(entry.scope)) return;
    loaded.add(entry.scope);
    for (const scope of entry.dependencies) await load(catalog.find(value => value.scope === scope));
    await highlighter.loadLanguage({ ...await grammarBytes(entry), name: entry.id, aliases: [] });
  }
  try {
    for (const [id, source] of [
      ['directives', '# Config\nLocalSocket "/tmp/service.sock"\nMaxThreads 2\n'],
      ['metrics', '# HELP count Sample\ncount{kind="ready"} 42\n'],
      ['cedar', '// Policy\npermit(principal == User::"u", action, resource) when { resource.owner == principal };\n'],
      ['cedarschema', '// Schema\nnamespace Demo { entity User { name: String }; }\n'],
      ['zoning', '// Topology\npackage demo { root src }\nzones { core core.rs }\nlimit reach to 0 hops\n'],
      ['amadeus', '# Score\ntempo 104;\ntrack "Keys" channel 1 { play theme at 1; }\n'],
      ['designcraft-script', 'file.new {"width": 432, "title": "Night Shift"}\n'],
      ['json5', '// Config\n{unquoted: "value", enabled: true,}\n'],
      ['jsx', '// View\nexport const view = <div title="hi">{42}</div>;\n'],
      ['jinja', 'Hello {{ person.name }}\n{% if ready %}Yes{% endif %}\n'],
    ]) {
      await load(catalog.find(entry => entry.id === id));
      const { tokens } = highlighter.codeToTokens(source, { lang: id, theme: 'dark-plus' });
      assert.equal(tokens.map(line => line.map(token => token.content).join('')).join('\n'), source, `${id} must preserve source text`);
      assert.ok(new Set(tokens.flat().filter(token => token.content.trim()).map(token => token.color)).size >= 3, `${id} must supply actual syntax colors`);
    }
  } finally { highlighter.dispose(); }
});

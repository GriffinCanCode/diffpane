import type { Plugin } from 'vite';
import { all } from '@wooorm/starry-night';
import * as linguist from 'linguist-languages';
import type { Language } from 'linguist-languages';
import { readFileSync } from 'node:fs';

type GrammarPack = {
  name: string;
  scopeName: string;
  displayName?: string;
};

type CatalogEntry = {
  id: string;
  scope: string;
  displayName: string;
  extensions: string[];
  filenames: string[];
  aliases: string[];
  dependencies: string[];
  importPath: string;
  priority?: boolean;
  firstLine?: string;
};

const custom: {
  id: string;
  extensions: string[];
  filenames?: string[];
  displayName: string;
  dependencies?: string[];
}[] = [
  {
    id: 'directives',
    extensions: ['.conf', '.acl'],
    filenames: ['.swiftformat'],
    displayName: 'Directive Config',
  },
  { id: 'metrics', extensions: ['.prom'], displayName: 'Metrics' },
  { id: 'cedar', extensions: ['.cedar'], displayName: 'Cedar' },
  { id: 'cedarschema', extensions: ['.cedarschema'], displayName: 'Cedar Schema' },
  { id: 'zoning', extensions: ['.zone'], displayName: 'Zoning' },
  { id: 'amadeus', extensions: ['.amadeus'], displayName: 'Amadeus' },
  {
    id: 'designcraft-script',
    extensions: ['.dcs'],
    displayName: 'Designcraft Script',
    dependencies: ['source.json'],
  },
];
const metadata = new Map<
  string,
  { extensions: string[]; filenames: string[]; interpreters: string[]; displayName?: string }
>();
const languages = Object.values(linguist) as Language[];
for (const language of languages) {
  // Some languages share a lexical grammar; merge their associations.
  const entry = metadata.get(language.tmScope) ?? {
    extensions: [],
    filenames: [],
    interpreters: [],
  };
  entry.displayName ??= language.name;
  entry.extensions.push(...(language.extensions ?? []));
  entry.filenames.push(...(language.filenames ?? []));
  entry.interpreters.push(...(language.interpreters ?? []));
  metadata.set(language.tmScope, entry);
}

/** The build reads upstream metadata; the browser receives only lazy grammar imports. */
export const catalog: CatalogEntry[] = [
  ...all.map(grammar => {
    const info = metadata.get(grammar.scopeName);
    const suffix = grammar.scopeName.split('.').pop()!.toLowerCase();
    const id =
      grammar.names.find(name => name.toLowerCase() === suffix) ??
      grammar.names[0] ??
      grammar.scopeName;
    const primary = languages.find(
      language =>
        language.tmScope === grammar.scopeName &&
        [language.name, ...(language.aliases ?? [])].some(name => name.toLowerCase() === id),
    );
    const interpreters = info?.interpreters ?? [];
    return {
      id,
      scope: grammar.scopeName,
      displayName: primary?.name ?? info?.displayName ?? grammar.names[0] ?? grammar.scopeName,
      extensions: [...new Set([...grammar.extensions, ...(info?.extensions ?? [])])],
      filenames: [...new Set(info?.filenames ?? [])],
      firstLine: interpreters.length
        ? `^#!\\s*(?:/\\S*/)?(?:env\\s+(?:-S\\s+)?)?(?:${[...new Set(interpreters)].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:\\s|$)`
        : undefined,
      aliases: grammar.names,
      dependencies: grammar.dependencies ?? [],
      importPath: `@wooorm/starry-night/${grammar.scopeName}`,
    };
  }),
  ...custom.map(info => ({
    ...info,
    scope: `source.${info.id}`,
    aliases: [info.id],
    filenames: info.filenames ?? [],
    dependencies: info.dependencies ?? [],
    priority: true,
    importPath: `/syntax/${info.id === 'designcraft-script' ? 'dcs' : info.id}.json`,
  })),
];

// Shiki carries distinct JSX, JSON5, and Jinja grammars where Linguist shares scopes.
for (const info of [
  { id: 'jsx', displayName: 'JSX', extensions: ['.jsx'] },
  { id: 'json5', displayName: 'JSON5', extensions: ['.json5'] },
  { id: 'jinja', displayName: 'Jinja', extensions: ['.j2', '.jinja', '.jinja2'] },
]) {
  const importPath = `@shikijs/langs/${info.id}`;
  const pack = ((await import(importPath)) as { default: GrammarPack[] }).default;
  const primary = pack.find(grammar => grammar.name === info.id);
  for (const grammar of pack) {
    const main = grammar === primary;
    if (!main && catalog.some(entry => entry.scope === grammar.scopeName)) continue;
    catalog.push({
      id: grammar.name,
      displayName: grammar.displayName ?? grammar.name,
      extensions: [],
      filenames: [],
      aliases: [],
      dependencies: [],
      ...(main
        ? {
            ...info,
            priority: true,
            dependencies: pack.filter(item => item !== primary).map(item => item.scopeName),
          }
        : {}),
      scope: grammar.scopeName,
      importPath,
    });
  }
}

export function syntaxCatalog(): Plugin {
  const virtual = 'virtual:syntax-catalog';
  return {
    name: 'syntax-catalog',
    resolveId: id => (id === virtual ? `\0${virtual}` : undefined),
    load(id) {
      if (id !== `\0${virtual}`) return;
      return `export default [${catalog.map(({ importPath, ...entry }) => `${JSON.stringify(entry).slice(0, -1)},load:()=>import(${JSON.stringify(importPath)}).then(m=>Array.isArray(m.default)?m.default.find(g=>g.scopeName===${JSON.stringify(entry.scope)}):m.default)}`).join(',')}];`;
    },
  };
}

/** Node checks use the exact same pinned grammar bytes as the browser build. */
export async function grammarBytes(entry: { importPath: string; scope: string }) {
  if (entry.importPath.startsWith('/syntax/'))
    return JSON.parse(
      readFileSync(new URL(`.${entry.importPath}`, import.meta.url), 'utf8'),
    ) as GrammarPack;
  const value = ((await import(entry.importPath)) as { default: GrammarPack | GrammarPack[] })
    .default;
  return Array.isArray(value) ? value.find(grammar => grammar.scopeName === entry.scope) : value;
}

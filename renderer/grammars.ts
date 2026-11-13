import { createHighlighterCore } from '@shikijs/core';
import type { ThemeRegistration } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
import { shikiToMonaco } from '@shikijs/monaco';
import dark from '@shikijs/themes/dark-plus';
import light from '@shikijs/themes/light-plus';
import { editorThemeName, editorThemes, syntaxColors } from './editor-themes.ts';
import type { EditorThemeName } from './editor-themes.ts';
import type { editor, languages } from 'monaco-editor';
import type { SyntaxCatalogEntry, SyntaxGrammar } from 'virtual:syntax-catalog';

type MonacoHost = {
  languages: Pick<typeof languages, 'getLanguages' | 'setTokensProvider'>;
  editor: Pick<typeof editor, 'defineTheme'>;
};

export type SyntaxRuntime = {
  load: (scope: string) => Promise<string[]>;
  setTheme: (name: EditorThemeName) => void;
};

function syntaxTheme(base: ThemeRegistration, name: EditorThemeName) {
  const { comment, keyword, string, number, symbol, variable } = syntaxColors[name];
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
        scope: [
          'entity.name.type',
          'support.type',
          'entity.name.function',
          'support.function',
          'constant.language',
        ],
        settings: { foreground: `#${symbol}` },
      },
      { scope: ['variable', 'variable.parameter'], settings: { foreground: `#${variable}` } },
    ],
  };
}

/** Mature TextMate grammars fill Monaco's config gaps without a language server. */
export async function createSyntaxRuntime(
  monaco: MonacoHost,
  catalog: readonly SyntaxCatalogEntry[],
  currentTheme: () => EditorThemeName,
): Promise<SyntaxRuntime> {
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
    themes: [
      syntaxTheme(dark, editorThemeName('dark')),
      syntaxTheme(light, editorThemeName('light')),
    ],
    langs: [],
  });
  const scopes = new Map(catalog.map(entry => [entry.scope, entry]));
  const loaded = new Set<string>();
  const themeSetters: Array<typeof editor.setTheme> = [];
  let themesDefined = false;
  let queue: Promise<unknown> = Promise.resolve();
  function load(scope: string) {
    const loading = queue.then(async () => {
      if (loaded.has(scope)) return highlighter.getLoadedLanguages();
      const entries = new Map<string, SyntaxCatalogEntry>();
      const collect = (name: string) => {
        if (loaded.has(name) || entries.has(name)) return;
        const entry = scopes.get(name);
        if (!entry) throw new Error(`Missing grammar dependency: ${name}`);
        entries.set(name, entry);
        for (const dependency of entry.dependencies) collect(dependency);
      };
      collect(scope);
      const grammars = await Promise.all(
        [...entries.values()].map(async entry => ({
          ...(await entry.load()),
          name: entry.id,
          aliases: [] as string[],
          embeddedLangs: entry.dependencies.map(name => scopes.get(name)!.id),
        })),
      );
      await highlighter.loadLanguage(...(grammars as never[]));
      for (const name of entries.keys()) loaded.add(name);
      const adapterEditor: Pick<typeof editor, 'defineTheme' | 'setTheme'> = {
        defineTheme(name, syntax) {
          if (themesDefined) return;
          const theme = editorThemes[name as EditorThemeName];
          monaco.editor.defineTheme(name, { ...theme, rules: [...syntax.rules, ...theme.rules] });
        },
        setTheme() {},
      };
      const active = currentTheme();
      // The adapter starts with the first theme and mutates its editor facade. Keep
      // those mutations local and install only the token providers added by this load.
      const newLanguages = new Set([...entries.values()].map(entry => entry.id));
      shikiToMonaco(
        {
          ...highlighter,
          getLoadedThemes: () => [
            active,
            ...highlighter.getLoadedThemes().filter(name => name !== active),
          ],
        },
        {
          languages: {
            ...monaco.languages,
            getLanguages: () =>
              monaco.languages.getLanguages().filter(({ id }) => newLanguages.has(id)),
          },
          editor: adapterEditor,
        } as Parameters<typeof shikiToMonaco>[1],
      );
      themesDefined = true;
      themeSetters.push(adapterEditor.setTheme);
      return highlighter.getLoadedLanguages();
    });
    queue = loading.catch(() => undefined);
    return loading;
  }
  return {
    load,
    setTheme(name) {
      for (const setTheme of themeSetters) setTheme(name);
    },
  };
}

export type { SyntaxGrammar };

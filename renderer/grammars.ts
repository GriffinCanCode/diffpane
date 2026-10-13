import { createHighlighterCore } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
import { shikiToMonaco } from '@shikijs/monaco';
import dark from '@shikijs/themes/dark-plus';
import type { SyntaxCatalogEntry, SyntaxGrammar } from 'virtual:syntax-catalog';

type ViewerTheme = {
  base: string;
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
};

type MonacoHost = {
  languages: object;
  editor: {
    defineTheme: (
      name: string,
      theme: { rules: ViewerTheme['rules'] } & Record<string, unknown>,
    ) => void;
  };
};

/** Mature TextMate grammars fill Monaco's config gaps without a language server. */
export async function createSyntaxRuntime(
  monaco: MonacoHost,
  theme: ViewerTheme,
  catalog: readonly SyntaxCatalogEntry[],
) {
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
    themes: [
      {
        ...dark,
        name: 'diffpane',
        tokenColors: [
          ...dark.tokenColors!,
          { scope: 'comment', settings: { foreground: '#808080', fontStyle: 'italic' } },
          {
            scope: ['keyword', 'storage.type', 'storage.modifier'],
            settings: { foreground: '#80CBC4' },
          },
          { scope: 'string', settings: { foreground: '#D994D3' } },
          { scope: 'constant.numeric', settings: { foreground: '#C4A7E7' } },
          {
            scope: [
              'entity.name.type',
              'support.type',
              'entity.name.function',
              'support.function',
              'constant.language',
            ],
            settings: { foreground: '#EFAB74' },
          },
          { scope: ['variable', 'variable.parameter'], settings: { foreground: '#CCCCCC' } },
        ],
      },
    ],
    langs: [],
  });
  const scopes = new Map(catalog.map(entry => [entry.scope, entry]));
  const loaded = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  return (scope: string) => {
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
      // Keep the viewer's native and semantic colors, and isolate the adapter's theme hooks.
      shikiToMonaco(highlighter, {
        languages: monaco.languages,
        editor: {
          ...monaco.editor,
          defineTheme(name: string, syntax: { rules: ViewerTheme['rules'] }) {
            monaco.editor.defineTheme(name, {
              ...syntax,
              ...theme,
              rules: [...syntax.rules, ...theme.rules],
            });
          },
        },
      } as Parameters<typeof shikiToMonaco>[1]);
      return highlighter.getLoadedLanguages();
    });
    queue = loading.catch(() => undefined);
    return loading;
  };
}

export type { SyntaxGrammar };

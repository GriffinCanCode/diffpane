import sourceCatalog from 'virtual:syntax-catalog';
import { parseDocument, isMap, isSeq } from 'yaml';
import type { SyntaxCatalogEntry } from 'virtual:syntax-catalog';

type MonacoLanguage = {
  id: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
  firstLine?: string;
  aliases?: string[];
};

type MonacoModel = { getLanguageId: () => string };

type ViewerTheme = {
  base: string;
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
};

type MonacoApi = {
  languages: {
    getLanguages: () => MonacoLanguage[];
    register: (language: MonacoLanguage) => void;
    onLanguage: (id: string, callback: () => void) => void;
    registerTokensProviderFactory: (
      id: string,
      provider: { create: () => Promise<unknown> },
    ) => void;
  };
  editor: {
    defineTheme: (
      name: string,
      theme: { rules: ViewerTheme['rules'] } & Record<string, unknown>,
    ) => void;
  };
};

/** Supplement Monaco from upstream associations without stealing existing language IDs. */
export function configureSyntax(monaco: MonacoApi, theme: ViewerTheme) {
  const native = monaco.languages.getLanguages();
  const claimed = new Set(
    native.flatMap(language => [...(language.extensions ?? []), ...(language.filenames ?? [])]),
  );
  const ids = new Set([...native.map(language => language.id), 'json']);
  const catalog: SyntaxCatalogEntry[] = sourceCatalog.map(entry => ({
    ...entry,
    id: entry.aliases.find(alias => ids.has(alias)) ?? entry.id,
  }));
  const react = new Set(['tsx', 'jsx']);
  const loaded = new Set<string>();
  const pending = new Set<string>();
  const errors = new Map<string, string>();
  let runtime: Promise<(scope: string) => Promise<string[]>> | undefined;
  for (const entry of catalog) {
    const extensions = entry.extensions.filter(
      extension => entry.priority || !claimed.has(extension) || react.has(entry.id),
    );
    const filenames = entry.filenames.filter(filename => !claimed.has(filename));
    if (extensions.length || filenames.length || entry.firstLine) {
      monaco.languages.register({
        id: entry.id,
        extensions,
        filenames,
        firstLine: entry.firstLine,
        aliases: [entry.displayName, ...entry.aliases],
      });
      for (const value of [...extensions, ...filenames]) claimed.add(value);
    }
    if (ids.has(entry.id)) continue;
    monaco.languages.onLanguage(entry.id, () => {
      pending.add(entry.id);
      runtime ??= import('./grammars.ts').then(module =>
        module.createSyntaxRuntime(monaco, theme, catalog),
      );
      void runtime
        .then(loader => loader(entry.scope))
        .then(languages => {
          for (const language of languages) loaded.add(language);
        })
        .catch(error => {
          errors.set(entry.id, (error as Error).message);
          console.error(`Syntax could not load: ${entry.id}`, error);
        })
        .finally(() => pending.delete(entry.id));
    });
  }
  monaco.languages.register({
    id: 'json',
    extensions: ['.jsonc', '.ndjson', '.hujson', '.ipynb', '.xctestplan', '.vectorcraft', '.map'],
    aliases: ['JSON'],
  });
  monaco.languages.register({ id: 'markdown', extensions: ['.mdc'], aliases: ['Markdown'] });
  monaco.languages.register({ id: 'sql', extensions: ['.logsql'], aliases: ['SQL'] });
  monaco.languages.register({ id: 'css', extensions: ['.tcss'], aliases: ['CSS'] });
  monaco.languages.register({
    id: 'ini',
    extensions: ['.cfg'],
    filenames: ['.npmrc', '.yarnrc', '.pypirc', '.codespellrc', '.sqlfluff', '.importlinter'],
    aliases: ['INI'],
  });
  monaco.languages.register({ id: 'dotenv', filenamePatterns: ['.env.*'], aliases: ['Dotenv'] });
  monaco.languages.register({
    id: 'dockerfile',
    filenamePatterns: ['*.Dockerfile', 'Dockerfile.*', '*.Containerfile'],
    aliases: ['Dockerfile'],
  });
  monaco.languages.register({
    id: 'ignore-list',
    filenamePatterns: ['*.dockerignore', '*ignore'],
    aliases: ['Ignore List'],
  });
  monaco.languages.register({
    id: 'caddyfile',
    filenamePatterns: ['Caddyfile.*'],
    aliases: ['Caddyfile'],
  });
  monaco.languages.register({
    id: 'xml',
    extensions: ['.plist', '.entitlements', '.xcprivacy', '.vot'],
    aliases: ['XML'],
  });
  monaco.languages.register({ id: 'pascal', extensions: ['.lfm'], aliases: ['Pascal'] });
  monaco.languages.register({ id: 'dm', extensions: ['.dmf', '.dmm'], aliases: ['DM'] });
  monaco.languages.register({ id: 'cpp', extensions: ['.modulemap'], aliases: ['C++'] });
  monaco.languages.register({
    id: 'yaml',
    firstLine: '^#\\s*yaml-language-server:\\s*\\$schema=',
    aliases: ['YAML'],
  });
  monaco.languages.registerTokensProviderFactory('json', {
    async create() {
      const { createTokenizationSupport } =
        await import('monaco-editor/languages/features/json/tokenization.js');
      return createTokenizationSupport(true);
    },
  });

  // Unknown suffixes often contain an ordinary serialization format. Parse it first.
  function resolve(model: MonacoModel, text: string) {
    let language = model.getLanguageId();
    if (
      !['plaintext', 'ini', 'xml', 'openstep-property-list', 'haproxy'].includes(language) ||
      !text.trim()
    )
      return language;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === 'object') return 'json';
    } catch {
      /* Another structured format or ordinary text. */
    }
    if (text.trimStart().startsWith('<')) {
      const document = new DOMParser().parseFromString(text, 'application/xml');
      if (!document.querySelector('parsererror')) return 'xml';
    }
    if (text.length <= 65_536) {
      try {
        const document = parseDocument(text, { uniqueKeys: false });
        if (!document.errors.length && (isMap(document.contents) || isSeq(document.contents)))
          language = 'yaml';
      } catch {
        /* Optional format inference must never prevent reading the source. */
      }
    }
    return language;
  }
  return {
    resolve,
    stats: () => ({
      loaded: [...loaded],
      pending: [...pending],
      errors: Object.fromEntries(errors),
    }),
  };
}

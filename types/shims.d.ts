/// <reference types="vite/client" />

declare module 'virtual:syntax-catalog' {
  export type SyntaxGrammar = {
    scopeName: string;
    name?: string;
    displayName?: string;
  } & Record<string, unknown>;

  export type SyntaxCatalogEntry = {
    id: string;
    scope: string;
    displayName: string;
    extensions: string[];
    filenames: string[];
    aliases: string[];
    dependencies: string[];
    priority?: boolean;
    firstLine?: string;
    load: () => Promise<SyntaxGrammar>;
  };

  const catalog: SyntaxCatalogEntry[];
  export default catalog;
}

declare module 'monaco-editor/languages/features/json/tokenization.js' {
  export function createTokenizationSupport(supportsComments: boolean): unknown;
}

declare module '@wooorm/starry-night' {
  export const all: {
    scopeName: string;
    names: string[];
    extensions: string[];
    dependencies?: string[];
  }[];
}

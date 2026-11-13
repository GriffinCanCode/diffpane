/// <reference types="vite/client" />

interface Window {
  diffpane?: import('../../electron/runtime/window/preload.ts').DiffpaneApi
}

declare module 'virtual:syntax-catalog' {
  export type SyntaxGrammar = import('@shikijs/core').RawGrammar

  export interface SyntaxCatalogEntry {
    id: string
    scope: string
    displayName: string
    extensions: string[]
    filenames: string[]
    aliases: string[]
    dependencies: string[]
    priority?: boolean
    firstLine?: string
    load: () => Promise<SyntaxGrammar>
  }

  const catalog: SyntaxCatalogEntry[]
  export default catalog
}

declare module 'monaco-editor/languages/features/json/tokenization.js' {
  /** The installed Monaco JSON tokenizer returns a synchronous manual token provider. */
  export function createTokenizationSupport(supportsComments: boolean): import('monaco-editor').languages.TokensProvider
}

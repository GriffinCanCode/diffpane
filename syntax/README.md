---
doc_radar:
  sentinels:
    - file: syntax.ts
      contains: ['syntaxCatalog', 'linguist-languages', '@wooorm/starry-night']
    - file: syntax/origins.json
      contains: ['token_sha256', 'e592133f33e4e9d2dd93ea7ee2e003e7e4e28e66']
    - file: renderer/grammars.ts
      contains: ['createOnigurumaEngine', 'embeddedLangs']
---

# Syntax

We use [Starry Night](https://github.com/wooorm/starry-night) for upstream TextMate grammars and [Linguist](https://github.com/github-linguist/linguist) for file associations. The build emits a lazy catalog; opening one format loads its grammar and dependencies. [Shiki](https://shiki.style/packages/monaco) connects those grammars to Monaco without a language server.

We supplement shared scopes with distinct JSX, JSON5, and Jinja grammars. Unknown serialization files go through actual JSON, XML, and YAML parsers; other text keeps its original layout.

Cedar comes from the [official VS Code extension](https://github.com/cedar-policy/vscode-cedar), which supplies both policy and schema grammars. Zoning uses [its existing editor grammar](https://github.com/The-Billy-Company/zoning/tree/main/editors/vscode); Amadeus uses the token expression from its Python lexer. Origins records the source revisions and lexer hash. DCS embeds JSON after a command; directive configs and [metric exposition](https://prometheus.io/docs/instrumenting/exposition_formats/) receive lexical coloring.

Run `npm test` to check dependency closure and actual grammar tokens. Run `npm run test:billy -- /path/to/billy` for the checkout inventory proof. Bundled grammar and icon attributions live in NOTICE; Cedar and Zoning licenses stay beside their grammar snapshots.

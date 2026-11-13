---
doc_radar:
  sentinels:
    - file: vite.config.ts
      contains: ['extends: [safetyLint, typeAwareLint]']
---

# Quality configuration

`oxlint-safety.ts` and `oxlint-typeaware.ts` supply the lint rules loaded by the root Vite+ config. `monolithic-registry.toml` records the existing source-size exceptions and the responsibility each file still owns. When moving a registered source file, update its path in the registry.

Run `npm run check` for formatting, lint, and type checks, or `npm run verify` to include tests and the renderer build.

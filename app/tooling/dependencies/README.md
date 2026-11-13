---
doc_radar:
  sentinels:
    - file: app/tooling/dependencies/setup-howmany.ts
      contains: ['verifyHowManySource']
---

# Tool setup and pins

`setup-howmany.ts` verifies and builds the released HowMany source in `howmany-tool.json`. `setup-languages.ts` uses `language-tools.json` to select language tool versions. Electron discovers the installed tools when opening a supported file.

From the repository root, run `npm run setup:howmany` to prepare the bundled counter or `npm run setup:languages` to prepare language servers for integration checks.

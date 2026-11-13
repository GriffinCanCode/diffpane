---
doc_radar:
  sentinels:
    - file: app/tooling/commands/emit-preload.ts
      contains: ['DO NOT EDIT.']
---

# Development commands

`dev.ts` starts Vite and launches Electron with the development URL. `emit-preload.ts` generates the CommonJS preload from its TypeScript source. `Makefile` delegates setup, development, build, test, and installation to npm.

Run `npm run dev -- .` to open the current repository. Run `npm run prepare` to regenerate the preload, or `make verify` to run the Make verification target. Use these commands from the repository root.

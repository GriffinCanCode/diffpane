---
doc_radar:
  sentinels:
    - file: app/tooling/commands/emit-preload.ts
      contains: ['DO NOT EDIT.']
---

# Development commands

`dev.ts` starts Vite, builds the isolated terminal assets, and launches Electron. `emit-preload.ts` generates both sandboxed CommonJS preloads from their TypeScript sources. `prepare-terminal.ts` makes the macOS PTY helper executable after dependency installation. `Makefile` delegates setup, development, build, test, and installation to npm.

Run `npm run dev -- .` to open the current repository. Run `npm run prepare` to regenerate the preload, or `make verify` to run the Make verification target. Use these commands from the repository root.

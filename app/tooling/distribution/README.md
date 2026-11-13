---
doc_radar:
  sentinels:
    - file: app/tooling/distribution/install.ts
      contains: ['beforeAsar']
---

# macOS distribution

`install.ts` builds the renderer and bundles the Electron runtime, shared contracts, language servers, HowMany, and third-party notices. It signs the macOS bundle and installs it and the shell launcher. `diffpane.sh` is the launcher template installed as `diffpane` and linked as `dp`.

Run `npm run install:app` from the repository root on macOS.
